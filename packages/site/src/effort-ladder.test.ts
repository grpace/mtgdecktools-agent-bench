/**
 * The Effort Ladder, the Harness Comparison and the mirror check (SITE-DATA 2.15): a model's versions by effort and by
 * harness on its page board, the fit's differences between versions of one model, and mirror games as a fairness
 * monitor that never touches a rating.
 *   npx tsx packages/site/src/effort-ladder.test.ts
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CardDb, loadEvent, type EventData } from './data.js';
import { makeContext } from './context.js';
import { builder } from './export.js';
import { SCHEMA_MINOR, type VersionStep } from './schema.js';
import { judge, stepText } from './ladder.js';
import { holm, pFromInterval } from './multiplicity.js';
import { boardSummary, provisionalRule } from './summary.js';
import { PROMPTS_DIR, promptsHash, promptVersionOf } from '../../director/src/prompts.js';

/** The current prompts (the main board is the current prompts' group), so a prompt change doesn't break the fixtures. */
const CURRENT = { prompt_version: promptVersionOf(PROMPTS_DIR), prompt_sha256: promptsHash(PROMPTS_DIR) };

const T0 = Date.parse('2026-10-22T12:00:00Z');
const root = mkdtempSync(join(tmpdir(), 'mtgdt-ladder-'));
let failed = 0;
const check = (name: string, f: () => void) => {
  try {
    f();
    console.log(`ok   ${name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL ${name}\n     ${(err as Error).stack ?? (err as Error).message}`);
  }
};

interface Seat { name: string; harness: string; model: string; effort: string; contributor_id?: number; context_policy?: string }

