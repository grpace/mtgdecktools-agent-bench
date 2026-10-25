/**
 * Automatic highlights: the "Lethal Setup" note is the decisive play of the final turn, not its last note; never a land
 * drop, pass, forced choice or trivial alpha strike; "Last Stand" only for a real action in a game the seat came back to
 * win; first picks carry their 17Lands numbers.
 *   npx tsx packages/site/src/highlights.test.ts
 */
import assert from 'node:assert/strict';
import type { Ratings } from './data.js';
import { decisivePlay, humanReference, isRealChoice, lastStand, lethalSetup, trivialAttack } from './highlights.js';

const d = (id: string, kind: string, turn: number, choice: string, note: string) => ({ id, kind, turn, answer: { choice, note, accepted: true } });

// Round 1 of the 2026-10-22 audit event: the attack, not the pass to damage after it (nor its trigger's target).
const r1 = [
  d('G62', 'Priority', 10, 'Pass priority', 'Opponent is at 8 with no board; pass the turn and keep Jace alive.'),
  d('G63', 'Priority', 12, 'Pass priority', 'Move to combat: the opponent has no creatures and is at 8, and my four attackers total exactly 8.'),
  d('G64', 'DeclareAttackers', 12, 'Attack with Pia, Determined Rebuilder [#48], Koth, the Geomancer [#51]', 'Attack with everything for exactly 8, lethal against an empty board at 8 life.'),
  d('G65', 'TriggerTargetSelection', 12, 'Target Living Library [#14] (opponent)', "Exile Living Library from the opponent's graveyard to deny recursion value."),
  d('G66', 'Priority', 12, 'Pass priority', 'No blockers; pass to combat damage for the lethal 8.'),
];
assert.equal(decisivePlay(r1, 12)?.id, 'G64');

// Round 2: the burn spell cast for lethal, not the target choice that follows it.
const r2 = [
  d('G95', 'DeclareAttackers', 13, 'Attack with Apex Witchstalker [#25], Gideon the Oathless [#34]', 'Attack with both; the opponent is tapped out.'),
  d('G96', 'Priority', 15, 'Cast No Admittance [#31] {1}{R} (tapping Mountain [#10], Mountain [#15])', 'Opponent is at 2; No Admittance deals 3 to their face for lethal.'),
  d('G97', 'TargetSelection', 15, 'Target player: opponent', 'Target the opponent player for 3 damage at 2 life.'),
];
assert.equal(decisivePlay(r2, 15)?.id, 'G96');

// Only passes and targets on the final turn: no automatic Lethal Setup (curated entries can still name one).
assert.equal(decisivePlay([r1[4]!, r1[3]!], 12), undefined);
// An attack beats an earlier cast on the same turn; among casts, the first one.
assert.equal(decisivePlay([d('A', 'Priority', 9, 'Cast Shock [#3] {R}', 'x'), d('B', 'DeclareAttackers', 9, 'Attack with Bear [#4]', 'y')], 9)?.id, 'B');
assert.equal(decisivePlay([d('A', 'Priority', 9, 'Cast Shock [#3] {R}', 'x'), d('B', 'Priority', 9, 'Cast Lava Axe [#5] {4}{R}', 'y')], 9)?.id, 'A');

// ---------------------------------------------------------------------------
// Real choices only: land drops, passes and single-option (forced) decisions are never a moment.
const v = (o: { id: string; kind: string; turn: number; choice: string; note?: string; options?: string[]; text?: string; life?: { you?: number; opponent?: number } }) =>
  ({ id: o.id, kind: o.kind, turn: o.turn, options: o.options ?? ['a', 'b'], text: o.text ?? '', life: o.life, answer: { choice: o.choice, note: o.note ?? 'x', accepted: true } });
assert.equal(isRealChoice(v({ id: 'L', kind: 'Priority', turn: 5, choice: 'Play land Mountain [#9]' })), false, 'a land drop');
assert.equal(isRealChoice(v({ id: 'P', kind: 'Priority', turn: 5, choice: 'Pass priority' })), false, 'a pass');
assert.equal(isRealChoice(v({ id: 'F', kind: 'Priority', turn: 5, choice: 'Cast Shock [#3] {R}', options: ['Cast Shock [#3] {R}'] })), false, 'one option: forced');
assert.equal(isRealChoice(v({ id: 'C', kind: 'Priority', turn: 5, choice: 'Cast Shock [#3] {R}' })), true);

