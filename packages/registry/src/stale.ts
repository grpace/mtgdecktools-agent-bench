/**
 * Is the registry stale? Compares the names that recent events actually used (declared seats in event_start,
 * model ids in harness usage and transcripts) with the registry, without calling any provider API.
 *
 *   registryStaleness(runsDir, { sinceDays })  scan run folders and check them (for `npm run deps -- check`)
 *   checkObservations(observations)            the same check over names you collected yourself
 *
 * CLI: npx tsx packages/registry/src/stale.ts [runsDir] [--since-days N] [--json] [--strict]
 *   prints the findings; with --strict exits 1 when the registry is stale.
 *
 * Findings:
 *   unknown_model     a model name (declared or reported by a harness) the registry doesn't resolve
 *   unknown_harness   a declared harness the registry doesn't know
 *   unknown_snapshot  a dated snapshot of a known model that isn't listed in its `snapshots`
 *   inactive_in_use   a deprecated or retired model still being used
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { registry as defaultRegistry, registryVersion, type Registry } from './index.js';

export interface Observation {
  /** A model name as declared or as a harness reported it. */
  model?: string;
  harness?: string;
  /** Event start (ms or ISO date): floating aliases resolve as of then. */
  at?: number | string;
  source: 'declared' | 'usage';
  event?: string;
}

export interface StaleFinding {
  kind: 'unknown_model' | 'unknown_harness' | 'unknown_snapshot' | 'inactive_in_use';
  name: string;
  harness?: string;
  source: Observation['source'];
  seen: number;
  events: string[];
  last_seen?: string;
  suggestions?: string[];
  detail?: string;
}

export interface StalenessReport {
  registry: ReturnType<typeof registryVersion>;
  checked: number;
  stale: boolean;
  findings: StaleFinding[];
}

const TEST_SEAT = /^(rand|bot-|bot$|random)/i;

export function checkObservations(obs: Observation[], reg: Registry = defaultRegistry): StalenessReport {
  const found = new Map<string, StaleFinding>();
  const add = (kind: StaleFinding['kind'], name: string, o: Observation, extra: Partial<StaleFinding> = {}) => {
    const k = `${kind}|${name.toLowerCase()}|${o.harness ?? ''}`;
    const f = found.get(k) ?? { kind, name, ...(o.harness ? { harness: o.harness } : {}), source: o.source, seen: 0, events: [], ...extra };
    f.seen++;
    if (o.event && !f.events.includes(o.event) && f.events.length < 5) f.events.push(o.event);
    if (o.at != null) {
      const day = new Date(o.at).toISOString().slice(0, 10);
      if (!f.last_seen || day > f.last_seen) f.last_seen = day;
    }
    found.set(k, f);
  };
  for (const o of obs) {
    const h = o.harness ? reg.resolveHarness(o.harness) : undefined;
    if (h && !h.ok) add('unknown_harness', o.harness!, o, { suggestions: h.suggestions });
    if (h?.ok && h.harness.kind === 'test') continue;
    if (!o.model?.trim()) continue;
    const m = reg.resolveModel(o.model, h?.ok ? h.id : undefined, { at: o.at });
    if (!m.ok) add('unknown_model', o.model.trim(), o, { suggestions: m.suggestions, detail: m.error });
    else {
      if (m.snapshot && m.snapshotKnown === false) add('unknown_snapshot', m.snapshot, o, { detail: `behind ${m.id}` });
      if (m.model.status === 'deprecated' || m.model.status === 'retired') add('inactive_in_use', m.id, o, { detail: m.model.status });
    }
  }
  const findings = [...found.values()].sort((a, b) => a.kind.localeCompare(b.kind) || b.seen - a.seen || a.name.localeCompare(b.name));
  return { registry: registryVersion(), checked: obs.length, stale: findings.some((f) => f.kind !== 'inactive_in_use'), findings };
}

