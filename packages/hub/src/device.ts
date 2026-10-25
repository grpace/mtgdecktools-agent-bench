/**
 * GitHub device flow for the CLI (`npm run bench -- login`): sign in on any device, get a contributor token in the
 * terminal. GitHub's device_code never leaves the Hub; the client holds an opaque device_id.
 *
 *   POST /auth/device/start           → { device_id, user_code, verification_uri, interval, expires_in }
 *   POST /auth/device/poll { device_id }
 *     200 { status: "pending", interval }        the user hasn't entered the code yet
 *     429 { status: "slow_down", interval }      GitHub (or the Hub) wants slower polling: wait `interval` seconds
 *     200 { status: "ok", token, handle, scopes, quotas }   exactly once; the device session is then gone
 *     410 { status: "expired" | "denied", error }           start again
 *     403 { status: "refused", error }           suspended GitHub user or contributor, account too new
 *     409 { status: "refused", error }           already at the active-token cap: revoke one at /account
 *     404 { status: "expired", error }           unknown device_id
 *
 * The GitHub access token is used once to read the user and is never stored or logged.
 */
import { randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { fetchGithubUser, findOrCreateGithubContributor, githubRefusal, MAX_ACTIVE_TOKENS } from './account.js';
import type { HubConfig } from './config.js';
import type { Sql } from './db.js';
import { clientIp, RateLimiter } from './ratelimit.js';
import { issueToken, scopesOf } from './tokens.js';

const MAX_SESSIONS = 1000;
/** Polls a little early (clock jitter, network) are fine; this much early is not. */
const POLL_TOLERANCE_MS = 500;

interface DeviceSession {
  deviceCode: string;
  interval: number;
  expiresAt: number;
  /** Earliest time the next poll is allowed. */
  nextPollAt: number;
  busy: boolean;
}

export interface DeviceAnswer {
  http: number;
  body: Record<string, unknown>;
  headers?: Record<string, string>;
}

export class DeviceFlow {
  private sessions = new Map<string, DeviceSession>();
  private starts = new RateLimiter(10, 15 * 60_000);
  private polls = new RateLimiter(120, 60_000);

  constructor(private cfg: HubConfig, private sql: Sql) {}

  get enabled(): boolean {
    return !!this.cfg.github.clientId;
  }

  private prune(now = Date.now()): void {
    for (const [id, s] of this.sessions) if (s.expiresAt <= now) this.sessions.delete(id);
  }

  async start(req: IncomingMessage): Promise<DeviceAnswer> {
    if (!this.enabled) return { http: 503, body: { error: 'GitHub sign-in is not enabled on this Hub' } };
    const ip = clientIp(req, this.cfg.trustProxy);
    if (!this.starts.take(`ip:${ip}`)) {
      return { http: 429, body: { error: 'too many sign-in attempts from your network; wait a few minutes' }, headers: { 'Retry-After': String(Math.max(1, this.starts.retryAfter(`ip:${ip}`))) } };
    }
    this.prune();
    if (this.sessions.size >= MAX_SESSIONS) return { http: 503, body: { error: 'too many sign-ins in progress; try again in a few minutes' }, headers: { 'Retry-After': '60' } };
    let r: Response;
    try {
      r = await fetch(`${this.cfg.github.oauthUrl}/login/device/code`, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'mtgdt-hub' },
        body: JSON.stringify({ client_id: this.cfg.github.clientId, scope: 'read:user' }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (e) {
      console.error(`github device code request failed: ${(e as Error).name}`);
      return { http: 502, body: { error: 'GitHub could not be reached; try again in a moment' } };
    }
    const j = (await r.json().catch(() => ({}))) as { device_code?: string; user_code?: string; verification_uri?: string; expires_in?: number; interval?: number; error?: string };
    if (!r.ok || !j.device_code || !j.user_code || !j.verification_uri) {
      console.error(`github device code request failed: http ${r.status}${j.error ? ` (${String(j.error).slice(0, 60)})` : ''}`);
      return { http: 502, body: { error: 'GitHub refused to start the sign-in; try again later' } };
    }
    const interval = Math.min(60, Math.max(1, Number(j.interval) || 5));
    const expiresIn = Math.min(1800, Math.max(60, Number(j.expires_in) || 900));
    const id = randomBytes(24).toString('base64url');
    const now = Date.now();
    this.sessions.set(id, { deviceCode: j.device_code, interval, expiresAt: now + expiresIn * 1000, nextPollAt: now + interval * 1000, busy: false });
    return { http: 200, body: { device_id: id, user_code: j.user_code, verification_uri: j.verification_uri, interval, expires_in: expiresIn } };
  }

  async poll(req: IncomingMessage, deviceId: unknown): Promise<DeviceAnswer> {
    if (!this.enabled) return { http: 503, body: { error: 'GitHub sign-in is not enabled on this Hub' } };
    const ip = clientIp(req, this.cfg.trustProxy);
    if (!this.polls.take(`ip:${ip}`)) return { http: 429, body: { status: 'slow_down', interval: 10, error: 'too many requests' }, headers: { 'Retry-After': '10' } };
    if (typeof deviceId !== 'string' || deviceId.length > 100) return { http: 400, body: { error: 'body must be JSON { "device_id": "..." }' } };
    const now = Date.now();
    const s = this.sessions.get(deviceId);
    if (!s || s.expiresAt <= now) {
      this.sessions.delete(deviceId);
      return { http: s ? 410 : 404, body: { status: 'expired', error: s ? 'the code expired; run the login again' : 'unknown or expired device_id; run the login again' } };
    }
    if (s.busy || now < s.nextPollAt - POLL_TOLERANCE_MS) {
      s.interval = Math.min(60, s.interval + 5);
      s.nextPollAt = now + s.interval * 1000;
      return { http: 429, body: { status: 'slow_down', interval: s.interval }, headers: { 'Retry-After': String(s.interval) } };
    }
    s.busy = true;
    try {
      return await this.check(deviceId, s, now);
    } finally {
      s.busy = false;
    }
  }

  private async check(deviceId: string, s: DeviceSession, now: number): Promise<DeviceAnswer> {
    const done = (a: DeviceAnswer) => {
      this.sessions.delete(deviceId);
      return a;
    };
    let r: Response;
    try {
      r = await fetch(`${this.cfg.github.oauthUrl}/login/oauth/access_token`, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'mtgdt-hub' },
        body: JSON.stringify({ client_id: this.cfg.github.clientId, device_code: s.deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (e) {
      console.error(`github device poll failed: ${(e as Error).name}`);
      s.nextPollAt = now + s.interval * 1000;
      return { http: 200, body: { status: 'pending', interval: s.interval } };
    }
    const j = (await r.json().catch(() => ({}))) as { access_token?: string; error?: string; interval?: number };
    s.nextPollAt = Date.now() + s.interval * 1000;
    if (!j.access_token) {
      switch (j.error) {
        case 'authorization_pending':
          return { http: 200, body: { status: 'pending', interval: s.interval } };
        case 'slow_down':
          s.interval = Math.min(60, Math.max(s.interval + 5, Number(j.interval) || 0));
          s.nextPollAt = Date.now() + s.interval * 1000;
          return { http: 429, body: { status: 'slow_down', interval: s.interval }, headers: { 'Retry-After': String(s.interval) } };
        case 'expired_token':
          return done({ http: 410, body: { status: 'expired', error: 'the code expired before it was entered; run the login again' } });
        case 'access_denied':
          return done({ http: 410, body: { status: 'denied', error: 'the sign-in was canceled on GitHub' } });
        default:
          console.error(`github device poll failed: http ${r.status}${j.error ? ` (${String(j.error).slice(0, 60)})` : ''}`);
          return done({ http: 502, body: { status: 'error', error: 'GitHub refused the sign-in; run the login again' } });
      }
    }
    let user;
    try {
      user = await fetchGithubUser(this.cfg, j.access_token);
    } catch (e) {
      console.error(`github device sign-in failed: ${(e as Error).message}`);
      return done({ http: 502, body: { status: 'error', error: 'GitHub could not confirm the sign-in; run the login again' } });
    }
    const refused = githubRefusal(this.cfg, user);
    if (refused) return done({ http: 403, body: { status: 'refused', error: refused.text } });
    const c = await findOrCreateGithubContributor(this.sql, user);
    if (c.status !== 'active') return done({ http: 403, body: { status: 'refused', error: 'this contributor account is suspended; contact us if you think this is a mistake' } });
    // Count and insert under a lock on the contributor row, as the account page does: parallel logins can't pass the cap together.
    const t = await this.sql.begin(async (tx) => {
      await tx`select id from contributors where id = ${c.id} for update`;
      const [{ n }] = (await tx`select count(*)::int as n from tokens where contributor_id = ${c.id} and revoked_at is null`) as unknown as [{ n: number }];
      if (n >= MAX_ACTIVE_TOKENS) return null;
      return issueToken(tx as unknown as Sql, c.id, 'contributor', 'cli login (device flow)');
    });
    if (!t) {
      return done({ http: 409, body: { status: 'refused', error: `you already have ${MAX_ACTIVE_TOKENS} active tokens; revoke one at ${this.cfg.publicUrl}/account and run the login again` } });
    }
    const [q] = await this.sql`select play_concurrent, play_daily, lobby_concurrent, lobby_daily from contributors where id = ${c.id}`;
    return done({
      http: 200,
      body: {
        status: 'ok', token: t.token, handle: c.handle, scopes: scopesOf('contributor'),
        quotas: {
          play_concurrent: q?.play_concurrent == null ? this.cfg.playConcurrent : Number(q.play_concurrent),
          play_daily: q?.play_daily == null ? this.cfg.playDaily : Number(q.play_daily),
          lobby_concurrent: q?.lobby_concurrent == null ? this.cfg.lobbyConcurrent : Number(q.lobby_concurrent),
          lobby_daily: q?.lobby_daily == null ? this.cfg.lobbyDaily : Number(q.lobby_daily),
        },
      },
    });
  }
}
