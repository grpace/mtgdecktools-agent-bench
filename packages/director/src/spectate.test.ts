/**
 * Fairness tests for the spectator view: nothing private is released before its condition holds.
 *   npx tsx packages/director/src/spectate.test.ts
 */
import assert from 'node:assert/strict';
import { Spectator, type SpectatorMsg } from './spectate.js';
import { DEFAULT_SPECTATE_POLICY, redactCards, spectatePolicyFromEnv, type SpectatePolicy } from './spectate-policy.js';

let clock = 1_000_000;
const now = () => clock;
let t = 0;
const rec = (type: string, data: Record<string, unknown> = {}) => ({ t: ++t, type, ...data });

/** Most tests run without the broadcast delay (its own tests below). */
const NO_DELAY: SpectatePolicy = { ...DEFAULT_SPECTATE_POLICY, delayMs: 0 };

function pod(policy: SpectatePolicy = NO_DELAY): { sp: Spectator; all: () => SpectatorMsg[]; of: (type: string) => SpectatorMsg[] } {
  const sp = new Spectator('ev', policy, now);
  const all = () => sp.since(0).messages;
  return { sp, all, of: (type) => all().filter((m) => m.type === type) };
}

const seats = [
  { name: 'alice', kind: 'agent', position: 0 },
  { name: 'bot-2', kind: 'bot', position: 1 },
  { name: 'bob', kind: 'agent', position: 2 },
  { name: 'bot-4', kind: 'bot', position: 3 },
];

function draft(sp: Spectator, rounds = 2, size = 2): void {
  for (let r = 1; r <= rounds; r++) {
    sp.ingest(rec('packs_opened', { round: r, packs: seats.map(() => Array.from({ length: size }, (_, i) => `Card ${r}-${i}`)), swaps: [{ from: 'Broken', to: `Card ${r}-0` }] }));
    for (let k = 1; k <= size; k++) {
      for (const s of seats) {
        sp.ingest(rec('draft_pick', { seat: s.name, pack_number: r, pick_number: k, overall_pick: (r - 1) * size + k, pack: [`Card ${r}-0`], pick: `Card ${r}-0`, by: s.kind, note: `${s.name} note ${r}.${k}` }));
        if (r === 1 && k === 1) {
          // Mid-round: nothing about round 1 is public yet (except that a pick was made).
          assert.equal(sp.since(0).messages.filter((m) => m.type === 'draft_pick').length, 0, 'no pick before its round ends');
          assert.equal(sp.since(0).messages.filter((m) => m.type === 'swaps').length, 0, 'no swaps before the round ends');
        }
      }
    }
  }
  sp.ingest(rec('draft_end'));
}

// --- round policy: picks of round 1 appear when round 1 is complete, not before -------------------------
{
  const { sp, of } = pod();
  sp.ingest(rec('event_start', { set: { code: 'fra', name: 'Test' }, seed: 'secret-seed', seats, best_of: 3 }));
  assert.equal((sp.hello().event as Record<string, unknown>).seed, undefined, 'seed hidden while live');
  sp.ingest(rec('packs_opened', { round: 1, packs: seats.map(() => ['A', 'B']), swaps: [] }));
  for (const s of seats) sp.ingest(rec('draft_pick', { seat: s.name, pack_number: 1, pick_number: 1, overall_pick: 1, pack: ['A', 'B'], pick: 'A', by: s.kind, note: 'n' }));
  assert.equal(of('draft_pick').length, 0, 'half a round: no picks');
  assert.equal(of('draft_progress').length, 4, 'progress is live');
  assert.ok(of('draft_progress').every((m) => m.card === undefined && m.contents === undefined), 'progress never names cards');
  for (const s of seats) sp.ingest(rec('draft_pick', { seat: s.name, pack_number: 1, pick_number: 2, overall_pick: 2, pack: ['B'], pick: 'B', by: 'forced' }));
  assert.equal(of('draft_pick').length, 8, 'round complete: all its picks');
  assert.equal(of('draft_progress').length, 0, 'progress superseded by the picks');
}

