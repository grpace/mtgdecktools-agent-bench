/**
 * Headline rating: Bradley–Terry on game outcomes, Elo scale, with uncertainty from a cluster bootstrap (events, or a
 * contributor's events once a scope has enough contributors). Dependency-free; see docs/METHODOLOGY.md §4 and §6.
 *
 *   P(a beats b) = σ(θ_a − θ_b + h·s + β·x)
 *
 * - θ: one strength per seat identity (harness + model + effort), natural log-odds units internally, reported as Elo
 *   (1500 + 400/ln 10 · θ), centered so the unweighted mean of the identities in each connected group is 1500.
 * - h: play/draw advantage (s = +1 when a was on the play, −1 when b was, 0 when unknown). Fitted only when at least
 *   one game records who was on the play.
 * - β: optional per-game covariate x (deck strength of a minus deck strength of b, in logits). Fitted only when every
 *   game carries x. Experimental; never used for the headline.
 * - Gaussian priors (a ridge penalty) keep the estimate finite when a seat wins or loses every game, and shrink small
 *   samples toward the field average.
 * - Optional partial pooling (`pooling`, off by default): θ = μ(model) + γ(harness) + ε(model, effort) + u(identity),
 *   each term with its own prior, so a sparse row shrinks toward its own model rather than toward the field.
 *
 * Reading rules:
 * - A identity is ahead of B when the 95% interval of θ_A − θ_B excludes 0 (the wider of the bootstrap interval of
 *   the difference and the Laplace interval from the posterior covariance). Rank ranges count those decisions within
 *   a connected group only: identities that never connect through games are never ranked against each other.
 * - A rating is provisional below the games / events / opponents floors, and until at least two contributors have
 *   supplied its games with none above half of them.
 * - Leave-one-contributor-out: each contributor's games are removed in turn and the scope refitted; a row whose rating
 *   would leave its own 95% range is flagged.
 *
 * The fit is MAP by Newton–Raphson (the log posterior is strictly concave). Everything is deterministic for a given
 * seed, so the export doesn't change between runs on the same logs.
 */

export const ELO_PER_LOGIT = 400 / Math.LN10; // ≈ 173.7
export const ELO_CENTER = 1500;

export interface RatingGame {
  /** Replication unit (event id). */
  event: string;
  a: string;
  b: string;
  winner: 'a' | 'b';
  /**
   * Who was on the play, when it was random: game 1 of a match (the event seed decides). The play term is fitted on
   * these games only (METHODOLOGY §4 "Play or draw"); games 2–3, where the previous game's loser chose, carry
   * onPlayChosen instead and enter the fit without a play term.
   */
  onPlay?: 'a' | 'b';
  /** Games 2–3: who was on the play by the chooser's decision (not random, so not used to estimate the play advantage). */
  onPlayChosen?: 'a' | 'b';
  /** Optional covariate for a minus b (e.g. deck strength difference, logits). */
  x?: number;
  /** Contributor who seated side a / side b (scoring.ts contributorOf). Undefined: not known. */
  ca?: string;
  cb?: string;
  /** The event's set (for the set variance component). Undefined: not known (adds nothing). */
  set?: string;
}

/** Prior SDs (Elo) of the partially pooled terms. */
export interface PoolingSd { model: number; harness: number; effort: number; unknownEffort: number; residual: number }
export const DEFAULT_POOLING_SD: PoolingSd = { model: 200, harness: 50, effort: 40, unknownEffort: 80, residual: 60 };

/** Partial pooling: what each identity is made of. An identity `of` returns nothing for gets one term with the flat prior. */
export interface PoolingSpec {
  of: (id: string) => { model: string; harness: string; effort: string } | undefined;
  sd?: Partial<PoolingSd>;
}

/**
 * How the bootstrap resamples. `cluster`: whole clusters with their games intact (an event, or a contributor's
 * events once there are `contributorClusterMin` of them). `two-stage`: events, then games within each drawn event
 * (the earlier method; about 1.3× too wide, kept for the calibration's before/after comparison).
 */
export type BootstrapKind = 'cluster' | 'two-stage';

export interface RatingOptions {
  /** Prior SD of each identity's rating, Elo points. */
  priorSdElo: number;
  /** Prior SD of the play/draw advantage, Elo points. */
  playPriorSdElo: number;
  /** Prior SD of the covariate coefficient. */
  covPriorSd: number;
  /** Bootstrap replicates (0 disables intervals, rank ranges and the influence flag's range test). */
  replicates: number;
  /** Central interval width. */
  ci: number;
  seed: number;
  /** Below any of these, a row is provisional. */
  minGames: number;
  minEvents: number;
  minOpponents: number;
  /** Distinct contributors whose seats supplied the identity's games. */
  minContributors: number;
  /** Largest share of an identity's games one contributor may supply. */
  maxContributorShare: number;
  bootstrap: BootstrapKind;
  /** Resample contributors' events as clusters once a scope has at least this many contributor clusters. */
  contributorClusterMin: number;
  /**
   * Per-contributor weight cap: when one contributor supplies more than this share of an identity's games (and at
   * least one other contributor supplied some), its games on that identity are down-weighted to this share. null: off.
   */
  contributorCap: number | null;
  /** Leave-one-contributor-out refits (needs contributors on the games). */
  influence: boolean;
  /**
   * SD (Elo) of a contributor's effect on an identity (their harness configuration and setup). Adds τ²·Σ share² to the
   * Laplace variance of each rating (and τ²·(H_a + H_b) to a difference), so a rating carried by few contributors
   * is less certain than its games alone suggest. 0: off.
   */
  contributorSdElo: number;
  /**
   * SD (Elo) of an identity's set-specific effect (a model may know one set's cards or archetypes better than
   * another's). Adds τ_s²·Σ set share² to the Laplace variance of each rating (and to a difference, both rows' terms):
   * a rating from one set says less about the identity's strength across sets than its games alone suggest, and the
   * event bootstrap can't see it (events of one set share the effect). Only games with a `set` count, and only in a
   * scope of two or more sets (a set board rates strength in its set). 0: off.
   */
  setSdElo: number;
  /** Scale bootstrap deviations by √(G/(G−1)) for G clusters (the small-sample correction of a cluster variance). */
  clusterCorrection: boolean;
  /** Experimental partial pooling (null: one free rating per identity). */
  pooling: PoolingSpec | null;
}

