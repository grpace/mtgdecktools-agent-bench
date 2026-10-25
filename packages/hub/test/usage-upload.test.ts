/**
 * Usage uploads for hosted seats (POST /api/usage, src/usage-uploads.ts) against a real Postgres: a contributor sends
 * the usage of the seats at the hosted Private Table they organized, and the export shows those seats Checked Against
 * Logs; strangers, other events, unknown seats, extra fields and floods are refused; the admin token covers admin tables.
 * Who seated a seat (seatedBy) is also checked without a database.
 *
 * Needs HUB_TEST_DATABASE_URL (see contributors-db.test.ts) for the database part.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { UploadSeat } from '../../director/src/usage-upload.js';
import { loadConfig } from '../src/config.js';
import { connect, migrate, type Sql } from '../src/db.js';
import { Hub } from '../src/hub.js';
import { startServer } from '../src/http.js';
import { FsBundleStore } from '../src/store.js';
import { authenticate, createContributor, ensureServiceTokens, issueToken } from '../src/tokens.js';
import { acceptTerms } from '../src/terms.js';
import { seatedBy } from '../src/usage-uploads.js';
import { filesOf, findRun, pack, rewrite } from './helpers.js';

describe('who seated a hosted seat', () => {
  const seats = [{ name: 'seat-a', contributor_id: 7 }, { name: 'seat-b', contributor_id: 8 }];
  test('lobby: each seat its own contributor; the admin token never', () => {
    const start = { table: { kind: 'lobby' }, seats };
    assert.equal(seatedBy(start, 'seat-a', { contributorId: 7 }), true);
    assert.equal(seatedBy(start, 'seat-b', { contributorId: 7 }), false);
    assert.equal(seatedBy(start, 'seat-a', 'admin'), false);
  });
  test('Private Table: its organizer (a contributor), or the admin token for an admin table', () => {
    const mine = { table: { kind: 'private' }, organizer: { kind: 'contributor', contributor_id: 7 }, seats };
    assert.equal(seatedBy(mine, 'seat-b', { contributorId: 7 }), true);
    assert.equal(seatedBy(mine, 'seat-b', { contributorId: 8 }), false);
    assert.equal(seatedBy(mine, 'seat-b', 'admin'), false);
    const admin = { table: { kind: 'private' }, organizer: { kind: 'admin' }, seats };
    assert.equal(seatedBy(admin, 'seat-a', 'admin'), true);
    assert.equal(seatedBy(admin, 'seat-a', { contributorId: 7 }), false);
  });
});

const dbUrl = process.env.HUB_TEST_DATABASE_URL;
const run = findRun((s) => (s.seats ?? []).filter((x: { kind: string }) => x.kind === 'agent').length >= 2);
const skip = !dbUrl ? 'set HUB_TEST_DATABASE_URL (a throwaway Postgres) to run' : !run ? 'no finished run under runs/ or tmp/smoke-runs (or HUB_TEST_RUN)' : false;

const DB = `hub_usage_${process.pid}`;
const SERVICE = 'svc-usage-test-0123456789abcdefghijkl';
const ADMIN = 'hub-admin-usage-test-0123456789';

/** The run as a hosted event of Claude Haiku seats (claude-code, low), with this organizer and event id. */
function hostedEvent(organizer: Record<string, unknown>, id?: string): { files: Map<string, Buffer>; id: string; seats: string[] } {
  let seats: string[] = [];
  let eventId = '';
  // Scripted seats (rand-N) become neutral LLM seat names (seat-<hex>), consistently in every file.
  const raw = filesOf(run!);
  const start0 = JSON.parse(raw.get('events.jsonl')!.toString('utf8').split('\n', 1)[0]!);
  const names = new Map<string, string>(start0.seats.filter((s: { name: string }) => /^rand-\d+$/.test(s.name)).map((s: { name: string }) => [s.name, `seat-${s.name.slice(5).padStart(4, 'a')}`]));
  const renamed = new Map<string, Buffer>();
  for (const [f, b] of raw) {
    let name = f;
    let text = b.toString('utf8');
    for (const [from, to] of names) {
      text = text.replace(new RegExp(`(?<![\\w-])${from}(?![\\w])`, 'g'), to);
      name = name.replace(new RegExp(`-${from}\\.`), `-${to}.`);
    }
    renamed.set(name, Buffer.from(text));
  }
  const files = rewrite(renamed, (events, summary) => {
    const start = events[0]!;
    if (id) {
      for (const e of events) if (e.id === start.id) e.id = id;
      if (summary.id) summary.id = id;
    }
    start.organizer = organizer;
    start.table = { kind: 'private' };
    for (const s of start.seats) if (s.kind === 'agent') Object.assign(s, { harness: 'claude-code', model: 'claude-haiku-5-5', effort: 'low', effort_basis: 'launch' });
    seats = start.seats.filter((s: { kind: string }) => s.kind === 'agent').map((s: { name: string }) => s.name);
    eventId = start.id;
  });
  return { files, id: eventId, seats };
}

