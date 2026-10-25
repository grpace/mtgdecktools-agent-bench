// Usage uploads after a hosted event (usage-upload.ts): which events, which token, what is sent, and the retries while
// the Hub doesn't have the event yet. The Hub side is packages/hub/test/usage-upload.test.ts.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { HOSTED_DIRECTOR_URL, type LocalEvent } from '../core.js';
import { handedToHub, hubAdminToken, sendUsage, uploadHostedUsage, usageBody } from '../usage-upload.js';

const EVENT = '2026-10-22-10-18-50-tla-8a85';
const ev = (extra: Partial<LocalEvent> = {}): LocalEvent => ({
  id: EVENT, director: HOSTED_DIRECTOR_URL, hosted: true, seats: { 'seat-0a1b': 'x', 'seat-2c3d': 'y' },
  meta: { 'seat-0a1b': { harness: 'claude-code', model: 'claude-haiku-5-5', effort: 'low' }, 'seat-2c3d': { harness: 'claude-code', model: 'claude-haiku-5-5', effort: 'low' } },
  ...extra,
});

/** A run folder of a hosted event as `bench play` leaves it: event.json, a transcript per seat it started. */
function runFolder(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bench-usage-'));
  const lines = [
    { type: 'system', subtype: 'init', cwd: '/tmp/x', session_id: 's', model: 'claude-haiku-5-5', claude_code_version: '2.1.306' },
    { type: 'result', subtype: 'success', result: 'EVENT COMPLETE', total_cost_usd: 3.97, usage: { input_tokens: 464, cache_read_input_tokens: 69141715, cache_creation_input_tokens: 545635, output_tokens: 58135 }, modelUsage: { 'claude-haiku-5-5': { outputTokens: 58152 } } },
  ];
  writeFileSync(join(dir, 'transcript-seat-0a1b.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return dir;
}

let server: Server;
let hub = '';
const calls: Array<{ auth: string; body: any }> = [];
let answers: Array<[number, unknown]> = [];
before(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      calls.push({ auth: String(req.headers.authorization), body: JSON.parse(raw) });
      const [code, body] = answers.shift() ?? [500, { error: 'no answer' }];
      res.writeHead(code, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
    });
  }).listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', () => r()));
  hub = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

test('only events on a hosted Director that hands them to the Hub', () => {
  assert.equal(handedToHub(ev()), true);
  assert.equal(handedToHub(ev({ director: 'http://127.0.0.1:8787' })), false);
  assert.equal(handedToHub(ev({ director: 'https://someone-elses-director.example' })), false);
  assert.equal(handedToHub(ev({ director: undefined })), false);
});

test('the Hub admin token goes only to an official Hub', () => {
  const home = mkdtempSync(join(tmpdir(), 'bench-home-'));
  assert.equal(hubAdminToken('https://agent-bench-hub.dev.greg.tech', { HUB_ADMIN_TOKEN: 'h' }, home), 'h');
  assert.equal(hubAdminToken('https://evil.example', { HUB_ADMIN_TOKEN: 'h' }, home), undefined);
  assert.equal(hubAdminToken('https://agent-bench-hub.dev.greg.tech', {}, home), undefined);
  rmSync(home, { recursive: true, force: true });
});

test('the body: only seats with harness usage here, each with the seat\'s declaration', () => {
  const dir = runFolder();
  const { body, missing } = usageBody(dir, ev(), ['seat-0a1b', 'seat-2c3d'], 'bench play test');
  assert.deepEqual(missing, ['seat-2c3d']);
  assert.equal(body.version, 1);
  assert.equal(body.event_id, EVENT);
  assert.deepEqual(body.seats.map((s) => [s.seat, s.model, s.effort, s.cache_read_tokens]), [['seat-0a1b', 'claude-haiku-5-5', 'low', 69141715]]);
  assert.ok(!JSON.stringify(body).includes('EVENT COMPLETE'));
  rmSync(dir, { recursive: true, force: true });
});

