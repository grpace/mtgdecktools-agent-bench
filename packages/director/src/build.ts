import { appendFileSync } from 'node:fs';
import type { PackCard } from './boosters.js';
import { CardDb } from './cards.js';
import type { LogFn } from './game.js';
import type { DeckData } from './phase.js';
import { Ratings, topColors } from './ratings.js';
import { Knowledge, poolAnalysis } from './knowledge.js';
import { AgentSeat, DecideInput, given, Offer, unexpectedFields } from './seat.js';
import { setDocName, type ObservationFormat } from './observation.js';
import { BASIC_OF, deckOfferV4, deckReview, landColors, resolveSubmission, type DeckReview, type DeckSubmission } from './deckbuild-v4.js';

export { landColors };

const BASICS = BASIC_OF;
const BASIC_NAMES = new Set(Object.values(BASICS));

const AUTO_AND_DECK = 'option "auto" hands deckbuilding to the reference builder, but you also sent a deck; nothing was built. Send your deck (cards and basics) without `option`, or option "auto" alone.';

/** Two submissions of the same deck: the same pool cards (by name, with copies) and the same basics. */
function sameDeck(a: DeckSubmission, b: DeckSubmission, pool: PackCard[]): boolean {
  const names = (d: DeckSubmission) => JSON.stringify(d.main.map((i) => pool[i]!.name).sort());
  const basics = (d: DeckSubmission) => JSON.stringify(Object.entries(d.basics).filter(([, n]) => n > 0).sort());
  return names(a) === names(b) && basics(a) === basics(b);
}

export interface BuiltDeck {
  deck: DeckData;
  mainCards: PackCard[];
  basics: Record<string, number>;
  by: 'agent' | 'auto';
}

/** At most this many non-basic lands in a reference build (they count toward its 17 lands). */
const MAX_NONBASIC_LANDS = 3;

/**
 * Reference builder: best two colors by rating, the top 23 non-land playables in them, then 17 lands: on-color
 * non-basic lands from the pool (lands that make at least one of the deck's colors and none outside them, best rated
 * first, at most MAX_NONBASIC_LANDS), and basics split by color weight for the rest. Always 40 cards: with fewer than
 * 23 playables, the lands fill the gap.
 *
 * Until 2026-10-22 the 23 "playables" could include non-basic lands, with 17 basics added on top (18+ land decks);
 * auto builds are logged in full in `deck_built`, so older events still replay as they were.
 */
export function autoBuild(pool: PackCard[], ratings: Ratings, cards?: CardDb): BuiltDeck {
  const lane = topColors(pool, ratings);
  const isLand = (c: PackCard) => /\bLand\b/.test(c.typeLine);
  const spells = pool
    .filter((c) => !isLand(c))
    .filter((c) => c.colors.every((col) => lane.includes(col)))
    .sort((a, b) => ratings.value(b) - ratings.value(a))
    .slice(0, 23);
  const landSlots = 40 - spells.length;
  const nonbasics = pool
    .filter((c) => isLand(c) && !/^Basic Land/.test(c.typeLine) && !BASIC_NAMES.has(c.name))
    .filter((c) => {
      const makes = landColors(c, cards);
      return makes.some((col) => lane.includes(col)) && (makes.length >= 5 || makes.every((col) => lane.includes(col)));
    })
    .sort((a, b) => ratings.value(b) - ratings.value(a))
    .slice(0, Math.min(MAX_NONBASIC_LANDS, landSlots));
  const main = [...spells, ...nonbasics];
  const pips: Record<string, number> = {};
  for (const c of spells) for (const col of c.colors) pips[col] = (pips[col] ?? 0) + 1;
  const total = lane.reduce((s, col) => s + (pips[col] ?? 0), 0) || 1;
  const basicCount = landSlots - nonbasics.length;
  const first = Math.round((basicCount * (pips[lane[0]!] ?? 0)) / total);
  const basics: Record<string, number> = { [BASICS[lane[0]!]!]: first, [BASICS[lane[1]!]!]: basicCount - first };
  return { deck: toDeck(main, basics, pool), mainCards: main, basics, by: 'auto' };
}

function toDeck(main: PackCard[], basics: Record<string, number>, pool: PackCard[]): DeckData {
  const mainDeck = main.map((c) => c.name);
  for (const [name, n] of Object.entries(basics)) for (let i = 0; i < n; i++) mainDeck.push(name);
  const used = new Set(main);
  return { main_deck: mainDeck, sideboard: pool.filter((c) => !used.has(c)).map((c) => c.name) };
}

