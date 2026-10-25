/**
 * Contributor points end to end against a real Postgres: ingest a real LLM event attributed to a contributor, then
 * the ledger table, contributors.json and profile files, the public API (cache headers, 404 for hidden handles,
 * rate limit) and the signed-in account panels; the Hub's own clock (PTS-1), no uploader handle in public files
 * (PTS-4), the hide setting reaching hosted Directors (LOB-3), and contributors.json before any event.
 *
 * Needs HUB_TEST_DATABASE_URL (a throwaway database: the test drops and recreates the schema), e.g.
 *   podman run -d --name hub-test-pg -e POSTGRES_USER=hub -e POSTGRES_PASSWORD=hub -e POSTGRES_DB=hub \
 *     -p 127.0.0.1:5451:5432 --tmpfs /var/lib/postgresql/data docker.io/library/postgres:17-alpine
 *   HUB_TEST_DATABASE_URL=postgres://hub:hub@127.0.0.1:5451/hub npm run test -w packages/hub
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { loadConfig } from '../src/config.js';
import { connect, migrate, type Sql } from '../src/db.js';
import { Hub } from '../src/hub.js';
import { startServer } from '../src/http.js';
import { accountPage } from '../src/pages.js';
import { FsBundleStore } from '../src/store.js';
import { createContributor, ensureServiceTokens, issueToken, maintainersId, type Principal } from '../src/tokens.js';
import { filesOf, findRun, pack, rewrite, withSideboarding } from './helpers.js';

const dbUrl = process.env.HUB_TEST_DATABASE_URL;
// A finished event (CI: the scripted smoke run, whose seats are renamed into LLM seats below).
// Best of 3 (best of 1 is Early Test Data and earns nothing); withSideboarding declares older best-of-3 logs as current.
const run = findRun((s) => (s.seats ?? []).filter((x: { kind: string }) => x.kind === 'agent').length >= 2 && (s.best_of ?? 3) === 3);
const skip = !dbUrl ? 'set HUB_TEST_DATABASE_URL (a throwaway Postgres) to run' : !run ? 'no finished run under runs/ or tmp/smoke-runs (or HUB_TEST_RUN)' : false;

/** Scripted seats (rand-N) become LLM seats of two identities, so the event earns points; the bundle stays consistent. */
function asLlmEvent(files: Map<string, Buffer>): Map<string, Buffer> {
  const start = JSON.parse(files.get('events.jsonl')!.toString('utf8').split('\n', 1)[0]!);
  const names = new Map<string, string>();
  for (const s of start.seats) if (s.kind === 'agent' && /^rand-\d+$/.test(s.name)) names.set(s.name, `${names.size % 2 ? 'gpt' : 'opus'}-${s.name.slice(5)}`);
  if (!names.size) return rewrite(files, (events) => withSideboarding(events));
  const out = new Map<string, Buffer>();
  for (const [f, b] of files) {
    let name = f;
    let text = b.toString('utf8');
    for (const [from, to] of names) {
      text = text.replace(new RegExp(`(?<![\\w-])${from}(?![\\w])`, 'g'), to);
      name = name.replace(new RegExp(`-${from}\\.`), `-${to}.`);
    }
    out.set(name, Buffer.from(text));
  }
  return rewrite(out, (events) => {
    // Rated play is best of 3 with sideboarding (SITE-DATA 2.13); older smoke logs are declared so here.
    withSideboarding(events);
    for (const s of events[0]!.seats) {
      if (s.name.startsWith('opus-')) Object.assign(s, { harness: 'claude-code', model: 'claude-opus-5-5', effort: 'high' });
      if (s.name.startsWith('gpt-')) Object.assign(s, { harness: 'codex', model: 'gpt-6-astra', effort: 'high' });
    }
  });
}

const DB = `hub_points_${process.pid}`;
const SERVICE = 'svc-points-test-0123456789abcdefghij';

