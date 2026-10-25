/**
 * Seat usage across rotated sessions (usage.ts): a seat with a fresh session per game has several Claude Code
 * sessions in one transcript, and only the last writes a result line (the others are ended from outside). Tokens are
 * summed over every session, each request's final usage comes from the session record, and the cost is reported only
 * when every session reported one; otherwise it is priced request by request at list price.
 *   npx tsx packages/director/src/usage.test.ts
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { callUsd, priceFor } from '../../registry/src/prices.js';
import { extractUsage, seatUsd, slimClaudeTranscript, usageFacts, usageProblem } from './usage.js';
import { SEAT_KEYS_V1, seatUploadFromRun, validateUsageUpload } from './usage-upload.js';

let passed = 0;
const test = (name: string, fn: () => void) => {
  fn();
  passed++;
  console.log(`ok - ${name}`);
};
const near = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) <= eps;
const jsonl = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';

/** [input, output as streamed, output in the session record (null: not there), cache read, cache write, of which 1 h] */
type Req = [number, number, number | null, number, number, number];
interface FixtureSession { requests: Req[]; result?: { total_cost_usd: number; num_turns?: number; usage: Record<string, unknown> } }

/** A run folder for one seat: the stream-json transcript (placeholder outputs) and Claude Code's session record. */
function writeSeat(dir: string, seat: string, sessions: FixtureSession[], model = 'claude-haiku-5-5'): void {
  const stream: unknown[] = [];
  const record: unknown[] = [];
  let n = 0;
  sessions.forEach((s, i) => {
    stream.push({ type: 'system', subtype: 'init', session_id: `s${i}`, model, claude_code_version: '2.1.306' });
    for (const [input, streamed, final, cr, cw, cw1h] of s.requests) {
      const id = `msg_${seat}_${n++}`;
      const usage = (output: number) => ({ input_tokens: input, output_tokens: output, cache_read_input_tokens: cr, cache_creation_input_tokens: cw, cache_creation: { ephemeral_1h_input_tokens: cw1h, ephemeral_5m_input_tokens: cw - cw1h } });
      // Claude Code repeats a message line per content block; each carries the usage as the message started.
      stream.push({ type: 'assistant', message: { id, model, usage: usage(streamed), content: [{ type: 'tool_use', id: `t${n}`, name: 'mcp__mtg__decide' }] } });
      stream.push({ type: 'assistant', message: { id, model, usage: usage(streamed), content: [] } });
      if (final != null) record.push({ type: 'assistant', sessionId: `s${i}`, message: { id, model, usage: usage(final), content: [] } });
    }
    if (s.result) stream.push({ type: 'result', subtype: 'success', ...s.result });
  });
  writeFileSync(join(dir, `transcript-${seat}.jsonl`), jsonl(stream));
  if (record.length) writeFileSync(join(dir, `session-${seat}.jsonl`), jsonl(record));
}

const haiku = priceFor('claude-haiku-5-5', '2026-10-22')!;
const AT = Date.parse('2026-10-22T14:39:42Z');
const call = ([input, , final, cr, cw, cw1h]: Req) => ({ input, output: final ?? 0, cache_read: cr, cache_write: cw, cache_write_1h: cw1h });

// A rotated seat: the draft session, then one per game. Prompts grow within a session and start small in the next.
const rotated: FixtureSession[] = [
  { requests: [[2, 6, 300, 5_000, 8_000, 8_000], [3, 8, 420, 13_000, 2_000, 2_000]] },
  { requests: [[2, 5, 250, 60_000, 9_000, 9_000], [4, 3, 610, 104_000, 3_000, 3_000]] }, // over 100 k: 104 k + 3 k, and below 99 k + 1.5 k
  { requests: [[2, 7, 199, 40_000, 7_000, 7_000], [2, 4, 805, 99_000, 1_500, 0]] },
  {
    requests: [[2, 6, 333, 50_000, 6_000, 6_000], [2, 5, 444, 120_000, 2_500, 2_500]],
    result: {
      total_cost_usd: 0.0123, num_turns: 2,
      usage: { input_tokens: 4, output_tokens: 777, cache_read_input_tokens: 170_000, cache_creation_input_tokens: 8_500, cache_creation: { ephemeral_1h_input_tokens: 8_500 } },
    },
  },
];

