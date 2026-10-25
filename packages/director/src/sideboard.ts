/**
 * Best of 3 between games (docs/PROTOCOL.md §5, METHODOLOGY §3): who plays first, and sideboarding.
 *
 * - **Play or draw.** Game 1: the event seed picks who plays first (secret until the event ends, reproducible). Games 2
 *   and 3: the loser of the previous game chooses; after a drawn game, the player who chose for it chooses again (after a
 *   drawn game 1, the player the seed put on the play). The Director then makes phase-server start the game with that
 *   player (game.ts `starter`).
 * - **Sideboarding.** Before games 2 and 3 both seats, at the same time, see their current deck, their sideboard (card
 *   JSON as at deckbuilding) and the match memory, and either keep the deck or submit the whole deck again. The
 *   deckbuilding rules apply unchanged (`resolveSubmission`: pool cards only, at most the copies drafted, basics
 *   unlimited, at least 40 cards). Neither seat sees the other's changes, only the resulting deck size (public at the
 *   table). Each match starts again from the registered deck (`deck_built`).
 *
 * Both are decisions with a forfeit default for the inactivity watchdog: play first; keep the current deck.
 */
import type { PackCard } from './boosters.js';
import { toDeckIdx, type BuiltDeck } from './build.js';
import type { CardDb } from './cards.js';
import { deckCardJson, deckReview, isBasicLand, isLandCard, poolEntries, resolveSubmission, type DeckSubmission, type PoolEntry } from './deckbuild-v4.js';
import type { LogFn } from './game.js';
import type { DeckData } from './phase.js';
import type { Ratings } from './ratings.js';
import { Rng } from './rng.js';
import { given, unexpectedFields, type AgentSeat, type DecideInput, type Offer } from './seat.js';

export interface Swap { name: string; qty: number }

/** A deck as pool indices (0-based, no basic land pool cards) plus basics: the form a submission resolves to. */
export type MatchDeck = DeckSubmission;

/**
 * A built deck as pool indices plus basics. Drafted basic lands in the main deck become `basics` (they are unlimited and
 * never listed), so the deck reads the same however it was built (agent, reference builder, or read back from the log).
 */
export function deckOf(built: Pick<BuiltDeck, 'mainCards' | 'basics'>, pool: PackCard[]): MatchDeck {
  const basics: Record<string, number> = {};
  for (const [name, n] of Object.entries(built.basics)) if (n > 0) basics[name] = (basics[name] ?? 0) + n;
  const taken = new Set<number>();
  const main: number[] = [];
  for (const c of built.mainCards) {
    // The same object first (decks built from this pool), else the first free copy with the same name (logged decks).
    let i = pool.findIndex((p, j) => p === c && !taken.has(j));
    if (i < 0) i = pool.findIndex((p, j) => p.name === c.name && !taken.has(j));
    if (i < 0) continue;
    taken.add(i);
    if (isBasicLand(pool[i]!)) basics[pool[i]!.name] = (basics[pool[i]!.name] ?? 0) + 1;
    else main.push(i);
  }
  return { main, basics };
}

/** The deck as phase-server takes it: the main deck's names, and every pool card not in it as the sideboard. */
export function deckData(d: MatchDeck, pool: PackCard[]): DeckData {
  return toDeckIdx(d.main, d.basics, pool);
}

const countNames = (names: string[]): Map<string, number> => names.reduce((m, n) => m.set(n, (m.get(n) ?? 0) + 1), new Map<string, number>());

/** What changed from one deck to the next, by name (basic land count changes included): cards in, cards out. */
export function swaps(before: string[], after: string[]): { in: Swap[]; out: Swap[] } {
  const b = countNames(before);
  const a = countNames(after);
  const diff = (x: Map<string, number>, y: Map<string, number>) => [...x]
    .map(([name, n]) => ({ name, qty: n - (y.get(name) ?? 0) }))
    .filter((s) => s.qty > 0)
    .sort((p, q) => p.name.localeCompare(q.name));
  return { in: diff(a, b), out: diff(b, a) };
}

/** "+2 Shock, +1 Island, −2 Grizzly Bears, −1 Forest" (or "kept"). */
export function swapLine(s: { in: Swap[]; out: Swap[] }): string {
  if (!s.in.length && !s.out.length) return 'kept the deck';
  return [...s.in.map((x) => `+${x.qty} ${x.name}`), ...s.out.map((x) => `−${x.qty} ${x.name}`)].join(', ');
}

/** Game 1: who plays first, from the event seed (secret until the event ends; the same seed and match give the same answer). */
export function seededStarter(seed: string, match: string, a: string, b: string): string {
  return new Rng(`${seed}|play-draw|${match}`).int(2) === 0 ? a : b;
}

