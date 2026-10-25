/**
 * Prompt v4 deckbuilding: the offer text, the submission check and the review, ported from the MTG Deck Tools AI
 * Deck Builder's 40-card Limited path (Magic-Deck-Builder src/pages/DeckBuilderPage.tsx, generateAiPromptString and
 * its result checks; parity checked by deck-parity.test.ts). The rules text lives in prompts/deckbuilding-guide.md.
 *
 * What the Director adds over a one-shot prompt: pool numbers instead of card names (no invented cards), exact counts
 * it computes itself (pool facts, the review), and a review round before the deck locks.
 */
import type { PackCard } from './boosters.js';
import { CardDb, v4Cost } from './cards.js';
import type { Knowledge } from './knowledge.js';
import type { Ratings } from './ratings.js';
import { compactJson } from './render-v4.js';

export const BASIC_OF: Record<string, string> = { W: 'Plains', U: 'Island', B: 'Swamp', R: 'Mountain', G: 'Forest' };
export const BASIC_LANDS = Object.values(BASIC_OF);
const COLOR_OF_BASIC: Record<string, string> = Object.fromEntries(Object.entries(BASIC_OF).map(([c, n]) => [n, c]));
const WUBRG = ['W', 'U', 'B', 'R', 'G'];
const COLOR_NAME: Record<string, string> = { W: 'white', U: 'blue', B: 'black', R: 'red', G: 'green' };
const GROUP_NAME: Record<string, string> = { W: 'White', U: 'Blue', B: 'Black', R: 'Red', G: 'Green' };
/** The deck size the guide asks for, and the rules minimum. */
export const DECK_SIZE = 40;
/**
 * The largest deck accepted (SEC-3). Limited has no maximum, but a deck far beyond any real one only costs the shared
 * rules engine memory and time: case and spacing variants of one basic once added 100,000+ lands.
 */
export const MAX_DECK_SIZE = 100;

export const isLandCard = (c: PackCard, cards?: CardDb): boolean => /\bLand\b/.test((cards?.get(c.name)?.typeLine ?? c.typeLine).split(' // ')[0]!);
export const isBasicLand = (c: PackCard): boolean => BASIC_LANDS.includes(c.name) || /^Basic Land/.test(c.typeLine);

/**
 * The colors of mana a land can make: from its rules text when the card data is at hand ("Add {G} or {W}",
 * "one mana of any color" → all five), else from basic land types in its type line ("Land — Forest Plains").
 */
export function landColors(card: PackCard, cards?: CardDb): string[] {
  const out = new Set<string>();
  const text = cards?.get(card.name)?.oracle ?? '';
  if (/one mana of any colou?r|mana of any one colou?r/i.test(text)) return [...WUBRG];
  for (const m of text.matchAll(/Add ([^.\n]+)/g)) for (const sym of m[1]!.matchAll(/\{([WUBRG])\}/g)) out.add(sym[1]!);
  for (const word of card.typeLine.split(/[\s—-]+/)) if (COLOR_OF_BASIC[word]) out.add(COLOR_OF_BASIC[word]!);
  return [...out];
}

/** A land that fetches a basic land (Evolving Wilds): a source of every color the deck has basics for. */
const fetchesBasic = (c: PackCard, cards?: CardDb): boolean => /search your library for a basic land/i.test(cards?.get(c.name)?.oracle ?? '');

// --- Costs -------------------------------------------------------------------------------------------------------

export interface CostNeeds {
  /** Hard colored pips per color ({W}{W} → W: 2). */
  hard: Record<string, number>;
  /** Color/color hybrid symbols, each the colors that can pay it ({R/G} → ['R', 'G']). */
  hybrid: string[][];
}

