/**
 * Calibration of the headline rating (docs/METHODOLOGY.md §6) by simulating community data at the launch design and
 * fitting it with the production rating model (src/rating.ts). No LLM runs: pure simulation.
 *
 *   npx tsx packages/site/src/calibrate.ts [--sims 60] [--power-sims 200] [--replicates 200] [--jobs 16] [--out analysis/results]
 *
 * Writes <out>/calibration.md (report) and <out>/calibration.json (every number in it). Work is split over --jobs
 * child processes (each runs this file with --shard i --shards n and writes its records to a temporary file).
 *
 * Generative model per scenario (one simulated "community"):
 * - K seat identities with true strengths θ ~ N(0, skill SD) Elo and Zipf popularity. In the hierarchical scenarios
 *   θ = μ(model) + γ(harness) + ε(model, effort) + u(identity), to test the experimental pooled fit.
 * - C contributors with Zipf activity. Each contributor's seats of an identity play at θ + δ(contributor, identity),
 *   δ ~ N(0, contributor SD): their harness configuration, settings and luck with their setup.
 * - Every table seats 8 agents and plays a 3-round Swiss paired by the Director's own code (`pairSwissRound` in
 *   packages/director/src/pairings.ts, the current PAIRING_VERSION), best of 3, the loser of a game choosing to play
 *   first. A Private Table is one contributor's 4 identities × 2 seats; a lobby table is 3–4 contributors with 1–3
 *   seats each.
 * - Every seat draws a deck effect ~ N(0, deck SD) logits for the event, and identity × set effects ~ N(0, set SD) Elo.
 *   P(a wins) = σ((θa + δa + set_a − θb − δb − set_b ± play + nt(a, b))/173.7 + deck_a − deck_b), nt the
 *   non-transitive term (0 except in that scenario). As in production (scoring.ts ratingGamesOf), only game 1 of a
 *   match carries `onPlay` (random play/draw); games 2–3 carry `onPlayChosen` and no play term.
 * - Forfeits as losses (FORFEIT_POLICY 'loss'): each contributor × identity setup has a per-game chance of going
 *   silent (most setups 0.5%, a flaky share more); a silent seat loses the game, and stays silent for the match's next
 *   game half the time. No-result matches: each game is lost to infrastructure with a small chance; the match then
 *   ends with no result (no match points, the pair has met) and its finished games stay rated (METHODOLOGY §3.2).
 * - Drift: an identity's strength moves linearly over the 48 tables (a model or harness update behind one id); the
 *   truth a fit is compared with is the identity's mean strength over the tables fitted.
 * - Adversarial scenario: one contributor runs a share of the Private Tables and seats a rival identity sandbagged by
 *   150 Elo (a hostile configuration) against its favorite.
 * Noise levels come from 17Lands (analysis/results/noise-17lands.json: play advantage 15–33 Elo; deck-strength spread
 * at least 0.23–0.29 logits).
 */
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { DEFAULT_POOLING_SD, DEFAULT_RATING_OPTIONS, ELO_PER_LOGIT, INFLUENCE_Z, rateGames, rng, type PoolingSd, type RatingGame, type RatingOptions, type RatingResult } from './rating.js';
import { repoRoot } from './context.js';
import { PAIRING_VERSION, pairSwissRound, type MatchOutcome, type PairingSeat, type RoundPairing } from '../../director/src/pairings.js';

// ---------------------------------------------------------------------------
// Scenarios

interface Hierarchy { models: number; harnesses: number; efforts: string[]; modelSd: number; harnessSd: number; effortSd: number; residualSd: number }

interface Scenario {
  name: string;
  note: string;
  identities: number;
  skillSd: number; // Elo
  deckSd: number; // logits
  setSd: number; // Elo
  playElo: number;
  zipf: number;
  contributors: number;
  contribSd: number; // Elo, per contributor × identity
  privateShare: number; // P(a table is a Private Table)
  /** One contributor sandbags a rival identity on a share of all tables (Private Tables it runs). */
  adversary?: { share: number; sandbag: number };
  hierarchy?: Hierarchy;
  /** Forfeits: per-game chance a setup goes silent; `flakyShare` of setups use `flaky` instead of `base`. */
  forfeit: { base: number; flaky: number; flakyShare: number };
  /** Per-game chance a game is lost to infrastructure (four voids): the match ends with no result. */
  noResult: number;
  /** Non-transitive term: s · (x_a y_b − x_b y_a) Elo with x, y ~ N(0, 1) per identity (a two-dimensional skill). */
  nonTransitive?: number;
  /** Drift: SD (Elo) of each identity's total linear change over the 48 tables. */
  driftSd?: number;
  /** A stress test: the data break one of the rating model's assumptions on purpose (reported apart from the rest). */
  stress?: string;
  /**
   * Harnesses pooled into one identity (METHODOLOGY §2.2, export 2.20): each contributor runs each identity on one of
   * `harnesses` harnesses (the first with probability `skew`), whose offsets are N(0, sd) Elo, shared by everyone on it.
   * The truth a row is compared with is the identity as its seats ran: θ plus the mean offset of its seats so far.
   */
  harnessMix?: { harnesses: number; sd: number; skew: number };
}

const CENTRAL: Scenario = {
  name: 'central', note: 'skill SD 100, deck SD 0.25, contributor SD 30, 10 contributors, half Private Tables, 12 identities',
  identities: 12, skillSd: 100, deckSd: 0.25, setSd: 30, playElo: 20, zipf: 1, contributors: 10, contribSd: 30, privateShare: 0.5,
  forfeit: { base: 0.005, flaky: 0.04, flakyShare: 0.1 }, noResult: 0.005,
};

const HIER: Hierarchy = { models: 6, harnesses: 2, efforts: ['low', 'medium', 'high', 'unknown'], modelSd: 100, harnessSd: 40, effortSd: 40, residualSd: 20 };

const SCENARIOS: Scenario[] = [
  CENTRAL,
  { ...CENTRAL, name: 'close field', note: 'skill SD 50 (models nearly equal)', skillSd: 50 },
  { ...CENTRAL, name: 'heavy deck noise', note: 'deck SD 0.5 logits (twice the 17Lands spread)', deckSd: 0.5 },
  { ...CENTRAL, name: 'no contributor effects', note: 'contributor SD 0', contribSd: 0 },
  { ...CENTRAL, name: 'strong contributor effects', note: 'contributor SD 60 Elo', contribSd: 60 },
  { ...CENTRAL, name: 'few contributors', note: '4 contributors, Private Tables only', contributors: 4, privateShare: 1 },
  { ...CENTRAL, name: 'lobby only', note: 'every table a lobby mix of 3–4 contributors', privateShare: 0 },
  { ...CENTRAL, name: 'many models', note: '24 identities, steeper popularity (Zipf 1.3)', identities: 24, zipf: 1.3 },
  { ...CENTRAL, name: 'adversarial', note: 'one contributor runs 30% of tables, seating a rival 150 Elo below its strength', adversary: { share: 0.3, sandbag: -150 } },
  { ...CENTRAL, name: 'harnesses pooled', note: 'each contributor runs each identity on one of 2 harnesses (70/30), harness SD 40 Elo; truth = the identity as its seats ran', harnessMix: { harnesses: 2, sd: 40, skew: 0.7 } },
  { ...CENTRAL, name: 'harnesses pooled, strong', note: 'as harnesses pooled, harness SD 80 Elo and a 50/50 mix', harnessMix: { harnesses: 2, sd: 80, skew: 0.5 }, stress: 'harness effects twice the size, evenly mixed' },
  { ...CENTRAL, name: 'hierarchical', note: '6 models × 2 harnesses × 4 efforts (Unknown included); model SD 100, harness 40, effort 40, residual 20', identities: 0, hierarchy: HIER, zipf: 1.1 },
  { ...CENTRAL, name: 'hierarchical, misspecified', note: 'as hierarchical, residual SD 80 (pooling assumptions wrong)', identities: 0, hierarchy: { ...HIER, residualSd: 80 }, zipf: 1.1 },
  { ...CENTRAL, name: 'drift', note: 'each identity drifts linearly by N(0, 100) Elo over the 48 tables; truth = mean strength over the tables fitted', driftSd: 100 },
  { ...CENTRAL, name: 'wide spread', note: 'skill SD 200 (frontier against small models, as wide as the prior)', skillSd: 200, stress: 'a spread as wide as the rating prior (SD 200)' },
  { ...CENTRAL, name: 'very wide spread', note: 'skill SD 300 (wider than the SD-200 prior: the tails are shrunk)', skillSd: 300, stress: 'a spread wider than the rating prior' },
  { ...CENTRAL, name: 'non-transitive', note: 'a two-dimensional skill: matchup term 60 · (x_a y_b − x_b y_a) Elo on top of θ', nonTransitive: 60, stress: 'matchups the Bradley–Terry model has no term for' },
  { ...CENTRAL, name: 'large set effects', note: 'identity × set SD 80 Elo (against 30)', setSd: 80, stress: 'set effects larger than the set component assumes (30 Elo)' },
  { ...CENTRAL, name: 'correlated forfeits', note: '30% of setups go silent in 8% of games (against 10% at 4%); 2% of games lost to infrastructure', forfeit: { base: 0.005, flaky: 0.08, flakyShare: 0.3 }, noResult: 0.02 },
];

