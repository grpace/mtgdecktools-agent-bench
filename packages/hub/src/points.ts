/**
 * Contributor points (docs/COMMUNITY.md "Points and the Contributors Leaderboard"; contract docs/SITE-DATA.md
 * "Contributors"). Pure functions: the ledger is a deterministic function of the accepted events, the scheme below
 * and the admin bounty file, so `hub points recompute` can rescore all of history whenever the scheme changes.
 *
 * Points reward contributing, never winning: a finished seat, its rated games, lobby seats (they let other people
 * play), and bounties for the data the benchmark needs most. Points never touch ratings (METHODOLOGY §4).
 *
 * Only rated play earns: a seat with no rated games (every opponent was the same setup, or no game finished) earns
 * nothing, and bounties need at least `bounty_min_rated` rated games at that table, harness logs, and (for Needs
 * Games) a listed model at an explicit effort, a few times a week per contributor and setup (docs/COMMUNITY.md).
 *
 * Time is the Hub's, never the bundle's (PTS-1): events are scored in the order the Hub accepted them (ties by id),
 * and the daily cap, the repeat taper, admin bounty windows and the season all use that acceptance time. The times
 * inside a bundle are informational. Everything an event's points depend on (bounties, the contributor's
 * reliability, repeats, the daily cap) is computed from the events accepted before it, plus the event itself for
 * reliability.
 */

export const SCHEME = {
  /**
   * points-v3 (2026-10-22): a seat earns full points and bounties when it was Checked Against Logs (its harness usage,
   * sent with the event or later by `bench attach-logs`, names the declared model) or the bench CLI launched it on a
   * hosted table; otherwise × no_logs and no bounties. points-v2 counted any usage file, even one without model ids.
   */
  id: 'points-v3',
  /** Per seat that played its table to the end without a watchdog forfeit, and played at least one rated game. */
  seat: 10,
  /** Per rated game the seat played (against a different, rated seat identity; forfeits excluded). */
  game: 2,
  /** lobby: only tables the hosted Director handed off as lobby-fired (PTS-3); never a bundle's claim. */
  multipliers: { lobby: 1.5, private: 1 },
  /** Seats not Checked Against Logs (and not launched by the bench CLI at a hosted table) earn this share, and no bounties (PTS-2). */
  no_logs: 0.5,
  /** Rated games a seat needs at that table before it earns any bounty (H2). */
  bounty_min_rated: 2,
  /** Needs Games bounties per contributor per setup (identity) in a rolling window (H2). */
  needs_games_cap: { per_window: 3, window_days: 7 },
  /** Reliability = finished / all over the contributor's last `window` seats (this event included), from `from_seats` on. */
  reliability: { window: 20, from_seats: 5, floor: 0.5 },
  /** Seats of one setup (identity) in one set, per contributor, in a rolling window, once the setup is no longer provisional. */
  repeat: { window_days: 7, full: 8, half: 16 },
  bounties: { first_games: 20, provisional: 10, new_set: 5 },
  /** Rated events a set needs before the New Set bounty ends. */
  new_set_events: 3,
  /** Provisional thresholds (METHODOLOGY §4). */
  provisional: { games: 30, events: 3, opponents: 2 },
  daily_cap: 400,
  season: 'month' as const,
};

export type TableKind = 'lobby' | 'private';

/** A seat at an accepted event, attributed to a contributor (or to nobody: admin and legacy events). */
export interface PointsSeat {
  name: string;
  contributorId: number | null;
  /** Canonical identity key (harness/model/effort) and model id. */
  identity: string;
  modelId: string;
  harness: string;
  effort: string;
  /** ok: listed and not a Mismatch. */
  status: 'ok' | 'unlisted' | 'mismatch';
  /**
   * Checked (points-v3): the seat is Checked Against Logs (its harness usage, in the bundle or uploaded afterwards with
   * `bench attach-logs`, names the declared model), or the bench CLI launched it at a hosted table with the declared
   * model and effort. Without: × no_logs, no bounties. Hand-started seats are checked only through their logs.
   */
  logs: boolean;
  /** The effort was set explicitly (at launch, in the app, detected in the logs), not a harness default or unknown. */
  explicitEffort: boolean;
  /** The model is active or in preview in the registry (not retired). */
  modelActive: boolean;
  /** Any watchdog forfeit (the harness went silent): counts against reliability, earns no seat points. */
  abandoned: boolean;
  /** Finished games the seat played (forfeits and unfinished games excluded). */
  games: number;
  /** Rated games: opponent identity and the result. */
  rated: Array<{ opponent: string; won: boolean }>;
  matchWins: number;
  matchLosses: number;
  gameWins: number;
  gameLosses: number;
}

