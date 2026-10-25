/**
 * Tests for the 2.8 export computations: outcome intervals (Wilson, max(bootstrap, Wilson)), play/draw splits, match
 * records, finishes and Swiss finishes, the head-to-head matrix, rank ranges from interval overlap, diagnostics context
 * (field median, rank-of-N), cost estimates from list prices, and the summary templates.
 *
 *   npm test -w @mtgdt/site        # or: npx tsx packages/site/src/outcomes.test.ts
 */
import type { EventData, Game, Standing } from './data.js';
import { boardDiagnostics, DIAGNOSTICS, rankOf } from './diagnostics.js';
import { finishOf, matchRecords, outcomesOf, pairwise, rankRanges, rateEst, sidesOf, wilson, type OutcomeGame } from './outcomes.js';
import { asOfDate, boardSummary, modelSummary, type SummaryRow } from './summary.js';
import type { Diagnostics, Outcomes } from './schema.js';
import { callUsd, estimateUsd, longShare, longShareFromTotals, priceFor, validatePrices, type PricesData } from '../../registry/src/prices.js';
import { seatCost } from './cost.js';

let failures = 0;
let passes = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) passes++;
  else failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}
const near = (a: number | null | undefined, b: number, eps = 1e-3) => a != null && Math.abs(a - b) < eps;

// ---------------------------------------------------------------------------
// Wilson and the outcome interval

const w = wilson(7, 10)!;
check('wilson: 7 of 10 → 0.397–0.892 (textbook values)', near(w[0], 0.3968) && near(w[1], 0.8922), JSON.stringify(w));
const w0 = wilson(3, 3)!;
check('wilson: 3–0 still has a wide range below 1', w0[1] === 1 && w0[0] < 0.5 && w0[0] > 0.4, JSON.stringify(w0));
check('wilson: no trials → null', wilson(0, 0) === null);

const allWins = rateEst([[1, 1], [1]], { replicates: 500, seed: 1 })!;
check('rateEst: one-sided sample keeps the Wilson width (bootstrap alone would be [1, 1])', allWins.value === 1 && allWins.ci![0] < 0.6 && allWins.ci![1] === 1, JSON.stringify(allWins));
const mixed = rateEst([[1, 0, 1], [0, 0], [1, 1, 1, 0]], { replicates: 1000, seed: 3 })!;
const wm = wilson(5, 9)!;
check('rateEst: point estimate pools items; n and events counted', near(mixed.value, 5 / 9) && mixed.n === 9 && mixed.events === 3);
check('rateEst: interval contains the Wilson interval', mixed.ci![0] <= wm[0] + 1e-9 && mixed.ci![1] >= wm[1] - 1e-9, JSON.stringify({ ci: mixed.ci, wm }));
check('rateEst: deterministic for a seed', JSON.stringify(rateEst([[1, 0, 1], [0, 0], [1, 1, 1, 0]], { replicates: 1000, seed: 3 })) === JSON.stringify(mixed));
check('rateEst: no items → null; replicates 0 → no interval', rateEst([[], []], { replicates: 100, seed: 1 }) === null && rateEst([[1, 0]], { replicates: 0, seed: 1 })!.ci === null);

// ---------------------------------------------------------------------------
// Sides, play/draw, matches

