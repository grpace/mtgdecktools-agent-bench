/**
 * Stopped events (METHODOLOGY §3.2 "Stopped events"): an organizer who stops a table can't erase its finished games.
 * Finished games of a stopped event are rated; games never played are not results; an open game is void, except that
 * the stopping organizer's own seat loses an open game against a seat that isn't theirs (like a watchdog forfeit).
 *   npx tsx packages/site/src/stopped-events.test.ts
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CardDb, loadEvent, type EventData } from './data.js';
import { makeContext } from './context.js';
import { builder } from './export.js';
import { totals } from './metrics.js';
import { eventRatingStatus, groupKey, Identities, ratingGamesOf, tableKind, tableSentence, unratedReason } from './scoring.js';
import { isSwiss8 } from './outcomes.js';

const T0 = Date.parse('2026-10-23T18:00:00Z');
const root = mkdtempSync(join(tmpdir(), 'mtgdt-stopped-'));
let failed = 0;
const check = (name: string, f: () => void) => {
  try {
    f();
    console.log(`ok   ${name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL ${name}\n     ${(err as Error).stack}`);
  }
};

const OPUS = { harness: 'claude-code', model: 'claude-opus-5-5', effort: 'high' };
const HAIKU = { harness: 'claude-code', model: 'claude-haiku-5-5', effort: 'low' };
const deck = (p: string) => ({ main: [...Array.from({ length: 23 }, (_, i) => `${p} ${i}`), ...Array(17).fill('Island')], sideboard: [] });

/**
 * o-1 (Opus) vs h-1 (Haiku): game 1 finished (o-1 won), game 2 still being played when the table stopped. With
 * `seatOwners`, the seats were queued by those contributors (a lobby-style table); without, it is a Private Table.
 */
function lines(o: { by?: string; organizer?: Record<string, unknown>; seatOwners?: Record<string, string>; abort?: boolean; open?: boolean } = {}): unknown[] {
  let t = T0;
  const M = 'o-1 vs h-1';
  const owner = (n: string) => (o.seatOwners?.[n] ? { contributor_id: o.seatOwners[n] } : {});
  const L: unknown[] = [
    { t: t++, type: 'event_start', set: { code: 'FRA', name: 'Reality Fracture' }, best_of: 3, sideboarding: true, play_draw: 'loser-chooses', mana: 'manual',
      prompt_version: 'v6', prompt_sha256: 'a'.repeat(64), knowledge: { level: 'primer' }, pairing: { format: 'swiss', rounds: 3, version: 2 },
      organizer: o.organizer ?? { kind: 'contributor', contributor_id: '7' },
      seats: [{ name: 'o-1', ...OPUS, kind: 'agent', position: 0, ...owner('o-1') }, { name: 'h-1', ...HAIKU, kind: 'agent', position: 1, ...owner('h-1') }] },
    { t: t++, type: 'deck_built', seat: 'o-1', by: 'agent', ...deck('A') },
    { t: t++, type: 'deck_built', seat: 'h-1', by: 'agent', ...deck('B') },
    { t: t++, type: 'round_start', round: 1, rounds: 3, format: 'swiss', pairs: [['o-1', 'h-1']], byes: [] },
    { t: t++, type: 'game_start', game: `${M} — game 1`, seats: ['o-1', 'h-1'] },
    { t: t++, type: 'game_over', game: `${M} — game 1`, winner: 'o-1', turns: 9, on_play: 'o-1' },
  ];
  if (o.open !== false) L.push({ t: t++, type: 'game_start', game: `${M} — game 2`, seats: ['h-1', 'o-1'] });
  if (o.abort !== false) {
    L.push({ t: t++, type: 'event_abort', reason: 'canceled', stage: 'games', by: o.by ?? 'organizer', completed_games: 1,
      open_games: o.open === false ? [] : [{ game: `${M} — game 2`, seats: ['h-1', 'o-1'] }] });
  }
  return L;
}

