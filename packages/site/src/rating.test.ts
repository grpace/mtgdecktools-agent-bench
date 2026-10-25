/**
 * Tests for the rating model (src/rating.ts) on synthetic data where the truth is known.
 *
 *   npm test -w @mtgdt/site          # or: npx tsx packages/site/src/rating.test.ts [--coverage]
 *
 * --coverage also runs a slower calibration study (repeated simulations; reports CI coverage).
 */
import { clusterBootstrap, contributorCapWeights, ELO_CENTER, expectedScore, rankRangesFromPairs, rateGames, rng, type RatingGame } from './rating.js';

let failures = 0;
let passes = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) passes++;
  else failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

/** Simulate pods: each event seats `perEvent` random identities, round robin, best-of-3 (2 or 3 games). */
function simulate(truth: Record<string, number>, opts: { events: number; perEvent: number; playElo: number; seed: number; withCov?: number; contributors?: number }): RatingGame[] {
  const rand = rng(opts.seed);
  const ids = Object.keys(truth);
  const games: RatingGame[] = [];
  for (let e = 0; e < opts.events; e++) {
    const pool = [...ids].sort(() => rand() - 0.5).slice(0, opts.perEvent);
    // Optional deck strength per seat in this event (logits), affecting outcomes with coefficient withCov.
    const deck = new Map(pool.map((id) => [id, (rand() - 0.5) * 1.2] as const));
    for (let i = 0; i < pool.length; i++) {
      for (let j = i + 1; j < pool.length; j++) {
        const a = pool[i]!;
        const b = pool[j]!;
        let wa = 0;
        let wb = 0;
        let aOnPlay = rand() < 0.5;
        while (wa < 2 && wb < 2) {
          const x = deck.get(a)! - deck.get(b)!;
          const diff = truth[a]! - truth[b]! + (aOnPlay ? opts.playElo : -opts.playElo) + (opts.withCov ? (opts.withCov * x * 400) / Math.LN10 : 0);
          const aWins = rand() < expectedScore(diff, 0);
          // Optional contributors: each event is one contributor's table, taking turns.
          const c = opts.contributors ? { ca: `c${e % opts.contributors}`, cb: `c${e % opts.contributors}` } : {};
          games.push({ event: `e${e}`, a, b, winner: aWins ? 'a' : 'b', onPlay: aOnPlay ? 'a' : 'b', ...(opts.withCov != null ? { x } : {}), ...c });
          if (aWins) wa++;
          else wb++;
          aOnPlay = !aWins; // loser chooses to play
        }
      }
    }
  }
  return games;
}

function spearman(xs: number[], ys: number[]): number {
  const rank = (v: number[]) => {
    const order = v.map((x, i) => [x, i] as const).sort((a, b) => a[0] - b[0]);
    const r = new Array<number>(v.length);
    order.forEach(([, i], k) => (r[i] = k));
    return r;
  };
  const rx = rank(xs);
  const ry = rank(ys);
  const n = xs.length;
  const d2 = rx.reduce((s, r, i) => s + (r - ry[i]!) ** 2, 0);
  return 1 - (6 * d2) / (n * (n * n - 1));
}

// ---------------------------------------------------------------------------
// 1. Recovery of a known ordering, play advantage, and CI coverage on one big dataset