const g = (event: string, a: string, b: string, seatA: string, seatB: string, winner: 'a' | 'b', onPlay?: 'a' | 'b'): OutcomeGame => ({ event, a, b, seatA, seatB, winner, ...(onPlay ? { onPlay } : {}) });
// Event e1: X (x-1) beats Y (y-1) 2–1; X on the play in games 1 and 3. X vs Z (z-1): 1–1 (third game voided, not rated).
// Event e2: Y (y-1) vs X (x-2): Y wins 2–0, X on the draw in game 1, unknown in game 2.
const games: OutcomeGame[] = [
  g('e1', 'X', 'Y', 'x-1', 'y-1', 'a', 'a'),
  g('e1', 'X', 'Y', 'x-1', 'y-1', 'b', 'b'),
  g('e1', 'X', 'Y', 'x-1', 'y-1', 'a', 'a'),
  g('e1', 'Z', 'X', 'z-1', 'x-1', 'a', 'a'),
  g('e1', 'Z', 'X', 'z-1', 'x-1', 'b', 'b'),
  g('e2', 'Y', 'X', 'y-1', 'x-2', 'a', 'a'),
  g('e2', 'Y', 'X', 'y-1', 'x-2', 'a'),
];
const isX = (id: string) => id === 'X';
const sx = sidesOf(games, isX);
check('sides: X has 7 sides, from either column', sx.length === 7 && sx.every((s) => s.seat.startsWith('x-')));
const sp = sx.filter((s) => s.onPlay === true);
const sd = sx.filter((s) => s.onPlay === false);
check('sides: on the play 3–0 (games 1, 3 vs Y; game 5 vs Z, X in column b)', sp.length === 3 && sp.every((s) => s.won), JSON.stringify(sp.map((s) => s.won)));
check('sides: on the draw 0–3 and one side unknown', sd.length === 3 && sd.every((s) => !s.won) && sx.filter((s) => s.onPlay == null).length === 1);
check('sides: self-play is skipped', sidesOf([g('e9', 'X', 'X', 'x-1', 'x-2', 'a')], isX).length === 0);
const mr = matchRecords(sx);
check('matches: X won e1 vs Y, lost e2 vs Y, level vs Z (drawn)', [...mr.byEvent.get('e1')!].join() === '1' && [...mr.byEvent.get('e2')!].join() === '0' && mr.drawn === 1, JSON.stringify([...mr.byEvent]));

// Finishes need events: a 2-agent round robin (e1-like) and an 8-agent Swiss event.
function standings(rows: Array<[string, number, number]>): Standing[] {
  return rows.map(([name, mw, ml]) => ({ name, matchWins: mw, matchLosses: ml, gameWins: mw * 2, gameLosses: ml * 2 }));
}
function ev(id: string, seats: string[], st: Standing[], format?: EventData['format']): EventData {
  return {
    id, dir: '', set: { code: 'tst', name: 'Test' }, bestOf: 3, source: { label: 'verified', inferred: true }, strength: null, draftEval: null,
    startT: id === 'e1' ? 1 : 2, lastT: 3, status: 'complete', seats: seats.map((name, i) => ({ name, kind: 'agent', position: i, llm: true, model: name })),
    packs: [], picks: [], decks: new Map(), games: [] as Game[], matches: [], standings: st, transcripts: new Map(),
    hasSummary: true, stage: 'done', aborted: false, draftEnded: true, rulesIssues: [], forfeits: [], forfeitsLogged: true, ...(format ? { format } : {}),
  } as EventData;
}
const e1 = ev('e1', ['x-1', 'y-1', 'z-1'], standings([['x-1', 1, 0], ['z-1', 1, 1], ['y-1', 0, 1]]));
const eight = ['x-2', 'y-1', 'a', 'b', 'c', 'd', 'e', 'f'];
const e2 = ev('e2', eight, standings([['y-1', 3, 0], ['a', 2, 1], ['x-2', 2, 1], ['b', 2, 1], ['c', 1, 2], ['d', 1, 2], ['e', 1, 2], ['f', 0, 3]]), { format: 'swiss', rounds: 3 });
const fx = finishOf(e1, 'x-1')!;
check('finish: rank among agents, winner flag', fx.rank === 1 && fx.of === 3 && fx.won === true && fx.format === 'round-robin', JSON.stringify(fx));
const fy = finishOf(e2, 'y-1')!;
check('finish: Swiss 3–0 is first of 8', fy.rank === 1 && fy.of === 8 && fy.match_w === 3 && fy.format === 'swiss');