/** A finished table: games [winner, loser] (one game per pairing), with seats' metadata. */
function table(id: string, seats: Seat[], games: Array<[string, string]>, t = T0): EventData {
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  const lines: unknown[] = [{
    t, type: 'event_start', id, set: { code: 'FRA', name: 'Test' }, best_of: 3, sideboarding: true, mana: 'manual', ...CURRENT, knowledge: { level: 'primer' },
    seats: seats.map((s, i) => ({ ...s, kind: 'agent', position: i })),
  }];
  games.forEach(([w, l], i) => {
    lines.push({ t: t + 1000 + i * 10, type: 'game_start', game: `g${i}`, seats: [w, l] });
    lines.push({ t: t + 1001 + i * 10, type: 'game_over', game: `g${i}`, winner: w, turns: 9, on_play: i % 3 === 0 ? l : w });
  });
  lines.push({ t: t + 9000, type: 'event_end' });
  writeFileSync(join(dir, 'events.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const ev = loadEvent(dir, t + 100_000);
  assert.ok(ev, `${id} loads`);
  return ev!;
}

const CC = 'claude-code';
const T3 = 't3-code:claude-code';
const HAIKU = 'claude-haiku-5-5';
const SONNET = 'claude-sonnet-5-5';
const exportOf = (evs: EventData[], replicates = 0) => builder(makeContext({ events: evs, cards: new CardDb(undefined), setsDir: root, replicates, now: T0 + 1e7 }), null, join(root, 'none.json'));

/** Tables where Haiku low, Haiku high and Sonnet high meet; high beats low most of the time. */
function ladderTables(n: number, extra: Seat[] = []): EventData[] {
  const evs: EventData[] = [];
  for (let k = 0; k < n; k++) {
    const seats: Seat[] = [
      { name: 'lo', harness: CC, model: HAIKU, effort: 'low', contributor_id: 1 + (k % 3) },
      { name: 'hi', harness: CC, model: HAIKU, effort: 'high', contributor_id: 2 + (k % 3) },
      { name: 'so', harness: CC, model: SONNET, effort: 'high', contributor_id: 3 + (k % 3) },
      ...extra,
    ];
    const games: Array<[string, string]> = [['hi', 'lo'], ['hi', 'lo'], [k % 4 ? 'hi' : 'lo', k % 4 ? 'lo' : 'hi'], ['so', 'lo'], [k % 2 ? 'hi' : 'so', k % 2 ? 'so' : 'hi']];
    if (extra.length) games.push([k % 2 ? 'tt' : 'hi', k % 2 ? 'hi' : 'tt'], ['tt', 'lo'], ['so', 'tt']);
    evs.push(table(`lad-${extra.length}-${k}`, seats, games, T0 + k * 20_000));
  }
  return evs;
}

try {
  check('schema minor is 24 (2.24: choices only; 2.23: visual replay boards; 2.22: test tables)', () => assert.equal(SCHEMA_MINOR, 24));

  check('multiplicity: p from an interval, Holm step-down', () => {
    assert.ok(Math.abs(pFromInterval(50, [10.8, 89.2])! - 0.0124) < 0.002, 'an interval 50 ± 39.2 is z = 2.5');
    assert.ok(pFromInterval(10, [-50, 70])! > 0.5);
    assert.equal(pFromInterval(10, null), null);
    assert.deepEqual(holm([0.01, 0.04, 0.03, null]).map((p) => (p == null ? null : Math.round(p * 1000) / 1000)), [0.03, 0.06, 0.06, null]);
  });

  check('"ranks first" only for a firm row, and on a set board only when it holds after the Holm correction', () => {
    const row = (label: string, rating: number, rr: [number, number], provisional = false) => ({ label, rating, ci: [rating - 60, rating + 60] as [number, number], games: 40, provisional, rankRange: rr, group: 0 });
    const base = { asOf: Date.parse('2026-10-23T00:00:00Z'), conditions: 'Set Context', set: null, events: 4, games: 80, minGames: 30 };
    const rows = [row('A', 1600, [1, 1]), row('B', 1480, [2, 3]), row('C', 1420, [2, 3])];
    assert.match(boardSummary({ ...base, rows }), /A ranks first:/);
    assert.match(boardSummary({ ...base, rows: [row('A', 1600, [1, 1], true), ...rows.slice(1)] }), /its rating is provisional, so it doesn’t rank first yet/);
    assert.match(boardSummary({ ...base, set: 'Reality Fracture', rows, exploratory: true, topHolds: false }), /not after correcting for the two comparisons; this is one of many set and table boards, so read it as exploratory/);
    assert.match(boardSummary({ ...base, set: 'Reality Fracture', rows, exploratory: true, topHolds: true }), /A ranks first: .*exploratory, but it holds after correcting/);
    const rule = provisionalRule({ minGames: 30, minEvents: 3, minOpponents: 2, minContributors: 2, maxContributorShare: 0.5 });
    assert.equal(rule, 'A rating is provisional until it has 30 rated games, 3 events and 2 different opponents, with games from at least 2 contributors and none supplying more than half of them. The contributor part is usually the one still missing.');
  });

  check('ladder verdicts: Holm within the ladder, never firm while a row is provisional, never "helped" or "a clear gain"', () => {
    const st = (o: Partial<VersionStep>): VersionStep => ({
      from: 'lo', to: 'hi', rating_change: 54, ci: [6, 104], credible: 'up', cost_change_per_game_usd: null, p_value: pFromInterval(54, [6, 104]), p_holm: null, comparisons: 0, provisional: false, verdict: 'open', ...o,
    });
    // One step, firm rows, interval excludes 0 (p ≈ 0.03): rated higher.
    const [one] = judge([st({})]);
    assert.equal(one!.verdict, 'higher');
    // The same step among three, the others null-ish: Holm triples it, so not after the correction.
    const three = judge([st({}), st({ rating_change: 5, ci: [-60, 70], credible: null, p_value: pFromInterval(5, [-60, 70]) }), st({ rating_change: -3, ci: [-70, 64], credible: null, p_value: pFromInterval(-3, [-70, 64]) })]);
    assert.deepEqual(three.map((s) => s.verdict), ['unadjusted', 'open', 'open']);
    assert.equal(three[0]!.comparisons, 3);
    // A provisional row: never firm, however strong.
    assert.equal(judge([st({ provisional: true, rating_change: 200, ci: [120, 280], p_value: pFromInterval(200, [120, 280]) })])[0]!.verdict, 'provisional');
    const name = (id: string) => (id === 'hi' ? 'High' : 'Medium');
    const open = 'too early to say';
    assert.equal(stepText(one!, name, open), 'High is rated 54 Elo above Medium (95% range +6 to +104): rated higher in these games, and the difference holds after correcting for this comparison.');
    assert.equal(stepText(three[0]!, name, open), 'High is rated 54 Elo above Medium (95% range +6 to +104): higher on its own range, but not after correcting for the 3 comparisons here, so it\u2019s too early to call.'.replace('\u2019', "'"));
    assert.match(stepText(judge([st({ provisional: true })])[0]!, name, open), /looks higher in these games, but a rating here is provisional, so it's too early to call\.$/);
    for (const s of [one!, ...three]) assert.doesNotMatch(stepText(s, name, open), /helped|clear gain|credibly/);
  });

  check('an Effort Ladder: rungs in effort order, steps from lower to higher, head to head and cost fields', () => {
    const b = exportOf(ladderTables(6), 60);
    const files = new Map(b.models());
    const haiku = files.get(HAIKU)!;
    assert.ok(haiku.effort_ladder, 'Haiku has a ladder');
    assert.equal(haiku.effort_ladder!.length, 1);
    const l = haiku.effort_ladder![0]!;
    assert.equal(l.harness, undefined, 'one ladder per model, across harnesses');
    assert.deepEqual(l.rungs.map((r) => r.effort), ['low', 'high']);
    assert.equal(l.steps.length, 1);
    const s = l.steps[0]!;
    assert.equal(s.from, `${HAIKU}/low`);
    assert.equal(s.to, `${HAIKU}/high`);
    assert.ok(s.rating_change! > 0, 'high wins more, so it is rated higher');
    if (s.ci) assert.ok(s.ci[0] <= s.rating_change! && s.rating_change! <= s.ci[1], 'the interval is oriented to − from');
    const lo = l.rungs[0]!;
    const hi = l.rungs[1]!;
    assert.ok(Math.abs((hi.rating! - lo.rating!) - s.rating_change!) < 0.2, 'the step equals the rating gap');
    assert.equal(l.head_to_head.length, 1, 'one pair of versions met');
    assert.equal(l.head_to_head[0]!.games, 18);
    assert.ok(l.head_to_head[0]!.difference, 'with its difference');
    for (const r of l.rungs) for (const k of ['expected_score', 'game_win_rate', 'cost_per_game_usd', 'cost_basis', 'provisional_reasons'] as const) assert.ok(k in r, `rung has ${k}`);
    assert.match(l.summary, /^Claude Haiku 5\.5 is rated at 2 effort levels \(Low and High\)\./);
    assert.match(l.summary, /High is rated \d+ Elo above Low/);
    assert.equal(l.unknown_effort_rows, 0);
    const row = b.index().models!.find((m) => m.model_id === HAIKU)!;
    assert.equal(row.effort_levels, 2);
    assert.equal(row.harness_variants, 1);
  });

  check('one effort level: no ladder; Sonnet has none', () => {
    const files = new Map(exportOf(ladderTables(3)).models());
    assert.equal(files.get(SONNET)!.effort_ladder, undefined);
    assert.equal(files.get(SONNET)!.harness_comparison, undefined);
  });

  check('a launcher is no Harness Comparison: Claude Code seats started in T3 Code join the Claude Code row', () => {
    const evs = ladderTables(4, [{ name: 'tt', harness: T3, model: HAIKU, effort: 'high', contributor_id: 9 }]);
    const b = exportOf(evs);
    const haiku = new Map(b.models()).get(HAIKU)!;
    assert.ok(!haiku.harness_comparison?.length, 'one harness: nothing to compare');
    assert.equal(b.index().models!.find((m) => m.model_id === HAIKU)!.harness_variants, 1);
    const seat = b.event(evs[0]!).config.seats.find((x) => x.name === 'tt')!;
    assert.deepEqual([seat.identity, seat.harness_display, seat.launcher, seat.launcher_display], [`${HAIKU}/high`, 'Claude Code', 't3-code', 'T3 Code']);
    assert.equal(b.event(evs[0]!).config.seats.find((x) => x.name === 'hi')!.launcher, undefined);
  });

  check('a second harness joins the same row; the harness split shows results by harness, never rated', () => {
    const evs = ladderTables(4, [{ name: 'tt', harness: 'cursor', model: HAIKU, effort: 'high', contributor_id: 9 }]);
    const b = exportOf(evs);
    const haiku = new Map(b.models()).get(HAIKU)!;
    assert.equal(haiku.harness_comparison, undefined);
    assert.equal(haiku.effort_ladder!.length, 1, 'one ladder, across harnesses');
    const split = haiku.harness_split!;
    assert.equal(split.length, 1, 'only High ran on two harnesses');
    assert.equal(split[0]!.identity, `${HAIKU}/high`);
    assert.deepEqual(split[0]!.rows.map((r) => r.harness).sort(), [CC, 'cursor'].sort());
    const cu = split[0]!.rows.find((r) => r.harness === 'cursor')!;
    assert.equal(cu.seats, 4);
    assert.equal(cu.games, 8, "tt's games against Low and Sonnet (not against hi, the same setup)");
    assert.match(split[0]!.text, /isn't rated/);
    assert.equal(b.index().models!.find((m) => m.model_id === HAIKU)!.harness_variants, 2);
    const seat = b.event(evs[0]!).config.seats.find((x) => x.name === 'tt')!;
    assert.deepEqual([seat.identity, seat.harness_id, seat.harness_display], [`${HAIKU}/high`, 'cursor', 'Cursor CLI']);
  });

  check('version_differences: only pairs of one model', () => {
    const idx = exportOf(ladderTables(4)).index();
    const board = idx.boards.find((x) => x.id === idx.main_board)!;
    assert.ok(board.version_differences?.length);
    for (const d of board.version_differences!) assert.equal(d.a.split('/')[0], d.b.split('/')[0], `${d.a} vs ${d.b}`);
    assert.deepEqual(board.version_differences!.map((d) => [d.a, d.b]), [[`${HAIKU}/high`, `${HAIKU}/low`]]);
  });

  check('mirror check: counts mirror games and on the play, flags a lopsided contributor, never rates them', () => {
    // 25 mirror games of Haiku low between two contributors: contributor 1 wins 22.
    const evs: EventData[] = [];
    for (let k = 0; k < 5; k++) {
      const seats: Seat[] = [
        { name: 'a', harness: CC, model: HAIKU, effort: 'low', contributor_id: 1, context_policy: 'fresh-per-game' },
        { name: 'b', harness: CC, model: HAIKU, effort: 'low', contributor_id: 2, context_policy: 'fresh-per-game' },
        { name: 's', harness: CC, model: SONNET, effort: 'high', contributor_id: 3 },
      ];
      const games: Array<[string, string]> = [];
      for (let i = 0; i < 5; i++) games.push(k * 5 + i < 22 ? ['a', 'b'] : ['b', 'a']);
      games.push(['s', 'a']);
      evs.push(table(`mir-${k}`, seats, games, T0 + k * 20_000));
    }
    const b = exportOf(evs);
    const idx = b.index();
    const m = idx.mirror_check!;
    // 2.16: summary.json carries the same check, so the Methodology box never needs index.json.
    const summary = b.summaryOf(idx);
    assert.deepEqual(summary.mirror_check, m);
    assert.deepEqual(summary.methodology.mirror_games, { rated: false, check_min_games: 20 });
    assert.equal(m.games, 25);
    assert.equal(m.events, 5);
    assert.equal(m.identities, 1);
    assert.equal(m.on_play.games, 25);
    assert.equal(m.min_games, 20);
    const c1 = m.checks.filter((c) => c.kind === 'contributor');
    assert.equal(c1.length, 2);
    assert.equal(c1[0]!.wins + c1[1]!.wins, 25);
    assert.ok(c1.every((c) => c.deviates), '22–3 deviates from 50% (both sides of it)');
    assert.equal(m.deviations, 2);
    assert.match(m.summary, /^2 mirror checks deviate from 50%/);
    assert.equal(m.checks.filter((c) => c.kind === 'context_policy').length, 0, 'same policy on both sides: no policy check');
    assert.deepEqual(idx.methodology.mirror_games, { rated: false, check_min_games: 20 });
    const lowRow = idx.boards.find((x) => x.id === idx.main_board)!.rows.find((r) => r.identity === `${HAIKU}/low`)!;
    assert.equal(lowRow.games, 5, 'only the games against Sonnet are rated');
  });

  check('mirror check: too few games never deviate; a context-policy split is checked', () => {
    const seats: Seat[] = [
      { name: 'a', harness: CC, model: HAIKU, effort: 'low', contributor_id: 1, context_policy: 'fresh-per-game' },
      { name: 'b', harness: CC, model: HAIKU, effort: 'low', contributor_id: 1 },
    ];
    const m = exportOf([table('few-1', seats, [['a', 'b'], ['a', 'b'], ['a', 'b'], ['a', 'b'], ['a', 'b']])]).index().mirror_check!;
    assert.equal(m.games, 5);
    assert.equal(m.checks.filter((c) => c.kind === 'contributor').length, 0, 'one contributor on both sides');
    const p = m.checks.filter((c) => c.kind === 'context_policy');
    assert.deepEqual(p.map((c) => [c.value, c.wins, c.games]).sort(), [['fresh-per-game', 5, 5], ['harness', 0, 5]]);
    assert.ok(p.every((c) => !c.deviates), '5–0 is below the 20-game floor');
    assert.equal(m.deviations, 0);
    assert.match(m.summary, /^No deviations/);
  });

  check('no mirror games: an empty check with its sentence', () => {
    const m = exportOf(ladderTables(1)).index().mirror_check!;
    assert.equal(m.games, 0);
    assert.equal(m.on_play.rate, null);
    assert.match(m.summary, /^No mirror games yet/);
  });
} finally {
  rmSync(root, { recursive: true, force: true });
}

if (failed) {
  console.log(`\n${failed} effort-ladder test(s) failed`);
  process.exit(1);
}
console.log('\neffort-ladder: all passed');