/** The deck from physical pool indices (0-based) plus basics; every other pool card is the sideboard. */
export function toDeckIdx(main: number[], basics: Record<string, number>, pool: PackCard[]): DeckData {
  const mainDeck = main.map((i) => pool[i]!.name);
  for (const [name, n] of Object.entries(basics)) for (let i = 0; i < n; i++) mainDeck.push(name);
  const used = new Set(main);
  return { main_deck: mainDeck, sideboard: pool.filter((_, i) => !used.has(i)).map((c) => c.name) };
}

/** Ask an agent seat to build a deck from its pool. Falls back to the reference builder on request. */
export function askForDeck(seat: AgentSeat, pool: PackCard[], cards: CardDb, ratings: Ratings, knowledge: Knowledge, log: LogFn): Promise<BuiltDeck> {
  if (seat.observation === 'v4') return askForDeckV4(seat, pool, cards, ratings, knowledge, log);
  seat.setStatus('Deckbuilding: waiting for the other players to submit their decks.');
  return new Promise((resolve) => {
    const offer: Offer = {
      id: seat.nextId('B'),
      phase: 'build',
      kind: 'deck_build',
      text: '',
      options: [{ id: 'auto', label: 'Let the reference builder build it for you (recorded as delegated)', value: 'auto' }],
      createdAt: Date.now(),
      answer: async (input, o) => {
        const extra = unexpectedFields(input, ['cards', 'basics'], 'Deckbuilding');
        if (extra) return extra;
        const deckGiven = given(input, 'cards') || given(input, 'basics');
        if (input.option === 'auto' && deckGiven) return AUTO_AND_DECK;
        if (input.option != null && input.option !== 'auto') return `this decision takes a deck: cards (pool numbers) and basics, or option "auto"; not option "${input.option}".`;
        if (input.option === 'auto') {
          const built = autoBuild(pool, ratings, cards);
          log('deck_built', { seat: seat.name, by: 'auto', main: built.deck.main_deck, sideboard: built.deck.sideboard, latency_ms: Date.now() - o.createdAt });
          resolve(built);
          return null;
        }
        const picks = input.cards ?? [];
        const basics = input.basics ?? {};
        const bad = picks.filter((n) => !(Number.isInteger(n) && n >= 1 && n <= pool.length));
        if (bad.length) return `pool numbers must be 1..${pool.length}; got ${bad.join(', ')}.`;
        if (new Set(picks).size !== picks.length) return 'each pool card can be used once (duplicate numbers in `cards`).';
        const badBasics = Object.keys(basics).filter((b) => !BASIC_NAMES.has(b));
        if (badBasics.length) return `basics must be among ${[...BASIC_NAMES].join(', ')}; got ${badBasics.join(', ')}.`;
        const basicCount = Object.values(basics).reduce((s, n) => s + (n > 0 ? n : 0), 0);
        if (picks.length + basicCount < 40) return `the deck has ${picks.length + basicCount} cards; it needs at least 40.`;
        const main = picks.map((n) => pool[n - 1]!);
        const built: BuiltDeck = { deck: toDeck(main, basics, pool), mainCards: main, basics, by: 'agent' };
        log('deck_built', { seat: seat.name, by: 'agent', main: built.deck.main_deck, sideboard: built.deck.sideboard, latency_ms: Date.now() - o.createdAt });
        resolve(built);
        return null;
      },
      // Inactive seat (watchdog): the reference builder builds it, logged as an auto build with forfeit: true.
      forfeit: () => {
        const built = autoBuild(pool, ratings, cards);
        log('deck_built', { seat: seat.name, by: 'auto', forfeit: true, main: built.deck.main_deck, sideboard: built.deck.sideboard, latency_ms: Date.now() - offer.createdAt });
        seat.clear();
        resolve(built);
        return {};
      },
    };
    offer.text = deckText(seat.observation, offer.id, pool, cards, ratings, knowledge);
    log('build_offered', { seat: seat.name, id: offer.id, text: offer.text });
    seat.offer(offer);
  });
}

