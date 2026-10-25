/**
 * Best of 3 with sideboarding: the integrity checks on `sideboarded` and `play_draw` records (checks.ts
 * sideboardConsistency, playDrawConsistency) and their sanity limits. A synthetic consistent log passes; tampered
 * copies fail; older logs without the records skip.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { playDrawConsistency, sideboardConsistency } from '../src/checks.js';
import { sanityErrors } from '../src/sanity.js';

type Rec = Record<string, any> & { type: string; t: number };

const pool = (p: string) => Array.from({ length: 26 }, (_, i) => `${p} Card ${i + 1}`);
const A = { main: [...pool('Alpha').slice(0, 23), ...Array(9).fill('Island'), ...Array(8).fill('Plains')], sideboard: pool('Alpha').slice(23) };
const B = { main: [...pool('Beta').slice(0, 23), ...Array(9).fill('Swamp'), ...Array(8).fill('Mountain')], sideboard: pool('Beta').slice(23) };
const M = 'a vs b';
const G = (n: number) => `${M} — game ${n}`;
const B2 = { main: [...B.main.filter((c) => c !== 'Beta Card 1'), 'Beta Card 24'], sideboard: [...B.sideboard.filter((c) => c !== 'Beta Card 24'), 'Beta Card 1'] };
const A3 = { main: [...A.main.slice(0, 23), ...Array(8).fill('Island'), ...Array(9).fill('Plains')], sideboard: A.sideboard };

/** a wins game 1 (seed: a on the play); b chooses play and wins game 2; a chooses draw and wins game 3. */
function log(): Rec[] {
  const L: Array<Record<string, any>> = [
    { type: 'event_start', id: 'sb-1', set: { code: 'FRA', name: 'Test' }, best_of: 3, sideboarding: true, play_draw: 'loser-chooses', seats: [{ name: 'a', kind: 'agent', position: 0 }, { name: 'b', kind: 'agent', position: 1 }, { name: 'c', kind: 'agent', position: 2 }] },
    { type: 'deck_built', seat: 'a', by: 'agent', ...A },
    { type: 'deck_built', seat: 'b', by: 'agent', ...B },
    { type: 'play_draw', match: M, game_number: 1, on_play: 'a', by: 'seed', chooser: null, choice: null },
    { type: 'game_start', game: G(1), seats: ['a', 'b'], deck_sizes: { a: 40, b: 40 } },
    { type: 'game_over', game: G(1), winner: 'a', turns: 8, on_play: 'a' },
    { type: 'play_draw', match: M, game_number: 2, on_play: 'b', by: 'agent', chooser: 'b', choice: 'play' },
    { type: 'sideboarded', seat: 'a', match: M, game_number: 2, by: 'agent', kept: true, in: [], out: [], ...A, basics: { Island: 9, Plains: 8 }, main_count: 40, latency_ms: 500 },
    { type: 'sideboarded', seat: 'b', match: M, game_number: 2, by: 'agent', kept: false, in: [{ name: 'Beta Card 24', qty: 1 }], out: [{ name: 'Beta Card 1', qty: 1 }], ...B2, basics: { Swamp: 9, Mountain: 8 }, main_count: 40, latency_ms: 900 },
    { type: 'game_start', game: G(2), seats: ['b', 'a'] },
    { type: 'game_over', game: G(2), winner: 'b', turns: 9, on_play: 'b' },
    { type: 'play_draw', match: M, game_number: 3, on_play: 'b', by: 'agent', chooser: 'a', choice: 'draw' },
    { type: 'sideboarded', seat: 'a', match: M, game_number: 3, by: 'agent', kept: false, in: [{ name: 'Plains', qty: 1 }], out: [{ name: 'Island', qty: 1 }], ...A3, basics: { Island: 8, Plains: 9 }, main_count: 40, latency_ms: 700 },
    { type: 'sideboarded', seat: 'b', match: M, game_number: 3, by: 'forfeit', kept: true, in: [], out: [], ...B2, basics: { Swamp: 9, Mountain: 8 }, main_count: 40, latency_ms: 600000 },
    { type: 'game_start', game: G(3), seats: ['b', 'a'] },
    { type: 'game_over', game: G(3), winner: 'a', turns: 10, on_play: 'b' },
    { type: 'match_end', a: 'a', b: 'b', wins: { a: 2, b: 1 } },
  ];
  return L.map((e, i) => ({ t: 1000 + i, ...e })) as Rec[];
}
const edit = (f: (ev: Rec[]) => void): Rec[] => {
  const ev = structuredClone(log());
  f(ev);
  return ev;
};
const find = (ev: Rec[], type: string, seat: string | null, n: number) => ev.find((e) => e.type === type && (seat == null || e.seat === seat) && e.game_number === n)!;
const pools = new Map([['a', [...pool('Alpha')]], ['b', [...pool('Beta')]]]);

