/** Contributor points (src/points.ts) and their attribution and views (src/contributors.ts). No database needed. */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import type { EventData } from '../../site/src/data.js';
import { Contributors, ContributorsView, isPublic, nextSeasonStart, openBounties, pointsEvents, SeasonClock, type ContributorRecord, type SubmissionMeta } from '../src/contributors.js';
import {
  computeLedger, finalState, NEEDS_GAMES, rank, reliabilityMultiplier, repeatMultiplier, SCHEME, seasonInfo, seasonOf, type PointsEvent, type PointsSeat,
} from '../src/points.js';

const T0 = Date.parse('2026-11-02T18:00:00Z');
const H = 3600_000;
const OPUS = 'claude-opus-5-5/high';
const GPT = 'gpt-6-astra/high';
const SONNET = 'claude-sonnet-5-5/high';

function seat(name: string, contributorId: number | null, identity: string, o: Partial<PointsSeat> = {}): PointsSeat {
  const [harness, modelId, effort] = identity.split('/') as [string, string, string];
  return {
    name, contributorId, identity, modelId, harness, effort, status: 'ok', logs: true, explicitEffort: true, modelActive: true, abandoned: false, games: 0, rated: [],
    matchWins: 0, matchLosses: 0, gameWins: 0, gameLosses: 0, ...o,
  };
}
const games = (n: number, opponent: string, won = true) => Array.from({ length: n }, () => ({ opponent, won }));

function event(id: string, at: number, seats: PointsSeat[], o: Partial<PointsEvent> = {}): PointsEvent {
  return { id, acceptedAt: at, endedAt: at, set: 'FRA', setName: 'Reality Fracture', group: 'kn=primer;mana=manual;bo=3;prompt=v4', table: 'lobby', ineligible: null, seats, ...o };
}

