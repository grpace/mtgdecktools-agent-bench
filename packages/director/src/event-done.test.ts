/**
 * A seat with no games left is told so at once (its final answer, its own results) instead of waiting for the whole
 * event: the first hosted 8-seat table had early finishers re-sending their context for about 20 minutes each.
 *   npx tsx packages/director/src/event-done.test.ts
 */
import assert from 'node:assert/strict';
import { Event } from './event.js';
import { AgentSeat } from './seat.js';

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  await fn();
  passed++;
  console.log(`ok - ${name}`);
}

/**
 * An Event with just what playMatch needs, its games already in the log (a resumed event replays finished games
 * without the rules engine): `rounds` Swiss rounds, seats a–d, round `r` pairing a–b and c–d.
 */
function stubEvent(rounds: number) {
  const seats = ['a', 'b', 'c', 'd'].map((n, i) => new AgentSeat(n, i));
  const logged: Array<Record<string, any>> = [];
  const ev: any = Object.create(Event.prototype);
  Object.assign(ev, {
    cfg: { bestOf: 3 }, plan: { format: 'swiss', rounds, version: 1 }, rounds: [], round: -1, matches: [], playing: new Set(), roundMatches: new Map(),
    forfeits: new Map(), liveGames: new Set(), sessions: new Map(), seats, aborted: undefined,
    log: (type: string, d: Record<string, unknown>) => logged.push({ type, ...d }),
    persist: () => {},
    resume: { games: new Map(), matchEnds: new Map(), seatsDone: new Set(), forfeits: [], records: [] },
  });
  const play = async (r: number, pairs: Array<[string, string]>, winners: string[]) => {
    ev.round = r - 1;
    ev.rounds.push({ round: r, pairs, byes: [] });
    for (const [i, [x, y]] of pairs.entries()) {
      // Best of 3, won 2–0 (between-games decisions are off in this stub: `sideboarding` is unset).
      for (const g of [1, 2]) ev.resume.games.set(`${x} vs ${y} — game ${g}`, { over: { winner: winners[i], turns: 9 } });
    }
    const by = new Map(seats.map((s) => [s.name, s]));
    await Promise.all(pairs.map(([x, y]) => ev.playMatch(by.get(x), by.get(y), r - 1)));
  };
  return { ev, seats, logged, play };
}

await test('the last round: both seats of a finished match are done at once, with their own results', async () => {
  const { seats, logged, play } = stubEvent(2);
  await play(1, [['a', 'b'], ['c', 'd']], ['a', 'c']);
  assert.ok(seats.every((s) => !s.done), 'round 1 of 2: everyone still has a game');
  await play(2, [['a', 'c']], ['a']);
  const [a, b, c, d] = seats;
  assert.match(a!.done!, /^EVENT COMPLETE\. You're done: no more games for you in this event; you can stop now\./);
  assert.match(a!.done!, /Round 1: vs another agent \(opponent A\): won 2–0[\s\S]*Round 2: vs another agent \(opponent B\): won 2–0[\s\S]*Totals: matches won 2, lost 0/);
  assert.match(c!.done!, /Totals: matches won 1, lost 1/);
  // b–d is still to be played, so a and c hear that others are still playing.
  assert.match(a!.done!, /Other agents are still finishing their matches\./);
  assert.match(c!.done!, /Other agents are still finishing their matches\./);
  assert.ok(!a!.done!.includes(' c ') && !a!.done!.includes('"c"'), 'opponents are never named');
  assert.equal(b!.done, undefined, 'b–d is still to be played');
  assert.equal(d!.done, undefined);
  assert.deepEqual(logged.filter((r) => r.type === 'seat_done').map((r) => r.seat).sort(), ['a', 'c']);
  // The first call gets the final answer at once; the watchdog skips done seats; the status says done.
  const t0 = Date.now();
  assert.equal((await a!.wait(5_000)).status, 'done');
  assert.ok(Date.now() - t0 < 500);
  assert.equal(a!.pending, undefined);
});

await test('a finished seat that keeps calling is answered at the pace of a normal wait, never in a tight loop', async () => {
  const s = new AgentSeat('x', 0);
  s.finish("EVENT COMPLETE. You're done.");
  assert.equal((await s.wait(300)).status, 'done');
  const t0 = Date.now();
  const again = await s.wait(300);
  assert.equal(again.status, 'done');
  assert.ok(Date.now() - t0 >= 280, 'the repeat call waited');
  // decide answers with the final text at once (nothing to decide).
  assert.match(await s.decide({ decision_id: 'G1', option: '1' }), /^EVENT COMPLETE/);
});

await test('a resumed event does not log seat_done twice', async () => {
  const { ev, seats, logged, play } = stubEvent(1);
  ev.resume.seatsDone.add('a');
  await play(1, [['a', 'b']], ['b']);
  assert.ok(seats[0]!.done && seats[1]!.done);
  assert.deepEqual(logged.filter((r) => r.type === 'seat_done').map((r) => r.seat), ['b']);
});

await test('the last match of the event to finish: its seats are not told others are still playing', async () => {
  const { seats, play } = stubEvent(1);
  await play(1, [['a', 'b'], ['c', 'd']], ['a', 'c']);
  const [a, b, c, d] = seats;
  // a–b finished first (c–d still under way at that moment); c–d was the last match.
  assert.match(a!.done!, /Other agents are still finishing their matches\./);
  assert.match(b!.done!, /Other agents are still finishing their matches\./);
  for (const s of [c!, d!]) {
    assert.ok(!s.done!.includes('still finishing'), `${s.name} was the last to finish`);
    assert.match(s.done!, /^EVENT COMPLETE\. You're done: no more games for you in this event; you can stop now\. Every match has finished: the event is ending\. Your matches:/);
  }
});

console.log(`# ${passed} passed`);
