import { randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BoosterFactory, type PackCard } from './boosters.js';
import { askForDeck, autoBuild, BuiltDeck } from './build.js';
import { CardDb } from './cards.js';
import { Draft } from './draft.js';
import {
  deckFromLog, gameResume, readKnowledge, repairLog, type EventCheckpoint, type ResumeLog, writeCheckpoint, writeKnowledge,
} from './durable.js';
import { Game, GameResult, GameSession, GameVoidError, ManaMode } from './game.js';
import { Knowledge, KnowledgeLevel, loadKnowledge, PrimerSources, splitSetContext } from './knowledge.js';
import { observationFormat, setDocName } from './observation.js';
import { promptsHash, promptVersionOf } from './prompts.js';
import { PAIRING_VERSIONS, pairingSeat, pairRound, plan, type MatchOutcome, type PairingFormat, type PairingPlan, type RoundPairing } from './pairings.js';
import { provenance, type BoosterProvenance } from './provenance.js';
import { Ratings } from './ratings.js';
import { Rng } from './rng.js';
import { AgentSeat, type Offer } from './seat.js';
import { askPlayDraw, askSideboard, deckData, deckFromSideboardLog, deckOf, nextChooser, seededStarter, type MatchDeck } from './sideboard.js';
import { Spectator } from './spectate.js';
import { DEFAULT_SPECTATE_POLICY, type SpectatePolicy } from './spectate-policy.js';

export interface EventConfig {
  set: string;
  /** Internal names for the agent seats (never shown to other agents). */
  agents: string[];
  seed?: string;
  podSize?: number;
  /** Games per match: a match is best-of-N. */
  bestOf?: number;
  phaseUrl: string;
  runsDir: string;
  setsDir: string;
  promptsDir: string;
  /** What agents may know (default none). */
  knowledge?: KnowledgeLevel;
  /** Where to fetch set primers from (default: mtgdecktools.com, cached under data/). */
  primerSources?: PrimerSources;
  /** Who chooses which mana sources pay for spells (default manual: the agent). */
  mana?: ManaMode;
  /** Optional per-agent metadata (harness, model, effort, prompt version) for logs and reports. */
  agentMeta?: Record<string, Record<string, string>>;
  /** What live spectators may see, and when (docs/SPECTATING.md). */
  spectate?: SpectatePolicy;
  /** The exact booster data the BoosterFactory was built from (logged so the Hub can regenerate the packs). */
  boosters?: BoosterProvenance;
  /**
   * Inactivity forfeit (SEAT_TIMEOUT_MS, default 10 min; 0 = off): a seat with an open decision that has made no
   * MCP request for this long has the decision settled for it (draft: bot pick; deck: reference build; game:
   * conceded). Before a seat's first request the limit is seatConnectTimeoutMs (default 30 min), so a seat
   * that is being connected by hand isn't forfeited while the draft starts.
   */
  seatTimeoutMs?: number;
  seatConnectTimeoutMs?: number;
  /**
   * Fields logged with event_start beyond the request: who organized the event (hosted play) and where the
   * seat metadata comes from (`self-reported` for contributor events).
   */
  startExtras?: Record<string, unknown>;
  /** How matches are paired (docs/METHODOLOGY.md §3): a 3-round Swiss (default) or a round robin (Private Tables). */
  pairing?: PairingFormat;
  /** Swiss rounds (default 3; capped at half the table so no rematch is ever needed). */
  swissRounds?: number;
  /**
   * Dev only (`--dev-bot-fill`, engine testing): bot drafters fill the seats agents don't. Product events need an
   * agent in every seat; a dev event logs `dev_bot_fill: true`, is labeled Smoke and is never rated or accepted
   * by the Hub.
   */
  devBotFill?: boolean;
  /**
   * Pause before each replay of a voided game, by void number (1st, 2nd, 3rd): the engine may be restarting, so later
   * replays wait longer. Default REPLAY_DELAYS_MS; tests pass zeros.
   */
  replayDelaysMs?: number[];
  /**
   * After a resume, a seat that hasn't made a request since the restart gets at least this long before the watchdog
   * settles its decisions (its harness may still be waiting out the deploy). Default DEFAULT_RESUME_GRACE_MS.
   */
  resumeGraceMs?: number;
  /** True while the watchdog must not forfeit anyone (the server is shutting down or restarting). */
  watchdogPaused?: () => boolean;
}

/** An event without enough agent seats (every product event seats 8 agents; bots are dev-only). */
export class SeatsRequired extends Error {}

/** Restoring an event after a restart: its id and seat tokens from the checkpoint (durable.ts). */
/**
 * Who stopped an event (event_abort.by): its organizer (the owner of a Private Table, with their token), an admin who
 * isn't the organizer, or the server itself (time limit, nobody connected, a failed resume).
 */
export type AbortedBy = 'organizer' | 'admin' | 'system';

export interface EventRestore {
  id: string;
  tokens: Record<string, string>;
}

/** report_rules_issue reports logged per seat per event. */
const MAX_REPORTS = 50;

/**
 * How often one game may be voided (engine failure, lost reconnect, or a game the engine couldn't start) and replayed
 * before its match ends with no result (METHODOLOGY §3.2, "No result").
 */
export const MAX_VOIDS_PER_GAME = 3;
/** Pause before the 1st, 2nd and 3rd replay of a voided game (an engine restart takes a minute or two). */
export const REPLAY_DELAYS_MS = [2_000, 30_000, 120_000];
/**
 * The watchdog's minimum for a seat that hasn't called since a resume: the bench CLI waits out a deploy for up to 10
 * minutes (DIRECTOR_DOWN_MAX_MS in scripts/bench/core.ts) before it relaunches a seat, and the harness needs a moment.
 */
export const DEFAULT_RESUME_GRACE_MS = 15 * 60_000;

export const DEFAULT_SEAT_TIMEOUT_MS = 10 * 60_000;
export const DEFAULT_SEAT_CONNECT_TIMEOUT_MS = 30 * 60_000;

/**
 * Add one game's cards seen (name → copies) to a seat's match memory: the most copies of a name seen in any one game
 * (the same deck plays every game of a match, so a card seen in two games may be the same copy).
 */
export function mergeSeen(mem: Record<string, number>, game: unknown): void {
  if (!game || typeof game !== 'object') return;
  for (const [name, n] of Object.entries(game as Record<string, unknown>)) {
    if (typeof n === 'number' && Number.isInteger(n) && n > 0) mem[name] = Math.max(mem[name] ?? 0, n);
  }
}

export interface MatchResult {
  a: string;
  b: string;
  wins: Record<string, number>;
  games: Array<GameResult & { label: string; winnerName: string | null }>;
  /**
   * The match couldn't be finished (a game voided more than MAX_VOIDS_PER_GAME times): no result. It is neither won,
   * lost nor drawn, gives no match points, and its unfinished game is never scored; its finished games stand.
   */
  noResult?: string;
}

/**
 * A pod: 8-seat booster draft → each agent builds a deck → rounds of matches (3-round Swiss by default, paired
 * as each round ends; pairings.ts). One AgentSeat per agent persists through every stage. Bot drafters only
 * exist in dev events (`devBotFill`) and as the watchdog's policy for a silent seat.
 */
