/**
 * Outcomes (docs/METHODOLOGY.md §4.4, docs/SITE-DATA.md 2.8): what agents achieved against each other. Games, best-of-N
 * matches, the play/draw split, event finishes, Swiss finishes and head to head, all from the same rated games as the
 * rating. Nothing here feeds the rating; these are the results the rating summarizes.
 */
import { eventWinner } from './metrics.js';
import { clusterBootstrap, normalQuantile } from './rating.js';
import type { EventData } from './data.js';
import type { Est, EventFinish, Outcomes, PairRecord, SwissFinishes, WinLoss } from './schema.js';

/** A rated game with its seats (scoring.ts ratingGamesOf). */
export interface OutcomeGame {
  event: string; a: string; b: string; seatA: string; seatB: string; winner: 'a' | 'b';
  /** Game 1 (random): who was on the play. Games 2–3 carry onPlayChosen (the previous loser chose): not in the play/draw split. */
  onPlay?: 'a' | 'b';
  onPlayChosen?: 'a' | 'b';
  /** A finished game of a match that ended with no result (METHODOLOGY §3.2): it counts as a game, never toward a match. */
  noResult?: boolean;
}

export interface IntervalOpts { replicates: number; seed: number; ci?: number }

/** z for a central interval (0.95 → 1.96). */
const zOf = (ci: number): number => normalQuantile(1 - (1 - ci) / 2);

/** Wilson score interval for w successes in n trials. Null when n = 0. */
export function wilson(w: number, n: number, ci = 0.95): [number, number] | null {
  if (n <= 0) return null;
  const z = zOf(ci);
  const p = w / n;
  const d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}

/**
 * A win rate from 0/1 items clustered by event: the point estimate, and the wider of the cluster bootstrap interval and
 * the Wilson interval (like the rating's max(bootstrap, Laplace)). The bootstrap captures event-to-event variation;
 * Wilson keeps small or one-sided samples (3–0, every resample identical) from looking certain.
 */
export function rateEst(clusters: number[][], opts: IntervalOpts): Est | null {
  const nonEmpty = clusters.filter((c) => c.length);
  const items = nonEmpty.flat();
  if (!items.length) return null;
  const w = items.reduce((s, x) => s + x, 0);
  const boot = opts.replicates > 0 ? clusterBootstrap(nonEmpty, (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : undefined), { replicates: opts.replicates, seed: opts.seed, ci: opts.ci ?? 0.95 }) : null;
  const wi = opts.replicates > 0 ? wilson(w, items.length, opts.ci ?? 0.95) : null;
  let ci: [number, number] | null = null;
  if (boot?.ci && wi) ci = [Math.min(boot.ci[0], wi[0]), Math.max(boot.ci[1], wi[1])];
  else ci = boot?.ci ?? wi;
  return { value: w / items.length, ci, n: items.length, events: nonEmpty.length };
}

function winLoss(byEvent: Map<string, number[]>, opts: IntervalOpts): WinLoss {
  const all = [...byEvent.values()].flat();
  const w = all.filter((x) => x === 1).length;
  return { w, l: all.length - w, win_rate: rateEst([...byEvent.values()], opts) };
}

const push = (m: Map<string, number[]>, k: string, v: number) => {
  const xs = m.get(k);
  if (xs) xs.push(v);
  else m.set(k, [v]);
};

/** A side of a rated game that belongs to the subject (an identity, or any identity of a model). */
export interface Side { game: OutcomeGame; seat: string; opponentSeat: string; won: boolean; onPlay: boolean | null }

/** The subject's sides in `games`. `mine(identity)` says whether an identity is the subject; games where both sides are the subject are skipped. */
export function sidesOf(games: OutcomeGame[], mine: (identity: string) => boolean): Side[] {
  const out: Side[] = [];
  for (const g of games) {
    const a = mine(g.a);
    const b = mine(g.b);
    if (a === b) continue;
    const seat = a ? g.seatA : g.seatB;
    const side = a ? 'a' : 'b';
    out.push({ game: g, seat, opponentSeat: a ? g.seatB : g.seatA, won: g.winner === side, onPlay: g.onPlay == null ? null : g.onPlay === side });
  }
  return out;
}