/** What a cost asks for in colored mana. Generic, colorless, X, {2/G} and phyrexian symbols ask for nothing. */
export function costNeeds(cost: string | undefined): CostNeeds {
  const out: CostNeeds = { hard: {}, hybrid: [] };
  for (const m of v4Cost(cost ?? '').matchAll(/\{([^}]+)\}/g)) {
    const parts = m[1]!.split('/');
    if (parts.includes('P') || parts.some((p) => /^\d+$/.test(p))) continue;
    const colors = parts.filter((p) => WUBRG.includes(p));
    if (colors.length === 1 && parts.length === 1) out.hard[colors[0]!] = (out.hard[colors[0]!] ?? 0) + 1;
    else if (colors.length > 1) out.hybrid.push(colors);
  }
  return out;
}

/** The cost has a hybrid symbol: color/color ({R/G}) or number/color ({2/G}). */
const hasHybrid = (cost: string | undefined): boolean => costNeeds(cost).hybrid.length > 0 || /\{2\/[WUBRG]\}/.test(v4Cost(cost ?? ''));

/** Color identity (WUBRG letters): colors plus every colored mana symbol in the costs and rules text (not reminder text) of every face. */
export function colorIdentity(c: PackCard, cards: CardDb): string {
  const info = cards.get(c.name);
  const set = new Set<string>([...(info?.colors ?? c.colors.join('')).split('')].filter((x) => WUBRG.includes(x)));
  const faces = [info, ...(info?.faces ?? []).map((f) => cards.get(f))];
  for (const f of faces) {
    if (!f) continue;
    const text = `${f.cost} ${(f.oracle ?? '').replace(/\([^)]*\)/g, '')}`;
    for (const m of text.matchAll(/\{([^}]+)\}/g)) for (const p of m[1]!.split('/')) if (WUBRG.includes(p)) set.add(p);
    for (const ch of f.colors ?? '') if (WUBRG.includes(ch)) set.add(ch);
  }
  // Lands: the colors they make, including basic land types and reminder text ("({T}: Add {B} or {R}.)").
  const makes = isLandCard(c, cards) ? landColors(c, cards) : [];
  if (makes.length < 5) for (const col of makes) set.add(col);
  return WUBRG.filter((x) => set.has(x)).join('');
}

// --- The pool ----------------------------------------------------------------------------------------------------

/** One card name in the pool with every physical copy's pool number (1-based, pick order). */
export interface PoolEntry {
  name: string;
  card: PackCard;
  numbers: number[];
}

/** The pool grouped by card name, in order of first pick. */
export function poolEntries(pool: PackCard[]): PoolEntry[] {
  const byName = new Map<string, PoolEntry>();
  pool.forEach((c, i) => {
    const e = byName.get(c.name);
    if (e) e.numbers.push(i + 1);
    else byName.set(c.name, { name: c.name, card: c, numbers: [i + 1] });
  });
  return [...byName.values()];
}

const RARITY_NAME: Record<string, string> = { common: 'common', uncommon: 'uncommon', rare: 'rare', mythic: 'mythic' };

/**
 * One deckbuilding pool entry as card JSON: "n" (the pool number to submit), "count" (copies drafted, the most you may
 * play), "poolNumbers" (each copy's number, when there are several), then the full printed card (every face, full rules
 * text) and its color identity, and 17Lands stats when the event shows them. No MTG Deck Tools tier score at any level
 * (owner decision): agents judge card power themselves, or with the 17Lands stats at Set Context + Human Stats.
 */
export function deckCardJson(e: PoolEntry, cards: CardDb, stats?: Ratings): Record<string, unknown> {
  const printed: Record<string, unknown> = cards.get(e.name)
    ? { ...cards.json(e.name) }
    : { name: e.name, mv: e.card.cmc, colors: e.card.colors.join('') || 'colorless', type: e.card.typeLine };
  // Color identity right after colors (MTG Deck Tools sends both; its mana rules refer to "colorIdentity").
  const withIdentity: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(printed)) {
    withIdentity[k] = v;
    if (k === 'colors') withIdentity.colorIdentity = colorIdentity(e.card, cards) || 'colorless';
  }
  const label = stats?.statsLabel(e.name).replace(/^17Lands:\s*/, '');
  return {
    n: e.numbers[0],
    count: e.numbers.length,
    ...(e.numbers.length > 1 ? { poolNumbers: e.numbers } : {}),
    rarity: RARITY_NAME[e.card.rarity] ?? e.card.rarity,
    ...withIdentity,
    ...(label ? { '17lands': label } : {}),
  };
}

