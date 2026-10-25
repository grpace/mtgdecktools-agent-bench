/**
 * Draft and deck metrics that need nothing but card data and the event log, so they work for every set
 * (docs/METHODOLOGY.md §5.1 "Core draft metrics"): color flow (signal reading), on-color rate and pair changes
 * (drafting consistency), and role coverage of the final deck against generic Limited norms. Card quality comes
 * from the same heuristic the bots use in sets without human win-rate data (packages/director/src/ratings.ts).
 */
import { cardQuality, interactionOf, keywordsOf } from '../../director/src/ratings.js';
import { BASICS, type CardDb, type Pick } from './data.js';
import type { PairNorm } from './build-quality.js';

const COLORS = ['W', 'U', 'B', 'R', 'G'] as const;

/** Cards below this heuristic value are filler: passing them says nothing about what is open. */
export const FLOW_FLOOR = 0.535;
/** Pack 1, picks 2–9: what the upstream seats chose to pass (pick 1 is an unopened pack; late picks are leftovers). */
export const FLOW_PICKS: [number, number] = [2, 9];

/** Heuristic card quality from card data (and the rarity seen on the booster sheet, when known). */
export function qualityOf(cards: CardDb, name: string, rarity?: string): number {
  const c = cards.get(name);
  if (!c) return BASICS.has(name) ? 0.3 : 0.535;
  return cardQuality({ name, rarity, typeLine: c.typeLine, cost: c.cost, pt: c.pt, oracle: c.oracle });
}

export interface Flow {
  /** Share of the above-filler quality passed in each color (sums to 1), WUBRG. */
  shares: Record<string, number>;
  /** The two colors that flowed most, WUBRG order ("" when nothing was passed). */
  top: string;
  /** Packs counted. */
  packs: number;
}

/**
 * Color flow: for every pack the seat saw in pack 1, picks 2–9, each non-land card adds its quality above
 * FLOW_FLOOR to the colors it needs (split evenly for gold cards; colorless and hybrid-only cards add nothing).
 */
export function colorFlow(picks: Pick[], cards: CardDb): Flow | null {
  if (!cards.loaded) return null;
  const open: Record<string, number> = { W: 0, U: 0, B: 0, R: 0, G: 0 };
  let packs = 0;
  for (const p of picks) {
    if (p.packNumber !== 1 || p.pickNumber < FLOW_PICKS[0] || p.pickNumber > FLOW_PICKS[1]) continue;
    packs++;
    p.contents.forEach((name, i) => {
      if (cards.isLand(name)) return;
      const need = cards.requiredColors(name);
      if (!need) return;
      const w = Math.max(0, qualityOf(cards, name, p.rarities?.[i]) - FLOW_FLOOR);
      for (const col of need) open[col] = open[col]! + w / need.length;
    });
  }
  const total = Object.values(open).reduce((s, x) => s + x, 0);
  if (!packs || total <= 0) return null;
  const shares = Object.fromEntries(COLORS.map((c) => [c, open[c]! / total]));
  const top = COLORS.filter((c) => open[c]! > 0).sort((a, b) => open[b]! - open[a]! || COLORS.indexOf(a) - COLORS.indexOf(b)).slice(0, 2);
  return { shares, top: COLORS.filter((c) => top.includes(c)).join(''), packs };
}

/** Share of `final` colors among the flow's top two (random choice ≈ 0.4). */
export function flowAlignment(flow: Flow | null, final: string): number | null {
  if (!flow || flow.top.length < 2 || !final) return null;
  return [...final].filter((c) => flow.top.includes(c)).length / final.length;
}

/** 1/0 per real, non-land pick in packs 2–3: castable with the final colors (colorless and hybrid count as on-color). */
export function onColorPicks(picks: Pick[], cards: CardDb, final: string, chose: (p: Pick) => boolean): number[] {
  if (!cards.loaded || !final) return [];
  const out: number[] = [];
  for (const p of picks) {
    if (p.packNumber < 2 || !chose(p) || p.contents.length < 2 || BASICS.has(p.pick) || cards.isLand(p.pick)) continue;
    out.push([...cards.requiredColors(p.pick)].every((c) => final.includes(c)) ? 1 : 0);
  }
  return out;
}

