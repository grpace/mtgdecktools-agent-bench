/**
 * Results bundle assembly (bundle_version 1, format in submissions.ts), shared by `npm run bench -- bundle`,
 * the Director's hand-off to the Hub (hub-handoff.ts) and the Hub's importer, so there is one implementation.
 */
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { BUNDLE_VERSION, packTarGz, sha256, type BundleManifest } from './submissions.js';
import { detectSeatEffort } from './effort-detect.js';
import { cleanId } from './harness-logs.js';
import { extractUsage, sessionFileFor, slimClaudeTranscript, usageFacts, type SeatUsage } from './usage.js';

export interface BuildBundleOptions {
  /** Recorded in bundle.json (`mtgdt-bench <sha>`, `mtgdt-director <version>`, …). */
  createdBy: string;
  /** Fixed creation time (ms) for created_at and the tar mtimes: the same inputs then give the same bytes. Default: now. */
  createdAt?: number;
  submitter?: string;
  /** Where transcript-<seat>.jsonl files live (default: the run folder). */
  transcriptsDir?: string;
  /** Include full harness transcripts instead of usage-only copies. */
  fullTranscripts?: boolean;
  /** Use a usage-<seat>.json already in the run folder (stored submissions, pulled runs) with its transcript as-is. */
  reuseUsageFiles?: boolean;
}

export interface SeatBundleInfo {
  seat: string;
  /** Where its usage came from: a transcript, an existing usage file, or nothing. */
  usage: 'transcript' | 'file' | 'none';
  report?: SeatUsage;
  transcriptPath: string;
}

export interface BuiltBundle {
  id: string;
  gz: Buffer;
  sha256: string;
  /** Every file in the bundle, bundle.json included. */
  files: Map<string, Buffer>;
  manifest: BundleManifest;
  start: Record<string, any>;
  seats: SeatBundleInfo[];
}

export class BundleError extends Error {}

/** Log records written after the event ended (hand-off bookkeeping) that are not part of the event itself. */
const POST_EVENT_TYPES = ['hub_handoff'];

/** The event log as it goes into a bundle: the file's bytes, minus post-event bookkeeping records. */
export function bundleEventLog(file: string): Buffer {
  const buf = readFileSync(file);
  const text = buf.toString('utf8');
  if (!POST_EVENT_TYPES.some((t) => text.includes(`"type":"${t}"`))) return buf;
  const kept = text.split('\n').filter((line) => {
    if (!POST_EVENT_TYPES.some((t) => line.includes(`"type":"${t}"`))) return true;
    try {
      return !POST_EVENT_TYPES.includes(JSON.parse(line).type);
    } catch {
      return true;
    }
  });
  return Buffer.from(kept.join('\n'));
}

/** The event_start record of a run folder, if its log starts with one. */
export function readEventStart(dir: string): Record<string, any> | undefined {
  const f = join(dir, 'events.jsonl');
  if (!existsSync(f)) return undefined;
  try {
    const o = JSON.parse(readFileSync(f, 'utf8').split('\n', 1)[0] ?? '');
    return o?.type === 'event_start' ? o : undefined;
  } catch {
    return undefined;
  }
}

