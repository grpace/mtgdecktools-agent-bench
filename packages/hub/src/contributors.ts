/**
 * Contributors: the points ledger (packages/hub/src/points.ts) applied to the Hub's accepted events, the public
 * leaderboard and profiles (docs/SITE-DATA.md "Contributors"), and each contributor's private view (/account).
 *
 *   refresh()     after every export: rebuild the ledger from the accepted events (Postgres points_ledger), then
 *                 write contributors.json and contributors/<handle>.json into the served tree
 *   board()       GET /api/contributors (season or all time, paged)
 *   profile()     GET /api/contributors/<handle>
 *   bounties()    GET /api/bounties
 *   account()     the signed-in contributor's own numbers, hidden or not
 *
 * Attribution (who gets a seat's points), from data the Hub trusts:
 *   - hosted events (the Director hand-off) and imports: lobby seats → event_start.seats[].contributor_id; a Private
 *     Table → event_start.organizer.contributor_id; admin events → nobody;
 *   - community uploads → the uploader (their own table on their own machine), whatever the log says.
 * Lobby tables (the × 1.5 multiplier) only from the hosted Director's hand-off, never from a bundle's claim (PTS-3).
 * Time: the Hub's acceptance time (submissions.decided_at, else received_at), never an upload's or a hand-off's log
 * (PTS-1); admin imports keep their log's end, capped at the import time.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readEventStart } from '../../director/src/bundle.js';
import { REGISTRY_DATA, registry } from '../../registry/src/index.js';
import type { EventData } from '../../site/src/data.js';
import { earlyTestData, groupKey, groupLabel, Identities, parseGroupKey, ratingGamesOf } from '../../site/src/scoring.js';
import type { Highlight } from '../../site/src/schema.js';
import type { Sql } from './db.js';
import {
  computeLedger, finalState, isProvisional, NEEDS_GAMES, rank, reliabilityOf, SCHEME, seasonInfo, seasonOf, totalsBy,
  type AdminBounties, type LedgerLine, type PointsEvent, type PointsSeat, type Totals,
} from './points.js';

export const CONTRIBUTORS_SCHEMA = 1;
const BOARD_SIZE = 100;
const HANDLE_RE = /^[a-z0-9][a-z0-9_.-]{0,39}$/;

export interface ContributorRecord {
  id: number;
  handle: string;
  kind: string;
  status: string;
  avatarUrl: string | null;
  githubLogin: string | null;
  boardVisibility: 'public' | 'hidden' | null;
}

/** What an accepted event's submission says about attribution, and when the Hub accepted it (Unix ms). */
export interface SubmissionMeta { via: 'upload' | 'director' | 'import'; uploader: number | null; acceptedAt: number }

export interface Inputs {
  events: EventData[];
  meta: Map<string, SubmissionMeta>;
  contributors: Map<number, ContributorRecord>;
}

/** A seat, its event and how it is labeled, for profiles. */
interface SeatFacts { ev: PointsEvent; seat: PointsSeat; label: string; display: { model: string; harness: string; effort: string } }

/** Events that count for points and the boards: finished LLM tables, not smoke or dev tables, accepted by the Hub. */
const countable = (ev: EventData, inp: Inputs): boolean =>
  !ev.devBotFill && ev.seats.some((s) => s.llm) && ev.source.label !== 'smoke' && ev.status === 'complete' && inp.meta.has(ev.id);

/**
 * Each person's latest lobby handle choice (show or hide), from the lobby tables the Hub got through its own channels
 * (the hosted Director, admin imports; never an upload, which could claim anything).
 */
export function lobbyChoices(inp: Inputs): Map<number, { at: number; shown: boolean }> {
  const out = new Map<number, { at: number; shown: boolean }>();
  for (const ev of inp.events) {
    if (!countable(ev, inp) || inp.meta.get(ev.id)!.via === 'upload' || ev.table?.kind !== 'lobby') continue;
    for (const s of ev.seats) {
      const n = Number(s.contributorId);
      const c = s.contributorId != null && Number.isSafeInteger(n) ? inp.contributors.get(n) : undefined;
      if (!c || c.kind !== 'person') continue;
      const prev = out.get(c.id);
      if (!prev || prev.at <= ev.startT) out.set(c.id, { at: ev.startT, shown: !!s.contributorHandle });
    }
  }
  return out;
}

/** The Hub ids (as strings) of contributors shown publicly right now: the export names only their handles. */
export function publicContributorIds(inp: Inputs): Set<string> {
  const lobby = lobbyChoices(inp);
  return new Set([...inp.contributors.values()].filter((c) => isPublic(c, lobby.get(c.id))).map((c) => String(c.id)));
}