export const DEFAULT_RATING_OPTIONS: RatingOptions = {
  priorSdElo: 200,
  playPriorSdElo: 50,
  covPriorSd: 2,
  replicates: 1000,
  ci: 0.95,
  seed: 20261021,
  minGames: 30,
  minEvents: 3,
  minOpponents: 2,
  minContributors: 2,
  maxContributorShare: 0.5,
  bootstrap: 'cluster',
  contributorClusterMin: 5,
  contributorCap: null,
  influence: true,
  contributorSdElo: 30,
  setSdElo: 30,
  clusterCorrection: true,
  pooling: null,
};

/** Where DEFAULT_RATING_OPTIONS' thresholds come from (exported in index.json → methodology.calibration). */
export const CALIBRATION = {
  doc: 'analysis/results/calibration.md',
  date: '2026-10-23',
  summary:
    'Simulated 8-seat, 3-round Swiss best-of-3 tables (Private Tables and lobby mixes; the Director\'s pairing version 3, the play term on game 1, forfeits as losses, no-result matches) with contributor and set effects, fitted with the production model (17 scenarios x 200 communities, 4 of them stress tests). '
    + 'The event-cluster bootstrap with the small-cluster correction, the Laplace floor, a 30 Elo contributor component and a 30 Elo set component covers 94-97% across the design scenarios (96% central); stress tests that break the model\'s assumptions cover 83-92%. '
    + 'Ranking from the interval of each difference ranks 28% of pairs (13% by non-overlapping ranges), 1.1% of them in the wrong order (0.7-3.6% across the design scenarios). '
    + 'Two identities 100 Elo apart at 4x2 Private Tables are told apart half the time after about 180 games each and 80% after about 570 (before: about 500 for half the time). '
    + 'The 30-game floor stands; the contributor floor (2 or more contributors, none above half of the games) keeps one contributor from making a rating firm; weight caps were tested and not used.',
};

export interface PairDiff {
  a: string;
  b: string;
  /** θ_a − θ_b, Elo. */
  diff: number;
  /** 95% interval of the difference (wider of bootstrap and Laplace); null without a bootstrap. */
  ci: [number, number] | null;
  /** Which side is credibly ahead (the interval excludes 0), else null. */
  ahead: 'a' | 'b' | null;
}

export interface Influence {
  /** The contributor whose removal moves this row the most (or removes all its games). */
  contributor: string;
  /** Rating change without that contributor's games, Elo (relative to the identities still rated). Null: no games left. */
  shift: number | null;
  /** Without that contributor the rating would leave its 95% range (or has no games left). */
  flagged: boolean;
  /** The largest |shift / SE of the shift| over contributors, and whose (null without a covariance). */
  z: number | null;
  zContributor: string | null;
  /** |z| ≥ INFLUENCE_Z, or no games left without one contributor: its results disagree with the rest of the data. */
  inconsistent?: boolean;
}

/**
 * |z| at which a contributor's games are called inconsistent with the rest. Calibrated (analysis/results/calibration.md,
 * "Contributors"): about 3% of honest rows with 30+ games cross 3.5, the same rate as the 95%-range flag.
 */
export const INFLUENCE_Z = 3.5;

export interface RatingRow {
  id: string;
  /** Elo-scale point estimate (MAP), centered on its connected group. */
  rating: number;
  /**
   * Reported interval, Elo: the wider of the bootstrap percentile interval and the Laplace (posterior) interval
   * rating ± z·se. The bootstrap captures event-to-event variation; the Laplace interval keeps tiny or one-sided
   * samples (e.g. a single 3–0 match, where every resample is identical) from looking certain. Null when bootstrapping is off.
   */
  ci: [number, number] | null;
  /** Bootstrap percentile interval alone. */
  ciBoot: [number, number] | null;
  /** Laplace (curvature) standard error of the rating relative to its component's mean, Elo. */
  se: number;
  rank: number;
  /** Best and worst rank (within its connected group) seen in the central share of bootstrap replicates. */
  rankCi: [number, number] | null;
  /**
   * Rank range from difference intervals within its connected group: best = 1 + identities credibly ahead of it,
   * worst = N − identities credibly behind it. Null without a bootstrap.
   */
  rankRange: [number, number] | null;
  games: number;
  wins: number;
  losses: number;
  events: number;
  opponents: number;
  /** Distinct contributors whose seats of this identity played its games. */
  contributors: number;
  /** The contributor who supplied most of its games and that share (0–1). */
  topContributor: { id: string; share: number } | null;
  /** Leave-one-contributor-out check (null with fewer than two contributors in scope). */
  influence: Influence | null;
  /** Connected component of the "has played" graph; ratings in different components share no games. */
  component: number;
  provisional: boolean;
  provisionalReasons: string[];
  /** Share of bootstrap replicates in which this identity had at least one game. */
  bootCoverage: number | null;
}

