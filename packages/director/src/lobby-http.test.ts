/**
 * The lobby's HTTP routes (lobby-http.ts) over a real socket, with a stub caller: best of 3 only (best_of 1 and
 * best-of-1 queue keys are refused with one message, a legacy -bo3 key joins the new queue), and the admin config.
 *   npx tsx packages/director/src/lobby-http.test.ts
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { BO1_REMOVED } from './best-of.js';
import { DEFAULT_LOBBY, Lobby, MemoryLobbyStore, type ViewContext } from './lobby.js';
import { LobbyHttp } from './lobby-http.js';

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  await fn();
  passed++;
  console.log(`ok - ${name}`);
}

const ctx: ViewContext = {
  publicUrl: 'https://director.test', siteUrl: 'https://site.test', promptVersion: 'v3', setName: (c) => (c.toLowerCase() === 'fra' ? 'Reality Fracture' : undefined),
  notInPacks: (c) => (c.toLowerCase() === 'fra' ? ["Jace's Machinations", 'Sanctum Lurker'] : []),
  capacity: () => ({ capacity: 30, load: 0 }),
  eventInfo: () => undefined,
};
const lobby = new Lobby({ ...DEFAULT_LOBBY, saveDelayMs: 60_000 }, new MemoryLobbyStore(), { paused: () => false, fire: async () => ({ event_id: 'ev-1' }) });
const http = new LobbyHttp({
  lobby: () => lobby,
  caller: async (req) => {
    const id = Number(String(req.headers.authorization ?? '').replace(/^Bearer tok-/, ''));
    return Number.isSafeInteger(id) && id > 0 ? { kind: 'contributor', id, handle: `p${id}`, github: true } : undefined;
  },
  isAdmin: (req) => req.headers.authorization === 'Bearer admin',
  ctx: () => ctx,
  setProblem: () => undefined,
  jsonMaxBytes: 65_536,
});
const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  void http.handle(req, res, url, url.pathname).then((handled) => handled || res.writeHead(404).end());
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const seat = { harness: 'claude-code', model: 'claude-opus-5-5', effort: 'high' };
let who = 0;
async function call(path: string, body?: unknown, method = body ? 'POST' : 'GET', token = `tok-${++who}`): Promise<{ status: number; json: Record<string, any> }> {
  const res = await fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: res.status, json: (await res.json()) as Record<string, any> };
}

try {
  await test('GET /api/lobby: each queue lists the set\'s cards its packs can\'t contain', async () => {
    lobby.setConfig({ featured: ['fra-primer-manual'], schedules: [] }, Date.now());
    const r = await call('/api/lobby');
    assert.equal(r.status, 200);
    const q = r.json.queues.find((x: { key: string }) => x.key === 'fra-primer-manual');
    assert.deepEqual(q.not_in_packs, ["Jace's Machinations", 'Sanctum Lurker']);
    lobby.setConfig({ featured: [], schedules: [] }, Date.now());
  });

  await test('join: best_of 1 and best-of-1 queue keys are refused with one clear message; other best-ofs too', async () => {
    for (const body of [
      { set: 'fra', knowledge: 'primer', mana: 'manual', best_of: 1, seats: [seat] },
      { queue: 'fra-primer-manual', best_of: 1, seats: [seat] },
      { queue: 'fra-primer-manual-bo1', seats: [seat] },
    ]) {
      const r = await call('/api/lobby/join', body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.equal(r.json.error, BO1_REMOVED);
    }
    for (const best_of of [5, 2, 'x']) {
      const r = await call('/api/lobby/join', { set: 'fra', best_of, seats: [seat] });
      assert.equal(r.status, 400);
      assert.match(r.json.error, /plays best of 3 with sideboarding/);
    }
    assert.equal(lobby.state.entries.length, 0, 'nothing joined');
  });

  await test('join: best_of 3, no best_of, a new key and a legacy -bo3 key all join the same queue', async () => {
    const keys: string[] = [];
    for (const body of [
      { set: 'fra', knowledge: 'primer', mana: 'manual', best_of: 3, seats: [seat] },
      { set: 'FRA', knowledge: 'primer', mana: 'manual', seats: [seat] },
      { queue: 'fra-primer-manual', seats: [seat] },
      { queue: 'fra-primer-manual-bo3', seats: [seat] },
    ]) {
      const r = await call('/api/lobby/join', body);
      assert.equal(r.status, 201, JSON.stringify(r.json));
      keys.push(r.json.queue);
    }
    assert.deepEqual(keys, Array(4).fill('fra-primer-manual'));
    const q = await call('/api/lobby/queues/fra-primer-manual-bo3');
    assert.equal(q.status, 200);
    assert.equal(q.json.key, 'fra-primer-manual');
    assert.equal(q.json.seats_filled, 4);
    assert.equal(q.json.best_of, 3);
    const gone = await call('/api/lobby/queues/fra-primer-manual-bo1');
    assert.equal(gone.status, 404);
    assert.equal(gone.json.error, BO1_REMOVED);
  });

  await test('admin config: legacy -bo3 keys are stored under the new key; a best-of-1 queue is refused', async () => {
    const ok = await call('/api/admin/lobby/config', { featured: ['fra-primer-manual-bo3'], schedules: [{ id: 'fra-weekly', name: 'Weekly FRA Draft', queue: 'fra-none-auto-bo3', weekly: { day: 'thu', time: '18:00' } }] }, 'PUT', 'admin');
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    assert.deepEqual(ok.json.featured, ['fra-primer-manual']);
    assert.equal(ok.json.schedules[0].queue, 'fra-none-auto');
    const bad = await call('/api/admin/lobby/config', { featured: ['fra-primer-manual-bo1'] }, 'PUT', 'admin');
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error, BO1_REMOVED);
  });
  await test('join: an oversized body is refused with 413 and the connection closed (not drained)', async () => {
    const res = await fetch(`${base}/api/lobby/join`, { method: 'POST', headers: { authorization: 'Bearer tok-999', 'content-type': 'application/json' }, body: JSON.stringify({ set: 'fra', pad: 'x'.repeat(100_000) }) });
    assert.equal(res.status, 413);
    assert.equal(res.headers.get('connection'), 'close');
  });
} finally {
  server.close();
  lobby.flush();
}

console.log(`\n${passed} lobby HTTP tests passed`);
