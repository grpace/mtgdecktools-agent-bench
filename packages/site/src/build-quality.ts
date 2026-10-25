/**
 * Archetype build quality (docs/METHODOLOGY.md §5.2): how good is a deck in its own color pair, judged by
 * 17Lands archetype ratings, compared with the reference build and with the best deck the same pool could
 * produce under the same scoring; plus structural checks against the norms of winning human decks.
 *
 * Inputs (both written by analysis/draft_eval):
 *   sets/<SET>/17lands-archetypes.json   per-card shrunk GIH WR in each color pair (archetypes.py)
 *   sets/<SET>/deck-norms.json           per-pair norms of winning human decks + scoring parameters (build_eval.py)
 *
 * The scoring mirrors analysis/draft_eval/build_eval.py exactly (the validation on held-out 17Lands games is run
 * there); keep the two in step.
 *
 *   prior(card)    = overall GIH WR (+ splash_delta if it needs a color outside P)
 *   lift(card, P)  = shrunk GIH WR in P − base[P] + baseline   (the card's lift in this archetype; prior when the cell isn't listed)
 *   value(card, P) = w · lift + (1 − w) · prior                 (w: archetype weight fitted per set on held-out games)
 *                  = replacement[P]                             (a colored pip with no source among the lands)
 *   quality        = mean value over the non-land card copies with 17Lands data
 *   expected_wr    = σ(logit(baseline) + slope · (quality − quality_ref) · 100 + pair_base · (base[P] − baseline) · 100)
 *                    (coefficients fitted on held-out 17Lands games with player skill and play/draw held fixed)
 *
 * The reference builder is re-implemented read-only from packages/director/src/build.ts (autoBuild); the test
 * suite checks it against decks the Director logged as `by: "auto"`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BASICS, type CardDb, type Ratings } from './data.js';
import { archetypeValue, normPair, type ArchetypeRatings } from './inputs.js';

const COLORS = 'WUBRG';
export const PAIRS = ['WU', 'WB', 'WR', 'WG', 'UB', 'UR', 'UG', 'BR', 'BG', 'RG'];
const BASIC_COLOR: Record<string, string> = { Plains: 'W', Island: 'U', Swamp: 'B', Mountain: 'R', Forest: 'G', Wastes: '' };

// ---------------------------------------------------------------------------
// deck-norms.json

/** p10, p25, p50, p75, p90 */
export type Quantiles = [number, number, number, number, number];

export interface PairNorm {
  decks: number;
  lands?: Quantiles; nonland?: Quantiles; creatures?: Quantiles; two_minus?: Quantiles; five_plus?: Quantiles; avg_mv?: Quantiles;
  src_primary?: Quantiles; src_secondary?: Quantiles; src_splash?: Quantiles;
  splash_share?: number;
  quality?: Quantiles;
  replacement?: number;
}

export interface DeckNorms {
  set: string;
  baseline?: number;
  splashDelta: number;
  /** Weight of the archetype-specific lift vs the overall rating (1 = lift only). */
  archetypeWeight: number;
  qualityRef?: number;
  slope?: number;
  pairBase?: number;
  verdict: string; // "validated" | "weak" (from the held-out 17Lands validation)
  validation: Record<string, unknown>;
  pairs: Map<string, PairNorm>;
  generatedAt?: string;
}

const isQ = (x: unknown): x is Quantiles => Array.isArray(x) && x.length === 5 && x.every((v) => typeof v === 'number');
const num = (x: unknown): number | undefined => (typeof x === 'number' && Number.isFinite(x) ? x : undefined);