// Trivial alpha strikes, from the view the agent saw. The 2026-10-21 FRA cb75 game 1, turn 24 (abridged): after Infinite
// Coursework taps Rampart Hunter, the opponent has no untapped creature, so the attack itself is trivial, and the setup
// is the Aura (its note ties it to the kill).
const view = (opp: string[], mine: string[]) =>
  `Turn 24\nOpponent battlefield:\n${opp.map((l) => `  ${l}`).join('\n')}\n  lands (2 untapped): Mountain [#37]\n\nYour battlefield:\n${mine.map((l) => `  ${l}`).join('\n')}\n  lands (4 untapped): Island [#58]\n\nYour hand:\n`;
const mine24 = ['Prudent Fateseer [#64] 1/4', 'Cadet [#128] 2/2', 'Cadet [#133] 2/2', 'Theorix Metamage [#54] 3/3 (Flying)'];
const cb75 = [
  v({ id: 'G125', kind: 'Priority', turn: 24, choice: 'Cast Infinite Coursework [#60] {2}{U} (tapping 53, 46, 65)', life: { you: 8, opponent: 6 },
    note: 'Infinite Coursework locks the only untapped blocker (Rampart Hunter), so my 8 power of attackers faces no blockers against their 6 life.',
    text: view(['Rampart Hunter [#16] 3/3 (Deathtouch) [summoning sick]'], mine24) }),
  v({ id: 'G127', kind: 'DeclareAttackers', turn: 24, choice: 'Attack with Prudent Fateseer [#64], Cadet [#128], Cadet [#133], Theorix Metamage [#54]', life: { you: 8, opponent: 6 },
    note: 'All in for 8 against 6 life with no blockers.', text: view(['Rampart Hunter [#16] 3/3 (Deathtouch) [tapped]'], mine24) }),
];
assert.equal(trivialAttack(cb75[1]!), true, 'no untapped creature on their side');
assert.equal(lethalSetup(cb75, 24)?.id, 'G125', 'the Aura that set up the kill, not the trivial attack');
// The same attack into an untapped 3/3 is a real decision (8 power, 6 life: not twice their life).
const contested = { ...cb75[1]!, text: view(['Rampart Hunter [#16] 3/3 (Deathtouch)'], mine24) };
assert.equal(trivialAttack(contested), false);
assert.equal(lethalSetup([contested], 24)?.id, 'G127');
// Overwhelming: a 13/10 trampler into a 4-life opponent with one blocker (the SOS audit example).
const alpha = v({ id: 'S1', kind: 'DeclareAttackers', turn: 14, choice: 'Attack with Big Beast [#7]', life: { you: 14, opponent: 4 }, note: 'Swing for lethal.',
  text: view(['Bear [#3] 2/2'], ['Big Beast [#7] 13/10 (Trample)']) });
assert.equal(trivialAttack(alpha), true);
assert.equal(lethalSetup([alpha], 14), undefined, 'no setup play that turn: no Lethal Setup at all');
// Round 1 of the audit event above: everything into an empty board is trivial, and nothing set it up.
assert.equal(lethalSetup(r1.map((x) => ({ ...x, options: ['a', 'b'], text: x.kind === 'DeclareAttackers' ? view([], ['Pia, Determined Rebuilder [#48] 4/4', 'Koth, the Geomancer [#51] 4/4']) : '', life: { you: 10, opponent: 8 } })), 12), undefined);

// Structured observations (JSON after the header lines, 2026-10-22 on): the SOS 909e alpha strike, a 13/10 trampler and
// two 4/4s into a 4-life opponent whose only untapped creatures are a 1/1 and a summoning-sick 4/4 flyer.
const json = (opp: unknown[], you: unknown[]) => `[Round 2 of 3] Turn 20, YOUR turn\nEverything you can see, as JSON:\n${JSON.stringify({ state: { battlefield: { opponent: opp, you } } }, null, 1)}\n`;
const sos = v({ id: 'S2', kind: 'DeclareAttackers', turn: 20, life: { you: 14, opponent: 4 }, choice: 'Attack with Tackle Artist [#56], Zealous Lorecaster [#69], Scathing Shadelock [#75]',
  text: json([{ id: 35, card: "Teacher's Pest", pt: '1/1' }, { id: 34, card: 'Sneering Shadewriter', pt: '4/4', sick: true }, { ids: [10, 7], card: 'Swamp', tapped: true }],
    [{ id: 75, card: 'Scathing Shadelock', pt: '4/6' }, { id: 56, card: 'Tackle Artist', pt: '13/10' }, { id: 69, card: 'Zealous Lorecaster', pt: '4/4' }]) });
