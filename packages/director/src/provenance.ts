/**
 * What produced an event, logged in event_start so results can be compared and verified:
 * the Director version, the pinned engine build, and the exact booster data packs were generated from.
 */
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { CardDataProvenance } from './cards.js';

/**
 * Version of the booster generator, logged as event_start.boosters.generator. The Hub regenerates every
 * pack from the seed with the code it runs (packages/hub/src/packs.ts) and only trusts the generator id it
 * knows, so BUMP THIS (boosters-v2, …) in the same commit as any change to:
 *   - pack generation (boosters.ts: variants, slots, sheets, swaps of unsupported cards),
 *   - the Rng (rng.ts),
 *   - the seat shuffle (event.ts: rng.shuffle of seat positions before the draft),
 *   - the bots' use of the Rng during the draft (draft.ts botPick: one rng.next() per card in the pack).
 * Keep the older generators runnable (BoosterFactory's `generator`, BOOSTER_GENERATORS in boosters.ts): the Hub
 * verifies, and the Director resumes, each event on the generator it started with.
 */
export const BOOSTER_GENERATOR = 'boosters-v2';

export interface BoosterProvenance {
  generator: string;
  /** sha256 of the draft-pools.json bytes the BoosterFactory loaded. */
  draft_pools_sha256: string;
  /** sha256 of the unsupported-cards.json bytes ({ unsupported: [...] }) the factory was built with. */
  unsupported_sha256: string;
  unsupported_count: number;
  /** Where the unsupported list came from: a file (archivable by its sha256) or the build's own markers. */
  unsupported_source?: 'file' | 'markers';
}

const sha256 = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');

/**
 * Booster provenance for the files the factory is built from. `unsupported` is either the file that was
 * read (hash its exact bytes: the Hub looks archived lists up by that hash) or, when there was no file, the
 * list itself (hashed as the JSON a file would hold).
 */
export function boosterProvenance(draftPoolsPath: string, unsupported: { file: string } | { list: string[] }): BoosterProvenance {
  const pools = sha256(readFileSync(draftPoolsPath));
  if ('file' in unsupported) {
    const bytes = readFileSync(unsupported.file);
    const list = (JSON.parse(bytes.toString('utf8')).unsupported ?? []) as string[];
    return { generator: BOOSTER_GENERATOR, draft_pools_sha256: pools, unsupported_sha256: sha256(bytes), unsupported_count: list.length, unsupported_source: 'file' };
  }
  return {
    generator: BOOSTER_GENERATOR, draft_pools_sha256: pools, unsupported_sha256: sha256(JSON.stringify({ unsupported: unsupported.list })),
    unsupported_count: unsupported.list.length, unsupported_source: 'markers',
  };
}

let cachedDirector: string | undefined;

/**
 * The Director version: DIRECTOR_TAG when set (container builds; deploy/deploy.sh and `bench up` add
 * `-dirty` for uncommitted changes), else the git commit with `-dirty` when tracked files have local changes.
 */
export function directorVersion(): string {
  if (process.env.DIRECTOR_TAG) return process.env.DIRECTOR_TAG;
  if (cachedDirector) return cachedDirector;
  try {
    cachedDirector = execSync('git describe --always --dirty --abbrev=7 --exclude "*"', { cwd: import.meta.dirname, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || 'unknown';
  } catch {
    cachedDirector = 'unknown';
  }
  return cachedDirector;
}

/**
 * What produced this event: Director version, pinned engine build and, when known, the card data phase-server runs
 * (its hash and the local card overrides applied to it: cards.ts cardDataProvenance). Lets results be compared safely.
 */
export function provenance(cardData?: CardDataProvenance): Record<string, unknown> {
  let engine: Record<string, unknown> = {};
  try {
    const lock = JSON.parse(readFileSync(new URL('../../../engine/phase.lock.json', import.meta.url), 'utf8'));
    engine = { server_version: lock.server_version, build_commit: lock.build_commit, protocol_version: lock.protocol_version, digest: lock.digest };
  } catch {
    // lock file missing: leave engine empty
  }
  return { director: directorVersion(), engine, ...(cardData ? { card_data: cardData } : {}) };
}
