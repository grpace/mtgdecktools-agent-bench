/**
 * Admission control, queue, quotas and request limits of the hosted Director.
 *   npx tsx packages/director/src/admission.test.ts
 */
import assert from 'node:assert/strict';
import { Admission, eventWeight } from './admission.js';
import type { Owner } from './durable.js';
import { RateLimiter } from './ratelimit.js';
import { HubAuth } from './hub-auth.js';

const admin: Owner = { kind: 'admin' };
const alice: Owner = { kind: 'contributor', id: 1, handle: 'alice' };
const bob: Owner = { kind: 'contributor', id: 2, handle: 'bob' };
let n = 0;
const entry = (owner: Owner, weight: number, createdAt = 0) => ({ id: `ev-${++n}`, owner, weight, createdAt });
let passed = 0;
function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve(fn()).then(() => {
    passed++;
    console.log(`ok - ${name}`);
  });
}

await test('event weight = most concurrent games, at least one slot', () => {
  assert.equal(eventWeight(1), 1);
  assert.equal(eventWeight(2), 1);
  assert.equal(eventWeight(3), 1);
  assert.equal(eventWeight(4), 2);
  assert.equal(eventWeight(8), 4);
});

await test('admits while capacity lasts, then queues FIFO; releases start the head of the queue', () => {
  const a = new Admission({ capacity: 4, maxQueue: 10, contributor: { concurrent: 9, daily: 99 } });
  const e1 = entry(admin, 2), e2 = entry(admin, 2), e3 = entry(admin, 2), e4 = entry(admin, 1);
  for (const e of [e1, e2]) {
    const d = a.check(e.owner, e.weight, 0);
    assert.deepEqual(d, { ok: true, start: true });
    a.admit(e, true, 0);
  }
  assert.equal(a.load, 4);
  const d3 = a.check(admin, 2, 0);
  assert.deepEqual(d3, { ok: true, start: false, position: 1 });
  a.admit(e3, false, 0);
  // A small event that would fit doesn't overtake the queue (strict FIFO, nothing starves).
  assert.deepEqual(a.check(admin, 1, 0), { ok: true, start: false, position: 2 });
  a.admit(e4, false, 0);
  assert.equal(a.position(e3.id), 1);
  assert.equal(a.position(e4.id), 2);
  assert.deepEqual(a.next(), []);
  a.release(e1.id);
  assert.deepEqual(a.next().map((e) => e.id), [e3.id]);
  assert.equal(a.position(e4.id), 1);
  a.release(e2.id);
  assert.deepEqual(a.next().map((e) => e.id), [e4.id]);
  assert.equal(a.load, 3);
  assert.equal(a.queued.length, 0);
});

await test('admin force starts at capacity; contributors cannot force', () => {
  const a = new Admission({ capacity: 1, maxQueue: 10, contributor: { concurrent: 5, daily: 99 } });
  a.admit(entry(admin, 1), true, 0);
  assert.deepEqual(a.check(admin, 1, 0, undefined, true), { ok: true, start: true });
  assert.equal((a.check(alice, 1, 0, undefined, true) as { start: boolean }).start, false);
});

await test('per-contributor concurrency counts running + queued; others are unaffected', () => {
  const a = new Admission({ capacity: 1, maxQueue: 10, contributor: { concurrent: 2, daily: 99 } });
  a.admit(entry(alice, 1), true, 0);
  a.admit(entry(alice, 1), false, 0);
  const d = a.check(alice, 1, 0);
  assert.equal(d.ok, false);
  assert.equal(!d.ok && d.status, 429);
  assert.match(!d.ok ? d.error : '', /2 Private Table\(s\) running or queued \(limit 2; lobby tables are counted separately\)/);
  assert.equal(a.check(bob, 1, 0).ok, true);
  assert.equal(a.check(admin, 1, 0).ok, true);
  // The Hub's per-contributor quota overrides the default.
  assert.equal(a.check(alice, 1, 0, { concurrent: 3 }).ok, true);
});

