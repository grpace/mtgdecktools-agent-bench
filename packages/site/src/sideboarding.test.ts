/**
 * Best of 3 with sideboarding (SITE-DATA 2.13): Early Test Data labels (best of 1, best of 3 without sideboarding),
 * groups that no longer split on best-of, the export of play/draw decisions and sideboarding, and their live redaction.
 *   npx tsx packages/site/src/sideboarding.test.ts
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_SPECTATE_POLICY } from '../../director/src/spectate-policy.js';
import { CardDb, loadEvent, type EventData } from './data.js';
import { makeContext, repoRoot } from './context.js';
import { builder } from './export.js';
import { redactLive } from './live-redact.js';
import {
  conditionsText, earlyTestData, EARLY_TEST_DATA_LABEL, eventRatingStatus, groupKey, groupLabel, Identities, isMainCondition, MAIN_CONDITION, normalizeGroupKey,
  parseGroupKey, ratingGamesOf, unratedReason,
} from './scoring.js';

const T0 = Date.parse('2026-10-22T18:00:00Z');
const root = mkdtempSync(join(tmpdir(), 'mtgdt-sideboarding-'));
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
const SONNET = { harness: 'claude-code', model: 'claude-sonnet-5-5', effort: 'high' };
const pool = (p: string) => Array.from({ length: 26 }, (_, i) => `${p} Card ${i + 1}`);
const deck = (p: string, basics: [string, string]) => ({
  main: [...pool(p).slice(0, 23), ...Array(9).fill(basics[0]), ...Array(8).fill(basics[1])],
  sideboard: pool(p).slice(23),
});
const M = 'o-1 vs s-1';
const G = (n: number) => `${M} — game ${n}`;

/**
 * One best-of-3 match: o-1 wins game 1 (seed put o-1 on the play), s-1 wins game 2 (s-1 lost game 1, chose play,
 * sideboarded one card), o-1 wins game 3 (o-1 lost game 2, chose draw, swapped an Island for a Plains).
 */
