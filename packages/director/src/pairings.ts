/**
 * Match pairings for an event's rounds (docs/METHODOLOGY.md §3, docs/PROTOCOL.md §8).
 *
 * Default: a **3-round Swiss**, like a real draft pod: each seat plays 3 matches. Round robin (every pair meets
 * once: 7 matches per seat at an 8-seat table) stays available for Private Tables.
 *
 * Swiss pairings are a pure function of the event seed, the seats (name + declared identity + contributor) and
 * the results of earlier rounds, so the Hub regenerates and checks them (packages/hub/src/checks.ts). Each round
 * is paired when the previous one has finished:
 * - round 1 is random (seeded);
 * - later rounds pair seats by match points (win 3, draw 1, bye 3; a match with no result, cut short by engine
 *   failures, gives neither seat any points), never rematch (a no-result pair has met), and break ties with a seeded
 *   random order per round;
 * - version 3 (from 2026-10-23), every round but the last: among pairings without rematches, prefer ones that don't
 *   pair two seats of the same identity (their games aren't rated: self-play); among those, keep seats within their
 *   score group (the sum of squared match-point differences: a seat floats to the adjacent group only when that avoids
 *   a mirror or a group is odd, and as little as possible); then avoid two seats of the same contributor (lobby
 *   tables: no throwing games to a friend). This is the standard Swiss pair-down float, used to keep games rated.
 * - version 3, the last round: strict points pairing. Score groups first; a mirror, then a same-contributor pair, is
 *   avoided only among equal-record options. So the seats with the best record meet in the last round.
 * - remaining ties go to the seeded standing order.
 * - version 2 (2026-10-23, before version 3) used the last-round rule in every round: one 3-0 per 8-seat pod, but a
 *   4 + 4 Effort Ladder table rated only about 8 of its 12 matches. Version 1 (logs before 2026-10-23) put identity
 *   and contributor avoidance before the score groups in every round, which could pair both 2-0 seats down in the
 *   last round and leave two 3-0s. Both stay here so the Hub can verify those logs.
 * - version 4 (owner decision 13, 2026-10-23): the same rules as version 3, with the pairing identity model/effort
 *   (the harness is no longer part of a setup: METHODOLOGY §2), so Claude Code and Cursor seats of one model and level
 *   count as a mirror. Versions 1–3 keep harness/model/effort.
 * - version 3 trade-off: a float in round 2 can leave three 2-0 seats, and then the last round pairs one of them down,
 *   so an 8-seat pod occasionally has two 3-0s (pairings.test.ts measures how often).
 *
 * The search enumerates every perfect matching (105 for 8 seats), so the result is exact and easy to verify. It
 * never uses the event's main Rng (that one regenerates the packs): pairing Rngs are derived from the seed.
 *
 * Bump PAIRING_VERSION with any change to the output for the same inputs: the Hub only checks versions it knows.
 */
import { Rng } from './rng.js';

export const PAIRING_VERSION = 4;
/** Every pairing version this code can reproduce (the Hub verifies logs of any of them). */
export const PAIRING_VERSIONS: readonly number[] = [1, 2, 3, 4];
export type PairingFormat = 'swiss' | 'round-robin';
export const PAIRING_FORMATS: PairingFormat[] = ['swiss', 'round-robin'];
export const DEFAULT_SWISS_ROUNDS = 3;
/** Largest table the exhaustive matching search is used for (10,395 matchings at 12). */
const MAX_SEATS = 12;

export interface PairingSeat {
  name: string;
  /** Declared model/effort (versions 1–3: harness/model/effort), lowercased; two seats with the same identity are not paired when avoidable. */
  identity?: string;
  /** Contributor id (lobby tables); two seats of one contributor are not paired when avoidable. */
  contributor?: string;
}

/** One round: pairs [a, b] (a ranked higher) and the seats with a bye. */
export interface RoundPairing {
  round: number;
  pairs: Array<[string, string]>;
  byes: string[];
}

/** A finished match, as match_end logs it. */
export interface MatchOutcome {
  a: string;
  b: string;
  wins: Record<string, number>;
  /** The match couldn't be finished (engine failures): no match points for either seat; the pair still counts as met. */
  no_result?: boolean;
}

