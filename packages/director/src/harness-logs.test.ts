// Finding a hand-seated seat's harness session on this machine (harness-logs.ts), on a fake home with every store
// type. Fixture shapes follow real files checked on 2026-10-22 (Claude Code 2.1.306 session files, OpenCode 2.1.2
// session_v2/session_message, the cursor-agent SDK store, Antigravity conversation DBs, T3 Code provider logs).
//   npx tsx packages/director/src/harness-logs.test.ts
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readdirSync } from 'node:fs';
import { attachHarnessLogs, cleanId, findSeatSessions, needFor, seatSnippets } from './harness-logs.js';
import { detectSeatEffort } from './effort-detect.js';
import { registry } from '../../registry/src/index.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
const root = mkdtempSync(join(tmpdir(), 'mtgdt-hlogs-'));
const home = join(root, 'home');
const T0 = Date.now() - 3600_000;
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
const jsonl = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';

// One event, several seats; each seat saw its own decision texts (eight decisions each).
const run = join(root, 'runs', 'ev-1');
mkdirSync(run, { recursive: true });
const seats = ['cc', 'oc', 'cu', 'ag', 'ag4', 't3', 't3g', 'none', 'shared', 'few', 'twisted', 'other-ev'];
const N = 8;
const lineFor = (seat: string, i: number) => `Turn ${i}: Opponent controls Grizzly Bears ${seat}-${i} and Llanowar Elves (2/2)`;
const ev = [
  { t: T0, type: 'event_start', id: 'ev-1', set: { code: 'FRA', name: 'x' }, seats: seats.map((name, position) => ({ name, kind: 'agent', position })) },
  ...Array.from({ length: N }, (_, k) => k + 1).flatMap((i) => seats.map((seat) => ({ t: T0 + i, type: 'decision_offered', seat, game: 'g1', id: `G${i}`, kind: 'play', turn: i, text: `DECISION G${i}\n${lineFor(seat, i)}\nYour options:\n  1. Pass priority and do nothing at all` }))),
];
writeFileSync(join(run, 'events.jsonl'), jsonl(ev));
/** The seat's lines `from`..`to`, in order, as they appear inside a JSON string. */
const said = (seat: string, from = 1, to = 6) => Array.from({ length: to - from + 1 }, (_, k) => lineFor(seat, from + k)).join('\\n...');

// Another event in the same runs folder, a little earlier.
const run2 = join(root, 'runs', 'ev-0');
mkdirSync(run2, { recursive: true });
const line2 = (i: number) => `Turn ${i}: Opponent controls Serra Angel x${i} and a Mountain, untapped (4/4)`;
writeFileSync(join(run2, 'events.jsonl'), jsonl([
  { t: T0 - 600_000, type: 'event_start', id: 'ev-0', seats: [{ name: 'p', kind: 'agent', position: 0 }] },
  ...Array.from({ length: N }, (_, k) => ({ t: T0 - 500_000 + k, type: 'decision_offered', seat: 'p', id: `G${k}`, text: `DECISION\n${line2(k + 1)}` })),
]));

// Claude Code session (per-account config dir, as T3 Code sets it).
const proj = join(home, '.claude-accounts', 'other', 'projects', '-tmp-seat');
mkdirSync(proj, { recursive: true });
writeFileSync(join(proj, 'sess-1.jsonl'), jsonl([
  { type: 'user', version: '2.1.306', message: { content: [{ type: 'tool_result', content: `x ${said('cc')} y` }] } },
  ...Array.from({ length: 4 }, () => ({ type: 'assistant', entrypoint: 'sdk-ts', effort: 'xhigh', perTurnEffort: 'xhigh', version: '2.1.306', message: { model: 'claude-opus-5-5', usage: { output_tokens: 100 } } })),
]));
// Another conversation of the user's, not this seat.
writeFileSync(join(proj, 'other.jsonl'), jsonl([{ type: 'assistant', effort: 'low', version: '2.1.306', message: { model: 'claude-haiku-5-5', content: 'unrelated' } }]));
// A supervising session (a coding agent that read events.jsonl): every seat's lines. It must never count as a seat's.
writeFileSync(join(proj, 'supervisor.jsonl'), jsonl([
  { type: 'user', version: '2.1.306', message: { content: [{ type: 'tool_result', content: seats.map((x) => said(x, 1, N)).join(' ') }] } },
  { type: 'assistant', effort: 'max', version: '2.1.306', message: { model: 'claude-fable-5-1', usage: { output_tokens: 5 } } },
]));
// 'few': only two of its lines (the old threshold matched this). 'twisted': its lines, but in reverse order.
writeFileSync(join(proj, 'few.jsonl'), jsonl([{ type: 'user', message: { content: said('few', 1, 2) } }, { type: 'assistant', message: { model: 'claude-haiku-5-5' } }]));
writeFileSync(join(proj, 'twisted.jsonl'), jsonl([
  ...Array.from({ length: N }, (_, k) => ({ type: 'user', message: { content: lineFor('twisted', N - k) } })), { type: 'assistant', message: { model: 'claude-haiku-5-5' } },
]));
// 'other-ev': its lines, plus another event's (a session that played two events).
writeFileSync(join(proj, 'two-events.jsonl'), jsonl([
  { type: 'user', message: { content: `${Array.from({ length: N }, (_, k) => line2(k + 1)).join(' ')} ${said('other-ev', 1, N)}` } }, { type: 'assistant', message: { model: 'claude-haiku-5-5' } },
]));