/**
 * Who chooses play or draw for the next game: the loser of the previous game; after a drawn game, the player who chose
 * for it (after a drawn game 1, which nobody chose, the player who was on the play).
 */
export function nextChooser(prev: { winner: string | null; chooser: string | null; onPlay: string }, a: string, b: string): string {
  if (prev.winner === a) return b;
  if (prev.winner === b) return a;
  return prev.chooser ?? prev.onPlay;
}

/** One pool card name with the copies of it in one list (deck or sideboard), as card JSON lines take it. */
function entriesFor(pool: PackCard[], indices: number[]): PoolEntry[] {
  const nums = new Set(indices.map((i) => i + 1));
  return poolEntries(pool)
    .map((e) => ({ ...e, numbers: e.numbers.filter((n) => nums.has(n)) }))
    .filter((e) => e.numbers.length > 0 && !isBasicLand(e.card));
}

const mvOf = (e: PoolEntry, cards: CardDb): number => cards.get(e.name)?.mv ?? e.card.cmc;
const sortByMv = (list: PoolEntry[], cards: CardDb): PoolEntry[] => [...list].sort((x, y) => Number(isLandCard(x.card, cards)) - Number(isLandCard(y.card, cards)) || mvOf(x, cards) - mvOf(y, cards) || x.numbers[0]! - y.numbers[0]!);
const basicsText = (b: Record<string, number>): string => JSON.stringify(Object.fromEntries(Object.entries(b).filter(([, n]) => n > 0)));

export interface SideboardContext {
  /** The game the decision is for (2 or 3). */
  game: number;
  /** "Round 1 of 3": how the seat's texts name the match (never a seat name). */
  roundLabel: string;
  /** This seat's games won and lost so far, and each earlier game from its point of view. */
  score: { me: number; them: number };
  results: Array<{ game: number; result: 'won' | 'lost' | 'drawn'; turns: number }>;
  /** Who plays first in the coming game, from this seat's point of view, and who chose. */
  onPlay: 'you' | 'opponent';
  chose: 'you' | 'opponent' | 'seed';
  /** The opponent's cards this seat saw in earlier games of the match (name → most copies seen in one game). */
  opponentSeen: Record<string, number>;
  /** The opponent's deck and sideboard sizes before this sideboarding (public). */
  opponentDeck: number;
  opponentSideboard: number;
  /** 17Lands data on the cards when the event shows it (Set Context + Human Stats). */
  stats?: Ratings;
  /** Whether the event includes the Set Context (the text points to it). */
  setContext: boolean;
}

/** The sideboarding decision text: the current deck, the sideboard, the match memory, and how to answer. */
export function sideboardText(id: string, pool: PackCard[], deck: MatchDeck, cards: CardDb, ctx: SideboardContext): string {
  const inDeck = sortByMv(entriesFor(pool, deck.main), cards);
  const used = new Set(deck.main);
  const side = sortByMv(entriesFor(pool, pool.map((_, i) => i).filter((i) => !used.has(i))), cards);
  const basicCount = Object.values(deck.basics).reduce((s, n) => s + n, 0);
  const total = deck.main.length + basicCount;
  const sideCount = side.reduce((s, e) => s + e.numbers.length, 0);
  const results = ctx.results.map((r) => `game ${r.game}: you ${r.result}${r.turns ? ` on turn ${r.turns}` : ''}`).join('; ');
  const who = ctx.onPlay === 'you' ? 'you play first' : 'your opponent plays first';
  const why = ctx.chose === 'seed' ? '' : ctx.chose === 'you' ? ` (you chose ${ctx.onPlay === 'you' ? 'to play' : 'to draw'})` : ` (your opponent chose ${ctx.onPlay === 'you' ? 'to draw' : 'to play'})`;
  const seen = Object.entries(ctx.opponentSeen).sort((x, y) => x[0].localeCompare(y[0]));
  const seenLines = seen.map(([name, n]) => {
    const info = cards.get(name);
    return JSON.stringify(info && !/^Basic Land/.test(info.typeLine) ? { seen: n, ...cards.json(name) } : { seen: n, name });
  });
  const current = `cards=[${deck.main.map((i) => i + 1).join(', ')}], basics=${basicsText(deck.basics)}`;
  return [
    `SIDEBOARDING — game ${ctx.game} of your best-of-3 match (${ctx.roundLabel}) is next. Score: you ${ctx.score.me}–${ctx.score.them} opponent (${results}). In game ${ctx.game} ${who}${why}.`,
    'Before games 2 and 3 both players may change their deck: swap cards between your deck and your sideboard, and change your basic lands (basics are unlimited). The deckbuilding rules apply: at least 40 cards, only cards from your pool, at most the copies you drafted. Your opponent sideboards at the same time; neither of you sees the other\'s changes, only the deck size. Your next match starts again from the deck you registered.',
    '',
    `YOUR DECK (as in game ${ctx.game - 1}): ${total} cards, ${deck.main.length} from your pool + ${basicCount} basic land${basicCount === 1 ? '' : 's'} ${basicsText(deck.basics)}. Card JSON as at deckbuilding; "count" = copies in your deck, "poolNumbers" = their pool numbers:`,
    ...inDeck.map((e) => JSON.stringify(deckCardJson(e, cards, ctx.stats))),
    '',
    `YOUR SIDEBOARD: ${sideCount} card${sideCount === 1 ? '' : 's'} (drafted basic lands aren't listed: basics are unlimited). "count" = copies in your sideboard:`,
    ...(side.length ? side.map((e) => JSON.stringify(deckCardJson(e, cards, ctx.stats))) : ['(none)']),
    '',
    seen.length
      ? `THE OPPONENT'S CARDS YOU SAW THIS MATCH ("seen" = the most copies seen in one game), with their printed data:`
      : 'THE OPPONENT\'S CARDS YOU SAW THIS MATCH: none.',
    ...seenLines,
    `The opponent's deck: ${ctx.opponentDeck} cards; their sideboard: ${ctx.opponentSideboard} cards (before their sideboarding).`,
    ...(ctx.setContext ? ['Your MTG Deck Tools Set Context (archetypes, key cards, what beats what) is available via get_set_context.'] : []),
    '',
    `DECISION ${id} — keep your deck: decide(decision_id="${id}", option="keep", note="…"); or submit your whole deck for game ${ctx.game}: decide(decision_id="${id}", cards=[pool numbers, one per copy], basics={…}, note="<what you changed and why>"). Your current deck as an answer: ${current}.`,
  ].join('\n');
}