function lines(o: { start?: Record<string, unknown>; finished?: boolean } = {}): unknown[] {
  const a = deck('Alpha', ['Island', 'Plains']);
  const b = deck('Beta', ['Swamp', 'Mountain']);
  const bMain2 = [...b.main.filter((c) => c !== 'Beta Card 1'), 'Beta Card 24'];
  const aMain3 = [...a.main.slice(0, 23), ...Array(8).fill('Island'), ...Array(9).fill('Plains')];
  let t = T0;
  const L: unknown[] = [
    { t: t++, type: 'event_start', id: 'sb-1', set: { code: 'FRA', name: 'Test' }, best_of: 3, sideboarding: true, play_draw: 'loser-chooses', mana: 'manual',
      prompt_version: 'v4', knowledge: { level: 'primer' }, seats: [{ name: 'o-1', ...OPUS, kind: 'agent', position: 0 }, { name: 's-1', ...SONNET, kind: 'agent', position: 1 }], ...o.start },
    { t: t++, type: 'deck_built', seat: 'o-1', by: 'agent', ...a },
    { t: t++, type: 'deck_built', seat: 's-1', by: 'agent', ...b },
    { t: t++, type: 'play_draw', match: M, game_number: 1, on_play: 'o-1', by: 'seed', chooser: null, choice: null },
    { t: t++, type: 'game_start', game: G(1), seats: ['o-1', 's-1'], deck_sizes: { 'o-1': 40, 's-1': 40 } },
    { t: t++, type: 'game_over', game: G(1), winner: 'o-1', turns: 8, on_play: 'o-1' },
    { t: t++, type: 'play_draw_offered', seat: 's-1', id: 'pd-2', match: M, game_number: 2, text: 'Play or draw?' },
    { t: t++, type: 'play_draw', match: M, game_number: 2, on_play: 's-1', by: 'agent', chooser: 's-1', choice: 'play', note: 'Beta Card 2 wants tempo', latency_ms: 900 },
    { t: t++, type: 'sideboard_offered', seat: 'o-1', id: 'sb-o2', match: M, game_number: 2, text: '…' },
    { t: t++, type: 'sideboarded', seat: 'o-1', match: M, game_number: 2, by: 'agent', kept: true, in: [], out: [], main: a.main, sideboard: a.sideboard, basics: { Island: 9, Plains: 8 }, main_count: 40, latency_ms: 500 },
    { t: t++, type: 'sideboard_offered', seat: 's-1', id: 'sb-s2', match: M, game_number: 2, text: '…' },
    { t: t++, type: 'sideboarded', seat: 's-1', match: M, game_number: 2, by: 'agent', kept: false, in: [{ name: 'Beta Card 24', qty: 1 }], out: [{ name: 'Beta Card 1', qty: 1 }],
      main: bMain2, sideboard: [...b.sideboard.filter((c) => c !== 'Beta Card 24'), 'Beta Card 1'], basics: { Swamp: 9, Mountain: 8 }, main_count: 40, note: 'More removal for their fliers', latency_ms: 1200 },
    { t: t++, type: 'game_start', game: G(2), seats: ['s-1', 'o-1'], deck_sizes: { 'o-1': 40, 's-1': 40 } },
    { t: t++, type: 'game_over', game: G(2), winner: 's-1', turns: 9, on_play: 's-1' },
    { t: t++, type: 'play_draw', match: M, game_number: 3, on_play: 's-1', by: 'agent', chooser: 'o-1', choice: 'draw' },
    { t: t++, type: 'sideboarded', seat: 'o-1', match: M, game_number: 3, by: 'agent', kept: false, in: [{ name: 'Plains', qty: 1 }], out: [{ name: 'Island', qty: 1 }],
      main: aMain3, sideboard: a.sideboard, basics: { Island: 8, Plains: 9 }, main_count: 40, latency_ms: 700 },
    { t: t++, type: 'sideboarded', seat: 's-1', match: M, game_number: 3, by: 'forfeit', kept: true, in: [], out: [], main: bMain2, sideboard: [...b.sideboard.filter((c) => c !== 'Beta Card 24'), 'Beta Card 1'], basics: { Swamp: 9, Mountain: 8 }, main_count: 40, latency_ms: 600000 },
    { t: t++, type: 'game_start', game: G(3), seats: ['s-1', 'o-1'], deck_sizes: { 'o-1': 40, 's-1': 40 } },
    // 2.23: a decision whose view (and replay board) shows a hidden card in hand.
    { t: t++, type: 'decision_offered', game: G(3), seat: 's-1', id: 'D3', kind: 'priority', turn: 2, phase: 'precombat main', active: 's-1', options: ['1. Pass'],
      text: '[Game 3] Turn 2\nEverything you can see, as JSON: ids stay fixed\n' + JSON.stringify({"state": {"turn": 2, "step": "precombat main", "active": "you", "priority": "you", "you": {"life": 20, "hand": 1, "library": 32}, "opponent": {"life": 20, "hand": 7, "library": 33}, "hand": [{"id": 1, "card": "Beta Card 24"}], "battlefield": {"you": [{"id": 2, "card": "Swamp"}], "opponent": []}, "stack": [], "graveyard": {"you": [], "opponent": []}, "exile": []}}) + '\nDECISION D3' },
  ];
  if (o.finished !== false) {
    L.push({ t: t++, type: 'game_over', game: G(3), winner: 'o-1', turns: 10, on_play: 's-1' });
    L.push({ t: t++, type: 'match_end', a: 'o-1', b: 's-1', wins: { 'o-1': 2, 's-1': 1 } });
    L.push({ t: t++, type: 'event_end' });
  }
  return L;
}

function write(id: string, ls: unknown[]): string {
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'events.jsonl'), ls.map((l) => JSON.stringify({ ...(l as object), ...((l as { type: string }).type === 'event_start' ? { id } : {}) })).join('\n') + '\n');
  return dir;
}
const load = (id: string, ls: unknown[], now = T0 + 100_000): EventData => {
  const ev = loadEvent(write(id, ls), now);
  assert.ok(ev, `${id} loads`);
  return ev!;
};
const exportOf = (evs: EventData[]) => builder(makeContext({ events: evs, cards: new CardDb(undefined), setsDir: root, replicates: 0, now: T0 + 100_000, mainPrompts: ['v4'] }), null, join(root, 'none.json'));