test('a rotated seat with 4 sessions: tokens summed over every session, final outputs from the session record', () => {
  const dir = mkdtempSync(join(tmpdir(), 'usage-rot-'));
  writeSeat(dir, 'seat-aa11', rotated);
  const u = extractUsage(join(dir, 'transcript-seat-aa11.jsonl'), 'seat-aa11', 'claude-code');
  assert.equal(u.sessions, 4);
  assert.equal(u.sessions_unreported, 3);
  // Sessions 1–3 from their requests (session record outputs), session 4 from its result line.
  const early = rotated.slice(0, 3).flatMap((s) => s.requests);
  assert.equal(u.output_tokens, early.reduce((n, r) => n + r[2]!, 0) + 777);
  assert.equal(u.cache_read_tokens, early.reduce((n, r) => n + r[3], 0) + 170_000);
  assert.equal(u.cache_creation_tokens, early.reduce((n, r) => n + r[4], 0) + 8_500);
  assert.equal(u.cache_creation_1h_tokens, early.reduce((n, r) => n + r[5], 0) + 8_500);
  assert.equal(u.requests, 8);
  assert.equal(u.tool_calls.decide, 8);
  // Not every session reported a cost: the last session's $0.0123 alone is not the seat's cost.
  assert.equal(u.cost_usd, null);
  const c = seatUsd(u, 'claude-haiku-5-5', 'claude-code', AT)!;
  assert.equal(c.basis, 'estimated');
  // Every request at its own tier: the long ones (prompt over 100 k) at 5×, 1-hour writes at their own price.
  const perRequest = rotated.flatMap((s) => s.requests).reduce((n, r) => n + callUsd(call(r), haiku), 0);
  assert.ok(near(c.usd, perRequest, 1e-12), `${c.usd} vs ${perRequest}`);
  assert.ok(c.usd > 0.0123 * 2);
  // The usage file and upload leave the per-request list out.
  assert.equal('calls' in usageFacts(u), false);
});

test('every session reported (ended with SIGINT): the reported costs are summed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'usage-rot-'));
  const all = rotated.map((s, i) => ({
    ...s,
    result: s.result ?? { total_cost_usd: 0.001 * (i + 1), usage: { input_tokens: 1, output_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 10 } },
  }));
  writeSeat(dir, 'seat-bb22', all);
  const u = extractUsage(join(dir, 'transcript-seat-bb22.jsonl'), 'seat-bb22', 'claude-code');
  assert.equal(u.sessions, 4);
  assert.equal(u.sessions_unreported, undefined);
  assert.ok(near(u.cost_usd!, 0.001 + 0.002 + 0.003 + 0.0123));
  assert.deepEqual(seatUsd(u, 'claude-haiku-5-5', 'claude-code', AT), { usd: u.cost_usd, basis: 'reported' });
  assert.equal(u.output_tokens, 30 + 777);
});

test('no session record: every session still counts, and the cost is still not taken from the last one alone', () => {
  const dir = mkdtempSync(join(tmpdir(), 'usage-rot-'));
  writeSeat(dir, 'seat-cc33', rotated.map((s) => ({ ...s, requests: s.requests.map((r): Req => [r[0], r[1], null, r[3], r[4], r[5]]) })));
  const u = extractUsage(join(dir, 'transcript-seat-cc33.jsonl'), 'seat-cc33', 'claude-code');
  assert.equal(u.sessions, 4);
  assert.equal(u.cost_usd, null);
  assert.equal(u.cache_read_tokens, rotated.slice(0, 3).flatMap((s) => s.requests).reduce((n, r) => n + r[3], 0) + 170_000);
});

test('the slim transcript of a bundle carries the final outputs, so the site prices the same requests', () => {
  const dir = mkdtempSync(join(tmpdir(), 'usage-rot-'));
  writeSeat(dir, 'seat-dd44', rotated);
  const t = join(dir, 'transcript-seat-dd44.jsonl');
  const slim = slimClaudeTranscript(t, join(dir, 'session-seat-dd44.jsonl'));
  const outs = slim.split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((o) => o.type === 'assistant').map((o) => o.message.usage.output_tokens);
  assert.ok(outs.includes(805) && outs.includes(610) && !outs.includes(4));
  const slimFile = join(dir, 'slim.jsonl');
  writeFileSync(slimFile, slim);
  const a = extractUsage(t, 'seat-dd44', 'claude-code');
  const b = extractUsage(slimFile, 'seat-dd44', 'claude-code', { sessionFile: false });
  assert.equal(b.output_tokens, a.output_tokens);
  assert.ok(near(seatUsd(b, 'claude-haiku-5-5', 'claude-code', AT)!.usd, seatUsd(a, 'claude-haiku-5-5', 'claude-code', AT)!.usd, 1e-12));
});

