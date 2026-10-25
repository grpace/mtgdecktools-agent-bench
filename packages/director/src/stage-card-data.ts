/**
 * The hosted stack's card-data stage (docs/CARD-OVERRIDES.md "Running It in Production", deploy/compose.yaml
 * `card-data`). It runs before phase-server, on the same `phase-data` volume:
 *   1. the pinned upstream files (deps/manifest.json): draft-pools.json and the upstream card data. Files already in
 *      the volume with the pinned sha256 are kept (no download); anything else is downloaded from the pinned release's
 *      data manifest (https://data.phase-rs.dev/desktop/release-server-v<version>.json) and checked against the pin;
 *   2. card-data.json = upstream + the active overrides (engine/overrides/), with its sidecar card-overrides.json
 *      (card-overrides.ts, byte for byte what scripts/card_overrides.py writes);
 *   3. phase-server then starts with --no-data-download: a file it can't load stops it loudly instead of being
 *      replaced by upstream's, and the Director records the hash of the file it loaded (event_start.provenance.card_data).
 * Idempotent and deterministic: a restart rewrites nothing when nothing changed. Exit 1 on any failure, so phase-server
 * (which waits for this step) never starts on the wrong data.
 *
 *   node --import tsx packages/director/src/stage-card-data.ts --data /phase-data [--offline] [--marker /tmp/card-data-staged]
 */
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { applyOverrides, CARD_DATA, loadOverrides, pristinePath, SIDECAR, UPSTREAM_COPY } from './card-overrides.js';

const REPO = resolve(import.meta.dirname, '../../..');
const RELEASE_MANIFEST = 'https://data.phase-rs.dev/desktop/release-server-v{version}.json';
const DRAFT_POOLS = 'draft-pools.json';

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const short = (s: string) => s.slice(0, 12);
const log = (m: string) => console.log(`card-data: ${m}`);

interface Pin { version: string; cardData: string; draftPools: string }

/** The pinned engine build and its data hashes (engine/phase.lock.json, deps/manifest.json). */
export function readPin(repo = REPO): Pin {
  const lock = JSON.parse(readFileSync(join(repo, 'engine/phase.lock.json'), 'utf8')) as { server_version?: string };
  const man = JSON.parse(readFileSync(join(repo, 'deps/manifest.json'), 'utf8')) as { phase_rs?: { data?: { card_data?: { sha256?: string }; booster_data?: { sha256?: string } } } };
  const pin = { version: String(lock.server_version ?? ''), cardData: String(man.phase_rs?.data?.card_data?.sha256 ?? ''), draftPools: String(man.phase_rs?.data?.booster_data?.sha256 ?? '') };
  if (!pin.version || !/^[0-9a-f]{64}$/.test(pin.cardData) || !/^[0-9a-f]{64}$/.test(pin.draftPools)) throw new Error('engine/phase.lock.json or deps/manifest.json has no pinned version and data hashes');
  return pin;
}

async function download(pin: Pin, name: string, want: string): Promise<Buffer> {
  const manUrl = RELEASE_MANIFEST.replace('{version}', pin.version);
  const res = await fetch(manUrl, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`${manUrl}: HTTP ${res.status}`);
  const man = (await res.json()) as { data?: Array<{ name: string; sha256: string; url: string }> };
  const entry = man.data?.find((d) => d.name === name);
  if (!entry) throw new Error(`${manUrl} lists no ${name}`);
  if (entry.sha256 !== want) throw new Error(`${manUrl} lists ${name} ${short(entry.sha256)}, but the pin is ${short(want)} (deps/manifest.json)`);
  log(`downloading ${name} ${short(want)} from ${entry.url}`);
  const body = await fetch(entry.url, { signal: AbortSignal.timeout(900_000) });
  if (!body.ok) throw new Error(`${entry.url}: HTTP ${body.status}`);
  const bytes = Buffer.from(await body.arrayBuffer());
  if (sha256(bytes) !== want) throw new Error(`${entry.url} does not match the pinned sha256 ${short(want)}`);
  return bytes;
}

function writeAtomic(p: string, b: Buffer): void {
  writeFileSync(`${p}.tmp`, b);
  chmodSync(`${p}.tmp`, 0o644);
  renameSync(`${p}.tmp`, p);
}

const fileSha = (p: string) => (existsSync(p) ? sha256(readFileSync(p)) : null);

export async function stage(dataDir: string, opts: { offline?: boolean; repo?: string } = {}): Promise<{ upstream: string; sha256: string; overrides: string[]; skipped: number; downloaded: string[] }> {
  const repo = opts.repo ?? REPO;
  const pin = readPin(repo);
  const downloaded: string[] = [];
  const need = async (name: string, want: string): Promise<Buffer> => {
    if (opts.offline) throw new Error(`${name} ${short(want)} is not in ${dataDir} and --offline forbids a download`);
    downloaded.push(name);
    return download(pin, name, want);
  };
  // Booster data: phase-server won't fetch it with --no-data-download.
  const pools = join(dataDir, DRAFT_POOLS);
  if (fileSha(pools) !== pin.draftPools) writeAtomic(pools, await need(DRAFT_POOLS, pin.draftPools));
  // Upstream card data: what is in the volume when it's the pinned build's, else the pinned download. A new pin (an
  // engine upgrade) replaces the old upstream file here, and the overrides pinned to the old entries are skipped.
  let upstream: string | null = null;
  try {
    upstream = fileSha(pristinePath(dataDir));
  } catch {
    upstream = null;
  }
  if (upstream !== pin.cardData) {
    const bytes = await need(CARD_DATA, pin.cardData);
    writeAtomic(join(dataDir, UPSTREAM_COPY), bytes);
    writeAtomic(join(dataDir, CARD_DATA), bytes);
  }
  const side = applyOverrides(dataDir, loadOverrides(join(repo, 'engine/overrides')));
  if (side.upstream_sha256 !== pin.cardData) throw new Error(`staged upstream ${short(side.upstream_sha256)} is not the pinned ${short(pin.cardData)}`);
  if (fileSha(join(dataDir, CARD_DATA)) !== side.sha256) throw new Error(`${CARD_DATA} does not match its sidecar ${SIDECAR}`);
  return { upstream: side.upstream_sha256, sha256: side.sha256, overrides: side.overrides.map((o) => o.slug), skipped: side.skipped.length, downloaded };
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { data: { type: 'string' }, offline: { type: 'boolean' }, marker: { type: 'string' } } });
  if (!values.data) {
    console.error('usage: stage-card-data.ts --data <phase-server data dir> [--offline] [--marker <file>]');
    process.exit(2);
  }
  const t0 = Date.now();
  try {
    const r = await stage(resolve(values.data), { offline: values.offline });
    const side = JSON.parse(readFileSync(join(values.data, SIDECAR), 'utf8')) as { skipped: Array<{ slug: string; reason: string }> };
    for (const s of side.skipped) console.error(`card-data: SKIPPED override ${s.slug}: ${s.reason}`);
    log(`upstream ${short(r.upstream)} -> ${CARD_DATA} ${short(r.sha256)}; overrides: ${r.overrides.join(', ') || 'none'}${r.skipped ? `; ${r.skipped} skipped (see above)` : ''}${r.downloaded.length ? `; downloaded ${r.downloaded.join(', ')}` : ''} (${Date.now() - t0} ms)`);
    if (values.marker) writeFileSync(values.marker, `${r.sha256}\n`);
  } catch (err) {
    console.error(`card-data: FAILED: ${String((err as Error)?.message ?? err)}`);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('stage-card-data.ts')) await main();
