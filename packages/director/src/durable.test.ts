/**
 * Durability: a draft cut at any point and resumed from its log continues exactly as if nothing happened, and the
 * log helpers rebuild what a resumed event needs.
 *   npx tsx packages/director/src/durable.test.ts      (the draft test needs data/draft-pools.json and data/card-data.json)
 */
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { BoosterFactory } from './boosters.js';
import { CardDb } from './cards.js';
import { Draft, ResumeMismatch } from './draft.js';
import { deckFromLog, gameResume, readCheckpoint, readLog, repairLog, resumeLog, writeCheckpoint, type EventCheckpoint, type Raw } from './durable.js';
import { Ratings } from './ratings.js';
import { Rng } from './rng.js';
import { AgentSeat } from './seat.js';

const root = resolve(import.meta.dirname, '../../..');
let passed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  await fn();
  passed++;
  console.log(`ok - ${name}`);
}

// ---------------------------------------------------------------------------
// Draft replay

const data = join(root, 'data');
const haveData = existsSync(join(data, 'draft-pools.json')) && existsSync(join(data, 'card-data.json'));
const unsupported = existsSync(join(data, 'unsupported-cards.json')) ? (JSON.parse(readFileSync(join(data, 'unsupported-cards.json'), 'utf8')).unsupported as string[]) : [];

/** Agents that answer deterministically from what they see (so two runs make the same picks). */
function answerer(seats: AgentSeat[], stopAfter = Infinity): { stop: () => void; picks: () => number } {
  let running = true;
  let picks = 0;
  for (const s of seats.filter((x) => x.kind === 'agent')) {
    void (async () => {
      while (running) {
        const o = s.pending;
        if (!o) {
          await new Promise((r) => setTimeout(r, 1));
          continue;
        }
        if (picks >= stopAfter) {
          await new Promise((r) => setTimeout(r, 5));
          continue;
        }
        const h = [...o.options.map((x) => x.label).join('|')].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
        picks++;
        await s.decide({ decision_id: o.id, option: String((h % o.options.length) + 1) });
      }
    })();
  }
  return { stop: () => (running = false), picks: () => picks };
}

function table(): AgentSeat[] {
  return [...Array(8).keys()].map((i) => (i === 2 || i === 5 ? new AgentSeat(`agent-${i}`, i, 'agent') : new AgentSeat(`bot-${i + 1}`, i, 'bot')));
}

if (haveData) {
  const factory = new BoosterFactory(join(data, 'draft-pools.json'), unsupported);
  const cards = new CardDb(join(data, 'card-data.json'), data);
  const ratings = new Ratings(join(root, 'sets'), 'fra');
  const knowledge = { level: 'none' as const, stats: false };
  const strip = (r: Raw) => {
    const { t: _t, latency_ms: _l, ...rest } = r;
    return JSON.stringify(rest);
  };

  async function fullDraft(seed: string): Promise<{ records: Raw[]; pools: string[][] }> {
    const records: Raw[] = [];
    const seats = table();
    const ans = answerer(seats);
    const d = new Draft('fra', factory, cards, ratings, seats, new Rng(seed), (type, x) => records.push({ t: Date.now(), type, ...x }), knowledge);
    const pools = await d.run();
    ans.stop();
    return { records, pools: pools.map((p) => p.map((c) => c.name)) };
  }

  const reference = await fullDraft('durable-test-1');

  for (const cut of [1, 9, 40, 200, reference.records.length - 3]) {
    await test(`draft cut after ${cut} log records resumes to the same picks, pools and log`, async () => {
      const before = reference.records.slice(0, cut);
      const log = resumeLog(before);
      const seats = table();
      const added: Raw[] = [];
      const ans = answerer(seats);
      const d = new Draft('fra', factory, cards, ratings, seats, new Rng('durable-test-1'), (type, x) => added.push({ t: Date.now(), type, ...x }), knowledge, 3, log.draft);
      const pools = await d.run();
      ans.stop();
      assert.deepEqual(pools.map((p) => p.map((c) => c.name)), reference.pools);
      // Agents answer in any order within a pick, so compare the records as multisets.
      assert.deepEqual([...before, ...added].map(strip).sort(), reference.records.map(strip).sort(), 'the resumed log equals the uninterrupted one, nothing logged twice');
      assert.equal(log.draft.picks.size, 0, 'every logged pick was replayed');
    });
  }

  await test('a log from other booster data is refused (ResumeMismatch), not silently continued', async () => {
    const log = resumeLog(reference.records.slice(0, 50));
    const seats = table();
    const ans = answerer(seats);
    const d = new Draft('fra', factory, cards, ratings, seats, new Rng('another-seed'), () => {}, knowledge, 3, log.draft);
    await assert.rejects(d.run(), ResumeMismatch);
    ans.stop();
  });

  await test('decision ids continue above every id handed out before the restart', () => {
    const log = resumeLog(reference.records.slice(0, 120));
    const agentPicks = reference.records.slice(0, 120).filter((r) => r.type === 'draft_pick' && r.seat === 'agent-2' && r.by === 'agent').length;
    assert.equal(log.lastIds.get('agent-2'), agentPicks + 1);
  });
} else {
  console.log('skip - draft replay tests (no data/draft-pools.json or data/card-data.json)');
}

