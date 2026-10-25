/**
 * Stopped events reach the Hub (METHODOLOGY §3.2 "Stopped events"): Event.abort records who stopped the table and the
 * games still being played, writes summary.json when a game has finished, and tells the seats their finished games
 * count; the hand-off resends such an event; a bundle of it validates; a Director error or a table stopped before any
 * game finished still can't be submitted.
 *   npx tsx packages/director/src/stopped-event.test.ts
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildBundle } from './bundle.js';
import { Event } from './event.js';
import { needsHandoff } from './hub-handoff.js';
import { AgentSeat } from './seat.js';
import { validateBundle } from './submissions.js';

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  await fn();
  passed++;
  console.log(`ok - ${name}`);
}

const root = mkdtempSync(join(tmpdir(), 'stopped-event-'));

/** An Event with what abort() needs: two seats, one finished game, one game still being played. */
function stubEvent(dir: string, gamesOver: number) {
  const seats = ['a', 'b'].map((n, i) => new AgentSeat(n, i));
  const logged: Array<Record<string, any>> = [];
  const abandoned: string[] = [];
  const live = { label: 'a vs b — game 2', seatNames: ['b', 'a'], abandon: () => abandoned.push('a vs b — game 2') };
  const ev: any = Object.create(Event.prototype);
  Object.assign(ev, {
    id: '2026-10-23-01-00-00-fra-aaaa', dir, seed: 's', setInfo: { code: 'FRA', name: 'Reality Fracture' }, stage: 'games', aborted: undefined,
    seats, matches: [], liveGames: new Set([live]), sessions: new Map(), gamesOver,
    log: (type: string, d: Record<string, unknown>) => logged.push({ type, ...d }),
  });
  return { ev, seats, logged, abandoned };
}

await test('abort: who stopped it, the open games, summary.json, and an honest message to every seat', () => {
  const dir = join(root, 'with-games');
  mkdirSync(dir, { recursive: true });
  const { ev, seats, logged, abandoned } = stubEvent(dir, 1);
  ev.abort('canceled', 'The event was canceled by its organizer.', 'organizer');
  const rec = logged.find((r) => r.type === 'event_abort')!;
  assert.deepEqual([rec.reason, rec.by, rec.stage, rec.completed_games], ['canceled', 'organizer', 'games', 1]);
  assert.deepEqual(rec.open_games, [{ game: 'a vs b — game 2', seats: ['b', 'a'] }]);
  assert.deepEqual(abandoned, ['a vs b — game 2']);
  const summary = JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8'));
  assert.deepEqual([summary.id, summary.stopped.by, summary.stopped.reason], ['2026-10-23-01-00-00-fra-aaaa', 'organizer', 'canceled']);
  for (const s of seats) assert.match(s.done!, /^EVENT COMPLETE\. The event was canceled by its organizer\. Games that already finished still count; games that were still being played do not\. You can stop now\.$/);
});

await test('abort before any game finished: no summary.json (nothing to hand off), and the seats are told so', () => {
  const dir = join(root, 'no-games');
  mkdirSync(dir, { recursive: true });
  const { ev, seats, logged } = stubEvent(dir, 0);
  ev.abort('abandoned', 'The event was stopped: no seat connected.');
  assert.equal(logged.find((r) => r.type === 'event_abort')!.by, 'system');
  assert.equal(existsSync(join(dir, 'summary.json')), false);
  assert.match(seats[0]!.done!, /No game had finished, so nothing from this event is scored\./);
});

const seatsMeta = [{ name: 'a', kind: 'agent', position: 0, harness: 'claude-code', model: 'claude-opus-5-5' }, { name: 'b', kind: 'agent', position: 1, harness: 'claude-code', model: 'claude-haiku-5-5' }];
function runDir(id: string, tail: Array<Record<string, unknown>>, summary = true): string {
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  const lines = [{ t: 1, type: 'event_start', id, set: { code: 'FRA', name: 'Reality Fracture' }, seed: 's', seats: seatsMeta, boosters: { draft_pools_sha256: 'x' } }, ...tail];
  writeFileSync(join(dir, 'events.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  if (summary) writeFileSync(join(dir, 'summary.json'), JSON.stringify({ id, standings: [] }));
  return dir;
}
const game = [{ t: 2, type: 'game_start', game: 'a vs b — game 1', seats: ['a', 'b'] }, { t: 3, type: 'game_over', game: 'a vs b — game 1', winner: 'a', turns: 7 }];
const terminalErrors = (dir: string) => validateBundle(buildBundle(dir, { createdBy: 'test', createdAt: 1 }).files, { allowedEngineDigests: [] }).errors
  .filter((e) => /event_end|event_abort|Director error|nothing to score/.test(e));

await test('hand-off: a stopped event with summary.json is sent like a finished one; a Director error never is', () => {
  assert.equal(needsHandoff(runDir('2026-10-23-02-00-00-fra-bbbb', [...game, { t: 4, type: 'event_abort', reason: 'canceled', by: 'organizer' }])), true);
  assert.equal(needsHandoff(runDir('2026-10-23-02-00-00-fra-cccc', [...game, { t: 4, type: 'event_abort', reason: 'abandoned' }], false)), false, 'no summary.json: no game had finished');
  assert.equal(needsHandoff(runDir('2026-10-23-02-00-00-fra-dddd', [...game, { t: 4, type: 'event_error', message: 'x' }])), false);
  assert.equal(needsHandoff(runDir('2026-10-23-02-00-00-fra-eeee', [...game, { t: 4, type: 'event_end', standings: [] }])), true);
});

await test('submissions: finished and stopped events validate; a Director error, no ending or no finished game do not', () => {
  assert.deepEqual(terminalErrors(runDir('2026-10-23-03-00-00-fra-aaaa', [...game, { t: 4, type: 'event_end', standings: [] }])), []);
  assert.deepEqual(terminalErrors(runDir('2026-10-23-03-00-00-fra-bbbb', [...game, { t: 4, type: 'event_abort', reason: 'canceled', by: 'organizer' }])), []);
  assert.deepEqual(terminalErrors(runDir('2026-10-23-03-00-00-fra-cccc', [{ t: 4, type: 'event_abort', reason: 'canceled' }])),
    ['the event was stopped before any game finished: there is nothing to score']);
  assert.deepEqual(terminalErrors(runDir('2026-10-23-03-00-00-fra-dddd', [...game, { t: 4, type: 'event_error', message: 'x' }])), ['the event hit a Director error; it cannot be scored']);
  assert.match(terminalErrors(runDir('2026-10-23-03-00-00-fra-eeee', game))[0] ?? '', /did not finish or stop/);
});

console.log(`\n${passed} passed`);