test('the upload of a rotated seat: no partial cost, the long requests\' tokens, accepted by the Hub check', () => {
  const dir = mkdtempSync(join(tmpdir(), 'usage-rot-'));
  writeSeat(dir, 'seat-ee55', rotated);
  const decl = { harness: 'claude-code', model: 'claude-haiku-5-5', effort: 'low' };
  const s = seatUploadFromRun(dir, 'seat-ee55', decl, 'bench play 0.1.0', AT)!;
  assert.equal('cost_usd' in s, false);
  assert.equal(s.requests, 8);
  assert.equal(s.long_context?.above, 100_000);
  assert.equal(s.long_context?.requests, 3);
  assert.equal(s.long_context?.output_tokens, 610 + 805 + 444);
  const start = { id: '2026-10-22-14-39-42-sos-909e', t: AT, seats: [{ name: 'seat-ee55', kind: 'agent', ...decl }] };
  const v = validateUsageUpload({ version: 1, event_id: start.id, seats: [s] }, start);
  assert.ok(v.ok, JSON.stringify(v));
  const bad = validateUsageUpload({ version: 1, event_id: start.id, seats: [{ ...s, long_context: { ...s.long_context, output_tokens: 1e9 } }] }, start);
  assert.ok(!bad.ok);
  // The fields an older Hub knows don't include the new ones (scripts/bench/usage-upload.ts falls back to these).
  for (const k of ['requests', 'long_context', 'cache_creation_1h_tokens']) assert.equal((SEAT_KEYS_V1 as readonly string[]).includes(k), false);
});

test('event 2026-10-22-14-39-42-sos-909e re-derived: low seats ≈ $2.57, medium ≈ $3.37 (the leaderboard showed a fraction)', () => {
  const fx = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../test/fixtures/usage-rotated-sos-909e.json'), 'utf8'));
  const dir = mkdtempSync(join(tmpdir(), 'usage-909e-'));
  const by: Record<string, number> = {};
  let reportedBefore = 0;
  for (const [seat, s] of Object.entries<{ effort: string; sessions: FixtureSession[] }>(fx.seats)) {
    writeSeat(dir, seat, s.sessions, fx.model);
    const u = extractUsage(join(dir, `transcript-${seat}.jsonl`), seat, fx.harness);
    assert.equal(u.sessions, 4);
    assert.equal(u.cost_usd, null);
    const c = seatUsd(u, fx.model, fx.harness, fx.event_start)!;
    assert.equal(c.basis, 'estimated');
    by[s.effort] = (by[s.effort] ?? 0) + c.usd;
    reportedBefore += s.sessions.at(-1)!.result!.total_cost_usd;
  }
  // Per request with long-context prices and 1-hour cache writes (one low seat's request stopped mid-stream, prompt
  // 211 k tokens, is counted too: $0.01 more than the session records alone).
  assert.ok(Math.abs(by.low! - 2.56) < 0.02, `low ${by.low}`);
  assert.ok(Math.abs(by.medium! - 3.37) < 0.02, `medium ${by.medium}`);
  assert.ok(by.medium! > by.low!);
  // What was reported before: the last session of each seat only, $1.05 of the $5.95.
  assert.ok(Math.abs(reportedBefore - 1.05) < 0.01, `${reportedBefore}`);
});

console.log(`\nusage: ${passed} passed`);

test('E-8: an unknown log format, no tokens or $0 with tokens is said, never silent; $0 with tokens is estimated', () => {
  const base = { format: 'claude-stream-json', lines: 10, input_tokens: 1000, output_tokens: 200, cache_read_tokens: 0, cost_usd: 0.01 };
  assert.equal(usageProblem(base), null);
  assert.match(usageProblem({ ...base, format: 'unknown' })!, /format this version reads/);
  assert.match(usageProblem({ ...base, input_tokens: 0, output_tokens: 0 })!, /no token counts/);
  assert.match(usageProblem({ ...base, cost_usd: 0 })!, /\$0 with tokens/);
  assert.equal(usageProblem({ ...base, lines: 0, format: 'unknown' }), null, 'no log at all is a different problem (the seat never ran)');
  const u = {
    seat: 's', harness: 'claude-code', format: 'claude-stream-json', model_ids: ['claude-haiku-5-5'], input_tokens: 1_000_000, output_tokens: 10_000,
    cache_read_tokens: 0, cache_creation_tokens: 0, reasoning_tokens: 0, cost_usd: 0, duration_ms: null, turns: null, tool_calls: {}, tool_errors: 0, complete: true, lines: 10,
  } as unknown as Parameters<typeof seatUsd>[0];
  assert.equal(seatUsd(u, 'claude-haiku-5-5', 'claude-code', AT)?.basis, 'estimated');
});