export interface RatingResult {
  rows: RatingRow[];
  games: number;
  events: number;
  components: number;
  playAdvantage: { elo: number; ci: [number, number] | null; games: number } | null;
  covariate: { coef: number; ci: [number, number] | null } | null;
  replicates: number;
  /** What the bootstrap resampled: events, or contributors' events. */
  bootstrapUnit: 'event' | 'contributor' | 'two-stage';
  /** Clusters the bootstrap resampled. */
  clusters: number;
  /** Every pair within a connected component, with the interval of its difference. */
  pairs: PairDiff[];
  /** Partial pooling only: the fitted model, harness and model-effort terms (Elo, with Laplace SE). */
  pooled: PooledTerms | null;
}

export interface PooledTerms {
  model: Array<{ id: string; elo: number; se: number }>;
  harness: Array<{ id: string; elo: number; se: number }>;
  effort: Array<{ id: string; elo: number; se: number }>;
}

// ---------------------------------------------------------------------------
// Deterministic PRNG (mulberry32)

export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A 32-bit seed from a string (FNV-1a): seeds that don't depend on the order boards are built in. */
export function seedOf(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// ---------------------------------------------------------------------------
// Linear algebra: Cholesky solve for the (SPD) negative Hessian

function cholesky(A: Float64Array, n: number): Float64Array | null {
  const L = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = A[i * n + j]!;
      for (let k = 0; k < j; k++) s -= L[i * n + k]! * L[j * n + k]!;
      if (i === j) {
        if (s <= 0) return null;
        L[i * n + i] = Math.sqrt(s);
      } else {
        L[i * n + j] = s / L[j * n + j]!;
      }
    }
  }
  return L;
}

function cholSolve(L: Float64Array, n: number, b: Float64Array): Float64Array {
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = b[i]!;
    for (let k = 0; k < i; k++) s -= L[i * n + k]! * y[k]!;
    y[i] = s / L[i * n + i]!;
  }
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let s = y[i]!;
    for (let k = i + 1; k < n; k++) s -= L[k * n + i]! * x[k]!;
    x[i] = s / L[i * n + i]!;
  }
  return x;
}

/** Columns of A⁻¹ (the posterior covariance) from its Cholesky factor. */
function inverse(L: Float64Array, n: number): Float64Array[] {
  const cols: Float64Array[] = [];
  const e = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    e.fill(0);
    e[i] = 1;
    cols.push(cholSolve(L, n, e));
  }
  return cols;
}

// ---------------------------------------------------------------------------
// Design: identities → parameter columns, games → sparse rows

interface Design {
  ids: string[];
  n: number;
  /** Parameters: identity terms (or pooled terms), then h, then β. */
  dim: number;
  names: string[];
  tau2: Float64Array;
  /** Parameter columns of each identity (θ_k = Σ p[c]). */
  idCols: Int32Array[];
  iH: number;
  iB: number;
  ga: Int32Array;
  gb: Int32Array;
  rowC: Int32Array[];
  rowV: Float64Array[];
  y: Float64Array;
  usePlay: boolean;
  useCov: boolean;
}

function design(games: RatingGame[], ids: string[], opts: RatingOptions): Design {
  const idx = new Map(ids.map((id, i) => [id, i] as const));
  const names: string[] = [];
  const tau: number[] = [];
  const col = new Map<string, number>();
  const param = (name: string, sdElo: number): number => {
    let c = col.get(name);
    if (c == null) {
      c = names.length;
      col.set(name, c);
      names.push(name);
      tau.push((sdElo / ELO_PER_LOGIT) ** 2);
    }
    return c;
  };
  const sd = { ...DEFAULT_POOLING_SD, ...opts.pooling?.sd };
  const idCols = ids.map((id) => {
    const s = opts.pooling?.of(id);
    if (!s) return Int32Array.of(param(`id:${id}`, opts.priorSdElo));
    return Int32Array.of(
      param(`model:${s.model}`, sd.model),
      param(`harness:${s.harness}`, sd.harness),
      param(`effort:${s.model}|${s.effort}`, s.effort === 'unknown' ? sd.unknownEffort : sd.effort),
      param(`id:${id}`, sd.residual),
    );
  });
  const usePlay = games.some((g) => g.onPlay != null);
  const useCov = games.length > 0 && games.every((g) => typeof g.x === 'number' && Number.isFinite(g.x));
  const iH = usePlay ? names.length : -1;
  if (usePlay) {
    names.push('play');
    tau.push((opts.playPriorSdElo / ELO_PER_LOGIT) ** 2);
  }
  const iB = useCov ? names.length : -1;
  if (useCov) {
    names.push('cov');
    tau.push(opts.covPriorSd ** 2);
  }
  const n = games.length;
  const d: Design = {
    ids, n: ids.length, dim: names.length, names, tau2: Float64Array.from(tau), idCols, iH, iB,
    ga: new Int32Array(n), gb: new Int32Array(n), rowC: [], rowV: [], y: new Float64Array(n), usePlay, useCov,
  };
  games.forEach((g, i) => {
    const a = idx.get(g.a)!;
    const b = idx.get(g.b)!;
    d.ga[i] = a;
    d.gb[i] = b;
    d.y[i] = g.winner === 'a' ? 1 : 0;
    const row = new Map<number, number>();
    for (const c of idCols[a]!) row.set(c, (row.get(c) ?? 0) + 1);
    for (const c of idCols[b]!) row.set(c, (row.get(c) ?? 0) - 1);
    const s = g.onPlay === 'a' ? 1 : g.onPlay === 'b' ? -1 : 0;
    if (iH >= 0 && s) row.set(iH, s);
    if (iB >= 0 && g.x) row.set(iB, g.x);
    const entries = [...row].filter(([, v]) => v !== 0);
    d.rowC.push(Int32Array.from(entries.map(([c]) => c)));
    d.rowV.push(Float64Array.from(entries.map(([, v]) => v)));
  });
  return d;
}