describe('contributor points (database)', { skip }, () => {
  let sql: Sql;
  let hub: Hub;
  let server: Server;
  let base = '';
  let dataDir = '';
  let alice = 0;
  let eventId = '';
  let emptyBoard: any;

  before(async () => {
    // Its own database: other test files drop and recreate the schema of HUB_TEST_DATABASE_URL in parallel.
    const admin = connect(dbUrl!, 1);
    await admin.unsafe(`drop database if exists ${DB} with (force)`);
    await admin.unsafe(`create database ${DB}`);
    await admin.end({ timeout: 5 });
    const url = new URL(dbUrl!);
    url.pathname = `/${DB}`;
    sql = connect(url.toString(), 3);
    await migrate(sql);
    dataDir = mkdtempSync(join(tmpdir(), 'hub-points-'));
    const cfg = loadConfig({ databaseUrl: url.toString(), dataDir, bundleDir: join(dataDir, 'bundles'), host: '127.0.0.1', port: 0, publicUrl: 'http://127.0.0.1', bootstrap: 0 });
    hub = new Hub(cfg, sql, new FsBundleStore(cfg.bundleDir), () => {});
    await hub.load();
    // Before any event or contributor: the board file exists already (the site never gets a 404).
    emptyBoard = JSON.parse(readFileSync(join(hub.siteDir, 'contributors.json'), 'utf8'));
    await ensureServiceTokens(sql, [{ name: 'points-test', token: SERVICE }]);
    alice = await createContributor(sql, 'alice', { kind: 'person', trust: 'trusted' });
    // A hosted Private Table alice organized (the hand-off carries event_start.organizer).
    const files = rewrite(asLlmEvent(filesOf(run!)), (events) => {
      events[0]!.organizer = { kind: 'contributor', handle: 'alice', contributor_id: alice };
      events[0]!.table = { kind: 'private' };
      // A seat whose log shows alice's handle (as a lobby seat's log does when she shows it at the time).
      const seat = (events[0]!.seats as Array<Record<string, unknown>>).find((x) => x.kind === 'agent')!;
      seat.contributor_id = alice;
      seat.contributor = 'alice';
    });
    eventId = JSON.parse(files.get('events.jsonl')!.toString('utf8').split('\n', 1)[0]!).id;
    const who: Principal = { contributorId: await maintainersId(sql), handle: 'maintainers', kind: 'maintainers', trust: 'trusted', tokenId: 0 };
    const res = await hub.receive(pack(files), who, 'import', { label: 'verified' });
    // Held only for review flags a maintainer would clear (e.g. a -dirty Director on the smoke run): approve it.
    if (res.body.status === 'held') await hub.approve(Number(res.body.submission_id), 'test');
    else assert.equal(res.body.status, 'ingested', JSON.stringify(res.body.reasons));
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

  test('contributors.json existed before any event: an empty board with the rules and bounties', () => {
    assert.deepEqual(emptyBoard.boards, { season: [], all_time: [] });
    assert.equal(emptyBoard.scheme.id, 'points-v3');
    assert.ok(emptyBoard.bounties.length > 0);
  });

  test('the ledger is written and recomputes to the same lines', async () => {
    const rows = await sql`select * from points_ledger where contributor_id = ${alice} order by seat`;
    assert.ok(rows.length >= 2, 'one line per LLM seat');
    assert.ok(rows.every((r) => r.event_id === eventId && r.table_kind === 'private' && r.scheme === 'points-v3'));
    // The Hub's clock (PTS-1): an admin import keeps its log's end, never later than when the Hub accepted it.
    const [sub] = await sql`select coalesce(s.decided_at, s.received_at) as at from submissions s join events e on e.submission_id = s.id where e.id = ${eventId}`;
    const want = Math.min(hub.events.get(eventId)!.lastT, new Date(sub!.at as Date).getTime());
    assert.ok(rows.every((r) => new Date(r.earned_at as Date).getTime() === want));
    const total = rows.reduce((a, r) => a + Number(r.points), 0);
    assert.ok(total > 0);
    await hub.contributors.refresh();
    const again = await sql`select seat, points from points_ledger where contributor_id = ${alice} order by seat`;
    assert.deepEqual(again.map((r) => [r.seat, r.points]), rows.map((r) => [r.seat, r.points]));
  });

  test('contributors.json and the profile file', () => {
    const file = JSON.parse(readFileSync(join(hub.siteDir, 'contributors.json'), 'utf8'));
    assert.equal(file.contributors_schema, 1);
    assert.equal(file.boards.all_time[0].handle, 'alice');
    assert.equal(file.boards.all_time[0].rank, 1);
    const p = JSON.parse(readFileSync(join(hub.siteDir, 'contributors', 'alice.json'), 'utf8'));
    assert.equal(p.contribution.tables, 1);
    assert.equal(p.contribution.private_tables, 1);
    assert.ok(p.agents.length >= 1);
    assert.ok(!JSON.stringify(p).includes('contributor_id'));
  });

  test('no uploader handle in public files or the public event API (PTS-4)', async () => {
    const src = JSON.parse(readFileSync(join(hub.runsDir, eventId, 'source.json'), 'utf8'));
    assert.equal(src.submitter, undefined);
    assert.match(String(src.submitter_id), /^\d+$/);
    assert.ok(!readFileSync(join(hub.siteDir, 'events', `${eventId}.json`), 'utf8').includes('"submitter"'));
    const ev = await (await fetch(`${base}/api/events/${eventId}`)).json();
    assert.equal(ev.submission.submitter, undefined, 'the admin import account is never named');
    assert.ok(!JSON.stringify(ev).includes('maintainers'));
  });

  test('the hide setting reaches hosted Directors: introspection and the visibility API (LOB-3)', async () => {
    const t = await issueToken(sql, alice, 'contributor');
    const call = async (path: string, body: unknown) => (await fetch(`${base}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
    assert.equal((await call('/api/internal/tokens/introspect', { token: t.token })).board_visibility, null);
    await sql`update contributors set board_visibility = 'hidden' where id = ${alice}`;
    assert.equal((await call('/api/internal/tokens/introspect', { token: t.token })).board_visibility, 'hidden');
    assert.deepEqual((await call('/api/internal/contributors/visibility', { ids: [alice, 999999] })).visibility, { [String(alice)]: 'hidden' });
    await sql`update contributors set board_visibility = null where id = ${alice}`;
    // A token without the play scope is not active for a Director (HUB-17).
    const sub = await issueToken(sql, alice, 'submit');
    assert.deepEqual(await call('/api/internal/tokens/introspect', { token: sub.token }), { active: false });
    assert.equal((await call('/api/internal/tokens/introspect', { token: sub.token, scope: 'submit' })).active, true);
  });

  test('public API: board, profile, bounties, cache headers', async () => {
    const r = await fetch(`${base}/api/contributors?board=all_time`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('cache-control') ?? '', /max-age=60/);
    const b = await r.json();
    assert.equal(b.rows[0].handle, 'alice');
    const p = await fetch(`${base}/api/contributors/alice`);
    assert.equal(p.status, 200);
    assert.equal((await p.json()).handle, 'alice');
    assert.equal((await fetch(`${base}/api/contributors/nobody`)).status, 404);
    assert.equal((await fetch(`${base}/api/contributors?season=2026-13`)).status, 400);
    const bo = await (await fetch(`${base}/api/bounties`)).json();
    assert.ok(Array.isArray(bo.bounties));
  });

  test('hiding the handle removes the board row and the profile, not the points', async () => {
    await sql`update contributors set board_visibility = 'hidden' where id = ${alice}`;
    await hub.contributors.refresh();
    assert.equal(existsSync(join(hub.siteDir, 'contributors', 'alice.json')), false);
    const file = JSON.parse(readFileSync(join(hub.siteDir, 'contributors.json'), 'utf8'));
    assert.equal(file.boards.all_time.length, 0);
    assert.equal(file.totals.contributors, 1);
    // The API caches per ledger computation: a new computation answers at once.
    assert.equal((await fetch(`${base}/api/contributors/alice`)).status, 404);
    const own = hub.contributors.view!.account(alice);
    assert.equal(own.public, false);
    assert.ok(own.points.all_time > 0);
    const html = accountPage({
      handle: 'alice', githubLogin: 'alice', avatarUrl: null, trust: 'trusted', reviewFirst: 3, quotas: { concurrent: 1, daily: 6, custom: false, lobbyConcurrent: 2, lobbyDaily: 12, lobbyCustom: false },
      tokens: [], maxTokens: 5, csrf: 'x', visibility: 'hidden', points: own,
      pending: [{ id: 7, eventId: 'e-held', status: 'held', receivedAt: new Date(), reasons: ['a maintainer reviews <b>first</b> submissions'], note: null }],
    }, 'nonce');
    assert.match(html, /Your Points/);
    assert.match(html, /Points Ledger/);
    assert.match(html, /Held for Review/);
    assert.match(html, /You are hidden from the public leaderboard/);
    assert.ok(!html.includes('<b>first</b>'), 'escaped');
    await sql`update contributors set board_visibility = null where id = ${alice}`;
  });

  test('the event export names a handle from the logs only while its contributor is public', async () => {
    const handles = () => {
      const f = JSON.parse(readFileSync(join(hub.siteDir, 'events', `${eventId}.json`), 'utf8'));
      return (f.config.seats as Array<{ contributor?: { handle: string | null } }>).map((x) => x.contributor?.handle).filter((h) => h != null);
    };
    assert.deepEqual(handles(), ['alice'], 'public: the handle the log carries');
    await sql`update contributors set board_visibility = 'hidden' where id = ${alice}`;
    hub.visibilityChanged(alice);
    await hub.idle();
    assert.deepEqual(handles(), [], 'hidden later: the old log no longer names her');
    await sql`update contributors set board_visibility = null where id = ${alice}`;
    hub.visibilityChanged(alice);
    await hub.idle();
    assert.deepEqual(handles(), ['alice']);
  });

  test('a takedown removes the points at the next export', async () => {
    await hub.takedown(eventId, 'test');
    await hub.idle();
    const rows = await sql`select count(*)::int as n from points_ledger`;
    assert.equal(rows[0]!.n, 0);
    const file = JSON.parse(readFileSync(join(hub.siteDir, 'contributors.json'), 'utf8'));
    assert.equal(file.totals.points, 0);
  });
});
