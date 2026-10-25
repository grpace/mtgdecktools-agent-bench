/**
 * GitHub self-serve sign-in and the contributor account pages (packages/hub/README.md "Self-serve tokens").
 *
 *   GET  /auth/github                 → GitHub authorize (scope read:user, state + PKCE S256 in a signed cookie)
 *   GET  /auth/github/callback        → code exchange, find-or-create the contributor by GitHub user id, session
 *   GET  /account                     your tokens and quotas (needs a sign-in within the last 10 minutes)
 *   POST /account/tokens              issue a token (shown once)
 *   POST /account/tokens/:id/revoke   revoke one of your tokens
 *   POST /account/rotate              revoke every active token, issue one new one (shown once)
 *   POST /account/visibility          show or hide yourself on the Contributors Leaderboard (public | hidden | lobby)
 *   POST /account/terms               accept the current terms (src/terms.ts; needed for hosted play and uploads)
 *   POST /account/signout             end the session
 *
 * Cookies are HMAC-signed (HUB_SESSION_SECRET, else a key derived from the GitHub client secret) and bound to
 * their purpose; over https they are host-locked (`__Host-` names, Path=/, Secure: HUB-14). A session carries the
 * contributor's session epoch, which signing out bumps, so a signed-out cookie stops working at once (HUB-17).
 * POSTs need the CSRF token from the page (bound to the session) and a same-origin Origin.
 * Tokens, codes, GitHub access tokens and cookies are never logged.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HubConfig } from './config.js';
import type { Sql } from './db.js';
import type { AccountPoints } from './contributors.js';
import { accountPage, messagePage, signInPage, type AccountView } from './pages.js';
import { clientIp, RateLimiter } from './ratelimit.js';
import { issueToken } from './tokens.js';
import { scanHandle } from './moderation.js';
import { acceptTerms, asksTerms, TERMS_SUMMARY, TERMS_VERSION, termsLinks } from './terms.js';

export const SESSION_MS = 10 * 60_000;
const OAUTH_MS = 10 * 60_000;
export const MAX_ACTIVE_TOKENS = 5;
const OAUTH_COOKIE = 'mtgdt_oauth';
const SESSION_COOKIE = 'mtgdt_session';
/** Host-locked cookie names (https only: the `__Host-` prefix requires Secure and Path=/). */
const HOST_PREFIX = '__Host-';
const HANDLE_RE = /^[a-z0-9][a-z0-9_.-]{0,39}$/;

const b64 = (b: Buffer | string) => Buffer.from(b).toString('base64url');

export interface GithubUser {
  id: number;
  login: string;
  avatar_url?: string | null;
  created_at?: string | null;
  suspended_at?: string | null;
}

export function accountKey(cfg: HubConfig): Buffer {
  // A short secret can be brute-forced offline from any signed sign-in cookie.
  if (cfg.sessionSecret && cfg.sessionSecret.length < 32) throw new Error('HUB_SESSION_SECRET must be at least 32 characters');
  if (cfg.sessionSecret) return createHash('sha256').update(`mtgdt-hub-session-v1|${cfg.sessionSecret}`).digest();
  return createHmac('sha256', cfg.github.clientSecret || randomBytes(32)).update('mtgdt-hub-session-v1').digest();
}

/** `<base64url json>.<base64url hmac>`, the hmac bound to `purpose`. */
export function signValue(key: Buffer, purpose: string, payload: unknown): string {
  const body = b64(JSON.stringify(payload));
  return `${body}.${b64(createHmac('sha256', key).update(`${purpose}|${body}`).digest())}`;
}

export function verifyValue<T>(key: Buffer, purpose: string, value: string | undefined): T | undefined {
  if (!value || value.length > 4096) return undefined;
  const parts = value.split('.');
  if (parts.length !== 2) return undefined;
  const [body, mac] = parts as [string, string];
  if (!body || !mac) return undefined;
  const want = createHmac('sha256', key).update(`${purpose}|${body}`).digest();
  const got = Buffer.from(mac, 'base64url');
  if (got.length !== want.length || !timingSafeEqual(got, want)) return undefined;
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T;
  } catch {
    return undefined;
  }
}

function cookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

const same = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** c: contributor id, a: signed in at, n: nonce (CSRF), e: the contributor's session epoch at sign-in. */
interface Session { c: number; a: number; n: string; e?: number }