export interface SideboardResult {
  deck: MatchDeck;
  kept: boolean;
}

/**
 * Ask a seat to sideboard before a game. Resolves with the deck for that game; logs `sideboard_offered` and, once
 * settled, `sideboarded` (with the swaps relative to the deck played in the previous game).
 */
export function askSideboard(seat: AgentSeat, pool: PackCard[], current: MatchDeck, cards: CardDb, ctx: SideboardContext, log: LogFn, meta: { match: string; game_number: number }): Promise<SideboardResult> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const rejected: string[] = [];
    const reject = (e: string) => {
      rejected.push(e);
      return e;
    };
    const before = deckData(current, pool);
    const settle = (deck: MatchDeck, by: 'agent' | 'forfeit', input?: DecideInput): string => {
      const data = deckData(deck, pool);
      const s = swaps(before.main_deck, data.main_deck);
      const kept = !s.in.length && !s.out.length;
      const basics = Object.fromEntries(Object.entries(deck.basics).filter(([, n]) => n > 0));
      log('sideboarded', {
        seat: seat.name, ...meta, by, kept, in: s.in, out: s.out, main: data.main_deck, sideboard: data.sideboard, basics,
        main_count: data.main_deck.length, ...(input?.note ? { note: input.note } : {}), ...(rejected.length ? { rejected } : {}), latency_ms: Date.now() - startedAt,
      });
      resolve({ deck, kept });
      const lands = data.main_deck.filter((n) => isLandCard({ name: n, typeLine: cards.get(n)?.typeLine ?? '' } as PackCard, cards)).length;
      const uncastable = kept ? [] : deckReview(pool, deck, cards, { totalCount: data.main_deck.length, setContext: ctx.setContext }).flags.filter((f) => f.startsWith("Can't be cast"));
      return kept
        ? `Deck kept for game ${ctx.game}: ${data.main_deck.length} cards.`
        : `Deck for game ${ctx.game}: ${swapLine(s)}. ${data.main_deck.length} cards, ${lands} lands.${uncastable.length ? ` Note: ${uncastable.join(' ')}` : ''}`;
    };
    const offer: Offer = {
      id: seat.nextId('S'),
      phase: 'sideboard',
      kind: 'sideboard',
      text: '',
      options: [{ id: 'keep', label: 'Keep your current deck', value: 'keep' }],
      createdAt: Date.now(),
      answer: async (input, o) => {
        const extra = unexpectedFields(input, ['cards', 'basics'], 'Sideboarding');
        if (extra) return reject(extra);
        const deckGiven = given(input, 'cards') || given(input, 'basics');
        if (input.option === 'keep' && deckGiven) {
          return reject('option "keep" keeps your deck as it is, but you also sent a deck; nothing was changed. Answer with option "keep" alone, or the whole deck (cards and basics) without `option`.');
        }
        if (input.option === 'keep') {
          o.acceptedText = settle(current, 'agent', input);
          return null;
        }
        if (input.option) return reject(`this decision takes option "keep", or your whole deck (cards and basics); not option "${input.option}".`);
        if (!deckGiven) return reject('answer with option "keep", or your whole deck for the next game: cards (pool numbers, one per copy) and basics.');
        const r = resolveSubmission(pool, input.cards, input.basics as Record<string, unknown> | undefined);
        if (!r.ok) return reject(r.error);
        o.acceptedText = settle(deckOf({ mainCards: r.deck.main.map((i) => pool[i]!), basics: r.deck.basics }, pool), 'agent', input);
        return null;
      },
      // Inactive seat (watchdog): it keeps its current deck.
      forfeit: () => {
        settle(current, 'forfeit');
        seat.clear();
        return { kept: true, game_number: meta.game_number };
      },
    };
    offer.text = sideboardText(offer.id, pool, current, cards, ctx);
    log('sideboard_offered', { seat: seat.name, id: offer.id, ...meta, text: offer.text });
    seat.offer(offer);
  });
}