const ox: Outcomes = outcomesOf(games, isX, [{ ev: e1, seat: 'x-1' }, { ev: e2, seat: 'x-2' }], { replicates: 300, seed: 5 });
check('outcomes: games 3–4', ox.games.w === 3 && ox.games.l === 4 && ox.games.win_rate!.n === 7 && ox.games.win_rate!.events === 2);
check('outcomes: matches 1–1 plus one drawn', ox.matches.w === 1 && ox.matches.l === 1 && ox.matches.drawn === 1);
check('outcomes: play 3–0, draw 0–3, one unknown', ox.on_play.w === 3 && ox.on_play.l === 0 && ox.on_draw.w === 0 && ox.on_draw.l === 3 && ox.side_unknown === 1);
check('outcomes: on-the-draw range from 0 of 3 is wide', ox.on_draw.win_rate!.value === 0 && ox.on_draw.win_rate!.ci![1] > 0.5, JSON.stringify(ox.on_draw.win_rate));
check('outcomes: two events, one won, newest first', ox.events.played === 2 && ox.events.won === 1 && ox.events.finishes[0]!.event_id === 'e2');
check('outcomes: Swiss finishes counted (one 2–1 of one event), 3–0 rate 0', ox.swiss != null && ox.swiss.events === 1 && ox.swiss.counts['2-1'] === 1 && ox.swiss.counts['3-0'] === 0 && ox.swiss.trophy_rate!.value === 0, JSON.stringify(ox.swiss));
const oy = outcomesOf(games, (id) => id === 'Y', [{ ev: e1, seat: 'y-1' }, { ev: e2, seat: 'y-1' }], { replicates: 300, seed: 5 });
check('outcomes: Y went 3–0 at the Swiss event (trophy rate 1 of 1, range below 1)', oy.swiss!.counts['3-0'] === 1 && oy.swiss!.trophy_rate!.value === 1 && oy.swiss!.trophy_rate!.ci![0] < 0.5);
const oz = outcomesOf(games, (id) => id === 'Z', [{ ev: e1, seat: 'z-1' }], { replicates: 0, seed: 5 });
check('outcomes: no Swiss events → swiss null', oz.swiss === null && oz.matches.drawn === 1 && oz.matches.w + oz.matches.l === 0);

// ---------------------------------------------------------------------------
// Head to head

const pw = pairwise(games);
const xy = pw.find((p) => p.a === 'X' && p.b === 'Y')!;
const xz = pw.find((p) => p.a === 'X' && p.b === 'Z')!;
check('pairwise: one entry per pair, a < b, most games first', pw.length === 2 && pw[0] === xy && pw.every((p) => p.a < p.b));
check('pairwise: X–Y games 2 of 5 to X across 2 events', xy.games === 5 && xy.a_wins === 2 && xy.events === 2, JSON.stringify(xy));
check('pairwise: X–Y matches 1 of 2 to X (e1 won, e2 lost)', xy.matches === 2 && xy.a_match_wins === 1 && xy.drawn_matches === 0, JSON.stringify(xy));
check('pairwise: X–Z oriented from X (games listed Z first), a level match', xz.games === 2 && xz.a_wins === 1 && xz.matches === 0 && xz.drawn_matches === 1, JSON.stringify(xz));
// A match cut short by engine failures (no result): its finished game counts as a game, never toward a match.
const nr = [g('e9', 'X', 'Y', 'x-1', 'y-1', 'a')].map((x) => ({ ...x, noResult: true }));
const pwNr = pairwise(nr)[0]!;
check('pairwise: a no-result match counts its game, not a match', pwNr.games === 1 && pwNr.a_wins === 1 && pwNr.matches === 0 && pwNr.drawn_matches === 0, JSON.stringify(pwNr));
const mrNr = matchRecords(sidesOf(nr, isX));
check('match records: a no-result match is neither won, lost nor drawn', mrNr.byEvent.size === 0 && mrNr.drawn === 0);
check('pairwise: symmetric with the sides view', xy.a_wins === sidesOf(games.filter((x) => [x.a, x.b].sort().join() === 'X,Y'), isX).filter((s) => s.won).length);

// ---------------------------------------------------------------------------
// Rank ranges from interval overlap

const rows = [{ ci: [1600, 1700] as [number, number] }, { ci: [1450, 1650] as [number, number] }, { ci: [1300, 1400] as [number, number] }, { ci: null }];
const rr = rankRanges(rows, (r) => r.ci);
check('rank ranges: clear leader is 1–2 (overlaps the second), last is 3–3, no interval → null', JSON.stringify(rr) === JSON.stringify([[1, 2], [1, 2], [3, 3], null]), JSON.stringify(rr));
check('rank ranges: everything overlapping → 1–N for all', JSON.stringify(rankRanges([[1, 3], [2, 4], [2.5, 5]] as Array<[number, number]>, (r) => r)) === JSON.stringify([[1, 3], [1, 3], [1, 3]]));