// ---------------------------------------------------------------------------
// Log helpers

await test('repairLog cuts a partial last line; complete logs are untouched', () => {
  const dir = mkdtempSync(join(tmpdir(), 'durable-'));
  const f = join(dir, 'events.jsonl');
  writeFileSync(f, '{"t":1,"type":"a"}\n{"t":2,"type":"b"}\n');
  assert.equal(repairLog(f), 0);
  appendFileSync(f, '{"t":3,"ty');
  assert.equal(repairLog(f), 10);
  assert.equal(statSync(f).size, 38);
  assert.deepEqual(readLog(f).map((r) => r.type), ['a', 'b']);
  rmSync(dir, { recursive: true });
});

await test('checkpoint round-trips and is private (mode 600)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'durable-'));
  const cp: EventCheckpoint = {
    version: 1, id: 'ev-1', status: 'running', owner: { kind: 'contributor', id: 3, handle: 'dee' }, weight: 1, created_at: 1,
    request: { set: 'fra', agents: [{ name: 'a', harness: 'h', model: 'm' }, { name: 'b' }], seed: 's', knowledge: 'primer', mana: 'manual', bestOf: 3, podSize: 8 },
    tokens: { a: 'f'.repeat(32), b: 'e'.repeat(32) }, games: {}, seats: {},
  };
  writeCheckpoint(dir, cp);
  assert.deepEqual(readCheckpoint(dir), cp);
  assert.equal(statSync(join(dir, 'state.json')).mode & 0o777, 0o600);
  rmSync(dir, { recursive: true });
});

await test('a seat keeps its token across a restart', () => {
  const s = new AgentSeat('a', 0, 'agent', 'ab'.repeat(16));
  assert.equal(s.token, 'ab'.repeat(16));
  assert.match(new AgentSeat('b', 1, 'agent', 'not-a-token').token, /^[0-9a-f]{32}$/);
});

let t = 0;
const r = (type: string, x: Record<string, unknown> = {}): Raw => ({ t: ++t, type, ...x });
const G1 = 'a vs b — game 1';
const G2 = 'a vs b — game 2';
const games: Raw[] = [
  r('event_start', { seats: [] }),
  r('deck_built', { seat: 'a', by: 'agent', main: ['Island', 'Card X', 'Island'], sideboard: ['Card Y'] }),
  r('build_end'),
  r('game_start', { game: G1, seats: ['a', 'b'] }),
  r('decision_offered', { game: G1, seat: 'b', id: 'G30', turn: 1, active: 'opponent' }),
  r('agent_decision', { game: G1, seat: 'b', id: 'G30', kind: 'MulliganDecision', choice: 'Mulligan', accepted: true }),
  r('game_over', { game: G1, winner: 'a', turns: 9, stats: {} }),
  r('turn_snapshot', { game: G2, turn: 1 }),
  r('game_start', { game: G2, seats: ['b', 'a'] }),
  r('decision_offered', { game: G2, seat: 'a', id: 'G41', turn: 1, active: 'you' }),
  r('agent_decision', { game: G2, seat: 'a', id: 'G41', kind: 'Priority', choice: 'Cast Card X (tapping Island [#3])', accepted: true }),
  r('card_played', { game: G2, seat: 'a', card: 'Card X', how: 'cast' }),
  r('auto_pass', { game: G2, seat: 'b' }),
  r('turn_snapshot', { game: G2, turn: 2 }),
];