/** The prompt v2/v3 deckbuilding decision text: one line per pool card (prompt v4: deckbuild-v4.ts). */
function deckText(observation: ObservationFormat | undefined, id: string, pool: PackCard[], cards: CardDb, ratings: Ratings, knowledge: Knowledge): string {
  const doc = setDocName(observation);
  const lines = [
    `DECKBUILDING — build a deck of at least 40 cards from your ${pool.length}-card draft pool, plus any number of basic lands (Plains, Island, Swamp, Mountain, Forest).`,
    'Unused pool cards become your sideboard. Most limited decks run 17 lands and 23 spells in two colors.',
    '',
    'Your pool:',
    ...pool.map((c, i) => {
      const stats = knowledge.stats ? ratings.statsLabel(c.name) : '';
      return `  [${i + 1}] ${cards.describe(c.name)}${stats ? `  [${stats}]` : ''}`;
    }),
    '',
    // Pool analysis and the deckbuilding guide are standard for every seat; stats only at primer+stats.
    ...poolAnalysis(pool, ratings, knowledge.stats), '',
    ...(knowledge.guide ? [knowledge.guide.trim(), ''] : []),
    ...(knowledge.primer ? [`Your MTG Deck Tools ${doc.lower} (archetypes, lane strategy, curve and land advice) is available any time via ${doc.tool}.`, ''] : []),
    `DECISION ${id} — submit your deck: decide(decision_id="${id}", cards=[pool numbers for the main deck], basics={"Plains": 8, "Island": 9}).`,
  ];
  return lines.join('\n');
}

/**
 * Prompt v4 deckbuilding (deckbuild-v4.ts): the MTG Deck Tools AI Deck Builder's 40-card rules, a submission check
 * that maps repeated pool numbers onto a card's other copies, then one review round: the Director shows the deck as
 * it counted it and the agent confirms it or resubmits once (a resubmitted deck locks at once).
 */
