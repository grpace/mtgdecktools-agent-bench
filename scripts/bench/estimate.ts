/**
 * Token and cost estimates for the Confirmation (`bench setup`) and Keep Playing budgets. Every match is best of 3
 * with sideboarding (best of 1 was removed on 2026-10-22); the sizes per game come from the two best-of-1 tables below,
 * which is what a game costs whatever the match structure, and the between-games decisions are added on top.
 *
 * One session per seat (`--fresh-session off`), measured on the first 8-seat hosted table (2026-10-22, TLA, Set
 * Context, manual mana, best of 1; 8× Claude Haiku 5.5 · Claude Code · low): $56.37 for the table, $3.97 to $9.52 per
 * seat, 69 to 169 M cache reads, 0.55 to 1.13 M cache writes and 57 to 100 k output per seat. Of that, $5.37 (9.5%)
 * was 6 seats that had finished their last match calling wait_for_decision for 14 to 19 minutes until the event
 * ended; finished seats now stop at once, so the estimate leaves that out (measured without it: $3.20 to $9.51 per
 * seat, $51.00 for the table).
 *
 * A fresh session per game (the default for seats `bench play` starts), measured on the second hosted table
 * (2026-10-22-14-39-42-sos-909e: SOS, Set Context, manual mana, best of 1; 4× Claude Haiku 5.5 · Claude Code · low and
 * 4× medium), priced request by request with the long-context prices and Claude Code's 1-hour cache writes: $5.93 for
 * the table. Low seats $0.27 to $0.93 ($2.56 for 4, about $0.21 per game played), medium seats $0.55 to $1.46 ($3.37
 * for 4, about $0.28 per game); 151 to 222 requests, 7.3 to 22 M cache reads, 0.39 to 0.76 M cache writes and 40 to
 * 63 k output per seat. The draft and deckbuilding session took 44 to 56 requests, 2.4 to 3.0 M cache reads and $0.08
 * (as in one long session); each game's session 20 to 82 requests and $0.02 to $0.88, with prompts from about 30 k
 * up to 80 to 380 k by the game's end.
 *
 * What drives the cost: a harness re-reads the whole conversation on every call. In one long session the conversation
 * grows by 150 to 270 k tokens per game (prompt v4: about 82 k of decision text per game plus the seat's own reasoning
 * and tool calls), from 100 to 126 k after the draft and deckbuilding, so the cache reads of a game grow with every game
 * before it, until the harness compacts its context (Claude Code at about 1 M tokens, back to about 170 k). With a
 * fresh session per game each game starts at about 30 k again. The model below replays that request by request; its
 * ends are calibrated on the two measured tables (`calibrationTokens`: their shape, 3 games and nothing between
 * them). Best of 3 plays 6 to 9 games per seat, a projection from those per-game sizes.
 *
 * Between games (sideboard.ts): before every game after a match's first, the loser chooses play or draw (a few hundred
 * tokens) and both seats get the sideboarding decision: their deck and sideboard as card JSON and the match memory,
 * 15 to 24 k characters (about 5 to 7.5 k tokens; measured on a scripted FRA table, 34 decisions). With a fresh
 * session per game it arrives at the start of the next game's session, so every request of that game re-reads it.
 * Each seat meets 3 (2-game matches) to 6 (3-game matches) of these. Measured on one Claude Haiku 5.5 · Claude Code ·
 * low seat (TLA, Set Context, 2026-10-22-16-57-21-tla-086a): each sideboarding took one request, about 9 k tokens
 * added (the decision and the notices before it), 165 to 518 output tokens, under $0.01; the high end allows more
 * reasoning for larger models and effort levels.
 *
 * Effort: measured at low and medium on Claude Haiku 5.5 (medium cost 1.32× low, with about 1.2× the tokens: more
 * reasoning, longer games, more requests over the long-context size). High, xhigh and max are extrapolated (about 1.3×
 * per level, rounded up: a conservative guess, not measured); the harness default or an unknown level counts as
 * medium. Other models get the same factors, a projection.
 *
 * Dollars: the same tokens at each seat's model list price (registry/prices.json). Claude Haiku 5.5 is the measured
 * model; every other model is a projection from its list price, since models differ in how many calls and words they
 * use. Each replayed request pays its model's long-context prices when its prompt is over the listed size
 * (registry/prices.json `long_context`: Claude Haiku 5.5 over 100 k at 5×, which reproduces Claude Code's reported cost;
 * GPT-6 over 272 k; Gemini 3.1 Pro over 200 k). Claude Code writes its cache for 1 hour (2× the tier's input price).
 */