export class Event {
  readonly id: string;
  readonly seats: AgentSeat[];
  readonly dir: string;
  readonly seed: string;
  private rng: Rng;
  private ratings: Ratings;
  knowledge: Knowledge;
  decks = new Map<string, BuiltDeck>();
  /** Each seat's draft pool, by table position (sideboarding draws on it). */
  private pools: PackCard[][] = [];
  /**
   * Best of 3 with sideboarding and the loser's play/draw choice (sideboard.ts). Every event from 2026-10-22 on; an event
   * that started before (resumed after an upgrade) finishes the way it began.
   */
  private sideboarding = true;
  matches: MatchResult[] = [];
  stage: 'created' | 'draft' | 'build' | 'games' | 'done' = 'created';
  /** The sanitized live view for spectators, fed from every log record. */
  readonly spectator: Spectator;
  /** How matches are paired and how many rounds there are (logged in event_start.pairing). */
  readonly plan: PairingPlan;
  /** The rounds paired so far (a Swiss round is paired when the previous one has finished). */
  readonly rounds: RoundPairing[] = [];
  /** Index of the round being played (-1 before the games). */
  private round = -1;
  /** Seats whose match is in progress. */
  private playing = new Set<string>();
  /** Each seat's match per round: `${round}|${seat}`. */
  private roundMatches = new Map<string, MatchResult>();
  /** Inactivity forfeits per seat (for the final message). */
  private forfeits = new Map<string, Array<{ stage: string; game?: string }>>();
  private startedAt = Date.now();
  /** Set when the event was stopped for good (max duration, abandoned, canceled): the reason. */
  aborted?: string;
  /** The set as event_start logged it (for a stopped event's summary.json). */
  private setInfo?: ReturnType<BoosterFactory['set']>;
  /** Games that reached game_over (this process and, after a restart, the log). */
  private gamesOver = 0;
  /** The private checkpoint (server mode): owner, request, tokens, live game sessions. Undefined: not durable. */
  checkpoint?: EventCheckpoint;
  /** What the log says happened before a restart (set by resumeFrom). */
  private resume?: ResumeLog;
  /** Games in progress (to abandon them on abort) and their reconnect credentials (checkpointed). */
  private liveGames = new Set<Game>();
  private sessions = new Map<string, GameSession & { on_play?: string }>();
  private watchdog?: ReturnType<typeof setInterval>;
  /** report_rules_issue calls per seat. */
  private reports = new Map<string, number>();
  /** When this process resumed the event after a restart (the watchdog's resume grace counts from here). */
  private resumedAt?: number;

  constructor(private cfg: EventConfig, private factory: BoosterFactory, private cards: CardDb, restore?: EventRestore) {
    const set = cfg.set.toLowerCase();
    // The seed regenerates every pack, so a default one must not be guessable from the event id (spectators
    // who see one released round could otherwise brute-force it and see the packs still to come).
    this.seed = cfg.seed ?? `${set}-${Date.now()}-${randomBytes(4).toString('hex')}`;
    // Timestamp + set + random suffix: several events can start in the same second (server mode).
    this.id = restore?.id ?? `${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}-${set}-${randomBytes(2).toString('hex')}`;
    this.rng = new Rng(this.seed);
    // Bot drafters and the reference builder: 17Lands win rates where the set has them, else the card-quality heuristic.
    // Pinned per event (runs/<id>/ratings-17lands.json), so a 17Lands refresh never changes a running or resumed event.
    this.ratings = new Ratings(cfg.setsDir, set, { cards, pin: join(cfg.runsDir, this.id, 'ratings-17lands.json') });
    this.knowledge = { level: cfg.knowledge ?? 'none', stats: cfg.knowledge === 'primer+stats' };
    const podSize = Math.max(cfg.podSize ?? 8, cfg.agents.length);
    if (cfg.agents.length < podSize && !cfg.devBotFill) {
      throw new SeatsRequired(`an event needs an agent in each of its ${podSize} seats (got ${cfg.agents.length}); bot drafters are for dev testing only (--dev-bot-fill)`);
    }
    // Agents get random seats around the table (bots fill the rest in dev events). The Hub replays this shuffle to
    // verify the packs: changing it means bumping BOOSTER_GENERATOR (provenance.ts).
    const positions = this.rng.shuffle([...Array(podSize).keys()]);
    const agentAt = new Map(cfg.agents.map((name, i) => [positions[i]!, name]));
    this.seats = [...Array(podSize).keys()].map((i) => (agentAt.has(i)
      ? new AgentSeat(agentAt.get(i)!, i, 'agent', restore?.tokens[agentAt.get(i)!])
      : new AgentSeat(`bot-${i + 1}`, i, 'bot')));
    this.dir = join(cfg.runsDir, this.id);
    mkdirSync(this.dir, { recursive: true });
    this.spectator = new Spectator(this.id, cfg.spectate ?? DEFAULT_SPECTATE_POLICY);
    this.plan = plan(cfg.pairing ?? 'swiss', this.agents.length, cfg.swissRounds);
    for (const s of this.agents) {
      s.statusNote = () => this.progressNote(s);
      s.onPending = (offer, done) => {
        this.spectator.seatPending(s.name, offer, done);
        // A seat already found inactive: settle its next decision right away instead of at the next watchdog tick.
        if (offer && s.inactive) setTimeout(() => this.checkIdle(), 0);
      };
      s.reportIssue = (card, note) => {
        // At most MAX_REPORTS per seat, so reports can't inflate the logs and exports (DIR-13).
        const n = (this.reports.get(s.name) ?? 0) + 1;
        this.reports.set(s.name, n);
        if (n > MAX_REPORTS) return `Report limit reached (${MAX_REPORTS} per event): this one was not logged. Carry on with your decision.`;
        const ctx = s.views?.context?.();
        this.log('rules_issue', { seat: s.name, card, note, stage: this.stage, ...(ctx ? { game: ctx.game, turn: ctx.turn } : {}) });
        return 'Thanks: your report is logged for us to check. It does not change the game; carry on with your decision.';
      };
      // Every harness session after the first (a relaunch, or bench play --fresh-session at a game or match boundary).
      s.onSessionStart = (session, resumed) => {
        if (session > 1) this.log('seat_session', { seat: s.name, session, resumed, stage: this.stage, games_finished: s.gamesFinished, matches_finished: s.matchesFinished });
      };
      s.onSetContextReminder = (session, decision) => this.log('set_context_reminder', { seat: s.name, session, decision, games_finished: s.gamesFinished });
    }
  }

  /**
   * Async setup before run(): fetch the set primer etc. A durable event keeps what it fetched (knowledge.json),
   * so after a restart its seats get the same briefing and primer, not a newer one.
   */
  async prepare(): Promise<void> {
    const kept = this.checkpoint ? readKnowledge(this.dir) : undefined;
    if (kept) {
      this.knowledge = kept;
      return;
    }
    this.knowledge = await loadKnowledge(this.cfg.knowledge ?? 'none', this.cfg.set.toLowerCase(), this.cfg.setsDir, this.cfg.promptsDir, this.cfg.primerSources);
    if (this.checkpoint) writeKnowledge(this.dir, this.knowledge);
  }