export function readDeckNorms(setsDir: string, code: string): DeckNorms | null {
  const path = join(setsDir, code.toUpperCase(), 'deck-norms.json');
  if (!existsSync(path)) return null;
  let j: any;
  try {
    j = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
  const sc = j?.scoring ?? {};
  const pairs = new Map<string, PairNorm>();
  for (const [b, v] of Object.entries<any>(j?.pairs ?? {})) {
    const n: PairNorm = { decks: num(v?.decks) ?? 0 };
    for (const k of ['lands', 'nonland', 'creatures', 'two_minus', 'five_plus', 'avg_mv', 'src_primary', 'src_secondary', 'src_splash', 'quality'] as const) {
      if (isQ(v?.[k])) n[k] = v[k];
    }
    if (num(v?.splash_share) != null) n.splash_share = v.splash_share;
    if (num(v?.replacement) != null) n.replacement = v.replacement;
    pairs.set(normPair(b), n);
  }
  return {
    set: code.toUpperCase(),
    baseline: num(sc.baseline_win_rate),
    splashDelta: num(sc.splash_delta) ?? 0,
    archetypeWeight: Math.min(1, Math.max(0, num(sc.archetype_weight) ?? 1)),
    qualityRef: num(sc.quality_ref),
    slope: num(sc.slope_logit_per_pp),
    pairBase: num(sc.pair_base_logit_per_pp),
    verdict: typeof sc.verdict === 'string' ? sc.verdict : 'unvalidated',
    validation: sc.validation && typeof sc.validation === 'object' ? sc.validation : {},
    pairs,
    generatedAt: typeof j?.generated_at === 'string' ? j.generated_at : undefined,
  };
}

// ---------------------------------------------------------------------------
// Card facts (mirrors analysis/draft_eval/cards.py)

export interface CardFacts {
  land: boolean;
  basic: boolean;
  creature: boolean;
  /** Colors of single-color pips (hard requirements). */
  pips: string;
  /** Hybrid pips: each group is satisfied by any one of its colors. */
  hybrid: string[];
  /** Colors the card shows (hard, hybrid, Phyrexian): MTGJSON-style `colors` for non-lands. */
  colors: string;
  mv: number;
  /** Colors a land can produce. */
  produces: string;
  known: boolean;
}

const wubrg = (s: string): string => COLORS.split('').filter((c) => s.includes(c)).join('');

export function cardFacts(name: string, cards: CardDb): CardFacts {
  const front = name.split(' // ')[0]!;
  if (BASICS.has(front)) {
    return { land: true, basic: true, creature: false, pips: '', hybrid: [], colors: '', mv: 0, produces: BASIC_COLOR[front] ?? '', known: true };
  }
  const c = cards.get(name);
  if (!c) return { land: false, basic: false, creature: false, pips: '', hybrid: [], colors: '', mv: 0, produces: '', known: false };
  const tl = c.typeLine.split('//')[0]!;
  const land = /Land/.test(tl);
  let pips = '';
  const hybrid: string[] = [];
  let shown = '';
  let mv = 0;
  for (const m of c.cost.matchAll(/\{([^}]+)\}/g)) {
    const t = m[1]!.toUpperCase();
    if (/^\d+$/.test(t)) mv += Number(t);
    else if (COLORS.includes(t) && t.length === 1) {
      pips += t;
      shown += t;
      mv += 1;
    } else if (t.includes('/')) {
      const parts = t.split('/');
      const cols = parts.filter((p) => COLORS.includes(p) && p.length === 1);
      shown += cols.join('');
      if (parts.includes('P') || parts.some((p) => /^\d+$/.test(p))) mv += Math.max(1, ...parts.filter((p) => /^\d+$/.test(p)).map(Number));
      else if (cols.length) {
        hybrid.push(wubrg(cols.join('')));
        mv += 1;
      }
    } else if (!['X', 'Y', 'Z'].includes(t)) mv += 1;
  }
  let produces = '';
  if (land) {
    const added = [...c.oracle.matchAll(/[Aa]dd ([^.]*)/g)].map((x) => x[1]!).join(' ');
    produces = wubrg([...added.matchAll(/\{([WUBRG])\}/g)].map((x) => x[1]!).join(''));
    if (/any (one )?color/.test(c.oracle)) produces = COLORS;
  }
  return { land, basic: false, creature: /Creature/.test(tl), pips: wubrg(pips), hybrid, colors: land ? '' : wubrg(shown), mv, produces, known: true };
}

// ---------------------------------------------------------------------------
// Deck shape and quality