{
  const truth = { a: -300, b: -150, c: 0, d: 100, e: 200, f: 350 };
  const games = simulate(truth, { events: 60, perEvent: 4, playElo: 40, seed: 1, contributors: 4 });
  const res = rateGames(games, { replicates: 400 });
  const ids = Object.keys(truth);
  const est = ids.map((id) => res.rows.find((r) => r.id === id)!.rating - ELO_CENTER);
  const tru = ids.map((id) => truth[id as keyof typeof truth]);
  const meanTruth = tru.reduce((s, x) => s + x, 0) / tru.length;
  const rho = spearman(est, tru);
  check('recovers the true ordering (Spearman ρ = 1)', rho === 1, `ρ=${rho.toFixed(3)}, ${games.length} games / 60 events, est ${est.map((x) => x.toFixed(0)).join(' ')}`);
  const covered = ids.filter((id) => {
    const r = res.rows.find((x) => x.id === id)!;
    const t = truth[id as keyof typeof truth] - meanTruth + ELO_CENTER;
    return r.ci != null && r.ci[0] <= t && t <= r.ci[1];
  }).length;
  check('95% CIs cover the (centered) truth for ≥ 5 of 6 identities', covered >= 5, `${covered}/6`);
  const pa = res.playAdvantage;
  check('play advantage estimated with a CI containing the truth (40 Elo)', pa != null && pa.ci != null && pa.ci[0] <= 40 && 40 <= pa.ci[1], pa ? `${pa.elo.toFixed(1)} [${pa.ci?.map((x) => x.toFixed(0)).join(', ')}]` : 'none');
  check('nobody provisional with 60 events from 4 contributors', res.rows.every((r) => !r.provisional), res.rows.map((r) => r.provisionalReasons.join(',')).join(' | '));
  check('4 contributors counted, none above half', res.rows.every((r) => r.contributors === 4 && r.topContributor!.share <= 0.5));
  check('bootstrap resamples events below 5 contributor clusters', res.bootstrapUnit === 'event' && res.clusters === 60, `${res.bootstrapUnit} × ${res.clusters}`);
  check('honest contributors: no row is flagged by the influence check', res.rows.every((r) => r.influence != null && !r.influence.flagged && !r.influence.inconsistent), res.rows.map((r) => `${r.id} ${r.influence?.shift?.toFixed(0)} z=${r.influence?.z?.toFixed(1)}`).join(', '));
  const top = res.rows[0]!;
  check('rank CI of the best identity includes 1', top.rankCi != null && top.rankCi[0] === 1, `${top.id} ranks ${top.rankCi?.join('–')}`);
  const se = res.rows.map((r) => (r.ciBoot![1] - r.ciBoot![0]) / (2 * 1.96 * r.se));
  check('bootstrap CI width agrees with the Laplace SE (ratio 0.6–1.6)', se.every((x) => x > 0.6 && x < 1.6), se.map((x) => x.toFixed(2)).join(' '));
}

// 2. Perfect separation stays finite and is shrunk; both provisional
{
  const games: RatingGame[] = [0, 1, 2].map(() => ({ event: 'e1', a: 'x', b: 'y', winner: 'a' as const }));
  const res = rateGames(games, { replicates: 200 });
  const x = res.rows.find((r) => r.id === 'x')!;
  const y = res.rows.find((r) => r.id === 'y')!;
  check('3–0 gives a finite, shrunk gap', Number.isFinite(x.rating) && x.rating > y.rating && x.rating - y.rating < 400, `${(x.rating - y.rating).toFixed(0)} Elo`);
  check('tiny samples are provisional with reasons (games, events, opponents, contributors)', x.provisional && y.provisional && x.provisionalReasons.length === 4 && x.provisionalReasons[3] === 'games from fewer than 2 contributors', x.provisionalReasons.join('; '));
  check('a 3–0 sweep still gets a wide interval (every resample is identical, so the Laplace interval sets it)', x.ci != null && x.ci[1] - x.ci[0] > 200, `${x.ci?.map((v) => v.toFixed(0)).join('–')} (bootstrap alone ${x.ciBoot?.map((v) => v.toFixed(0)).join('–')})`);
  check('no play term without on-play data', res.playAdvantage == null);
}

// 3. Symmetry: relabeling sides doesn't change ratings
{
  const truth = { p: 0, q: 120, r: -80 };
  const g1 = simulate(truth, { events: 10, perEvent: 3, playElo: 30, seed: 5 });
  const g2 = g1.map((g) => ({ ...g, a: g.b, b: g.a, winner: g.winner === 'a' ? ('b' as const) : ('a' as const), onPlay: g.onPlay === 'a' ? ('b' as const) : g.onPlay === 'b' ? ('a' as const) : undefined }));
  const r1 = rateGames(g1, { replicates: 0 });
  const r2 = rateGames(g2, { replicates: 0 });
  const diff = Math.max(...r1.rows.map((r) => Math.abs(r.rating - r2.rows.find((x) => x.id === r.id)!.rating)));
  check('side relabeling invariance', diff < 1e-6, `max |Δ| = ${diff.toExponential(1)}`);
}