/** Matches (event + seat pair) decided by the subject's rated games: wins per event, and level matches. */
export function matchRecords(sides: Side[]): { byEvent: Map<string, number[]>; drawn: number } {
  const m = new Map<string, { event: string; w: number; l: number }>();
  for (const s of sides) {
    if (s.game.noResult) continue;
    const k = `${s.game.event}|${s.seat}|${s.opponentSeat}`;
    const r = m.get(k) ?? { event: s.game.event, w: 0, l: 0 };
    if (s.won) r.w++;
    else r.l++;
    m.set(k, r);
  }
  const byEvent = new Map<string, number[]>();
  let drawn = 0;
  for (const r of m.values()) {
    if (r.w === r.l) drawn++;
    else push(byEvent, r.event, r.w > r.l ? 1 : 0);
  }
  return { byEvent, drawn };
}

/** Finish of `seat` in a finished event, among the agent seats of its standings. */
export function finishOf(ev: EventData, seat: string): EventFinish | null {
  const agents = ev.standings.filter((st) => ev.seats.find((s) => s.name === st.name)?.kind === 'agent');
  const i = agents.findIndex((st) => st.name === seat);
  if (i < 0) return null;
  const st = agents[i]!;
  return {
    event_id: ev.id,
    seat,
    started_at: ev.startT,
    format: ev.format?.format ?? 'round-robin',
    rank: i + 1,
    of: agents.length,
    won: eventWinner(ev) === seat,
    match_w: st.matchWins,
    match_l: st.matchLosses,
  };
}

/** Three-round Swiss with 8 language-model agents: the format whose finishes are comparable (3–0 / 2–1 / 1–2 / 0–3). Scripted seats are `kind: agent` too, so they're counted out. */
export const isSwiss8 = (ev: EventData): boolean => ev.format?.format === 'swiss' && ev.seats.filter((s) => s.llm).length === 8;

/**
 * Swiss finishes by setup over finished 8-agent Swiss events (2.11): a fact about the tables, so it needs no rated game
 * and counts every LLM seat, a table of one setup included. Most seats first.
 */
export function swissFinishes(evs: EventData[], identityOf: (ev: EventData, seat: string) => string): SwissFinishes[] {
  const by = new Map<string, SwissFinishes & { evs: Set<string> }>();
  for (const ev of evs) {
    if (ev.status !== 'complete' || !isSwiss8(ev)) continue;
    const rounds = ev.format!.rounds;
    for (const s of ev.seats.filter((x) => x.llm)) {
      const f = finishOf(ev, s.name);
      if (!f) continue;
      const identity = identityOf(ev, s.name);
      let r = by.get(identity);
      if (!r) {
        r = { identity, events: 0, seats: 0, rounds, counts: {}, trophies: 0, evs: new Set() };
        by.set(identity, r);
      }
      r.rounds = Math.max(r.rounds, rounds);
      for (let w = rounds; w >= 0; w--) r.counts[`${w}-${rounds - w}`] ??= 0;
      const key = `${f.match_w}-${f.match_l}`;
      r.counts[key] = (r.counts[key] ?? 0) + 1;
      r.seats++;
      if (f.match_w === rounds && f.match_l === 0) r.trophies++;
      r.evs.add(ev.id);
    }
  }
  return [...by.values()]
    .map(({ evs: e, ...r }) => ({ ...r, events: e.size, counts: Object.fromEntries(Object.entries(r.counts).sort((a, b) => Number(b[0].split('-')[0]) - Number(a[0].split('-')[0]))) }))
    .sort((a, b) => b.seats - a.seats || a.identity.localeCompare(b.identity));
}

/**
 * Outcomes of a subject over its rated games and its seats. `seats` are the subject's seats in finished, rated events
 * (one finish each); `games` the scope's rated games.
 */