export interface DeckShape {
  lands: number;
  nonland: number;
  creatures: number;
  two_minus: number;
  five_plus: number;
  avg_mv: number;
  src_primary: number | null;
  src_secondary: number | null;
  src_splash: number | null;
  sources: Record<string, number>;
}

export interface DeckQuality {
  pair: string;
  /** Mean archetype value of the non-land cards (fraction, GIH WR scale); null without data. */
  quality: number | null;
  /** Calibrated expected game win rate against the 17Lands population; null when the set has no calibration. */
  expected_wr: number | null;
  rated: number;
  unrated: string[];
  /** Cards with a colored pip that no land in the deck produces (valued at replacement level). */
  dead: string[];
  /** Cards that need a color outside the pair (castable: the deck has a source). */
  splash: string[];
  shape: DeckShape;
}

export interface QualityInputs {
  cards: CardDb;
  arch: ArchetypeRatings;
  norms: DeckNorms | null;
}

function overallOf(arch: ArchetypeRatings, name: string): number | undefined {
  return arch.overall?.get(name) ?? arch.overall?.get(name.split(' // ')[0]!);
}

const replCache = new WeakMap<ArchetypeRatings, Map<string, number | undefined>>();

/** Replacement level of a pair on the lift scale: from deck-norms.json, else the 10th percentile of the pair's non-land cells. */
export function replacementLevel(inp: QualityInputs, pair: string): number | undefined {
  const fromNorms = inp.norms?.pairs.get(pair)?.replacement;
  if (fromNorms != null) return fromNorms;
  let m = replCache.get(inp.arch);
  if (!m) replCache.set(inp.arch, (m = new Map()));
  if (m.has(pair)) return m.get(pair);
  const base = inp.arch.base?.get(pair);
  const baseline = inp.arch.baseline;
  const vals = [...(inp.arch.pairs.get(pair)?.entries() ?? [])].filter(([n]) => !cardFacts(n, inp.cards).land).map(([, v]) => v.gih).sort((a, b) => a - b);
  let v: number | undefined;
  if (vals.length && base != null && baseline != null) {
    const pos = (vals.length - 1) * 0.1;
    const lo = Math.floor(pos);
    v = vals[lo]! + (vals[Math.ceil(pos)]! - vals[lo]!) * (pos - lo) - base + baseline;
  }
  m.set(pair, v);
  return v;
}

/** A card's archetype value in `pair` on the lift scale (see the header); undefined without data. */
export function cardValue(inp: QualityInputs, pair: string, name: string, dead: boolean, splash: boolean): number | undefined {
  const { arch } = inp;
  const ov = overallOf(arch, name);
  const base = arch.base?.get(pair);
  if (ov == null || base == null || arch.baseline == null) return undefined;
  if (dead) return replacementLevel(inp, pair);
  const prior = ov + (splash ? (inp.norms?.splashDelta ?? 0) : 0);
  const cell = archetypeValue(arch, pair, name);
  if (cell == null) return prior;
  const w = inp.norms?.archetypeWeight ?? 1;
  return w * (cell - base + arch.baseline) + (1 - w) * prior;
}

/** Calibrated expected 17Lands game win rate of a deck of this quality in `pair`; null without calibration. */
export function expectedWinRate(inp: QualityInputs, pair: string, quality: number | null): number | null {
  const n = inp.norms;
  if (!n || quality == null || n.slope == null || n.qualityRef == null || n.baseline == null) return null;
  const b = n.baseline;
  const base = inp.arch.base?.get(pair);
  const z = Math.log(b / (1 - b)) + n.slope * (quality - n.qualityRef) * 100 + (n.pairBase != null && base != null ? n.pairBase * (base - b) * 100 : 0);
  return 1 / (1 + Math.exp(-z));
}

const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;

