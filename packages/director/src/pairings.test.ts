/**
 * Swiss and round-robin pairings: determinism, no rematches, byes, and the Hub's verification of logged events of
 * every pairing version (the real SOS table paired under version 1). Version 3 (current): before the last round,
 * mirror avoidance first with the smallest score-group float; the last round strictly by points (equal records meet,
 * mirrors avoided only among them). Version 2: strictly by points every round (one 3-0 per 8-seat pod).
 *   npx tsx packages/director/src/pairings.test.ts
 */
import assert from 'node:assert/strict';
import {
  matchPoints, PAIRING_VERSION, pairingSeat, pairRound, pairSwissRound, plan, roundRobinSchedule, samePairing, swissRoundCount, verifyPairings,
  type MatchOutcome, type PairingSeat, type RoundPairing,
} from './pairings.js';
import { Rng } from './rng.js';

let passed = 0;
function test(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`ok - ${name}`);
}

const names = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
const seats: PairingSeat[] = names.map((name) => ({ name }));
const key = (x: string, y: string) => [x, y].sort().join('|');

/** Play a whole Swiss event with outcomes from an Rng: returns the rounds and results. */
function simulate(s: PairingSeat[], seed: string, outcomeSeed: string, rounds = 3, draws = true, version = PAIRING_VERSION): { prior: RoundPairing[]; results: MatchOutcome[] } {
  const rng = new Rng(outcomeSeed);
  const prior: RoundPairing[] = [];
  const results: MatchOutcome[] = [];
  for (let r = 1; r <= rounds; r++) {
    const p = pairSwissRound(s, seed, r, prior, results, version, rounds);
    prior.push(p);
    for (const [a, b] of p.pairs) {
      const x = draws ? rng.int(5) : 1 + rng.int(4);
      const wins = x === 0 ? { [a]: 1, [b]: 1 } : x < 3 ? { [a]: 2, [b]: x - 1 } : { [a]: x - 3, [b]: 2 };
      results.push({ a, b, wins });
    }
  }
  return { prior, results };
}

test('round counts: 3 rounds at 8 seats, capped so a rematch-free pairing always exists', () => {
  assert.equal(swissRoundCount(8), 3);
  assert.equal(swissRoundCount(2), 1);
  assert.equal(swissRoundCount(3), 2);
  assert.equal(swissRoundCount(4), 2);
  assert.equal(swissRoundCount(1), 0);
  assert.equal(PAIRING_VERSION, 4);
  assert.deepEqual(plan('swiss', 8), { format: 'swiss', rounds: 3, version: 4 });
  assert.equal(plan('round-robin', 8).rounds, 7);
  assert.equal(plan('round-robin', 3).rounds, 3);
});

test('version 4: the pairing identity is model/effort, so two harnesses of one model and level are a mirror; 1–3 keep the harness', () => {
  const cc = { harness: 'claude-code', model: 'claude-opus-5-5', effort: 'high' };
  const cu = { harness: 'cursor', model: 'claude-opus-5-5', effort: 'high' };
  assert.equal(pairingSeat('a', cc).identity, pairingSeat('b', cu).identity);
  assert.equal(pairingSeat('a', cc, 4).identity, 'claude-opus-5-5/high');
  assert.equal(pairingSeat('a', cc, 3).identity, 'claude-code/claude-opus-5-5/high');
  assert.notEqual(pairingSeat('a', cc, 3).identity, pairingSeat('b', cu, 3).identity);
});

test('deterministic: same seed and results give the same pairings, whatever the seat order', () => {
  const one = simulate(seats, 'seed-1', 'out-1');
  const two = simulate([...seats].reverse(), 'seed-1', 'out-1');
  assert.deepEqual(one.prior, two.prior);
  const other = simulate(seats, 'seed-2', 'out-1');
  assert.notDeepEqual(one.prior[0], other.prior[0], 'a different seed gives a different round 1');
});

test('round 1 is a seeded random pairing of everyone', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 40; i++) {
    const p = pairSwissRound(seats, `s${i}`, 1, [], []);
    assert.equal(p.pairs.length, 4);
    assert.equal(p.byes.length, 0);
    assert.deepEqual(p.pairs.flat().sort(), names);
    for (const [a, b] of p.pairs) seen.add(key(a, b));
  }
  assert.ok(seen.size >= 20, `round 1 should vary with the seed (saw ${seen.size} distinct pairs of 28)`);
});