// ---------------------------------------------------------------------------
// Diagnostics context

check('rankOf: desc and asc, ties share the best rank', rankOf(0.9, [0.9, 0.95, 0.8, 0.9], 'desc') === 2 && rankOf(3, [3, 9, 2.5], 'asc') === 2 && rankOf(0.9, [0.9, 0.9], 'desc') === 1);
const est = (value: number) => ({ value, ci: [value - 0.1, value + 0.1] as [number, number], n: 10, events: 2 });
const diag = (onColor: number | null, lat: number | null): Diagnostics =>
  ({
    draft: { core: { on_color_rate: onColor == null ? null : est(onColor), conversion: null, commitment_pick: null, flow_alignment: null, pair_changes: null, role_coverage: null, decks: 0, role_fails: {} } },
    build: { avg_lands: 17, legal_rate: 1, agent_built: 1 },
    play: { mulligans_per_game: null, games: 0 },
    reliability: { rejected_per_100: null, decisions: 100 },
    efficiency: { median_latency_ms: lat, output_tokens_per_decision: null },
  }) as unknown as Diagnostics;
const bd = boardDiagnostics([{ stages: diag(0.9, 3000) }, { stages: diag(0.7, 2000) }, { stages: diag(null, 4000) }]);
check('diagnostics: field median over rows with a value', near(bd.field.on_color_rate!.median, 0.8) && bd.field.on_color_rate!.n === 2 && bd.field.median_latency_ms!.median === 3000);
check('diagnostics: behavior is never ranked (2.9): rank and rank_label are null; of counts rows with a value', bd.perRow.every((p) => Object.values(p).every((v) => v.rank === null)) && DIAGNOSTICS.every((d) => d.rank_label === null) && bd.perRow[0]!.on_color_rate!.of === 2);
check('diagnostics: values pass through', bd.perRow[2]!.on_color_rate!.value === null && bd.perRow[0]!.avg_lands!.value === 17 && bd.perRow[1]!.median_latency_ms!.value === 2000);

// ---------------------------------------------------------------------------
// Cost estimates and price windows

const prices: PricesData = {
  currency: 'USD', unit: 'per_million_tokens',
  prices: [
    { model: 'm', from: '2026-01-01', until: '2026-12-01', input: 2, output: 10, cache_read: 0.1, cache_write: 2.5, source: 'https://x', checked: '2026-10-21' },
    { model: 'm', from: '2026-12-01', input: 4, output: 20, cache_read: 0.2, cache_write: null, source: 'https://x', checked: '2026-10-21' },
  ],
};
check('prices: the window of the event day applies', priceFor('m', Date.UTC(2026, 10, 30), prices)!.input === 2 && priceFor('m', Date.UTC(2026, 11, 1), prices)!.input === 4);
check('prices: before the first window → earliest; unknown model → null', priceFor('m', Date.UTC(2025, 0, 1), prices)!.input === 2 && priceFor('n', Date.UTC(2026, 5, 1), prices) === null);
check('estimate: tokens × price per million', near(estimateUsd({ input: 1e6, output: 2e5, cache_read: 1e7, cache_write: 4e5 }, prices.prices[0]!), 2 + 2 + 1 + 1));
check('estimate: no cache-write price → billed as input', near(estimateUsd({ input: 0, output: 0, cache_read: 0, cache_write: 1e6 }, prices.prices[1]!), 4));