describe('points scheme', () => {
  test('the worked example in docs/COMMUNITY.md', () => {
    // Earlier history: alice finished 9 seats and abandoned none; GPT-6 Astra and Claude Opus 5.5 have played before.
    const history: PointsEvent[] = [];
    for (let i = 0; i < 3; i++) {
      history.push(event(`h-${i}`, T0 - (10 - i) * 24 * H, [
        ...[0, 1, 2].map((k) => seat(`a${k}`, 1, OPUS, { rated: games(2, GPT), games: 2 })),
        seat('g1', null, GPT, { rated: games(6, OPUS, false), games: 6 }),
      ], { set: 'TLA', table: 'private' }));
    }
    // The lobby table: seat a finishes with 7 rated games, seat b plays 2 and goes silent.
    const ev = event('lobby-1', T0, [
      seat('opus-1', 1, OPUS, { rated: games(7, GPT), games: 7, matchWins: 2, matchLosses: 1 }),
      seat('opus-2', 1, OPUS, { rated: games(2, SONNET), games: 2, abandoned: true }),
      seat('gpt-1', 2, GPT, { rated: games(5, OPUS), games: 5 }),
    ]);
    const lines = computeLedger([...history, ev]).filter((l) => l.eventId === 'lobby-1');
    const a = lines.find((l) => l.seat === 'opus-1')!;
    const b = lines.find((l) => l.seat === 'opus-2')!;
    // Reliability over alice's last 11 seats: 10 finished → 10/11 = 0.909.
    assert.equal(a.reliabilityMult, 0.909);
    assert.equal(a.base, 10 + 7 * 2);
    assert.equal(a.tableMult, 1.5);
    assert.deepEqual(a.bounties.map((x) => x.kind).sort(), ['new_set', 'provisional']);
    // (24 × 1.5 + 10 + 5) × 0.909 = 46.36 → 46
    assert.equal(a.points, 46);
    assert.equal(b.status, 'abandoned');
    assert.equal(b.base, 4);
    assert.equal(b.bounty, 0);
    // 4 × 1.5 × 0.909 = 5.45 → 5
    assert.equal(b.points, 5);
    // bob's first seat: no history, so reliability 1.
    assert.equal(lines.find((l) => l.seat === 'gpt-1')!.reliabilityMult, 1);
  });

  test('no lines for seats nobody contributed; mismatch, unlisted and excluded seats score 0 with a reason', () => {
    const lines = computeLedger([
      event('e1', T0, [seat('x', null, OPUS, { rated: games(3, GPT) }), seat('m', 1, OPUS, { status: 'mismatch' }), seat('u', 1, 'unlisted:foo/high', { status: 'unlisted' })]),
      event('e2', T0 + H, [seat('y', 1, OPUS, { rated: games(3, GPT) })], { ineligible: 'engine bug' }),
    ]);
    assert.equal(lines.length, 3);
    for (const l of lines) {
      assert.equal(l.points, 0);
      assert.equal(l.status, 'ineligible');
      assert.ok(l.note.length > 10);
    }
    assert.match(lines.find((l) => l.seat === 'u')!.note, /earns points once it is listed/);
  });

  test('bounties come from the data before the event, and end', () => {
    const evs: PointsEvent[] = [];
    // Enough rated games for OPUS and GPT in one group: 3 events × 2 seats × 6 games each side.
    for (let i = 0; i < 4; i++) {
      evs.push(event(`e${i}`, T0 + i * 24 * H, [
        seat(`o${i}`, 1, OPUS, { rated: games(6, GPT), games: 6 }), seat(`p${i}`, 1, OPUS, { rated: games(6, SONNET), games: 6 }),
        seat(`g${i}`, 2, GPT, { rated: games(6, OPUS, false), games: 6 }), seat(`s${i}`, 2, SONNET, { rated: games(6, OPUS, false), games: 6 }),
      ]));
    }
    const lines = computeLedger(evs);
    const kinds = (e: string, s: string) => lines.find((l) => l.eventId === e && l.seat === s)!.bounties.map((b) => b.kind).sort();
    assert.deepEqual(kinds('e0', 'o0'), ['first_games', 'new_set', 'provisional']);
    assert.deepEqual(kinds('e1', 'o1'), ['new_set', 'provisional']);
    // After 3 events OPUS has 72 rated games, 3 events, 2 opponents: no longer provisional; FRA has 3 rated events.
    assert.deepEqual(kinds('e3', 'o3'), []);
    // GPT has 36 games over 3 events but one opponent: still provisional, but bob already took 3 Needs Games
    // bounties for it this week (e0–e2): the cap.
    assert.deepEqual(kinds('e2', 'g2'), ['new_set', 'provisional']);
    assert.deepEqual(kinds('e3', 'g3'), []);
  });

  test('repeats taper only once the setup is no longer provisional', () => {
    assert.deepEqual([1, 8, 9, 16, 17].map(repeatMultiplier), [1, 1, 0.5, 0.5, 0.25]);
    const evs: PointsEvent[] = [];
    for (let i = 0; i < 6; i++) {
      evs.push(event(`r${i}`, T0 + i * H, [
        ...[0, 1, 2, 3].map((k) => seat(`o${k}`, 1, OPUS, { rated: games(3, k % 2 ? GPT : SONNET), games: 3 })),
        ...[0, 1, 2, 3].map((k) => seat(`x${k}`, null, k % 2 ? GPT : SONNET, { rated: games(3, OPUS, false), games: 3 })),
      ], { table: 'private' }));
    }
    const lines = computeLedger(evs);
    const mults = evs.map((e) => lines.filter((l) => l.eventId === e.id).map((l) => l.repeatMult));
    // r0–r2: provisional (fewer than 3 events), full points. From r3 on: seats 13–24 of this setup in a week.
    assert.deepEqual(mults[0], [1, 1, 1, 1]);
    assert.deepEqual(mults[2], [1, 1, 1, 1]);
    assert.deepEqual(mults[3], [0.5, 0.5, 0.5, 0.5]);
    assert.deepEqual(mults[4], [0.25, 0.25, 0.25, 0.25]);
  });

  test('the daily cap cuts the line that crosses it, and the next UTC day starts fresh', () => {
    const big = (id: string, at: number) => event(id, at, Array.from({ length: 8 }, (_, k) => seat(`s${k}`, 1, k % 2 ? OPUS : GPT, { rated: games(9, k % 2 ? GPT : OPUS), games: 9 })), { table: 'lobby' });
    const day1 = Date.parse('2026-11-03T01:00:00Z');
    const lines = computeLedger([big('a', day1), big('b', day1 + H), big('c', day1 + 24 * H)]);
    const sum = (e: string) => lines.filter((l) => l.eventId === e).reduce((x, l) => x + l.points, 0);
    assert.equal(sum('a') + sum('b'), SCHEME.daily_cap);
    assert.ok(lines.filter((l) => l.eventId === 'b').some((l) => l.capped > 0));
    assert.ok(sum('c') > 0);
  });

  test('only rated play earns: a table of 8 identical seats earns nothing (H2)', () => {
    // One contributor, 8 seats of one never-rated model at one effort: Swiss pairs them with each other, nothing is rated.
    const farm = event('farm', T0, Array.from({ length: 8 }, (_, k) => seat(`s${k}`, 1, 'claude-haiku-5-5/low', { games: 3, matchWins: k % 2 ? 2 : 1, matchLosses: k % 2 ? 1 : 2 })), { table: 'private' });
    const lines = computeLedger([farm]);
    assert.equal(lines.length, 8);
    assert.equal(lines.reduce((a, l) => a + l.points, 0), 0);
    for (const l of lines) {
      assert.equal(l.bounty, 0);
      assert.match(l.note, /no rated games/);
    }
    // The same farm in a (claimed) lobby: still nothing.
    assert.equal(computeLedger([{ ...farm, id: 'farm-lobby', table: 'lobby' }]).reduce((a, l) => a + l.points, 0), 0);
  });

  test(`bounties need ${SCHEME.bounty_min_rated} rated games and harness logs; no logs earns × ${SCHEME.no_logs} (H2, PTS-2)`, () => {
    const [one] = computeLedger([event('b1', T0, [seat('a', 1, OPUS, { rated: games(1, GPT) })], { table: 'private' })]);
    assert.equal(one!.bounty, 0, 'one rated game: no bounty');
    assert.equal(one!.points, 10 + 2);
    assert.match(one!.note, /no bounties: fewer than 2 rated games/);
    const [two] = computeLedger([event('b2', T0, [seat('a', 1, OPUS, { rated: games(2, GPT) })], { table: 'private' })]);
    assert.deepEqual(two!.bounties.map((b) => b.kind).sort(), ['first_games', 'new_set', 'provisional']);
    assert.equal(two!.bounties.find((b) => b.kind === 'provisional')!.label, NEEDS_GAMES);
    const [nolog] = computeLedger([event('b3', T0, [seat('a', 1, OPUS, { rated: games(4, GPT), logs: false })], { table: 'private' })]);
    assert.equal(nolog!.bounty, 0, 'no harness logs: no bounties');
    assert.equal(nolog!.logsMult, SCHEME.no_logs);
    assert.equal(nolog!.points, Math.round((10 + 4 * 2) * SCHEME.no_logs));
    assert.match(nolog!.note, /× 0\.5 not checked against harness logs .*\(no bounties: not checked against harness logs\)/);
  });

  test('Needs Games: only active listed models at an explicit effort, at most 3 per contributor and setup a week (H2)', () => {
    const at = (d: number) => T0 + d * 24 * H;
    const ev = (id: string, d: number, o: Partial<PointsSeat> = {}) => event(id, at(d), [seat(`${id}-a`, 1, OPUS, { rated: games(2, GPT), ...o })], { set: 'TLA' });
    const kinds = (e: PointsEvent, before: PointsEvent[] = []) => computeLedger([...before, e]).find((l) => l.eventId === e.id)!.bounties.map((b) => b.kind);
    assert.ok(!kinds(ev('x1', 0, { explicitEffort: false })).includes('provisional'), 'harness default or unknown effort: no Needs Games');
    assert.ok(!kinds(ev('x2', 0, { modelActive: false })).includes('provisional'), 'retired model: no Needs Games');
    assert.ok(!kinds(ev('x3', 0, { modelActive: false })).includes('first_games'), 'retired model: no First Games');
    const week = [0, 1, 2, 3, 4].map((d) => ev(`w${d}`, d));
    const lines = computeLedger([...week, ev('w9', 9)]);
    const got = (id: string) => lines.find((l) => l.eventId === id)!.bounties.some((b) => b.kind === 'provisional');
    assert.deepEqual(['w0', 'w1', 'w2', 'w3', 'w4', 'w9'].map(got), [true, true, true, false, false, true]);
  });

  test('time is the Hub\'s: acceptance order, day and season; the bundle\'s times are ignored (PTS-1)', () => {
    // A backdated upload (its log says 2026-01) accepted after an honest event: it doesn't take the First Games bounty,
    // and its points land in the acceptance month, not in the past.
    const honest = event('honest', T0, [seat('h', 2, OPUS, { rated: games(2, GPT) })], { table: 'private' });
    const backdated = event('backdated', T0 + H, [seat('b', 1, OPUS, { rated: games(2, GPT) })], { table: 'private', endedAt: Date.parse('2026-01-05T00:00:00Z') });
    const lines = computeLedger([backdated, honest]);
    const b = lines.find((l) => l.eventId === 'backdated')!;
    assert.ok(lines.find((l) => l.eventId === 'honest')!.bounties.some((x) => x.kind === 'first_games'));
    assert.ok(!b.bounties.some((x) => x.kind === 'first_games'));
    assert.equal(b.at, T0 + H);
    assert.equal(b.season, seasonOf(T0 + H));
    // Claiming a different day per upload doesn't escape the daily cap: the day is the acceptance day.
    const many = Array.from({ length: 12 }, (_, i) => event(`u${i}`, T0 + i * 60_000, Array.from({ length: 8 }, (_, k) => seat(`s${k}`, 1, k % 2 ? OPUS : GPT, { rated: games(9, k % 2 ? GPT : OPUS) })), { table: 'private', endedAt: T0 - i * 24 * H }));
    assert.equal(computeLedger(many).reduce((a, l) => a + l.points, 0), SCHEME.daily_cap);
  });

  test('reliability multiplier', () => {
    assert.equal(reliabilityMultiplier([true, false, false]), 1); // fewer than 5 seats
    assert.equal(reliabilityMultiplier([true, true, true, true, false]), 0.8);
    assert.equal(reliabilityMultiplier([false, false, false, false, false]), 0.5); // floor
    assert.equal(reliabilityMultiplier([...Array(30).fill(false), ...Array(20).fill(true)]), 1); // window of 20
  });

  test('deterministic: input order does not matter', () => {
    const evs = [0, 1, 2, 3, 4].map((i) => event(`d${i}`, T0 + i * H, [seat(`a${i}`, 1, OPUS, { rated: games(i + 1, GPT), games: i + 1 }), seat(`b${i}`, 2, GPT, { rated: games(i + 1, OPUS, false), abandoned: i === 2 })]));
    const a = computeLedger(evs);
    const b = computeLedger([...evs].reverse());
    assert.deepEqual(a, b);
  });

  test('admin bounties match and computed kinds can be switched off', () => {
    const admin = { version: 1 as const, disable: ['new_set', 'first_games'], bounties: [{ id: 'fra-launch', label: 'FRA Launch Week', bonus: 15, match: { set: 'fra', table: 'lobby' as const }, from: '2026-11-01', until: '2026-11-08' }] };
    const [l] = computeLedger([event('a1', T0, [seat('s', 1, OPUS, { rated: games(2, GPT) })])], admin);
    assert.deepEqual(l!.bounties.map((b) => b.id).sort(), ['admin:fra-launch', `provisional:kn=primer;mana=manual;bo=3;prompt=v4:${OPUS}`]);
    const [late] = computeLedger([event('a2', Date.parse('2026-11-09T00:00:00Z'), [seat('s', 1, OPUS, { rated: games(2, GPT) })])], admin);
    assert.ok(!late!.bounties.some((b) => b.kind === 'admin'));
  });

  test('ranks, seasons', () => {
    assert.deepEqual(rank([{ handle: 'b', points: 5 }, { handle: 'a', points: 9 }, { handle: 'c', points: 5 }, { handle: 'd', points: 1 }]).map((r) => [r.handle, r.rank]),
      [['a', 1], ['b', 2], ['c', 2], ['d', 4]]);
    assert.equal(seasonOf(Date.parse('2026-11-30T23:59:59Z')), '2026-11');
    assert.deepEqual(seasonInfo('2026-12'), { id: '2026-12', label: 'December 2026', starts_at: '2026-12-01T00:00:00.000Z', ends_at: '2027-01-01T00:00:00.000Z' });
  });
});