  /** Write the checkpoint (server mode only): live game sessions and seat activity. Never throws. */
  persist(): void {
    const cp = this.checkpoint;
    if (!cp) return;
    cp.games = Object.fromEntries(this.sessions);
    for (const s of this.agents) {
      const prev = cp.seats[s.name] ?? {};
      cp.seats[s.name] = { seen: prev.seen || s.lastActivity != null, ...(s.inactive ? { inactive: true } : {}) };
    }
    try {
      writeCheckpoint(this.dir, cp);
    } catch (err) {
      console.error(`checkpoint ${this.id}: ${String((err as Error)?.message ?? err)}`);
    }
  }

  /**
   * Prepare to continue after a restart: repair and read the log, rebuild the spectator view from it, and
   * restore what the seats had (decision ids, watchdog state). run() then replays what is logged and carries on.
   */
  resumeFrom(log: ResumeLog): void {
    this.resume = log;
    this.gamesOver = log.records.filter((r) => r.type === 'game_over').length;
    for (const r of log.records) {
      try {
        this.spectator.ingest(r);
      } catch {
        // the spectator view must never stop an event
      }
    }
    const cp = this.checkpoint;
    for (const [label, sess] of Object.entries(cp?.games ?? {})) this.sessions.set(label, sess);
    for (const f of log.forfeits) {
      const list = this.forfeits.get(f.seat) ?? [];
      list.push({ stage: f.stage, game: typeof f.game === 'string' ? f.game : undefined });
      this.forfeits.set(f.seat, list);
    }
    const now = Date.now();
    this.resumedAt = now;
    for (const s of this.agents) {
      s.resumeIds(log.lastIds.get(s.name) ?? 0);
      const st = cp?.seats[s.name];
      // A seat that was playing before the restart gets the normal timeout from now; one that never connected
      // keeps the connect grace; one the watchdog had forfeited stays forfeited until it calls again.
      if (st?.seen || log.active.has(s.name)) {
        s.lastActivity = now;
        // It read its briefing before the restart: a later new session of it gets the resume briefing.
        s.briefed = true;
      }
      if (st?.inactive) s.inactive = true;
    }
  }

  /** Repair a log cut mid-line before reading it to resume (durable.ts). */
  static repair(dir: string): number {
    return repairLog(join(dir, 'events.jsonl'));
  }

  /**
   * Stop the event for good (max duration, abandoned, canceled by its owner or an admin): log event_abort, end
   * running games without a result, and tell every seat. Nothing is handed to the Hub; the run() promise never settles.
   */
  abort(reason: string, message: string, by: AbortedBy = 'system'): void {
    if (this.aborted || this.stage === 'done') return;
    this.aborted = reason;
    // Who stopped it and the games still being played (METHODOLOGY §3.2, "Stopped events"): finished games stay
    // results and are rated; open games are void, except that an organizer who stops their table forfeits the open
    // games of their own seats against seats that aren't theirs.
    const open = [...this.liveGames].map((g) => ({ game: g.label, seats: g.seatNames }));
    this.log('event_abort', { reason, stage: this.stage, by, open_games: open, completed_games: this.completedGames });
    if (this.watchdog) clearInterval(this.watchdog);
    for (const g of this.liveGames) g.abandon();
    this.liveGames.clear();
    this.sessions.clear();
    // The results so far, for the Hub hand-off (bundle.ts needs summary.json): a stopped event's finished games count.
    if (this.completedGames > 0 && this.setInfo) {
      writeFileSync(join(this.dir, 'summary.json'), JSON.stringify({
        id: this.id, set: this.setInfo, seed: this.seed, standings: this.standings(), matches: this.matches, stopped: { reason, by, stage: this.stage },
      }, null, 1));
    }
    const scored = this.completedGames > 0 ? 'Games that already finished still count; games that were still being played do not.' : 'No game had finished, so nothing from this event is scored.';
    for (const s of this.agents) s.finish(`EVENT COMPLETE. ${message} ${scored} You can stop now.`);
  }

  /** Games with a result so far (game_over logged), resumed ones included. */
  get completedGames(): number {
    return this.gamesOver;
  }

  /** Every agent seat has made at least one MCP request (now or before a restart). */
  get anySeatSeen(): boolean {
    return this.agents.some((s) => s.lastActivity != null || this.checkpoint?.seats[s.name]?.seen || this.resume?.active.has(s.name));
  }

  /**
   * Awaited before a new game starts (not before resuming one): the server holds new games while it drains for a
   * deploy, so running games finish and nothing new begins.
   */
  beforeGame?: (seats: AgentSeat[]) => Promise<void>;

  /** Games being played right now. */
  get liveGameCount(): number {
    return this.liveGames.size;
  }

  /** When the event started playing (admission), for the max-duration limit. */
  get started(): number {
    return this.startedAt;
  }

  get agents(): AgentSeat[] {
    return this.seats.filter((s) => s.kind === 'agent');
  }

  seatByToken(token: string): AgentSeat | undefined {
    return this.agents.find((s) => s.token === token);
  }

  log = (type: string, data: Record<string, unknown>): void => {
    const record = { t: Date.now(), type, ...data };
    if (type === 'game_over') this.gamesOver++;
    appendFileSync(join(this.dir, 'events.jsonl'), JSON.stringify(record) + '\n');
    try {
      this.spectator?.ingest(record);
    } catch (err) {
      // The spectator view must never take an event down.
      console.error(`spectator: ${String((err as Error)?.stack ?? err)}`);
    }
  };

  async run(): Promise<void> {
    const timeout = this.seatTimeoutMs;
    this.watchdog = timeout > 0 ? setInterval(() => this.checkIdle(), Math.min(5_000, Math.max(250, timeout / 4))) : undefined;
    this.watchdog?.unref();
    try {
      await this.runStages();
    } finally {
      if (this.watchdog) clearInterval(this.watchdog);
    }
  }

  private get seatTimeoutMs(): number {
    return this.cfg.seatTimeoutMs ?? DEFAULT_SEAT_TIMEOUT_MS;
  }

  /**
   * The inactivity watchdog: settle the open decision of any seat that has made no MCP request for the timeout
   * (counted from its last request or from when the decision opened, whichever is later), and every later
   * decision of that seat at once until it makes a request again.
   */
  checkIdle(now = Date.now()): void {
    const timeout = this.seatTimeoutMs;
    if (!(timeout > 0) || this.stage === 'done' || this.aborted) return;
    // Paused while the server shuts down or restarts: seats can't reach it then, so their silence means nothing.
    if (this.cfg.watchdogPaused?.()) return;
    // Hosted: if no seat ever connected, the server stops the event as abandoned instead of letting it play itself.
    if (this.checkpoint && !this.anySeatSeen) return;
    const connect = Math.max(timeout, this.cfg.seatConnectTimeoutMs ?? DEFAULT_SEAT_CONNECT_TIMEOUT_MS);
    const resumeGrace = Math.max(timeout, this.cfg.resumeGraceMs ?? DEFAULT_RESUME_GRACE_MS);
    for (const s of this.agents) {
      const o = s.pending;
      if (!o?.forfeit || o.answering || s.done || s.busy) continue;
      const last = s.lastActivity ?? this.startedAt;
      // After a resume, a seat that hasn't called since gets the resume grace: its CLI may still be waiting out the
      // deploy (and its harness restarting). The restart itself is never held against a seat.
      const sinceResume = this.resumedAt != null && last <= this.resumedAt;
      const limit = s.lastActivity == null ? connect : sinceResume ? resumeGrace : timeout;
      if (!s.inactive && now - Math.max(last, o.createdAt) < limit) continue;
      this.forfeit(s, o, now - last);
    }
  }