// Long-context prices: a request over the threshold pays the higher prices on all of it; the prompt counts cache reads.
const haiku = priceFor('claude-haiku-5-5', '2026-10-22')!;
check('long context: Claude Haiku 5.5 lists 5× over 100,000 prompt tokens (registry)', haiku.long_context?.above === 100000 && near(haiku.long_context.input, 5 * haiku.input) && near(haiku.long_context.output, 5 * haiku.output) && near(haiku.long_context.cache_read!, 5 * haiku.cache_read!));
check('long context: the flat-priced Claude models list no tier; GPT-6 over 272 k, Gemini 3.1 Pro over 200 k', ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1'].every((m) => !priceFor(m, '2026-10-22')!.long_context) && priceFor('gpt-6.1-sol', '2026-10-22')!.long_context!.above === 272000 && priceFor('gemini-3.1-pro-preview', '2026-10-22')!.long_context!.above === 200000);
const req = (cr: number) => ({ input: 1000, output: 1000, cache_read: cr, cache_write: 0 });
check('long context: a request is priced by its whole prompt, cache reads included', near(callUsd(req(98_000), haiku), (1000 * 0.1 + 1000 * 0.5 + 98_000 * 0.01) / 1e6, 1e-12) && near(callUsd(req(99_001), haiku), (1000 * 0.5 + 1000 * 2.5 + 99_001 * 0.05) / 1e6, 1e-12));
const calls = [req(50_000), req(150_000), req(250_000)];
const sh = longShare(calls, 100_000);
const sumT = { input: 3000, output: 3000, cache_read: 450_000, cache_write: 0 };
check('long context: per-request shares reproduce the per-request prices', near(sh.cache_read, 400 / 450) && near(sh.output, 2 / 3) && near(estimateUsd(sumT, haiku, sh), calls.reduce((n, c) => n + callUsd(c, haiku), 0), 1e-12), JSON.stringify(sh));
check('long context: without shares every token is at the base price', near(estimateUsd(sumT, haiku), (3000 * 0.1 + 3000 * 0.5 + 450_000 * 0.01) / 1e6, 1e-12));
// Totals only: prompts taken as spread evenly from 0 to twice the mean. Mean 200 k, top 400 k: a quarter of the way up.
const ft = longShareFromTotals({ input: 0, output: 1000, cache_read: 2e6, cache_write: 0 }, 10, 100_000);
check('long context from totals: share of prompt 1 - (T/2m)^2, of requests 1 - T/2m', near(ft.cache_read, 1 - 0.25 ** 2) && near(ft.output, 0.75), JSON.stringify(ft));
check('long context from totals: a mean under half the threshold is all base; no request count → no share', longShareFromTotals({ input: 0, output: 0, cache_read: 4e5, cache_write: 0 }, 10, 100_000).cache_read === 0 && longShareFromTotals(sumT, 0, 100_000).cache_read === 0);
check('prices: a long-context price below the base is flagged', validatePrices({ ...prices, prices: [{ ...prices.prices[0]!, long_context: { above: 1000, input: 1, output: 10, cache_read: 0.1, cache_write: 2.5 } }] }, new Set(['m'])).length === 1);

// seatCost: an unreported Claude Haiku 5.5 seat at long context is estimated at the long prices (5×), not the base.
const he = ev('h1', ['h-1', 'h-2'], standings([['h-1', 1, 0], ['h-2', 0, 1]]));
he.startT = Date.UTC(2026, 9, 22);
const big = Array.from({ length: 40 }, (_, i) => ({ input: 500, output: 300, cache_read: 110_000 + i * 20_000, cache_write: 2000 }));
const tot = (k: 'input' | 'output' | 'cache_read' | 'cache_write') => big.reduce((n, c) => n + c[k], 0);
he.transcripts.set('h-1', { seat: 'h-1', file: '', done: false, lines: 1, inputTokens: tot('input'), outputTokens: tot('output'), cacheReadTokens: tot('cache_read'), cacheCreationTokens: tot('cache_write'), toolCalls: { decide: 39 }, toolErrors: 0, calls: big });
he.usage = new Map([['h-2', { input_tokens: tot('input'), output_tokens: tot('output'), cache_read_tokens: tot('cache_read'), cache_creation_tokens: tot('cache_write'), requests: 40, complete: false }]]);
const c1 = seatCost(he, 'h-1', 'claude-haiku-5-5')!;
const c2 = seatCost(he, 'h-2', 'claude-haiku-5-5')!;
const allLong = big.reduce((n, c) => n + callUsd(c, haiku), 0);
check('seatCost: transcript with per-request usage → every request over 100 k at 5×', c1.basis === 'estimated' && c1.long_context === 'per_request' && near(c1.usd, allLong, 1e-9) && near(c1.usd, 5 * estimateUsd({ input: tot('input'), output: tot('output'), cache_read: tot('cache_read'), cache_write: tot('cache_write') }, haiku), 1e-9), `${c1.usd}`);
check('seatCost: usage file with totals only → approximated, within 10% of the per-request figure', c2.long_context === 'from_totals' && Math.abs(c2.usd / allLong - 1) < 0.1, `${c2.usd} vs ${allLong}`);
const he2 = { ...he, usage: new Map([['h-2', { ...he.usage.get('h-2')!, requests: undefined }]]) };
check('seatCost: no request count → base prices, flagged unknown', seatCost(he2, 'h-2', 'claude-haiku-5-5')!.long_context === 'unknown');
check('seatCost: a flat-priced model has no long-context flag', seatCost(he, 'h-1', 'claude-sonnet-5-5')!.long_context === undefined);

// Fresh sessions per game: only the last session wrote a cost, so a reported sum would undercount (event 909e showed
// $0.02–0.07 a game against a real $0.21–0.28). Not every session reported → estimated, per request.
const hr = ev('hr', ['r-1', 'r-2'], standings([['r-1', 1, 0], ['r-2', 0, 1]]));
hr.startT = Date.UTC(2026, 9, 22);
hr.transcripts.set('r-1', { seat: 'r-1', file: '', done: true, costUsd: 0.01, sessionsUnreported: 3, lines: 1, inputTokens: tot('input'), outputTokens: tot('output'), cacheReadTokens: tot('cache_read'), cacheCreationTokens: tot('cache_write'), toolCalls: { decide: 39 }, toolErrors: 0, calls: big });
const r1 = seatCost(hr, 'r-1', 'claude-haiku-5-5')!;
check('seatCost: a transcript whose sessions did not all report a cost is estimated per request, not the partial sum', r1.basis === 'estimated' && r1.long_context === 'per_request' && near(r1.usd, allLong, 1e-9), JSON.stringify(r1));
const T = { input_tokens: tot('input'), output_tokens: tot('output'), cache_read_tokens: tot('cache_read'), cache_creation_tokens: tot('cache_write'), requests: 40 };
hr.usage = new Map([['r-2', { ...T, cost_usd: 0.01, complete: true, sessions_unreported: 3, long_context: { above: 100_000, ...T, requests: 40, cache_creation_1h_tokens: 0 } }]]);
const r2 = seatCost(hr, 'r-2', 'claude-haiku-5-5')!;
check('seatCost: a usage upload with its long requests\' tokens is priced per request, exactly', r2.basis === 'estimated' && r2.long_context === 'per_request' && near(r2.usd, allLong, 1e-9), JSON.stringify(r2));
hr.usage = new Map([['r-2', { ...T, cost_usd: 0.5, complete: true }]]);
// F-2: an uploaded cost is the contributor's own figure: with token counts, the estimate wins and both are kept.
const up = seatCost(hr, 'r-2', 'claude-haiku-5-5')!;
check('seatCost: a self-reported upload with tokens is re-priced from them (both kept, flagged)', up.basis === 'estimated' && up.flag === 'upload_repriced' && up.reported_usd === 0.5 && up.estimated_usd === up.usd, JSON.stringify(up));
hr.usage = new Map([['r-2', { cost_usd: 0.5, complete: true }]]);
check('seatCost: an upload without token counts keeps its reported cost', seatCost(hr, 'r-2', 'claude-haiku-5-5')!.basis === 'reported');
// A transcript whose every session reported: trusted when near the estimate; $0 with tokens or a gap over 35% is not.
const t1 = hr.transcripts.get('r-1')!;
const estR1 = seatCost(hr, 'r-1', 'claude-haiku-5-5')!.usd;
hr.transcripts.set('r-1', { ...t1, sessionsUnreported: 0, costUsd: estR1 * 1.1 });
const ok1 = seatCost(hr, 'r-1', 'claude-haiku-5-5')!;
check('seatCost: every session reported, near the estimate → the reported cost', ok1.basis === 'reported' && ok1.flag === undefined && near(ok1.usd, estR1 * 1.1, 1e-9), JSON.stringify(ok1));
hr.transcripts.set('r-1', { ...t1, sessionsUnreported: 0, costUsd: 0 });
check('seatCost: $0 reported with tokens used → the estimate, flagged', seatCost(hr, 'r-1', 'claude-haiku-5-5')!.flag === 'reported_zero');
hr.transcripts.set('r-1', { ...t1, sessionsUnreported: 0, costUsd: estR1 * 3 });
const gap = seatCost(hr, 'r-1', 'claude-haiku-5-5')!;
check('seatCost: a reported cost over 35% from the estimate → the estimate, flagged', gap.flag === 'gap' && gap.basis === 'estimated' && near(gap.usd, estR1, 1e-9), JSON.stringify(gap));
hr.transcripts.set('r-1', t1);
// 1-hour cache writes (Claude Code writes them) cost more than the default write: $0.20 against $0.125 for Haiku 5.5.
check('prices: 1-hour cache writes at their own price, and 5× over 100 k', near(estimateUsd({ input: 0, output: 0, cache_read: 0, cache_write: 1e6, cache_write_1h: 6e5 }, haiku), 0.4 * 0.125 + 0.6 * 0.2) && near(callUsd({ input: 0, output: 0, cache_read: 100_000, cache_write: 1e6, cache_write_1h: 1e6 }, haiku), 0.1 * 0.05 + 1), JSON.stringify(haiku));

check('prices: overlapping windows and unknown models are flagged', validatePrices({ ...prices, prices: [...prices.prices, { ...prices.prices[1]!, from: '2026-11-15' }, { ...prices.prices[1]!, model: 'zz' }] }, new Set(['m'])).length === 3);

// ---------------------------------------------------------------------------
// Summary templates

const asOf = Date.UTC(2026, 9, 22, 4, 0);
check('asOfDate: "Oct 22, 2026" in UTC', asOfDate(asOf) === 'Oct 22, 2026');
const R = (label: string, rating: number, ci: [number, number], games: number, rankRange: [number, number], provisional = true, group = 0): SummaryRow => ({ label, rating, ci, games, provisional, rankRange, group });
const base = { asOf, conditions: 'Set Context', set: null, events: 4, games: 15, minGames: 30 };
const s1 = boardSummary({ ...base, rows: [R('A', 1540, [1380, 1700], 3, [1, 3]), R('B', 1500, [1360, 1670], 10, [1, 3]), R('C', 1460, [1300, 1620], 7, [1, 3])] });
check('board summary: nobody clearly ahead → too early to rank, names the leader so far (no thousands separators)', s1.startsWith('As of Oct 22, 2026, three agents have played 15 rated games across four events under Set Context.') && s1.includes('No agent is clearly ahead of another yet, so it’s too early to rank them: A has the highest rating so far, 1540 (95% range 1380–1700), from three games.'), s1);
check('board summary: all provisional is said, with the most-played count and the contributor floor', s1.includes('Every rating is still provisional') && s1.includes('games from 2 or more contributors') && s1.includes('the most-played agent has ten games'), s1);
const s2 = boardSummary({ ...base, rows: [R('A', 1700, [1650, 1750], 60, [1, 1], false), R('B', 1500, [1450, 1550], 60, [2, 2], false), R('C', 1300, [1250, 1350], 12, [3, 3])] });
check('board summary: a leader clearly ahead of everyone ranks first', s2.includes('A ranks first: its rating, 1700 (95% range 1650–1750), is clearly ahead of every other agent’s.') && s2.includes('1 of 3 ratings are still provisional.'), s2);
// Ranges that overlap can still be separated by the difference: B and C overlap A's range but A is ahead of both.
const s3 = boardSummary({ ...base, rows: [R('A', 1600, [1520, 1680], 60, [1, 2], false), R('B', 1560, [1480, 1640], 60, [1, 2], false), R('C', 1300, [1250, 1350], 60, [3, 3], false)] });
check('board summary: a shared top spot is named as shared', s3.includes('but it isn’t clearly ahead of one other agent, so two agents share the top spot.') && !s3.includes('provisional'), s3);
check('board summary: no games → says so', boardSummary({ ...base, set: 'The Hobbit', events: 0, games: 0, rows: [] }) === 'As of Oct 22, 2026, no games between agents have been rated under Set Context in The Hobbit yet.');
check('board summary: deterministic', boardSummary({ ...base, rows: [R('A', 1540, [1380, 1700], 3, [1, 3]), R('B', 1500, [1360, 1670], 10, [1, 3]), R('C', 1460, [1300, 1620], 7, [1, 3])] }) === s1);
const s4 = boardSummary({ ...base, rows: [R('A', 1600, [1500, 1700], 60, [1, 1], false, 0), R('B', 1400, [1300, 1500], 60, [2, 2], false, 0), R('C', 1550, [1450, 1650], 60, [1, 1], false, 1), R('D', 1450, [1350, 1550], 60, [2, 2], false, 1)], unknownEffortRows: 2 });
check('board summary: disconnected groups are said, ranks within a group', s4.includes('These agents form two groups that haven’t played each other, so ranks compare agents within a group only.'), s4);
check('board summary: Unknown Effort rows are said to be off the ranking', s4.endsWith('Two agents without a recorded effort are rated but left off this ranking.'), s4);
const s5 = boardSummary({ ...base, rows: [R('A', 1600, [1500, 1700], 60, [1, 1], false, 0), R('B', 1400, [1300, 1500], 60, [1, 1], false, 1)] });
check('board summary: a leader alone in its group is not ranked against anyone', s5.includes('but no other agent is connected to it through games yet.'), s5);

const mo = { ...ox, games: { w: 8, l: 9, win_rate: null }, matches: { w: 3, l: 4, drawn: 0, win_rate: null }, events: { played: 6, won: 2, finishes: [] }, swiss: null };
const m1 = modelSummary({
  asOf, model: 'Claude Sonnet 5.5', versions: ['Claude Code at Medium', 'Claude Code at Unknown Effort'],
  main: { version: 'Claude Code · Medium', conditions: 'Set Context', rating: 1500, ci: [1363, 1670], rankRange: [1, 5], of: 5, games: 10, provisional: true },
  outcomes: mo, events: 6, sets: 4, minGames: 30,
});
check('model summary: outcomes first, two versions, too early to rank, provisional', m1 === 'As of Oct 22, 2026, Claude Sonnet 5.5 has played 17 rated games against other models across six events and four sets. It is rated as two versions: Claude Code at Medium and Claude Code at Unknown Effort. Its most-played version (Claude Code · Medium, Set Context) is 1500 (95% range 1363–1670), and it isn’t clearly ahead of or behind any other agent yet, so it’s too early to rank it. That rating is provisional: it has ten of the 30 games a firm rating needs. In those games it has won 8–9, taken three of its seven matches and won two of its six events.', m1);
const m2 = modelSummary({
  asOf, model: 'M', versions: ['H at High'], main: { version: 'H · High', conditions: 'Set Context', rating: 1650, ci: [1600, 1700], rankRange: [1, 2], of: 6, games: 80, provisional: false },
  outcomes: { ...mo, swiss: { events: 5, rounds: 3, counts: { '3-0': 2, '2-1': 2, '1-2': 1, '0-3': 0 }, trophy_rate: null } }, events: 5, sets: 1, minGames: 30,
});
check('model summary: a rank range and Swiss 3–0s when separated', m2.includes('which places it 1–2 of 6.') && !m2.includes('provisional') && m2.includes('it went 3–0 in two of five events.') && m2.includes('Its rating (H · High, Set Context)'), m2);
const m3 = modelSummary({ asOf, model: 'M', versions: [], main: null, outcomes: { ...mo, games: { w: 0, l: 0, win_rate: null } }, events: 2, sets: 1, minGames: 30, unratedReason: 'model "x" isn’t in the registry' });
check('model summary: unrated model says why', m3 === 'As of Oct 22, 2026, M has sat at two events. It isn’t rated: model "x" isn’t in the registry.', m3);

console.log(`\n${passes} passed, ${failures} failed`);
if (failures) process.exit(1);