// ---------------------------------------------------------------------------
// Attribution, visibility and views

const dirs: string[] = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function fakeEvent(id: string, at: number, start: Record<string, unknown>, seats: Array<{ name: string; harness: string; model: string; effort: string; effortBasis?: 'launch' | 'self-report' }>, gamesPlayed: Array<[string, string, string]>, extra: Partial<EventData> = {}): EventData {
  const dir = mkdtempSync(join(tmpdir(), 'points-ev-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'events.jsonl'), JSON.stringify({ type: 'event_start', t: at, id, set: { code: 'FRA', name: 'Reality Fracture' }, ...start, seats: seats.map((s, i) => ({ ...s, kind: 'agent', position: i, ...((start.seatMeta as Record<string, unknown>)?.[s.name] as object ?? {}) })) }) + '\n');
  return {
    id, dir, set: { code: 'FRA', name: 'Reality Fracture' }, bestOf: 3, sideboarding: true, mana: 'manual', promptVersion: 'v4', knowledge: { level: 'primer' },
    source: { label: 'verified' } as EventData['source'], strength: null, draftEval: null, startT: at, lastT: at + 2 * H, status: 'complete',
    seats: seats.map((s, i) => {
      // As loadEvent parses event_start: the seat's contributor id, and its handle when it showed one.
      const m = ((start.seatMeta as Record<string, { contributor_id?: unknown; contributor?: string }>)?.[s.name]) ?? {};
      return {
        name: s.name, kind: 'agent', position: i, llm: true, model: s.name, harness: s.harness, modelHint: s.model, effort: s.effort, ...(s.effortBasis ? { effortBasis: s.effortBasis } : {}),
        ...(m.contributor_id != null ? { contributorId: String(m.contributor_id) } : {}), ...(m.contributor ? { contributorHandle: m.contributor } : {}),
      };
    }),
    ...(start.table ? { table: start.table } : {}),
    packs: [], picks: [], decks: new Map(), matches: [], transcripts: new Map(), usage: new Map(), hasSummary: true, stage: 'done', aborted: false, draftEnded: true,
    rulesIssues: [], forfeits: [], forfeitsLogged: true,
    standings: seats.map((s) => ({ name: s.name, matchWins: gamesPlayed.filter((g) => g[2] === s.name).length, matchLosses: gamesPlayed.filter((g) => (g[0] === s.name || g[1] === s.name) && g[2] !== s.name).length, gameWins: 0, gameLosses: 0 })),
    games: gamesPlayed.map(([a, b, w], i) => ({ index: i + 1, label: `g${i}`, seats: [a, b], matchKey: `${a}-${b}`, gameInMatch: 1, startT: at, over: true, winner: w, decisions: [], autoPasses: {}, forced: {}, payTaps: {}, failures: 0, plays: [], playsLogged: false, unimplemented: [], rulesIssues: [], refusedAuto: [], publicNames: new Set() })),
    ...extra,
  } as unknown as EventData;
}

const people = new Map<number, ContributorRecord>([
  [1, { id: 1, handle: 'alice', kind: 'person', status: 'active', avatarUrl: null, githubLogin: 'alice', boardVisibility: null }],
  [2, { id: 2, handle: 'bob', kind: 'person', status: 'active', avatarUrl: null, githubLogin: null, boardVisibility: null }],
  [3, { id: 3, handle: 'carol', kind: 'person', status: 'active', avatarUrl: null, githubLogin: null, boardVisibility: 'public' }],
  [9, { id: 9, handle: 'director-1', kind: 'director', status: 'active', avatarUrl: null, githubLogin: null, boardVisibility: null }],
]);

describe('attribution and visibility', () => {
  const S = [
    { name: 'opus-1', harness: 'claude-code', model: 'claude-opus-5-5', effort: 'high' },
    { name: 'gpt-1', harness: 'codex', model: 'gpt-6-astra', effort: 'high' },
    { name: 'opus-2', harness: 'claude-code', model: 'claude-opus-5-5', effort: 'high' },
  ];
  // A lobby table: alice brought opus-1 and opus-2 and hid her handle; bob brought gpt-1 and showed his.
  const lobby = fakeEvent('2026-11-02-18-00-00-fra-aaaa', T0, {
    table: { kind: 'lobby', table_id: 't-1' }, organizer: { kind: 'lobby' },
    seatMeta: { 'opus-1': { contributor_id: '1' }, 'opus-2': { contributor_id: '1' }, 'gpt-1': { contributor_id: '2', contributor: 'bob' } },
  }, S, [['opus-1', 'gpt-1', 'opus-1'], ['opus-2', 'gpt-1', 'gpt-1'], ['opus-1', 'opus-2', 'opus-1']]);
  // A Private Table carol organized, but the log claims bob's id for a seat: the organizer gets every seat.
  const priv = fakeEvent('2026-11-03-18-00-00-fra-bbbb', T0 + 24 * H, {
    table: { kind: 'private' }, organizer: { kind: 'contributor', handle: 'carol', contributor_id: 3 }, seatMeta: { 'gpt-1': { contributor_id: '2' } },
  }, S, [['opus-1', 'gpt-1', 'gpt-1']]);
  // A community upload by bob: every seat is bob's, whatever the log says.
  const upload = fakeEvent('2026-11-04-18-00-00-fra-cccc', T0 + 48 * H, { table: { kind: 'lobby' }, seatMeta: { 'opus-1': { contributor_id: '1' } } }, S, [['opus-1', 'gpt-1', 'opus-1']]);
  // Smoke and admin events earn nothing.
  const smoke = fakeEvent('2026-11-05-18-00-00-fra-dddd', T0 + 72 * H, { organizer: { kind: 'admin' } }, S, [], { source: { label: 'smoke' } as EventData['source'] });
  const admin = fakeEvent('2026-11-06-18-00-00-fra-eeee', T0 + 96 * H, { organizer: { kind: 'admin' } }, S, [['opus-1', 'gpt-1', 'gpt-1']]);
  // An admin import of a lobby table: seats keep their owners, but only the hosted Director attests a lobby table.
  const imported = fakeEvent('2026-11-07-18-00-00-fra-ffff', T0 + 120 * H, {
    table: { kind: 'lobby', table_id: 't-9' }, organizer: { kind: 'lobby' }, seatMeta: { 'opus-1': { contributor_id: '1' }, 'gpt-1': { contributor_id: '2', contributor: 'bob' }, 'opus-2': { contributor_id: '3' } },
  }, S, [['opus-1', 'gpt-1', 'opus-1']]);
  // Acceptance times: the Hub's, a few minutes after each event (the logs' own times are informational).
  const acc = (e: EventData) => e.lastT + 5 * 60_000;
  const meta = new Map<string, SubmissionMeta>([
    [lobby.id, { via: 'director', uploader: 9, acceptedAt: acc(lobby) }], [priv.id, { via: 'director', uploader: 9, acceptedAt: acc(priv) }],
    [upload.id, { via: 'upload', uploader: 2, acceptedAt: acc(upload) }], [smoke.id, { via: 'director', uploader: 9, acceptedAt: acc(smoke) }],
    [admin.id, { via: 'director', uploader: 9, acceptedAt: acc(admin) }], [imported.id, { via: 'import', uploader: 9, acceptedAt: acc(imported) }],
  ]);
  const pe = pointsEvents({ events: [lobby, priv, upload, smoke, admin, imported], meta, contributors: people });

  test('who gets each seat', () => {
    const owner = (e: string, s: string) => pe.events.find((x) => x.id === e)!.seats.find((x) => x.name === s)!.contributorId;
    assert.equal(pe.events.length, 5); // smoke left out
    assert.deepEqual([owner(lobby.id, 'opus-1'), owner(lobby.id, 'gpt-1'), owner(lobby.id, 'opus-2')], [1, 2, 1]);
    assert.deepEqual(S.map((s) => owner(priv.id, s.name)), [3, 3, 3]);
    assert.deepEqual(S.map((s) => owner(upload.id, s.name)), [2, 2, 2]);
    assert.deepEqual(S.map((s) => owner(admin.id, s.name)), [null, null, null]);
    assert.equal(pe.events.find((x) => x.id === lobby.id)!.table, 'lobby');
    assert.deepEqual(S.map((s) => owner(imported.id, s.name)), [1, 2, 3]);
    assert.equal(pe.events.find((x) => x.id === imported.id)!.acceptedAt, imported.lastT, 'an admin import keeps its log end (never after the import)');
    assert.equal(pe.events.find((x) => x.id === lobby.id)!.acceptedAt, acc(lobby));
    // Same-identity games are never rated: opus-1 vs opus-2 earns no game points.
    assert.equal(pe.events.find((x) => x.id === lobby.id)!.seats.find((x) => x.name === 'opus-1')!.rated.length, 1);
  });

  test('Early Test Data (best of 1, or best of 3 without sideboarding) earns no rated games and no points', () => {
    const games: Array<[string, string, string]> = [['opus-1', 'gpt-1', 'opus-1'], ['opus-2', 'gpt-1', 'gpt-1']];
    const start = { table: { kind: 'private' }, organizer: { kind: 'contributor', contributor_id: 3 } };
    const bo1 = fakeEvent('2026-11-09-18-00-00-fra-iiii', T0 + 160 * H, start, S, games, { bestOf: 1, sideboarding: undefined });
    const noSb = fakeEvent('2026-11-09-19-00-00-fra-jjjj', T0 + 161 * H, start, S, games, { sideboarding: undefined });
    const bo3 = fakeEvent('2026-11-09-20-00-00-fra-kkkk', T0 + 162 * H, start, S, games);
    const m = new Map<string, SubmissionMeta>([bo1, noSb, bo3].map((e) => [e.id, { via: 'director', uploader: 9, acceptedAt: acc(e) }]));
    const evs = pointsEvents({ events: [bo1, noSb, bo3], meta: m, contributors: people }).events;
    const of = (e: EventData) => evs.find((x) => x.id === e.id)!;
    assert.equal(of(bo1).testData, 'early test data (best of 1)');
    assert.equal(of(noSb).testData, 'early test data (best of 3 without sideboarding)');
    assert.equal(of(bo3).testData, null);
    assert.ok([bo1, noSb].every((e) => of(e).group === null && of(e).seats.every((s) => s.rated.length === 0)), 'no group, no rated games');
    const lines = computeLedger(evs);
    const at = (e: EventData) => lines.filter((l) => l.eventId === e.id);
    for (const e of [bo1, noSb]) {
      assert.ok(at(e).length && at(e).every((l) => l.points === 0 && l.ratedGames === 0 && l.status === 'ineligible'), e.id);
      assert.match(at(e)[0]!.note, /^early test data \(best of (1|3 without sideboarding)\): not rated, no points$/);
    }
    assert.ok(at(bo3).some((l) => l.points > 0), 'best of 3 with sideboarding earns');
    // Test data never feeds bounty state (New Set counts, Needs Games progress).
    assert.equal(finalState(evs.filter((e) => e.testData)).setEvents.size, 0);
  });

  test('a rated table has a rated game: a mirror-only table (pooled, no rated games) is not counted for New Set', () => {
    const mirror = event('2026-11-10-10-00-00-fra-mmmm', T0 + 170 * H, [seat('h1', 1, OPUS, { games: 6 }), seat('h2', 1, OPUS, { games: 6 })]);
    const rated = event('2026-11-10-11-00-00-fra-rrrr', T0 + 171 * H, [seat('o1', 1, OPUS, { rated: games(3, GPT), games: 3 }), seat('g1', 2, GPT, { rated: games(3, OPUS, false), games: 3 })]);
    assert.equal(finalState([mirror]).setEvents.get('FRA') ?? 0, 0);
    assert.equal(finalState([mirror, rated]).setEvents.get('FRA'), 1);
  });

  test('visibility follows the account setting, else the latest lobby handle choice', () => {
    assert.equal(pe.lobbyShown.get(1)?.shown, false);
    assert.equal(pe.lobbyShown.get(2)?.shown, true);
    assert.equal(isPublic(people.get(1), pe.lobbyShown.get(1)), false);
    assert.equal(isPublic(people.get(2), pe.lobbyShown.get(2)), true);
    assert.equal(isPublic(people.get(3), undefined), true);
    assert.equal(isPublic({ ...people.get(1)!, boardVisibility: 'public' }, pe.lobbyShown.get(1)), true);
    assert.equal(isPublic(people.get(9), undefined), false);
  });

  test('a lobby bonus without the hosted Director\'s attestation is refused (PTS-3)', () => {
    const table = (id: string) => pe.events.find((x) => x.id === id)!.table;
    assert.equal(table(upload.id), 'private', 'an upload claiming a lobby table earns as a Private Table');
    assert.equal(table(imported.id), 'private', 'an import keeps its owners, not the lobby multiplier');
    const lines = computeLedger(pe.events);
    const mult = (id: string) => new Set(lines.filter((l) => l.eventId === id).map((l) => l.tableMult));
    assert.deepEqual([...mult(lobby.id)], [1.5]);
    assert.deepEqual([...mult(upload.id)], [1]);
    assert.deepEqual([...mult(imported.id)], [1]);
  });

  test('seats without harness logs are marked; the bundle\'s time is not the points time (PTS-1, PTS-2)', () => {
    const ev = pe.events.find((x) => x.id === upload.id)!;
    assert.ok(ev.seats.every((s) => s.logs === false), 'no usage files in these fixtures');
    assert.ok(ev.seats.every((s) => s.explicitEffort && s.modelActive));
    const lines = computeLedger(pe.events).filter((l) => l.eventId === upload.id);
    assert.ok(lines.every((l) => l.at === acc(upload) && l.season === seasonOf(acc(upload)) && l.bounty === 0));
    assert.ok(lines.filter((l) => l.ratedGames > 0).every((l) => l.logsMult === SCHEME.no_logs));
  });

  test('hosted tables: seats the bench CLI launched count as checked; hand-seated ones do not (PTS-2)', () => {
    const seats = [{ ...S[0]!, effortBasis: 'launch' as const }, { ...S[1]!, effortBasis: 'self-report' as const }];
    const hosted = fakeEvent('2026-11-08-18-00-00-fra-gggg', T0 + 150 * H, { table: { kind: 'private' }, organizer: { kind: 'contributor', contributor_id: 3 } }, seats, [['opus-1', 'gpt-1', 'opus-1']]);
    const up = fakeEvent('2026-11-08-19-00-00-fra-hhhh', T0 + 151 * H, { table: { kind: 'private' } }, seats, [['opus-1', 'gpt-1', 'opus-1']]);
    const m = new Map<string, SubmissionMeta>([[hosted.id, { via: 'director', uploader: 9, acceptedAt: acc(hosted) }], [up.id, { via: 'upload', uploader: 3, acceptedAt: acc(up) }]]);
    const evs = pointsEvents({ events: [hosted, up], meta: m, contributors: people }).events;
    const logs = (e: string) => evs.find((x) => x.id === e)!.seats.map((x) => [x.name, x.logs]);
    assert.deepEqual(logs(hosted.id), [['opus-1', true], ['gpt-1', false]]);
    assert.deepEqual(logs(up.id), [['opus-1', false], ['gpt-1', false]], 'an upload needs its usage files');
  });

  test('hand-started seats: half points and no bounties until `bench attach-logs` shows the declared model (points-v3)', () => {
    // carol's hosted Private Table: opus-1 launched by the bench CLI, gpt-1 started by hand (effort_basis self-report).
    const seats = [{ ...S[0]!, effortBasis: 'launch' as const }, { ...S[1]!, effortBasis: 'self-report' as const }];
    const mk = (id: string, at: number, usage?: Record<string, unknown>) =>
      fakeEvent(id, at, { table: { kind: 'private' }, organizer: { kind: 'contributor', contributor_id: 3 } }, seats, [['opus-1', 'gpt-1', 'opus-1'], ['opus-1', 'gpt-1', 'gpt-1'], ['opus-1', 'gpt-1', 'gpt-1']],
        usage ? { usage: new Map([['gpt-1', usage]]) as EventData['usage'] } : {});
    const before = mk('2026-11-09-18-00-00-fra-iiii', T0 + 170 * H);
    // The same table after `bench attach-logs`: the Hub wrote usage-gpt-1.json from the upload (usage-uploads.ts).
    const attached = mk('2026-11-09-18-00-00-fra-iiii', T0 + 170 * H, { model_ids: ['gpt-6-astra'], model_output_tokens: { 'gpt-6-astra': 91_000 } });
    const noIds = mk('2026-11-09-18-00-00-fra-iiii', T0 + 170 * H, { input_tokens: 1000, output_tokens: 200 });
    const other = mk('2026-11-09-18-00-00-fra-iiii', T0 + 170 * H, { model_ids: ['gpt-6-astra-mini'] });
    const ledger = (ev: EventData) => {
      const m = new Map<string, SubmissionMeta>([[ev.id, { via: 'director', uploader: 9, acceptedAt: ev.lastT + 60_000 }]]);
      const evs = pointsEvents({ events: [ev], meta: m, contributors: people }).events;
      return { seat: evs[0]!.seats.find((x) => x.name === 'gpt-1')!, line: computeLedger(evs).find((l) => l.seat === 'gpt-1')! };
    };
    const a = ledger(before);
    assert.equal(a.seat.logs, false, 'hand-started, no logs: not checked');
    assert.equal(a.line.logsMult, SCHEME.no_logs);
    assert.equal(a.line.bounty, 0);
    assert.match(a.line.note, /no bounties: not checked against harness logs/);
    const b = ledger(attached);
    assert.equal(b.seat.logs, true, 'Checked Against Logs after attach-logs');
    assert.equal(b.line.logsMult, 1, 'full points');
    assert.ok(b.line.bounty > 0, `bounties: ${b.line.note}`);
    assert.equal(b.line.points, Math.round((b.line.base * b.line.tableMult * b.line.repeatMult + b.line.bounty) * b.line.reliabilityMult));
    assert.ok(b.line.points > a.line.points);
    const c = ledger(noIds);
    assert.equal(c.seat.logs, false, 'usage without model ids checks nothing (Self-Reported): still half');
    assert.equal(c.line.logsMult, SCHEME.no_logs);
    const d = ledger(other);
    assert.equal(d.seat.status, 'mismatch');
    assert.equal(d.line.points, 0, 'logs that show another model: Mismatch, no points');
    // Deterministic: the same inputs give the same ledger, whatever order they come in.
    assert.deepEqual(ledger(attached).line, b.line);
  });

  test('boards leave hidden contributors out; profiles and the private view', () => {
    const lines = computeLedger(pe.events);
    const view = new ContributorsView(lines, pe.events, pe.labels, people, pe.lobbyShown, null, [{ code: 'FRA', name: 'Reality Fracture' }], [], T0 + 100 * H);
    const board = view.board('all');
    assert.deepEqual(board.map((r) => r.handle).sort(), ['bob', 'carol']);
    assert.equal(view.publicProfile('alice'), undefined);
    const bob = view.publicProfile('bob')! as any;
    assert.equal(bob.handle, 'bob');
    assert.equal(bob.contribution.tables, 3); // the lobby table, his upload, the imported lobby table
    assert.equal(bob.agents[0].identity_label.includes('GPT-6 Astra'), true);
    assert.ok(!JSON.stringify(bob).includes('contributor_id'));
    const alice = view.account(1);
    assert.equal(alice.public, false);
    assert.ok(alice.points.all_time > 0);
    assert.ok(alice.points.rank_all_time != null);
    const file = view.file() as any;
    assert.equal(file.contributors_schema, 1);
    assert.equal(file.totals.contributors, 3);
    assert.equal(file.totals.public_contributors, 2);
    assert.equal(file.scheme.id, 'points-v3');
    assert.ok(!JSON.stringify(file).includes('alice'));
  });

  test('open bounties list models without games and provisional setups', () => {
    const b = openBounties(pe.events, pe.labels, null, [{ code: 'FRA', name: 'Reality Fracture' }, { code: 'TLA', name: 'Avatar' }]);
    assert.ok(b.some((x) => x.kind === 'first_games' && x.model_id === 'claude-haiku-5-5'));
    assert.ok(!b.some((x) => x.kind === 'first_games' && x.model_id === 'claude-opus-5-5'));
    assert.ok(b.some((x) => x.kind === 'provisional' && x.identity === OPUS && x.label === NEEDS_GAMES));
    assert.ok(b.some((x) => x.kind === 'new_set' && x.set === 'TLA'));
  });

  test('contributors.json always exists: an empty board with the rules and bounties before any contributor', () => {
    const empty = new ContributorsView([], [], new Map(), new Map(), new Map(), null, [{ code: 'FRA', name: 'Reality Fracture' }]).file() as any;
    assert.deepEqual(empty.boards, { season: [], all_time: [] });
    assert.equal(empty.totals.contributors, 0);
    assert.equal(empty.scheme.id, SCHEME.id);
    assert.ok(empty.bounties.some((x: any) => x.kind === 'first_games'));
    assert.ok(empty.bounties.some((x: any) => x.kind === 'new_set' && x.set === 'FRA'));
    const site = mkdtempSync(join(tmpdir(), 'points-site-'));
    dirs.push(site);
    const c = new Contributors({ sql: null as never, events: new Map(), siteDir: site, cfg: { setsDir: join(site, 'no-sets'), bountiesFile: join(site, 'none.json') }, log: () => {} });
    c.ensureFile();
    const file = JSON.parse(readFileSync(join(site, 'contributors.json'), 'utf8'));
    assert.deepEqual(file.boards.all_time, []);
    assert.ok(existsSync(join(site, 'contributors.json')));
  });
});

describe('season rollover (LAUNCH-CHECKLIST F-4)', () => {
  const OCT_31 = Date.parse('2026-10-31T23:59:00Z');
  const NOV_1 = Date.parse('2026-11-01T00:00:00Z');
  const ledger = computeLedger([event('oct-table', Date.parse('2026-10-31T20:00:00Z'), [seat('c1', 3, OPUS, { rated: games(3, GPT), games: 3 })])]);
  const viewAt = (now: number) => new ContributorsView(ledger, [], new Map(), people, new Map(), null, [{ code: 'FRA', name: 'Reality Fracture' }], [], now);

  test('the next season starts at 00:00 UTC on the 1st, December to January included', () => {
    assert.equal(nextSeasonStart(OCT_31), NOV_1);
    assert.equal(nextSeasonStart(NOV_1), Date.parse('2026-12-01T00:00:00Z'), 'at the boundary itself: the one after');
    assert.equal(nextSeasonStart(Date.parse('2026-12-31T23:59:59Z')), Date.parse('2027-01-01T00:00:00Z'));
  });

  test('with a mocked clock: the label says October until midnight UTC, then November, with no new table', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: OCT_31 });
    let view = viewAt(Date.now());
    assert.deepEqual((view.file() as any).season, { id: '2026-10', label: 'October 2026', starts_at: '2026-10-01T00:00:00.000Z', ends_at: '2026-11-01T00:00:00.000Z' });
    const host = { sql: null as never, events: new Map(), siteDir: '', cfg: { setsDir: '', bountiesFile: '' }, log: () => {} };
    const service = new Contributors(host);
    service.view = view;
    assert.equal(service.stale(), false);
    const fired: string[] = [];
    const clock = new SeasonClock((season) => {
      fired.push(season);
      view = viewAt(Date.now());
    });
    clock.start();
    t.mock.timers.tick(60_000); // 00:00:00 UTC on November 1
    assert.equal(service.stale(), true, 'the October view is stale from the first second of November (the API rebuilds it)');
    assert.deepEqual(fired, [], 'a few seconds of grace after the boundary');
    t.mock.timers.tick(5_000);
    assert.deepEqual(fired, ['2026-11']);
    const file = view.file() as any;
    assert.deepEqual(file.season, { id: '2026-11', label: 'November 2026', starts_at: '2026-11-01T00:00:00.000Z', ends_at: '2026-12-01T00:00:00.000Z' });
    assert.deepEqual(file.seasons, ['2026-11', '2026-10'], 'the new season is listed before it has points');
    assert.deepEqual(file.boards.season, [], 'the November board starts empty');
    assert.equal(view.board('2026-10')[0]?.handle, 'carol', 'October keeps its points');
    assert.equal(file.boards.all_time[0]?.handle, 'carol');
    // And again a month later (the timer re-arms itself; 30 days is longer than one setTimeout can wait).
    t.mock.timers.tick(30 * 24 * H);
    assert.deepEqual(fired, ['2026-11', '2026-12']);
    assert.equal((view.file() as any).season.label, 'December 2026');
    clock.stop();
  });

  test('a wait longer than one setTimeout re-arms without firing early', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.parse('2026-12-01T00:00:10Z') });
    const fired: string[] = [];
    const clock = new SeasonClock((season) => fired.push(season));
    clock.start();
    t.mock.timers.tick(2 ** 31 - 1); // about 24.8 days: still December
    assert.deepEqual(fired, []);
    t.mock.timers.tick(Date.parse('2027-01-01T00:00:05Z') - Date.now());
    assert.deepEqual(fired, ['2027-01']);
    clock.stop();
  });
});