test('no rematches across 3 rounds, for many seeds and outcomes', () => {
  for (let i = 0; i < 300; i++) {
    const { prior } = simulate(seats, `seed-${i}`, `out-${i}`);
    const met = new Set<string>();
    for (const r of prior) {
      assert.equal(r.pairs.length, 4);
      assert.deepEqual(r.pairs.flat().sort(), names, 'everyone plays every round');
      for (const [a, b] of r.pairs) {
        assert.ok(!met.has(key(a, b)), `rematch ${a}-${b} (seed ${i})`);
        met.add(key(a, b));
      }
    }
  }
});

test('later rounds pair by match record: 1–0 seats meet 1–0 seats in round 2', () => {
  for (let i = 0; i < 100; i++) {
    const r1 = pairSwissRound(seats, `rec-${i}`, 1, [], []);
    const results: MatchOutcome[] = r1.pairs.map(([a, b]) => ({ a, b, wins: { [a]: 2, [b]: 0 } }));
    const winners = new Set(r1.pairs.map(([a]) => a));
    const r2 = pairSwissRound(seats, `rec-${i}`, 2, [r1], results);
    for (const [a, b] of r2.pairs) assert.equal(winners.has(a), winners.has(b), `round 2 crossed score groups: ${a} vs ${b}`);
    // Higher points first in each pair.
    const pts = matchPoints(names, [r1], results);
    for (const [a, b] of r2.pairs) assert.ok(pts.get(a)! >= pts.get(b)!);
  }
});

const pts9 = (prior: RoundPairing[], results: MatchOutcome[]) => matchPoints(names, prior, results);

/** Whether some perfect matching of `ns` avoids every pair `bad` rejects (exhaustive; 105 matchings at 8). */
function existsMatching(ns: string[], bad: (a: string, b: string) => boolean): boolean {
  if (!ns.length) return true;
  const [a, ...rest] = ns;
  return rest.some((b, i) => !bad(a!, b) && existsMatching(rest.filter((_, j) => j !== i), bad));
}

test('version 3, the last round: strictly by points: score groups never cross when every group is even', () => {
  // Two identities, 4 seats each (an effort ladder): identity avoidance never pulls a seat out of its group in round 3.
  const ladder = names.map((name, i) => ({ name, identity: `cc/haiku/${i % 2 ? 'low' : 'medium'}` }));
  for (let i = 0; i < 300; i++) {
    const { prior, results } = simulate(ladder, `eq-${i}`, `o-${i}`, 3, false);
    const pts = pts9(prior.slice(0, 2), results.slice(0, 8));
    const groups = new Map<number, number>();
    for (const n of names) groups.set(pts.get(n)!, (groups.get(pts.get(n)!) ?? 0) + 1);
    if ([...groups.values()].every((c) => c % 2 === 0)) {
      for (const [a, b] of prior[2]!.pairs) assert.equal(pts.get(a), pts.get(b), `round 3 crossed score groups with even groups: ${a} vs ${b} (seed ${i})`);
    }
  }
});