  private forfeit(s: AgentSeat, o: Offer, idleMs: number): void {
    const first = !s.inactive;
    s.inactive = true;
    const stage = o.phase;
    const details = o.forfeit!();
    this.log('forfeit', { seat: s.name, stage, reason: 'inactive', idle_ms: idleMs, decision: o.id, kind: o.kind, ...details });
    const list = this.forfeits.get(s.name) ?? [];
    list.push({ stage, game: typeof details.game === 'string' ? details.game : undefined });
    this.forfeits.set(s.name, list);
    const mins = Math.round(this.seatTimeoutMs / 60_000) || 1;
    if (first) {
      s.notify(`You made no call for over ${mins} minute${mins === 1 ? '' : 's'} with a decision open, so the Director is playing for you: draft picks are made by the bot policy, your deck by the reference builder, between games you keep your deck (and play first if the choice is yours), and open games are conceded. This stops as soon as you call wait_for_decision again. Keep calling it until EVENT COMPLETE.`);
    }
    if (stage === 'game') s.notify(`Game ${details.game_number} of your match was conceded for you (no call for ${mins}+ minute${mins === 1 ? '' : 's'} with a decision open). The match goes on.`);
  }

  private async runStages(): Promise<void> {
    this.startedAt = Date.now();
    const set = this.cfg.set.toLowerCase();
    const info = this.factory.set(set);
    this.setInfo = info;
    const resume = this.resume;
    if (resume?.started) return this.resumeStages(info, resume);
    this.log('event_start', {
      id: this.id, set: info, seed: this.seed, seats: this.seats.map((s) => ({ name: s.name, kind: s.kind, position: s.index, ...(this.cfg.agentMeta?.[s.name] ?? {}) })),
      ...(this.cfg.boosters ? { boosters: this.cfg.boosters } : {}),
      seat_timeout_ms: this.seatTimeoutMs, ...(this.cfg.startExtras ?? {}),
      pairing: this.plan, ...(this.seats.some((s) => s.kind === 'bot') ? { dev_bot_fill: true } : {}),
      // Agents in request order: agent i sits at the seed's positions[i], which the Hub checks seat by seat.
      agent_order: this.cfg.agents,
      mana: this.cfg.mana ?? 'manual', prompt_version: promptVersionOf(this.cfg.promptsDir), prompt_sha256: promptsHash(this.cfg.promptsDir), provenance: provenance(this.cards.provenance()),
      best_of: this.cfg.bestOf ?? 3, sideboarding: true, play_draw: 'loser-chooses', ratings: this.ratings.source, ...(this.ratings.snapshot ? { ratings_snapshot: this.ratings.snapshot } : {}),
      knowledge: {
        level: this.knowledge.level, fundamentals: !!this.knowledge.fundamentals, primer: this.knowledge.primerSource ?? false, guide: !!this.knowledge.guide,
        stats: this.knowledge.stats, warning: this.knowledge.warning, ...(this.knowledge.requested ? { requested: this.knowledge.requested } : {}),
      },
    });
    for (const s of this.agents) {
      this.equipSeat(s, info.name);
      // The briefing: the format and the Limited fundamentals, and where to read the Set Context (in parts, so no
      // result is too long for a harness to show).
      s.brief(this.briefing(info.name, 'welcome'));
    }
    await this.playStages(set, info);
  }

  /** After a restart: say so, then replay what the log has and carry on from there. */
  private async resumeStages(info: ReturnType<BoosterFactory['set']>, resume: ResumeLog): Promise<void> {
    const n = (this.checkpoint?.resumes ?? 0) + 1;
    if (this.checkpoint) this.checkpoint.resumes = n;
    this.sideboarding = resume.records.find((e) => e.type === 'event_start')?.sideboarding === true;
    this.log('event_resume', {
      resume: n, downtime_ms: Math.max(0, Date.now() - resume.lastT), draft_ended: resume.draftEnded, build_ended: resume.buildEnded,
      games_in_progress: Object.keys(this.checkpoint?.games ?? {}),
      // What runs from here on (an upgrade may have changed it since event_start.provenance): games after this point
      // are played on this engine build and card data.
      provenance: provenance(this.cards.provenance()),
    });
    for (const s of this.agents) {
      this.equipSeat(s, info.name);
      s.notify(`The Director restarted and your ${info.name} event has resumed where it was: nothing you decided is lost. A decision you had open is offered again with a new id. Keep calling wait_for_decision until EVENT COMPLETE.`);
    }
    await this.playStages(this.cfg.set.toLowerCase(), info);
  }

  private async playStages(set: string, info: ReturnType<BoosterFactory['set']>): Promise<void> {
    const resume = this.resume;
    this.stage = 'draft';
    const draft = new Draft(set, this.factory, this.cards, this.ratings, this.seats, this.rng, this.log, this.knowledge, 3, resume?.draft);
    const pools = await draft.run();
    this.pools = pools;

    if (!resume?.draftEnded) this.log('draft_end', {});
    this.stage = 'build';
    for (const s of this.seats.filter((x) => x.kind === 'bot')) this.decks.set(s.name, autoBuild(pools[s.index]!, this.ratings, this.cards));
    await Promise.all(this.agents.map(async (s) => {
      const logged = resume?.decks.get(s.name);
      this.decks.set(s.name, logged ? deckFromLog(logged, pools[s.index]!) : await askForDeck(s, pools[s.index]!, this.cards, this.ratings, this.knowledge, this.log));
      s.deckLocked = true;
    }));

    if (!resume?.buildEnded) this.log('build_end', {});
    this.stage = 'games';
    const agents = this.agents;
    const byName = new Map(agents.map((s) => [s.name, s]));
    // Each round is paired when the previous one has finished (Swiss: from the results so far). After a restart
    // the rounds already paired come from the log, so seats keep the opponents they were given.
    // A resumed event keeps the pairing version its event_start logged (a deploy may have brought a newer one), so the
    // rounds still to pair follow the rule the event began with and the Hub verifies them against it.
    const startPairing = (this.resume?.records ?? []).find((e) => e.type === 'event_start')?.pairing as { version?: unknown } | undefined;
    const pairingPlan: PairingPlan = typeof startPairing?.version === 'number' && PAIRING_VERSIONS.includes(startPairing.version) ? { ...this.plan, version: startPairing.version } : this.plan;
    const seats = agents.map((s) => pairingSeat(s.name, this.cfg.agentMeta?.[s.name], pairingPlan.version));
    const logged = new Map((this.resume?.records ?? []).filter((e) => e.type === 'round_start').map((e) => [Number(e.round), e]));
    const bo = this.cfg.bestOf ?? 3;
    for (let r = 1; r <= this.plan.rounds && !this.aborted; r++) {
      const results: MatchOutcome[] = this.matches.map(({ a, b, wins, noResult }) => ({ a, b, wins, ...(noResult ? { no_result: true } : {}) }));
      const prev = logged.get(r);
      const pairing: RoundPairing = prev
        ? { round: r, pairs: prev.pairs as Array<[string, string]>, byes: (prev.byes as string[]) ?? [] }
        : pairRound(pairingPlan, seats, this.seed, r, this.rounds, results);
      if (!prev) this.log('round_start', { round: r, rounds: this.plan.rounds, format: this.plan.format, pairs: pairing.pairs, byes: pairing.byes });
      this.rounds.push(pairing);
      this.round = r - 1;
      for (const name of pairing.byes) byName.get(name)?.setStatus(`You have no match in round ${r} of ${this.plan.rounds} (a bye).`);
      // A bye in the last round: nothing more for that seat.
      if (r === this.plan.rounds) for (const name of pairing.byes) this.seatDone(byName.get(name));
      for (const name of pairing.pairs.flat()) {
        if (!prev) byName.get(name)?.notify(`Round ${r} of ${this.plan.rounds}: your best-of-${bo} match against another agent is starting.`);
      }
      await Promise.all(pairing.pairs.map(([a, b]) => this.playMatch(byName.get(a)!, byName.get(b)!, r - 1)));
    }

    if (this.aborted) return;
    this.stage = 'done';
    const standings = this.standings();
    this.log('event_end', { standings, matches: this.matches.map(({ a, b, wins, noResult }) => ({ a, b, wins, ...(noResult ? { no_result: true } : {}) })) });
    writeFileSync(join(this.dir, 'summary.json'), JSON.stringify({ id: this.id, set: info, seed: this.seed, standings, matches: this.matches }, null, 1));
    for (const s of agents) s.finish(this.finalText(s));
  }

