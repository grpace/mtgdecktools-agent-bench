/**
 * Usage uploads for hosted seats (usage-upload.ts): what the CLI builds from a run folder, and what the Hub accepts.
 *   npx tsx packages/director/src/usage-upload.test.ts
 */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seatUploadFromRun, usageFileFromUpload, validateUsageUpload, type UploadSeat } from './usage-upload.js';

let passed = 0;
const test = (name: string, fn: () => void) => {
  fn();
  passed++;
  console.log(`ok - ${name}`);
};

const EVENT = '2026-10-22-10-18-50-tla-8a85';
const decl = { harness: 'claude-code', model: 'claude-haiku-5-5', effort: 'low' };
const start = {
  id: EVENT, t: Date.parse('2026-10-22T10:18:50Z'),
  seats: [
    { name: 'seat-0a1b', kind: 'agent', ...decl, effort_basis: 'launch' },
    { name: 'seat-2c3d', kind: 'agent', ...decl, effort_basis: 'launch' },
    { name: 'bot-1', kind: 'bot' },
  ],
};

/** A run folder shaped like the first 8-seat hosted table's (a Claude Code stream-json transcript, its session record). */
function runFolder(): string {
  const dir = mkdtempSync(join(tmpdir(), 'usage-upload-'));
  const lines = [
    { type: 'system', subtype: 'init', cwd: '/tmp/mtgdt-seat-x/work', session_id: 's1', model: 'claude-haiku-5-5', claude_code_version: '2.1.306', tools: [] },
    { type: 'assistant', message: { model: 'claude-haiku-5-5', content: [{ type: 'text', text: 'PRIVATE REASONING TEXT' }], usage: { input_tokens: 2, cache_creation_input_tokens: 6649, cache_read_input_tokens: 0, output_tokens: 32 } } },
    {
      type: 'result', subtype: 'success', result: 'EVENT COMPLETE', total_cost_usd: 3.97224821, num_turns: 232, duration_ms: 2550299,
      usage: { input_tokens: 464, cache_creation_input_tokens: 545635, cache_read_input_tokens: 69141715, output_tokens: 58135, output_tokens_details: { thinking_tokens: 33362 } },
      modelUsage: { 'claude-haiku-5-5': { inputTokens: 3011, outputTokens: 58152, cacheReadInputTokens: 69141715, cacheCreationInputTokens: 545635, costUSD: 3.97224821 } },
    },
  ];
  writeFileSync(join(dir, 'transcript-seat-0a1b.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  writeFileSync(join(dir, 'harness-seat-0a1b.json'), JSON.stringify({ seat: 'seat-0a1b', harness_version: '2.1.306 (Claude Code)' }));
  // Claude Code's own session record: the effort it ran at.
  const session = [{ type: 'user', message: { role: 'user', content: 'x' } }, { type: 'assistant', effort: 'low', message: { model: 'claude-haiku-5-5', role: 'assistant', content: [] } }];
  writeFileSync(join(dir, 'session-seat-0a1b.jsonl'), session.map((l) => JSON.stringify(l)).join('\n') + '\n');
  // A hand-started seat whose session `bench attach-logs` found.
  writeFileSync(join(dir, 'harness-logs-seat-2c3d.json'), JSON.stringify({
    seat: 'seat-2c3d', status: 'matched', model_ids: ['claude-haiku-5-5', '/home/me/secret.gguf'], model_output_tokens: { 'claude-haiku-5-5': 4000 },
    harness_version: '2.1.306', effort_reported: { level: 'low', counts: { low: 10 }, source: 'claude-session', status: 'tested' },
    facts: [{ store: 'claude-session' }], provenance: { kind: 'cli-local-logs', read_by: 'bench attach-logs 0.1.0', self_attested: true },
  }));
  return dir;
}

test('the CLI summary of a seat it started: model ids, tokens, cost, version and effort only', () => {
  const dir = runFolder();
  const s = seatUploadFromRun(dir, 'seat-0a1b', decl, 'bench play 0.1.0')!;
  assert.equal(s.source, 'launch-transcript');
  assert.deepEqual(s.model_ids, ['claude-haiku-5-5']);
  assert.equal(s.cache_read_tokens, 69141715);
  assert.equal(s.output_tokens, 58135);
  assert.equal(s.cost_usd, 3.9722);
  assert.equal(s.harness_version, '2.1.306');
  assert.equal(s.effort_reported?.level, 'low');
  const text = JSON.stringify(s);
  for (const leak of ['PRIVATE REASONING', '/tmp/', 'EVENT COMPLETE', 'session_id']) assert.ok(!text.includes(leak), `the summary carries ${leak}`);
  assert.equal(validateUsageUpload({ version: 1, event_id: EVENT, seats: [s] }, start).ok, true);
});

test('a hand-started seat: the facts attach-logs found (paths dropped); no logs, nothing to send', () => {
  const dir = runFolder();
  const s = seatUploadFromRun(dir, 'seat-2c3d', decl, 'bench attach-logs 0.1.0')!;
  assert.equal(s.source, 'harness-logs');
  assert.deepEqual(s.model_ids, ['claude-haiku-5-5']);
  assert.equal(s.effort_reported?.level, 'low');
  assert.equal(seatUploadFromRun(dir, 'seat-9999', decl, 'bench play'), undefined);
  assert.equal(seatUploadFromRun(dir, 'seat-0a1b', { ...decl, effort: undefined }, 'bench play'), undefined);
});

test('a Cursor CLI seat: its stream names the model for people, so the registry id of that name is sent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'usage-upload-cursor-'));
  // cursor-agent 2026.10.19 on a hosted table (2026-10-23): the init line's model is a display name with the level.
  writeFileSync(join(dir, 'transcript-seat-5e6f.jsonl'), [
    { type: 'system', subtype: 'init', model: 'GPT-5.6 Luna 272K Low', session_id: 's1' },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } },
    { type: 'result', subtype: 'success', usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 1000, cacheWriteTokens: 50 } },
  ].map((l) => JSON.stringify(l)).join('\n') + '\n');
  const s = seatUploadFromRun(dir, 'seat-5e6f', { harness: 'cursor', model: 'gpt-5.6-luna', effort: 'low' }, 'bench play 0.1.0')!;
  assert.ok(s, 'sent, not dropped for want of an id');
  assert.deepEqual(s.model_ids, ['gpt-5.6-luna']);
  assert.equal(s.effort_reported?.level, 'low');
});

