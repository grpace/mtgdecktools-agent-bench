/**
 * Results bundles and community submissions.
 *
 * A bundle is a flat .tar.gz made by `npm run bench -- bundle <event-id>`:
 *   bundle.json               manifest: event id, submitter, seats, sha256 of every other file
 *   events.jsonl              the Director's event log (source of truth)
 *   summary.json              standings and match results
 *   seats-meta.json           seat name → { kind, position, harness, model, effort } (no seat URLs/tokens)
 *   usage-<seat>.json         per-seat harness usage (tokens, cost, model ids) extracted from the transcript
 *   transcript-<seat>.jsonl   optional; a usage-only transcript by default, the full one with --transcripts
 *
 * The same validator runs in the CLI (before upload) and on the server (POST /api/submissions),
 * so a bundle that passes locally passes on the server unless it's a duplicate or the token is wrong.
 * Dependency-free on purpose: a minimal ustar reader/writer and node:zlib.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';

export const BUNDLE_VERSION = 1;
/**
 * Prompt sets this Director ships (prompts.ts): the archived ones by folder name, and "current" (current prompts no
 * archived set matches). Others are accepted but flagged. v1 predates events.
 */
export const KNOWN_PROMPT_VERSIONS = ['v2', 'v3', 'v4', 'v5', 'v6', 'v7', 'v8', 'current'];
export const EVENT_ID_RE = /^[A-Za-z0-9][\w.-]{0,99}$/;
export const SEAT_NAME_RE = /^[\w.-]{1,40}$/;
const MAX_UNPACKED_BYTES = 150 * 1024 * 1024;

const KNOWN_EVENT_TYPES = new Set([
  'event_start', 'packs_opened', 'draft_pick', 'draft_end', 'build_offered', 'deck_built', 'build_end',
  'game_start', 'decision_offered', 'agent_decision', 'decision_withdrawn', 'auto_pass', 'auto_pay', 'forced',
  'pay_tap', 'pay_color', 'pay_finish', 'pay_error', 'turn_snapshot', 'game_over', 'match_end', 'event_end',
  'phase_error', 'resend', 'event_abort', 'event_error',
  'game_setup_retry', 'game_failed', 'card_played', 'unimplemented_effect', 'rules_issue', 'forfeit', 'deck_strength',
  // Durability (durable.ts): an event resumed after a Director restart; a game socket re-attached.
  'event_resume', 'game_reconnect', 'game_reconnect_retry',
]);

export const sha256 = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');

// ---------------------------------------------------------------------------
// Minimal tar (ustar, regular files only, flat names)