  /** What every seat carries for its MCP tools: the Set Context (whole and in parts), the format, the resume briefing. */
  private equipSeat(s: AgentSeat, setName: string): void {
    const k = this.knowledge;
    s.primer = k.primer;
    s.primerParts = k.primer ? splitSetContext(k.primer) : undefined;
    s.observation = observationFormat(this.cfg.promptsDir);
    // Set Context levels: each harness session reads it before its first game decision (seat.ts setContextGate).
    s.setContextRequired = s.primerParts?.length ? { tool: setDocName(s.observation).tool, parts: s.primerParts.length } : undefined;
    s.formatLine = `a booster draft, then deckbuilding, then ${this.matchesSentence(false)}`;
    s.resumeBriefing = () => this.briefing(setName, 'resume', s);
  }

  /**
   * The briefing: the event's format, the Limited fundamentals, and how to read the Set Context (never inline: at
   * up to 56 KB it would make the result too long for harnesses to show). 'resume' is for a new harness session of a
   * seat that was briefed before (a relaunch): it also says where the event stands.
   */
  private briefing(setName: string, kind: 'welcome' | 'resume', seat?: AgentSeat): string {
    const k = this.knowledge;
    const doc = setDocName(observationFormat(this.cfg.promptsDir));
    const n = this.seats.length;
    const format = `This event is ${/^(8|11|18)/.test(String(n)) ? 'an' : 'a'} ${n}-player ${setName} booster draft, then deckbuilding, then ${this.matchesSentence()}.`;
    const stats = k.stats ? ' Cards in packs and in your pool show 17Lands human win-rate data (GIH WR = win rate when drawn; ATA = average pick taken).' : '';
    const parts = k.primer ? splitSetContext(k.primer).length : 0;
    const name = doc.lower === 'set context' ? 'Set Context' : 'set primer';
    const read = parts === 1 ? `call ${doc.tool}()` : `call ${doc.tool}(part=1), then ${Array.from({ length: parts - 1 }, (_, i) => `part=${i + 2}`).join(' and ')}`;
    const context = k.primer
      ? `${doc.title}: this event includes the MTG Deck Tools ${name} for ${setName} (archetypes, lanes, curve and land advice)${parts > 1 ? `, in ${parts} parts` : ''}. ${kind === 'welcome' ? 'Read it now, before your first pick' : 'Read it again before you go on'}: ${read}.`
      : '';
    const fundamentals = k.fundamentals ? `===== LIMITED FUNDAMENTALS (MTG Deck Tools) =====\n${k.fundamentals.trim()}\n===== END FUNDAMENTALS =====` : '';
    const head = kind === 'welcome'
      ? `Welcome. ${format}${stats}`
      : `You are continuing this event in a new session; nothing you decided is lost. ${this.whereNow(seat)} Your briefing again: ${format}${stats}`;
    return [head, fundamentals, context].filter(Boolean).join('\n\n');
  }

  /** Where the event stands, for a seat's resume briefing (with the seat's own match so far: its score, never its opponent). */
  private whereNow(s?: AgentSeat): string {
    if (this.stage === 'draft') return 'The draft is under way.';
    if (this.stage === 'build') return s?.deckLocked ? 'Your deck is locked; the other agents are finishing theirs.' : 'Deckbuilding is under way.';
    if (this.stage !== 'games') return '';
    const round = `Round ${this.round + 1} of ${this.plan.rounds} is being played.`;
    const m = s ? this.roundMatches.get(`${this.round}|${s.name}`) : undefined;
    if (!s || !m) return round;
    const me = m.wins[s.name] ?? 0;
    const them = Object.entries(m.wins).find(([n]) => n !== s.name)?.[1] ?? 0;
    const bo = this.cfg.bestOf ?? 3;
    if (!this.playing.has(s.name)) return `${round} Your match this round is over (you ${me}–${them}).`;
    return bo === 1 ? `${round} You are playing your best-of-1 match.` : `${round} Your best-of-${bo} match so far: you ${me}–${them} in games; game ${m.games.length + 1} is next or under way.`;
  }

  /** The welcome message's part about matches: how many rounds, best-of, and how they are paired. */
  private matchesSentence(withPairing = true): string {
    const n = this.plan.rounds;
    const bo = this.cfg.bestOf ?? 3;
    if (!n) return 'no matches (there are no other agent seats)';
    const sb = this.sideboarding ? ' with sideboarding' : '';
    if (!withPairing) return `${n} round${n === 1 ? '' : 's'} of best-of-${bo} matches${sb} against other agents`;
    const how = this.plan.format === 'swiss'
      ? 'Swiss pairings: round 1 is random, then each round pairs players with similar records, and you never meet the same opponent twice'
      : 'a round robin: you play every other agent once';
    return `${n} round${n === 1 ? '' : 's'} of best-of-${bo} matches${sb} against other agents (${how})`;
  }