/**
 * How often the seat's two most-drafted colors changed, from its 6th pick on (`pairAt(k)` = top pair of the
 * first k picks). Descriptive: some changes are good reading, many are wandering.
 */
export function pairChanges(prefixPairs: string[]): number | null {
  if (prefixPairs.length < 6) return null;
  let n = 0;
  for (let k = 6; k < prefixPairs.length; k++) {
    const a = prefixPairs[k - 1]!;
    const b = prefixPairs[k]!;
    if (a.length === 2 && b.length === 2 && a !== b) n++;
  }
  return n;
}

// ---------------------------------------------------------------------------
// Role coverage of a deck against generic Limited norms

/** Generic 40-card Limited norms (METHODOLOGY §5.1). Each check passes inside the band. */
export const ROLE_NORMS = {
  lands_16_18: { lo: 16, hi: 18, label: '16–18 lands' },
  creatures_12_plus: { lo: 12, hi: Infinity, label: 'at least 12 creatures' },
  early_6_plus: { lo: 6, hi: Infinity, label: 'at least 6 plays at mana value 2 or less' },
  top_end_6_max: { lo: 0, hi: 6, label: 'at most 6 cards at mana value 5 or more' },
  avg_mv_2_5_3_5: { lo: 2.5, hi: 3.5, label: 'average mana value 2.5–3.5' },
  interaction_2_plus: { lo: 2, hi: Infinity, label: 'at least 2 interaction spells' },
} as const;
export type RoleCheck = keyof typeof ROLE_NORMS;

/** Fewest 17Lands winning decks of a pair before its own norms replace the generic bands. */
export const PAIR_NORM_MIN_DECKS = 200;

export interface RoleBand { lo: number; hi: number; label: string }
export interface RoleBasis {
  /** set_pair: the middle 80% (p10–p90) of 17Lands decks with 6+ wins in this set and color pair (sets/<SET>/deck-norms.json); generic: ROLE_NORMS. */
  basis: 'set_pair' | 'generic';
  bands: Record<RoleCheck, RoleBand>;
  /** "17Lands SOS WB decks with 6+ wins (2,987 decks), p10–p90"; null for generic. */
  source: string | null;
}

const q = (x: number) => (Number.isInteger(x) ? String(x) : x.toFixed(1));

/**
 * The bands a deck is checked against (METHODOLOGY §5.1): the set and pair's own norms when the set has deck-norms.json
 * with enough winning decks of that pair (p10–p90; lands p10 − 1 to p90 + 1), else the generic Limited bands.
 * Interaction has no 17Lands norm: generic.
 */
export function roleBands(norm?: { set: string; pair: string; norm: PairNorm } | null): RoleBasis {
  const generic = Object.fromEntries((Object.keys(ROLE_NORMS) as RoleCheck[]).map((k) => [k, { ...ROLE_NORMS[k] }])) as Record<RoleCheck, RoleBand>;
  const n = norm?.norm;
  if (!n || n.decks < PAIR_NORM_MIN_DECKS || !n.lands || !n.creatures || !n.two_minus || !n.five_plus || !n.avg_mv) return { basis: 'generic', bands: generic, source: null };
  // Lands: nearly every winning deck runs 17 (p10 = p90), so the band is widened by one land each way.
  const [l10, l90] = [n.lands[0] - 1, n.lands[4] + 1];
  const bands: Record<RoleCheck, RoleBand> = {
    lands_16_18: { lo: l10, hi: l90, label: `${q(l10)}–${q(l90)} lands` },
    creatures_12_plus: { lo: n.creatures[0], hi: Infinity, label: `at least ${q(n.creatures[0])} creatures` },
    early_6_plus: { lo: n.two_minus[0], hi: Infinity, label: `at least ${q(n.two_minus[0])} plays at mana value 2 or less` },
    top_end_6_max: { lo: 0, hi: n.five_plus[4], label: `at most ${q(n.five_plus[4])} cards at mana value 5 or more` },
    avg_mv_2_5_3_5: { lo: n.avg_mv[0], hi: n.avg_mv[4], label: `average mana value ${n.avg_mv[0].toFixed(2)}–${n.avg_mv[4].toFixed(2)}` },
    interaction_2_plus: generic.interaction_2_plus,
  };
  return { basis: 'set_pair', bands, source: `17Lands ${norm!.set} ${norm!.pair} decks with 6+ wins (${n.decks.toLocaleString('en-US')} decks), p10–p90` };
}

