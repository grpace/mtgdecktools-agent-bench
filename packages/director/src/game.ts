import { appendFileSync } from 'node:fs';
import { CardDb, formatCost, v4Cost } from './cards.js';
import { isManaAction, isPlanManaAction, manaActionColors, poolCovers } from './mana-sources.js';
import { DeckData, FullSessionKey, PhaseSeat, PhaseUpdate, ReconnectRefused } from './phase.js';
import { Renderer } from './render.js';
import type { ObservationFormat } from './observation.js';
import { pruneByObject, pruneState } from './obs-fixtures.js';
import { abilityText, actionObjects, compactJson, costText, findDescription, manaPart, ObserverV4, shownCards, stepName, words, type V4Context } from './render-v4.js';
import { AgentSeat, DecideInput, given, Offer, Option, unexpectedFields } from './seat.js';
import { publicBoard, publicLogLine, type LogLine, type PublicBoard } from './spectate.js';

export type LogFn = (type: string, data: Record<string, unknown>) => void;

/** Receives a game's public information as it happens (the spectator stream). */
export interface GameWatch {
  board(game: string, board: PublicBoard): void;
  logLines(game: string, lines: LogLine[], names: string[]): void;
  endBoard(game: string): void;
}

/** What it takes to re-attach both seats to a running game on phase-server (kept private: tokens are credentials). */
export interface GameSession {
  code: string;
  /** In game order (host first). */
  players: Array<{ seat: string; token: string; full_key: FullSessionKey }>;
}

/** A game that was running when the Director stopped: reconnect to it and carry on (durability, event.ts). */
export interface GameResume {
  session: GameSession;
  onPlay?: string;
  forfeitedBy?: string;
  lastSnapshotTurn: number;
  /** Per seat: counters for game_over.stats / mulligans, rebuilt from the log. */
  counters: Record<string, Partial<Record<'decisions' | 'autoPasses' | 'forced' | 'rejections' | 'manualPayments' | 'autoTapper' | 'payFailures' | 'autoPaid' | 'mulligans', number>>>;
  played: Record<string, { cast: Record<string, number>; activated: Record<string, number> }>;
  unimplemented: Array<{ key: string; card: string; seat: string | null }>;
}

export interface GameHooks {
  /** Called once both seats hold reconnect credentials (right after the game starts): persist them. */
  onSession?: (s: GameSession) => void;
  /** Resume this game instead of creating it. */
  resume?: GameResume;
  /** Observation format agents see (from the prompt version): 'v3' text board, or 'v4' JSON state + card table. Default 'v3'. */
  observation?: ObservationFormat;
  /**
   * How the game is named in everything a seat reads ("Round 2 of 3, game 1 (best of 3)"). Never seat names: a seat
   * must not learn who its opponent is (`label` names both seats and is for logs only).
   */
  seatLabel?: string;
  /**
   * The match so far (game number, earlier results by seat name), for the observation's match context; `opponentSeen`
   * per seat name: its opponent's cards it saw in earlier games of the match (match memory, name → most copies in a game).
   */
  match?: { game: number; bestOf: number; results: Array<{ game: number; winner: string | null; turns: number }>; opponentSeen?: Record<string, Record<string, number>> };
  /**
   * The seat that must take the first turn (the play/draw decision; sideboard.ts). phase-server picks the starting player
   * itself (a d20 roll), so a new game whose first state names the other player is conceded and created again before any
   * update reaches a seat (no decision has been offered yet). Not used when resuming a game.
   */
  starter?: string;
  /** Pauses between reconnect tries after a Director restart (default RESUME_RETRY_MS; tests pass short ones). */
  resumeRetryMs?: number[];
}

/** New games tried for the chosen starter before giving up (each has a 1/2 chance; 2^-24 to fail). */
const MAX_STARTER_TRIES = 24;

/**
 * Debug (MTGDT_OBS_COMPARE=<file.jsonl>): at every decision, also render the other formats for the same state and
 * append all texts (v3, v4, and two v4 card-table variants for measurement) to the file. Measurement only; agents see one format.
 */
const OBS_COMPARE = process.env.MTGDT_OBS_COMPARE;
/** Debug (MTGDT_OBS_DUMP=<file.jsonl>): every decision's (pruned) engine state, for observation test fixtures. */
const OBS_DUMP = process.env.MTGDT_OBS_DUMP;
/**
 * How a game decision is laid out: 'json' (default) one structured object (summary, events since the last decision,
 * state, cards, the decision with its options); 'text' the summary, log lines and options as text around the JSON
 * state. MTGDT_OBS_ENVELOPE picks one for experiments; MTGDT_OBS_COMPARE records both.
 */
type Envelope = 'json' | 'text';
const OBS_ENVELOPE: Envelope = process.env.MTGDT_OBS_ENVELOPE === 'text' ? 'text' : 'json';

/** One log entry as structured data: when, who, what (text), which objects it mentions. */
interface EventEntry {
  turn: number;
  step: string;
  text: string;
  actor?: 'you' | 'opponent';
  cards?: number[];
}

/**
 * The game can't go on (it was lost on phase-server: reconnect refused or the grace period expired). The caller
 * voids it and replays it from the start; a void is never scored (CLAUDE.md: infrastructure failures are not misplays).
 */
export class GameVoidError extends Error {
  constructor(message: string, readonly reason: string) {
    super(message);
  }
}

/** Live reconnect after an unexpected socket close: tries, and the pause between them (inside phase-server's 120 s grace). */
const RECONNECT_TRIES = 8;
const RECONNECT_PAUSE_MS = 5_000;
/**
 * Re-attaching a game after a Director restart: pauses before each retry, about 105 s in all, inside phase-server's
 * 120 s reconnect grace. A deploy can start the Director before phase-server answers (or while it restarts too), so a
 * failed connection proves nothing. A running phase-server that refuses the Reconnect (the game or session is gone,
 * e.g. the grace expired) is believed after RESUME_REFUSALS tries in a row.
 */
export const RESUME_RETRY_MS = [1_000, 2_000, 4_000, 8_000, 15_000, 15_000, 15_000, 15_000, 15_000, 15_000];
export const RESUME_REFUSALS = 3;

export interface GameResult {
  /** Index into the game's two players (0 or 1), or null for a draw. */
  winner: number | null;
  turns: number;
  stats: Record<string, unknown>;
  /** Per seat name: the opponent's cards it saw this game (name → copies), for the match memory of later games. */
  opponentCardsSeen?: Record<string, Record<string, number>>;
}

/** Copies per name of a seat's `shown` cards (object id → name). */
function countByName(shown: Map<number, string>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const name of shown.values()) out[name] = (out[name] ?? 0) + 1;
  return Object.fromEntries(Object.entries(out).sort((a, b) => a[0].localeCompare(b[0])));
}

/** Steps where a seat with only instant-speed options is not stopped (Arena-like smart stops). */
const OWN_TURN_STOPS = new Set(['PreCombatMain', 'PostCombatMain', 'DeclareBlockers']);
const OPP_TURN_STOPS = new Set(['DeclareAttackers', 'DeclareBlockers', 'End']);