  /**
   * What is still to come for a seat, appended to its status while it waits (so a seat with nothing to decide,
   * e.g. between rounds, knows to keep polling instead of quitting).
   */
  private progressNote(s: AgentSeat): string {
    const keep = 'Keep calling wait_for_decision until a result says EVENT COMPLETE';
    const total = this.plan.rounds;
    // With an odd number of agents (dev events only) a round can be a bye: "up to".
    const upTo = this.agents.length % 2 ? 'up to ' : '';
    const matches = (n: number) => `${upTo}${n} match${n === 1 ? '' : 'es'}`;
    const more = (n: number) => `${upTo}${n} more match${n === 1 ? '' : 'es'} to play`;
    const bo = this.cfg.bestOf ?? 3;
    if (this.stage === 'created' || this.stage === 'draft' || this.stage === 'build') {
      const games = total ? `${matches(total)} (best of ${bo}) against other agents, one per round` : '';
      const rest = [this.stage === 'build' ? '' : 'deckbuilding', games].filter(Boolean).join(', then ');
      return `${rest ? `Still to come: ${rest}. ` : ''}${keep}: waiting for slower players can take several minutes.`;
    }
    if (this.stage !== 'games') return '';
    const later = Math.max(0, total - (this.round + 1));
    if (this.playing.has(s.name)) return `${later ? `After this match: ${more(later)}.` : 'This is your last match.'} ${keep}.`;
    if (later) {
      return `Waiting: ${more(later)} (round ${this.round + 2} of ${total} is paired when every match of round ${this.round + 1} has finished; other agents are still playing). ${keep}: waits between rounds can take 10–30 minutes.`;
    }
    return `You have played all your matches; other agents are still playing theirs. Your final results come with EVENT COMPLETE. ${keep}.`;
  }

  /** The EVENT COMPLETE message: every match of this seat (opponents anonymized) and the totals. */
  private finalText(s: AgentSeat, early = false): string {
    if (!this.plan.rounds) return 'EVENT COMPLETE. There were no matches in this event (no other agent seats). You can stop now.';
    if (early) {
      // Starts like the event's final message: the join prompts (frozen per comparability group) say to play until
      // a result says EVENT COMPLETE, and play-claude-seat.sh looks for it. "Others are still playing" only when some
      // other seat (not this seat's own opponent, who finishes with it) really has a match left.
      const pair = this.rounds[this.round]?.pairs.find((p) => p.includes(s.name));
      const opponent = pair ? (pair[0] === s.name ? pair[1] : pair[0]) : undefined;
      const othersPlaying = this.agents.some((o) => o.name !== s.name && o.name !== opponent && !o.done);
      const others = othersPlaying ? 'Other agents are still finishing their matches.' : 'Every match has finished: the event is ending.';
      return this.finalText(s).replace(/^EVENT COMPLETE\. Your matches:/,
        `EVENT COMPLETE. You're done: no more games for you in this event; you can stop now. ${others} Your matches:`);
    }
    // Opponents are never named; with several, they get letters in the order you met them.
    const opponents = [...new Set(this.rounds.flatMap((rp) => rp.pairs.filter((p) => p.includes(s.name)).map(([a, b]) => (a === s.name ? b : a))))];
    const label = (o: string) => (opponents.length > 1 ? `another agent (opponent ${String.fromCharCode(65 + opponents.indexOf(o))})` : 'another agent');
    const lines = ['EVENT COMPLETE. Your matches:'];
    let mw = 0, ml = 0, md = 0, nr = 0, gw = 0, gl = 0;
    this.rounds.forEach((rp, r) => {
      const pair = rp.pairs.find((p) => p.includes(s.name));
      if (!pair) {
        lines.push(`  Round ${r + 1}: no match (bye).`);
        return;
      }
      const opp = pair[0] === s.name ? pair[1] : pair[0];
      const m = this.roundMatches.get(`${r}|${s.name}`);
      if (!m) {
        lines.push(`  Round ${r + 1}: vs ${label(opp)}: not played.`);
        return;
      }
      const me = m.wins[s.name] ?? 0;
      const them = m.wins[opp] ?? 0;
      gw += me;
      gl += them;
      const games = m.games.map((g, i) => `game ${i + 1} ${g.winnerName === s.name ? 'won' : g.winnerName == null ? 'drawn' : 'lost'}`).join(', ');
      if (m.noResult) {
        nr++;
        lines.push(`  Round ${r + 1}: vs ${label(opp)}: no result (the rules engine kept failing; neither a win nor a loss)${games ? ` (${games})` : ''}.`);
        return;
      }
      const result = me > them ? (mw++, 'won') : me < them ? (ml++, 'lost') : (md++, 'drew');
      lines.push(`  Round ${r + 1}: vs ${label(opp)}: ${result} ${me}–${them}${games ? ` (${games})` : ''}.`);
    });
    const lost = this.forfeits.get(s.name) ?? [];
    if (lost.length) {
      const n = (stage: string) => lost.filter((f) => f.stage === stage).length;
      const parts = [n('draft') ? `${n('draft')} draft pick(s)` : '', n('build') ? 'your deck' : '', n('sideboard') ? `${n('sideboard')} between-games decision(s) (deck kept, or play first)` : '', n('game') ? `${n('game')} game(s) conceded` : ''].filter(Boolean);
      lines.push(`Inactivity forfeits (no call for ${Math.round(this.seatTimeoutMs / 60_000) || 1}+ minutes with a decision open): ${parts.join(', ')}.`);
    }
    lines.push(`Totals: matches won ${mw}, lost ${ml}${md ? `, drawn ${md}` : ''}${nr ? `, no result ${nr}` : ''}; games won ${gw}, lost ${gl}. You can stop now.`);
    return lines.join('\n');
  }

  /** Per agent seat: inactivity forfeits and finished games (lobby contribution stats and reliability). */
  seatOutcomes(): Record<string, { forfeits: number; games: number }> {
    return Object.fromEntries(this.agents.map((s) => [s.name, {
      forfeits: this.forfeits.get(s.name)?.length ?? 0,
      games: this.matches.filter((m) => m.a === s.name || m.b === s.name).reduce((n, m) => n + m.games.length, 0),
    }]));
  }

