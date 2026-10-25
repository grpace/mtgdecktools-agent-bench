/**
 * The matchmaking lobby (docs/LOBBY.md): queues, presence, ready checks with backfill, the per-contributor cap,
 * expiry, cooldowns, reliability, scheduled tables, draining, stats and restart durability; churn limits (LOB-1),
 * hosted-play quotas (LOB-2), the Hub's hide setting (LOB-3) and scripted seats (LOB-4).
 *   npx tsx packages/director/src/lobby.test.ts
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Admission } from './admission.js';
import { BO1_REMOVED } from './best-of.js';
import {
  applyStartConfig, configProblems, DEFAULT_LOBBY, ratedMatchesFor, FileLobbyStore, Lobby, LobbyError, MemoryLobbyStore, normalizeQueueKey, occurrence, parseQueueKey, queueKey, queueKeyProblem,
  type LobbyConfig, type LobbyHooks, type LobbyStore, type TableToFire, type ViewContext,
} from './lobby.js';
import { resolveSeatIdentity, type SeatIdentity } from './seat-identity.js';
import { ratedMatchesText } from './rated-estimate.js';

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  await fn();
  passed++;
  console.log(`ok - ${name}`);
}

const Q = 'fra-primer-manual';
const seat = (model = 'claude-opus-5-5', harness = 'claude-code', effort = 'high'): SeatIdentity => {
  const r = resolveSeatIdentity({ harness, model, effort });
  if (!r.ok) throw new Error(r.error);
  const { ok, ...s } = r;
  void ok;
  return s;
};
const people = Array.from({ length: 6 }, (_, i) => ({ id: i + 1, handle: `p${i + 1}` }));

interface Rig {
  lobby: Lobby;
  fired: TableToFire[];
  paused: { on: boolean };
  store: LobbyStore;
  fail: { next?: string };
}
function rig(store: LobbyStore = new MemoryLobbyStore(), now = 0, recover?: LobbyHooks['recover'], cfg: Partial<LobbyConfig> = {}, quota?: LobbyHooks['quota']): Rig {
  const fired: TableToFire[] = [];
  const paused = { on: false };
  const fail: { next?: string } = {};
  let n = 0;
  const hooks: LobbyHooks = {
    paused: () => paused.on,
    fire: async (t) => {
      if (fail.next) {
        const m = fail.next;
        fail.next = undefined;
        throw new Error(m);
      }
      fired.push(t);
      return { event_id: `ev-${++n}` };
    },
    ...(recover ? { recover } : {}),
    ...(quota ? { quota } : {}),
  };
  // Most tests seat 8 copies of one setup: the setup cap (§10) is off unless a test sets it.
  return { lobby: new Lobby({ ...DEFAULT_LOBBY, maxSameSetup: 8, ...cfg }, store, hooks, now), fired, paused, store, fail };
}
const ctx: ViewContext = {
  publicUrl: 'https://director.test', siteUrl: 'https://site.test', promptVersion: 'v3', setName: (c) => (c.toLowerCase() === 'fra' ? 'Reality Fracture' : undefined),
  capacity: () => ({ capacity: 30, load: 0 }),
  eventInfo: (id) => ({ stage: 'draft', queue_position: null, seatUrl: (name) => `https://director.test/mcp/${id}-${name}` }),
};
type View = Record<string, any>;
const view = (r: Rig, ticket: string, now: number) => r.lobby.ticketView(ticket, now, ctx) as View;

/** Join n seats per contributor in the order given; returns the tickets. */
async function joinAll(r: Rig, plan: Array<[number, number]>, now = 0, queue = Q): Promise<string[]> {
  const out: string[] = [];
  // One millisecond apart, so queue order is join order.
  plan.forEach(([who, n], i) => out.push(r.lobby.join(people[who]!, { queue, seats: Array.from({ length: n }, () => seat()) }, now + i).ticket));
  await r.lobby.tick(now + plan.length);
  return out;
}