/** Build a results bundle from a finished run folder (events.jsonl + summary.json). Throws BundleError. */
export function buildBundle(dir: string, opts: BuildBundleOptions): BuiltBundle {
  const id = basename(dir.replace(/\/+$/, ''));
  for (const f of ['events.jsonl', 'summary.json']) if (!existsSync(join(dir, f))) throw new BundleError(`${f} is missing in ${dir}`);
  const start = readEventStart(dir);
  if (!start) throw new BundleError('events.jsonl does not start with event_start');
  const tdir = opts.transcriptsDir ?? dir;
  const createdAt = opts.createdAt ?? Date.now();

  const files = new Map<string, Buffer>();
  files.set('events.jsonl', bundleEventLog(join(dir, 'events.jsonl')));
  files.set('summary.json', readFileSync(join(dir, 'summary.json')));
  const seats = (start.seats ?? []) as Array<Record<string, any> & { name: string; kind: string }>;
  files.set('seats-meta.json', Buffer.from(JSON.stringify(Object.fromEntries(seats.map(({ name, ...rest }) => [name, rest])), null, 1)));

  const manifestSeats: BundleManifest['seats'] = [];
  const info: SeatBundleInfo[] = [];
  for (const s of seats.filter((x) => x.kind === 'agent')) {
    manifestSeats.push({ name: s.name, harness: s.harness, model: s.model, effort: s.effort });
    const t = join(tdir, `transcript-${s.name}.jsonl`);
    const usageFile = join(dir, `usage-${s.name}.json`);
    if (opts.reuseUsageFiles && existsSync(usageFile)) {
      files.set(`usage-${s.name}.json`, readFileSync(usageFile));
      if (existsSync(t)) files.set(`transcript-${s.name}.jsonl`, readFileSync(t));
      info.push({ seat: s.name, usage: 'file', transcriptPath: t });
      continue;
    }
    if (!existsSync(t)) {
      // Seated by hand: `bench attach-logs` may have found the harness's own session on this machine (facts only).
      const logs = join(dir, `harness-logs-${s.name}.json`);
      if (existsSync(logs)) {
        const l = JSON.parse(readFileSync(logs, 'utf8'));
        const ids = (Array.isArray(l.model_ids) ? l.model_ids : []).map(cleanId).filter((x: string | undefined): x is string => !!x).slice(0, 8);
        const tokens = l.model_output_tokens && typeof l.model_output_tokens === 'object'
          ? Object.fromEntries(Object.entries(l.model_output_tokens).filter(([k, v]) => cleanId(k) && typeof v === 'number').slice(0, 8)) : undefined;
        const stores: string[] = Array.isArray(l.facts) ? [...new Set<string>(l.facts.map((f: { store?: unknown }) => String(f?.store)))].filter((x) => /^[a-z0-9-]{1,30}$/.test(x)) : [];
        files.set(`usage-${s.name}.json`, Buffer.from(JSON.stringify({
          seat: s.name, harness: s.harness, format: 'harness-logs', model_ids: ids,
          ...(tokens && Object.keys(tokens).length ? { model_output_tokens: tokens } : {}),
          ...(l.effort_reported ? { effort_reported: l.effort_reported } : {}),
          ...(cleanId(l.harness_version) ? { harness_version: cleanId(l.harness_version) } : {}),
          stores,
          // Where this came from (LOG-1): the contributor's CLI read their own machine's logs. Self-attested: anyone can
          // write this file, so it never counts as evidence the Director observed.
          evidence: { kind: 'cli-local-logs', self_attested: true, read_by: typeof l.provenance?.read_by === 'string' ? l.provenance.read_by.slice(0, 80) : null, match: l.status === 'matched' ? 'unique' : (l.status ?? 'unknown') },
          model_declared: s.model_declared ?? s.model, effort_declared: s.effort_declared ?? s.effort,
        }, null, 1)));
        info.push({ seat: s.name, usage: 'file', transcriptPath: t });
        continue;
      }
      info.push({ seat: s.name, usage: 'none', transcriptPath: t });
      continue;
    }
    const usage = extractUsage(t, s.name, s.harness);
    const run = join(dir, `harness-${s.name}.json`);
    const runInfo = existsSync(run) ? JSON.parse(readFileSync(run, 'utf8')) : {};
    // The effort the harness logged (session/rollout files the CLI saved next to the transcript; METHODOLOGY §2.1).
    const effort = detectSeatEffort(tdir, s.name, s.harness, t) ?? detectSeatEffort(dir, s.name, s.harness, t);
    const { harness_version: effortVersion, ...effortReported } = effort ?? { harness_version: undefined };
    files.set(`usage-${s.name}.json`, Buffer.from(JSON.stringify({
      ...usageFacts(usage), model_declared: s.model_declared ?? s.model, effort_declared: s.effort_declared ?? s.effort,
      ...(effort ? { effort_reported: effortReported } : {}),
      harness_version: usage.harness_version ?? effortVersion ?? runInfo.harness_version,
      started_at: runInfo.started_at, finished_at: runInfo.finished_at, exit_code: runInfo.exit_code, launches: runInfo.launches,
      // Where this came from (LOG-1): the harness output the contributor's CLI captured when it started the seat.
      // Self-attested like any upload; the Director didn't observe it.
      evidence: { kind: 'cli-launch-transcript', self_attested: true, effort_source: effort?.source ?? null },
    }, null, 1)));
    // Full transcripts (opt-in) without the harness's init and system records: they name plugin and skill paths,
    // which contain the home folder and username (CLI-12).
    if (opts.fullTranscripts) files.set(`transcript-${s.name}.jsonl`, Buffer.from(withoutSystemRecords(readFileSync(t, 'utf8'))));
    else if (usage.format === 'claude-stream-json') files.set(`transcript-${s.name}.jsonl`, Buffer.from(slimClaudeTranscript(t, sessionFileFor(t, s.name))));
    info.push({ seat: s.name, usage: 'transcript', report: usage, transcriptPath: t });
  }

  const manifest: BundleManifest = {
    bundle_version: BUNDLE_VERSION,
    event_id: String(start.id ?? id),
    created_at: new Date(createdAt).toISOString(),
    created_by: opts.createdBy,
    ...(opts.submitter ? { submitter: opts.submitter } : {}),
    includes_transcripts: !!opts.fullTranscripts,
    seats: manifestSeats,
    files: Object.fromEntries([...files].map(([n, b]) => [n, sha256(b)])),
  };
  const manifestBuf = Buffer.from(JSON.stringify(manifest, null, 1));
  const ordered = new Map<string, Buffer>([['bundle.json', manifestBuf], ...files]);
  const gz = packTarGz(ordered, createdAt);
  return { id: manifest.event_id, gz, sha256: sha256(gz), files: ordered, manifest, start, seats: info };
}

/** A JSONL transcript without `system` records (init lines list local paths); other lines unchanged. */
export function withoutSystemRecords(text: string): string {
  return text.split('\n').filter((l) => {
    if (!l.includes('"system"')) return true;
    try {
      return JSON.parse(l)?.type !== 'system';
    } catch {
      return true;
    }
  }).join('\n');
}
