/**
 * The matchmaking lobby (docs/LOBBY.md): contributors queue 1–4 agent seats for one set of conditions; when 8 seats
 * are present, their holders get a ready check; confirmed tables fire as 8-seat events on this Director.
 *
 * This module is the state machine and the read models. It does no HTTP and no event creation itself: the server
 * (lobby-http.ts) passes requests in and supplies hooks (fire a table, is the Director draining, event status).
 * The clock is passed in, so every rule is unit-tested (lobby.test.ts).
 *
 * Why the Director owns the lobby (not the Hub): a lobby is a scheduler of live tables, and tables live on a
 * Director. Firing a table is then a local call (admission, seat tokens, checkpoint), holders' long-polls end at
 * the process that fires, and draining/restarts reuse the Director's own durability. The Hub stays the source of
 * truth for results only. With several workers later, the lobby moves to a coordinator (or the Hub) and fires
 * tables on the least-loaded worker; the API here stays the same.
 *
 * Persistence: one private JSON file (`<RUNS_DIR>/.lobby/state.json`, mode 600, atomic writes: temp file, then
 * rename), written at most once a second after changes (asynchronously, off the request path) and synchronously on
 * shutdown. Tickets are stored as sha256 hashes only. The state stays small (LOB-1): ended entries and their tickets
 * are dropped after a short grace (seated ones after a day), joins are rate-limited per contributor, and the number
 * of waiting entries has a global cap.
 *
 * Quotas (LOB-2): the server's `quota` hook says whether a contributor may be seated now (their lobby quotas, separate from Private Tables,
 * count lobby tables) and refuses joins once their daily quota is spent. Visibility (LOB-3): the Hub's leaderboard
 * setting wins over the lobby's show choice (applyVisibility, and the join's `visibility`).
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { BENCH_COMMAND } from './bench-command.js';
import { BEST_OF, bestOfProblem, BO1_REMOVED } from './best-of.js';
import { writePrivateJson } from './durable.js';
import type { ManaMode } from './game.js';
import type { KnowledgeLevel } from './knowledge.js';
import { displayOf, identityOf, type SeatIdentity } from './seat-identity.js';
import { neutralSeatName } from './seat-names.js';
import { parseContextPolicy, type ContextPolicy } from './context-policy.js';
import { GAMES_PER_MATCH, ratedGamesOf, ratedMatches, ratedMatchesText, type RatedMatches } from './rated-estimate.js';

// ---------------------------------------------------------------------------
// Configuration

export interface LobbyConfig {
  seatsPerTable: number;
  /** Most seats of one contributor at one public table (LOBBY_MAX_SEATS_PER_CONTRIBUTOR). */
  maxSeatsPerContributor: number;
  /** Most active entries of one contributor across all queues (LOBBY_MAX_ENTRIES). */
  maxEntries: number;
  /** Seats per join request. */
  maxSeatsPerJoin: number;
  /** Ready-check window (LOBBY_READY_S). */
  readyWindowMs: number;
  /** An entry counts toward filling a table only if its ticket was polled this recently (LOBBY_PRESENCE_S). */
  presenceMs: number;
  /** Entries expire this long after joining (LOBBY_ENTRY_TTL_HOURS). */
  entryTtlMs: number;
  /** Below this reliability, over at least lowReliabilityMinSeats seats: queued last, one entry at a time. */
  lowReliability: number;
  lowReliabilityMinSeats: number;
  /** Missed ready checks within missWindowMs that trigger a cooldown of missCooldownMs. */
  missLimit: number;
  missWindowMs: number;
  missCooldownMs: number;
  /** Fired tables kept in the state (recent lists, contributor pages). */
  keepFired: number;
  /** Joins per contributor per rolling hour (LOBBY_MAX_JOINS_PER_HOUR; LOB-1). */
  maxJoinsPerHour: number;
  /** Waiting entries across the lobby; beyond it joins get 503 (LOBBY_MAX_ACTIVE_ENTRIES; LOB-1). */
  maxActiveEntries: number;
  /** Left, expired and dropped entries (and tickets with nothing else) are forgotten this long after they end (LOB-1). */
  tombstoneMs: number;
  /** Seated entries are kept this long (the holder's tables list), then forgotten. */
  seatedKeepMs: number;
  /** State writes are batched: at most one per this interval (LOB-1). */
  saveDelayMs: number;
  /** Scripted test seats in public queues (LOBBY_ALLOW_SCRIPT=1, development only; LOB-4). */
  allowScript: boolean;
  /**
   * Most seats of one setup (harness + model + effort) at a forming table (LOBBY_MAX_SAME_SETUP; docs/LOBBY.md §10).
   * At half the table or fewer, most matches are between different setups (a 4+4 table rates about 10.5 of 12 matches
   * under Swiss v3; docs/LOBBY.md §10).
   * Entries over it keep their place and go to the next table.
   */
  maxSameSetup: number;
  /**
   * An entry held back by maxSameSetup this long (LOBBY_SAME_SETUP_WAIT_MIN) may take a seat anyway, as long as the
   * table keeps at least two setups (a lobby table that could rate nothing never forms).
   */
  sameSetupWaitMs: number;
}

export const DEFAULT_LOBBY: LobbyConfig = {
  seatsPerTable: 8, maxSeatsPerContributor: 4, maxEntries: 8, maxSeatsPerJoin: 4,
  readyWindowMs: 60_000, presenceMs: 120_000, entryTtlMs: 24 * 3600_000,
  lowReliability: 0.7, lowReliabilityMinSeats: 5, missLimit: 3, missWindowMs: 24 * 3600_000, missCooldownMs: 3600_000,
  keepFired: 500, maxJoinsPerHour: 20, maxActiveEntries: 2_000, tombstoneMs: 10 * 60_000, seatedKeepMs: 24 * 3600_000, saveDelayMs: 1_000,
  allowScript: false, maxSameSetup: 4, sameSetupWaitMs: 60 * 60_000,
};

/**
 * Matches between different setups a 3-round Swiss of these setup counts rates: the real pairing (pairings.ts, the
 * current version) over a fixed set of simulated pods, cached per composition (rated-estimate.ts, the same estimate
 * setup shows: scripts/bench/mix.ts). Seats not in `counts` (a table still filling) count as new setups, one seat each.
 * `rated` is the median over the pods; 4 + 4 rates about 10 of 12 matches, 6 + 2 about 6, 7 + 1 3.
 */
export function ratedMatchesFor(counts: number[], seats: number, rounds = 3): RatedMatches {
  const filled = counts.reduce((s, c) => s + c, 0);
  return ratedMatches([...counts, ...Array<number>(Math.max(0, seats - filled)).fill(1)], 0, rounds);
}

// ---------------------------------------------------------------------------
// Queues

export interface QueueSpec {
  set: string;
  knowledge: KnowledgeLevel;
  mana: ManaMode;
}

/**
 * `fra-primer-manual` (knowledge `primer+stats` is written `primer-stats`). Every queue plays best of 3 with
 * sideboarding (best-of.ts), so the best-of is not part of the key.
 */
export function queueKey(q: QueueSpec): string {
  return `${q.set.toLowerCase()}-${q.knowledge.replace('+', '-')}-${q.mana}`;
}

/**
 * A queue key, or undefined. Legacy keys ending in `-bo3` (old invite links, featured lists, schedules and state
 * files) parse to the same queue; `-bo1` and other best-ofs don't (queueKeyProblem says why).
 */
export function parseQueueKey(key: string): QueueSpec | undefined {
  const m = /^([a-z0-9]{2,8})-(none|primer|primer-stats)-(manual|auto)(?:-bo3)?$/.exec(String(key ?? '').toLowerCase());
  if (!m) return undefined;
  return { set: m[1]!, knowledge: m[2]!.replace('primer-stats', 'primer+stats') as KnowledgeLevel, mana: m[3] as ManaMode };
}

/** The current form of a queue key (`fra-primer-manual-bo3` becomes `fra-primer-manual`), or undefined. */
export function normalizeQueueKey(key: string): string | undefined {
  const q = parseQueueKey(key);
  return q && queueKey(q);
}

/** Why a key isn't a queue key, or undefined when it is. */
export function queueKeyProblem(key: string): string | undefined {
  if (parseQueueKey(key)) return undefined;
  const bo = /-bo(\d+)$/.exec(String(key ?? '').toLowerCase());
  if (bo) return bestOfProblem(bo[1]) ?? `"${String(key).slice(0, 40)}" isn't a queue key: give one like fra-primer-manual.`;
  return `"${String(key ?? '').slice(0, 40)}" isn't a queue key: give one like fra-primer-manual.`;
}

// ---------------------------------------------------------------------------
// Schedules

export interface Schedule {
  id: string;
  name: string;
  queue: string;
  /** Every week at this UTC day and time. */
  weekly?: { day: string; time: string };
  /** Once, at this time. */
  at?: string;
  /** Sign-ups open this long before the start (default 48). */
  signup_hours?: number;
  /** After the start, the table fires whenever 8 are present, for this long (default 120). */
  window_minutes?: number;
}

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

export interface Occurrence {
  schedule: Schedule;
  id: string;
  starts_at: number;
  signup_opens_at: number;
  closes_at: number;
  state: 'upcoming' | 'signup' | 'open' | 'closed';
}