// 4. Disconnected groups are reported as separate components
{
  const games: RatingGame[] = [
    { event: 'e1', a: 'a', b: 'b', winner: 'a' },
    { event: 'e1', a: 'a', b: 'b', winner: 'b' },
    { event: 'e2', a: 'c', b: 'd', winner: 'a' },
  ];
  const res = rateGames(games, { replicates: 50 });
  check('two components detected', res.components === 2 && new Set(res.rows.map((r) => r.component)).size === 2);
}

// 5. Covariate (deck strength) coefficient recovered and ratings still ordered
{
  const truth = { a: -150, b: 0, c: 150, d: 50 };
  const games = simulate(truth, { events: 80, perEvent: 4, playElo: 0, seed: 9, withCov: 1 });
  const res = rateGames(games, { replicates: 200 });
  const cov = res.covariate;
  check('covariate coefficient CI contains the truth (1.0)', cov != null && cov.ci != null && cov.ci[0] <= 1 && 1 <= cov.ci[1], cov ? `${cov.coef.toFixed(2)} [${cov.ci?.map((x) => x.toFixed(2)).join(', ')}]` : 'none');
  const ids = Object.keys(truth);
  const rho = spearman(ids.map((id) => res.rows.find((r) => r.id === id)!.rating), ids.map((id) => truth[id as keyof typeof truth]));
  check('deck-adjusted ratings keep the true order', rho === 1, `ρ=${rho.toFixed(2)}`);
}

// 6. Cluster bootstrap for outcomes and diagnostics
{
  const clusters = [Array(40).fill(1).concat(Array(60).fill(0)), Array(30).fill(1).concat(Array(70).fill(0)), Array(50).fill(1).concat(Array(50).fill(0))];
  const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : undefined);
  const r = clusterBootstrap(clusters, mean, { replicates: 500 });
  check('cluster bootstrap: point estimate is the pooled mean', r != null && Math.abs(r.value - 0.4) < 1e-12);
  const naive = 1.96 * Math.sqrt((0.4 * 0.6) / 300);
  check('cluster bootstrap CI is wider than the naive binomial CI when events differ', r != null && r.ci != null && (r.ci[1] - r.ci[0]) / 2 > naive, r?.ci ? `±${((r.ci[1] - r.ci[0]) / 2).toFixed(3)} vs ±${naive.toFixed(3)}` : '');
}

// 7. Determinism
{
  const truth = { a: 0, b: 100, c: -100 };
  const games = simulate(truth, { events: 6, perEvent: 3, playElo: 30, seed: 3 });
  const r1 = rateGames(games, { replicates: 100 });
  const r2 = rateGames(games, { replicates: 100 });
  check('same input, same output (seeded bootstrap)', JSON.stringify(r1) === JSON.stringify(r2));
}

// 8. Contributor floor: at least 2 contributors, none above half of the identity's games
{
  const truth = { a: 0, b: 50, c: -50 };
  const base = simulate(truth, { events: 40, perEvent: 3, playElo: 0, seed: 21 });
  const tag = (f: (e: number) => string) => base.map((g) => ({ ...g, ca: f(Number(g.event.slice(1))), cb: f(Number(g.event.slice(1))) }));
  const one = rateGames(tag(() => 'solo'), { replicates: 100 });
  check('contributor floor: one contributor keeps every row provisional', one.rows.every((r) => r.provisional && r.provisionalReasons.includes('games from fewer than 2 contributors') && r.contributors === 1));
  // Every event played twice, once by each contributor: exactly half each.
  const even = rateGames([...tag(() => 'x'), ...tag(() => 'y').map((g) => ({ ...g, event: `${g.event}y` }))], { replicates: 100 });
  check('contributor floor: two contributors at exactly 50/50 pass', even.rows.every((r) => !r.provisional), even.rows.map((r) => r.provisionalReasons.join(',')).join(' | '));
  const three = rateGames(tag((e) => `c${e % 3}`), { replicates: 100 });
  check('contributor floor: three contributors at about a third each pass', three.rows.every((r) => !r.provisional && r.contributors === 3), three.rows.map((r) => r.provisionalReasons.join(',')).join(' | '));
  const skew = rateGames(tag((e) => (e % 10 < 7 ? 'x' : 'y')), { replicates: 100 });
  check('contributor floor: one contributor above 50% keeps it provisional', skew.rows.every((r) => r.provisional && r.provisionalReasons.includes('one contributor supplied more than 50% of its games') && r.topContributor!.id === 'x' && Math.abs(r.topContributor!.share - 0.7) < 0.05));
  // A lobby game: the floor counts the identity's own side, not its opponent's contributor.
  const lobby = rateGames(base.map((g, i) => ({ ...g, ca: i % 2 ? 'p' : 'q', cb: 'z' })), { replicates: 0 });
  const a = lobby.rows.find((r) => r.id === 'a')!;
  check('contributor floor: counts who seated this identity (both sides of a lobby game)', a.contributors >= 2 && lobby.rows.some((r) => r.contributors === 3), lobby.rows.map((r) => `${r.id}:${r.contributors}`).join(' '));
}