const seatUsage = (seat: string, extra: Partial<UploadSeat> = {}): UploadSeat => ({
  seat, harness: 'claude-code', model: 'claude-haiku-5-5', effort: 'low', source: 'launch-transcript', read_by: 'bench play 0.1.0',
  harness_version: '2.1.306', model_ids: ['claude-haiku-5-5'], model_output_tokens: { 'claude-haiku-5-5': 58152 },
  input_tokens: 464, output_tokens: 58135, cache_read_tokens: 69141715, cache_creation_tokens: 545635, cost_usd: 3.9722,
  effort_reported: { level: 'low', counts: { low: 326 }, source: 'claude-session', status: 'tested' }, ...extra,
});

describe('usage uploads (database)', { skip }, () => {
  let sql: Sql;
  let hub: Hub;
  let server: Server;
  let base = '';
  let dataDir = '';
  let aliceToken = '';
  let bobToken = '';
  let mine: ReturnType<typeof hostedEvent>;
  let adminEv: ReturnType<typeof hostedEvent>;

  const post = (body: unknown, token?: string) => fetch(`${base}/api/usage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const verification = (eventId: string, seat: string) => {
    const ev = JSON.parse(readFileSync(join(hub.siteDir, 'events', `${eventId}.json`), 'utf8'));
    return ev.config.seats.find((s: { name: string }) => s.name === seat)?.model_verification;
  };

  before(async () => {
    const admin = connect(dbUrl!, 1);
    await admin.unsafe(`drop database if exists ${DB} with (force)`);
    await admin.unsafe(`create database ${DB}`);
    await admin.end({ timeout: 5 });
    const url = new URL(dbUrl!);
    url.pathname = `/${DB}`;
    sql = connect(url.toString(), 3);
    await migrate(sql);
    dataDir = mkdtempSync(join(tmpdir(), 'hub-usage-'));
    const cfg = loadConfig({ databaseUrl: url.toString(), dataDir, bundleDir: join(dataDir, 'bundles'), host: '127.0.0.1', port: 0, publicUrl: 'http://127.0.0.1', bootstrap: 0, adminToken: ADMIN, usageUploadsPerHour: 12 });
    hub = new Hub(cfg, sql, new FsBundleStore(cfg.bundleDir), () => {});
    await hub.load();
    await ensureServiceTokens(sql, [{ name: 'usage-test', token: SERVICE }]);
    const alice = await createContributor(sql, 'alice', { kind: 'person', trust: 'trusted' });
    const bob = await createContributor(sql, 'bob', { kind: 'person', trust: 'trusted' });
    aliceToken = (await issueToken(sql, alice, 'contributor')).token;
    bobToken = (await issueToken(sql, bob, 'contributor')).token;
    // Uploads need the current terms accepted (src/terms.ts); moderation-db.test.ts covers the refusal.
    for (const id of [alice, bob]) await acceptTerms(sql, id, 'cli');
    const director = (await authenticate(sql, SERVICE, 'ingest'))!;
    mine = hostedEvent({ kind: 'contributor', handle: 'alice', contributor_id: alice });
    adminEv = hostedEvent({ kind: 'admin' }, `${mine.id.slice(0, -4)}beef`);
    for (const e of [mine, adminEv]) {
      const res = await hub.receive(pack(e.files), director, 'director');
      if (res.body.status === 'held') await hub.approve(Number(res.body.submission_id), 'test');
      else assert.equal(res.body.status, 'ingested', JSON.stringify(res.body));
    }
    await hub.idle();
    server = startServer(hub);
    await new Promise<void>((r) => server.once('listening', () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    server?.close();
    await sql?.end({ timeout: 5 });
    const admin = connect(dbUrl!, 1);
    await admin.unsafe(`drop database if exists ${DB} with (force)`).catch(() => {});
    await admin.end({ timeout: 5 });
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  test('before the upload, hosted seats are Self-Reported', () => {
    assert.equal(verification(mine.id, mine.seats[0]!)?.label, 'Self-Reported');
  });

  test('the organizer uploads; the export shows the seat Checked Against Logs, read on the contributor\'s machine', async () => {
    const r = await post({ version: 1, event_id: mine.id, seats: [seatUsage(mine.seats[0]!)] }, aliceToken);
    const body = await r.json() as any;
    assert.equal(r.status, 200, JSON.stringify(body));
    assert.deepEqual(body.seats, { [mine.seats[0]!]: 'stored' });
    assert.equal(body.model_check[mine.seats[0]!], 'verified');
    assert.equal(body.applied, 'now');
    await hub.idle();
    const v = verification(mine.id, mine.seats[0]!);
    assert.equal(v.label, 'Checked Against Logs');
    assert.equal(v.logs_read_by, 'contributor-cli');
    assert.equal(verification(mine.id, mine.seats[1]!)?.label, 'Self-Reported', 'only the seat sent');
    const file = JSON.parse(readFileSync(join(hub.runsDir, mine.id, `usage-${mine.seats[0]}.json`), 'utf8'));
    assert.deepEqual([file.evidence.kind, file.evidence.self_attested, file.evidence.uploaded_by], ['cli-local-logs', true, 'contributor']);
    const [row] = await sql`select uploaded_by, contributor_id from seat_usage where event_id = ${mine.id}`;
    assert.equal(row!.uploaded_by, 'contributor');
  });

  test('the same upload again changes nothing; a new summary from the same sender replaces it', async () => {
    const same = await (await post({ version: 1, event_id: mine.id, seats: [seatUsage(mine.seats[0]!)] }, aliceToken)).json() as any;
    assert.deepEqual([same.seats[mine.seats[0]!], same.applied], ['unchanged', 'unchanged']);
    const again = await (await post({ version: 1, event_id: mine.id, seats: [seatUsage(mine.seats[0]!, { output_tokens: 60000 })] }, aliceToken)).json() as any;
    assert.equal(again.seats[mine.seats[0]!], 'replaced');
    await hub.idle();
  });

  test('refused: another contributor, no token, an admin token on a contributor\'s table, unknown seats and fields, unknown events', async () => {
    const body = { version: 1, event_id: mine.id, seats: [seatUsage(mine.seats[1]!)] };
    assert.equal((await post(body, bobToken)).status, 403);
    assert.equal((await post(body)).status, 401);
    assert.equal((await post(body, ADMIN)).status, 403);
    assert.equal((await post({ ...body, seats: [seatUsage('seat-nobody')] }, aliceToken)).status, 422);
    assert.equal((await post({ ...body, seats: [{ ...seatUsage(mine.seats[1]!), transcript: 'x' }] }, aliceToken)).status, 422);
    assert.equal((await post({ ...body, seats: [seatUsage(mine.seats[1]!, { model: 'claude-opus-5-5' })] }, aliceToken)).status, 422);
    const unknown = await post({ ...body, event_id: '2020-01-01-00-00-00-fra-0000' }, aliceToken);
    assert.equal(unknown.status, 404);
    assert.equal(((await unknown.json()) as any).retry_after_s, 60);
    assert.equal((await post('{not json', aliceToken)).status, 400);
    assert.equal((await post('x'.repeat(40 * 1024), aliceToken)).status, 413);
    assert.equal(verification(mine.id, mine.seats[1]!)?.label, 'Self-Reported');
  });

  test('the Hub admin token covers admin-organized tables; a contributor can\'t', async () => {
    const body = { version: 1, event_id: adminEv.id, seats: [seatUsage(adminEv.seats[0]!)] };
    assert.equal((await post(body, aliceToken)).status, 403);
    const r = await post(body, ADMIN);
    assert.equal(r.status, 200, await r.clone().text());
    await hub.idle();
    assert.equal(verification(adminEv.id, adminEv.seats[0]!)?.label, 'Checked Against Logs');
    const [row] = await sql`select uploaded_by, contributor_id from seat_usage where event_id = ${adminEv.id}`;
    assert.deepEqual([row!.uploaded_by, row!.contributor_id], ['admin', null]);
  });

  test('re-ingest and a fresh data volume keep the uploaded usage', async () => {
    await hub.reingest([mine.id]);
    rmSync(join(hub.runsDir, mine.id), { recursive: true, force: true });
    await hub.sync(mine.id);
    await hub.idle();
    assert.equal(verification(mine.id, mine.seats[0]!)?.label, 'Checked Against Logs');
  });

  test('rate limited per sender', async () => {
    const body = { version: 1, event_id: mine.id, seats: [seatUsage(mine.seats[0]!, { output_tokens: 60000 })] };
    let limited = false;
    for (let i = 0; i < 10 && !limited; i++) limited = (await post(body, aliceToken)).status === 429;
    assert.ok(limited, 'alice was never limited');
  });
});
