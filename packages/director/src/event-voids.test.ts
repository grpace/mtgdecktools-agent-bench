/**
 * Infrastructure failures never decide a match (METHODOLOGY §3.2, "No result"): a game the engine loses or can't start
 * is voided and replayed; one that keeps failing ends its match with no result (no winner, no Swiss points), also across
 * a restart. And the inactivity watchdog never holds a restart against a seat.
 *   npx tsx packages/director/src/event-voids.test.ts
 */
import assert from 'node:assert/strict';
import { Event, MAX_VOIDS_PER_GAME } from './event.js';
import { GameVoidError, type GameResult } from './game.js';
import { matchPoints, pairSwissRound, verifyPairings, type MatchOutcome } from './pairings.js';
import { AgentSeat } from './seat.js';
import { gameConsistency } from '../../hub/src/checks.js';

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  await fn();
  passed++;
  console.log(`ok - ${name}`);
}

type Script = Array<'void' | 'setup' | 0 | 1>;

/**
 * An Event with what playMatch needs and scripted games: each attempt at a game takes the next step of the script
 * ('void': lost on the engine; 'setup': the engine couldn't start it; 0 or 1: the host or the joiner wins; hosts alternate,
 * a in odd games).
 */
function stubEvent(script: Script, resume?: Record<string, unknown>) {
  const seats = ['a', 'b'].map((n, i) => new AgentSeat(n, i));
  const logged: Array<Record<string, any>> = [];
  const steps = [...script];
  const ev: any = Object.create(Event.prototype);
  Object.assign(ev, {
    cfg: { bestOf: 3, replayDelaysMs: [0, 0, 0], promptsDir: new URL('../../../prompts', import.meta.url).pathname }, plan: { format: 'swiss', rounds: 1, version: 1 }, rounds: [{ round: 1, pairs: [['a', 'b']], byes: [] }], round: 0,
    matches: [], playing: new Set(), roundMatches: new Map(), forfeits: new Map(), liveGames: new Set(), sessions: new Map(), seats, aborted: undefined,
    decks: new Map(['a', 'b'].map((n) => [n, { deck: { main_deck: [], sideboard: [] } }])),
    log: (type: string, d: Record<string, unknown>) => logged.push({ type, ...d }),
    persist: () => {},
    resume: { games: new Map(), matchEnds: new Map(), seatsDone: new Set(), forfeits: [], records: [], playDraw: new Map(), sideboards: new Map(), ...(resume ?? {}) },
    createGame: (_url: string, _cards: unknown, players: AgentSeat[], _decks: unknown, log: (t: string, d: Record<string, unknown>) => void, label: string) => ({
      abandon() {},
      async play(): Promise<GameResult> {
        const step = steps.shift();
        if (step === undefined) throw new Error('script ran out');
        if (step === 'setup') throw new Error(`could not start ${label}: timed out waiting for GameStarted`);
        log('game_start', { game: label, seats: players.map((p) => p.name) });
        if (step === 'void') throw new GameVoidError(`lost the connection to ${label}`, 'connection_lost');
        log('game_over', { game: label, winner: players[step]!.name, turns: 7 });
        return { winner: step, turns: 7, stats: {} };
      },
    }),
  });
  const run = () => ev.playMatch(seats[0], seats[1], 0);
  return { ev, seats, logged, steps, run };
}

await test('a game the engine could not start is voided and replayed, not the end of the match', async () => {
  const { ev, logged, run } = stubEvent(['setup', 0, 'setup', 'setup', 1]); // game 2 is hosted by b: 1 = a wins
  await run();
  const fails = logged.filter((r) => r.type === 'game_failed');
  assert.equal(fails.length, 3);
  assert.ok(fails.every((f) => f.void === true && f.replay === true && f.reason === 'setup_failed'));
  const end = logged.find((r) => r.type === 'match_end')!;
  assert.deepEqual(end.wins, { a: 2, b: 0 });
  assert.equal(end.no_result, undefined, 'the match finished: it has a result');
  assert.equal(ev.standings().find((s: { name: string }) => s.name === 'a').matchWins, 1);
});