export interface PointsEvent {
  id: string;
  /** Unix ms: when the Hub accepted the event (PTS-1). Ordering, the daily cap, repeats, seasons and bounty windows use it. */
  acceptedAt: number;
  /** Unix ms: the event's end as its log says (informational: profiles show it; points never use it). */
  endedAt: number;
  set: string;
  setName?: string;
  /** Comparability group (null: no rated group, e.g. conditions not logged). */
  group: string | null;
  /** 'lobby' only when the hosted Director handed it off as a lobby-fired table (contributors.ts). */
  table: TableKind;
  /** Set when the event is accepted but must not earn points (excluded by a reviewer): lines with 0 points. */
  ineligible: string | null;
  /**
   * Early Test Data (best of 1, or best of 3 without sideboarding; site scoring earlyTestData): the reason. Never rated,
   * so it earns nothing: lines with 0 points, outside reliability, repeats and bounty state. Absent: not test data.
   */
  testData?: string | null;
  seats: PointsSeat[];
}

/** packages/hub/bounties.json: bounties set by hand, and computed kinds switched off. */
export interface AdminBounties {
  version: 1;
  /** Computed bounty kinds to switch off: "first_games", "provisional", "new_set". */
  disable?: string[];
  bounties?: Array<{
    id: string;
    label: string;
    bonus: number;
    text?: string;
    match: { set?: string; model?: string; harness?: string; effort?: string; table?: TableKind };
    /** ISO dates (inclusive from, exclusive until), by the Hub's acceptance time. */
    from?: string;
    until?: string;
  }>;
}

export interface BountyHit { id: string; kind: 'first_games' | 'provisional' | 'new_set' | 'admin'; label: string; bonus: number }

export interface LedgerLine {
  eventId: string;
  seat: string;
  contributorId: number;
  season: string;
  /** Unix ms: the Hub's acceptance time of the event. */
  at: number;
  set: string;
  table: TableKind;
  identity: string;
  modelId: string;
  status: 'finished' | 'abandoned' | 'ineligible';
  games: number;
  ratedGames: number;
  /** Seat points + game points. */
  base: number;
  tableMult: number;
  repeatMult: number;
  /** 1 when checked (Checked Against Logs, or launched at a hosted table), SCHEME.no_logs otherwise (not stored in points_ledger: the note says it). */
  logsMult: number;
  reliabilityMult: number;
  bounties: BountyHit[];
  bounty: number;
  /** Before the daily cap. */
  raw: number;
  /** Points the daily cap removed. */
  capped: number;
  points: number;
  note: string;
}

/** "2026-11" for a Unix ms timestamp (UTC calendar month). */
export function seasonOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 7);
}

export function seasonInfo(id: string): { id: string; label: string; starts_at: string; ends_at: string } {
  const [y, m] = id.split('-').map(Number) as [number, number];
  const start = Date.UTC(y, m - 1, 1);
  const end = Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 1);
  const label = `${new Date(start).toLocaleString('en-US', { month: 'long', timeZone: 'UTC' })} ${y}`;
  return { id, label, starts_at: new Date(start).toISOString(), ends_at: new Date(end).toISOString() };
}

const DAY = 86_400_000;
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const round1 = (x: number) => Math.round(x * 1000) / 1000;

/** Rated-game counters of one identity in one group, for the provisional thresholds. */
interface Need { games: number; events: Set<string>; opponents: Set<string> }

export function isProvisional(n: Need | undefined): boolean {
  const p = SCHEME.provisional;
  return !n || n.games < p.games || n.events.size < p.events || n.opponents.size < p.opponents;
}