/** Log lines that add nothing for a player (mana bookkeeping, untaps, duplicate zone moves). */
const LOG_NOISE = /passes priority$|adds \{[^}]*\}.* mana$| tapped$| untapped$|expended \(cumulative|moves from Hand to (Stack|Battlefield)$|moves from Library to Hand$/;

type Structured = 'attackers' | 'blocks' | 'cards' | 'mana';
export type ManaMode = 'manual' | 'auto';

const COLOR_NAME: Record<string, string> = { W: 'White', U: 'Blue', B: 'Black', R: 'Red', G: 'Green', C: 'Colorless' };
const COLOR_LETTER: Record<string, string> = { White: 'W', Blue: 'U', Black: 'B', Red: 'R', Green: 'G', Colorless: 'C' };
/** A named choice with more options than this lists only the likely ones (shortList). */
const NAMED_CHOICE_LIST = 40;
/** Events since the last decision shown in a decision (the rest: get_game_log). */
const MAX_EVENTS = 30;

class Player {
  render!: Renderer;
  obs!: ObserverV4;
  latest?: PhaseUpdate;
  answeredRevision = -1;
  offeredRevision = -1;
  seenCards = new Set<string>();
  /** The opponent's cards this seat has seen this game (object id → name; shownCards), for match memory. */
  oppShown = new Map<number, string>();
  /** MTGDT_OBS_COMPARE only: what the formats this seat isn't using would have tracked. */
  shadowSeen = new Set<string>();
  shadowSent = new Set<string>();
  logSince: string[] = [];
  eventsSince: EventEntry[] = [];
  fullLog: string[] = [];
  decisions = 0;
  autoPasses = 0;
  forced = 0;
  rejections = 0;
  /** Remaining mana sources the agent asked us to tap for the payment in progress. */
  payQueue?: string[];
  payError?: string;
  /** The color (engine name) the plan wants from an "any color" source just activated; the engine asks next. */
  payColor?: string;
  /** The agent activated a mana ability as an option during this payment (it pays by hand, one source at a time). */
  optionTapped = false;
  /** This payment already counts as manual (a tap plan was given for it). */
  paymentCounted = false;
  manualPayments = 0;
  mulligans = 0;
  /** Actions the engine listed as legal but refused, keyed by JSON → turn; hidden for the rest of that turn. */
  refused = new Map<string, number>();
  autoTapper = 0;
  payFailures = 0;
  /** Abilities and other non-spell costs the engine paid by itself (no tap plan given, or the plan fell short). */
  autoPaid = 0;
  /** Set while the Director taps the agent's planned sources before activating an ability (no update is offered). */
  preTapping = false;

  constructor(readonly seat: AgentSeat, public phase: PhaseSeat, readonly slot: number) {}

  get me(): number {
    return this.phase.player ?? this.slot;
  }
}

/**
 * One game between two event seats on phase-server. Owns both seat sockets and turns raw
 * engine state into decisions offered through each seat's queue. Agents never see phase-server.
 */
export class Game {
  private players: [Player, Player];
  private finished?: (r: GameResult) => void;
  private failed?: (err: Error) => void;
  /** Set when the game is over (or abandoned) and its sockets are being closed on purpose. */
  private closing = false;
  private session?: GameSession;
  private onPlay?: string;
  private lastSnapshotTurn = 0;
  /** While a new game is set up (its starting player not yet checked), its updates wait here instead of reaching seats. */
  private held?: Map<Player, PhaseUpdate[]>;
  /** Ids of offers this game made, so it only ever clears its own decisions. */
  private offerIds = new Set<string>();
  private result?: GameResult;
  /** Cards each seat cast or activated (non-mana abilities), for engine-issue flags (METHODOLOGY §5.6). */
  private played = new Map<string, { cast: Record<string, number>; activated: Record<string, number> }>();
  /** The seat this game was conceded for by the inactivity watchdog, if any. */
  private forfeitedBy?: string;
  /** Oracle ids (or token names) phase-rs recorded as hitting an Unimplemented effect, already logged. */
  private unimplemented = new Map<string, { card: string; seat: string | null }>();

  constructor(
    private phaseUrl: string,
    private cards: CardDb,
    seats: [AgentSeat, AgentSeat],
    private decks: [DeckData, DeckData],
    private log: LogFn,
    readonly label: string,
    private manaMode: ManaMode = 'manual',
    /** Extra fields logged with game_start / game_over (match id, game number). */
    private meta: Record<string, unknown> = {},
    /** Spectator sink for public boards and log lines. */
    private watch?: GameWatch,
    private hooks: GameHooks = {},
  ) {
    this.players = [
      new Player(seats[0], new PhaseSeat(phaseUrl, `Seat${seats[0].index + 1}`), 0),
      new Player(seats[1], new PhaseSeat(phaseUrl, `Seat${seats[1].index + 1}`), 1),
    ];
    const r = hooks.resume;
    if (r) {
      this.session = r.session;
      this.onPlay = r.onPlay;
      this.forfeitedBy = r.forfeitedBy;
      this.lastSnapshotTurn = r.lastSnapshotTurn;
      for (const [seat, rec] of Object.entries(r.played)) this.played.set(seat, rec);
      for (const u of r.unimplemented) this.unimplemented.set(u.key, { card: u.card, seat: u.seat });
      for (const p of this.players) Object.assign(p, r.counters[p.seat.name] ?? {});
    }
  }

  /** Stop this game without a result (the event was aborted): close its sockets, withdraw its offers. */
  /** The two seats playing this game. */
  get seatNames(): [string, string] {
    return [this.players[0].seat.name, this.players[1].seat.name];
  }

  abandon(): void {
    this.closing = true;
    for (const p of this.players) {
      p.phase.removeAllListeners('update');
      if (p.seat.pending && this.offerIds.has(p.seat.pending.id)) p.seat.clear();
      p.phase.close();
    }
  }

  async play(): Promise<GameResult> {
    const done = new Promise<GameResult>((resolve, reject) => {
      this.finished = resolve;
      this.failed = reject;
    });
    if (this.hooks.resume) return this.resumePlay(done);
    const [a, b] = this.players;
    // phase-server can refuse to create or join a game under load (e.g. "database is locked").
    // Retry setup on fresh sockets instead of waiting forever.
    let code = '';
    const want = this.hooks.starter;
    let starterTries = 0;
    let starterOk: boolean | undefined;
    for (let attempt = 1; ; attempt++) {
      try {
        this.held = new Map(this.players.map((p) => [p, []]));
        for (const p of this.players) await this.attach(p);
        code = await a.phase.createGame(this.decks[0]);
        b.phase.joinGame(code, this.decks[1]);
        await Promise.all([a.phase.waitStarted(20_000), b.phase.waitStarted(20_000)]);
        if (want) {
          starterTries++;
          const first = this.startingSeat();
          starterOk = first === want;
          if (!starterOk && starterTries < MAX_STARTER_TRIES) {
            // phase-server rolled the other player: end this game before anyone saw it and create another.
            a.phase.concede();
            await new Promise((r) => setTimeout(r, 100));
            for (const p of this.players) {
              p.phase.removeAllListeners();
              p.phase.close();
              p.phase = new PhaseSeat(this.phaseUrl, p.phase.displayName);
            }
            attempt--;
            continue;
          }
        }
        break;
      } catch (err) {
        this.log('game_setup_retry', { game: this.label, attempt, error: String((err as Error)?.message ?? err) });
        for (const p of this.players) {
          p.phase.removeAllListeners();
          p.phase.close();
          p.phase = new PhaseSeat(this.phaseUrl, p.phase.displayName);
        }
        if (attempt >= 4) throw new Error(`could not start ${this.label}: ${String((err as Error)?.message ?? err)}`);
        await new Promise((r) => setTimeout(r, 1000 * attempt + Math.random() * 1000));
      }
    }
    this.log('game_start', {
      game: this.label, ...this.meta, game_code: code, seats: this.players.map((p) => p.seat.name), mana: this.manaMode,
      deck_sizes: Object.fromEntries(this.players.map((p, i) => [p.seat.name, this.decks[i]!.main_deck.length])),
      ...(want ? { starter: { seat: want, games_created: starterTries, ...(starterOk ? {} : { honored: false }) } } : {}),
    });
    if (want && !starterOk) this.log('starter_mismatch', { game: this.label, ...this.meta, wanted: want, tries: starterTries });
    // The game is the one played: its updates (held since it started) now reach the seats, in order.
    const held = this.held;
    this.held = undefined;
    for (const [p, list] of held ?? []) for (const u of list) this.onUpdate(p, u);
    if (this.players.every((p) => p.phase.playerToken && p.phase.fullKey)) {
      this.session = {
        code,
        players: this.players.map((p) => ({ seat: p.seat.name, token: p.phase.playerToken!, full_key: p.phase.fullKey! })),
      };
      this.hooks.onSession?.(this.session);
    }
    for (const p of this.players) this.watchSocket(p);
    return this.finish(done);
  }

  /**
   * Re-attach both seats to the game after a Director restart, retrying with backoff (RESUME_RETRY_MS) while
   * phase-server may still be starting; GameVoidError once the retries are spent (its grace has expired by then).
   */
  private async resumePlay(done: Promise<GameResult>): Promise<GameResult> {
    const s = this.session!;
    const delays = this.hooks.resumeRetryMs ?? RESUME_RETRY_MS;
    const missing = this.players.find((p) => !s.players.some((x) => x.seat === p.seat.name));
    if (missing) {
      this.abandon();
      throw new GameVoidError(`could not reconnect to ${this.label} (${s.code}): no reconnect credentials for ${missing.seat.name}`, 'reconnect_failed');
    }
    // Each seat reconnects on its own: a seat that is back stays attached while the other retries.
    const attached = new Set<Player>();
    let refusals = 0;
    for (let attempt = 1; ; attempt++) {
      let last: unknown;
      let refusedOnly = true;
      await Promise.all(this.players.filter((p) => !attached.has(p)).map(async (p) => {
        const cred = s.players.find((x) => x.seat === p.seat.name)!;
        try {
          await this.attach(p);
          await p.phase.reconnect(s.code, cred.token, cred.full_key);
          attached.add(p);
        } catch (err) {
          last = err;
          if (!(err instanceof ReconnectRefused)) refusedOnly = false;
          p.phase.removeAllListeners();
          p.phase.close();
          p.phase = new PhaseSeat(this.phaseUrl, p.phase.displayName);
        }
      }));
      if (attached.size === this.players.length) break;
      const msg = String((last as Error)?.message ?? last);
      refusals = refusedOnly ? refusals + 1 : 0;
      if (this.closing || attempt > delays.length || refusals >= RESUME_REFUSALS) {
        this.abandon();
        throw new GameVoidError(`could not reconnect to ${this.label} (${s.code}) after ${attempt} tries: ${msg}`, 'reconnect_failed');
      }
      this.log('game_reconnect_retry', { game: this.label, ...this.meta, after: 'restart', attempt, error: msg.slice(0, 200) });
      await new Promise((r) => setTimeout(r, delays[attempt - 1]));
    }
    this.log('game_reconnect', { game: this.label, ...this.meta, after: 'restart', game_code: s.code });
    for (const p of this.players) this.watchSocket(p);
    return this.finish(done);
  }

  private async finish(done: Promise<GameResult>): Promise<GameResult> {
    try {
      return await done;
    } finally {
      this.closing = true;
      for (const p of this.players) {
        // Stop listening first: the other player's socket may still deliver queued pre-game-over updates.
        p.phase.removeAllListeners('update');
        p.seat.views = undefined;
        if (p.seat.pending && this.offerIds.has(p.seat.pending.id)) p.seat.clear();
        p.phase.close();
      }
    }
  }

  /**
   * A socket that closes while the game runs (phase-server restarted, network blip): reconnect it with the seat's
   * credentials, within phase-server's grace period. If that fails, the game is void (GameVoidError from play()).
   */
  private watchSocket(p: Player): void {
    const phase = p.phase;
    phase.once('closed', () => {
      if (this.closing || this.result || p.phase !== phase) return;
      void this.recoverSocket(p);
    });
  }

  private async recoverSocket(p: Player): Promise<void> {
    const cred = this.session?.players.find((x) => x.seat === p.seat.name);
    let last = 'no reconnect credentials';
    for (let i = 1; cred && i <= RECONNECT_TRIES && !this.closing && !this.result; i++) {
      await new Promise((r) => setTimeout(r, i === 1 ? 500 : RECONNECT_PAUSE_MS));
      if (this.closing || this.result) return;
      const fresh = new PhaseSeat(this.phaseUrl, p.phase.displayName);
      p.phase.removeAllListeners();
      p.phase = fresh;
      try {
        await this.attach(p);
        await fresh.reconnect(this.session!.code, cred.token, cred.full_key);
        this.log('game_reconnect', { game: this.label, ...this.meta, after: 'socket_closed', seat: p.seat.name, attempt: i });
        this.watchSocket(p);
        return;
      } catch (err) {
        last = String((err as Error)?.message ?? err);
        fresh.removeAllListeners();
        fresh.close();
      }
    }
    if (this.closing || this.result) return;
    this.failed?.(new GameVoidError(`lost the connection to ${this.label} and could not reconnect: ${last}`, 'connection_lost'));
  }

  /** The seat phase-server put on the play in the game being set up (its first state), from the held updates. */
  private startingSeat(): string | undefined {
    for (const list of this.held?.values() ?? []) {
      for (const u of list) {
        const s = u.state;
        const first = s?.current_starting_player ?? (s?.turn_number === 1 ? s.active_player : undefined);
        if (first != null) return this.players.find((x) => x.me === first)?.seat.name;
      }
    }
    return undefined;
  }

  private onUpdate(p: Player, u: PhaseUpdate): void {
    if (this.held) {
      this.held.get(p)?.push(u);
      return;
    }
    // Match memory: the opponent's cards this seat's own view shows (every update, not only decisions: a spell cast
    // and countered between two decisions was seen too). It reaches the seat only in later games of the match.
    if (u.state) for (const [id, name] of shownCards(u.state, 1 - p.me, p.me)) p.oppShown.set(id, name);
    // Once either side has seen game over, nothing more from this game may reach a seat.
    if (this.result) return;
    if (!p.render) p.render = new Renderer(this.cards, p.me);
    if (!p.obs) p.obs = new ObserverV4(this.cards, p.me);
    p.latest = u;
    if (p.slot === 0) this.observe(u);
    if (p.slot === 0 && u.state?.turn_number && u.state.turn_number !== this.lastSnapshotTurn) {
      this.lastSnapshotTurn = u.state.turn_number;
      this.log('turn_snapshot', { game: this.label, ...this.meta, turn: u.state.turn_number, ...this.snapshot(u.state) });
    }
    if (this.onPlay === undefined && u.state?.turn_number === 1 && u.state.active_player != null) {
      this.onPlay = this.players.find((x) => x.me === u.state.active_player)?.seat.name;
    }
    for (const entry of u.logEntries) {
      const line = p.render.logLine(entry);
      // Current prompts: the log as the seat reads it ("You draw a card", actors from the engine's objects).
      const ev = this.observation === 'v4' ? eventEntry(entry, p.me, u.state) : undefined;
      p.fullLog.push(ev ? `T${ev.turn} ${ev.step}: ${ev.text}` : line);
      if (!LOG_NOISE.test(line) && entry.presentation?.boundary !== 'Phase') {
        p.logSince.push(line);
        p.eventsSince.push(ev ?? eventEntry(entry, p.me, u.state));
      }
    }

    const wf = u.state?.waiting_for;
    if (wf?.type === 'GameOver') {
      if (!this.result) {
        const w = wf.data?.winner;
        const winnerSlot = w == null ? null : this.players.findIndex((x) => x.me === w);
        // The other seat's socket may never deliver its final update (this game closes both now): the public zones of
        // the final state are the same in both views, so it sees this seat's cards there (never this seat's hand).
        for (const q of this.players) if (q !== p) for (const [id, name] of shownCards(u.state, p.me, p.me)) q.oppShown.set(id, name);
        const opponentCardsSeen = Object.fromEntries(this.players.map((x) => [x.seat.name, countByName(x.oppShown)]));
        this.result = { winner: winnerSlot, turns: u.state.turn_number, stats: this.stats(), opponentCardsSeen };
        const life = Object.fromEntries(this.players.map((x) => [x.seat.name, u.state.players?.[x.me]?.life]));
        // A watchdog concession reads like other endings in the final state (e.g. empty libraries at the mulligan).
        const reason = this.forfeitedBy && this.players[winnerSlot ?? -1]?.seat.name !== this.forfeitedBy ? 'concede' : this.endReason(u, w);
        const { opponentCardsSeen: _seen, ...logged } = this.result;
        this.log('game_over', {
          game: this.label, ...this.meta, ...logged, winner: winnerSlot == null ? null : this.players[winnerSlot]!.seat.name,
          on_play: this.onPlay, final_life: life, end_reason: reason, ...(this.forfeitedBy ? { forfeited_by: this.forfeitedBy } : {}),
          mulligans: Object.fromEntries(this.players.map((x) => [x.seat.name, x.mulligans])),
          cards_played: Object.fromEntries(this.players.map((x) => [x.seat.name, this.played.get(x.seat.name) ?? { cast: {}, activated: {} }])),
          opponent_cards_seen: opponentCardsSeen,
          unimplemented: [...this.unimplemented.values()],
        });
        this.watch?.endBoard(this.label);
        this.finished?.(this.result);
      }
      if (p.seat.pending && this.offerIds.has(p.seat.pending.id)) p.seat.clear();
      return;
    }

    // The Director is tapping this seat's planned sources before an activation (answer → preTap): the updates in
    // between are not decisions.
    if (p.preTapping) return;
    const legal = ownActions(u.state, p.me, dedupe(u.legal));
    if (!legal.length) {
      if (p.seat.pending && this.offerIds.has(p.seat.pending.id)) {
        if (!p.seat.pending.answering) this.log('decision_withdrawn', { game: this.label, seat: p.seat.name, id: p.seat.pending.id, kind: p.seat.pending.kind });
        p.seat.clear();
      }
      return;
    }
    if (u.revision === p.answeredRevision || u.revision === p.offeredRevision) return;

    // A tap plan for a spell whose payment never came (it cost nothing in the end, or was canceled) must not pay
    // for a later one.
    if (wf?.type === 'Priority') {
      p.payQueue = undefined;
      p.payColor = undefined;
      p.optionTapped = false;
      p.paymentCounted = false;
    }
    // A tap plan's "any color" source: the engine asks which color; the plan (or what the cost still needs) answers.
    if (this.manaMode === 'manual' && p.payQueue && (wf?.type === 'ChooseManaColor' || wf?.type === 'ManaColorChoice')) {
      this.choosePlanColor(p, u, legal);
      return;
    }
    if (wf?.type === 'Priority' && this.shouldAutoPass(u, legal, p.me)) {
      p.autoPasses++;
      this.submit(p, u.revision, { type: 'PassPriority' }, 'auto_pass');
      return;
    }
    if (wf?.type === 'ManaPayment') {
      // Manual mode: carry out the agent's tap plan if it gave one; otherwise ask it below.
      if (this.manaMode === 'manual' && p.payQueue) {
        this.advancePayment(p, u, legal);
        return;
      }
      // The mana pool already pays the whole cost (the agent activated its sources as options, or floated mana):
      // finishing taps nothing more, so it is the agent's own payment, never the auto-tapper.
      if (this.manaMode === 'manual' && this.poolPays(u, p.me) && legal.some((a) => a.type === 'PassPriority')) {
        const byHand = p.optionTapped && !p.paymentCounted;
        if (byHand) p.manualPayments++;
        p.optionTapped = false;
        p.paymentCounted = true;
        this.submit(p, u.revision, { type: 'PassPriority' }, 'pay_finish', { from_pool: true, ...(byHand ? { by_hand: true } : {}) });
        return;
      }
      if (this.manaMode === 'auto' && legal.some((a) => a.type === 'PassPriority')) {
        p.forced++;
        this.submit(p, u.revision, { type: 'PassPriority' }, 'auto_pay');
        return;
      }
    }
    if (legal.length === 1 && !['Priority', 'DeclareAttackers', 'DeclareBlockers'].includes(wf?.type)) {
      p.forced++;
      this.submit(p, u.revision, legal[0], 'forced');
      return;
    }
    this.offer(p, u, legal);
  }

  private shouldAutoPass(u: PhaseUpdate, legal: any[], me: number): boolean {
    if (!legal.some((a) => a.type !== 'PassPriority')) return true;
    if (u.autoPassRecommended) return true;
    const s = u.state;
    const stack: any[] = s.stack ?? [];
    // Your own spell/ability on top: let it resolve. Opponent's: you may respond.
    if (stack.length) return stack[stack.length - 1]?.controller === me;
    return s.active_player === me ? !OWN_TURN_STOPS.has(s.phase) : !OPP_TURN_STOPS.has(s.phase);
  }

  private async submit(p: Player, revision: number, action: any, how: string, extra?: Record<string, unknown>): Promise<{ ok: boolean; reason?: string }> {
    p.answeredRevision = revision;
    let r = await p.phase.act(action);
    for (let retry = 0; !r.ok && r.reason === 'timeout' && retry < 3 && p.latest?.revision === revision; retry++) {
      this.log('resend', { game: this.label, seat: p.seat.name, revision, retry });
      r = await p.phase.act(action);
    }
    if (!r.ok && r.reason === 'timeout' && p.latest?.revision !== revision) r = { ok: true };
    // The game ended while we waited (its sockets are closed, so the action timed out): nothing more to do here.
    if (this.result) return r;
    if (how !== 'decide') this.log(how, { game: this.label, seat: p.seat.name, revision, action: action.type, ok: r.ok, reason: r.ok ? undefined : r.reason, ...extra });
    if (!r.ok) {
      p.answeredRevision = -1;
      // An automatic answer was refused: hand the decision to the agent instead.
      if (how !== 'decide' && how !== 'pre_tap' && p.latest) {
        const legal = ownActions(p.latest.state, p.me, dedupe(p.latest.legal));
        if (legal.length) this.offer(p, p.latest, legal);
      }
    }
    return r;
  }

  private offer(p: Player, u: PhaseUpdate, legal: any[]): void {
    // Never offer from a finished game: the seat may already be playing the next one (a late retry once replaced
    // a live game-2 decision with a stale game-1 one and stalled the match).
    if (this.result) return;
    const turn = u.state.turn_number;
    const usable = legal.filter((a) => p.refused.get(JSON.stringify(a)) !== turn);
    if (usable.length) legal = usable;
    p.offeredRevision = u.revision;
    const options: Option[] = legal.map((action, i) => ({ id: String(i + 1), label: this.label_(p.render, u.state, action), value: action }));
    this.shortList(p, u.state, options);
    const { prompt, accepts } = this.prompt(p, u, options);
    const kind = u.state.waiting_for?.type ?? 'Unknown';
    // The same decision again (a new engine revision while this seat still holds it, e.g. the opponent mulliganed):
    // keep its id, so an answer the agent is writing still counts.
    const prev = p.seat.pending;
    const same = !!prev && prev.phase === 'game' && this.offerIds.has(prev.id) && !prev.answering && prev.kind === kind && sameOptions(prev.options, options);
    if (!same) p.decisions++;
    const offer: Offer = {
      id: same ? prev!.id : p.seat.nextId('G'),
      phase: 'game',
      kind,
      text: '',
      options,
      createdAt: same ? prev!.createdAt : Date.now(),
      answer: (input, o) => this.answer(p, u, accepts, input, o),
      // Inactive seat (watchdog): concede this game for it on its own socket; the match goes on.
      forfeit: () => {
        if (p.seat.pending?.id === offer.id) p.seat.clear();
        this.forfeitedBy ??= p.seat.name;
        p.phase.concede();
        return { game: this.label, ...this.meta, turn };
      },
    };
    offer.text = this.decisionText(p, u, offer, prompt, accepts);
    if (OBS_DUMP) {
      try {
        appendFileSync(OBS_DUMP, JSON.stringify({
          game: this.label, seat: p.seat.name, id: offer.id, kind: offer.kind, me: p.me, state: pruneState(u.state),
          legal: legal.map(({ interactionActionId: _drop, ...a }) => a), byObject: pruneByObject(u.byObject), options: options.map((x) => ({ id: x.id, label: x.label })),
        }) + '\n');
      } catch (err) {
        console.error(`MTGDT_OBS_DUMP: ${String((err as Error)?.message ?? err)}`);
      }
    }
    if (same) {
      this.log('decision_refreshed', { game: this.label, seat: p.seat.name, id: offer.id, kind, turn: u.state.turn_number, text: offer.text });
      p.seat.offer(offer);
      return;
    }
    if (p.seat.pending?.phase === 'game' && !p.seat.pending.answering) {
      this.log('decision_withdrawn', { game: this.label, seat: p.seat.name, id: p.seat.pending.id, kind: p.seat.pending.kind });
    }
    const st = u.state;
    this.log('decision_offered', {
      game: this.label, seat: p.seat.name, id: offer.id, kind: offer.kind, turn: st.turn_number, phase: st.phase,
      active: st.active_player === p.me ? 'you' : 'opponent',
      life: { you: st.players?.[p.me]?.life, opponent: st.players?.[1 - p.me]?.life },
      hand: { you: st.players?.[p.me]?.hand?.length, opponent: st.players?.[1 - p.me]?.hand?.length },
      options: options.map((x) => x.label), text: offer.text,
    });
    this.offerIds.add(offer.id);
    p.seat.offer(offer);
  }

  /**
   * A named choice with a long list (every creature type: 381 options, 40 KB) lists only the names among the cards this
   * seat knows of (its deck, everything in view); the rest stay valid and are answered by name.
   */
  private shortList(p: Player, s: any, options: Option[]): void {
    if (s.waiting_for?.type !== 'NamedChoice' || options.length <= NAMED_CHOICE_LIST) return;
    const known = new Set<string>();
    const add = (t: string | undefined) => {
      for (const w of String(t ?? '').split(/[\s,—.;:()/"]+/)) if (w) known.add(w.toLowerCase());
    };
    const names = new Set<string>(this.decks[p.slot]?.main_deck ?? []);
    for (const o of Object.values(s.objects ?? {}) as any[]) if (o?.name && !o.face_down && o.name !== 'Hidden Card') names.add(String(o.name));
    for (const n of names) {
      const c = this.cards.get(n);
      add(n);
      add(c?.typeLine);
    }
    const listed = options.filter((x) => {
      const choice = (x.value as any)?.data?.choice;
      return typeof choice !== 'string' || choice.split(/\s+/).every((w) => known.has(w.toLowerCase()));
    });
    if (!listed.length || listed.length === options.length) return;
    for (const x of options) if (!listed.includes(x)) x.unlisted = true;
  }

  private async answer(p: Player, u: PhaseUpdate, accepts: Structured[], input: DecideInput, o: Offer): Promise<string | null> {
    const wf = u.state.waiting_for;
    let action: any;
    /** How the mana for this action is paid (logged; the mana metrics count it). */
    let payment: 'manual' | 'auto' | undefined;
    let preTap: string[] | undefined;
    // Fields this decision doesn't take are refused, never dropped (a seat once sent blocks with a priority pass).
    const extra = unexpectedFields(input, accepts, 'This decision');
    if (extra) return extra;
    if (given(input, 'mana') && input.option == null && wf?.type !== 'ManaPayment') {
      return '`mana` pays for the spell or ability you choose: give its `option` too, e.g. option="2", mana=["37"].';
    }
    if (input.mana && accepts.includes('mana') && input.option == null) {
      // A payment plan for the open ManaPayment decision: tap these sources, then finish.
      p.payQueue = [...input.mana];
      p.manualPayments++;
      p.paymentCounted = true;
      this.log('agent_decision', {
        game: this.label, seat: p.seat.name, id: o.id, kind: o.kind, turn: u.state.turn_number, latency_ms: Date.now() - o.createdAt,
        choice: `Tap ${this.manaLabel(u.state, input.mana)}`, accepted: true,
      });
      this.advancePayment(p, u, dedupe(u.legal));
      return null;
    }
    // The option chosen, if any (undefined for a structured answer).
    let chosen: Option | undefined;
    // A structured answer (attackers, blocks, cards) is the seat's exact intent: it wins over `option`. Both given and
    // they disagree: refused, so a 6-blocker answer is never cut down to one option's single block.
    const field = (['attackers', 'blocks', 'cards'] as const).find((f) => input[f] && accepts.includes(f));
    if (field) {
      const structured = this.structuredAction(p, u, field, input);
      if (typeof structured === 'string') return structured;
      if (input.option != null) {
        const opt = o.options.find((x) => x.id === String(input.option)) ?? byName(o.options, input.option);
        if (!opt) return `${unknownOption(o, input.option)} Or leave out \`option\`: your \`${field}\` list alone answers this decision.`;
        if (!sameStructured(field, opt.value, structured)) {
          return `option "${opt.id}" (${opt.label}) and your \`${field}\` (${this.label_(p.render, u.state, structured)}) disagree; nothing was applied. `
            + `Answer again with one of them: \`${field}\` alone for exactly what you listed, or \`option\` alone.`;
        }
      }
      action = structured;
    } else if (input.option != null) {
      chosen = o.options.find((x) => x.id === String(input.option)) ?? byName(o.options, input.option);
      action = chosen?.value;
      if (!action) return unknownOption(o, input.option);
      const mana = this.manaMode === 'manual' ? manaCostOf(u.state, action) : undefined;
      if (input.mana?.length && this.manaMode === 'manual' && !mana) {
        return `"${chosen!.label}" has no mana cost to pay; leave out \`mana\` (it is for spells and abilities that cost mana).`;
      }
      if (this.manaMode === 'manual' && isCast(action) && mana) {
        // Spells: the engine asks for the payment (ManaPayment), which the plan, if any, answers tap by tap.
        action = { ...action, data: { ...action.data, payment_mode: { type: 'Manual' } } };
        if (input.mana?.length) {
          p.payQueue = [...input.mana];
          p.manualPayments++;
          p.paymentCounted = true;
        }
      } else if (mana) {
        // Abilities and prepared copies have no manual payment in the engine, which pays them from the mana pool
        // first: tap the planned sources into the pool, then activate. Without a plan the engine's auto-tapper pays.
        if (input.mana?.length) preTap = [...input.mana];
        else payment = 'auto';
      }
      if (wf?.type === 'ManaPayment' && action.type === 'PassPriority' && !this.poolPays(u, p.me)) p.autoTapper++;
      if (wf?.type === 'ManaPayment' && isManaAction(u.state, action)) p.optionTapped = true;
    } else {
      return `Give \`option\`${accepts.length ? ` or ${accepts.join('/')}` : ''}.`;
    }
    const latency = Date.now() - o.createdAt;
    const label = chosen ? chosen.label : this.label_(p.render, u.state, action);
    let r: { ok: boolean; reason?: string };
    let autoTapped: number[] = [];
    if (preTap) {
      const pre = await this.preTap(p, u, preTap, manaCostOf(u.state, action));
      if (!pre.ok) {
        p.payFailures++;
        this.log('agent_decision', {
          game: this.label, seat: p.seat.name, id: o.id, kind: o.kind, turn: u.state.turn_number, latency_ms: latency,
          choice: `${label} (tapping ${this.manaLabel(u.state, preTap)})`, structured: false, accepted: false, action: action.type, reason: pre.reason,
        });
        // Sources already tapped stay tapped and their mana floats: offer the decision again from the new state.
        if (pre.tapped && p.latest && p.latest !== u) {
          p.offeredRevision = -1;
          this.offer(p, p.latest, ownActions(p.latest.state, p.me, dedupe(p.latest.legal)));
          return `${pre.reason} The mana already tapped stays in your pool; the decision is offered again.`;
        }
        return pre.reason!;
      }
      // The action's own objects (a source with {T} in its cost) are tapped by the cost itself, not by the auto-tapper.
      const own = new Set(actionObjects(action));
      const before = new Set(this.manaSources(p.latest ?? u).map((x) => x.id).filter((id) => !own.has(id)));
      r = await this.submit(p, (p.latest ?? u).revision, action, 'decide');
      // Did the engine tap anything beyond the plan (the plan fell short)? Then the payment was only partly the agent's.
      const now = p.latest?.state;
      autoTapped = [...before].filter((id) => now?.objects?.[String(id)]?.tapped);
      if (r.ok) {
        p.manualPayments++;
        if (autoTapped.length) p.autoPaid++;
      }
      payment = 'manual';
    } else {
      r = await this.submit(p, u.revision, action, 'decide');
      if (r.ok && payment === 'auto') p.autoPaid++;
    }
    if (r.ok && action.type === 'MulliganDecision' && action.data?.choice?.type === 'Mulligan') p.mulligans++;
    const card = actionCard(u.state, action);
    const tapping = input.mana?.length && (payment === 'manual' || action.data?.payment_mode?.type === 'Manual');
    this.log('agent_decision', {
      game: this.label, seat: p.seat.name, id: o.id, kind: o.kind, turn: u.state.turn_number, latency_ms: latency,
      choice: `${label}${tapping ? ` (tapping ${this.manaLabel(u.state, input.mana!)})` : ''}`, structured: !chosen, accepted: r.ok,
      // payment: "auto" = the engine paid this ability's mana by itself (no plan); "manual+auto" = it tapped more
      // sources after the agent's plan (auto_tapped).
      ...(payment === 'auto' ? { payment: 'auto' } : payment === 'manual' && autoTapped.length ? { payment: 'manual+auto', auto_tapped: autoTapped } : {}),
      ...(card ? { card } : {}), ...(r.ok ? {} : { action: action.type, reason: r.reason }),
    });
    if (!r.ok) {
      p.rejections++;
      // Don't let the agent pick a refused option again: cross it out in the decision text.
      const refused = chosen;
      if (refused) {
        p.refused.set(JSON.stringify(refused.value), u.state.turn_number);
        o.options = o.options.filter((x) => x !== refused);
        o.text = o.text.replace(`  [${refused.id}] ${refused.label}`, `  [${refused.id}] (not available: the rules engine refused "${refused.label}")`)
          .replace(`"label":${JSON.stringify(refused.label)}`, `"label":${JSON.stringify(`(not available: the rules engine refused "${refused.label}")`)},"refused":true`);
      }
      p.offeredRevision = u.revision;
      return `the rules engine refused it (${r.reason}).`;
    }
    return null;
  }

  /** The engine action for a structured answer (attackers, blocks, cards), or why it can't be one. */
  private structuredAction(p: Player, u: PhaseUpdate, field: 'attackers' | 'blocks' | 'cards', input: DecideInput): any | string {
    const wf = u.state.waiting_for;
    // Only what the engine offered (SEC-8): the agent's raw ids never reach phase-server unchecked, so a seat can't
    // name the opponent's creature as an attacker or blocker, or select a card outside the choice (the engine has
    // taken out-of-range selections before: see ownActions).
    if (field === 'attackers') {
      const valid = new Set<number>(wf.data?.valid_attacker_ids ?? []);
      const bad = input.attackers!.filter((id) => !valid.has(id));
      if (bad.length) return `${ids(bad)} can't attack now; creatures that can attack: ${ids([...valid]) || 'none'}. Nothing was applied.`;
      if (new Set(input.attackers).size !== input.attackers!.length) return 'each attacker once: `attackers` repeats an id. Nothing was applied.';
      const byAttacker = wf.data?.valid_attack_targets_by_attacker ?? {};
      const attacks = input.attackers!.map((id) => {
        const targets: any[] = byAttacker[String(id)] ?? wf.data?.valid_attack_targets ?? [];
        const target = targets.find((t) => t.type === 'Player' && t.data !== p.me) ?? targets[0] ?? { type: 'Player', data: 1 - p.me };
        return [id, target];
      });
      return { type: 'DeclareAttackers', data: { attacks, bands: [] } };
    }
    if (field === 'blocks') {
      const targets: Record<string, number[]> = wf.data?.valid_block_targets ?? {};
      const bad = input.blocks!.filter((b) => !(targets[String(b.blocker)] ?? []).includes(b.attacker));
      if (bad.length) return `${bad.map((b) => `#${b.blocker} blocking #${b.attacker}`).join(', ')}: not a possible block (see "can block" in the decision). Nothing was applied.`;
      return { type: 'DeclareBlockers', data: { assignments: input.blocks!.map((b) => [b.blocker, b.attacker]) } };
    }
    if (wf?.type === 'MulliganDecision' || wf?.type === 'OpeningHandBottomCards') {
      // Only cards from this seat's own hand (the engine would take the opponent's: see ownActions).
      const hand = new Set<number>(u.state.players?.[p.me]?.hand ?? []);
      const bad = input.cards!.filter((id) => !hand.has(id));
      if (bad.length) return `${bad.map((id) => `#${id}`).join(', ')} ${bad.length === 1 ? 'is' : 'are'} not in your hand; choose cards from your hand.`;
    }
    // Any other selection: only cards the engine offered (in its legal selections or the choice's own card list).
    const offered = new Set<number>();
    for (const a of u.legal ?? []) if (a?.type === 'SelectCards') for (const id of a.data?.cards ?? []) offered.add(id);
    for (const id of wf?.data?.cards ?? []) if (typeof id === 'number') offered.add(id);
    const outside = input.cards!.filter((id) => !offered.has(id));
    if (offered.size && outside.length) return `${ids(outside)} ${outside.length === 1 ? 'is' : 'are'} not among the cards you can choose (${ids([...offered])}). Nothing was applied.`;
    if (new Set(input.cards).size !== input.cards!.length) return 'each card once: `cards` repeats an id. Nothing was applied.';
    return { type: 'SelectCards', data: { cards: input.cards } };
  }

  /**
   * Tap the agent's planned sources into the mana pool, in order, before an action the engine pays by itself (an
   * activated ability, a prepared copy): the engine spends floating mana first, so the plan pays the cost. The
   * updates in between are not offered (Player.preTapping).
   */
  private async preTap(p: Player, u: PhaseUpdate, plan: string[], cost: any): Promise<{ ok: boolean; reason?: string; tapped: number }> {
    p.preTapping = true;
    let tapped = 0;
    try {
      const need: string[] = [...(cost?.shards ?? [])].filter((x: unknown) => typeof x === 'string');
      for (const entry of plan) {
        const cur = p.latest ?? u;
        const [idPart, colorPart] = entry.split(':');
        const wanted = colorPart ? COLOR_NAME[colorPart.trim().toUpperCase()] ?? colorPart.trim() : undefined;
        const pick = this.planSource(cur, idPart!, wanted, need);
        if (!pick) return { ok: false, tapped, reason: this.notASource(cur, entry, idPart!, wanted) };
        const colors = manaActionColors(cur.state, pick);
        const made = wanted && colors.includes(wanted) ? wanted : colors.find((c) => need.includes(c)) ?? colors[0];
        const i = need.indexOf(made!);
        if (i >= 0) need.splice(i, 1);
        const { interactionActionId: _drop, ...act } = pick;
        const r = await this.submit(p, cur.revision, act, 'pre_tap');
        if (!r.ok) return { ok: false, tapped, reason: `The engine refused tapping "${entry}" (${r.reason}).` };
        // An "any color" source: the engine asks for the color next.
        const next = p.latest;
        const wt = next?.state?.waiting_for?.type;
        if (next && (wt === 'ChooseManaColor' || wt === 'ManaColorChoice')) {
          const color = pickColor(dedupe(next.legal), made ? [made] : [], need);
          if (!color) return { ok: false, tapped, reason: `Couldn't choose a color for "${entry}".` };
          const c = await this.submit(p, next.revision, color, 'pre_tap');
          if (!c.ok) return { ok: false, tapped, reason: `The engine refused the color for "${entry}" (${c.reason}).` };
        }
        tapped++;
      }
      return { ok: true, tapped };
    } finally {
      p.preTapping = false;
    }
  }

  private prompt(p: Player, u: PhaseUpdate, options: Option[]): { prompt: string; accepts: Structured[] } {
    const s = u.state;
    const r = p.render;
    const wf = s.waiting_for ?? { type: 'Unknown' };
    const d = wf.data ?? {};
    const accepts: Structured[] = [];
    const cardName = (id: unknown) => {
      const o = typeof id === 'number' ? r.obj(s, id) : undefined;
      return o && !o.face_down && o.name !== 'Hidden Card' ? String(o.name) : 'this';
    };
    let prompt: string;
    switch (wf.type) {
      case 'Priority': {
        prompt = 'You have priority. Choose an action, or pass priority.';
        const values = options.map((x) => x.value);
        const casts = values.some((a) => isCast(a) && manaCostOf(s, a));
        const abilities = values.some((a) => !isCast(a) && manaCostOf(s, a));
        if (this.manaMode === 'manual' && (casts || abilities)) {
          if (casts) prompt += '\nWhen casting, you choose which mana sources to tap: add mana=["<id>", …] (e.g. "50:U" for a specific color from a multi-color land). Without it you will be asked how to pay.';
          if (abilities) prompt += `\n${casts ? 'Abilities' : 'When activating an ability'} with a mana cost (and prepared copies) take mana=["<id>", …] too: those sources are tapped first and pay the cost. Without it the engine's auto-tapper pays (recorded).`;
          accepts.push('mana');
        }
        break;
      }
      case 'MulliganDecision': {
        const mine = (d.pending ?? []).find((x: any) => x.player === p.me);
        if (mine?.phase?.type === 'BottomCards') {
          prompt = `Choose ${mine.phase.count} card(s) from your hand to put on the bottom of your library. Pass \`cards\` with the object ids, or pick an option.`;
          accepts.push('cards');
        } else {
          prompt = `Opening hand${mine?.mulligan_count ? ` (after ${mine.mulligan_count} mulligan(s))` : ''}: keep or mulligan?`;
        }
        break;
      }
      case 'OpeningHandBottomCards': {
        const mine = (d.pending ?? []).find((x: any) => x.player === p.me);
        prompt = `Choose ${mine?.count ?? ''} card(s) from your hand to put on the bottom of your library. Pass \`cards\` with the object ids, or pick an option.`;
        accepts.push('cards');
        break;
      }
      case 'DeclareAttackers': {
        const ids: number[] = d.valid_attacker_ids ?? [];
        prompt = `Declare attackers. Creatures that can attack: ${ids.map((id) => r.ref(s, id)).join(', ') || 'none'}.\n`
          + 'Pass `attackers` with the object ids that should attack the opponent (empty list = no attack), or pick an option.';
        accepts.push('attackers');
        break;
      }
      case 'DeclareBlockers': {
        const targets: Record<string, number[]> = d.valid_block_targets ?? {};
        const lines = Object.entries(targets).map(([b, as]) => `  ${r.ref(s, Number(b))} can block: ${as.map((a) => r.ref(s, a)).join(', ')}`);
        prompt = `Declare blockers.\n${lines.join('\n') || '  (no possible blocks)'}\n`
          + 'Pass `blocks` as [{blocker, attacker}] (empty list = no blocks), or pick an option.';
        accepts.push('blocks');
        break;
      }
      case 'TargetSelection':
      case 'TriggerTargetSelection': {
        const src = d.pending_cast?.object_id ?? d.trigger_event?.data?.object_id;
        prompt = `Choose a target${src != null ? ` for ${r.ref(s, src)}` : ''}.`;
        break;
      }
      case 'ModeChoice':
      case 'AbilityModeChoice':
        prompt = `Choose mode(s) (min ${d.modal?.min_choices ?? 1}, max ${d.modal?.max_choices ?? 1}).`;
        break;
      case 'ScryChoice':
      case 'SurveilChoice':
        prompt = `${wf.type === 'ScryChoice' ? 'Scry' : 'Surveil'}: looking at ${(d.cards ?? []).map((id: number) => r.ref(s, id)).join(', ')}. `
          + `Pass \`cards\` with the ids to keep on top (the rest go to the ${wf.type === 'ScryChoice' ? 'bottom' : 'graveyard'}), or pick an option.`;
        accepts.push('cards');
        break;
      case 'DiscardChoice':
      case 'DiscardToHandSize':
        prompt = `Discard ${d.count} card(s). Pass \`cards\` with the ids to discard, or pick an option.`;
        accepts.push('cards');
        break;
      case 'EffectZoneChoice':
        prompt = `Choose ${d.count ?? ''} card(s) for ${d.source_id != null ? r.ref(s, d.source_id) : 'an effect'}. Pass \`cards\` with ids, or pick an option.`;
        accepts.push('cards');
        break;
      case 'OrderTriggers':
        prompt = 'Order your simultaneous triggers (the first listed goes on the stack first, so it resolves last).';
        break;
      case 'AssignCombatDamage':
        prompt = `Assign ${d.total_damage} combat damage from ${r.ref(s, d.attacker_id)}.`;
        break;
      case 'OptionalEffectChoice':
        prompt = `Optional effect from ${r.ref(s, d.source_id)}: ${String(d.description ?? '').replace(/~/g, cardName(d.source_id))}`;
        break;
      case 'AlternativeCastChoice':
        prompt = `Cast ${s.pending_cast?.object_id != null ? r.ref(s, s.pending_cast.object_id) : 'this spell'} normally or for its alternative cost?`;
        break;
      case 'ManaColorChoice':
      case 'ChooseManaColor':
        prompt = 'Choose which color(s) of mana to make.';
        break;
      case 'OptionalCostChoice': {
        const pc = d.pending_cast ?? s.pending_cast;
        const what = additionalCostText(d.cost);
        prompt = `Pay the optional additional cost${what ? ` (${what})` : ''}${pc?.object_id != null ? ` for ${r.ref(s, pc.object_id)}` : ''}?`
          + (this.observation === 'v4' ? ' The card\'s text is in "cards".' : ' (kicker-style costs; check the card text with get_card)');
        break;
      }
      case 'ManaPayment': {
        const pc = s.pending_cast;
        const what = pc?.object_id != null ? r.ref(s, pc.object_id) : 'this spell or ability';
        const pool = (s.players?.[p.me]?.mana_pool?.mana ?? []).map((m: any) => `{${COLOR_LETTER[m.color] ?? m.color}}`).join('') || 'empty';
        const sources = this.manaSources(u).map(({ id, colors }) => `  ${r.ref(s, id)}: ${colors.join(' or ')}`);
        prompt = `Pay ${pc?.cost ? formatCost(pc.cost) : 'the cost'} for ${what}. Mana pool: ${pool}.\n`
          + `Untapped mana sources:\n${sources.join('\n') || '  (none)'}\n`
          + 'Choose which to tap with mana=["<id>", …] (add ":U" etc. to pick a color from a multi-color source); the payment finishes after the last tap. '
          + 'Or pick an option (the auto-tapper choice is recorded).';
        if (p.payError) {
          prompt = `${p.payError}\n${prompt}`;
          p.payError = undefined;
        }
        accepts.push('mana');
        break;
      }
      case 'SearchChoice':
        prompt = `Search your library${d.source_id != null ? ` for ${r.ref(s, d.source_id)}` : ''}: choose what to find.`;
        break;
      case 'PayCost': {
        const src = d.source_id ?? s.pending_cast?.object_id;
        const kind = d.kind == null ? '' : words(typeof d.kind === 'string' ? d.kind : d.kind.type ?? Object.keys(d.kind)[0] ?? '');
        const n = d.count ?? 1;
        const range = d.min_count != null && d.min_count !== n ? `${d.min_count} to ${n}` : String(n);
        prompt = `Pay an additional cost${src != null ? ` for ${r.ref(s, src)}` : ''}${kind ? `: ${kind}` : ''} (choose ${range}).`;
        break;
      }
      case 'ChooseXValue': {
        const pc = d.pending_cast ?? s.pending_cast;
        const id = pc?.object_id;
        const cost = id != null ? formatCost(r.obj(s, id)?.mana_cost) : '';
        prompt = `Choose X for ${id != null ? `${r.ref(s, id)}${cost ? ` ${cost}` : ''}` : 'this spell or ability'} (X from ${d.min ?? 0} to ${d.max ?? '?'}).`;
        break;
      }
      case 'ChooseOneOfBranch':
        prompt = `${d.source_id != null ? `${r.ref(s, d.source_id)}: choose` : 'Choose'} one.`;
        break;
      case 'UnlessPayment': {
        const src = d.pending_effect?.source_id;
        const effect = String(d.effect_description ?? findDescription(d.pending_effect) ?? '').replace(/~/g, cardName(src));
        // The engine's text usually states the deal itself ("Counter target spell unless its controller pays {2}.").
        prompt = `${src != null ? `${r.ref(s, src)}: ` : ''}${effect ? `${effect.replace(/\s*$/, '').replace(/([^.!?])$/, '$1.')} ` : ''}Pay ${costText(d.cost) || 'the cost'}?`;
        break;
      }
      case 'CrewVehicle':
        prompt = `Crew ${d.vehicle_id != null ? r.ref(s, d.vehicle_id) : 'the vehicle'}${d.crew_power ? ` (crew ${d.crew_power}: tap creatures with total power ${d.crew_power} or more)` : ''}.`;
        break;
      case 'DigChoice': {
        const n = d.keep_count ?? 1;
        prompt = `${stackTop(r, s) ? `${stackTop(r, s)}: ` : ''}choose ${d.up_to ? 'up to ' : ''}${n} card${n === 1 ? '' : 's'} from the ${(d.cards ?? []).length || ''} you look at${d.kept_destination ? ` (they go to your ${words(String(d.kept_destination))}` : ''}${d.kept_destination && d.rest_destination ? `, the rest to your ${words(String(d.rest_destination))})` : d.kept_destination ? ')' : ''}.`.replace('from the  you', 'from the cards you');
        break;
      }
      case 'RevealChoice':
        prompt = `Choose a card from your hand to reveal${d.optional ? ' (you may decline)' : ''}${s.stack?.length ? ` (for ${stackTop(r, s)})` : ''}.`;
        break;
      case 'WardDiscardChoice':
        prompt = `Ward: choose ${d.remaining ?? 1} card(s) to discard to pay the ward cost.`;
        break;
      case 'TopOrBottomChoice':
        prompt = `Put ${d.object_id != null ? r.ref(s, d.object_id) : 'the card'} on the top or the bottom of your library?`;
        break;
      case 'NamedChoice': {
        const type = d.choice_type == null ? 'option' : words(typeof d.choice_type === 'string' ? d.choice_type : d.choice_type.type ?? Object.keys(d.choice_type)[0] ?? 'option');
        const listed = options.filter((x) => !x.unlisted).length;
        prompt = `Choose a ${type}${stackTop(r, s) ? ` (for ${stackTop(r, s)})` : ''}.`
          + (listed < options.length ? ` The options below are the ${type}s among the cards you know of; any other of the ${options.length} allowed values works too: give its name as the option (option=list shows them all).` : '');
        break;
      }
      default: {
        const src = d.source_id ?? d.object_id;
        prompt = `${words(wf.type)}${src != null && typeof src === 'number' ? ` (${r.ref(s, src)})` : ''}: choose an option.`;
      }
    }
    return { prompt, accepts };
  }

  /** The game's name in seat-facing text: never the seats' names (see GameHooks.seatLabel). */
  private get seatLabel(): string {
    return this.hooks.seatLabel ?? `Game ${Number(this.meta.game_number) || 1}`;
  }

  private get observation(): ObservationFormat {
    return this.hooks.observation ?? 'v3';
  }

  private decisionText(p: Player, u: PhaseUpdate, o: Offer, prompt: string, accepts: Structured[]): string {
    const since = p.logSince.slice(-MAX_EVENTS);
    const events = p.eventsSince.slice(-MAX_EVENTS);
    // Say when earlier events were left out, and where to read them.
    const omitted = Math.max(0, p.eventsSince.length - MAX_EVENTS);
    p.logSince = [];
    p.eventsSince = [];
    const v4 = this.observation === 'v4';
    const text = v4 ? this.textV4(p, u, o, prompt, accepts, since, events, OBS_ENVELOPE, omitted) : this.textV3(p, u.state, o, prompt, accepts, since, p.seenCards);
    if (OBS_COMPARE) {
      try {
        const other = v4 ? this.textV3(p, u.state, o, prompt, accepts, since, p.shadowSeen) : this.textV4(p, u, o, prompt, accepts, since, events, OBS_ENVELOPE);
        const cur = v4 ? text : other;
        const otherEnvelope = this.textV4(p, u, o, prompt, accepts, since, events, OBS_ENVELOPE === 'json' ? 'text' : 'json');
        appendFileSync(OBS_COMPARE, JSON.stringify({
          game: this.label, seat: p.seat.name, id: o.id, kind: o.kind, turn: u.state.turn_number,
          v3: v4 ? other : text, v4: cur, [`v4_${OBS_ENVELOPE === 'json' ? 'text' : 'json'}`]: otherEnvelope,
        }) + '\n');
      } catch (err) {
        console.error(`MTGDT_OBS_COMPARE: ${String((err as Error)?.message ?? err)}`);
      }
    }
    return text;
  }

  /** Prompt v2/v3: text board, card text the first time a card is seen this game. */
  private textV3(p: Player, s: any, o: Offer, prompt: string, accepts: Structured[], since: string[], seen: Set<string>): string {
    const r = p.render;
    const parts: string[] = [`[${this.seatLabel}]`];
    if (since.length) parts.push('Since your last decision:', ...since.map((l) => `  ${l}`), '');
    parts.push(r.view(s), '');
    const fresh = r.visibleNames(s).filter((n) => !seen.has(n));
    if (fresh.length) {
      parts.push('Card reference (cards you have not seen yet this game):');
      for (const n of fresh) {
        parts.push(`  ${this.cards.describe(n)}`);
        seen.add(n);
      }
      parts.push('');
    }
    parts.push(`DECISION ${o.id} — ${prompt}`);
    for (const x of o.options) if (!x.unlisted) parts.push(`  [${x.id}] ${x.label}`);
    parts.push('', `Answer with decide(decision_id="${o.id}", option="<id>"${accepts.length ? ` or ${accepts.join('/')}` : ''}).`);
    return parts.join('\n');
  }

  /** What this seat knows outside the engine state: its decklist, the match so far, who was on the play, mulligans. */
  private context(p: Player): V4Context {
    const other = this.players[1 - p.slot]!;
    const deck = this.decks[p.slot];
    const rel = (name: string | null | undefined): 'you' | 'opponent' | 'draw' => (name == null ? 'draw' : name === p.seat.name ? 'you' : 'opponent');
    const m = this.hooks.match;
    return {
      deck: deck ? { main: deck.main_deck, sideboard: deck.sideboard } : undefined,
      opponentSideboard: this.decks[other.slot]?.sideboard.length,
      ...(m ? { match: { game: m.game, best_of: m.bestOf, results: m.results.map((r) => ({ game: r.game, winner: rel(r.winner), turns: r.turns })) } } : {}),
      ...(m?.opponentSeen?.[p.seat.name] ? { opponentSeen: m.opponentSeen[p.seat.name] } : {}),
      ...(this.onPlay ? { onPlay: this.onPlay === p.seat.name ? 'you' as const : 'opponent' as const } : {}),
      mulligans: { you: p.mulligans, opponent: other.mulligans },
    };
  }

  /**
   * The game decision (current prompts): everything this seat can see, as structured data, plus the printed data of
   * every card in view. 'json': one JSON object between a one-line header and the answer line; 'text': the earlier
   * layout (summary, log lines and options as text around the JSON state), kept for measurement.
   */
  private textV4(p: Player, u: PhaseUpdate, o: Offer, prompt: string, accepts: Structured[], since: string[], events: EventEntry[], envelope: Envelope, omitted = 0): string {
    const v = p.obs.render(u.state, { byObject: u.byObject, options: o.options, context: this.context(p) });
    const answer = `decide(decision_id="${o.id}", option="<id>"${accepts.length ? ` or ${accepts.join('/')}` : ''})`;
    if (envelope === 'text') {
      const parts: string[] = [`[${this.seatLabel}] ${v.summary}`, ''];
      if (since.length) parts.push('Since your last decision:', ...since.map((l) => `  ${l}`), '');
      parts.push('STATE (JSON; object ids stay fixed for the whole game; "card" names key into CARDS):', v.json, '');
      if (v.cards) parts.push('CARDS (printed data of every card in view):', v.cards, '');
      parts.push(`DECISION ${o.id} — ${prompt}`);
      for (const x of o.options) if (!x.unlisted) parts.push(`  [${x.id}] ${x.label}`);
      parts.push('', `Answer with ${answer}.`);
      return parts.join('\n');
    }
    const decision = {
      id: o.id, kind: words(o.kind), instruction: prompt, answer_with: accepts.length ? ['option', ...accepts] : ['option'],
      options: o.options.filter((x) => !x.unlisted).map((x) => optionJson(x, p.me)),
    };
    // The header line is the summary; the body holds the rest.
    const body = {
      ...(omitted ? { earlier_events: `+${omitted} earlier event${omitted === 1 ? '' : 's'} since your last decision; call get_game_log to read them` } : {}),
      events_since_last: events, state: v.state, cards: v.cardList, decision,
    };
    return [
      `[${this.seatLabel}] ${v.summary}`,
      'Everything you can see, as JSON: object ids stay fixed for the whole game; "card" names key into "cards" (printed data); "decision" lists your options.',
      compactJson(body),
      `DECISION ${o.id} — answer with ${answer}.`,
    ].join('\n');
  }

  private label_(r: Renderer, s: any, a: any): string {
    const wf = s.waiting_for ?? {};
    const d = a.data ?? {};
    switch (a.type) {
      case 'PassPriority': return wf.type === 'ManaPayment' ? 'Let the auto-tapper pay (recorded)' : 'Pass priority';
      case 'PlayLand': return `Play land ${r.ref(s, d.object_id)}`;
      case 'CastSpell': {
        const base = `Cast ${r.ref(s, d.object_id)} ${formatCost(r.obj(s, d.object_id)?.mana_cost)}`;
        // Current prompts: a card with another castable face (adventure, modal DFC, split) is cast either way; the
        // face is chosen next. Older prompts keep their exact labels.
        const back = this.observation === 'v4' && !(r.obj(s, d.object_id)?.back_face?.card_types?.core_types ?? []).includes('Land') ? r.obj(s, d.object_id)?.back_face : undefined;
        const kind = back?.layout_kind && ({ Adventure: 'adventure', Modal: 'other face', Split: 'other half', Omen: 'omen' } as Record<string, string>)[back.layout_kind];
        return kind && back.name ? `${base}, or its ${kind} ${back.name} ${v4Cost(formatCost(back.mana_cost)) || ''}`.trimEnd() + ' (you choose which next)' : base;
      }
      case 'ActivateAbility': {
        // The ability's text (engine description, else the printed line with its cost, else the keyword); the number
        // is 1-based, as in usable_now.
        const o = r.obj(s, d.source_id);
        const text = o && !o.face_down && o.name !== 'Hidden Card' ? abilityText(o, Number(d.ability_index ?? 0), this.cards.get(String(o.name))?.oracle) : undefined;
        return `Activate ${r.ref(s, d.source_id)}${text ? `: ${text}` : ` (ability ${Number(d.ability_index ?? 0) + 1})`}`;
      }
      case 'ChooseTarget': {
        const t = d.target;
        if (t == null) return 'No target (skip this optional target)';
        if (t.Player != null) return `Target player: ${r.who(t.Player)}`;
        if (t.Object != null) return `Target ${r.ref(s, t.Object)} (${r.who(r.obj(s, t.Object)?.controller)})`;
        return `Target ${JSON.stringify(t)}`;
      }
      case 'MulliganDecision': return d.choice?.type === 'Keep' ? 'Keep this hand' : 'Mulligan';
      case 'SelectModes': {
        const descs: string[] = wf.data?.modal?.mode_descriptions ?? [];
        const src = r.obj(s, wf.data?.source_id ?? s.pending_cast?.object_id);
        const name = src && !src.face_down && src.name !== 'Hidden Card' ? String(src.name) : 'this';
        const chosen = (d.indices ?? []).map((i: number) => String(descs[i] ?? `#${i}`).replace(/~/g, name));
        return chosen.length ? `Mode: ${chosen.join(' + ')}` : 'No mode';
      }
      case 'ChooseX': {
        // With the total cost for that X, when the engine previews it.
        const preview = (wf.data?.x_cost_previews ?? []).find((x: any) => Array.isArray(x) && x[0] === d.value);
        return `X = ${d.value}${preview ? ` (total cost ${formatCost(preview[1])})` : ''}`;
      }
      case 'ChooseBranch': {
        const desc = wf.data?.branch_descriptions?.[d.index] ?? findDescription(wf.data?.branches?.[d.index]);
        return desc ? `Choose: ${desc}` : `Choose option ${Number(d.index ?? 0) + 1}`;
      }
      case 'PayUnlessCost': {
        const cost = costText(wf.data?.cost);
        return d.pay ? `Pay ${cost || 'the cost'}` : "Don't pay";
      }
      case 'ChooseOption': return typeof d.choice === 'string' ? `Choose ${d.choice}` : humanizeAction(r, s, a);
      case 'SelectCards': return `Select: ${(d.cards ?? []).map((id: number) => r.ref(s, id)).join(', ') || 'none'}`;
      case 'OrderTriggers': {
        const trig: any[] = wf.data?.triggers ?? [];
        return `Order: ${(d.order ?? []).map((i: number) => trig[i]?.source_name ?? `#${i}`).join(' → ')}`;
      }
      case 'DeclareAttackers':
        return d.attacks?.length ? `Attack with ${d.attacks.map((x: any) => r.ref(s, x[0])).join(', ')}` : 'No attack';
      case 'DeclareBlockers':
        return d.assignments?.length ? `Block: ${d.assignments.map((x: any) => `${r.ref(s, x[0])} blocks ${r.ref(s, x[1])}`).join('; ')}` : 'No blocks';
      case 'AssignCombatDamage':
        return `Damage: ${(d.assignments ?? []).map((x: any) => `${x[1]} to ${r.ref(s, x[0])}`).join(', ')}${d.trample_damage ? `, ${d.trample_damage} trample to the player` : ''}`;
      case 'DecideOptionalEffect': return d.accept ? 'Yes' : 'No';
      case 'ChooseTopOrBottom': {
        const id = wf.data?.object_id;
        const it = id != null ? r.ref(s, id) : 'it';
        return d.top ? `Put ${it} on top` : `Put ${it} on the bottom`;
      }
      case 'CancelCast': return 'Cancel (undo this spell/ability)';
      case 'ChooseManaColor': {
        const c = d.choice ?? {};
        const colors: string[] = Array.isArray(c.data) ? c.data : [c.data];
        return `Make ${colors.map((x) => `{${COLOR_LETTER[x] ?? x}}`).join('')}${d.count > 1 ? ` ×${d.count}` : ''}`;
      }
      case 'ChooseAlternativeCast':
      case 'AlternativeCastChoice':
        return d.choice?.type === 'Alternative' ? 'Cast it for its alternative cost (see the card text)' : 'Cast it normally (pay its mana cost)';
      case 'CrewVehicle':
        return d.creature_ids?.length
          ? `Crew ${r.ref(s, d.vehicle_id)} with ${d.creature_ids.map((id: number) => r.ref(s, id)).join(', ')}`
          : `Crew ${r.ref(s, d.vehicle_id)} (choose the crew next)`;
      case 'DecideOptionalCost': {
        // "[cost A] or [cost B]": yes pays the first, no the second.
        const pair = choicePair(wf.data?.cost);
        const act = (t: string) => (/^[{\d]/.test(t) ? `Pay ${t}` : t);
        if (pair) return d.pay ? act(pair[0]) : `${act(pair[1])} instead`;
        const what = additionalCostText(wf.data?.cost);
        return d.pay ? `Pay the optional additional cost${what ? ` (${what})` : ''}` : "Don't pay the optional additional cost";
      }
      case 'ChooseAdventureFace': return d.creature ? 'Cast the creature side' : 'Cast the Adventure side';
      case 'CastPreparedCopy': {
        // Name the spell and its cost: "Cast Soul Tether {2}{R/G} (prepared copy from Konstrari Improviser [#69])".
        const spell = r.obj(s, d.source)?.back_face;
        return spell?.name
          ? `Cast ${spell.name} ${v4Cost(formatCost(spell.mana_cost))} (prepared copy from ${r.ref(s, d.source)})`.replace(/ {2,}/g, ' ')
          : `Cast the prepared copy of ${r.ref(s, d.source)}'s spell`;
      }
      case 'TapForConvoke':
        return `Tap ${r.ref(s, d.object_id)} to help pay (convoke/waterbend: pays {1}${d.mana_type && d.mana_type !== 'Colorless' ? ` or one ${d.mana_type} mana` : ''})`;
      default: return humanizeAction(r, s, a);
    }
  }

  /** Wire a player's phase socket to this game and connect it. */
  private async attach(p: Player): Promise<void> {
    const phase = p.phase;
    p.phase.on('update', (u: PhaseUpdate) => {
      if (p.phase === phase) this.onUpdate(p, u);
    });
    p.phase.on('error-message', (e: unknown) => this.log('phase_error', { game: this.label, seat: p.seat.name, error: e }));
    p.phase.on('error', () => {}); // socket errors surface as setup failures / timeouts
    await p.phase.connect();
    p.seat.views = {
      view: () => {
        if (!p.latest) return 'The game has not started yet.';
        if (this.observation !== 'v4') return p.render.view(p.latest.state);
        const v = p.obs.render(p.latest.state, { byObject: p.latest.byObject, context: this.context(p), full: true });
        return [`[${this.seatLabel}] ${v.summary}`, compactJson({ state: v.state, cards: v.cardList })].join('\n');
      },
      log: (n) => p.fullLog.slice(-n).join('\n') || '(no log yet)',
      context: () => ({ game: this.label, turn: p.latest?.state?.turn_number ?? null }),
    };
  }

  /** "37", "50:U" → "Forest [#37], Island [#50] for U": readable mana plans in logs and replays. */
  private manaLabel(state: any, mana: string[]): string {
    return mana.map((m) => {
      const [id, color] = m.split(':');
      const o = state?.objects?.[String(Number(id))];
      return `${o?.name ? `${o.name} [#${Number(id)}]` : `#${id}`}${color ? ` for ${color.trim().toUpperCase()}` : ''}`;
    }).join(', ');
  }

  private seatOfPlayer = (player: number): string | null => this.players.find((x) => x.me === player)?.seat.name ?? null;

  /**
   * Public information from one socket's update (slot 0; every update reaches both sockets): spectator board and
   * log, cards cast/activated, and effects phase-rs could not carry out (Effect::Unimplemented).
   */
  private observe(u: PhaseUpdate): void {
    const s = u.state;
    if (!s) return;
    const turn = s.turn_number ?? null;
    for (const e of u.events ?? []) {
      const d = e?.data ?? {};
      if (e?.type === 'SpellCast' || (e?.type === 'AbilityActivated' && d.kind !== 'Mana')) {
        const cast = e.type === 'SpellCast';
        const seat = this.seatOfPlayer(cast ? d.controller : d.player_id);
        const o = s.objects?.[String(cast ? d.object_id : d.source_id)];
        const card = o && !o.face_down && o.name !== 'Hidden Card' ? String(o.base_name ?? o.name) : null;
        if (!seat || !card) continue;
        const rec = this.played.get(seat) ?? { cast: {}, activated: {} };
        const bucket = cast ? rec.cast : rec.activated;
        bucket[card] = (bucket[card] ?? 0) + 1;
        this.played.set(seat, rec);
        this.log('card_played', { game: this.label, seat, card, how: cast ? 'cast' : d.kind === 'Loyalty' ? 'loyalty' : 'activate', turn });
        // phase-rs lists the mechanics of a card it has not implemented; casting such a card is an engine gap too.
        const gaps: string[] = Array.isArray(o.unimplemented_mechanics) ? o.unimplemented_mechanics.map(String) : [];
        if (cast && gaps.length) this.noteUnimplemented(`${card}|mechanics`, card, seat, turn, gaps);
      }
      if (e?.type === 'EffectResolved' && d.kind === 'Unimplemented') {
        const o = s.objects?.[String(d.source_id)];
        if (o?.name) this.noteUnimplemented(String(o.printed_ref?.oracle_id ?? o.name), String(o.name), this.seatOfPlayer(o.controller), turn);
      }
    }
    // phase-rs records the source of every Unimplemented effect it resolves in this diagnostics set.
    for (const id of (s.unimplemented_oracle_ids ?? []) as string[]) {
      if (this.unimplemented.has(id)) continue;
      const src = Object.values(s.objects ?? {}).find((o: any) => o?.printed_ref?.oracle_id === id || o?.name === id) as any;
      this.noteUnimplemented(id, String(src?.name ?? id), src ? this.seatOfPlayer(src.controller) : null, turn);
    }
    if (this.watch && !this.result) {
      this.watch.board(this.label, publicBoard(s, this.seatOfPlayer));
      const lines: LogLine[] = [];
      const names: string[] = [];
      for (const entry of u.logEntries) {
        if (entry.presentation?.boundary === 'Phase') continue;
        const { line, names: n } = publicLogLine(entry, this.seatOfPlayer);
        if (LOG_NOISE.test(line.text)) continue;
        lines.push(line);
        names.push(...n);
      }
      this.watch.logLines(this.label, lines, names);
    }
  }

  private noteUnimplemented(id: string, card: string, seat: string | null, turn: number | null, mechanics?: string[]): void {
    if (this.unimplemented.has(id)) return;
    this.unimplemented.set(id, { card, seat });
    this.log('unimplemented_effect', {
      game: this.label, card, seat, turn,
      ...(mechanics ? { mechanics, source: 'mechanics' } : { source: 'resolved', oracle_id: id === card ? undefined : id }),
    });
  }

  /** Public board summary for both players (life, cards in each zone, permanents by name). */
  private snapshot(s: any): Record<string, unknown> {
    const active = this.players.find((x) => x.me === s.active_player)?.seat.name;
    return {
      active,
      players: Object.fromEntries(this.players.map((x) => {
        const pl = s.players?.[x.me] ?? {};
        const perms = (s.battlefield ?? []).map((id: number) => s.objects?.[String(id)]).filter((o: any) => o?.controller === x.me);
        return [x.seat.name, {
          life: pl.life, poison: pl.poison_counters || undefined, hand: pl.hand?.length, library: pl.library?.length, graveyard: pl.graveyard?.length,
          lands: perms.filter((o: any) => (o.card_types?.core_types ?? []).includes('Land')).length,
          // This is slot 0's projection, which names slot 0's own face-down permanents: never log those names
          // (turn_snapshot is public; SPEC-1).
          permanents: perms.filter((o: any) => !(o.card_types?.core_types ?? []).includes('Land')).map((o: any) => {
            const name = o.face_down || o.name === 'Hidden Card' ? 'Face-down card' : o.name;
            return o.power != null ? `${name} ${o.power}/${o.toughness}` : name;
          }),
        }];
      })),
    };
  }

  /** Plain-language reason the game ended, from the final state. */
  private endReason(u: PhaseUpdate, winner: number | null | undefined): string {
    if (winner == null) return 'draw';
    const loser = u.state.players?.find((pl: any) => pl.id !== winner) ?? u.state.players?.[1 - winner];
    if (u.events.some((e: any) => e.type === 'PlayerConceded' || e.type === 'Conceded')) return 'concede';
    if (loser && loser.life <= 0) return 'life';
    if (loser && (loser.poison_counters ?? 0) >= 10) return 'poison';
    if (loser && loser.library?.length === 0) return 'decking';
    return 'other';
  }

  /** Untapped mana sources this seat can activate now, with the colors each can make. */
  private manaSources(u: PhaseUpdate): Array<{ id: number; colors: string[] }> {
    const out: Array<{ id: number; colors: string[] }> = [];
    for (const [id, acts] of Object.entries(u.byObject)) {
      const colors = [...new Set(acts.filter((a) => isPlanManaAction(u.state, a)).flatMap((a) => manaActionColors(u.state, a)).map((c) => COLOR_LETTER[c] ?? c))];
      if (colors.length) out.push({ id: Number(id), colors });
    }
    return out;
  }

  /** Colors still owed by the pending cost after the mana already in the pool. */
  private stillNeeded(u: PhaseUpdate, me: number): string[] {
    const shards: string[] = (u.state.pending_cast?.cost?.shards ?? []).filter((x: unknown) => typeof x === 'string');
    const pool: string[] = (u.state.players?.[me]?.mana_pool?.mana ?? []).map((m: any) => m.color);
    const need = [...shards];
    for (const c of pool) {
      const i = need.indexOf(c);
      if (i >= 0) need.splice(i, 1);
    }
    return need;
  }

  /**
   * The mana action a tap plan entry ("37", "37:U") uses: the source's mana action that makes the color asked for,
   * else one that makes a color still needed, else its first. Lands, mana creatures, mana rocks and Treasures alike
   * (mana-sources.ts); undefined when the object has no such action now.
   */
  private planSource(u: PhaseUpdate, idPart: string, wanted: string | undefined, needed: string[]): any | undefined {
    const choices = (u.byObject[String(Number(idPart))] ?? []).filter((a) => isPlanManaAction(u.state, a));
    if (wanted) return choices.find((a) => manaActionColors(u.state, a).includes(wanted));
    return choices.find((a) => manaActionColors(u.state, a).some((c) => needed.includes(c))) ?? choices[0];
  }

  /** Why a tap plan entry can't be used, for the agent. */
  private notASource(u: PhaseUpdate, entry: string, idPart: string, wanted: string | undefined): string {
    const acts = u.byObject[String(Number(idPart))] ?? [];
    if (acts.some((a) => isManaAction(u.state, a) && !isPlanManaAction(u.state, a))) {
      return `Couldn't tap "${entry}" as part of a plan: its mana ability has a cost of its own (mana, or another card to choose). Pick it as an option instead.`;
    }
    if (wanted && acts.some((a) => isPlanManaAction(u.state, a))) return `Couldn't tap "${entry}" for ${wanted}: it can't make that color.`;
    return `Couldn't tap "${entry}"${wanted ? ` for ${wanted}` : ''}: it isn't an untapped mana source you control right now.`;
  }

  /** Whether the mana pool already pays the pending spell's whole cost (finishing the payment taps nothing more). */
  private poolPays(u: PhaseUpdate, me: number): boolean {
    return poolCovers(u.state.pending_cast?.cost, u.state.players?.[me]?.mana_pool?.mana ?? []) === true;
  }

  /** Answer the engine's color question for the "any color" source a tap plan just activated. */
  private choosePlanColor(p: Player, u: PhaseUpdate, legal: any[]): void {
    const want = p.payColor;
    p.payColor = undefined;
    const pick = pickColor(legal, want ? [want] : [], this.stillNeeded(u, p.me));
    if (!pick) {
      this.offer(p, u, legal);
      return;
    }
    this.submit(p, u.revision, pick, 'pay_color').then((r) => {
      if (!r.ok) {
        p.payQueue = undefined;
        p.payFailures++;
        p.payError = `The engine refused the color for the last source in your plan (${r.reason}).`;
      }
    });
  }

  /** Tap the next source in the agent's plan, or finish the payment when the plan is done. */
  private advancePayment(p: Player, u: PhaseUpdate, legal: any[]): void {
    const entry = p.payQueue?.shift();
    if (entry === undefined) {
      p.payQueue = undefined;
      p.optionTapped = false;
      this.submit(p, u.revision, { type: 'PassPriority' }, 'pay_finish');
      return;
    }
    const [idPart, colorPart] = entry.split(':');
    const wanted = colorPart ? COLOR_NAME[colorPart.trim().toUpperCase()] ?? colorPart.trim() : undefined;
    const needed = this.stillNeeded(u, p.me);
    const pick = this.planSource(u, idPart!, wanted, needed);
    if (!pick) {
      p.payQueue = undefined;
      p.payColor = undefined;
      p.payFailures++;
      p.payError = `${this.notASource(u, entry, idPart!, wanted)} Mana already tapped stays in your pool.`;
      this.log('pay_error', { game: this.label, seat: p.seat.name, entry });
      this.offer(p, u, legal);
      return;
    }
    // An "any color" source asks for the color next (choosePlanColor): the color asked for, else one still needed.
    if (pick.type === 'ActivateAbility') {
      const colors = manaActionColors(u.state, pick);
      p.payColor = wanted && colors.includes(wanted) ? wanted : colors.find((c) => needed.includes(c));
    }
    const { interactionActionId: _drop, ...action } = pick;
    this.submit(p, u.revision, action, 'pay_tap').then((r) => {
      if (!r.ok) {
        p.payQueue = undefined;
        p.payColor = undefined;
        p.payFailures++;
        p.payError = `The engine refused tapping "${entry}" (${r.reason}).`;
      }
    });
  }

  stats(): Record<string, unknown> {
    return Object.fromEntries(this.players.map((p) => [p.seat.name, {
      decisions: p.decisions, auto_passes: p.autoPasses, forced: p.forced, rejections: p.rejections,
      manual_payments: p.manualPayments, auto_tapper: p.autoTapper, auto_paid: p.autoPaid, payment_failures: p.payFailures,
    }]));
  }
}

/**
 * Only this seat's own actions. phase-server sends every seat that may act the seat-agnostic list of legal actions.
 * In a simultaneous decision (the mulligan: MulliganDecision, OpeningHandBottomCards) that list holds the other
 * player's choices too: their keep or mulligan, and which of their cards (hidden from this seat) to put on the bottom.
 * The engine even accepts such a choice from the wrong seat, so it must never be offered: keep the actions of this
 * seat's own entry, and selections made only of cards in this seat's hand.
 */
export function ownActions(state: any, me: number, legal: any[]): any[] {
  const wf = state?.waiting_for;
  if (wf?.type !== 'MulliganDecision' && wf?.type !== 'OpeningHandBottomCards') return legal;
  const mine = (wf.data?.pending ?? []).find((x: any) => x?.player === me);
  if (!mine) return [];
  const hand = new Set<number>(state.players?.[me]?.hand ?? []);
  const ownSelection = (a: any) => a.type === 'SelectCards' && Array.isArray(a.data?.cards) && a.data.cards.every((id: unknown) => hand.has(id as number));
  if (wf.type === 'OpeningHandBottomCards' || mine.phase?.type === 'BottomCards') return legal.filter(ownSelection);
  return legal.filter((a) => a.type !== 'SelectCards');
}

/** The same options (labels and engine actions, ignoring the engine's per-revision interaction ids). */
function sameOptions(a: Option[], b: Option[]): boolean {
  const key = (x: Option) => {
    const { interactionActionId: _drop, ...v } = (x.value ?? {}) as Record<string, unknown>;
    return `${x.id}|${x.label}|${JSON.stringify(v)}`;
  };
  return a.length === b.length && a.every((x, i) => key(x) === key(b[i]!));
}

/** An option given by name instead of id: a named choice ("Elf"), or an option's exact label. */
/**
 * Does an option's action say the same as a structured answer? Attacks compare by attacker, blocks by blocker and
 * attacker pair, cards as a set (a list's order is the seat's own choice either way).
 */
export function sameStructured(field: 'attackers' | 'blocks' | 'cards', option: any, structured: any): boolean {
  const key = (a: any): string | undefined => {
    const d = a?.data ?? {};
    if (field === 'attackers') return a?.type === 'DeclareAttackers' ? JSON.stringify((d.attacks ?? []).map((t: any) => t[0]).sort()) : undefined;
    if (field === 'blocks') return a?.type === 'DeclareBlockers' ? JSON.stringify((d.assignments ?? []).map((t: any) => `${t[0]}>${t[1]}`).sort()) : undefined;
    return a?.type === 'SelectCards' ? JSON.stringify([...(d.cards ?? [])].sort()) : undefined;
  };
  const a = key(option);
  return a !== undefined && a === key(structured);
}

/** Object ids as the agent sees them: "#12, #40". */
function ids(list: number[]): string {
  return list.map((id) => `#${id}`).join(', ');
}

function byName(options: Option[], text: string): Option | undefined {
  const t = String(text).trim().toLowerCase();
  if (!t) return undefined;
  return options.find((x) => {
    const choice = (x.value as any)?.data?.choice;
    return (typeof choice === 'string' && choice.toLowerCase() === t) || x.label.toLowerCase() === t;
  });
}

/** The reply to an option that isn't one: the valid ids, or for a long list of names, close matches (or the whole list). */
function unknownOption(o: Offer, text: string): string {
  const names = o.options.map((x) => (x.value as any)?.data?.choice).filter((c): c is string => typeof c === 'string');
  if (o.options.some((x) => x.unlisted) && names.length) {
    if (/^(list|\?)$/i.test(String(text).trim())) return `Every allowed value (${names.length}): ${names.join(', ')}.`;
    const t = String(text).trim().toLowerCase();
    const close = names.filter((n) => n.toLowerCase().startsWith(t.slice(0, 3)) || n.toLowerCase().includes(t)).slice(0, 12);
    return `"${text}" is not one of the ${names.length} allowed values.${close.length ? ` Close: ${close.join(', ')}.` : ''} Answer with an option id or a name; option="list" shows them all.`;
  }
  return `Unknown option "${text}". Valid options: ${o.options.map((x) => x.id).join(', ')}.`;
}

/** An additional cost (kicker, gift, …) in words: its kind and its mana, when it has some. */
function additionalCostText(c: any): string {
  if (!c || typeof c !== 'object') return '';
  const type = String(c.type ?? Object.keys(c)[0] ?? '');
  const inner = c.type ? (c.data ?? c) : c[type];
  const pair = choicePair(c);
  if (pair) return `${pair[0]} or ${pair[1].replace(/^[A-Z](?=[a-z])/, (x) => x.toLowerCase())}`;
  if (type === 'Kicker') return `kicker ${(inner?.costs ?? []).map(costText).filter(Boolean).join(' and/or ')}`.trim();
  if (type === 'Optional') return costText(inner?.cost);
  if (type === 'Required') return costText(inner?.cost ?? inner);
  return costText(inner?.cost ?? inner) || words(type);
}

/** The two costs of an "[A] or [B]" additional cost (AdditionalCost::Choice), as text. */
function choicePair(c: any): [string, string] | undefined {
  if (!c || typeof c !== 'object') return undefined;
  const v = c.type === 'Choice' ? c.data ?? c.costs : c.Choice;
  if (!Array.isArray(v) || v.length !== 2) return undefined;
  const a = costText(v[0]);
  const b = costText(v[1]);
  return a && b ? [a, b] : undefined;
}

/** The top of the stack as "Card [#id]" (what a choice is for), when this seat can identify it. */
function stackTop(r: Renderer, s: any): string | undefined {
  const top = (s.stack ?? [])[s.stack?.length - 1];
  if (!top) return undefined;
  const o = r.obj(s, top.source_id);
  return o && !o.face_down && o.name !== 'Hidden Card' ? r.ref(s, top.source_id) : undefined;
}

/** A spell cast the engine can pay manually (it carries a payment mode). */
function isCast(a: any): boolean {
  return /^CastSpell/.test(String(a?.type ?? '')) || (!!a?.data && typeof a.data === 'object' && 'payment_mode' in a.data);
}

/** Whether a ManaCost asks for any mana. */
function hasMana(cost: any): boolean {
  if (!cost || typeof cost !== 'object') return false;
  if (cost.dynamic) return true;
  return cost.type === 'Cost' && ((cost.generic ?? 0) > 0 || (cost.shards ?? []).length > 0);
}

/**
 * The mana cost an action asks this seat to pay, when it has one: a spell's cost, an activated ability's mana part,
 * a prepared copy's spell. Undefined: no mana to pay (a land, a free ability, a pass).
 */
export function manaCostOf(state: any, a: any): any {
  const d = a?.data ?? {};
  const obj = (id: unknown) => state?.objects?.[String(id)];
  let cost: any;
  if (a?.type === 'CastSpellForFree') return undefined;
  if (isCast(a)) cost = obj(d.object_id)?.mana_cost;
  else if (a?.type === 'ActivateAbility') cost = manaPart(obj(d.source_id)?.abilities?.[d.ability_index]?.cost);
  else if (a?.type === 'CastPreparedCopy') cost = obj(d.source)?.back_face?.mana_cost;
  return hasMana(cost) ? cost : undefined;
}

/**
 * The engine's mana color choice (ChooseManaColor) to send: one making a color asked for, else a color still needed,
 * else the first offered. Undefined when there is no such choice.
 */
function pickColor(legal: any[], wanted: string[], needed: string[]): any | undefined {
  const opts = legal.filter((a) => a?.type === 'ChooseManaColor');
  const colorsOf = (a: any): string[] => {
    const c = a.data?.choice?.data;
    return Array.isArray(c) ? c : [c];
  };
  const pick = opts.find((a) => wanted.length && colorsOf(a).every((c) => wanted.includes(c)))
    ?? opts.find((a) => colorsOf(a).some((c) => needed.includes(c)))
    ?? opts[0];
  if (!pick) return undefined;
  const { interactionActionId: _drop, ...action } = pick;
  return action;
}

function dedupe(actions: any[]): any[] {
  const seen = new Set<string>();
  return actions.filter((a) => {
    // "Decide and remember for this card/trigger" variants are UI conveniences; a plain yes/no is enough.
    if (a.type === 'DecideOptionalEffectAndRemember') return false;
    const k = JSON.stringify(a);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * Readable fallback for GameAction variants we haven't labeled yet (new mechanics in new sets):
 * "SomeAction {source_id: 37, pay: true}" → "Some action: source Konstrari Improviser [#37], pay yes".
 */
function humanizeAction(r: Renderer, s: any, a: any): string {
  const name = String(a.type).replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  const title = name.charAt(0).toUpperCase() + name.slice(1);
  if (!a.data || typeof a.data !== 'object') return title;
  const parts = Object.entries(a.data).map(([k, v]) => {
    const key = k.replace(/_ids?$/, '').replace(/_/g, ' ');
    const obj = (id: unknown) => (typeof id === 'number' && s.objects?.[String(id)] ? r.ref(s, id) : JSON.stringify(id));
    if (/_id$|^source$|^target$/.test(k) && typeof v === 'number') return `${key} ${obj(v)}`;
    if (/_ids$/.test(k) && Array.isArray(v)) return `${key} ${v.length ? v.map(obj).join(', ') : 'none'}`;
    if (typeof v === 'boolean') return `${key} ${v ? 'yes' : 'no'}`;
    return `${key} ${JSON.stringify(v).slice(0, 80)}`;
  });
  return `${title}: ${parts.join(', ')}`;
}

/** The card an action is about (the spell cast, the ability's source, the land played), when there is one. */
export function actionCard(state: any, a: any): string | undefined {
  const d = a?.data ?? {};
  const id = d.object_id ?? d.source_id ?? d.source ?? d.vehicle_id;
  if (typeof id !== 'number') return undefined;
  const o = state?.objects?.[String(id)];
  return o?.name && o.name !== 'Hidden Card' ? String(o.base_name ?? o.name) : undefined;
}

/** Verbs whose subject a combat or effect line starts with ("Pia [#48] deals 2 combat damage…"): the card's controller acts. */
const CARD_ACTS = /^\s*(attacks|deals|blocks|fights|explores|connives|deal|attack)\b/;

/** "draws" → "draw", "searches" → "search", "has" → "have": the verb after "You". */
function secondPerson(verb: string): string {
  const special: Record<string, string> = { has: 'have', is: 'are', was: 'were', does: 'do', goes: 'go' };
  if (special[verb]) return special[verb]!;
  if (/(ch|sh|ss|x|z)es$/.test(verb)) return verb.slice(0, -2);
  if (/[^aeiou]ies$/.test(verb)) return `${verb.slice(0, -3)}y`;
  if (/[^s]s$/.test(verb)) return verb.slice(0, -1);
  return verb;
}

/**
 * A log entry for the structured envelope: turn, step, readable text (ids as [#42]), actor, object ids mentioned.
 * The actor is the player the line starts with ("You draw a card"), or the controller of the card it starts with
 * when that card acts ("Pia [#48] deals 2 combat damage to Opponent": you). Lines about a card that something
 * happens to ("… is destroyed") have no actor.
 */
export function eventEntry(entry: any, me: number, state?: any): EventEntry {
  let actor: 'you' | 'opponent' | undefined;
  const cards: number[] = [];
  const segs: any[] = (entry.segments ?? []).filter((s: any) => !(s.type === 'Text' && !String(s.value ?? '').trim()));
  const first = segs.findIndex((s: any) => !(s.type === 'Text' && /^Turn \d+ — $/.test(String(s.value))));
  const lead = segs[first];
  if (lead?.type === 'PlayerName') actor = lead.value?.player_id === me ? 'you' : 'opponent';
  else if (lead?.type === 'CardName' && segs[first + 1]?.type === 'Text' && CARD_ACTS.test(String(segs[first + 1].value))) {
    const c = state?.objects?.[String(lead.value?.object_id)]?.controller;
    if (typeof c === 'number') actor = c === me ? 'you' : 'opponent';
  }
  let text = '';
  let youBefore = false;
  for (const s of entry.segments ?? []) {
    let part: string;
    switch (s.type) {
      case 'PlayerName': {
        const you = s.value?.player_id === me;
        // Mid-sentence "to you"; at the start (or after "Turn 3 — ") "You".
        part = you ? (/[a-z,]\s*$/.test(text) ? 'you' : 'You') : 'Opponent';
        youBefore = you;
        text += part;
        continue;
      }
      case 'CardName':
        if (typeof s.value?.object_id === 'number') cards.push(s.value.object_id);
        part = s.value?.object_id != null ? `${s.value.name} [#${s.value.object_id}]` : s.value?.name;
        break;
      case 'Text':
        part = String(s.value ?? '');
        // "You draws a card" → "You draw a card"; "You shuffles their library" → "You shuffle your library".
        if (youBefore) part = part.replace(/^(\s+)([a-z]+)\b/, (_m, sp: string, v: string) => sp + secondPerson(v)).replace(/\btheir\b/, 'your');
        break;
      default: part = typeof s.value === 'object' ? (s.value?.name ?? JSON.stringify(s.value)) : String(s.value);
    }
    youBefore = false;
    text += part;
  }
  return { turn: entry.turn, step: stepName(entry.phase), text, ...(actor ? { actor } : {}), ...(cards.length ? { cards: [...new Set(cards)] } : {}) };
}

/** An option for the structured envelope: id, what it does, the objects/players it involves, and its readable label. */
function optionJson(x: Option, me: number): Record<string, unknown> {
  const a: any = x.value ?? {};
  const d = a.data ?? {};
  const out: Record<string, unknown> = { id: x.id, action: words(String(a.type ?? 'choose')) };
  const objs = actionObjects(a);
  if (objs.length) out.objects = objs;
  if (d.target?.Player != null) out.player = d.target.Player === me ? 'you' : 'opponent';
  if (Array.isArray(d.attacks)) out.attackers = d.attacks.map((t: any) => t[0]);
  if (Array.isArray(d.assignments) && a.type === 'DeclareBlockers') out.blocks = d.assignments.map((t: any) => ({ blocker: t[0], attacker: t[1] }));
  out.label = x.label;
  return out;
}