test('a consistent best-of-3 log passes both checks, with or without the replayed draft pools', () => {
  for (const p of [undefined, pools]) {
    const sb = sideboardConsistency(log(), p);
    assert.equal(sb.outcome, 'pass', JSON.stringify(sb.details ?? sb.message));
  }
  const pd = playDrawConsistency(log());
  assert.equal(pd.outcome, 'pass', JSON.stringify(pd.details ?? pd.message));
  assert.match(pd.message, /3 play\/draw decision/);
});

test('older logs without sideboarding or play/draw records skip', () => {
  const old = log().filter((e) => !['sideboarded', 'play_draw'].includes(e.type));
  delete old[0]!.sideboarding;
  delete old[0]!.play_draw;
  assert.equal(sideboardConsistency(old, undefined).outcome, 'skip');
  assert.equal(playDrawConsistency(old).outcome, 'skip');
});

const fails = (ev: Rec[], re: RegExp, which: 'sb' | 'pd' = 'sb') => {
  const r = which === 'sb' ? sideboardConsistency(ev, pools) : playDrawConsistency(ev);
  assert.equal(r.outcome, 'fail', r.message);
  assert.match(JSON.stringify(r.details), re);
};

test('sideboarding: a card from outside the pool fails', () => {
  fails(edit((ev) => { const r = find(ev, 'sideboarded', 'b', 2); r.main[0] = 'Black Lotus'; r.in.push({ name: 'Black Lotus', qty: 1 }); r.out.push({ name: 'Beta Card 2', qty: 1 }); }), /not in the pool/);
});