/** Accepted events → the points module's view, plus each contributor's latest lobby handle choice. */
export function pointsEvents(inp: Inputs): { events: PointsEvent[]; labels: Map<string, IdentityLabel>; lobbyShown: Map<number, { at: number; shown: boolean }> } {
  const ids = new Identities(inp.events);
  const labels = new Map<string, IdentityLabel>();
  const lobbyShown = lobbyChoices(inp);
  const person = (raw: unknown): number | null => {
    const n = Number(raw);
    const c = Number.isSafeInteger(n) ? inp.contributors.get(n) : undefined;
    return c && c.kind === 'person' ? c.id : null;
  };
  const out: PointsEvent[] = [];
  for (const ev of inp.events) {
    // Smoke, dev (bot drafters), unfinished: no points for anyone.
    if (!countable(ev, inp)) continue;
    const meta = inp.meta.get(ev.id)!;
    const start = readEventStart(ev.dir) ?? {};
    // Seats of a lobby table belong to whoever queued them: trusted from our own channels (the hosted Director's
    // hand-off, admin imports), never from an upload. The lobby multiplier needs more: the hosted Director, which
    // fired the table itself, handed it off (PTS-3). An import keeps its seats' owners but earns as a Private Table.
    const loggedLobby = meta.via !== 'upload' && start.table?.kind === 'lobby';
    const table: 'lobby' | 'private' = loggedLobby && meta.via === 'director' ? 'lobby' : 'private';
    const startSeats = new Map<string, Record<string, unknown>>((Array.isArray(start.seats) ? start.seats : []).map((s: Record<string, unknown>) => [String(s.name), s]));
    const organizer = start.organizer?.kind === 'contributor' ? person(start.organizer.contributor_id) : null;
    const who = (seat: string): number | null => {
      if (meta.via === 'upload') return meta.uploader != null && inp.contributors.get(meta.uploader)?.kind === 'person' ? meta.uploader : null;
      if (loggedLobby) return person(startSeats.get(seat)?.contributor_id);
      return organizer;
    };
    // Early Test Data (best of 1, or best of 3 without sideboarding) is never rated: no rated games, no points.
    const testData = earlyTestData(ev) ?? null;
    // Points count only games actually played (points-v2: "forfeits excluded"), whatever the rating's forfeit policy:
    // a game the watchdog conceded is a loss in the rating, never points for either seat.
    const rated = testData ? [] : ratingGamesOf([ev], ids, { forfeits: 'exclude-game' });
    const seats: PointsSeat[] = [];
    for (const s of ev.seats.filter((x) => x.llm)) {
      const id = ids.of(ev, s.name);
      const info = ids.info.get(id.key);
      if (info && !labels.has(id.key)) {
        labels.set(id.key, {
          identity: id.key, identity_label: info.label, model_id: info.model_id ?? id.model, model_display: info.model_display ?? id.model,
          // 2.20: an identity spans harnesses, so a contributor's row names none (empty, kept for older readers).
          harness_id: '', harness_display: '', effort: id.effort, effort_display: info.effort_display ?? id.effort,
        });
      }
      const st = ev.standings.find((x) => x.name === s.name);
      const mine = rated.filter((g) => g.seatA === s.name || g.seatB === s.name);
      const entry = registry.model(id.model);
      seats.push({
        name: s.name, contributorId: who(s.name), identity: id.key, modelId: id.model, harness: id.harness, effort: id.effort,
        status: !id.listed ? 'unlisted' : id.verification.status === 'mismatch' ? 'mismatch' : 'ok',
        // Checked (PTS-2, points-v3): Checked Against Logs, i.e. harness usage (a usage file or a transcript; for hosted
        // seats, the summary `bench play` or `bench attach-logs` sent afterwards, usage-uploads.ts) that names the declared
        // model. On hosted tables a seat the bench CLI launched with the declared model and effort (effort_basis
        // "launch") counts too, even before its summary arrives. Hand-started seats and uploads count only through their
        // logs: usage without model ids (Self-Reported) or none at all is not a check.
        logs: id.verification.status === 'verified' || (meta.via === 'director' && s.effortBasis === 'launch'),
        explicitEffort: id.effort !== 'unknown' && !!id.effortInfo && id.effortInfo.source !== 'harness-default' && id.effortInfo.source !== 'unknown',
        modelActive: entry?.status === 'active' || entry?.status === 'preview',
        abandoned: ev.forfeits.some((f) => f.seat === s.name),
        games: ev.games.filter((g) => g.over && g.seats.includes(s.name) && g.forfeitedBy !== s.name).length,
        rated: mine.map((g) => (g.seatA === s.name ? { opponent: g.b, won: g.winner === 'a' } : { opponent: g.a, won: g.winner === 'b' })),
        matchWins: st?.matchWins ?? 0, matchLosses: st?.matchLosses ?? 0, gameWins: st?.gameWins ?? 0, gameLosses: st?.gameLosses ?? 0,
      });
    }
    // The Hub's acceptance time (PTS-1). Admin imports (history, disaster recovery) keep their log's end, never later
    // than the import itself, so re-importing old tables doesn't pile them onto one day under the daily cap.
    const acceptedAt = meta.via === 'import' && Number.isFinite(ev.lastT) && ev.lastT > 0 ? Math.min(ev.lastT, meta.acceptedAt) : meta.acceptedAt;
    out.push({
      id: ev.id, acceptedAt, endedAt: ev.lastT, set: ev.set.code.toUpperCase(), setName: ev.set.name, group: groupKey(ev), table,
      ineligible: ev.source.exclude ?? null, testData, seats,
    });
  }
  return { events: out, labels, lobbyShown };
}

