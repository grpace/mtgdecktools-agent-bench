/**
 * How many matches of a Swiss are rated: only games between two different setups (model + effort; the harness is never part of it) are
 * rated (METHODOLOGY §2.3–2.4), and the Swiss pairs two seats of one setup only when it can't avoid it
 * (pairings.ts). How often it can't depends on the results, so we run the real pairing function, at the current
 * PAIRING_VERSION, over simulated results and count the matches between different setups.
 *
 * The simulation is deterministic: a fixed set of seeds (`rated-estimate|<k>`), each with its own simulated results
 * (each match a coin flip, the loser taking 0 or 1 games). Seats are laid out canonically (largest setup first), so the
 * answer depends only on the table's composition (how many seats each setup has, and how many seats are never rated),
 * and it is cached per composition. The lobby's `needs` (lobby.ts) and setup's "Rated games this table can produce"
 * (scripts/bench/mix.ts) both read it, so they always agree.
 *
 * At 8 seats and 3 rounds (version 3), median (mean) of 12 matches: 4 + 4 rates 10 (10.5), 5 + 3 9 (8.1), 6 + 2 6 (5.7),
 * 7 + 1 3, four setups at 2 seats 12 (11.5: most pods rate every match), eight different setups always 12.
 */
import { PAIRING_VERSION, pairSwissRound, type MatchOutcome, type PairingSeat, type RoundPairing } from './pairings.js';
import { Rng } from './rng.js';

/** Simulated pods per composition. */
export const RATED_SIMULATIONS = 200;
/** Games per best-of-3 match on our tables (METHODOLOGY §3.2: 3 matches × 2.4 games ≈ 7 games per seat). */
export const GAMES_PER_MATCH = 2.4;

export interface RatedMatches {
  /** Matches the table plays (4 a round at 8 seats). */
  matches: number;
  /** Matches between two different setups: the median over the simulated pods, the fewest, the most and the mean. */
  rated: number;
  min: number;
  max: number;
  mean: number;
}

const cache = new Map<string, RatedMatches>();

/**
 * Rated matches for a table of these setups. `counts[i]` is the number of seats of setup i; `unrated` seats (scripted
 * test players) are paired like any other seat but their matches are never rated. Cached per composition.
 */
export function ratedMatches(counts: number[], unrated = 0, rounds = 3): RatedMatches {
  const sorted = counts.filter((c) => c > 0).sort((a, b) => b - a);
  const key = `${sorted.join('+')}|${unrated}|${rounds}|v${PAIRING_VERSION}`;
  const hit = cache.get(key);
  if (hit) return hit;
  // Canonical layout: setup g0's seats first (the largest), then g1, …, then the unrated seats.
  const setupOf: Array<number | null> = [...sorted.flatMap((c, g) => Array<number>(c).fill(g)), ...Array<null>(unrated).fill(null)];
  const n = setupOf.length;
  const name = (i: number) => `s${String(i).padStart(2, '0')}`;
  const seats: PairingSeat[] = setupOf.map((g, i) => ({ name: name(i), identity: g == null ? `\u0000unrated-${i}` : `g${g}` }));
  const ratedPair = (a: string, b: string) => {
    const ga = setupOf[Number(a.slice(1))];
    const gb = setupOf[Number(b.slice(1))];
    return ga != null && gb != null && ga !== gb;
  };
  const tallies: number[] = [];
  let matches = 0;
  for (let k = 0; k < RATED_SIMULATIONS; k++) {
    const seed = `rated-estimate|${k}`;
    const rng = new Rng(`${seed}|results`);
    const prior: RoundPairing[] = [];
    const results: MatchOutcome[] = [];
    let rated = 0;
    let played = 0;
    for (let r = 1; r <= rounds && n >= 2; r++) {
      const p = pairSwissRound(seats, seed, r, prior, results, PAIRING_VERSION, rounds);
      for (const [a, b] of p.pairs) {
        played++;
        if (ratedPair(a, b)) rated++;
        const aWins = rng.next() < 0.5;
        results.push({ a, b, wins: { [a]: aWins ? 2 : rng.int(2), [b]: aWins ? rng.int(2) : 2 } });
      }
      prior.push(p);
    }
    matches = played;
    tallies.push(rated);
  }
  tallies.sort((a, b) => a - b);
  const out: RatedMatches = {
    matches,
    rated: tallies[Math.floor(tallies.length / 2)] ?? 0,
    min: tallies[0] ?? 0,
    max: tallies[tallies.length - 1] ?? 0,
    mean: tallies.length ? tallies.reduce((s, x) => s + x, 0) / tallies.length : 0,
  };
  cache.set(key, out);
  return out;
}

/** Rated matches for seats given by setup key (null: a seat whose games are never rated). */
export function ratedMatchesOfSeats(identities: Array<string | null>, rounds = 3): RatedMatches {
  const counts = new Map<string, number>();
  let unrated = 0;
  for (const id of identities) {
    if (id == null) unrated++;
    else counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return ratedMatches([...counts.values()], unrated, rounds);
}

/** "about 10 of 12 matches rated" (the median); "all 12" / "none of the 12" when every pod agrees. */
export function ratedMatchesText(r: RatedMatches): string {
  if (r.matches === 0) return 'no matches';
  if (r.min === r.matches) return `all ${r.matches} matches rated`;
  if (r.max === 0) return `none of the ${r.matches} matches rated`;
  if (r.rated === r.matches) return `nearly all ${r.matches} matches rated`;
  return `about ${r.rated} of ${r.matches} matches rated`;
}

/** Rated games: the median rated matches at GAMES_PER_MATCH (rounded), as setup and the lobby show them. */
export const ratedGamesOf = (r: RatedMatches): number => Math.round(r.rated * GAMES_PER_MATCH);
