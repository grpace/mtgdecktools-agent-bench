/**
 * Re-attaching a game after a Director restart (a deploy): the reconnect is retried with backoff while phase-server
 * isn't answering yet or refuses, and the game is voided only once the retries are spent.
 *   npx tsx packages/director/src/game-resume.test.ts
 */
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import { Game, GameVoidError } from './game.js';
import { PROTOCOL_VERSION } from './phase.js';
import { AgentSeat } from './seat.js';

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  await fn();
  passed++;
  console.log(`ok - ${name}`);
}

/** A fake phase-server: says hello, and answers Reconnect with an Error for the first `refuse` tries, then GameStarted. */
function fakeEngine(refuse: number) {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  const tries: string[] = [];
  wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ type: 'ServerHello', data: { protocol_version: PROTOCOL_VERSION, build_commit: 'test' } }));
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.type !== 'Reconnect') return;
      tries.push(msg.data.player_token);
      if (tries.length <= refuse) ws.send(JSON.stringify({ type: 'Error', data: { message: 'game not found' } }));
      else ws.send(JSON.stringify({ type: 'GameStarted', data: { state_revision: 5, state: {}, legal_actions: [] } }));
    });
  });
  return { wss, tries, url: () => `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/ws` };
}

function resumedGame(url: string, delays: number[]) {
  const seats: [AgentSeat, AgentSeat] = [new AgentSeat('a', 0), new AgentSeat('b', 1)];
  const logged: Array<Record<string, any>> = [];
  const deck = { main_deck: [], sideboard: [] };
  const session = { code: 'ABC123', players: [{ seat: 'a', token: 'ta', full_key: {} }, { seat: 'b', token: 'tb', full_key: {} }] } as any;
  const game = new Game(url, {} as any, seats, [deck, deck], (t, d) => logged.push({ type: t, ...d }), 'a vs b — game 1', 'manual', {}, undefined, {
    resume: { session, forfeitedBy: undefined, lastSnapshotTurn: 0, counters: {}, played: {}, unimplemented: [] } as any,
    resumeRetryMs: delays,
  });
  // The board itself isn't under test: updates go nowhere.
  (game as any).onUpdate = () => {};
  return { game, logged };
}

await test('the engine is not up yet when the Director resumes: the reconnect is retried until it answers', async () => {
  // Nothing listens on this port at first; the engine comes up after the first try.
  const engine = fakeEngine(1);
  await new Promise((r) => engine.wss.once('listening', r));
  const url = engine.url();
  await new Promise<void>((r) => engine.wss.close(() => r()));
  const { game, logged } = resumedGame(url, [50, 50, 300, 300, 300]);
  const played = game.play().catch((e) => e);
  await new Promise((r) => setTimeout(r, 30));
  // Restart the engine on the same port, refusing one reconnect (it is still loading its games).
  const port = Number(new URL(url).port);
  const again = new WebSocketServer({ port, host: '127.0.0.1' });
  let refused = 0;
  again.on('connection', (ws) => {
    ws.send(JSON.stringify({ type: 'ServerHello', data: { protocol_version: PROTOCOL_VERSION, build_commit: 'test' } }));
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.type !== 'Reconnect') return;
      if (msg.data.player_token === 'ta' && refused++ < 1) ws.send(JSON.stringify({ type: 'Error', data: { message: 'game not loaded yet' } }));
      else ws.send(JSON.stringify({ type: 'GameStarted', data: { state_revision: 5, state: {}, legal_actions: [] } }));
    });
  });
  for (let i = 0; i < 100 && !logged.some((r) => r.type === 'game_reconnect'); i++) await new Promise((r) => setTimeout(r, 50));
  const retries = logged.filter((r) => r.type === 'game_reconnect_retry');
  assert.ok(retries.length >= 2, `retried (${retries.length})`);
  assert.ok(logged.some((r) => r.type === 'game_reconnect' && r.after === 'restart'), 'reconnected');
  assert.ok(!logged.some((r) => r.type === 'game_failed'));
  game.abandon();
  again.close();
  void played;
});

await test('a game the engine no longer has is voided after three refusals in a row, not after one', async () => {
  const engine = fakeEngine(Infinity);
  await new Promise((r) => engine.wss.once('listening', r));
  const { game, logged } = resumedGame(engine.url(), [20, 20, 20, 20, 20]);
  const err = await game.play().then(() => undefined, (e) => e);
  assert.ok(err instanceof GameVoidError, String(err));
  assert.equal(err.reason, 'reconnect_failed');
  assert.match(err.message, /after 3 tries: game not found/);
  assert.equal(logged.filter((r) => r.type === 'game_reconnect_retry').length, 2);
  // Both seats tried every time (a seat already back would not be asked again).
  assert.equal(engine.tries.length, 6);
  engine.wss.close();
});

await test('an engine that does not answer at all is retried until the retries are spent', async () => {
  // A port nobody listens on: connection refused every time.
  const engine = fakeEngine(0);
  await new Promise((r) => engine.wss.once('listening', r));
  const url = engine.url();
  await new Promise<void>((r) => engine.wss.close(() => r()));
  const { game, logged } = resumedGame(url, [10, 10, 10, 10]);
  const err = await game.play().then(() => undefined, (e) => e);
  assert.ok(err instanceof GameVoidError, String(err));
  assert.match(err.message, /after 5 tries/);
  assert.equal(logged.filter((r) => r.type === 'game_reconnect_retry').length, 4);
});

console.log(`\n${passed} passed`);
process.exit(0);