test('version 3, rounds before the last: a mirror only when no rematch-free pairing avoids one; floats stay adjacent', () => {
  const ladder = names.map((name, i) => ({ name, identity: `cc/haiku/${i % 2 ? 'low' : 'medium'}` }));
  const idOf = new Map(ladder.map((x) => [x.name, x.identity]));
  for (let i = 0; i < 300; i++) {
    const { prior, results } = simulate(ladder, `fl-${i}`, `fo-${i}`, 3, false);
    const met = new Set(prior[0]!.pairs.map(([a, b]) => key(a, b)));
    const mirrors = prior[1]!.pairs.filter(([a, b]) => idOf.get(a) === idOf.get(b));
    if (mirrors.length) assert.ok(!existsMatching(names, (a, b) => met.has(key(a, b)) || idOf.get(a) === idOf.get(b)), `round 2 has a mirror although a mirror-free pairing existed (seed ${i})`);
    const pts = pts9(prior.slice(0, 1), results.slice(0, 4));
    for (const [a, b] of prior[1]!.pairs) assert.ok(Math.abs(pts.get(a)! - pts.get(b)!) <= 3, 'a float moves one score group at most');
  }
  // A 1-0 group of three seats of one setup and one other: version 2 pairs a mirror in it; version 3 floats instead.
  const three = names.map((name) => ({ name, identity: ['a', 'b', 'c'].includes(name) ? 'cc/x/low' : `cc/${name}/high` }));
  const r1: RoundPairing = { round: 1, pairs: [['a', 'e'], ['b', 'f'], ['c', 'g'], ['d', 'h']], byes: [] };
  const res1: MatchOutcome[] = r1.pairs.map(([x, y]) => ({ a: x, b: y, wins: { [x]: 2, [y]: 0 } }));
  const mirror = (p: RoundPairing) => p.pairs.some(([x, y]) => ['a', 'b', 'c'].includes(x) && ['a', 'b', 'c'].includes(y));
  for (let i = 0; i < 30; i++) {
    assert.ok(mirror(pairSwissRound(three, `f-${i}`, 2, [r1], res1, 2, 3)), 'version 2: strictly by points');
    const v3 = pairSwissRound(three, `f-${i}`, 2, [r1], res1, 3, 3);
    assert.ok(!mirror(v3), 'version 3 floats to avoid the mirror');
    const crossing = v3.pairs.filter(([x, y]) => ['a', 'b', 'c', 'd'].includes(x) !== ['a', 'b', 'c', 'd'].includes(y));
    assert.equal(crossing.length, 2, 'the smallest float: one seat down and one up');
    // The same position in the last round is paired strictly by points.
    assert.ok(mirror(pairSwissRound(three, `f-${i}`, 2, [r1], res1, 3, 2)), 'version 3, last round: strictly by points');
  }
});

test('version 3: rated matches by mix, and how often a pod has two 3-0s (1,000 pods each)', () => {
  const mix = (counts: number[]) => counts.flatMap((n, k) => Array.from({ length: n }, () => `cc/m${k}/high`)).map((identity, i) => ({ name: names[i]!, identity }));
  const measure = (counts: number[], version: number) => {
    const s = mix(counts);
    const idOf = new Map(s.map((x) => [x.name, x.identity]));
    let rated = 0, two = 0;
    for (let i = 0; i < 1000; i++) {
      const { prior, results } = simulate(s, `mix-${i}`, `mo-${i}`, 3, false, version);
      rated += prior.flatMap((r) => r.pairs).filter(([a, b]) => idOf.get(a) !== idOf.get(b)).length;
      if (names.filter((n) => pts9(prior, results).get(n) === 9).length >= 2) two++;
    }
    return { rated: rated / 1000, two: two / 1000 };
  };
  const v3 = { '7+1': measure([7, 1], 3), '6+2': measure([6, 2], 3), '4+4': measure([4, 4], 3), '2x4': measure([2, 2, 2, 2], 3) };
  const v2 = measure([4, 4], 2);
  console.log(`  rated matches of 12 (v3): 7+1 ${v3['7+1'].rated}, 6+2 ${v3['6+2'].rated}, 4+4 ${v3['4+4'].rated} (v2: ${v2.rated}), 2x4 ${v3['2x4'].rated}; two 3-0s at 4+4: ${(v3['4+4'].two * 100).toFixed(1)}% (v2: ${v2.two * 100}%)`);
  assert.equal(v3['7+1'].rated, 3, 'one seat of another setup: one rated match a round');
  assert.ok(v3['4+4'].rated > 10 && v2.rated < 9.5, 'floats before the last round rate more of a 4 + 4 table');
  assert.ok(v3['4+4'].two > 0 && v3['4+4'].two < 0.15, 'the trade-off: occasionally two 3-0s');
  assert.equal(v2.two, 0, 'version 2: never two 3-0s');
});

test('version 2: one 3-0 per 8-seat pod: the two 2-0 seats always meet in round 3 (500 seeds, no draws)', () => {
  const ladder = names.map((name, i) => ({ name, identity: `cc/haiku/${i % 2 ? 'low' : 'medium'}`, contributor: String(i % 3) }));
  for (const s of [seats, ladder]) {
    for (let i = 0; i < 500; i++) {
      const { prior, results } = simulate(s, `pod-${i}`, `res-${i}`, 3, false, 2);
      const pts = pts9(prior, results);
      const undefeated = names.filter((n) => pts.get(n) === 9);
      assert.equal(undefeated.length, 1, `seed ${i}: ${undefeated.length} seats finished 3-0`);
      const twoOh = names.filter((n) => pts9(prior.slice(0, 2), results.slice(0, 8)).get(n) === 6);
      assert.equal(twoOh.length, 2);
      assert.ok(prior[2]!.pairs.some(([a, b]) => twoOh.includes(a) && twoOh.includes(b)), `seed ${i}: the 2-0 seats didn't meet`);
    }
  }
  // Version 3 with distinct setups (no float needed) behaves the same: one 3-0.
  for (let i = 0; i < 300; i++) {
    const { prior, results } = simulate(seats, `pod3-${i}`, `res3-${i}`, 3, false, 3);
    assert.equal(names.filter((n) => pts9(prior, results).get(n) === 9).length, 1);
  }
});