function askForDeckV4(seat: AgentSeat, pool: PackCard[], cards: CardDb, ratings: Ratings, knowledge: Knowledge, log: LogFn): Promise<BuiltDeck> {
  seat.setStatus('Deckbuilding: waiting for the other players to submit their decks.');
  return new Promise((resolve) => {
    const startedAt = Date.now();
    /** Every rejected submission's message, in order (logged with the deck). */
    const rejected: string[] = [];
    const reject = (error: string) => {
      rejected.push(error);
      return error;
    };
    const check = (input: DecideInput) => {
      const r = resolveSubmission(pool, input.cards, input.basics as Record<string, unknown> | undefined);
      if (!r.ok) reject(r.error);
      return r;
    };
    const reviewOf = (deck: DeckSubmission, input: DecideInput) =>
      deckReview(pool, deck, cards, { totalCount: input.total_count, archetype: input.archetype, setContext: !!knowledge.primer });
    const lock = (deck: DeckSubmission, input: DecideInput, review: Record<string, unknown>) => {
      const built: BuiltDeck = { deck: toDeckIdx(deck.main, deck.basics, pool), mainCards: deck.main.map((i) => pool[i]!), basics: deck.basics, by: 'agent' };
      log('deck_built', {
        seat: seat.name, by: 'agent', main: built.deck.main_deck, sideboard: built.deck.sideboard,
        pool_numbers: deck.main.map((i) => i + 1), basics: deck.basics,
        ...(input.deck_name ? { deck_name: input.deck_name } : {}), ...(input.archetype ? { archetype: input.archetype } : {}),
        ...(input.total_count !== undefined ? { total_count: input.total_count } : {}),
        ...(rejected.length ? { rejected } : {}), review, latency_ms: Date.now() - startedAt,
      });
      resolve(built);
    };
    const reviewOffer = (deck: DeckSubmission, input: DecideInput, review: DeckReview): Offer => {
      const first = { flags: review.flags, summary: review.summary };
      const r: Offer = {
        id: seat.nextId('B'),
        phase: 'build',
        kind: 'deck_review',
        text: '',
        options: [{ id: 'confirm', label: 'Lock the deck as shown', value: 'confirm' }],
        createdAt: Date.now(),
        answer: async (again, o) => {
          const extra = unexpectedFields(again, ['cards', 'basics'], 'The deck review');
          if (extra) return reject(extra);
          if (again.option === 'confirm' && (given(again, 'cards') || given(again, 'basics'))) {
            // Confirm plus a deck: fine when it is the deck shown; a different deck is a conflict, never half-applied.
            const res = resolveSubmission(pool, again.cards, again.basics as Record<string, unknown> | undefined);
            if (!res.ok || !sameDeck(res.deck, deck, pool)) {
              return reject('option "confirm" locks the deck as shown, but you also sent a different deck; nothing was locked. Answer with option "confirm" alone, or resubmit the whole deck without `option`.');
            }
          }
          if (again.option === 'confirm') {
            lock(deck, input, { ...first, outcome: 'confirmed', latency_ms: Date.now() - r.createdAt });
            o.acceptedText = 'Deck locked.';
            return null;
          }
          if (again.option && again.option !== 'confirm') return reject('answer with option "confirm" to lock the deck as shown, or resubmit the whole deck with cards and basics.');
          const res = check(again);
          if (!res.ok) return res.error;
          const second = reviewOf(res.deck, again);
          lock(res.deck, again, { ...first, outcome: 'resubmitted', resubmitted: { flags: second.flags, summary: second.summary }, latency_ms: Date.now() - r.createdAt });
          o.acceptedText = `Deck locked (resubmitted). The Director's count of the final deck:\n${second.text}`;
          return null;
        },
        // Inactive seat (watchdog): the deck it submitted locks as it was.
        forfeit: () => {
          lock(deck, input, { ...first, outcome: 'forfeit' });
          seat.clear();
          return { locked: 'submitted deck' };
        },
      };
      r.text = [
        'DECK REVIEW — your deck is not locked yet. The Director counted the deck you submitted, exactly ("main": each card once with its count; "colors": cards, pips and sources per color; "flags": every way it breaks the guide):',
        '',
        review.text,
        '',
        `DECISION ${r.id} — lock this deck with decide(decision_id="${r.id}", option="confirm"), or fix it: resubmit the whole deck once with decide(decision_id="${r.id}", cards=[…], basics={…}, total_count=…, deck_name="…", archetype="…"). A resubmitted deck locks at once.`,
      ].join('\n');
      log('build_offered', { seat: seat.name, id: r.id, kind: 'deck_review', text: r.text });
      return r;
    };
    const offer: Offer = {
      id: seat.nextId('B'),
      phase: 'build',
      kind: 'deck_build',
      text: '',
      options: [{ id: 'auto', label: 'Let the reference builder build it for you (recorded as delegated)', value: 'auto' }],
      createdAt: Date.now(),
      answer: async (input, o) => {
        const extra = unexpectedFields(input, ['cards', 'basics'], 'Deckbuilding');
        if (extra) return reject(extra);
        if (input.option === 'auto' && (given(input, 'cards') || given(input, 'basics'))) return reject(AUTO_AND_DECK);
        if (input.option === 'auto') {
          const built = autoBuild(pool, ratings, cards);
          log('deck_built', { seat: seat.name, by: 'auto', main: built.deck.main_deck, sideboard: built.deck.sideboard, ...(rejected.length ? { rejected } : {}), latency_ms: Date.now() - o.createdAt });
          resolve(built);
          return null;
        }
        if (input.option) return reject(`this decision takes a deck: cards (pool numbers) and basics, not option "${input.option}".`);
        const res = check(input);
        if (!res.ok) return res.error;
        seat.offer(reviewOffer(res.deck, input, reviewOf(res.deck, input)));
        o.acceptedText = 'Deck received; it is not locked yet.';
        return null;
      },
      // Inactive seat (watchdog): the reference builder builds it, logged as an auto build with forfeit: true.
      forfeit: () => {
        const built = autoBuild(pool, ratings, cards);
        log('deck_built', { seat: seat.name, by: 'auto', forfeit: true, main: built.deck.main_deck, sideboard: built.deck.sideboard, latency_ms: Date.now() - offer.createdAt });
        seat.clear();
        resolve(built);
        return {};
      },
    };
    offer.text = deckOfferV4(offer.id, pool, cards, ratings, knowledge);
    log('build_offered', { seat: seat.name, id: offer.id, text: offer.text });
    const cmp = process.env.MTGDT_OBS_COMPARE;
    if (cmp) appendFileSync(cmp, JSON.stringify({ seat: seat.name, id: offer.id, kind: 'deck_build', v3: deckText('v3', offer.id, pool, cards, ratings, knowledge), v4: offer.text }) + '\n');
    seat.offer(offer);
  });
}