await test('resumeLog: finished games, the game in progress, ids', () => {
  const log = resumeLog(games);
  assert.equal(log.started, true);
  assert.equal(log.buildEnded, true);
  assert.equal(log.games.get(G1)?.over?.winner, 'a');
  assert.ok(log.games.get(G2)?.start && !log.games.get(G2)?.over);
  assert.equal(log.lastIds.get('a'), 41);
  assert.equal(log.lastIds.get('b'), 30);
  assert.ok(log.active.has('a') && log.active.has('b'));
});

await test('gameResume rebuilds counters, cards played, the player on the play and the last snapshot', () => {
  const log = resumeLog(games);
  const sess = { code: 'ABC', players: [{ seat: 'b', token: 't1', full_key: { game_code: 'ABC', generation: 1 } }, { seat: 'a', token: 't2', full_key: { game_code: 'ABC', generation: 1 } }] };
  const gr = gameResume(log.games.get(G2)!, sess, []);
  assert.equal(gr.onPlay, 'a');
  assert.equal(gr.lastSnapshotTurn, 2);
  assert.deepEqual(gr.counters.a, { decisions: 1, manualPayments: 1 });
  assert.deepEqual(gr.counters.b, { autoPasses: 1 });
  assert.deepEqual(gr.played.a, { cast: { 'Card X': 1 }, activated: {} });
  const g1 = gameResume(log.games.get(G1)!, sess, [{ t: 1, type: 'forfeit', stage: 'game', game: G1, seat: 'b' }]);
  assert.equal(g1.counters.b?.mulligans, 1);
  assert.equal(g1.forfeitedBy, 'b');
});

await test('gameResume counts the payment counters as the live game does (pool payments, mana abilities in a payment)', () => {
  const G3 = 'a vs b — game 3';
  const recs: Raw[] = [
    r('game_start', { game: G3, seats: ['a', 'b'] }),
    // A mana creature picked in the payment, then the pool paid: the agent's own payment, not the auto-tapper.
    r('agent_decision', { game: G3, seat: 'a', id: 'G50', kind: 'ManaPayment', choice: 'Activate Noxious Newt [#19]: {T}: Add {G}.', accepted: true }),
    r('pay_finish', { game: G3, seat: 'a', action: 'PassPriority', ok: true, from_pool: true, by_hand: true }),
    r('pay_color', { game: G3, seat: 'a', action: 'ChooseManaColor', ok: true }),
    r('agent_decision', { game: G3, seat: 'b', id: 'G51', kind: 'ManaPayment', choice: 'Let the auto-tapper pay (recorded)', accepted: true }),
    r('agent_decision', { game: G3, seat: 'b', id: 'G52', kind: 'ManaPayment', choice: 'Cancel (undo this spell/ability)', accepted: true }),
  ];
  const log = resumeLog([...games, ...recs]);
  const sess = { code: 'ABC', players: [{ seat: 'a', token: 't1', full_key: { game_code: 'ABC', generation: 1 } }, { seat: 'b', token: 't2', full_key: { game_code: 'ABC', generation: 1 } }] };
  const gr = gameResume(log.games.get(G3)!, sess, []);
  assert.deepEqual(gr.counters.a, { manualPayments: 1 });
  assert.deepEqual(gr.counters.b, { autoTapper: 1 });
});

await test('a voided game starts over under the same label; its earlier records are dropped', () => {
  const voided = [...games, r('game_failed', { game: G2, void: true, reason: 'reconnect_failed', replay: true }), r('turn_snapshot', { game: G2, turn: 1 })];
  const log = resumeLog(voided);
  const g = log.games.get(G2)!;
  assert.equal(g.voids, 1);
  assert.equal(g.start, undefined, 'the replay has not started yet');
  assert.deepEqual(g.records.map((x) => x.type), ['turn_snapshot']);
  const replay = resumeLog([...voided, r('game_start', { game: G2, seats: ['b', 'a'] })]).games.get(G2)!;
  assert.ok(replay.start && !replay.failed);
});

await test('deckFromLog: pool cards and basics', () => {
  const pool = [{ name: 'Card X' }, { name: 'Card Y' }] as Parameters<typeof deckFromLog>[1];
  const d = deckFromLog(games[1]!, pool);
  assert.deepEqual(d.deck.main_deck, ['Island', 'Card X', 'Island']);
  assert.deepEqual(d.mainCards.map((c) => c.name), ['Card X']);
  assert.deepEqual(d.basics, { Island: 2 });
  assert.equal(d.by, 'agent');
});

console.log(`\n${passed} durability tests passed`);