// 9. Leave-one-contributor-out: a contributor who sandbags one identity is caught
{
  const truth = { v: 0, f: 0, o1: 0, o2: 0 };
  const rand = rng(99);
  const games: RatingGame[] = [];
  for (let e = 0; e < 80; e++) {
    const evil = e % 4 === 0; // one table in four belongs to the adversary, who seats v 400 Elo below its strength
    const c = evil ? 'adv' : `h${e % 3}`;
    const ids = Object.keys(truth);
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        for (let k = 0; k < 3; k++) {
          const a = ids[i]!;
          const b = ids[j]!;
          const d = (a === 'v' && evil ? -400 : 0) - (b === 'v' && evil ? -400 : 0);
          games.push({ event: `e${e}`, a, b, winner: rand() < expectedScore(d, 0) ? 'a' : 'b', ca: c, cb: c });
        }
      }
    }
  }
  const res = rateGames(games, { replicates: 200 });
  const v = res.rows.find((r) => r.id === 'v')!;
  check('influence: the sandbagged row is flagged, naming the adversary', v.influence != null && v.influence.flagged && v.influence.contributor === 'adv' && v.influence.shift! > 0, JSON.stringify(v.influence));
  check('influence: its z marks it inconsistent', v.influence?.inconsistent === true && v.influence.zContributor === 'adv' && v.influence.z! > 3.5, JSON.stringify(v.influence));
  check('influence: the adversary supplies 25% of its games, so the floor alone would not catch it', !v.provisionalReasons.some((x) => x.includes('contributor')) && Math.abs(v.topContributor!.share - 0.25) < 0.01, JSON.stringify(v.topContributor));
  const solo = rateGames(games.map((g) => ({ ...g, ca: g.ca === 'adv' ? 'adv' : 'h', cb: g.cb === 'adv' ? 'adv' : 'h' })).filter((g) => g.ca === 'adv' || g.a !== 'v' && g.b !== 'v'), { replicates: 50 });
  const sv = solo.rows.find((r) => r.id === 'v')!;
  check('influence: a row with no games left without one contributor is flagged with shift null', sv.influence?.shift === null && sv.influence.flagged && sv.influence.inconsistent === true, JSON.stringify(sv.influence));
}

