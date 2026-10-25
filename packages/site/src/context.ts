/**
 * Shared loading for both renderers (HTML site and JSON data export): command-line paths,
 * event logs, card data, and the optional human-reference inputs (17Lands-derived files in sets/<SET>/).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { CardDb, loadRatings, loadRuns, type EventData, type LegacyGame, type Ratings } from './data.js';
import { readArchetypes, type ArchetypeRatings } from './inputs.js';
import { readDeckNorms, type DeckNorms } from './build-quality.js';
import { isLive, redactLive } from './live-redact.js';
import { spectatePolicyFromEnv } from '../../director/src/spectate-policy.js';
import { PROMPTS_DIR, promptsHash, promptVersionOf } from '../../director/src/prompts.js';
import type { SiteNav } from './html.js';
import type { ContributorPublic } from './scoring.js';

export interface Ctx {
  events: EventData[];
  legacy: LegacyGame[];
  cards: CardDb;
  ratingsFor: (set: string) => Ratings | null;
  /** 17Lands GIH WR by color pair (sets/<SET>/17lands-archetypes.json), when present. */
  archetypesFor: (set: string) => ArchetypeRatings | null;
  /** Deck norms of winning human decks + build-quality scoring parameters (sets/<SET>/deck-norms.json), when present. */
  normsFor: (set: string) => DeckNorms | null;
  /** Bootstrap replicates for ratings, outcome and diagnostic intervals (--bootstrap). */
  replicates: number;
  /** Set codes (upper case) that appear in at least one event, sorted. */
  sets: string[];
  /** Featured sets (sets/rotation.json), upper case. Every set is playable; these are the ones the site highlights. */
  featured: Set<string>;
  /** A set context (knowledge level "primer") exists in sets/<SET>/primer.md. */
  hasSetContext: (set: string) => boolean;
  nav: SiteNav;
  builtAt: number;
  /**
   * Which Hub contributors are public now (the Hub's export passes its current setting). Absent (every other export):
   * no handle from the logs is known to be public, so none is exported.
   */
  contributorPublic?: ContributorPublic;
  /**
   * The prompt keys of the current prompts (scoring.ts promptKey): the main board is the main condition with these
   * prompts, and nothing else (no older group stands in while the current one has no rated games). Default:
   * currentPromptKeys() of this checkout's prompts/.
   */
  mainPrompts: string[];
}

/**
 * The prompt keys the current prompts have in event logs: `sha256:<12 hex>` of prompts/ (event_start.prompt_sha256, every
 * log since 2.9), plus the archive folder with the same content ("v6") for logs that only named it.
 */
export function currentPromptKeys(dir = PROMPTS_DIR): string[] {
  const sha = promptsHash(dir);
  if (!sha) return [];
  const version = promptVersionOf(dir, dir);
  return [`sha256:${sha.slice(0, 12)}`, ...(/^v\d+$/.test(version) ? [version] : [])];
}

const here = dirname(fileURLToPath(import.meta.url));
export const pkgDir = resolve(here, '..');
export const repoRoot = resolve(pkgDir, '..', '..');

/** Parse `--runs --sets --cards --out` (out defaults to `packages/site/<defaultOut>`) and load everything. */
export function loadContext(defaultOut: string): { ctx: Ctx; out: string } {
  const { values: args } = parseArgs({
    options: {
      runs: { type: 'string', default: join(repoRoot, 'runs') },
      sets: { type: 'string', default: join(repoRoot, 'sets') },
      cards: { type: 'string', default: join(repoRoot, 'data', 'card-data.slim.json') },
      out: { type: 'string', default: join(pkgDir, defaultOut) },
      bootstrap: { type: 'string', default: '1000' },
    },
  });
  const now = Date.now();
  const loaded = loadRuns(resolve(args.runs!), now);
  // Events still running are exported under the spectator fairness policy (same env as the Director). With
  // SPECTATE=admin or off, the live view is private, so running events are left out of the public export too.
  const policy = spectatePolicyFromEnv(process.env);
  const events = policy.access === 'public' ? loaded.events : loaded.events.filter((ev) => !isLive(ev));
  const { legacy } = loaded;
  for (const ev of events) redactLive(ev, policy);
  const cards = new CardDb(resolve(args.cards!));
  if (!cards.loaded) console.warn(`card data not found at ${args.cards}: deck types, curves and colors will be limited`);
  const ctx = makeContext({ events, legacy, cards, setsDir: resolve(args.sets!), replicates: Math.max(0, Number(args.bootstrap) || 0), now });
  return { ctx, out: resolve(args.out!) };
}

/**
 * Build a context from already-loaded events (the Hub keeps parsed events in memory and exports
 * incrementally). Ratings and archetype files are read lazily per set and cached for this context.
 */
export function makeContext(o: { events: EventData[]; legacy?: LegacyGame[]; cards: CardDb; setsDir: string; replicates: number; now?: number; contributorPublic?: ContributorPublic; mainPrompts?: string[] }): Ctx {
  const now = o.now ?? Date.now();
  const ratingsCache = new Map<string, Ratings | null>();
  const ratingsFor = (set: string): Ratings | null => {
    const k = set.toUpperCase();
    if (!ratingsCache.has(k)) ratingsCache.set(k, loadRatings(o.setsDir, k));
    return ratingsCache.get(k)!;
  };
  const archCache = new Map<string, ArchetypeRatings | null>();
  const archetypesFor = (set: string): ArchetypeRatings | null => {
    const k = set.toUpperCase();
    if (!archCache.has(k)) archCache.set(k, readArchetypes(o.setsDir, k));
    return archCache.get(k)!;
  };
  const normsCache = new Map<string, DeckNorms | null>();
  const normsFor = (set: string): DeckNorms | null => {
    const k = set.toUpperCase();
    if (!normsCache.has(k)) normsCache.set(k, readDeckNorms(o.setsDir, k));
    return normsCache.get(k)!;
  };
  const events = [...o.events].sort((a, b) => b.startT - a.startT);
  const sets = [...new Set(events.map((e) => e.set.code.toUpperCase()))].sort();
  const featured = new Set<string>();
  try {
    const rot = JSON.parse(readFileSync(join(o.setsDir, 'rotation.json'), 'utf8')) as { featured?: Array<{ code: string }>; active?: Array<{ code: string }> };
    for (const s of rot.featured ?? rot.active ?? []) featured.add(s.code.toUpperCase());
  } catch {
    // no rotation file: nothing featured
  }
  const hasSetContext = (set: string) => /^[A-Za-z0-9]{2,8}$/.test(set) && existsSync(join(o.setsDir, set.toUpperCase(), 'primer.md'));
  return {
    events, legacy: o.legacy ?? [], cards: o.cards, ratingsFor, archetypesFor, normsFor, replicates: o.replicates, sets, featured, hasSetContext, nav: { sets }, builtAt: now,
    mainPrompts: o.mainPrompts ?? currentPromptKeys(),
    ...(o.contributorPublic ? { contributorPublic: o.contributorPublic } : {}),
  };
}
