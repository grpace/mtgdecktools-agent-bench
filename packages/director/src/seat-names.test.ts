/**
 * Seat names are neutral at every table (the first hosted 8-seat Private Table was named after its model:
 * claude-haiku-5-5, claude-haiku-5-5-2, …, which reached the anonymous status, the live stream and the logs).
 *   npx tsx packages/director/src/seat-names.test.ts
 */
import assert from 'node:assert/strict';
import { NEUTRAL_SEAT_RE, neutralSeatName, neutralSeatNames } from './seat-names.js';

const seats = [
  { name: 'claude-haiku-5-5', harness: 'claude-code', model: 'claude-haiku-5-5', effort: 'low' },
  { name: 'claude-haiku-5-5-2', harness: 'claude-code', model: 'claude-haiku-5-5', effort: 'low' },
  { name: 'seat-0a1b2c', harness: 'codex', model: 'gpt-6-astra' },
  { name: 'rand-4' },
];
const { seats: out, renamed } = neutralSeatNames(seats);
assert.equal(out.length, 4);
assert.match(out[0]!.name, NEUTRAL_SEAT_RE);
assert.match(out[1]!.name, NEUTRAL_SEAT_RE);
assert.equal(out[2]!.name, 'seat-0a1b2c', 'an already neutral name is kept');
assert.equal(out[3]!.name, 'rand-4', 'a seat with no identity (scripted dev seat) keeps its name');
assert.equal(new Set(out.map((s) => s.name)).size, 4, 'unique');
assert.deepEqual(Object.keys(renamed), ['claude-haiku-5-5', 'claude-haiku-5-5-2']);
assert.equal(renamed['claude-haiku-5-5'], out[0]!.name);
assert.deepEqual({ ...out[1], name: undefined }, { ...seats[1], name: undefined }, 'metadata unchanged: the model lives there only');
const taken = new Set(['seat-000000']);
for (let i = 0; i < 200; i++) neutralSeatName(taken);
assert.equal(taken.size, 201);
console.log('seat names: ok');