await test('a game voided more often than the limit ends the match with no result: no winner, no Swiss points', async () => {
  // a wins game 1; game 2 is lost on the engine 4 times (the first attempt and 3 replays).
  const { ev, seats, logged, run } = stubEvent([0, ...Array(MAX_VOIDS_PER_GAME + 1).fill('void')]);
  await run();
  const fails = logged.filter((r) => r.type === 'game_failed');
  assert.equal(fails.length, MAX_VOIDS_PER_GAME + 1);
  assert.deepEqual(fails.map((f) => f.replay), [true, true, true, false]);
  const end = logged.find((r) => r.type === 'match_end')!;
  assert.equal(end.no_result, true);
  assert.equal(end.reason, 'connection_lost');
  assert.deepEqual(end.wins, { a: 1, b: 0 }, 'the finished game stands');
  const st = Object.fromEntries(ev.standings().map((s: any) => [s.name, s]));
  assert.equal(st.a.matchWins, 0, 'a 1–0 lead is not a match win');
  assert.equal(st.b.matchLosses, 0);
  assert.equal(st.a.gameWins, 1);
  // Swiss: no points for either seat, and the pair has met.
  const results = ev.matches.map(({ a, b, wins, noResult }: any) => ({ a, b, wins, ...(noResult ? { no_result: true } : {}) }));
  assert.deepEqual(Object.fromEntries(matchPoints(['a', 'b'], [], results)), { a: 0, b: 0 });
  // What the seats are told.
  assert.match(seats[0]!.status, /no result/);
  const text = ev.finalText(seats[0]);
  assert.match(text, /Round 1: vs another agent: no result/);
  assert.match(text, /Totals: matches won 0, lost 0, no result 1; games won 1, lost 0/);
});

await test('a restart keeps the void count and a match that ended with no result', async () => {
  // Two voids before the restart: one replay left, then no result.
  const label = 'a vs b — game 1';
  const before = stubEvent(['void', 'void'], {
    games: new Map([[label, { label, voids: 2, records: [], failed: { type: 'game_failed', void: true, replay: true, reason: 'connection_lost' } }]]),
  });
  await before.run();
  const fails = before.logged.filter((r) => r.type === 'game_failed');
  assert.deepEqual(fails.map((f) => f.replay), [true, false], '2 logged + 2 here = 4 voids: the 4th ends the match');
  assert.equal(before.logged.find((r) => r.type === 'match_end')!.no_result, true);

  // The match had already ended with no result before the restart: nothing is replayed, nothing logged twice.
  const after = stubEvent([], {
    games: new Map([[label, { label, voids: 4, records: [], failed: { type: 'game_failed', void: true, replay: false, reason: 'connection_lost' } }]]),
    matchEnds: new Map([['a vs b', { type: 'match_end', a: 'a', b: 'b', wins: { a: 0, b: 0 }, no_result: true }]]),
  });
  await after.run();
  assert.equal(after.logged.filter((r) => r.type === 'match_end' || r.type === 'game_failed').length, 0);
  assert.equal(after.ev.matches[0].noResult, 'connection_lost');
  assert.equal(after.ev.standings().find((s: any) => s.name === 'a').matchLosses, 0);
});

await test('Swiss after a no-result match: no points, no rematch', () => {
  const seats = ['a', 'b', 'c', 'd'].map((name) => ({ name }));
  const r1 = { round: 1, pairs: [['a', 'b'], ['c', 'd']] as Array<[string, string]>, byes: [] };
  const results: MatchOutcome[] = [{ a: 'a', b: 'b', wins: { a: 1, b: 0 }, no_result: true }, { a: 'c', b: 'd', wins: { c: 2, d: 0 } }];
  const pts = matchPoints(['a', 'b', 'c', 'd'], [r1], results);
  assert.deepEqual(Object.fromEntries(pts), { a: 0, b: 0, c: 3, d: 0 });
  const r2 = pairSwissRound(seats, 'seed', 2, [r1], results);
  for (const [x, y] of r2.pairs) assert.ok(!(x === 'a' && y === 'b') && !(x === 'b' && y === 'a'), 'a and b have met');
  // The Hub's regeneration of the pairing reads no_result from match_end and agrees.
  const start = { type: 'event_start', seed: 'seed', pairing: { format: 'swiss', rounds: 2, version: 1 }, seats: seats.map((s, i) => ({ ...s, kind: 'agent', position: i })) };
  const log = [start, { type: 'round_start', ...r1 }, { type: 'match_end', ...results[0] }, { type: 'match_end', ...results[1] }, { type: 'round_start', ...r2 },
    ...r2.pairs.map(([a, b]) => ({ type: 'match_end', a, b, wins: { [a]: 2, [b]: 0 } }))];
  assert.equal(verifyPairings(log).status, 'verified');
  // Without the flag the same log pairs differently or the same: the flag is what the checker must read.
  assert.deepEqual(Object.fromEntries(matchPoints(['a', 'b'], [r1], [{ ...results[0]!, no_result: undefined }])), { a: 3, b: 0 });
});

