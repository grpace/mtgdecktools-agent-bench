/**
 * Hosted play and GitHub self-serve tokens against a real Postgres and a mocked GitHub:
 * token scopes, introspection (POST /api/internal/tokens/introspect), quotas, and the OAuth flow
 * (state + PKCE, cookies, suspended users, find-or-create, CSRF, rotation).
 *
 * Needs HUB_TEST_DATABASE_URL (a throwaway database: the test drops and recreates the schema), e.g.
 *   podman run -d --name hub-test-pg -e POSTGRES_USER=hub -e POSTGRES_PASSWORD=hub -e POSTGRES_DB=hub \
 *     -p 127.0.0.1:5451:5432 --tmpfs /var/lib/postgresql/data docker.io/library/postgres:17-alpine
 *   HUB_TEST_DATABASE_URL=postgres://hub:hub@127.0.0.1:5451/hub npm run test -w packages/hub
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { loadConfig, type HubConfig } from '../src/config.js';
import { connect, migrate, type Sql } from '../src/db.js';
import { findOrCreateGithubContributor } from '../src/account.js';
import { Hub } from '../src/hub.js';
import { startServer } from '../src/http.js';
import { FsBundleStore } from '../src/store.js';
import { authenticate, createContributor, ensureServiceTokens, issueToken } from '../src/tokens.js';
import { acceptTerms, TERMS_VERSION } from '../src/terms.js';

const dbUrl = process.env.HUB_TEST_DATABASE_URL;
const skip = dbUrl ? false : 'set HUB_TEST_DATABASE_URL (a throwaway Postgres) to run';

const SERVICE = 'svc-token-0123456789abcdefghijklmnop';
const users: Record<string, Record<string, unknown>> = {
  'code-alice': { id: 1001, login: 'Alice', avatar_url: 'https://avatars.githubusercontent.com/u/1001', created_at: '2015-01-01T00:00:00Z' },
  'code-bob': { id: 1002, login: 'bob', avatar_url: 'https://avatars.githubusercontent.com/u/1002', created_at: '2016-01-01T00:00:00Z' },
  'code-frank': { id: 1005, login: 'frank', created_at: '2017-01-01T00:00:00Z' },
  'code-erin': { id: 1004, login: 'erin', created_at: '2017-01-01T00:00:00Z' },
  'code-susp': { id: 1003, login: 'mallory', created_at: '2016-01-01T00:00:00Z', suspended_at: '2024-01-01T00:00:00Z' },
};

const listen = (s: Server) => new Promise<number>((r) => s.listen(0, '127.0.0.1', () => r((s.address() as AddressInfo).port)));

describe('hosted play + GitHub sign-in', { skip }, () => {
  let sql: Sql;
  let hubServer: Server;
  let gh: Server;
  let base = '';
  let dataDir = '';
  let cfg: HubConfig;
  /** challenge sent to /authorize, checked against the verifier at the token exchange (PKCE). */
  let lastChallenge = '';
  let exchanges = 0;
  /** Device flow: what GitHub answers to each successive poll of the next device code handed out. */
  const deviceScripts: string[][] = [];
  const deviceRuns = new Map<string, string[]>();
  let deviceSeq = 0;

  before(async () => {
    sql = connect(dbUrl!, 3);
    await sql.unsafe('drop schema public cascade; create schema public;');
    await migrate(sql);
    await ensureServiceTokens(sql, [{ name: 'worker-1', token: SERVICE }]);
    gh = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const url = new URL(req.url!, 'http://x');
      if (url.pathname === '/login/device/code' && req.method === 'POST') {
        const b = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const code = `dc-secret-${++deviceSeq}`;
        deviceRuns.set(code, deviceScripts.shift() ?? ['authorization_pending']);
        res.writeHead(b.client_id === 'cid' && b.scope === 'read:user' ? 200 : 400, { 'Content-Type': 'application/json' })
          .end(JSON.stringify({ device_code: code, user_code: 'WDJB-MJHT', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 1 }));
        return;
      }
      if (url.pathname === '/login/oauth/access_token' && req.method === 'POST' && JSON.parse(Buffer.concat(chunks).toString('utf8')).grant_type) {
        const b = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const run = deviceRuns.get(b.device_code);
        const step = b.grant_type === 'urn:ietf:params:oauth:grant-type:device_code' && b.client_id === 'cid' && run ? (run.length > 1 ? run.shift()! : run[0]!) : 'bad_verification_code';
        res.writeHead(200, { 'Content-Type': 'application/json' })
          .end(JSON.stringify(step.startsWith('ok:') ? { access_token: `gho_${step.slice(3)}`, token_type: 'bearer' } : { error: step, ...(step === 'slow_down' ? { interval: 6 } : {}) }));
        return;
      }
      if (url.pathname === '/login/oauth/access_token' && req.method === 'POST') {
        exchanges++;
        const b = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const ok = b.client_id === 'cid' && b.client_secret === 'csecret' && users[b.code]
          && createHash('sha256').update(b.code_verifier ?? '').digest('base64url') === lastChallenge;
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(ok ? { access_token: `gho_${b.code}`, token_type: 'bearer', scope: 'read:user' } : { error: 'bad_verification_code' }));
        return;
      }
      if (url.pathname === '/user') {
        const code = String(req.headers.authorization ?? '').replace(/^Bearer gho_/, '');
        const u = users[code];
        res.writeHead(u ? 200 : 401, { 'Content-Type': 'application/json' }).end(JSON.stringify(u ?? { message: 'Bad credentials' }));
        return;
      }
      res.writeHead(404).end();
    });
    const ghPort = await listen(gh);
    dataDir = mkdtempSync(join(tmpdir(), 'hub-play-'));
    // Pick the hub's port first so HUB_PUBLIC_URL (redirect_uri, cookie origin) is right.
    const probe = createServer();
    const port = await listen(probe);
    await new Promise((r) => probe.close(r));
    base = `http://127.0.0.1:${port}`;
    cfg = loadConfig({
      databaseUrl: dbUrl!, dataDir, bundleDir: join(dataDir, 'bundles'), host: '127.0.0.1', port, publicUrl: base,
      playConcurrent: 1, playDaily: 6, lobbyConcurrent: 2, lobbyDaily: 12, reviewFirst: 3,
      github: { clientId: 'cid', clientSecret: 'csecret', oauthUrl: `http://127.0.0.1:${ghPort}`, apiUrl: `http://127.0.0.1:${ghPort}`, minAccountDays: 0 },
      sessionSecret: 'test-session-secret-0123456789abcdef',
    });
    hubServer = startServer(new Hub(cfg, sql, new FsBundleStore(cfg.bundleDir), () => {}));
    await new Promise((r) => setTimeout(r, 100));
  });

  after(async () => {
    hubServer?.close();
    gh?.close();
    await sql?.end({ timeout: 5 });
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  const introspect = (token: unknown, auth = SERVICE) => fetch(`${base}/api/internal/tokens/introspect`, {
    method: 'POST', headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ token }),
  });

  test('scopes: contributor tokens can submit and play; old single-scope tokens keep their scope', async () => {
    const id = await createContributor(sql, 'carol');
    const con = await issueToken(sql, id, 'contributor');
    const sub = await issueToken(sql, id, 'submit');
    const ply = await issueToken(sql, id, 'play');
    assert.match(con.token, /^mtgdt_con_/);
    assert.match(ply.token, /^mtgdt_ply_/);
    assert.ok(await authenticate(sql, con.token, 'submit'));
    assert.ok(await authenticate(sql, con.token, 'play'));
    assert.equal(await authenticate(sql, con.token, 'ingest'), null);
    assert.ok(await authenticate(sql, sub.token, 'submit'));
    assert.equal(await authenticate(sql, sub.token, 'play'), null);
    assert.ok(await authenticate(sql, ply.token, 'play'));
    assert.equal(await authenticate(sql, ply.token, 'submit'), null);
  });

  test('introspection: owner, scopes, default and custom quotas; inactive when revoked or suspended', async () => {
    const id = await createContributor(sql, 'dave');
    const t = await issueToken(sql, id, 'contributor');
    assert.equal((await introspect(t.token, 'wrong-token-0123456789abcdefgh')).status, 401);
    assert.equal((await introspect(t.token, t.token)).status, 401, 'a contributor token is not a service token');
    const bad = await fetch(`${base}/api/internal/tokens/introspect`, { method: 'POST', headers: { Authorization: `Bearer ${SERVICE}` }, body: '{not json' });
    assert.equal(bad.status, 400);
    assert.equal((await introspect(42)).status, 400);
    const { terms, ...r } = await (await introspect(t.token)).json();
    assert.deepEqual(r, {
      active: true, contributor: { id, handle: 'dave', kind: 'person', trust: 'new', github_login: null }, board_visibility: null, scopes: ['submit', 'play'],
      token_id: t.id, token_prefix: t.token.slice(0, 14), quotas: { play_concurrent: 1, play_daily: 6, lobby_concurrent: 2, lobby_daily: 12 },
    });
    // Terms: a Director refuses hosted play until the current version is accepted, with this message.
    assert.equal(terms.current, TERMS_VERSION);
    assert.equal(terms.accepted, false);
    assert.match(terms.message, /bench login/);
    await acceptTerms(sql, id, 'cli');
    assert.deepEqual((await (await introspect(t.token)).json()).terms, { current: TERMS_VERSION, accepted_version: TERMS_VERSION, accepted: true });
    await sql`update contributors set play_concurrent = 3, play_daily = 10 where id = ${id}`;
    assert.deepEqual((await (await introspect(t.token)).json()).quotas, { play_concurrent: 3, play_daily: 10, lobby_concurrent: 2, lobby_daily: 12 }, 'Private Table quotas raised; the lobby keeps its defaults');
    // The lobby quota is separate (owner decision 2026-10-22): raising it leaves Private Tables alone.
    await sql`update contributors set lobby_concurrent = 4, lobby_daily = 20 where id = ${id}`;
    assert.deepEqual((await (await introspect(t.token)).json()).quotas, { play_concurrent: 3, play_daily: 10, lobby_concurrent: 4, lobby_daily: 20 });
    assert.deepEqual(await (await introspect('mtgdt_con_unknown-token-value-xxxxxxxx')).json(), { active: false });
    await sql`update contributors set status = 'suspended' where id = ${id}`;
    assert.deepEqual(await (await introspect(t.token)).json(), { active: false });
    await sql`update contributors set status = 'active' where id = ${id}`;
    await sql`update tokens set revoked_at = now() where id = ${t.id}`;
    assert.deepEqual(await (await introspect(t.token)).json(), { active: false });
  });

  /** Start a sign-in: the authorize redirect and the signed state cookie. */
  async function begin(): Promise<{ state: string; cookie: string; location: URL }> {
    const r = await fetch(`${base}/auth/github`, { redirect: 'manual' });
    assert.equal(r.status, 302);
    const location = new URL(r.headers.get('location')!);
    assert.equal(location.pathname, '/login/oauth/authorize');
    assert.equal(location.searchParams.get('scope'), 'read:user');
    assert.equal(location.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(location.searchParams.get('redirect_uri'), `${base}/auth/github/callback`);
    lastChallenge = location.searchParams.get('code_challenge')!;
    const setCookie = r.headers.get('set-cookie')!;
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Lax/);
    return { state: location.searchParams.get('state')!, cookie: setCookie.split(';')[0]!, location };
  }

  async function callback(code: string, state: string, cookie?: string) {
    const r = await fetch(`${base}/auth/github/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`, {
      redirect: 'manual', headers: cookie ? { Cookie: cookie } : {},
    });
    const html = await r.text();
    const session = (r.headers.getSetCookie?.() ?? []).find((c) => c.startsWith('mtgdt_session='))?.split(';')[0];
    const token = /value="(mtgdt_con_[\w-]+)"/.exec(html)?.[1];
    const csrf = /name="csrf" value="([\w-]+)"/.exec(html)?.[1];
    return { status: r.status, html, session, token, csrf, headers: r.headers };
  }

  test('sign-in: state and cookie are checked', async () => {
    const { state, cookie } = await begin();
    const before = exchanges;
    assert.equal((await callback('code-alice', 'wrong-state', cookie)).status, 400, 'state mismatch');
    assert.equal((await callback('code-alice', state)).status, 400, 'no cookie');
    const [val, mac] = cookie.split('=')[1]!.split('.');
    const forged = `mtgdt_oauth=${val}.${mac!.slice(0, -2)}${mac!.endsWith('AA') ? 'BB' : 'AA'}`;
    assert.equal((await callback('code-alice', state, forged)).status, 400, 'forged cookie');
    assert.equal(exchanges, before, 'GitHub is never called for a bad state');
  });

  test('sign-in: suspended GitHub users are blocked', async () => {
    const { state, cookie } = await begin();
    const r = await callback('code-susp', state, cookie);
    assert.equal(r.status, 403);
    assert.equal(r.token, undefined);
    assert.equal((await sql`select 1 from contributors where github_id = 1003`).length, 0);
  });

  let aliceToken = '';
  let aliceSession = '';
  let aliceCsrf = '';

  test('first sign-in creates the contributor and shows a token once; it can submit and play', async () => {
    const { state, cookie } = await begin();
    const r = await callback('code-alice', state, cookie);
    assert.equal(r.status, 200, r.html);
    assert.ok(r.token, 'token shown');
    assert.ok(r.session, 'session cookie set');
    assert.match(r.headers.get('cache-control') ?? '', /no-store/);
    assert.match(r.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
    assert.match(r.html, /agent-bench\/play/);
    const [c] = await sql`select id, handle, trust, github_login, github_id, avatar_url, github_created_at from contributors where github_id = 1001`;
    assert.equal(c!.handle, 'alice');
    assert.equal(c!.trust, 'new');
    assert.equal(c!.github_login, 'Alice');
    assert.ok(c!.github_created_at);
    assert.ok(await authenticate(sql, r.token!, 'play'));
    assert.ok(await authenticate(sql, r.token!, 'submit'));
    // The token is shown once: the account page lists its prefix only.
    const page = await (await fetch(`${base}/account`, { headers: { Cookie: r.session! } })).text();
    assert.ok(!page.includes(r.token!));
    assert.ok(page.includes(r.token!.slice(0, 14)));
    aliceToken = r.token!;
    aliceSession = r.session!;
    aliceCsrf = r.csrf!;
  });

  test('find-or-create is idempotent; a taken handle gets a suffix', async () => {
    const { state, cookie } = await begin();
    const again = await callback('code-alice', state, cookie);
    assert.equal(again.status, 200);
    assert.equal(again.token, undefined, 'no new token when one is active');
    assert.equal((await sql`select count(*)::int as n from contributors where github_id = 1001`)[0]!.n, 1);
    await createContributor(sql, 'bob');
    const b = await begin();
    const r = await callback('code-bob', b.state, b.cookie);
    assert.equal(r.status, 200);
    assert.equal((await sql`select handle from contributors where github_id = 1002`)[0]!.handle, 'bob-gh');
  });

  const post = (path: string, form: Record<string, string>, cookie: string, headers: Record<string, string> = {}) => fetch(`${base}${path}`, {
    method: 'POST', redirect: 'manual', body: new URLSearchParams(form).toString(),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie, ...headers },
  });

  test('account changes need the CSRF token, the same origin and a recent session', async () => {
    assert.equal((await post('/account/tokens', {}, aliceSession)).status, 403, 'no csrf');
    assert.equal((await post('/account/tokens', { csrf: 'x'.repeat(43) }, aliceSession)).status, 403, 'wrong csrf');
    assert.equal((await post('/account/tokens', { csrf: aliceCsrf }, aliceSession, { Origin: 'https://evil.example' })).status, 403, 'cross-origin');
    assert.equal((await post('/account/tokens', { csrf: aliceCsrf }, 'mtgdt_session=garbage.sig')).status, 401, 'no session');
    const r = await post('/account/tokens', { csrf: aliceCsrf }, aliceSession, { Origin: base });
    assert.equal(r.status, 200);
    const t = /value="(mtgdt_con_[\w-]+)"/.exec(await r.text())?.[1];
    assert.ok(t && t !== aliceToken);
    assert.ok(await authenticate(sql, t!, 'play'));
  });

  test('rotation revokes every earlier token and issues one', async () => {
    const r = await post('/account/rotate', { csrf: aliceCsrf }, aliceSession);
    assert.equal(r.status, 200);
    const fresh = /value="(mtgdt_con_[\w-]+)"/.exec(await r.text())?.[1];
    assert.ok(fresh);
    assert.equal(await authenticate(sql, aliceToken, 'play'), null);
    assert.ok(await authenticate(sql, fresh!, 'submit'));
    const [{ n }] = (await sql`select count(*)::int as n from tokens t join contributors c on c.id = t.contributor_id where c.github_id = 1001 and t.revoked_at is null`) as unknown as [{ n: number }];
    assert.equal(n, 1);
    // Revoke that one too; someone else's token id can't be revoked.
    const [mine] = await sql`select t.id from tokens t join contributors c on c.id = t.contributor_id where c.github_id = 1001 and t.revoked_at is null`;
    const [other] = await sql`select t.id from tokens t join contributors c on c.id = t.contributor_id where c.handle = 'carol' and t.revoked_at is null limit 1`;
    assert.match(await (await post(`/account/tokens/${other!.id}/revoke`, { csrf: aliceCsrf }, aliceSession)).text(), /No such active token/);
    assert.match(await (await post(`/account/tokens/${mine!.id}/revoke`, { csrf: aliceCsrf }, aliceSession)).text(), /Token revoked/);
    assert.equal(await authenticate(sql, fresh!, 'submit'), null);
  });

  test('suspended contributors are blocked at sign-in', async () => {
    await sql`update contributors set status = 'suspended' where github_id = 1002`;
    const b = await begin();
    const r = await callback('code-bob', b.state, b.cookie);
    assert.equal(r.status, 403);
    assert.equal(r.token, undefined);
  });

  const dpost = (path: string, body?: unknown) => fetch(`${base}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const sleep = (s: number) => new Promise((r) => setTimeout(r, s * 1000 + 50));

  test('device flow: pending, slow_down, then the token exactly once', { timeout: 30_000 }, async () => {
    deviceScripts.push(['authorization_pending', 'slow_down', 'ok:code-erin']);
    const st = await dpost('/auth/device/start');
    assert.equal(st.status, 200);
    const raw = await st.text();
    assert.ok(!raw.includes('dc-secret'), "GitHub's device_code never leaves the Hub");
    const s1 = JSON.parse(raw);
    assert.equal(s1.user_code, 'WDJB-MJHT');
    assert.equal(s1.verification_uri, 'https://github.com/login/device');
    assert.equal(s1.interval, 1);
    assert.ok(s1.device_id && s1.expires_in > 0);
    await sleep(1);
    const p1 = await dpost('/auth/device/poll', { device_id: s1.device_id });
    assert.equal(p1.status, 200);
    assert.deepEqual(await p1.json(), { status: 'pending', interval: 1 });
    await sleep(1);
    const p2 = await dpost('/auth/device/poll', { device_id: s1.device_id });
    assert.equal(p2.status, 429);
    const b2 = await p2.json();
    assert.equal(b2.status, 'slow_down');
    assert.equal(b2.interval, 6, 'interval raised as GitHub asked');
    const early = await dpost('/auth/device/poll', { device_id: s1.device_id });
    assert.equal(early.status, 429, 'polling faster than the interval is refused by the Hub itself');
    const b3 = await early.json();
    assert.equal(b3.status, 'slow_down');
    await sleep(b3.interval);
    const ok = await dpost('/auth/device/poll', { device_id: s1.device_id });
    assert.equal(ok.status, 200);
    const t = await ok.json();
    assert.equal(t.status, 'ok');
    assert.equal(t.handle, 'erin');
    assert.deepEqual(t.scopes, ['submit', 'play']);
    assert.deepEqual(t.quotas, { play_concurrent: 1, play_daily: 6, lobby_concurrent: 2, lobby_daily: 12 });
    assert.match(t.token, /^mtgdt_con_/);
    assert.ok(await authenticate(sql, t.token, 'play'));
    const again = await dpost('/auth/device/poll', { device_id: s1.device_id });
    assert.equal(again.status, 404, 'the token is returned once; the session is gone');
    assert.equal((await again.json()).status, 'expired');
  });

  test('device flow: expired and denied codes, bad requests, the token cap', { timeout: 30_000 }, async () => {
    for (const [step, status] of [['expired_token', 'expired'], ['access_denied', 'denied']] as const) {
      deviceScripts.push([step]);
      const s = await (await dpost('/auth/device/start')).json();
      await sleep(1);
      const p = await dpost('/auth/device/poll', { device_id: s.device_id });
      assert.equal(p.status, 410);
      assert.equal((await p.json()).status, status);
    }
    assert.equal((await dpost('/auth/device/poll', {})).status, 400);
    assert.equal((await dpost('/auth/device/poll', { device_id: 'nope' })).status, 404);
    // erin has 1 active token; at 5 the device flow refuses and points at /account.
    const [e] = await sql`select id from contributors where github_id = 1004`;
    for (let i = 0; i < 4; i++) await issueToken(sql, Number(e!.id), 'contributor');
    deviceScripts.push(['ok:code-erin']);
    const s = await (await dpost('/auth/device/start')).json();
    await sleep(1);
    const p = await dpost('/auth/device/poll', { device_id: s.device_id });
    assert.equal(p.status, 409);
    assert.match((await p.json()).error, /revoke one at .*\/account/);
  });

  test('bench login: the terms first, then the device flow; token saved privately; logout removes it', { timeout: 90_000 }, async () => {
    deviceScripts.push(['authorization_pending', 'ok:code-frank']);
    const xdg = mkdtempSync(join(tmpdir(), 'bench-login-'));
    const root = join(import.meta.dirname, '../../..');
    const run = (args: string[]) => new Promise<{ code: number; out: string }>((resolve) => {
      execFile('npx', ['tsx', 'scripts/bench/cli.ts', ...args], { cwd: root, env: { ...process.env, XDG_CONFIG_HOME: xdg, BENCH_TOKEN: '' } }, (err, stdout, stderr) =>
        resolve({ code: err ? Number((err as { code?: number }).code ?? 1) : 0, out: stdout + stderr }));
    });
    try {
      // Without a terminal and without --accept-terms: the summary and links, and no sign-in starts.
      const no = await run(['login', '--hub', base]);
      assert.equal(no.code, 1, no.out);
      assert.match(no.out, /responsible for all costs/);
      assert.match(no.out, /\/legal\/terms/);
      assert.match(no.out, /not signed in/);
      assert.doesNotMatch(no.out, /WDJB-MJHT/);
      const r = await run(['login', '--hub', base, '--accept-terms']);
      assert.equal(r.code, 0, r.out);
      assert.match(r.out, /WDJB-MJHT/);
      assert.match(r.out, new RegExp(`Terms accepted \\(version ${TERMS_VERSION}\\)`));
      assert.match(r.out, /github\.com\/login\/device/);
      assert.match(r.out, /Signed in as frank/);
      const file = join(xdg, 'mtgdt-bench', 'token');
      assert.equal(statSync(file).mode & 0o777, 0o600);
      assert.equal(statSync(join(xdg, 'mtgdt-bench')).mode & 0o777, 0o700);
      const token = readFileSync(file, 'utf8').trim();
      assert.ok(!r.out.includes(token), 'the token is not printed');
      assert.ok(await authenticate(sql, token, 'play'));
      const [c] = await sql`select terms_version from contributors where github_login = 'frank'`;
      assert.equal(c!.terms_version, TERMS_VERSION, 'the Hub recorded the acceptance');
      const out = await run(['logout']);
      assert.equal(out.code, 0, out.out);
      assert.equal(existsSync(file), false);
    } finally {
      rmSync(xdg, { recursive: true, force: true });
    }
  });

  test('a GitHub login cannot claim a system handle or receive a service token', async () => {
    const r = await findOrCreateGithubContributor(sql, { id: 4242, login: 'Director-Worker-9' });
    assert.match(r.handle, /^gh-director-worker-9/);
    await ensureServiceTokens(sql, [{ name: 'worker-9', token: 'w9'.repeat(16) }]);
    const [svc] = await sql`select c.handle, c.github_id from tokens t join contributors c on c.id = t.contributor_id where t.label = 'HUB_SERVICE_TOKENS' and c.handle = 'director-worker-9'`;
    assert.ok(svc && svc.github_id === null, 'the service token belongs to the system account');
    // A GitHub account that already holds such a handle (from before the rule) is never given the token.
    await sql`insert into contributors (handle, kind, trust, github_id, github_login) values ('director-worker-8', 'person', 'new', 4343, 'director-worker-8')`;
    await assert.rejects(ensureServiceTokens(sql, [{ name: 'worker-8', token: 'w8'.repeat(16) }]), /belongs to a GitHub account/);
  });

  test('sign-in is off without GitHub credentials', async () => {
    const off = startServer(new Hub({ ...cfg, port: 0, github: { ...cfg.github, clientId: '' } }, sql, new FsBundleStore(cfg.bundleDir), () => {}));
    await new Promise((r) => setTimeout(r, 50));
    const port = (off.address() as AddressInfo).port;
    const r = await fetch(`http://127.0.0.1:${port}/auth/github`, { redirect: 'manual' });
    assert.equal(r.status, 503);
    assert.match(await r.text(), /not enabled/);
    const d = await fetch(`http://127.0.0.1:${port}/auth/device/start`, { method: 'POST' });
    assert.equal(d.status, 503);
    off.close();
  });
});