// --- decks, and notes never streamed (an older log carries them) ---------------------------------------------------------------------------------
{
  const { sp, of } = pod();
  sp.ingest(rec('event_start', { set: { code: 'fra', name: 'Test' }, seed: 's', seats, best_of: 3 }));
  draft(sp);
  sp.ingest(rec('deck_built', { seat: 'alice', by: 'agent', main: ['Shock', 'Grizzly Bears', 'Mountain'], sideboard: ['Giant Growth'], note: 'RG beats' }));
  sp.ingest(rec('deck_built', { seat: 'bob', by: 'agent', main: ['Cancel', 'Island'], sideboard: [] }));
  sp.ingest(rec('build_end'));
  assert.equal(of('deck').length, 0, 'decklists hidden while the seat still plays');
  assert.equal(of('deck_submitted').length, 2);
  const G = 'alice vs bob — game 1';
  sp.ingest(rec('game_start', { game: G, seats: ['alice', 'bob'], match: 'alice vs bob', game_number: 1 }));
  sp.ingest(rec('decision_offered', { game: G, seat: 'alice', id: 'G1', kind: 'Priority', turn: 3, text: 'Your hand: Shock [#5] …' }));
  sp.ingest(rec('agent_decision', { game: G, seat: 'alice', id: 'G1', kind: 'Priority', turn: 3, choice: 'Pass priority', note: 'Holding Shock [#5] for their flyer; Giant Growth later', accepted: true }));
  assert.equal(of('decision').length, 0, 'decision hidden in its own turn');
  sp.ingest(rec('decision_offered', { game: G, seat: 'bob', id: 'G1', kind: 'Priority', turn: 4 }));
  assert.equal(of('decision').length, 0, 'still hidden one turn later');
  sp.board(G, { turn: 5, phase: 'Main', active: 'alice', priority: 'alice', players: { alice: { life: 20, hand: 5, library: 30, graveyard: ['Grizzly Bears'], exile: [], battlefield: [] }, bob: { life: 18, hand: 6, library: 30, graveyard: [], exile: [], battlefield: [] } }, stack: [], combat: [] });
  const dec = of('decision');
  assert.equal(dec.length, 1, 'released two turns later');
  assert.equal(dec[0]!.full, false);
  assert.equal('note' in dec[0]!, false, 'a logged note is never streamed');
  assert.ok(!JSON.stringify(of('decision')).includes('Giant Growth'), 'nor what it said');
  sp.ingest(rec('game_over', { game: G, winner: 'alice', turns: 6 }));
  assert.equal(of('decision')[0]!.full, false, 'default policy: game over is not enough while alice still has games');
  sp.ingest(rec('match_end', { a: 'alice', b: 'bob', wins: { alice: 2, bob: 0 } }));
  assert.equal(of('decision')[0]!.full, true, 'seat done: released in full');
  assert.equal('note' in of('decision')[0]!, false, 'still without a note');
  assert.equal(of('deck').length, 2, 'decks released when the seats are done');
  assert.equal(of('deck_submitted').length, 0, 'superseded by the decklists');
}

// --- choices about hidden cards stay hidden whole --------------------------------------------------------
{
  const { sp, of } = pod();
  sp.ingest(rec('event_start', { set: { code: 'fra', name: 'Test' }, seed: 's', seats, best_of: 3 }));
  draft(sp);
  sp.ingest(rec('deck_built', { seat: 'alice', by: 'agent', main: ['Mountain', 'Shock'], sideboard: [] }));
  sp.ingest(rec('deck_built', { seat: 'bob', by: 'agent', main: ['Island'], sideboard: [] }));
  const G = 'alice vs bob — game 1';
  sp.ingest(rec('game_start', { game: G, seats: ['alice', 'bob'] }));
  sp.ingest(rec('card_played', { game: G, seat: 'alice', card: 'Mountain' }));
  sp.ingest(rec('agent_decision', { game: G, seat: 'alice', id: 'G2', kind: 'MulliganDecision', turn: 1, choice: 'Select: Mountain [#5]', note: 'bottom the extra Mountain', accepted: true }));
  sp.ingest(rec('agent_decision', { game: G, seat: 'alice', id: 'G3', kind: 'MulliganDecision', turn: 1, choice: 'Keep this hand', note: 'two lands', accepted: true }));
  sp.ingest(rec('decision_offered', { game: G, seat: 'bob', id: 'G9', kind: 'Priority', turn: 3 }));
  const [bottom, keep] = of('decision');
  assert.equal(bottom!.choice, 'A choice about hidden cards', `bottomed card hidden even though Mountain is public: ${bottom!.choice}`);
  assert.equal(bottom!.note, undefined, 'its note too');
  assert.equal(keep!.choice, 'Keep this hand', 'keep/mulligan is public');
}