/** What the data looked like before an event: the state bounties and repeats are judged against. */
export class DataState {
  /** group → identity → counters. */
  readonly needs = new Map<string, Map<string, Need>>();
  /** Models with at least one rated game. */
  readonly modelsPlayed = new Set<string>();
  /** Rated events per set. */
  readonly setEvents = new Map<string, number>();

  need(group: string, identity: string): Need | undefined {
    return this.needs.get(group)?.get(identity);
  }

  add(ev: PointsEvent): void {
    if (ev.ineligible || ev.testData) return;
    // A rated table has at least one rated game: an all-mirror or all-scripted table (no rated games) is not one.
    if (ev.group && ev.seats.some((s) => s.status === 'ok' && s.rated.length)) this.setEvents.set(ev.set, (this.setEvents.get(ev.set) ?? 0) + 1);
    for (const s of ev.seats) {
      if (s.status !== 'ok' || !s.rated.length) continue;
      this.modelsPlayed.add(s.modelId);
      if (!ev.group) continue;
      const g = this.needs.get(ev.group) ?? new Map<string, Need>();
      this.needs.set(ev.group, g);
      const n = g.get(s.identity) ?? { games: 0, events: new Set<string>(), opponents: new Set<string>() };
      g.set(s.identity, n);
      n.games += s.rated.length;
      n.events.add(ev.id);
      for (const r of s.rated) n.opponents.add(r.opponent);
    }
  }
}

function inWindow(at: number, from?: string, until?: string): boolean {
  if (from && at < Date.parse(from)) return false;
  if (until && at >= Date.parse(until)) return false;
  return true;
}

/** Why a seat earns no bounty at all (H2, PTS-2), or '' when it may. */
export function bountyBlock(s: PointsSeat): string {
  if (s.abandoned) return 'abandoned';
  if (s.rated.length < SCHEME.bounty_min_rated) return `fewer than ${SCHEME.bounty_min_rated} rated games`;
  if (!s.logs) return 'not checked against harness logs';
  return '';
}

/**
 * The bounties a seat earns, judged against the data before its event. `needsGamesUsed`: Needs Games bounties this
 * contributor already earned for this setup within the window (the cap). Call only for seats bountyBlock() allows.
 */
export function bountiesFor(ev: PointsEvent, s: PointsSeat, before: DataState, admin: AdminBounties | null, needsGamesUsed = 0): BountyHit[] {
  const off = new Set(admin?.disable ?? []);
  const out: BountyHit[] = [];
  const b = SCHEME.bounties;
  if (!off.has('first_games') && s.modelActive && !before.modelsPlayed.has(s.modelId)) out.push({ id: `first-games:${s.modelId}`, kind: 'first_games', label: 'First Games', bonus: b.first_games });
  // Needs Games: only listed, active models at an explicit effort, so inventing a rarely used setup isn't a bounty
  // farm; and a few per contributor and setup a week, so one contributor can't take a setup past the floor alone.
  if (!off.has('provisional') && ev.group && s.modelActive && s.explicitEffort && needsGamesUsed < SCHEME.needs_games_cap.per_window
    && isProvisional(before.need(ev.group, s.identity))) {
    out.push({ id: `provisional:${ev.group}:${s.identity}`, kind: 'provisional', label: NEEDS_GAMES, bonus: b.provisional });
  }
  if (!off.has('new_set') && ev.group && (before.setEvents.get(ev.set) ?? 0) < SCHEME.new_set_events) {
    out.push({ id: `new-set:${ev.set}`, kind: 'new_set', label: 'New Set', bonus: b.new_set });
  }
  for (const a of admin?.bounties ?? []) {
    const m = a.match ?? {};
    if (m.set && m.set.toUpperCase() !== ev.set.toUpperCase()) continue;
    if (m.model && m.model !== s.modelId) continue;
    if (m.harness && m.harness !== s.harness) continue;
    if (m.effort && m.effort !== s.effort) continue;
    if (m.table && m.table !== ev.table) continue;
    if (!inWindow(ev.acceptedAt, a.from, a.until)) continue;
    if (!(a.bonus > 0)) continue;
    out.push({ id: `admin:${a.id}`, kind: 'admin', label: a.label, bonus: Math.min(100, a.bonus) });
  }
  return out;
}

