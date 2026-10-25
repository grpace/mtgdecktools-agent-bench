/**
 * Agent-written text with bytes Postgres can't store (NUL, lone UTF-16 surrogates) and terminal controls (ANSI escapes,
 * bidi overrides), in a hosted Director's hand-off: the event must still be ingested, never stuck as a 500 that every
 * hand-off retry repeats (HUB-22). Postgres refuses NUL in text and jsonb and lone surrogates in jsonb; src/db.ts
 * cleans every text and JSON parameter. Also: the log-line cap and terminal-safe output (src/logsafe.ts, HUB-24).
 *
 * The database part needs HUB_TEST_DATABASE_URL (see contributors-db.test.ts).
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { connect as tcp } from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { loadConfig } from '../src/config.js';
import { connect, migrate, pgSafe, type Sql } from '../src/db.js';
import { Hub } from '../src/hub.js';
import { startServer } from '../src/http.js';
import { capLine, termSafe } from '../src/logsafe.js';
import { FsBundleStore } from '../src/store.js';
import { authenticate, ensureServiceTokens } from '../src/tokens.js';
import { filesOf, findRun, pack, rewrite } from './helpers.js';

const HOSTILE = 'ok\u0000nul \ud800lone \u001b[31mred\u001b[0m \u202eevil\u202c \u0007bell';

describe('text cleaning (no database)', () => {
  test('pgSafe drops NUL and repairs lone surrogates, deeply, keys too', () => {
    assert.equal(pgSafe('a\u0000b\ud800c'), 'ab\ufffdc');
    assert.deepEqual(pgSafe({ ['k\u0000']: ['x\u0000', { y: '\udfff' }], n: 3, b: true, z: null }), { k: ['x', { y: '\ufffd' }], n: 3, b: true, z: null });
    // A literal backslash-u text is not a NUL: kept as is.
    assert.equal(pgSafe('\\u0000'), '\\u0000');
  });
  test('termSafe strips terminal controls and bidi overrides, keeps newlines and tabs', () => {
    assert.equal(termSafe('a\u001b[31mb\u0007c\u009bd\u202ee\u2066f\ng\th'), 'a[31mbcdef\ng\th');
  });
  test('capLine bounds a log line and makes it terminal-safe', () => {
    const line = capLine(`x${'y'.repeat(20_000)}\u001b]52;c;AAAA\u0007`, 1000);
    assert.ok(line.length <= 1100, String(line.length));
    assert.ok(!/[\u001b\u0007]/.test(line));
    assert.match(line, /…\(\d+ more characters\)$/);
  });
});

const dbUrl = process.env.HUB_TEST_DATABASE_URL;
const run = findRun((s) => (s.seats ?? []).filter((x: { kind: string }) => x.kind === 'agent').length >= 2);
const skip = !dbUrl ? 'set HUB_TEST_DATABASE_URL (a throwaway Postgres) to run' : !run ? 'no finished run under runs/ or tmp/smoke-runs (or HUB_TEST_RUN)' : false;
const DB = `hub_hostile_${process.pid}`;
const SERVICE = 'svc-hostile-test-0123456789abcdefghij';

describe('hostile agent text in a hosted hand-off (database)', { skip }, () => {
  let sql: Sql;
  let hub: Hub;
  let dataDir = '';
  let server: Server | undefined;
  let port = 0;

  before(async () => {
    const admin = connect(dbUrl!, 1);
    await admin.unsafe(`drop database if exists ${DB} with (force)`);
    await admin.unsafe(`create database ${DB}`);
    await admin.end({ timeout: 5 });
    const url = new URL(dbUrl!);
    url.pathname = `/${DB}`;
    sql = connect(url.toString(), 3);
    await migrate(sql);
    dataDir = mkdtempSync(join(tmpdir(), 'hub-hostile-'));
    const cfg = loadConfig({ databaseUrl: url.toString(), dataDir, bundleDir: join(dataDir, 'bundles'), host: '127.0.0.1', port: 0, publicUrl: 'http://127.0.0.1', bootstrap: 0 });
    hub = new Hub(cfg, sql, new FsBundleStore(cfg.bundleDir), () => {});
    await hub.load();
    await ensureServiceTokens(sql, [{ name: 'hostile-test', token: SERVICE }]);
    server = startServer(hub);
    await new Promise<void>((r) => server!.once('listening', () => r()));
    port = (server.address() as AddressInfo).port;
  });

  after(async () => {
    server?.close();
    await hub?.idle();
    await sql?.end({ timeout: 5 });
    const admin = connect(dbUrl!, 1);
    await admin.unsafe(`drop database if exists ${DB} with (force)`).catch(() => {});
    await admin.end({ timeout: 5 });
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  test('NUL, lone surrogates and escapes in notes, the set name and the seed: ingested, stored cleaned', async () => {
    const files = rewrite(filesOf(run!), (events) => {
      const start = events[0]!;
      start.organizer = { kind: 'admin' };
      start.set.name = `Set ${HOSTILE}`;
      start.seed = `seed ${HOSTILE}`;
      for (const e of events) if (e.type === 'draft_pick' || e.type === 'agent_decision' || e.type === 'deck_built') e.note = HOSTILE;
      events.push({ t: events.at(-2)!.t, type: 'rules_issue', seat: start.seats[0].name, card: `Card ${HOSTILE}`, note: HOSTILE, stage: 'game' });
      // rules_issue goes before event_end, which must stay last.
      const end = events.findIndex((e) => e.type === 'event_end');
      events.splice(end, 0, events.pop()!);
    });
    const director = (await authenticate(sql, SERVICE, 'ingest'))!;
    const res = await hub.receive(pack(files), director, 'director');
    let status = String(res.body.status);
    if (status === 'held') {
      await hub.approve(Number(res.body.submission_id), 'test');
      status = 'ingested';
    }
    assert.equal(status, 'ingested', JSON.stringify(res.body).slice(0, 2000));
    const eventId = String(res.body.id);
    const [ev] = await sql`select set_name, seed from events where id = ${eventId}`;
    assert.ok(ev, 'the event is indexed');
    assert.ok(!String(ev.set_name).includes('\u0000') && !String(ev.seed).includes('\u0000'));
    const notes = await sql`select note from picks where event_id = ${eventId} and note is not null limit 5`;
    assert.ok(notes.length > 0, 'pick notes are stored');
    // Bidi overrides are gone too: the public scrubber removes invisible and bidi characters (HUB-36).
    for (const n of notes) assert.equal(n.note, 'oknul \ufffdlone \u001b[31mred\u001b[0m evil \u0007bell');
  });
});

/** Send raw bytes; resolve with whatever came back before the server closed (or 3 s passed). */
function raw(port: number, bytes: string | Buffer, waitMs = 3000): Promise<string> {
  return new Promise((resolve) => {
    let out = '';
    const sock = tcp(port, '127.0.0.1', () => sock.write(bytes));
    sock.on('data', (d) => (out += d.toString('latin1')));
    sock.on('error', () => resolve(out));
    sock.on('close', () => resolve(out));
    setTimeout(() => {
      sock.destroy();
      resolve(out);
    }, waitMs);
  });
}

