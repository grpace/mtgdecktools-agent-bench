import { timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';
import { promptVersionOf } from './prompts.js';
import { Admission, AdmissionConfig, DEFAULT_ADMISSION, eventWeight, type Quotas } from './admission.js';
import { BoosterFactory } from './boosters.js';
import type { BoosterFactories } from './booster-archive.js';
import { eventLogStream, hasEventLog } from './log-files.js';
import type { BoosterProvenance } from './provenance.js';
import { CardDb } from './cards.js';
import { ResumeMismatch } from './draft.js';
import { readCheckpoint, readLog, resumeLog, writeCheckpoint, type AgentSpec, type EventCheckpoint, type Owner } from './durable.js';
import { DEFAULT_SEAT_CONNECT_TIMEOUT_MS, Event, EventConfig, type AbortedBy } from './event.js';
import type { ManaMode } from './game.js';
import { HubAuth, HubUnavailable, type Visibility } from './hub-auth.js';
import { KNOWLEDGE_LEVELS, KnowledgeLevel, KnowledgeUnavailable, setContextRefusal, statsUnavailable } from './knowledge.js';
import { Ratings } from './ratings.js';
import type { HubHandoff } from './hub-handoff.js';
import { ExtraRoutes, loggablePath, readBody } from './mcp.js';
import { isTakenDown, ModerationSync } from './moderation.js';
import { BodyTooLarge, clientIp, RateLimiter, readLimited, tooLarge } from './ratelimit.js';
import type { AgentSeat } from './seat.js';
import { SpectateHub } from './spectate-http.js';
import { DEFAULT_SPECTATE_POLICY } from './spectate-policy.js';
import { acceptSubmission, EVENT_ID_RE, SubmissionError } from './submissions.js';
import { BEST_OF, bestOfProblem } from './best-of.js';
import { applyStartConfig, DEFAULT_LOBBY, FileLobbyStore, Lobby, type LobbyConfig, type Schedule, type TableToFire, type ViewContext } from './lobby.js';
import { LobbyHttp } from './lobby-http.js';
import { PAIRING_FORMATS, type PairingFormat } from './pairings.js';
import { resolveSeatIdentity } from './seat-identity.js';
import { SeatsRequired } from './event.js';
import { resolveSeat } from '../../registry/src/index.js';
import { neutralSeatNames } from './seat-names.js';
import { CONTEXT_POLICIES, isContextPolicy } from './context-policy.js';

/** Limits of the hosted Director (env, see main.ts and docs/ARCHITECTURE.md §5). */
export interface HostedLimits {
  admission: AdmissionConfig;
  /** An event running longer than this is stopped (EVENT_MAX_HOURS, default 8). */
  eventMaxMs: number;
  /** A queued event that hasn't started after this long is dropped (QUEUE_MAX_WAIT_HOURS, default 4). */
  queueMaxWaitMs: number;
  /** Finished events stay in memory this long (then their status is read from disk). */
  retainMs: number;
  /**
   * Optional allow-list of sets contributors may use (HOSTED_SETS). Default: every set with booster data, like
   * the admin. sets/rotation.json only lists the featured sets the site highlights.
   */
  hostedSets?: string[];
  /** API requests per client IP per minute (API_RATE_PER_MIN, default 120). */
  apiPerMin: number;
  /** Event creations per client IP per minute (CREATE_RATE_PER_MIN, default 10, bursts of 5). */
  createPerMin: number;
  /** Largest JSON request body (API_MAX_BODY, default 64 KB). */
  jsonMaxBytes: number;
}

export const DEFAULT_LIMITS: HostedLimits = {
  admission: DEFAULT_ADMISSION, eventMaxMs: 8 * 3600_000, queueMaxWaitMs: 4 * 3600_000, retainMs: 3600_000,
  apiPerMin: 120, createPerMin: 10, jsonMaxBytes: 64 * 1024,
};

export interface ServerConfig {
  base: Omit<EventConfig, 'set' | 'agents' | 'agentMeta' | 'seed' | 'knowledge' | 'mana' | 'bestOf' | 'podSize'>;
  adminToken?: string;
  publicUrl: string;
  /** Optional directory of static report data (packages/site/dist-data) served under /data/. */
  dataDir?: string;
  /** Slim card index used by the report exporter (card-data.slim.json in the cache dir). */
  cardsSlim?: string;
  /** Community submission tokens (SUBMIT_TOKENS), separate from the admin token. Empty: submissions off. */
  submitTokens?: Array<{ name: string; token: string }>;
  /** Largest accepted bundle (compressed bytes). */
  submitMaxBytes?: number;
  /** Engine image digests accepted without a flag: the pinned one plus ALLOWED_ENGINE_DIGESTS. */
  allowedEngineDigests?: string[];
  /** Behind a reverse proxy: take client IPs from X-Forwarded-For (TRUST_PROXY=1), counting TRUST_PROXY_HOPS proxies. */
  trustProxy?: boolean;
  proxyHops?: number;
  /** Read-only token for SPECTATE=admin streams (SPECTATE_TOKEN). */
  spectateToken?: string;
  /** Hands finished events to the Hub (HUB_URL); none: results stay here. */
  handoff?: HubHandoff;
  /** Checks contributor tokens with the Hub (HUB_URL + HUB_SERVICE_TOKEN); none: only the admin token creates events. */
  hubAuth?: HubAuth;
  limits?: Partial<HostedLimits>;
  /** The matchmaking lobby (docs/LOBBY.md). */
  lobby?: LobbySettings;
  /** Booster data by version: a resumed event regenerates its packs from the data it started on (booster-archive.ts). */
  boosterFactories?: BoosterFactories;
}

export interface LobbySettings {
  config?: Partial<LobbyConfig>;
  /** The site the public API links to (invite and watch pages; LOBBY_SITE_URL, default https://www.mtgdecktools.com). */
  siteUrl?: string;
  /** Allow lobby queues for every hosted set, not only the featured ones (LOBBY_ANY_SET=1). */
  anySet?: boolean;
  /** Featured queues and schedules from the LOBBY_CONFIG file: for the first start only, or (`applyInitial: 'always'`) at every start. */
  initial?: { featured?: string[]; schedules?: Schedule[] };
  /**
   * 'seed' (default): `initial` only seeds a lobby with no state yet; later changes go through the admin API.
   * 'always' (LOBBY_CONFIG_APPLY=always, the hosted stack): the file replaces the featured queues and schedules at every
   * start, so the committed config is what runs; an admin PUT lasts until the next start.
   */
  applyInitial?: 'seed' | 'always';
}

interface CreateEventBody {
  /** Match pairing: swiss (3 rounds, default) or round-robin (7 matches per seat; Private Tables). */
  pairing?: string;
  set: string;
  agents: Array<string | AgentSpec>;
  seed?: string;
  knowledge?: KnowledgeLevel;
  mana?: ManaMode;
  bestOf?: number;
  podSize?: number;
  /** Admin only: start now even when the worker is at capacity. */
  force?: boolean;
  /**
   * Admin (private tables) only: accept models and harnesses the registry doesn't list. Those seats are logged as
   * declared, labeled Unlisted and unrated until registry/models.json knows them. Hosted tables refuse them.
   */
  allow_unlisted?: boolean;
  /** Run a Set Context level as "none" on a set without a Set Context (refused otherwise for contributors; E-1). */
  allow_downgrade?: boolean;
  /**
   * A contributor's "Keep Playing" loop (`bench setup --keep-playing`): the Private Table waits behind lobby and
   * one-off tables and keeps headroom for them (admission.ts, docs/LOBBY.md §2.3). Logged in event_start.table.
   */
  continuous?: boolean;
}

class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly retryAfterS?: number) {
    super(message);
  }
}

/** `quotas`: the contributor's Private Table quotas; `lobbyQuotas`: their lobby quotas, counted separately (both from the Hub). */
type Principal = { owner: Owner; quotas?: Partial<Quotas>; lobbyQuotas?: Partial<Quotas>; github?: boolean; visibility?: Visibility };

/** Contributor ids seated at a lobby table, from its checkpoint request (for quotas after a restart). */
const lobbyContributors = (cp: EventCheckpoint): number[] =>
  cp.owner.kind === 'lobby' ? [...new Set((cp.request.agents as Array<{ contributor_id?: string }>).map((a) => Number(a.contributor_id)).filter((x) => Number.isSafeInteger(x) && x > 0))] : [];