export interface IdentityLabel {
  identity: string; identity_label: string; model_id: string; model_display: string; harness_id: string; harness_display: string; effort: string; effort_display: string;
}

/** Whether a contributor appears on the public boards: their account setting, else their latest lobby choice. */
export function isPublic(c: ContributorRecord | undefined, lobby: { shown: boolean } | undefined): boolean {
  if (!c || c.kind !== 'person' || c.status !== 'active') return false;
  if (c.boardVisibility) return c.boardVisibility === 'public';
  return lobby?.shown ?? true;
}

export function readAdminBounties(path: string): AdminBounties | null {
  if (!existsSync(path)) return null;
  try {
    const o = JSON.parse(readFileSync(path, 'utf8')) as AdminBounties;
    return o && o.version === 1 ? o : null;
  } catch (e) {
    console.error(`bounties file ${path} unreadable: ${(e as Error).message}`);
    return null;
  }
}

const iso = (ms: number | null | undefined) => (ms == null || !Number.isFinite(ms) ? null : new Date(ms).toISOString());
/** "Set Context · Manual Mana" from a group key (keys written before 2.13 carry `bo=`, which no label shows). */
const groupText = (g: string) => {
  const p = parseGroupKey(g);
  return groupLabel({ knowledge: p.knowledge, mana: p.mana, prompt_version: p.prompt });
};

/** Everything public, plus what /account needs, from one ledger computation. */
export class ContributorsView {
  readonly generatedAt = new Date().toISOString();
  readonly season: string;
  readonly seasons: string[];
  private seats = new Map<string, PointsSeat>();
  private facts = new Map<string, SeatFacts>();
  private publicIds = new Set<number>();
  private boards = new Map<string, Array<Record<string, unknown> & { rank: number; handle: string; points: number }>>();
  readonly openBounties: Array<Record<string, unknown>>;

  constructor(
    readonly lines: LedgerLine[],
    readonly events: PointsEvent[],
    readonly labels: Map<string, IdentityLabel>,
    readonly contributors: Map<number, ContributorRecord>,
    lobbyShown: Map<number, { at: number; shown: boolean }>,
    admin: AdminBounties | null,
    featuredSets: Array<{ code: string; name?: string }>,
    private highlights: Highlight[] = [],
    now = Date.now(),
  ) {
    for (const ev of events) {
      for (const s of ev.seats) {
        this.seats.set(`${ev.id}|${s.name}`, s);
        const l = labels.get(s.identity);
        this.facts.set(`${ev.id}|${s.name}`, { ev, seat: s, label: l?.identity_label ?? s.identity, display: { model: l?.model_display ?? s.modelId, harness: l?.harness_display ?? s.harness, effort: l?.effort_display ?? s.effort } });
      }
    }
    for (const c of contributors.values()) if (isPublic(c, lobbyShown.get(c.id))) this.publicIds.add(c.id);
    this.season = seasonOf(now);
    this.seasons = [...new Set([this.season, ...lines.map((l) => l.season)])].sort().reverse();
    this.openBounties = openBounties(events, labels, admin, featuredSets, now);
  }

  isPublicId(id: number): boolean {
    return this.publicIds.has(id);
  }

  /** Board rows (public contributors only) for a season id, or "all" for all time. */
  board(scope: string): Array<Record<string, unknown> & { rank: number; handle: string; points: number }> {
    const hit = this.boards.get(scope);
    if (hit) return hit;
    const t = totalsBy(this.lines, this.seats, scope === 'all' ? undefined : (l) => l.season === scope);
    const rows = [...t].filter(([id, x]) => this.publicIds.has(id) && x.seats > 0).map(([id, x]) => this.row(id, x));
    const ranked = rank(rows);
    this.boards.set(scope, ranked);
    return ranked;
  }