/** The current occurrence of a schedule: the one whose window contains `now`, else the next one (or the last, for one-offs). */
export function occurrence(s: Schedule, now: number): Occurrence | undefined {
  const window = (s.window_minutes ?? 120) * 60_000;
  const signup = (s.signup_hours ?? 48) * 3600_000;
  let start: number;
  if (s.weekly) {
    const day = DAYS.indexOf(s.weekly.day.toLowerCase().slice(0, 3));
    const [hh, mm] = s.weekly.time.split(':').map(Number) as [number, number];
    const d = new Date(now);
    const back = (d.getUTCDay() - day + 7) % 7;
    start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - back, hh, mm);
    if (start > now) start -= 7 * 86_400_000;
    if (now >= start + window) start += 7 * 86_400_000;
  } else if (s.at) {
    start = Date.parse(s.at);
    if (!Number.isFinite(start)) return undefined;
  } else return undefined;
  const ymd = new Date(start).toISOString().slice(0, 10).replace(/-/g, '');
  const state = now < start - signup ? 'upcoming' : now < start ? 'signup' : now < start + window ? 'open' : 'closed';
  return { schedule: s, id: `${s.id}-${ymd}`, starts_at: start, signup_opens_at: start - signup, closes_at: start + window, state };
}

/**
 * The LOBBY_CONFIG file at start (server.ts): it seeds a lobby with no state yet (`seed`, the default), or replaces the
 * featured queues and schedules at every start (`always`, the hosted stack's deploy/lobby.json, so the committed file is
 * what runs; an admin PUT lasts until the next start). Only `featured` and `schedules` are read. An invalid file changes
 * nothing and says why.
 */
export function applyStartConfig(lobby: Lobby, file: { featured?: string[]; schedules?: Schedule[] }, mode: 'seed' | 'always', fresh: boolean, now: number): { applied: boolean; error?: string } {
  if (!fresh && mode !== 'always') return { applied: false };
  try {
    lobby.setConfig({ featured: file.featured ?? [], schedules: file.schedules ?? [] }, now);
    return { applied: true };
  } catch (err) {
    return { applied: false, error: String((err as Error).message) };
  }
}