/** The label of the `provisional` bounty kind (a setup still short of the games its rating needs). */
export const NEEDS_GAMES = 'Needs Games';

/** Repeat multiplier for the n-th seat (1-based) of one setup in one set within the window. */
export function repeatMultiplier(n: number): number {
  const r = SCHEME.repeat;
  return n <= r.full ? 1 : n <= r.half ? 0.5 : 0.25;
}

/** Reliability multiplier from the contributor's seat outcomes so far (true = finished), newest last. */
export function reliabilityMultiplier(outcomes: boolean[]): number {
  const r = SCHEME.reliability;
  const last = outcomes.slice(-r.window);
  if (last.length < r.from_seats) return 1;
  return Math.max(r.floor, last.filter(Boolean).length / last.length);
}

export const eventOrder = (a: PointsEvent, b: PointsEvent) => a.acceptedAt - b.acceptedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * The whole ledger, from scratch. `events` are the accepted events (any order); seats without a contributor earn
 * nothing and leave no line, but their games still count toward what the data needs.
 */
export function computeLedger(events: PointsEvent[], admin: AdminBounties | null = null): LedgerLine[] {
  const sorted = [...events].sort(eventOrder);
  const state = new DataState();
  const outcomes = new Map<number, boolean[]>();
  const repeats = new Map<string, number[]>();
  const needsGames = new Map<string, number[]>();
  const daily = new Map<string, number>();
  const lines: LedgerLine[] = [];
  for (const ev of sorted) {
    const at = ev.acceptedAt;
    const seats = [...ev.seats].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    // Reliability counts this event's seats too: abandoning a seat costs at this table already.
    for (const s of seats) {
      if (s.contributorId == null || ev.ineligible || ev.testData) continue;
      const o = outcomes.get(s.contributorId) ?? [];
      outcomes.set(s.contributorId, o);
      o.push(!s.abandoned);
    }
    const tableMult = SCHEME.multipliers[ev.table];
    for (const s of seats) {
      if (s.contributorId == null) continue;
      const line: LedgerLine = {
        eventId: ev.id, seat: s.name, contributorId: s.contributorId, season: seasonOf(at), at, set: ev.set, table: ev.table,
        identity: s.identity, modelId: s.modelId, status: s.abandoned ? 'abandoned' : 'finished', games: s.games, ratedGames: s.rated.length,
        base: 0, tableMult, repeatMult: 1, logsMult: 1, reliabilityMult: 1, bounties: [], bounty: 0, raw: 0, capped: 0, points: 0, note: '',
      };
      lines.push(line);
      const ineligible = ev.ineligible ? `event excluded: ${ev.ineligible}`
        : ev.testData ? `${ev.testData}: not rated, no points`
        : s.status === 'mismatch' ? 'the harness logs show a different model than declared (Mismatch): no points'
          : s.status === 'unlisted' ? 'model not in the registry yet: earns points once it is listed' : '';
      if (ineligible) {
        line.status = 'ineligible';
        line.note = ineligible;
        continue;
      }
      line.reliabilityMult = round1(reliabilityMultiplier(outcomes.get(s.contributorId) ?? []));
      // Only rated play earns (H2): a table of one setup, or a seat whose games never finished, earns nothing.
      if (!s.rated.length) {
        line.note = 'no rated games (every opponent was the same model setup, or no game finished): no points';
        continue;
      }
      line.base = (s.abandoned ? 0 : SCHEME.seat) + SCHEME.game * s.rated.length;
      line.logsMult = s.logs ? 1 : SCHEME.no_logs;
      // Repeats: only beyond what the data needs (the setup is no longer provisional in this group).
      const rk = `${s.contributorId}|${s.identity}|${ev.set}`;
      const prev = (repeats.get(rk) ?? []).filter((t) => at - t < SCHEME.repeat.window_days * DAY);
      prev.push(at);
      repeats.set(rk, prev);
      if (ev.group && !isProvisional(state.need(ev.group, s.identity))) line.repeatMult = repeatMultiplier(prev.length);
      const blocked = bountyBlock(s);
      if (!blocked) {
        const nk = `${s.contributorId}|${s.identity}`;
        const used = (needsGames.get(nk) ?? []).filter((t) => at - t < SCHEME.needs_games_cap.window_days * DAY);
        line.bounties = bountiesFor(ev, s, state, admin, used.length);
        if (line.bounties.some((b) => b.kind === 'provisional')) used.push(at);
        needsGames.set(nk, used);
      }
      line.bounty = line.bounties.reduce((a, b) => a + b.bonus, 0);
      line.raw = round1((line.base * tableMult * line.repeatMult * line.logsMult + line.bounty) * line.reliabilityMult);
      const dk = `${s.contributorId}|${day(at)}`;
      const usedToday = daily.get(dk) ?? 0;
      const want = Math.round(line.raw);
      line.points = Math.max(0, Math.min(want, SCHEME.daily_cap - usedToday));
      line.capped = want - line.points;
      daily.set(dk, usedToday + line.points);
      const parts = [
        `${s.abandoned ? 'abandoned (no seat points)' : `${SCHEME.seat} seat`} + ${s.rated.length} rated game${s.rated.length === 1 ? '' : 's'} × ${SCHEME.game}`,
        tableMult !== 1 ? `× ${tableMult} lobby` : '',
        line.repeatMult !== 1 ? `× ${line.repeatMult} repeat` : '',
        line.logsMult !== 1 ? `× ${line.logsMult} not checked against harness logs` : '',
        line.bounty ? `+ ${line.bounties.map((b) => `${b.bonus} ${b.label}`).join(' + ')}` : '',
        line.reliabilityMult !== 1 ? `× ${line.reliabilityMult} reliability` : '',
        line.capped ? `(${line.capped} over the daily cap)` : '',
        blocked && blocked !== 'abandoned' ? `(no bounties: ${blocked})` : '',
      ].filter(Boolean);
      line.note = parts.join(' ');
    }
    state.add(ev);
  }
  return lines;
}

