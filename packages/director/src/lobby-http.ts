/**
 * HTTP routes of the matchmaking lobby (contract: docs/LOBBY.md §4–§6). The state machine is lobby.ts; the
 * server (server.ts) supplies auth, set policy and event status through LobbyHttpDeps.
 *
 *   GET    /api/lobby                         overview: queues, scheduled tables, recent tables (public, cached 5 s)
 *   GET    /api/lobby/queues/<key>            one queue (public; any valid key, so invite links always resolve)
 *   GET    /api/lobby/schedule                scheduled tables (public)
 *   GET    /api/lobby/stats                   contribution stats (public, cached 60 s)
 *   GET    /api/lobby/models/<model_id>       one model's stats and public backers
 *   GET    /api/lobby/contributors/<handle>   one public contributor
 *   POST   /api/lobby/join                    (contributor token, GitHub sign-in) join a queue or a scheduled table → ticket
 *   GET    /api/lobby/tickets/<ticket>        the holder's view; ?rev=<n>&wait=40 long-polls (keeps the entries present)
 *   POST   /api/lobby/tickets/<ticket>/confirm         { table_id }: confirm a ready check
 *   DELETE /api/lobby/tickets/<ticket>[/entries/<id>]  leave
 *   GET    /api/admin/lobby                   (admin) full state
 *   PUT    /api/admin/lobby/config            (admin) featured queues and schedules
 *   DELETE /api/admin/lobby/entries/<id>      (admin) remove an entry
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { KNOWLEDGE_LEVELS, type KnowledgeLevel } from './knowledge.js';
import { bestOfProblem } from './best-of.js';
import { Lobby, LobbyError, normalizeQueueKey, parseQueueKey, queueKey, queueKeyProblem, type Schedule, type ViewContext } from './lobby.js';
import { readBody } from './mcp.js';
import { BodyTooLarge } from './ratelimit.js';
import { resolveSeatIdentity, type SeatIdentity } from './seat-identity.js';

export interface LobbyCaller {
  kind: 'admin' | 'contributor';
  id?: number;
  handle?: string;
  /** The token comes from GitHub sign-in on the Hub (the lobby requires it). */
  github?: boolean;
  /** The Hub's leaderboard setting (LOB-3): 'hidden' or 'public' wins over show_handle. */
  visibility?: 'public' | 'hidden' | null;
  /** The contributor's lobby quotas from the Hub (separate from their Private Tables; LOB-2). */
  quotas?: { concurrent?: number; daily?: number };
}

export interface LobbyHttpDeps {
  lobby(): Lobby | undefined;
  /** Who is calling (throws an HTTP-shaped error for bad tokens); undefined without a token. */
  caller(req: IncomingMessage, needPlay: boolean): Promise<LobbyCaller | undefined>;
  isAdmin(req: IncomingMessage): boolean;
  ctx(): ViewContext;
  /** Why this set can't have a lobby queue (not hosted, not featured), or undefined when it can. */
  setProblem(set: string, knowledge: KnowledgeLevel): string | undefined;
  jsonMaxBytes: number;
}

const CACHE_MS = 5_000;
const STATS_CACHE_MS = 60_000;
const MAX_WAIT_S = 40;
/**
 * Long-polls held at once, per ticket and in all (LOB-6, SEC-5). Without a cap one ticket holder could hold every
 * connection the server accepts, and seats couldn't reach it. Beyond the cap a poll answers at once.
 */
export const MAX_WAITS_PER_TICKET = 2;
export const MAX_WAITS = 500;
const CACHE_ENTRIES = 2_000;

/** A path segment decoded, or undefined when its percent-encoding is malformed (404, never a 500 with a stack: LOB-12). */
function decodeSegment(raw: string): string | undefined {
  try {
    return decodeURIComponent(raw);
  } catch {
    return undefined;
  }
}

export class LobbyHttp {
  private cache = new Map<string, { at: number; body: unknown }>();
  private waits = new Map<string, number>();
  private waiting = 0;

  constructor(private deps: LobbyHttpDeps) {}