// --- strict draft policy -------------------------------------------------------------------------------
{
  const { sp, of } = pod({ ...NO_DELAY, draft: 'seat' });
  sp.ingest(rec('event_start', { set: { code: 'fra', name: 'Test' }, seed: 's', seats, best_of: 3 }));
  draft(sp);
  assert.ok(of('draft_pick').length > 0 && of('draft_pick').every((m) => String(m.seat).startsWith('bot')), 'seat policy: only bot picks after the draft');
  sp.ingest(rec('match_end', { a: 'alice', b: 'bob', wins: { alice: 1, bob: 2 } }));
  assert.equal(of('draft_pick').length, 16, 'all picks once both agents are done');
}

// --- broadcast delay -------------------------------------------------------------------------------------
{
  const { sp, of } = pod({ ...DEFAULT_SPECTATE_POLICY, delayMs: 30_000 });
  sp.ingest(rec('event_start', { set: { code: 'fra', name: 'Test' }, seed: 's', seats, best_of: 3 }));
  sp.ingest({ t: clock, type: 'game_start', game: 'g', seats: ['alice', 'bob'] });
  assert.equal(of('game_start').length, 0, 'delayed');
  clock += 31_000;
  sp.flush();
  assert.equal(of('game_start').length, 1, 'released after the delay');
  sp.close();
}

// --- the broadcast delay holds turn-based note releases too (notes never run ahead of the delayed board) -----
{
  const { sp, of } = pod({ ...DEFAULT_SPECTATE_POLICY, delayMs: 60_000 });
  sp.ingest(rec('event_start', { set: { code: 'fra', name: 'Test' }, seed: 's', seats, best_of: 3 }));
  draft(sp);
  sp.ingest(rec('deck_built', { seat: 'alice', by: 'agent', main: ['Mountain'], sideboard: [] }));
  sp.ingest(rec('deck_built', { seat: 'bob', by: 'agent', main: ['Island'], sideboard: [] }));
  const G = 'alice vs bob — game 1';
  sp.ingest({ t: clock, type: 'game_start', game: G, seats: ['alice', 'bob'] });
  sp.ingest({ t: clock, type: 'agent_decision', game: G, seat: 'alice', id: 'G1', kind: 'Priority', turn: 3, choice: 'Pass priority', note: 'waiting', accepted: true });
  const board = (turn: number) => ({ turn, phase: 'Main', active: 'alice', priority: 'alice', players: { alice: { life: 20, hand: 5, library: 30, graveyard: [], exile: [], battlefield: [] }, bob: { life: 20, hand: 6, library: 30, graveyard: [], exile: [], battlefield: [] } }, stack: [], combat: [] });
  sp.board(G, board(5));
  assert.equal(of('decision').length, 0, 'turn 5 reached, but the delay holds the note with the board');
  assert.equal(of('board').length, 0, 'board delayed');
  clock += 61_000;
  sp.flush();
  assert.equal(of('board').length, 1, 'board released after the delay');
  assert.equal(of('decision').length, 1, 'and the note with it');
  sp.close();
}

// --- seat identities (harness, model) are released with the seat, never live -------------------------------
{
  const { sp, of } = pod();
  const named = [{ name: 'seat-a1b2c3', kind: 'agent', position: 0, harness: 'claude-code', model: 'claude-opus-5-5' }, { name: 'seat-d4e5f6', kind: 'agent', position: 1, harness: 'codex', model: 'gpt-6-astra' }];
  sp.ingest(rec('event_start', { set: { code: 'fra', name: 'Test' }, seed: 's', seats: named, best_of: 1, pairing: { format: 'swiss', rounds: 1, version: 1 } }));
  const hello = () => JSON.stringify(sp.hello());
  assert.ok(!hello().includes('claude-opus-5-5') && !hello().includes('codex'), 'no models or harnesses while the seats play');
  sp.ingest(rec('round_start', { round: 1, rounds: 1, format: 'swiss', pairs: [['seat-a1b2c3', 'seat-d4e5f6']], byes: [] }));
  sp.ingest(rec('match_end', { a: 'seat-a1b2c3', b: 'seat-d4e5f6', wins: { 'seat-a1b2c3': 1, 'seat-d4e5f6': 0 } }));
  assert.ok(hello().includes('claude-opus-5-5') && hello().includes('gpt-6-astra'), 'released once the seats are done');
  assert.ok(of('release').some((m) => m.what === 'seat' && m.model === 'claude-opus-5-5'), 'the release message carries the identity');
}