test('validation: a closed, bounded format for this event\'s own agent seats and declarations', () => {
  const s = seatUploadFromRun(runFolder(), 'seat-0a1b', decl, 'bench play 0.1.0')!;
  const up = (seats: unknown[], extra: Record<string, unknown> = {}) => validateUsageUpload({ version: 1, event_id: EVENT, seats, ...extra }, start);
  const err = (r: ReturnType<typeof up>) => (r.ok ? '' : r.error);
  assert.match(err(up([s], { transcript: 'x' })), /unknown field: transcript/);
  assert.match(err(up([{ ...s, prompt: 'x' }])), /seat seat-0a1b: unknown field: prompt/);
  assert.match(err(up([{ ...s, seat: 'bot-1' }])), /not an agent seat/);
  assert.match(err(up([{ ...s, seat: 'seat-ffff' }])), /not an agent seat/);
  assert.match(err(up([s, s])), /listed twice/);
  assert.match(err(up([{ ...s, model: 'claude-opus-5-5' }])), /model "claude-opus-5-5" is not what the seat declared/);
  assert.match(err(up([{ ...s, effort: 'high' }])), /effort "high" is not what the seat declared/);
  assert.match(err(up([{ ...s, output_tokens: -1 }])), /output_tokens must be a whole number/);
  assert.match(err(up([{ ...s, cache_read_tokens: 1.5 }])), /cache_read_tokens must be a whole number/);
  assert.match(err(up([{ ...s, cost_usd: 1e9 }])), /cost_usd must be a number/);
  assert.match(err(up([{ ...s, model_ids: [] }])), /model_ids must list/);
  assert.match(err(up([{ ...s, model_ids: ['x'.repeat(300)] }])), /model_ids must list/);
  assert.match(err(up([{ ...s, harness_version: 'v'.repeat(200) }])), /harness_version/);
  assert.match(err(up([{ ...s, effort_reported: { level: 'turbo', counts: {}, source: 'claude-session' } }])), /effort_reported.level/);
  assert.match(err(up([{ ...s, effort_reported: { level: 'low', counts: {}, source: 'x', text: 'y' } }])), /effort_reported takes/);
  assert.match(err(up([s], { event_id: '2026-10-22-10-18-50-tla-ffff' })), /does not match the event/);
  assert.match(err(validateUsageUpload({ version: 2, event_id: EVENT, seats: [s] }, start)), /version must be 1/);
  assert.match(err(up(Array(9).fill(s))), /1 to 8 seats/);
  // A declared model the registry doesn't know: refused (the upload must check a listed model).
  const odd = { ...start, seats: [{ name: 'seat-0a1b', kind: 'agent', harness: 'claude-code', model: 'my-model', effort: 'low' }] };
  assert.match(err(validateUsageUpload({ version: 1, event_id: EVENT, seats: [{ ...s, model: 'my-model' }] }, odd)), /isn't in the registry/);
});

test('the stored usage file: the summary plus its evidence (self-attested, read on the contributor\'s machine)', () => {
  const s: UploadSeat = seatUploadFromRun(runFolder(), 'seat-0a1b', decl, 'bench play 0.1.0')!;
  const f = usageFileFromUpload(s, 'contributor', '2026-10-22T11:05:00.000Z') as any;
  assert.deepEqual(f.evidence, { kind: 'cli-local-logs', self_attested: true, read_by: 'bench play 0.1.0', via: 'hub-usage-upload', source: 'launch-transcript', uploaded_by: 'contributor', received_at: '2026-10-22T11:05:00.000Z' });
  assert.equal(f.model_declared, 'claude-haiku-5-5');
  assert.equal(f.effort_declared, 'low');
  assert.deepEqual(f.model_ids, ['claude-haiku-5-5']);
  assert.equal(f.model, undefined);
});

console.log(`usage uploads: ${passed} passed`);
