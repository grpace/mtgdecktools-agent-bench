/**
 * The booster data every event ran on, kept by hash so an event can resume on it after an engine upgrade
 * (docs/UPGRADING.md). phase-server rewrites its data volume on start, so after an upgrade `draft-pools.json` (and the unsupported-card
 * list) are the new build's; a resumed event replays its draft from the seed, and only its own data regenerates the packs
 * it logged. So at every start the Director copies the data it runs on into its archive as `<sha256>.json` (the hashes
 * event_start.boosters names), and a resumed event whose hashes differ from the current ones builds its BoosterFactory
 * from the archived files. Other directories can be searched too (BOOSTER_ARCHIVE_DIRS: the Hub's archive, a backup).
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BoosterFactory } from './boosters.js';
import { adjustUnsupported, type UnsupportedDoc } from './card-overrides.js';
import type { BoosterProvenance } from './provenance.js';

const SHA_RE = /^[0-9a-f]{64}$/;

/** Copy `src` into `dir` as `<sha>.json` unless it is there already (atomic: a partial copy is never visible). */
function keep(dir: string, sha: string, write: (to: string) => void): boolean {
  const to = join(dir, `${sha}.json`);
  if (existsSync(to)) return false;
  const tmp = `${to}.tmp-${process.pid}`;
  write(tmp);
  renameSync(tmp, to);
  return true;
}

/**
 * Archive the booster data this process runs on: the draft pools file, and the unsupported list as the exact bytes its
 * hash names (the file it was read from, or `{"unsupported":[…]}` for a list taken from the card data's markers).
 * Returns the names written. Never throws: a full disk must not stop the Director (resume then fails clearly).
 */
export function archiveBoosterData(dir: string, draftPoolsPath: string, prov: BoosterProvenance, unsupported: { file: string } | { list: string[] }): string[] {
  const out: string[] = [];
  try {
    mkdirSync(dir, { recursive: true });
    if (keep(dir, prov.draft_pools_sha256, (to) => copyFileSync(draftPoolsPath, to))) out.push(`${prov.draft_pools_sha256}.json`);
    const wrote = 'file' in unsupported
      ? keep(dir, prov.unsupported_sha256, (to) => copyFileSync(unsupported.file, to))
      : keep(dir, prov.unsupported_sha256, (to) => writeFileSync(to, JSON.stringify({ unsupported: unsupported.list })));
    if (wrote) out.push(`${prov.unsupported_sha256}.json`);
  } catch (err) {
    console.error(`booster archive ${dir}: ${String((err as Error)?.message ?? err)}`);
  }
  return out;
}

/**
 * The unsupported-card list for the card overrides applied to the card data (`supported`: the sidecar's cards, see
 * card-overrides.ts adjustUnsupported): those cards come off the list, and a card whose override is retired or stale
 * goes back on. A changed file is rewritten in place after its previous bytes are archived in `dir` by hash (events that
 * ran on them resume and verify on them); a list that can't be written (or never was a file) is used from memory, and
 * archived at start like any markers list. Returns undefined when nothing changes.
 */
export function adjustForOverrides(source: { file: string } | { list: string[] }, list: string[], supported: string[], dir: string):
  { unsupported: string[]; source: { file: string } | { list: string[] }; removed: string[] } | undefined {
  const raw = 'file' in source ? readFileSync(source.file) : undefined;
  const doc = raw ? (JSON.parse(raw.toString('utf8')) as UnsupportedDoc) : { unsupported: list };
  const adj = adjustUnsupported(doc, supported);
  if (!adj.changed) return undefined;
  const unsupported = adj.doc.unsupported;
  const removed = adj.doc.removed_by_overrides ?? [];
  if (!('file' in source) || !raw) return { unsupported, source: { list: unsupported }, removed };
  try {
    mkdirSync(dir, { recursive: true });
    keep(dir, createHash('sha256').update(raw).digest('hex'), (to) => writeFileSync(to, raw));
    const tmp = `${source.file}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(adj.doc));
    renameSync(tmp, source.file);
    return { unsupported, source, removed };
  } catch (err) {
    console.error(`unsupported-card list ${source.file}: ${String((err as Error)?.message ?? err)}; using the adjusted list from memory`);
    return { unsupported, source: { list: unsupported }, removed };
  }
}

/** The archived file for a hash, checked against its name (a damaged copy is never used). */
export function findArchived(dirs: string[], sha: string): string | undefined {
  if (!SHA_RE.test(sha)) return undefined;
  for (const d of dirs) {
    const f = join(d, `${sha}.json`);
    if (!existsSync(f)) continue;
    if (createHash('sha256').update(readFileSync(f)).digest('hex') === sha) return f;
  }
  return undefined;
}

/** An event's booster data can't be found: the event can't resume on its own packs. */
export class BoosterDataMissing extends Error {}

/**
 * BoosterFactories for events whose booster data differs from what this process runs on, built once per data version
 * from the archive. `current` is the factory of this process with its provenance.
 */
export class BoosterFactories {
  private built = new Map<string, BoosterFactory>();

  constructor(private current: { factory: BoosterFactory; boosters?: BoosterProvenance }, private dirs: string[]) {}

  /**
   * The factory an event started on (event_start.boosters: its data and its generator); the current one when it is the
   * same or unrecorded. A log without a generator predates generator ids: boosters-v1.
   */
  forEvent(b: Partial<BoosterProvenance> | undefined): BoosterFactory {
    const cur = this.current.boosters;
    if (!b || !cur) return this.current.factory;
    const generator = b.generator ?? 'boosters-v1';
    const sameGenerator = generator === this.current.factory.generator;
    if (!b.draft_pools_sha256) return sameGenerator ? this.current.factory : this.build(`|${generator}`, undefined, undefined, generator);
    if (sameGenerator && b.draft_pools_sha256 === cur.draft_pools_sha256 && b.unsupported_sha256 === cur.unsupported_sha256) return this.current.factory;
    const key = `${b.draft_pools_sha256}|${b.unsupported_sha256}|${generator}`;
    const hit = this.built.get(key);
    if (hit) return hit;
    const pools = b.draft_pools_sha256 === cur.draft_pools_sha256 ? undefined : findArchived(this.dirs, b.draft_pools_sha256);
    const unsupported = b.unsupported_sha256 && b.unsupported_sha256 !== cur.unsupported_sha256 ? findArchived(this.dirs, b.unsupported_sha256) : undefined;
    if (b.draft_pools_sha256 !== cur.draft_pools_sha256 && !pools) {
      throw new BoosterDataMissing(`the event's booster data (draft pools ${b.draft_pools_sha256.slice(0, 12)}…) isn't in the archive (${this.dirs.join(', ')})`);
    }
    if (b.unsupported_sha256 && b.unsupported_sha256 !== cur.unsupported_sha256 && !unsupported) {
      throw new BoosterDataMissing(`the event's unsupported-card list (${b.unsupported_sha256.slice(0, 12)}…) isn't in the archive (${this.dirs.join(', ')})`);
    }
    return this.build(key, pools, unsupported, generator);
  }

  private build(key: string, pools: string | undefined, unsupported: string | undefined, generator: string): BoosterFactory {
    const hit = this.built.get(key);
    if (hit) return hit;
    const list = unsupported ? (JSON.parse(readFileSync(unsupported, 'utf8')).unsupported as string[]) : this.current.factory.unsupportedNames();
    const f = new BoosterFactory(pools ?? this.current.factory.poolsPath, list, generator);
    this.built.set(key, f);
    return f;
  }
}
