/**
 * Terms, moderation and erasure against a real Postgres (docs/legal/, docs/SECURITY.md "Moderation and erasure"):
 * terms acceptance gating uploads and hosted play, the review queue, hiding a note, a deck name and a handle (with
 * the rebuild of every public output and the log), the list hosted Directors read, contributor erasure, takedowns.
 *
 * Needs HUB_TEST_DATABASE_URL (a throwaway Postgres; this test uses its own database in it), e.g.
 *   podman run -d --name hub-test-pg -e POSTGRES_USER=hub -e POSTGRES_PASSWORD=hub -e POSTGRES_DB=hub \
 *     -p 127.0.0.1:5451:5432 --tmpfs /var/lib/postgresql/data docker.io/library/postgres:17-alpine
 *   HUB_TEST_DATABASE_URL=postgres://hub:hub@127.0.0.1:5451/hub npm run test -w packages/hub
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { REMOVED_TEXT } from '../../director/src/public-text.js';
import { unpackTarGz } from '../../director/src/submissions.js';
import { loadConfig } from '../src/config.js';
import { connect, migrate, type Sql } from '../src/db.js';
import { Hub } from '../src/hub.js';
import { startServer } from '../src/http.js';
import { accountPage } from '../src/pages.js';
import { FsBundleStore } from '../src/store.js';
import { TERMS_SUMMARY, TERMS_VERSION } from '../src/terms.js';
import { authenticate, createContributor, ensureServiceTokens, issueToken } from '../src/tokens.js';
import { filesOf, findRun, pack, rewrite, withSideboarding } from './helpers.js';

const dbUrl = process.env.HUB_TEST_DATABASE_URL;
const run = findRun((s) => (s.seats ?? []).filter((x: { kind: string }) => x.kind === 'agent').length >= 2);
const skip = !dbUrl ? 'set HUB_TEST_DATABASE_URL (a throwaway Postgres) to run' : !run ? 'no finished run under runs/ or tmp/smoke-runs (or HUB_TEST_RUN)' : false;

const DB = `hub_moderation_${process.pid}`;
const SERVICE = 'svc-moderation-test-0123456789abcdefghij';
const ADMIN = 'admin-moderation-test-0123456789abcdef';
const RUDE = 'What a shit draw; my notes are in /home/alice/agents/notes.txt';

describe('terms, moderation and erasure (database)', { skip }, () => {
  let sql: Sql;
  let hub: Hub;
  let server: Server;
  let base = '';
  let dataDir = '';
  let alice = 0;
  let bob = 0;
  let aliceToken = '';
  let bobToken = '';
  let eventId = '';
  let seatA = '';
  let seatB = '';
  let decisionId = '';
  let bundle: Buffer;

  const admin = (path: string, body: unknown) => fetch(`${base}${path}`, {
    method: 'POST', headers: { Authorization: `Bearer ${ADMIN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const service = async (path: string, body?: unknown) => (await fetch(`${base}${path}`, {
    method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })).json();
  const runLog = () => readFileSync(join(hub.runsDir, eventId, 'events.jsonl'), 'utf8');
  /** The event's whole /data export: the event file, its draft and game files. */
  const exported = () => [join(hub.siteDir, 'events', `${eventId}.json`), ...readdirSync(join(hub.siteDir, 'events', eventId)).map((f) => join(hub.siteDir, 'events', eventId, f))]
    .map((f) => readFileSync(f, 'utf8')).join('\n');

  before(async () => {
    const root = connect(dbUrl!, 1);
    await root.unsafe(`drop database if exists ${DB} with (force)`);
    await root.unsafe(`create database ${DB}`);
    await root.end({ timeout: 5 });
    const url = new URL(dbUrl!);
    url.pathname = `/${DB}`;
    sql = connect(url.toString(), 3);
    await migrate(sql);
    dataDir = mkdtempSync(join(tmpdir(), 'hub-moderation-'));
    const cfg = loadConfig({ databaseUrl: url.toString(), dataDir, bundleDir: join(dataDir, 'bundles'), host: '127.0.0.1', port: 0, publicUrl: 'http://127.0.0.1', bootstrap: 0, adminToken: ADMIN });
    hub = new Hub(cfg, sql, new FsBundleStore(cfg.bundleDir), () => {});
    await hub.load();
    await ensureServiceTokens(sql, [{ name: 'moderation-test', token: SERVICE }]);
    alice = await createContributor(sql, 'alice', { kind: 'person', trust: 'trusted' });
    bob = await createContributor(sql, 'bob', { kind: 'person', trust: 'trusted' });
    aliceToken = (await issueToken(sql, alice, 'contributor')).token;
    bobToken = (await issueToken(sql, bob, 'contributor')).token;
    // A lobby table: alice and bob each seated one agent (and showed their handles at the time).
    const files = rewrite(filesOf(run!), (events) => {
      withSideboarding(events);
      const agents = (events[0]!.seats as Array<Record<string, unknown>>).filter((s) => s.kind === 'agent');
      seatA = String(agents[0]!.name);
      seatB = String(agents[1]!.name);
      Object.assign(agents[0]!, { contributor_id: String(alice), contributor: 'alice' });
      Object.assign(agents[1]!, { contributor_id: String(bob), contributor: 'bob' });
      events[0]!.table = { kind: 'lobby' };
      const d = events.find((e) => e.type === 'agent_decision' && e.seat === seatA)!;
      d.note = RUDE;
      decisionId = String(d.id);
      const deck = events.find((e) => e.type === 'deck_built' && e.seat === seatB)!;
      deck.deck_name = 'Fuck Yeah Aggro';
      deck.note = 'Curve out and attack; key sk-ant-api03-Zx9kQ2mN7pLr4TvW8yB1cD5fG3hJ6kL0';
    });
    eventId = JSON.parse(files.get('events.jsonl')!.toString('utf8').split('\n', 1)[0]!).id;
    bundle = pack(files);
    const director = (await authenticate(sql, SERVICE, 'ingest'))!;
    const res = await hub.receive(bundle, director, 'director');
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
    const root = connect(dbUrl!, 1);
    await root.unsafe(`drop database if exists ${DB} with (force)`).catch(() => {});
    await root.end({ timeout: 5 });
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  test('terms: uploads and hosted play are refused until the current version is accepted; acceptance is recorded', async () => {
    const info = await (await fetch(`${base}/api/terms`)).json();
    assert.equal(info.version, TERMS_VERSION);
    assert.deepEqual(info.summary, [...TERMS_SUMMARY]);
    assert.match(info.links.terms, /\/legal\/terms$/);
    const doc = await fetch(`${base}/legal/privacy`);
    assert.equal(doc.status, 200);
    assert.match(await doc.text(), /Privacy/);
    // An upload before acceptance: 403 with how to accept.
    const up = await fetch(`${base}/api/submissions`, { method: 'POST', headers: { Authorization: `Bearer ${aliceToken}`, 'Content-Type': 'application/gzip' }, body: new Uint8Array(bundle) });
    assert.equal(up.status, 403);
    assert.match((await up.json()).error, /bench login.*\/account/s);
    // Hosted play: the Director reads this from introspection and refuses with the message.
    const intro = await service('/api/internal/tokens/introspect', { token: aliceToken });
    assert.equal(intro.terms.accepted, false);
    assert.match(intro.terms.message, /accept/i);
    // Accepting an old version is refused; the current one is recorded with a consent row.
    const call = (version: string) => fetch(`${base}/api/account/terms`, { method: 'POST', headers: { Authorization: `Bearer ${aliceToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ version }) });
    assert.equal((await call('2000-01-01')).status, 409);
    const ok = await (await call(TERMS_VERSION)).json();
    assert.equal(ok.accepted, true);
    assert.equal(ok.accepted_version, TERMS_VERSION);
    const [c] = await sql`select count(*)::int as n from consents where contributor_id = ${alice} and terms_version = ${TERMS_VERSION} and via = 'cli'`;
    assert.equal(c!.n, 1);
    assert.equal((await service('/api/internal/tokens/introspect', { token: aliceToken })).terms.accepted, true);
    const st = await (await fetch(`${base}/api/account/terms`, { headers: { Authorization: `Bearer ${aliceToken}` } })).json();
    assert.equal(st.accepted, true);
    // Hosted Directors and the admin account are never asked.
    assert.equal((await sql`select kind from contributors where handle = 'director-moderation-test'`)[0]!.kind, 'director');
  });

  test('the account page asks for acceptance with the summary and links, and says so once accepted', () => {
    const view = {
      handle: 'bob', githubLogin: 'bob', avatarUrl: null, trust: 'new', reviewFirst: 3, quotas: { concurrent: 1, daily: 6, custom: false, lobbyConcurrent: 2, lobbyDaily: 12, lobbyCustom: false }, tokens: [], maxTokens: 5, csrf: 'x',
      terms: { current: TERMS_VERSION, acceptedVersion: null, acceptedAt: null, accepted: false, summary: TERMS_SUMMARY, links: { terms: '/legal/terms', privacy: '/legal/privacy', content_policy: '/legal/content-policy' } },
    };
    const html = accountPage(view, 'n');
    assert.match(html, /I Accept the Terms/);
    assert.match(html, /action="\/account\/terms"/);
    assert.match(html, /responsible for all costs/);
    assert.match(accountPage({ ...view, terms: { ...view.terms, accepted: true, acceptedVersion: TERMS_VERSION } }, 'n'), /You accepted the/);
    assert.match(accountPage({ ...view, handleHiddenByModerators: true }, 'n'), /Moderators hid your handle/);
  });

  test('public outputs are scrubbed: the export and the stored log', () => {
    const ex = exported();
    assert.ok(!ex.includes('/home/alice'), 'no file path in the export');
    assert.ok(!ex.includes('sk-ant-api03'), 'no API key in the export');
    assert.ok(ex.includes('[path]'));
  });

  test('the review queue flags the rude note and the deck name; flagged text is never auto-featured', async () => {
    const q = await (await fetch(`${base}/api/admin/moderation/queue`, { headers: { Authorization: `Bearer ${ADMIN}` } })).json();
    const note = q.find((f: any) => f.kind === 'note' && f.seat === seatA && f.item === decisionId);
    const deck = q.find((f: any) => f.kind === 'deck_name' && f.seat === seatB);
    assert.ok(note, JSON.stringify(q));
    assert.ok(note.reasons.includes('word:shit'));
    assert.ok(deck?.reasons.includes('word:fuck'));
    const hl = readFileSync(join(hub.siteDir, 'highlights.json'), 'utf8');
    assert.ok(!hl.includes('What a shit draw'));
    assert.equal((await fetch(`${base}/api/admin/moderation/queue`)).status, 401, 'admin token required');
  });

  test('hide a note: every public output shows the placeholder; logged; the bundle keeps the original; undo restores it', async () => {
    assert.equal((await admin('/api/admin/moderation/notes/hide', { event: eventId, seat: seatA, item: decisionId })).status, 400, 'a reason is required');
    const r = await admin('/api/admin/moderation/notes/hide', { event: eventId, seat: seatA, item: decisionId, reason: 'profanity', actor: 'greg' });
    assert.equal(r.status, 200, await r.text());
    await hub.idle();
    assert.ok(runLog().includes(REMOVED_TEXT) && !runLog().includes('What a shit draw'), 'the stored run folder (open data reads it)');
    assert.ok(exported().includes(REMOVED_TEXT) && !exported().includes('What a shit draw'), 'the /data export');
    const [s] = await sql`select s.bundle_sha256 from submissions s join events e on e.submission_id = s.id where e.id = ${eventId}`;
    const original = unpackTarGz(await hub.store.get(String(s!.bundle_sha256))).get('events.jsonl')!.toString('utf8');
    assert.ok(original.includes('What a shit draw'), 'the private bundle keeps the original');
    const [f] = await sql`select status, reviewed_by from moderation_flags where kind = 'note' and event_id = ${eventId} and seat = ${seatA}`;
    assert.deepEqual([f!.status, f!.reviewed_by], ['hidden', 'admin-api:greg']);
    const [l] = await sql`select actor, action, reason, target from moderation_log where action = 'hide_note'`;
    assert.deepEqual([l!.actor, l!.reason, (l!.target as any).item], ['admin-api:greg', 'profanity', decisionId]);
    const list = await service('/api/internal/moderation');
    assert.deepEqual(list.hides, [{ kind: 'note', event: eventId, seat: seatA, item: decisionId }]);
    // Undo.
    const [h] = await sql`select id from moderation_hides where kind = 'note'`;
    assert.equal((await admin(`/api/admin/moderation/hides/${h!.id}/undo`, { reason: 'mistake' })).status, 200);
    await hub.idle();
    assert.ok(!runLog().includes(REMOVED_TEXT));
    assert.notEqual((await service('/api/internal/moderation')).version, list.version, 'the list version changes with it');
  });

  test('hide a deck name through its flag', async () => {
    const [f] = await sql`select id from moderation_flags where kind = 'deck_name'`;
    assert.equal((await admin(`/api/admin/moderation/flags/${f!.id}/hide`, { reason: 'profanity' })).status, 200);
    await hub.idle();
    const deck = runLog().split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((x) => x.type === 'deck_built' && x.seat === seatB);
    assert.equal(deck.deck_name, REMOVED_TEXT);
    assert.ok(!deck.note.includes('sk-ant'), 'agent text in the stored log is scrubbed too');
  });

  test('force-hide a handle: gone from the logs, the boards and the Director-facing APIs; the contributor cannot show it', async () => {
    assert.equal((await admin('/api/admin/moderation/handles/alice/hide', { reason: 'impersonation' })).status, 200);
    await hub.idle();
    const start = JSON.parse(runLog().split('\n', 1)[0]!);
    assert.equal(start.seats.find((x: any) => x.name === seatA).contributor, undefined);
    assert.equal(start.seats.find((x: any) => x.name === seatB).contributor, 'bob');
    assert.equal((await service('/api/internal/tokens/introspect', { token: aliceToken })).board_visibility, 'hidden');
    await sql`update contributors set board_visibility = 'public' where id = ${alice}`;
    assert.deepEqual((await service('/api/internal/contributors/visibility', { ids: [alice] })).visibility, { [String(alice)]: 'hidden' });
    assert.ok(!(await hub.contributors.publicIds()).has(String(alice)));
    assert.deepEqual((await service('/api/internal/moderation')).hiddenHandles, [String(alice)]);
    const [l] = await sql`select actor, reason from moderation_log where action = 'hide_handle'`;
    assert.deepEqual([l!.actor, l!.reason], ['admin-api', 'impersonation']);
  });

  test('ban a contributor: tokens stop, their games leave the ratings, logged; activate and include undo it', async () => {
    const r = await admin('/api/admin/contributors/alice/ban', { reason: 'suspected fabricated results' });
    assert.equal(r.status, 200);
    await hub.idle();
    const out = ((await r.json()) as { result: { events: string[]; seats: Array<{ event: string; seats: string[] }> } }).result;
    assert.equal((await service('/api/internal/tokens/introspect', { token: aliceToken })).active, false, 'a suspended account\u2019s tokens stop at once');
    const [c] = await sql`select status from contributors where id = ${alice}`;
    assert.equal(c!.status, 'suspended');
    const ev = hub.events.get(eventId)!;
    // Their own upload or Private Table is excluded whole; at someone else's table only their seat's games are.
    if (out.events.includes(eventId)) assert.match(ev.source.exclude ?? '', /contributor banned: suspected fabricated results/);
    else {
      assert.deepEqual(out.seats.find((x) => x.event === eventId)?.seats, [seatA]);
      assert.match(ev.source.excludeSeats?.[seatA] ?? '', /contributor banned/);
      assert.equal(ev.source.excludeSeats?.[seatB], undefined, 'the other contributor\u2019s seat stands');
    }
    const [l] = await sql`select target, reason from moderation_log where action = 'ban_contributor'`;
    assert.equal(l!.reason, 'suspected fabricated results');
    // Undo, so the tests after this one see the event as before.
    await sql`update contributors set status = 'active' where id = ${alice}`;
    if (out.events.includes(eventId)) await hub.setExcluded(eventId, null);
    else await hub.setSeatsExcluded(eventId, {});
    await hub.idle();
    assert.equal(hub.events.get(eventId)!.source.exclude, undefined);
    assert.equal(hub.events.get(eventId)!.source.excludeSeats, undefined);
  });

  test('erase a contributor: identity gone, tokens gone, logs anonymized, the list tells Directors', async () => {
    await sql`update contributors set github_id = 4242, github_login = 'bob-gh', avatar_url = 'https://avatars.githubusercontent.com/u/4242' where id = ${bob}`;
    const r = await admin('/api/admin/contributors/bob/erase', { reason: 'privacy request' });
    assert.equal(r.status, 200, await r.text());
    await hub.idle();
    const [c] = await sql`select handle, status, github_id, github_login, avatar_url from contributors where id = ${bob}`;
    assert.deepEqual({ ...c }, { handle: `erased-${bob}`, status: 'erased', github_id: null, github_login: null, avatar_url: null });
    assert.equal((await sql`select count(*)::int as n from tokens where contributor_id = ${bob}`)[0]!.n, 0);
    assert.equal(await authenticate(sql, bobToken, 'submit'), null);
    const [e] = await sql`select anon_id from erasures where contributor_id = ${bob}`;
    const seat = JSON.parse(runLog().split('\n', 1)[0]!).seats.find((x: any) => x.name === seatB);
    assert.deepEqual([seat.contributor_id, seat.contributor], [e!.anon_id, undefined]);
    assert.ok(!runLog().includes('"bob"'));
    assert.deepEqual((await service('/api/internal/moderation')).erased, [{ id: String(bob), anon: e!.anon_id }]);
    const [l] = await sql`select target, reason from moderation_log where action = 'erase_contributor'`;
    assert.equal((l!.target as any).contributor_id, bob);
    assert.ok(!JSON.stringify(l!.target).includes('bob'), 'the log keeps the id, not the handle');
    assert.equal((await admin('/api/admin/contributors/bob/erase', { reason: 'again' })).status, 409);
  });

  test('takedown: logged, listed for hosted Directors, gone from the export', async () => {
    assert.equal((await admin(`/api/admin/events/${eventId}/takedown`, { reason: 'requested', actor: 'greg' })).status, 200);
    await hub.idle();
    assert.deepEqual((await service('/api/internal/moderation')).takedowns, [eventId]);
    const [l] = await sql`select actor, reason from moderation_log where action = 'takedown'`;
    assert.deepEqual([l!.actor, l!.reason], ['admin-api:greg', 'requested']);
    assert.equal((await fetch(`${base}/data/events/${eventId}.json`)).status, 404);
    assert.equal((await fetch(`${base}/api/internal/moderation`)).status, 401, 'service token required');
  });
});