  /** Handle a lobby route; false when the path isn't one. */
  async handle(req: IncomingMessage, res: ServerResponse, url: URL, path: string): Promise<boolean> {
    if (!(path === '/api/lobby' || path.startsWith('/api/lobby/') || path === '/api/admin/lobby' || path.startsWith('/api/admin/lobby/'))) return false;
    const send = (code: number, body: unknown, headers: Record<string, string> = {}) => {
      if (res.headersSent || res.destroyed) return true;
      res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers }).end(JSON.stringify(body, null, 1));
      return true;
    };
    const pub = (body: unknown, maxAge = 5) => send(200, body, { 'Cache-Control': `public, max-age=${maxAge}`, 'Access-Control-Allow-Origin': '*' });
    const lobby = this.deps.lobby();
    if (!lobby) return send(503, { error: 'the lobby is starting; try again in a few seconds' }, { 'Retry-After': '5' });
    const now = Date.now();
    try {
      // ----- admin
      if (path.startsWith('/api/admin/lobby')) {
        if (!this.deps.isAdmin(req)) return send(401, { error: 'admin token required' });
        if (path === '/api/admin/lobby' && req.method === 'GET') return send(200, lobby.adminView(now));
        if (path === '/api/admin/lobby/config' && req.method === 'PUT') {
          const body = (await this.body(req)) as { featured?: string[]; schedules?: Schedule[] } | undefined;
          if (!body || typeof body !== 'object') return send(400, { error: 'body: { "featured": [...], "schedules": [...] }' });
          for (const key of [...(body.featured ?? []), ...(body.schedules ?? []).map((s) => s?.queue)]) {
            const q = parseQueueKey(String(key));
            const problem = q ? this.deps.setProblem(q.set, q.knowledge) : (queueKeyProblem(String(key)) ?? `invalid queue key ${JSON.stringify(key)}`);
            if (problem && q && !/featured/.test(problem)) return send(400, { error: `${key}: ${problem}` });
            if (!q) return send(400, { error: problem });
          }
          lobby.setConfig(body, now);
          this.cache.clear();
          return send(200, lobby.state.config);
        }
        const rm = path.match(/^\/api\/admin\/lobby\/entries\/(e-[0-9a-f]{8})$/);
        if (rm && req.method === 'DELETE') return lobby.remove(rm[1]!, now) ? send(200, { removed: rm[1] }) : send(404, { error: 'no such active entry' });
        return send(404, { error: 'not found' });
      }

      // ----- public reads (cached)
      if (req.method === 'GET' && !path.startsWith('/api/lobby/tickets/')) {
        const stats = path === '/api/lobby/stats' || path.startsWith('/api/lobby/models/') || path.startsWith('/api/lobby/contributors/');
        const hit = this.cache.get(path);
        const cors = { 'Access-Control-Allow-Origin': '*' };
        if (hit && now - hit.at < (stats ? STATS_CACHE_MS : CACHE_MS)) return hit.body == null ? send(404, { error: 'not found' }, cors) : pub(hit.body, stats ? 60 : 5);
        const ctx = this.deps.ctx();
        let body: unknown;
        if (path === '/api/lobby') body = lobby.overview(now, ctx);
        else if (path === '/api/lobby/schedule') body = { api_version: 1, scheduled: lobby.scheduleViews(now, ctx) };
        else if (path === '/api/lobby/stats') body = lobby.stats(now);
        else if (path.startsWith('/api/lobby/queues/')) {
          const key = decodeSegment(path.slice('/api/lobby/queues/'.length));
          if (key === undefined) return send(404, { error: 'not found' }, cors);
          const q = lobby.queueView(key, now, ctx);
          // A best-of-1 invite link (best of 1 was removed): say so instead of a bare 404.
          if (!q && /-bo\d+$/i.test(key)) {
            const problem = queueKeyProblem(key);
            if (problem) return send(404, { error: problem }, cors);
          }
          body = q ? { api_version: 1, ...q, recent: lobby.recentTables(now, ctx, (f) => f.queue === q.key, 10) } : undefined;
        } else if (path.startsWith('/api/lobby/models/') || path.startsWith('/api/lobby/contributors/')) {
          const models = path.startsWith('/api/lobby/models/');
          const name = decodeSegment(path.slice((models ? '/api/lobby/models/' : '/api/lobby/contributors/').length));
          if (name === undefined) return send(404, { error: 'not found' }, cors);
          body = models ? lobby.modelStats(name.slice(0, 80), now) : lobby.contributorStatsView(name.slice(0, 80), now, ctx);
        } else return send(404, { error: 'not found' }, cors);
        // Oldest entries go first, so a flood of distinct paths can't flush every hot entry at once (LOB-13 style).
        this.cache.delete(path);
        while (this.cache.size >= CACHE_ENTRIES) this.cache.delete(this.cache.keys().next().value!);
        this.cache.set(path, { at: now, body });
        return body == null ? send(404, { error: 'not found' }, cors) : pub(body, stats ? 60 : 5);
      }

      // ----- join
      if (path === '/api/lobby/join' && req.method === 'POST') {
        const who = await this.deps.caller(req, true);
        if (!who) return send(401, { error: 'a contributor token is required (Authorization: Bearer <token>); sign in with `bench login`' });
        if (who.kind !== 'contributor' || who.id == null) return send(403, { error: 'the lobby seats contributors: use a contributor token from GitHub sign-in (`bench login`), not the admin token' });
        if (!who.github) return send(403, { error: 'the lobby needs a contributor token from GitHub sign-in on the Hub (`bench login`); this token is not linked to a GitHub account' });
        const body = (await this.body(req)) as Record<string, unknown> | undefined;
        if (!body || typeof body !== 'object') return send(400, { error: 'body: { "queue": "fra-primer-manual", "seats": [{ "harness", "model", "effort" }] }' });
        let key: string | undefined;
        if (body.schedule == null) {
          // Every queue plays best of 3 with sideboarding: a best_of other than 3 is refused, absent means 3.
          const bestOf = bestOfProblem(body.best_of);
          if (bestOf) return send(400, { error: bestOf });
          if (typeof body.queue === 'string') {
            const problem = queueKeyProblem(body.queue);
            if (problem) return send(400, { error: problem });
            key = normalizeQueueKey(body.queue)!;
          } else {
            const knowledge = (body.knowledge ?? 'primer') as KnowledgeLevel;
            if (!KNOWLEDGE_LEVELS.includes(knowledge)) return send(400, { error: `knowledge must be one of ${KNOWLEDGE_LEVELS.join(', ')}` });
            const mana = body.mana ?? 'manual';
            if (mana !== 'manual' && mana !== 'auto') return send(400, { error: 'mana must be manual or auto' });
            if (typeof body.set !== 'string' || !/^[A-Za-z0-9]{2,8}$/.test(body.set)) return send(400, { error: 'give a queue key, or set (+ knowledge, mana)' });
            key = queueKey({ set: body.set, knowledge, mana });
          }
          const q = parseQueueKey(key);
          if (!q) return send(400, { error: `invalid queue key "${String(key).slice(0, 40)}" (e.g. fra-primer-manual)` });
          const problem = this.deps.setProblem(q.set, q.knowledge);
          if (problem) return send(400, { error: problem });
        } else {
          if (typeof body.schedule !== 'string') return send(400, { error: 'schedule must be a schedule id' });
          const s = lobby.state.config.schedules.find((x) => x.id === body.schedule);
          const q = s && parseQueueKey(s.queue);
          const problem = q && this.deps.setProblem(q.set, q.knowledge);
          if (problem && !/featured/.test(problem)) return send(400, { error: problem });
        }
        if (!Array.isArray(body.seats) || !body.seats.length) return send(400, { error: 'seats: 1–3 of { "harness", "model", "effort", "context_policy"? }' });
        const seats: Array<SeatIdentity & { context_policy?: unknown }> = [];
        for (const [i, s] of (body.seats as Array<Record<string, unknown>>).slice(0, 10).entries()) {
          if (s?.effort_basis != null && s.effort_basis !== 'launch' && s.effort_basis !== 'self-report') return send(400, { error: `seat ${i + 1}: effort_basis must be "launch" or "self-report"` });
          const r = resolveSeatIdentity(s ?? {}, { requireEffort: true });
          if (!r.ok) return send(400, { error: `seat ${i + 1}: ${r.error}` });
          const { ok, ...identity } = r;
          void ok;
          // The declared context policy rides along (Lobby.join validates it); never part of the identity.
          seats.push({ ...identity, ...(s?.context_policy != null ? { context_policy: s.context_policy } : {}) });
        }
        if (body.show_handle != null && typeof body.show_handle !== 'boolean') return send(400, { error: 'show_handle must be true or false' });
        const out = lobby.join({ id: who.id, handle: who.handle ?? `contributor-${who.id}` }, {
          ...(typeof body.schedule === 'string' ? { schedule: body.schedule } : { queue: key }), seats, ...(typeof body.show_handle === 'boolean' ? { showHandle: body.show_handle } : {}),
          ...(who.visibility !== undefined ? { visibility: who.visibility } : {}), ...(who.quotas ? { quotas: who.quotas } : {}),
        }, now);
        this.cache.clear();
        const ctx = this.deps.ctx();
        const view = lobby.ticketView(out.ticket, now, ctx) as Record<string, any>;
        return send(201, {
          api_version: 1, ticket: out.ticket, poll_url: `${ctx.publicUrl}/api/lobby/tickets/${out.ticket}`, queue: out.entries[0]!.queue,
          schedule: out.entries[0]!.schedule ? { id: out.entries[0]!.schedule.id, occurrence: out.entries[0]!.schedule.occurrence, starts_at: new Date(out.entries[0]!.schedule.starts_at).toISOString() } : null,
          expires_at: new Date(out.entries[0]!.expires_at).toISOString(), entries: view.entries, message: view.message,
        });
      }

      // ----- ticket holder
      const tm = path.match(/^\/api\/lobby\/tickets\/([0-9a-f]{32})(\/confirm|\/entries\/(e-[0-9a-f]{8}))?$/);
      if (tm) {
        const raw = tm[1]!;
        if (!lobby.touch(raw, now)) return send(404, { error: 'unknown ticket' });
        const ctx = this.deps.ctx();
        if (!tm[2] && req.method === 'GET') {
          const rev = url.searchParams.get('rev');
          const wait = Math.min(MAX_WAIT_S, Math.max(0, Number(url.searchParams.get('wait') ?? MAX_WAIT_S) || 0));
          const held = this.waits.get(raw) ?? 0;
          if (rev != null && Number(rev) === lobby.state.rev && wait > 0 && held < MAX_WAITS_PER_TICKET && this.waiting < MAX_WAITS) {
            let closed = false;
            res.on('close', () => (closed = true));
            this.waits.set(raw, held + 1);
            this.waiting++;
            try {
              await lobby.wait(Number(rev), wait * 1000);
            } finally {
              this.waiting--;
              const left = (this.waits.get(raw) ?? 1) - 1;
              if (left > 0) this.waits.set(raw, left);
              else this.waits.delete(raw);
            }
            if (closed) return true;
            lobby.touch(raw, Date.now());
          }
          return send(200, lobby.ticketView(raw, Date.now(), ctx));
        }
        if (tm[2] === '/confirm' && req.method === 'POST') {
          const body = (await this.body(req)) as { table_id?: unknown } | undefined;
          if (typeof body?.table_id !== 'string') return send(400, { error: 'body: { "table_id": "t-…" }' });
          try {
            lobby.confirm(raw, body.table_id, now);
          } catch (err) {
            if (err instanceof LobbyError) return send(err.status, { error: err.message, ...(lobby.ticketView(raw, now, ctx) ?? {}) });
            throw err;
          }
          await lobby.settled();
          return send(200, lobby.ticketView(raw, Date.now(), ctx));
        }
        if (req.method === 'DELETE') {
          lobby.leave(raw, tm[3], now);
          this.cache.clear();
          return send(200, lobby.ticketView(raw, now, ctx));
        }
        return send(405, { error: 'method not allowed' });
      }
      return send(404, { error: 'not found' });
    } catch (err) {
      if (err instanceof LobbyError) return send(err.status, { error: err.message }, err.retryAfterS ? { 'Retry-After': String(err.retryAfterS) } : {});
      if (err instanceof BodyTooLarge) return send(413, { error: err.message });
      if (err instanceof SyntaxError) return send(400, { error: 'malformed JSON body' });
      throw err;
    }
  }

  private body(req: IncomingMessage): Promise<unknown> {
    return readBody(req, this.deps.jsonMaxBytes);
  }

  /** Drop cached public views (after a table fires or ends). */
  invalidate(): void {
    this.cache.clear();
  }
}