import { priceFor, type PriceEntry } from '../../packages/registry/src/prices.js';
import { SWISS_ROUNDS } from './core.js';
import type { FreshSession } from './rotation.js';

/** The two calibrated ends of the request model (per seat). */
interface Profile {
  /** Context after the draft and deckbuilding, and the cache reads those took (about 45 calls). */
  c0: number;
  draftReads: number;
  /** Calls per game, including the long-polls while other matches finish; context added per game; output per game. */
  calls: number;
  perGame: number;
  output: number;
  /** Games per seat (best of 3: 2 or 3 per match). */
  games: number;
  /** Between two games of a match: calls (play or draw, sideboarding), decision text added to the context, output. */
  between: { calls: number; text: number; output: number };
  /**
   * A game played in a fresh session (`--fresh-session`): calls, context added and output per game, measured on the
   * second hosted table (low effort; the effort factor scales the rest). Its ends are a cheap seat's games (about 32
   * requests from 30 k to about 105 k: $0.07 a game at Claude Haiku 5.5) and an expensive one's (about 50 requests up
   * to about 180 k: $0.32 a game).
   */
  fresh: { calls: number; perGame: number; output: number };
}
const LOW: Profile = {
  c0: 100e3, draftReads: 2.1e6, calls: 55, perGame: 150e3, output: 17e3, games: SWISS_ROUNDS * 2,
  between: { calls: 2, text: 7e3, output: 0.5e3 },
  fresh: { calls: 32, perGame: 75e3, output: 10e3 },
};
const HIGH: Profile = {
  c0: 126e3, draftReads: 3.0e6, calls: 95, perGame: 270e3, output: 33e3, games: SWISS_ROUNDS * 3,
  between: { calls: 3, text: 9e3, output: 3e3 },
  fresh: { calls: 50, perGame: 150e3, output: 17e3 },
};

/**
 * Effort levels against low (the measured base): `usd` scales a seat's cost, `tokens` its token counts. Low and medium
 * are measured (Claude Haiku 5.5 · Claude Code, second hosted table); the rest are extrapolated, rounded up.
 */
export const EFFORT_FACTORS: Record<string, { usd: number; tokens: number; measured: boolean }> = {
  minimal: { usd: 1, tokens: 1, measured: false },
  low: { usd: 1, tokens: 1, measured: true },
  medium: { usd: 1.32, tokens: 1.2, measured: true },
  high: { usd: 1.75, tokens: 1.45, measured: false },
  xhigh: { usd: 2.3, tokens: 1.75, measured: false },
  max: { usd: 3, tokens: 2.1, measured: false },
};
/** A seat's effort factor; the harness default, "unknown" or no level counts as medium. */
export const effortFactor = (effort: string | undefined) => EFFORT_FACTORS[String(effort ?? '').toLowerCase()] ?? EFFORT_FACTORS.medium!;
const DRAFT_CALLS = 45;
const DRAFT_OUTPUT = 5e3;
const COMPACT_AT = 1.0e6;
const COMPACT_TO = 170e3;
/**
 * A fresh session's context when it starts a game (`--fresh-session`, rotation.ts): measured 31 k on Claude Code at
 * TLA, the longest Set Context (6 k for the harness's start and the resume briefing, 23 k for the Set Context it reads
 * again before its first game decision, then the decision). Sets with a shorter Set Context start lower. From there
 * the game grows the context as in one long session.
 */