function header(name: string, size: number, mtime: number): Buffer {
  const h = Buffer.alloc(512);
  const put = (s: string, off: number, len: number) => h.write(s.slice(0, len), off, len, 'utf8');
  const oct = (n: number, len: number) => n.toString(8).padStart(len - 1, '0') + '\0';
  put(name, 0, 100);
  put(oct(0o644, 8), 100, 8);
  put(oct(0, 8), 108, 8);
  put(oct(0, 8), 116, 8);
  put(oct(size, 12), 124, 12);
  put(oct(Math.floor(mtime / 1000), 12), 136, 12);
  h.fill(' ', 148, 156);
  put('0', 156, 1);
  put('ustar\0', 257, 6);
  put('00', 263, 2);
  let sum = 0;
  for (const b of h) sum += b;
  put(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return h;
}

export function packTarGz(files: Map<string, Buffer>, mtime = Date.now()): Buffer {
  const parts: Buffer[] = [];
  for (const [name, data] of files) {
    if (Buffer.byteLength(name) > 100) throw new Error(`file name too long for the bundle: ${name}`);
    parts.push(header(name, data.length, mtime), data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts), { level: 9 });
}

export function unpackTarGz(gz: Buffer): Map<string, Buffer> {
  let tar: Buffer;
  try {
    tar = gunzipSync(gz, { maxOutputLength: MAX_UNPACKED_BYTES });
  } catch (err) {
    throw new Error(`not a valid .tar.gz (or larger than ${MAX_UNPACKED_BYTES >> 20} MB unpacked): ${(err as Error).message}`);
  }
  const files = new Map<string, Buffer>();
  let off = 0;
  while (off + 512 <= tar.length) {
    const h = tar.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const str = (a: number, n: number) => h.subarray(a, a + n).toString('utf8').replace(/\0.*$/s, '');
    const prefix = str(345, 155);
    const name = (prefix ? `${prefix}/` : '') + str(0, 100);
    const size = parseInt(str(124, 12).trim() || '0', 8);
    const type = str(156, 1) || '0';
    if (!Number.isFinite(size) || size < 0) throw new Error('corrupt tar header');
    const data = tar.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === 'x' || type === 'g') continue; // pax metadata (bsdtar adds these)
    if (type === '5') continue; // directory entries (e.g. "./")
    if (type !== '0') throw new Error(`unsupported tar entry type "${type}" for ${name} (only regular files)`);
    const flat = name.replace(/^\.\//, '');
    if (flat.includes('/') || flat.startsWith('.') || flat.includes('..')) throw new Error(`bundle files must be flat (got "${name}")`);
    if (files.has(flat)) throw new Error(`duplicate file in bundle: ${flat}`);
    files.set(flat, Buffer.from(data));
  }
  return files;
}

// ---------------------------------------------------------------------------
// Validation

export interface BundleManifest {
  bundle_version: number;
  event_id: string;
  created_at: string;
  created_by?: string;
  submitter?: string;
  includes_transcripts?: boolean;
  seats: Array<{ name: string; harness?: string; model?: string; effort?: string }>;
  files: Record<string, string>;
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  /** Accepted, but shown next to the result (e.g. an engine build we don't know). */
  flags: string[];
  warnings: string[];
  eventId?: string;
  manifest?: BundleManifest;
  agents: string[];
}

export interface ValidateOptions {
  /** Engine image digests accepted without a flag (the pinned one plus any listed). */
  allowedEngineDigests: string[];
}

type Raw = { t: number; type: string; [k: string]: unknown };

export function validateBundle(files: Map<string, Buffer>, opts: ValidateOptions): ValidationResult {
  const r: ValidationResult = { ok: false, errors: [], flags: [], warnings: [], agents: [] };
  const err = (m: string) => r.errors.push(m);
  const json = (name: string): any => {
    try {
      return JSON.parse(files.get(name)!.toString('utf8'));
    } catch {
      err(`${name} is not valid JSON`);
      return undefined;
    }
  };

  for (const need of ['bundle.json', 'events.jsonl', 'summary.json']) if (!files.has(need)) err(`missing ${need}`);
  if (r.errors.length) return r;

  // Manifest and file hashes.
  const m = json('bundle.json') as BundleManifest | undefined;
  if (!m || typeof m !== 'object') return r;
  r.manifest = m;
  if (m.bundle_version !== BUNDLE_VERSION) err(`bundle_version ${m.bundle_version} is not supported (expected ${BUNDLE_VERSION}); update your checkout`);
  if (!m.files || typeof m.files !== 'object') err('bundle.json has no files map');
  else {
    for (const name of files.keys()) {
      if (name === 'bundle.json') continue;
      if (!(name in m.files)) err(`${name} is not listed in bundle.json`);
      else if (m.files[name] !== sha256(files.get(name)!)) err(`sha256 mismatch for ${name}`);
    }
    for (const name of Object.keys(m.files)) if (!files.has(name)) err(`bundle.json lists ${name}, which is missing`);
  }
  if (m.submitter !== undefined && (typeof m.submitter !== 'string' || m.submitter.length > 80)) err('submitter must be a short string');

  // Only known file names.
  for (const name of files.keys()) {
    if (['bundle.json', 'events.jsonl', 'summary.json', 'seats-meta.json'].includes(name)) continue;
    if (/^usage-[\w.-]{1,40}\.json$/.test(name) || /^transcript-[\w.-]{1,40}\.jsonl$/.test(name)) continue;
    err(`unexpected file ${name}`);
  }

  // Hashes and file names first: a bundle that fails them is not parsed any further (DIR-3).
  if (r.errors.length) return r;

  // The event log.
  const lines = files.get('events.jsonl')!.toString('utf8').split('\n');
  const events: Raw[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim()) continue;
    let o: unknown;
    try {
      o = JSON.parse(line);
    } catch {
      err(`events.jsonl line ${i + 1} is not JSON`);
      if (r.errors.length > 20) return r;
      continue;
    }
    const e = o as Raw;
    if (!e || typeof e !== 'object' || typeof e.t !== 'number' || typeof e.type !== 'string') {
      err(`events.jsonl line ${i + 1} needs numeric "t" and string "type"`);
      continue;
    }
    events.push(e);
  }
  if (!events.length) {
    err('events.jsonl is empty');
    return r;
  }
  const start = events[0]!;
  if (start.type !== 'event_start') err('events.jsonl must begin with event_start');
  const count = (type: string) => events.filter((e) => e.type === type).length;
  if (count('event_start') !== 1) err(`expected exactly one event_start, found ${count('event_start')}`);
  // A finished event (event_end) or a stopped one (event_abort, METHODOLOGY §3.2 "Stopped events": its finished games
  // are results, so stopping a table can't erase them). A Director error is never scored.
  const ends = count('event_end');
  const aborts = count('event_abort');
  if (count('event_error')) err('the event hit a Director error; it cannot be scored');
  else if (ends + aborts === 0) err('the event did not finish or stop (no event_end or event_abort): only finished or stopped events can be submitted');
  else if (ends + aborts > 1) err(`expected one event_end or event_abort, found ${ends} and ${aborts}`);
  else if (aborts && !events.some((e) => e.type === 'game_over')) err('the event was stopped before any game finished: there is nothing to score');

  const id = String(start.id ?? '');
  r.eventId = id;
  if (!EVENT_ID_RE.test(id)) err(`event id "${id}" is not a valid id`);
  if (m.event_id !== id) err(`bundle.json event_id (${m.event_id}) does not match event_start.id (${id})`);

  const set = start.set as { code?: unknown } | undefined;
  if (!set || typeof set.code !== 'string') err('event_start.set.code is missing');
  else if (!/^[A-Za-z0-9]{2,8}$/.test(set.code)) err('event_start.set.code is not a set code');
  const seats = Array.isArray(start.seats) ? (start.seats as Array<Record<string, unknown>>) : [];
  if (!seats.length) err('event_start.seats is missing');
  const names = seats.map((s) => String(s.name));
  if (new Set(names).size !== names.length) err('seat names in event_start are not unique');
  for (const n of names) if (!SEAT_NAME_RE.test(n) || ['__proto__', 'constructor', 'prototype'].includes(n)) err(`seat name "${n}" is not allowed`);
  r.agents = seats.filter((s) => s.kind === 'agent').map((s) => String(s.name));
  if (r.agents.length < 2) r.flags.push('fewer_than_two_agents');
  for (const s of seats.filter((x) => x.kind === 'agent')) {
    if (!s.harness || !s.model) r.flags.push(`seat_metadata_incomplete:${s.name}`);
  }

  // Provenance and comparability.
  const prov = (start.provenance ?? {}) as { director?: unknown; engine?: { digest?: unknown; protocol_version?: unknown } };
  const digest = typeof prov.engine?.digest === 'string' ? prov.engine.digest : '';
  if (!digest) r.flags.push('engine_build_unknown');
  else if (!opts.allowedEngineDigests.includes(digest)) r.flags.push(`engine_build_not_allowed:${digest.replace(/^sha256:/, '').slice(0, 12)}`);
  const director = String(prov.director ?? '');
  if (!director || director === 'unknown' || director === 'local') r.flags.push('director_version_unknown');
  else if (/dirty/.test(director)) r.flags.push('director_modified');
  const pv = String(start.prompt_version ?? '');
  if (!KNOWN_PROMPT_VERSIONS.includes(pv)) r.flags.push(`prompt_version_unknown:${pv || 'none'}`);

  // Log sanity.
  const unknown = [...new Set(events.map((e) => e.type).filter((t) => !KNOWN_EVENT_TYPES.has(t)))];
  if (unknown.length) r.warnings.push(`unknown event types: ${unknown.join(', ')}`);
  let back = 0;
  for (let i = 1; i < events.length; i++) if (events[i]!.t < events[i - 1]!.t - 5000) back++;
  if (back) r.flags.push('timestamps_out_of_order');
  const agentSet = new Set(r.agents);
  for (const e of events) {
    if (e.type === 'agent_decision' && typeof e.seat === 'string' && !agentSet.has(e.seat) && !names.includes(e.seat)) {
      err(`agent_decision for unknown seat "${e.seat}"`);
      break;
    }
  }

  // Summary must agree with the log.
  const summary = json('summary.json') as { id?: string; standings?: Array<{ name: string }>; matches?: Array<{ games?: unknown[] }> } | undefined;
  if (summary) {
    if (summary.id !== id) err(`summary.json id (${summary.id}) does not match the event (${id})`);
    for (const s of summary.standings ?? []) if (!agentSet.has(s.name)) err(`summary.json standing for unknown agent "${s.name}"`);
    const games = (summary.matches ?? []).reduce((n, mt) => n + (mt.games?.length ?? 0), 0);
    if (games !== count('game_over')) r.flags.push(`summary_game_count_mismatch:${games}/${count('game_over')}`);
  }

  // Seat metadata and usage files.
  if (files.has('seats-meta.json')) {
    const meta = json('seats-meta.json') as Record<string, Record<string, unknown>> | undefined;
    if (meta) {
      for (const [name, v] of Object.entries(meta)) {
        const s = seats.find((x) => x.name === name);
        if (!s) err(`seats-meta.json has unknown seat "${name}"`);
        else for (const k of ['harness', 'model', 'effort']) if (s[k] && v[k] && s[k] !== v[k]) r.flags.push(`seat_metadata_differs:${name}.${k}`);
      }
    }
  }
  for (const name of files.keys()) {
    const u = /^usage-(.+)\.json$/.exec(name) ?? /^transcript-(.+)\.jsonl$/.exec(name);
    if (u && !agentSet.has(u[1]!)) err(`${name} is for "${u[1]}", which is not an agent seat in this event`);
    if (/^usage-/.test(name)) {
      const v = json(name);
      if (v && (typeof v !== 'object' || Array.isArray(v))) err(`${name} must be a JSON object`);
    }
  }
  if (!r.agents.some((a) => files.has(`usage-${a}.json`))) r.flags.push('no_usage_reported');

  r.ok = r.errors.length === 0;
  return r;
}

