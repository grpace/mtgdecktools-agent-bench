/**
 * Contributor tokens on the hosted Director ("bring your agent, we host the table").
 *
 * Contributors hold Hub tokens (packages/hub: GitHub sign-in or `hub token issue`). A token with the `play`
 * scope may create events here. The Director checks it with the Hub's introspection endpoint
 * (`POST $HUB_URL/api/internal/tokens/introspect`, authenticated with the Director's service token) and caches the
 * answer briefly. Why introspection rather than a signed short-lived capability:
 * - revocation, suspension and quota changes on the Hub take effect within the cache TTL (60 s), with no key
 *   distribution or rotation between services;
 * - contributors use one long-lived token everywhere (submit + play) instead of minting capabilities;
 * - the Hub is only needed when an event is created, a rare operation; running events never depend on it.
 * If the Hub can't be reached, creating an event fails with 503 (and a cached positive answer still works for its TTL).
 *
 * The answer also carries the contributor's leaderboard visibility (`board_visibility`), and visibility() reads it for
 * many contributors at once, so the lobby hides a handle the contributor hid on the Hub (LOB-3).
 */
import { createHash } from 'node:crypto';
import type { HubTarget } from './hub-handoff.js';
import type { ModerationList } from './public-text.js';

export interface Contributor {
  id: number;
  handle: string;
  kind: string;
  trust: string;
  github_login?: string | null;
}

export interface Introspection {
  active: boolean;
  contributor?: Contributor;
  scopes?: string[];
  token_id?: number;
  token_prefix?: string;
  /** play_*: Private Tables; lobby_*: lobby tables, counted separately (Hubs from 2026-10-22 on). */
  quotas?: { play_concurrent?: number; play_daily?: number; lobby_concurrent?: number; lobby_daily?: number };
  /** The Hub's leaderboard setting: 'hidden' wins over the lobby's show choice, 'public' too; null follows the lobby choice. */
  board_visibility?: Visibility;
  /** The contributor's acceptance of the current terms (Hubs from 2026-10-22 on). Hosted play needs `accepted`. */
  terms?: { current: string; accepted_version: string | null; accepted: boolean; message?: string };
}

export type Visibility = 'public' | 'hidden' | null;

export class HubUnavailable extends Error {}

export class HubAuth {
  private cache = new Map<string, { at: number; v: Introspection }>();

  constructor(
    private target: HubTarget,
    private opts: { ttlMs?: number; negativeTtlMs?: number; timeoutMs?: number; fetchFn?: typeof fetch } = {},
  ) {}

  /** The Hub's answer for this token (cached: 60 s when active, 15 s when not). Throws HubUnavailable. */
  async introspect(token: string, now = Date.now()): Promise<Introspection> {
    if (!token || token.length < 24 || token.length > 200 || !/^[\w.-]+$/.test(token)) return { active: false };
    const key = createHash('sha256').update(token).digest('hex');
    const hit = this.cache.get(key);
    // An answer that refuses play (inactive, or terms not accepted) is cached briefly: accepting the terms or fixing a
    // token takes effect within seconds.
    const short = !hit?.v.active || hit.v.terms?.accepted === false;
    if (hit && now - hit.at < (short ? this.opts.negativeTtlMs ?? 15_000 : this.opts.ttlMs ?? 60_000)) return hit.v;
    let res: Response;
    try {
      res = await (this.opts.fetchFn ?? fetch)(`${this.target.url}/api/internal/tokens/introspect`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.target.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 10_000),
      });
    } catch (err) {
      throw new HubUnavailable(`the Hub can't be reached to check your token (${(err as Error).message}); try again shortly`);
    }
    if (!res.ok) throw new HubUnavailable(`the Hub answered ${res.status} when checking your token; try again shortly`);
    const v = (await res.json()) as Introspection;
    const clean: Introspection = v?.active === true && v.contributor ? v : { active: false };
    // Oldest first, so a burst of new tokens never sends every cached one back to the Hub (LOB-13).
    while (this.cache.size >= 10_000) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(key, { at: now, v: clean });
    return clean;
  }

  /** The Hub's moderation list (GET /api/internal/moderation): takedowns, hidden text and handles, erasures. Throws HubUnavailable. */
  async moderation(): Promise<ModerationList> {
    let res: Response;
    try {
      res = await (this.opts.fetchFn ?? fetch)(`${this.target.url}/api/internal/moderation`, {
        headers: { Authorization: `Bearer ${this.target.token}` },
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 10_000),
      });
    } catch (err) {
      throw new HubUnavailable(`the Hub can't be reached (${(err as Error).message})`);
    }
    if (!res.ok) throw new HubUnavailable(`the Hub answered ${res.status} for the moderation list`);
    const v = (await res.json()) as Partial<ModerationList>;
    const strings = (x: unknown) => (Array.isArray(x) ? x.filter((y): y is string => typeof y === 'string') : []);
    return {
      version: typeof v.version === 'string' ? v.version : 'unknown',
      takedowns: strings(v.takedowns),
      hides: Array.isArray(v.hides) ? v.hides.filter((h) => h && (h.kind === 'note' || h.kind === 'deck_name') && typeof h.event === 'string' && typeof h.seat === 'string')
        .map((h) => ({ kind: h.kind, event: h.event, seat: h.seat, item: String(h.item ?? '') })) : [],
      hiddenHandles: strings(v.hiddenHandles),
      erased: Array.isArray(v.erased) ? v.erased.filter((e) => e && typeof e.id === 'string' && typeof e.anon === 'string') : [],
    };
  }

  /** The Hub's visibility setting of these contributors (POST /api/internal/contributors/visibility). Throws HubUnavailable. */
  async visibility(ids: number[]): Promise<Record<string, Visibility>> {
    if (!ids.length) return {};
    let res: Response;
    try {
      res = await (this.opts.fetchFn ?? fetch)(`${this.target.url}/api/internal/contributors/visibility`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.target.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: ids.slice(0, 5000) }),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 10_000),
      });
    } catch (err) {
      throw new HubUnavailable(`the Hub can't be reached (${(err as Error).message})`);
    }
    if (!res.ok) throw new HubUnavailable(`the Hub answered ${res.status} for contributor visibility`);
    const v = (await res.json()) as { visibility?: Record<string, unknown> };
    const out: Record<string, Visibility> = {};
    for (const [k, x] of Object.entries(v?.visibility ?? {})) if (/^\d+$/.test(k)) out[k] = x === 'public' || x === 'hidden' ? x : null;
    return out;
  }
}