  private row(id: number, x: Totals) {
    const c = this.contributors.get(id)!;
    return {
      handle: c.handle, avatar_url: c.avatarUrl, points: x.points, seats: x.seats, seats_finished: x.finished, seats_abandoned: x.abandoned,
      reliability: reliabilityOf(x.finished, x.abandoned), tables: x.tables.size, lobby_seats: x.lobbySeats, games: x.games,
      models: [...x.models].sort((a, b) => b[1] - a[1]).map(([m]) => m), last_played: iso(x.last || null),
    };
  }

  /** A contributor's rank and points in a scope, among public contributors plus them (their own view). */
  standing(id: number, scope: string): { points: number; rank: number | null } {
    const t = totalsBy(this.lines, this.seats, (l) => l.contributorId === id && (scope === 'all' || l.season === scope)).get(id);
    const points = t?.points ?? 0;
    if (!t) return { points, rank: null };
    const ahead = this.board(scope).filter((r) => r.points > points && r.handle !== this.contributors.get(id)?.handle).length;
    return { points, rank: ahead + 1 };
  }

  totals() {
    const t = totalsBy(this.lines, this.seats);
    let points = 0;
    let seats = 0;
    let games = 0;
    const tables = new Set<string>();
    for (const x of t.values()) {
      points += x.points;
      seats += x.seats;
      games += x.games;
      for (const e of x.tables) tables.add(e);
    }
    return { contributors: t.size, public_contributors: [...t.keys()].filter((id) => this.publicIds.has(id)).length, points, seats, tables: tables.size, games };
  }

  file(): Record<string, unknown> {
    return {
      contributors_schema: CONTRIBUTORS_SCHEMA, generated_at: this.generatedAt, scheme: schemeJson(),
      season: seasonInfo(this.season), seasons: this.seasons, totals: this.totals(),
      boards: { season: this.board(this.season).slice(0, BOARD_SIZE), all_time: this.board('all').slice(0, BOARD_SIZE) },
      bounties: this.openBounties,
    };
  }

  idByHandle(handle: string): number | undefined {
    const h = handle.toLowerCase();
    for (const c of this.contributors.values()) if (c.handle === h) return c.id;
    return undefined;
  }

  /** The public profile, or undefined for unknown and hidden contributors. */
  publicProfile(handle: string): Record<string, unknown> | undefined {
    const id = this.idByHandle(handle);
    return id != null && this.publicIds.has(id) && this.lines.some((l) => l.contributorId === id) ? this.profile(id) : undefined;
  }