// --- SPEC-1: a face-down permanent named in an (old-log) turn snapshot never becomes public --------------
{
  const { sp, of } = pod();
  sp.ingest(rec('event_start', { set: { code: 'fra', name: 'Test' }, seed: 's', seats, best_of: 3 }));
  draft(sp);
  sp.ingest(rec('deck_built', { seat: 'alice', by: 'agent', main: ['Granite Witness', 'Plains'], sideboard: [] }));
  sp.ingest(rec('deck_built', { seat: 'bob', by: 'agent', main: ['Island'], sideboard: [] }));
  const G = 'alice vs bob — game 1';
  sp.ingest(rec('game_start', { game: G, seats: ['alice', 'bob'] }));
  sp.ingest(rec('agent_decision', { game: G, seat: 'alice', id: 'G5', kind: 'Priority', turn: 3, choice: 'Cast Granite Witness [#54] face down (disguise)', card: 'Granite Witness', note: 'Granite Witness hides as a 2/2 ward', accepted: true }));
  // Logs written before the fix: the host's projection names its own face-down creature.
  sp.ingest(rec('turn_snapshot', { game: G, turn: 4, active: 'bob', players: { alice: { life: 20, permanents: ['Granite Witness 2/2'] }, bob: { life: 20, permanents: [] } } }));
  const facedown = { id: 54, name: 'Face-down card', land: false, creature: true, face_down: true, pt: '2/2' };
  const b = (turn: number) => ({ turn, phase: 'Main', active: 'alice', priority: 'alice', players: { alice: { life: 20, hand: 5, library: 30, graveyard: [], exile: [], battlefield: [facedown] }, bob: { life: 20, hand: 6, library: 30, graveyard: [], exile: [], battlefield: [] } }, stack: [], combat: [] });
  sp.board(G, b(5));
  sp.board(G, b(6));
  const dec = of('decision');
  assert.equal(dec.length, 1, 'note released by turn');
  for (const f of [dec[0]!.choice, dec[0]!.note, dec[0]!.card]) assert.ok(!String(f ?? '').includes('Granite Witness'), `still face down, still hidden: ${f}`);
  assert.equal(dec[0]!.redacted, true);
  assert.equal(of('snapshot').length, 0, 'no snapshot frame while the game runs');
  assert.ok(!JSON.stringify(of('board')).includes('Granite Witness'));
}

// --- redaction helper and env parsing ----------------------------------------------------------------
{
  assert.deepEqual(redactCards('Cast Fire [#3] then Ice', ['Fire // Ice']), { text: 'Cast [hidden card] then [hidden card]', redacted: true });
  assert.equal(redactCards('Firebreathing dragon', ['Fire']).text, 'Firebreathing dragon', 'whole words only');
  assert.equal(redactCards('no cards here', []).redacted, false);
  const p = spectatePolicyFromEnv({ SPECTATE: 'admin', SPECTATE_DRAFT: 'bogus', SPECTATE_NOTES: '3', SPECTATE_HIDDEN: 'game' });
  assert.equal(p.access, 'admin');
  assert.equal(p.draft, 'round', 'unknown values fall back to the default');
  assert.deepEqual(p.notes, { turns: 3 });
  assert.equal(p.hidden, 'game');
  assert.equal(spectatePolicyFromEnv({}).delayMs, 90_000, 'SPEC-3: a broadcast delay when nothing is configured');
  assert.equal(spectatePolicyFromEnv({ SPECTATE_DELAY_S: '0' }).delayMs, 0, 'local runs can turn it off');
  assert.equal(spectatePolicyFromEnv({ SPECTATE_DELAY_S: 'bogus' }).delayMs, 90_000, 'bad values keep the safe default');
}