interface Fit { p: Float64Array; theta: Float64Array; L: Float64Array | null }

function thetaOf(d: Design, p: Float64Array): Float64Array {
  const t = new Float64Array(d.n);
  for (let k = 0; k < d.n; k++) for (const c of d.idCols[k]!) t[k] = t[k]! + p[c]!;
  return t;
}

function fitMap(d: Design, w: Float64Array, warm?: Fit): Fit {
  const dim = d.dim;
  const p = new Float64Array(dim);
  if (warm) p.set(warm.p);
  const g = new Float64Array(dim);
  const H = new Float64Array(dim * dim);
  let L: Float64Array | null = null;
  for (let iter = 0; iter < 100; iter++) {
    for (let k = 0; k < dim; k++) g[k] = -p[k]! / d.tau2[k]!;
    H.fill(0);
    for (let k = 0; k < dim; k++) H[k * dim + k] = 1 / d.tau2[k]!;
    for (let t = 0; t < d.y.length; t++) {
      const wt = w[t]!;
      if (!wt) continue;
      const cs = d.rowC[t]!;
      const vs = d.rowV[t]!;
      let eta = 0;
      for (let i = 0; i < cs.length; i++) eta += p[cs[i]!]! * vs[i]!;
      const pr = 1 / (1 + Math.exp(-eta));
      const r = wt * (d.y[t]! - pr);
      const v = wt * pr * (1 - pr);
      for (let i = 0; i < cs.length; i++) {
        const ci = cs[i]!;
        g[ci] = g[ci]! + r * vs[i]!;
        for (let j = 0; j < cs.length; j++) H[ci * dim + cs[j]!] = H[ci * dim + cs[j]!]! + v * vs[i]! * vs[j]!;
      }
    }
    L = cholesky(H, dim);
    if (!L) break; // cannot happen with positive priors; guard anyway
    const step = cholSolve(L, dim, g);
    let maxStep = 0;
    for (let k = 0; k < dim; k++) {
      p[k] = p[k]! + step[k]!;
      maxStep = Math.max(maxStep, Math.abs(step[k]!));
    }
    if (maxStep < 1e-9) break;
  }
  return { p, theta: thetaOf(d, p), L };
}

// ---------------------------------------------------------------------------
// Helpers

export function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

function components(ids: string[], games: RatingGame[]): Map<string, number> {
  const parent = new Map(ids.map((id) => [id, id] as const));
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    parent.set(x, r);
    return r;
  };
  for (const g of games) parent.set(find(g.a), find(g.b));
  const roots = new Map<string, number>();
  const out = new Map<string, number>();
  for (const id of ids) {
    const r = find(id);
    if (!roots.has(r)) roots.set(r, roots.size);
    out.set(id, roots.get(r)!);
  }
  return out;
}

const elo = (theta: number): number => ELO_CENTER + theta * ELO_PER_LOGIT;

/** The wider of a bootstrap interval and the Laplace interval est ± z·se (null when there is no bootstrap). */
function envelope(est: number, se: number, boot: [number, number] | null, z: number): [number, number] | null {
  if (!boot) return null;
  if (!Number.isFinite(se)) return boot;
  return [Math.min(boot[0], est - z * se), Math.max(boot[1], est + z * se)];
}