// ---------------------------------------------------------------------------
// Storing an accepted submission

export interface SourceInfo {
  label: 'community';
  submitter: string;
  submitter_claimed?: string;
  submitted_at: string;
  bundle_sha256: string;
  bundle_version: number;
  includes_transcripts: boolean;
  flags: string[];
  warnings: string[];
}

export class SubmissionError extends Error {
  constructor(public status: number, message: string, public details?: unknown) {
    super(message);
  }
}

/** Find an earlier submission of the exact same bundle. */
function findDuplicate(runsDir: string, bundleSha: string): string | undefined {
  if (!existsSync(runsDir)) return undefined;
  for (const d of readdirSync(runsDir)) {
    const p = join(runsDir, d, 'source.json');
    if (!existsSync(p)) continue;
    try {
      if (JSON.parse(readFileSync(p, 'utf8')).bundle_sha256 === bundleSha) return d;
    } catch {
      // ignore unreadable source files
    }
  }
  return undefined;
}

/**
 * Validate and store a bundle under runsDir/<event-id>/ with a source.json, atomically.
 * Throws SubmissionError (400 invalid, 409 duplicate).
 */
export function acceptSubmission(gz: Buffer, runsDir: string, submitter: string, opts: ValidateOptions): { id: string; source: SourceInfo } {
  const bundleSha = sha256(gz);
  let files: Map<string, Buffer>;
  try {
    files = unpackTarGz(gz);
  } catch (e) {
    throw new SubmissionError(400, (e as Error).message);
  }
  const v = validateBundle(files, opts);
  if (!v.ok) throw new SubmissionError(400, 'bundle failed validation', { errors: v.errors, flags: v.flags });
  const id = v.eventId!;
  const dup = findDuplicate(runsDir, bundleSha);
  if (dup) throw new SubmissionError(409, `this bundle was already submitted (event ${dup})`);
  const dir = join(runsDir, id);
  if (existsSync(dir)) throw new SubmissionError(409, `an event with id ${id} already exists on this server`);

  const source: SourceInfo = {
    label: 'community',
    submitter,
    ...(v.manifest?.submitter ? { submitter_claimed: v.manifest.submitter } : {}),
    submitted_at: new Date().toISOString(),
    bundle_sha256: bundleSha,
    bundle_version: v.manifest!.bundle_version,
    includes_transcripts: !!v.manifest?.includes_transcripts,
    flags: v.flags,
    warnings: v.warnings,
  };
  mkdirSync(runsDir, { recursive: true });
  const tmp = join(runsDir, `.incoming-${randomBytes(4).toString('hex')}`);
  mkdirSync(tmp);
  try {
    for (const [name, data] of files) writeFileSync(join(tmp, name === 'bundle.json' ? 'bundle-manifest.json' : name), data);
    writeFileSync(join(tmp, 'source.json'), JSON.stringify(source, null, 1));
    renameSync(tmp, dir);
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
  return { id, source };
}

/** Parse SUBMIT_TOKENS: comma-separated `name:token` (or a bare token, named by its hash). */
export function parseSubmitTokens(raw: string | undefined): Array<{ name: string; token: string }> {
  return (raw ?? '').split(/[,\n]/).map((s) => s.trim()).filter(Boolean).map((entry) => {
    const i = entry.lastIndexOf(':');
    if (i > 0) return { name: entry.slice(0, i).trim(), token: entry.slice(i + 1).trim() };
    return { name: `token-${sha256(entry).slice(0, 8)}`, token: entry };
  }).filter((t) => t.token.length >= 16);
}