/** Quality and shape of a main deck (basics included) in `pair` (the deck's main colors). */
export function deckQuality(main: string[], pair: string, inp: QualityInputs): DeckQuality {
  const facts = new Map<string, CardFacts>();
  const f = (n: string) => {
    let x = facts.get(n);
    if (!x) facts.set(n, (x = cardFacts(n, inp.cards)));
    return x;
  };
  const sources: Record<string, number> = { W: 0, U: 0, B: 0, R: 0, G: 0 };
  let lands = 0;
  const spells: string[] = [];
  for (const n of main) {
    const c = f(n);
    if (c.land) {
      lands++;
      for (const col of c.produces) sources[col]!++;
    } else spells.push(n);
  }
  const need: Record<string, number> = {};
  for (const n of spells) for (const col of f(n).pips) need[col] = (need[col] ?? 0) + 1;
  const prim = pair.split('').sort((a, b) => (need[b] ?? 0) - (need[a] ?? 0) || COLORS.indexOf(a) - COLORS.indexOf(b));
  const splashCols = Object.keys(need).filter((c) => !pair.includes(c)).sort();
  const mvs = spells.map((n) => f(n).mv);
  const shape: DeckShape = {
    lands,
    nonland: spells.length,
    creatures: spells.filter((n) => f(n).creature).length,
    two_minus: mvs.filter((v) => v <= 2).length,
    five_plus: mvs.filter((v) => v >= 5).length,
    avg_mv: mvs.length ? mean(mvs) : 0,
    src_primary: prim[0] ? sources[prim[0]]! : null,
    src_secondary: prim[1] ? sources[prim[1]]! : null,
    src_splash: splashCols.length ? Math.min(...splashCols.map((c) => sources[c]!)) : null,
    sources,
  };
  const values: number[] = [];
  const unrated: string[] = [];
  const dead: string[] = [];
  const splash: string[] = [];
  for (const n of spells) {
    const c = f(n);
    const isDead = [...c.pips].some((col) => !sources[col]) || c.hybrid.some((h) => ![...h].some((col) => sources[col]));
    const isSplash = [...c.pips].some((col) => !pair.includes(col)) || c.hybrid.some((h) => ![...h].some((col) => pair.includes(col)));
    if (isDead) dead.push(n);
    else if (isSplash) splash.push(n);
    const v = cardValue(inp, pair, n, isDead, isSplash);
    if (v == null) unrated.push(n);
    else values.push(v);
  }
  const quality = values.length ? mean(values) : null;
  return { pair, quality, expected_wr: expectedWinRate(inp, pair, quality), rated: values.length, unrated, dead, splash, shape };
}

// ---------------------------------------------------------------------------
// Structural checks against the archetype norms of winning human decks

export interface StructuralFlag { check: string; value: number; band: [number, number] }

/** Checks outside the p10–p90 band of winning human decks in the pair (`splash_sources_low`: below max(3, p10)). */
export function structuralFlags(q: DeckQuality, norms: DeckNorms | null): { checked: string[]; flags: StructuralFlag[] } {
  const n = norms?.pairs.get(q.pair);
  const s = q.shape;
  const checked: string[] = [];
  const flags: StructuralFlag[] = [];
  const band = (k: keyof PairNorm): [number, number] | null => {
    const v = n?.[k];
    return isQ(v) ? [v[0], v[4]] : null;
  };
  const low = (check: string, k: keyof PairNorm, v: number | null) => {
    const b = band(k);
    if (!b || v == null) return;
    checked.push(check);
    if (v < b[0]) flags.push({ check, value: v, band: b });
  };
  const high = (check: string, k: keyof PairNorm, v: number | null) => {
    const b = band(k);
    if (!b || v == null) return;
    checked.push(check);
    if (v > b[1]) flags.push({ check, value: v, band: b });
  };
  low('lands_low', 'lands', s.lands);
  high('lands_high', 'lands', s.lands);
  low('creatures_low', 'creatures', s.creatures);
  low('two_drops_low', 'two_minus', s.two_minus);
  high('top_heavy', 'five_plus', s.five_plus);
  high('curve_high', 'avg_mv', Math.round(s.avg_mv * 1000) / 1000);
  low('primary_sources_low', 'src_primary', s.src_primary);
  low('secondary_sources_low', 'src_secondary', s.src_secondary);
  if (s.src_splash != null) {
    const b = band('src_splash');
    const lo = Math.max(3, b?.[0] ?? 3);
    checked.push('splash_sources_low');
    if (s.src_splash < lo) flags.push({ check: 'splash_sources_low', value: s.src_splash, band: [lo, b?.[1] ?? lo] });
  }
  checked.push('uncastable_cards');
  if (q.dead.length) flags.push({ check: 'uncastable_cards', value: q.dead.length, band: [0, 0] });
  return { checked, flags };
}