  profile(id: number): Record<string, unknown> {
    const c = this.contributors.get(id)!;
    const mine = this.lines.filter((l) => l.contributorId === id);
    const t = totalsBy(mine, this.seats).get(id);
    const all = this.standing(id, 'all');
    const season = this.standing(id, this.season);
    const bySeason = [...new Set(mine.map((l) => l.season))].sort().reverse().map((s) => ({ season: s, ...this.standing(id, s) }));
    const facts = mine.map((l) => this.facts.get(`${l.eventId}|${l.seat}`)!).filter(Boolean);
    const tables = new Map<string, TableKindCount>();
    for (const f of facts) tables.set(f.ev.id, f.ev.table);
    // Field: every seat of an identity (everyone's), rated games only.
    const field = new Map<string, { games: number; won: number; seats: number }>();
    for (const ev of this.events) {
      for (const s of ev.seats) {
        const x = field.get(s.identity) ?? { games: 0, won: 0, seats: 0 };
        field.set(s.identity, x);
        x.seats++;
        x.games += s.rated.length;
        x.won += s.rated.filter((r) => r.won).length;
      }
    }
    const agents = new Map<string, { seats: number; events: Set<string>; won: number; lost: number; mw: number; ml: number; swiss: Record<string, number> }>();
    for (const f of facts) {
      const a = agents.get(f.seat.identity) ?? { seats: 0, events: new Set<string>(), won: 0, lost: 0, mw: 0, ml: 0, swiss: { '3-0': 0, '2-1': 0, '1-2': 0, '0-3': 0 } };
      agents.set(f.seat.identity, a);
      a.seats++;
      a.events.add(f.ev.id);
      a.won += f.seat.rated.filter((r) => r.won).length;
      a.lost += f.seat.rated.filter((r) => !r.won).length;
      a.mw += f.seat.matchWins;
      a.ml += f.seat.matchLosses;
      const k = `${f.seat.matchWins}-${f.seat.matchLosses}`;
      if (k in a.swiss) a.swiss[k]!++;
    }
    const rate = (w: number, n: number) => (n ? Math.round((w / n) * 1000) / 1000 : null);
    const keys = new Set(facts.map((f) => `${f.ev.id}|${f.seat.name}`));
    const best = facts.filter((f) => !f.seat.abandoned && f.seat.matchWins > f.seat.matchLosses)
      .sort((a, b) => b.seat.matchWins - a.seat.matchWins || (b.seat.gameWins - b.seat.gameLosses) - (a.seat.gameWins - a.seat.gameLosses) || b.ev.endedAt - a.ev.endedAt)
      .slice(0, 5)
      .map((f) => ({
        event_id: f.ev.id, set: { code: f.ev.set, name: f.ev.setName ?? f.ev.set }, ended_at: iso(f.ev.endedAt), identity_label: f.label,
        matches: `${f.seat.matchWins}-${f.seat.matchLosses}`, games: `${f.seat.gameWins}-${f.seat.gameLosses}`,
      }));
    const recentIds = [...new Set(mine.sort((a, b) => b.at - a.at).map((l) => l.eventId))].slice(0, 20);
    const recent = recentIds.map((eid) => {
      const ls = mine.filter((l) => l.eventId === eid);
      const ev = this.facts.get(`${eid}|${ls[0]!.seat}`)!.ev;
      return {
        event_id: eid, ended_at: iso(ev.endedAt), set: { code: ev.set, name: ev.setName ?? ev.set }, table: ev.table, points: ls.reduce((a, l) => a + l.points, 0),
        seats: ls.map((l) => {
          const f = this.facts.get(`${eid}|${l.seat}`)!;
          return { seat: l.seat, identity_label: f.label, status: f.seat.abandoned ? 'abandoned' : 'finished', matches: f.seat.matchWins + f.seat.matchLosses ? `${f.seat.matchWins}-${f.seat.matchLosses}` : null, points: l.points };
        }),
      };
    });
    const models = new Map<string, number>();
    for (const f of facts) models.set(f.seat.modelId, (models.get(f.seat.modelId) ?? 0) + 1);
    return {
      contributors_schema: CONTRIBUTORS_SCHEMA, generated_at: this.generatedAt, scheme: SCHEME.id,
      handle: c.handle, avatar_url: c.avatarUrl, github_url: c.githubLogin ? `https://github.com/${c.githubLogin}` : null,
      first_played: iso(t?.first ?? null), last_played: iso(t?.last ?? null),
      points: {
        all_time: all.points, rank_all_time: this.publicIds.has(id) ? all.rank : null, season: season.points, rank_season: this.publicIds.has(id) ? season.rank : null,
        season_id: this.season, by_season: bySeason.map((x) => ({ season: x.season, points: x.points, rank: this.publicIds.has(id) ? x.rank : null })),
        from_bounties: Math.round(mine.reduce((a, l) => a + (l.raw > 0 ? (l.bounty * l.reliabilityMult * l.points) / l.raw : 0), 0)),
      },
      contribution: {
        tables: tables.size, lobby_tables: [...tables.values()].filter((k) => k === 'lobby').length, private_tables: [...tables.values()].filter((k) => k === 'private').length,
        seats: t?.seats ?? 0, seats_finished: t?.finished ?? 0, seats_abandoned: t?.abandoned ?? 0, reliability: reliabilityOf(t?.finished ?? 0, t?.abandoned ?? 0),
        games: t?.games ?? 0, rated_games: facts.reduce((a, f) => a + f.seat.rated.length, 0),
      },
      models: [...models].sort((a, b) => b[1] - a[1]).map(([m, n]) => ({ model_id: m, model_display: registry.model(m) ? registry.modelDisplay(m) : m, seats: n })),
      agents: [...agents].sort((a, b) => b[1].seats - a[1].seats).map(([key, a]) => {
        const l = this.labels.get(key);
        const fl = field.get(key) ?? { games: 0, won: 0, seats: 0 };
        const theirs = rate(a.won, a.won + a.lost);
        const all2 = rate(fl.won, fl.games);
        return {
          identity: key, identity_label: l?.identity_label ?? key, model_id: l?.model_id ?? key, model_display: l?.model_display ?? key,
          harness_id: l?.harness_id ?? '', harness_display: l?.harness_display ?? '', effort: l?.effort ?? '', effort_display: l?.effort_display ?? '',
          seats: a.seats, events: a.events.size,
          games: { won: a.won, lost: a.lost, win_rate: theirs },
          matches: { won: a.mw, lost: a.ml }, swiss: a.swiss,
          field: { games: fl.games, win_rate: all2 },
          vs_field_pp: theirs != null && all2 != null && a.won + a.lost >= 10 ? Math.round((theirs - all2) * 1000) / 10 : null,
        };
      }),
      best_finishes: best,
      highlights: this.highlights.filter((h) => keys.has(`${h.event_id}|${h.seat}`)).slice(0, 6),
      recent,
    };
  }