export class AccountRoutes {
  private key: Buffer;
  private signIns = new RateLimiter(20, 15 * 60_000);
  private posts = new RateLimiter(20, 10 * 60_000);
  private secure: boolean;
  private origin: string;
  private sessionCookieName: string;
  private oauthCookieName: string;
  /** Path of the OAuth state cookie (Path=/ when host-locked, as `__Host-` requires). */
  private oauthPath: string;

  constructor(
    private cfg: HubConfig,
    private sql: Sql,
    /** The contributor's points (contributors.ts), when the leaderboard has been computed. */
    private points: (contributorId: number) => AccountPoints | null = () => null,
    /** A contributor's visibility changed: rebuild the public files that could name them. */
    private changed: (contributorId: number) => void = () => {},
  ) {
    this.key = accountKey(cfg);
    this.secure = cfg.publicUrl.startsWith('https://');
    this.origin = new URL(cfg.publicUrl).origin;
    this.sessionCookieName = this.secure ? `${HOST_PREFIX}${SESSION_COOKIE}` : SESSION_COOKIE;
    this.oauthCookieName = this.secure ? `${HOST_PREFIX}${OAUTH_COOKIE}` : OAUTH_COOKIE;
    this.oauthPath = this.secure ? '/' : '/auth/github';
  }

  get enabled(): boolean {
    return !!(this.cfg.github.clientId && this.cfg.github.clientSecret);
  }

  private get redirectUri(): string {
    return `${this.cfg.publicUrl}/auth/github/callback`;
  }

  /** Handles /auth/github* and /account*; false for any other path. */
  async handle(req: IncomingMessage, res: ServerResponse, path: string, url: URL): Promise<boolean> {
    const method = req.method ?? 'GET';
    if (path === '/auth/github' && method === 'GET') return this.start(req, res), true;
    if (path === '/auth/github/callback' && method === 'GET') return await this.callback(req, res, url), true;
    if (path === '/account' && method === 'GET') return await this.show(req, res), true;
    if (path.startsWith('/account/') && method === 'POST') return await this.post(req, res, path), true;
    if (path === '/auth/github' || path === '/auth/github/callback' || path === '/account' || path.startsWith('/account/')) {
      this.html(res, 405, messagePage('Not Allowed', 'That method is not allowed here.', { error: true }));
      return true;
    }
    return false;
  }