  private async playMatch(a: AgentSeat, b: AgentSeat, round: number): Promise<void> {
    const bestOf = this.cfg.bestOf ?? 3;
    const need = Math.floor(bestOf / 2) + 1;
    const m: MatchResult = { a: a.name, b: b.name, wins: { [a.name]: 0, [b.name]: 0 }, games: [] };
    this.matches.push(m);
    for (const s of [a, b]) {
      this.roundMatches.set(`${round}|${s.name}`, m);
      this.playing.add(s.name);
    }
    // Voids per game number (from the log after a restart, then this process), and the games voided in this process
    // (their logged attempt is history: the replay starts afresh).
    const voids = new Map<number, number>();
    const fresh = new Set<number>();
    // Match memory: per seat, its opponent's cards seen in the match's finished games (name → most copies in one game).
    const seen = new Map<string, Record<string, number>>([[a.name, {}], [b.name, {}]]);
    const remember = (perSeat: unknown) => {
      if (!perSeat || typeof perSeat !== 'object') return;
      for (const [name, mem] of seen) mergeSeen(mem, (perSeat as Record<string, unknown>)[name]);
    };
    // Each match starts from the registered decks (deck_built); sideboarding changes them for games 2 and 3.
    const decks = new Map<string, MatchDeck>(this.sideboarding ? [a, b].map((s) => [s.name, deckOf(this.decks.get(s.name)!, this.pools[s.index]!)]) : []);
    // Who plays first in each game, and who chose (decided once per game: a voided game is replayed the same way).
    const plays = new Map<number, { onPlay: string; chooser: string | null }>();
    for (let g = 1; g <= bestOf && m.wins[a.name]! < need && m.wins[b.name]! < need && !this.aborted; g++) {
      const meta = { match: `${a.name} vs ${b.name}`, game_number: g };
      if (this.sideboarding && !plays.has(g)) {
        plays.set(g, await this.betweenGames(a, b, g, round, m, decks, plays, seen));
        if (this.aborted) return;
      }
      // Alternate who hosts; who plays first is the play/draw decision above (phase-server is made to start with that player).
      const [x, y] = g % 2 === 1 ? [a, b] : [b, a];
      const label = `${a.name} vs ${b.name} — game ${g}`;
      const starter = plays.get(g)?.onPlay;
      // Resuming after a restart: games that finished come from the log; the one in progress is re-attached.
      const past = this.resume?.games.get(label);
      if (past && !voids.has(g)) voids.set(g, past.voids);
      if (past?.over && !fresh.has(g)) {
        const w = past.over.winner as string | null;
        if (w) m.wins[w] = (m.wins[w] ?? 0) + 1;
        m.games.push({ winner: w == null ? null : w === x.name ? 0 : 1, turns: past.over.turns, stats: past.over.stats ?? {}, label, winnerName: w });
        remember(past.over.opponent_cards_seen);
        for (const s of [x, y]) s.gamesFinished++;
        continue;
      }
      if (past?.failed && !fresh.has(g)) {
        // The match had ended before the restart: with no result (voided too often), or, in logs from before
        // this rule (2026-10-22), on a setup failure.
        if (past.failed.void && past.failed.replay === false) {
          m.noResult = String(past.failed.reason ?? 'voided');
          break;
        }
        if (!past.failed.void) break;
      }
      let resumeGame = past?.start && !fresh.has(g) ? this.sessions.get(label) : undefined;
      if (past?.start && !fresh.has(g) && !resumeGame) {
        const n = (voids.get(g) ?? 0) + 1;
        voids.set(g, n);
        fresh.add(g);
        const replay = n <= MAX_VOIDS_PER_GAME;
        this.voidGame(label, meta, [x, y], g, 'no_session', 'its reconnect credentials were not saved', replay);
        if (!replay) {
          m.noResult = 'no_session';
          break;
        }
        g--;
        continue;
      }
      if (!resumeGame && this.beforeGame) await this.beforeGame([x, y]);
      if (this.aborted) return;
      if (!resumeGame) {
        for (const s of [x, y]) {
          const opp = s === x ? y : x;
          const first = starter ? (starter === s.name ? ' You play first.' : ' Your opponent plays first.') : '';
          const size = this.sideboarding && g > 1 ? ` Your opponent's deck: ${deckData(decks.get(opp.name)!, this.pools[opp.index]!).main_deck.length} cards.` : '';
          s.setStatus(`Game ${g} of your match: starting, or the opponent is acting.`);
          s.notify(`Match game ${g} (best of ${bestOf}) is starting. Score: you ${m.wins[s.name]} - ${m.wins[opp.name]} opponent.${first}${size}`);
        }
      } else {
        for (const s of [x, y]) s.setStatus(`Game ${g} of your match: reconnecting to the rules engine after a restart.`);
      }
      const deckFor = (s: AgentSeat) => (this.sideboarding ? deckData(decks.get(s.name)!, this.pools[s.index]!) : this.decks.get(s.name)!.deck);
      const game = this.createGame(this.cfg.phaseUrl, this.cards, [x, y], [deckFor(x), deckFor(y)], this.log, label,
        this.cfg.mana ?? 'manual', meta, this.spectator, {
          onSession: (sess) => {
            this.sessions.set(label, sess);
            this.persist();
          },
          ...(resumeGame ? { resume: gameResume(past!, resumeGame, this.resume?.forfeits ?? []) } : {}),
          observation: observationFormat(this.cfg.promptsDir),
          ...(starter ? { starter } : {}),
          // What the seats read: never the seat names (`label` is for logs and spectators).
          seatLabel: `Round ${round + 1} of ${this.plan.rounds}, game ${g} (best of ${bestOf})`,
          match: {
            game: g, bestOf, results: m.games.map((x, i) => ({ game: i + 1, winner: x.winnerName ?? null, turns: x.turns })),
            opponentSeen: Object.fromEntries([...seen].map(([n, mem]) => [n, { ...mem }])),
          },
        });
      this.liveGames.add(game);
      let r: GameResult;
      try {
        r = await game.play();
      } catch (err) {
        if (this.aborted) return;
        // Lost on the engine side (restart, expired reconnect), or the engine couldn't start it even after its setup
        // retries: void it and play it again from the start, after a pause that grows with each void (the engine may
        // be restarting). Infrastructure failures never decide a game; one that keeps failing ends the match with no
        // result.
        const reason = err instanceof GameVoidError ? err.reason : 'setup_failed';
        const n = (voids.get(g) ?? 0) + 1;
        voids.set(g, n);
        fresh.add(g);
        const replay = n <= MAX_VOIDS_PER_GAME;
        this.voidGame(label, meta, [x, y], g, reason, String((err as Error)?.message ?? err), replay);
        if (!replay) {
          m.noResult = reason;
          break;
        }
        const delays = this.cfg.replayDelaysMs ?? REPLAY_DELAYS_MS;
        const wait = delays[Math.min(n, delays.length) - 1] ?? 0;
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        if (this.aborted) return;
        g--;
        continue;
      } finally {
        this.liveGames.delete(game);
        if (this.sessions.delete(label)) this.persist();
      }
      const winner = r.winner == null ? null : (r.winner === 0 ? x : y);
      if (winner) m.wins[winner.name]!++;
      const { opponentCardsSeen, ...result } = r;
      remember(opponentCardsSeen);
      m.games.push({ ...result, label, winnerName: winner?.name ?? null });
      for (const s of [x, y]) {
        s.gamesFinished++;
        s.setStatus('Waiting for the next game.');
        s.notify(`Game ${g} over: ${winner == null ? 'draw' : winner === s ? 'you WON' : 'you lost'} on turn ${r.turns}.`);
      }
    }
    if (this.aborted) return;
    if (!this.resume?.matchEnds.has(`${a.name} vs ${b.name}`)) {
      this.log('match_end', { a: a.name, b: b.name, wins: m.wins, ...(m.noResult ? { no_result: true, reason: m.noResult } : {}) });
    }
    for (const s of [a, b]) {
      s.matchesFinished++;
      this.playing.delete(s.name);
      s.setStatus(m.noResult
        ? `Your round ${round + 1} match ended with no result (the rules engine kept failing): it counts as neither a win nor a loss.`
        : `Your round ${round + 1} match is over (you ${m.wins[s.name]}–${m.wins[s === a ? b.name : a.name]}).`);
    }
    // The last round: these seats have no games left. Tell them now, so they stop instead of waiting (and
    // re-sending their whole context every 40 s) until the slowest match of the event ends.
    if (round + 1 >= this.plan.rounds) for (const s of [a, b]) this.seatDone(s);
  }

  /** A game of a match (tests replace it with a scripted one). */
  protected createGame(...args: ConstructorParameters<typeof Game>): Game {
    return new Game(...args);
  }