test('avoids pairing two seats of the same identity, then of the same contributor, among equal-record options', () => {
  // Four models × two seats (a Private Table): round 1 (everyone at 0 points) never pairs a model with itself, and
  // later rounds never do when an equal-cost alternative exists inside the score groups.
  const dup = names.map((name, i) => ({ name, identity: `cc/model-${i % 4}/high` }));
  for (let i = 0; i < 100; i++) {
    const r1 = pairSwissRound(dup, `dup-${i}`, 1, [], []);
    for (const [a, b] of r1.pairs) assert.notEqual(dup.find((s) => s.name === a)!.identity, dup.find((s) => s.name === b)!.identity);
  }
  // Round 2 with 1-0 seats {a, b, c, d} where a and b share an identity: a meets c or d, never b.
  const four = names.map((name) => ({ name, identity: name === 'a' || name === 'b' ? 'cc/same/high' : `cc/${name}/high` }));
  const r1: RoundPairing = { round: 1, pairs: [['a', 'e'], ['b', 'f'], ['c', 'g'], ['d', 'h']], byes: [] };
  const res1: MatchOutcome[] = r1.pairs.map(([x, y]) => ({ a: x, b: y, wins: { [x]: 2, [y]: 0 } }));
  for (let i = 0; i < 50; i++) {
    const r2 = pairSwissRound(four, `id-${i}`, 2, [r1], res1);
    assert.ok(!r2.pairs.some(([x, y]) => [x, y].sort().join() === 'a,b'), 'same identity paired although an equal-record option existed');
    for (const [x, y] of r2.pairs) assert.equal(['a', 'b', 'c', 'd'].includes(x), ['a', 'b', 'c', 'd'].includes(y), 'still within score groups');
  }
  // Lobby: contributors 1,1,1,2,2,2,3,3: same-contributor pairs avoided in round 1.
  const lobby = names.map((name, i) => ({ name, contributor: String(i < 3 ? 1 : i < 6 ? 2 : 3) }));
  for (let i = 0; i < 100; i++) {
    const r1 = pairSwissRound(lobby, `lob-${i}`, 1, [], []);
    for (const [a, b] of r1.pairs) assert.notEqual(lobby.find((s) => s.name === a)!.contributor, lobby.find((s) => s.name === b)!.contributor);
  }
  // Rematches still beat identity avoidance: 8 copies of one model still get a full pairing every round.
  const same = names.map((name) => ({ name, identity: 'cc/one/high' }));
  const { prior } = simulate(same, 'same', 'same');
  assert.equal(prior.flatMap((r) => r.pairs).length, 12);
});

test('odd tables (dev only): one bye per round, never twice to the same seat', () => {
  const five = names.slice(0, 5).map((name) => ({ name }));
  for (let i = 0; i < 100; i++) {
    const { prior } = simulate(five, `odd-${i}`, `o-${i}`, swissRoundCount(5));
    const byes = prior.flatMap((r) => r.byes);
    assert.equal(byes.length, prior.length);
    assert.equal(new Set(byes).size, byes.length, 'a seat got two byes');
  }
});

test('round robin: every pair once, table order', () => {
  const rr = roundRobinSchedule(names);
  assert.equal(rr.length, 7);
  const met = new Set(rr.flatMap((r) => r.pairs.map(([a, b]) => key(a, b))));
  assert.equal(met.size, 28);
  const p = plan('round-robin', 8);
  assert.ok(samePairing(pairRound(p, seats, 'x', 3, [], []), rr[2]!));
  assert.deepEqual(roundRobinSchedule(['a', 'b', 'c']).map((r) => r.byes.length), [1, 1, 1]);
});

