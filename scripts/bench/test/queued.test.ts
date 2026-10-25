// bench play waits while the Director holds an event in its capacity queue, so no harness session is paid for
// before the event can offer a decision (core.ts waitWhileQueued).
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { eventStatus, seatStateAt, waitWhileQueued } from '../core.js';

/** A Director whose answers follow `stages`; `proxy: true` answers like Traefik with no backend (plain text). */
async function director(stages: Array<{ status?: number; body?: Record<string, unknown>; proxy?: boolean }>) {
  let i = 0;
  const server = createServer((_req, res) => {
    const s = stages[Math.min(i++, stages.length - 1)]!;
    if (s.proxy) res.writeHead(s.status ?? 404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 page not found\n');
    else res.writeHead(s.status ?? 200, { 'Content-Type': 'application/json' }).end(JSON.stringify(s.body ?? {}));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls: () => i, close: () => server.close() };
}

test('waits while queued, says the position once per change, returns when the event starts', async () => {
  const d = await director([
    { body: { stage: 'queued', queue_position: 2 } },
    { body: { stage: 'queued', queue_position: 2 } },
    { body: { stage: 'queued', queue_position: 1 } },
    { body: { stage: 'draft' } },
  ]);
  const lines: string[] = [];
  try {
    assert.equal(await waitWhileQueued(d.base, 'ev', { pollMs: 5, log: (l) => lines.push(l) }), 'running');
    assert.equal(d.calls(), 4);
    assert.deepEqual(lines.map((l) => /position (\d)/.exec(l)?.[1]), ['2', '1']);
  } finally {
    d.close();
  }
});

test('an event that is not queued returns at once', async () => {
  const d = await director([{ body: { stage: 'games' } }]);
  try {
    assert.equal(await waitWhileQueued(d.base, 'ev', { pollMs: 5, log: () => {} }), 'running');
    assert.equal(d.calls(), 1);
  } finally {
    d.close();
  }
});

test('a queued event that times out or disappears is reported, so no session starts', async () => {
  const a = await director([{ body: { stage: 'queued', queue_position: 1 } }, { body: { stage: 'aborted', abort_reason: 'queue_timeout' } }]);
  const g = await director([{ status: 404 }]);
  try {
    assert.equal(await waitWhileQueued(a.base, 'ev', { pollMs: 5, log: () => {} }), 'aborted');
    assert.equal(await waitWhileQueued(g.base, 'ev', { pollMs: 5, log: () => {} }), 'gone');
  } finally {
    a.close();
    g.close();
  }
});

test("during a deploy the proxy's 404 is no answer, not a gone event; the Director's own 404 is", async () => {
  const p = await director([{ status: 404, proxy: true }, { status: 502, proxy: true }, { status: 404, body: { error: 'no such event' } }]);
  try {
    assert.equal(await eventStatus(p.base, 'ev'), undefined);
    assert.equal(await eventStatus(p.base, 'ev'), undefined);
    assert.deepEqual(await eventStatus(p.base, 'ev'), { stage: 'gone' });
  } finally {
    p.close();
  }
});

test('seat state waits out a restarting Director with backoff, then says it waited; gives up after the window', async () => {
  const d = await director([
    { status: 404, proxy: true }, { status: 502, proxy: true }, { status: 503, proxy: true },
    { body: { stage: 'games', agents: [{ name: 's1', status: 'waiting' }] } },
  ]);
  const down = await director([{ status: 404, proxy: true }]);
  try {
    assert.deepEqual(await seatStateAt(d.base, 'ev', 's1', { backoffMs: () => 5, log: () => {} }), { state: 'running', waited: true });
    assert.equal(d.calls(), 4);
    const t0 = Date.now();
    assert.deepEqual(await seatStateAt(down.base, 'ev', 's1', { maxDownMs: 120, backoffMs: () => 20, log: () => {} }), { state: 'unreachable', waited: true });
    assert.ok(Date.now() - t0 >= 100);
  } finally {
    d.close();
    down.close();
  }
});

test('a queued event survives a Director restart: the wait goes on through the proxy\'s 404s', async () => {
  const d = await director([{ body: { stage: 'queued', queue_position: 1 } }, { status: 404, proxy: true }, { status: 404, proxy: true }, { body: { stage: 'draft' } }]);
  try {
    assert.equal(await waitWhileQueued(d.base, 'ev', { pollMs: 5, log: () => {} }), 'running');
  } finally {
    d.close();
  }
});

test('a Director that stops answering ends the wait after a few tries', async () => {
  const d = await director([{ status: 503 }]);
  try {
    assert.equal(await waitWhileQueued(d.base, 'ev', { pollMs: 5, maxFailures: 3, log: () => {} }), 'unknown');
    assert.equal(d.calls(), 3);
  } finally {
    d.close();
  }
});
