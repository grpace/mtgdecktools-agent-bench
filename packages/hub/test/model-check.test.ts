// Model identity checks on a bundle (METHODOLOGY §2.1): Verified, Mismatch (warned, excluded from rating at export),
// Self-Reported and Unlisted (info).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { modelChecks } from '../src/checks.js';

const T = Date.parse('2026-10-22T12:00:00Z');
const start = (seats: Array<Record<string, string>>) => [{ t: T, type: 'event_start', seats: seats.map((s, i) => ({ kind: 'agent', position: i, ...s })) }];
const usage = (o: unknown) => Buffer.from(JSON.stringify(o));

test('verified: the primary model (helpers ignored) matches the declared one', () => {
  const ev = start([{ name: 'son', harness: 'claude-code', model: 'claude-sonnet-5-5', model_declared: 'sonnet' }]);
  const files = new Map([['usage-son.json', usage({ model_ids: ['claude-sonnet-5-5', 'claude-haiku-5-5'], model_output_tokens: { 'claude-sonnet-5-5': 900, 'claude-haiku-5-5': 19 } })]]);
  const [c, ...rest] = modelChecks(ev as never, files);
  assert.equal(c!.outcome, 'pass');
  assert.match(c!.message, /Verified Model/);
  assert.equal(rest.length, 0);
});

test('mismatch: warned with the reason', () => {
  const ev = start([{ name: 'op', harness: 'claude-code', model: 'claude-opus-5-5' }]);
  const files = new Map([['usage-op.json', usage({ model_ids: ['claude-sonnet-5-5'] })]]);
  const [c] = modelChecks(ev as never, files);
  assert.equal(c!.outcome, 'warn');
  assert.match(c!.message, /op: declared claude-opus-5-5, but the harness usage shows claude-sonnet-5-5.*excluded from rating/);
});

test('self-reported and unlisted seats are recorded as info', () => {
  const ev = start([
    { name: 'a', harness: 'codex', model: 'gpt-6-astra' },
    { name: 'b', harness: 'claude-code', model: 'my-finetune' },
    { name: 'c', harness: 'zed-agent', model: 'claude-opus-5-5' },
  ]);
  const checks = modelChecks(ev as never, new Map([['usage-a.json', usage({ model_ids: [] })]]));
  assert.equal(checks[0]!.outcome, 'skip');
  const info = checks.find((x) => x.id === 'identity.registry')!;
  assert.equal(info.class, 'info');
  assert.match(info.message, /a: Self-Reported/);
  assert.match(info.message, /b: Unlisted/);
  assert.match(info.message, /c: Unlisted \(harness "zed-agent"/);
});

test('effort: confirmed by the logs, a mismatch, and Unknown', async () => {
  const { effortChecks } = await import('../src/checks.js');
  const ev = start([
    { name: 'ok', harness: 'claude-code', model: 'claude-opus-5-5', effort: 'high', effort_basis: 'launch' },
    { name: 'off', harness: 'claude-code', model: 'claude-opus-5-5', effort: 'high', effort_basis: 'launch' },
    { name: 'unk', harness: 'claude-code', model: 'claude-opus-5-5', effort: 'default' },
  ]);
  const files = new Map([
    ['usage-ok.json', usage({ model_ids: ['claude-opus-5-5'], harness_version: '2.1.306', effort_reported: { level: 'high', counts: { high: 9 }, source: 'claude-session' } })],
    ['usage-off.json', usage({ model_ids: ['claude-opus-5-5'], effort_reported: { level: 'low', counts: { low: 9 }, source: 'claude-session' } })],
  ]);
  const [c, info] = effortChecks(ev as never, files);
  assert.equal(c!.outcome, 'warn');
  assert.match(c!.message, /off: declared high, but the harness logs \(claude-session\) show low/);
  assert.equal(info!.id, 'identity.effort');
  assert.match(info!.message, /unk: unknown \(Unknown\)/);
});
