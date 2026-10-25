/**
 * Set findings only from all-agent tables (export 2.18, set-findings.ts): a pod of agents with scripted drafters is
 * watchable and feeds no set finding, and re-runs of one draft count once. The tables are built from the real 8-seat
 * scripted fixture (scripted-seats.test.ts) with seats turned into agents: two (a mixed pod) or all eight.
 *   npx tsx packages/site/src/set-findings.test.ts
 */
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CardDb, loadEvent, type EventData } from './data.js';
import { makeContext, repoRoot } from './context.js';
import { builder } from './export.js';
import { feedsSetFindings, isTestSet, PICK_GAP_RULE, podKey } from './set-findings.js';

const FIXTURE = join(repoRoot, 'packages', 'site', 'test', 'fixtures', 'scripted-table-905e', 'events.jsonl.gz');
const ID = '2026-10-22-22-34-06-fra-905e';
const NOW = Date.parse('2026-10-23T00:00:00Z');
const root = mkdtempSync(join(tmpdir(), 'mtgdt-findings-'));
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

let base: EventData | null = null;
function fixture(): EventData {
  if (!base) {
    const dir = join(root, ID);
    mkdirSync(dir, { recursive: true });
    copyFileSync(FIXTURE, join(dir, 'events.jsonl.gz'));
    base = loadEvent(dir, NOW)!;
    assert.ok(base, 'the fixture loads');
  }
  return base;
}

/** A copy of the fixture table with `agents` of its 8 seats played by a language model, under its own id and seed. */
function table(n: number, agents: number, seed: string, o: Partial<EventData> = {}): EventData {
  const ev = structuredClone(fixture());
  ev.id = `2026-10-22-22-34-06-fra-t${n}`;
  ev.seed = seed;
  ev.startT += n;
  ev.source = { ...ev.source, label: 'verified', inferred: false };
  ev.seats.forEach((s, i) => {
    if (i >= agents) return;
    s.llm = true;
    s.harness = 'claude-code';
    s.model = 'claude-haiku-5-5';
    s.modelId = 'claude-haiku-5-5';
    s.effort = 'low';
  });
  return Object.assign(ev, o);
}

function exportOf(events: EventData[]) {
  const ctx = makeContext({ events, cards: new CardDb(undefined), setsDir: join(repoRoot, 'sets'), replicates: 0, now: NOW });
  const b = builder(ctx, null, join(root, 'none.json'));
  const idx = b.index();
  return { idx, fra: idx.sets.find((s) => s.code === 'FRA')!, set: b.set('FRA') };
}

const noFinding = (x: ReturnType<typeof exportOf>) => {
  assert.equal(x.fra.top_archetypes?.length ?? 0, 0, 'no top archetypes');
  assert.equal(x.fra.insight?.ready, false, 'not ready');
  assert.equal(x.fra.insight?.decks, 0, 'no decks counted');
  assert.equal(x.set.archetypes?.length ?? 0, 0, 'no archetypes');
  assert.equal(x.set.deck_shape ?? null, null, 'no deck shape');
  assert.equal(x.set.commitment_median ?? null, null, 'no commitment median');
  assert.equal(x.set.first_picks?.length ?? 0, 0, 'no first picks');
  assert.equal(x.set.pick_gaps?.length ?? 0, 0, 'no pick gaps');
  assert.ok(x.set.cards.every((c) => c.agent_picks === 0 && c.in_decks === 0 && c.agent_avg_pick == null), 'no card pick or deck counted');
  assert.equal(x.set.totals.agent_picks, 0);
  assert.equal(x.set.totals.agent_decks, 0);
};

