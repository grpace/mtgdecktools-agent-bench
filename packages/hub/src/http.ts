/**
 * Hub HTTP API.
 *
 *   GET  /health                          liveness, build version (DIRECTOR_TAG) + counts
 *   POST /api/submissions                 (contributor token, scope submit) a results bundle (.tar.gz)
 *   GET  /api/submissions                 (contributor token) your recent submissions
 *   GET  /api/submissions/:id             (contributor token: your own; admin: any) status, reasons, checks
 *   POST /api/internal/events             (service token, scope ingest) a finished event from an official hosted Director
 *   POST /api/usage                       (contributor token, or the admin token for admin tables) usage summaries for hosted seats
 *                                         you seated (src/usage-uploads.ts); rate-limited per sender and per IP
 *   POST /api/internal/tokens/introspect  (service token, scope ingest) body { token, scope? }: a contributor token's owner, scopes, play quotas, visibility
 *   POST /api/internal/contributors/visibility  (service token) body { ids }: leaderboard visibility by contributor id (the lobby honors it)
 *   GET  /auth/github, /auth/github/callback, /account; POST /account/...   GitHub self-serve tokens (src/account.ts)
 *   POST /auth/device/start, /auth/device/poll   GitHub device flow for `bench login` (src/device.ts)
 *   GET  /api/events                      ingested events (public, per-IP rate limit)
 *   GET  /api/events/:id                  one event: seats, games, decks, integrity summary (public, per-IP rate limit)
 *   GET  /api/admin/submissions?status=   (admin token) review queue
 *   POST /api/admin/submissions/:id/(approve|reject)   (admin token) body { note }
 *   POST /api/admin/events/:id/(exclude|include|takedown) (admin token) body { reason }
 *   POST /api/admin/export                (admin token) full re-export
 *   GET  /data/*                          the JSON export (docs/SITE-DATA.md), CORS + cache headers, gzip, ETag
 *   GET  /data/open/*                     the open dataset (docs/OPEN-DATA.md): prebuilt static files only (built nightly in
 *                                         a separate process), Range requests, long cache headers, per-IP rate and
 *                                         concurrency limits
 *   GET  /api/contributors?board=season|all_time&season=YYYY-MM&limit=&offset=   points leaderboard (public, cached 60 s)
 *   GET  /api/contributors/:handle        a contributor's public profile (404 for hidden or unknown handles)
 *   GET  /api/bounties                    what the data needs most (points bounties)
 *   GET  /api/terms                       the current terms version, the short summary, links (public)
 *   GET  /api/account/terms               (contributor token) whether you accepted the current terms
 *   POST /api/account/terms               (contributor token) body { version }: accept the current terms (`bench login` does this)
 *   GET  /legal/terms, /legal/privacy, /legal/content-policy   the documents (docs/legal/*.md, plain text)
 *   GET  /api/internal/moderation         (service token) takedowns, hidden text and handles, erasures (hosted Directors apply them)
 *   Moderation (admin token; every action needs a reason and is logged with who, when and why; body.actor names who):
 *   GET  /api/admin/moderation/queue?status=open|kept|hidden    flagged notes, deck names and handles
 *   POST /api/admin/moderation/flags/:id/(keep|hide)            body { reason, actor? }
 *   POST /api/admin/moderation/notes/hide                       body { event, seat, item, reason, actor? }
 *   POST /api/admin/moderation/deck-names/hide                  body { event, seat, reason, actor? }
 *   GET  /api/admin/moderation/hides, POST /api/admin/moderation/hides/:id/undo   body { reason, actor? }
 *   POST /api/admin/moderation/handles/:handle/(hide|show)      body { reason, actor? }
 *   GET  /api/admin/moderation/log                              the last 100 actions
 *   GET  /api/admin/events/:id/notes?seat=&grep=                an event's agent notes with their keys
 *   POST /api/admin/contributors/:handle/erase                  body { reason, remove_events?, actor? }
 *   POST /api/admin/contributors/:handle/ban                    body { reason, actor? }: suspend, exclude their events and lobby seats
 */
import { timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { createGzip, gzipSync } from 'node:zlib';
import { directorVersion } from '../../director/src/provenance.js';
import { EVENT_ID_RE } from '../../director/src/submissions.js';
import { AccountRoutes } from './account.js';
import { DeviceFlow } from './device.js';
import type { Hub } from './hub.js';
import { clientIp, RateLimiter, Serial } from './ratelimit.js';
import { authenticate, bearer, introspect, visibilityOf, type Permission, type Principal } from './tokens.js';
import { USAGE_UPLOAD_MAX_BYTES } from '../../director/src/usage-upload.js';
import { receiveUsage } from './usage-uploads.js';
import { normalizeGroupKey } from '../../site/src/scoring.js';
import { repoRoot } from './config.js';
import { banContributor, eraseContributor, eventNotes, hideDeckName, hideNote, listHides, moderationList, moderationLog, reviewFlag, reviewQueue, setHandleHidden, unhide } from './moderation.js';
import { acceptTerms, CONTACT_URL, HAS_CONTACT, legalForReaders, termsInfo, termsRequiredMessage, termsStatus, TERMS_VERSION } from './terms.js';

type Res = ServerResponse;

/** docs/legal: the terms, privacy notice and content policy, served at /legal/* (src/terms.ts). */
const LEGAL_DIR = join(repoRoot, 'docs', 'legal');

export function startServer(hub: Hub): Server {
  const { cfg, sql } = hub;
  const cors = {
    'Access-Control-Allow-Origin': cfg.corsOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, If-None-Match, Range, If-Range',
    'Access-Control-Expose-Headers': 'ETag, Content-Length, Content-Range, Accept-Ranges',
    'X-Content-Type-Options': 'nosniff',
    // Every response is data (JSON, Markdown, files): nothing in it may run or be framed if a browser renders it.
    // The HTML account pages set their own policy (account.ts).
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
  };
  const json = (res: Res, code: number, body: unknown) => {
    res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors }).end(JSON.stringify(body, null, 1));
  };
  const account = new AccountRoutes(cfg, sql, (id) => hub.contributors.view?.account(id) ?? null, (id) => hub.visibilityChanged(id));
  // Public contributor endpoints: per-IP rate limit and a 60 s response cache (docs/SITE-DATA.md "Contributors").
  const publicLimit = new RateLimiter(120, 60_000);
  // The public read API (/api/events, /health) has its own bucket (HUB-16).
  const readLimit = new RateLimiter(120, 60_000);
  // Usage uploads (POST /api/usage): per sender (contributor or admin) and per IP, so bad tokens can't hammer it either.
  const usageLimit = new RateLimiter(cfg.usageUploadsPerHour, 3_600_000);
  const usageIpLimit = new RateLimiter(Math.max(cfg.usageUploadsPerHour * 2, 10), 3_600_000);
  // The open dataset (/data/open/): requests per IP per minute, and downloads in flight per IP (big files stream).
  const openLimit = new RateLimiter(cfg.openData.ratePerMinute, 60_000);
  const openInFlight = new Map<string, number>();
  // Bundles are taken in one at a time (HUB-8).
  const intakeLine = new Serial(cfg.intakeQueue);
  let health: { at: number; n: number } | undefined;
  const publicCache = new Map<string, { at: number; code: number; body: string }>();
  const cached = (res: Res, key: string, make: () => { code: number; body: unknown }) => {
    const now = Date.now();
    let hit = publicCache.get(key);
    if (!hit || now - hit.at > 60_000) {
      const r = make();
      hit = { at: now, code: r.code, body: JSON.stringify(r.body, null, 1) };
      // Oldest first (Map order), so a flood of distinct keys can't flush every hot entry at once (PTS-8).
      while (publicCache.size >= 2000) publicCache.delete(publicCache.keys().next().value!);
      publicCache.set(key, hit);
    }
    res.writeHead(hit.code, { 'Content-Type': 'application/json', 'Cache-Control': hit.code === 200 ? 'public, max-age=60' : 'no-store', ...cors }).end(hit.body);
  };
  const device = new DeviceFlow(cfg, sql);
  if (!account.enabled) console.log('GitHub sign-in is off (GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET unset)');
  const isAdmin = (req: IncomingMessage) => {
    const got = Buffer.from(bearer(req.headers.authorization));
    const want = Buffer.from(cfg.adminToken);
    return want.length >= 16 && got.length === want.length && timingSafeEqual(got, want);
  };

  async function readRaw(req: IncomingMessage, max: number): Promise<Buffer | undefined> {
    // A body announced over the cap is never read: the answer closes the connection (see the server below).
    if (Number(req.headers['content-length'] ?? 0) > max) return undefined;
    const chunks: Buffer[] = [];
    let n = 0;
    for await (const c of req) {
      n += (c as Buffer).length;
      // Over the cap without a Content-Length (chunked): stop reading instead of draining the rest.
      if (n > max) return void req.destroy();
      chunks.push(c as Buffer);
    }
    return Buffer.concat(chunks);
  }

  // Failed token checks per client IP (HUB-26): every bad bearer costs a database lookup, so a flood of them is cut off.
  const authFailures = new RateLimiter(60, 60_000);
  async function auth(req: IncomingMessage, res: Res, scope: Permission): Promise<Principal | null | 'limited'> {
    const ip = clientIp(req, cfg.trustProxy);
    if (authFailures.retryAfter(ip) > 0) {
      res.writeHead(429, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Retry-After': String(authFailures.retryAfter(ip)), ...cors })
        .end(JSON.stringify({ error: 'too many requests with an invalid token from your network; wait a minute' }));
      return 'limited';
    }
    const who = await authenticate(sql, bearer(req.headers.authorization), scope);
    if (!who) authFailures.take(ip);
    return who;
  }

  /** Uploads need the current terms accepted (src/terms.ts): a 403 that says how to accept, and true, when not. */
  async function refusedForTerms(req: IncomingMessage, res: Res, who: Principal): Promise<boolean> {
    if (!cfg.termsRequired) return false;
    const st = await termsStatus(sql, who.contributorId);
    if (st.accepted) return false;
    req.resume();
    json(res, 403, { error: termsRequiredMessage(cfg.publicUrl, st), terms: { ...st, ...termsInfo(cfg.publicUrl) } });
    return true;
  }

  async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
    const raw = await readRaw(req, 64 * 1024);
    if (!raw?.length) return {};
    try {
      return JSON.parse(raw.toString('utf8'));
    } catch {
      return {};
    }
  }

  async function intake(req: IncomingMessage, res: Res, via: 'upload' | 'director', who: Principal) {
    // The body is read only once it is this request's turn, so waiting requests hold no bundle in memory.
    const out = await intakeLine.run(async () => {
      const body = await readRaw(req, cfg.maxBundleBytes).catch(() => undefined);
      if (!body) return { http: 413, body: { error: `bundle missing or larger than ${cfg.maxBundleBytes} bytes` } as Record<string, unknown> };
      return hub.receive(body, who, via);
    });
    if (!out) {
      req.resume();
      res.writeHead(429, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Retry-After': '30', ...cors })
        .end(JSON.stringify({ error: 'the Hub is checking other bundles right now; send this one again in a minute' }));
      return;
    }
    return json(res, out.http, out.body);
  }

  async function submissionView(id: number) {
    const [s] = await sql`
      select s.id, s.event_id, s.status, s.label, s.via, s.reasons, s.checks, s.received_at, s.decided_at, s.ingested_at,
             s.bundle_sha256, s.bundle_bytes, s.review_note, s.contributor_id, c.handle
      from submissions s left join contributors c on c.id = s.contributor_id where s.id = ${id}`;
    if (!s) return null;
    const checks = (s.checks ?? {}) as { checks?: Array<{ id: string; outcome: string; message: string }>; regen?: { status: string; message: string; missing?: string[] } };
    return {
      contributorId: Number(s.contributor_id),
      view: {
        submission_id: Number(s.id), id: s.event_id, status: s.status, label: s.label, via: s.via, submitter: s.handle,
        received_at: s.received_at, decided_at: s.decided_at, ingested_at: s.ingested_at, bundle_sha256: s.bundle_sha256, bundle_bytes: s.bundle_bytes,
        reasons: s.reasons, review_note: s.review_note,
        checks: (checks.checks ?? []).map((c) => ({ id: c.id, outcome: c.outcome, message: c.message })),
        pack_regeneration: checks.regen ? { status: checks.regen.status, message: checks.regen.message, missing: checks.regen.missing ?? [] } : null,
        report: s.status === 'ingested' && s.event_id ? `${cfg.publicUrl}/data/events/${s.event_id}.json` : null,
      },
    };
  }

  // A traffic spike re-gzipped every file on every request. The gzipped bytes of each export file
  // are kept per ETag (they change only when the export replaces the file), bounded in total; and one address can't
  // monopolize the server (a generous per-IP limit: a page loads a handful of files).
  const gzCache = new Map<string, Buffer>();
  let gzBytes = 0;
  const GZ_MAX_BYTES = 64 << 20;
  const GZ_MAX_FILE = 8 << 20;
  const gzipped = (file: string, etag: string): Buffer | undefined => {
    const key = `${file}|${etag}`;
    const hit = gzCache.get(key);
    if (hit) {
      gzCache.delete(key);
      gzCache.set(key, hit); // most recently used last
      return hit;
    }
    let raw: Buffer;
    try {
      raw = readFileSync(file);
    } catch {
      return undefined;
    }
    if (raw.length > GZ_MAX_FILE) return undefined;
    const out = gzipSync(raw, { level: 6 });
    gzCache.set(key, out);
    gzBytes += out.length;
    for (const [k, v] of gzCache) {
      if (gzBytes <= GZ_MAX_BYTES) break;
      gzCache.delete(k);
      gzBytes -= v.length;
    }
    return out;
  };
  const dataLimiter = new RateLimiter(Number(process.env.HUB_DATA_PER_MINUTE ?? 600), 60_000);

  function serveData(req: IncomingMessage, res: Res, rel: string) {
    const root = normalize(hub.siteDir);
    const file = normalize(join(root, rel));
    // Inside the served tree, and never a dot-file or dot-directory (the export's temporary and swapped-out trees).
    if (!file.startsWith(root + '/') || rel.split('/').some((seg) => seg.startsWith('.')) || !existsSync(file) || !statSync(file).isFile()) return json(res, 404, { error: 'not found' });
    if (!dataLimiter.take(`ip:${clientIp(req, cfg.trustProxy)}`)) {
      return res.writeHead(429, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Retry-After': '30', ...cors }).end(JSON.stringify({ error: 'too many requests; slow down' }));
    }
    if (rel.startsWith('open/')) return serveOpen(req, res, rel, file);
    const st = statSync(file);
    const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
    // index.json changes after every ingest; event files only when an event is re-ingested or identities change.
    // Contributor files: a contributor who hides their handle must disappear within a minute, never served stale (PTS-6).
    const contributorFile = rel === 'contributors.json' || rel.startsWith('contributors/');
    const maxAge = rel === 'index.json' || rel.startsWith('sets/') || contributorFile ? 60 : 300;
    const headers: Record<string, string> = {
      ...cors,
      'Content-Type': extname(file) === '.json' ? 'application/json' : extname(file) === '.md' ? 'text/markdown; charset=utf-8' : 'application/octet-stream',
      'Cache-Control': contributorFile ? `public, max-age=${maxAge}` : `public, max-age=${maxAge}, stale-while-revalidate=600`,
      ETag: etag,
      Vary: 'Accept-Encoding',
    };
    if (req.headers['if-none-match'] === etag) return res.writeHead(304, headers).end();
    const gzip = /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? '')) && st.size > 1024;
    if (req.method === 'HEAD') return res.writeHead(200, headers).end();
    const cached = gzip ? gzipped(file, etag) : undefined;
    if (cached) return res.writeHead(200, { ...headers, 'Content-Encoding': 'gzip', 'Content-Length': String(cached.length) }).end(cached);
    // The export may replace a file between stat and open: end the response, never crash the process.
    const src = createReadStream(file).on('error', () => res.destroy());
    if (gzip) {
      res.writeHead(200, { ...headers, 'Content-Encoding': 'gzip' });
      src.pipe(createGzip({ level: 6 }).on('error', () => res.destroy())).pipe(res);
    } else {
      res.writeHead(200, { ...headers, 'Content-Length': String(st.size) });
      src.pipe(res);
    }
  }

  /**
   * /data/open/: files the nightly build wrote (open-data/build.ts), streamed from disk; nothing is computed per
   * request. Snapshot zips have dated names and never change: cached for a year. latest.json says what is current
   * (5 minutes); the rest is replaced nightly under the same names (1 hour, then revalidated by ETag). Single byte
   * ranges for resumable downloads; already-compressed files are never compressed again.
   */
  function serveOpen(req: IncomingMessage, res: Res, rel: string, file: string) {
    const ip = clientIp(req, cfg.trustProxy);
    if (!openLimit.take(ip)) {
      res.writeHead(429, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Retry-After': String(Math.max(1, openLimit.retryAfter(ip))), ...cors })
        .end(JSON.stringify({ error: 'too many requests' }));
      return;
    }
    const st = statSync(file);
    const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
    const ext = extname(file);
    const name = rel.split('/').pop()!;
    const type = ext === '.json' ? 'application/json' : ext === '.md' ? 'text/markdown; charset=utf-8' : ext === '.zip' ? 'application/zip'
      : ext === '.parquet' ? 'application/vnd.apache.parquet' : ext === '.gz' ? 'application/gzip' : name === 'SHA256SUMS' ? 'text/plain; charset=utf-8' : 'application/octet-stream';
    const cache = rel.startsWith('open/snapshots/') ? 'public, max-age=31536000, immutable' : rel === 'open/latest.json' ? 'public, max-age=300' : 'public, max-age=3600';
    const headers: Record<string, string> = {
      ...cors, 'Content-Type': type, 'Cache-Control': cache, ETag: etag, 'Accept-Ranges': 'bytes', 'Last-Modified': st.mtime.toUTCString(),
      ...(['.zip', '.parquet', '.gz'].includes(ext) ? { 'Content-Disposition': `attachment; filename="${name.replace(/[^\w.-]/g, '_')}"` } : {}),
    };
    if (req.headers['if-none-match'] === etag) return res.writeHead(304, headers).end();
    // Range: one range (bytes=a-b, a-, -n); If-Range with another ETag means "send it all".
    let start = 0;
    let end = st.size - 1;
    let partial = false;
    const range = String(req.headers.range ?? '');
    const ifRange = req.headers['if-range'];
    if (range && (!ifRange || ifRange === etag)) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
      const a = m?.[1] ? Number(m[1]) : null;
      const b = m?.[2] ? Number(m[2]) : null;
      if (m && (a != null || b != null)) {
        if (a == null) start = Math.max(0, st.size - b!);
        else {
          start = a;
          if (b != null) end = Math.min(b, st.size - 1);
        }
        if (start > end || start >= st.size) {
          return res.writeHead(416, { ...cors, 'Content-Range': `bytes */${st.size}`, 'Cache-Control': 'no-store' }).end();
        }
        partial = true;
      }
    }
    const text = ['.json', '.md'].includes(ext) || name === 'SHA256SUMS';
    const gzip = !partial && text && /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? '')) && st.size > 1024;
    if (text) headers.Vary = 'Accept-Encoding';
    if (req.method === 'HEAD') return res.writeHead(200, { ...headers, 'Content-Length': String(st.size) }).end();
    const n = openInFlight.get(ip) ?? 0;
    if (n >= cfg.openData.concurrentPerIp) {
      res.writeHead(429, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Retry-After': '30', ...cors })
        .end(JSON.stringify({ error: `at most ${cfg.openData.concurrentPerIp} downloads at a time` }));
      return;
    }
    openInFlight.set(ip, n + 1);
    res.on('close', () => {
      const k = (openInFlight.get(ip) ?? 1) - 1;
      if (k > 0) openInFlight.set(ip, k);
      else openInFlight.delete(ip);
    });
    // Streamed from disk with backpressure: a large zip never sits in memory. A build swapping files mid-download is
    // harmless: the open file stays readable until the stream ends.
    const src = createReadStream(file, { start, end }).on('error', () => res.destroy());
    if (gzip) {
      res.writeHead(200, { ...headers, 'Content-Encoding': 'gzip' });
      src.pipe(createGzip({ level: 6 }).on('error', () => res.destroy())).pipe(res);
    } else if (partial) {
      res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': String(end - start + 1) });
      src.pipe(res);
    } else {
      res.writeHead(200, { ...headers, 'Content-Length': String(st.size) });
      src.pipe(res);
    }
  }

  async function route(req: IncomingMessage, res: Res): Promise<void> {
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://x');
    } catch {
      return json(res, 400, { error: 'bad request target' });
    }
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const method = req.method ?? 'GET';
    if (method === 'OPTIONS') return void res.writeHead(204, { ...cors, 'Access-Control-Max-Age': '86400' }).end();

    // Public reads that touch the database: per-IP limited (HUB-16).
    if ((path === '/health' || path === '/api/events' || path.startsWith('/api/events/')) && method === 'GET') {
      const ip = clientIp(req, cfg.trustProxy);
      if (!readLimit.take(ip)) {
        res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': String(Math.max(1, readLimit.retryAfter(ip))), ...cors }).end(JSON.stringify({ error: 'too many requests' }));
        return;
      }
    }
    if (path === '/health') {
      // The event count is cached for 10 s: health checks and probes never queue database work.
      if (!health || Date.now() - health.at > 10_000) {
        const [{ n }] = (await sql`select count(*)::int as n from events`) as unknown as [{ n: number }];
        health = { at: Date.now(), n };
      }
      return json(res, 200, {
        ok: true, version: directorVersion(), events: health.n, loaded: hub.events.size, last_export: hub.lastExport, intake_waiting: intakeLine.busy,
        open_data: hub.openData ? { next_build_at: hub.openData.nextAt ? new Date(hub.openData.nextAt).toISOString() : null, last_build: hub.openData.lastRun } : null,
      });
    }
    if (path.startsWith('/data/') && (method === 'GET' || method === 'HEAD')) {
      let rel: string;
      try {
        rel = decodeURIComponent(path.slice(6));
      } catch {
        return json(res, 404, { error: 'not found' });
      }
      if (rel.includes('\0')) return json(res, 404, { error: 'not found' });
      serveData(req, res, rel);
      return;
    }

    const legal = /^\/legal\/(terms|privacy|content-policy)$/.exec(path);
    if (legal && (method === 'GET' || method === 'HEAD')) {
      const file = join(LEGAL_DIR, `${legal[1] === 'content-policy' ? 'CONTENT-POLICY' : legal[1]!.toUpperCase()}.md`);
      let text: string;
      try {
        text = readFileSync(file, 'utf8');
      } catch {
        return json(res, 404, { error: 'not found' });
      }
      // Readers get the draft notice (until the legal review), no owner notes, and the contact address, or while there's
      // none, sentences saying the request can't be made yet (terms.ts legalForReaders).
      text = legalForReaders(text, { contact: HAS_CONTACT ? CONTACT_URL : null });
      res.writeHead(200, { ...cors, 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=300' });
      return void res.end(method === 'HEAD' ? undefined : text);
    }
    if (path === '/api/terms' && method === 'GET') return json(res, 200, termsInfo(cfg.publicUrl));
    if (path === '/api/account/terms' && (method === 'GET' || method === 'POST')) {
      // Any contributor token: one that may submit, or only play.
      const who = (await auth(req, res, 'submit')) ?? (await auth(req, res, 'play'));
      if (who === 'limited') return;
      if (!who) return json(res, 401, { error: 'a contributor token is required (Authorization: Bearer <token>; `bench login`)' });
      if (method === 'GET') return json(res, 200, { ...(await termsStatus(sql, who.contributorId)), ...termsInfo(cfg.publicUrl) });
      const body = await readJson(req);
      if (body.version !== TERMS_VERSION) return json(res, 409, { error: `the current terms are version ${TERMS_VERSION}; read them and accept that version`, ...termsInfo(cfg.publicUrl) });
      return json(res, 200, await acceptTerms(sql, who.contributorId, 'cli'));
    }

    if (path === '/auth/github' || path.startsWith('/auth/github/') || path === '/account' || path.startsWith('/account/')) {
      if (await account.handle(req, res, path, url)) return;
    }
    if ((path === '/auth/device/start' || path === '/auth/device/poll') && method === 'POST') {
      let deviceId: unknown;
      if (path === '/auth/device/poll') {
        const raw = await readRaw(req, 4 * 1024).catch(() => undefined);
        try {
          deviceId = raw ? (JSON.parse(raw.toString('utf8')) as { device_id?: unknown })?.device_id : undefined;
        } catch {
          deviceId = undefined;
        }
      } else req.resume();
      const a = path === '/auth/device/start' ? await device.start(req) : await device.poll(req, deviceId);
      res.writeHead(a.http, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...(a.headers ?? {}) })
        .end(JSON.stringify(a.body, null, 1));
      return;
    }
    if (path === '/api/internal/tokens/introspect' && method === 'POST') {
      const who = await auth(req, res, 'ingest');
      if (who === 'limited') return;
      if (!who) return json(res, 401, { error: 'service token required' });
      const raw = await readRaw(req, 64 * 1024).catch(() => undefined);
      if (!raw) return json(res, 400, { error: 'body must be JSON { "token": "..." } (64 KB max)' });
      let body: { token?: unknown; scope?: unknown };
      try {
        body = JSON.parse(raw.toString('utf8'));
      } catch {
        return json(res, 400, { error: 'body must be JSON { "token": "..." }' });
      }
      if (!body || typeof body.token !== 'string') return json(res, 400, { error: 'body must be JSON { "token": "..." }' });
      const scope = body.scope ?? 'play';
      if (scope !== 'play' && scope !== 'submit') return json(res, 400, { error: 'scope must be "play" or "submit"' });
      return json(res, 200, await introspect(sql, body.token, { concurrent: cfg.playConcurrent, daily: cfg.playDaily, lobbyConcurrent: cfg.lobbyConcurrent, lobbyDaily: cfg.lobbyDaily }, scope as Permission, {
        required: cfg.termsRequired, message: (accepted) => termsRequiredMessage(cfg.publicUrl, { accepted_version: accepted }),
      }));
    }
    if (path === '/api/internal/moderation' && method === 'GET') {
      const who = await auth(req, res, 'ingest');
      if (who === 'limited') return;
      if (!who) return json(res, 401, { error: 'service token required' });
      return json(res, 200, await moderationList(sql));
    }
    if (path === '/api/internal/contributors/visibility' && method === 'POST') {
      const who = await auth(req, res, 'ingest');
      if (who === 'limited') return;
      if (!who) return json(res, 401, { error: 'service token required' });
      const body = await readJson(req);
      const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter((x) => Number.isSafeInteger(x)) : null;
      if (!ids || ids.length > 5000) return json(res, 400, { error: 'body must be JSON { "ids": [contributor ids] } (at most 5000)' });
      return json(res, 200, { visibility: await visibilityOf(sql, ids) });
    }
    if (path === '/api/submissions' && method === 'POST') {
      const who = await auth(req, res, 'submit');
      if (who === 'limited') return;
      if (!who) return json(res, 401, { error: 'submission token required (Authorization: Bearer <token>); sign in at the Hub to get one' });
      if (await refusedForTerms(req, res, who)) return;
      return intake(req, res, 'upload', who);
    }
    if (path === '/api/internal/events' && method === 'POST') {
      const who = await auth(req, res, 'ingest');
      if (who === 'limited') return;
      if (!who) return json(res, 401, { error: 'service token required' });
      return intake(req, res, 'director', who);
    }
    if (path === '/api/usage' && method === 'POST') {
      const tooMany = (limiter: RateLimiter, key: string) => {
        req.resume();
        res.writeHead(429, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Retry-After': String(Math.max(1, limiter.retryAfter(key))), ...cors })
          .end(JSON.stringify({ error: 'too many usage uploads; try again later' }));
      };
      const ip = clientIp(req, cfg.trustProxy);
      if (!usageIpLimit.take(ip)) return tooMany(usageIpLimit, ip);
      const admin = isAdmin(req);
      const who = admin ? null : await auth(req, res, 'submit');
      if (who === 'limited') return void req.resume();
      if (!admin && !who) {
        req.resume();
        return json(res, 401, { error: 'a contributor token is required (Authorization: Bearer <token>; `bench login`), or the Hub admin token for admin tables' });
      }
      if (!admin && (await refusedForTerms(req, res, who!))) return;
      const key = admin ? 'admin' : `c${who!.contributorId}`;
      if (!usageLimit.take(key)) return tooMany(usageLimit, key);
      const raw = await readRaw(req, USAGE_UPLOAD_MAX_BYTES).catch(() => undefined);
      if (!raw?.length) return json(res, 413, { error: `the body must be JSON of at most ${USAGE_UPLOAD_MAX_BYTES} bytes` });
      let body: unknown;
      try {
        body = JSON.parse(raw.toString('utf8'));
      } catch {
        return json(res, 400, { error: 'the body must be JSON { version, event_id, seats }' });
      }
      // In line with bundle intake: an upload to an ingested event re-ingests it.
      const out = await intakeLine.run(() => receiveUsage(hub, admin ? 'admin' : { contributorId: who!.contributorId }, body));
      if (!out) {
        res.writeHead(429, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Retry-After': '30', ...cors })
          .end(JSON.stringify({ error: 'the Hub is checking bundles right now; send the usage again in a minute' }));
        return;
      }
      return json(res, out.http, out.body);
    }
    if (path === '/api/submissions' && method === 'GET') {
      const who = await auth(req, res, 'submit');
      if (who === 'limited') return;
      if (!who) return json(res, 401, { error: 'submission token required' });
      const rows = await sql`
        select id, event_id, status, label, received_at, decided_at from submissions where contributor_id = ${who.contributorId} order by id desc limit 50`;
      return json(res, 200, rows.map((r) => ({ submission_id: Number(r.id), id: r.event_id, status: r.status, label: r.label, received_at: r.received_at, decided_at: r.decided_at })));
    }
    const sm = /^\/api\/submissions\/(\d+)$/.exec(path);
    if (sm && method === 'GET') {
      const admin = isAdmin(req);
      const who = admin ? null : await auth(req, res, 'submit');
      if (who === 'limited') return;
      if (!admin && !who) return json(res, 401, { error: 'submission token required' });
      const v = await submissionView(Number(sm[1]));
      if (!v || (!admin && v.contributorId !== who!.contributorId)) return json(res, 404, { error: 'no such submission' });
      return json(res, 200, v.view);
    }

    if ((path === '/api/contributors' || path.startsWith('/api/contributors/') || path === '/api/bounties') && (method === 'GET' || method === 'HEAD')) {
      const ip = clientIp(req, cfg.trustProxy);
      if (!publicLimit.take(ip)) {
        res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': String(Math.max(1, publicLimit.retryAfter(ip))), ...cors }).end(JSON.stringify({ error: 'too many requests' }));
        return;
      }
      // A new month without a rebuild yet (the season clock missed it): serve this view, rebuild in the background.
      if (hub.contributors.stale()) void hub.contributors.refresh();
      const view = hub.contributors.view;
      if (!view) {
        res.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': '10', ...cors }).end(JSON.stringify({ error: 'the leaderboard is being computed; try again in a few seconds' }));
        return;
      }
      const stamp = view.generatedAt;
      if (path === '/api/bounties') return cached(res, `b|${stamp}`, () => ({ code: 200, body: { api_version: 1, generated_at: stamp, bounties: view.openBounties } }));
      if (path === '/api/contributors') {
        const board = url.searchParams.get('board') === 'all_time' ? 'all' : 'season';
        const season = url.searchParams.get('season');
        if (season != null && !/^\d{4}-(0[1-9]|1[0-2])$/.test(season)) return json(res, 400, { error: 'season must be YYYY-MM' });
        const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 100));
        const offset = Math.min(100_000, Math.max(0, Math.floor(Number(url.searchParams.get('offset')) || 0)));
        const scope = board === 'all' ? 'all' : season ?? view.season;
        return cached(res, `c|${stamp}|${scope}|${limit}|${offset}`, () => {
          const rows = view.board(scope);
          return { code: 200, body: { api_version: 1, generated_at: stamp, board: board === 'all' ? 'all_time' : 'season', season: scope === 'all' ? null : scope, total: rows.length, offset, limit, rows: rows.slice(offset, offset + limit) } };
        });
      }
      let handle: string;
      try {
        handle = decodeURIComponent(path.slice('/api/contributors/'.length)).toLowerCase();
      } catch {
        return json(res, 404, { error: 'no such contributor' });
      }
      if (!/^[a-z0-9][a-z0-9_.-]{0,39}$/.test(handle)) return json(res, 404, { error: 'no such contributor' });
      return cached(res, `p|${stamp}|${handle}`, () => {
        const p = view.publicProfile(handle);
        return p ? { code: 200, body: { api_version: 1, ...p } } : { code: 404, body: { error: 'no such contributor' } };
      });
    }

    if (path === '/api/events' && method === 'GET') {
      const label = url.searchParams.get('label');
      const set = url.searchParams.get('set')?.toUpperCase();
      // Group keys before 2.13 carried "bo=<n>"; stored rows and links of either form match.
      const groupParam = url.searchParams.get('group');
      const group = groupParam == null ? null : normalizeGroupKey(groupParam);
      const rows = await sql`
        select id, label, set_code, seed, knowledge, mana, best_of, sideboarding, agents, llm, comparability_group, unrated_reason, pack_regen,
               started_at, ended_at, winner, excluded, engine_version, director_version, prompt_version
        from events
        where (${label}::text is null or label = ${label}) and (${set ?? null}::text is null or set_code = ${set ?? null})
          and (${group}::text is null or regexp_replace(comparability_group, ';bo=[0-9]+', '') = ${group})
        order by started_at desc limit 500`;
      return json(res, 200, rows.map((r) => ({ ...r, data: `${cfg.publicUrl}/data/events/${r.id}.json` })));
    }
    const em = /^\/api\/events\/([\w.-]+)$/.exec(path);
    if (em && method === 'GET') {
      const id = em[1]!;
      if (!EVENT_ID_RE.test(id)) return json(res, 404, { error: 'no such event' });
      const [ev] = await sql`select * from events where id = ${id}`;
      if (!ev) return json(res, 404, { error: 'no such event' });
      const [seats, games, decks, sub] = await Promise.all([
        sql`select name, kind, position, is_llm, harness, model, model_id, effort, identity, final_colors from seats where event_id = ${id} order by position`,
        sql`select game_index, match_key, game_in_match, seat_a, seat_b, winner, turns, on_play, end_reason, final_life, mulligans, play_draw, sideboarding, deck_sizes from games where event_id = ${id} order by game_index`,
        sql`select seat, by, main_count, colors, basics, deck_strength from decks where event_id = ${id}`,
        sql`select s.id, s.status, s.via, s.received_at, s.checks->'regen' as regen, s.reasons, s.contributor_id, c.handle from submissions s left join contributors c on c.id = s.contributor_id where s.id = ${ev.submission_id as number}`,
      ]);
      const s = sub[0];
      // The uploader's handle only when they are on the public leaderboard (PTS-4); never for hidden contributors,
      // hosted Directors or admin imports.
      const shown = s?.contributor_id != null && hub.contributors.view?.isPublicId(Number(s.contributor_id)) === true;
      // US spelling since migration 005; the old column names ride along for one release (deprecated).
      const legacySeats = seats.map((x) => ({ ...x, final_colours: x.final_colors }));
      const legacyDecks = decks.map((x) => ({ ...x, colours: x.colors }));
      return json(res, 200, {
        event: ev, seats: legacySeats, games, decks: legacyDecks,
        submission: s ? { submission_id: Number(s.id), status: s.status, via: s.via, ...(shown ? { submitter: s.handle } : {}), received_at: s.received_at, flags: ((s.reasons ?? []) as Array<{ code: string; severity: string }>).filter((r) => r.severity !== 'info').map((r) => r.code), pack_regeneration: s.regen ? { status: (s.regen as any).status, message: (s.regen as any).message } : null } : null,
        data: `${cfg.publicUrl}/data/events/${id}.json`,
      });
    }

    if (path.startsWith('/api/admin/')) {
      if (!isAdmin(req)) return json(res, 401, { error: 'admin token required' });
      if (path === '/api/admin/submissions' && method === 'GET') {
        const status = url.searchParams.get('status') ?? 'held';
        const rows = await sql`
          select s.id, s.event_id, s.status, s.label, s.via, s.reasons, s.received_at, c.handle from submissions s
          left join contributors c on c.id = s.contributor_id where s.status = ${status} order by s.id limit 200`;
        return json(res, 200, rows);
      }
      const am = /^\/api\/admin\/submissions\/(\d+)\/(approve|reject)$/.exec(path);
      if (am && method === 'POST') {
        const body = await readJson(req);
        try {
          if (am[2] === 'approve') return json(res, 200, { ingested: await hub.approve(Number(am[1]), 'admin-api', body.note as string | undefined) });
          if (!body.note) return json(res, 400, { error: 'a note (reason) is required to reject' });
          await hub.rejectHeld(Number(am[1]), 'admin-api', String(body.note));
          return json(res, 200, { rejected: Number(am[1]) });
        } catch (e) {
          return json(res, 409, { error: (e as Error).message });
        }
      }
      const handled = await moderationRoute(req, res, path, url, method);
      if (handled !== false) return;
      const xm = /^\/api\/admin\/events\/([\w.-]+)\/(exclude|include|takedown)$/.exec(path);
      if (xm && method === 'POST' && !EVENT_ID_RE.test(xm[1]!)) return json(res, 404, { error: 'no such event' });
      if (xm && method === 'POST') {
        const body = await readJson(req);
        try {
          if (xm[2] === 'include') await hub.setExcluded(xm[1]!, null);
          else if (!body.reason) return json(res, 400, { error: 'a reason is required' });
          else if (xm[2] === 'exclude') await hub.setExcluded(xm[1]!, String(body.reason));
          else await hub.takedown(xm[1]!, String(body.reason), body.purge === true, actorOf(body));
          return json(res, 200, { ok: true });
        } catch (e) {
          return json(res, 404, { error: (e as Error).message });
        }
      }
      if (path === '/api/admin/export' && method === 'POST') {
        hub.requestExport('full');
        await hub.idle();
        return json(res, 200, { ok: true, last_export: hub.lastExport });
      }
    }
    return json(res, 404, { error: 'not found' });
  }

  /** Who an admin request acts as (body.actor, else "admin-api"): the moderation log records it. */
  function actorOf(body: Record<string, unknown>): string {
    const a = typeof body.actor === 'string' ? body.actor.replace(/[^\w .@-]/g, '').trim().slice(0, 60) : '';
    return a ? `admin-api:${a}` : 'admin-api';
  }

  /** The admin moderation API (header comment). Returns false when the path isn't one of its routes. */
  async function moderationRoute(req: IncomingMessage, res: Res, path: string, url: URL, method: string): Promise<void | false> {
    const reasonOf = (body: Record<string, unknown>) => (typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim().slice(0, 500) : null);
    const act = async (fn: (body: Record<string, unknown>, reason: string) => Promise<unknown>) => {
      const body = await readJson(req);
      const reason = reasonOf(body);
      if (!reason) return json(res, 400, { error: 'a reason is required (it goes into the moderation log)' });
      try {
        return json(res, 200, { ok: true, result: (await fn(body, reason)) ?? null });
      } catch (e) {
        return json(res, 409, { error: (e as Error).message });
      }
    };
    const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
    if (path === '/api/admin/moderation/queue' && method === 'GET') {
      const status = url.searchParams.get('status') ?? 'open';
      if (!['open', 'kept', 'hidden'].includes(status)) return json(res, 400, { error: 'status must be open, kept or hidden' });
      return json(res, 200, await reviewQueue(sql, status));
    }
    if (path === '/api/admin/moderation/hides' && method === 'GET') return json(res, 200, await listHides(sql));
    if (path === '/api/admin/moderation/log' && method === 'GET') return json(res, 200, await moderationLog(sql));
    const fm = /^\/api\/admin\/moderation\/flags\/(\d{1,15})\/(keep|hide)$/.exec(path);
    if (fm && method === 'POST') return act((b, r) => reviewFlag(hub, actorOf(b), Number(fm[1]), fm[2] as 'keep' | 'hide', r));
    if (path === '/api/admin/moderation/notes/hide' && method === 'POST') {
      return act((b, r) => {
        const [event, seat, item] = [str(b.event), str(b.seat), str(b.item)];
        if (!event || !seat || !item) throw new Error('event, seat and item (the note key, from GET /api/admin/events/<id>/notes) are required');
        return hideNote(hub, actorOf(b), { event, seat, item }, r);
      });
    }
    if (path === '/api/admin/moderation/deck-names/hide' && method === 'POST') {
      return act((b, r) => {
        const [event, seat] = [str(b.event), str(b.seat)];
        if (!event || !seat) throw new Error('event and seat are required');
        return hideDeckName(hub, actorOf(b), { event, seat }, r);
      });
    }
    const um = /^\/api\/admin\/moderation\/hides\/(\d{1,15})\/undo$/.exec(path);
    if (um && method === 'POST') return act((b, r) => unhide(hub, actorOf(b), Number(um[1]), r));
    const hm = /^\/api\/admin\/moderation\/handles\/([a-z0-9][a-z0-9_.-]{0,39})\/(hide|show)$/.exec(path);
    if (hm && method === 'POST') return act((b, r) => setHandleHidden(hub, actorOf(b), hm[1]!, hm[2] === 'hide', r));
    const nm = /^\/api\/admin\/events\/([\w.-]+)\/notes$/.exec(path);
    if (nm && method === 'GET') {
      if (!EVENT_ID_RE.test(nm[1]!)) return json(res, 404, { error: 'no such event' });
      try {
        return json(res, 200, eventNotes(hub, nm[1]!, { seat: url.searchParams.get('seat') ?? undefined, grep: url.searchParams.get('grep') ?? undefined }));
      } catch (e) {
        return json(res, 404, { error: (e as Error).message });
      }
    }
    const em = /^\/api\/admin\/contributors\/([a-z0-9][a-z0-9_.-]{0,39})\/erase$/.exec(path);
    if (em && method === 'POST') return act((b, r) => eraseContributor(hub, actorOf(b), em[1]!, r, { removeEvents: b.remove_events === true }));
    const bm = /^\/api\/admin\/contributors\/([a-z0-9][a-z0-9_.-]{0,39})\/ban$/.exec(path);
    if (bm && method === 'POST') return act((b, r) => banContributor(hub, actorOf(b), bm[1]!, r));
    return false;
  }

  const server = createServer((req, res) => {
    // A request body still unread when the answer starts (refused before reading: a bad token, over a cap, a full
    // intake line) is not drained: the answer says `Connection: close` and the socket is closed after it.
    const bodied = req.headers['transfer-encoding'] != null || Number(req.headers['content-length'] ?? 0) > 0;
    if (bodied) {
      const writeHead = res.writeHead.bind(res) as (...a: unknown[]) => Res;
      res.writeHead = ((...a: unknown[]) => {
        if (!req.complete && !res.headersSent) res.setHeader('Connection', 'close');
        return writeHead(...a);
      }) as typeof res.writeHead;
    }
    route(req, res).catch((e) => {
      // Path only: query strings can carry OAuth codes and state.
      console.error(`${req.method} ${(req.url ?? '/').split('?')[0]}: ${(e as Error)?.stack ?? e}`);
      if (!res.headersSent) json(res, 500, { error: 'internal error' });
      else res.end();
    });
  });
  server.requestTimeout = 120_000;
  server.headersTimeout = 30_000;
  // Like the Director (DIR-2): a cap on open sockets, so a connection flood can't exhaust file descriptors.
  server.maxConnections = 2_000;
  server.listen(cfg.port, cfg.host);
  return server;
}