const mvOf = (c: PackCard, cards: CardDb): number => cards.get(c.name)?.mv ?? c.cmc;
const typeOf = (c: PackCard, cards: CardDb): string => (cards.get(c.name)?.typeLine ?? c.typeLine).split(' // ')[0]!;
const isCreature = (c: PackCard, cards: CardDb): boolean => /Creature/.test(typeOf(c, cards));

/** Which colors can cast a card: castable with a color set when every hard pip is in it and every hybrid symbol has a color in it. */
function castableWith(c: PackCard, cards: CardDb, colors: Set<string>): boolean {
  const need = costNeeds(cards.get(c.name)?.cost);
  return Object.keys(need.hard).every((col) => colors.has(col)) && need.hybrid.every((h) => h.some((col) => colors.has(col)));
}

/** The glance group of a non-land card: its one color, "Hybrid" (only hybrid colored symbols), "Multicolor" or "Colorless". */
function glanceGroup(c: PackCard, cards: CardDb): string {
  const need = costNeeds(cards.get(c.name)?.cost);
  const hard = Object.keys(need.hard);
  const colors = c.colors.length ? c.colors : hard;
  if (!colors.length) return 'Colorless';
  if (!hard.length && need.hybrid.length) return 'Hybrid';
  if (colors.length === 1) return GROUP_NAME[colors[0]!] ?? colors[0]!;
  return 'Multicolor';
}

const PAIRS = ['WU', 'UB', 'BR', 'RG', 'GW', 'WB', 'UR', 'BG', 'RW', 'GU'];
const PAIR_NAMES: Record<string, string> = {
  WU: 'Azorius (WU)', UB: 'Dimir (UB)', BR: 'Rakdos (BR)', RG: 'Gruul (RG)', GW: 'Selesnya (GW)',
  WB: 'Orzhov (WB)', UR: 'Izzet (UR)', BG: 'Golgari (BG)', RW: 'Boros (RW)', GU: 'Simic (GU)',
};

/**
 * The exact pool facts the Director gives at deckbuilding, so the model never has to count them: by color (cards,
 * creatures, two-drops, each card once with its copies), non-basic lands, the copies, and castable cards per color pair.
 */