// ---------------------------------------------------------------------------
// Reference builder (read-only re-implementation of packages/director/src/build.ts autoBuild + ratings.ts)

const RARITY_PRIOR: Record<string, number> = { mythic: 0.575, rare: 0.565, uncommon: 0.552, common: 0.54, special: 0.55, bonus: 0.55 };
const BASIC_NAMES = new Set(['Plains', 'Island', 'Swamp', 'Mountain', 'Forest', 'Wastes']);
const BASIC_OF: Record<string, string> = { W: 'Plains', U: 'Island', B: 'Swamp', R: 'Mountain', G: 'Forest' };

interface RefCard { name: string; colors: string[]; typeLine: string; rarity: string }

/** The Director's Ratings.value: 17Lands GIH WR by lower-case name, basics 0.3, else a rarity prior. */
function directorValue(gih: Map<string, number>, c: RefCard): number {
  if (/^Basic Land/.test(c.typeLine) || BASIC_NAMES.has(c.name)) return 0.3;
  const known = gih.get(c.name.toLowerCase());
  if (known !== undefined) return known;
  return (RARITY_PRIOR[c.rarity] ?? 0.54) + (/Creature/.test(c.typeLine) ? 0.004 : 0);
}

const gihCache = new WeakMap<Ratings, Map<string, number>>();
function gihMap(ratings: Ratings | null): Map<string, number> {
  if (!ratings) return new Map();
  let m = gihCache.get(ratings);
  if (!m) {
    m = new Map();
    for (const [name, r] of ratings.cards) if (typeof r.gih_wr === 'number') m.set(name.split(' // ')[0]!.toLowerCase(), r.gih_wr);
    gihCache.set(ratings, m);
  }
  return m;
}

export interface ReferenceDeck { lane: string; main: string[]; spells: string[]; basics: Record<string, number> }

/**
 * autoBuild: the two colors with the most rating above 0.5 in the pool, the top 23 cards (by GIH WR) whose
 * colors are all in those two, and 40 − that many basics split by the color count of those cards.
 * `pool` is the seat's picks in pick order (front-face names); `rarity` from the pack logs.
 */
const REF_MAX_NONBASIC_LANDS = 3;
const LAND_SUBTYPE_COLOR: Record<string, string> = { Plains: 'W', Island: 'U', Swamp: 'B', Mountain: 'R', Forest: 'G' };

/** The Director's landColors (build.ts): colors from "Add …" rules text, "any color" → all five, plus basic land types. */
function refLandColors(c: RefCard, cards: CardDb): string[] {
  const out = new Set<string>();
  const text = cards.get(c.name)?.oracle ?? '';
  if (/one mana of any colou?r|mana of any one colou?r/i.test(text)) return ['W', 'U', 'B', 'R', 'G'];
  for (const m of text.matchAll(/Add ([^.\n]+)/g)) for (const sym of m[1]!.matchAll(/\{([WUBRG])\}/g)) out.add(sym[1]!);
  for (const word of c.typeLine.split(/[\s—-]+/)) if (LAND_SUBTYPE_COLOR[word]) out.add(LAND_SUBTYPE_COLOR[word]!);
  return [...out];
}

