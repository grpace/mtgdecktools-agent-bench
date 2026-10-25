/**
 * HTTP for spectators: GET /api/events/:id/live
 *
 *   Accept: text/event-stream   Server-Sent Events. First an `event: hello`, then every released message as
 *                               `id: <seq>` + `data: <json>`. Resume with Last-Event-ID (EventSource does it) or ?since=.
 *   otherwise                   JSON polling: { hello, seq, messages, more, poll_ms } for messages after ?since=<seq>.
 *
 * Bounded: concurrent streams per IP / per event / in total (429 beyond), polls per IP per minute, a heartbeat
 * comment every 15 s, a slow reader (over 1 MiB buffered) is dropped and reconnects with Last-Event-ID, and
 * streams are recycled after SpectateLimits.maxStreamMs. SPECTATE=off disables it; SPECTATE=admin needs the
 * admin token or the read-only SPECTATE_TOKEN in Authorization: Bearer, or SPECTATE_TOKEN as ?token= (EventSource
 * can't send headers; the admin token is never accepted in a URL, where it would land in logs and history).
 */
import { timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { eventLogFile, eventLogSize, eventLogStream, hasEventLog } from './log-files.js';
import { currentModeration, isTakenDown } from './moderation.js';
import { AGENT_TEXT_KEYS, moderateRecord, scrubText } from './public-text.js';
import { clientIp } from './ratelimit.js';
import { Spectator, type SpectatorMsg } from './spectate.js';
import type { SpectatePolicy } from './spectate-policy.js';

const HEARTBEAT_MS = 15_000;
const MAX_BUFFERED = 256 << 10;
const CATCH_UP_BATCH = 100;
const REPLAY_TTL_MS = 10 * 60_000;
const MAX_REPLAYS = 16;
/**
 * Reading a finished event back from disk is the one expensive thing an anonymous spectator can ask for (a 15 MB log
 * took 1.4 s of one synchronous block, so a poll a second over 9+ finished events stalled every live seat: SEC-1).
 * It is read in chunks that yield to the event loop, one replay at a time, at most REPLAYS_PER_MIN a minute in all
 * (cache hits are free); beyond that the caller gets 503 with Retry-After.
 */
const REPLAYS_PER_MIN = 6;
const REPLAY_CONCURRENCY = 1;
/** Parse for at most this long before letting other work in. */
const REPLAY_SLICE_MS = 10;
/**
 * A replay still running after this long is given up (and not retried until REPLAY_TTL_MS): the spectator's release
 * bookkeeping is linear in what it still holds, so a pathological log costs quadratic time.
 */
const REPLAY_MAX_MS = 30_000;

/** No capacity to read another finished event right now (503). */
export class ReplayBusy extends Error {}
/** Logs bigger than this aren't replayed for spectators (a finished event is far smaller). */
const REPLAY_MAX_BYTES = 64 << 20;
/** A log not in memory that hasn't grown for this long is treated as cut off (released whole). */
const STALL_MS = 10 * 60_000;

interface Stream {
  res: ServerResponse;
  ip: string;
  event: string;
  cursor: number;
  live: boolean;
  closed: boolean;
  close: () => void;
}

export interface SpectateHubOptions {
  adminToken?: string;
  /** Read-only token for SPECTATE=admin (SPECTATE_TOKEN); the only one accepted as ?token=. */
  spectateToken?: string;
  /** Read the client IP from X-Forwarded-For when behind a reverse proxy (TRUST_PROXY, TRUST_PROXY_HOPS). */
  trustProxy?: boolean;
  proxyHops?: number;
  runsDir: string;
  /**
   * Injected time, for tests (production: the real clocks). `now`: the wall clock of the replay budget, the caches and
   * the give-up (Date.now). `sliceClock`: how long a replay has parsed since it last yielded (performance.now).
   * `yieldTurn`: how a replay hands the event loop back between slices (setImmediate).
   */
  now?: () => number;
  sliceClock?: () => number;
  yieldTurn?: () => Promise<void>;
}

export class SpectateHub {
  private streams = new Set<Stream>();
  private perIp = new Map<string, number>();
  private perEvent = new Map<string, number>();
  private polls = new Map<string, number[]>();
  private replays = new Map<string, { sp: Spectator; at: number }>();
  private replaying = new Map<string, Promise<Spectator | undefined>>();
  /** Logs given up on (REPLAY_MAX_MS), with when. */
  private tooSlow = new Map<string, number>();
  private replayStarts: number[] = [];
  private heartbeat: NodeJS.Timeout;
  /** The moderation list the cached replays were built with: a new list drops them (moderation.ts). */
  private modVersion = currentModeration().version;
  private readonly now: () => number;
  private readonly sliceClock: () => number;
  private readonly yieldTurn: () => Promise<void>;

  constructor(readonly policy: SpectatePolicy, private opts: SpectateHubOptions) {
    this.now = opts.now ?? Date.now;
    this.sliceClock = opts.sliceClock ?? (() => performance.now());
    this.yieldTurn = opts.yieldTurn ?? (() => new Promise((r) => setImmediate(r)));
    this.heartbeat = setInterval(() => {
      for (const s of this.streams) if (!s.closed) s.res.write(': hb\n\n');
      const now = this.now();
      for (const [ip, ts] of this.polls) {
        const fresh = ts.filter((x) => now - x < 60_000);
        if (fresh.length) this.polls.set(ip, fresh);
        else this.polls.delete(ip);
      }
      for (const [id, r] of this.replays) if (now - r.at > REPLAY_TTL_MS) this.replays.delete(id);
      for (const [id, at] of this.tooSlow) if (now - at > REPLAY_TTL_MS) this.tooSlow.delete(id);
    }, HEARTBEAT_MS);
    this.heartbeat.unref();
  }

  get stats(): { streams: number; events: number } {
    return { streams: this.streams.size, events: this.perEvent.size };
  }

  private ip(req: IncomingMessage): string {
    return clientIp(req, !!this.opts.trustProxy, this.opts.proxyHops);
  }

  private authorized(req: IncomingMessage, url: URL): boolean {
    if (this.policy.access === 'public') return true;
    if (this.policy.access !== 'admin') return false;
    const same = (want: string | undefined, got: string) => {
      if (!want || !got) return false;
      const a = Buffer.from(want);
      const b = Buffer.from(got);
      return a.length === b.length && timingSafeEqual(a, b);
    };
    const header = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    if (header) return same(this.opts.adminToken, header) || same(this.opts.spectateToken, header);
    return same(this.opts.spectateToken, url.searchParams.get('token') ?? '');
  }

  /** Polls and stream connects per IP per minute (checked before any work). */
  private overRate(ip: string): boolean {
    const now = this.now();
    const ts = (this.polls.get(ip) ?? []).filter((x) => now - x < 60_000);
    if (ts.length >= this.policy.limits.pollsPerMinute) return true;
    ts.push(now);
    this.polls.set(ip, ts);
    return false;
  }

  /** A finished (or orphaned) event read back from its log, with everything released. Cached; see REPLAYS_PER_MIN. */
  private async replay(id: string): Promise<Spectator | undefined> {
    if (currentModeration().version !== this.modVersion) {
      this.modVersion = currentModeration().version;
      this.replays.clear();
    }
    const hit = this.replays.get(id);
    if (hit) {
      hit.at = this.now();
      return hit.sp;
    }
    const running = this.replaying.get(id);
    if (running) return running;
    // The run folder: its log is events.jsonl, or events.jsonl.gz once the Hub has the event (log-files.ts).
    const file = join(this.opts.runsDir, id);
    if (!hasEventLog(file)) return undefined;
    const now = this.now();
    if (now - (this.tooSlow.get(id) ?? -Infinity) < REPLAY_TTL_MS) return undefined;
    this.tooSlow.delete(id);
    this.replayStarts = this.replayStarts.filter((t) => now - t < 60_000);
    if (this.replaying.size >= REPLAY_CONCURRENCY || this.replayStarts.length >= REPLAYS_PER_MIN) throw new ReplayBusy();
    this.replayStarts.push(now);
    const job = this.readReplay(id, file).finally(() => this.replaying.delete(id));
    this.replaying.set(id, job);
    return job;
  }

  private async readReplay(id: string, file: string): Promise<Spectator | undefined> {
    const st = statSync(eventLogFile(file)!);
    if (eventLogSize(file) > REPLAY_MAX_BYTES) return undefined;
    const sp = new Spectator(id, this.policy);
    let last = 0;
    let ended = false;
    // Line by line from a stream: each chunk is parsed in its own tick, so live seats keep being served meanwhile.
    // readline hands queued lines over in microtasks, which never let I/O in: yield to the event loop every few ms.
    const input = eventLogStream(file, { end: REPLAY_MAX_BYTES });
    if (!input) return undefined;
    input.setEncoding('utf8');
    const lines = createInterface({ input, crlfDelay: Infinity });
    const started = this.now();
    let slice = this.sliceClock();
    for await (const line of lines) {
      if (this.sliceClock() - slice > REPLAY_SLICE_MS) {
        await this.yieldTurn();
        slice = this.sliceClock();
        if (this.now() - started > REPLAY_MAX_MS) {
          lines.close();
          input.destroy();
          this.tooSlow.set(id, this.now());
          console.error(`spectate: gave up replaying ${id} after ${REPLAY_MAX_MS / 1000} s`);
          return undefined;
        }
      }
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line);
        last = r.t ?? last;
        if (r.type === 'event_end' || r.type === 'event_abort') ended = true;
        // Hidden notes and deck names, hidden handles and erased contributors (the Hub's list), agent text scrubbed.
        sp.ingest(moderateRecord(r, id, currentModeration()));
      } catch {
        // partial last line
      }
    }
    // Not running in this process and never finished: if its log has stalled, it was cut off and nothing is live
    // any more. A log that is still growing belongs to a live event elsewhere: the normal policy applies.
    if (!ended && Date.now() - st.mtimeMs > STALL_MS) sp.ingest({ t: last, type: 'event_abort' });
    if (this.replays.size >= MAX_REPLAYS) {
      const oldest = [...this.replays.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (oldest) this.replays.delete(oldest[0]);
    }
    this.replays.set(id, { sp, at: this.now() });
    return sp;
  }

  /**
   * Handle /api/events/:id/live. `live` is the in-memory Spectator of a running event, if any.
   * Returns false if the event is unknown (the caller answers 404).
   */
  async handle(req: IncomingMessage, res: ServerResponse, id: string, live: Spectator | undefined): Promise<boolean> {
    const url = new URL(req.url ?? '/', 'http://x');
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Last-Event-ID', Vary: 'Origin' };
    const json = (code: number, body: unknown, extra: Record<string, string> = {}) => {
      res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors, ...extra }).end(JSON.stringify(body));
      return true;
    };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { ...cors, 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Max-Age': '600' }).end();
      return true;
    }
    if (this.policy.access === 'off') return json(404, { error: 'spectating is disabled on this server' });
    if (!this.authorized(req, url)) return json(401, { error: 'spectating on this server needs a spectator token' });
    // Rate limit before any work (reading a finished event's log, serializing a backlog).
    if (this.overRate(this.ip(req))) return json(429, { error: 'too many requests; slow down' }, { 'Retry-After': '10' });
    // Taken down on the Hub: served from nowhere (moderation.ts).
    if (isTakenDown(id)) return false;
    // A finished event whose text moderators changed is replayed from its log (with the list), not from memory.
    let sp: Spectator | undefined = live?.over && currentModeration().touched.has(id) ? undefined : live;
    if (!sp) {
      try {
        sp = await this.replay(id);
      } catch (err) {
        if (err instanceof ReplayBusy) return json(503, { error: 'busy reading other finished events; try again shortly' }, { 'Retry-After': '10' });
        throw err;
      }
    }
    if (!sp) return false;
    if (res.destroyed) return true;

    const sinceRaw = req.headers['last-event-id'] ?? url.searchParams.get('since') ?? '0';
    let since = Math.max(0, Number(sinceRaw) || 0);
    // A cursor from another numbering (the Director restarted, or the client is confused): start over.
    const epoch = url.searchParams.get('epoch');
    if ((epoch && epoch !== sp.epoch) || since > sp.latestSeq) since = 0;
    const ip = this.ip(req);
    const wantsStream = String(req.headers.accept ?? '').includes('text/event-stream') || url.searchParams.get('stream') === '1';

    if (!wantsStream) {
      const { messages, more } = sp.since(since, this.policy.limits.pollBatch);
      return json(200, { hello: sp.hello(), seq: sp.latestSeq, messages: messages.map(publicMsg), more, poll_ms: sp.over ? 0 : more ? 250 : 2000 });
    }

    const lim = this.policy.limits;
    if (this.streams.size >= lim.total || (this.perIp.get(ip) ?? 0) >= lim.perIp || (this.perEvent.get(id) ?? 0) >= lim.perEvent) {
      return json(429, { error: 'too many live viewers; use polling (no Accept: text/event-stream) or try again soon' }, { 'Retry-After': '15' });
    }
    this.open(req, res, id, sp, since, ip, cors);
    return true;
  }

  private open(req: IncomingMessage, res: ServerResponse, id: string, sp: Spectator, since: number, ip: string, cors: Record<string, string>): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      ...cors,
    });
    res.socket?.setNoDelay(true);
    const s: Stream = { res, ip, event: id, cursor: since, live: false, closed: false, close: () => {} };
    let unsub = () => {};
    const timer = setTimeout(() => s.close(), this.policy.limits.maxStreamMs);
    timer.unref();
    s.close = () => {
      if (s.closed) return;
      s.closed = true;
      clearTimeout(timer);
      unsub();
      this.streams.delete(s);
      dec(this.perIp, ip);
      dec(this.perEvent, id);
      res.end();
    };
    this.streams.add(s);
    this.perIp.set(ip, (this.perIp.get(ip) ?? 0) + 1);
    this.perEvent.set(id, (this.perEvent.get(id) ?? 0) + 1);
    req.on('close', () => s.close());
    res.on('error', () => s.close());

    res.write(`retry: 3000\nevent: hello\ndata: ${JSON.stringify(sp.hello())}\n\n`);
    unsub = sp.onMessage((m) => {
      if (!s.live || s.closed) return;
      write(s, frame(m));
      s.cursor = m.seq;
    });
    void this.catchUp(s, sp);
  }

  /** Send the backlog in chunks, honoring backpressure, then switch the stream to live. */
  private async catchUp(s: Stream, sp: Spectator): Promise<void> {
    for (;;) {
      if (s.closed) return;
      const { messages, more } = sp.since(s.cursor, CATCH_UP_BATCH);
      if (!messages.length) break;
      const chunk = messages.map(frame).join('');
      s.cursor = messages[messages.length - 1]!.seq;
      if (!s.res.write(chunk)) {
        const drained = await new Promise<boolean>((resolve) => {
          const t = setTimeout(() => resolve(false), 20_000);
          s.res.once('drain', () => {
            clearTimeout(t);
            resolve(true);
          });
        });
        if (!drained) return s.close();
      }
      if (!more) {
        // Nothing can be released between this check and going live: both run in this tick.
        if (sp.latestSeq <= s.cursor || !sp.since(s.cursor, 1).messages.length) break;
      }
    }
    s.live = true;
    s.res.write(`event: live\ndata: ${JSON.stringify({ seq: s.cursor })}\n\n`);
    if (sp.over) {
      // A finished event has nothing more to send: let the client know, then hang up.
      s.res.write(`event: over\ndata: {}\n\n`);
      s.close();
    }
  }

  close(): void {
    clearInterval(this.heartbeat);
    for (const s of this.streams) s.close();
  }
}

/** A message as spectators get it: agent-written text through the scrubber every public output uses (public-text.ts). */
export function publicMsg(m: SpectatorMsg): SpectatorMsg {
  let out: SpectatorMsg | null = null;
  for (const k of AGENT_TEXT_KEYS) {
    const v = m[k];
    if (typeof v !== 'string' || !v) continue;
    const s = scrubText(v);
    if (s !== v) (out ??= { ...m })[k] = s;
  }
  return out ?? m;
}

function frame(m: SpectatorMsg): string {
  return `id: ${m.seq}\ndata: ${JSON.stringify(publicMsg(m))}\n\n`;
}

function write(s: Stream, data: string): void {
  s.res.write(data);
  // A reader that can't keep up is dropped; EventSource reconnects with Last-Event-ID and catches up.
  if (s.res.writableLength > MAX_BUFFERED) s.close();
}

function dec(m: Map<string, number>, k: string): void {
  const n = (m.get(k) ?? 1) - 1;
  if (n > 0) m.set(k, n);
  else m.delete(k);
}