  private html(res: ServerResponse, code: number, body: string, extra: Record<string, string | string[]> = {}, nonce = ''): void {
    res.writeHead(code, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; img-src https://avatars.githubusercontent.com data:; script-src ${nonce ? `'nonce-${nonce}'` : "'none'"}; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
      'X-Frame-Options': 'DENY',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      ...extra,
    }).end(body);
  }

  private cookie(name: string, value: string, opts: { maxAgeS: number; sameSite: 'Lax' | 'Strict'; path: string }): string {
    return `${name}=${value}; Path=${opts.path}; Max-Age=${opts.maxAgeS}; HttpOnly; SameSite=${opts.sameSite}${this.secure ? '; Secure' : ''}`;
  }

  private limited(res: ServerResponse, limiter: RateLimiter, key: string): boolean {
    if (limiter.take(key)) return false;
    this.html(res, 429, messagePage('Too Many Attempts', 'Too many sign-in attempts from your network. Wait a few minutes and try again.', { error: true }),
      { 'Retry-After': String(Math.max(1, limiter.retryAfter(key))) });
    return true;
  }

  private start(req: IncomingMessage, res: ServerResponse): void {
    if (!this.enabled) return this.html(res, 503, signInPage(false));
    if (this.limited(res, this.signIns, `ip:${clientIp(req, this.cfg.trustProxy)}`)) return;
    const state = b64(randomBytes(24));
    const verifier = b64(randomBytes(32));
    const challenge = b64(createHash('sha256').update(verifier).digest());
    const u = new URL(`${this.cfg.github.oauthUrl}/login/oauth/authorize`);
    u.searchParams.set('client_id', this.cfg.github.clientId);
    u.searchParams.set('redirect_uri', this.redirectUri);
    u.searchParams.set('scope', 'read:user');
    u.searchParams.set('state', state);
    u.searchParams.set('code_challenge', challenge);
    u.searchParams.set('code_challenge_method', 'S256');
    u.searchParams.set('allow_signup', 'true');
    const value = signValue(this.key, 'oauth', { s: state, v: verifier, e: Date.now() + OAUTH_MS });
    res.writeHead(302, {
      Location: u.toString(),
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'Set-Cookie': this.cookie(this.oauthCookieName, value, { maxAgeS: OAUTH_MS / 1000, sameSite: 'Lax', path: this.oauthPath }),
    }).end();
  }

  private async callback(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    if (!this.enabled) return this.html(res, 503, signInPage(false));
    if (this.limited(res, this.signIns, `ip:${clientIp(req, this.cfg.trustProxy)}`)) return;
    const clear = this.cookie(this.oauthCookieName, '', { maxAgeS: 0, sameSite: 'Lax', path: this.oauthPath });
    const fail = (code: number, title: string, text: string) =>
      this.html(res, code, messagePage(title, text, { signIn: true, error: true }), { 'Set-Cookie': clear });
    if (url.searchParams.get('error')) return fail(400, 'Sign-In Canceled', 'GitHub did not complete the sign-in. You can try again.');
    const pending = verifyValue<{ s: string; v: string; e: number }>(this.key, 'oauth', cookies(req)[this.oauthCookieName]);
    const state = url.searchParams.get('state') ?? '';
    const code = url.searchParams.get('code') ?? '';
    if (!pending || !(pending.e > Date.now()) || !state || !same(state, pending.s) || !code || code.length > 512) {
      return fail(400, 'Sign-In Expired', 'This sign-in link is invalid or has expired. Start again.');
    }
    let user: GithubUser;
    try {
      user = await this.githubUser(code, pending.v);
    } catch (e) {
      console.error(`github sign-in failed: ${(e as Error).message}`);
      return fail(502, 'Sign-In Failed', 'GitHub could not confirm the sign-in. Try again in a moment.');
    }
    const refused = githubRefusal(this.cfg, user);
    if (refused) return fail(403, refused.title, refused.text);
    const c = await findOrCreateGithubContributor(this.sql, user);
    if (c.status !== 'active') return fail(403, 'Account Suspended', 'This contributor account is suspended. Contact us if you think this is a mistake.');
    const [ep] = await this.sql`select session_epoch from contributors where id = ${c.id}`;
    const session: Session = { c: c.id, a: Date.now(), n: b64(randomBytes(16)), e: Number(ep?.session_epoch ?? 0) };
    const sessionCookie = this.cookie(this.sessionCookieName, signValue(this.key, 'session', session), { maxAgeS: SESSION_MS / 1000, sameSite: 'Strict', path: '/' });
    // First sign-in (or every token revoked): issue one right away and show it once.
    const active = await this.sql`select count(*)::int as n from tokens where contributor_id = ${c.id} and revoked_at is null`;
    let newToken: string | undefined;
    if (Number(active[0]!.n) === 0) newToken = (await issueToken(this.sql, c.id, 'contributor', 'github sign-in')).token;
    await this.render(res, session, { newToken, message: c.created ? 'Welcome. Your contributor account is ready.' : undefined }, [clear, sessionCookie]);
  }

  /** Exchange the code (with the PKCE verifier) and read the GitHub user. Throws without echoing secrets. */
  private async githubUser(code: string, verifier: string): Promise<GithubUser> {
    const g = this.cfg.github;
    const tr = await fetch(`${g.oauthUrl}/login/oauth/access_token`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'mtgdt-hub' },
      body: JSON.stringify({ client_id: g.clientId, client_secret: g.clientSecret, code, redirect_uri: this.redirectUri, code_verifier: verifier }),
      signal: AbortSignal.timeout(15_000),
    });
    const tj = (await tr.json().catch(() => ({}))) as { access_token?: string; error?: string };
    if (!tr.ok || !tj.access_token) throw new Error(`token exchange: http ${tr.status}${tj.error ? ` (${String(tj.error).slice(0, 60)})` : ''}`);
    return fetchGithubUser(this.cfg, tj.access_token);
  }

  /** The signed-in session, if its cookie is valid, recent, and not from before the contributor last signed out. */
  private async session(req: IncomingMessage): Promise<Session | undefined> {
    const s = verifyValue<Session>(this.key, 'session', cookies(req)[this.sessionCookieName]);
    if (!s || !Number.isSafeInteger(s.c) || typeof s.n !== 'string' || !(Date.now() - s.a < SESSION_MS) || s.a > Date.now() + 60_000) return undefined;
    const [r] = await this.sql`select session_epoch from contributors where id = ${s.c}`;
    if (!r || Number(r.session_epoch) !== (s.e ?? 0)) return undefined;
    return s;
  }

  private csrf(s: Session): string {
    return b64(createHmac('sha256', this.key).update(`csrf|${s.c}|${s.n}`).digest());
  }

  private async show(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const s = await this.session(req);
    if (!s) return this.html(res, 200, signInPage(this.enabled));
    await this.render(res, s, {});
  }

  private async render(res: ServerResponse, s: Session, extra: { newToken?: string; message?: string; error?: string }, setCookies: string[] = []): Promise<void> {
    const [c] = await this.sql`
      select handle, kind, github_login, avatar_url, trust, status, play_concurrent, play_daily, lobby_concurrent, lobby_daily, board_visibility, moderation_hidden, terms_version, terms_accepted_at
      from contributors where id = ${s.c} and github_id is not null`;
    if (!c || c.status !== 'active') {
      return this.html(res, 403, messagePage('Account Suspended', 'This contributor account is suspended. Contact us if you think this is a mistake.', { error: true }),
        { 'Set-Cookie': this.cookie(this.sessionCookieName, '', { maxAgeS: 0, sameSite: 'Strict', path: '/' }) });
    }
    const tokens = await this.sql`
      select id, prefix, scopes, created_at, last_used_at from tokens where contributor_id = ${s.c} and revoked_at is null order by id`;
    // Bundles you uploaded that aren't on the leaderboard (yet): waiting, held for review, or recently rejected.
    const pending = await this.sql`
      select id, event_id, status, received_at, reasons, review_note from submissions
      where contributor_id = ${s.c} and (status in ('received', 'validated', 'held') or (status = 'rejected' and received_at > now() - interval '30 days'))
      order by id desc limit 20`;
    const view: AccountView = {
      handle: String(c.handle), githubLogin: (c.github_login as string | null) ?? null,
      avatarUrl: typeof c.avatar_url === 'string' && c.avatar_url.startsWith('https://avatars.githubusercontent.com/') ? c.avatar_url : null,
      trust: String(c.trust), reviewFirst: this.cfg.reviewFirst,
      quotas: {
        concurrent: c.play_concurrent == null ? this.cfg.playConcurrent : Number(c.play_concurrent),
        daily: c.play_daily == null ? this.cfg.playDaily : Number(c.play_daily),
        custom: c.play_concurrent != null || c.play_daily != null,
        lobbyConcurrent: c.lobby_concurrent == null ? this.cfg.lobbyConcurrent : Number(c.lobby_concurrent),
        lobbyDaily: c.lobby_daily == null ? this.cfg.lobbyDaily : Number(c.lobby_daily),
        lobbyCustom: c.lobby_concurrent != null || c.lobby_daily != null,
      },
      tokens: tokens.map((t) => ({ id: Number(t.id), prefix: String(t.prefix), scopes: (t.scopes as string[]) ?? [], createdAt: t.created_at as Date, lastUsedAt: (t.last_used_at as Date | null) ?? null })),
      maxTokens: MAX_ACTIVE_TOKENS,
      csrf: this.csrf(s),
      visibility: (c.board_visibility as 'public' | 'hidden' | null) ?? null,
      handleHiddenByModerators: c.moderation_hidden != null,
      terms: {
        current: TERMS_VERSION, acceptedVersion: (c.terms_version as string | null) ?? null,
        acceptedAt: (c.terms_accepted_at as Date | null) ?? null,
        accepted: !asksTerms(String(c.kind)) || c.terms_version === TERMS_VERSION,
        summary: TERMS_SUMMARY, links: termsLinks(this.cfg.publicUrl),
      },
      points: this.points(s.c),
      pending: pending.map((p) => ({
        id: Number(p.id), eventId: (p.event_id as string | null) ?? null, status: String(p.status), receivedAt: p.received_at as Date,
        reasons: ((p.reasons ?? []) as Array<{ code: string; severity: string; message: string }>).filter((r) => r.severity === 'hold' || r.severity === 'reject').map((r) => r.message).slice(0, 3),
        note: (p.review_note as string | null) ?? null,
      })),
      ...extra,
    };
    const nonce = b64(randomBytes(16));
    this.html(res, 200, accountPage(view, nonce), setCookies.length ? { 'Set-Cookie': setCookies } : {}, nonce);
  }

  private async post(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    const origin = req.headers.origin;
    if (origin && origin !== this.origin) return this.html(res, 403, messagePage('Request Refused', 'Cross-site requests are not allowed.', { error: true }));
    const s = await this.session(req);
    const body = await readForm(req);
    if (!s) return this.html(res, 401, messagePage('Sign In Again', 'For your safety, account changes need a sign-in within the last 10 minutes.', { signIn: true }));
    if (!body || !same(body.get('csrf') ?? '', this.csrf(s))) {
      return this.html(res, 403, messagePage('Request Refused', 'The form expired or did not come from this page. Reload your account page and try again.', { error: true }));
    }
    if (!this.posts.take(`c:${s.c}`)) {
      return this.html(res, 429, messagePage('Slow Down', 'Too many changes in a short time. Wait a few minutes.', { error: true }), { 'Retry-After': String(Math.max(1, this.posts.retryAfter(`c:${s.c}`))) });
    }
    // Sessions only ever name GitHub-linked accounts: never the admin account or a hosted Director.
    const [c] = await this.sql`select status from contributors where id = ${s.c} and github_id is not null`;
    if (!c || c.status !== 'active') return this.render(res, s, {});

    if (path === '/account/signout') {
      // Every session cookie issued before now stops working, wherever it is (HUB-17).
      await this.sql`update contributors set session_epoch = session_epoch + 1 where id = ${s.c}`;
      return this.html(res, 200, messagePage('Signed Out', 'You are signed out. Your tokens keep working until you revoke them.', { signIn: true }),
        { 'Set-Cookie': this.cookie(this.sessionCookieName, '', { maxAgeS: 0, sameSite: 'Strict', path: '/' }) });
    }
    if (path === '/account/tokens') {
      // Count and insert under a lock on the contributor row, so parallel requests can't pass the cap together (HUB-17).
      const t = await this.sql.begin(async (tx) => {
        await tx`select id from contributors where id = ${s.c} for update`;
        const [{ n }] = (await tx`select count(*)::int as n from tokens where contributor_id = ${s.c} and revoked_at is null`) as unknown as [{ n: number }];
        if (n >= MAX_ACTIVE_TOKENS) return null;
        return issueToken(tx as unknown as Sql, s.c, 'contributor', 'account page');
      });
      if (!t) return this.render(res, s, { error: `You already have ${MAX_ACTIVE_TOKENS} active tokens. Revoke one first.` });
      return this.render(res, s, { newToken: t.token });
    }
    if (path === '/account/rotate') {
      const t = await this.sql.begin(async (tx) => {
        await tx`update tokens set revoked_at = now() where contributor_id = ${s.c} and revoked_at is null`;
        return issueToken(tx as unknown as Sql, s.c, 'contributor', 'rotated');
      });
      return this.render(res, s, { newToken: t.token, message: 'Every earlier token is revoked.' });
    }
    if (path === '/account/terms') {
      if (body.get('version') !== TERMS_VERSION) return this.render(res, s, { error: 'The terms changed while this page was open. Read the current summary and accept again.' });
      await acceptTerms(this.sql, s.c, 'web');
      return this.render(res, s, { message: `Thank you. You accepted the terms (version ${TERMS_VERSION}); hosted play and uploads are open to you.` });
    }
    if (path === '/account/visibility') {
      const v = body.get('visibility');
      if (v !== 'public' && v !== 'hidden' && v !== 'lobby') return this.render(res, s, { error: 'Choose Show, Hide or Follow My Lobby Choice.' });
      await this.sql`update contributors set board_visibility = ${v === 'lobby' ? null : v} where id = ${s.c}`;
      this.changed(s.c);
      return this.render(res, s, { message: v === 'hidden' ? 'You are hidden from the Contributors Leaderboard. Your points still count.' : v === 'public' ? 'You are shown on the Contributors Leaderboard.' : 'The leaderboard follows the handle choice of your latest lobby seat.' });
    }
    const m = /^\/account\/tokens\/(\d{1,15})\/revoke$/.exec(path);
    if (m) {
      const r = await this.sql`update tokens set revoked_at = now() where id = ${Number(m[1])} and contributor_id = ${s.c} and revoked_at is null returning id`;
      return this.render(res, s, r.length ? { message: 'Token revoked.' } : { error: 'No such active token.' });
    }
    return this.html(res, 404, messagePage('Not Found', 'There is nothing here.', { error: true }));
  }
}