await test('daily quota is a rolling 24 h window and survives releases', () => {
  const a = new Admission({ capacity: 10, maxQueue: 10, contributor: { concurrent: 9, daily: 2 } });
  const t0 = 1_000_000_000;
  const x = entry(alice, 1), y = entry(alice, 1);
  a.admit(x, true, t0);
  a.admit(y, true, t0 + 1000);
  a.release(x.id);
  a.release(y.id);
  const d = a.check(alice, 1, t0 + 3600_000);
  assert.equal(d.ok, false);
  assert.equal(!d.ok && d.status, 429);
  assert.ok(!d.ok && d.retryAfterS! > 3600 * 22);
  assert.equal(a.check(alice, 1, t0 + 24 * 3600_000 + 2000).ok, true);
  // Events from before a restart count (restore → noteCreated).
  const b = new Admission({ capacity: 10, maxQueue: 10, contributor: { concurrent: 9, daily: 1 } });
  b.noteCreated(alice, t0);
  assert.equal(b.check(alice, 1, t0 + 60_000).ok, false);
  assert.equal(b.check(alice, 1, t0 + 60_000, { daily: 5 }).ok, true);
});

await test('queue cap and draining refuse with 503; draining starts nothing', () => {
  const a = new Admission({ capacity: 1, maxQueue: 1, contributor: { concurrent: 9, daily: 99 } });
  const running = entry(admin, 1);
  const waiting = entry(admin, 1);
  a.admit(running, true, 0);
  a.admit(waiting, false, 0);
  const full = a.check(admin, 1, 0);
  assert.equal(!full.ok && full.status, 503);
  a.draining = true;
  const d = a.check(alice, 1, 0);
  assert.equal(!d.ok && d.status, 503);
  a.release(running.id);
  assert.deepEqual(a.next(), []);
  a.draining = false;
  assert.deepEqual(a.next().map((e) => e.id), [waiting.id]);
});

await test('an event bigger than the worker is refused', () => {
  const a = new Admission({ capacity: 3, maxQueue: 10, contributor: { concurrent: 9, daily: 99 } });
  const d = a.check(admin, 4, 0);
  assert.equal(!d.ok && d.status, 429);
});

await test('restore re-registers without counting the daily quota twice', () => {
  const a = new Admission({ capacity: 2, maxQueue: 10, contributor: { concurrent: 9, daily: 99 } });
  const e = entry(alice, 1);
  a.restore(e, true);
  assert.equal(a.isRunning(e.id), true);
  assert.equal(a.createdToday(alice, 0), 0);
  const q = entry(alice, 2);
  a.restore(q, false);
  assert.equal(a.position(q.id), 1);
});

await test('rate limiter: burst, then refill over time; idle keys are swept', () => {
  const r = new RateLimiter(60, 3);
  const t = 1_000;
  assert.equal(r.take('ip', t), 0);
  assert.equal(r.take('ip', t), 0);
  assert.equal(r.take('ip', t), 0);
  assert.ok(r.take('ip', t) >= 1);
  assert.equal(r.take('other', t), 0);
  assert.equal(r.take('ip', t + 1_000), 0);
  assert.ok(r.take('ip', t + 1_000) >= 1);
  r.sweep(t + 60_000);
  assert.equal(r.size, 0);
  const off = new RateLimiter(0);
  for (let i = 0; i < 100; i++) assert.equal(off.take('x'), 0);
});