  /** The signed-in contributor's own view (works for hidden contributors too). */
  account(id: number): AccountPoints {
    const mine = this.lines.filter((l) => l.contributorId === id).sort((a, b) => b.at - a.at || (a.seat < b.seat ? -1 : 1));
    const all = this.standing(id, 'all');
    const season = this.standing(id, this.season);
    return {
      public: this.publicIds.has(id), season: seasonInfo(this.season),
      points: { all_time: all.points, rank_all_time: all.rank, season: season.points, rank_season: season.rank },
      lines: mine.slice(0, 50).map((l) => ({ ...l, label: this.facts.get(`${l.eventId}|${l.seat}`)?.label ?? l.identity })),
      abandoned: mine.filter((l) => this.seats.get(`${l.eventId}|${l.seat}`)?.abandoned).slice(0, 20).map((l) => ({ eventId: l.eventId, seat: l.seat, at: l.at, label: this.facts.get(`${l.eventId}|${l.seat}`)?.label ?? l.identity })),
      seats: mine.length,
    };
  }
}

type TableKindCount = 'lobby' | 'private';

export interface AccountPoints {
  public: boolean;
  season: { id: string; label: string };
  points: { all_time: number; rank_all_time: number | null; season: number; rank_season: number | null };
  lines: Array<LedgerLine & { label: string }>;
  abandoned: Array<{ eventId: string; seat: string; at: number; label: string }>;
  seats: number;
}

export function schemeJson(): Record<string, unknown> {
  return {
    id: SCHEME.id, seat: SCHEME.seat, game: SCHEME.game, multipliers: SCHEME.multipliers, no_logs: SCHEME.no_logs, reliability: SCHEME.reliability, repeat: SCHEME.repeat,
    bounties: SCHEME.bounties, bounty_min_rated: SCHEME.bounty_min_rated, needs_games_cap: SCHEME.needs_games_cap, daily_cap: SCHEME.daily_cap, season: SCHEME.season,
  };
}