// OpenCode 2.x database.
mkdirSync(join(home, '.local', 'share', 'opencode'), { recursive: true });
{
  const db = new DatabaseSync(join(home, '.local', 'share', 'opencode', 'opencode.db'));
  db.exec(`create table session_v2 (id text primary key, model text, version text, tokens_input int, tokens_output int, tokens_reasoning int, tokens_cache_read int, title text);
           create table session_message (id text primary key, session_id text, type text, seq int, time_created int, time_updated int, data text);`);
  db.prepare('insert into session_v2 values (?,?,?,?,?,?,?,?)').run('ses_a', JSON.stringify({ id: 'claude-opus-5-5', providerID: 'anthropic', variant: 'max' }), '2.1.2', 10, 20, 30, 5, 'private title');
  for (let i = 1; i <= 6; i++) db.prepare('insert into session_message values (?,?,?,?,?,?,?)').run(`t${i}`, 'ses_a', 'tool', i, Date.now() + i, Date.now() + i, JSON.stringify({ output: lineFor('oc', i) }));
  for (const i of [7, 8]) db.prepare('insert into session_message values (?,?,?,?,?,?,?)').run(`m${i}`, 'ses_a', 'assistant', i, Date.now() + i, Date.now() + i, JSON.stringify({ model: { id: 'claude-opus-5-5', providerID: 'anthropic', variant: 'max' } }));
  db.close();
}

// Cursor SDK store.
const cdir = join(home, '.cursor', 'projects', 'p', 'sdk-agent-store', 'h', 'agents', 'a');
mkdirSync(cdir, { recursive: true });
{
  const db = new DatabaseSync(join(cdir, 'store.db'));
  db.exec('create table blobs (id text, data blob); create table meta (key text, value text);');
  db.prepare('insert into blobs values (?, ?)').run('b1', Buffer.from(JSON.stringify({ providerOptions: { cursor: { modelName: 'claude-opus-5-5-high-fast' } } })));
  db.prepare('insert into blobs values (?, ?)').run('b2', Buffer.from(`tool: ${said('cu', 1, 4)}`));
  db.close();
}

// Antigravity conversation (under T3 Code): protobuf-ish blobs with the model id + level.
const adir = join(home, '.t3', 'userdata', 'providers', 'antigravity', 'abc', 'antigravity-acp', 'conversations');
mkdirSync(adir, { recursive: true });
{
  const db = new DatabaseSync(join(adir, 'conv.db'));
  db.exec('create table steps (idx int, metadata blob, step_payload blob); create table gen_metadata (idx int, data blob, size int);');
  db.prepare('insert into steps values (?,?,?)').run(1, Buffer.from('\x0agemini-3.8-flash-mediumh\x12'), Buffer.from(`${lineFor('ag', 1)}\x00${lineFor('ag', 3)}\x00${lineFor('ag', 5)}`));
  db.prepare('insert into gen_metadata values (?,?,?)').run(1, Buffer.from('\x0agemini-3.8-flash-medium\x10'), 1);
  db.close();
}
{
  // Gemini 4 Argon: the T3 Code catalog's gemini-4-argon-high.
  const db = new DatabaseSync(join(adir, 'conv4.db'));
  db.exec('create table steps (idx int, metadata blob, step_payload blob);');
  db.prepare('insert into steps values (?,?,?)').run(1, Buffer.from('\x0agemini-4-argon-high\x12'), Buffer.from(`${lineFor('ag4', 1)}\x00${lineFor('ag4', 3)}\x00${lineFor('ag4', 5)}`));
  db.close();
}