/** The data state after every event (for the open bounties). */
export function finalState(events: PointsEvent[]): DataState {
  const st = new DataState();
  for (const ev of [...events].sort(eventOrder)) st.add(ev);
  return st;
}

// ---------------------------------------------------------------------------
// Boards

export interface Totals { points: number; seats: number; finished: number; abandoned: number; tables: Set<string>; lobbySeats: number; games: number; models: Map<string, number>; last: number; first: number }

export function totalsBy(lines: LedgerLine[], seats: Map<string, PointsSeat>, filter: (l: LedgerLine) => boolean = () => true): Map<number, Totals> {
  const out = new Map<number, Totals>();
  for (const l of lines) {
    if (!filter(l)) continue;
    const t = out.get(l.contributorId) ?? { points: 0, seats: 0, finished: 0, abandoned: 0, tables: new Set<string>(), lobbySeats: 0, games: 0, models: new Map(), last: 0, first: Infinity };
    out.set(l.contributorId, t);
    t.points += l.points;
    t.seats++;
    const s = seats.get(`${l.eventId}|${l.seat}`);
    if (s?.abandoned) t.abandoned++;
    else t.finished++;
    t.tables.add(l.eventId);
    if (l.table === 'lobby') t.lobbySeats++;
    t.games += l.games;
    t.models.set(l.modelId, (t.models.get(l.modelId) ?? 0) + 1);
    t.last = Math.max(t.last, l.at);
    t.first = Math.min(t.first, l.at);
  }
  return out;
}

/** Competition ranks ("1, 2, 2, 4") by points, ties sorted by handle. */
export function rank<T extends { points: number; handle: string }>(rows: T[]): Array<T & { rank: number }> {
  const sorted = [...rows].sort((a, b) => b.points - a.points || (a.handle < b.handle ? -1 : a.handle > b.handle ? 1 : 0));
  let last = NaN;
  let r = 0;
  return sorted.map((x, i) => {
    if (x.points !== last) r = i + 1;
    last = x.points;
    return { ...x, rank: r };
  });
}

export const reliabilityOf = (finished: number, abandoned: number): number | null =>
  finished + abandoned >= 3 ? Math.round((finished / (finished + abandoned)) * 1000) / 1000 : null;