export interface PlayDrawContext {
  game: number;
  roundLabel: string;
  score: { me: number; them: number };
  /** Why this seat chooses: it lost the previous game, or it chose before a drawn game. */
  reason: 'lost' | 'draw';
}

export function playDrawText(id: string, ctx: PlayDrawContext): string {
  const why = ctx.reason === 'lost'
    ? `You lost game ${ctx.game - 1}, so you choose who plays first in game ${ctx.game}.`
    : `Game ${ctx.game - 1} was a draw, so you choose again who plays first in game ${ctx.game}.`;
  return [
    `PLAY OR DRAW — your best-of-3 match (${ctx.roundLabel}), score: you ${ctx.score.me}–${ctx.score.them} opponent. ${why} Both players sideboard after this choice, knowing it.`,
    '  [play] You play first (you skip your first draw)',
    '  [draw] Your opponent plays first (you draw on your first turn)',
    `DECISION ${id} — decide(decision_id="${id}", option="play" or "draw", note="…").`,
  ].join('\n');
}

/** Ask the chooser whether to play or draw. Resolves 'play' or 'draw'; logs `play_draw_offered`. The caller logs `play_draw`. */
export function askPlayDraw(seat: AgentSeat, ctx: PlayDrawContext, log: LogFn, meta: { match: string; game_number: number }): Promise<{ choice: 'play' | 'draw'; by: 'agent' | 'forfeit'; note?: string; latency_ms: number }> {
  return new Promise((resolve) => {
    const offer: Offer = {
      id: seat.nextId('P'),
      phase: 'sideboard',
      kind: 'play_draw',
      text: '',
      options: [{ id: 'play', label: 'Play first', value: 'play' }, { id: 'draw', label: 'Draw first', value: 'draw' }],
      createdAt: Date.now(),
      answer: async (input, o) => {
        const extra = unexpectedFields(input, [], 'The play-or-draw choice');
        if (extra) return extra;
        const choice = String(input.option ?? '').trim().toLowerCase();
        if (choice !== 'play' && choice !== 'draw') return 'answer with option "play" (you play first) or "draw" (your opponent plays first).';
        resolve({ choice, by: 'agent', ...(input.note ? { note: input.note } : {}), latency_ms: Date.now() - offer.createdAt });
        o.acceptedText = choice === 'play' ? `You play first in game ${ctx.game}.` : `Your opponent plays first in game ${ctx.game}; you draw.`;
        return null;
      },
      // Inactive seat (watchdog): it plays first.
      forfeit: () => {
        seat.clear();
        resolve({ choice: 'play', by: 'forfeit', latency_ms: Date.now() - offer.createdAt });
        return { choice: 'play', game_number: meta.game_number };
      },
    };
    offer.text = playDrawText(offer.id, ctx);
    log('play_draw_offered', { seat: seat.name, id: offer.id, ...meta, text: offer.text });
    seat.offer(offer);
  });
}

/** A `sideboarded` record read back from the log (resume): the deck it settled on. */
export function deckFromSideboardLog(rec: Record<string, unknown>, pool: PackCard[]): MatchDeck {
  const names = Array.isArray(rec.main) ? rec.main.map(String) : [];
  const left = pool.map((c, i) => ({ c, i }));
  const mainCards: PackCard[] = [];
  const basics: Record<string, number> = {};
  for (const n of names) {
    const k = left.findIndex((x) => x.c.name === n && !isBasicLand(x.c));
    if (k >= 0) mainCards.push(left.splice(k, 1)[0]!.c);
    else basics[n] = (basics[n] ?? 0) + 1;
  }
  return deckOf({ mainCards, basics }, pool);
}