export function referenceBuild(pool: string[], ratings: Ratings | null, cards: CardDb, rarity: (name: string) => string | undefined = () => undefined): ReferenceDeck {
  const gih = gihMap(ratings);
  const rc: RefCard[] = pool.map((name) => {
    const info = cards.get(name);
    const f = cardFacts(name, cards);
    const typeLine = info?.typeLine ?? (BASIC_NAMES.has(name) ? `Basic Land — ${name}` : '');
    return { name, colors: f.land ? [] : f.colors.split('').filter(Boolean), typeLine, rarity: rarity(name) ?? 'common' };
  });
  const w: Record<string, number> = { W: 0, U: 0, B: 0, R: 0, G: 0 };
  for (const c of rc) {
    const v = Math.max(0, directorValue(gih, c) - 0.5);
    for (const col of c.colors) if (col in w) w[col] = w[col]! + v / c.colors.length;
  }
  const lane = Object.entries(w).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([c]) => c);
  // Mirrors the Director's autoBuild (build.ts): 23 non-land spells, then 17 lands, counting up to
  // REF_MAX_NONBASIC_LANDS on-color non-basic lands from the pool toward them.
  const isLand = (c: RefCard) => /\bLand\b/.test(c.typeLine);
  const spells = rc
    .filter((c) => !isLand(c))
    .filter((c) => c.colors.every((col) => lane.includes(col)))
    .sort((a, b) => directorValue(gih, b) - directorValue(gih, a))
    .slice(0, 23);
  const landSlots = 40 - spells.length;
  const nonbasics = rc
    .filter((c) => isLand(c) && !/^Basic Land/.test(c.typeLine) && !BASIC_NAMES.has(c.name))
    .filter((c) => {
      const makes = refLandColors(c, cards);
      return makes.some((col) => lane.includes(col)) && (makes.length >= 5 || makes.every((col) => lane.includes(col)));
    })
    .sort((a, b) => directorValue(gih, b) - directorValue(gih, a))
    .slice(0, Math.min(REF_MAX_NONBASIC_LANDS, landSlots));
  const main = [...spells, ...nonbasics];
  const pips: Record<string, number> = {};
  for (const c of spells) for (const col of c.colors) pips[col] = (pips[col] ?? 0) + 1;
  const total = lane.reduce((s, col) => s + (pips[col] ?? 0), 0) || 1;
  const basicCount = landSlots - nonbasics.length;
  const first = Math.round((basicCount * (pips[lane[0]!] ?? 0)) / total);
  const basics: Record<string, number> = { [BASIC_OF[lane[0]!]!]: first, [BASIC_OF[lane[1]!]!]: basicCount - first };
  const deck = main.map((c) => c.name);
  for (const [name, n] of Object.entries(basics)) for (let i = 0; i < n; i++) deck.push(name);
  return { lane: normPair(lane.join('')), main: deck, spells: spells.map((c) => c.name), basics };
}

// ---------------------------------------------------------------------------
// Best deck under the same scoring

export interface BestDeck { pair: string; quality: number; expected_wr: number | null; lands: number; spells: string[] }

/**
 * The best two-color deck the pool can make under the same scoring: for every color pair, the top
 * (40 − L) castable non-land cards by archetype value, with L the median land count of winning human decks
 * in that pair (17 without norms). No splashes. Mean value, as in deckQuality; missing playables count at the
 * pair's replacement level. Pairs are compared by expected
 * win rate when the set is calibrated (it adds the archetype's base-rate term), else by quality.
 */
export function bestBuild(pool: string[], inp: QualityInputs): BestDeck | null {
  let best: BestDeck | null = null;
  for (const pair of PAIRS) {
    const L = Math.round(inp.norms?.pairs.get(pair)?.lands?.[2] ?? 17);
    const cands: Array<{ name: string; v: number }> = [];
    for (const n of pool) {
      const c = cardFacts(n, inp.cards);
      if (c.land || !c.known) continue;
      if ([...c.pips].some((col) => !pair.includes(col))) continue;
      if (c.hybrid.some((h) => ![...h].some((col) => pair.includes(col)))) continue;
      const v = cardValue(inp, pair, n, false, false);
      if (v != null) cands.push({ name: n, v });
    }
    if (!cands.length) continue;
    cands.sort((a, b) => b.v - a.v || a.name.localeCompare(b.name));
    const top = cands.slice(0, 40 - L);
    // A pair without enough playables can't field a deck: empty slots count at the pair's replacement level
    // (otherwise three great cards in a third pair would "win").
    const repl = replacementLevel(inp, pair);
    if (top.length < 40 - L && repl == null) continue;
    const vals = [...top.map((x) => x.v), ...Array<number>(40 - L - top.length).fill(repl ?? 0)];
    const q = mean(vals);
    const e = expectedWinRate(inp, pair, q);
    const better = !best || (e != null && best.expected_wr != null ? e > best.expected_wr : q > best.quality);
    if (better) best = { pair, quality: q, expected_wr: e, lands: L, spells: top.map((x) => x.name) };
  }
  return best;
}