await test('queue keys round-trip; invalid keys and configs are refused', () => {
  assert.equal(queueKey({ set: 'FRA', knowledge: 'primer+stats', mana: 'manual' }), 'fra-primer-stats-manual');
  assert.deepEqual(parseQueueKey('fra-primer-stats-manual'), { set: 'fra', knowledge: 'primer+stats', mana: 'manual' });
  // Legacy keys: -bo3 is the same queue (old invite links, featured lists, schedules); best of 1 was removed.
  assert.deepEqual(parseQueueKey('FRA-primer-stats-manual-bo3'), { set: 'fra', knowledge: 'primer+stats', mana: 'manual' });
  assert.equal(normalizeQueueKey('fra-primer-manual-bo3'), 'fra-primer-manual');
  assert.equal(normalizeQueueKey('fra-primer-manual'), 'fra-primer-manual');
  assert.equal(parseQueueKey('fra-primer-manual-bo1'), undefined);
  assert.equal(queueKeyProblem('fra-primer-manual-bo1'), BO1_REMOVED);
  assert.equal(queueKeyProblem('fra-primer-manual-bo3'), undefined);
  assert.match(queueKeyProblem('fra-primer-manual-bo5')!, /best of 3 with sideboarding/);
  assert.equal(parseQueueKey('fra-primer-manual-bo2'), undefined);
  assert.match(queueKeyProblem('nope')!, /isn't a queue key: give one like fra-primer-manual/);
  assert.equal(parseQueueKey('../etc'), undefined);
  assert.deepEqual(configProblems({ featured: [Q], schedules: [{ id: 'fra-weekly', name: 'Weekly FRA Draft', queue: Q, weekly: { day: 'thu', time: '18:00' } }] }), []);
  assert.ok(configProblems({ schedules: [{ id: 'X', name: '', queue: 'nope' }] }).length >= 3);
  assert.deepEqual(configProblems({ featured: [`${Q}-bo3`], schedules: [{ id: 'fra-weekly', name: 'Weekly FRA Draft', queue: `${Q}-bo3`, weekly: { day: 'thu', time: '18:00' } }] }), [], 'legacy bo3 keys are accepted');
  assert.deepEqual(configProblems({ featured: [`${Q}-bo1`] }), [`featured: ${BO1_REMOVED}`]);
  assert.deepEqual(configProblems({ schedules: [{ id: 'fra-weekly', name: 'Weekly FRA Draft', queue: `${Q}-bo1`, weekly: { day: 'thu', time: '18:00' } }] }), [`schedule fra-weekly: ${BO1_REMOVED}`]);
});

await test('best of 3 only: a best-of-1 queue is refused at join; a legacy -bo3 key joins the same queue; the view keeps best_of 3 without splitting on it', async () => {
  const r = rig();
  assert.throws(() => r.lobby.join(people[0]!, { queue: `${Q}-bo1`, seats: [seat()] }, 0), (e: LobbyError) => e.status === 400 && e.message === BO1_REMOVED);
  assert.throws(() => r.lobby.setConfig({ featured: [`${Q}-bo1`] }, 0), (e: LobbyError) => e.status === 400 && e.message.includes(BO1_REMOVED));
  assert.equal(r.lobby.state.entries.length, 0, 'a refused join adds nothing');
  // An old invite link (-bo3) and the new key fill one table.
  const legacy = r.lobby.join(people[0]!, { queue: `${Q}-BO3`, seats: [seat(), seat(), seat()] }, 0);
  assert.ok(legacy.entries.every((e) => e.queue === Q), 'stored under the new key');
  const ts = [legacy.ticket, ...(await joinAll(r, [[1, 3], [2, 2]], 1))];
  assert.equal(r.lobby.state.forming.length, 1, 'one table across old and new keys');
  assert.equal(r.lobby.state.forming[0]!.queue, Q);
  const v = r.lobby.queueView(`${Q}-bo3`, 10, ctx)!;
  assert.equal(v.key, Q, 'an old key resolves to the queue under its new key');
  assert.equal(v.best_of, 3);
  assert.equal(v.group, 'kn=primer;mana=manual;prompt=v3', 'the comparability group no longer carries bo=');
  assert.equal(r.lobby.queueView(`${Q}-bo1`, 10, ctx), undefined);
  assert.match(String(v.join_command), / --queue fra-primer-manual --seat/);
  assert.equal(v.invite_url, 'https://site.test/agent-bench/lobby/fra-primer-manual');
  r.lobby.setConfig({ featured: [`${Q}-bo3`], schedules: [{ id: 'fra-weekly', name: 'Weekly FRA Draft', queue: `${Q}-bo3`, weekly: { day: 'thu', time: '18:00' } }] }, 10);
  assert.deepEqual(r.lobby.state.config.featured, [Q]);
  assert.equal(r.lobby.state.config.schedules[0]!.queue, Q);
  const f = r.lobby.state.forming[0]!;
  for (const t of ts) r.lobby.confirm(t, f.id, 11);
  await r.lobby.settled();
  assert.equal(r.fired.length, 1);
  assert.deepEqual(r.fired[0]!.queue, { set: 'fra', knowledge: 'primer', mana: 'manual', key: Q }, 'the fired table carries no best-of: every event plays best of 3');
});

await test('seat identity: canonical ids, unknown models and harnesses refused', () => {
  assert.equal(seat('Claude Opus 5.5', 'Claude Code', 'HIGH').model_id, 'claude-opus-5-5');
  assert.equal(seat('anthropic/claude-sonnet-5-5', 'opencode').harness_display, 'OpenCode');
  const r = resolveSeatIdentity({ harness: 'claude-code', model: 'gpt-7-imaginary' });
  assert.equal(r.ok, false);
  assert.equal(resolveSeatIdentity({ harness: 'not-a-harness', model: 'claude-opus-5-5' }).ok, false);
  assert.equal(resolveSeatIdentity({ harness: 'claude-code', model: 'claude-opus-5-5', effort: 'extreme' }).ok, false);
  const s = resolveSeatIdentity({ harness: 'script' });
  assert.ok(s.ok && s.test && s.model_id === 'random');
  // The public lobby needs a concrete effort for LLM seats (identity = harness + model + effort).
  for (const effort of [undefined, 'default', 'unknown']) {
    const r2 = resolveSeatIdentity({ harness: 'claude-code', model: 'claude-opus-5-5', effort }, { requireEffort: true });
    assert.ok(!r2.ok && r2.field === 'effort', `effort ${effort} should be refused`);
  }
  assert.ok(resolveSeatIdentity({ harness: 'claude-code', model: 'claude-opus-5-5', effort: 'High' }, { requireEffort: true }).ok);
  assert.ok(resolveSeatIdentity({ harness: 'script' }, { requireEffort: true }).ok, 'scripted seats have no effort');
  // A level in the model name (Antigravity) is declared; one that disagrees with a separate effort is refused.
  const ag = resolveSeatIdentity({ harness: 't3-code:antigravity', model: 'gemini-4-argon-high' }, { requireEffort: true });
  assert.ok(ag.ok && ag.model_id === 'gemini-4-argon' && ag.effort === 'high');
  const clash = resolveSeatIdentity({ harness: 't3-code:antigravity', model: 'gemini-4-argon-high', effort: 'low' }, { requireEffort: true });
  assert.ok(!clash.ok && clash.field === 'effort');
  // A model with no effort setting (Composer 2.5) has no level to declare.
  assert.ok(resolveSeatIdentity({ harness: 't3-code:cursor', model: 'composer-2.5' }, { requireEffort: true }).ok);
  const q = (() => {
    const r = rig();
    r.lobby.join(people[0]!, { queue: Q, seats: [seat()] }, 0);
    return r.lobby.queueView(Q, 0, ctx)!;
  })();
  assert.equal((q.seats as View[])[0]!.identity_label, 'Claude Opus 5.5 · High');
  assert.equal((q.seats as View[])[0]!.identity_key, 'claude-opus-5-5/high');
});

await test('6 of 8: the queue shows the seats and how many more it needs; no table forms', async () => {
  const r = rig();
  const [t1] = await joinAll(r, [[0, 3], [1, 3]]);
  const q = r.lobby.queueView(Q, 1000, ctx)!;
  assert.equal(q.seats_filled, 6);
  assert.equal(q.seats_needed, 2);
  assert.equal(q.status, 'waiting');
  assert.equal((q.seats as View[]).length, 6);
  assert.equal((q.seats as View[])[0]!.model_display, 'Claude Opus 5.5');
  assert.equal((q.seats as View[])[0]!.contributor, 'p1');
  assert.equal(r.lobby.state.forming.length, 0);
  const v = view(r, t1!, 1000);
  assert.equal(v.state, 'waiting');
  assert.match(v.message, /Table 6\/8, waiting for 2 more/);
});

await test('per-contributor cap: at most 4 seats of one contributor per table and per queue', async () => {
  const r = rig();
  await joinAll(r, [[0, 4]]);
  assert.throws(() => r.lobby.join(people[0]!, { queue: Q, seats: [seat()] }, 0), (e: LobbyError) => e.status === 409 && /At most 4/.test(e.message));
  // 4 + 3 present: one more seat needed from someone else.
  await joinAll(r, [[1, 3]]);
  assert.equal(r.lobby.queueView(Q, 0, ctx)!.seats_needed, 1);
  // Total cap across queues: 8 entries.
  r.lobby.join(people[0]!, { queue: 'fra-none-manual', seats: [seat(), seat(), seat(), seat()] }, 0);
  assert.throws(() => r.lobby.join(people[0]!, { queue: 'fra-none-auto', seats: [seat()] }, 0), (e: LobbyError) => e.status === 409 && /at most 8/.test(e.message));
  // Nine present (4+3+2): one table of 8 that holds at most 4 of anyone.
  await joinAll(r, [[2, 2]]);
  assert.equal(r.lobby.state.forming.length, 1);
  const f = r.lobby.state.forming[0]!;
  const per = new Map<number, number>();
  for (const id of f.entries) {
    const e = r.lobby.state.entries.find((x) => x.id === id)!;
    per.set(e.contributor.id, (per.get(e.contributor.id) ?? 0) + 1);
  }
  assert.ok([...per.values()].every((n) => n <= 4));
  assert.equal(f.entries.length, 8);
});

await test('ready check: everyone confirms → the table fires with 8 seats; holders get only their own seat URLs', async () => {
  const r = rig();
  const tickets = await joinAll(r, [[0, 3], [1, 3], [2, 2]]);
  const f = r.lobby.state.forming[0]!;
  assert.ok(f);
  for (const t of tickets) assert.equal(view(r, t, 1000).state, 'ready_check');
  r.lobby.confirm(tickets[0]!, f.id, 1000);
  assert.equal(view(r, tickets[0]!, 1000).state, 'confirmed');
  r.lobby.confirm(tickets[1]!, f.id, 1000);
  assert.equal(r.fired.length, 0);
  r.lobby.confirm(tickets[2]!, f.id, 1000);
  await r.lobby.settled();
  assert.equal(r.fired.length, 1);
  const t = r.fired[0]!;
  assert.equal(t.seats.length, 8);
  assert.equal(new Set(t.seats.map((s) => s.seat_name)).size, 8);
  // OBS-1: seat names are neutral and never encode the model, harness or contributor.
  for (const s of t.seats) {
    assert.match(s.seat_name, /^seat-[0-9a-f]{6}$/);
    for (const leak of [s.seat.model_id, s.seat.harness_id, s.contributor.handle].filter(Boolean)) assert.ok(!s.seat_name.includes(String(leak)), `${s.seat_name} encodes ${leak}`);
  }
  assert.equal(t.queue.key, Q);
  const v = view(r, tickets[2]!, 2000);
  assert.equal(v.state, 'seated');
  assert.equal(v.tables.length, 1);
  assert.equal(Object.keys(v.tables[0].seats).length, 2, 'only this ticket\'s two seats');
  for (const s of Object.values(v.tables[0].seats) as View[]) assert.match(s.url, /^https:\/\/director\.test\/mcp\//);
  assert.equal(r.lobby.state.forming.length, 0);
  // Recent tables list it, seats in canonical order, without seat names.
  const recent = r.lobby.recentTables(0, ctx);
  assert.equal(recent.length, 1);
  assert.equal(recent[0]!.event_id, 'ev-1');
  assert.ok(!JSON.stringify(recent).includes('seat_name'));
  // LOB-5: a running table lists no seat identities; they appear once its event has ended.
  assert.deepEqual(recent[0]!.seats, []);
  for (const s of t.seats) assert.ok(!JSON.stringify(recent).includes(s.seat.model_id), 'no model of a running table');
  const ended = r.lobby.recentTables(0, { ...ctx, eventInfo: (id: string) => ({ ...ctx.eventInfo(id)!, stage: 'done' }) });
  assert.equal((ended[0]!.seats as unknown[]).length, 8);
});

await test('ready check backfill: a holder who misses it drops out, the next queued seat takes the place, the table re-checks', async () => {
  const r = rig();
  // p1 3, p2 3, p3 2 → table; p4 1 waits as the 9th.
  const tickets = await joinAll(r, [[0, 3], [1, 3], [2, 2], [3, 1]]);
  const f = r.lobby.state.forming[0]!;
  r.lobby.confirm(tickets[0]!, f.id, 1000);
  r.lobby.confirm(tickets[1]!, f.id, 1000);
  // p3 never confirms; p4 keeps polling.
  r.lobby.touch(tickets[3]!, DEFAULT_LOBBY.readyWindowMs);
  await r.lobby.tick(DEFAULT_LOBBY.readyWindowMs + 11);
  assert.equal(view(r, tickets[2]!, DEFAULT_LOBBY.readyWindowMs + 11).entries.every((e: View) => e.status === 'dropped'), true);
  // Only 7 now (6 confirmed + p4): not a table yet, so it dissolves and the confirmed seats wait again, in place.
  assert.equal(r.lobby.state.forming.length, 0);
  assert.equal(Math.min(...view(r, tickets[0]!, DEFAULT_LOBBY.readyWindowMs + 11).entries.map((e: View) => e.position)), 1);
  // A new seat arrives: 8 present again → a new ready check; everyone confirms → fires without p3.
  const t5 = r.lobby.join(people[4]!, { queue: Q, seats: [seat('gpt-6-astra', 'codex', 'medium')] }, DEFAULT_LOBBY.readyWindowMs + 12).ticket;
  await r.lobby.tick(DEFAULT_LOBBY.readyWindowMs + 12);
  const g = r.lobby.state.forming[0]!;
  assert.ok(g);
  for (const t of [tickets[0]!, tickets[1]!, tickets[3]!, t5]) r.lobby.confirm(t, g.id, DEFAULT_LOBBY.readyWindowMs + 13);
  await r.lobby.settled();
  assert.equal(r.fired.length, 1);
  assert.ok(!r.fired[0]!.seats.some((s) => s.contributor.id === people[2]!.id));
});

await test('ready check backfill in place: with a 9th seat present, the miss is replaced and only the newcomer must confirm', async () => {
  const r = rig();
  const tickets = await joinAll(r, [[0, 3], [1, 3], [2, 1], [3, 1], [4, 1]]);
  const f = r.lobby.state.forming[0]!;
  const out = r.lobby.state.entries.find((e) => !f.entries.includes(e.id))!; // the 9th
  const missing = tickets.find((t) => view(r, t, 1).entries.some((e: View) => e.status === 'ready_check') && t !== tickets[0] && t !== tickets[1])!;
  for (const t of tickets) if (t !== missing && view(r, t, 1).ready_check) r.lobby.confirm(t, f.id, 1);
  for (const t of tickets) r.lobby.touch(t, DEFAULT_LOBBY.readyWindowMs);
  await r.lobby.tick(DEFAULT_LOBBY.readyWindowMs + 11);
  const g = r.lobby.state.forming[0]!;
  assert.equal(g.id, f.id, 'same table, re-checked');
  assert.ok(g.entries.includes(out.id), 'the 9th seat backfilled');
  assert.equal(g.entries.length, 8);
  assert.ok(g.deadline > DEFAULT_LOBBY.readyWindowMs + 11);
  const newcomer = tickets.find((t) => view(r, t, DEFAULT_LOBBY.readyWindowMs + 12).state === 'ready_check')!;
  r.lobby.confirm(newcomer, g.id, DEFAULT_LOBBY.readyWindowMs + 12);
  await r.lobby.settled();
  assert.equal(r.fired.length, 1);
});

await test('presence: seats whose holder stopped polling don\'t fill a table until they come back', async () => {
  const r = rig();
  const tickets = await joinAll(r, [[0, 3], [1, 3]]);
  const later = DEFAULT_LOBBY.presenceMs + 10_000;
  r.lobby.join(people[2]!, { queue: Q, seats: [seat(), seat()] }, later);
  await r.lobby.tick(later);
  assert.equal(r.lobby.state.forming.length, 0, 'p1 and p2 are away');
  assert.equal(r.lobby.queueView(Q, later, ctx)!.seats_away, 6);
  r.lobby.touch(tickets[0]!, later + 1);
  r.lobby.touch(tickets[1]!, later + 1);
  await r.lobby.tick(later + 1);
  assert.equal(r.lobby.state.forming.length, 1);
});

await test('expiry: entries leave the queue after 24 hours; leaving works at any time', async () => {
  const r = rig();
  const [t1, t2] = await joinAll(r, [[0, 2], [1, 1]]);
  r.lobby.leave(t2!, undefined, 10);
  assert.equal(view(r, t2!, 10).entries[0].status, 'left');
  r.lobby.touch(t1!, DEFAULT_LOBBY.entryTtlMs);
  await r.lobby.tick(DEFAULT_LOBBY.entryTtlMs + 1);
  const v = view(r, t1!, DEFAULT_LOBBY.entryTtlMs + 1);
  assert.deepEqual(v.entries.map((e: View) => e.status), ['expired', 'expired']);
  assert.equal(v.state, 'done');
  // A day after they ended, ended entries and their tickets are forgotten.
  await r.lobby.tick(DEFAULT_LOBBY.entryTtlMs * 2 + 10);
  assert.equal(r.lobby.ticketView(t1!, DEFAULT_LOBBY.entryTtlMs * 2 + 10, ctx), undefined);
});

await test('three missed ready checks in a day: a one-hour cooldown', async () => {
  const r = rig();
  let now = 0;
  for (let i = 0; i < 3; i++) {
    const ts = await joinAll(r, [[0, 1], [1, 3], [2, 3], [3, 1]], now);
    const f = r.lobby.state.forming.at(-1)!;
    for (const t of ts.slice(1)) r.lobby.confirm(t, f.id, now + 1);
    now += DEFAULT_LOBBY.readyWindowMs + 11;
    await r.lobby.tick(now);
    for (const t of ts.slice(1)) r.lobby.leave(t, undefined, now);
  }
  assert.throws(() => r.lobby.join(people[0]!, { queue: Q, seats: [seat()] }, now), (e: LobbyError) => e.status === 409 && /paused until/.test(e.message) && (e.retryAfterS ?? 0) > 3000);
  r.lobby.join(people[0]!, { queue: Q, seats: [seat()] }, now + DEFAULT_LOBBY.missCooldownMs + 1);
});

await test('reliability: abandoned seats count; unreliable contributors queue last and hold one seat', async () => {
  const r = rig();
  // p1 abandons 3 of 5 seats over earlier tables (recorded through private tables here).
  for (let i = 0; i < 5; i++) {
    r.lobby.notePrivate(`old-${i}`, people[0]!, [{ seat_name: 'a', seat: seat() }], 0);
    r.lobby.eventFinished(`old-${i}`, 'done', { a: { forfeits: i < 3 ? 2 : 0, games: 3 } }, 0);
  }
  assert.equal(r.lobby.reliability(1), 0.4);
  assert.throws(() => r.lobby.join(people[0]!, { queue: Q, seats: [seat(), seat()] }, 0), /one lobby seat at a time/);
  const tp1 = r.lobby.join(people[0]!, { queue: Q, seats: [seat()] }, 0).ticket;
  // Others join later but are seated first; p1 (joined first) is 9th, so not at the table.
  await joinAll(r, [[1, 3], [2, 3], [3, 2]], 5);
  const f = r.lobby.state.forming[0]!;
  const p1Entry = view(r, tp1, 5).entries[0];
  assert.ok(!f.entries.includes(p1Entry.entry_id));
  assert.equal(p1Entry.position, 1);
  const stats = r.lobby.stats(0) as View;
  const row = stats.contributors.find((c: View) => c.handle === 'p1');
  assert.equal(row.seats_abandoned, 3);
  assert.equal(row.reliability, 0.4);
});

await test('scheduled tables: sign up ahead, nothing fires before the start, fires when full, leftovers join the open queue', async () => {
  const r = rig();
  const start = Date.UTC(2026, 9, 29, 18, 0);
  r.lobby.setConfig({ schedules: [{ id: 'fra-weekly', name: 'Weekly FRA Draft', queue: Q, weekly: { day: 'thu', time: '18:00' }, signup_hours: 48, window_minutes: 120 }] }, start - 72 * 3600_000);
  const occ = occurrence(r.lobby.state.config.schedules[0]!, start - 3600_000)!;
  assert.equal(occ.starts_at, start);
  assert.equal(occ.state, 'signup');
  assert.equal(occ.id, 'fra-weekly-20261029');
  assert.throws(() => r.lobby.join(people[0]!, { schedule: 'fra-weekly', seats: [seat()] }, start - 72 * 3600_000), /Sign-ups/);
  const before = start - 3600_000;
  const ts: string[] = [];
  for (const [who, n] of [[0, 3], [1, 3], [2, 3]] as const) ts.push(r.lobby.join(people[who]!, { schedule: 'fra-weekly', seats: Array.from({ length: n }, () => seat()) }, before).ticket);
  await r.lobby.tick(before);
  assert.equal(r.lobby.state.forming.length, 0, 'no table before the start');
  const sv = r.lobby.scheduleViews(before, ctx)[0]!;
  assert.equal(sv.rsvps, 9);
  assert.equal(sv.state, 'signup');
  assert.match(view(r, ts[0]!, before).message, /Signed up for the scheduled table/);
  // The open queue doesn't show scheduled entries.
  assert.equal(r.lobby.queueView(Q, before, ctx)!.seats_filled, 0);
  for (const t of ts) r.lobby.touch(t, start);
  await r.lobby.tick(start);
  const f = r.lobby.state.forming[0]!;
  assert.equal(f.occurrence, 'fra-weekly-20261029');
  for (const t of ts) if (view(r, t, start + 1).ready_check) r.lobby.confirm(t, f.id, start + 1);
  await r.lobby.settled();
  assert.equal(r.fired.length, 1);
  assert.equal(r.fired[0]!.schedule, 'fra-weekly');
  // The 9th seat waits; when the window closes it moves to the open queue with its place.
  const closes = start + 120 * 60_000;
  for (const t of ts) r.lobby.touch(t, closes);
  await r.lobby.tick(closes + 1);
  const q = r.lobby.queueView(Q, closes + 1, ctx)!;
  assert.equal(q.seats_filled, 1);
  // The next occurrence is a week later.
  assert.equal(occurrence(r.lobby.state.config.schedules[0]!, closes + 1)!.starts_at, start + 7 * 86_400_000);
});

await test('draining: no ready checks while paused; a forming table dissolves with places kept; joins get 503', async () => {
  const r = rig();
  const ts = await joinAll(r, [[0, 3], [1, 3], [2, 2]]);
  assert.equal(r.lobby.state.forming.length, 1);
  r.lobby.confirm(ts[0]!, r.lobby.state.forming[0]!.id, 1);
  r.paused.on = true;
  await r.lobby.tick(2);
  assert.equal(r.lobby.state.forming.length, 0);
  assert.ok(view(r, ts[0]!, 2).paused);
  assert.equal(view(r, ts[0]!, 2).entries[0].status, 'waiting');
  assert.throws(() => r.lobby.join(people[3]!, { queue: Q, seats: [seat()] }, 2), (e: LobbyError) => e.status === 503);
  r.paused.on = false;
  await r.lobby.tick(3);
  assert.equal(r.lobby.state.forming.length, 1);
});

await test('a table that cannot start dissolves with places kept, and the queue waits a minute before retrying', async () => {
  const r = rig();
  const ts = await joinAll(r, [[0, 3], [1, 3], [2, 2]]);
  r.fail.next = 'the queue is full';
  const f = r.lobby.state.forming[0]!;
  for (const t of ts) r.lobby.confirm(t, f.id, 1);
  await r.lobby.settled();
  assert.equal(r.fired.length, 0);
  assert.match(view(r, ts[0]!, 2).notice, /could not start \(the queue is full\)/);
  await r.lobby.tick(30_000);
  assert.equal(r.lobby.state.forming.length, 0, 'backoff');
  for (const t of ts) r.lobby.touch(t, 61_000);
  await r.lobby.tick(61_000);
  assert.equal(r.lobby.state.forming.length, 1);
});

await test('stats: backers, games, reliability; hidden handles never appear publicly', async () => {
  const r = rig(undefined, 0, undefined, { allowScript: true });
  const tickets = [
    r.lobby.join(people[0]!, { queue: Q, seats: [seat(), seat()], showHandle: true }, 0).ticket,
    r.lobby.join(people[1]!, { queue: Q, seats: [seat(), seat('gpt-6-astra', 'codex')], showHandle: false }, 0).ticket,
    r.lobby.join(people[2]!, { queue: Q, seats: [seat('gpt-6-astra', 'codex'), seat('gpt-6-astra', 'codex'), seat()] }, 0).ticket,
    r.lobby.join(people[3]!, { queue: Q, seats: [seat('script', 'script')] }, 0).ticket,
  ];
  await r.lobby.tick(0);
  const f = r.lobby.state.forming[0]!;
  for (const t of tickets) r.lobby.confirm(t, f.id, 1);
  await r.lobby.settled();
  const t = r.fired[0]!;
  assert.ok(t.seats.some((s) => s.seat_name.startsWith('rand-')), 'scripted seats are named rand-*');
  assert.equal(t.seats.find((s) => s.contributor.id === 2)!.show_handle, false);
  r.lobby.eventFinished('ev-1', 'done', Object.fromEntries(t.seats.map((s, i) => [s.seat_name, { forfeits: i === 0 ? 1 : 0, games: 3 }])), 100);
  const st = r.lobby.stats(100) as View;
  const opus = st.models.find((m: View) => m.model_id === 'claude-opus-5-5');
  assert.equal(opus.backers, 3);
  assert.equal(opus.seats, 4);
  assert.equal(opus.games, 12);
  assert.ok(!st.models.some((m: View) => m.model_id === 'random'), 'scripted seats are not a model');
  assert.ok(!st.contributors.some((c: View) => c.handle === 'p2'), 'hidden contributor not listed');
  assert.equal(r.lobby.contributorStatsView('p2', 100, ctx), undefined);
  const astra = r.lobby.modelStats('gpt-6-astra', 100) as View;
  assert.equal(astra.anonymous_backers, 1);
  assert.deepEqual(astra.contributors.map((c: View) => c.handle), ['p3']);
  assert.ok(!JSON.stringify(r.lobby.overview(100, ctx)).includes('p2'), 'hidden handle not in the lobby overview');
  const p1 = r.lobby.contributorStatsView('P1', 100, ctx) as View;
  assert.equal(p1.recent.length, 1);
  assert.equal(st.totals.tables, 1);
  // p4's only seat was scripted: no seats, tables, finished seats or reliability (LOB-4).
  const p4 = r.lobby.state.stats.contributors['4']!;
  assert.deepEqual([p4.seats, p4.tables, p4.finished, p4.abandoned, p4.games], [0, 0, 0, 0, 0]);
  assert.equal(r.lobby.reliability(4), null);
});

await test('restart durability: entries, tickets, ready checks and stats survive; a ready check restarts with a fresh window', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lobby-'));
  try {
    const file = join(dir, '.lobby', 'state.json');
    const a = rig(new FileLobbyStore(file), 0);
    const ts = await joinAll(a, [[0, 3], [1, 3], [2, 2], [3, 1]], 0);
    const f = a.lobby.state.forming[0]!;
    a.lobby.confirm(ts[0]!, f.id, 10);
    a.lobby.flush();
    assert.equal(statSync(file).mode & 0o777, 0o600);
    // "Restart" 30 s later: a new Lobby from the same file.
    const b = rig(new FileLobbyStore(file), 30_000);
    assert.equal(b.lobby.state.entries.length, 9);
    const g = b.lobby.state.forming[0]!;
    assert.equal(g.id, f.id);
    assert.equal(g.deadline, 30_000 + DEFAULT_LOBBY.readyWindowMs, 'fresh window after the restart');
    assert.equal(view(b, ts[0]!, 30_001).state, 'confirmed', 'confirmation kept');
    for (const t of ts.slice(1)) if (view(b, t, 30_001).ready_check) b.lobby.confirm(t, g.id, 30_001);
    await b.lobby.settled();
    assert.equal(b.fired.length, 1);
    b.lobby.flush();
    // A table that was firing when the process died is recovered from the Director's events.
    const c0 = rig(new FileLobbyStore(file), 40_000);
    const ts2 = [ts[3]!, ...(await joinAll(c0, [[4, 3], [5, 3]], 40_000))];
    const t3 = c0.lobby.join({ id: 7, handle: 'p7' }, { queue: Q, seats: [seat()] }, 40_000).ticket;
    await c0.lobby.tick(40_000);
    const h = c0.lobby.state.forming[0]!;
    h.firing = true; // as if fire() had started when the process died
    c0.lobby.flush();
    void ts2;
    void t3;
    const c = rig(new FileLobbyStore(file), 50_000, (id) => (id === h.id ? { event_id: 'ev-recovered', seats: Object.fromEntries(h.entries.map((e, i) => [e, `s-${i}`])) } : undefined));
    assert.equal(c.lobby.state.forming.length, 0);
    assert.ok(c.lobby.state.fired.some((x) => x.event_id === 'ev-recovered'));
    assert.equal((c.lobby.stats(50_000) as View).totals.tables, 2);
    c.lobby.flush();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await test('restart with an older state file: -bo3 queue keys map to the new key; best-of-1 seats, ready checks, featured queues and schedules are dropped', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lobby-'));
  try {
    const file = join(dir, '.lobby', 'state.json');
    const a = rig(new FileLobbyStore(file), 0);
    const weekly = { day: 'thu', time: '18:00' };
    a.lobby.setConfig({ featured: [Q], schedules: [{ id: 'fra-weekly', name: 'Weekly FRA Draft', queue: Q, weekly }] }, 0);
    // 8 seats in Q: a ready check forms; p1 confirms. p6 waits in another queue that becomes a best-of-1 one.
    const ts = await joinAll(a, [[0, 3], [1, 3], [2, 2]], 0);
    const f = a.lobby.state.forming[0]!;
    a.lobby.confirm(ts[0]!, f.id, 10);
    const bo1 = a.lobby.join(people[5]!, { queue: 'fra-none-auto', seats: [seat(), seat()] }, 10).ticket;
    a.lobby.flush();
    // Rewrite the file as a Director from before the change wrote it.
    const st = JSON.parse(readFileSync(file, 'utf8'));
    for (const e of st.entries) e.queue = e.queue === Q ? `${Q}-bo3` : 'fra-none-auto-bo1';
    for (const x of st.forming) x.queue = `${Q}-bo3`;
    // A best-of-1 ready check of its own (p5's seats), and fired tables under both old keys.
    const p5 = a.lobby.join(people[4]!, { queue: 'fra-none-manual', seats: [seat()] }, 10);
    a.lobby.flush();
    const p5entry = { ...p5.entries[0]!, queue: 'fra-none-manual-bo1', status: 'ready_check' };
    st.entries.push(p5entry);
    st.tickets = JSON.parse(readFileSync(file, 'utf8')).tickets;
    st.forming.push({ id: 't-oldbo1', queue: 'fra-none-manual-bo1', entries: [p5entry.id], confirmed: [], deadline: 20, created_at: 10 });
    st.fired.push({ id: 't-old3', kind: 'lobby', queue: `${Q}-bo3`, event_id: 'ev-old3', fired_at: 5, seats: [] });
    st.fired.push({ id: 't-old1', kind: 'lobby', queue: 'fra-none-auto-bo1', event_id: 'ev-old1', fired_at: 6, seats: [] });
    st.config.featured = [`${Q}-bo3`, 'fra-none-auto-bo1'];
    st.config.schedules = [{ id: 'fra-weekly', name: 'Weekly FRA Draft', queue: `${Q}-bo3`, weekly }, { id: 'fra-bo1', name: 'Old Bo1 Draft', queue: 'fra-none-auto-bo1', weekly }];
    writeFileSync(file, JSON.stringify(st), { mode: 0o600 });

    const errors: string[] = [];
    const orig = console.error;
    console.error = (...m: unknown[]) => void errors.push(m.join(' '));
    let b: Rig;
    try {
      b = rig(new FileLobbyStore(file), 60_000);
    } finally {
      console.error = orig;
    }
    const s2 = b.lobby.state;
    // bo3: nothing lost, under the new key.
    assert.equal(s2.entries.filter((e) => e.queue === Q && e.status !== 'dropped').length, 8);
    assert.equal(s2.forming.length, 1, 'the best-of-1 ready check is gone');
    assert.equal(s2.forming[0]!.id, f.id);
    assert.equal(s2.forming[0]!.queue, Q);
    assert.deepEqual(s2.config.featured, [Q]);
    assert.deepEqual(s2.config.schedules.map((x) => [x.id, x.queue]), [['fra-weekly', Q]]);
    assert.equal(s2.fired.find((x) => x.id === 't-old3')!.queue, Q);
    assert.equal(s2.fired.find((x) => x.id === 't-old1')!.queue, 'fra-none-auto-bo1', 'history keeps the key it played under');
    assert.equal(errors.filter((m) => m.includes(BO1_REMOVED)).length, 2, 'the dropped featured queue and schedule are logged');
    // bo1: the seats left the queue, and their holders are told why.
    for (const t of [bo1, p5.ticket]) {
      const v = view(b, t, 60_001);
      assert.ok((v.entries as View[]).every((e) => e.status === 'dropped'), 'best-of-1 seats were dropped');
      assert.ok(String(v.notice).startsWith(BO1_REMOVED), v.notice);
    }
    assert.equal(view(b, ts[0]!, 60_001).state, 'confirmed', 'a bo3 confirmation is kept');
    // The kept ready check fires under the new key.
    const g = s2.forming[0]!;
    for (const t of ts.slice(1)) b.lobby.confirm(t, g.id, 60_002);
    await b.lobby.settled();
    assert.equal(b.fired.length, 1);
    assert.equal(b.fired[0]!.queue.key, Q);
    b.lobby.flush();
    // The migrated state was saved: a second restart sees the new keys only.
    const again = JSON.parse(readFileSync(file, 'utf8'));
    assert.ok(!JSON.stringify([again.config, again.forming, again.entries.filter((e: { status: string }) => e.status !== 'dropped')]).includes('-bo'), 'no legacy key left in the live state');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await test('long-poll: wait() returns on a change, or after the timeout', async () => {
  const r = rig();
  const rev = r.lobby.state.rev;
  const t0 = Date.now();
  await r.lobby.wait(rev, 50);
  assert.ok(Date.now() - t0 >= 40);
  const p = r.lobby.wait(r.lobby.state.rev, 5_000);
  r.lobby.join(people[0]!, { queue: Q, seats: [seat()] }, 0);
  const t1 = Date.now();
  await p;
  assert.ok(Date.now() - t1 < 1_000);
});

await test('seat identity carries how the effort was declared (launch | self-report); scripted seats have none', () => {
  const r = resolveSeatIdentity({ harness: 'claude-code', model: 'claude-opus-5-5', effort: 'high', effort_basis: 'launch' }, { requireEffort: true });
  assert.ok(r.ok && r.effort_basis === 'launch');
  const x = resolveSeatIdentity({ harness: 'claude-code', model: 'claude-opus-5-5', effort: 'high', effort_basis: 'whatever' }, { requireEffort: true });
  assert.ok(x.ok && x.effort_basis === undefined);
  const t = resolveSeatIdentity({ harness: 'script', effort_basis: 'launch' });
  assert.ok(t.ok && t.effort_basis === undefined);
});

await test('scripted seats: refused in public queues; allowed only with LOBBY_ALLOW_SCRIPT (LOB-4)', async () => {
  const r = rig();
  assert.throws(() => r.lobby.join(people[0]!, { queue: Q, seats: [seat(), seat('script', 'script')] }, 0), (e: LobbyError) => e.status === 400 && /Scripted test seats/.test(e.message));
  assert.equal(r.lobby.state.entries.length, 0, 'nothing joined');
  const dev = rig(undefined, 0, undefined, { allowScript: true });
  assert.ok(dev.lobby.join(people[0]!, { queue: Q, seats: [seat('script', 'script')] }, 0).ticket);
});

await test('churn: left entries and their tickets are forgotten soon, joins are rate-limited, a global cap (LOB-1)', async () => {
  const r = rig(undefined, 0, undefined, { maxJoinsPerHour: 20 });
  // 20 join/leave cycles in an hour: allowed; the 21st join is refused with a Retry-After.
  for (let i = 0; i < 20; i++) {
    const t = r.lobby.join(people[0]!, { queue: Q, seats: [seat(), seat(), seat()] }, i * 1000).ticket;
    r.lobby.leave(t, undefined, i * 1000 + 500);
  }
  assert.throws(() => r.lobby.join(people[0]!, { queue: Q, seats: [seat()] }, 25_000), (e: LobbyError) => e.status === 429 && (e.retryAfterS ?? 0) > 3000);
  assert.ok(r.lobby.join(people[1]!, { queue: Q, seats: [seat()] }, 25_000).ticket, 'other contributors are not affected');
  assert.equal(r.lobby.state.entries.filter((e) => e.status === 'left').length, 60);
  // Ten minutes after they ended, the left entries and their tickets are gone; the live one stays.
  await r.lobby.tick(25_000 + DEFAULT_LOBBY.tombstoneMs);
  assert.equal(r.lobby.state.entries.length, 1);
  assert.equal(r.lobby.state.tickets.length, 1);
  // An hour later the contributor may join again.
  assert.ok(r.lobby.join(people[0]!, { queue: Q, seats: [seat()] }, 3600_000 + 1000).ticket);
  // The global cap on waiting entries answers 503.
  const small = rig(undefined, 0, undefined, { maxActiveEntries: 4 });
  small.lobby.join(people[0]!, { queue: Q, seats: [seat(), seat(), seat()] }, 0);
  assert.throws(() => small.lobby.join(people[1]!, { queue: Q, seats: [seat(), seat()] }, 0), (e: LobbyError) => e.status === 503);
});

await test('churn: saves are batched (at most one a second) and atomic; an older async save never overwrites a newer one (LOB-1)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lobby-save-'));
  try {
    const file = join(dir, '.lobby', 'state.json');
    let saves = 0;
    let asyncSaves = 0;
    class Counting extends FileLobbyStore {
      override save(st: Parameters<FileLobbyStore['save']>[0]) {
        saves++;
        super.save(st);
      }
      override async saveAsync(text: string, isCurrent: () => boolean) {
        asyncSaves++;
        await super.saveAsync(text, isCurrent);
      }
    }
    const r = rig(new Counting(file), 0, undefined, { saveDelayMs: 50 });
    for (let i = 0; i < 30; i++) r.lobby.leave(r.lobby.join(people[i % 6]!, { queue: Q, seats: [seat()] }, i).ticket, undefined, i);
    await new Promise((done) => setTimeout(done, 200));
    assert.equal(saves, 0, 'no synchronous save on the request path');
    assert.ok(asyncSaves >= 1 && asyncSaves <= 2, `batched: ${asyncSaves} async saves for 60 changes`);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).rev, r.lobby.state.rev);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    // A slow async save that finishes after a synchronous flush (shutdown) is discarded.
    const store = new FileLobbyStore(file);
    r.lobby.flush();
    const rev = r.lobby.state.rev;
    await store.saveAsync(JSON.stringify({ ...r.lobby.state, rev: 1 }), () => false);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).rev, rev, 'the newer state stays');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await test('quotas: the lobby has its own quota, separate from Private Tables; at its limit a contributor waits, a spent daily lobby quota refuses joins (LOB-2)', async () => {
  // Private Tables 1 at a time / 6 a day; the lobby 1 at a time / 2 a day here (defaults 2 / 12), counted separately.
  const adm = new Admission({ capacity: 30, maxQueue: 50, contributor: { concurrent: 1, daily: 6 }, lobby: { concurrent: 1, daily: 2 } });
  // p1 has a Private Table running: it doesn't use their lobby quota.
  adm.admit({ id: 'ev-private', owner: { kind: 'contributor', id: 1, handle: 'p1' }, weight: 4, createdAt: 0 }, true, 0);
  // p1 also sits at a running lobby table: their lobby quota (1 at a time) is in use.
  adm.admit({ id: 'ev-lobby-0', owner: { kind: 'lobby', table: 't-earlier' }, weight: 4, createdAt: 0, contributors: [1] }, true, 0);
  const r = rig(undefined, 0, undefined, {}, (id, quotas, pending, now) => adm.quotaState(id, now, quotas, pending));
  const ts = await joinAll(r, [[0, 2], [1, 3], [2, 3]], 0);
  assert.equal(r.lobby.state.forming.length, 0, 'p1 is at their lobby limit: no table with them');
  assert.match(view(r, ts[0]!, 5).message, /lobby limit is in use/);
  // The earlier lobby table ends (the Private Table still runs): the table forms and fires.
  adm.release('ev-lobby-0');
  for (const t of ts) r.lobby.touch(t, 10);
  await r.lobby.tick(10);
  const f = r.lobby.state.forming[0]!;
  assert.ok(f, 'the table forms once p1 has lobby room, with their Private Table still running');
  for (const t of ts) r.lobby.confirm(t, f.id, 11);
  await r.lobby.settled();
  assert.equal(r.fired.length, 1);
  adm.admit({ id: 'ev-lobby', owner: { kind: 'lobby', table: f.id }, weight: 4, createdAt: 11, contributors: [1, 2, 3] }, true, 11);
  const p2 = { kind: 'contributor' as const, id: 2, handle: 'p2' };
  assert.equal(adm.activeLobby(2), 1, 'the lobby table is running for p2');
  assert.equal(adm.active(p2), 0, 'and not as a Private Table');
  assert.equal(adm.check(p2, 4, 12).ok, true, 'p2 may start a Private Table while seated in the lobby');
  assert.equal(adm.createdToday(p2, 20), 0, 'lobby tables never use the Private Table daily quota');
  assert.equal(adm.lobbyCreatedToday(3, 20), 1);
  // p1 has now been seated at 2 lobby tables today (lobby daily 2): joining again is refused until the oldest is a day old.
  assert.throws(() => r.lobby.join(people[0]!, { queue: Q, seats: [seat()] }, 20), (e: LobbyError) => e.status === 429 && /daily lobby limit/i.test(e.message) && /Private Tables are counted separately/.test(e.message));
  // The Hub's lobby quotas for a contributor win over the Director's defaults.
  assert.equal(adm.quotaState(1, 20, { daily: 3 }).refuse, undefined, 'a raised lobby daily quota lets p1 join again');
  // A Private Table quota spent doesn't stop the lobby, and the other way round.
  const b = new Admission({ capacity: 30, maxQueue: 50, contributor: { concurrent: 9, daily: 1 }, lobby: { concurrent: 9, daily: 1 } });
  const p9 = { kind: 'contributor' as const, id: 9, handle: 'p9' };
  b.admit({ id: 'priv-9', owner: p9, weight: 4, createdAt: 0 }, true, 0);
  assert.equal(b.check(p9, 4, 1).ok, false, 'Private Table daily quota spent');
  assert.equal(b.quotaState(9, 1).seatable, true, 'the lobby is still open to p9');
  b.admit({ id: 'lob-9', owner: { kind: 'lobby', table: 't-9' }, weight: 4, createdAt: 2, contributors: [9] }, true, 2);
  assert.match(b.quotaState(9, 3).refuse ?? '', /daily lobby limit/);
  assert.equal(b.createdToday(p9, 3), 1, 'the lobby table did not count as a Private Table');
});

await test("Hub visibility: the Hub's hide setting wins over show_handle, at join and when read later (LOB-3)", async () => {
  const r = rig();
  // p1 says show in the lobby, but hid their handle on the Hub: hidden.
  const tickets = [
    r.lobby.join(people[0]!, { queue: Q, seats: [seat(), seat(), seat()], showHandle: true, visibility: 'hidden' }, 0).ticket,
    r.lobby.join(people[1]!, { queue: Q, seats: [seat(), seat(), seat()] }, 0).ticket,
    r.lobby.join(people[2]!, { queue: Q, seats: [seat(), seat()] }, 0).ticket,
  ];
  await r.lobby.tick(0);
  assert.ok(!JSON.stringify(r.lobby.overview(1, ctx)).includes('"p1"'), 'hidden in the queue view');
  assert.ok(JSON.stringify(r.lobby.overview(1, ctx)).includes('"p2"'), 'shown by default');
  const f = r.lobby.state.forming[0]!;
  for (const t of tickets) r.lobby.confirm(t, f.id, 1);
  await r.lobby.settled();
  const t = r.fired[0]!;
  assert.ok(t.seats.filter((x) => x.contributor.id === 1).every((x) => !x.show_handle), 'the event log gets no handle for p1');
  assert.ok(t.seats.filter((x) => x.contributor.id === 2).every((x) => x.show_handle));
  r.lobby.eventFinished('ev-1', 'done', Object.fromEntries(t.seats.map((x) => [x.seat_name, { forfeits: 0, games: 3 }])), 100);
  // Later p2 hides on the Hub: the next visibility read hides them everywhere in the lobby.
  r.lobby.applyVisibility({ 2: 'hidden', 1: 'hidden', 999: 'public' });
  const st = JSON.stringify(r.lobby.stats(200)) + JSON.stringify(r.lobby.overview(200, ctx));
  assert.ok(!st.includes('"p2"') && !st.includes('"p1"'), 'p1 and p2 hidden in stats and recent tables');
  assert.equal(r.lobby.contributorStatsView('p2', 200, ctx), undefined);
  assert.ok(st.includes('"p3"'));
  // 'public' on the Hub wins over a lobby --hide-handle; null follows the lobby choice again.
  r.lobby.join(people[3]!, { queue: 'fra-none-auto', seats: [seat()], showHandle: false, visibility: 'public' }, 300);
  assert.equal(r.lobby.shown(4), true);
  r.lobby.applyVisibility({ 4: null });
  assert.equal(r.lobby.shown(4), false);
  assert.deepEqual(r.lobby.contributorIds().sort(), [1, 2, 3, 4]);
});

await test('recent tables list Private Tables too, admin ones included; an admin table never counts as contribution', async () => {
  const r = rig();
  r.lobby.notePrivate('ev-private', people[0]!, [{ seat_name: 'seat-aaaaaa', seat: seat() }], 0);
  // The first hosted 8-seat test table: an admin Private Table of 8 Haiku seats.
  const eight = [...Array(8)].map((_, i) => ({ seat_name: `seat-00000${i}`, seat: seat('claude-haiku-5-5', 'claude-code', 'low') }));
  r.lobby.noteAdminTable('ev-admin', eight, 1);
  // Scripted seats only (smoke and load tests on the hosted Director): not listed.
  r.lobby.noteAdminTable('ev-smoke', [{ seat_name: 'rand-1', seat: { ...seat(), test: true } }, { seat_name: 'rand-2', seat: null }], 2);
  const recent = r.lobby.recentTables(0, ctx);
  assert.deepEqual(recent.map((t) => t.event_id), ['ev-admin', 'ev-private']);
  assert.ok(recent.every((t) => t.kind === 'private'));
  assert.equal(recent[0]!.contributors, 0, 'no contributor at an admin table');
  assert.deepEqual(recent[0]!.seats, [], 'running: no seats listed (LOB-5)');
  r.lobby.eventFinished('ev-admin', 'done', Object.fromEntries(eight.map((s) => [s.seat_name, { forfeits: 0, games: 3 }])), 10);
  const stats = r.lobby.stats(10) as View;
  assert.ok(!JSON.stringify(stats.models ?? {}).includes('claude-haiku-5-5'), 'admin seats are not contribution');
  const ended = r.lobby.recentTables(0, { ...ctx, eventInfo: (id: string) => ({ ...ctx.eventInfo(id)!, stage: 'done' }) });
  assert.equal((ended[0]!.seats as unknown[]).length, 8, 'its seats are listed once it has ended');
});

await test('context policy: carried per seat from the join to the fired table; validated; holder-only, never public, never a queue split', async () => {
  const r = rig();
  // Contributor 0 launches with a fresh session per game, 1 per match on one seat, 2 seats by hand ("harness" or absent).
  const t0 = r.lobby.join(people[0]!, { queue: Q, seats: [{ ...seat(), context_policy: 'fresh-per-game' }, { ...seat(), context_policy: 'fresh-per-game' }, { ...seat(), context_policy: 'fresh-per-game' }] }, 0).ticket;
  const t1 = r.lobby.join(people[1]!, { queue: Q, seats: [{ ...seat(), context_policy: 'fresh-per-match' }, seat(), { ...seat(), context_policy: 'harness' }] }, 1).ticket;
  // Allowed values only: nothing joins on a bad one.
  for (const bad of ['fresh-per-turn', 'off', 'per-game', 7, { x: 1 }, '']) {
    assert.throws(() => r.lobby.join(people[2]!, { queue: Q, seats: [{ ...seat(), context_policy: bad }] }, 2), (e: LobbyError) => e.status === 400 && /Seat 1: context_policy must be fresh-per-match or fresh-per-game/.test(e.message), String(bad));
  }
  assert.equal(r.lobby.state.entries.filter((e) => e.contributor.id === 3).length, 0, 'a refused join adds nothing');
  const t2 = r.lobby.join(people[2]!, { queue: Q, seats: [seat(), { ...seat(), context_policy: null }] }, 3).ticket;
  await r.lobby.tick(4);
  // Mixed policies form one table: a launch condition, not a separate queue.
  const f = r.lobby.state.forming[0]!;
  assert.ok(f, 'one table forms across policies');
  assert.equal(f.entries.length, 8);
  // The holder sees each seat's policy ("harness" for none), in the join answer's entries and at the table.
  assert.deepEqual((view(r, t1, 5).entries as View[]).map((e) => e.context_policy), ['fresh-per-match', 'harness', 'harness']);
  assert.ok(!r.lobby.state.entries.some((e) => 'context_policy' in e.seat), 'never part of the seat identity');
  // Nothing public shows it.
  const pub = JSON.stringify([r.lobby.overview(5, ctx), r.lobby.queueView(Q, 5, ctx), r.lobby.stats(5), r.lobby.scheduleViews(5, ctx)]);
  assert.ok(!pub.includes('context_policy') && !pub.includes('fresh-per'), 'public views carry no context policy');
  for (const t of [t0, t1, t2]) r.lobby.confirm(t, f.id, 6);
  await r.lobby.settled();
  const fired = r.fired[0]!;
  const byEntry = new Map(r.lobby.state.entries.map((e) => [e.id, e]));
  const policyOf = (who: number) => fired.seats.filter((s) => s.contributor.id === who).map((s) => s.context_policy ?? '-').sort();
  assert.deepEqual(policyOf(1), ['fresh-per-game', 'fresh-per-game', 'fresh-per-game']);
  assert.deepEqual(policyOf(2), ['-', '-', 'fresh-per-match']);
  assert.deepEqual(policyOf(3), ['-', '-']);
  for (const s of fired.seats) assert.equal(s.context_policy, byEntry.get(s.entry_id)!.context_policy, 'each seat keeps its own entry\'s policy');
  const seated = view(r, t0, 7);
  assert.deepEqual(Object.values(seated.tables[0].seats as Record<string, View>).map((x) => x.context_policy), ['fresh-per-game', 'fresh-per-game', 'fresh-per-game']);
  const ended = r.lobby.recentTables(7, { ...ctx, eventInfo: (id: string) => ({ ...ctx.eventInfo(id)!, stage: 'done' }) });
  assert.ok(!JSON.stringify(ended).includes('context_policy'), 'recent tables carry no context policy');
  // Saved with the entry: a restart keeps it.
  const store = new MemoryLobbyStore();
  const a = rig(store);
  a.lobby.join(people[0]!, { queue: Q, seats: [{ ...seat(), context_policy: 'fresh-per-game' }] }, 0);
  a.lobby.flush();
  const b = rig(store, 1);
  assert.equal(b.lobby.state.entries[0]!.context_policy, 'fresh-per-game');
});

await test('diversity-aware filling: at most maxSameSetup seats of one setup, the rest wait, then fill after the wait (§10)', async () => {
  const r = rig(new MemoryLobbyStore(), 0, undefined, { maxSameSetup: 4, sameSetupWaitMs: 60 * 60_000 });
  const opus = seat();
  const sonnet = seat('claude-sonnet-5-5');
  const haiku = seat('claude-haiku-5-5', 'claude-code', 'low');
  // Six Opus seats from two contributors first, then two Sonnet and two Haiku seats.
  r.lobby.join(people[0]!, { queue: Q, seats: [opus, opus, opus] }, 0);
  r.lobby.join(people[1]!, { queue: Q, seats: [opus, opus, opus] }, 1);
  r.lobby.join(people[2]!, { queue: Q, seats: [sonnet, sonnet] }, 2);
  const late = r.lobby.join(people[3]!, { queue: Q, seats: [haiku, haiku] }, 3).ticket;
  await r.lobby.tick(4);
  const f = r.lobby.state.forming[0]!;
  assert.ok(f, 'a table forms from 4 Opus, 2 Sonnet and 2 Haiku seats');
  const keys = f.entries.map((id) => r.lobby.state.entries.find((e) => e.id === id)!.seat.model_id);
  assert.equal(keys.filter((m) => m === 'claude-opus-5-5').length, 4, 'two Opus seats wait for the next table');
  assert.ok(view(r, late, 5).state === 'ready_check', 'a later, different setup is seated ahead of a fifth Opus seat');
  const needs = r.lobby.queueView(Q, 5, ctx)!.needs as View;
  assert.equal(needs.seats, 2, 'the two Opus seats left wait for the next table, at the front of the queue');
  assert.equal(needs.held_back, 0);
});

await test('needs: setups at the cap, rated games, one sentence; a table of one setup never forms, even after the wait', async () => {
  const r = rig(new MemoryLobbyStore(), 0, undefined, { maxSameSetup: 4, sameSetupWaitMs: 60_000 });
  r.lobby.join(people[0]!, { queue: Q, seats: [seat(), seat(), seat()] }, 0);
  r.lobby.join(people[1]!, { queue: Q, seats: [seat(), seat(), seat()] }, 1);
  await r.lobby.tick(2);
  let needs = r.lobby.queueView(Q, 2, ctx)!.needs as View;
  assert.equal(needs.seats, 4);
  assert.equal(needs.missing, 4);
  assert.deepEqual((needs.at_cap as View[]).map((x) => x.identity_label), ['Claude Opus 5.5 · High']);
  assert.equal(needs.held_back, 2);
  // 4 Opus + 4 new setups: the real Swiss (version 3) rates a median 11 of 12 matches (rated-estimate.ts).
  assert.equal(needs.text, 'Needs 4 more seats, any setup other than Claude Opus 5.5 · High; then about 11 of 12 matches rated.');
  assert.equal(needs.rated_matches, 11);
  assert.equal(needs.matches, 12);
  assert.equal(needs.rated_games, 26, 'round(11 × 2.4)');
  assert.equal(needs.games, 29);
  r.lobby.join(people[2]!, { queue: Q, seats: [seat(), seat()] }, 3);
  // Long past the wait: 8 Opus seats present, but a table that could rate nothing never forms.
  for (const t of r.lobby.state.tickets) t.last_seen = 10 * 60_000;
  await r.lobby.tick(10 * 60_000);
  assert.equal(r.lobby.state.forming.length, 0);
  needs = r.lobby.queueView(Q, 10 * 60_000, ctx)!.needs as View;
  assert.equal(needs.seats, 7, 'relaxed after the wait: up to 7 of one setup, so one more setup still fires it');
});

await test('ratedMatchesFor: the real Swiss (version 3) over simulated pods, the same estimate setup shows (mix.ts)', () => {
  const pick = (c: number[]) => { const r = ratedMatchesFor(c, 8); return { matches: r.matches, rated: r.rated, min: r.min, max: r.max }; };
  // 4 + 4 isn't every match: a pod rates 8–12, a median 10 (mean about 10.5).
  assert.deepEqual(pick([4, 4]), { matches: 12, rated: 10, min: 8, max: 12 });
  assert.ok(Math.abs(ratedMatchesFor([4, 4], 8).mean - 10.5) < 0.2);
  assert.equal(ratedMatchesText(ratedMatchesFor([4, 4], 8)), 'about 10 of 12 matches rated');
  assert.deepEqual(pick([8]), { matches: 12, rated: 0, min: 0, max: 0 });
  assert.equal(ratedMatchesText(ratedMatchesFor([8], 8)), 'none of the 12 matches rated');
  assert.deepEqual(pick([7, 1]), { matches: 12, rated: 3, min: 3, max: 3 });
  assert.equal(ratedMatchesFor([6, 2], 8).rated, 6);
  assert.equal(ratedMatchesFor([5, 3], 8).rated, 9);
  assert.equal(ratedMatchesText(ratedMatchesFor([1, 1, 1, 1, 1, 1, 1, 1], 8)), 'all 12 matches rated');
  assert.equal(ratedMatchesText(ratedMatchesFor([2, 2, 2, 2], 8)), 'nearly all 12 matches rated', 'most pods rate every match, some 10 or 11');
  // A table still filling: the missing seats count as new setups.
  assert.deepEqual(ratedMatchesFor([4], 8), ratedMatchesFor([4, 1, 1, 1, 1], 8));
  // Deterministic and cached per composition: the same object, whatever the order of the counts.
  assert.equal(ratedMatchesFor([3, 5], 8), ratedMatchesFor([5, 3], 8));
});

await test('expiry: a ticket whose seats waited 24 hours unseated says so, with the command to join again (C-2)', async () => {
  const r = rig();
  const t = r.lobby.join(people[0]!, { queue: Q, seats: [seat(), seat('claude-sonnet-5-5')] }, 0).ticket;
  await r.lobby.tick(DEFAULT_LOBBY.entryTtlMs + 1);
  const v = view(r, t, DEFAULT_LOBBY.entryTtlMs + 2);
  assert.equal(v.state, 'done');
  assert.match(v.message, /^Your 2 seats waited 24 hours without a full table and left the queue \(nothing ran, no tokens were used\)\. To keep waiting, join again: `.* lobby join --queue fra-primer-manual --seat claude-code\/claude-opus-5-5\/high --seat claude-code\/claude-sonnet-5-5\/high`\.$/);
});

await test('hosted config: deploy/lobby.json is valid, features the newest featured set\'s main condition, and has no schedule', () => {
  const repo = join(import.meta.dirname, '../../..');
  const file = JSON.parse(readFileSync(join(repo, 'deploy/lobby.json'), 'utf8')) as { featured: string[]; schedules: unknown[] };
  assert.deepEqual(configProblems(file), []);
  const rotation = JSON.parse(readFileSync(join(repo, 'sets/rotation.json'), 'utf8')) as { featured: Array<{ code: string; primer: boolean }> };
  // The lobby features the newest set (rotation order, newest first); the others stay joinable.
  assert.deepEqual(file.featured, [`${rotation.featured[0]!.code.toLowerCase()}-primer-manual`],
    'the Set Context · Manual Mana queue of the first featured set in sets/rotation.json: update deploy/lobby.json with the rotation');
  assert.ok(rotation.featured.every((s) => s.primer), 'every featured set has a Set Context (the main condition needs one)');
  assert.deepEqual(file.schedules, [], 'no scheduled tables (docs/LOBBY.md §2.5)');
});

await test('LOBBY_CONFIG at start: seeds a fresh lobby; with "always" replaces what an admin set; an invalid file changes nothing', () => {
  const store = new MemoryLobbyStore();
  const a = rig(store);
  assert.deepEqual(applyStartConfig(a.lobby, { featured: ['fra-primer-manual'] }, 'seed', true, 0), { applied: true });
  assert.deepEqual(a.lobby.state.config.featured, ['fra-primer-manual']);
  // An admin changes it by hand (PUT /api/admin/lobby/config); the state persists.
  a.lobby.setConfig({ featured: ['tla-none-auto'], schedules: [{ id: 'adhoc', name: 'Ad Hoc', queue: 'tla-none-auto', at: '2026-11-01T18:00:00Z' }] }, 1);
  a.lobby.flush();
  const file = { featured: ['fra-primer-manual', 'sos-primer-manual'], schedules: [] };
  // Next start without "always": the stored config stays.
  const b = rig(store);
  assert.deepEqual(applyStartConfig(b.lobby, file, 'seed', false, 2), { applied: false });
  assert.deepEqual(b.lobby.state.config.featured, ['tla-none-auto']);
  // With "always" (the hosted stack): the committed file wins, schedules included.
  assert.deepEqual(applyStartConfig(b.lobby, file, 'always', false, 3), { applied: true });
  assert.deepEqual(b.lobby.state.config.featured, ['fra-primer-manual', 'sos-primer-manual']);
  assert.deepEqual(b.lobby.state.config.schedules, []);
  // An invalid file: refused with the reason, nothing changes.
  const bad = applyStartConfig(b.lobby, { featured: ['fra-primer-manual-bo1'] }, 'always', false, 4);
  assert.equal(bad.applied, false);
  assert.match(bad.error ?? '', /featured/);
  assert.deepEqual(b.lobby.state.config.featured, ['fra-primer-manual', 'sos-primer-manual']);
});

console.log(`\n${passed} lobby tests passed`);