/** GET /user with a GitHub access token (used once, never stored or logged). */
export async function fetchGithubUser(cfg: HubConfig, accessToken: string): Promise<GithubUser> {
  const ur = await fetch(`${cfg.github.apiUrl}/user`, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/vnd.github+json', 'User-Agent': 'mtgdt-hub', 'X-GitHub-Api-Version': '2022-11-28' },
    signal: AbortSignal.timeout(15_000),
  });
  const u = (await ur.json().catch(() => ({}))) as GithubUser;
  if (!ur.ok || !Number.isSafeInteger(u.id) || u.id <= 0 || typeof u.login !== 'string' || !u.login) throw new Error(`user: http ${ur.status}`);
  return u;
}

/** Why a GitHub account may not get a token (suspended on GitHub, younger than HUB_GITHUB_MIN_ACCOUNT_DAYS), if it may not. */
export function githubRefusal(cfg: HubConfig, user: GithubUser): { title: string; text: string } | undefined {
  if (user.suspended_at) return { title: 'Account Not Allowed', text: 'This GitHub account is suspended, so it cannot get a token.' };
  const minDays = cfg.github.minAccountDays;
  if (minDays > 0 && user.created_at && Date.now() - Date.parse(user.created_at) < minDays * 86_400_000) {
    return { title: 'Account Too New', text: `GitHub accounts need to be at least ${minDays} days old to get a token. Contact us if you need one sooner.` };
  }
  return undefined;
}

