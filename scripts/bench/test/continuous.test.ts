// Keep Playing (continuous play): limits, the loop's decisions, backoff, set rotation, lobby wait information.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  backoffMs, inAllText, limitsText, lobbyOverview, lobbyWait, MAX_FAILURES, nextStep, parseLimits, perTable, queueKeyOf, sameQueueKey, setFor, tokenCount,
  type LobbyView,
} from '../continuous.js';

test('limits: text, combinations, none, objects, errors', () => {
  assert.deepEqual(parseLimits('5 tables'), { tables: 5 });
  assert.deepEqual(parseLimits('8 hours, $50, 200M tokens'), { hours: 8, usd: 50, tokens: 200_000_000 });
  assert.deepEqual(parseLimits('3 drafts or 90 min'), { tables: 3, hours: 1.5 });
  assert.deepEqual(parseLimits('50 usd and 1.5b tokens'), { usd: 50, tokens: 1_500_000_000 });
  assert.deepEqual(parseLimits('none'), {});
  assert.deepEqual(parseLimits(undefined), {});
  assert.deepEqual(parseLimits({ tables: 4, tokens: '200M' }), { tables: 4, tokens: 200_000_000 });
  assert.equal(typeof parseLimits('lots'), 'string');
  assert.equal(typeof parseLimits('0 tables'), 'string');
  assert.equal(typeof parseLimits({ hours: -1 }), 'string');
  assert.equal(tokenCount('250k'), 250_000);
  assert.equal(tokenCount('1234'), 1234);
  assert.equal(limitsText({}), '');
  assert.equal(limitsText({ tables: 5 }), '5 tables');
  assert.match(limitsText({ tables: 5, hours: 8, usd: 60 }), /^5 tables or 8 h or \$60 .*whichever comes first$/);
});

const per = { minutes: [30, 90] as [number, number], tokens: [1e6, 3e6] as [number, number], usd: [5, 15] as [number, number] };
const t0 = Date.parse('2026-11-01T00:00:00Z');

test('the loop goes on until a limit or a stop request', () => {
  const p = { tables: 0, startedAt: t0, tokens: 0, usd: 0 };
  assert.deepEqual(nextStep(p, {}, per, t0, null), { go: true });
  assert.equal(nextStep(p, {}, per, t0, 'graceful').go, false);
  const stop = nextStep(p, {}, per, t0, 'now');
  assert.ok(!stop.go && stop.reason === 'stop_requested');
  const tables = nextStep({ ...p, tables: 3 }, { tables: 3 }, per, t0, null);
  assert.ok(!tables.go && tables.reason === 'max_tables');
  assert.deepEqual(nextStep({ ...p, tables: 2 }, { tables: 3 }, per, t0, null), { go: true });
  // 7 h in, an 8 h limit and a table of about an hour: don't start another one.
  const hours = nextStep(p, { hours: 8 }, per, t0 + 7.2 * 3600_000, null);
  assert.ok(!hours.go && hours.reason === 'max_hours');
  assert.deepEqual(nextStep(p, { hours: 8 }, per, t0 + 6 * 3600_000, null), { go: true });
  // Budgets: stop when the next table would likely go over (its midpoint estimate).
  const tok = nextStep({ ...p, tokens: 9e6 }, { tokens: 10e6 }, per, t0, null);
  assert.ok(!tok.go && tok.reason === 'max_tokens');
  assert.deepEqual(nextStep({ ...p, tokens: 7e6 }, { tokens: 10e6 }, per, t0, null), { go: true });
  const usd = nextStep({ ...p, usd: 45 }, { usd: 50 }, per, t0, null);
  assert.ok(!usd.go && usd.reason === 'max_usd');
});

test('backoff doubles from a minute up to 30 minutes; five failures in a row stop the loop', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 9].map((n) => backoffMs(n) / 60_000), [1, 2, 4, 8, 16, 30, 30]);
  assert.equal(MAX_FAILURES, 5);
});

test('set rotation', () => {
  assert.equal(setFor(0, 'fra', []), 'fra');
  assert.equal(setFor(5, 'fra', []), 'fra');
  assert.deepEqual([0, 1, 2, 3].map((n) => setFor(n, 'fra', ['fra', 'tla', 'msh'])), ['fra', 'tla', 'msh', 'fra']);
});

const now = Date.parse('2026-11-01T18:00:00Z');
const view = (q: Partial<NonNullable<LobbyView['queues']>[number]> | null, extra: Partial<LobbyView> = {}): LobbyView => ({
  director: { paused: false },
  queues: q ? [{ key: 'fra-primer-manual', set: 'FRA', seats_filled: 0, seats_needed: 8, seats_per_table: 8, oldest_wait_s: null, status: 'waiting', ...q }] : [],
  scheduled: [],
  recent: [],
  ...extra,
});

