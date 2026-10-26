/**
 * The draft clocks (event.ts checkDraftClocks): a pick past DRAFT_PICK_MS is made by the bot policy and the seat keeps
 * drafting; a first pick still open after FIRST_PICK_MS stops the event (draft_stalled) with a reason naming the seats;
 * a seat waiting out a Director restart keeps its resume grace.
 *   npx tsx packages/director/src/draft-clock.test.ts
 */
import assert from 'node:assert/strict';
import { DEFAULT_DRAFT_PICK_MS, DEFAULT_FIRST_PICK_MS, Event } from './event.js';
import { AgentSeat, type Offer } from './seat.js';

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok - ${name}`);
}

const T0 = 1_800_000_000_000;

/** An Event in its draft with the given seats (what checkIdle reads), logging into `logged`. */
function draftEvent(seats: AgentSeat[], extra: Record<string, unknown> = {}) {
  const logged: Array<Record<string, any>> = [];
  const stalls: Array<{ reason: string; message: string }> = [];
  const ev: any = Object.create(Event.prototype);
  Object.assign(ev, {
    cfg: {}, stage: 'draft', aborted: undefined, seats, startedAt: T0, forfeits: new Map(),
    log: (type: string, d: Record<string, unknown>) => logged.push({ type, ...d }),
    onStall: (reason: string, message: string) => stalls.push({ reason, message }),
    ...extra,
  });
  return { ev: ev as Event, logged, stalls };
}

/** Offer seat `s` a draft pick created at `at`; returns how often its forfeit ran. */
function offerPick(s: AgentSeat, pack: number, pick: number, at: number) {
  const settled = { n: 0 };
  const offer: Offer = {
    id: s.nextId('D'), phase: 'draft', kind: 'draft_pick', text: 'pick', options: [], createdAt: at, draftPick: { pack, pick },
    answer: async () => null,
    forfeit: () => {
      settled.n++;
      s.clear();
      return { pack_number: pack, pick_number: pick, pick: 'Some Card' };
    },
  };
  s.offer(offer);
  return settled;
}

test('the defaults: 75 s a pick, 3 minutes for the first', () => {
  assert.equal(DEFAULT_DRAFT_PICK_MS, 75_000);
  assert.equal(DEFAULT_FIRST_PICK_MS, 180_000);
});

test('a pick past the clock is made by the bot policy, logged as pick_clock; the seat keeps drafting', () => {
  const a = new AgentSeat('seat-aaaaaa', 0);
  a.lastActivity = T0;
  const { ev, logged, stalls } = draftEvent([a]);
  const settled = offerPick(a, 1, 3, T0);
  ev.checkIdle(T0 + DEFAULT_DRAFT_PICK_MS - 1);
  assert.equal(settled.n, 0, 'not before the clock');
  ev.checkIdle(T0 + DEFAULT_DRAFT_PICK_MS);
  assert.equal(settled.n, 1);
  const f = logged.find((r) => r.type === 'forfeit')!;
  assert.deepEqual([f.reason, f.stage, f.pick], ['pick_clock', 'draft', 'Some Card']);
  assert.equal(a.inactive, false, 'one late pick does not hand the seat to the bot');
  assert.equal(stalls.length, 0);
});

test('a seat that keeps calling without answering is still on the clock', () => {
  const a = new AgentSeat('seat-aaaaaa', 0);
  const { ev } = draftEvent([a]);
  const settled = offerPick(a, 2, 5, T0);
  a.beginRequest();
  ev.checkIdle(T0 + DEFAULT_DRAFT_PICK_MS + 1);
  assert.equal(settled.n, 1);
});

test('a first pick still open after 3 minutes stops the event, naming the seats and why', () => {
  const never = new AgentSeat('seat-111111', 0);
  const slow = new AgentSeat('seat-222222', 1);
  const fine = new AgentSeat('seat-333333', 2);
  slow.lastActivity = T0 + 5_000;
  fine.lastActivity = T0 + 5_000;
  const { ev, stalls } = draftEvent([never, slow, fine]);
  offerPick(never, 1, 1, T0);
  offerPick(slow, 1, 1, T0);
  ev.checkIdle(T0 + DEFAULT_FIRST_PICK_MS - 1);
  assert.equal(stalls.length, 0, 'the first pick gets its full 3 minutes, connected or not');
  ev.checkIdle(T0 + DEFAULT_FIRST_PICK_MS);
  assert.equal(stalls.length, 1);
  assert.equal(stalls[0]!.reason, 'draft_stalled');
  assert.match(stalls[0]!.message, /^The event was stopped: The draft stalled on pack 1, pick 1: seat-111111 never connected; seat-222222 connected but made no first pick within 180 s/);
  assert.doesNotMatch(stalls[0]!.message, /seat-333333/);
  assert.match(ev.abortDetail!, /harness logs/);
});

test('without a server the stalled event stops itself (abort)', () => {
  const a = new AgentSeat('seat-111111', 0);
  const { ev, logged } = draftEvent([a], { onStall: undefined, liveGames: new Set(), sessions: new Map(), gamesOver: 0, dir: '/nonexistent' });
  offerPick(a, 1, 1, T0);
  ev.checkIdle(T0 + DEFAULT_FIRST_PICK_MS);
  const rec = logged.find((r) => r.type === 'event_abort')!;
  assert.deepEqual([rec.reason, rec.stage], ['draft_stalled', 'draft']);
  assert.match(rec.detail, /seat-111111 never connected/);
  assert.match(a.done!, /^EVENT COMPLETE\. The event was stopped: The draft stalled/);
});

test('after a restart, a seat that has not called since keeps its resume grace', () => {
  const a = new AgentSeat('seat-aaaaaa', 0);
  a.lastActivity = T0;
  const resumedAt = T0 + 1_000;
  const { ev, logged } = draftEvent([a], { resumedAt });
  const settled = offerPick(a, 1, 4, T0);
  ev.checkIdle(resumedAt + DEFAULT_DRAFT_PICK_MS + 1);
  assert.equal(settled.n, 0);
  a.lastActivity = resumedAt + 10_000; // it called after the restart
  ev.checkIdle(resumedAt + DEFAULT_DRAFT_PICK_MS + 1);
  assert.equal(settled.n, 1, 'once it calls again, the clock (counted from the resume) applies');
  assert.equal(logged.filter((r) => r.type === 'forfeit').length, 1);
});

test('0 turns a clock off', () => {
  const a = new AgentSeat('seat-aaaaaa', 0);
  a.lastActivity = T0;
  const { ev, stalls } = draftEvent([a], { cfg: { draftPickMs: 0, firstPickMs: 0, seatTimeoutMs: 0 } });
  const first = offerPick(a, 1, 1, T0);
  ev.checkIdle(T0 + 60 * 60_000);
  assert.equal(first.n + stalls.length, 0);
});

console.log(`${passed} passed`);
