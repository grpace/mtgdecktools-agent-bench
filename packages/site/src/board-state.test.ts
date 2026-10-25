/**
 * Visual replay boards (export 2.23): the board at a decision, read from the view the agent saw.
 *   npx tsx packages/site/src/board-state.test.ts
 */
import assert from 'node:assert/strict';
import { boardStateOf, firstJsonObject } from './board-state.js';

let n = 0;
const check = (name: string, fn: () => void) => {
  fn();
  n++;
  console.log(`ok   ${name}`);
};

const view = {
  events_since_last: [],
  state: {
    turn: 8, step: 'precombat main', active: 'you', priority: 'you',
    you: { life: 20, hand: 2, library: 29, graveyard: 1, exile: 0 },
    opponent: { life: 17, hand: 3, library: 30, graveyard: 1, exile: 0, poison: 2 },
    hand: [{ id: 40, card: 'Swamp', usable_now: ['play land'] }, { id: 21, card: 'Rampart Hunter' }],
    battlefield: {
      opponent: [{ id: 83, card: 'Jace', token: true, loyalty: 1 }, { ids: [69, 71], card: 'Swamp', tapped: true }],
      you: [{ id: 15, card: 'Vigorbloom Vanguard', pt: '3/3', counters: { '+1/+1': 1 }, keywords: ['Vigilance'], granted: ['Flying'], sick: true }],
    },
    stack: [{ id: 6, top: true, kind: 'spell', controller: 'opponent', card: 'Shock', targets: [{ id: 15, card: 'Vigorbloom Vanguard', controller: 'you' }] }],
    graveyard: { you: [{ id: 37, card: 'Master of Barbs' }], opponent: [{ id: 54, card: 'Last Gasp "quoted" {x}' }] },
    exile: [],
  },
  cards: {},
  decision: { id: 'G52' },
};
const text = `[Round 1 of 3, game 1] Turn 8, YOUR turn\nEverything you can see, as JSON: object ids stay fixed for the whole game\n${JSON.stringify(view, null, 1)}\nDECISION G52 — answer with decide(...)`;

check('maps you/opponent to the seats, expands grouped objects, keeps both public zones and the deciding hand', () => {
  const s = boardStateOf(text, 'seat-a', 'seat-b')!;
  assert.equal(s.turn, 8);
  assert.equal(s.active, 'seat-a');
  assert.deepEqual(Object.keys(s.players).sort(), ['seat-a', 'seat-b']);
  assert.equal(s.players['seat-b']!.life, 17);
  assert.equal(s.players['seat-b']!.poison, 2);
  assert.deepEqual(s.players['seat-b']!.battlefield.map((p) => [p.id, p.card, p.tapped ?? false]), [[83, 'Jace', false], [69, 'Swamp', true], [71, 'Swamp', true]]);
  assert.deepEqual(s.players['seat-a']!.battlefield[0], { id: 15, card: 'Vigorbloom Vanguard', pt: '3/3', counters: { '+1/+1': 1 }, keywords: ['Vigilance', 'Flying'], sick: true });
  assert.deepEqual(s.players['seat-a']!.graveyard, ['Master of Barbs']);
  assert.deepEqual(s.players['seat-b']!.graveyard, ['Last Gasp "quoted" {x}'], 'braces and quotes inside strings');
  assert.deepEqual(s.stack, [{ card: 'Shock', controller: 'seat-b', kind: 'spell', targets: ['Vigorbloom Vanguard'] }]);
  assert.deepEqual(s.hand, { seat: 'seat-a', cards: ['Swamp', 'Rampart Hunter'] });
});

check('a withheld (blank) view or an older text view has no board', () => {
  assert.equal(boardStateOf('', 'a', 'b'), undefined);
  assert.equal(boardStateOf(undefined, 'a', 'b'), undefined);
  assert.equal(boardStateOf('Turn 3. Your hand: Shock, Island. Battlefield: …', 'a', 'b'), undefined);
  assert.equal(firstJsonObject('{"a": "}"', 0), undefined, 'an unfinished object');
});

console.log(`board-state: all ${n} passed`);