// 10. Rank ranges from difference intervals: fewer games to separate than overlapping ranges
{
  // a and b meet often (a wins about 62%); c joins for a few games, so the field's mean (and each individual
  // range) is uncertain while the a − b difference is not.
  const rand = rng(5);
  const games: RatingGame[] = [];
  for (let e = 0; e < 50; e++) {
    for (let k = 0; k < 8; k++) games.push({ event: `e${e}`, a: 'a', b: 'b', winner: rand() < 0.62 ? 'a' : 'b' });
    if (e < 2) games.push({ event: `e${e}`, a: 'c', b: e ? 'a' : 'b', winner: 'a' });
  }
  const res = rateGames(games, { replicates: 400, minContributors: 0 });
  const A = res.rows.find((r) => r.id === 'a')!;
  const B = res.rows.find((r) => r.id === 'b')!;
  const overlap = A.ci![0] <= B.ci![1];
  const p = res.pairs.find((x) => x.a === 'a' && x.b === 'b')!;
  check('difference: a is credibly ahead of b although their individual ranges overlap', overlap && p.ahead === 'a' && p.ci![0] > 0, `a ${A.ci!.map((x) => x.toFixed(0))} b ${B.ci!.map((x) => x.toFixed(0))} diff ${p.ci!.map((x) => x.toFixed(0))}`);
  check('difference: rank ranges follow (a never below b)', A.rankRange![1] < B.rankRange![1] || (A.rankRange![0] === 1 && B.rankRange![0] > 1), `a ${A.rankRange} b ${B.rankRange}`);
}

// 11. Disconnected groups are never ranked against each other
{
  const games: RatingGame[] = [];
  for (let e = 0; e < 30; e++) {
    for (let k = 0; k < 5; k++) games.push({ event: `e${e}`, a: 'p', b: 'q', winner: k < 4 ? 'a' : 'b' });
    for (let k = 0; k < 5; k++) games.push({ event: `f${e}`, a: 'r', b: 's', winner: k < 4 ? 'a' : 'b' });
  }
  const res = rateGames(games, { replicates: 200 });
  check('groups: two connected groups', res.components === 2);
  check('groups: no pair across groups', res.pairs.length === 2 && res.pairs.every((x) => [x.a, x.b].sort().join() === 'p,q' || [x.a, x.b].sort().join() === 'r,s'), JSON.stringify(res.pairs.map((x) => [x.a, x.b])));
  const rr = Object.fromEntries(res.rows.map((r) => [r.id, r.rankRange]));
  check('groups: ranks are within each group (1 of 2 and 2 of 2 in both)', JSON.stringify([rr.p, rr.q, rr.r, rr.s]) === JSON.stringify([[1, 1], [2, 2], [1, 1], [2, 2]]), JSON.stringify(rr));
  const sub = rankRangesFromPairs(['p', 'q', 'r', 's'], (id) => res.rows.find((r) => r.id === id)!.component, res.pairs, (id) => id !== 'q');
  check('groups: leaving a row off the ranking shrinks its group (p is 1 of 1; q has no rank)', JSON.stringify(sub.get('p')) === '[1,1]' && sub.get('q') === null && JSON.stringify(sub.get('s')) === '[2,2]');
}

// 12. Weight cap and partial pooling
{
  const g = (a: string, b: string, ca: string, cb: string): RatingGame => ({ event: 'e', a, b, winner: 'a', ca, cb });
  const games = [...Array(8)].map(() => g('x', 'y', 'big', 'other')).concat([...Array(2)].map(() => g('x', 'y', 'small', 'other')));
  const w = contributorCapWeights(games, 0.5);
  // x: big has 80% → its games scale to (0.5 × 2) / (0.5 × 8) = 0.25, so its weighted share is 50%.
  check('cap: a contributor above the cap is scaled to it; others keep weight 1', Math.abs(w[0]! - 0.25) < 1e-12 && w[9] === 1, `${w[0]} ${w[9]}`);
  check('cap: a single contributor is never capped (the floor handles it)', contributorCapWeights([g('x', 'y', 'solo', 'solo')], 0.5)[0] === 1);

  const truth: Record<string, number> = { 'h/strong/high': 200, 'h/strong/low': 160, 'h/weak/high': -150, 'h/weak/low': -190 };
  const rand = rng(17);
  const ids = Object.keys(truth);
  const pg: RatingGame[] = [];
  for (let e = 0; e < 60; e++) {
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        // 'h/strong/low' is sparse: one game in six events.
        if ((ids[i] === 'h/strong/low' || ids[j] === 'h/strong/low') && e % 6) continue;
        const a = ids[i]!;
        const b = ids[j]!;
        pg.push({ event: `e${e}`, a, b, winner: rand() < expectedScore(truth[a]!, truth[b]!) ? 'a' : 'b' });
      }
    }
  }
  const of = (id: string) => ({ harness: id.split('/')[0]!, model: id.split('/')[1]!, effort: id.split('/')[2]! });
  const flat = rateGames(pg, { replicates: 0 });
  const pooled = rateGames(pg, { replicates: 100, pooling: { of } });
  const sparseF = flat.rows.find((r) => r.id === 'h/strong/low')!;
  const sparseP = pooled.rows.find((r) => r.id === 'h/strong/low')!;
  const sib = pooled.rows.find((r) => r.id === 'h/strong/high')!;
  check('pooling: a sparse row moves toward its own model', Math.abs(sparseP.rating - sib.rating) < Math.abs(sparseF.rating - flat.rows.find((r) => r.id === 'h/strong/high')!.rating), `flat ${sparseF.rating.toFixed(0)} pooled ${sparseP.rating.toFixed(0)} sibling ${sib.rating.toFixed(0)}`);
  check('pooling: model, harness and effort terms are reported', pooled.pooled != null && pooled.pooled.model.length === 2 && pooled.pooled.harness.length === 1 && pooled.pooled.effort.length === 4 && pooled.pooled.model.find((m) => m.id === 'strong')!.elo > pooled.pooled.model.find((m) => m.id === 'weak')!.elo);
  check('pooling: off by default', flat.pooled === null);
}