export interface DeckRoles {
  lands: number;
  nonland: number;
  creatures: number;
  early: number; // non-land cards at mana value ≤ 2
  top_end: number; // non-land cards at mana value ≥ 5
  avg_mv: number | null;
  interaction: number; // removal, sweepers, bounce, tapping, counters (rules-text patterns)
  removal: number; // the removal and sweeper part of it
  evasive: number; // creatures with flying, menace, trample, shadow, …, or "can't be blocked"
  checks: Record<RoleCheck, boolean>;
  passed: number;
  total: number;
  /** 2.17: what the checks were measured against (the set and pair's 17Lands norms, or the generic bands). */
  basis: RoleBasis['basis'];
  bands: Record<RoleCheck, RoleBand>;
  source: string | null;
}

const EVASION = new Set(['flying', 'menace', 'trample', 'shadow', 'fear', 'intimidate', 'skulk', 'horsemanship', 'landwalk', 'swampwalk', 'islandwalk', 'forestwalk', 'mountainwalk', 'plainswalk']);

export function deckRoles(main: string[], cards: CardDb, norm?: { set: string; pair: string; norm: PairNorm } | null): DeckRoles | null {
  if (!cards.loaded || !main.length) return null;
  const nonland = main.filter((n) => !BASICS.has(n) && !cards.isLand(n));
  const lands = main.length - nonland.length;
  let creatures = 0, early = 0, top = 0, interaction = 0, removal = 0, evasive = 0;
  const mvs: number[] = [];
  for (const n of nonland) {
    const c = cards.get(n);
    const mv = cards.mv(n) ?? 0;
    mvs.push(mv);
    if (mv <= 2) early++;
    if (mv >= 5) top++;
    const creature = /\bCreature\b/.test(c?.typeLine ?? '');
    if (creature) {
      creatures++;
      const oracle = c?.oracle ?? '';
      if (keywordsOf(oracle).some((k) => EVASION.has(k)) || /can't be blocked/i.test(oracle.replace(/\([^)]*\)/g, ''))) evasive++;
    }
    const it = interactionOf(c?.oracle);
    if (it) {
      interaction++;
      if (it.kind === 'removal' || it.kind === 'sweeper') removal++;
    }
  }
  const avg = mvs.length ? mvs.reduce((s, x) => s + x, 0) / mvs.length : null;
  const value: Record<RoleCheck, number | null> = {
    lands_16_18: lands, creatures_12_plus: creatures, early_6_plus: early, top_end_6_max: top, avg_mv_2_5_3_5: avg, interaction_2_plus: interaction,
  };
  const rb = roleBands(norm);
  const checks = Object.fromEntries((Object.keys(ROLE_NORMS) as RoleCheck[]).map((k) => {
    const v = value[k];
    return [k, v != null && v >= rb.bands[k].lo && v <= rb.bands[k].hi];
  })) as Record<RoleCheck, boolean>;
  const passed = Object.values(checks).filter(Boolean).length;
  return {
    lands, nonland: nonland.length, creatures, early, top_end: top, avg_mv: avg == null ? null : Math.round(avg * 100) / 100,
    interaction, removal, evasive, checks, passed, total: Object.keys(checks).length, basis: rb.basis, bands: rb.bands, source: rb.source,
  };
}

/** A two-color deck's 17Lands pair norm from the set's deck-norms.json (null for other color counts or no data). */
export function pairNormOf(norms: { set: string; pairs: Map<string, PairNorm> } | null | undefined, colors: string): { set: string; pair: string; norm: PairNorm } | null {
  const pair = 'WUBRG'.split('').filter((c) => colors.toUpperCase().includes(c)).join('');
  if (!norms || pair.length !== 2) return null;
  const n = norms.pairs.get(pair);
  return n ? { set: norms.set, pair, norm: n } : null;
}