assert.equal(trivialAttack(sos), true, '21 power into 4 life');
const noBlockers = { ...sos, life: { you: 14, opponent: 20 }, text: json([{ id: 33, card: 'Forest', tapped: true }, { id: 9, card: 'Bear', pt: '2/2', tapped: true }], [{ id: 56, card: 'Tackle Artist', pt: '13/10' }]) };
assert.equal(trivialAttack(noBlockers), true, 'only a tapped creature on their side');
const blocked = { ...sos, life: { you: 14, opponent: 20 } };
assert.equal(trivialAttack(blocked), false, '21 power into 20 life with blockers: a real attack');

// A spell as the final-turn play counts only when its note ties it to the kill.
const cast = (note: string) => v({ id: 'K1', kind: 'Priority', turn: 9, choice: 'Cast Semester Foreseer [#28] {3}{U}', note });
assert.equal(lethalSetup([cast('Cast Semester Foreseer as a 3/4 blocker and surveil before attacking.')], 9), undefined);
assert.equal(lethalSetup([cast('Its ping can take the opponent from 2 to 1 with no blockers involved.')], 9), undefined, 'the board was already empty');
assert.equal(lethalSetup([cast('Destroy the only blocker so my two attackers are lethal.')], 9)?.id, 'K1');
assert.equal(lethalSetup([cast('Burn the face for the last 3 damage.')], 9)?.id, 'K1');

// Last Stand: a real action at 3 life or less, only in a game the seat came back to win.
const low = [
  v({ id: 'A', kind: 'Priority', turn: 16, choice: 'Play land Mountain [#9]', life: { you: 3, opponent: 8 }, note: 'Play the Mountain so I have five mana.' }),
  v({ id: 'B', kind: 'Priority', turn: 16, choice: 'Cast Sureshot Sower [#12] {1}{G}', life: { you: 1, opponent: 17 }, note: 'Kill the flyer.' }),
];
assert.equal(lastStand(low, 17, false), undefined, 'lost the game: survived one turn is not a moment');
assert.equal(lastStand(low, 30, true)?.id, 'B', 'the cast, never the land drop');
assert.equal(lastStand([low[0]!], 30, true), undefined, 'a land drop alone: no Last Stand');
assert.equal(lastStand([v({ id: 'K', kind: 'DeclareBlockers', turn: 9, choice: 'Block: Wall [#2] blocks Ogre [#8]', life: { you: 2, opponent: 9 } })], 20, true)?.id, 'K', 'a block counts');

// First picks carry the 17Lands numbers: the pick's ATA and GIH WR, and the pack's best card when it isn't the pick.
const ratings = { set: 'TLA', cards: new Map([
  ['Meteor Sword', { gih_wr: 0.525, ata: 9.1 }], ['Allies at Last', { gih_wr: 0.593, ata: 3.2 }], ['Plains', { gih_wr: 0.7 }],
]) } as unknown as Ratings;
assert.deepEqual(humanReference(['Meteor Sword', 'Allies at Last', 'Plains', 'Unknown Card'], 'Meteor Sword', ratings),
  { source: '17Lands', ata: 9.1, gih_wr: 0.525, pack_best: { name: 'Allies at Last', gih_wr: 0.593 } });
assert.deepEqual(humanReference(['Meteor Sword', 'Allies at Last'], 'Allies at Last', ratings), { source: '17Lands', ata: 3.2, gih_wr: 0.593, pack_best: null }, 'the best card: no pack_best');
assert.equal(humanReference(['Meteor Sword'], 'Meteor Sword', null), null, 'no 17Lands data for the set');

console.log('highlights tests: ok');