/** The format logged in event_start.pairing. */
export interface PairingPlan {
  format: PairingFormat;
  rounds: number;
  version: number;
}

/**
 * How many Swiss rounds a table of n seats plays: the requested number, but at most half the table (rounded up
 * to even), so that a pairing without rematches always exists (Dirac: after r − 1 rounds every seat still has
 * n − r unplayed opponents, at least n / 2).
 */
export function swissRoundCount(n: number, requested = DEFAULT_SWISS_ROUNDS): number {
  if (n < 2) return 0;
  const even = n % 2 ? n + 1 : n;
  return Math.max(1, Math.min(requested, Math.floor(even / 2)));
}

export function plan(format: PairingFormat, n: number, swissRounds = DEFAULT_SWISS_ROUNDS): PairingPlan {
  const rounds = n < 2 ? 0 : format === 'round-robin' ? (n % 2 ? n : n - 1) : swissRoundCount(n, swissRounds);
  return { format, rounds, version: PAIRING_VERSION };
}

/** Match points so far: win 3, draw 1, loss 0, bye 3, no result 0 for both. */
export function matchPoints(names: string[], prior: RoundPairing[], results: MatchOutcome[]): Map<string, number> {
  const pts = new Map(names.map((n) => [n, 0]));
  for (const m of results) {
    if (m.no_result) continue;
    const wa = m.wins[m.a] ?? 0;
    const wb = m.wins[m.b] ?? 0;
    if (wa > wb) pts.set(m.a, (pts.get(m.a) ?? 0) + 3);
    else if (wb > wa) pts.set(m.b, (pts.get(m.b) ?? 0) + 3);
    else {
      pts.set(m.a, (pts.get(m.a) ?? 0) + 1);
      pts.set(m.b, (pts.get(m.b) ?? 0) + 1);
    }
  }
  for (const r of prior) for (const s of r.byes) pts.set(s, (pts.get(s) ?? 0) + 3);
  return pts;
}

const BYE = '\u0000bye';

/**
 * Pair Swiss round `round` (1-based) from the seats, the seed, the earlier rounds and their results. Seats are
 * given in any order (they are sorted by name first, so the input order never matters).
 */
