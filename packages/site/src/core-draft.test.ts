/**
 * Tests for the core draft metrics (src/core-draft.ts, METHODOLOGY §5.1): color flow and its alignment,
 * on-color rate, pair changes, deck roles, and the draft context / diagnostics built from them, all without
 * any human (17Lands) data.
 *
 *   npx tsx packages/site/src/core-draft.test.ts
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { colorFlow, deckRoles, flowAlignment, onColorPicks, pairChanges, pairNormOf, qualityOf, roleBands } from './core-draft.js';
import { readDeckNorms } from './build-quality.js';
import { repoRoot } from './context.js';
import { CardDb, type Deck, type EventData, type Pick } from './data.js';
import { choseIt, draftContext, stageScores } from './scoring.js';

let failures = 0;
let passes = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) passes++;
  else failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}
const near = (a: number | null | undefined, b: number, eps = 1e-9) => a != null && Math.abs(a - b) < eps;

// Synthetic card data: per color a removal spell, a good flyer, a vanilla two-drop, a filler defender; some lands.
const dir = mkdtempSync(join(tmpdir(), 'core-draft-test-'));
const specs: Array<{ name: string; cost: string; typeLine: string; pt?: string; oracle: string }> = [];
for (const c of 'WUBRG') {
  specs.push({ name: `${c} Removal`, cost: `{1}{${c}}`, typeLine: 'Instant', oracle: 'Destroy target creature.' });
  specs.push({ name: `${c} Flyer`, cost: `{2}{${c}}`, typeLine: 'Creature — Bird', pt: '2/2', oracle: 'Flying' });
  specs.push({ name: `${c} Bear`, cost: `{1}{${c}}`, typeLine: 'Creature — Bear', pt: '2/2', oracle: '' });
  specs.push({ name: `${c} Wall`, cost: `{${c}}`, typeLine: 'Creature — Wall', pt: '0/3', oracle: 'Defender' });
  specs.push({ name: `${c} Giant`, cost: `{4}{${c}}`, typeLine: 'Creature — Giant', pt: '5/5', oracle: '' });
}
specs.push({ name: 'WU Charm', cost: '{W}{U}', typeLine: 'Instant', oracle: 'Destroy target tapped creature.' });
specs.push({ name: 'Clockwork', cost: '{3}', typeLine: 'Artifact Creature — Construct', pt: '2/2', oracle: '' });
specs.push({ name: 'Hybrid Spirit', cost: '{1}{W/U}', typeLine: 'Creature — Spirit', pt: '2/2', oracle: '' });
specs.push({ name: 'Tundra Gate', cost: '', typeLine: 'Land', oracle: '{T}: Add {W} or {U}.' });
for (const [b, c] of [['Plains', 'W'], ['Island', 'U'], ['Swamp', 'B'], ['Mountain', 'R'], ['Forest', 'G']]) {
  specs.push({ name: b!, cost: '', typeLine: `Basic Land — ${b}`, oracle: `({T}: Add {${c}}.)` });
}
const cardsPath = join(dir, 'cards.json');
writeFileSync(cardsPath, JSON.stringify(specs));
const cards = new CardDb(cardsPath);

const pick = (seat: string, pack: number, n: number, chosen: string, contents: string[], by = 'agent'): Pick => ({
  seat, packNumber: pack, pickNumber: n, overallPick: (pack - 1) * 14 + n, contents: [chosen, ...contents.filter((c) => c !== chosen)], pick: chosen, by, t: 0,
});

// ---------------------------------------------------------------------------
// Card quality from card data

check('quality: removal > flyer > bear > wall', qualityOf(cards, 'B Removal') > qualityOf(cards, 'B Flyer') && qualityOf(cards, 'B Flyer') > qualityOf(cards, 'B Bear') && qualityOf(cards, 'B Bear') > qualityOf(cards, 'B Wall'));
check('quality: basics are 0.3, unknown cards replacement level', qualityOf(cards, 'Plains') === 0.3 && qualityOf(cards, 'Nope') === 0.535);
check('quality: rarity raises the value', qualityOf(cards, 'G Bear', 'mythic') > qualityOf(cards, 'G Bear', 'common'));

// ---------------------------------------------------------------------------
// Color flow: upstream seats take white and blue, so black and red good cards keep coming.

const flowPicks: Pick[] = [];
flowPicks.push(pick('s', 1, 1, 'W Removal', ['U Removal', 'B Removal', 'R Removal', 'G Removal', 'W Flyer']));
for (let n = 2; n <= 9; n++) flowPicks.push(pick('s', 1, n, 'B Removal', ['R Removal', 'B Flyer', 'R Flyer', 'W Wall', 'U Wall', 'G Bear', 'Tundra Gate']));
for (let n = 10; n <= 14; n++) flowPicks.push(pick('s', 1, n, 'B Bear', ['R Bear'], n === 14 ? 'forced' : 'agent'));
const flow = colorFlow(flowPicks, cards);
check('flow: black and red flowed', flow?.top === 'BR', JSON.stringify(flow));
check('flow: shares sum to 1, walls and lands add nothing', flow != null && near(Object.values(flow.shares).reduce((s, x) => s + x, 0), 1) && flow.shares.W === 0 && flow.shares.U === 0, JSON.stringify(flow?.shares));
check('flow: only pack 1 picks 2–9 count', flow?.packs === 8);
check('flow alignment: BR deck = 1, BG = 0.5, WU = 0', flowAlignment(flow, 'BR') === 1 && flowAlignment(flow, 'BG') === 0.5 && flowAlignment(flow, 'WU') === 0);
check('flow alignment: null without a flow or final colors', flowAlignment(null, 'BR') === null && flowAlignment(flow, '') === null);
check('flow: null without card data', colorFlow(flowPicks, new CardDb(undefined)) === null);

// Gold cards split their weight between their colors.
const gold = colorFlow([pick('g', 1, 2, 'WU Charm', ['WU Charm'])], cards);
check('flow: a gold card splits evenly', gold != null && near(gold.shares.W!, 0.5) && near(gold.shares.U!, 0.5));

// ---------------------------------------------------------------------------
// On-color rate and pair changes

const p23: Pick[] = [
  pick('s', 2, 1, 'B Removal', ['W Removal']),
  pick('s', 2, 2, 'R Flyer', ['W Removal']),
  pick('s', 2, 3, 'W Removal', ['B Bear']), // off-color
  pick('s', 2, 4, 'Clockwork', ['B Bear']), // colorless counts as on-color
  pick('s', 2, 5, 'Hybrid Spirit', ['B Bear']), // hybrid needs no single color: on-color
  pick('s', 2, 6, 'Tundra Gate', ['B Bear']), // lands are left out
  pick('s', 3, 14, 'G Bear', ['G Bear'].slice(1), 'forced'), // forced: left out
  pick('s', 1, 3, 'G Removal', ['B Bear']), // pack 1: left out
];
const on = onColorPicks(p23, cards, 'BR', choseIt);
check('on-color: 4 of 5 counted picks', on.length === 5 && on.reduce((s, x) => s + x, 0) === 4, JSON.stringify(on));
check('on-color: nothing without final colors', onColorPicks(p23, cards, '', choseIt).length === 0);
check('pair changes: counts changes from the 6th pick', pairChanges(['', 'W', 'WU', 'WU', 'WU', 'WU', 'UB', 'UB', 'WU', 'WU']) === 2);
check('pair changes: null before 6 picks', pairChanges(['W', 'WU']) === null);

// ---------------------------------------------------------------------------
// Deck roles

const good: string[] = [
  ...Array(3).fill('B Removal'), ...Array(2).fill('R Removal'),
  ...Array(4).fill('B Flyer'), ...Array(4).fill('R Flyer'), ...Array(4).fill('B Bear'), ...Array(3).fill('R Bear'), ...Array(3).fill('B Giant'),
  ...Array(9).fill('Swamp'), ...Array(8).fill('Mountain'),
];
const r = deckRoles(good, cards)!;
check('roles: counts', r.lands === 17 && r.nonland === 23 && r.creatures === 18 && r.removal === 5 && r.interaction === 5 && r.evasive === 8 && r.top_end === 3, JSON.stringify(r));
check('roles: early plays (MV ≤ 2) and average MV', r.early === 12 && near(r.avg_mv!, Math.round(((5 * 2 + 8 * 3 + 7 * 2 + 3 * 5) / 23) * 100) / 100), JSON.stringify(r));
check('roles: a sound deck passes every check', r.passed === r.total && r.total === 6, JSON.stringify(r.checks));
const clunky = [...Array(10).fill('G Giant'), ...Array(8).fill('G Wall'), ...Array(5).fill('Clockwork'), ...Array(14).fill('Forest'), 'Tundra Gate'];
const rc = deckRoles(clunky, cards)!;
check('roles: a clunky deck fails lands, top end and interaction', !rc.checks.lands_16_18 && !rc.checks.top_end_6_max && !rc.checks.interaction_2_plus && rc.checks.creatures_12_plus, JSON.stringify(rc.checks));
check('roles: null without card data', deckRoles(good, new CardDb(undefined)) === null);
// Per-set, per-pair norms (17Lands winning decks): the real SOS UR (Prismari) norms let a 9-creature control deck pass.
{
  const sos = readDeckNorms(join(repoRoot, 'sets'), 'SOS')!;
  const ur = pairNormOf(sos, 'UR')!;
  const b = roleBands(ur);
  check('norms: SOS UR bands come from 17Lands (p10 creatures 4, p90 five-drops 7)', b.basis === 'set_pair' && b.bands.creatures_12_plus.lo === 4 && b.bands.top_end_6_max.hi === 7 && b.bands.lands_16_18.lo === 16 && b.bands.lands_16_18.hi === 18 && /^17Lands SOS UR decks with 6\+ wins \(2,666 decks\), p10–p90$/.test(b.source ?? ''), JSON.stringify(b));
  const control = [...Array(5).fill('B Bear'), ...Array(4).fill('B Giant'), ...Array(7).fill('B Removal'), ...Array(7).fill('R Removal'), ...Array(9).fill('Swamp'), ...Array(8).fill('Mountain')];
  const gen = deckRoles(control, cards)!;
  const set = deckRoles(control, cards, ur)!;
  check('norms: a 9-creature deck fails the generic floor of 12, passes the set pair floor', !gen.checks.creatures_12_plus && set.checks.creatures_12_plus && set.basis === 'set_pair' && gen.basis === 'generic');
  check('norms: no pair norm for a mono or three-color deck, or a thin pair', pairNormOf(sos, 'U') === null && pairNormOf(sos, 'WUB') === null && roleBands({ set: 'X', pair: 'WU', norm: { decks: 50 } }).basis === 'generic');
}

// ---------------------------------------------------------------------------
// Draft context and diagnostics on a synthetic event (no ratings, no archetypes: the core layer only)

function event(id: string, picks: Pick[], decks: Deck[]): EventData {
  return {
    id, dir: '', set: { code: 'tst', name: 'Test' }, bestOf: 3, source: { label: 'verified', inferred: true }, strength: null, draftEval: null,
    startT: 0, lastT: 0, status: 'complete', seats: [{ name: 's', kind: 'agent', position: 0, llm: true, model: 's' }],
    packs: [], picks, decks: new Map(decks.map((d) => [d.seat, d])), games: [], matches: [], standings: [], transcripts: new Map(),
    hasSummary: true, stage: 'done', aborted: false, draftEnded: true, rulesIssues: [], forfeits: [], forfeitsLogged: true,
  } as EventData;
}
const allPicks = [...flowPicks, ...p23.filter((p) => p.packNumber > 1)];
const deck: Deck = { seat: 's', by: 'agent', main: good, sideboard: [], t: 0 };
const ev = event('e1', allPicks, [deck]);
const dc = draftContext(ev, 's', cards, null, null);
check('context: final pair BR, flow aligned', dc.pair === 'BR' && dc.flowAlignment === 1 && dc.flow?.top === 'BR');
check('context: on-color picks and roles computed without ratings', dc.onColor.length === 5 && dc.roles?.passed === 6);
check('context: human-reference fields stay empty without data', dc.signalAlignment == null && dc.archRegret.length === 0 && dc.expert.length === 0);
const ev2 = event('e2', allPicks.map((p) => ({ ...p })), [{ ...deck, main: clunky }]);
const scores = stageScores([{ ev, seat: 's' }, { ev: ev2, seat: 's' }], [], 'x', { cards, ratingsFor: () => null, archetypesFor: () => null }, { replicates: 200, seed: 1 });
const core = scores.draft.core!;
check('stage: core present for a set without human data', core != null && core.decks === 2);
check('stage: flow alignment averages events (1 and 0)', near(core.flow_alignment?.value, (1 + 0) / 2) && core.flow_alignment?.events === 2, JSON.stringify(core.flow_alignment));
check('stage: role coverage pools checks (6 + 3 of 12)', near(core.role_coverage?.value, (6 + rc.passed) / 12), JSON.stringify(core.role_coverage));
check('stage: role failures counted per check', core.role_fails.lands_16_18 === 1 && core.role_fails.interaction_2_plus === 1);
check('stage: conversion is defined, human-reference layers null', core.conversion != null && scores.draft.archetype == null && scores.draft.expert == null && scores.draft.baseline.top_pick_rate == null);
check('stage: pair changes and on-color rate have intervals', core.pair_changes != null && core.on_color_rate != null && core.on_color_rate.n === 10);

console.log(`\n${passes} passed, ${failures} failed`);
if (failures) process.exit(1);