/** Tables at which every community is fitted. */
const CHECKPOINTS = [6, 12, 24, 48];

// ---------------------------------------------------------------------------
// Helpers

function gauss(r: () => number): number {
  let u = 0;
  while (u === 0) u = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
}

function pick(r: () => number, weights: number[]): number {
  const tot = weights.reduce((s, w) => s + w, 0);
  let x = r() * tot;
  for (let i = 0; i < weights.length; i++) {
    x -= weights[i]!;
    if (x <= 0) return i;
  }
  return weights.length - 1;
}

function shuffle<T>(r: () => number, xs: T[]): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

function spearman(xs: number[], ys: number[]): number {
  const rank = (v: number[]) => {
    const o = v.map((x, i) => [x, i] as const).sort((a, b) => a[0] - b[0]);
    const r = new Array<number>(v.length);
    o.forEach(([, i], k) => (r[i] = k));
    return r;
  };
  const n = xs.length;
  if (n < 3) return NaN;
  const rx = rank(xs);
  const ry = rank(ys);
  const d2 = rx.reduce((s, r, i) => s + (r - ry[i]!) ** 2, 0);
  return 1 - (6 * d2) / (n * (n * n - 1));
}

/** Lexicographic x < y. */
const lexLess = (x: number[], y: number[]): boolean => {
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i]! < y[i]!;
  return false;
};

const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN);
const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));

/** Every perfect matching of 8 seats (105), as pairs of seat indexes. */
const MATCHINGS: Array<Array<[number, number]>> = (() => {
  const out: Array<Array<[number, number]>> = [];
  const rec = (left: number[], acc: Array<[number, number]>) => {
    if (!left.length) return void out.push(acc);
    const [a, ...rest] = left;
    for (let i = 0; i < rest.length; i++) rec(rest.filter((_, j) => j !== i), [...acc, [a!, rest[i]!]]);
  };
  rec([0, 1, 2, 3, 4, 5, 6, 7], []);
  return out;
})();

// ---------------------------------------------------------------------------
// One simulated community

interface SimSeat { id: number; contributor: number; strength: number }
interface World {
  truth: number[]; // true θ per identity at the start, Elo
  /** Linear drift per table (Elo), drift scenario only. */
  drift: number[] | null;
  /** Non-transitive coordinates per identity (x, y), non-transitive scenario only. */
  nt: Array<[number, number]> | null;
  /** Per-game chance a contributor's setup of an identity goes silent ([contributor][identity]). */
  forfeitP: number[][];
  structure: Array<{ model: string; harness: string; effort: string }> | null;
  pop: number[];
  activity: number[];
  favorite: (c: number) => number[]; // a contributor's preferred identities (Private Tables)
  contribFx: number[][]; // [contributor][identity], Elo
  setFx: number[][]; // [identity][set], Elo
  /** harnessMix: offsets per harness, each contributor's harness per identity, and the offsets its seats played with. */
  harness: { fx: number[]; of: number[][]; seen: Array<Array<[number, number]>> } | null;
  adversary: { c: number; victim: number; favored: number } | null;
}

function makeWorld(sc: Scenario, r: () => number): World {
  let truth: number[];
  let structure: World['structure'] = null;
  if (sc.hierarchy) {
    const h = sc.hierarchy;
    const mu = Array.from({ length: h.models }, () => gauss(r) * h.modelSd);
    const ga = Array.from({ length: h.harnesses }, () => gauss(r) * h.harnessSd);
    const ep = Array.from({ length: h.models }, () => h.efforts.map(() => gauss(r) * h.effortSd));
    truth = [];
    structure = [];
    for (let m = 0; m < h.models; m++) {
      for (let k = 0; k < h.harnesses; k++) {
        for (let e = 0; e < h.efforts.length; e++) {
          truth.push(mu[m]! + ga[k]! + ep[m]![e]! + gauss(r) * h.residualSd);
          structure.push({ model: `m${m}`, harness: `h${k}`, effort: h.efforts[e]! });
        }
      }
    }
  } else {
    truth = Array.from({ length: sc.identities }, () => gauss(r) * sc.skillSd);
  }
  const K = truth.length;
  const order = shuffle(r, Array.from({ length: K }, (_, i) => i));
  const pop = new Array<number>(K);
  order.forEach((id, rankI) => (pop[id] = 1 / (rankI + 1) ** sc.zipf));
  const activity = Array.from({ length: sc.contributors }, (_, i) => 1 / (i + 1));
  const favs = Array.from({ length: sc.contributors }, () => {
    const w = [...pop];
    const out: number[] = [];
    for (let i = 0; i < Math.min(6, K); i++) {
      const k = pick(r, w);
      out.push(k);
      w[k] = 0;
    }
    return out;
  });
  const contribFx = Array.from({ length: sc.contributors }, () => Array.from({ length: K }, () => gauss(r) * sc.contribSd));
  const setFx = Array.from({ length: K }, () => Array.from({ length: 8 }, () => gauss(r) * sc.setSd));
  let adversary: World['adversary'] = null;
  if (sc.adversary) {
    // The adversary is the most active contributor; the victim and its favorite are the two most popular identities.
    const top = [...order];
    adversary = { c: 0, victim: top[0]!, favored: top[1]! };
  }
  const forfeitP = Array.from({ length: sc.contributors }, () => Array.from({ length: K }, () => (r() < sc.forfeit.flakyShare ? sc.forfeit.flaky : sc.forfeit.base)));
  const drift = sc.driftSd ? truth.map(() => (gauss(r) * sc.driftSd!) / (CHECKPOINTS[CHECKPOINTS.length - 1]! - 1)) : null;
  const nt = sc.nonTransitive ? truth.map(() => [gauss(r), gauss(r)] as [number, number]) : null;
  const harness = sc.harnessMix
    ? {
        fx: Array.from({ length: sc.harnessMix.harnesses }, () => gauss(r) * sc.harnessMix!.sd),
        of: Array.from({ length: sc.contributors }, () => Array.from({ length: K }, () => (r() < sc.harnessMix!.skew ? 0 : 1 + Math.floor(r() * (sc.harnessMix!.harnesses - 1))))),
        seen: Array.from({ length: K }, () => [] as Array<[number, number]>),
      }
    : null;
  return { truth, drift, nt, forfeitP, structure, pop, activity, favorite: (c) => favs[c]!, contribFx, setFx, harness, adversary };
}

/** An identity's true strength at table t (0-based). */
const strengthAt = (w: World, id: number, t: number) => w.truth[id]! + (w.drift ? w.drift[id]! * t : 0);
/** The truth a fit over the first T tables is compared with: the mean strength over those tables. */
const truthAt = (w: World, id: number, T: number) => w.truth[id]! + (w.drift ? (w.drift[id]! * (T - 1)) / 2 : 0) + harnessMean(w, id, T);
/** harnessMix: the mean harness offset of an identity's seats over the first T tables (0 without the scenario). */
function harnessMean(w: World, id: number, T: number): number {
  const xs = w.harness?.seen[id]!.filter(([t]) => t < T) ?? [];
  return xs.length ? xs.reduce((a, [, g]) => a + g, 0) / xs.length : 0;
}

function drawDistinct(r: () => number, weights: number[], n: number): number[] {
  const w = [...weights];
  const out: number[] = [];
  for (let i = 0; i < n && w.some((x) => x > 0); i++) {
    const k = pick(r, w);
    out.push(k);
    w[k] = 0;
  }
  return out;
}

/** One 8-seat table (the t-th, 0-based). */
function tableSeats(sc: Scenario, w: World, r: () => number, t: number): SimSeat[] {
  const K = w.truth.length;
  const strength = (id: number, c: number) => {
    const g = w.harness ? w.harness.fx[w.harness.of[c]![id]!]! : 0;
    if (w.harness) w.harness.seen[id]!.push([t, g]);
    return strengthAt(w, id, t) + g + w.contribFx[c]![id]! + (w.adversary && c === w.adversary.c && id === w.adversary.victim ? sc.adversary!.sandbag : 0);
  };
  if (w.adversary && r() < sc.adversary!.share) {
    // The adversary's Private Table: the rival and its favorite, two seats each, plus two more identities.
    const { c, victim, favored } = w.adversary;
    const others = drawDistinct(r, w.pop.map((p, k) => (k === victim || k === favored ? 0 : p)), 2);
    return [victim, victim, favored, favored, others[0]!, others[0]!, others[1]!, others[1]!].map((id) => ({ id, contributor: c, strength: strength(id, c) }));
  }
  if (r() < sc.privateShare) {
    const c = pick(r, w.activity.map((a, i) => (w.adversary && i === w.adversary.c ? 0 : a)));
    const fav = w.favorite(c);
    const ids = drawDistinct(r, w.pop.map((p, k) => (fav.includes(k) ? p * 4 : p * 0.25)), Math.min(4, K));
    const seats: SimSeat[] = [];
    for (const id of ids) for (let i = 0; i < 2; i++) seats.push({ id, contributor: c, strength: strength(id, c) });
    while (seats.length < 8) seats.push({ ...seats[seats.length % ids.length]! });
    return seats;
  }
  // Lobby table: 3–4 contributors, up to 3 seats each.
  const nC = Math.min(sc.contributors, r() < 0.5 ? 3 : 4);
  const cs = drawDistinct(r, w.activity, nC);
  const counts = nC === 3 ? [3, 3, 2] : [2, 2, 2, 2];
  const seats: SimSeat[] = [];
  cs.forEach((c, i) => {
    for (let s = 0; s < counts[i]!; s++) {
      const id = pick(r, w.pop);
      seats.push({ id, contributor: c, strength: strength(id, c) });
    }
  });
  return seats;
}