await test('hub token introspection: cached, negative answers cached briefly, hub errors surface', async () => {
  let calls = 0;
  let answer: unknown = { active: true, contributor: { id: 7, handle: 'carol', kind: 'person', trust: 'new' }, scopes: ['submit', 'play'], quotas: { play_concurrent: 2, play_daily: 5 } };
  let status = 200;
  const fetchFn = (async (_url: string, init: RequestInit) => {
    calls++;
    assert.equal((init.headers as Record<string, string>).Authorization, 'Bearer service-token-xxxxxxxxxxxxxxxx');
    assert.match(String(init.body), /"token":"mtgdt_con_/);
    return new Response(JSON.stringify(answer), { status });
  }) as unknown as typeof fetch;
  const auth = new HubAuth({ url: 'http://hub', token: 'service-token-xxxxxxxxxxxxxxxx' }, { fetchFn });
  const tok = 'mtgdt_con_' + 'a'.repeat(40);
  const t0 = 5_000_000;
  const v = await auth.introspect(tok, t0);
  assert.equal(v.active, true);
  assert.equal(v.contributor?.handle, 'carol');
  await auth.introspect(tok, t0 + 30_000);
  assert.equal(calls, 1);
  await auth.introspect(tok, t0 + 61_000);
  assert.equal(calls, 2);
  answer = { active: false };
  const bad = 'mtgdt_con_' + 'b'.repeat(40);
  assert.equal((await auth.introspect(bad, t0)).active, false);
  assert.equal((await auth.introspect(bad, t0 + 10_000)).active, false);
  assert.equal(calls, 3);
  // Malformed tokens never reach the hub.
  assert.equal((await auth.introspect('short', t0)).active, false);
  assert.equal((await auth.introspect('x'.repeat(30) + ' ;drop', t0)).active, false);
  assert.equal(calls, 3);
  status = 502;
  await assert.rejects(auth.introspect('mtgdt_con_' + 'c'.repeat(40), t0), /answered 502/);
});

await test('continuous (Keep Playing) tables keep headroom, queue behind one-off tables, one per contributor', () => {
  const a = new Admission({ capacity: 16, maxQueue: 10, contributor: { concurrent: 3, daily: 99 }, continuousReserve: 8, continuousPerContributor: 1 });
  const cont = (owner: Owner) => ({ ...entry(owner, 4), continuous: true });
  // Empty worker: 4 + 8 reserve <= 16, so it starts.
  const c1 = cont(alice);
  assert.deepEqual(a.check(alice, 4, 0, undefined, false, true), { ok: true, start: true });
  a.admit(c1, true, 0);
  // A second continuous table of the same contributor: refused (per-contributor cap).
  const capped = a.check(alice, 4, 0, undefined, false, true);
  assert.equal(capped.ok, false);
  assert.equal(!capped.ok && capped.status, 429);
  // Bob's continuous table: 4 + 4 + 8 = 16 fits exactly.
  const c2 = cont(bob);
  assert.deepEqual(a.check(bob, 4, 0, undefined, false, true), { ok: true, start: true });
  a.admit(c2, true, 0);
  // A third contributor's continuous table would eat the reserve: queued.
  const carol: Owner = { kind: 'contributor', id: 3, handle: 'carol' };
  const c3 = cont(carol);
  assert.deepEqual(a.check(carol, 4, 0, undefined, false, true), { ok: true, start: false, position: 1 });
  a.admit(c3, false, 0);
  // A lobby table still starts right away (the reserve is for it), skipping the queued continuous table.
  const lobby: Owner = { kind: 'lobby', table: 't-1' };
  const l1 = entry(lobby, 4);
  assert.deepEqual(a.check(lobby, 4, 0), { ok: true, start: true });
  a.admit(l1, true, 0);
  // Full now: a one-off table queues AHEAD of the continuous one.
  const o1 = entry(admin, 8);
  assert.deepEqual(a.check(admin, 8, 0), { ok: true, start: false, position: 1 });
  a.admit(o1, false, 0);
  assert.deepEqual(a.queued.map((e) => e.id), [o1.id, c3.id]);
  assert.equal(a.position(c3.id), 2);
  // Free one table: the one-off starts first; the continuous one keeps waiting for headroom.
  a.release(c1.id);
  assert.deepEqual(a.next().map((e) => e.id), [o1.id]);
  assert.deepEqual(a.next(), []);
  // Free two more: 4 (lobby) + 4 (c3) + 8 reserve <= 16.
  a.release(c2.id);
  a.release(o1.id);
  assert.deepEqual(a.next().map((e) => e.id), [c3.id]);
  const st = a.status();
  assert.deepEqual(st.continuous, { running: 1, queued: 0, reserve: 8, per_contributor: 1 });
  // Continuous tables count toward the daily quota like any other.
  const d = new Admission({ capacity: 30, maxQueue: 10, contributor: { concurrent: 9, daily: 1 } });
  d.admit(cont(alice), true, 0);
  const daily = d.check(alice, 4, 1000, undefined, false, false);
  assert.equal(daily.ok, false);
});

await test('continuous reserve never exceeds the capacity left after the table itself', () => {
  const a = new Admission({ capacity: 4, maxQueue: 10, contributor: { concurrent: 3, daily: 99 }, continuousReserve: 8 });
  assert.equal(a.reserveFor(4), 0);
  assert.deepEqual(a.check(alice, 4, 0, undefined, false, true), { ok: true, start: true });
});

console.log(`\n${passed} admission tests passed`);