async function readForm(req: IncomingMessage): Promise<URLSearchParams | undefined> {
  const max = 8 * 1024;
  if (Number(req.headers['content-length'] ?? 0) > max) return undefined;
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) {
    n += (c as Buffer).length;
    if (n > max) return void req.destroy();
    chunks.push(c as Buffer);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

/** The contributor linked to this GitHub user id, created on first sign-in (handle from the login). */
export async function findOrCreateGithubContributor(sql: Sql, u: GithubUser): Promise<{ id: number; handle: string; status: string; created: boolean }> {
  const avatar = typeof u.avatar_url === 'string' ? u.avatar_url.slice(0, 500) : null;
  const created = u.created_at && !Number.isNaN(Date.parse(u.created_at)) ? new Date(u.created_at) : null;
  const login = String(u.login).slice(0, 39);
  const existing = async () => {
    const [r] = await sql`
      update contributors set github_login = ${login}, avatar_url = ${avatar}, github_created_at = coalesce(github_created_at, ${created}), last_login_at = now()
      where github_id = ${u.id} returning id, handle, status`;
    return r ? { id: Number(r.id), handle: String(r.handle), status: String(r.status), created: false } : undefined;
  };
  const found = await existing();
  if (found) return found;
  let base = login.toLowerCase().replace(/[^a-z0-9_.-]/g, '-').replace(/^[^a-z0-9]+/, '').slice(0, 34) || 'gh';
  if (!HANDLE_RE.test(base)) base = `gh-${u.id}`.slice(0, 34);
  // System handles (hosted Directors, the admin account, erased accounts) are never claimable by a GitHub login; handles
  // that could pass for us or a moderator get a prefix too (the review queue also flags look-alikes: moderation.ts).
  if (/^(director-|erased-|maintainers$|admin$|hub$|system$|moderators?$|mtgdt$|mtgdecktools$|agent-bench$|support$|staff$)/.test(base)) base = `gh-${base}`.slice(0, 34);
  for (let i = 0; i < 20; i++) {
    const handle = i === 0 ? base : `${base}-gh${i === 1 ? '' : i}`;
    try {
      const [r] = await sql`
        insert into contributors (handle, kind, trust, note, github_id, github_login, avatar_url, github_created_at, last_login_at)
        values (${handle}, 'person', 'new', 'GitHub sign-in', ${u.id}, ${login}, ${avatar}, ${created}, now())
        on conflict (handle) do nothing returning id, handle, status`;
      if (r) {
        // The review queue: handles the content filter flags (offensive words, impersonation). Never blocks sign-in.
        await scanHandle(sql, Number(r.id), String(r.handle)).catch((e) => console.error(`handle scan failed: ${(e as Error).message}`));
        return { id: Number(r.id), handle: String(r.handle), status: String(r.status), created: true };
      }
    } catch (e) {
      // Two sign-ins of the same new user at once: the other one created it.
      if (/github_id/.test((e as Error).message)) {
        const again = await existing();
        if (again) return again;
      }
      throw e;
    }
  }
  throw new Error('could not find a free handle');
}