export function outcomesOf(games: OutcomeGame[], mine: (identity: string) => boolean, seats: Array<{ ev: EventData; seat: string }>, opts: IntervalOpts): Outcomes {
  const sides = sidesOf(games, mine);
  const all = new Map<string, number[]>();
  const play = new Map<string, number[]>();
  const draw = new Map<string, number[]>();
  let unknown = 0;
  for (const s of sides) {
    const v = s.won ? 1 : 0;
    push(all, s.game.event, v);
    if (s.onPlay === true) push(play, s.game.event, v);
    else if (s.onPlay === false) push(draw, s.game.event, v);
    else if (s.game.onPlayChosen == null) unknown++;
  }
  const o = (k: number): IntervalOpts => ({ ...opts, seed: opts.seed + k });
  const mr = matchRecords(sides);
  const finishes = seats
    .filter((s) => s.ev.status === 'complete')
    .map((s) => finishOf(s.ev, s.seat))
    .filter((f): f is EventFinish => f != null)
    .sort((a, b) => b.started_at - a.started_at || a.seat.localeCompare(b.seat));
  const swissSeats = seats.filter((s) => s.ev.status === 'complete' && isSwiss8(s.ev));
  let swiss: Outcomes['swiss'] = null;
  if (swissSeats.length) {
    const rounds = Math.max(...swissSeats.map((s) => s.ev.format!.rounds));
    const counts: Record<string, number> = {};
    for (let w = rounds; w >= 0; w--) counts[`${w}-${rounds - w}`] = 0;
    const trophy = new Map<string, number[]>();
    for (const s of swissSeats) {
      const f = finishOf(s.ev, s.seat);
      if (!f) continue;
      const key = `${f.match_w}-${f.match_l}`;
      counts[key] = (counts[key] ?? 0) + 1;
      push(trophy, s.ev.id, f.match_w === s.ev.format!.rounds && f.match_l === 0 ? 1 : 0);
    }
    swiss = { events: new Set(swissSeats.map((s) => s.ev.id)).size, rounds, counts, trophy_rate: rateEst([...trophy.values()], o(4)) };
  }
  return {
    games: winLoss(all, o(0)),
    matches: { ...winLoss(mr.byEvent, o(1)), drawn: mr.drawn },
    on_play: winLoss(play, o(2)),
    on_draw: winLoss(draw, o(3)),
    side_unknown: unknown,
    events: { played: finishes.length, won: finishes.filter((f) => f.won).length, finishes },
    swiss,
  };
}

/** Head to head between identities, one entry per pair that met (a < b), most games first. */
export function pairwise(games: OutcomeGame[]): PairRecord[] {
  const m = new Map<string, PairRecord & { evs: Set<string>; mt: Map<string, number> }>();
  for (const g of games) {
    const [a, b] = g.a < g.b ? [g.a, g.b] : [g.b, g.a];
    const flip = a !== g.a;
    const k = `${a}\u0000${b}`;
    const r = m.get(k) ?? { a, b, games: 0, a_wins: 0, matches: 0, a_match_wins: 0, drawn_matches: 0, events: 0, evs: new Set<string>(), mt: new Map<string, number>() };
    const aWon = (g.winner === 'a') !== flip;
    r.games++;
    if (aWon) r.a_wins++;
    r.evs.add(g.event);
    // Match key: event + the two seats, oriented a-then-b; the value is a's game margin.
    const seatOfA = flip ? g.seatB : g.seatA;
    const seatOfB = flip ? g.seatA : g.seatB;
    const mk = `${g.event}|${seatOfA}|${seatOfB}`;
    if (!g.noResult) r.mt.set(mk, (r.mt.get(mk) ?? 0) + (aWon ? 1 : -1));
    m.set(k, r);
  }
  return [...m.values()]
    .map(({ evs, mt, ...r }) => {
      for (const margin of mt.values()) {
        if (margin === 0) r.drawn_matches++;
        else {
          r.matches++;
          if (margin > 0) r.a_match_wins++;
        }
      }
      return { ...r, events: evs.size };
    })
    .sort((x, y) => y.games - x.games || x.a.localeCompare(y.a) || x.b.localeCompare(y.b));
}

/**
 * Rank range from interval overlap: best = 1 + rows whose interval lies wholly above this one, worst = N − rows whose
 * interval lies wholly below. A row whose range overlaps everyone's gets [1, N]: "too early to rank".
 */
export function rankRanges<T>(rows: T[], ci: (r: T) => [number, number] | null): Array<[number, number] | null> {
  const n = rows.filter((r) => ci(r) != null).length;
  return rows.map((r) => {
    const mine = ci(r);
    if (!mine) return null;
    let above = 0;
    let below = 0;
    for (const o of rows) {
      if (o === r) continue;
      const c = ci(o);
      if (!c) continue;
      if (c[0] > mine[1]) above++;
      else if (c[1] < mine[0]) below++;
    }
    return [1 + above, n - below];
  });
}