// --- Swiss: a seat's deck is released when its last paired match ends, not after agents − 1 matches -------
{
  const { sp, of } = pod({ ...NO_DELAY });
  const four = ['a', 'b', 'c', 'd'].map((name, i) => ({ name, kind: 'agent', position: i }));
  sp.ingest(rec('event_start', { set: { code: 'fra', name: 'Test' }, seed: 's', seats: four, best_of: 1, pairing: { format: 'swiss', rounds: 2, version: 1 } }));
  for (const s of four) sp.ingest(rec('deck_built', { seat: s.name, by: 'agent', main: ['X'], sideboard: [] }));
  sp.ingest(rec('build_end'));
  const released = () => of('release').filter((m) => m.what === 'seat').map((m) => m.seat);
  sp.ingest(rec('round_start', { round: 1, rounds: 2, format: 'swiss', pairs: [['a', 'b'], ['c', 'd']], byes: [] }));
  sp.ingest(rec('match_end', { a: 'a', b: 'b', wins: { a: 1, b: 0 } }));
  sp.ingest(rec('match_end', { a: 'c', b: 'd', wins: { c: 1, d: 0 } }));
  assert.deepEqual(released(), [], 'nobody is done before the last round is paired');
  sp.ingest(rec('round_start', { round: 2, rounds: 2, format: 'swiss', pairs: [['a', 'c'], ['b', 'd']], byes: [] }));
  sp.ingest(rec('match_end', { a: 'a', b: 'c', wins: { a: 1, c: 0 } }));
  assert.deepEqual(released().sort(), ['a', 'c'], 'a and c have played both rounds (b and d still play)');
  sp.ingest(rec('match_end', { a: 'b', b: 'd', wins: { b: 1, d: 0 } }));
  sp.ingest(rec('event_end', { standings: [] }));
  assert.deepEqual(released().sort(), ['a', 'b', 'c', 'd'], 'each seat released exactly once');
}

// --- standings, a seat's "done" and its release wait for the broadcast delay, like the results they carry ------
{
  const { sp, of } = pod({ ...DEFAULT_SPECTATE_POLICY, delayMs: 90_000 });
  const two = ['a', 'b'].map((name, i) => ({ name, kind: 'agent', position: i }));
  sp.ingest({ t: clock, type: 'event_start', set: { code: 'fra', name: 'Test' }, seed: 's', seats: two, best_of: 1, pairing: { format: 'swiss', rounds: 1, version: 1 } });
  sp.ingest({ t: clock, type: 'build_end' });
  sp.ingest({ t: clock, type: 'round_start', round: 1, rounds: 1, format: 'swiss', pairs: [['a', 'b']], byes: [] });
  const G = 'a vs b — game 1';
  sp.ingest({ t: clock, type: 'game_start', game: G, seats: ['a', 'b'] });
  sp.ingest({ t: clock, type: 'game_over', game: G, winner: 'a', turns: 9 });
  sp.ingest({ t: clock, type: 'match_end', a: 'a', b: 'b', wins: { a: 1, b: 0 } });
  sp.seatPending('a', undefined, true);
  // The first hosted 8-seat table sent standings at 0 s, about 90 s before the delayed game_over.
  const results = () => ['game_over', 'match_end', 'standings'].map((x) => of(x).length);
  assert.deepEqual(results(), [0, 0, 0], 'no result of any kind before the delay');
  assert.equal(of('release').filter((m) => m.what === 'seat').length, 0, 'the seat is not shown done before its last result');
  assert.equal(of('seat_status').filter((m) => m.state === 'done').length, 0, 'nor its status');
  clock += 60_000;
  sp.flush();
  assert.deepEqual(results(), [0, 0, 0], 'still held at 60 s');
  clock += 31_000;
  sp.flush();
  assert.deepEqual(results(), [1, 1, 1], 'all released together after the delay');
  const order = sp.since(0).messages.map((m) => m.type).filter((x) => ['game_over', 'standings', 'release'].includes(x));
  assert.ok(order.indexOf('game_over') < order.indexOf('standings'), 'standings never ahead of the game result');
  assert.equal((of('standings')[0]!.standings as any[])[0].name, 'a');
  assert.deepEqual(of('release').filter((m) => m.what === 'seat').map((m) => m.seat).sort(), ['a', 'b'], 'both seats done, once');
  assert.equal(of('seat_status').filter((m) => m.state === 'done').length, 1);
  sp.close();
}

console.log('spectate tests: ok');