await test("the Hub's game check accepts a no-result match, even one that never started a game", () => {
  const seats = [{ name: 'a', kind: 'agent', position: 0 }, { name: 'b', kind: 'agent', position: 1 }, { name: 'c', kind: 'agent', position: 2 }, { name: 'd', kind: 'agent', position: 3 }];
  const g1 = 'a vs b — game 1';
  const events: any[] = [
    { type: 'event_start', best_of: 3, seats },
    { type: 'game_start', game: g1, seats: ['a', 'b'] }, { type: 'game_over', game: g1, winner: 'a', turns: 7 },
    { type: 'game_failed', game: 'a vs b — game 2', void: true, replay: false, reason: 'setup_failed' },
    { type: 'match_end', a: 'a', b: 'b', wins: { a: 1, b: 0 }, no_result: true, reason: 'setup_failed' },
    { type: 'game_failed', game: 'c vs d — game 1', void: true, replay: false, reason: 'setup_failed' },
    { type: 'match_end', a: 'c', b: 'd', wins: { c: 0, d: 0 }, no_result: true, reason: 'setup_failed' },
  ];
  const standings = [
    { name: 'a', matchWins: 0, matchLosses: 0, gameWins: 1, gameLosses: 0 }, { name: 'b', matchWins: 0, matchLosses: 0, gameWins: 0, gameLosses: 1 },
    { name: 'c', matchWins: 0, matchLosses: 0, gameWins: 0, gameLosses: 0 }, { name: 'd', matchWins: 0, matchLosses: 0, gameWins: 0, gameLosses: 0 },
  ];
  events.push({ type: 'event_end', standings });
  const r = gameConsistency(events, { standings, matches: [] });
  assert.equal(r.outcome, 'pass', JSON.stringify(r.details ?? r.message));
  // A 1–0 "no result" scored as a win in the standings is caught.
  const bad = standings.map((s) => (s.name === 'a' ? { ...s, matchWins: 1 } : s.name === 'b' ? { ...s, matchLosses: 1 } : s));
  assert.equal(gameConsistency([...events.slice(0, -1), { type: 'event_end', standings: bad }], { standings: bad, matches: [] }).outcome, 'fail');
});

await test('the watchdog: paused while the server restarts; after a resume, seats get the resume grace', () => {
  const seat = new AgentSeat('a', 0);
  const forfeited: string[] = [];
  let paused = true;
  const ev: any = Object.create(Event.prototype);
  const now = 1_000_000_000;
  Object.assign(ev, {
    cfg: { seatTimeoutMs: 60_000, resumeGraceMs: 600_000, watchdogPaused: () => paused }, stage: 'games', aborted: undefined, checkpoint: undefined,
    seats: [seat], startedAt: now - 3_600_000, resumedAt: now - 120_000,
    forfeit: (s: AgentSeat) => forfeited.push(s.name),
  });
  seat.lastActivity = now - 120_000; // set at the resume, no call since
  (seat as any).pending = { forfeit: () => ({}), createdAt: now - 120_000, phase: 'game', id: 'G1', kind: 'x' };
  ev.checkIdle(now);
  assert.deepEqual(forfeited, [], 'paused: nothing is forfeited');
  paused = false;
  ev.checkIdle(now);
  assert.deepEqual(forfeited, [], '2 minutes after the resume is inside the 10-minute resume grace (the 1-minute timeout does not apply)');
  ev.checkIdle(now + 600_000);
  assert.deepEqual(forfeited, ['a'], 'past the resume grace');
  // A seat that has called since the resume is back on the normal timeout.
  forfeited.length = 0;
  seat.lastActivity = now - 60_000 + 10;
  (seat as any).inactive = false;
  ev.checkIdle(now + 1);
  assert.deepEqual(forfeited, []);
  ev.checkIdle(now + 20);
  assert.deepEqual(forfeited, ['a']);
});

console.log(`\n${passed} passed`);