test('sendUsage retries while the Hub hasn\'t received the event (404), then stops at a final answer', async () => {
  calls.length = 0;
  answers = [[404, { error: 'not yet', retry_after_s: 60 }], [200, { seats: { 'seat-0a1b': 'stored' } }]];
  const ok = await sendUsage(hub, 'tok', { version: 1, event_id: EVENT, seats: [] }, { retryMs: 10, waitMs: 5000 });
  assert.deepEqual([ok.ok, ok.status, ok.attempts], [true, 200, 2]);
  assert.equal(calls[0]!.auth, 'Bearer tok');
  answers = [[403, { error: 'not seated by you' }]];
  const no = await sendUsage(hub, 'tok', { version: 1, event_id: EVENT, seats: [] }, { retryMs: 10, waitMs: 5000 });
  assert.deepEqual([no.ok, no.status, no.attempts], [false, 403, 1]);
  answers = [[404, {}], [404, {}], [404, {}]];
  const late = await sendUsage(hub, 'tok', { version: 1, event_id: EVENT, seats: [] }, { retryMs: 30, waitMs: 50 });
  assert.equal(late.ok, false);
  assert.ok(late.attempts <= 3);
});

test('a Hub that doesn\'t know the per-request fields yet: sent again with only the fields it knows', async () => {
  calls.length = 0;
  const seat = {
    seat: 'seat-0a1b', harness: 'claude-code', model: 'claude-haiku-5-5', effort: 'low', source: 'launch-transcript' as const, read_by: 'x', model_ids: ['claude-haiku-5-5'],
    input_tokens: 1, requests: 3, cache_creation_1h_tokens: 5, long_context: { above: 100000, requests: 1, input_tokens: 1, output_tokens: 1, cache_read_tokens: 1, cache_creation_tokens: 1, cache_creation_1h_tokens: 1 },
  };
  answers = [[400, { error: 'seat seat-0a1b: unknown fields: cache_creation_1h_tokens, requests, long_context (only the model, effort, harness version and token counts)' }], [200, { seats: { 'seat-0a1b': 'stored' } }]];
  const r = await sendUsage(hub, 'tok', { version: 1, event_id: EVENT, seats: [seat] }, { retryMs: 10, waitMs: 5000 });
  assert.deepEqual([r.ok, r.legacy, r.attempts], [true, true, 2]);
  assert.deepEqual(Object.keys(calls[1]!.body.seats[0]).sort(), ['effort', 'harness', 'input_tokens', 'model', 'model_ids', 'read_by', 'seat', 'source']);
  // Another 400 is final.
  answers = [[400, { error: 'seats must list 1 to 8 seats' }]];
  const no = await sendUsage(hub, 'tok', { version: 1, event_id: EVENT, seats: [] }, { retryMs: 10, waitMs: 5000 });
  assert.deepEqual([no.ok, no.attempts], [false, 1]);
});

test('after a hosted event: the contributor token, the seats this machine started, and a record in the run folder', async () => {
  const dir = runFolder();
  calls.length = 0;
  answers = [[200, { seats: { 'seat-0a1b': 'stored' }, model_check: { 'seat-0a1b': 'verified' }, applied: 'now' }]];
  const out = await uploadHostedUsage(dir, ev(), ['seat-0a1b', 'seat-2c3d'], { readBy: 'bench play test', hub, token: 'contrib-token', quiet: true });
  assert.deepEqual(out, { 'seat-0a1b': 'stored' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.auth, 'Bearer contrib-token');
  assert.deepEqual(calls[0]!.body.seats.map((s: { seat: string }) => s.seat), ['seat-0a1b']);
  assert.equal(JSON.parse(readFileSync(join(dir, 'usage-upload.json'), 'utf8')).ok, true);
  // An own table (a local Director): nothing is sent.
  calls.length = 0;
  assert.deepEqual(await uploadHostedUsage(dir, ev({ director: 'http://127.0.0.1:8787' }), ['seat-0a1b'], { readBy: 'x', hub, token: 't', quiet: true }), {});
  assert.equal(calls.length, 0);
  rmSync(dir, { recursive: true, force: true });
});