/** What the data needs most right now: computed from every accepted event, plus the admin file. */
export function openBounties(events: PointsEvent[], labels: Map<string, IdentityLabel>, admin: AdminBounties | null, featured: Array<{ code: string; name?: string }>, now = Date.now()): Array<Record<string, unknown>> {
  const st = finalState(events);
  const off = new Set(admin?.disable ?? []);
  const out: Array<Record<string, unknown>> = [];
  const b = SCHEME.bounties;
  if (!off.has('first_games')) {
    for (const m of REGISTRY_DATA.models) {
      if (m.status !== 'active' && m.status !== 'preview') continue;
      if (st.modelsPlayed.has(m.id)) continue;
      out.push({ id: `first-games:${m.id}`, kind: 'first_games', label: 'First Games', bonus: b.first_games, text: `${m.display} has no rated games yet`, model_id: m.id, model_display: m.display });
    }
  }
  if (!off.has('provisional')) {
    const p = SCHEME.provisional;
    const rows: Array<Record<string, unknown> & { _games: number }> = [];
    for (const [group, ids] of st.needs) {
      for (const [identity, n] of ids) {
        if (!isProvisional(n)) continue;
        const l = labels.get(identity);
        // Only setups the bounty pays for: an active listed model at a known effort (points.ts bountiesFor).
        const m = registry.model(l?.model_id ?? identity.split('/')[0] ?? '');
        if (!(m?.status === 'active' || m?.status === 'preview') || (l?.effort ?? identity.split('/')[1]) === 'unknown') continue;
        rows.push({
          id: `provisional:${group}:${identity}`, kind: 'provisional', label: NEEDS_GAMES, bonus: b.provisional,
          text: `${l?.identity_label ?? identity} needs ${Math.max(0, p.games - n.games)} more rated games in ${groupText(group)}`,
          identity, identity_label: l?.identity_label ?? identity, model_id: l?.model_id, model_display: l?.model_display, group, group_label: groupText(group),
          progress: { games: n.games, games_needed: p.games, events: n.events.size, events_needed: p.events, opponents: n.opponents.size, opponents_needed: p.opponents },
          _games: n.games,
        });
      }
    }
    rows.sort((x, y) => y._games - x._games || String(x.id).localeCompare(String(y.id)));
    for (const { _games, ...r } of rows.slice(0, 30)) out.push(r);
  }
  if (!off.has('new_set')) {
    for (const s of featured) {
      const n = st.setEvents.get(s.code.toUpperCase()) ?? 0;
      if (n >= SCHEME.new_set_events) continue;
      out.push({ id: `new-set:${s.code.toUpperCase()}`, kind: 'new_set', label: 'New Set', bonus: b.new_set, text: n ? `${s.name ?? s.code} has ${n} rated table${n === 1 ? '' : 's'} so far` : `${s.name ?? s.code} has no rated tables yet`, set: s.code.toUpperCase() });
    }
  }
  for (const a of admin?.bounties ?? []) {
    if (a.until && now >= Date.parse(a.until)) continue;
    if (!(a.bonus > 0)) continue;
    out.push({ id: `admin:${a.id}`, kind: 'admin', label: a.label, bonus: Math.min(100, a.bonus), text: a.text ?? a.label, ...(a.match.set ? { set: a.match.set.toUpperCase() } : {}), ...(a.match.model ? { model_id: a.match.model } : {}), until: a.until ?? null });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Database and files

export async function loadInputs(sql: Sql, events: EventData[]): Promise<Inputs> {
  // Acceptance time: when the submission was decided (validated, or approved after review), else received. Both are
  // set by the Hub and never change on a re-ingest, so a recompute is deterministic.
  const subs = await sql`select e.id, s.via, s.contributor_id, coalesce(s.decided_at, s.received_at) as accepted_at from events e join submissions s on s.id = e.submission_id`;
  const meta = new Map<string, SubmissionMeta>(subs.map((r) => [String(r.id), {
    via: r.via as SubmissionMeta['via'], uploader: r.contributor_id == null ? null : Number(r.contributor_id), acceptedAt: new Date(r.accepted_at as Date).getTime(),
  }]));
  const cs = await sql`select id, handle, kind, status, avatar_url, github_login, board_visibility, moderation_hidden from contributors`;
  const contributors = new Map<number, ContributorRecord>(cs.map((r) => [Number(r.id), {
    id: Number(r.id), handle: String(r.handle), kind: String(r.kind), status: String(r.status),
    avatarUrl: typeof r.avatar_url === 'string' && r.avatar_url.startsWith('https://avatars.githubusercontent.com/') ? r.avatar_url : null,
    // A handle moderators hid is hidden whatever the contributor chose (moderation.ts setHandleHidden).
    githubLogin: (r.github_login as string | null) ?? null, boardVisibility: r.moderation_hidden != null ? 'hidden' : (r.board_visibility as 'public' | 'hidden' | null) ?? null,
  }]));
  return { events: events.filter((e) => meta.has(e.id)), meta, contributors };
}

export async function writeLedger(sql: Sql, lines: LedgerLine[]): Promise<void> {
  const rows = lines.map((l) => ({
    event_id: l.eventId, seat: l.seat, contributor_id: l.contributorId, season: l.season, earned_at: new Date(l.at), scheme: SCHEME.id, set_code: l.set,
    table_kind: l.table, identity: l.identity, model_id: l.modelId, status: l.status, games: l.games, rated_games: l.ratedGames, base: l.base,
    table_mult: l.tableMult, repeat_mult: l.repeatMult, reliability_mult: l.reliabilityMult, bounty: l.bounty, bounties: sql.json(l.bounties as any),
    raw: l.raw, capped: l.capped, points: l.points, note: l.note,
  }));
  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext('mtgdt-hub-points'))`;
    await tx`delete from points_ledger`;
    // Only events still in the index (a takedown between loading and writing drops its lines).
    const known = new Set((await tx`select id from events`).map((r) => String(r.id)));
    const keep = rows.filter((r) => known.has(r.event_id));
    for (let i = 0; i < keep.length; i += 300) await tx`insert into points_ledger ${tx(keep.slice(i, i + 300))}`;
  });
}

function featuredSets(setsDir: string): Array<{ code: string; name?: string }> {
  try {
    const o = JSON.parse(readFileSync(join(setsDir, 'rotation.json'), 'utf8')) as { featured?: Array<{ code: string; name?: string }> };
    return (o.featured ?? []).filter((s) => typeof s?.code === 'string');
  } catch {
    return [];
  }
}

function readHighlights(siteDir: string): Highlight[] {
  try {
    const o = JSON.parse(readFileSync(join(siteDir, 'highlights.json'), 'utf8')) as { highlights?: Highlight[] };
    return Array.isArray(o.highlights) ? o.highlights : [];
  } catch {
    return [];
  }
}

export interface ContributorsHost {
  sql: Sql;
  events: Map<string, EventData>;
  siteDir: string;
  cfg: { setsDir: string; bountiesFile: string };
  log: (m: string) => void;
}

/** Unix ms when the season after the one at `ms` starts: 00:00 UTC on the 1st of the next month. */
export function nextSeasonStart(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

/** setTimeout's longest delay (about 24.8 days); a longer wait re-arms. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * Season rollover (LAUNCH-CHECKLIST F-4): the season, its label ("November 2026") and the season board are fixed when
 * the view is built, and the view is rebuilt only when events change. This calls `onRollover` a few seconds after
 * every month boundary (UTC), so the served files show the new season from its first minutes, even with no new
 * table. The timer never keeps the process alive.
 */
export class SeasonClock {
  private timer?: ReturnType<typeof setTimeout>;

  constructor(private onRollover: (season: string) => void, private graceMs = 5_000) {}

  start(now = Date.now()): void {
    this.stop();
    const at = nextSeasonStart(now) + this.graceMs;
    this.timer = setTimeout(() => {
      const t = Date.now();
      if (t >= at) this.onRollover(seasonOf(t));
      this.start(t);
    }, Math.min(Math.max(0, at - now), MAX_TIMER_MS));
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}

/** The Hub's contributors service: one view, rebuilt after every export and at every month boundary. */
export class Contributors {
  view: ContributorsView | null = null;
  private running: Promise<void> | null = null;
  private again = false;
  private clock?: SeasonClock;

  constructor(private host: ContributorsHost) {}

  /** Rebuild at every month boundary (UTC) so the new season shows without waiting for a table (F-4). */
  startSeasonClock(now = Date.now()): void {
    this.clock ??= new SeasonClock((season) => {
      this.host.log(`contributors: season ${season} started; rebuilding the boards`);
      void this.refresh();
    });
    this.clock.start(now);
  }

  stopSeasonClock(): void {
    this.clock?.stop();
  }

  /** The view was built in an earlier month (a missed timer, a sleeping host): the caller should refresh. */
  stale(now = Date.now()): boolean {
    return this.view != null && this.view.season !== seasonOf(now);
  }

  /** Recompute the ledger and the public files. Concurrent calls coalesce. */
  async refresh(opts: { write?: boolean } = {}): Promise<ContributorsView | null> {
    if (this.running) {
      this.again = true;
      await this.running;
      return this.view;
    }
    this.running = (async () => {
      do {
        this.again = false;
        try {
          await this.once(opts.write !== false);
        } catch (e) {
          this.host.log(`contributors refresh failed: ${(e as Error).stack ?? e}`);
          try {
            this.ensureFile();
          } catch {
            // the next refresh tries again
          }
        }
      } while (this.again);
    })().finally(() => {
      this.running = null;
    });
    await this.running;
    return this.view;
  }

  /** Who is public right now (account setting, else latest lobby choice), read fresh: the export names only them. */
  async publicIds(): Promise<Set<string>> {
    return publicContributorIds(await loadInputs(this.host.sql, [...this.host.events.values()]));
  }

  /** Compute without writing anything (`hub points recompute --dry-run`). */
  async compute(): Promise<ContributorsView> {
    const inp = await loadInputs(this.host.sql, [...this.host.events.values()]);
    const { events, labels, lobbyShown } = pointsEvents(inp);
    const admin = readAdminBounties(this.host.cfg.bountiesFile);
    const lines = computeLedger(events, admin);
    return new ContributorsView(lines, events, labels, inp.contributors, lobbyShown, admin, featuredSets(this.host.cfg.setsDir), readHighlights(this.host.siteDir));
  }

  private async once(write: boolean): Promise<void> {
    const t0 = Date.now();
    const view = await this.compute();
    if (write) {
      await writeLedger(this.host.sql, view.lines);
      this.writeFiles(view);
    }
    this.view = view;
    this.host.log(`contributors: ${view.lines.length} ledger line(s), ${view.board('all').length} public contributor(s) in ${Date.now() - t0} ms`);
  }

  /**
   * contributors.json always exists, so the site never gets a 404: before the first computation (and if it fails
   * on a fresh Hub) it is an empty board with the rules and the open bounties.
   */
  ensureFile(): void {
    if (existsSync(join(this.host.siteDir, 'contributors.json'))) return;
    const empty = new ContributorsView([], [], new Map(), new Map(), new Map(), readAdminBounties(this.host.cfg.bountiesFile), featuredSets(this.host.cfg.setsDir));
    putJson(this.host.siteDir, 'contributors.json', empty.file());
  }

  private writeFiles(view: ContributorsView): void {
    const root = this.host.siteDir;
    const put = (rel: string, data: unknown) => putJson(root, rel, data);
    put('contributors.json', view.file());
    const keep = new Set<string>();
    for (const row of view.board('all')) {
      if (!HANDLE_RE.test(row.handle)) continue;
      const p = view.publicProfile(row.handle);
      if (!p) continue;
      put(`contributors/${row.handle}.json`, p);
      keep.add(`${row.handle}.json`);
    }
    // Contributors who hid their handle (or were taken down) lose their file.
    const dir = join(root, 'contributors');
    if (existsSync(dir)) for (const f of readdirSync(dir)) if (!keep.has(f)) rmSync(join(dir, f), { force: true });
  }
}

/** Write a JSON file under the served tree atomically (temp file, then rename). */
function putJson(root: string, rel: string, data: unknown): void {
  const full = join(root, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  const tmp = `${full}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(data));
  renameSync(tmp, full);
}