// T3 Code provider log: two threads share one (truncated-name) file.
const tdir = join(home, '.t3', 'userdata', 'logs', 'provider');
mkdirSync(tdir, { recursive: true });
const thread = '11111111-2222-3333-4444-555555555555';
const otherThread = '99999999-2222-3333-4444-555555555555';
const line = (th: string, payload: unknown) => `[2026-10-22T04:00:00.000Z] NTIVE: ${JSON.stringify({ provider: 'cursor', protocol: 'cursor-agent-sdk.local', kind: 'protocol', providerSessionId: `provider-session:provider-instance:cursor:thread:${th}:x`, event: { direction: 'outgoing', payload } })}`;
writeFileSync(join(tdir, 'events.11111111-2222.log'), [
  line(thread, { method: 'run.start', options: { model: { id: 'grok-4.7', params: [{ id: 'reasoning_effort', value: 'xhigh' }, { id: 'fast', value: 'true' }] } } }),
  line(thread, { type: 'tool_result', text: said('t3') }),
  line(thread, { type: 'interaction.update', update: { type: 'turn-ended', usage: { outputTokens: 70, reasoningTokens: 30 } } }),
  line(otherThread, { method: 'run.start', options: { model: { id: 'gpt-x', params: [{ id: 'reasoning_effort', value: 'low' }] } } }),
].join('\n') + '\n');
// A GPT model through Cursor: its level parameter is `reasoning` (T3 Code's Cursor catalog), with Cursor's "extra-high".
const gptThread = '77777777-2222-3333-4444-555555555555';
writeFileSync(join(tdir, 'events.77777777-2222.log'), [
  line(gptThread, { method: 'run.start', options: { model: { id: 'gpt-5.5', params: [{ id: 'reasoning', value: 'extra-high' }, { id: 'fast', value: 'false' }] } } }),
  line(gptThread, { type: 'tool_result', text: said('t3g') }),
].join('\n') + '\n');

const o = { home, env: {} as NodeJS.ProcessEnv };
const scanDir = join(home, '.cache', 'mtgdt-bench', 'scan');