test('pairing identity from seat metadata', () => {
  assert.deepEqual(pairingSeat('x', { harness: 'Claude-Code', model: 'claude-opus-5-5' }), { name: 'x', identity: 'claude-opus-5-5/default' });
  assert.deepEqual(pairingSeat('y', { harness: 'codex', model: 'gpt-5', effort: 'High', contributor_id: '12' }), { name: 'y', identity: 'gpt-5/high', contributor: '12' });
  assert.deepEqual(pairingSeat('z', {}), { name: 'z' });
});

/** A minimal log as the Director writes it: event_start, round_start, match_end. */
function fakeLog(seed: string, out: string): Array<Record<string, any>> {
  const meta = names.map((name, i) => ({ name, kind: 'agent', position: i, harness: 'claude-code', model: `m${i % 3}`, contributor_id: String(i % 4) }));
  const s = meta.map((m) => pairingSeat(m.name, m));
  const p = plan('swiss', 8);
  const rng = new Rng(out);
  const log: Array<Record<string, any>> = [{ type: 'event_start', seed, seats: meta, pairing: p }];
  const prior: RoundPairing[] = [];
  const results: MatchOutcome[] = [];
  for (let r = 1; r <= p.rounds; r++) {
    const rp = pairRound(p, s, seed, r, prior, results);
    log.push({ type: 'round_start', round: r, pairs: rp.pairs, byes: rp.byes, format: 'swiss' });
    prior.push(rp);
    for (const [a, b] of rp.pairs) {
      const wins = rng.int(2) ? { [a]: 2, [b]: 1 } : { [a]: 0, [b]: 2 };
      results.push({ a, b, wins });
      log.push({ type: 'match_end', a, b, wins });
    }
  }
  return log;
}

/** The real SOS table (2026-10-22-14-39-42-sos-909e): 4 Medium and 4 Low Haiku seats, paired under version 1. */
const SOS_SEATS = [
  ['seat-4ff9a3', 'medium'], ['seat-06fb60', 'low'], ['seat-6c1424', 'medium'], ['seat-c7df88', 'low'],
  ['seat-e2c7af', 'medium'], ['seat-fc5874', 'low'], ['seat-e386ff', 'medium'], ['seat-cf5eea', 'low'],
].map(([name, effort], position) => ({ name: name!, kind: 'agent', position, harness: 'claude-code', model: 'claude-haiku-5-5', effort }));
const SOS_SEED = 'sos-1792679982728-21b02844';
const SOS_ROUNDS: Array<{ pairs: Array<[string, string]>; ends: Array<[string, string, number, number]> }> = [
  { pairs: [['seat-c7df88', 'seat-6c1424'], ['seat-fc5874', 'seat-e386ff'], ['seat-06fb60', 'seat-4ff9a3'], ['seat-e2c7af', 'seat-cf5eea']],
    ends: [['seat-c7df88', 'seat-6c1424', 1, 0], ['seat-06fb60', 'seat-4ff9a3', 0, 1], ['seat-fc5874', 'seat-e386ff', 1, 0], ['seat-e2c7af', 'seat-cf5eea', 1, 0]] },
  { pairs: [['seat-fc5874', 'seat-4ff9a3'], ['seat-c7df88', 'seat-e2c7af'], ['seat-6c1424', 'seat-cf5eea'], ['seat-e386ff', 'seat-06fb60']],
    ends: [['seat-c7df88', 'seat-e2c7af', 0, 1], ['seat-fc5874', 'seat-4ff9a3', 0, 1], ['seat-e386ff', 'seat-06fb60', 0, 1], ['seat-6c1424', 'seat-cf5eea', 1, 0]] },
  { pairs: [['seat-e2c7af', 'seat-fc5874'], ['seat-4ff9a3', 'seat-c7df88'], ['seat-06fb60', 'seat-6c1424'], ['seat-cf5eea', 'seat-e386ff']],
    ends: [['seat-e2c7af', 'seat-fc5874', 1, 0], ['seat-cf5eea', 'seat-e386ff', 0, 1], ['seat-4ff9a3', 'seat-c7df88', 1, 0], ['seat-06fb60', 'seat-6c1424', 0, 1]] },
];
function sosLog(version: number): Array<Record<string, any>> {
  const log: Array<Record<string, any>> = [{ type: 'event_start', seed: SOS_SEED, seats: SOS_SEATS, pairing: { format: 'swiss', rounds: 3, version } }];
  SOS_ROUNDS.forEach((r, i) => {
    log.push({ type: 'round_start', round: i + 1, pairs: r.pairs, byes: [], format: 'swiss' });
    for (const [a, b, wa, wb] of r.ends) log.push({ type: 'match_end', a, b, wins: { [a]: wa, [b]: wb } });
  });
  return log;
}