export function pairSwissRound(
  seats: PairingSeat[], seed: string, round: number, prior: RoundPairing[], results: MatchOutcome[], version: number = PAIRING_VERSION,
  /** The event's number of rounds (version 3 pairs its last round strictly by points). */
  totalRounds: number = DEFAULT_SWISS_ROUNDS,
): RoundPairing {
  if (!PAIRING_VERSIONS.includes(version)) throw new Error(`unknown pairing version ${version}`);
  const sorted = [...seats].sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
  if (sorted.length > MAX_SEATS) throw new Error(`Swiss pairing supports at most ${MAX_SEATS} seats`);
  if (sorted.length < 2) return { round, pairs: [], byes: sorted.map((s) => s.name) };
  const names = sorted.map((s) => s.name);
  const pts = matchPoints(names, prior, results);
  // The seeded tie-break for this round: a shuffle of the name-sorted seats.
  const tiebreak = new Map(new Rng(`${seed}|pairing|swiss|r${round}`).shuffle(names).map((n, i) => [n, i]));
  const order = [...names].sort((x, y) => (pts.get(y)! - pts.get(x)!) || (tiebreak.get(x)! - tiebreak.get(y)!));
  if (order.length % 2) order.push(BYE);
  const info = new Map(sorted.map((s) => [s.name, s]));
  const met = new Set<string>();
  const key = (x: string, y: string) => (x < y ? `${x}|${y}` : `${y}|${x}`);
  for (const r of prior) {
    for (const [x, y] of r.pairs) met.add(key(x, y));
    for (const s of r.byes) met.add(key(s, BYE));
  }
  const cost = (x: string, y: string): number[] => {
    if (y === BYE || x === BYE) return [met.has(key(x, y)) ? 1 : 0, 0, 0, 0];
    const a = info.get(x)!;
    const b = info.get(y)!;
    const rematch = met.has(key(x, y)) ? 1 : 0;
    const identity = a.identity && a.identity === b.identity ? 1 : 0;
    const contributor = a.contributor && a.contributor === b.contributor ? 1 : 0;
    const diff = Math.abs(pts.get(x)! - pts.get(y)!);
    // v3, before the last round: avoid mirrors first, floating as little as possible (squared, so one big float costs
    // more than two small ones), then contributor. v3's last round and v2: score groups first, then identity, contributor.
    if (version >= 3 && round < totalRounds) return [rematch, identity, diff * diff, contributor];
    return version >= 2 ? [rematch, diff * diff, identity, contributor] : [rematch, identity, contributor, diff];
  };
  // Every perfect matching, in lexicographic order of (first unpaired seat in standing order, its partner's index):
  // the first one with the lowest cost wins, so remaining ties follow the standing order.
  let best: { cost: number[]; pairs: Array<[string, string]> } | undefined;
  const less = (a: number[], b: number[]) => {
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i]! < b[i]!;
    return false;
  };
  const used = new Array<boolean>(order.length).fill(false);
  const pairs: Array<[string, string]> = [];
  const acc = [0, 0, 0, 0];
  const walk = () => {
    // Costs only grow as pairs are added, so a partial cost that isn't below the best can't end below it.
    if (best && !less(acc, best.cost)) return;
    const i = used.indexOf(false);
    if (i < 0) {
      if (!best || less(acc, best.cost)) best = { cost: [...acc], pairs: [...pairs] };
      return;
    }
    used[i] = true;
    for (let j = i + 1; j < order.length; j++) {
      if (used[j]) continue;
      const c = cost(order[i]!, order[j]!);
      used[j] = true;
      for (let k = 0; k < 4; k++) acc[k]! += c[k]!;
      pairs.push([order[i]!, order[j]!]);
      walk();
      pairs.pop();
      for (let k = 0; k < 4; k++) acc[k]! -= c[k]!;
      used[j] = false;
    }
    used[i] = false;
  };
  walk();
  const out: RoundPairing = { round, pairs: [], byes: [] };
  for (const [x, y] of best!.pairs) {
    if (y === BYE) out.byes.push(x);
    else if (x === BYE) out.byes.push(y);
    else out.pairs.push([x, y]);
  }
  return out;
}

/** Circle-method round robin over the seats in table order: rounds of disjoint pairs. */
export function roundRobinSchedule(names: string[]): RoundPairing[] {
  const list: Array<string | null> = [...names];
  if (list.length % 2) list.push(null);
  const n = list.length;
  const rounds: RoundPairing[] = [];
  for (let r = 0; r < n - 1; r++) {
    const pairs: Array<[string, string]> = [];
    const byes: string[] = [];
    for (let i = 0; i < n / 2; i++) {
      const a = list[i];
      const b = list[n - 1 - i];
      if (a != null && b != null) pairs.push([a, b]);
      else if (a != null || b != null) byes.push((a ?? b)!);
    }
    rounds.push({ round: r + 1, pairs, byes });
    list.splice(1, 0, list.pop()!);
  }
  return rounds;
}

/**
 * The pairing of round `round` (1-based) for a plan: Swiss from the results so far, round robin from the fixed
 * schedule (seats in table order).
 */
export function pairRound(p: PairingPlan, seats: PairingSeat[], seed: string, round: number, prior: RoundPairing[], results: MatchOutcome[]): RoundPairing {
  if (p.format === 'round-robin') return roundRobinSchedule(seats.map((s) => s.name))[round - 1] ?? { round, pairs: [], byes: [] };
  return pairSwissRound(seats, seed, round, prior, results, p.version, p.rounds);
}

/** The pairing identity of a seat from its declared metadata (event_start.seats[] fields), for a pairing version. */
export function pairingSeat(name: string, meta: { harness?: unknown; model?: unknown; effort?: unknown; contributor_id?: unknown } = {}, version: number = PAIRING_VERSION): PairingSeat {
  const h = typeof meta.harness === 'string' ? meta.harness.trim().toLowerCase() : '';
  const m = typeof meta.model === 'string' ? meta.model.trim().toLowerCase() : '';
  const e = typeof meta.effort === 'string' && meta.effort.trim() ? meta.effort.trim().toLowerCase() : 'default';
  const c = meta.contributor_id != null && String(meta.contributor_id) !== '' ? String(meta.contributor_id) : undefined;
  return { name, ...(h && m ? { identity: version >= 4 ? `${m}/${e}` : `${h}/${m}/${e}` } : {}), ...(c ? { contributor: c } : {}) };
}