export function poolFacts(pool: PackCard[], cards: CardDb, ratings: Ratings, withStats: boolean): Record<string, unknown> {
  const all = poolEntries(pool);
  const entries = all.filter((e) => !isBasicLand(e.card));
  const nonland = entries.filter((e) => !isLandCard(e.card, cards));
  const lands = entries.filter((e) => isLandCard(e.card, cards));
  const copies = (list: PoolEntry[]) => list.reduce((s, e) => s + e.numbers.length, 0);
  const order = ['White', 'Blue', 'Black', 'Red', 'Green', 'Hybrid', 'Multicolor', 'Colorless'];
  const groups = new Map<string, PoolEntry[]>();
  for (const e of nonland) {
    const g = glanceGroup(e.card, cards);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push(e);
  }
  const named = (e: PoolEntry) => `${e.numbers.length > 1 ? `${e.numbers.length}× ` : ''}${e.name}`;
  const byColor = order.filter((g) => groups.has(g)).map((g) => {
    const list = groups.get(g)!.sort((a, b) => mvOf(a.card, cards) - mvOf(b.card, cards));
    return {
      group: g, cards: copies(list), creatures: copies(list.filter((e) => isCreature(e.card, cards))),
      mv2: copies(list.filter((e) => mvOf(e.card, cards) === 2)), list: list.map(named),
    };
  });
  // Castable cards per color pair: hybrid cards count for either color, colorless cards for every pair.
  const rows = PAIRS.map((pair) => {
    const set = new Set(pair.split(''));
    const fits = nonland.filter((e) => castableWith(e.card, cards, set)).flatMap((e) => e.numbers.map(() => e.card));
    const best = [...fits].sort((a, b) => ratings.value(b) - ratings.value(a)).slice(0, 23);
    const avg = (best.reduce((s, c) => s + ratings.value(c), 0) + (23 - best.length) * 0.48) / 23;
    return {
      pair: PAIR_NAMES[pair]!, cards: fits.length, creatures: fits.filter((c) => isCreature(c, cards)).length,
      mv2: fits.filter((c) => mvOf(c, cards) === 2).length, ...(withStats ? { best23_avg_gih_wr: Number((avg * 100).toFixed(1)) } : {}),
    };
  });
  rows.sort((a, b) => (withStats ? (b.best23_avg_gih_wr ?? 0) - (a.best23_avg_gih_wr ?? 0) : 0) || b.cards - a.cards || b.creatures - a.creatures);
  const basicsDrafted = copies(all.filter((e) => isBasicLand(e.card)));
  return {
    drafted: pool.length,
    listed: copies(entries),
    different: entries.length,
    ...(basicsDrafted ? { basics_drafted_not_listed: basicsDrafted } : {}),
    nonland: copies(nonland),
    creatures: copies(nonland.filter((e) => isCreature(e.card, cards))),
    by_color: byColor,
    nonbasic_lands: lands.map((e) => ({ name: e.name, count: e.numbers.length, n: e.numbers[0], makes: landColors(e.card, cards).join('') || 'none' })),
    copies: entries.filter((e) => e.numbers.length > 1).map((e) => ({ name: e.name, count: e.numbers.length, poolNumbers: e.numbers })),
    pairs_top5: rows.slice(0, 5),
  };
}