/** Rated matches and matches played, over every simulated table (a check on the pairing rule). */
const MATCH_TALLY = { matches: 0, mirrors: 0, noResult: 0 };

/**
 * Play one table: a 3-round Swiss paired by the Director's pairSwissRound (current version), best of 3. Returns its
 * rated games (self-play is unrated), as scoring.ts ratingGamesOf would: forfeited games are losses for the silent seat,
 * the finished games of a no-result match stay, only game 1 carries onPlay.
 */
function playTable(seats: SimSeat[], sc: Scenario, w: World, r: () => number, ev: string): RatingGame[] {
  const set = Math.floor(r() * 8);
  const deck = seats.map(() => gauss(r) * sc.deckSd);
  const names = seats.map((_, i) => `s${i}`);
  const pseats: PairingSeat[] = seats.map((x, i) => ({ name: names[i]!, identity: `m${x.id}`, contributor: `c${x.contributor}` }));
  const prior: RoundPairing[] = [];
  const results: MatchOutcome[] = [];
  const games: RatingGame[] = [];
  const nt = (a: number, b: number) => (w.nt && sc.nonTransitive ? sc.nonTransitive * (w.nt[a]![0] * w.nt[b]![1] - w.nt[b]![0] * w.nt[a]![1]) : 0);
  const rounds = 3;
  for (let round = 1; round <= rounds; round++) {
    const pairing = pairSwissRound(pseats, ev, round, prior, results, PAIRING_VERSION, rounds);
    prior.push(pairing);
    for (const [x, y] of pairing.pairs) {
      const i = Number(x.slice(1));
      const j = Number(y.slice(1));
      const A = seats[i]!;
      const Bs = seats[j]!;
      const mirror = A.id === Bs.id;
      MATCH_TALLY.matches++;
      if (mirror) MATCH_TALLY.mirrors++;
      let wa = 0;
      let wb = 0;
      let aPlays = r() < 0.5;
      let silentA = false;
      let silentB = false;
      let noResult = false;
      for (let g = 1; wa < 2 && wb < 2; g++) {
        if (r() < sc.noResult) {
          noResult = true; // four voids: the match ends with no result; its finished games stand
          break;
        }
        // A seat that went silent stays silent for the next game half the time (until its launcher relaunches it).
        silentA = (silentA && r() < 0.5) || r() < w.forfeitP[A.contributor]![A.id]!;
        silentB = (silentB && r() < 0.5) || r() < w.forfeitP[Bs.contributor]![Bs.id]!;
        let aWins: boolean;
        if (silentA !== silentB) aWins = silentB; // the watchdog concedes for the silent seat: a loss
        else if (silentA && silentB) aWins = r() < 0.5; // both silent: whichever the watchdog reaches first
        else {
          const e = A.strength + w.setFx[A.id]![set]! - Bs.strength - w.setFx[Bs.id]![set]! + nt(A.id, Bs.id) + (aPlays ? sc.playElo : -sc.playElo);
          aWins = r() < sigmoid(e / ELO_PER_LOGIT + deck[i]! - deck[j]!);
        }
        if (!mirror) {
          const side = aPlays ? 'a' : 'b';
          games.push({ event: ev, a: `m${A.id}`, b: `m${Bs.id}`, winner: aWins ? 'a' : 'b', ...(g === 1 ? { onPlay: side } : { onPlayChosen: side }), ca: `c${A.contributor}`, cb: `c${Bs.contributor}`, set: `S${set}` });
        }
        if (aWins) wa++;
        else wb++;
        aPlays = !aWins; // the loser chooses to play
      }
      if (noResult) MATCH_TALLY.noResult++;
      results.push({ a: x, b: y, wins: { [x]: wa, [y]: wb }, ...(noResult ? { no_result: true } : {}) });
    }
  }
  return games;
}

// ---------------------------------------------------------------------------
// Records

/** One identity in one fit. */
interface Rec {
  sc: string; sim: number; T: number; m: string; id: number;
  games: number; events: number; opps: number; contribs: number; topShare: number;
  err: number; truthC: number; covered: boolean; width: number;
  rr: [number, number] | null; trueRank: number; nRows: number; flagged: boolean; incons: boolean; zabs: number | null; provisionalC: boolean; victim: boolean;
}
/** One pair of identities in one fit (the first rated above the second). */
interface PairRec { sc: string; T: number; m: string; sepOverlap: boolean; sepDiff: boolean; correct: boolean; gap: number; diffCovered: boolean | null }
interface PowerRec { design: string; sim: number; T: number; m: string; games: number; separated: boolean; correct: boolean }

type Method = 'old' | 'new' | 'event-only' | 'new+cap' | 'new+cap30' | 'pooled';

/** Overrides of the "now" method's options (--new-options '<json>'), for trying alternatives; production defaults otherwise. */
let NEW_OPTIONS: Partial<RatingOptions> = {};
/** The pooled fit's prior SDs (--pool-sd '<json>'); production defaults otherwise. */
let POOL_SD: Partial<PoolingSd> = {};

function methodOptions(m: Method, sc: Scenario, w: World, R: number): Partial<RatingOptions> {
  const base: Partial<RatingOptions> = { replicates: R, minGames: 0, minEvents: 0, minOpponents: 0, minContributors: 0, maxContributorShare: 1 };
  // The earlier method: two-stage bootstrap, no contributor variance, no small-cluster correction.
  if (m === 'old') return { ...base, bootstrap: 'two-stage', influence: false, contributorSdElo: 0, setSdElo: 0, clusterCorrection: false };
  // The event-cluster bootstrap alone: no contributor variance, no small-cluster correction.
  if (m === 'event-only') return { ...base, ...NEW_OPTIONS, influence: false, contributorSdElo: 0, setSdElo: 0, clusterCorrection: false };
  if (m === 'new+cap') return { ...base, ...NEW_OPTIONS, influence: false, contributorCap: 0.5 };
  if (m === 'new+cap30') return { ...base, ...NEW_OPTIONS, influence: false, contributorCap: 0.3 };
  if (m === 'pooled') return { ...base, ...NEW_OPTIONS, influence: false, pooling: { of: (id) => w.structure?.[Number(id.slice(1))], sd: POOL_SD } };
  if (m === 'new') return { ...base, ...NEW_OPTIONS };
  void sc;
  return base;
}

function fitRecords(sc: Scenario, sim: number, T: number, m: Method, w: World, games: RatingGame[], R: number): { recs: Rec[]; pairs: PairRec[] } {
  const res: RatingResult = rateGames(games, { ...methodOptions(m, sc, w, R), seed: 1000 + sim * 31 + T });
  const compSize = new Map<number, number>();
  for (const r of res.rows) compSize.set(r.component, (compSize.get(r.component) ?? 0) + 1);
  const big = [...compSize].sort((a, b) => b[1] - a[1])[0]![0];
  const rows = res.rows.filter((r) => r.component === big);
  const t = (id: string) => truthAt(w, Number(id.slice(1)), T);
  const shift = mean(rows.map((r) => r.rating)) - mean(rows.map((r) => t(r.id)));
  const trueOrder = [...rows].sort((a, b) => t(b.id) - t(a.id)).map((r) => r.id);
  const victim = w.adversary ? `m${w.adversary.victim}` : null;
  const recs: Rec[] = rows.map((r) => {
    const tc = t(r.id) + shift;
    return {
      sc: sc.name, sim, T, m, id: Number(r.id.slice(1)), games: r.games, events: r.events, opps: r.opponents, contribs: r.contributors, topShare: r.topContributor?.share ?? 1,
      err: r.rating - tc, truthC: tc - mean(rows.map((x) => x.rating)), covered: r.ci != null && r.ci[0] <= tc && tc <= r.ci[1], width: r.ci ? r.ci[1] - r.ci[0] : NaN,
      rr: r.rankRange, trueRank: trueOrder.indexOf(r.id) + 1, nRows: rows.length, flagged: r.influence?.flagged ?? false, incons: r.influence?.inconsistent ?? false, zabs: r.influence?.z != null ? Math.abs(r.influence.z) : r.influence?.shift === null ? Infinity : null,
      provisionalC: r.contributors < 2 || (r.topContributor?.share ?? 1) > 0.5, victim: r.id === victim,
    };
  });
  const pd = new Map(res.pairs.map((p) => [`${p.a}|${p.b}`, p] as const));
  const pairs: PairRec[] = [];
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const a = rows[i]!;
      const b = rows[j]!;
      const p = pd.get(`${a.id}|${b.id}`) ?? pd.get(`${b.id}|${a.id}`);
      const aFirst = p ? p.a === a.id : true;
      const sepDiff = p?.ahead != null && (p.ahead === 'a') === aFirst;
      const sepOverlap = a.ci != null && b.ci != null && a.ci[0] > b.ci[1];
      const trueDiff = (t(a.id) - t(b.id)) * (aFirst ? 1 : -1);
      pairs.push({
        sc: sc.name, T, m, sepOverlap, sepDiff, correct: t(a.id) > t(b.id), gap: Math.abs(t(a.id) - t(b.id)),
        diffCovered: p?.ci && Number.isFinite(p.ci[0]) ? p.ci[0] <= trueDiff && trueDiff <= p.ci[1] : null,
      });
    }
  }
  return { recs, pairs };
}