test('lobby wait: only what the lobby state says', () => {
  const key = queueKeyOf('FRA', 'primer', 'manual');
  assert.equal(key, 'fra-primer-manual');
  assert.equal(queueKeyOf('tla', 'primer+stats', 'auto'), 'tla-primer-stats-auto');
  assert.match(lobbyWait(undefined, key, 1, now), /unknown/);
  assert.match(lobbyWait(view(null, { director: { paused: true } }), key, 1, now), /paused/);
  assert.match(lobbyWait(view(null), key, 2, now), /^No one is waiting in this queue right now: your seats may wait hours unless others join\./);
  // No scheduled table: never point at scheduled tables that don't exist, and never at a `bench` command contributors don't have.
  assert.doesNotMatch(lobbyWait(view(null), key, 2, now), /Scheduled tables|`bench /);
  assert.match(lobbyWait(view(null), key, 2, now), /Waiting costs nothing/);
  const waiting = lobbyWait(view({ seats_filled: 5, seats_needed: 3, oldest_wait_s: 2400 }), key, 1, now);
  assert.equal(waiting, 'Right now: FRA table 5/8, waiting for 3 more; the oldest seat has waited 40 min.');
  assert.match(lobbyWait(view({ seats_filled: 6, seats_needed: 2, oldest_wait_s: 600 }), key, 2, now), /Your seats would fill it/);
  // 6 present but needing 2 from someone else (the per-contributor cap): one seat can't fill it.
  assert.doesNotMatch(lobbyWait(view({ seats_filled: 6, seats_needed: 2 }), key, 1, now), /would fill/);
  const busy = view({ seats_filled: 2, seats_needed: 6, oldest_wait_s: 300 }, {
    recent: [
      { queue: key, kind: 'lobby', fired_at: '2026-11-01T15:00:00Z' },
      { queue: key, kind: 'lobby', fired_at: '2026-10-30T15:00:00Z' },
      { queue: key, kind: 'lobby', fired_at: '2026-10-01T15:00:00Z' },
      { queue: 'tla-primer-manual', kind: 'lobby', fired_at: '2026-11-01T17:00:00Z' },
    ],
  });
  assert.match(lobbyWait(busy, key, 1, now), /2 tables started from this queue in the last 7 days, the last one 3 h ago\./);
  const sched = view(null, { scheduled: [{ name: 'Weekly FRA Draft', queue: key, starts_at: '2026-11-05T18:00:00Z', state: 'signup' }] });
  assert.match(lobbyWait(sched, key, 1, now), /Next scheduled table: Weekly FRA Draft, Thu, 05 Nov 2026 18:00 UTC\./);
});

test('lobby wait: a Director from before the change (queue keys ending in -bo3) is the same queue', () => {
  assert.equal(sameQueueKey('FRA-primer-manual-bo3'), 'fra-primer-manual');
  assert.equal(sameQueueKey('fra-primer-manual'), 'fra-primer-manual');
  assert.equal(sameQueueKey('fra-primer-manual-bo1'), 'fra-primer-manual-bo1', 'a best-of-1 queue is another queue');
  const key = queueKeyOf('fra', 'primer', 'manual');
  const old = view({ key: 'fra-primer-manual-bo3', seats_filled: 5, seats_needed: 3, oldest_wait_s: 2400 }, {
    recent: [{ queue: 'fra-primer-manual-bo3', kind: 'lobby', fired_at: '2026-11-01T15:00:00Z' }, { queue: 'fra-primer-manual-bo1', kind: 'lobby', fired_at: '2026-11-01T16:00:00Z' }],
    scheduled: [{ name: 'Weekly FRA Draft', queue: 'fra-primer-manual-bo3', starts_at: '2026-11-05T18:00:00Z', state: 'signup' }],
  });
  const text = lobbyWait(old, key, 1, now);
  assert.match(text, /^Right now: FRA table 5\/8, waiting for 3 more; the oldest seat has waited 40 min\./);
  assert.match(text, /1 table started from this queue in the last 7 days, the last one 3 h ago\./);
  assert.match(text, /Next scheduled table: Weekly FRA Draft/);
});

test('lobby overview for the table question', () => {
  assert.equal(lobbyOverview(undefined), '');
  assert.match(lobbyOverview(view(null)), /no one is waiting/);
  assert.equal(lobbyOverview(view({ seats_filled: 5, seats_needed: 3 })), 'Right now: 5 seats waiting at 1 open table (fullest: FRA 5/8).');
});

test('Keep Playing: how many tables the limits allow, with no token or dollar projection', () => {
  const perSeat = { input: [100_000, 200_000], cached_input: [4e6, 30e6], output: [60_000, 240_000], usd: [5, 35] };
  const pt = perTable([50, 150], perSeat, 8);
  assert.deepEqual(pt.tokens, [1_280_000, 3_520_000]);
  assert.deepEqual(pt.usd, [40, 280]);
  const five = inAllText({ limits: { tables: 5 }, minutes: [50, 150], hostedPrivate: true });
  assert.match(five, /^up to 5 tables\. Each table counts toward your daily Private Table limit/);
  const hours = inAllText({ limits: { hours: 4 }, minutes: [50, 150], hostedPrivate: false });
  assert.match(hours, /^1 to 4 tables before a limit is reached/);
  const budget = inAllText({ limits: { tables: 5, usd: 300 }, minutes: [50, 150], hostedPrivate: false });
  assert.equal(budget, "up to 5 tables. It also stops before a table would take your seats' reported usage past $300.");
  assert.match(inAllText({ limits: { tokens: 200e6 }, minutes: [50, 150], hostedPrivate: false }), /^one table at a time until your seats' reported usage would pass 200 M tokens\./);
  const none = inAllText({ limits: {}, minutes: [50, 150], hostedPrivate: true, dailyLimit: 4 });
  assert.match(none, /^no limit: about 4 tables a day/);
  const own = inAllText({ limits: {}, minutes: [50, 150], hostedPrivate: false });
  assert.match(own, /^no limit: about 9 to 28 tables a day/);
  const lobby = inAllText({ limits: {}, minutes: [50, 150], hostedPrivate: false, lobby: true });
  assert.match(lobby, /^no limit: one table at a time, as often as the queue fills \(at most about 28 a day\)/);
  for (const t of [five, hours, budget, none, own, lobby]) assert.doesNotMatch(t, /API list prices|roughly|cached/);
});