// ---------------------------------------------------------------------------
// Optional: calibration study (slow). Coverage of the 95% intervals across repeated small simulations.
if (process.argv.includes('--coverage')) {
  const truth = { a: -200, b: -60, c: 0, d: 80, e: 180 };
  const ids = Object.keys(truth);
  const centered = (id: string) => truth[id as keyof typeof truth] - ids.reduce((s, k) => s + truth[k as keyof typeof truth], 0) / ids.length + ELO_CENTER;
  for (const events of [3, 8, 20]) {
    let inside = 0;
    let total = 0;
    let width = 0;
    let orderOk = 0;
    const sims = 40;
    for (let s = 0; s < sims; s++) {
      const games = simulate(truth, { events, perEvent: 3, playElo: 30, seed: 1000 + s * 7 + events });
      const res = rateGames(games, { replicates: 200, seed: s + 1 });
      for (const r of res.rows) {
        if (!r.ci) continue;
        total++;
        width += r.ci[1] - r.ci[0];
        if (r.ci[0] <= centered(r.id) && centered(r.id) <= r.ci[1]) inside++;
      }
      if (res.rows[0]?.id === 'e') orderOk++;
    }
    console.log(`coverage: ${events} events/sim (3 seats per pod, Bo3): 95% CI covers truth ${((inside / total) * 100).toFixed(0)}% of the time; mean CI width ${(width / total).toFixed(0)} Elo; best identity ranked first in ${orderOk}/${sims}`);
  }
}

// Set component: a rating from one set is less certain about strength across sets; a set board has none.
{
  const truth = { a: 60, b: 0, c: -60 };
  const base = simulate(truth, { events: 40, perEvent: 3, playElo: 20, seed: 11, contributors: 6 });
  const width = (gs: RatingGame[], id: string, setSdElo?: number) => {
    const r = rateGames(gs, { replicates: 50, influence: false, seed: 5, ...(setSdElo != null ? { setSdElo } : {}) }).rows.find((x) => x.id === id)!;
    return r.ci![1] - r.ci![0];
  };
  // The same games, tagged with 8 sets (by event), with one set, or with none.
  const spread = base.map((g, i) => ({ ...g, set: `S${Number(g.event.slice(1)) % 8}` }));
  const oneSet = base.map((g) => ({ ...g, set: 'S0' }));
  check('set component: a multi-set scope widens ranges by about 30 Elo × √Σ share² (Laplace)', width(spread, 'a') > width(spread, 'a', 0), `${width(spread, 'a').toFixed(0)} vs ${width(spread, 'a', 0).toFixed(0)}`);
  check('set component: a one-set scope (a set board) has none', Math.abs(width(oneSet, 'a') - width(oneSet, 'a', 0)) < 1e-9);
  check('set component: games without a set add nothing', Math.abs(width(base, 'a') - width(base, 'a', 0)) < 1e-9);
}

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