describe('HTTP hardening (database)', { skip }, () => {
  let sql: Sql;
  let hub: Hub;
  let server: Server;
  let base = '';
  let port = 0;
  let dataDir = '';
  const DB2 = `${DB}_http`;

  before(async () => {
    const admin = connect(dbUrl!, 1);
    await admin.unsafe(`drop database if exists ${DB2} with (force)`);
    await admin.unsafe(`create database ${DB2}`);
    await admin.end({ timeout: 5 });
    const url = new URL(dbUrl!);
    url.pathname = `/${DB2}`;
    sql = connect(url.toString(), 3);
    await migrate(sql);
    dataDir = mkdtempSync(join(tmpdir(), 'hub-http-'));
    const cfg = loadConfig({ databaseUrl: url.toString(), dataDir, bundleDir: join(dataDir, 'bundles'), host: '127.0.0.1', port: 0, publicUrl: 'http://127.0.0.1', bootstrap: 0 });
    hub = new Hub(cfg, sql, new FsBundleStore(cfg.bundleDir), () => {});
    await hub.load();
    mkdirSync(join(hub.siteDir, '.tmp-export'), { recursive: true });
    writeFileSync(join(hub.siteDir, '.tmp-export', 'index.json'), '{}');
    writeFileSync(join(hub.siteDir, '.hidden.json'), '{}');
    server = startServer(hub);
    await new Promise<void>((r) => server.once('listening', () => r()));
    port = (server.address() as AddressInfo).port;
    base = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    server?.close();
    await sql?.end({ timeout: 5 });
    const admin = connect(dbUrl!, 1);
    await admin.unsafe(`drop database if exists ${DB2} with (force)`).catch(() => {});
    await admin.end({ timeout: 5 });
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  test('a malformed request target is a 400, and the Hub keeps serving', async () => {
    const out = await raw(port, 'GET //a:b HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
    assert.match(out, /^HTTP\/1\.1 400/);
    assert.equal((await fetch(`${base}/health`)).status, 200);
  });

  test('every JSON answer forbids scripts and framing', async () => {
    const r = await fetch(`${base}/api/nothing-here`);
    assert.equal(r.status, 404);
    assert.equal(r.headers.get('content-security-policy'), "default-src 'none'; frame-ancestors 'none'");
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  });

  test('dot-files and dot-directories under /data are never served', async () => {
    assert.equal((await fetch(`${base}/data/.hidden.json`)).status, 404);
    assert.equal((await fetch(`${base}/data/.tmp-export/index.json`)).status, 404);
  });

  test('an announced oversized upload is answered and the connection closed, the body never read', async () => {
    const t0 = Date.now();
    const out = await raw(port, `POST /api/internal/tokens/introspect HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${SERVICE}\r\nContent-Type: application/json\r\nContent-Length: 999999999\r\n\r\n{"token":"`);
    assert.match(out, /^HTTP\/1\.1 (400|401)/);
    assert.match(out, /connection: close/i);
    assert.ok(Date.now() - t0 < 2500, 'closed at once, not after a timeout');
  });

  test('a flood of bad tokens is cut off per client (429), and the database is spared', async () => {
    let limited = 0;
    for (let i = 0; i < 70; i++) {
      const r = await fetch(`${base}/api/submissions`, { headers: { Authorization: `Bearer mtgdt_con_${'x'.repeat(30)}${i}` } });
      if (r.status === 429) limited++;
      else assert.equal(r.status, 401);
    }
    assert.ok(limited >= 5, `limited ${limited}`);
  });
});