/** Standard normal quantile (Acklam's rational approximation; |error| < 1.2e-9). */
export function normalQuantile(p: number): number {
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  if (p < pl) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  }
  if (p > 1 - pl) return -normalQuantile(1 - p);
  const q = p - 0.5;
  const r = q * q;
  return ((((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q) / (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1);
}

/** Contributor of a side ('unattributed' when the log doesn't say). */
const side = (c: string | undefined): string => c ?? 'unattributed';

/**
 * Per-game weights from the per-contributor cap: a contributor above `cap` of an identity's games (with at least one
 * other contributor present) has its games on that identity scaled so its weighted share is `cap`. A game's weight is
 * the smaller of its two sides' factors.
 */
export function contributorCapWeights(games: RatingGame[], cap: number): Float64Array {
  const per = new Map<string, Map<string, number>>();
  const add = (id: string, c: string) => {
    const m = per.get(id) ?? new Map<string, number>();
    m.set(c, (m.get(c) ?? 0) + 1);
    per.set(id, m);
  };
  for (const g of games) {
    add(g.a, side(g.ca));
    add(g.b, side(g.cb));
  }
  const factor = (id: string, c: string): number => {
    const m = per.get(id)!;
    if (m.size < 2) return 1;
    const n = [...m.values()].reduce((s, x) => s + x, 0);
    const nc = m.get(c)!;
    if (nc / n <= cap) return 1;
    return (cap * (n - nc)) / ((1 - cap) * nc);
  };
  return Float64Array.from(games.map((g) => Math.min(factor(g.a, side(g.ca)), factor(g.b, side(g.cb)))));
}

/**
 * Rank ranges from pairwise decisions, within each connected group: best = 1 + members credibly ahead, worst = N −
 * members credibly behind, where N counts the included members of the group. Rows not included get null.
 */
export function rankRangesFromPairs(
  ids: string[], componentOf: (id: string) => number | null | undefined, pairs: PairDiff[], include: (id: string) => boolean = () => true,
): Map<string, [number, number] | null> {
  const inc = ids.filter((id) => include(id) && componentOf(id) != null);
  const size = new Map<number, number>();
  for (const id of inc) size.set(componentOf(id)!, (size.get(componentOf(id)!) ?? 0) + 1);
  const above = new Map<string, number>();
  const below = new Map<string, number>();
  const ok = new Set(inc);
  for (const p of pairs) {
    if (!p.ahead || !ok.has(p.a) || !ok.has(p.b)) continue;
    const [win, lose] = p.ahead === 'a' ? [p.a, p.b] : [p.b, p.a];
    above.set(lose, (above.get(lose) ?? 0) + 1);
    below.set(win, (below.get(win) ?? 0) + 1);
  }
  const out = new Map<string, [number, number] | null>();
  for (const id of ids) {
    if (!ok.has(id)) {
      out.set(id, null);
      continue;
    }
    const n = size.get(componentOf(id)!)!;
    out.set(id, [1 + (above.get(id) ?? 0), n - (below.get(id) ?? 0)]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Public entry point

/** Fit ratings for one comparability scope. `games` must be LLM-vs-LLM games with a winner. */
export function rateGames(games: RatingGame[], options: Partial<RatingOptions> = {}): RatingResult {
  const opts = { ...DEFAULT_RATING_OPTIONS, ...options };
  const ids = [...new Set(games.flatMap((g) => [g.a, g.b]))].sort();
  const events = [...new Set(games.map((g) => g.event))].sort();
  if (!games.length) {
    return { rows: [], games: 0, events: 0, components: 0, playAdvantage: null, covariate: null, replicates: 0, bootstrapUnit: 'event', clusters: 0, pairs: [], pooled: null };
  }

  const d = design(games, ids, opts);
  const n = ids.length;
  const base = opts.contributorCap != null ? contributorCapWeights(games, opts.contributorCap) : new Float64Array(games.length).fill(1);
  const fit = fitMap(d, base);
  const compMap = components(ids, games);
  const comp = ids.map((id) => compMap.get(id)!);
  const nComp = new Set(comp).size;
  const members: number[][] = Array.from({ length: nComp }, () => []);
  comp.forEach((c, k) => members[c]!.push(k));

  /** Center θ so each connected group's unweighted mean is 0 (a no-op for the flat model, where the MAP already is). */
  const center = (t: Float64Array): Float64Array => {
    const out = new Float64Array(t);
    for (const m of members) {
      let s = 0;
      for (const k of m) s += t[k]!;
      const mean = s / m.length;
      for (const k of m) out[k] = t[k]! - mean;
    }
    return out;
  };
  const theta = center(fit.theta);

  // Posterior covariance of θ (identities), and of h and β.
  const covP = fit.L ? inverse(fit.L, d.dim) : null;
  const covT: Float64Array[] | null = covP
    ? ids.map((_, i) => Float64Array.from(ids.map((__, j) => {
        let s = 0;
        for (const a of d.idCols[i]!) for (const b of d.idCols[j]!) s += covP[a]![b]!;
        return s;
      })))
    : null;
  const se = ids.map((_, k) => {
    if (!covT) return NaN;
    const m = members[comp[k]!]!;
    // Var(θ_k − mean of its group) = C_kk − 2/m Σ_j C_kj + 1/m² Σ_ij C_ij
    let row = 0;
    let all = 0;
    for (const j of m) row += covT[j]![k]!;
    for (const i of m) for (const j of m) all += covT[i]![j]!;
    return Math.sqrt(Math.max(0, covT[k]![k]! - (2 * row) / m.length + all / (m.length * m.length))) * ELO_PER_LOGIT;
  });
  const seH = covP && d.usePlay ? Math.sqrt(covP[d.iH]![d.iH]!) * ELO_PER_LOGIT : NaN;
  const seB = covP && d.useCov ? Math.sqrt(covP[d.iB]![d.iB]!) : NaN;

  // Per-identity tallies.
  const tally = ids.map(() => ({ games: 0, wins: 0, events: new Set<string>(), opps: new Set<string>(), contrib: new Map<string, number>(), sets: new Map<string, number>() }));
  games.forEach((g, i) => {
    for (const [me, opp, won, c] of [[d.ga[i]!, g.b, g.winner === 'a', g.ca], [d.gb[i]!, g.a, g.winner === 'b', g.cb]] as const) {
      const t = tally[me]!;
      t.games++;
      if (won) t.wins++;
      t.events.add(g.event);
      t.opps.add(opp);
      t.contrib.set(side(c), (t.contrib.get(side(c)) ?? 0) + 1);
      if (g.set != null) t.sets.set(g.set, (t.sets.get(g.set) ?? 0) + 1);
    }
  });

  // Contributor variance component: τ² · Σ_c share_c² (the Herfindahl index of the identity's contributors).
  const tauC2 = (opts.contributorSdElo / ELO_PER_LOGIT) ** 2;
  // Set variance component: τ_s² · Σ_set share² (games without a set add nothing). Both are summed into `extraVar` as one
  // extra variance in logits², so every interval and difference below carries them together. A scope of one set (a set
  // board) rates strength in that set, so it has no set component.
  const setsInScope = new Set(games.map((g) => g.set).filter((x) => x != null));
  const tauS2 = setsInScope.size >= 2 ? (opts.setSdElo / ELO_PER_LOGIT) ** 2 : 0;
  const extraVar = tally.map((t) => tauC2 * [...t.contrib.values()].reduce((s, x) => s + (x / t.games) ** 2, 0)
    + tauS2 * [...t.sets.values()].reduce((s, x) => s + (x / t.games) ** 2, 0));
  const seTot = se.map((x, k) => Math.sqrt(x * x + extraVar[k]! * ELO_PER_LOGIT * ELO_PER_LOGIT));

  // Bootstrap clusters: an event, or a contributor's events when every game of the event was seated by that contributor.
  const owner = new Map<string, string>();
  {
    const cs = new Map<string, Set<string>>();
    for (const g of games) {
      const s = cs.get(g.event) ?? new Set<string>();
      s.add(g.ca ?? '\u0000');
      s.add(g.cb ?? '\u0000');
      cs.set(g.event, s);
    }
    for (const [e, s] of cs) owner.set(e, s.size === 1 && !s.has('\u0000') ? `c:${[...s][0]}` : `e:${e}`);
  }
  const ownerClusters = [...new Set(owner.values())];
  const byContributor = opts.bootstrap === 'cluster' && ownerClusters.some((k) => k.startsWith('c:')) && ownerClusters.length >= opts.contributorClusterMin;
  const clusterOf = (g: RatingGame) => (byContributor ? owner.get(g.event)! : g.event);
  const clusterKeys = [...new Set(games.map(clusterOf))].sort();
  const byCluster = new Map<string, number[]>();
  games.forEach((g, i) => {
    const k = clusterOf(g);
    if (!byCluster.has(k)) byCluster.set(k, []);
    byCluster.get(k)!.push(i);
  });

  const B = opts.replicates;
  const reps: Array<{ t: Float64Array; present: Uint8Array }> = [];
  const hDraws: number[] = [];
  const bDraws: number[] = [];
  if (B > 0) {
    const rand = rng(opts.seed);
    const w = new Float64Array(games.length);
    for (let rep = 0; rep < B; rep++) {
      w.fill(0);
      for (let e = 0; e < clusterKeys.length; e++) {
        const idxs = byCluster.get(clusterKeys[Math.floor(rand() * clusterKeys.length)]!)!;
        if (opts.bootstrap === 'two-stage') for (let k = 0; k < idxs.length; k++) w[idxs[Math.floor(rand() * idxs.length)]!]! += 1;
        else for (const i of idxs) w[i]! += 1;
      }
      const present = new Uint8Array(n);
      for (let t = 0; t < games.length; t++) {
        if (w[t]) {
          present[d.ga[t]!] = 1;
          present[d.gb[t]!] = 1;
        }
        w[t] = w[t]! * base[t]!;
      }
      const f = fitMap(d, w, fit);
      const t = center(f.theta);
      // Small-sample correction of a cluster variance: deviations scaled by √(G/(G−1)).
      if (opts.clusterCorrection && clusterKeys.length > 1) {
        const c = Math.sqrt(clusterKeys.length / (clusterKeys.length - 1));
        for (let k = 0; k < n; k++) t[k] = theta[k]! + c * (t[k]! - theta[k]!);
      }
      reps.push({ t, present });
      if (d.usePlay) hDraws.push(f.p[d.iH]! * ELO_PER_LOGIT);
      if (d.useCov) bDraws.push(f.p[d.iB]!);
    }
  }
  const lo = (1 - opts.ci) / 2;
  const hi = 1 - lo;
  const interval = (xs: number[]): [number, number] | null => {
    if (!xs.length) return null;
    const s = [...xs].sort((a, b) => a - b);
    return [quantile(s, lo), quantile(s, hi)];
  };
  const z = normalQuantile(hi);

  // Ratings and bootstrap rank intervals (within each connected group).
  const draws: number[][] = ids.map(() => []);
  const rankDraws: number[][] = ids.map(() => []);
  for (const r of reps) {
    for (const m of members) {
      const order = m.filter((k) => r.present[k]).sort((x, y) => r.t[y]! - r.t[x]!);
      order.forEach((k, i) => {
        draws[k]!.push(elo(r.t[k]!));
        rankDraws[k]!.push(i + 1);
      });
    }
  }
  const ratingOf = (k: number) => elo(theta[k]!);
  const ciOf = ids.map((_, k) => envelope(ratingOf(k), seTot[k]!, interval(draws[k]!), z));

  // Pairwise differences within each connected group.
  const pairs: PairDiff[] = [];
  for (const m of members) {
    for (let x = 0; x < m.length; x++) {
      for (let y = x + 1; y < m.length; y++) {
        const i = m[x]!;
        const j = m[y]!;
        const diff = (theta[i]! - theta[j]!) * ELO_PER_LOGIT;
        let ci: [number, number] | null = null;
        if (B > 0) {
          const ds: number[] = [];
          for (const r of reps) if (r.present[i] && r.present[j]) ds.push((r.t[i]! - r.t[j]!) * ELO_PER_LOGIT);
          // Too few replicates with both present: the bootstrap can't say how the two compare; keep it undecided.
          const sdD = covT ? Math.sqrt(Math.max(0, covT[i]![i]! + covT[j]![j]! - 2 * covT[i]![j]! + extraVar[i]! + extraVar[j]!)) * ELO_PER_LOGIT : NaN;
          ci = ds.length >= B / 2 ? envelope(diff, sdD, interval(ds), z) : null;
        }
        const ahead = ci && ci[0] > 0 ? 'a' : ci && ci[1] < 0 ? 'b' : null;
        pairs.push({ a: ids[i]!, b: ids[j]!, diff, ci, ahead });
      }
    }
  }
  const rankRange = B > 0 ? rankRangesFromPairs(ids, (id) => compMap.get(id), pairs) : new Map<string, [number, number] | null>();

  // Leave-one-contributor-out influence. For each contributor c, refit without every game c seated a side of, and
  // compare each remaining identity's rating (relative to the identities still rated in its group):
  // - flagged: the rating without c would leave its 95% range;
  // - z: the shift over its own standard error, √(Var_without − Var_with) from the Laplace covariances (the two
  //   estimates share every game but c's, so this is the SE of the change). |z| ≥ INFLUENCE_Z marks results that
  //   disagree with the rest of the data (a configuration or a contributor unlike the others).
  const influence = new Map<number, Influence>();
  const contributorsInScope = [...new Set(games.flatMap((g) => [g.ca, g.cb]).filter((c): c is string => c != null))].sort();
  const relVar = (cov: Float64Array[], k: number, set: number[]): number => {
    let row = 0;
    let all = 0;
    for (const j of set) row += cov[j]![k]!;
    for (const i of set) for (const j of set) all += cov[i]![j]!;
    return cov[k]![k]! - (2 * row) / set.length + all / (set.length * set.length);
  };
  const thetaCov = (L: Float64Array | null): Float64Array[] | null => {
    if (!L) return null;
    const cp = inverse(L, d.dim);
    return ids.map((_, i) => Float64Array.from(ids.map((__, j) => {
      let s2 = 0;
      for (const a2 of d.idCols[i]!) for (const b2 of d.idCols[j]!) s2 += cp[a2]![b2]!;
      return s2;
    })));
  };
  if (opts.influence && contributorsInScope.length >= 2) {
    for (const c of contributorsInScope) {
      const w = Float64Array.from(base);
      let left = 0;
      games.forEach((g, i) => {
        if (g.ca === c || g.cb === c) w[i] = 0;
        else if (w[i]) left++;
      });
      if (!left) continue;
      const present = new Uint8Array(n);
      for (let t = 0; t < games.length; t++) {
        if (w[t]) {
          present[d.ga[t]!] = 1;
          present[d.gb[t]!] = 1;
        }
      }
      const f = fitMap(d, w, fit);
      const covL = thetaCov(f.L);
      for (const m of members) {
        const common = m.filter((k) => present[k]);
        const gone = m.filter((k) => !present[k]);
        for (const k of gone) influence.set(k, { contributor: c, shift: null, flagged: true, z: influence.get(k)?.z ?? null, zContributor: influence.get(k)?.zContributor ?? null });
        if (!common.length) continue;
        let sF = 0;
        let sL = 0;
        for (const k of common) {
          sF += theta[k]!;
          sL += f.theta[k]!;
        }
        for (const k of common) {
          const shift = ((f.theta[k]! - sL / common.length) - (theta[k]! - sF / common.length)) * ELO_PER_LOGIT;
          const vd = covT && covL ? relVar(covL, k, common) - relVar(covT, k, common) : NaN;
          const zk = Number.isFinite(vd) && vd > 1e-12 ? shift / (Math.sqrt(vd) * ELO_PER_LOGIT) : null;
          const prev = influence.get(k);
          const next: Influence = prev ? { ...prev } : { contributor: c, shift, flagged: false, z: null, zContributor: null };
          if (zk != null && (next.z == null || Math.abs(zk) > Math.abs(next.z))) {
            next.z = zk;
            next.zContributor = c;
          }
          if (!prev || (prev.shift != null && Math.abs(shift) > Math.abs(prev.shift))) {
            const r = ratingOf(k);
            const ci = ciOf[k] ?? (Number.isFinite(seTot[k]!) ? [r - z * seTot[k]!, r + z * seTot[k]!] : null);
            next.contributor = c;
            next.shift = shift;
            next.flagged = ci != null && (r + shift < ci[0] || r + shift > ci[1]);
          }
          influence.set(k, next);
        }
      }
    }
    for (const v of influence.values()) v.inconsistent = v.shift == null || (v.z != null && Math.abs(v.z) >= INFLUENCE_Z);
  }

  const rows: RatingRow[] = ids.map((id, k) => {
    const t = tally[k]!;
    const reasons: string[] = [];
    if (t.games < opts.minGames) reasons.push(`fewer than ${opts.minGames} games`);
    if (t.events.size < opts.minEvents) reasons.push(`fewer than ${opts.minEvents} events`);
    if (t.opps.size < opts.minOpponents) reasons.push(`fewer than ${opts.minOpponents} distinct opponents`);
    const contrib = [...t.contrib].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const top = contrib[0] ? { id: contrib[0][0], share: contrib[0][1] / t.games } : null;
    if (contrib.length < opts.minContributors) reasons.push(`games from fewer than ${opts.minContributors} contributors`);
    else if (top && top.share > opts.maxContributorShare) reasons.push(`one contributor supplied more than ${Math.round(opts.maxContributorShare * 100)}% of its games`);
    const rci = interval(rankDraws[k]!);
    return {
      id,
      rating: ratingOf(k),
      ci: ciOf[k]!,
      ciBoot: interval(draws[k]!),
      se: se[k]!,
      rank: 0,
      rankCi: rci ? [Math.round(rci[0]), Math.round(rci[1])] : null,
      rankRange: rankRange.get(id) ?? null,
      games: t.games,
      wins: t.wins,
      losses: t.games - t.wins,
      events: t.events.size,
      opponents: t.opps.size,
      contributors: contrib.length,
      topContributor: top,
      influence: influence.get(k) ?? null,
      component: comp[k]!,
      provisional: reasons.length > 0,
      provisionalReasons: reasons,
      bootCoverage: B > 0 ? draws[k]!.length / B : null,
    };
  });
  rows.sort((a, b) => b.rating - a.rating || a.id.localeCompare(b.id));
  rows.forEach((r, i) => (r.rank = i + 1));

  let pooled: PooledTerms | null = null;
  if (opts.pooling && covP) {
    const term = (prefix: string) => d.names
      .map((name, c) => [name, c] as const)
      .filter(([name]) => name.startsWith(prefix))
      .map(([name, c]) => ({ id: name.slice(prefix.length), elo: fit.p[c]! * ELO_PER_LOGIT, se: Math.sqrt(covP[c]![c]!) * ELO_PER_LOGIT }));
    pooled = { model: term('model:'), harness: term('harness:'), effort: term('effort:') };
  }

  return {
    rows,
    games: games.length,
    events: events.length,
    components: nComp,
    playAdvantage: d.usePlay ? { elo: fit.p[d.iH]! * ELO_PER_LOGIT, ci: envelope(fit.p[d.iH]! * ELO_PER_LOGIT, seH, interval(hDraws), z), games: games.filter((g) => g.onPlay).length } : null,
    covariate: d.useCov ? { coef: fit.p[d.iB]!, ci: envelope(fit.p[d.iB]!, seB, interval(bDraws), z) } : null,
    replicates: B,
    bootstrapUnit: opts.bootstrap === 'two-stage' ? 'two-stage' : byContributor ? 'contributor' : 'event',
    clusters: clusterKeys.length,
    pairs,
    pooled,
  };
}

/** Expected score of a over b under the model, from Elo-scale ratings (no play term). */
export function expectedScore(eloA: number, eloB: number): number {
  return 1 / (1 + 10 ** (-(eloA - eloB) / 400));
}

// ---------------------------------------------------------------------------
// Cluster bootstrap for outcomes and diagnostics

/**
 * Two-stage bootstrap of a statistic over clustered observations (clusters = events, items = picks,
 * decisions, games…). Returns the point estimate on the full data and a percentile interval.
 * With a single cluster the first stage is degenerate and only within-event noise is captured.
 */
export function clusterBootstrap<T>(
  clusters: T[][],
  stat: (items: T[]) => number | undefined,
  opts: { replicates?: number; ci?: number; seed?: number } = {},
): { value: number; ci: [number, number] | null; n: number; clusters: number } | null {
  const nonEmpty = clusters.filter((c) => c.length);
  const all = nonEmpty.flat();
  const value = stat(all);
  if (value == null || !Number.isFinite(value)) return null;
  const B = opts.replicates ?? 1000;
  const ci = opts.ci ?? 0.95;
  if (B <= 0 || all.length < 2) return { value, ci: null, n: all.length, clusters: nonEmpty.length };
  const rand = rng(opts.seed ?? 7);
  const out: number[] = [];
  for (let rep = 0; rep < B; rep++) {
    const sample: T[] = [];
    for (let c = 0; c < nonEmpty.length; c++) {
      const cl = nonEmpty[Math.floor(rand() * nonEmpty.length)]!;
      for (let k = 0; k < cl.length; k++) sample.push(cl[Math.floor(rand() * cl.length)]!);
    }
    const v = stat(sample);
    if (v != null && Number.isFinite(v)) out.push(v);
  }
  out.sort((a, b) => a - b);
  const lo = (1 - ci) / 2;
  return { value, ci: out.length ? [quantile(out, lo), quantile(out, 1 - lo)] : null, n: all.length, clusters: nonEmpty.length };
}
