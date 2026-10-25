/**
 * Seat classification from metadata, never the seat name (METHODOLOGY §3): a table of scripted players with neutral
 * hosted seat names (`seat-<hex>`) contributes nothing to any LLM total, set report, activity item or board. The
 * regression fixture is the real 8-seat `script/random` table 2026-10-22-22-34-06-fra-905e (trimmed to the records the
 * export reads), which the name rule counted as eight LLM agents.
 *   npx tsx packages/site/src/scripted-seats.test.ts
 */
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CardDb, isLlmSeat, loadEvent, type EventData } from './data.js';
import { makeContext, repoRoot } from './context.js';
import { builder } from './export.js';
import { isLlmEvent, totals } from './metrics.js';
import { eventRatingStatus, groupKey, Identities } from './scoring.js';

const FIXTURE = join(repoRoot, 'packages', 'site', 'test', 'fixtures', 'scripted-table-905e', 'events.jsonl.gz');
const ID = '2026-10-22-22-34-06-fra-905e';
const root = mkdtempSync(join(tmpdir(), 'mtgdt-scripted-'));
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

function loadFixture(): EventData {
  const dir = join(root, ID);
  mkdirSync(dir, { recursive: true });
  copyFileSync(FIXTURE, join(dir, 'events.jsonl.gz'));
  const ev = loadEvent(dir, Date.parse('2026-10-23T00:00:00Z'));
  assert.ok(ev, 'the fixture loads');
  return ev!;
}

try {
  check('isLlmSeat: harness and model metadata decide; the seat name only when a log has none', () => {
    const seat = (o: Record<string, unknown>) => ({ name: 'seat-77ce0c', kind: 'agent', ...o });
    assert.equal(isLlmSeat(seat({ harness: 'script', model: 'random', effort: 'default' })), false, 'the registry test harness');
    assert.equal(isLlmSeat(seat({ harness: 'scripted', model: 'random' })), false, 'a test-harness alias');
    assert.equal(isLlmSeat(seat({ harness: 'random-agent' })), false, 'a test-harness alias, no model');
    assert.equal(isLlmSeat(seat({ harness: 'my-runner', model: 'random' })), false, 'an unlisted harness with the scripted model');
    assert.equal(isLlmSeat(seat({ harness: 'claude-code', model: 'unlisted:random' })), false, 'an unlisted random model');
    assert.equal(isLlmSeat(seat({ harness: 'claude-code', model: 'claude-haiku-5-5' })), true);
    assert.equal(isLlmSeat(seat({ harness: 'codex', model: 'some-new-model' })), true, 'an unlisted model is still a model (Unlisted, unrated)');
    assert.equal(isLlmSeat({ name: 'rand-1', kind: 'agent', harness: 'claude-code', model: 'claude-sonnet-5-5' }), true, 'metadata beats a scripted-looking name');
    assert.equal(isLlmSeat({ name: 'seat-ab12cd', kind: 'bot' }), false, 'bots never');
    // The earliest logs (2026-10-21) recorded no metadata: the name convention is all there is.
    assert.equal(isLlmSeat({ name: 'rand-1', kind: 'agent' }), false);
    assert.equal(isLlmSeat({ name: 'haiku-2', kind: 'agent' }), true);
  });

  check(`the real scripted table ${ID}: no LLM seat, not an LLM event, a Test Run, no group, no rated games`, () => {
    const ev = loadFixture();
    assert.equal(ev.seats.length, 8);
    assert.ok(ev.seats.every((s) => /^seat-[0-9a-f]{6}$/.test(s.name)), 'neutral hosted seat names');
    assert.deepEqual(ev.seats.map((s) => s.llm), Array(8).fill(false));
    assert.equal(isLlmEvent(ev), false);
    assert.equal(ev.source.label, 'smoke', 'labeled a Test Run whatever source.json says');
    assert.equal(ev.status, 'complete');
    assert.equal(groupKey(ev), null, 'in no comparability group, so it can never pick or join the main board');
    assert.equal(eventRatingStatus(ev, new Identities([ev])).rated_games, 0);
  });

  check('it adds nothing to the headline totals, set reports, activity, boards or the latest event', () => {
    const ev = loadFixture();
    const t = totals([ev]);
    assert.deepEqual(t, { llmEvents: 0, liveEvents: 0, llmGames: 0, decisions: 0, agentPicks: 0 });
    const b = builder(makeContext({ events: [ev], cards: new CardDb(undefined), setsDir: join(repoRoot, 'sets'), replicates: 0, now: Date.parse('2026-10-23T00:00:00Z') }), null, join(root, 'none.json'));
    const idx = b.index();
    assert.deepEqual(
      [idx.totals.llm_events, idx.totals.llm_events_finished, idx.totals.llm_games, idx.totals.decisions, idx.totals.agent_picks], [0, 0, 0, 0, 0],
    );
    const e = idx.events.find((x) => x.id === ID)!;
    assert.deepEqual([e.llm, e.llm_agents, e.scripted_seats, e.provenance, e.provenance_display], [false, 0, 8, 'test', 'Test Run']);
    assert.ok(e.agents.every((a) => a.llm === false));
    assert.equal(idx.boards.length, 0, 'no board');
    assert.equal(idx.groups.length, 0, 'no group');
    const fra = idx.sets.find((s) => s.code === 'FRA')!;
    assert.deepEqual([fra.llm_events, fra.llm_events_finished, fra.top_archetypes?.length ?? 0], [0, 0, 0], 'no set insight from scripted decks');
    const s = b.summaryOf(idx);
    assert.equal(s.main, null, 'no main board');
    assert.equal(s.totals.llm_events, 0);
    assert.ok(!s.recent_events.some((x) => x.id === ID && x.llm), 'never the latest LLM event');
    assert.ok(!(s.activity ?? []).some((a) => a.event_id === ID), 'no What’s New item');
    const set = b.set('FRA');
    assert.equal(set.totals.llm_events, 0);
    assert.equal(set.totals.agent_decks, 0);
    assert.equal(set.archetypes?.length ?? 0, 0);
    assert.equal((set.highlights ?? []).length, 0, 'no highlight from scripted play');
  });
} finally {
  rmSync(root, { recursive: true, force: true });
}

if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nall scripted-seat checks passed');