try {
  check('the log loads: one play/draw per game, one sideboarding per seat before games 2 and 3, deck sizes', () => {
    const ev = load('sb-load', lines());
    assert.equal(ev.sideboarding, true);
    assert.equal(ev.playDrawRule, 'loser-chooses');
    assert.deepEqual(ev.playDraws!.map((p) => [p.gameNumber, p.onPlay, p.chooser, p.choice, p.by]), [[1, 'o-1', null, null, 'seed'], [2, 's-1', 's-1', 'play', 'agent'], [3, 's-1', 'o-1', 'draw', 'agent']]);
    assert.equal(ev.sideboards!.length, 4);
    assert.deepEqual(ev.games[0]!.deckSizes, { 'o-1': 40, 's-1': 40 });
  });

  check('Early Test Data: best of 1 and best of 3 without sideboarding are unrated and labeled; best of 3 with sideboarding is rated', () => {
    const rated = load('sb-rated', lines());
    const bo1 = load('sb-bo1', lines({ start: { best_of: 1, sideboarding: undefined, play_draw: undefined } }));
    const noSb = load('sb-nosb', lines({ start: { sideboarding: undefined } }));
    load('sb-smoke', lines({ start: { best_of: 1 } })); // a smoke run at best of 1: still Test Run, not Early Test Data
    writeFileSync(join(root, 'sb-smoke', 'source.json'), JSON.stringify({ label: 'smoke' }));
    const smokeEv = loadEvent(join(root, 'sb-smoke'), T0 + 100_000)!;
    assert.equal(unratedReason(rated), undefined);
    assert.equal(unratedReason(bo1), 'early test data (best of 1)');
    assert.equal(unratedReason(noSb), 'early test data (best of 3 without sideboarding)');
    assert.equal(earlyTestData(smokeEv), undefined, 'smoke runs keep their own label');
    assert.equal(unratedReason(smokeEv), 'labeled smoke');
    for (const ev of [bo1, noSb]) {
      assert.equal(groupKey(ev), null, 'in no group');
      const r = eventRatingStatus(ev, new Identities([ev]));
      assert.deepEqual([r.status, r.display, r.rated_games], ['not_rated', 'Not Rated', 0], 'never counted as rated games');
    }
    const b = exportOf([rated, bo1, noSb, smokeEv]);
    const idx = b.index();
    const ev = (id: string) => idx.events.find((e) => e.id === id)!;
    assert.deepEqual([ev('sb-bo1').test_data, ev('sb-bo1').test_data_label, ev('sb-bo1').rating_reason], [true, EARLY_TEST_DATA_LABEL, 'early test data (best of 1)']);
    assert.equal(EARLY_TEST_DATA_LABEL, 'Early Test Data');
    assert.deepEqual([ev('sb-nosb').test_data, ev('sb-nosb').test_data_label, ev('sb-nosb').sideboarding], [true, 'Early Test Data', false]);
    assert.deepEqual([ev('sb-rated').test_data, ev('sb-rated').test_data_label, ev('sb-rated').sideboarding, ev('sb-rated').play_draw], [false, null, true, 'loser-chooses']);
    assert.deepEqual([ev('sb-smoke').test_data, ev('sb-smoke').provenance_display], [false, 'Test Run']);
    assert.deepEqual(idx.methodology.unrated_events.filter((u) => /^early test data/.test(u.reason)).map((u) => u.id).sort(), ['sb-bo1', 'sb-nosb']);
    // Only the rated event is on a board; the test data stays visible as an event file.
    assert.deepEqual(idx.boards.flatMap((x) => x.rows.flatMap((r) => r.seats.map((s) => s.event_id))).filter((x, i, a) => a.indexOf(x) === i), ['sb-rated']);
    assert.equal(b.event(bo1).config.unrated_reason, 'early test data (best of 1)');
    assert.equal(idx.methodology.early_test_data?.label, 'Early Test Data');
    assert.ok((idx.activity ?? []).filter((a) => a.event_id === 'sb-bo1').every((a) => a.test_data === true));
  });

  check('the known best-of-1 tables (SOS 909e, TLA 8a85) are labeled Early Test Data', () => {
    const ids = ['2026-10-22-14-39-42-sos-909e', '2026-10-22-10-18-50-tla-8a85'].filter((id) => existsSync(join(repoRoot, 'runs', id, 'events.jsonl')));
    if (!ids.length) return console.log('     (runs not present: skipped)');
    for (const id of ids) {
      const ev = loadEvent(join(repoRoot, 'runs', id), Date.now())!;
      assert.equal(earlyTestData(ev), 'early test data (best of 1)', id);
      assert.equal(groupKey(ev), null, id);
    }
  });

  check('groups no longer split on best-of: keys, labels, sentences; old keys still parse', () => {
    const ev = load('sb-key', lines());
    assert.equal(groupKey(ev), 'kn=primer;mana=manual;prompt=v4');
    assert.equal(groupLabel({ knowledge: 'primer', mana: 'manual' }), 'Set Context · Manual Mana');
    assert.equal(groupLabel({ knowledge: 'none', mana: 'auto', best_of: 1 }), 'No Set Context · Automatic Mana', 'a best_of passed in is ignored');
    assert.equal(conditionsText({ knowledge: 'none', mana: 'auto' }), 'No Set Context with automatic mana');
    assert.equal(conditionsText({ knowledge: 'primer', mana: 'manual' }), 'Set Context');
    assert.equal(normalizeGroupKey('kn=primer;mana=manual;bo=3;prompt=sha256:3f2a9c01b7de'), 'kn=primer;mana=manual;prompt=sha256:3f2a9c01b7de');
    assert.equal(normalizeGroupKey('kn=primer;mana=manual;prompt=v4'), 'kn=primer;mana=manual;prompt=v4');
    assert.deepEqual(parseGroupKey('kn=primer+stats;mana=auto;bo=1;prompt=sha256:abc'), { knowledge: 'primer+stats', mana: 'auto', prompt: 'sha256:abc' });
    assert.ok(isMainCondition({ knowledge: 'primer', mana: 'manual' }));
    assert.ok(!isMainCondition({ knowledge: 'none', mana: 'manual' }));
    const idx = exportOf([ev]).index();
    assert.equal(idx.groups[0]!.label, 'Set Context · Manual Mana');
    assert.equal(idx.groups[0]!.conditions.best_of, 3, 'kept for compatibility');
    assert.equal(idx.methodology.main_condition?.label, 'Set Context · Manual Mana');
    assert.equal(idx.groups[0]!.role, 'main');
  });

  check('export: each game carries its play/draw decision; games 2–3 carry each seat\'s sideboarding', () => {
    const ev = load('sb-export', lines());
    const b = exportOf([ev]);
    const file = b.event(ev);
    const [g1, g2, g3] = file.games;
    // 2.23: a finished event's decisions carry the replay board, the deciding seat's hand included.
    const tl = b.game(ev, ev.games[2]!).timeline;
    assert.deepEqual(tl[0]!.state?.hand, { seat: 's-1', cards: ['Beta Card 24'] });
    assert.deepEqual(tl[0]!.state?.players['s-1']!.battlefield, [{ id: 2, card: 'Swamp' }]);
    assert.equal(tl[0]!.state?.active, 's-1');
    assert.deepEqual(g1!.play_draw, { on_play: 'o-1', chooser: null, choice: null, by: 'seed' });
    assert.equal(g1!.sideboarding, undefined, 'no sideboarding before game 1');
    assert.deepEqual(g1!.deck_sizes, { 'o-1': 40, 's-1': 40 });
    assert.deepEqual(g2!.play_draw, { on_play: 's-1', chooser: 's-1', choice: 'play', by: 'agent', latency_ms: 900 }, 'a note in an older log is not exported');
    assert.deepEqual(g2!.sideboarding!['s-1'], {
      by: 'agent', kept: false, in: [{ name: 'Beta Card 24', qty: 1 }], out: [{ name: 'Beta Card 1', qty: 1 }], main_count: 40, latency_ms: 1200,
    });
    assert.deepEqual(g2!.sideboarding!['o-1'], { by: 'agent', kept: true, in: [], out: [], main_count: 40, latency_ms: 500 });
    assert.deepEqual(g3!.play_draw, { on_play: 's-1', chooser: 'o-1', choice: 'draw', by: 'agent' });
    assert.deepEqual(g3!.sideboarding!['o-1']!.in, [{ name: 'Plains', qty: 1 }]);
    assert.equal(g3!.sideboarding!['s-1']!.by, 'forfeit');
    assert.equal(g3!.on_play, g3!.play_draw!.on_play);
    // The replay file carries the same summary, and its card table resolves the cards that came in or went out.
    const gf = b.game(ev, ev.games[1]!);
    assert.deepEqual(gf.game.sideboarding, g2!.sideboarding);
    assert.ok('Beta Card 24' in gf.cards && 'Beta Card 1' in gf.cards);
    assert.equal(file.config.sideboarding, true);
    assert.equal(file.config.play_draw, 'loser-chooses');
    assert.equal(file.event.conditions.sideboarding, true);
  });

  check('live: sideboard contents are withheld until the seat has no games left; kept, by, main_count and play/draw stay public', () => {
    const ev = load('sb-live', lines({ finished: false }), T0 + 60_000);
    assert.equal(ev.status, 'in-progress');
    redactLive(ev, DEFAULT_SPECTATE_POLICY);
    const b = exportOf([ev]);
    const file = b.event(ev);
    const s2 = file.games[1]!.sideboarding!['s-1']!;
    assert.deepEqual(s2, { by: 'agent', kept: false, in: [], out: [], main_count: 40, latency_ms: 1200, withheld: true });
    assert.equal(file.games[1]!.sideboarding!['o-1']!.kept, true);
    assert.ok(ev.sideboards!.every((x) => x.main.length === 0 && x.sideboard.length === 0 && Object.keys(x.basics).length === 0), 'nothing private left in memory');
    assert.equal(file.withheld?.sideboards, 4);
    assert.deepEqual(file.games[2]!.play_draw, { on_play: 's-1', chooser: 'o-1', choice: 'draw', by: 'agent' }, 'who chose and what: public');
    assert.ok(!JSON.stringify(file).includes('wants tempo'), 'no note from an older log');
    assert.deepEqual(file.games[1]!.deck_sizes, { 'o-1': 40, 's-1': 40 });
    const gf = b.game(ev, ev.games[1]!);
    assert.ok(!JSON.stringify(gf).includes('Beta Card 24') && !JSON.stringify(file).includes('More removal'), 'no withheld card or note anywhere in the files');
    // 2.23: a withheld decision carries no replay board (it is read from the blanked view): live, game 3's is withheld.
    const g3 = b.game(ev, ev.games[2]!);
    assert.ok(g3.timeline.length > 0 && g3.timeline.every((e) => e.withheld && e.state === undefined), 'no board on a withheld decision');
    assert.ok(!JSON.stringify(g3).includes('Beta Card 24'), 'the hidden hand card is nowhere in the live game file');
  });

  check('live: once the match is over the seat\'s sideboarding is released (it has no games left)', () => {
    const ls = lines({ finished: false });
    ls.push({ t: T0 + 50, type: 'game_over', game: G(3), winner: 'o-1', turns: 10, on_play: 's-1' }, { t: T0 + 51, type: 'match_end', a: 'o-1', b: 's-1', wins: { 'o-1': 2, 's-1': 1 } });
    const ev = load('sb-live2', ls, T0 + 60_000);
    assert.equal(ev.status, 'in-progress');
    redactLive(ev, DEFAULT_SPECTATE_POLICY);
    const file = exportOf([ev]).event(ev);
    assert.deepEqual(file.games[1]!.sideboarding!['s-1']!.in, [{ name: 'Beta Card 24', qty: 1 }]);
    assert.equal(file.withheld?.sideboards, 0);
  });

  check('older logs: no play/draw or sideboarding keys', () => {
    const old = lines({ start: { sideboarding: undefined, play_draw: undefined } }).filter((l) => !['play_draw', 'sideboarded'].includes((l as { type: string }).type));
    const ev = load('sb-old', old);
    const file = exportOf([ev]).event(ev);
    assert.ok(file.games.every((g) => g.play_draw === undefined && g.sideboarding === undefined));
    assert.equal(file.event.play_draw, null);
  });
  check('play/draw: only game 1 (random) carries onPlay for the play term and the play/draw split; games 2–3 are chosen', () => {
    const ev = load('sb-playdraw', lines());
    const games = ratingGamesOf([ev], new Identities([ev]));
    assert.deepEqual(games.map((g) => [g.onPlay ?? null, g.onPlayChosen ?? null]), [['a', null], [null, 'a'], [null, 'a']], 'games 2–3 list s-1 first (on the play by its choice)');
  });
} finally {
  rmSync(root, { recursive: true, force: true });
}

if (failed) {
  console.log(`\n${failed} sideboarding test(s) failed`);
  process.exit(1);
}
console.log('\nsideboarding: all passed');