function runScenario(sc: Scenario, sim: number, R: number): { recs: Rec[]; pairs: PairRec[]; rho: Array<{ sc: string; T: number; m: string; rho: number }> } {
  const r = rng(7919 * (sim + 1) + sc.name.length * 104729 + sc.name.charCodeAt(0));
  const w = makeWorld(sc, r);
  const tables: RatingGame[][] = [];
  for (let t = 0; t < CHECKPOINTS[CHECKPOINTS.length - 1]!; t++) tables.push(playTable(tableSeats(sc, w, r, t), sc, w, r, `e${t}`));
  const recs: Rec[] = [];
  const pairs: PairRec[] = [];
  const rho: Array<{ sc: string; T: number; m: string; rho: number }> = [];
  const methods: Method[] = ['old', 'new', 'event-only'];
  if (sc.adversary || sc.name === 'central') methods.push('new+cap', 'new+cap30');
  if (sc.hierarchy) methods.push('pooled');
  for (const T of CHECKPOINTS) {
    const games = tables.slice(0, T).flat();
    for (const m of methods) {
      const f = fitRecords(sc, sim, T, m, w, games, R);
      for (const x of f.recs) recs.push(x);
      // Pairs are compared for the two reading rules only.
      if (m === 'old' || m === 'new') for (const x of f.pairs) pairs.push(x);
      rho.push({ sc: sc.name, T, m, rho: spearman(f.recs.map((x) => x.err + x.truthC), f.recs.map((x) => x.truthC)) });
    }
  }
  return { recs, pairs, rho };
}

// ---------------------------------------------------------------------------
// Power: games needed to separate two identities 100 Elo apart

const POWER_CHECKPOINTS = [1, 2, 3, 4, 6, 8, 10, 12, 15, 18, 22, 26, 30, 36, 42, 48];
const POWER_DESIGNS = [
  { name: 'private 4×2', note: 'Private Tables of 4 identities × 2 seats; A and B at every table with two others from a field of 6; 6 contributors take turns' },
  { name: 'lobby', note: 'lobby tables; A and B one seat each at every table, six other identities from a field of 6, 3–4 contributors' },
] as const;

