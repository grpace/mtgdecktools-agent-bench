import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { PackCard } from './boosters.js';

const BASIC_NAMES = new Set(['Plains', 'Island', 'Swamp', 'Mountain', 'Forest', 'Wastes']);

/** Value of a card missing from a set's win-rate file (sets that have one): unchanged since boosters-v1. */
const RARITY_PRIOR: Record<string, number> = { mythic: 0.575, rare: 0.565, uncommon: 0.552, common: 0.54, special: 0.55, bonus: 0.55 };

// ---------------------------------------------------------------------------
// Card-quality heuristic (no win-rate data): docs/METHODOLOGY.md §5.1 "Card quality"

/** Version of the card-quality heuristic; bump it with any change to `cardQuality` (it shapes bot drafts and metrics). */
export const CARD_QUALITY_VERSION = 'cq-1';

/** What the heuristic reads: booster-sheet facts plus the card text, all from phase-rs data (no outside ratings). */
export interface QualityCard {
  name: string;
  rarity?: string;
  typeLine: string;
  /** Mana cost as "{2}{W}{U/B}" (preferred), else `cmc` and `colors` are used. */
  cost?: string;
  cmc?: number;
  colors?: string[];
  /** "3/4", "*\/*" … */
  pt?: string;
  oracle?: string;
}

/** Card text lookup (the Director's CardDb and the site's CardDb both fit). */
export interface CardTextLookup {
  get(name: string): { cost: string; typeLine: string; pt?: string; oracle: string } | undefined;
}

const RARITY_BASE: Record<string, number> = { common: 0.535, uncommon: 0.539, rare: 0.547, mythic: 0.56, special: 0.538, bonus: 0.538 };

/** Keyword abilities worth something in Limited combat, in win-rate points (fractions). */
const KEYWORD_BONUS: Record<string, number> = {
  flying: 0.01, 'double strike': 0.01, menace: 0.005, deathtouch: 0.006, trample: 0.003, lifelink: 0.004, 'first strike': 0.004,
  vigilance: 0.002, haste: 0.003, hexproof: 0.003, ward: 0.003, reach: 0.001, flash: 0.003, indestructible: 0.006, prowess: 0.002,
  skulk: 0.003, shadow: 0.008, fear: 0.006, intimidate: 0.006, horsemanship: 0.008, landwalk: 0.002, swampwalk: 0.002,
  islandwalk: 0.002, forestwalk: 0.002, mountainwalk: 0.002, plainswalk: 0.002, 'protection from': 0.003,
};

/**
 * Interaction found in the rules text: the strongest match counts (not the sum). Patterns are matched on the
 * lower-cased text with reminder text removed.
 */
