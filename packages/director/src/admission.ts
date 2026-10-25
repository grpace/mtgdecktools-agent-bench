/**
 * Admission control for the hosted Director (docs/ARCHITECTURE.md §2, §5): global capacity, a FIFO queue, and
 * per-contributor quotas. Pure bookkeeping (no I/O, the clock is passed in) so it is unit-tested on its own.
 *
 * Capacity is counted in **game slots**. One worker (Director + phase-server) handles about 30 concurrent LLM
 * games (§2). An event's weight is the most games it can run at once, floor(agents / 2), at least 1: its draft
 * and deckbuilding hold the same slot(s), so an admitted event never waits for capacity halfway through. The
 * weight is reserved from admission to the end, which is conservative (a 3-agent pod plays one game per round
 * but reserves 1 slot; a 2-agent pod 1; an 8-agent pod 4).
 *
 * When the event doesn't fit, it waits in a FIFO queue and starts when capacity frees (strict FIFO: a small event
 * never overtakes a big one at the head, so nothing starves). Contributors have limits on concurrent events
 * (running + queued) and on events created per rolling 24 hours; the admin token has none (but still queues:
 * capacity is physical), unless it asks to `force` a start.
 *
 * **Continuous play ("Keep Playing", docs/LOBBY.md §2.3).** A contributor's Private Table created by a `bench` loop
 * (`continuous: true`) must never starve lobby tables or one-off tables:
 *   - it never starts ahead of a waiting non-continuous event (those skip ahead of queued continuous ones);
 *   - it starts only while `load + weight + reserve <= capacity` (CONTINUOUS_RESERVE_SLOTS, default 8 slots = two
 *     lobby tables; never more than the capacity left after its own weight);
 *   - a contributor has at most CONTINUOUS_PER_CONTRIBUTOR (default 1) continuous events running or queued;
 *   - it counts toward the normal daily quota like any other event.
 *
 * **Lobby tables have their own quota (LOB-2; owner decision 2026-10-22).** A fired lobby table is owned by the lobby,
 * but it lists the contributors seated at it (`contributors`): for each of them it counts as one lobby table, running or
 * queued, and as one lobby table created today, against their **lobby** quota (default 2 at a time, 12 a day), which
 * is counted separately from their Private Table quota (default 1 at a time, 6 a day). The lobby seats nobody whose
 * lobby quota is used up (quotaState) and refuses joins once its daily part is spent. Capacity (game slots, the queue)
 * is shared by everything.
 */
import type { Owner } from './durable.js';

export interface Quotas {
  /** Events running or queued at once. */
  concurrent: number;
  /** Events created per rolling 24 h. */
  daily: number;
}

export interface AdmissionConfig {
  /** Game slots on this worker (MAX_CONCURRENT_GAMES, default 30). */
  capacity: number;
  /** Longest queue (all owners); beyond it new events are refused (MAX_QUEUE, default 50). */
  maxQueue: number;
  /** Default Private Table quotas per contributor, when the Hub returns none (CONTRIB_CONCURRENT 1, CONTRIB_DAILY 6). */
  contributor: Quotas;
  /** Default lobby quotas per contributor, counted separately (LOBBY_CONTRIB_CONCURRENT 2, LOBBY_CONTRIB_DAILY 12). */
  lobby?: Quotas;
  /** Game slots continuous events leave free for lobby and one-off tables (CONTINUOUS_RESERVE_SLOTS, default 8). */
  continuousReserve?: number;
  /** Continuous events per contributor, running or queued (CONTINUOUS_PER_CONTRIBUTOR, default 1). */
  continuousPerContributor?: number;
}

export const DEFAULT_ADMISSION: AdmissionConfig = {
  capacity: 30, maxQueue: 50, contributor: { concurrent: 1, daily: 6 }, lobby: { concurrent: 2, daily: 12 }, continuousReserve: 8, continuousPerContributor: 1,
};
export const DEFAULT_LOBBY_QUOTAS: Quotas = { concurrent: 2, daily: 12 };

export interface Entry {
  id: string;
  owner: Owner;
  weight: number;
  createdAt: number;
  /** A contributor's "Keep Playing" Private Table: lower priority, keeps headroom (see the header). */
  continuous?: boolean;
  /** Lobby tables: the contributors seated at it (each one's quotas count it). */
  contributors?: number[];
}

export type Decision =
  | { ok: true; start: boolean; position?: number }
  | { ok: false; status: 429 | 503; error: string; retryAfterS?: number };

const DAY_MS = 24 * 3600_000;

export const eventWeight = (agents: number): number => Math.max(1, Math.floor(agents / 2));