export const FRESH_START = 30e3;

/** One harness call: its context size, the tokens it read from cache and wrote to it. */
interface Call { context: number; read: number; write: number }
export interface TokenRun { calls: Call[]; output: number }

/** `shape`: the measured tables' (3 games, one per match, nothing between games), for calibration only. */
function replay(p: Profile, fresh: FreshSession = 'off', shape: 'best-of-3' | 'measured' = 'best-of-3'): TokenRun {
  const calls: Call[] = [];
  for (let i = 0; i < DRAFT_CALLS; i++) calls.push({ context: (p.c0 * (i + 1)) / DRAFT_CALLS, read: p.draftReads / DRAFT_CALLS, write: p.c0 / DRAFT_CALLS });
  let ctx = p.c0;
  const games = shape === 'measured' ? SWISS_ROUNDS : p.games;
  const perMatch = Math.max(1, Math.round(games / SWISS_ROUNDS));
  let betweens = 0;
  // A fresh session per game or match plays its games at the fresh-session sizes (measured that way).
  const g0 = fresh === 'off' ? { calls: p.calls, perGame: p.perGame, output: p.output } : p.fresh;
  const step = g0.perGame / g0.calls;
  for (let g = 0; g < games; g++) {
    // A fresh session (after the deck lock, then every game or match): its first call writes its whole context.
    if (fresh === 'per-game' || (fresh === 'per-match' && g % perMatch === 0)) {
      calls.push({ context: FRESH_START, read: 0, write: FRESH_START });
      ctx = FRESH_START;
    }
    // Between two games of a match: play or draw, then sideboarding; the decision text stays in the context.
    if (shape === 'best-of-3' && g % perMatch !== 0) {
      betweens++;
      const add = (p.between.text + p.between.output) / p.between.calls;
      for (let i = 0; i < p.between.calls; i++) {
        calls.push({ context: ctx + add, read: ctx, write: add });
        ctx += add;
      }
    }
    for (let i = 0; i < g0.calls; i++) {
      if (ctx + step > COMPACT_AT) {
        // Compaction: one call reads the whole context, then the summary is written.
        calls.push({ context: ctx, read: ctx, write: 0 }, { context: COMPACT_TO, read: 0, write: COMPACT_TO });
        ctx = COMPACT_TO;
      }
      calls.push({ context: ctx + step, read: ctx, write: step });
      ctx += step;
    }
  }
  return { calls, output: DRAFT_OUTPUT + games * g0.output + betweens * p.between.output };
}

/**
 * Per seat at low effort, low and high: calls, cache reads, cache writes (the fresh input) and output. `fresh`: the
 * seat's --fresh-session mode (one long session when off), each with its own measured game sizes.
 */
export function projectTokens(fresh: FreshSession = 'off'): { low: TokenRun; high: TokenRun } {
  return { low: replay(LOW, fresh), high: replay(HIGH, fresh) };
}

/** The request model in the shape of the two measured best-of-1 tables (3 games, nothing between them): calibration. */
export function calibrationTokens(fresh: FreshSession = 'off'): { low: TokenRun; high: TokenRun } {
  return { low: replay(LOW, fresh, 'measured'), high: replay(HIGH, fresh, 'measured') };
}

export const sumOf = (run: TokenRun, k: 'read' | 'write') => run.calls.reduce((s, c) => s + c[k], 0);

/**
 * A token run at a model's list price, in USD. A request whose context is over the model's long-context size pays the
 * long-context prices (registry/prices.json); output, which the model doesn't split by request, follows the share of
 * long requests.
 */