/** Declared harness/model/effort as typed ("Claude Code", "anthropic/claude-sonnet-5-5#high"); resolved by the registry. */
const META_RE = /^[\w .:@+/#=()[\]-]{1,80}$/;
/** Seat names that would collide with object internals wherever seats are keyed by name (DIR-20). */
const RESERVED_NAMES = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Long-running Director: many events at once, created over the API by the admin or by contributors with a Hub
 * `play` token ("bring your agent, we host the table"); admission control, a FIFO queue, quotas; events survive
 * restarts (durable.ts).
 *
 *   POST   /api/events            (admin or contributor token) create an event → 201 { id, status: running, seats } or 202 { status: queued, position }
 *   GET    /api/events            list events (no seat tokens); with a contributor token: only yours
 *   GET    /api/events/:id        event status (no seat tokens), queue position while queued
 *   DELETE /api/events/:id        (admin or owner) cancel a queued event or stop a running one
 *   GET    /api/events/:id/live   spectator stream (SSE) or poll (JSON ?since=), per the fairness policy (docs/SPECTATING.md)
 *   GET    /api/events/:id/seats  (admin or owner) seat URLs again
 *   GET    /api/events/:id/files/(events.jsonl|summary.json)  (admin or owner) the event's logs, for `bench pull`
 *   GET    /api/capacity          worker capacity, load, queue length, draining
 *   GET    /api/admin/status      (admin) every live or queued event with its owner and weight
 *   POST   /api/admin/drain       (admin) { "drain": true|false, "games"?: false }: stop/resume admitting and starting events
 *                                  (deploys); with "games": false, games of running events still start (deploy.sh
 *                                  --drain-events waits for whole events to finish)
 *   POST   /api/admin/moderation/sync  (admin) read the Hub's moderation list now (takedowns, hidden text, erasures)
 *   GET    /api/sets              sets with booster data: featured, set context and human stats available, engine coverage
 *   POST   /api/submissions       (submit token) a results bundle (.tar.gz) from a community event
 *   GET    /data/*                static report data, when configured
 */
export class EventServer {
  private events = new Map<string, Event>();
  /** Requested seat names that weren't neutral, per event just created, for the creation answer only. */
  private renamedSeats = new Map<string, Record<string, string>>();
  readonly admission: Admission;
  readonly limits: HostedLimits;
  private apiLimiter: RateLimiter;
  private createLimiter: RateLimiter;
  private dataLimiter: RateLimiter;
  private sweeper?: ReturnType<typeof setInterval>;
  private exporting = false;
  private exportAgain = false;
  readonly spectate: SpectateHub;
  /** The Hub's moderation list (moderation.ts): hosted Directors with HUB_URL only. */
  readonly moderation?: ModerationSync;
  /** The matchmaking lobby (created by restore(), after live events are back). */
  lobby?: Lobby;
  private lobbyTimer?: ReturnType<typeof setInterval>;
  private visibilityTimer?: ReturnType<typeof setInterval>;
  private readonly lobbyHttp: LobbyHttp;
  /** Set by shutdown(): the process is about to exit for a restart; the watchdog forfeits nobody meanwhile. */
  private stopping = false;
  /** While draining: hold new games too (the default), or only new events (POST /api/admin/drain { games: false }). */
  private holdGames = true;

  constructor(private cfg: ServerConfig, private factory: BoosterFactory, private cards: CardDb) {
    this.limits = { ...DEFAULT_LIMITS, ...(cfg.limits ?? {}), admission: { ...DEFAULT_ADMISSION, ...(cfg.limits?.admission ?? {}) } };
    this.admission = new Admission(this.limits.admission);
    this.apiLimiter = new RateLimiter(this.limits.apiPerMin, Math.max(10, Math.ceil(this.limits.apiPerMin / 3)));
    this.createLimiter = new RateLimiter(this.limits.createPerMin, Math.max(2, Math.ceil(this.limits.createPerMin / 2)));
    this.dataLimiter = new RateLimiter(this.limits.apiPerMin * 5, this.limits.apiPerMin * 2);
    this.lobbyHttp = new LobbyHttp({
      lobby: () => this.lobby,
      caller: async (req, needPlay) => {
        const p = await this.principal(req, needPlay);
        if (!p) return undefined;
        if (p.owner.kind === 'contributor') return { kind: 'contributor', id: p.owner.id, handle: p.owner.handle, github: p.github, visibility: p.visibility, quotas: p.lobbyQuotas };
        return { kind: 'admin' };
      },
      isAdmin: (req) => this.isAdmin(req),
      ctx: () => this.lobbyContext(),
      setProblem: (set, knowledge) => this.lobbySetProblem(set, knowledge),
      jsonMaxBytes: this.limits.jsonMaxBytes,
    });
    this.spectate = new SpectateHub(cfg.base.spectate ?? DEFAULT_SPECTATE_POLICY, {
      adminToken: cfg.adminToken, spectateToken: cfg.spectateToken, trustProxy: cfg.trustProxy, proxyHops: cfg.proxyHops, runsDir: cfg.base.runsDir,
    });
    // Takedowns, hidden text and erasures from the Hub reach this Director's export and replays (moderation.ts).
    if (cfg.hubAuth) {
      const hub = cfg.hubAuth;
      this.moderation = new ModerationSync({
        fetchList: () => hub.moderation(), runsDir: cfg.base.runsDir, dataDir: cfg.dataDir, file: join(cfg.base.runsDir, '.moderation.json'),
        onChange: (ch) => {
          for (const id of ch.removed) this.forgetFinished(id);
          this.exportData();
        },
        log: (m) => console.log(m),
      });
      this.moderation.start();
    }
    if (cfg.dataDir) {
      this.exportData();
      // Keep live events fresh for the website while anything is running.
      setInterval(() => {
        if ([...this.events.values()].some((e) => e.stage !== 'done' && !e.aborted)) this.exportData();
      }, 120_000).unref();
    }
  }

  // -------------------------------------------------------------------------
  // Lifecycle: restore after a restart, the periodic sweep, graceful shutdown

  /**
   * Resume what was live before this process started (durable.ts): queued events go back in the queue in their
   * order; running ones are replayed from their logs and carry on. Also counts recent events for daily quotas.
   */
  async restore(): Promise<{ resumed: string[]; queued: string[]; closed: string[] }> {
    const out = { resumed: [] as string[], queued: [] as string[], closed: [] as string[] };
    const dir = this.cfg.base.runsDir;
    if (!existsSync(dir)) {
      this.startLobby();
      return out;
    }
    const cps: EventCheckpoint[] = [];
    for (const name of readdirSync(dir)) {
      if (!EVENT_ID_RE.test(name)) continue;
      const cp = readCheckpoint(join(dir, name));
      if (cp && cp.id === name) cps.push(cp);
    }
    cps.sort((a, b) => a.created_at - b.created_at);
    const now = Date.now();
    for (const cp of cps) {
      if (cp.status === 'done' || cp.status === 'aborted') {
        if (now - cp.created_at < 24 * 3600_000) this.admission.noteCreated(cp.owner, cp.created_at, lobbyContributors(cp));
        continue;
      }
      this.admission.noteCreated(cp.owner, cp.created_at, lobbyContributors(cp));
      try {
        if (cp.status === 'queued') {
          const ev = await this.instantiate(cp);
          this.admission.restore({ id: cp.id, owner: cp.owner, weight: cp.weight, createdAt: cp.created_at, ...(cp.continuous ? { continuous: true } : {}), contributors: lobbyContributors(cp) }, false);
          out.queued.push(cp.id);
          this.events.set(ev.id, ev);
          continue;
        }
        const evDir = join(dir, cp.id);
        Event.repair(evDir);
        const log = resumeLog(readLog(join(evDir, 'events.jsonl')));
        if (log.ended || log.aborted) {
          cp.status = log.ended ? 'done' : 'aborted';
          cp.ended_at = log.lastT;
          cp.games = {};
          writeCheckpoint(evDir, cp);
          out.closed.push(cp.id);
          continue;
        }
        // The booster data it started on, from the archive when an engine upgrade has replaced it since (E-2).
        const boosters = log.records.find((e) => e.type === 'event_start')?.boosters as Partial<BoosterProvenance> | undefined;
        const ev = await this.instantiate(cp, this.cfg.boosterFactories?.forEvent(boosters));
        ev.resumeFrom(log);
        this.admission.restore({ id: cp.id, owner: cp.owner, weight: cp.weight, createdAt: cp.created_at, ...(cp.continuous ? { continuous: true } : {}), contributors: lobbyContributors(cp) }, true);
        this.events.set(ev.id, ev);
        this.launch(ev);
        out.resumed.push(cp.id);
      } catch (err) {
        console.error(`resume ${cp.id} failed: ${String((err as Error)?.stack ?? err)}`);
        cp.status = 'aborted';
        cp.abort_reason = 'resume_failed';
        writeCheckpoint(join(dir, cp.id), cp);
        this.admission.release(cp.id);
        out.closed.push(cp.id);
      }
    }
    this.pump();
    this.refreshQueueStatus();
    this.startLobby();
    return out;
  }

  // -------------------------------------------------------------------------
  // The matchmaking lobby (docs/LOBBY.md; state machine in lobby.ts, routes in lobby-http.ts)

  /** Load the lobby's private state (`<runs>/.lobby/state.json`) and connect it to this server. */
  private startLobby(): void {
    if (this.lobby) return;
    const store = new FileLobbyStore(join(this.cfg.base.runsDir, '.lobby', 'state.json'));
    const fresh = !store.load();
    this.lobby = new Lobby({ ...DEFAULT_LOBBY, ...(this.cfg.lobby?.config ?? {}) }, store, {
      paused: () => this.admission.draining,
      fire: (t) => this.fireTable(t),
      // Lobby tables count toward each seated contributor's lobby quota, separate from their Private Tables (LOB-2).
      quota: (id, quotas, pending, now) => this.admission.quotaState(id, now, quotas, pending),
      // A table that was being created when the process stopped: find its event among the restored ones.
      recover: (tableId) => {
        for (const ev of this.events.values()) {
          const o = ev.checkpoint?.owner;
          if (o?.kind !== 'lobby' || o.table !== tableId) continue;
          const byEntry = Object.fromEntries((ev.checkpoint!.request.agents as Array<{ name: string; entry_id?: string }>).filter((a) => a.entry_id).map((a) => [a.entry_id!, a.name]));
          return { event_id: ev.id, seats: byEntry };
        }
        return undefined;
      },
    });
    if (this.cfg.lobby?.initial) {
      const r = applyStartConfig(this.lobby, this.cfg.lobby.initial, this.cfg.lobby.applyInitial ?? 'seed', fresh, Date.now());
      if (r.error) console.error(`LOBBY_CONFIG ignored: ${r.error}`);
      else if (r.applied) console.log(`lobby: LOBBY_CONFIG applied (${fresh ? 'first start' : 'every start'}): ${this.lobby.state.config.featured.length} featured queue(s), ${this.lobby.state.config.schedules.length} schedule(s)`);
    }
  }

  /** Create the event for a full, confirmed lobby table (8 seats, random seed, Swiss, rated conditions). */
  private async fireTable(t: TableToFire): Promise<{ event_id: string }> {
    const agents = t.seats.map((s) => ({
      name: s.seat_name, harness: s.seat.harness_id, model: s.seat.model_id, effort: s.seat.effort, ...(s.seat.effort_basis ? { effort_basis: s.seat.effort_basis } : {}),
      // The declared context policy (context-policy.ts): logged per seat in event_start, as for a Private Table.
      ...(s.context_policy ? { context_policy: s.context_policy } : {}),
      contributor_id: String(s.contributor.id), ...(s.show_handle ? { contributor: s.contributor.handle } : {}), entry_id: s.entry_id,
    }));
    const ev = await this.createFrom({
      set: t.queue.set, agents, knowledge: t.queue.knowledge, mana: t.queue.mana, bestOf: BEST_OF, podSize: 8, pairing: 'swiss',
      table: { kind: 'lobby', queue: t.queue.key, table_id: t.table_id, ...(t.schedule ? { schedule: t.schedule, occurrence: t.occurrence } : {}) },
    }, { owner: { kind: 'lobby', table: t.table_id } }, false, false, [...new Set(t.seats.map((s) => s.contributor.id))]);
    this.lobbyHttp.invalidate();
    return { event_id: ev.id };
  }

  /** Why a set can't have a lobby queue, or undefined. Public queues default to the featured sets, so players concentrate. */
  private lobbySetProblem(set: string, knowledge: string): string | undefined {
    const code = set.toUpperCase();
    try {
      this.factory.set(set.toLowerCase());
    } catch {
      return `unknown set ${code}: GET /api/sets lists the sets with booster data`;
    }
    if (!this.hostedSets().includes(code)) return `this Director doesn't host ${code}`;
    const noStats = statsUnavailable(knowledge as KnowledgeLevel, set.toLowerCase(), this.cfg.base.setsDir);
    if (noStats) return noStats;
    // A lobby queue never downgrades: its tables pool with the condition the queue names.
    const noContext = this.setContextProblem(code, knowledge as KnowledgeLevel, false);
    if (noContext) return noContext;
    const cfg = this.lobby?.state.config;
    const configured = [...(cfg?.featured ?? []), ...(cfg?.schedules ?? []).map((s) => s.queue)].some((k) => k.startsWith(`${set.toLowerCase()}-`));
    if (!this.cfg.lobby?.anySet && !this.featuredSets().includes(code) && !configured) {
      return `lobby queues are open for the featured sets (${this.featuredSets().join(', ')}) so players meet; run a Private Table for ${code}`;
    }
    return undefined;
  }

  /** Per set: the cards its packs can't contain (the unsupported list is fixed for the process's life). */
  private notInPacksCache = new Map<string, string[]>();

  private lobbyContext(): ViewContext {
    return {
      publicUrl: this.cfg.publicUrl,
      siteUrl: (this.cfg.lobby?.siteUrl ?? 'https://www.mtgdecktools.com').replace(/\/+$/, ''),
      promptVersion: promptVersionOf(this.cfg.base.promptsDir),
      setName: (code) => {
        try {
          return this.factory.set(code.toLowerCase()).name;
        } catch {
          return undefined;
        }
      },
      notInPacks: (code) => {
        const k = code.toLowerCase();
        if (!this.notInPacksCache.has(k)) {
          try {
            this.notInPacksCache.set(k, this.factory.swappedOut(k));
          } catch {
            this.notInPacksCache.set(k, []);
          }
        }
        return this.notInPacksCache.get(k)!;
      },
      capacity: () => ({ ...this.admission.status() }),
      eventInfo: (id) => {
        const ev = this.events.get(id);
        if (ev) {
          const sum = this.summary(ev);
          return {
            stage: String(sum.stage), queue_position: (sum.queue_position as number | undefined) ?? null,
            seatUrl: (name) => {
              const s = ev.agents.find((a) => a.name === name);
              return s && ev.stage !== 'done' && !ev.aborted ? `${this.cfg.publicUrl}/mcp/${s.token}` : null;
            },
          };
        }
        const disk = EVENT_ID_RE.test(id) ? this.diskSummary(id) : undefined;
        return disk ? { stage: String(disk.stage === 'not running (no summary)' ? 'unknown' : disk.stage), queue_position: null, seatUrl: () => null } : undefined;
      },
    };
  }

  /** An Event object for a checkpoint (same id, seed, seat order and tokens). */
  private async instantiate(cp: EventCheckpoint, factory?: BoosterFactory): Promise<Event> {
    const ev = this.newEvent(cp.request, cp.owner, { id: cp.id, tokens: cp.tokens }, factory);
    ev.checkpoint = cp;
    await ev.prepare();
    return ev;
  }

  private newEvent(req: EventCheckpoint['request'] | (Omit<EventCheckpoint['request'], 'seed'> & { seed?: string }), owner: Owner, restore?: { id: string; tokens: Record<string, string> }, factory?: BoosterFactory): Event {
    const ev = this.makeEvent(req, owner, restore, factory);
    ev.beforeGame = (seats) => this.gameGate(seats);
    return ev;
  }

  /**
   * While draining for a deploy, new games wait (running ones finish); they start when draining ends or after the restart.
   * A drain for whole events ({ games: false }) lets running events play on to their end.
   */
  private async gameGate(seats: AgentSeat[]): Promise<void> {
    if (!this.admission.draining || !this.holdGames) return;
    for (const s of seats) s.setStatus('Your next game is about to start: the server is restarting first (a few minutes at most). Keep calling wait_for_decision.');
    while (this.admission.draining && this.holdGames) await new Promise((r) => setTimeout(r, 1000));
  }

  private makeEvent(req: EventCheckpoint['request'] | (Omit<EventCheckpoint['request'], 'seed'> & { seed?: string }), owner: Owner, restore?: { id: string; tokens: Record<string, string> }, factory?: BoosterFactory): Event {
    return new Event({
      ...this.cfg.base,
      watchdogPaused: () => this.stopping,
      set: req.set,
      agents: req.agents.map((a) => a.name),
      // Logged in event_start.seats[] (the lobby's entry ids stay in the private checkpoint).
      agentMeta: Object.fromEntries(req.agents.map(({ name, ...meta }) => [name, Object.fromEntries(Object.entries(meta).filter(([k, v]) => v && k !== 'entry_id')) as Record<string, string>])),
      seed: req.seed,
      knowledge: req.knowledge,
      mana: req.mana,
      bestOf: req.bestOf,
      podSize: req.podSize,
      pairing: req.pairing ?? 'swiss',
      // The organizer's handle is logged only when they are shown publicly (LOB-3): event logs go to the Hub and the export.
      startExtras: owner.kind === 'contributor'
        ? { organizer: { kind: 'contributor', ...(this.lobby?.shown(owner.id) ?? true ? { handle: owner.handle } : {}), contributor_id: owner.id }, seat_meta: 'self-reported', table: req.table ?? { kind: 'private' } }
        : owner.kind === 'lobby'
          ? { organizer: { kind: 'lobby', table_id: owner.table }, seat_meta: 'self-reported', table: req.table ?? { kind: 'lobby', table_id: owner.table } }
          : { organizer: { kind: 'admin' } },
    }, factory ?? this.factory, this.cards, restore);
  }

  /** Periodic housekeeping (every 15 s): limits, abandoned events, queue expiry, checkpoints, memory. */
  startSweeper(intervalMs = 15_000): void {
    this.sweeper = setInterval(() => this.sweep(), intervalMs);
    this.sweeper.unref();
    // The lobby's clock: expiry, ready-check deadlines, scheduled tables.
    this.lobbyTimer = setInterval(() => void this.lobby?.tick(Date.now()), 2_000);
    this.lobbyTimer.unref();
    // The Hub's "hide my handle" setting, for everyone the lobby knows, even those who haven't called since (LOB-3).
    if (this.cfg.hubAuth) {
      void this.syncVisibility();
      this.visibilityTimer = setInterval(() => void this.syncVisibility(), 5 * 60_000);
      this.visibilityTimer.unref();
    }
  }

  /** Read the Hub's visibility setting of every contributor the lobby knows (a failure waits for the next round). */
  async syncVisibility(): Promise<void> {
    const ids = this.lobby?.contributorIds() ?? [];
    if (!this.cfg.hubAuth || !ids.length) return;
    try {
      this.lobby?.applyVisibility(await this.cfg.hubAuth.visibility(ids));
      this.lobbyHttp.invalidate();
    } catch (err) {
      console.error(`lobby: contributor visibility not refreshed: ${String((err as Error)?.message ?? err)}`);
    }
  }

  sweep(now = Date.now()): void {
    const connectMs = Math.max(this.cfg.base.seatTimeoutMs ?? 0, this.cfg.base.seatConnectTimeoutMs ?? DEFAULT_SEAT_CONNECT_TIMEOUT_MS);
    for (const ev of [...this.events.values()]) {
      const cp = ev.checkpoint;
      if (!cp) continue;
      if (cp.status === 'queued') {
        if (now - cp.created_at > this.limits.queueMaxWaitMs) this.cancelQueued(ev, 'queue_timeout');
        continue;
      }
      if (cp.status === 'running' && ev.stage !== 'done' && !ev.aborted) {
        const hours = Math.round(this.limits.eventMaxMs / 3600_000 * 10) / 10;
        if (now - ev.started > this.limits.eventMaxMs) this.stop(ev, 'max_duration', `The event was stopped: it ran longer than the ${hours}-hour limit.`);
        else if (!ev.anySeatSeen && now - ev.started > connectMs) this.stop(ev, 'abandoned', 'The event was stopped: no seat connected.');
        else ev.persist();
        continue;
      }
      // Finished: keep it in memory for a while (live view, status), then serve it from disk.
      if ((cp.ended_at ?? now) + this.limits.retainMs < now) this.events.delete(ev.id);
    }
    this.refreshQueueStatus();
  }

  /** SIGTERM: stop admitting and starting events, checkpoint every live one. The caller then exits. */
  shutdown(): void {
    this.stopping = true;
    this.admission.draining = true;
    if (this.sweeper) clearInterval(this.sweeper);
    if (this.lobbyTimer) clearInterval(this.lobbyTimer);
    if (this.visibilityTimer) clearInterval(this.visibilityTimer);
    this.lobby?.flush();
    for (const ev of this.events.values()) if (ev.checkpoint?.status === 'running' && !ev.aborted) ev.persist();
  }

  /** Live (running) events and the games in progress in them. */
  liveCounts(): { events: number; games: number; queued: number } {
    let events = 0;
    let games = 0;
    for (const ev of this.events.values()) {
      if (ev.checkpoint?.status !== 'running' || ev.stage === 'done' || ev.aborted) continue;
      events++;
      games += ev.liveGameCount;
    }
    return { events, games, queued: this.admission.queued.length };
  }

  // -------------------------------------------------------------------------
  // Events

  /** A taken-down event leaves memory once it is over (moderation.ts); a running one stays until it ends. */
  private forgetFinished(id: string): void {
    const ev = this.events.get(id);
    if (ev && (ev.stage === 'done' || ev.aborted)) this.events.delete(id);
  }

  /** Regenerate the report JSON (packages/site build-data) into dataDir; one run at a time. */
  exportData(): void {
    if (!this.cfg.dataDir) return;
    if (this.exporting) {
      this.exportAgain = true;
      return;
    }
    this.exporting = true;
    const root = resolve(import.meta.dirname, '../../..');
    // This Node with tsx (no npx: nothing is resolved from PATH or written to an npm cache, so the root file system can
    // stay read-only). Fixed arguments, no shell.
    const args = ['--import', 'tsx', 'packages/site/src/build-data.ts', '--runs', this.cfg.base.runsDir, '--sets', this.cfg.base.setsDir, '--out', this.cfg.dataDir];
    if (this.cfg.cardsSlim) args.push('--cards', this.cfg.cardsSlim);
    const child = spawn(process.execPath, args, { cwd: root, stdio: ['ignore', 'ignore', 'pipe'] });
    child.on('error', (e) => console.error(`report export could not start: ${e.message}`));
    let err = '';
    // Only the tail is ever printed: keep the buffer bounded however much the export writes.
    child.stderr.on('data', (d) => (err = (err + String(d)).slice(-4000)));
    child.on('close', (code) => {
      this.exporting = false;
      if (code !== 0) console.error(`report export failed (${code}): ${err.slice(-500)}`);
      if (this.exportAgain) {
        this.exportAgain = false;
        this.exportData();
      }
    });
  }

  seatByToken = (token: string): AgentSeat | undefined => {
    // Queued events' seats already answer (they are told to wait); finished ones answer EVENT COMPLETE until evicted.
    for (const ev of this.events.values()) {
      const s = ev.seatByToken(token);
      if (s) return s;
    }
    return undefined;
  };

  /** The allowed values for a contributor's event (hosted play); admins keep full power. */
  private validate(body: CreateEventBody, owner: Owner): { set: string; agents: AgentSpec[]; renamed: Record<string, string>; knowledge: KnowledgeLevel; mana: ManaMode; bestOf: number; podSize: number; seed?: string } {
    if (!body || typeof body !== 'object' || typeof body.set !== 'string' || !Array.isArray(body.agents) || body.agents.length < 1) {
      throw new HttpError(400, 'Need `set` and at least one entry in `agents`.');
    }
    if (body.knowledge && !KNOWLEDGE_LEVELS.includes(body.knowledge)) throw new HttpError(400, `knowledge must be one of ${KNOWLEDGE_LEVELS.join(', ')}.`);
    if (body.mana && !['manual', 'auto'].includes(body.mana)) throw new HttpError(400, 'mana must be manual or auto.');
    try {
      if (!/^[A-Za-z0-9]{2,8}$/.test(body.set)) throw new Error('bad set code');
      this.factory.set(body.set); // throws for unknown sets
    } catch {
      throw new HttpError(400, `Unknown set "${String(body.set).slice(0, 12)}": GET /api/sets lists the ${this.factory.sets().length} sets with booster data.`);
    }
    const knowledge: KnowledgeLevel = body.knowledge ?? (owner.kind === 'contributor' ? 'primer' : 'none');
    const noStats = statsUnavailable(knowledge, body.set, this.cfg.base.setsDir);
    if (noStats) throw new HttpError(400, noStats);
    if (body.allow_downgrade != null && typeof body.allow_downgrade !== 'boolean') throw new HttpError(400, 'allow_downgrade must be true or false.');
    const noContext = this.setContextProblem(body.set, knowledge, body.allow_downgrade === true || owner.kind === 'admin');
    if (noContext) throw new HttpError(400, noContext);
    const specs: AgentSpec[] = body.agents.map((a) => (typeof a === 'string' ? { name: a } : a)).map((a) => ({
      name: String(a?.name ?? ''), ...(a?.harness ? { harness: String(a.harness) } : {}), ...(a?.model ? { model: String(a.model) } : {}), ...(a?.effort ? { effort: String(a.effort) } : {}),
      // How the effort was declared: "launch" (the bench CLI starts the seat with it) or "self-report" (seated by hand).
      ...(a?.effort_basis === 'launch' || a?.effort_basis === 'self-report' ? { effort_basis: a.effort_basis } : {}),
      ...(isContextPolicy(a?.context_policy) ? { context_policy: a.context_policy } : {}),
    }));
    const badPolicy = body.agents.find((a) => typeof a === 'object' && a?.context_policy != null && (a.context_policy as unknown) !== 'harness' && !isContextPolicy(a.context_policy));
    if (badPolicy) throw new HttpError(400, `seat ${String((badPolicy as AgentSpec).name ?? '?').slice(0, 40)}: context_policy must be ${CONTEXT_POLICIES.join(' or ')} (or left out).`);
    const names = specs.map((a) => a.name);
    if (new Set(names).size !== names.length || names.some((n) => !/^[\w.-]{1,40}$/.test(n) || RESERVED_NAMES.has(n))) {
      throw new HttpError(400, 'Agent names must be unique and use letters, digits, dot, dash or underscore.');
    }
    for (const a of specs) for (const k of ['harness', 'model', 'effort'] as const) {
      if (a[k] != null && !META_RE.test(a[k]!)) throw new HttpError(400, `seat ${a.name}: ${k} must be 1–80 characters of letters, digits, spaces and . : @ + / # = ( ) [ ] - _`);
    }
    // Every event plays best of 3 with sideboarding (best-of.ts), the admin's too: absent means 3, anything else is refused.
    const bestOfRefused = bestOfProblem(body.bestOf);
    if (bestOfRefused) throw new HttpError(400, bestOfRefused);
    const bestOf = BEST_OF;
    const podSize = body.podSize ?? 8;
    // Every event seats 8 agents (no bot drafters: docs/METHODOLOGY.md §3). Fewer agents: the lobby (docs/LOBBY.md).
    if (podSize !== 8) throw new HttpError(400, 'Every event has 8 seats (podSize 8).');
    if (specs.length !== podSize) {
      throw new HttpError(400, `Every event needs an agent in each of its 8 seats (got ${specs.length}). Bring 8 seats for a Private Table (seats may share a model), or join the lobby with 1–4 (docs/LOBBY.md). Scripted seats ("script") work for tests.`);
    }
    if (owner.kind === 'contributor') {
      // Hosted play: rated conditions only, declared seats, no chosen seeds (a known seed means known packs).
      // Any set with booster data, unless the operator restricted this Director (HOSTED_SETS).
      const only = this.limits.hostedSets?.map((x) => x.toUpperCase());
      if (only?.length && !only.includes(body.set.toUpperCase())) throw new HttpError(400, `This Director hosts these sets only: ${only.join(', ')}.`);
      if (specs.length < 2) throw new HttpError(400, 'a hosted event needs at least two agent seats.');
      if (podSize !== 8) throw new HttpError(400, 'hosted events use an 8-seat pod.');
      if (body.seed != null) throw new HttpError(400, 'hosted events get a random seed; `seed` is for maintainer runs.');
      if (body.force) throw new HttpError(403, '`force` is for the admin token.');
      const missing = specs.filter((a) => !a.harness || !a.model).map((a) => a.name);
      if (missing.length) throw new HttpError(400, `declare each seat's harness and model (self-reported, e.g. {"name":"a","harness":"claude-code","model":"claude-opus-5-5","effort":"high"}); missing for ${missing.join(', ')}.`);
    }
    if (body.seed != null && (typeof body.seed !== 'string' || body.seed.length > 120)) throw new HttpError(400, 'seed must be a string of at most 120 characters.');
    // Canonical seat identity (registry/README.md): every declared seat resolves to canonical harness, model and
    // effort; event_start logs both those and the strings as typed. Unknown names are refused with suggestions,
    // except on private tables that pass allow_unlisted (those seats stay unrated until the registry lists them).
    if (body.allow_unlisted != null && typeof body.allow_unlisted !== 'boolean') throw new HttpError(400, 'allow_unlisted must be true or false.');
    if (body.allow_unlisted && owner.kind === 'contributor') {
      throw new HttpError(400, 'hosted tables accept only models and harnesses in the registry (registry/models.json); allow_unlisted is for private tables.');
    }
    const resolved = specs.map((a): AgentSpec => {
      if (!a.harness && !a.model && !a.effort) return a; // scripted smoke seats on an admin table
      // Hosted tables are rated: a concrete effort level wherever the harness can set one (METHODOLOGY §2.1).
      const r = resolveSeat(a, { allowUnlisted: body.allow_unlisted === true, at: Date.now(), requireEffort: owner.kind === 'contributor' });
      if (!r.ok) throw new HttpError(400, `seat ${a.name}: ${r.error}`);
      return { name: a.name, ...r.seat, ...(a.effort_basis ? { effort_basis: a.effort_basis } : {}), ...(a.context_policy ? { context_policy: a.context_policy } : {}) };
    });
    // Neutral seat names at every table (seat-names.ts): a name like "claude-haiku-5-5-2" would reach the anonymous
    // status, the live stream and the logs. The answer says which names were replaced (`renamed`).
    const { seats: agents, renamed } = neutralSeatNames(resolved);
    return {
      set: body.set.toLowerCase(), agents, knowledge, renamed,
      mana: body.mana ?? 'manual', bestOf, podSize, ...(body.seed ? { seed: body.seed } : {}),
    };
  }

  /** Sets contributors may use: every set with booster data, or the operator's HOSTED_SETS allow-list. */
  hostedSets(): string[] {
    if (this.limits.hostedSets?.length) return this.limits.hostedSets.map((s) => s.toUpperCase());
    return this.factory.sets().map((s) => s.code.toUpperCase());
  }

  /** Featured sets (sets/rotation.json): the ones the site highlights. Every other set is just as playable. */
  featuredSets(): string[] {
    try {
      const rot = JSON.parse(readFileSync(join(this.cfg.base.setsDir, 'rotation.json'), 'utf8')) as { featured?: Array<{ code: string }>; active?: Array<{ code: string }> };
      return (rot.featured ?? rot.active ?? []).map((s) => s.code.toUpperCase());
    } catch {
      return [];
    }
  }

  private setsCache?: { at: number; body: unknown };

  /**
   * GET /api/sets: every set with booster data, newest first, with what it offers: `featured`, `set_context`
   * (a set context is available for knowledge "primer"), `human_stats` (knowledge "primer+stats" and the
   * human-reference metrics), `coverage` (share of the set's booster cards the engine runs; the rest are swapped).
   */
  /** A Set Context exists for this set (the repo copy, or one fetched from mtgdecktools.com before). */
  private setContextAvailable(code: string): boolean {
    const c = code.toUpperCase();
    const cacheDir = this.cfg.base.primerSources?.cacheDir;
    return existsSync(join(this.cfg.base.setsDir, c, 'primer.md')) || (!!cacheDir && existsSync(join(cacheDir, `${c}.md`)));
  }

  /**
   * A table asked for a Set Context level on a set without one: it would quietly run at "none"
   * and pool there. Refused for contributors unless they say so (`allow_downgrade`); admin tables keep the warning.
   */
  private setContextProblem(code: string, knowledge: KnowledgeLevel, allowDowngrade: boolean): string | undefined {
    return setContextRefusal(code, knowledge, { available: knowledge === 'none' || this.setContextAvailable(code), allowDowngrade });
  }

  setsInfo(): unknown {
    if (this.setsCache && Date.now() - this.setsCache.at < 10 * 60_000) return this.setsCache.body;
    const featured = this.featuredSets();
    const hosted = new Set(this.hostedSets());
    const sets = this.factory.sets().map((s) => {
      const code = s.code.toUpperCase();
      const index = this.factory.cardIndex(code);
      let supported = 0;
      for (const c of index.values()) if (this.factory.isSupported(c.name)) supported++;
      return {
        ...s, code, featured: featured.includes(code), hosted: hosted.has(code),
        set_context: this.setContextAvailable(code),
        human_stats: Ratings.hasStats(this.cfg.base.setsDir, code),
        coverage: index.size ? Math.round((supported / index.size) * 1000) / 1000 : null,
      };
    });
    const body = { sets, featured, hosted: [...hosted] };
    this.setsCache = { at: Date.now(), body };
    return body;
  }

  /** Create an event: admitted at once, queued, or refused (HttpError 400/429/503). */
  async create(body: CreateEventBody, who: Principal = { owner: { kind: 'admin' } }): Promise<Event> {
    const pairing = (body.pairing ?? 'swiss') as PairingFormat;
    if (!PAIRING_FORMATS.includes(pairing)) throw new HttpError(400, `pairing must be one of ${PAIRING_FORMATS.join(', ')}.`);
    if (body.continuous != null && typeof body.continuous !== 'boolean') throw new HttpError(400, 'continuous must be true or false.');
    const continuous = body.continuous === true;
    const { renamed, ...valid } = this.validate(body, who.owner);
    const req = {
      ...valid, pairing,
      ...(who.owner.kind === 'contributor' ? { table: { kind: 'private' as const, ...(continuous ? { continuous: true } : {}) } } : {}),
    };
    const ev = await this.createFrom(req, who, body.force === true, continuous);
    if (Object.keys(renamed).length) this.renamedSeats.set(ev.id, renamed);
    const ident = (a: { harness?: string; model?: string; effort?: string }) => {
      const r = resolveSeatIdentity(a);
      if (!r.ok) return null;
      const { ok, ...rest } = r;
      void ok;
      return rest;
    };
    const tableSeats = req.agents.map((a) => ({ seat_name: a.name, seat: ident(a) }));
    // A Private Table: every seat is this contributor's; it counts in the lobby's contribution stats.
    if (who.owner.kind === 'contributor') this.lobby?.notePrivate(ev.id, { id: who.owner.id, handle: who.owner.handle }, tableSeats, Date.now());
    // The admin's Private Tables are listed in the lobby's recent tables too, never counted as contribution.
    else if (who.owner.kind === 'admin') this.lobby?.noteAdminTable(ev.id, tableSeats, Date.now());
    return ev;
  }

  /** Admit and create a validated event request (also how the lobby fires a table). */
  private async createFrom(req: Omit<EventCheckpoint['request'], 'seed'> & { seed?: string }, who: Principal, force = false, continuousAsked = false, contributors: number[] = []): Promise<Event> {
    if (req.agents.length !== req.podSize) throw new HttpError(400, `Every event needs an agent in each of its ${req.podSize} seats (got ${req.agents.length}).`);
    const weight = eventWeight(req.agents.length);
    const now = Date.now();
    // The continuous-play rules (lower priority, headroom, one per contributor) apply to contributors' tables only.
    const continuous = continuousAsked && who.owner.kind === 'contributor';
    const decision = this.admission.check(who.owner, weight, now, who.quotas, force, continuous);
    if (!decision.ok) throw new HttpError(decision.status, decision.error, decision.retryAfterS);
    let ev: Event;
    try {
      ev = this.newEvent(req, who.owner);
    } catch (err) {
      throw err instanceof SeatsRequired ? new HttpError(400, err.message) : err;
    }
    const cp: EventCheckpoint = {
      version: 1, id: ev.id, status: decision.start ? 'running' : 'queued', owner: who.owner, weight, created_at: now, ...(continuous ? { continuous: true } : {}),
      request: { ...req, seed: ev.seed }, tokens: Object.fromEntries(ev.agents.map((s) => [s.name, s.token])), games: {}, seats: {},
    };
    ev.checkpoint = cp;
    // Reserve the capacity (or the queue place) before any await, so concurrent requests can't overbook.
    this.admission.admit({ id: ev.id, owner: who.owner, weight, createdAt: now, ...(continuous ? { continuous: true } : {}), ...(contributors.length ? { contributors } : {}) }, decision.start, now);
    this.events.set(ev.id, ev);
    try {
      await ev.prepare();
      ev.persist();
      writeFileSync(join(ev.dir, 'seats.json'), JSON.stringify(this.seatUrls(ev), null, 1), { mode: 0o600 });
    } catch (err) {
      this.admission.release(ev.id);
      this.events.delete(ev.id);
      throw err instanceof KnowledgeUnavailable ? new HttpError(400, err.message) : err;
    }
    if (decision.start) this.start(ev);
    else this.refreshQueueStatus();
    this.exportData();
    return ev;
  }

  private start(ev: Event): void {
    const cp = ev.checkpoint!;
    cp.status = 'running';
    cp.admitted_at = Date.now();
    ev.persist();
    this.launch(ev);
  }

  private launch(ev: Event): void {
    ev.run()
      .then(() => {
        // event_end and summary.json are written: hand the results to the Hub (retries in the background).
        if (ev.stage === 'done' && !ev.aborted) this.cfg.handoff?.send(ev.dir).catch((err) => console.error(`hub hand-off ${ev.id}: ${String(err?.stack ?? err)}`));
        this.finished(ev);
      }, (err) => {
        if (err instanceof ResumeMismatch) {
          ev.abort('resume_failed', `The event could not be resumed after a restart (${err.message}).`);
          this.handOffStopped(ev);
        }
        else if (!ev.aborted) ev.log('event_error', { message: String(err?.stack ?? err) });
        this.finished(ev);
      })
      .finally(() => this.exportData());
  }

  /** An event ended (finished, failed or aborted): free its capacity and start whatever fits from the queue. */
  private finished(ev: Event): void {
    const cp = ev.checkpoint;
    // Lobby tables and Private Tables: finished and abandoned seats, games (contribution stats, reliability).
    if (cp?.owner.kind === 'lobby' || cp?.owner.kind === 'contributor') {
      this.lobby?.eventFinished(ev.id, ev.stage === 'done' && !ev.aborted ? 'done' : 'aborted', ev.seatOutcomes(), Date.now());
      this.lobbyHttp.invalidate();
    }
    if (cp && cp.status !== 'done' && cp.status !== 'aborted') {
      cp.status = ev.stage === 'done' && !ev.aborted ? 'done' : 'aborted';
      if (ev.aborted) cp.abort_reason = ev.aborted;
      cp.ended_at = Date.now();
      ev.persist();
    }
    this.admission.release(ev.id);
    this.pump();
  }

  /** Start queued events that fit now (FIFO). */
  private pump(): void {
    for (const e of this.admission.next()) {
      const ev = this.events.get(e.id);
      if (ev) this.start(ev);
      else this.admission.release(e.id);
    }
    this.refreshQueueStatus();
  }

  /** Stop a running event for good (event_abort) and free its capacity. */
  stop(ev: Event, reason: string, message: string, by: AbortedBy = 'system'): void {
    ev.abort(reason, message, by);
    this.handOffStopped(ev);
    this.finished(ev);
    this.exportData();
  }

  /**
   * A stopped event with finished games goes to the Hub like a finished one: its finished games are results
   * (METHODOLOGY §3.2, "Stopped events"), so stopping a table can't erase the games already played.
   */
  private handOffStopped(ev: Event): void {
    if (ev.completedGames > 0) this.cfg.handoff?.send(ev.dir).catch((err) => console.error(`hub hand-off ${ev.id}: ${String(err?.stack ?? err)}`));
  }

  private cancelQueued(ev: Event, reason: string): void {
    const cp = ev.checkpoint!;
    cp.status = 'aborted';
    cp.abort_reason = reason;
    cp.ended_at = Date.now();
    ev.persist();
    this.admission.release(ev.id);
    this.lobby?.eventFinished(ev.id, 'aborted', {}, Date.now());
    const why = reason === 'queue_timeout' ? 'it waited too long in the queue for a free table' : 'it was canceled';
    for (const s of ev.agents) s.finish(`EVENT COMPLETE. This event never started: ${why}. You can stop now.`);
    this.refreshQueueStatus();
  }

  /** Tell the seats of queued events where they stand. */
  private refreshQueueStatus(): void {
    for (const e of this.admission.queued) {
      const ev = this.events.get(e.id);
      const pos = this.admission.position(e.id);
      for (const s of ev?.agents ?? []) {
        s.setStatus(`Your event is waiting for a free table (position ${pos} in the queue${this.admission.draining ? '; the server is about to restart' : ''}). It starts on its own: keep calling wait_for_decision.`);
      }
    }
  }

  seatUrls(ev: Event): Record<string, string> {
    return Object.fromEntries(ev.agents.map((s) => [s.name, `${this.cfg.publicUrl}/mcp/${s.token}`]));
  }

  /**
   * The status anyone may read (LOB-5). While an event runs, an agent with web tools could find it and learn about
   * its opponents from live per-seat states (who is deciding right now: a timing channel the spectator delay
   * exists to close), forfeits and standings. So anonymous callers of a running event get each seat's name (neutral
   * in lobby events) and only whether it is done; standings and per-seat details come once the event has ended.
   * The organizer and the admin always get the full summary.
   */
  publicSummary(ev: Event): Record<string, unknown> {
    const out = this.summary(ev);
    const stage = String(out.stage);
    if (stage === 'done' || stage === 'aborted') return out;
    const { standings: _standings, agents, ...rest } = out;
    return {
      ...rest,
      agents: (agents as Array<{ name: string; status: string }>).map((a) => ({ name: a.name, status: a.status === 'done' ? 'done' : 'playing' })),
      standings_after: 'the event ends',
    };
  }

  /** The caller's summary of an event: full for its organizer and the admin, else publicSummary. Never throws for a bad token. */
  private async summaryFor(req: IncomingMessage, ev: Event): Promise<Record<string, unknown>> {
    let who: Principal | undefined;
    try {
      who = await this.principal(req, false);
    } catch {
      who = undefined;
    }
    return this.owns(who, ev.checkpoint?.owner ?? (who?.owner.kind === 'admin' ? { kind: 'admin' } : undefined)) ? this.summary(ev) : this.publicSummary(ev);
  }

  summary(ev: Event): Record<string, unknown> {
    const cp = ev.checkpoint;
    const queued = cp?.status === 'queued';
    const out: Record<string, unknown> = { ...ev.summary() };
    if (queued) {
      out.stage = 'queued';
      out.queue_position = this.admission.position(ev.id) ?? null;
    }
    if (cp?.status === 'aborted' && !ev.aborted) {
      out.stage = 'aborted';
      out.abort_reason = cp.abort_reason;
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Auth

  private isAdmin(req: IncomingMessage): boolean {
    const want = this.cfg.adminToken;
    return !!want && tokenMatches(req, want);
  }

  /**
   * Who is calling: the admin, a contributor with an active Hub token, or nobody (undefined). Throws HttpError 401
   * for a token that isn't valid, 503 when the Hub can't be reached.
   */
  private async principal(req: IncomingMessage, needPlay: boolean): Promise<Principal | undefined> {
    if (this.isAdmin(req)) return { owner: { kind: 'admin' } };
    const token = bearer(req);
    if (!token) return undefined;
    if (!this.cfg.hubAuth) throw new HttpError(401, 'this Director only accepts its admin token (contributor tokens need HUB_URL)');
    let info;
    try {
      info = await this.cfg.hubAuth.introspect(token);
    } catch (err) {
      if (err instanceof HubUnavailable) throw new HttpError(503, err.message, 30);
      throw err;
    }
    // 401: the Hub answers whether this is an active token *with the play scope* (HUB-17), so a submit-only token is,
    // to this Director, no credential at all. 403 is kept for an authenticated contributor who may not do this (the
    // terms below, and older Hubs that still report other scopes as active).
    if (!info.active || !info.contributor) throw new HttpError(401, 'token not recognized for hosted play (revoked, mistyped, or without the `play` scope); get a contributor token with `bench login` or at the Hub');
    if (needPlay && !info.scopes?.includes('play')) throw new HttpError(403, 'this token has no `play` scope; sign in at the Hub to get a contributor token');
    // Hosted play needs the Hub's current terms accepted (docs/legal/TERMS.md).
    if (needPlay && info.terms && !info.terms.accepted) {
      throw new HttpError(403, info.terms.message ?? `accept the current terms (${info.terms.current}) before hosted play: run \`bench login\` again, or use the Accept button on the Hub's /account page`);
    }
    const c = info.contributor;
    // The Hub's leaderboard setting reaches the lobby with every authenticated request (LOB-3).
    if (info.board_visibility !== undefined) this.lobby?.noteVisibility({ id: c.id, handle: c.handle }, info.board_visibility, Date.now());
    return {
      owner: { kind: 'contributor', id: c.id, handle: c.handle, ...(info.token_id ? { token_id: info.token_id } : {}) },
      quotas: { concurrent: info.quotas?.play_concurrent, daily: info.quotas?.play_daily },
      // A Hub from before separate lobby quotas sends none: the Director's lobby defaults apply.
      lobbyQuotas: { concurrent: info.quotas?.lobby_concurrent, daily: info.quotas?.lobby_daily },
      github: !!c.github_login,
      ...(info.board_visibility !== undefined ? { visibility: info.board_visibility } : {}),
    };
  }

  private owns(p: Principal | undefined, owner: Owner | undefined): boolean {
    if (!p) return false;
    if (p.owner.kind === 'admin') return true;
    return p.owner.kind === 'contributor' && owner?.kind === 'contributor' && owner.id === p.owner.id;
  }

  /** The submitter name for a valid submission token, else undefined. */
  private submitter(req: IncomingMessage): string | undefined {
    return this.cfg.submitTokens?.find((t) => tokenMatches(req, t.token))?.name;
  }

  /** An event's status from disk (finished, or from before a restart). */
  private diskSummary(id: string): Record<string, unknown> | undefined {
    const dir = join(this.cfg.base.runsDir, id);
    if (!hasEventLog(dir) && !existsSync(join(dir, 'state.json'))) return undefined;
    const summaryFile = join(dir, 'summary.json');
    let summary: { standings?: unknown[] } | undefined;
    try {
      summary = existsSync(summaryFile) ? JSON.parse(readFileSync(summaryFile, 'utf8')) : undefined;
    } catch {
      summary = undefined;
    }
    const cp = readCheckpoint(dir);
    const stage = summary ? 'done' : cp?.status === 'aborted' ? 'aborted' : 'not running (no summary)';
    return { id, stage, ...(cp?.abort_reason ? { abort_reason: cp.abort_reason } : {}), standings: summary?.standings ?? [], live: false };
  }

  private submitting = false;

  private async submit(req: IncomingMessage): Promise<[number, unknown]> {
    if (!this.cfg.submitTokens?.length) return [404, { error: 'submissions are not enabled on this server' }];
    const submitter = this.submitter(req);
    if (!submitter) return [401, { error: 'submission token required (Authorization: Bearer <token>)' }];
    // Unpacking and checking a bundle is synchronous work: one at a time (DIR-3).
    if (this.submitting) return [429, { error: 'another submission is being checked; try again in a few seconds' }];
    this.submitting = true;
    try {
      return await this.submitOne(req, submitter);
    } finally {
      this.submitting = false;
    }
  }

  private async submitOne(req: IncomingMessage, submitter: string): Promise<[number, unknown]> {
    const max = this.cfg.submitMaxBytes ?? 25 * 1024 * 1024;
    let body: Buffer | undefined;
    try {
      body = await readLimited(req, max);
    } catch (err) {
      if (err instanceof BodyTooLarge) return [413, { error: `bundle larger than ${max} bytes`, close: true }];
      return [400, { error: 'upload interrupted' }];
    }
    try {
      const { id, source } = acceptSubmission(body, this.cfg.base.runsDir, submitter, { allowedEngineDigests: this.cfg.allowedEngineDigests ?? [] });
      console.log(`submission accepted: ${id} from ${submitter}${source.flags.length ? ` (flags: ${source.flags.join(', ')})` : ''}`);
      this.exportData();
      return [201, { id, label: source.label, submitter, flags: source.flags, warnings: source.warnings, bundle_sha256: source.bundle_sha256,
        report: this.cfg.dataDir ? `${this.cfg.publicUrl}/data/events/${id}.json` : null }];
    } catch (e) {
      if (e instanceof SubmissionError) return [e.status, { error: e.message, ...(e.details ? { details: e.details } : {}) }];
      console.error(`submission failed: ${(e as Error)?.stack ?? e}`);
      return [500, { error: 'could not store the submission' }];
    }
  }

  /** The owner of an event, from memory or its checkpoint on disk. */
  private ownerOf(id: string): Owner | undefined {
    return this.events.get(id)?.checkpoint?.owner ?? readCheckpoint(join(this.cfg.base.runsDir, id))?.owner;
  }

  // -------------------------------------------------------------------------
  // HTTP

  routes: ExtraRoutes = async (req, res) => {
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://x');
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'bad request target' }));
      return true;
    }
    const json = (code: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers }).end(JSON.stringify(body, null, 1));
      return true;
    };
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const ip = clientIp(req, !!this.cfg.trustProxy, this.cfg.proxyHops);

    // Public reads that browsers fetch (mtgdecktools.com): their errors carry the same CORS header as their answers, so
    // a page can tell "not found" or "slow down" from "unreachable". Authenticated and admin routes never get one.
    const publicCors = { 'Access-Control-Allow-Origin': '*' };
    if (path.startsWith('/data/') && this.cfg.dataDir && req.method === 'GET') {
      const wait = this.dataLimiter.take(ip);
      if (wait) return json(429, { error: 'too many requests' }, { 'Retry-After': String(wait), ...publicCors });
      const rel = path.slice('/data/'.length);
      const root = resolve(this.cfg.dataDir);
      const file = resolve(root, rel);
      const inside = relative(root, file);
      // Confined to the export directory (DIR-16), no dot-files or dot-directories (DIR-12).
      if (!inside || inside.startsWith('..') || isAbsolute(inside) || rel.split('/').some((seg) => seg.startsWith('.'))
        || !existsSync(file) || !statSync(file).isFile()) return json(404, { error: 'not found' }, publicCors);
      const type = extname(file) === '.json' ? 'application/json' : extname(file) === '.md' ? 'text/markdown; charset=utf-8' : 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': type, 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=60' });
      createReadStream(file).on('error', () => res.destroy()).pipe(res);
      return true;
    }
    if (!path.startsWith('/api/')) return false;

    // The spectator stream has its own per-IP limits (spectate-http.ts).
    const live = path.match(/^\/api\/events\/([^/]+)\/live$/);
    if (live && (req.method === 'GET' || req.method === 'OPTIONS')) {
      const id = live[1]!;
      if (!EVENT_ID_RE.test(id)) return json(404, { error: 'no such event' }, publicCors);
      return (await this.spectate.handle(req, res, id, this.events.get(id)?.spectator)) || json(404, { error: 'no such event' }, publicCors);
    }
    const wait = this.apiLimiter.take(ip);
    // The lobby's public reads are fetched by browsers (mtgdecktools.com): let them see the 429 too.
    if (wait) return json(429, { error: 'too many requests; slow down' }, { 'Retry-After': String(wait), ...(path.startsWith('/api/lobby') ? { 'Access-Control-Allow-Origin': '*' } : {}) });

    try {
      if (path === '/api/sets' && req.method === 'GET') return json(200, this.setsInfo());
      if (path === '/api/capacity' && req.method === 'GET') return json(200, { ...this.admission.status(), live: this.liveCounts() });

      if (path === '/api/events' && req.method === 'GET') {
        const who = await this.principal(req, false);
        const list = [...this.events.values()].filter((e) => !isTakenDown(e.id) && (!who || who.owner.kind === 'admin' || this.owns(who, e.checkpoint?.owner)));
        return json(200, list.map((e) => (this.owns(who, e.checkpoint?.owner ?? (who?.owner.kind === 'admin' ? { kind: 'admin' } : undefined)) ? this.summary(e) : this.publicSummary(e))));
      }
      if (path === '/api/events' && req.method === 'POST') {
        const cw = this.createLimiter.take(ip);
        if (cw) return json(429, { error: 'too many events created from this address; slow down' }, { 'Retry-After': String(cw) });
        const who = await this.principal(req, true);
        if (!who) return json(401, { error: 'a token is required: the admin token, or a contributor token with the play scope (Authorization: Bearer <token>)' });
        let body: CreateEventBody;
        try {
          body = (await readBody(req, this.limits.jsonMaxBytes)) as CreateEventBody;
        } catch (err) {
          if (err instanceof BodyTooLarge) return tooLarge(res, err.message), true;
          return json(400, { error: 'malformed JSON body' });
        }
        const ev = await this.create(body, who);
        const renamed = this.renamedSeats.get(ev.id);
        this.renamedSeats.delete(ev.id);
        const queued = ev.checkpoint?.status === 'queued';
        return json(queued ? 202 : 201, {
          id: ev.id, status: queued ? 'queued' : 'running', ...(queued ? { queue_position: this.admission.position(ev.id) } : {}),
          // No seed, for any table: it regenerates the packs, so it stays secret until the event ends (docs/COMMUNITY.md,
          // ARCHITECTURE.md); the status shows it once the event is done. An admin who chose one already knows it.
          knowledge: ev.knowledge.level, primer: ev.knowledge.primerSource ?? null, seats: this.seatUrls(ev),
          // Canonical harness/model/effort per seat as logged (plus the declared strings when they differed).
          seat_meta: Object.fromEntries((ev.checkpoint?.request.agents ?? []).map(({ name, ...meta }) => [name, meta])),
          // Seat names are neutral at every table: requested names that weren't, and what they became.
          ...(renamed ? { renamed } : {}),
          status_url: `${this.cfg.publicUrl}/api/events/${ev.id}`,
        });
      }
      if (path === '/api/submissions' && req.method === 'POST') {
        const [code, body] = await this.submit(req);
        if (code === 413) return tooLarge(res, (body as { error: string }).error), true;
        return json(code, body);
      }

      if (await this.lobbyHttp.handle(req, res, url, path)) return true;

      if (path.startsWith('/api/admin/')) {
        if (!this.isAdmin(req)) return json(401, { error: 'admin token required' });
        if (path === '/api/admin/status' && req.method === 'GET') {
          return json(200, {
            ...this.admission.status(), live: this.liveCounts(),
            events: [...this.events.values()].filter((e) => e.checkpoint && e.checkpoint.status !== 'done').map((e) => ({
              id: e.id, status: e.checkpoint!.status, stage: e.aborted ? 'aborted' : e.stage, owner: e.checkpoint!.owner, weight: e.checkpoint!.weight,
              games: e.liveGameCount, created_at: e.checkpoint!.created_at, admitted_at: e.checkpoint!.admitted_at ?? null,
              queue_position: this.admission.position(e.id) ?? null, resumes: e.checkpoint!.resumes ?? 0,
            })),
          });
        }
        if (path === '/api/admin/moderation/sync' && req.method === 'POST') {
          if (!this.moderation) return json(409, { error: 'no Hub configured (HUB_URL): this Director has no moderation list' });
          const change = await this.moderation.syncNow();
          return json(200, { change, last_sync: this.moderation.lastSync });
        }
        if (path === '/api/admin/drain' && req.method === 'POST') {
          let body: { drain?: boolean; games?: boolean } | undefined;
          try {
            body = (await readBody(req, this.limits.jsonMaxBytes)) as { drain?: boolean; games?: boolean } | undefined;
          } catch {
            return json(400, { error: 'malformed JSON body' });
          }
          this.admission.draining = body?.drain !== false;
          this.holdGames = body?.games !== false;
          void this.lobby?.tick(Date.now());
          if (!this.admission.draining) this.pump();
          else this.refreshQueueStatus();
          return json(200, { ...this.admission.status(), hold_games: this.admission.draining && this.holdGames, live: this.liveCounts() });
        }
        return json(404, { error: 'not found' });
      }

      const f = path.match(/^\/api\/events\/([\w.-]+)\/files\/(events\.jsonl|summary\.json)$/);
      if (f && req.method === 'GET') {
        if (!EVENT_ID_RE.test(f[1]!)) return json(404, { error: 'not found' });
        const who = await this.principal(req, false);
        if (!who) return json(401, { error: 'admin token or the organizer\'s token required' });
        if (!this.owns(who, this.ownerOf(f[1]!))) return json(404, { error: 'not found' });
        const file = join(this.cfg.base.runsDir, f[1]!, f[2]!);
        // The log is served plain, also once it is kept gzipped (log-files.ts).
        const stream = f[2] === 'events.jsonl' ? eventLogStream(join(this.cfg.base.runsDir, f[1]!)) : existsSync(file) ? createReadStream(file) : undefined;
        if (!stream) return json(404, { error: 'not found' });
        res.writeHead(200, { 'Content-Type': f[2]!.endsWith('.json') ? 'application/json' : 'application/x-ndjson', 'Cache-Control': 'no-store' });
        stream.on('error', () => res.destroy()).pipe(res);
        return true;
      }
      const m = path.match(/^\/api\/events\/([\w-]+)(\/seats)?$/);
      if (m && req.method === 'DELETE' && !m[2]) {
        const ev = this.events.get(m[1]!);
        const who = await this.principal(req, false);
        if (!who) return json(401, { error: 'admin token or the organizer\'s token required' });
        if (!ev || !this.owns(who, ev.checkpoint?.owner)) return json(404, { error: 'no such live event' });
        const cp = ev.checkpoint!;
        if (cp.status === 'queued') this.cancelQueued(ev, 'canceled');
        else if (cp.status === 'running' && ev.stage !== 'done' && !ev.aborted) {
          // The owner's token (or an admin's on the admin's own table) is the organizer stopping it; otherwise an admin.
          const organizer = who.owner.kind === 'contributor' || cp.owner.kind === 'admin';
          this.stop(ev, 'canceled', organizer ? 'The event was canceled by its organizer.' : 'The event was stopped by an admin.', organizer ? 'organizer' : 'admin');
        }
        else return json(409, { error: `the event is already ${cp.status}` });
        return json(200, this.summary(ev));
      }
      if (m && req.method === 'GET') {
        const ev = this.events.get(m[1]!);
        if (m[2]) {
          const who = await this.principal(req, false);
          if (!who) return json(401, { error: 'admin token or the organizer\'s token required' });
          if (!ev || !this.owns(who, ev.checkpoint?.owner ?? (who.owner.kind === 'admin' ? { kind: 'admin' } : undefined))) return json(404, { error: 'no such event' });
          return json(200, this.seatUrls(ev));
        }
        if (isTakenDown(m[1]!)) return json(404, { error: 'no such event' });
        if (!ev && EVENT_ID_RE.test(m[1]!)) {
          const disk = this.diskSummary(m[1]!);
          if (disk) return json(200, disk);
        }
        if (!ev) return json(404, { error: 'no such event' });
        return json(200, await this.summaryFor(req, ev));
      }
    } catch (err) {
      if (err instanceof HttpError) return json(err.status, { error: err.message }, err.retryAfterS ? { 'Retry-After': String(err.retryAfterS) } : {});
      console.error(`${req.method} ${loggablePath(path)}: ${String((err as Error)?.stack ?? err)}`);
      return json(500, { error: 'internal error' });
    }
    return false;
  };
}

function bearer(req: IncomingMessage): string {
  return (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '').trim();
}

function tokenMatches(req: IncomingMessage, want: string): boolean {
  const got = bearer(req);
  if (!want || !got) return false;
  const a = Buffer.from(want);
  const b = Buffer.from(got);
  return a.length === b.length && timingSafeEqual(a, b);
}