function runPower(design: (typeof POWER_DESIGNS)[number]['name'], sim: number, R: number): PowerRec[] {
  const r = rng(4242 + sim * 977 + design.length * 31);
  // Identities 0 (A, +50) and 1 (B, −50); a field of 6 others ~ N(0, 100). Contributor SD 30, deck SD 0.25, play 20.
  const sc: Scenario = { ...CENTRAL, identities: 8 };
  const truth = [50, -50, ...Array.from({ length: 6 }, () => gauss(r) * 100)];
  const contributors = 6;
  const contribFx = Array.from({ length: contributors }, () => truth.map(() => gauss(r) * 30));
  const w: World = {
    truth, drift: null, nt: null, forfeitP: Array.from({ length: contributors }, () => truth.map(() => (r() < sc.forfeit.flakyShare ? sc.forfeit.flaky : sc.forfeit.base))), structure: null, pop: truth.map(() => 1), activity: Array(contributors).fill(1), favorite: () => [], contribFx,
    setFx: truth.map(() => Array.from({ length: 8 }, () => gauss(r) * 30)), harness: null, adversary: null,
  };
  const tables: RatingGame[][] = [];
  for (let t = 0; t < POWER_CHECKPOINTS[POWER_CHECKPOINTS.length - 1]!; t++) {
    let seats: SimSeat[];
    if (design === 'private 4×2') {
      const c = t % contributors;
      const others = drawDistinct(r, [0, 0, 1, 1, 1, 1, 1, 1], 2);
      seats = [0, 0, 1, 1, others[0]!, others[0]!, others[1]!, others[1]!].map((id) => ({ id, contributor: c, strength: truth[id]! + contribFx[c]![id]! }));
    } else {
      const cs = drawDistinct(r, Array(contributors).fill(1), r() < 0.5 ? 3 : 4);
      const ids = shuffle(r, [0, 1, 2, 3, 4, 5, 6, 7]);
      seats = ids.map((id, i) => {
        const c = cs[i % cs.length]!;
        return { id, contributor: c, strength: truth[id]! + contribFx[c]![id]! };
      });
    }
    tables.push(playTable(seats, sc, w, r, `p${t}`));
  }
  const out: PowerRec[] = [];
  for (const T of POWER_CHECKPOINTS) {
    const games = tables.slice(0, T).flat();
    for (const m of ['old', 'new'] as const) {
      const res = rateGames(games, { ...methodOptions(m, sc, w, R), influence: false, seed: 77 + sim * 13 + T });
      const A = res.rows.find((x) => x.id === 'm0');
      const B = res.rows.find((x) => x.id === 'm1');
      if (!A || !B) continue;
      let separated: boolean;
      let correct: boolean;
      if (m === 'old') {
        separated = A.ci != null && B.ci != null && (A.ci[0] > B.ci[1] || B.ci[0] > A.ci[1]);
        correct = A.ci != null && B.ci != null && A.ci[0] > B.ci[1];
      } else {
        const p = res.pairs.find((x) => (x.a === 'm0' && x.b === 'm1') || (x.a === 'm1' && x.b === 'm0'))!;
        separated = p.ahead != null;
        correct = p.ahead != null && (p.ahead === 'a') === (p.a === 'm0');
      }
      out.push({ design, sim, T, m, games: (A.games + B.games) / 2, separated, correct });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Sharding

interface Unit { kind: 'sc' | 'power'; name: string; sim: number }

/** The scenarios a run covers: --quick's three, or MTGDT_CALIBRATE_ONLY="name|name" (shards inherit it), else all. */
function chosen(quick: boolean): Scenario[] {
  const only = process.env.MTGDT_CALIBRATE_ONLY?.split('|').map((x) => x.trim()).filter(Boolean);
  if (only?.length) return SCENARIOS.filter((s) => only.includes(s.name));
  return quick ? SCENARIOS.filter((s) => ['central', 'adversarial', 'hierarchical'].includes(s.name)) : SCENARIOS;
}

function units(sims: number, powerSims: number, quick: boolean): Unit[] {
  const out: Unit[] = [];
  const scs = chosen(quick);
  for (const sc of scs) for (let s = 0; s < sims; s++) out.push({ kind: 'sc', name: sc.name, sim: s });
  for (const d of POWER_DESIGNS) for (let s = 0; s < powerSims; s++) out.push({ kind: 'power', name: d.name, sim: s });
  return out;
}

function runShard(shard: number, shards: number, sims: number, powerSims: number, R: number, quick: boolean, file: string): void {
  const all = units(sims, powerSims, quick).filter((_, i) => i % shards === shard);
  const recs: Rec[] = [];
  const pairs: PairRec[] = [];
  const rho: Array<{ sc: string; T: number; m: string; rho: number }> = [];
  const power: PowerRec[] = [];
  for (const u of all) {
    if (u.kind === 'sc') {
      const x = runScenario(SCENARIOS.find((s) => s.name === u.name)!, u.sim, R);
      recs.push(...x.recs);
      pairs.push(...x.pairs);
      rho.push(...x.rho);
    } else power.push(...runPower(u.name as (typeof POWER_DESIGNS)[number]['name'], u.sim, R));
  }
  writeFileSync(file, JSON.stringify({ recs, pairs, rho, power, tally: MATCH_TALLY }));
}

// ---------------------------------------------------------------------------
// Analysis

const pct = (x: number) => (Number.isFinite(x) ? `${(x * 100).toFixed(0)}%` : '–');
const pct1 = (x: number) => (Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : '–');
const f0 = (x: number) => (Number.isFinite(x) ? x.toFixed(0) : '–');
const f2 = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : '–');
const rate = <T>(xs: T[], f: (x: T) => boolean) => (xs.length ? xs.filter(f).length / xs.length : NaN);
const r2 = (q: Rec[]) => 1 - mean(q.map((r) => r.err ** 2)) / mean(q.map((r) => r.truthC ** 2));
const rmse = (q: Rec[]) => Math.sqrt(mean(q.map((r) => r.err ** 2)));

/** Games per identity at which the share of correct separations first reaches `p` (linear interpolation). */
function gamesFor(curve: Array<{ games: number; rate: number }>, p: number): number {
  for (let i = 0; i < curve.length; i++) {
    if (curve[i]!.rate >= p) {
      if (i === 0) return curve[0]!.games;
      const a = curve[i - 1]!;
      const b = curve[i]!;
      return a.games + ((p - a.rate) / (b.rate - a.rate)) * (b.games - a.games);
    }
  }
  return NaN;
}

function analyze(recs: Rec[], pairs: PairRec[], rho: Array<{ sc: string; T: number; m: string; rho: number }>, power: PowerRec[], meta: Record<string, unknown>) {
  const scNames = [...new Set(recs.map((r) => r.sc))];
  const by = (sc: string, m: string) => recs.filter((r) => r.sc === sc && r.m === m);
  const coverage = scNames.map((sc) => ({
    sc,
    methods: (['old', 'new', 'event-only', 'new+cap', 'new+cap30', 'pooled'] as const).filter((m) => by(sc, m).length).map((m) => {
      const q = by(sc, m);
      return {
        m, n: q.length, coverage: rate(q, (r) => r.covered), width: mean(q.map((r) => r.width)), rmse: rmse(q),
        buckets: [[1, 9], [10, 29], [30, 59], [60, 119], [120, 1e9]].map(([lo, hi]) => {
          const b = q.filter((r) => r.games >= lo! && r.games <= hi!);
          return { games: `${lo}–${hi! >= 1e9 ? '' : hi}`, n: b.length, coverage: rate(b, (r) => r.covered), width: mean(b.map((r) => r.width)), rmse: rmse(b) };
        }),
        byEvents: [[1, 2], [3, 4], [5, 9], [10, 1e9]].map(([lo, hi]) => {
          const b = q.filter((r) => r.events >= lo! && r.events <= hi!);
          return { events: `${lo}–${hi! >= 1e9 ? '' : hi}`, n: b.length, coverage: rate(b, (r) => r.covered) };
        }),
        rankCoverage: rate(q.filter((r) => r.rr), (r) => r.rr![0] <= r.trueRank && r.trueRank <= r.rr![1]),
        // The strongest and weakest identity of each fit (the tails a prior shrinks): coverage, and the mean shrinkage
        // (error toward the middle, Elo; positive = pulled toward the average).
        extremes: (() => {
          const e = q.filter((r) => r.nRows >= 4 && (r.trueRank === 1 || r.trueRank === r.nRows));
          const mid = q.filter((r) => r.nRows >= 4 && r.trueRank !== 1 && r.trueRank !== r.nRows);
          return { n: e.length, coverage: rate(e, (r) => r.covered), shrink: mean(e.map((r) => -Math.sign(r.truthC) * r.err)), width: mean(e.map((r) => r.width)), midCoverage: rate(mid, (r) => r.covered) };
        })(),
      };
    }),
  }));
  const pairStats = scNames.map((sc) => {
    const q = (m: string) => pairs.filter((p) => p.sc === sc && p.m === m);
    const old = q('old');
    const nw = q('new');
    return {
      sc, pairs: nw.length,
      old_overlap: { separated: rate(old, (p) => p.sepOverlap), wrong: rate(old.filter((p) => p.sepOverlap), (p) => !p.correct) },
      new_overlap: { separated: rate(nw, (p) => p.sepOverlap), wrong: rate(nw.filter((p) => p.sepOverlap), (p) => !p.correct) },
      new_diff: { separated: rate(nw, (p) => p.sepDiff), wrong: rate(nw.filter((p) => p.sepDiff), (p) => !p.correct), coverage: rate(nw.filter((p) => p.diffCovered != null), (p) => !!p.diffCovered) },
      gap100: {
        old: rate(old.filter((p) => p.gap >= 75 && p.gap < 125), (p) => p.sepOverlap && p.correct),
        new: rate(nw.filter((p) => p.gap >= 75 && p.gap < 125), (p) => p.sepDiff && p.correct),
      },
    };
  });
  const powerStats = POWER_DESIGNS.map((d) => {
    const out: Record<string, unknown> = { design: d.name, note: d.note };
    for (const m of ['old', 'new'] as const) {
      const curve = POWER_CHECKPOINTS.map((T) => {
        const q = power.filter((p) => p.design === d.name && p.m === m && p.T === T);
        return { tables: T, games: mean(q.map((p) => p.games)), rate: rate(q, (p) => p.correct), wrong: rate(q, (p) => p.separated && !p.correct) };
      });
      out[m] = { curve, games50: gamesFor(curve, 0.5), games80: gamesFor(curve, 0.8), tables50: gamesFor(curve.map((c) => ({ games: c.tables, rate: c.rate })), 0.5), tables80: gamesFor(curve.map((c) => ({ games: c.tables, rate: c.rate })), 0.8) };
    }
    return out;
  });
  // Contributor floor and influence: honest vs adversarial.
  const contributorStats = scNames.map((sc) => {
    const q = by(sc, 'new').filter((r) => r.games >= 30);
    const v = q.filter((r) => r.victim);
    const vc = by(sc, 'new+cap').filter((r) => r.victim && r.games >= 30);
    return {
      zThresholds: [3, 3.5, 4, 4.5].map((zt) => ({
        z: zt,
        falsePositive: rate(q.filter((r) => !r.victim), (r) => r.zabs != null && r.zabs >= zt),
        victimByT: CHECKPOINTS.map((T) => ({ T, caught: rate(q.filter((r) => r.victim && r.T === T), (r) => r.zabs != null && r.zabs >= zt) })),
      })),
      sc, rows: q.length, floorFails: rate(q, (r) => r.provisionalC), flagged: rate(q.filter((r) => !r.victim), (r) => r.flagged), inconsistent: rate(q.filter((r) => !r.victim), (r) => r.incons),
      victimByT: CHECKPOINTS.map((T) => {
        const vt = by(sc, 'new').filter((r) => r.victim && r.T === T);
        const vtc = by(sc, 'new+cap').filter((r) => r.victim && r.T === T);
        const vt30 = by(sc, 'new+cap30').filter((r) => r.victim && r.T === T);
        return {
          T, n: vt.length, games: mean(vt.map((r) => r.games)), topShare: mean(vt.map((r) => r.topShare)), bias: mean(vt.map((r) => r.err)), biasCap: vtc.length ? mean(vtc.map((r) => r.err)) : NaN, biasCap30: vt30.length ? mean(vt30.map((r) => r.err)) : NaN,
          floorFails: rate(vt, (r) => r.provisionalC), flagged: rate(vt, (r) => r.flagged), inconsistent: rate(vt, (r) => r.incons), caught: rate(vt, (r) => r.provisionalC || r.flagged || r.incons),
        };
      }),
      flaggedByT: CHECKPOINTS.map((T) => {
        const q = by(sc, 'new').filter((r) => r.T === T && r.games >= 30 && !r.victim);
        return { T, n: q.length, flagged: rate(q, (r) => r.flagged), inconsistent: rate(q, (r) => r.incons) };
      }),
      victim: v.length ? { n: v.length, bias: mean(v.map((r) => r.err)), floorFails: rate(v, (r) => r.provisionalC), flagged: rate(v, (r) => r.flagged), inconsistent: rate(v, (r) => r.incons), caught: rate(v, (r) => r.provisionalC || r.flagged || r.incons), biasCap: vc.length ? mean(vc.map((r) => r.err)) : NaN, coverage: rate(v, (r) => r.covered), coverageCap: rate(vc, (r) => r.covered) } : null,
    };
  });
  const capStats = scNames.filter((sc) => by(sc, 'new+cap').length).map((sc) => ({
    sc, rmse: rmse(by(sc, 'new')), coverage: rate(by(sc, 'new'), (r) => r.covered), width: mean(by(sc, 'new').map((r) => r.width)),
    caps: (['new+cap', 'new+cap30'] as const).map((m) => ({ cap: m === 'new+cap' ? 0.5 : 0.3, rmse: rmse(by(sc, m)), coverage: rate(by(sc, m), (r) => r.covered), width: mean(by(sc, m).map((r) => r.width)) })),
  }));
  const poolStats = scNames.filter((sc) => by(sc, 'pooled').length).map((sc) => {
    const f = by(sc, 'new');
    const p = by(sc, 'pooled');
    const sparse = (q: Rec[]) => q.filter((r) => r.games < 30);
    return {
      sc, flat: { rmse: rmse(f), coverage: rate(f, (r) => r.covered), width: mean(f.map((r) => r.width)), sparseRmse: rmse(sparse(f)), sparseCoverage: rate(sparse(f), (r) => r.covered), r2: r2(f) },
      pooled: { rmse: rmse(p), coverage: rate(p, (r) => r.covered), width: mean(p.map((r) => r.width)), sparseRmse: rmse(sparse(p)), sparseCoverage: rate(sparse(p), (r) => r.covered), r2: r2(p) },
      sparseN: sparse(p).length,
    };
  });
  const margin = scNames.filter((sc) => !sc.startsWith('hierarchical')).map((sc) => ({
    sc,
    byG: [10, 20, 30, 40, 60].map((G) => {
      const q = by(sc, 'new').filter((r) => r.games >= G && r.games < 2 * G && r.events >= 3);
      return { G, n: q.length, r2: r2(q), rmse: rmse(q), coverage: rate(q, (r) => r.covered) };
    }),
  }));
  const rhoStats = scNames.map((sc) => ({ sc, byT: CHECKPOINTS.map((T) => ({ T, rho: mean(rho.filter((x) => x.sc === sc && x.T === T && x.m === 'new').map((x) => x.rho).filter(Number.isFinite)) })) }));
  return { ...meta, coverage, pairs: pairStats, power: powerStats, contributors: contributorStats, cap: capStats, pooling: poolStats, margin, rank_correlation: rhoStats };
}

function report(j: any): string {
  const L: string[] = [];
  L.push('# Calibration of the Rating', '');
  L.push(`Generated by \`npx tsx packages/site/src/calibrate.ts --sims ${j.sims} --power-sims ${j.power_sims} --replicates ${j.replicates}\` (${j.generated_at.slice(0, 10)}, ${f0(j.elapsed_s)} s on ${j.jobs} processes). Pure simulation with the production rating model (\`packages/site/src/rating.ts\`: Bradley–Terry, prior SD ${DEFAULT_RATING_OPTIONS.priorSdElo} Elo, play/draw term; reported interval = the wider of the bootstrap and Laplace intervals); no LLM runs. Every number is in \`calibration.json\`.`, '');
  L.push('Two methods are compared on the same simulated data:', '');
  L.push('- **Before:** two-stage bootstrap (events, then games within each drawn event); a pair is ranked only when the two individual 95% ranges don\'t overlap.');
  L.push(`- **Now:** cluster bootstrap (events with their games intact; a contributor\'s events once there are ${DEFAULT_RATING_OPTIONS.contributorClusterMin} or more contributor clusters) with the small-cluster correction, floored by the Laplace interval, which carries a contributor component (${DEFAULT_RATING_OPTIONS.contributorSdElo} Elo × √Σ share²) and a set component (${DEFAULT_RATING_OPTIONS.setSdElo} Elo × √Σ set share²); A is ranked above B when the 95% interval of the rating difference A − B excludes 0, within a connected group.`, '');

  const cen = j.coverage.find((c: any) => c.sc === 'central');
  const covOf = (sc: string, m: string) => j.coverage.find((c: any) => c.sc === sc)?.methods.find((x: any) => x.m === m);
  const pw = (d: string) => j.power.find((p: any) => p.design === d);
  const stressOf = new Map<string, string | undefined>((j.scenarios as Scenario[]).map((sc) => [sc.name, sc.stress]));
  const design = j.coverage.filter((c: any) => !stressOf.get(c.sc));
  const stress = j.coverage.filter((c: any) => stressOf.get(c.sc));
  const range = (cs: any[], m: string, f: (x: any) => number = (x) => x.coverage, fmt = pct) => {
    const v = cs.map((c: any) => c.methods.find((x: any) => x.m === m)).filter(Boolean).map(f).filter(Number.isFinite);
    return v.length ? `${fmt(Math.min(...v))}–${fmt(Math.max(...v))}` : '–';
  };
  const pairOf = (sc: string) => j.pairs.find((p: any) => p.sc === sc);
  const wrongRange = (cs: any[], k: 'old_overlap' | 'new_diff') => {
    const v = cs.map((c: any) => pairOf(c.sc)?.[k]?.wrong).filter(Number.isFinite);
    return v.length ? `${pct1(Math.min(...v))}–${pct1(Math.max(...v))}` : '–';
  };
  L.push('## Summary', '');
  L.push(`${design.length} design scenarios (the launch design and the plausible spread of conditions around it) and ${stress.length} stress tests (data that break one of the model's assumptions on purpose; marked † below).`, '');
  L.push('| | Before | Now |', '|---|---|---|');
  L.push(`| 95% interval coverage, central scenario | ${pct(covOf('central', 'old')?.coverage)} | ${pct(covOf('central', 'new')?.coverage)} |`);
  L.push(`| Coverage range, design scenarios | ${range(design, 'old')} | ${range(design, 'new')} |`);
  L.push(`| Coverage range, stress tests† | ${range(stress, 'old')} | ${range(stress, 'new')} |`);
  L.push(`| Mean interval width, central (Elo) | ${f0(covOf('central', 'old')?.width)} | ${f0(covOf('central', 'new')?.width)} |`);
  L.push(`| Mean interval width, design scenarios (Elo) | ${range(design, 'old', (x) => x.width, f0)} | ${range(design, 'new', (x) => x.width, f0)} |`);
  const pc = pairOf('central');
  L.push(`| Pairs ranked, central | ${pct(pc.old_overlap.separated)} | ${pct(pc.new_diff.separated)} |`);
  L.push(`| Ranked pairs in the wrong order, central | ${pct1(pc.old_overlap.wrong)} | ${pct1(pc.new_diff.wrong)} |`);
  L.push(`| Ranked pairs in the wrong order, design scenarios | ${wrongRange(design, 'old_overlap')} | ${wrongRange(design, 'new_diff')} |`);
  L.push(`| Ranked pairs in the wrong order, stress tests† | ${wrongRange(stress, 'old_overlap')} | ${wrongRange(stress, 'new_diff')} |`);
  for (const d of ['private 4×2', 'lobby']) {
    const p = pw(d);
    if (!p) continue;
    L.push(`| Games per identity to separate 100 Elo (${d}): 50% / 80% of the time | ${f0(p.old.games50)} / ${f0(p.old.games80)} | ${f0(p.new.games50)} / ${f0(p.new.games80)} |`);
    L.push(`| Tables for that (${d}) | ${f0(p.old.tables50)} / ${f0(p.old.tables80)} | ${f0(p.new.tables50)} / ${f0(p.new.tables80)} |`);
  }
  L.push('', `A dash means the target wasn't reached within ${POWER_CHECKPOINTS[POWER_CHECKPOINTS.length - 1]} tables.`, '');

  {
    // What the numbers decide (generated, so a rerun keeps the text and the numbers together).
    const adv = j.contributors.find((c: any) => c.sc === 'adversarial');
    const last = adv?.victimByT?.[adv.victimByT.length - 1];
    const capC = j.cap.find((c: any) => c.sc === 'central');
    const hp = j.pooling.find((p: any) => p.sc === 'hierarchical');
    const hm = j.pooling.find((p: any) => p.sc === 'hierarchical, misspecified');
    const p42 = pw('private 4×2');
    const big = (sc: string) => covOf(sc, 'new')?.buckets?.[4];
    const ext = (sc: string) => covOf(sc, 'new')?.extremes;
    L.push('## What This Decides', '');
    L.push(`- **Intervals:** event-cluster bootstrap (a contributor's events once there are ${DEFAULT_RATING_OPTIONS.contributorClusterMin}+ contributor clusters) with the small-cluster correction √(G/(G−1)), floored by the Laplace interval, plus a contributor component of ${DEFAULT_RATING_OPTIONS.contributorSdElo} Elo × √Σ share² and a set component of ${DEFAULT_RATING_OPTIONS.setSdElo} Elo × √Σ set share². Coverage ${range(design, 'new')} across the design scenarios (central ${pct(covOf('central', 'new')?.coverage)}; ratings with 120+ games ${pct(big('central')?.coverage)}), against ${pct(covOf('central', 'old')?.coverage)} and ${f0(covOf('central', 'old')?.width / covOf('central', 'new')?.width * 100 - 100)}% wider ranges before. The event bootstrap alone covers ${pct(covOf('no contributor effects', 'event-only')?.coverage)} without contributor effects but ${pct(covOf('central', 'event-only')?.coverage)} in the central scenario and ${pct(covOf('strong contributor effects', 'event-only')?.coverage)} with strong ones: that is what the two components fix.`);
    L.push(`- **Ranking:** A ahead of B only when the 95% interval of A − B excludes 0, within a connected group. In the central scenario ${pct(pc.new_diff.separated)} of pairs are ranked (against ${pct(pc.old_overlap.separated)} by non-overlap), ${pct1(pc.new_diff.wrong)} of them in the wrong order (${wrongRange(design, 'new_diff')} across the design scenarios; the close field is the worst). Two identities 100 Elo apart at 4 × 2 Private Tables are told apart half the time after about ${f0(p42?.new.games50)} games each (${f0(p42?.new.tables50)} tables), and 80% of the time after about ${f0(p42?.new.games80)} (${f0(p42?.new.tables80)} tables)${Number.isFinite(p42?.old.games50) ? `; before, half the time took about ${f0(p42.old.games50)} games` : ''} and 80% wasn't reached in ${POWER_CHECKPOINTS[POWER_CHECKPOINTS.length - 1]} tables.`);
    if (stress.length) {
      const parts = stress.map((c: any) => `${c.sc} ${pct(covOf(c.sc, 'new')?.coverage)}`);
      L.push(`- **Stress tests:** ${parts.join(', ')}. These break an assumption on purpose and are not a reason to widen every range: a spread wider than the rating prior (SD ${DEFAULT_RATING_OPTIONS.priorSdElo}) shrinks the strongest and weakest rows toward the middle (in the very wide spread by about ${f0(ext('very wide spread')?.shrink)} Elo, covered ${pct(ext('very wide spread')?.coverage)} of the time; the rows between them ${pct(ext('very wide spread')?.midCoverage)}); matchups and set effects the model has no term for widen the error without the ranges seeing it. The export's predictive check (LAUNCH-CHECKLIST F-1) is how real data would show either.`);
    }
    L.push(`- **Games floor:** 30 games stays. At G = 30 the least-sampled ratings explain ${f2(j.margin.find((m: any) => m.sc === 'central').byG.find((x: any) => x.G === 30).r2)} of the true-strength variance in the central scenario; in a close field (skill SD 50) no small sample is informative, so read the rank range.`);
    L.push(`- **Contributor floor:** a rating is provisional until 2 or more contributors supplied its games and none supplied more than half. With exactly two contributors that means an even split; in practice a firm rating needs three or more.`);
    if (last) L.push(`- **Influence check:** two flags. The 95%-range flag (as specified) fires on about ${pct(mean(j.contributors.map((c: any) => c.flagged)))} of honest rows and catches the sandbagged row ${pct(last.flagged)} of the time at 48 tables; the shift's own z (|z| ≥ ${INFLUENCE_Z}) fires on about ${pct(mean(j.contributors.map((c: any) => c.inconsistent)))} of honest rows and catches it ${pct(last.inconsistent)} of the time at 48 tables. A contributor who supplies under half of a row's games can still bias it by about ${f0(-last.bias)} Elo (the adversary here); the flags, the contributor floor and the wider intervals are the defenses, and none is complete.`);
    if (capC && last) L.push(`- **Weight cap: not used.** A 50% cap moves the sandbagged row by ${f0(Math.abs(last.biasCap - last.bias))} Elo and a 30% cap by ${f0(Math.abs(last.biasCap30 - last.bias))}, while widening every interval by ${f0((capC.caps[0].width / capC.width - 1) * 100)}% and ${f0((capC.caps[1].width / capC.width - 1) * 100)}% (more games for the same precision). An adversary keeps its share under any cap; the floor and the flags cover the case a cap was meant for.`);
    if (hp && hm) L.push(`- **Partial pooling: off by default.** With the true structure it cuts RMSE from ${f0(hp.flat.rmse)} to ${f0(hp.pooled.rmse)} Elo at ${pct(hp.pooled.coverage)} coverage; when the harness × effort interactions are larger than its prior (residual SD 80 against 60) RMSE still falls (${f0(hm.flat.rmse)} → ${f0(hm.pooled.rmse)}) but coverage drops to ${pct(hm.pooled.coverage)} (${pct(hm.pooled.sparseCoverage)} for sparse rows). At launch there is one main condition with few versions per model, so it would buy little; turn it on (MTGDT_RATING_POOLING=1) once several models have two or more harness or effort rows, after estimating its variance components from real data.`);
    L.push('');
  }

  L.push('## Generative model', '');
  L.push(`Each simulated community has K seat identities with true strengths θ ~ N(0, skill SD) and Zipf popularity, and C contributors with Zipf activity. Each contributor's seats of an identity play at θ + δ, δ ~ N(0, contributor SD), for every table they run: the contributor's harness configuration and setup. Every table seats 8 agents and plays a 3-round Swiss, best of 3, paired by the Director's own code (\`pairSwissRound\`, pairing version ${j.pairing_version ?? '?'}): round 1 random, then by match points with no rematches, a seat floated to the next record group rather than pair two seats of one identity before the last round, and the last round strictly by points; the loser of a game chooses to play first. Only game 1 of a match carries the play/draw side the fit uses (games 2–3 are the loser's choice, as in production). A Private Table is one contributor's 4 identities × 2 seats; a lobby table is 3–4 contributors with 1–3 seats each. Every seat draws a deck effect ~ N(0, deck SD) logits for the event, and each identity has a set-specific offset ~ N(0, set SD) Elo in one of 8 sets.`, '');
  L.push(`Forfeits count as losses: each contributor's setup of an identity goes silent in 0.5% of its games, or (10% of setups, flaky) 4%; a silent seat loses the game and stays silent for the match's next game half the time. Each game is lost to infrastructure with a 0.5% chance; the match then ends with no result (no match points, the pair has met) and its finished games stay rated. Ratings are fitted after ${(j.checkpoints ?? CHECKPOINTS).join(', ')} tables, over the largest connected group, and compared with the truth shifted to the same mean (in the drift scenario, each identity's mean strength over the tables fitted).`, '');
  if (j.match_tally?.matches) {
    const t = j.match_tally;
    L.push(`Pairing check, over every simulated table: ${t.matches.toLocaleString('en-US')} matches, ${pct1(t.mirrors / t.matches)} of them between two seats of one identity (unrated), ${pct1(t.noResult / t.matches)} ended with no result.`, '');
  }
  L.push('| Scenario | Note | Identities | Skill SD | Deck SD | Set SD | Contributors | Contributor SD | Private Tables |', '|---|---|---|---|---|---|---|---|---|');
  for (const sc of j.scenarios as Scenario[]) L.push(`| ${sc.name}${sc.stress ? '†' : ''} | ${sc.note} | ${sc.hierarchy ? sc.hierarchy.models * sc.hierarchy.harnesses * sc.hierarchy.efforts.length : sc.identities} | ${sc.hierarchy ? 'hierarchical' : sc.skillSd} | ${sc.deckSd} | ${sc.setSd} | ${sc.contributors} | ${sc.contribSd} | ${pct(sc.privateShare)} |`);
  L.push('', '† Stress test: ' + (j.scenarios as Scenario[]).filter((x) => x.stress).map((x) => `${x.name}, ${x.stress}`).join('; ') + '.', '');

  L.push('## Interval coverage', '');
  L.push('Share of 95% intervals that contain the (centered) true rating, mean width and RMSE, over every identity and checkpoint.', '');
  L.push('"Event bootstrap only" is the cluster bootstrap without the contributor and set components and the small-cluster correction.', '');
  L.push('| Scenario | Before: coverage | Before: width | Event bootstrap only: coverage | Now: coverage | Now: width | RMSE (Elo) | Now: 120+ games | Now: rank range contains the true rank |', '|---|---|---|---|---|---|---|---|---|');
  for (const c of j.coverage) {
    const o = c.methods.find((x: any) => x.m === 'old');
    const e = c.methods.find((x: any) => x.m === 'event-only');
    const n = c.methods.find((x: any) => x.m === 'new');
    L.push(`| ${c.sc}${stressOf.get(c.sc) ? '†' : ''} | ${pct(o?.coverage)} | ${f0(o?.width)} | ${pct(e?.coverage)} | ${pct(n?.coverage)} | ${f0(n?.width)} | ${f0(n?.rmse)} | ${pct(n?.buckets?.[4]?.coverage)} | ${pct(n?.rankCoverage)} |`);
  }
  L.push('', '**By sample size (now, central scenario).**', '');
  L.push('| Rated games | Ratings | Coverage | Width | RMSE |', '|---|---|---|---|---|');
  for (const b of cen.methods.find((x: any) => x.m === 'new').buckets) if (b.n) L.push(`| ${b.games} | ${b.n} | ${pct(b.coverage)} | ${f0(b.width)} | ${f0(b.rmse)} |`);
  L.push('', '| Events | Ratings | Coverage (now) | Coverage (before) |', '|---|---|---|---|');
  const ob = cen.methods.find((x: any) => x.m === 'old').byEvents;
  cen.methods.find((x: any) => x.m === 'new').byEvents.forEach((b: any, i: number) => { if (b.n) L.push(`| ${b.events} | ${b.n} | ${pct(b.coverage)} | ${pct(ob[i]?.coverage)} |`); });
  L.push('', '**The strongest and weakest rows** (now): in each fit with 4 or more rows, the identity with the highest and the lowest true rating. Shrinkage is the mean error toward the middle (Elo; positive = pulled toward the average), which the prior causes and no interval accounts for.', '');
  L.push('| Scenario | Rows | Coverage | Other rows: coverage | Shrinkage (Elo) | Width |', '|---|---|---|---|---|---|');
  for (const c of j.coverage) {
    const x = c.methods.find((m: any) => m.m === 'new')?.extremes;
    if (x?.n) L.push(`| ${c.sc}${stressOf.get(c.sc) ? '†' : ''} | ${x.n} | ${pct(x.coverage)} | ${pct(x.midCoverage)} | ${f0(x.shrink)} | ${f0(x.width)} |`);
  }
  L.push('');

  L.push('## Ranking pairs', '');
  L.push('For every pair of identities in a fit: the share ranked (separated), and among those, the share in the wrong order. "Difference covers" is how often the 95% interval of the difference contains the true difference.', '');
  L.push('| Scenario | Pairs | Before: ranked | Before: wrong | Now: ranked | Now: wrong | Difference covers | 100 Elo apart, ranked correctly: before / now |', '|---|---|---|---|---|---|---|---|');
  for (const p of j.pairs) L.push(`| ${p.sc}${(j.scenarios as Scenario[]).find((x) => x.name === p.sc)?.stress ? '†' : ''} | ${p.pairs} | ${pct(p.old_overlap.separated)} | ${pct1(p.old_overlap.wrong)} | ${pct(p.new_diff.separated)} | ${pct1(p.new_diff.wrong)} | ${pct(p.new_diff.coverage)} | ${pct(p.gap100.old)} / ${pct(p.gap100.new)} |`);
  L.push('');

  L.push('## Games needed to separate 100 Elo', '');
  L.push('Two identities A and B with true ratings 100 Elo apart, in a field of six others (skill SD 100), 6 contributors (contributor SD 30), deck SD 0.25. The share of simulations in which A is ranked above B, by tables played (games are per identity).', '');
  for (const p of j.power) {
    L.push(`**${p.design}:** ${p.note}.`, '');
    L.push('| Tables | Games per identity | Before: ranked correctly | Now: ranked correctly | Now: wrong order |', '|---|---|---|---|---|');
    p.new.curve.forEach((c: any, i: number) => L.push(`| ${c.tables} | ${f0(c.games)} | ${pct(p.old.curve[i].rate)} | ${pct(c.rate)} | ${pct1(c.wrong)} |`));
    L.push('');
  }

  L.push('## Contributors', '');
  L.push(`Rows with at least 30 games (now). "Floor fails": fewer than 2 contributors, or one above half of its games (the row stays provisional). "Range flag": leaving one contributor out moves the rating outside its 95% range. "Inconsistent": the shift without one contributor is at least ${INFLUENCE_Z} of its own standard errors (|z| ≥ ${INFLUENCE_Z}). Both flags are counted on honest rows (the sandbagged row excluded), so they are false-alarm rates.`, '');
  L.push('| Scenario | Rows | Floor fails | Range flag | Inconsistent |', '|---|---|---|---|---|');
  for (const c of j.contributors) L.push(`| ${c.sc} | ${c.rows} | ${pct(c.floorFails)} | ${pct(c.flagged)} | ${pct(c.inconsistent)} |`);
  const adv = j.contributors.find((c: any) => c.sc === 'adversarial');
  if (adv?.victimByT) {
    L.push('', '**The sandbagged row** (adversarial scenario: one contributor runs 30% of tables and seats the most popular identity 150 Elo below its strength):', '');
    L.push('| Tables | Its games | Adversary\'s share | Bias (Elo) | Floor fails | Range flag | Inconsistent | Caught by any | Bias with a 50% cap | with a 30% cap |', '|---|---|---|---|---|---|---|---|---|---|');
    for (const t of adv.victimByT) L.push(`| ${t.T} | ${f0(t.games)} | ${pct(t.topShare)} | ${f0(t.bias)} | ${pct(t.floorFails)} | ${pct(t.flagged)} | ${pct(t.inconsistent)} | ${pct(t.caught)} | ${f0(t.biasCap)} | ${f0(t.biasCap30)} |`);
    L.push('', '**Choosing the |z| threshold:** false alarms on honest rows (all scenarios pooled) and how often the sandbagged row is caught, by tables played.', '');
    L.push(`| |z| ≥ | False alarms | ${CHECKPOINTS.map((T) => `Caught at ${T} tables`).join(' | ')} |`, `|---|---|${CHECKPOINTS.map(() => '---').join('|')}|`);
    const honest = j.contributors.filter((c: any) => c.zThresholds);
    for (const [i, zt] of adv.zThresholds.entries()) {
      const fp = mean(honest.map((c: any) => c.zThresholds[i].falsePositive));
      L.push(`| ${zt.z} | ${pct1(fp)} | ${zt.victimByT.map((v: any) => pct(v.caught)).join(' | ')} |`);
    }
  }
  L.push('', '**Weight caps**, all rows (central and adversarial scenarios):', '');
  L.push('| Scenario | RMSE | Coverage | Width | 50% cap: RMSE | coverage | width | 30% cap: RMSE | coverage | width |', '|---|---|---|---|---|---|---|---|---|---|');
  for (const c of j.cap) L.push(`| ${c.sc} | ${f0(c.rmse)} | ${pct(c.coverage)} | ${f0(c.width)} | ${c.caps.map((x: any) => `${f0(x.rmse)} | ${pct(x.coverage)} | ${f0(x.width)}`).join(' | ')} |`);
  L.push('');

  L.push('## Partial pooling (experimental)', '');
  const psd = { ...DEFAULT_POOLING_SD, ...(j.pool_sd ?? {}) };
  L.push(`θ = μ(model) + γ(harness) + ε(model, effort) + u(identity) with prior SDs ${psd.model} / ${psd.harness} / ${psd.effort} (${psd.unknownEffort} for Unknown Effort) / ${psd.residual} Elo, against one free rating per identity (prior SD ${DEFAULT_RATING_OPTIONS.priorSdElo}). Sparse = fewer than 30 games. The misspecified scenario's true residual SD (80) is wider than the prior.`, '');
  L.push('| Scenario | Flat: RMSE | Pooled: RMSE | Flat: coverage | Pooled: coverage | Flat: width | Pooled: width | Sparse rows | Sparse: flat RMSE | Sparse: pooled RMSE | Sparse: flat coverage | Sparse: pooled coverage |', '|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const p of j.pooling) L.push(`| ${p.sc} | ${f0(p.flat.rmse)} | ${f0(p.pooled.rmse)} | ${pct(p.flat.coverage)} | ${pct(p.pooled.coverage)} | ${f0(p.flat.width)} | ${f0(p.pooled.width)} | ${p.sparseN} | ${f0(p.flat.sparseRmse)} | ${f0(p.pooled.sparseRmse)} | ${pct(p.flat.sparseCoverage)} | ${pct(p.pooled.sparseCoverage)} |`);
  L.push('');

  L.push('## Games floor', '');
  L.push('Among the least-sampled ratings a floor admits (G ≤ games < 2G, at least 3 events): R² (share of true-strength variance explained), RMSE and coverage (now).', '');
  L.push(`| Scenario | ${[10, 20, 30, 40, 60].map((G) => `G = ${G}`).join(' | ')} |`, `|---|${[10, 20, 30, 40, 60].map(() => '---').join('|')}|`);
  for (const m of j.margin) L.push(`| ${m.sc} | ${m.byG.map((x: any) => (x.n >= 30 ? `${f2(x.r2)} (±${f0(x.rmse)}, ${pct(x.coverage)})` : '–')).join(' | ')} |`);
  L.push('', 'Cells: R² (RMSE, coverage); – = fewer than 30 ratings.', '');

  L.push('## Rank correlation', '');
  L.push(`| Scenario | ${CHECKPOINTS.map((T) => `${T} tables`).join(' | ')} |`, `|---|${CHECKPOINTS.map(() => '---').join('|')}|`);
  for (const r of j.rank_correlation) L.push(`| ${r.sc} | ${r.byT.map((x: any) => f2(x.rho)).join(' | ')} |`);
  L.push('');
  if (j.findings) {
    L.push('## Findings', '');
    for (const f of j.findings as string[]) L.push(`- ${f}`);
    L.push('');
  }
  return L.join('\n') + '\n';
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { values: args } = parseArgs({
    options: {
      sims: { type: 'string', default: '60' },
      'power-sims': { type: 'string', default: '200' },
      replicates: { type: 'string', default: '200' },
      jobs: { type: 'string', default: '8' },
      out: { type: 'string', default: join(repoRoot, 'analysis', 'results') },
      quick: { type: 'boolean', default: false },
      shard: { type: 'string' },
      shards: { type: 'string' },
      file: { type: 'string' },
      'new-options': { type: 'string', default: '{}' },
      'pool-sd': { type: 'string', default: '{}' },
    },
  });
  NEW_OPTIONS = JSON.parse(args['new-options']!) as Partial<RatingOptions>;
  POOL_SD = JSON.parse(args['pool-sd']!) as Partial<PoolingSd>;
  const sims = Number(args.sims);
  const powerSims = Number(args['power-sims']);
  const R = Number(args.replicates);
  if (args.shard != null) {
    runShard(Number(args.shard), Number(args.shards), sims, powerSims, R, !!args.quick, args.file!);
    return;
  }
  const jobs = Math.max(1, Number(args.jobs));
  const out = resolve(args.out!);
  mkdirSync(out, { recursive: true });
  const t0 = Date.now();
  const dir = join(tmpdir(), `mtgdt-calibrate-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  const self = fileURLToPath(import.meta.url);
  await Promise.all(Array.from({ length: jobs }, (_, i) => new Promise<void>((ok, fail) => {
    const p = spawn(process.execPath, [...process.execArgv, self, '--shard', String(i), '--shards', String(jobs), '--sims', String(sims), '--power-sims', String(powerSims), '--replicates', String(R), '--file', join(dir, `${i}.json`), '--new-options', args['new-options']!, '--pool-sd', args['pool-sd']!, ...(args.quick ? ['--quick'] : [])], { stdio: 'inherit' });
    p.on('exit', (code) => (code === 0 ? (console.log(`shard ${i} done (${((Date.now() - t0) / 1000).toFixed(0)} s)`), ok()) : fail(new Error(`shard ${i} exited ${code}`))));
  })));
  const recs: Rec[] = [];
  const pairs: PairRec[] = [];
  const rho: Array<{ sc: string; T: number; m: string; rho: number }> = [];
  const power: PowerRec[] = [];
  const tally = { matches: 0, mirrors: 0, noResult: 0 };
  for (let i = 0; i < jobs; i++) {
    const x = JSON.parse(readFileSync(join(dir, `${i}.json`), 'utf8'));
    for (const k of ['matches', 'mirrors', 'noResult'] as const) tally[k] += x.tally[k];
    for (const r of x.recs) recs.push(r);
    for (const r of x.pairs) pairs.push(r);
    for (const r of x.rho) rho.push(r);
    for (const r of x.power) power.push(r);
  }
  rmSync(dir, { recursive: true, force: true });
  const json = analyze(recs, pairs, rho, power, {
    generated_at: new Date().toISOString(), generator: 'packages/site/src/calibrate.ts', sims, power_sims: powerSims, replicates: R, jobs, new_options: NEW_OPTIONS, pool_sd: POOL_SD,
    checkpoints: CHECKPOINTS, power_checkpoints: POWER_CHECKPOINTS, pairing_version: PAIRING_VERSION, match_tally: tally,
    scenarios: chosen(!!args.quick),
  }) as Record<string, any>;
  json.elapsed_s = (Date.now() - t0) / 1000;
  const findingsPath = join(out, 'calibration-findings.json');
  if (existsSync(findingsPath)) json.findings = JSON.parse(readFileSync(findingsPath, 'utf8'));
  writeFileSync(join(out, 'calibration.json'), JSON.stringify(json, null, 1));
  writeFileSync(join(out, 'calibration.md'), report(json));
  console.log(`wrote ${join(out, 'calibration.md')} (${json.elapsed_s.toFixed(0)} s)`);
}

void main();