test('the real SOS table: its version-1 log still verifies; version 2 makes the two 2-0 Medium seats meet in round 3', () => {
  assert.deepEqual(verifyPairings(sosLog(1)), { ok: true, status: 'verified', problems: [], rounds: 3 });
  // Under version 2 the same rounds 1-2 (all within score groups) and results lead to round 3: 4ff9a3 vs e2c7af.
  const s = SOS_SEATS.map((m) => pairingSeat(m.name, m));
  const prior: RoundPairing[] = [];
  const results: MatchOutcome[] = [];
  for (let r = 1; r <= 2; r++) {
    const want = pairSwissRound(s, SOS_SEED, r, prior, results, 2);
    prior.push({ round: r, pairs: SOS_ROUNDS[r - 1]!.pairs, byes: [] });
    for (const [a, b, wa, wb] of SOS_ROUNDS[r - 1]!.ends) results.push({ a, b, wins: { [a]: wa, [b]: wb } });
    if (r === 1) assert.ok(samePairing(want, prior[0]!), 'round 1 is random and identical under both versions');
  }
  const r3 = pairSwissRound(s, SOS_SEED, 3, prior, results, 2);
  assert.ok(r3.pairs.some(([a, b]) => [a, b].sort().join() === 'seat-4ff9a3,seat-e2c7af'), `2-0 seats must meet: ${JSON.stringify(r3.pairs)}`);
  // Version 3's last round is strictly by points too: the two 2-0 Medium seats meet.
  const r3v3 = pairSwissRound(s, SOS_SEED, 3, prior, results, 3, 3);
  assert.ok(r3v3.pairs.some(([a, b]) => [a, b].sort().join() === 'seat-4ff9a3,seat-e2c7af'), `v3: 2-0 seats must meet: ${JSON.stringify(r3v3.pairs)}`);
  const v1 = pairSwissRound(s, SOS_SEED, 3, prior, results, 1);
  assert.ok(samePairing(v1, { pairs: SOS_ROUNDS[2]!.pairs, byes: [] }), 'version 1 reproduces what the table logged');
  // The verifier checks each log against the version it records, and skips versions it doesn't know.
  assert.equal(verifyPairings(sosLog(2)).status, 'mismatch', 'the v1 round 3 is not a valid v2 pairing');
  assert.equal(verifyPairings(sosLog(99)).status, 'skip');
  assert.throws(() => pairSwissRound(s, SOS_SEED, 1, [], [], 99));
});

test('the Hub verifies a logged Swiss event and catches edited pairings or results', () => {
  const log = fakeLog('event-seed', 'outcomes');
  assert.deepEqual(verifyPairings(log), { ok: true, status: 'verified', problems: [], rounds: 3 });
  // A different seed (e.g. an edited event_start) breaks round 1.
  const wrongSeed = log.map((e) => (e.type === 'event_start' ? { ...e, seed: 'other' } : e));
  assert.equal(verifyPairings(wrongSeed).status, 'mismatch');
  // Swapped opponents in round 2.
  const swapped = log.map((e) => (e.type === 'round_start' && e.round === 2 ? { ...e, pairs: [[e.pairs[0][0], e.pairs[1][1]], [e.pairs[1][0], e.pairs[0][1]], ...e.pairs.slice(2)] } : e));
  assert.equal(verifyPairings(swapped).status, 'mismatch');
  // A flipped round-1 result changes the round-2 pairing the log should have (usually): never a silent pass.
  let caught = 0;
  for (let i = 0; i < 20; i++) {
    const l = fakeLog(`seed-${i}`, `out-${i}`);
    const firstEnd = l.findIndex((e) => e.type === 'match_end');
    const e = l[firstEnd]!;
    l[firstEnd] = { ...e, wins: { [e.a]: e.wins[e.b], [e.b]: e.wins[e.a] } };
    if (verifyPairings(l).status === 'mismatch') caught++;
  }
  assert.ok(caught >= 10, `flipped results should usually be caught (caught ${caught}/20)`);
  // Older logs without a pairing plan are skipped, not failed.
  assert.equal(verifyPairings([{ type: 'event_start', seed: 's', seats: [] }]).status, 'skip');
});

console.log(`\n${passed} pairing tests passed`);