/** Same pairs, same orientation, same byes. */
export function samePairing(a: Pick<RoundPairing, 'pairs' | 'byes'>, b: Pick<RoundPairing, 'pairs' | 'byes'>): boolean {
  const k = (r: Pick<RoundPairing, 'pairs' | 'byes'>) => JSON.stringify([r.pairs.map(([x, y]) => `${x}|${y}`).sort(), [...r.byes].sort()]);
  return k(a) === k(b);
}

export interface PairingCheck {
  ok: boolean;
  /** 'skip' when the log has no pairing plan (older Directors: round robin, not verified). */
  status: 'verified' | 'mismatch' | 'skip';
  problems: string[];
  rounds: number;
}

/**
 * Verify an event log's pairings (the Hub): every round_start is the pairing the plan gives for the seed, the
 * seats and the logged results of the earlier rounds; every match played belongs to its round's pairs.
 */
export function verifyPairings(events: Array<Record<string, any>>): PairingCheck {
  const start = events.find((e) => e.type === 'event_start');
  const p = start?.pairing as PairingPlan | undefined;
  if (!start || !p || typeof p !== 'object') return { ok: true, status: 'skip', problems: [], rounds: 0 };
  const problems: string[] = [];
  if (!PAIRING_VERSIONS.includes(p.version)) return { ok: true, status: 'skip', problems: [`pairing version ${p.version} is not known to this checker`], rounds: 0 };
  if (!PAIRING_FORMATS.includes(p.format)) return { ok: false, status: 'mismatch', problems: [`unknown pairing format ${String(p.format)}`], rounds: 0 };
  const agents = (start.seats as Array<Record<string, any>>).filter((s) => s.kind === 'agent').sort((a, b) => a.position - b.position);
  const seats = agents.map((s) => pairingSeat(s.name, s, p.version));
  const expectRounds = plan(p.format, seats.length, p.format === 'swiss' ? p.rounds : undefined).rounds;
  if (p.rounds !== expectRounds) problems.push(`event_start.pairing says ${p.rounds} rounds; ${p.format} for ${seats.length} seats gives ${expectRounds}`);
  const logged = events.filter((e) => e.type === 'round_start');
  const ends = new Map<string, MatchOutcome>();
  for (const e of events) if (e.type === 'match_end') ends.set(`${e.a} vs ${e.b}`, { a: e.a, b: e.b, wins: e.wins ?? {}, ...(e.no_result === true ? { no_result: true } : {}) });
  const prior: RoundPairing[] = [];
  const results: MatchOutcome[] = [];
  const paired = new Set<string>();
  for (let r = 1; r <= p.rounds; r++) {
    const rec = logged.filter((e) => e.round === r);
    if (rec.length !== 1) {
      problems.push(`round ${r}: ${rec.length} round_start records`);
      break;
    }
    const want = pairRound(p, seats, String(start.seed), r, prior, results);
    const got = { pairs: (rec[0]!.pairs ?? []) as Array<[string, string]>, byes: (rec[0]!.byes ?? []) as string[] };
    if (!samePairing(want, got)) {
      problems.push(`round ${r}: logged pairs ${JSON.stringify(got.pairs)} byes ${JSON.stringify(got.byes)}, expected ${JSON.stringify(want.pairs)} byes ${JSON.stringify(want.byes)}`);
      break;
    }
    prior.push(want);
    for (const [a, b] of want.pairs) {
      paired.add(`${a} vs ${b}`);
      const m = ends.get(`${a} vs ${b}`);
      if (!m) {
        problems.push(`round ${r}: no match_end for ${a} vs ${b}`);
        continue;
      }
      results.push(m);
    }
  }
  if (logged.length > p.rounds) problems.push(`${logged.length} round_start records for ${p.rounds} rounds`);
  for (const k of ends.keys()) if (!paired.has(k) && !problems.length) problems.push(`match ${k} was not paired in any round`);
  return { ok: !problems.length, status: problems.length ? 'mismatch' : 'verified', problems, rounds: p.rounds };
}