try {
  check('feedsSetFindings: finished, all 8 seats agents; a mixed pod, a stopped table or a short table never', () => {
    assert.equal(feedsSetFindings(table(1, 8, 's1')), true);
    assert.equal(feedsSetFindings(table(2, 2, 's2')), false, '2 agents and 6 scripted seats');
    assert.equal(feedsSetFindings(table(3, 7, 's3')), false, '7 agents and one scripted seat');
    assert.equal(feedsSetFindings(table(4, 8, 's4', { status: 'stopped' })), false, 'stopped');
    const short = table(5, 8, 's5');
    short.seats = short.seats.slice(0, 6);
    assert.equal(feedsSetFindings(short), false, 'six seats');
  });

  check('podKey: a re-run of one seed is one pod; without a seed, the packs decide', () => {
    assert.equal(podKey(table(1, 8, 'abl-fra-1')), podKey(table(2, 8, 'abl-fra-1')));
    assert.notEqual(podKey(table(1, 8, 'a')), podKey(table(2, 8, 'b')));
    const x = table(3, 8, '');
    const y = table(4, 8, '');
    x.seed = undefined;
    y.seed = undefined;
    assert.equal(podKey(x), podKey(y), 'same packs');
  });

  check('a mixed pod (2 agents, 6 scripted drafters) contributes nothing to set findings', () => {
    const x = exportOf([table(1, 2, 'm1')]);
    noFinding(x);
    assert.equal(x.fra.insight?.excluded_events, 1, 'counted as left out');
    const e = x.idx.events.find((v) => v.id.endsWith('-t1'))!;
    assert.equal(e.llm, true, 'still an agent table');
    assert.equal(e.in_set_findings, false);
    assert.equal(x.set.events.length, 1, 'still listed (watchable)');
  });

  check('a set with only mixed pods publishes no finding, however many there are', () => {
    const x = exportOf([table(1, 2, 'm1'), table(2, 2, 'm2'), table(3, 3, 'm3'), table(4, 2, 'm4')]);
    noFinding(x);
    assert.equal(x.fra.insight?.excluded_events, 4);
    assert.equal(x.fra.llm_events_finished, 4, 'the tables still exist');
  });

  check('mixed pods next to all-agent tables: only the all-agent decks count', () => {
    const x = exportOf([table(1, 8, 'a1'), table(2, 2, 'm2')]);
    assert.equal(x.fra.insight?.decks, 8);
    assert.equal(x.fra.insight?.events, 1);
    assert.equal(x.fra.insight?.excluded_events, 1);
    assert.equal(x.set.totals.agent_decks, 8);
    if (x.set.deck_shape) assert.equal(x.set.deck_shape.decks, 8, 'deck shape (needs card data)');
    assert.equal((x.set.archetypes ?? []).reduce((n, a) => n + a.decks, 0), 8);
  });

  check('re-runs of one seed count as one draft: no finding from four replays', () => {
    const x = exportOf([1, 2, 3, 4].map((n) => table(n, 8, 'abl-fra-1')));
    assert.equal(x.fra.insight?.events, 4);
    assert.equal(x.fra.insight?.pods, 1);
    assert.equal(x.fra.insight?.ready, false, '32 decks, one draft');
    assert.match(x.fra.insight!.n_text, /from 4 all-agent tables, 1 different draft \(findings need 8 decks from 3 different drafts\)/);
    assert.equal(x.fra.top_archetypes?.length ?? 0, 0);
    assert.ok(x.set.cards.every((c) => (c.agent_pods ?? 0) <= 1), 'every card in one pod');
    assert.equal(x.set.pick_gaps?.length ?? 0, 0, 'no gap from one draft');
  });

  check('three different all-agent drafts: a finding, with the Early Test Data count', () => {
    const x = exportOf([table(1, 8, 'a1'), table(2, 8, 'a2', { bestOf: 1 }), table(3, 8, 'a3')]);
    assert.equal(x.fra.insight?.pods, 3);
    assert.equal(x.fra.insight?.ready, true);
    assert.equal(x.fra.insight?.early_test_events, 1, 'the best-of-1 table is Early Test Data');
    assert.ok((x.fra.top_archetypes?.length ?? 0) > 0);
    assert.ok(x.idx.events.every((e) => e.in_set_findings === true));
    for (const g of x.set.pick_gaps ?? []) {
      assert.ok(g.picks >= PICK_GAP_RULE.min_picks && g.pods >= PICK_GAP_RULE.min_pods && Math.abs(g.gap) >= PICK_GAP_RULE.min_gap, `${g.name} meets the rule`);
      assert.ok(g.agent_pick <= PICK_GAP_RULE.max_pick, 'real-choice picks only');
      assert.equal(g.direction, g.gap > 0 ? 'earlier' : 'later');
    }
    assert.deepEqual(x.set.pick_gap_rule, { ...PICK_GAP_RULE });
  });

  check('isTestSet: only a placeholder release date far ahead', () => {
    assert.equal(isTestSet('2099-01-01', NOW), true);
    assert.equal(isTestSet('2026-08-14', NOW), false);
    assert.equal(isTestSet('2027-02-01', NOW), false, 'an announced set a few months out');
    assert.equal(isTestSet(undefined, NOW), false, 'older logs without a date');
  });
} finally {
  rmSync(root, { recursive: true, force: true });
}

if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nall set-findings checks passed');