/** Render the guide template: {{#flag}}…{{/flag}} keeps the block when the flag is on, {{^flag}}…{{/flag}} when it's off. */
export function renderGuide(template: string, flags: Record<string, boolean>): string {
  let out = template;
  for (let guard = 0; guard < 50; guard++) {
    // Innermost blocks first: a block body without another opening tag.
    const m = out.match(/\{\{([#^])(\w+)\}\}((?:(?!\{\{[#^]\w+\}\})[\s\S])*?)\{\{\/\2\}\}/);
    if (!m) break;
    const keep = m[1] === '#' ? !!flags[m[2]!] : !flags[m[2]!];
    out = out.slice(0, m.index) + (keep ? m[3] : '') + out.slice(m.index! + m[0].length);
  }
  return out.replace(/\n{3,}/g, '\n\n').trim();
}

/** The prompt v4 deckbuilding decision. */
export function deckOfferV4(id: string, pool: PackCard[], cards: CardDb, ratings: Ratings, knowledge: Knowledge): string {
  const stats = knowledge.stats ? ratings : undefined;
  const entries = poolEntries(pool);
  const listed = entries.filter((e) => !isBasicLand(e.card));
  const basicsDrafted = entries.filter((e) => isBasicLand(e.card)).reduce((s, e) => s + e.numbers.length, 0);
  const sorted = [...listed].sort((a, b) => mvOf(a.card, cards) - mvOf(b.card, cards) || a.numbers[0]! - b.numbers[0]!);
  const nonbasicCopies = listed.reduce((s, e) => s + e.numbers.length, 0);
  const hybrid = listed.some((e) => hasHybrid(cards.get(e.name)?.cost));
  const lines = [
    `DECKBUILDING — build your 40-card deck from the ${pool.length} cards you drafted, plus any number of basic lands. Unused pool cards become your sideboard.`,
    '',
    `YOUR POOL: ${nonbasicCopies} cards, ${listed.length} different${basicsDrafted ? ` (the ${basicsDrafted} basic land${basicsDrafted === 1 ? '' : 's'} you drafted ${basicsDrafted === 1 ? 'is' : 'are'} left out: basics are unlimited)` : ''}. One line of card JSON per card, sorted by mana value.`,
    '"n" is the pool number you submit; "count" is how many copies you drafted, the most you may play; "poolNumbers" lists every copy\'s own number. The card data is complete: "text" is the full rules text and "faces" are the other faces of multi-face cards, each with its own cost and text.'
      + (stats ? ' "17lands" is human play data from 17Lands: GIH WR (win rate when the card was in hand) and ATA (average pick it was taken at).' : ''),
    ...sorted.map((e) => JSON.stringify(deckCardJson(e, cards, stats))),
    '',
    'POOL FACTS (counted by the Director, exact: "by_color" counts copies, "mv2" = cards at mana value 2, "pairs_top5" = castable non-land cards per color pair, hybrid cards counting for either color and colorless for every pair):',
    compactJson(poolFacts(pool, cards, ratings, knowledge.stats)),
  ];
  if (knowledge.guide) lines.push('', renderGuide(knowledge.guide, { set_context: !!knowledge.primer, stats: knowledge.stats, hybrid }));
  lines.push('', `DECISION ${id} — submit your deck: decide(decision_id="${id}", cards=[pool numbers, one per copy], basics={"Plains": 8, "Island": 9}, total_count=40, deck_name="…", archetype="…", analysis="…", note="<one-line plan>").`);
  return lines.join('\n');
}

// --- Submissions -------------------------------------------------------------------------------------------------

export interface DeckSubmission {
  /** Physical pool indices (0-based) of the main deck's pool cards, in submission order. */
  main: number[];
  /** Basic lands to add (canonical names, counts > 0). */
  basics: Record<string, number>;
}

/**
 * Check a deck submission and map it onto physical pool cards. A pool number may be repeated: each repeat takes
 * another copy of the same card (its other pool numbers), so [12, 12, 12] and [12, 30, 41] both mean three copies.
 * Returns every problem at once, each with what to do about it.
 */
export function resolveSubmission(pool: PackCard[], cardsIn: unknown[] | undefined, basicsIn: Record<string, unknown> | undefined): { ok: true; deck: DeckSubmission } | { ok: false; error: string } {
  const errors: string[] = [];
  const nums = cardsIn ?? [];
  const bad = nums.filter((n) => !(typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= pool.length));
  if (bad.length) errors.push(`Pool numbers run from 1 to ${pool.length}; ${bad.map((b) => JSON.stringify(b)).join(', ')} ${bad.length === 1 ? 'is' : 'are'} not in your pool. Use the "n" (or "poolNumbers") values from YOUR POOL.`);
  const entries = poolEntries(pool);
  const entryOf = new Map<number, PoolEntry>();
  for (const e of entries) for (const n of e.numbers) entryOf.set(n, e);
  // Requests per card name, in submission order.
  const asked = new Map<PoolEntry, number[]>();
  for (const n of nums) {
    if (typeof n !== 'number' || !entryOf.has(n)) continue;
    const e = entryOf.get(n)!;
    if (!asked.has(e)) asked.set(e, []);
    asked.get(e)!.push(n);
  }
  const main: number[] = [];
  for (const [e, req] of asked) {
    if (req.length > e.numbers.length) {
      const have = e.numbers.length;
      errors.push(`You drafted ${have} cop${have === 1 ? 'y' : 'ies'} of ${e.name} (pool number${have === 1 ? '' : 's'} ${e.numbers.join(', ')}); your deck asks for ${req.length}.`
        + (isBasicLand(e.card) ? ` Basic lands are unlimited: add them through basics instead.` : ` Play at most ${have}.`));
      continue;
    }
    // The numbers asked for first, then the card's other copies for repeats.
    const free = e.numbers.filter((n) => !req.includes(n));
    const used = new Set<number>();
    for (const n of req) {
      const pick = used.has(n) ? free.shift()! : n;
      used.add(pick);
      main.push(pick - 1);
    }
  }
  const basics: Record<string, number> = {};
  for (const [rawName, rawCount] of Object.entries(basicsIn ?? {})) {
    const name = BASIC_LANDS.find((b) => b.toLowerCase() === rawName.trim().toLowerCase());
    if (!name) {
      errors.push(`"${rawName}" is not a basic land you can add; basics are ${BASIC_LANDS.slice(0, -1).join(', ')} and ${BASIC_LANDS.at(-1)}.`);
      continue;
    }
    if (typeof rawCount !== 'number' || !Number.isInteger(rawCount) || rawCount < 0) {
      errors.push(`basics counts must be whole numbers of 0 or more; got "${rawName}": ${JSON.stringify(rawCount)}.`);
      continue;
    }
    if (rawCount > 0) basics[name] = (basics[name] ?? 0) + rawCount;
  }
  if (!errors.length) {
    const basicCount = Object.values(basics).reduce((s, n) => s + n, 0);
    const total = main.length + basicCount;
    if (total > MAX_DECK_SIZE) {
      errors.push(`The deck you submitted has ${total} cards (${main.length} pool card${main.length === 1 ? '' : 's'} + ${basicCount} basic land${basicCount === 1 ? '' : 's'}); the most this event accepts is ${MAX_DECK_SIZE}. A limited deck is usually ${DECK_SIZE}: submit the whole deck again.`);
    }
    if (total < DECK_SIZE) {
      const short = DECK_SIZE - total;
      errors.push(`The deck you submitted has ${total} cards (${main.length} pool card${main.length === 1 ? '' : 's'} + ${basicCount} basic land${basicCount === 1 ? '' : 's'}); a deck needs at least ${DECK_SIZE}. Add ${short} card${short === 1 ? '' : 's'} from your pool or basic lands, then submit the whole deck again.`);
    }
  }
  return errors.length ? { ok: false, error: errors.join('\n') } : { ok: true, deck: { main, basics } };
}

// --- The review --------------------------------------------------------------------------------------------------

export interface DeckReview {
  /** The review as compact JSON (what the agent sees). */
  text: string;
  /** Everything the review flags, one line each (also logged). */
  flags: string[];
  summary: Record<string, unknown>;
}

/** A non-land card with a land face (modal double-faced spell // land): a spell that can be played as a land. */
const landFace = (c: PackCard, cards: CardDb): string | undefined => (cards.get(c.name)?.faces ?? []).find((f) => /\bLand\b/.test(cards.get(f)?.typeLine ?? ''));

/** The exact computed summary of a submitted deck, with every way it breaks the guide's rules. */
export function deckReview(pool: PackCard[], deck: DeckSubmission, cards: CardDb, opts: { totalCount?: number; archetype?: string; setContext: boolean }): DeckReview {
  const mainCards = deck.main.map((i) => pool[i]!);
  const basicCount = Object.values(deck.basics).reduce((s, n) => s + n, 0);
  const total = mainCards.length + basicCount;
  const lands = mainCards.filter((c) => isLandCard(c, cards));
  const spells = mainCards.filter((c) => !isLandCard(c, cards));
  const creatures = spells.filter((c) => isCreature(c, cards));
  const spellLands = spells.filter((c) => landFace(c, cards));
  const landCount = lands.length + basicCount;
  const curve = [0, 0, 0, 0, 0, 0, 0, 0];
  for (const c of spells) curve[Math.min(7, Math.max(0, Math.round(mvOf(c, cards))))]!++;
  // Deck Mana Colors: hard pips of the non-land cards' main faces (step 3a); hybrid-only cards add nothing.
  const pips: Record<string, number> = {};
  const cardsOfColor: Record<string, PackCard[]> = {};
  for (const c of spells) {
    for (const [col, n] of Object.entries(costNeeds(cards.get(c.name)?.cost).hard)) {
      pips[col] = (pips[col] ?? 0) + n;
      (cardsOfColor[col] ??= []).push(c);
    }
  }
  const deckColors = WUBRG.filter((c) => pips[c]);
  // Sources: basics, lands by the colors they make, basic-fetchers for every color the deck has basics of.
  const sources: Record<string, number> = {};
  const add = (col: string | undefined) => { if (col) sources[col] = (sources[col] ?? 0) + 1; };
  for (const [name, n] of Object.entries(deck.basics)) for (let i = 0; i < n; i++) add(COLOR_OF_BASIC[name]);
  for (const c of lands.filter(isBasicLand)) add(COLOR_OF_BASIC[c.name]);
  const basicColors = WUBRG.filter((col) => (sources[col] ?? 0) > 0);
  const nonbasicLands = lands.filter((c) => !isBasicLand(c));
  for (const c of nonbasicLands) for (const col of new Set([...landColors(c, cards), ...(fetchesBasic(c, cards) ? basicColors : [])])) add(col);
  const src = (col: string) => sources[col] ?? 0;
  const flags: string[] = [];
  const uniq = (list: PackCard[]) => [...new Set(list.map((c) => c.name))];
  const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

  if (total > DECK_SIZE) flags.push(`${total} cards: the rule is exactly ${DECK_SIZE}. Cut your ${plural(total - DECK_SIZE, 'weakest card')} unless you mean to play ${total}.`);
  if (opts.totalCount === undefined) flags.push(`You didn't report total_count; the deck as submitted has ${total} cards.`);
  else if (opts.totalCount !== total) flags.push(`You reported total_count ${opts.totalCount}; the deck as submitted has ${total} cards.`);
  for (const c of uniq(spells)) {
    const need = costNeeds(cards.get(c)?.cost);
    const missing = Object.keys(need.hard).filter((col) => !src(col));
    if (missing.length) flags.push(`Can't be cast: ${c} needs ${missing.map((m) => `{${m}}`).join('')} and the deck has no ${missing.map((m) => COLOR_NAME[m]).join(' or ')} source.`);
    for (const h of need.hybrid) if (!h.some((col) => src(col))) flags.push(`Can't be cast: ${c} needs {${h.join('/')}} (${h.map((x) => COLOR_NAME[x]).join(' or ')}) and the deck has neither.`);
  }
  // Splashes: colors beyond the two with the most cards.
  const ranked = [...deckColors].sort((a, b) => (cardsOfColor[b]!.length - cardsOfColor[a]!.length) || ((pips[b] ?? 0) - (pips[a] ?? 0)));
  const splash = ranked.slice(2);
  for (const col of splash) {
    const list = cardsOfColor[col]!;
    const k = list.length;
    const needSources = k === 1 ? 3 : k === 2 ? 4 : 5;
    if (src(col) && src(col) < needSources) flags.push(`Splash: ${COLOR_NAME[col]} has ${plural(k, 'card')} (${uniq(list).join(', ')}) and ${plural(src(col), 'source')}; the guide asks for at least ${needSources}${k >= 3 ? '–6' : ''} sources for ${plural(k, 'splashed card')}.`);
    for (const c of uniq(list.filter((x) => mvOf(x, cards) <= 2))) flags.push(`Splash: ${c} (mana value ${mvOf(list.find((x) => x.name === c)!, cards)}) is splashed; the guide says never splash mana value 1–2 cards unless it is a game-winning bomb.`);
    for (const c of uniq(list.filter((x) => (costNeeds(cards.get(x.name)?.cost).hard[col] ?? 0) >= 2))) flags.push(`Splash: ${c} needs {${col}}{${col}}; the guide says avoid splashing double-pipped cards.`);
  }
  for (const c of uniq(nonbasicLands)) {
    const makes = landColors(nonbasicLands.find((x) => x.name === c)!, cards);
    if (makes.length >= 5 || !makes.length) continue;
    if (makes.some((col) => !deckColors.includes(col))) flags.push(`Off-color land: ${c} makes ${makes.map((m) => `{${m}}`).join(' or ')}; Deck Mana Colors are ${deckColors.join(', ') || 'none'}. A basic is better.`);
  }
  for (const [b, n] of Object.entries(deck.basics)) if (!deckColors.includes(COLOR_OF_BASIC[b]!)) flags.push(`Off-color basics: ${n} ${b}, but no card in the deck has a {${COLOR_OF_BASIC[b]}} pip.`);
  const ctx = opts.setContext ? ' (unless the set context says otherwise)' : '';
  if (landCount !== 17 && !(landCount === 16 && spellLands.length)) flags.push(`${plural(landCount, 'land')}${spellLands.length ? ` plus ${plural(spellLands.length, 'spell that can be played as a land', 'spells that can be played as lands')}` : ''}: the guide's default is 17${ctx}.`);
  if (curve[2]! < 5) flags.push(`${plural(curve[2]!, 'card')} at mana value 2: the guide asks for at least 5–6 proactive two-drops${ctx}.`);
  if (/aggr/i.test(opts.archetype ?? '') && creatures.length < 15) flags.push(`${plural(creatures.length, 'creature')} in an aggro deck: the guide says aggro decks need 15+.`);
  for (const e of poolEntries(pool)) {
    const played = deck.main.filter((i) => pool[i]!.name === e.name).length;
    const left = e.numbers.length - played;
    if (played > 0 && left > 0 && !isBasicLand(e.card)) flags.push(`Copies: you play ${played} of your ${e.numbers.length} ${e.name}; ${left === 1 ? 'the other stays' : `the other ${left} stay`} in your sideboard.`);
  }

  // The deck list by mana value (lands last), each card once with its count and pool numbers.
  const groups = new Map<string, number[]>();
  for (const i of deck.main) groups.set(pool[i]!.name, [...(groups.get(pool[i]!.name) ?? []), i + 1]);
  const main = [...groups.entries()]
    .map(([name, nums]) => ({ name, nums, card: pool[nums[0]! - 1]! }))
    .sort((a, b) => Number(isLandCard(a.card, cards)) - Number(isLandCard(b.card, cards)) || mvOf(a.card, cards) - mvOf(b.card, cards) || a.name.localeCompare(b.name))
    .map(({ name, nums, card }) => {
      const info = cards.get(name);
      return {
        count: nums.length, name, ...(info?.cost ? { cost: v4Cost(info.cost) } : {}), mv: mvOf(card, cards), type: typeOf(card, cards),
        ...(info?.pt ? { pt: info.pt } : {}), ...(landFace(card, cards) ? { land_face: landFace(card, cards) } : {}), poolNumbers: nums,
      };
    });
  const summary: Record<string, unknown> = {
    total, pool_cards: mainCards.length, basics: deck.basics, lands: landCount,
    ...(spellLands.length ? { spells_with_a_land_face: uniq(spellLands) } : {}),
    creatures: creatures.length, noncreature_spells: spells.length - creatures.length,
    curve: Object.fromEntries(curve.map((n, mv) => [mv === 7 ? '7+' : String(mv), n]).filter(([mv, n]) => mv !== '0' || n)),
    deck_mana_colors: deckColors.join(''),
    colors: WUBRG.filter((c) => pips[c] || src(c)).map((c) => ({ color: c, cards: (cardsOfColor[c] ?? []).length, pips: pips[c] ?? 0, sources: src(c), ...(splash.includes(c) ? { splash: true } : {}) })),
    ...(opts.totalCount !== undefined ? { total_count_reported: opts.totalCount } : {}),
    main,
    flags,
  };
  return { text: compactJson(summary), flags, summary };
}