  /**
   * Before game g of a match: who plays first (game 1 from the seed; later games the loser of the previous game chooses)
   * and, before games 2 and 3, both seats sideboard at the same time (sideboard.ts). What the log already has (a resumed
   * event) is reused, never asked again. Logs `play_draw` (and the decisions' own records); returns who plays first.
   */
  private async betweenGames(a: AgentSeat, b: AgentSeat, g: number, round: number, m: MatchResult, decks: Map<string, MatchDeck>,
    plays: Map<number, { onPlay: string; chooser: string | null }>, seen: Map<string, Record<string, number>>): Promise<{ onPlay: string; chooser: string | null }> {
    const match = `${a.name} vs ${b.name}`;
    const meta = { match, game_number: g };
    const roundLabel = `Round ${round + 1} of ${this.plan.rounds}`;
    const other = (s: AgentSeat) => (s === a ? b : a);
    const score = (s: AgentSeat) => ({ me: m.wins[s.name] ?? 0, them: m.wins[other(s).name] ?? 0 });
    let play: { onPlay: string; chooser: string | null };
    const logged = this.resume?.playDraw.get(`${match}|${g}`);
    if (logged && (logged.on_play === a.name || logged.on_play === b.name)) {
      play = { onPlay: String(logged.on_play), chooser: typeof logged.chooser === 'string' ? logged.chooser : null };
    } else if (g === 1) {
      play = { onPlay: seededStarter(this.seed, match, a.name, b.name), chooser: null };
      this.log('play_draw', { ...meta, on_play: play.onPlay, by: 'seed', chooser: null, choice: null });
    } else {
      const last = m.games[m.games.length - 1];
      const prev = plays.get(g - 1);
      const chooserName = nextChooser({ winner: last?.winnerName ?? null, chooser: prev?.chooser ?? null, onPlay: prev?.onPlay ?? a.name }, a.name, b.name);
      const chooser = chooserName === a.name ? a : b;
      other(chooser).setStatus(`Between games: your opponent is choosing whether to play or draw in game ${g}.`);
      const r = await askPlayDraw(chooser, { game: g, roundLabel, score: score(chooser), reason: last?.winnerName ? 'lost' : 'draw' }, this.log, meta);
      play = { onPlay: r.choice === 'play' ? chooser.name : other(chooser).name, chooser: chooser.name };
      this.log('play_draw', { ...meta, on_play: play.onPlay, by: r.by, chooser: chooser.name, choice: r.choice, ...(r.note ? { note: r.note } : {}), latency_ms: r.latency_ms });
      other(chooser).notify(`Your opponent chose to ${r.choice} in game ${g}: ${play.onPlay === chooser.name ? 'they play first' : 'you play first'}.`);
    }
    if (g === 1 || this.aborted) return play;
    // Sideboarding: both seats at once, each seeing the other's deck as it was (sizes are public; changes are not).
    const before = new Map([a, b].map((s) => [s.name, deckData(decks.get(s.name)!, this.pools[s.index]!)]));
    await Promise.all([a, b].map(async (s) => {
      const pool = this.pools[s.index]!;
      const rec = this.resume?.sideboards.get(`${match}|${g}|${s.name}`);
      if (rec) {
        decks.set(s.name, deckFromSideboardLog(rec, pool));
        return;
      }
      const opp = before.get(other(s).name)!;
      s.setStatus(`Between games: your opponent is sideboarding for game ${g}.`);
      const r = await askSideboard(s, pool, decks.get(s.name)!, this.cards, {
        game: g, roundLabel, score: score(s),
        results: m.games.map((x, i) => ({ game: i + 1, result: x.winnerName === s.name ? 'won' as const : x.winnerName == null ? 'drawn' as const : 'lost' as const, turns: x.turns })),
        onPlay: play.onPlay === s.name ? 'you' : 'opponent',
        chose: play.chooser == null ? 'seed' : play.chooser === s.name ? 'you' : 'opponent',
        opponentSeen: { ...(seen.get(s.name) ?? {}) }, opponentDeck: opp.main_deck.length, opponentSideboard: opp.sideboard.length,
        stats: this.knowledge.stats ? this.ratings : undefined, setContext: !!this.knowledge.primer,
      }, this.log, meta);
      decks.set(s.name, r.deck);
    }));
    return play;
  }

  /**
   * A seat with no games left in this event: its final answer (its own results) and the end of its session, at once.
   * bench play, play-claude-seat.sh and the watchdog read it as done (GET /api/events/:id status "done"), never as
   * a disconnect. Logged as `seat_done`.
   */
  private seatDone(s: AgentSeat | undefined): void {
    if (!s || s.done || this.aborted) return;
    if (!this.resume?.seatsDone.has(s.name)) this.log('seat_done', { seat: s.name, round: this.round + 1 });
    s.finish(this.finalText(s, true));
  }

  /**
   * Log a void: the game's attempt so far doesn't count for anyone (never a loss), and it is replayed from the
   * start under the same label unless `replay` is false (too many voids: the match ends like a setup failure).
   */
  private voidGame(label: string, meta: Record<string, unknown>, seats: AgentSeat[], g: number, reason: string, error: string, replay = true): void {
    this.log('game_failed', { game: label, ...meta, void: true, reason, replay, error });
    for (const s of seats) {
      s.notify(replay
        ? `Game ${g} of your match was voided (${reason === 'no_session' || reason === 'reconnect_failed' ? 'the Director restarted and could not reconnect to it' : reason === 'setup_failed' ? 'the rules engine could not start it' : 'the rules engine lost it'}). It doesn't count for either player and is replayed from the start.`
        : `Game ${g} of your match was voided again and the match ends here with no result: it counts as neither a win nor a loss for either player, and voided games don't count for anyone.`);
    }
  }

  /** Public status (GET /api/events/:id): stage, each agent seat's state, standings. No seat tokens. */
  summary(): Record<string, unknown> {
    return {
      // The seed regenerates the packs: public only once the event is over.
      id: this.id, stage: this.aborted ? 'aborted' : this.stage, ...(this.stage === 'done' ? { seed: this.seed } : {}), knowledge: this.knowledge.level,
      format: this.plan.format, rounds: this.plan.rounds, ...(this.stage === 'games' ? { round: this.round + 1 } : {}),
      ...(this.aborted ? { abort_reason: this.aborted } : {}),
      agents: this.agents.map((s) => ({
        name: s.name, status: s.done ? 'done' : s.pending ? `deciding (${s.pending.phase})` : 'waiting',
        ...(s.inactive ? { inactive: true } : {}),
      })),
      standings: this.standings(),
    };
  }

  standings(): Array<{ name: string; matchWins: number; matchLosses: number; gameWins: number; gameLosses: number }> {
    return this.agents.map((s) => {
      let mw = 0, ml = 0, gw = 0, gl = 0;
      for (const m of this.matches) {
        if (m.a !== s.name && m.b !== s.name) continue;
        const opp = m.a === s.name ? m.b : m.a;
        gw += m.wins[s.name]!;
        gl += m.wins[opp]!;
        if (m.noResult) continue; // no result: neither won nor lost (its finished games still count)
        if (m.wins[s.name]! > m.wins[opp]!) mw++;
        else if (m.wins[s.name]! < m.wins[opp]!) ml++;
      }
      return { name: s.name, matchWins: mw, matchLosses: ml, gameWins: gw, gameLosses: gl };
    }).sort((x, y) => y.matchWins - x.matchWins || (y.gameWins - y.gameLosses) - (x.gameWins - x.gameLosses));
  }
}