const ownerKey = (o: Owner): string => (o.kind === 'admin' ? 'admin' : o.kind === 'lobby' ? `lobby:${o.table}` : `c:${o.id}`);
/** A contributor's lobby quota key: lobby tables count here, never against their Private Tables (`c:<id>`). */
const lobbyKey = (contributorId: number): string => `l:${contributorId}`;
/** Every quota key an event counts against: its owner, plus each contributor seated at a lobby table (their lobby key). */
const keysOf = (e: { owner: Owner; contributors?: number[] }): string[] => [ownerKey(e.owner), ...[...new Set(e.contributors ?? [])].map(lobbyKey)];
const withQuotas = (defaults: Quotas, quotas?: Partial<Quotas>): Quotas =>
  ({ ...defaults, ...Object.fromEntries(Object.entries(quotas ?? {}).filter(([, v]) => typeof v === 'number' && v >= 0)) }) as Quotas;

export class Admission {
  private running = new Map<string, Entry>();
  private queue: Entry[] = [];
  /** Creation times per contributor (rolling 24 h), including events that already ended. */
  private created = new Map<string, number[]>();
  draining = false;

  constructor(readonly cfg: AdmissionConfig = DEFAULT_ADMISSION) {}

  get load(): number {
    let n = 0;
    for (const e of this.running.values()) n += e.weight;
    return n;
  }

  get queued(): readonly Entry[] {
    return this.queue;
  }

  isRunning(id: string): boolean {
    return this.running.has(id);
  }

  /** 1-based queue position, or undefined when not queued. */
  position(id: string): number | undefined {
    const i = this.queue.findIndex((e) => e.id === id);
    return i < 0 ? undefined : i + 1;
  }

  /** Slots a continuous event of this weight must leave free (never more than the capacity left after it). */
  reserveFor(weight: number): number {
    return Math.max(0, Math.min(this.cfg.continuousReserve ?? 8, this.cfg.capacity - weight));
  }

  /** Continuous events of this owner running or queued. */
  activeContinuous(owner: Owner): number {
    const k = ownerKey(owner);
    let n = 0;
    for (const e of this.running.values()) if (e.continuous && ownerKey(e.owner) === k) n++;
    for (const e of this.queue) if (e.continuous && ownerKey(e.owner) === k) n++;
    return n;
  }

  /** Events counted under one quota key, running or queued. */
  private activeKey(k: string): number {
    let n = 0;
    for (const e of this.running.values()) if (keysOf(e).includes(k)) n++;
    for (const e of this.queue) if (keysOf(e).includes(k)) n++;
    return n;
  }

  /** Events of this owner running or queued (for a contributor: their Private Tables; lobby tables count separately). */
  active(owner: Owner): number {
    return this.activeKey(ownerKey(owner));
  }

  /** Lobby tables this contributor sits at, running or queued. */
  activeLobby(contributorId: number): number {
    return this.activeKey(lobbyKey(contributorId));
  }

  /**
   * A contributor's lobby quota state (separate from their Private Tables): `seatable` while they have room for one more
   * lobby table now (`pending`: their tables still in a ready check); `refuse` (with the seconds until it frees) once
   * today's lobby quota is spent. `quotas`: the contributor's lobby quotas from the Hub, else the Director's defaults.
   */
  quotaState(contributorId: number, now: number, quotas?: Partial<Quotas>, pending = 0): { seatable: boolean; refuse?: string; retryAfterS?: number } {
    const q = withQuotas(this.cfg.lobby ?? DEFAULT_LOBBY_QUOTAS, quotas);
    const k = lobbyKey(contributorId);
    const today = this.createdTodayKey(k, now);
    if (today >= q.daily) {
      const oldest = Math.min(...(this.created.get(k) ?? [now]));
      return { seatable: false, refuse: `daily lobby limit reached: ${today} lobby table(s) in the last 24 hours (limit ${q.daily}; Private Tables are counted separately)`, retryAfterS: Math.max(60, Math.ceil((oldest + DAY_MS - now) / 1000)) };
    }
    return { seatable: this.activeKey(k) + pending < q.concurrent && today + pending < q.daily };
  }

  /** Events this owner created in the last 24 hours (a contributor: Private Tables only). */
  createdToday(owner: Owner, now: number): number {
    return this.createdTodayKey(ownerKey(owner), now);
  }

  /** Lobby tables this contributor was seated at in the last 24 hours. */
  lobbyCreatedToday(contributorId: number, now: number): number {
    return this.createdTodayKey(lobbyKey(contributorId), now);
  }

  private createdTodayKey(k: string, now: number): number {
    const list = (this.created.get(k) ?? []).filter((t) => now - t < DAY_MS);
    this.created.set(k, list);
    return list.length;
  }

  /** Record an event created earlier (startup: from the checkpoints), for the daily quotas; a lobby table counts toward every seated contributor's lobby quota. */
  noteCreated(owner: Owner, at: number, contributors: number[] = []): void {
    for (const k of keysOf({ owner, contributors })) this.created.set(k, [...(this.created.get(k) ?? []), at]);
  }

