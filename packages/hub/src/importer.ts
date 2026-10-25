/**
 * One-off importer: turn existing run folders (local runs/, or hosted runs pulled with
 * scripts/pull-hosted-runs.sh) into bundles and ingest them as the hub's first data, keeping their labels.
 *
 * The bundle is built by the same code as `npm run bench -- bundle` (packages/director/src/bundle.ts: usage-only
 * transcripts, no seat URLs) with a deterministic created_at, so importing the same folder twice yields the same bundle sha256 (a no-op).
 * strength.json / draft-eval.json (derived analysis inputs) travel as sidecars.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { buildBundle } from '../../director/src/bundle.js';
import { readSource } from '../../site/src/inputs.js';
import { isLlmSeat } from '../../site/src/data.js';
import type { Hub } from './hub.js';
import type { Principal } from './tokens.js';

export interface ImportOutcome { dir: string; id?: string; status: string; detail?: string }

/** Build a bundle (bundle_version 1) from a run folder. Returns null with a reason when it can't. */
export function bundleFromRunDir(dir: string): { gz: Buffer; sidecars: Map<string, Buffer>; start: any } | { skip: string } {
  const log = join(dir, 'events.jsonl');
  if (!existsSync(log)) return { skip: 'no events.jsonl' };
  const first = readFileSync(log, 'utf8').split('\n', 1)[0] ?? '';
  let start: any;
  try {
    start = JSON.parse(first);
  } catch {
    return { skip: 'events.jsonl does not start with JSON' };
  }
  if (start?.type !== 'event_start') return { skip: 'legacy log (no event_start)' };
  if (!existsSync(join(dir, 'summary.json'))) return { skip: 'no summary.json (event did not finish)' };

  const src = existsSync(join(dir, 'source.json')) ? JSON.parse(readFileSync(join(dir, 'source.json'), 'utf8')) : {};
  const submitter = typeof src.submitter_claimed === 'string' ? src.submitter_claimed : typeof src.submitter === 'string' ? src.submitter : undefined;
  // The same assembly as `bench bundle` and the Director's hand-off, with a deterministic created_at.
  const b = buildBundle(dir, { createdBy: 'mtgdt-hub import', createdAt: Number(start.t), submitter, reuseUsageFiles: true });
  const sidecars = new Map<string, Buffer>();
  for (const f of ['strength.json', 'draft-eval.json']) if (existsSync(join(dir, f))) sidecars.set(f, readFileSync(join(dir, f)));
  return { gz: b.gz, sidecars, start };
}

/** Import every run folder under the given directories (or the folders themselves). */
export async function importRuns(hub: Hub, who: Principal, roots: string[], log: (m: string) => void): Promise<ImportOutcome[]> {
  const dirs: string[] = [];
  for (const root of roots) {
    if (existsSync(join(root, 'events.jsonl'))) dirs.push(root);
    else if (existsSync(root)) for (const d of readdirSync(root).sort()) if (statSync(join(root, d)).isDirectory()) dirs.push(join(root, d));
  }
  const out: ImportOutcome[] = [];
  for (const dir of dirs) {
    const b = bundleFromRunDir(dir);
    if ('skip' in b) {
      out.push({ dir, status: 'skipped', detail: b.skip });
      log(`skip ${basename(dir)}: ${b.skip}`);
      continue;
    }
    const llm = (b.start.seats ?? []).some((s: { kind: string; name: string }) => isLlmSeat(s));
    const source = readSource(dir, llm);
    const res = await hub.receive(b.gz, who, 'import', { sidecars: b.sidecars, label: source.label, exclude: source.exclude });
    const status = String(res.body.status ?? (res.http === 409 ? 'duplicate' : 'error'));
    out.push({ dir, id: String(b.start.id), status, detail: res.http >= 400 ? String(res.body.error ?? '') : (res.body.flags as string[] | undefined)?.join(', ') });
    log(`${basename(dir)}: ${status} (${source.label}${source.inferred ? ', inferred' : ''})${res.http >= 400 ? ` — ${res.body.error}` : ''}`);
  }
  return out;
}