/** Problems with a lobby config (featured queues and schedules), or [] when it's valid. */
export function configProblems(c: { featured?: unknown; schedules?: unknown }): string[] {
  const out: string[] = [];
  if (c.featured != null && !Array.isArray(c.featured)) out.push('featured must be a list of queue keys like fra-primer-manual');
  for (const k of Array.isArray(c.featured) ? c.featured : []) {
    const problem = queueKeyProblem(String(k));
    if (problem) out.push(`featured: ${problem}`);
  }
  if (c.schedules != null && !Array.isArray(c.schedules)) out.push('schedules must be a list');
  const ids = new Set<string>();
  for (const s of (Array.isArray(c.schedules) ? c.schedules : []) as Schedule[]) {
    if (!s || typeof s.id !== 'string' || !/^[a-z0-9][a-z0-9-]{1,40}$/.test(s.id)) out.push(`schedule id must be 2–41 lowercase letters, digits or dashes (got ${JSON.stringify(s?.id)})`);
    else if (ids.has(s.id)) out.push(`duplicate schedule id ${s.id}`);
    else ids.add(s.id);
    if (typeof s?.name !== 'string' || !s.name.trim() || s.name.length > 80) out.push(`schedule ${s?.id}: name (1–80 characters) required`);
    const queueProblem = queueKeyProblem(String(s?.queue));
    if (queueProblem) out.push(`schedule ${s?.id}: ${queueProblem}`);
    const weekly = s?.weekly && typeof s.weekly === 'object' && DAYS.includes(String(s.weekly.day).toLowerCase().slice(0, 3)) && /^([01]\d|2[0-3]):[0-5]\d$/.test(String(s.weekly.time));
    const at = typeof s?.at === 'string' && Number.isFinite(Date.parse(s.at));
    if (!weekly && !at) out.push(`schedule ${s?.id}: give "weekly": {"day": "thu", "time": "18:00"} (UTC) or "at": an ISO time`);
    for (const [k, max] of [['signup_hours', 24 * 14], ['window_minutes', 24 * 60]] as const) {
      const v = s?.[k];
      if (v != null && (!Number.isFinite(v) || v < 0 || v > max)) out.push(`schedule ${s?.id}: ${k} must be 0–${max}`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// State

export interface Contributor {
  id: number;
  handle: string;
}

export type EntryStatus = 'waiting' | 'ready_check' | 'confirmed' | 'seated' | 'left' | 'expired' | 'dropped';
const ACTIVE: EntryStatus[] = ['waiting', 'ready_check', 'confirmed'];

export interface Entry {
  id: string;
  ticket: string;
  queue: string;
  /** Scheduled occurrence this entry signed up for (cleared when the occurrence closes: it joins the open queue). */
  schedule?: { id: string; occurrence: string; starts_at: number; closes_at: number };
  contributor: Contributor;
  seat: SeatIdentity;
  /**
   * The seat's declared context policy (context-policy.ts): its launcher starts a fresh harness session per game or
   * match. A launch condition, not identity: it doesn't split queues, and only the holder (and event_start) sees it.
   */
  context_policy?: ContextPolicy;
  /** The contributor's lobby quotas from the Hub at join time (null fields: the Director's defaults). */
  quotas?: { concurrent?: number; daily?: number };
  joined_at: number;
  expires_at: number;
  status: EntryStatus;
  table?: string;
  event?: string;
  seat_name?: string;
  ended_at?: number;
}

export interface Ticket {
  hash: string;
  contributor_id: number;
  created_at: number;
  last_seen: number;
  /** Something the holder should know (a table that couldn't start, a dropped ready check). */
  notice?: string;
}

export interface Forming {
  id: string;
  queue: string;
  occurrence?: string;
  entries: string[];
  /** Tickets (hashes) that confirmed. */
  confirmed: string[];
  deadline: number;
  created_at: number;
  firing?: boolean;
}

export interface FiredSeat {
  seat_name: string;
  entry?: string;
  contributor_id: number;
  seat: SeatIdentity | null;
}

export interface Fired {
  id: string;
  kind: 'lobby' | 'private';
  queue: string | null;
  occurrence?: string;
  event_id: string;
  fired_at: number;
  seats: FiredSeat[];
  stage?: 'done' | 'aborted';
  ended_at?: number;
  /** A Private Table created with the admin token (maintainer runs): listed, never counted as contribution. */
  organizer?: 'admin';
}

export interface ContributorStats {
  handle: string;
  /** The lobby choice (`--hide-handle`); the Hub's setting (`hub`) wins over it. */
  show: boolean;
  /** The contributor's leaderboard setting on the Hub (LOB-3): 'hidden' or 'public' wins; null/absent follows `show`. */
  hub?: 'public' | 'hidden' | null;
  tables: number;
  seats: number;
  finished: number;
  abandoned: number;
  games: number;
  models: Record<string, number>;
  first_seen: number;
  last_played?: number;
  misses: number[];
  cooldown_until?: number;
}

export interface ModelStats {
  seats: number;
  finished: number;
  abandoned: number;
  games: number;
  tables: number;
  backers: Record<string, number>;
  harnesses: Record<string, number>;
  last_played?: number;
}

export interface LobbyState {
  version: 1;
  rev: number;
  entries: Entry[];
  tickets: Ticket[];
  forming: Forming[];
  fired: Fired[];
  stats: { contributors: Record<string, ContributorStats>; models: Record<string, ModelStats> };
  config: { featured: string[]; schedules: Schedule[] };
}

export const emptyState = (): LobbyState => ({
  version: 1, rev: 0, entries: [], tickets: [], forming: [], fired: [], stats: { contributors: {}, models: {} }, config: { featured: [], schedules: [] },
});

export interface LobbyStore {
  load(): LobbyState | undefined;
  save(state: LobbyState): void;
  /** Optional asynchronous save of the serialized state (FileLobbyStore); `isCurrent` false: a newer save won. */
  saveAsync?(text: string, isCurrent: () => boolean): Promise<void>;
}

/** The private state file (mode 600, atomic writes). */
export class FileLobbyStore implements LobbyStore {
  constructor(readonly file: string) {}
  load(): LobbyState | undefined {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    if (!existsSync(this.file)) return undefined;
    try {
      const s = JSON.parse(readFileSync(this.file, 'utf8')) as LobbyState;
      return s?.version === 1 ? s : undefined;
    } catch (err) {
      console.error(`lobby state ${this.file} unreadable: ${String((err as Error).message)}`);
      return undefined;
    }
  }
  save(state: LobbyState): void {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    writePrivateJson(this.file, state);
  }
  /**
   * The same, off the event loop's critical path: the serialized text is written to a unique temp file
   * asynchronously, then renamed into place (synchronously, so `isCurrent` and the rename can't interleave with a
   * newer synchronous save). Skipped when `isCurrent()` says a newer state was saved meanwhile.
   */
  async saveAsync(text: string, isCurrent: () => boolean): Promise<void> {
    const tmp = `${this.file}.tmp-${process.pid}-${randomBytes(3).toString('hex')}`;
    try {
      await writeFile(tmp, text, { mode: 0o600 });
      if (isCurrent()) renameSync(tmp, this.file);
    } finally {
      rmSync(tmp, { force: true }); // left over when skipped or failed
    }
  }
}

export class MemoryLobbyStore implements LobbyStore {
  state?: LobbyState;
  load() {
    return this.state ? (JSON.parse(JSON.stringify(this.state)) as LobbyState) : undefined;
  }
  save(s: LobbyState) {
    this.state = JSON.parse(JSON.stringify(s));
  }
}

// ---------------------------------------------------------------------------
// Hooks the server provides

export interface TableToFire {
  table_id: string;
  queue: QueueSpec & { key: string };
  occurrence?: string;
  schedule?: string;
  seats: Array<{ entry_id: string; seat_name: string; contributor: Contributor; show_handle: boolean; seat: SeatIdentity; context_policy?: ContextPolicy }>;
}

/** A contributor's lobby quota as the server sees it (admission.ts quotaState; separate from Private Tables). */
export interface QuotaState {
  /** Room for one more table now (concurrent quota), counting `pending` tables still forming. */
  seatable: boolean;
  /** Set once the daily quota is spent: joining is refused with this reason. */
  refuse?: string;
  retryAfterS?: number;
}

export interface LobbyHooks {
  /** Create the event for a full, confirmed table. Throws when it can't (the table dissolves, places kept). */
  fire(t: TableToFire): Promise<{ event_id: string }>;
  /** The Director is draining for a restart: form and fire nothing. */
  paused(): boolean;
  /** After a restart: the event a table that was firing became, if it was created. */
  recover?(table_id: string): { event_id: string; seats: Record<string, string> } | undefined;
  /**
   * The contributor's lobby quota (LOB-2; separate from Private Tables). `pending`: tables of theirs in a
   * ready check, not yet fired. Without the hook, no quotas apply (tests, a Director without a Hub).
   */
  quota?(contributorId: number, quotas: Entry['quotas'], pending: number, now: number): QuotaState;
}

export class LobbyError extends Error {
  constructor(readonly status: number, message: string, readonly retryAfterS?: number) {
    super(message);
  }
}

const hashTicket = (raw: string) => createHash('sha256').update(raw).digest('hex');
const rid = (p: string) => `${p}-${randomBytes(4).toString('hex')}`;
const iso = (t: number | undefined) => (t == null ? null : new Date(t).toISOString());

/**
 * Seat names inside a fired event. They are neutral (`seat-<random hex>`) and never encode the model, harness or
 * contributor: they appear in logs, the spectator stream and status endpoints that an agent with web tools could
 * read (OBS-1, LOB-5). The model is shown from the seat metadata (event_start.seats), under the spectator rules.
 * `rand-*` marks scripted seats (smoke, never rated). `taken` keeps names unique within a table.
 */
function seatName(seat: SeatIdentity, i: number, taken: Set<string>): string {
  if (seat.test) return `rand-${i}`;
  return neutralSeatName(taken);
}

// ---------------------------------------------------------------------------

export class Lobby {
  state: LobbyState;
  private waiters = new Set<() => void>();
  private saveTimer?: ReturnType<typeof setTimeout>;
  /** Save sequence numbers: the newest started, and the newest on disk (an older async save never overwrites a newer one). */
  private saveSeq = 0;
  private savedSeq = 0;
  private saving = false;
  private saveAgain = false;
  /** Join times per contributor in the last hour (LOB-1). */
  private joins = new Map<number, number[]>();
  private firing = new Set<Promise<void>>();
  /** Pools whose last table couldn't start (e.g. the Director's queue was full): no new ready check before this. */
  private retryAt = new Map<string, number>();

  constructor(readonly cfg: LobbyConfig, private store: LobbyStore, private hooks: LobbyHooks, now = Date.now()) {
    this.state = store.load() ?? emptyState();
    this.restore(now);
    if (this.migrateQueueKeys(now)) this.changed();
  }

  /**
   * State written before queues stopped splitting on best-of (keys like `fra-primer-manual-bo3`): bo3 keys map to
   * the new key (`fra-primer-manual`) everywhere, so waiting seats, featured queues and schedules carry over. Best
   * of 1 was removed: its waiting seats and ready checks end with a notice, its featured queues and schedules are
   * dropped. Fired tables keep the key they played under. Returns whether anything changed.
   */
  private migrateQueueKeys(now: number): boolean {
    let changed = false;
    const removed = (key: string) => !parseQueueKey(key) && /-bo\d+$/.test(key);
    const norm = (key: string) => {
      const k = normalizeQueueKey(key);
      if (k && k !== key) changed = true;
      return k ?? key;
    };
    const notice = `${BO1_REMOVED} Your seats left the queue; join a best-of-3 queue instead (\`${BENCH_COMMAND} lobby list\`).`;
    for (const f of [...this.state.forming]) {
      if (!removed(f.queue)) {
        f.queue = norm(f.queue);
        continue;
      }
      this.state.forming = this.state.forming.filter((x) => x !== f);
      changed = true;
    }
    const tickets = new Set<string>();
    for (const e of this.state.entries) {
      if (!removed(e.queue)) {
        e.queue = norm(e.queue);
        continue;
      }
      if (!ACTIVE.includes(e.status)) continue;
      this.end(e, 'dropped', now);
      tickets.add(e.ticket);
      changed = true;
    }
    for (const t of this.state.tickets) if (tickets.has(t.hash)) t.notice = notice;
    for (const f of this.state.fired) if (f.queue && !removed(f.queue)) f.queue = norm(f.queue);
    const cfg = this.state.config;
    const featured = [...new Set(cfg.featured.filter((k) => !removed(k)).map(norm))];
    if (featured.length !== cfg.featured.length) {
      for (const k of cfg.featured.filter(removed)) console.error(`lobby: featured queue ${k} dropped (${BO1_REMOVED})`);
      changed = true;
    }
    cfg.featured = featured;
    const schedules = cfg.schedules.filter((x) => !removed(String(x.queue)));
    for (const x of cfg.schedules.filter((y) => removed(String(y.queue)))) {
      console.error(`lobby: schedule ${x.id} (${x.queue}) dropped (${BO1_REMOVED})`);
      changed = true;
    }
    cfg.schedules = schedules.map((x) => ({ ...x, queue: norm(x.queue) }));
    return changed;
  }

  /** After a restart: ready checks get a fresh window; holders count as present for a while (they reconnect). */
  private restore(now: number): void {
    for (const t of this.state.tickets) t.last_seen = Math.max(t.last_seen, now);
    for (const f of [...this.state.forming]) {
      if (f.firing) {
        const got = this.hooks.recover?.(f.id);
        if (got) {
          this.finishFire(f, got.event_id, got.seats, now);
          continue;
        }
        f.firing = false;
      }
      f.deadline = now + this.cfg.readyWindowMs;
    }
    this.changed();
  }

  // ----- persistence and change notification

  private changed(): void {
    this.state.rev++;
    for (const w of [...this.waiters]) w();
    this.scheduleSave();
  }

  /** Batch writes: at most one per saveDelayMs, whatever the churn (LOB-1). */
  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      void this.saveNow();
    }, this.cfg.saveDelayMs);
    this.saveTimer.unref?.();
  }

  /** One save, asynchronous when the store can (the file write leaves the event loop); another follows if asked meanwhile. */
  private async saveNow(): Promise<void> {
    if (this.saving) {
      this.saveAgain = true;
      return;
    }
    this.saving = true;
    const seq = ++this.saveSeq;
    try {
      if (this.store.saveAsync) {
        await this.store.saveAsync(JSON.stringify(this.state, null, 1), () => seq > this.savedSeq);
      } else this.store.save(this.state);
      if (seq > this.savedSeq) this.savedSeq = seq;
    } catch (err) {
      console.error(`lobby: could not save state: ${String((err as Error)?.message ?? err)}`);
    } finally {
      this.saving = false;
      if (this.saveAgain) {
        this.saveAgain = false;
        this.scheduleSave();
      }
    }
  }

  /** Save now, synchronously (shutdown, tests). A slower asynchronous save still in flight is then discarded. */
  flush(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    const seq = ++this.saveSeq;
    try {
      this.store.save(this.state);
      this.savedSeq = seq;
    } catch (err) {
      console.error(`lobby: could not save state: ${String((err as Error)?.message ?? err)}`);
    }
  }

  /** Resolves when the state changes past `rev`, or after `ms`. */
  wait(rev: number, ms: number): Promise<void> {
    if (this.state.rev !== rev) return Promise.resolve();
    return new Promise((done) => {
      const finish = () => {
        clearTimeout(timer);
        this.waiters.delete(finish);
        done();
      };
      const timer = setTimeout(finish, ms);
      this.waiters.add(finish);
    });
  }

  /** Wait for tables being fired (tests, shutdown). */
  async settled(): Promise<void> {
    while (this.firing.size) await Promise.all([...this.firing]);
  }

  // ----- lookups

  private ticketOf(raw: string): Ticket | undefined {
    if (typeof raw !== 'string' || !/^[0-9a-f]{32}$/.test(raw)) return undefined;
    const h = hashTicket(raw);
    return this.state.tickets.find((t) => t.hash === h);
  }

  private entry(id: string): Entry | undefined {
    return this.state.entries.find((e) => e.id === id);
  }

  /** Whether a contributor's handle may appear publicly: the Hub's setting wins, else their lobby choice (default shown). */
  shown(contributorId: number | string): boolean {
    const s = this.state.stats.contributors[String(contributorId)];
    if (!s) return true;
    return s.hub === 'hidden' ? false : s.hub === 'public' ? true : s.show;
  }

  /** The Hub's visibility settings (server: read from the Hub every few minutes; LOB-3). Unknown ids are ignored. */
  applyVisibility(v: Record<string, 'public' | 'hidden' | null>): void {
    let dirty = false;
    for (const [id, hub] of Object.entries(v)) {
      const s = this.state.stats.contributors[id];
      if (!s || (s.hub ?? null) === hub) continue;
      s.hub = hub;
      dirty = true;
    }
    if (dirty) this.changed();
  }

  /** One contributor's Hub setting, seen on an authenticated request; their stats row is created if new. */
  noteVisibility(c: Contributor, hub: 'public' | 'hidden' | null, now: number): void {
    const s = this.contributorStats(c, now);
    if ((s.hub ?? null) === hub) return;
    s.hub = hub;
    this.changed();
  }

  /** Contributor ids the lobby knows (for applyVisibility). */
  contributorIds(): number[] {
    return Object.keys(this.state.stats.contributors).map(Number).filter((x) => Number.isSafeInteger(x));
  }

  /** Tables of this contributor in a ready check (not yet firing), other than `except`. */
  private pendingTables(contributorId: number, except?: Forming): number {
    return this.state.forming.filter((f) => f !== except && !f.firing && f.entries.some((id) => this.entry(id)?.contributor.id === contributorId)).length;
  }

  /** May this entry's contributor be seated at a table now (their quota; LOB-2)? */
  private seatable(e: Entry, now: number, except?: Forming): boolean {
    if (!this.hooks.quota) return true;
    return this.hooks.quota(e.contributor.id, e.quotas, this.pendingTables(e.contributor.id, except), now).seatable;
  }

  private contributorStats(c: Contributor, now: number): ContributorStats {
    const k = String(c.id);
    const s = (this.state.stats.contributors[k] ??= { handle: c.handle, show: true, tables: 0, seats: 0, finished: 0, abandoned: 0, games: 0, models: {}, first_seen: now, misses: [] });
    s.handle = c.handle;
    return s;
  }

  reliability(contributorId: number | string): number | null {
    const s = this.state.stats.contributors[String(contributorId)];
    if (!s) return null;
    const n = s.finished + s.abandoned;
    return n >= 3 ? s.finished / n : null;
  }

  private lowTier(contributorId: number): boolean {
    const s = this.state.stats.contributors[String(contributorId)];
    if (!s) return false;
    const n = s.finished + s.abandoned;
    return n >= this.cfg.lowReliabilityMinSeats && s.finished / n < this.cfg.lowReliability;
  }

  private present(e: Entry, now: number): boolean {
    const t = this.state.tickets.find((x) => x.hash === e.ticket);
    return !!t && now - t.last_seen <= this.cfg.presenceMs;
  }

  /** The pool an entry fills tables in: its scheduled occurrence, else its queue. */
  private pool(e: Entry): string {
    return e.schedule ? `@${e.schedule.occurrence}` : e.queue;
  }

  /** Waiting entries of a pool that may be seated now (present, within quota), in priority order (reliable first, then first come). */
  private candidates(pool: string, now: number, except?: Forming): Entry[] {
    return this.state.entries
      .filter((e) => e.status === 'waiting' && this.pool(e) === pool && this.present(e, now) && this.seatable(e, now, except))
      .sort((a, b) => Number(this.lowTier(a.contributor.id)) - Number(this.lowTier(b.contributor.id)) || a.joined_at - b.joined_at || (a.id < b.id ? -1 : 1));
  }

  /**
   * Fill `members` up to a table from the candidates (in priority order): at most maxSeatsPerContributor per
   * contributor and, first, at most maxSameSetup per setup, so the table can rate every match (§10). Then entries held
   * back by the setup cap for sameSetupWaitMs may fill what is left, keeping at least two setups at the table.
   */
  private fill(members: Entry[], candidates: Entry[], now: number): Entry[] {
    const out = [...members];
    const per = new Map<number, number>();
    const same = new Map<string, number>();
    const setup = (e: Entry) => identityOf(e.seat).identity_key;
    for (const e of out) {
      per.set(e.contributor.id, (per.get(e.contributor.id) ?? 0) + 1);
      same.set(setup(e), (same.get(setup(e)) ?? 0) + 1);
    }
    const relaxed = Math.max(this.cfg.maxSameSetup, this.cfg.seatsPerTable - 1);
    const take = (cap: (e: Entry) => number) => {
      for (const e of candidates) {
        if (out.length >= this.cfg.seatsPerTable) break;
        if (out.includes(e)) continue;
        if ((per.get(e.contributor.id) ?? 0) >= this.cfg.maxSeatsPerContributor) continue;
        if ((same.get(setup(e)) ?? 0) >= cap(e)) continue;
        per.set(e.contributor.id, (per.get(e.contributor.id) ?? 0) + 1);
        same.set(setup(e), (same.get(setup(e)) ?? 0) + 1);
        out.push(e);
      }
    };
    take(() => this.cfg.maxSameSetup);
    if (out.length < this.cfg.seatsPerTable) take((e) => (now - e.joined_at >= this.cfg.sameSetupWaitMs ? relaxed : this.cfg.maxSameSetup));
    return out;
  }

  // ----- contributor actions

  join(c: Contributor, opts: {
    /** Each seat's identity, with its declared context policy (validated here: absent or "harness" means none). */
    queue?: string; schedule?: string; seats: Array<SeatIdentity & { context_policy?: unknown }>; showHandle?: boolean;
    /** The Hub's leaderboard setting from the token introspection (LOB-3). */
    visibility?: 'public' | 'hidden' | null;
    /** The contributor's lobby quotas from the Hub. */
    quotas?: Entry['quotas'];
  }, now: number): { ticket: string; entries: Entry[] } {
    if (this.hooks.paused()) throw new LobbyError(503, 'The lobby is paused while the server restarts. Try again in a few minutes.', 120);
    if (!opts.seats.length || opts.seats.length > this.cfg.maxSeatsPerJoin) throw new LobbyError(400, `Join with 1–${this.cfg.maxSeatsPerJoin} seats.`);
    const policies = opts.seats.map((x, i) => {
      const p = parseContextPolicy(x.context_policy);
      if ('error' in p) throw new LobbyError(400, `Seat ${i + 1}: ${p.error}.`);
      return p.policy;
    });
    // Scripted seats would spend other contributors' tokens on games that are never rated (LOB-4).
    if (!this.cfg.allowScript && opts.seats.some((x) => x.test)) {
      throw new LobbyError(400, 'Scripted test seats can\'t join public lobby queues: they would spend other players\' tokens on games that are never rated. Use a Private Table to test.');
    }
    const recent = (this.joins.get(c.id) ?? []).filter((t) => now - t < 3600_000);
    if (recent.length >= this.cfg.maxJoinsPerHour) {
      throw new LobbyError(429, `Too many joins: at most ${this.cfg.maxJoinsPerHour} an hour. Keep one \`bench lobby join\` running instead of joining again.`, Math.max(1, Math.ceil((recent[0]! + 3600_000 - now) / 1000)));
    }
    if (this.state.entries.filter((e) => ACTIVE.includes(e.status)).length + opts.seats.length > this.cfg.maxActiveEntries) {
      throw new LobbyError(503, 'The lobby is full right now. Try again in a few minutes.', 300);
    }
    const q = this.hooks.quota?.(c.id, opts.quotas, 0, now);
    if (q?.refuse) throw new LobbyError(429, `${q.refuse[0]!.toUpperCase()}${q.refuse.slice(1)}.`, q.retryAfterS);
    let queue: string;
    let sched: Entry['schedule'];
    if (opts.schedule) {
      const s = this.state.config.schedules.find((x) => x.id === opts.schedule);
      const occ = s && occurrence(s, now);
      if (!s || !occ) throw new LobbyError(404, `No scheduled table "${String(opts.schedule).slice(0, 40)}".`);
      if (occ.state === 'upcoming') throw new LobbyError(409, `Sign-ups for ${s.name} open at ${iso(occ.signup_opens_at)}.`, Math.ceil((occ.signup_opens_at - now) / 1000));
      if (occ.state === 'closed') throw new LobbyError(409, `${s.name} has closed. Join the open queue ${s.queue} instead.`);
      queue = s.queue;
      sched = { id: s.id, occurrence: occ.id, starts_at: occ.starts_at, closes_at: occ.closes_at };
    } else {
      if (!opts.queue) throw new LobbyError(400, 'Give a queue key like fra-primer-manual.');
      const problem = queueKeyProblem(opts.queue);
      if (problem) throw new LobbyError(400, problem);
      queue = normalizeQueueKey(opts.queue)!;
    }
    const stats = this.contributorStats(c, now);
    if (stats.cooldown_until && stats.cooldown_until > now) {
      throw new LobbyError(409, `You missed ${this.cfg.missLimit} ready checks in a day, so joining is paused until ${iso(stats.cooldown_until)}. Keep \`bench lobby join\` running while you wait: it confirms for you.`, Math.ceil((stats.cooldown_until - now) / 1000));
    }
    const mine = this.state.entries.filter((e) => e.contributor.id === c.id && ACTIVE.includes(e.status));
    const maxTotal = this.lowTier(c.id) ? 1 : this.cfg.maxEntries;
    if (mine.length + opts.seats.length > maxTotal) {
      throw new LobbyError(409, this.lowTier(c.id)
        ? 'Your recent seats were often abandoned mid-event, so you can hold one lobby seat at a time for now. Finishing events restores the normal limits.'
        : `You can hold at most ${maxTotal} lobby seats at once (you have ${mine.length}). Leave some with \`bench lobby leave\`.`);
    }
    const inPool = mine.filter((e) => e.queue === queue && e.schedule?.occurrence === sched?.occurrence).length;
    if (inPool + opts.seats.length > this.cfg.maxSeatsPerContributor) {
      throw new LobbyError(409, `At most ${this.cfg.maxSeatsPerContributor} of a table's ${this.cfg.seatsPerTable} seats can be yours (you already have ${inPool} in this queue).`);
    }
    if (opts.showHandle != null) stats.show = opts.showHandle;
    if (opts.visibility !== undefined) stats.hub = opts.visibility;
    this.joins.set(c.id, [...recent, now]);
    const raw = randomBytes(16).toString('hex');
    const ticket: Ticket = { hash: hashTicket(raw), contributor_id: c.id, created_at: now, last_seen: now };
    this.state.tickets.push(ticket);
    const entries = opts.seats.map((declared, i) => ({
      id: rid('e'), ticket: ticket.hash, queue, ...(sched ? { schedule: sched } : {}), contributor: { id: c.id, handle: c.handle }, seat: identityOnly(declared),
      ...(policies[i] ? { context_policy: policies[i] } : {}),
      ...(opts.quotas ? { quotas: opts.quotas } : {}), joined_at: now, expires_at: now + this.cfg.entryTtlMs, status: 'waiting' as EntryStatus,
    }));
    this.state.entries.push(...entries);
    this.changed();
    void this.tick(now);
    return { ticket: raw, entries };
  }

  /** A poll or any ticket request: the holder is present. Undefined for an unknown ticket. */
  touch(raw: string, now: number): Ticket | undefined {
    const t = this.ticketOf(raw);
    if (!t) return undefined;
    const wasAway = now - t.last_seen > this.cfg.presenceMs;
    t.last_seen = now;
    if (wasAway) {
      this.changed();
      void this.tick(now);
    }
    return t;
  }

  confirm(raw: string, tableId: string, now: number): void {
    const t = this.touch(raw, now);
    if (!t) throw new LobbyError(404, 'Unknown ticket.');
    const f = this.state.forming.find((x) => x.id === tableId);
    if (!f || f.firing || !f.entries.some((id) => this.entry(id)?.ticket === t.hash)) throw new LobbyError(409, 'That ready check is over.');
    if (!f.confirmed.includes(t.hash)) f.confirmed.push(t.hash);
    for (const id of f.entries) {
      const e = this.entry(id)!;
      if (e.ticket === t.hash) e.status = 'confirmed';
    }
    this.changed();
    if (this.allConfirmed(f)) this.fire(f, now);
  }

  leave(raw: string, entryId: string | undefined, now: number): void {
    const t = this.touch(raw, now);
    if (!t) throw new LobbyError(404, 'Unknown ticket.');
    const mine = this.state.entries.filter((e) => e.ticket === t.hash && (!entryId || e.id === entryId));
    if (entryId && !mine.length) throw new LobbyError(404, 'No such entry on this ticket.');
    for (const e of mine) this.end(e, 'left', now);
    this.changed();
    void this.tick(now);
  }

  /** Admin moderation: remove one entry. */
  remove(entryId: string, now: number): boolean {
    const e = this.entry(entryId);
    if (!e || !ACTIVE.includes(e.status)) return false;
    this.end(e, 'left', now);
    this.changed();
    void this.tick(now);
    return true;
  }

  /** End an active entry (left, expired, dropped); it also leaves any forming table. */
  private end(e: Entry, status: 'left' | 'expired' | 'dropped', now: number): void {
    if (!ACTIVE.includes(e.status)) return;
    for (const f of this.state.forming) {
      if (f.firing) continue;
      f.entries = f.entries.filter((id) => id !== e.id);
    }
    e.status = status;
    e.table = undefined;
    e.ended_at = now;
  }

  // ----- the state machine

  /**
   * Expire entries, close scheduled occurrences, settle ready checks that ran out (drop, backfill, re-check),
   * and form new tables wherever 8 seats are present. Call it every few seconds and after every change.
   */
  async tick(now: number): Promise<void> {
    let dirty = false;
    // Expiry, and scheduled occurrences that closed: their entries join the open queue, keeping their place.
    for (const e of this.state.entries) {
      if ((e.status === 'waiting') && e.expires_at <= now) {
        this.end(e, 'expired', now);
        dirty = true;
      }
      if (e.schedule && e.status === 'waiting' && e.schedule.closes_at <= now) {
        delete e.schedule;
        dirty = true;
      }
    }
    // Forget ended entries soon (seated ones after a day: their holders' tables list), then tickets with nothing
    // left on them; keep the fired list bounded. Join/leave churn leaves nothing behind for long (LOB-1).
    const tomb = now - this.cfg.tombstoneMs;
    const seatedKeep = now - this.cfg.seatedKeepMs;
    const before = this.state.entries.length;
    this.state.entries = this.state.entries.filter((e) => ACTIVE.includes(e.status) || (e.ended_at ?? now) > (e.status === 'seated' ? seatedKeep : tomb));
    if (this.state.entries.length !== before) dirty = true;
    const live = new Set(this.state.entries.map((e) => e.ticket));
    const tickets = this.state.tickets.length;
    this.state.tickets = this.state.tickets.filter((t) => live.has(t.hash) || t.created_at > tomb);
    if (this.state.tickets.length !== tickets) dirty = true;
    for (const [id, ts] of this.joins) {
      const left = ts.filter((t) => now - t < 3600_000);
      if (left.length) this.joins.set(id, left);
      else this.joins.delete(id);
    }
    if (this.state.fired.length > this.cfg.keepFired) this.state.fired = this.state.fired.slice(-this.cfg.keepFired);

    if (this.hooks.paused()) {
      // Draining for a restart: nothing forms or fires; tables in a ready check dissolve, places kept.
      for (const f of [...this.state.forming]) if (!f.firing) this.dissolve(f, 'The server is restarting, so this ready check was called off. Your place in the queue is kept.');
      if (dirty || this.state.forming.length) this.changed();
      return;
    }

    for (const f of [...this.state.forming]) {
      if (f.firing) continue;
      if (f.deadline > now) {
        // Someone left during the ready check: backfill at once (the newcomers get a full window).
        if (f.entries.length < this.cfg.seatsPerTable) {
          const pool = f.occurrence ? `@${f.occurrence}` : f.queue;
          const filled = this.fill(f.entries.map((id) => this.entry(id)!), this.candidates(pool, now, f), now);
          if (filled.length === this.cfg.seatsPerTable) {
            for (const e of filled) {
              if (e.status !== 'waiting') continue;
              e.status = 'ready_check';
              e.table = f.id;
            }
            f.entries = filled.map((e) => e.id);
            f.deadline = Math.max(f.deadline, now + this.cfg.readyWindowMs);
            dirty = true;
          }
        }
        continue;
      }
      dirty = true;
      // Tickets that didn't confirm leave the queue with all their entries.
      const missed = new Set(f.entries.map((id) => this.entry(id)!).filter((e) => !f.confirmed.includes(e.ticket)).map((e) => e.ticket));
      for (const h of missed) this.missed(h, now);
      const members = f.entries.map((id) => this.entry(id)!).filter((e) => e && f.confirmed.includes(e.ticket));
      const pool = f.occurrence ? `@${f.occurrence}` : f.queue;
      const filled = this.fill(members, this.candidates(pool, now, f), now);
      if (filled.length < this.cfg.seatsPerTable) {
        this.dissolve(f, 'Not enough seats confirmed, so the table was called off. You keep your place in the queue.');
        continue;
      }
      // Backfilled: the newcomers get a fresh ready check.
      f.entries = filled.map((e) => e.id);
      for (const e of filled) {
        if (e.status !== 'waiting') continue;
        e.status = 'ready_check';
        e.table = f.id;
      }
      f.deadline = now + this.cfg.readyWindowMs;
      if (this.allConfirmed(f)) this.fire(f, now);
    }

    // New tables wherever 8 present seats can be seated together.
    const pools = new Set(this.state.entries.filter((e) => e.status === 'waiting').map((e) => this.pool(e)));
    for (const pool of pools) {
      const sample = this.state.entries.find((e) => e.status === 'waiting' && this.pool(e) === pool)!;
      if (sample.schedule && now < sample.schedule.starts_at) continue;
      if ((this.retryAt.get(pool) ?? 0) > now) continue;
      for (;;) {
        const table = this.fill([], this.candidates(pool, now), now);
        if (table.length < this.cfg.seatsPerTable) break;
        const f: Forming = {
          id: rid('t'), queue: sample.queue, ...(sample.schedule ? { occurrence: sample.schedule.occurrence } : {}),
          entries: table.map((e) => e.id), confirmed: [], deadline: now + this.cfg.readyWindowMs, created_at: now,
        };
        for (const e of table) {
          e.status = 'ready_check';
          e.table = f.id;
        }
        this.state.forming.push(f);
        dirty = true;
      }
    }
    if (dirty) this.changed();
    await this.settled();
  }

  private allConfirmed(f: Forming): boolean {
    return f.entries.length === this.cfg.seatsPerTable && f.entries.every((id) => f.confirmed.includes(this.entry(id)!.ticket));
  }

  private missed(ticketHash: string, now: number): void {
    const t = this.state.tickets.find((x) => x.hash === ticketHash);
    const entries = this.state.entries.filter((e) => e.ticket === ticketHash && ACTIVE.includes(e.status));
    for (const e of entries) this.end(e, 'dropped', now);
    if (t) t.notice = 'You missed a ready check, so your seats left the queue. Join again when you are back (keep `bench lobby join` running: it confirms for you).';
    const c = entries[0]?.contributor;
    if (!c) return;
    const s = this.contributorStats(c, now);
    s.misses = [...s.misses.filter((x) => now - x < this.cfg.missWindowMs), now];
    if (s.misses.length >= this.cfg.missLimit) s.cooldown_until = now + this.cfg.missCooldownMs;
  }

  /** Call a table off: its entries wait again, keeping their place (joined_at). */
  private dissolve(f: Forming, notice: string): void {
    this.state.forming = this.state.forming.filter((x) => x !== f);
    const tickets = new Set<string>();
    for (const id of f.entries) {
      const e = this.entry(id);
      if (!e || !ACTIVE.includes(e.status)) continue;
      e.status = 'waiting';
      e.table = undefined;
      tickets.add(e.ticket);
    }
    for (const t of this.state.tickets) if (tickets.has(t.hash)) t.notice = notice;
  }

  private fire(f: Forming, now: number): void {
    f.firing = true;
    const entries = f.entries.map((id) => this.entry(id)!);
    const spec = parseQueueKey(f.queue)!;
    const sched = entries.find((e) => e.schedule)?.schedule;
    const names = new Set<string>();
    const table: TableToFire = {
      table_id: f.id, queue: { ...spec, key: f.queue }, ...(f.occurrence ? { occurrence: f.occurrence, schedule: sched?.id } : {}),
      seats: entries.map((e, i) => ({
        entry_id: e.id, seat_name: seatName(e.seat, i + 1, names), contributor: e.contributor,
        show_handle: this.shown(e.contributor.id), seat: e.seat, ...(e.context_policy ? { context_policy: e.context_policy } : {}),
      })),
    };
    this.changed();
    const p = this.hooks.fire(table).then(
      ({ event_id }) => this.finishFire(f, event_id, Object.fromEntries(table.seats.map((s) => [s.entry_id, s.seat_name])), now),
      (err) => {
        console.error(`lobby: table ${f.id} could not start: ${String((err as Error)?.message ?? err)}`);
        f.firing = false;
        this.retryAt.set(f.occurrence ? `@${f.occurrence}` : f.queue, now + 60_000);
        this.dissolve(f, `Your table could not start (${String((err as Error)?.message ?? err).slice(0, 200)}). You keep your place in the queue.`);
        this.changed();
      },
    ).finally(() => this.firing.delete(p));
    this.firing.add(p);
  }

  /** A table's event exists: seat its entries and count the contribution. `seats`: entry id → seat name. */
  private finishFire(f: Forming, eventId: string, seats: Record<string, string>, now: number): void {
    this.state.forming = this.state.forming.filter((x) => x !== f);
    const entries = f.entries.map((id) => this.entry(id)!).filter(Boolean);
    for (const e of entries) {
      e.status = 'seated';
      e.table = f.id;
      e.event = eventId;
      e.seat_name = seats[e.id];
      e.ended_at = now;
    }
    const fired: Fired = {
      id: f.id, kind: 'lobby', queue: f.queue, ...(f.occurrence ? { occurrence: f.occurrence } : {}), event_id: eventId, fired_at: now,
      seats: entries.map((e) => ({ seat_name: e.seat_name ?? '', entry: e.id, contributor_id: e.contributor.id, seat: e.seat })),
    };
    this.state.fired.push(fired);
    this.countSeats(fired, entries.map((e) => e.contributor), now);
    this.changed();
  }

  /** Contribution stats when a table fires: tables, seats, backers. Scripted test seats count for nothing (LOB-4). */
  private countSeats(fired: Fired, contributors: Contributor[], now: number): void {
    const byId = new Map(contributors.map((c) => [c.id, c]));
    const tableContributors = new Set<number>();
    const tableModels = new Set<string>();
    for (const s of fired.seats) {
      const c = byId.get(s.contributor_id);
      if (!c || s.seat?.test) continue;
      const cs = this.contributorStats(c, now);
      cs.seats++;
      if (!tableContributors.has(c.id)) cs.tables++, tableContributors.add(c.id);
      if (!s.seat) continue;
      cs.models[s.seat.model_id] = (cs.models[s.seat.model_id] ?? 0) + 1;
      const ms = (this.state.stats.models[s.seat.model_id] ??= { seats: 0, finished: 0, abandoned: 0, games: 0, tables: 0, backers: {}, harnesses: {} });
      ms.seats++;
      ms.backers[String(c.id)] = (ms.backers[String(c.id)] ?? 0) + 1;
      ms.harnesses[s.seat.harness_id] = (ms.harnesses[s.seat.harness_id] ?? 0) + 1;
      if (!tableModels.has(s.seat.model_id)) ms.tables++, tableModels.add(s.seat.model_id);
    }
  }

  /** A Private Table was created (all seats one contributor's): it counts in contribution stats and recent tables. */
  notePrivate(eventId: string, c: Contributor, seats: Array<{ seat_name: string; seat: SeatIdentity | null }>, now: number): void {
    if (this.state.fired.some((f) => f.event_id === eventId)) return;
    const fired: Fired = { id: rid('t'), kind: 'private', queue: null, event_id: eventId, fired_at: now, seats: seats.map((s) => ({ ...s, contributor_id: c.id })) };
    this.state.fired.push(fired);
    this.countSeats(fired, [c], now);
    this.changed();
  }

  /**
   * A Private Table created with the admin token: listed in recent tables like any Private Table (docs/LOBBY.md
   * `recent`), but it has no contributor, so it never counts in contribution stats. Tables of scripted seats only
   * (smoke and load tests) aren't listed.
   */
  noteAdminTable(eventId: string, seats: Array<{ seat_name: string; seat: SeatIdentity | null }>, now: number): void {
    if (this.state.fired.some((f) => f.event_id === eventId)) return;
    if (!seats.some((s) => s.seat && !s.seat.test)) return;
    this.state.fired.push({ id: rid('t'), kind: 'private', organizer: 'admin', queue: null, event_id: eventId, fired_at: now, seats: seats.map((s) => ({ ...s, contributor_id: 0 })) });
    this.changed();
  }

  /**
   * A table's event ended. Done: each seat counts as finished, or abandoned when the watchdog forfeited for it;
   * its games count. Aborted (server-side stops): counts for nobody.
   */
  eventFinished(eventId: string, status: 'done' | 'aborted', seats: Record<string, { forfeits: number; games: number }>, now: number): void {
    const f = this.state.fired.find((x) => x.event_id === eventId);
    if (!f || f.stage) return;
    f.stage = status;
    f.ended_at = now;
    if (status === 'done' && f.organizer !== 'admin') {
      for (const s of f.seats) {
        const o = seats[s.seat_name];
        // Scripted seats never count toward reliability or contribution (LOB-4).
        if (!o || s.seat?.test) continue;
        const cs = this.state.stats.contributors[String(s.contributor_id)];
        const ms = s.seat && !s.seat.test ? this.state.stats.models[s.seat.model_id] : undefined;
        for (const x of [cs, ms]) {
          if (!x) continue;
          if (o.forfeits > 0) x.abandoned++;
          else x.finished++;
          x.games += o.games;
          x.last_played = now;
        }
      }
    }
    this.changed();
  }

  // ----- admin

  setConfig(c: { featured?: string[]; schedules?: Schedule[] }, now: number): void {
    const problems = configProblems(c);
    if (problems.length) throw new LobbyError(400, problems.join('; '));
    if (c.featured) this.state.config.featured = [...new Set(c.featured.map((k) => normalizeQueueKey(k)!))];
    if (c.schedules) this.state.config.schedules = c.schedules.map((s) => ({ ...s, queue: normalizeQueueKey(s.queue)!, ...(s.weekly ? { weekly: { day: s.weekly.day.toLowerCase().slice(0, 3), time: s.weekly.time } } : {}) }));
    this.changed();
    void this.tick(now);
  }

  // ----- read models

  /** A ticket whose seats all expired unseated says so (LAUNCH-CHECKLIST C-2), with the command to wait again. */
  private expiredText(entries: Entry[], tables: number): string | undefined {
    const expired = entries.filter((e) => e.status === 'expired');
    if (!expired.length || tables || entries.some((e) => ACTIVE.includes(e.status))) return undefined;
    const hours = Math.round(this.cfg.entryTtlMs / 3600_000);
    const seats = expired.map((e) => `--seat ${e.seat.harness_id}/${e.seat.model_id}/${e.seat.effort}`).join(' ');
    return `Your ${expired.length === 1 ? 'seat' : `${expired.length} seats`} waited ${hours} hours without a full table and left the queue (nothing ran, no tokens were used). To keep waiting, join again: \`${BENCH_COMMAND} lobby join --queue ${expired[0]!.queue} ${seats}\`.`;
  }

  /** The holder's view of a ticket (docs/LOBBY.md §5.2). `tableInfo` adds a fired table's stage and seat URLs. */
  ticketView(raw: string, now: number, ctx: ViewContext): Record<string, unknown> | undefined {
    const t = this.ticketOf(raw);
    if (!t) return undefined;
    const entries = this.state.entries.filter((e) => e.ticket === t.hash);
    const mineIn = (f: Forming) => f.entries.some((id) => this.entry(id)?.ticket === t.hash);
    const forming = this.state.forming.find((f) => !f.firing && mineIn(f) && !f.confirmed.includes(t.hash)) ?? this.state.forming.find((f) => !f.firing && mineIn(f));
    const firing = this.state.forming.find((f) => f.firing && mineIn(f));
    const tables = [...new Set(entries.filter((e) => e.status === 'seated' && e.event).map((e) => e.event!))].map((eventId) => {
      const fired = this.state.fired.find((f) => f.event_id === eventId);
      const mine = entries.filter((e) => e.event === eventId);
      const info = ctx.eventInfo(eventId);
      return {
        table_id: fired?.id ?? mine[0]?.table ?? null, event_id: eventId, stage: info?.stage ?? fired?.stage ?? 'unknown', queue_position: info?.queue_position ?? null,
        seats: Object.fromEntries(mine.map((e) => [e.seat_name!, { entry_id: e.id, url: info?.seatUrl(e.seat_name!) ?? null, harness: e.seat.harness_id, model: e.seat.model_id, effort: e.seat.effort, ...holderPolicy(e) }])),
        status_url: `${ctx.publicUrl}/api/events/${eventId}`, live_url: `${ctx.publicUrl}/api/events/${eventId}/live`,
      };
    });
    const active = entries.filter((e) => ACTIVE.includes(e.status));
    const state = forming && !forming.confirmed.includes(t.hash) ? 'ready_check' : forming ? 'confirmed' : firing ? 'starting'
      : tables.some((x) => !['done', 'aborted'].includes(String(x.stage))) ? 'seated' : active.length ? 'waiting' : tables.length ? 'seated' : 'done';
    const q = active[0] ?? entries[0];
    const qv = q ? this.queueCounts(this.pool(q), now) : undefined;
    const paused = this.hooks.paused();
    const left = forming ? Math.max(0, Math.ceil((forming.deadline - now) / 1000)) : 0;
    const message = paused ? 'The server is restarting. Your place in the queue is kept; keep this running.'
      : state === 'ready_check' ? `Your table is full. Confirm within ${left} s to take your seat.`
      : state === 'confirmed' ? `Confirmed. Waiting for the other players (${forming!.confirmed.length} of ${new Set(forming!.entries.map((id) => this.entry(id)!.ticket)).size} confirmed).`
      : state === 'starting' ? 'Your table is starting.'
      : state === 'seated' ? 'Your table is playing. Your seats are listed under tables.'
      : state === 'waiting' && qv ? (q!.schedule && now < q!.schedule.starts_at
        ? `Signed up for the scheduled table at ${iso(q!.schedule.starts_at)}. Keep this running from then on.`
        : !this.seatable(q!, now)
          ? 'Your lobby limit is in use (lobby tables of yours are running; Private Tables are counted separately). Your seats keep their place and join a table once one ends.'
          : `Table ${qv.filled}/${this.cfg.seatsPerTable}, waiting for ${qv.needed} more.`)
      : this.expiredText(entries, tables.length) ?? 'Nothing left on this ticket.';
    return {
      api_version: 1, rev: this.state.rev, state, paused, message, ...(t.notice ? { notice: t.notice } : {}),
      queue: q ? { key: q.queue, ...(q.schedule ? { schedule: q.schedule.id, starts_at: iso(q.schedule.starts_at) } : {}), seats_filled: qv?.filled ?? 0, seats_needed: qv?.needed ?? 0 } : null,
      ready_check: forming ? { table_id: forming.id, deadline: iso(forming.deadline), confirmed: forming.confirmed.includes(t.hash) } : null,
      entries: entries.map((e) => ({
        entry_id: e.id, status: e.status, table_id: e.table ?? null, position: e.status === 'waiting' ? this.position(e, now) : null, ...seatJson(e.seat), ...holderPolicy(e), expires_at: iso(e.expires_at),
      })),
      tables,
      expires_at: active.length ? iso(Math.max(...active.map((e) => e.expires_at))) : null,
    };
  }

  /** 1-based place of a waiting entry among its pool's waiting entries. */
  private position(e: Entry, now: number): number {
    const pool = this.pool(e);
    const all = this.state.entries.filter((x) => x.status === 'waiting' && this.pool(x) === pool)
      .sort((a, b) => Number(this.lowTier(a.contributor.id)) - Number(this.lowTier(b.contributor.id)) || a.joined_at - b.joined_at || (a.id < b.id ? -1 : 1));
    void now;
    return all.indexOf(e) + 1;
  }

  /** Present waiting seats (0–8) and how many more it takes, counting the per-contributor cap. */
  private queueCounts(pool: string, now: number): { filled: number; needed: number; away: number } {
    const waiting = this.state.entries.filter((e) => e.status === 'waiting' && this.pool(e) === pool);
    const present = waiting.filter((e) => this.present(e, now));
    const formable = this.fill([], present.sort((a, b) => a.joined_at - b.joined_at), now).length;
    return { filled: Math.min(present.length, this.cfg.seatsPerTable), needed: Math.max(0, this.cfg.seatsPerTable - formable), away: waiting.length - present.length };
  }

  /**
   * What a queue's next table needs (§10): the seats it would seat now, how many rated games they can produce, the
   * setups already at the cap (seats of those wait for the next table), and one plain sentence.
   */
  private needs(pool: string, now: number): Record<string, unknown> {
    const candidates = this.state.entries.filter((e) => e.status === 'waiting' && this.pool(e) === pool && this.present(e, now))
      .sort((a, b) => Number(this.lowTier(a.contributor.id)) - Number(this.lowTier(b.contributor.id)) || a.joined_at - b.joined_at || (a.id < b.id ? -1 : 1));
    const table = this.fill([], candidates, now);
    const bySetup = new Map<string, { label: string; seats: number }>();
    for (const e of table) {
      const id = identityOf(e.seat);
      bySetup.set(id.identity_key, { label: id.identity_label, seats: (bySetup.get(id.identity_key)?.seats ?? 0) + 1 });
    }
    const atCap = [...bySetup.entries()].filter(([, v]) => v.seats >= this.cfg.maxSameSetup).map(([k, v]) => ({ identity_key: k, identity_label: v.label, seats: v.seats }));
    const heldBack = candidates.filter((e) => !table.includes(e) && atCap.some((x) => x.identity_key === identityOf(e.seat).identity_key)).length;
    const missing = this.cfg.seatsPerTable - table.length;
    // Rated matches if the table filled now with setups not yet at it (each missing seat a new setup).
    const r = ratedMatchesFor([...bySetup.values()].map((v) => v.seats), this.cfg.seatsPerTable);
    const others = atCap.map((x) => x.identity_label).join(' or ');
    const text = missing <= 0
      ? `Ready to form: ${bySetup.size} setups, ${ratedMatchesText(r)}.`
      : `Needs ${missing} more seat${missing === 1 ? '' : 's'}${atCap.length ? `, any setup other than ${others}` : ''}; then ${ratedMatchesText(r)}.`;
    return {
      seats: table.length, missing: Math.max(0, missing), setups: bySetup.size, max_same_setup: this.cfg.maxSameSetup,
      at_cap: atCap, held_back: heldBack,
      // Rated games and matches if the table filled now with setups not yet at it (each missing seat a new setup).
      rated_games: ratedGamesOf(r), games: Math.round(r.matches * GAMES_PER_MATCH),
      rated_matches: r.rated, matches: r.matches,
      text,
    };
  }

  private seatPublic(e: Entry): Record<string, unknown> {
    return { ...seatJson(e.seat), contributor: this.shown(e.contributor.id) ? e.contributor.handle : null };
  }

  /** One queue (open pool), as GET /api/lobby lists it. */
  queueView(key: string, now: number, ctx: ViewContext): Record<string, unknown> | undefined {
    const spec = parseQueueKey(key);
    if (!spec || !ctx.setName(spec.set)) return undefined;
    key = queueKey(spec);
    const counts = this.queueCounts(key, now);
    const waiting = this.state.entries.filter((e) => e.status === 'waiting' && e.queue === key && !e.schedule)
      .sort((a, b) => a.joined_at - b.joined_at);
    const forming = this.state.forming.filter((f) => f.queue === key && !f.occurrence);
    const inForming = forming.flatMap((f) => f.entries.map((id) => this.entry(id)!)).filter(Boolean);
    const paused = this.hooks.paused();
    return {
      key, set: spec.set.toUpperCase(), set_name: ctx.setName(spec.set), knowledge: spec.knowledge, knowledge_label: KNOWLEDGE_LABEL[spec.knowledge] ?? spec.knowledge,
      // best_of stays in the view for older clients; every queue plays best of 3, so nothing splits on it.
      mana: spec.mana, best_of: BEST_OF, prompt_version: ctx.promptVersion, group: `kn=${spec.knowledge};mana=${spec.mana};prompt=${ctx.promptVersion}`,
      featured: this.state.config.featured.includes(key), schedule: null,
      seats_per_table: this.cfg.seatsPerTable, seats_filled: counts.filled, seats_needed: counts.needed, seats_away: counts.away,
      // §10: what the next table needs (setups at the cap, rated games), additive to api_version 1.
      needs: this.needs(key, now),
      status: paused ? 'paused' : forming.some((f) => !f.firing) ? 'ready_check' : 'waiting',
      oldest_wait_s: waiting.length ? Math.round((now - waiting[0]!.joined_at) / 1000) : 0,
      seats: [
        ...inForming.map((e) => ({ ...this.seatPublic(e), waiting_since: iso(e.joined_at), status: e.status === 'confirmed' ? 'confirmed' : 'ready_check' })),
        ...waiting.filter((e) => this.present(e, now)).map((e) => ({ ...this.seatPublic(e), waiting_since: iso(e.joined_at), status: 'waiting' })),
      ],
      forming: forming.map((f) => ({ table_id: f.id, confirmed: f.entries.filter((id) => f.confirmed.includes(this.entry(id)!.ticket)).length, seats: f.entries.length, deadline: iso(f.deadline) })),
      invite_url: `${ctx.siteUrl}/agent-bench/lobby/${key}`,
      join_command: `${BENCH_COMMAND} lobby join --queue ${key} --seat <harness>/<model>/<effort>`,
    };
  }

  scheduleViews(now: number, ctx: ViewContext): Array<Record<string, unknown>> {
    const out: Array<Record<string, unknown> & { starts: number }> = [];
    for (const s of this.state.config.schedules) {
      const o = occurrence(s, now);
      if (!o || (o.state === 'closed' && now - o.closes_at > 24 * 3600_000)) continue;
      const mine = this.state.entries.filter((e) => e.schedule?.occurrence === o.id);
      out.push({
        id: s.id, occurrence: o.id, name: s.name, queue: s.queue, starts_at: iso(o.starts_at), signup_opens_at: iso(o.signup_opens_at), closes_at: iso(o.closes_at),
        state: o.state, rsvps: mine.filter((e) => ACTIVE.includes(e.status) || e.status === 'seated').length,
        seats_present: mine.filter((e) => ACTIVE.includes(e.status) && this.present(e, now)).length,
        tables_fired: this.state.fired.filter((f) => f.occurrence === o.id).length,
        invite_url: `${ctx.siteUrl}/agent-bench/lobby/scheduled/${s.id}`,
        join_command: `${BENCH_COMMAND} lobby join --schedule ${s.id} --seat <harness>/<model>/<effort>`,
        starts: o.starts_at,
      });
    }
    return out.sort((a, b) => a.starts - b.starts).map(({ starts, ...rest }) => (void starts, rest));
  }

  recentTables(now: number, ctx: ViewContext, filter: (f: Fired) => boolean = () => true, limit = 20): Array<Record<string, unknown>> {
    void now;
    return this.state.fired.filter(filter).slice(-limit).reverse().map((f) => this.firedView(f, ctx));
  }

  private firedView(f: Fired, ctx: ViewContext): Record<string, unknown> {
    const info = ctx.eventInfo(f.event_id);
    const handle = (id: number) => (this.shown(id) ? this.state.stats.contributors[String(id)]?.handle ?? null : null);
    const stage = info?.stage ?? f.stage ?? 'unknown';
    // LOB-5: who sits at a table (models, harnesses, handles) is listed only once its event has ended. While it
    // runs, an agent with web tools could otherwise find its own table and narrow down its opponents.
    const ended = stage === 'done' || stage === 'aborted';
    const seats = !ended ? [] : f.seats.filter((s) => s.seat).map((s) => ({ ...seatJson(s.seat!), contributor: handle(s.contributor_id) }) as Record<string, unknown>)
      .sort((a, b) => String(a.model_id).localeCompare(String(b.model_id)) || String(a.harness_id).localeCompare(String(b.harness_id)) || String(a.effort).localeCompare(String(b.effort)));
    return {
      table_id: f.id, event_id: f.event_id, queue: f.queue, kind: f.kind, fired_at: iso(f.fired_at), stage,
      queue_position: info?.queue_position ?? null, contributors: new Set(f.seats.map((s) => s.contributor_id).filter((id) => id > 0)).size, seats, ...(ended ? {} : { seats_listed: 'when the event ends' }),
      status_url: `${ctx.publicUrl}/api/events/${f.event_id}`, live_url: `${ctx.publicUrl}/api/events/${f.event_id}/live`,
      watch_url: `${ctx.siteUrl}/agent-bench/events/${f.event_id}/live`,
    };
  }

  /** GET /api/lobby (docs/LOBBY.md §4.1). */
  overview(now: number, ctx: ViewContext): Record<string, unknown> {
    const keys = new Set([...this.state.config.featured, ...this.state.entries.filter((e) => ACTIVE.includes(e.status) && !e.schedule).map((e) => e.queue)]);
    const queues = [...keys].map((k) => this.queueView(k, now, ctx)).filter((q): q is Record<string, unknown> => !!q)
      .sort((a, b) => Number(b.featured) - Number(a.featured) || (b.seats_filled as number) - (a.seats_filled as number) || String(a.key).localeCompare(String(b.key)));
    return {
      api_version: 1, generated_at: iso(now),
      director: { url: ctx.publicUrl, prompt_version: ctx.promptVersion, paused: this.hooks.paused(), capacity: ctx.capacity() },
      policy: {
        seats_per_table: this.cfg.seatsPerTable, max_seats_per_contributor: this.cfg.maxSeatsPerContributor, max_same_setup: this.cfg.maxSameSetup, same_setup_wait_min: Math.round(this.cfg.sameSetupWaitMs / 60_000), ready_window_s: Math.round(this.cfg.readyWindowMs / 1000),
        entry_ttl_hours: Math.round(this.cfg.entryTtlMs / 3600_000), format: { pairing: 'swiss', rounds: 3 },
      },
      queues, scheduled: this.scheduleViews(now, ctx), recent: this.recentTables(now, ctx),
    };
  }

  /** GET /api/lobby/stats (docs/LOBBY.md §4.4). */
  stats(now: number): Record<string, unknown> {
    const c = this.state.stats.contributors;
    const m = this.state.stats.models;
    const rel = (x: { finished: number; abandoned: number }) => (x.finished + x.abandoned >= 3 ? Math.round((x.finished / (x.finished + x.abandoned)) * 1000) / 1000 : null);
    const models = Object.entries(m).map(([id, s]) => ({
      model_id: id, model_display: displayOf('model', id), backers: Object.keys(s.backers).length, seats: s.seats, seats_finished: s.finished, seats_abandoned: s.abandoned,
      reliability: rel(s), tables: s.tables, games: s.games,
      harnesses: Object.entries(s.harnesses).map(([h, n]) => ({ harness_id: h, harness_display: displayOf('harness', h), seats: n })).sort((a, b) => b.seats - a.seats),
      last_played: iso(s.last_played) ?? null,
    })).sort((a, b) => b.seats - a.seats || a.model_id.localeCompare(b.model_id));
    const contributors = Object.entries(c).filter(([id, s]) => this.shown(id) && s.seats > 0).map(([, s]) => ({
      handle: s.handle, tables: s.tables, seats: s.seats, seats_finished: s.finished, seats_abandoned: s.abandoned, reliability: rel(s), games: s.games,
      models: Object.keys(s.models).sort((a, b) => s.models[b]! - s.models[a]!), first_seen: iso(s.first_seen), last_played: iso(s.last_played) ?? null,
    })).sort((a, b) => b.seats_finished - a.seats_finished || b.seats - a.seats || a.handle.localeCompare(b.handle)).slice(0, 200);
    return {
      api_version: 1, generated_at: iso(now),
      totals: {
        tables: this.state.fired.length, seats: Object.values(c).reduce((n, s) => n + s.seats, 0),
        contributors: Object.values(c).filter((s) => s.seats > 0).length, games: Object.values(c).reduce((n, s) => n + s.games, 0),
      },
      models, contributors,
    };
  }

  modelStats(id: string, now: number): Record<string, unknown> | undefined {
    const row = (this.stats(now).models as Array<Record<string, unknown>>).find((x) => x.model_id === id);
    const s = this.state.stats.models[id];
    if (!row || !s) return undefined;
    const backers = Object.entries(s.backers).map(([cid, n]) => ({ c: this.state.stats.contributors[cid], shown: !!this.state.stats.contributors[cid] && this.shown(cid), n }));
    return {
      api_version: 1, ...row,
      contributors: backers.filter((b) => b.shown).map((b) => ({ handle: b.c!.handle, seats: b.n })).sort((a, b) => b.seats - a.seats).slice(0, 50),
      anonymous_backers: backers.filter((b) => !b.shown).length,
    };
  }

  contributorStatsView(handle: string, now: number, ctx: ViewContext): Record<string, unknown> | undefined {
    const entry = Object.entries(this.state.stats.contributors).find(([id, s]) => this.shown(id) && s.handle.toLowerCase() === String(handle).toLowerCase());
    if (!entry) return undefined;
    const [cid, s] = entry;
    const rel = s.finished + s.abandoned >= 3 ? Math.round((s.finished / (s.finished + s.abandoned)) * 1000) / 1000 : null;
    const recent = this.state.fired.filter((f) => f.seats.some((x) => String(x.contributor_id) === cid)).slice(-20).reverse().map((f) => {
      const v = this.firedView(f, ctx);
      return {
        table_id: f.id, event_id: f.event_id, fired_at: v.fired_at, stage: v.stage, kind: f.kind,
        models: f.seats.filter((x) => String(x.contributor_id) === cid && x.seat).map((x) => x.seat!.model_id), watch_url: v.watch_url,
      };
    });
    return {
      api_version: 1, handle: s.handle, tables: s.tables, seats: s.seats, seats_finished: s.finished, seats_abandoned: s.abandoned, reliability: rel, games: s.games,
      models: Object.keys(s.models).sort((a, b) => s.models[b]! - s.models[a]!), first_seen: iso(s.first_seen), last_played: iso(s.last_played) ?? null, recent,
    };
  }

  /** Everything, for the admin (contributor ids included; tickets by hash prefix only). */
  adminView(now: number): Record<string, unknown> {
    return {
      rev: this.state.rev, config: this.state.config, paused: this.hooks.paused(),
      entries: this.state.entries.map((e) => ({ ...e, ticket: e.ticket.slice(0, 8), present: this.present(e, now) })),
      tickets: this.state.tickets.map((t) => ({ ...t, hash: t.hash.slice(0, 8) })),
      forming: this.state.forming.map((f) => ({ ...f, confirmed: f.confirmed.map((h) => h.slice(0, 8)) })),
      fired: this.state.fired.slice(-50),
    };
  }
}

export interface ViewContext {
  publicUrl: string;
  siteUrl: string;
  promptVersion: string;
  setName(code: string): string | undefined;
  capacity(): Record<string, unknown>;
  eventInfo(eventId: string): { stage: string; queue_position: number | null; seatUrl(name: string): string | null } | undefined;
}

export const KNOWLEDGE_LABEL: Record<string, string> = { none: 'No Set Knowledge', primer: 'Set Context', 'primer+stats': 'Set Context + Human Stats' };

/** A declared seat without the fields that aren't identity (the context policy is kept on the entry). */
function identityOnly(s: SeatIdentity & { context_policy?: unknown }): SeatIdentity {
  const { context_policy, ...seat } = s;
  void context_policy;
  return seat;
}

/**
 * The seat's context policy, for its holder only (ticket views): "harness" when none was declared, so a CLI can tell a
 * Director that records policies from one that doesn't (no field). Public views never show it: it isn't identity.
 */
function holderPolicy(e: Entry): { context_policy: ContextPolicy | 'harness' } {
  return { context_policy: e.context_policy ?? 'harness' };
}

function seatJson(s: SeatIdentity): Record<string, unknown> {
  return { model_id: s.model_id, model_display: s.model_display, harness_id: s.harness_id, harness_display: s.harness_display, effort: s.effort, ...identityOf(s) };
}