function readJson(file: string): any {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

/** Names used in run folders (runs/<id>/events.jsonl, usage-<seat>.json, transcript-<seat>.jsonl). */
export function scanRuns(runsDir: string, opts: { sinceDays?: number; now?: number } = {}): Observation[] {
  const out: Observation[] = [];
  if (!existsSync(runsDir)) return out;
  const cutoff = opts.sinceDays != null ? (opts.now ?? Date.now()) - opts.sinceDays * 86_400_000 : -Infinity;
  for (const name of readdirSync(runsDir).sort()) {
    const dir = join(runsDir, name);
    const log = join(dir, 'events.jsonl');
    if (!statSync(dir).isDirectory() || !existsSync(log)) continue;
    let start: any;
    try {
      const first = readFileSync(log, 'utf8').split('\n', 1)[0] ?? '';
      start = JSON.parse(first);
    } catch {
      continue;
    }
    if (start?.type !== 'event_start' || !Array.isArray(start.seats)) continue;
    const at = typeof start.t === 'number' ? start.t : undefined;
    if (at != null && at < cutoff) continue;
    const event = String(start.id ?? name);
    for (const s of start.seats) {
      if (s?.kind !== 'agent' || TEST_SEAT.test(String(s.name ?? ''))) continue;
      const harness = s.harness_declared ?? s.harness;
      const model = s.model_declared ?? s.model ?? s.model_id;
      if (harness || model) out.push({ ...(model ? { model: String(model) } : {}), ...(harness ? { harness: String(harness) } : {}), at, source: 'declared', event });
      const usage = readJson(join(dir, `usage-${s.name}.json`));
      const reported = new Set<string>([
        ...(Array.isArray(usage?.model_ids) ? usage.model_ids.map(String) : []),
        ...Object.keys(usage?.model_output_tokens ?? {}),
      ]);
      const tr = join(dir, `transcript-${s.name}.jsonl`);
      if (!reported.size && existsSync(tr)) {
        for (const line of readFileSync(tr, 'utf8').split('\n')) {
          if (!line.includes('"model')) continue;
          try {
            const o = JSON.parse(line);
            if (o.type === 'system' && typeof o.model === 'string') reported.add(o.model);
            if (o.type === 'assistant' && typeof o.message?.model === 'string') reported.add(o.message.model);
            if (o.type === 'result') for (const m of Object.keys(o.modelUsage ?? {})) reported.add(m);
          } catch {
            // not JSON
          }
        }
      }
      for (const m of reported) out.push({ model: m, ...(harness ? { harness: String(harness) } : {}), at, source: 'usage', event });
    }
  }
  return out;
}

export function registryStaleness(runsDir: string, opts: { sinceDays?: number; now?: number } = {}, reg?: Registry): StalenessReport {
  return checkObservations(scanRuns(runsDir, opts), reg);
}

// CLI
if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const args = process.argv.slice(2);
  const flag = (f: string) => args.includes(f);
  const since = args.indexOf('--since-days');
  const runs = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--since-days') ?? resolve(import.meta.dirname, '../../../runs');
  const report = registryStaleness(runs, since >= 0 ? { sinceDays: Number(args[since + 1]) } : {});
  if (flag('--json')) console.log(JSON.stringify(report, null, 1));
  else {
    console.log(`registry ${report.registry.version} (${report.registry.models} models, ${report.registry.harnesses} harnesses); ${report.checked} names checked in ${runs}`);
    if (!report.findings.length) console.log('up to date: every name used resolves');
    for (const f of report.findings) {
      console.log(`  ${f.kind}: ${f.name}${f.harness ? ` (${f.harness})` : ''}, ${f.source}, seen ${f.seen}× last ${f.last_seen ?? '?'}${f.suggestions?.length ? `; did you mean ${f.suggestions.join(', ')}?` : ''}${f.detail && f.kind !== 'unknown_model' ? `; ${f.detail}` : ''}`);
    }
  }
  if (flag('--strict') && report.stale) process.exit(1);
}