test('sideboarding: in/out that don\'t match the change from the previous deck fail', () => {
  fails(edit((ev) => { find(ev, 'sideboarded', 'b', 2).in = [{ name: 'Beta Card 25', qty: 1 }]; }), /don't match the change/);
  // Game 3 is relative to the game-2 deck, not the registered one: claiming the registered deck as the base fails.
  fails(edit((ev) => { const r = find(ev, 'sideboarded', 'b', 3); r.kept = false; r.in = [{ name: 'Beta Card 24', qty: 1 }]; r.out = [{ name: 'Beta Card 1', qty: 1 }]; r.by = 'agent'; }), /don't match the change/);
});

test('sideboarding: "kept" with a changed deck, too few cards, and basics added to the sideboard fail', () => {
  fails(edit((ev) => { find(ev, 'sideboarded', 'b', 2).kept = true; }), /kept, but the deck changed/);
  fails(edit((ev) => { const r = find(ev, 'sideboarded', 'a', 2); r.main = r.main.slice(0, 39); r.out = [{ name: 'Plains', qty: 1 }]; r.kept = false; r.main_count = 39; r.basics = { Island: 9, Plains: 7 }; }), /main deck has 39 cards/);
  fails(edit((ev) => { find(ev, 'sideboarded', 'a', 2).sideboard.push('Island'); }), /basic lands added to the sideboard/);
});

test('sideboarding: a duplicate record, a seat outside the match, a missing record, a forfeit that changed the deck fail', () => {
  fails(edit((ev) => { ev.splice(9, 0, { ...structuredClone(find(ev, 'sideboarded', 'b', 2)), t: 1008 }); }), /more than one sideboarded record/);
  fails(edit((ev) => { ev.splice(9, 0, { ...structuredClone(find(ev, 'sideboarded', 'b', 2)), seat: 'c', t: 1008 }); }), /not an agent seat of that match/);
  fails(edit((ev) => { ev.splice(ev.indexOf(find(ev, 'sideboarded', 'a', 3)), 1); }), /a before .*a vs b.* game 3: no sideboarded record/);
  fails(edit((ev) => { const r = find(ev, 'sideboarded', 'a', 3); r.by = 'forfeit'; }), /a forfeit keeps the current deck/);
});

test('play/draw: the chooser must be the previous game\'s loser, and the game must start the way they chose', () => {
  fails(edit((ev) => { find(ev, 'play_draw', null, 2).chooser = 'a'; }), /chooser a, but the loser of the previous game is b/, 'pd');
  fails(edit((ev) => { find(ev, 'play_draw', null, 3).choice = 'play'; }), /a chose to play, but b was on the play/, 'pd');
  fails(edit((ev) => { ev.find((e) => e.type === 'game_over' && e.game === G(3))!.on_play = 'a'; }), /game_over says a/, 'pd');
  fails(edit((ev) => { const r = find(ev, 'play_draw', null, 1); r.by = 'agent'; r.chooser = 'b'; }), /game 1 is decided by the seed/, 'pd');
  fails(edit((ev) => { ev.splice(ev.indexOf(find(ev, 'play_draw', null, 2)), 1); }), /game 2: no play_draw record/, 'pd');
  fails(edit((ev) => { ev.splice(7, 0, { ...find(ev, 'play_draw', null, 2), t: 1006 }); }), /more than one play_draw record/, 'pd');
});

test('play/draw: after a drawn game the previous chooser chooses again (after a drawn game 1, the seat the seed put on the play)', () => {
  const drawn1 = edit((ev) => {
    ev.find((e) => e.type === 'game_over' && e.game === G(1))!.winner = null;
    Object.assign(find(ev, 'play_draw', null, 2), { chooser: 'a', choice: 'draw', on_play: 'b' });
    // Game 3: b won game 2, so a (the loser) chooses.
  });
  const r = playDrawConsistency(drawn1);
  assert.equal(r.outcome, 'pass', JSON.stringify(r.details ?? r.message));
  const drawn2 = edit((ev) => {
    ev.find((e) => e.type === 'game_over' && e.game === G(2))!.winner = null;
    Object.assign(find(ev, 'play_draw', null, 3), { chooser: 'b', choice: 'play', on_play: 'b' });
  });
  assert.equal(playDrawConsistency(drawn2).outcome, 'pass', 'game 2 drawn: b (game 2\'s chooser) chooses again');
  fails(edit((ev) => { ev.find((e) => e.type === 'game_over' && e.game === G(2))!.winner = null; }), /the previous chooser \(the previous game was a draw\) is b/, 'pd');
});

test('a forfeited play/draw choice defaults to play', () => {
  const ok = edit((ev) => Object.assign(find(ev, 'play_draw', null, 2), { by: 'forfeit', choice: 'play' }));
  assert.equal(playDrawConsistency(ok).outcome, 'pass');
  fails(edit((ev) => Object.assign(find(ev, 'play_draw', null, 2), { by: 'forfeit', choice: 'draw', on_play: 'a' })), /a forfeit defaults to play/, 'pd');
});

test('sanity: the new records must have the Director\'s types and sizes', () => {
  const files = (ev: Rec[]) => new Map([['events.jsonl', Buffer.from(ev.map((e) => JSON.stringify(e)).join('\n'))]]);
  assert.deepEqual(sanityErrors(files(log())), []);
  assert.ok(sanityErrors(files(edit((ev) => { find(ev, 'sideboarded', 'a', 2).main = 'Island'; }))).some((e) => /main must be a list/.test(e)));
  assert.ok(sanityErrors(files(edit((ev) => { find(ev, 'sideboarded', 'b', 2).in = [{ name: 'X', qty: -2 }]; }))).some((e) => /in qty/.test(e)));
  assert.ok(sanityErrors(files(edit((ev) => { find(ev, 'play_draw', null, 2).on_play = 42; }))).some((e) => /on_play must be a string/.test(e)));
  assert.ok(sanityErrors(files(edit((ev) => { ev[0]!.sideboarding = 'yes'; }))).some((e) => /sideboarding must be true or false/.test(e)));
  assert.ok(sanityErrors(files(edit((ev) => { ev.find((e) => e.type === 'game_start')!.deck_sizes = { a: 'forty' }; }))).some((e) => /deck_sizes/.test(e)));
});