try {
  check('snippets: lines only this seat saw, safe to find inside JSON; a quarter (3 or more) needed', () => {
    const s = seatSnippets(ev, 'cc');
    assert.deepEqual(s, Array.from({ length: N }, (_, k) => lineFor('cc', k + 1)));
    assert.ok(!s.some((x) => x.includes('Pass priority')), 'lines every seat saw are left out');
    assert.deepEqual([needFor(2), needFor(8), needFor(32)], [Infinity, 3, 8]);
  });

  check('a supervising session holding every seat\'s lines is set aside, never merged', () => {
    const r = findSeatSessions(run, 'shared', o);
    assert.equal(r.status, 'ambiguous');
    assert.deepEqual(r.facts, []);
    assert.deepEqual(r.model_ids, []);
    assert.ok(r.rejected.some((x) => x.store === 'claude-session' && x.reason === 'other seats'));
    // And it doesn't add its model to a seat that has its own session.
    assert.ok(!findSeatSessions(run, 'cc', o).model_ids.includes('claude-fable-5-1'));
  });

  check('two of eight lines is not a match; lines out of order are set aside', () => {
    const few = findSeatSessions(run, 'few', o);
    assert.deepEqual([few.facts.length, few.rejected.map((x) => x.reason)], [0, ['other seats']], 'only the supervisor is a candidate');
    const t = findSeatSessions(run, 'twisted', o);
    assert.deepEqual([t.status, t.facts.length], ['ambiguous', 0]);
    assert.ok(t.rejected.some((x) => x.reason === 'out of order'));
  });

  check("a session holding another event's decision text is set aside (otherEvents)", () => {
    assert.equal(findSeatSessions(run, 'other-ev', o).facts.length, 1, 'without the other event it matches');
    const r = findSeatSessions(run, 'other-ev', { ...o, otherEvents: [run2] });
    assert.deepEqual([r.status, r.facts.length], ['ambiguous', 0]);
    assert.ok(r.rejected.some((x) => x.reason === 'another event'));
  });

  check('ids only: paths and free text from a store never become a model id or version', () => {
    assert.equal(cleanId('claude-opus-5-5'), 'claude-opus-5-5');
    assert.equal(cleanId('anthropic/claude-sonnet-5-5'), 'anthropic/claude-sonnet-5-5');
    for (const bad of ['/Users/alice/models/x.gguf', '~/m', 'local/home/x', 'a b', 'x'.repeat(81), '/home/bob/llm/', 'models/q.gguf', 'a//b']) assert.equal(cleanId(bad), undefined, bad);
  });

  check('Claude Code session under a per-account config dir', () => {
    const r = findSeatSessions(run, 'cc', o);
    assert.equal(r.facts.length, 1);
    assert.deepEqual([r.facts[0]!.store, r.facts[0]!.model, r.facts[0]!.harness_version], ['claude-session', 'claude-opus-5-5', '2.1.306']);
    assert.deepEqual(r.effort_reported, { level: 'xhigh', counts: { xhigh: 4 }, source: 'claude-session', status: 'tested' });
    assert.deepEqual(r.model_output_tokens, { 'claude-opus-5-5': 400 });
  });

  check('OpenCode database: variant, version and tokens (read from a copy)', () => {
    const r = findSeatSessions(run, 'oc', o);
    assert.equal(r.facts.length, 1);
    const f = r.facts[0]!;
    assert.deepEqual([f.store, f.model, f.harness_version, f.effort?.level], ['opencode-db', 'anthropic/claude-opus-5-5', '2.1.2', 'max']);
    assert.deepEqual(f.tokens, { input: 10, output: 20, reasoning: 30, cache_read: 5 });
  });

  check('Cursor SDK store: level and fast mode from the model name', () => {
    const r = findSeatSessions(run, 'cu', o);
    assert.deepEqual([r.facts[0]?.store, r.facts[0]?.model, r.effort_reported?.level, r.effort_reported?.fast], ['cursor-sdk-store', 'claude-opus-5-5', 'high', true]);
  });

  check('Antigravity conversation DB: level from the model id', () => {
    const r = findSeatSessions(run, 'ag', o);
    assert.deepEqual([r.facts[0]?.store, r.facts[0]?.model, r.effort_reported?.level], ['antigravity-db', 'gemini-3.8-flash-medium', 'medium']);
  });

  check('Antigravity: gemini-4-argon-high gives the level and resolves to Gemini 4 Argon', () => {
    const r = findSeatSessions(run, 'ag4', o);
    assert.deepEqual([r.facts[0]?.store, r.facts[0]?.model, r.effort_reported?.level], ['antigravity-db', 'gemini-4-argon-high', 'high']);
    assert.equal(registry.verifySeatModel({ model: 'gemini-4-argon-high', harness: 't3-code:antigravity' }, { model_ids: r.model_ids }).status, 'verified');
  });

  check('T3 Code provider log: a Cursor GPT model\'s level is its `reasoning` parameter', () => {
    const r = findSeatSessions(run, 't3g', o);
    assert.deepEqual([r.facts[0]?.store, r.facts[0]?.model, r.effort_reported?.level, r.effort_reported?.fast], ['t3-log', 'gpt-5.5', 'xhigh', undefined]);
  });

  check('T3 Code provider log: only the matching thread of a shared file', () => {
    const r = findSeatSessions(run, 't3', o);
    assert.equal(r.facts.length, 1);
    assert.deepEqual([r.facts[0]!.store, r.facts[0]!.model, r.effort_reported?.level, r.effort_reported?.fast], ['t3-log', 'grok-4.7', 'xhigh', true]);
    assert.deepEqual(r.facts[0]!.tokens, { output: 70, reasoning: 30 });
  });

  check('SQLite snapshots: none left in the scan folder; stores over the size cap are skipped and listed', () => {
    findSeatSessions(run, 'oc', o);
    assert.deepEqual(readdirSync(scanDir), []);
    assert.equal(statSync(scanDir).mode & 0o777, 0o700);
    const r = findSeatSessions(run, 'oc', { ...o, maxDbBytes: 10 });
    assert.deepEqual([r.facts.length, r.rejected.find((x) => x.store === 'opencode-db')?.reason], [0, 'too large']);
  });

  check('provenance: read from this machine by the CLI, self-attested', () => {
    const r = findSeatSessions(run, 'cc', { ...o, readBy: 'bench attach-logs 0.1.0' });
    assert.deepEqual(r.provenance, { kind: 'cli-local-logs', read_by: 'bench attach-logs 0.1.0', self_attested: true, stores: ['claude-session'] });
    assert.equal(r.status, 'matched');
  });

  check('no session, no facts; nothing private is written', () => {
    assert.deepEqual(findSeatSessions(run, 'none', o).facts, []);
    const written = attachHarnessLogs(run, { ...o, seats: ['cc', 'oc'] });
    assert.equal(written.length, 2);
    const file = join(run, 'harness-logs-oc.json');
    assert.equal(statSync(file).mode & 0o777, 0o600);
    const text = readFileSync(file, 'utf8');
    for (const secret of ['private title', 'Grizzly', home, 'ses_a', 'unrelated', 'Serra']) assert.ok(!text.includes(secret), `leaked ${secret}`);
    // Bundles and the export read it through detectSeatEffort.
    const d = detectSeatEffort(run, 'oc', 'opencode');
    assert.deepEqual([d?.level, d?.source, d?.harness_version], ['max', 'opencode-db', '2.1.2']);
  });
} finally {
  rmSync(root, { recursive: true, force: true });
}

if (failed) {
  console.log(`\n${failed} harness-log test(s) failed`);
  process.exit(1);
}
console.log('\nharness logs: all passed');