  /**
   * Can this owner create an event of this weight now? Does not change anything. `quotas` are the contributor's
   * (from the Hub), else the defaults; admins have none.
   */
  check(owner: Owner, weight: number, now: number, quotas?: Partial<Quotas>, force = false, continuous = false): Decision {
    if (this.draining) return { ok: false, status: 503, error: 'this Director is draining for a restart: try again in a few minutes', retryAfterS: 120 };
    if (weight > this.cfg.capacity) return { ok: false, status: 429, error: `an event needs ${weight} game slot(s); this worker has ${this.cfg.capacity}` };
    if (owner.kind === 'contributor') {
      const q = withQuotas(this.cfg.contributor, quotas);
      if (this.active(owner) >= q.concurrent) {
        return { ok: false, status: 429, error: `you already have ${this.active(owner)} Private Table(s) running or queued (limit ${q.concurrent}; lobby tables are counted separately); wait for one to finish or cancel it (DELETE /api/events/<id>)`, retryAfterS: 300 };
      }
      const today = this.createdToday(owner, now);
      if (today >= q.daily) {
        const oldest = Math.min(...(this.created.get(ownerKey(owner)) ?? [now]));
        return { ok: false, status: 429, error: `daily limit reached: ${today} Private Table(s) in the last 24 hours (limit ${q.daily}; lobby tables are counted separately)`, retryAfterS: Math.max(60, Math.ceil((oldest + DAY_MS - now) / 1000)) };
      }
      const cap = this.cfg.continuousPerContributor ?? 1;
      if (continuous && this.activeContinuous(owner) >= cap) {
        return { ok: false, status: 429, error: `you already have ${this.activeContinuous(owner)} Keep Playing table(s) running or queued (limit ${cap})`, retryAfterS: 300 };
      }
    }
    // Continuous events wait behind everything and keep headroom; other events only wait behind other events.
    const ahead = continuous ? this.queue.length : this.queue.filter((e) => !e.continuous).length;
    const fits = ahead === 0 && this.load + weight + (continuous ? this.reserveFor(weight) : 0) <= this.cfg.capacity;
    if (fits || (force && owner.kind === 'admin')) return { ok: true, start: true };
    if (this.queue.length >= this.cfg.maxQueue) return { ok: false, status: 503, error: `the queue is full (${this.queue.length} events waiting); try again later`, retryAfterS: 600 };
    return { ok: true, start: false, position: ahead + 1 };
  }

  /** Admit (after a successful check): either running now or queued (continuous events at the back, others before them). */
  admit(e: Entry, start: boolean, now: number): void {
    this.noteCreated(e.owner, now, e.contributors);
    if (start) this.running.set(e.id, e);
    else this.enqueue(e);
  }

  private enqueue(e: Entry): void {
    if (e.continuous) {
      this.queue.push(e);
      return;
    }
    const i = this.queue.findIndex((x) => x.continuous);
    if (i < 0) this.queue.push(e);
    else this.queue.splice(i, 0, e);
  }

  /** Re-register an event after a restart without counting it against the daily quota again. */
  restore(e: Entry, running: boolean): void {
    if (running) this.running.set(e.id, e);
    else this.enqueue(e);
  }

  /** An event finished, was aborted or canceled: free its slots (or its queue place). */
  release(id: string): void {
    this.running.delete(id);
    this.queue = this.queue.filter((e) => e.id !== id);
  }

  /**
   * Queued events that fit now, in queue order (one-off and lobby events first, then continuous ones with their
   * headroom); they are moved to running. Nothing overtakes the head of the queue. Nothing starts while draining.
   */
  next(): Entry[] {
    const out: Entry[] = [];
    if (this.draining) return out;
    const need = (e: Entry) => e.weight + (e.continuous ? this.reserveFor(e.weight) : 0);
    while (this.queue.length && this.load + need(this.queue[0]!) <= this.cfg.capacity) {
      const e = this.queue.shift()!;
      this.running.set(e.id, e);
      out.push(e);
    }
    return out;
  }

  status(): { capacity: number; load: number; running: number; queued: number; draining: boolean; continuous: { running: number; queued: number; reserve: number; per_contributor: number } } {
    let cr = 0;
    for (const e of this.running.values()) if (e.continuous) cr++;
    return {
      capacity: this.cfg.capacity, load: this.load, running: this.running.size, queued: this.queue.length, draining: this.draining,
      continuous: { running: cr, queued: this.queue.filter((e) => e.continuous).length, reserve: this.cfg.continuousReserve ?? 8, per_contributor: this.cfg.continuousPerContributor ?? 1 },
    };
  }
}