function load(id: string, ls: unknown[], now = T0 + 100_000): EventData {
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'events.jsonl'), ls.map((l) => JSON.stringify({ ...(l as object), ...((l as { type: string }).type === 'event_start' ? { id } : {}) })).join('\n') + '\n');
  // A stopped event's summary.json (Event.abort writes it for the Hub hand-off).
  if (ls.some((l) => (l as { type: string }).type === 'event_abort')) writeFileSync(join(dir, 'summary.json'), JSON.stringify({ id, standings: [], matches: [], stopped: { reason: 'canceled' } }));
  const ev = loadEvent(dir, now);
  assert.ok(ev, `${id} loads`);
  return ev!;
}

try {
  check('a Private Table its organizer stopped: status stopped, its finished game rated, the open game void', () => {
    const ev = load('2026-10-23-18-00-00-fra-aaaa', lines());
    assert.equal(ev.status, 'stopped');
    assert.equal(ev.stop?.by, 'organizer');
    assert.equal(unratedReason(ev), undefined, 'pooled: stopping a table no longer drops it');
    const ids = new Identities([ev]);
    const rated = ratingGamesOf([ev], ids);
    assert.equal(rated.length, 1, 'game 1 is rated');
    assert.equal(rated[0]!.winner, 'a');
    assert.deepEqual(ev.stop?.forfeitedGames, [], 'both seats are the organizer’s: no side to charge, the open game is void');
    assert.equal(ev.games.find((g) => g.gameInMatch === 2)?.over, false);
    assert.deepEqual(eventRatingStatus(ev, ids).status, 'rated');
  });

  check('an organizer who stops mid-game forfeits the open game of their own seat against a seat that isn’t theirs', () => {
    const ev = load('2026-10-23-18-00-00-fra-bbbb', lines({ seatOwners: { 'o-1': '7', 'h-1': '9' } }));
    assert.deepEqual(ev.stop?.forfeitedGames, ['o-1 vs h-1 — game 2']);
    const g2 = ev.games.find((g) => g.gameInMatch === 2)!;
    assert.deepEqual([g2.over, g2.winner, g2.forfeitedBy, g2.endReason], [true, 'h-1', 'o-1', 'organizer_stop']);
    const rated = ratingGamesOf([ev], new Identities([ev]));
    assert.equal(rated.length, 2, 'game 1 plus the forfeited game 2 (a loss, like a watchdog forfeit)');
  });

  check('an admin or the server stopping a table voids its open games; its finished games still count', () => {
    for (const by of ['admin', 'system']) {
      const ev = load(`2026-10-23-18-00-00-fra-c${by.slice(0, 3)}`, lines({ by, seatOwners: { 'o-1': '7', 'h-1': '9' } }));
      assert.deepEqual(ev.stop?.forfeitedGames, []);
      assert.equal(ratingGamesOf([ev], new Identities([ev])).length, 1);
    }
  });

  check('a live event is still not rated; a stalled one (never ended) rates its finished games', () => {
    const live = load('2026-10-23-18-00-00-fra-dddd', lines({ abort: false }), T0 + 60_000);
    assert.equal(live.status, 'in-progress');
    assert.match(unratedReason(live) ?? '', /in progress/);
    const stalled = load('2026-10-23-18-00-00-fra-eeee', lines({ abort: false }), T0 + 3 * 3_600_000);
    assert.equal(stalled.status, 'stalled');
    assert.equal(ratingGamesOf([stalled], new Identities([stalled])).length, 1);
  });

  check('the export: status stopped with the stop sentence, totals count its finished game, no winner named', () => {
    const ev = load('2026-10-23-18-00-00-fra-ffff', lines());
    const b = builder(makeContext({ events: [ev], cards: new CardDb(undefined), setsDir: root, replicates: 0, now: T0 + 100_000 }), null, join(root, 'none.json'));
    const idx = b.index();
    const e = idx.events.find((x) => x.id === ev.id)!;
    assert.equal(e.status, 'stopped');
    assert.deepEqual([e.stop?.by, e.stop?.open_games, e.stop?.forfeited_games], ['organizer', 1, 0]);
    assert.match(e.stop!.text, /^Stopped by its organizer \(canceled\) before it finished\. Its finished games count and are rated; games never played are not results\. The game still being played is void \(not results\)\.$/);
    assert.equal(e.rated_games, 1);
    assert.equal(totals([ev]).llmGames, 1);
    const act = (idx.activity ?? []).find((a) => a.event_id === ev.id)!;
    assert.equal(act.stopped, true);
    assert.equal(act.winner_label, null);
    assert.ok(!/won a table/.test(act.text), act.text);
  });

  check('the stop sentence follows the rating status; a stop with no recorded stopper or reason reads plainly', () => {
    // An early test table (best of 1: Early Test Data, never rated) killed by a redeploy, its log naming no stopper.
    const ls = lines().map((l) => {
      const r = l as Record<string, unknown>;
      if (r.type === 'event_start') return { ...r, best_of: 1, sideboarding: false };
      if (r.type === 'event_abort') return { t: r.t, type: 'event_abort', signal: 'redeploy', stage: 'games' };
      return r;
    });
    const ev = load('2026-10-23-18-00-00-fra-cb75', ls);
    const b = builder(makeContext({ events: [ev], cards: new CardDb(undefined), setsDir: root, replicates: 0, now: T0 + 100_000 }), null, join(root, 'none.json'));
    const e = b.index().events.find((x) => x.id === ev.id)!;
    assert.equal(e.rating_status, 'not_rated');
    assert.equal(e.stop!.text, "Stopped before it finished (who stopped it wasn't recorded). Its finished games are kept as results, but this table is not rated; games never played are not results.");
    assert.doesNotMatch(e.stop!.text, /are rated|\(stopped\)|someone/);
  });

  check('activity sentences leave out an effort that isn\u2019t known', () => {
    let t = T0 + 900;
    const seats = [{ name: 'o-1', harness: 'claude-code', model: 'claude-opus-5-5' }, { name: 'h-1', ...HAIKU }];
    const ev = load('2026-10-23-18-00-00-tla-c001', [
      { t: t++, type: 'event_start', set: { code: 'TLA', name: 'Avatar' }, best_of: 3, sideboarding: true, mana: 'manual', prompt_version: 'v6', knowledge: { level: 'primer' },
        seats: seats.map((x, i) => ({ kind: 'agent', position: i, ...x })) },
      { t: t++, type: 'game_start', game: 'o-1 vs h-1 — game 1', seats: ['o-1', 'h-1'] }, { t: t++, type: 'game_over', game: 'o-1 vs h-1 — game 1', winner: 'o-1', turns: 8 },
      { t: t++, type: 'event_end', standings: [] },
    ]);
    const b = builder(makeContext({ events: [ev], cards: new CardDb(undefined), setsDir: root, replicates: 0, now: T0 + 100_000 }), null, join(root, 'none.json'));
    const idx = b.index();
    assert.equal(idx.identities.find((i) => i.model === 'claude-opus-5-5')?.effort, 'unknown');
    const texts = (idx.activity ?? []).filter((a) => a.event_id === ev.id || a.identity?.includes('opus')).map((a) => a.text);
    assert.ok(texts.length > 0);
    for (const x of texts) assert.doesNotMatch(x, /Unknown Effort/, x);
    assert.ok(texts.some((x) => x.includes('Claude Opus 5.5 played')), texts.join(' | '));
  });

  check('table kinds and their sentences: never "won a table of N agents" at a mirror or single-model table', () => {
    const mk = (id: string, seats: Array<Record<string, unknown>>, winner: string) => {
      const games = [];
      let t = T0 + 10;
      for (let i = 1; i < seats.length; i++) {
        const [x, y] = [seats[0]!.name as string, seats[i]!.name as string];
        games.push({ t: t++, type: 'game_start', game: `${x} vs ${y} — game 1`, seats: [x, y] }, { t: t++, type: 'game_over', game: `${x} vs ${y} — game 1`, winner, turns: 8 });
      }
      return load(id, [
        { t: T0, type: 'event_start', set: { code: 'TLA', name: 'Avatar: The Last Airbender' }, best_of: 3, sideboarding: true, mana: 'manual', prompt_version: 'v6', knowledge: { level: 'primer' },
          seats: seats.map((s, i) => ({ kind: 'agent', position: i, ...s })) },
        ...games, { t: t++, type: 'event_end', standings: [] },
      ]);
    };
    const mirror = mk('2026-10-23-18-00-00-tla-a001', [{ name: 'h-1', ...HAIKU }, { name: 'h-2', ...HAIKU }], 'h-1');
    const ladder = mk('2026-10-23-18-00-00-tla-a002', [{ name: 'h-1', ...HAIKU }, { name: 'h-2', ...HAIKU, effort: 'medium' }], 'h-2');
    const mixed = mk('2026-10-23-18-00-00-tla-a003', [{ name: 'o-1', ...OPUS }, { name: 'h-1', ...HAIKU }], 'o-1');
    const ids = new Identities([mirror, ladder, mixed]);
    const label = (k: string) => ids.info.get(k)?.label ?? k;
    assert.deepEqual([tableKind(mirror, ids), tableKind(ladder, ids), tableKind(mixed, ids)], ['mirror', 'single_model', 'mixed']);
    assert.equal(tableSentence(mirror, ids, label, 'h-1'), 'Two identical Claude Haiku 5.5 · Low seats played each other in Avatar: The Last Airbender: a mirror table, so no game is rated and no setup won it.');
    assert.match(tableSentence(ladder, ids, label, 'h-2'), /^Two Claude Haiku 5\.5 seats played each other in Avatar: The Last Airbender \(2 setups: .*\)\. A Claude Haiku 5\.5 · Medium seat finished first\.$/);
    assert.equal(tableSentence(mixed, ids, label, 'o-1'), 'Claude Opus 5.5 · High won a table of 2 agents in Avatar: The Last Airbender.');
    // Critic round 3: two models and six scripted players is a test table: never rated, never "won", no group.
    const scripted = Array.from({ length: 6 }, (_, k) => ({ name: `r-${k}`, harness: 'script', model: 'random' }));
    const test = mk('2026-10-23-18-00-00-tla-a004', [{ name: 'o-1', ...OPUS }, { name: 'h-1', ...HAIKU }, ...scripted], 'o-1');
    const ids2 = new Identities([test]);
    const label2 = (k: string) => ids2.info.get(k)?.label ?? k;
    assert.equal(tableKind(test, ids2), 'test');
    assert.equal(tableSentence(test, ids2, label2, 'o-1'), 'A test table in Avatar: The Last Airbender: Claude Haiku 5.5 · Low, Claude Opus 5.5 · High with six scripted players, a check of the software, not a result.');
    assert.equal(groupKey(test), null, 'no rating group');
    assert.match(unratedReason(test)!, /^test table \(6 scripted seats\)$/);
    assert.equal(isSwiss8(test), false, 'no Swiss finishes');
  });
  check('model files: games played count each game once (a game against itself is one game), cost says what it covers', () => {
    let t = T0 + 500;
    const seats = [{ name: 'h-1', ...HAIKU }, { name: 'h-2', ...HAIKU }, { name: 'o-1', ...OPUS }];
    const g = (x: string, y: string, w: string) => [{ t: t++, type: 'game_start', game: `${x} vs ${y} — game 1`, seats: [x, y] }, { t: t++, type: 'game_over', game: `${x} vs ${y} — game 1`, winner: w, turns: 8 }];
    const ev = load('2026-10-23-18-00-00-tla-b001', [
      { t: t++, type: 'event_start', set: { code: 'TLA', name: 'Avatar' }, best_of: 3, sideboarding: true, mana: 'manual', prompt_version: 'v6', knowledge: { level: 'primer' },
        seats: seats.map((x, i) => ({ kind: 'agent', position: i, ...x })) },
      ...g('h-1', 'h-2', 'h-1'), ...g('h-1', 'o-1', 'o-1'), ...g('h-2', 'o-1', 'h-2'), { t: t++, type: 'event_end', standings: [] },
    ]);
    const b = builder(makeContext({ events: [ev], cards: new CardDb(undefined), setsDir: root, replicates: 0, now: T0 + 100_000 }), null, join(root, 'none.json'));
    const haiku = new Map(b.models()).get('claude-haiku-5-5')!;
    assert.deepEqual(haiku.played, { games: 3, mirror_games: 1, events: 1, seats: 2, text: '3 games at 1 table, 1 of them against itself.' });
    assert.equal(haiku.cost.coverage_text, 'No seat has a cost yet.');
    assert.equal(haiku.cost.seats_total, 2);
    assert.deepEqual(haiku.cost_conditions!.map((c) => c.label), ['Best of 3 with Sideboarding · One Session']);
  });
} finally {
  rmSync(root, { recursive: true, force: true });
}

if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nall stopped-event checks passed');
