/**
 * Seat session rotation (bench play --fresh-session): the boundary signal a launcher polls (GET /mcp/<token>/progress)
 * and what a fresh harness session gets at the switch. No decision may be lost or answered twice, and polling never
 * counts as activity for the inactivity watchdog.
 *   npx tsx packages/director/src/session-rotation.test.ts
 */
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { Event, mergeSeen } from './event.js';
import { startHttp } from './mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { AgentSeat, type Offer } from './seat.js';
import type { CardDb } from './cards.js';

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  await fn();
  passed++;
  console.log(`ok - ${name}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A game decision whose answer takes `ms` to apply; `answers` collects every applied answer. */
function offer(seat: AgentSeat, id: string, answers: string[], ms = 0): Offer {
  return {
    id, phase: 'game', kind: 'priority', text: `[Round 1 of 3, game 1 (best of 3)] decision ${id}`, createdAt: Date.now(),
    options: [{ id: '1', label: 'Pass', value: null }],
    answer: async (input) => {
      if (ms) await sleep(ms);
      answers.push(`${id}:${input.option}`);
      return null;
    },
  };
}

/** An Event with what playMatch and the resume briefing need, games already in the log (no rules engine). */
function stubEvent(bestOf: number, rounds = 2) {
  const seats = ['a', 'b'].map((n, i) => new AgentSeat(n, i));
  const logged: Array<Record<string, any>> = [];
  const ev: any = Object.create(Event.prototype);
  Object.assign(ev, {
    cfg: { bestOf, promptsDir: resolve(import.meta.dirname, '../../../prompts') }, plan: { format: 'swiss', rounds, version: 1 }, rounds: [], round: -1, matches: [], playing: new Set(), roundMatches: new Map(),
    forfeits: new Map(), liveGames: new Set(), sessions: new Map(), seats, aborted: undefined, stage: 'games', knowledge: { level: 'none', stats: false },
    seed: 's', log: (type: string, d: Record<string, unknown>) => logged.push({ type, ...d }), persist: () => {},
    resume: { games: new Map(), matchEnds: new Map(), seatsDone: new Set(), forfeits: [], records: [] },
  });
  return { ev, seats, logged };
}

await test('progress: deck locked, games and matches finished, done (the boundaries a launcher rotates on)', async () => {
  const { ev, seats: [a, b] } = stubEvent(3);
  assert.deepEqual(a!.progress(), { deck_locked: false, games_finished: 0, matches_finished: 0, done: false, deciding: false, sessions: 0 });
  a!.deckLocked = b!.deckLocked = true;
  ev.round = 0;
  ev.rounds.push({ round: 1, pairs: [['a', 'b']], byes: [] });
  ev.resume.games.set('a vs b — game 1', { over: { winner: 'a', turns: 8 } });
  ev.resume.games.set('a vs b — game 2', { over: { winner: 'b', turns: 9 } });
  ev.resume.games.set('a vs b — game 3', { over: { winner: 'a', turns: 7 } });
  await ev.playMatch(a, b, 0);
  assert.equal(a!.progress().games_finished, 3);
  assert.equal(b!.progress().matches_finished, 1);
  assert.equal(a!.progress().done, false, 'round 1 of 2: more to play');
});

await test('progress: deciding while a decide call is in progress, also during the reply that follows the answer', async () => {
  const s = new AgentSeat('x', 0);
  const answers: string[] = [];
  s.offer(offer(s, 'G1', answers, 100));
  const p = s.decide({ decision_id: 'G1', option: '1' });
  await sleep(20);
  assert.equal(s.progress().deciding, true, 'the answer is being applied');
  await sleep(150);
  assert.equal(s.progress().deciding, true, 'decide waits up to 2.5 s for the next decision before it replies');
  await p;
  assert.equal(s.progress().deciding, false);
  assert.deepEqual(answers, ['G1:1']);
});

await test('switch while the old session thinks: the fresh session gets the resume briefing and the same decision in full; it is answered once', async () => {
  const s = new AgentSeat('x', 0);
  const sessions: Array<[number, boolean]> = [];
  s.onSessionStart = (n, resumed) => sessions.push([n, resumed]);
  s.resumeBriefing = () => 'You are continuing this event in a new session; nothing you decided is lost.';
  s.sessionStart(); // the first session
  s.brief('Welcome.');
  assert.match((await s.wait(50)).text, /Welcome/);
  const answers: string[] = [];
  s.offer(offer(s, 'G7', answers));
  assert.match((await s.wait(50)).text, /decision G7/, 'the old session read G7');
  // The launcher ends the old session here (no decide in flight) and starts a fresh one.
  assert.equal(s.progress().deciding, false);
  s.sessionStart();
  const first = await s.wait(50);
  assert.match(first.text, /continuing this event in a new session/);
  assert.match(first.text, /decision G7/, 'the open decision in full again, not the one-line pointer');
  assert.match(await s.decide({ decision_id: 'G7', option: '1' }), /^Accepted/);
  // A late answer from the old session (its last request still in flight) can't be applied twice.
  assert.match(await s.decide({ decision_id: 'G7', option: '1' }), /no open decision|not open/);
  assert.deepEqual(answers, ['G7:1']);
  assert.deepEqual(sessions, [[1, false], [2, true]]);
  assert.equal(s.progress().sessions, 2);
});

await test('switch after an answer was applied: the fresh session gets the next decision, never the answered one', async () => {
  const s = new AgentSeat('x', 0);
  s.resumeBriefing = () => 'Resume briefing.';
  s.brief('Welcome.');
  await s.wait(50);
  const answers: string[] = [];
  s.offer(offer(s, 'G1', answers));
  await s.wait(50);
  // The old session's decide was applied (it may be killed before it reads the reply).
  const reply = s.decide({ decision_id: 'G1', option: '1' });
  await sleep(10);
  s.offer(offer(s, 'G2', answers));
  await reply;
  s.sessionStart();
  const next = await s.wait(50);
  assert.match(next.text, /Resume briefing/);
  assert.match(next.text, /decision G2/);
  assert.doesNotMatch(next.text, /decision G1/);
  assert.match(await s.decide({ decision_id: 'G1', option: '1' }), /Decision G1 is not open; the open decision is G2/);
  assert.deepEqual(answers, ['G1:1']);
});

await test('seat_session is logged for every session after the first; the resume briefing says where the seat\'s match stands', async () => {
  const { ev, seats: [a, b], logged } = stubEvent(3);
  for (const s of [a!, b!]) ev.equipSeat(s, 'Reality Fracture');
  // The stub skips the constructor, which installs this logger: the same one.
  a!.onSessionStart = (session, resumed) => {
    if (session > 1) ev.log('seat_session', { seat: a!.name, session, resumed, stage: ev.stage, games_finished: a!.gamesFinished, matches_finished: a!.matchesFinished });
  };
  ev.round = 0;
  ev.rounds.push({ round: 1, pairs: [['a', 'b']], byes: [] });
  const m = { a: 'a', b: 'b', wins: { a: 1, b: 0 }, games: [{ winner: 0, turns: 8, stats: {}, label: 'a vs b — game 1', winnerName: 'a' }] };
  ev.roundMatches.set('0|a', m);
  ev.playing.add('a');
  // The seat played game 1 in its first session; the launcher starts a fresh one.
  a!.briefed = true;
  a!.sessions = 1;
  a!.sessionStart();
  const text = (await a!.wait(50)).text;
  assert.match(text, /Round 1 of 2 is being played\. Your best-of-3 match so far: you 1–0 in games; game 2 is next or under way\./);
  assert.doesNotMatch(text, /\bb\b vs|opponent b/, 'never the opponent');
  assert.equal(logged.filter((r) => r.type === 'seat_session').length, 1, 'only the second session is logged');
  assert.equal(logged.find((r) => r.type === 'seat_session')!.resumed, true);
});

await test('GET /mcp/<token>/progress: the seat\'s progress, not activity for the watchdog; unknown seats 404; POST refused', async () => {
  const s = new AgentSeat('x', 0);
  s.deckLocked = true;
  s.gamesFinished = 2;
  const http = startHttp((t) => (t === s.token ? s : undefined), {} as CardDb, 0, '127.0.0.1');
  await new Promise((r) => http.once('listening', r));
  const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  try {
    const res = await fetch(`${base}/mcp/${s.token}/progress`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { deck_locked: true, games_finished: 2, matches_finished: 0, done: false, deciding: false, sessions: 0 });
    assert.equal(s.lastActivity, undefined, 'polling progress is not a seat request');
    assert.equal((await fetch(`${base}/mcp/${'0'.repeat(32)}/progress`)).status, 404);
    assert.equal((await fetch(`${base}/mcp/${s.token}/progress`, { method: 'POST' })).status, 405);
    // The MCP endpoint itself still only takes POST.
    assert.equal((await fetch(`${base}/mcp/${s.token}`)).status, 405);
  } finally {
    http.close();
  }
});

await test('the watchdog still forfeits a seat whose launcher only polls progress', async () => {
  const s = new AgentSeat('x', 0);
  const ev: any = Object.create(Event.prototype);
  const logged: string[] = [];
  Object.assign(ev, {
    cfg: { seatTimeoutMs: 1000 }, seats: [s], stage: 'games', aborted: undefined, forfeits: new Map(), startedAt: Date.now() - 60_000,
    log: (type: string) => logged.push(type),
  });
  s.lastActivity = Date.now() - 5_000;
  let settled = false;
  s.offer({ ...offer(s, 'G3', []), createdAt: Date.now() - 5_000, forfeit: () => ((settled = true), { game: 'g', game_number: 1 }) });
  s.progress(); // a launcher's poll
  ev.checkIdle();
  assert.ok(settled && logged.includes('forfeit'), 'polling progress never keeps a silent seat alive');
});

/** A draft pick offer (not gated: the Set Context rule is about game decisions). */
function pick(id: string, answers: string[]): Offer {
  return { id, phase: 'draft', kind: 'pick', text: `DECISION ${id} — pick`, createdAt: Date.now(), options: [{ id: '1', label: 'A', value: 1 }], answer: async (i) => (answers.push(`${id}:${i.option}`), null) };
}

await test('Set Context levels: a session that hasn\'t read it gets a reminder instead of its first game decision; the decision waits', async () => {
  const s = new AgentSeat('x', 0);
  const reminders: Array<[number, string]> = [];
  s.primer = 'part one\n\n# B\n\npart two';
  s.primerParts = ['part one', '# B\n\npart two'];
  s.setContextRequired = { tool: 'get_set_context', parts: 2 };
  s.onSetContextReminder = (session, id) => reminders.push([session, id]);
  s.sessionStart();
  const answers: string[] = [];
  // Draft decisions are never gated.
  s.offer(pick('D1', answers));
  assert.match((await s.wait(50)).text, /DECISION D1/);
  assert.match(await s.decide({ decision_id: 'D1', option: '1' }), /^Accepted/);
  s.offer(offer(s, 'G1', answers));
  const r = await s.wait(50);
  assert.equal(r.status, 'waiting');
  assert.match(r.text, /read the Set Context for this format: call get_set_context\(part=1\), then part=2\. Then call wait_for_decision: your game decision G1 is open/);
  assert.doesNotMatch(r.text, /decision G1 \(best of 3\)\] decision G1|Round 1 of 3/, 'not the decision text');
  // Answering it anyway is refused, nothing is applied.
  assert.match(await s.decide({ decision_id: 'G1', option: '1' }), /^Not applied: Before your first game decision/);
  assert.deepEqual(answers, ['D1:1']);
  // Reading any part opens the gate for this session.
  s.markSetContextRead();
  assert.match((await s.wait(50)).text, /decision G1/);
  assert.match(await s.decide({ decision_id: 'G1', option: '1' }), /^Accepted/);
  assert.deepEqual(reminders, [[1, 'G1']], 'logged once per session');
});

await test('Set Context levels: the same rule for every session, rotated or not; a fresh session reads it again, a long one never has to', async () => {
  const make = () => {
    const s = new AgentSeat('x', 0);
    s.primer = 'ctx';
    s.primerParts = ['ctx'];
    s.setContextRequired = { tool: 'get_set_context', parts: 1 };
    s.resumeBriefing = () => 'Resume briefing.';
    return s;
  };
  // One long session that read it during the draft: its game decisions come straight away, all event long.
  const long = make();
  long.sessionStart();
  long.brief('Welcome.');
  await long.wait(50);
  long.markSetContextRead();
  const answers: string[] = [];
  long.offer(offer(long, 'G1', answers));
  assert.match((await long.wait(50)).text, /decision G1/);
  // A rotated seat: the fresh session (after the deck lock or a game) must read it before its next game decision.
  const rot = make();
  rot.sessionStart();
  rot.brief('Welcome.');
  await rot.wait(50);
  rot.markSetContextRead();
  rot.sessionStart();
  rot.offer(offer(rot, 'G2', answers));
  const first = await rot.wait(50);
  assert.match(first.text, /Resume briefing/);
  assert.match(first.text, /call get_set_context\(\)\. Then call wait_for_decision: your game decision G2 is open/);
  rot.markSetContextRead();
  assert.match((await rot.wait(50)).text, /decision G2/);
  // Without a Set Context (knowledge none) nothing is gated.
  const none = new AgentSeat('y', 1);
  none.sessionStart();
  none.offer(offer(none, 'G3', answers));
  assert.match((await none.wait(50)).text, /decision G3/);
});

await test('over MCP: each new session (initialize) must read the Set Context again; get_set_context opens the gate', async () => {
  const s = new AgentSeat('x', 0);
  s.observation = 'v4';
  s.primer = 'The Set Context.';
  s.primerParts = ['The Set Context.'];
  s.setContextRequired = { tool: 'get_set_context', parts: 1 };
  const answers: string[] = [];
  s.offer(offer(s, 'G5', answers));
  const http = startHttp((t) => (t === s.token ? s : undefined), {} as CardDb, 0, '127.0.0.1');
  await new Promise((r) => http.once('listening', r));
  const url = new URL(`http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp/${s.token}`);
  const text = (r: any) => String(r.content[0].text);
  try {
    for (let session = 1; session <= 2; session++) {
      const client = new Client({ name: 'test', version: '1' });
      await client.connect(new StreamableHTTPClientTransport(url));
      assert.match(text(await client.callTool({ name: 'wait_for_decision', arguments: {} })), /read the Set Context for this format: call get_set_context\(\)/, `session ${session}: reminded`);
      assert.match(text(await client.callTool({ name: 'get_set_context', arguments: {} })), /The Set Context/);
      assert.match(text(await client.callTool({ name: 'wait_for_decision', arguments: {} })), /decision G5/, `session ${session}: the decision after reading`);
      await client.close();
    }
    assert.equal(s.progress().sessions, 2);
    assert.deepEqual(answers, []);
  } finally {
    http.close();
  }
});

await test('Set Context gate: the Event requires it at Set Context levels only, with the tool and parts it names in the briefing', async () => {
  const { ev, seats: [a] } = stubEvent(3);
  ev.knowledge = { level: 'primer', stats: false, primer: 'x'.repeat(30_000) };
  ev.equipSeat(a, 'Reality Fracture');
  assert.deepEqual(a!.setContextRequired, { tool: 'get_set_context', parts: 2 });
  const { ev: ev2, seats: [b] } = stubEvent(3);
  ev2.equipSeat(b, 'Reality Fracture');
  assert.equal(b!.setContextRequired, undefined);
});

await test('match memory across games: the most copies of a name seen in any one game; junk ignored', async () => {
  const mem: Record<string, number> = {};
  mergeSeen(mem, { Shock: 1, Mountain: 6 });
  mergeSeen(mem, { Shock: 2, Mountain: 4, 'Grizzly Bears': 1 });
  mergeSeen(mem, { Bad: -1, Worse: 'x', Frac: 1.5 });
  mergeSeen(mem, null);
  assert.deepEqual(mem, { Shock: 2, Mountain: 6, 'Grizzly Bears': 1 });
});

console.log(`# ${passed} passed`);