// ---------------------------------------------------------------------------
// Per seat

export interface SeatBuildQuality {
  pair: string;
  build_quality: number | null;
  expected_wr: number | null;
  reference_pair: string;
  reference_quality: number | null;
  reference_expected_wr: number | null;
  best_pair: string | null;
  best_quality: number | null;
  best_expected_wr: number | null;
  /** (build − reference) quality, percentage points. */
  build_delta_pp: number | null;
  /** (build − best) quality, percentage points (≤ 0 unless a splash or extra lands help). */
  vs_best_pp: number | null;
  /** Same as build_delta_pp, in calibrated expected win rate (pp). */
  build_delta_wr_pp: number | null;
  /** Same as vs_best_pp, in calibrated expected win rate (pp). */
  vs_best_wr_pp: number | null;
  shape: DeckShape;
  checked: string[];
  flags: StructuralFlag[];
  unrated: string[];
  dead: string[];
  splash: string[];
  /** Validation label of the set's score ("validated" | "weak" | "unvalidated"). */
  verdict: string;
}

export function seatBuildQuality(main: string[], pair: string, pool: string[], ratings: Ratings | null, inp: QualityInputs, rarity?: (name: string) => string | undefined): SeatBuildQuality | null {
  if (!pair || !inp.arch.base || inp.arch.baseline == null) return null;
  const q = deckQuality(main, pair, inp);
  const ref = referenceBuild(pool, ratings, inp.cards, rarity);
  const refPair = refPairOf(ref, inp.cards) || ref.lane;
  const rq = deckQuality(ref.main, refPair, inp);
  const best = bestBuild(pool, inp);
  const { checked, flags } = structuralFlags(q, inp.norms);
  const pp = (a: number | null | undefined, b: number | null | undefined) => (a != null && b != null ? (a - b) * 100 : null);
  return {
    pair,
    build_quality: q.quality,
    expected_wr: q.expected_wr,
    reference_pair: refPair,
    reference_quality: rq.quality,
    reference_expected_wr: rq.expected_wr,
    best_pair: best?.pair ?? null,
    best_quality: best?.quality ?? null,
    best_expected_wr: best?.expected_wr ?? null,
    build_delta_pp: pp(q.quality, rq.quality),
    vs_best_pp: pp(q.quality, best?.quality),
    build_delta_wr_pp: pp(q.expected_wr, rq.expected_wr),
    vs_best_wr_pp: pp(q.expected_wr, best?.expected_wr),
    shape: q.shape,
    checked,
    flags,
    unrated: q.unrated,
    dead: q.dead,
    splash: q.splash,
    verdict: inp.norms?.verdict ?? 'unvalidated',
  };
}

/** Main pair of the reference deck, by the same rule as scoring.mainPair (colors ≥ 2 non-land cards strictly need). */
function refPairOf(ref: ReferenceDeck, cards: CardDb): string {
  const count: Record<string, number> = {};
  for (const n of ref.spells) {
    const c = cardFacts(n, cards);
    if (c.land) continue;
    for (const col of c.pips) count[col] = (count[col] ?? 0) + 1;
  }
  return normPair(
    Object.entries(count)
      .filter(([, n]) => n >= 2)
      .sort((a, b) => b[1] - a[1] || COLORS.indexOf(a[0]) - COLORS.indexOf(b[0]))
      .slice(0, 2)
      .map(([c]) => c)
      .join(''),
  );
}