export function runUsd(run: TokenRun, model: string, price: PriceEntry): number {
  const long = price.long_context;
  // Claude Code caches for 1 hour: twice the tier's input price (the registry lists the 5-minute write).
  const rates = (r: Pick<PriceEntry, 'input' | 'cache_read' | 'cache_write'>) => ({
    write: model.startsWith('claude-') ? 2 * r.input : r.cache_write ?? r.input,
    read: r.cache_read ?? r.input,
  });
  const base = rates(price);
  const high = long ? rates(long) : base;
  let usd = 0;
  let longCalls = 0;
  for (const c of run.calls) {
    const isLong = !!long && c.context > long.above;
    if (isLong) longCalls++;
    const r = isLong ? high : base;
    usd += (c.read * r.read + c.write * r.write) / 1e6;
  }
  const f = long && run.calls.length ? longCalls / run.calls.length : 0;
  return usd + (run.output * (price.output * (1 - f) + (long?.output ?? price.output) * f)) / 1e6;
}

/**
 * A seat's cost range at its model's list price and effort (effortFactor; low when not given), or null when the
 * registry has no price for the model.
 */
export function seatUsd(model: string | undefined, at: number | string | Date = Date.now(), fresh: FreshSession = 'off', effort: string = 'low', tokens = projectTokens(fresh)): [number, number] | null {
  const price = model ? priceFor(model, at) : null;
  if (!model || !price) return null;
  const { low, high } = tokens;
  const k = effortFactor(effort).usd;
  return [runUsd(low, model, price) * k, runUsd(high, model, price) * k];
}

// The per-game sizes were measured on Claude Haiku 5.5 (best-of-1 tables; one session at low effort, a fresh session per
// game at low and medium). Best of 3 with sideboarding is projected from them for every model: every figure is "projected".

/** Seats of an unpriced model: the range of the priced Claude tiers' midpoints would mislead, so use Haiku to Opus. */
const FALLBACK_RANGE = (fresh: FreshSession, effort: string): [number, number] => [seatUsd('claude-haiku-5-5', Date.now(), fresh, effort)![0], seatUsd('claude-opus-5-5', Date.now(), fresh, effort)![1]];

const round = (n: number) => (n >= 100 ? Math.round(n / 10) * 10 : n >= 10 ? Math.round(n) : Math.round(n * 10) / 10);
export const fmtUsd = (n: number) => `$${round(n)}`;

/**
 * The cost of a table's seats: per seat (each distinct model and effort) and in all. `models` holds one entry per LLM
 * seat (registry ids), `efforts` the seats' effort levels in the same order (low when not given); an unpriced model
 * counts with the Haiku-to-Opus range.
 */
export function tableUsd(models: Array<string | undefined>, fresh: FreshSession = 'off', efforts?: Array<string | undefined>, freshEach?: Array<FreshSession | undefined>): { perModel: Array<{ model: string; effort: string; seats: number; usd: [number, number]; basis: 'projected' | 'no list price'; fresh: FreshSession }>; total: [number, number] } {
  // `freshEach`: a seat's own policy where it differs (a seat seated by hand keeps one session: 'off').
  const counts = new Map<string, { model: string; effort: string; seats: number; fresh: FreshSession }>();
  models.forEach((m, i) => {
    const model = m ?? '?';
    const effort = efforts ? String(efforts[i] ?? 'default').toLowerCase() : 'low';
    const f = freshEach?.[i] ?? fresh;
    const key = `${model}|${effort}|${f}`;
    counts.set(key, { model, effort, fresh: f, seats: (counts.get(key)?.seats ?? 0) + 1 });
  });
  const perModel = [...counts.values()].map(({ model, effort, seats, fresh: f }) => {
    const usd = seatUsd(model === '?' ? undefined : model, Date.now(), f, effort);
    const basis = !usd ? 'no list price' as const : 'projected' as const;
    return { model, effort, seats, usd: usd ?? FALLBACK_RANGE(f, effort), basis, fresh: f };
  });
  const total = perModel.reduce<[number, number]>((t, x) => [t[0] + x.usd[0] * x.seats, t[1] + x.usd[1] * x.seats], [0, 0]);
  return { perModel, total };
}