const INTERACTION: Array<{ re: RegExp; value: number; kind: string }> = [
  { re: /\b(destroy|exile) target (\w+ )*(creature|permanent|planeswalker)\b/, value: 0.025, kind: 'removal' },
  { re: /\bdestroy all (\w+ )*creatures\b|\ball creatures get -\d+\/-\d+/, value: 0.02, kind: 'sweeper' },
  { re: /\bdeals? (\d+|x) damage to (any target|target (\w+ )*creature|each creature|target (\w+ )*(planeswalker|permanent))/, value: 0.022, kind: 'removal' },
  { re: /\btarget (\w+ )*creature( an opponent controls)? gets -(\d+|x)\/-(\d+|x)/, value: 0.022, kind: 'removal' },
  { re: /\b(fights?|deals damage equal to its power to) (up to one )?(another )?target\b/, value: 0.015, kind: 'removal' },
  { re: /\benchanted creature can't attack or block\b|\benchanted creature can't attack\b|\bdoesn't untap during its controller's untap step\b/, value: 0.015, kind: 'removal' },
  { re: /\b(target )?(player|opponent) sacrifices a creature\b|\beach opponent sacrifices a creature\b/, value: 0.015, kind: 'removal' },
  { re: /\breturn target (\w+ )*(creature|permanent) to its owner's hand\b/, value: 0.006, kind: 'tempo' },
  { re: /\bcounter target (\w+ )*spell\b/, value: 0.006, kind: 'counter' },
  { re: /\btap target (\w+ )*creature\b/, value: 0.003, kind: 'tempo' },
];

const TOKEN_RE = /\bcreate (a|an|one|two|three|x|\d+) .*?(creature )?tokens?\b/;
const DRAW_RE = /\bdraws? (a|two|three|x|\d+) cards?\b/;
const ETB_RE = /\bwhen (this creature|this permanent|~|[a-z ,'-]+) enters\b/;

function stripReminder(text: string): string {
  return text.replace(/\([^)]*\)/g, '').toLowerCase();
}

/** Keywords on keyword-only lines ("Flying, vigilance", "Ward {2}", "Protection from black"). */
export function keywordsOf(oracle: string | undefined): string[] {
  const out: string[] = [];
  for (const raw of (oracle ?? '').split('\n')) {
    const line = stripReminder(raw).trim();
    if (!line) continue;
    const parts = line.split(/,\s*|;\s*/).map((p) => p.trim()).filter(Boolean);
    const kws = parts.map((p) => Object.keys(KEYWORD_BONUS).find((k) => p === k || p.startsWith(`${k} `)) ?? (/^\w+walk$/.test(p) ? 'landwalk' : undefined));
    if (kws.every((k) => k != null)) out.push(...(kws as string[]));
  }
  return [...new Set(out)];
}

/** The interaction a card offers (removal, sweeper, tempo, counter) and its bonus, or null. */
export function interactionOf(oracle: string | undefined): { kind: string; value: number } | null {
  const text = stripReminder(oracle ?? '');
  let best: { kind: string; value: number } | null = null;
  for (const it of INTERACTION) if (it.re.test(text) && (!best || it.value > best.value)) best = { kind: it.kind, value: it.value };
  return best;
}

function costFacts(c: QualityCard): { mv: number; colors: string[]; maxPips: number } {
  if (c.cost) {
    let mv = 0;
    const pips: Record<string, number> = {};
    for (const m of c.cost.matchAll(/\{([^}]+)\}/g)) {
      const s = m[1]!;
      if (/^\d+$/.test(s)) mv += Number(s);
      else if (s !== 'X') mv += 1;
      if (/^[WUBRG]$/.test(s)) pips[s] = (pips[s] ?? 0) + 1; // hybrid and Phyrexian pips don't commit to a color
    }
    return { mv, colors: Object.keys(pips), maxPips: Math.max(0, ...Object.values(pips)) };
  }
  return { mv: c.cmc ?? 0, colors: c.colors ?? [], maxPips: 1 };
}

const num = (s: string | undefined): number | undefined => (s != null && /^-?\d+$/.test(s) ? Number(s) : undefined);

/**
 * A 17Lands-free estimate of a card's Limited value, on the same scale as a games-in-hand win rate (about
 * 0.47–0.63, replacement level near 0.53), so it can stand in where no human win-rate data exists. It reads only
 * card data: rarity, mana value, power/toughness against mana value, combat keywords, removal and other
 * interaction, card advantage, and how hard the card is to cast (colors, heavy pips). Documented in
 * docs/METHODOLOGY.md §5.1; validated against 17Lands GIH WR in analysis/results/card-quality.md.
 */
export function cardQuality(c: QualityCard): number {
  return cardQualityParts(c).value;
}

export interface QualityParts {
  value: number;
  base: number; body: number; keywords: number; interaction: number; advantage: number; cost: number; type: number;
  roles: { creature: boolean; interaction: string | null; early: boolean; top_end: boolean };
}

export function cardQualityParts(c: QualityCard): QualityParts {
  const type = c.typeLine ?? '';
  const isLand = /\bLand\b/.test(type);
  const { mv, colors, maxPips } = costFacts(c);
  const oracle = c.oracle ?? '';
  const text = stripReminder(oracle);
  const creature = /\bCreature\b/.test(type);
  const inter = interactionOf(oracle);
  const roles = { creature, interaction: inter?.kind ?? null, early: !isLand && mv <= 2, top_end: !isLand && mv >= 5 };
  const zero = { base: 0, body: 0, keywords: 0, interaction: 0, advantage: 0, cost: 0, type: 0 };
  if (/^Basic\b/.test(type) || BASIC_NAMES.has(c.name)) return { value: 0.3, ...zero, roles };
  if (isLand && !creature) {
    // Below playable spells (a deck gets its basics anyway); fixing a little above other lands.
    const produces = new Set([...oracle.matchAll(/\{([WUBRG])\}/g)].map((m) => m[1]));
    const fetchesBasic = /search your library for a basic land/.test(text);
    const v = produces.size >= 2 || fetchesBasic ? 0.49 : 0.48;
    return { value: v, ...zero, base: v, roles };
  }
  const base = (RARITY_BASE[c.rarity ?? ''] ?? 0.535) + (creature ? 0.004 : 0);
  let body = 0;
  if (creature) {
    const [ps, ts] = (c.pt ?? '').split('/');
    const p = num(ps);
    const t = num(ts);
    if (p != null && t != null) body = Math.max(-3, Math.min(3, p + t - 2 * Math.max(1, mv))) * 0.004;
    if (ETB_RE.test(text)) body += 0.003;
    if (/^defender\b/m.test(text)) body -= 0.008;
  }
  const keywords = creature ? Math.min(0.02, keywordsOf(oracle).reduce((s, k) => s + (KEYWORD_BONUS[k] ?? 0), 0)) : 0;
  const interaction = inter?.value ?? 0;
  let advantage = 0;
  if (DRAW_RE.test(text)) advantage += /\bdraws? (two|three|x|[2-9]) cards?\b/.test(text) ? 0.008 : 0.005;
  if (TOKEN_RE.test(text)) advantage += 0.006;
  advantage = Math.min(0.012, advantage);
  let cost = 0;
  // Two-color cards are usually strong for their cost (they are drafted into their own pair); three or more
  // colors are hard to cast. Colorless cards fit any deck but are, on average, filler.
  if (colors.length >= 3) cost -= 0.01;
  if (colors.length === 0) cost -= 0.004;
  if (maxPips >= 3) cost -= 0.003;
  if (!creature && !inter && mv >= 5) cost -= 0.004 * (mv - 4);
  let typeAdj = 0;
  if (/\bPlaneswalker\b/.test(type)) typeAdj += 0.03;
  if (/\bAura\b/.test(type) && !inter) typeAdj -= 0.004;
  // Non-creature cards that neither interact nor draw cards: tricks, auras, odd effects.
  if (!creature && !inter && !/\bPlaneswalker\b/.test(type)) typeAdj -= advantage ? 0.004 : 0.01;
  const value = Math.max(0.47, Math.min(0.63, base + body + keywords + interaction + advantage + cost + typeAdj));
  return { value, base, body, keywords, interaction, advantage, cost, type: typeAdj, roles };
}

// ---------------------------------------------------------------------------
// Ratings used by bot drafters and the reference deck builder

export type RatingsPolicy = 'win-rates' | 'card-quality';

export interface RatingsOptions {
  /** Card text for the card-quality heuristic (without it the heuristic reads only rarity, mana value and type). */
  cards?: CardTextLookup;
  /** 'card-quality' ignores any win-rate file (ablations, tests). Default: win rates when the set has them. */
  policy?: RatingsPolicy;
  /**
   * Per-event copy of the win-rate file (e.g. runs/<id>/ratings-17lands.json). When it exists it is read instead of
   * sets/<SET>/17lands.json; otherwise the set's file is copied there. A 17Lands refresh (npm run deps -- update
   * 17lands) therefore never changes an event that is already running: a resumed event keeps the snapshot it
   * started with, so replayed bot picks still match the log and fallback picks/builds use the same values.
   */
  pin?: string;
}

/** Which 17Lands snapshot valued the picks: logged in event_start.ratings_snapshot (deps/manifest.json ids). */
export interface RatingsSnapshot {
  /** deps/manifest.json snapshot id, e.g. "FRA.PremierDraft@2026-10-19T16:20:26Z" (null for files from before ids). */
  id: string | null;
  /** sha256 of the 17lands.json bytes the values were read from. */
  sha256: string;
  /** Date range of the 17Lands games behind the file. */
  date_range?: { first: string | null; last: string | null };
  /** 'pinned' when read from the event's own copy (a resumed event), else 'sets'. */
  from: 'sets' | 'pinned';
}

/**
 * Card values used by bot drafters and the reference deck builder.
 *  - Sets with human win-rate data (`sets/<SET>/17lands.json`, 17Lands public datasets): GIH WR, and the rarity
 *    prior for the few cards missing from the file (unchanged, so bots and reference builds stay reproducible).
 *  - Every other set: the card-quality heuristic (`cardQuality`), from card data alone.
 */
export class Ratings {
  private gih = new Map<string, number>();
  private ata = new Map<string, number>();
  private quality = new Map<string, number>();
  readonly policy: RatingsPolicy;
  /** The set has human win-rate data (whatever the policy). */
  readonly hasStats: boolean;
  /** Human-readable bot policy, logged in event_start.ratings. */
  readonly source: string;
  /** The 17Lands snapshot behind the values (undefined without win-rate data). */
  readonly snapshot?: RatingsSnapshot;

  constructor(setsDir: string, set: string, private opts: RatingsOptions = {}) {
    const setFile = join(setsDir, set.toUpperCase(), '17lands.json');
    const pinned = !!opts.pin && existsSync(opts.pin);
    let bytes: Buffer | undefined = pinned ? readFileSync(opts.pin!) : existsSync(setFile) ? readFileSync(setFile) : undefined;
    if (opts.pin && !pinned) {
      // Pin what the event starts with, including "no win-rate data", so a later refresh can't switch policies mid-event.
      mkdirSync(dirname(opts.pin), { recursive: true });
      writeFileSync(opts.pin, bytes ?? JSON.stringify({ no_win_rates: true }));
    }
    let data: any = bytes ? JSON.parse(bytes.toString('utf8')) : undefined;
    if (data?.no_win_rates) bytes = data = undefined;
    this.hasStats = !!data;
    if (bytes && data) {
      this.snapshot = {
        id: typeof data.snapshot === 'string' ? data.snapshot : null,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        ...(data.date_range ? { date_range: { first: data.date_range.first ?? null, last: data.date_range.last ?? null } } : {}),
        from: pinned ? 'pinned' : 'sets',
      };
      for (const [name, c] of Object.entries<any>(data.cards ?? {})) {
        const key = name.split(' // ')[0]!.toLowerCase();
        if (typeof c.gih_wr === 'number') this.gih.set(key, c.gih_wr);
        if (typeof c.ata === 'number') this.ata.set(key, c.ata);
      }
    }
    this.policy = opts.policy ?? (this.hasStats ? 'win-rates' : 'card-quality');
    this.source = this.policy === 'win-rates'
      ? `17Lands GIH WR (${this.gih.size} cards)`
      : `card-quality heuristic ${CARD_QUALITY_VERSION} (${this.hasStats ? 'win rates ignored' : 'no win-rate data for this set'})`;
  }

  /** Whether a set has human win-rate data (sets/<SET>/17lands.json). */
  static hasStats(setsDir: string, set: string): boolean {
    return existsSync(join(setsDir, set.toUpperCase(), '17lands.json'));
  }

  /** Human 17Lands stats for display, e.g. "17Lands: GIH WR 58.2%, ATA 3.1", or '' when unknown. */
  statsLabel(name: string): string {
    const key = name.split(' // ')[0]!.toLowerCase();
    const g = this.gih.get(key);
    const a = this.ata.get(key);
    if (g === undefined && a === undefined) return '';
    const gih = g === undefined ? 'GIH WR n/a' : `GIH WR ${(g * 100).toFixed(1)}%`;
    return `17Lands: ${gih}${a === undefined ? '' : `, ATA ${a.toFixed(1)}`}`;
  }

  value(card: PackCard): number {
    // Basics first: their 17Lands GIH WR is high (they're in every deck) but nobody should draft them.
    if (/^Basic Land/.test(card.typeLine) || BASIC_NAMES.has(card.name)) return 0.3;
    if (this.policy === 'card-quality') return this.qualityOf(card);
    const known = this.gih.get(card.name.toLowerCase());
    if (known !== undefined) return known;
    const prior = RARITY_PRIOR[card.rarity] ?? 0.54;
    return prior + (/Creature/.test(card.typeLine) ? 0.004 : 0);
  }

  private qualityOf(card: PackCard): number {
    const key = card.name.toLowerCase();
    let v = this.quality.get(key);
    if (v === undefined) {
      const t = this.opts.cards?.get(card.name);
      v = cardQuality({
        name: card.name, rarity: card.rarity, typeLine: t?.typeLine || card.typeLine, cmc: card.cmc, colors: card.colors,
        ...(t ? { cost: t.cost, pt: t.pt, oracle: t.oracle } : {}),
      });
      this.quality.set(key, v);
    }
    return v;
  }
}

export const COLORS = ['W', 'U', 'B', 'R', 'G'] as const;

/** Color weights of a pool: sum of (value above replacement) per color. */
export function colorWeights(pool: PackCard[], ratings: Ratings): Record<string, number> {
  const w: Record<string, number> = { W: 0, U: 0, B: 0, R: 0, G: 0 };
  for (const c of pool) {
    const v = Math.max(0, ratings.value(c) - 0.5);
    for (const col of c.colors) if (col in w) w[col] = w[col]! + v / c.colors.length;
  }
  return w;
}

export function topColors(pool: PackCard[], ratings: Ratings, n = 2): string[] {
  const w = colorWeights(pool, ratings);
  return Object.entries(w).sort((a, b) => b[1] - a[1]).slice(0, n).map(([c]) => c);
}
