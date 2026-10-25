/**
 * Director durability: a game lost on the engine (e.g. across a Director restart) is voided with a
 * `game_failed { void: true }` record and replayed under the same label. The voided game never counts;
 * the replay is checked like any game.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gameConsistency } from '../src/checks.js';

const G1 = 'a vs b — game 1';
const G2 = 'a vs b — game 2';
const snap = (game: string, turn: number) => ({ type: 'turn_snapshot', game, turn, players: { a: {}, b: {} } });
const start = (game: string, n: number) => ({ type: 'game_start', game, match: 'a vs b', game_number: n, seats: ['a', 'b'] });
const over = (game: string, winner: string, turns: number) => ({ type: 'game_over', game, winner, turns, end_reason: 'concede' });
const standings = [
  { name: 'a', matchWins: 1, matchLosses: 0, gameWins: 2, gameLosses: 0 },
  { name: 'b', matchWins: 0, matchLosses: 1, gameWins: 0, gameLosses: 2 },
];

function log(middle: Array<Record<string, unknown>>) {
  return [
    { type: 'event_start', best_of: 3, seats: [{ name: 'a', kind: 'agent' }, { name: 'b', kind: 'agent' }] },
    start(G1, 1), snap(G1, 1), over(G1, 'a', 1),
    ...middle,
    { type: 'match_end', a: 'a', b: 'b', wins: { a: 2, b: 0 } },
    { type: 'event_end', standings },
  ].map((e, i) => ({ t: 1000 + i, ...e }));
}
const summary = { standings, matches: [{ a: 'a', b: 'b', wins: { a: 2, b: 0 } }] };

test('a voided game replayed under the same label passes; its snapshots are not mixed with the replay', () => {
  const events = log([
    snap(G2, 1), start(G2, 2), snap(G2, 2), snap(G2, 3), snap(G2, 4),
    { type: 'game_failed', game: G2, void: true, reason: 'reconnect_failed', replay: true },
    { type: 'event_resume' },
    snap(G2, 1), start(G2, 2), snap(G2, 2), over(G2, 'a', 2),
  ]);
  const r = gameConsistency(events as any, summary);
  assert.equal(r.outcome, 'pass', JSON.stringify(r.details ?? r.message));
});

test('a duplicate game_start without a void is still a failure', () => {
  const events = log([start(G2, 2), snap(G2, 1), start(G2, 2), snap(G2, 1), over(G2, 'a', 1)]);
  const r = gameConsistency(events as any, summary);
  assert.equal(r.outcome, 'fail');
  assert.match(JSON.stringify(r.details), /duplicate game_start/);
});

test('a voided game never counts as a win', () => {
  // The voided game "had" a winner in nobody's records; the match must still be decided by real games only.
  const events = log([
    start(G2, 2), { type: 'game_failed', game: G2, void: true, reason: 'connection_lost', replay: true },
    start(G2, 2), over(G2, 'b', 3),
  ]);
  const r = gameConsistency(events as any, summary);
  assert.equal(r.outcome, 'fail', 'match_end says a won 2 but only one real game went to a');
  assert.match(JSON.stringify(r.details), /games say/);
});
