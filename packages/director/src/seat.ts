import { randomBytes } from 'node:crypto';

export interface Option {
  id: string;
  label: string;
  /** Opaque payload for whoever created the offer (e.g. a phase-rs GameAction). */
  value: unknown;
  /** Valid but not listed in the decision text (a long list of names, answered by name instead). */
  unlisted?: boolean;
}

export interface DecideInput {
  decision_id: string;
  option?: string;
  attackers?: number[];
  blocks?: Array<{ blocker: number; attacker: number }>;
  cards?: number[];
  basics?: Record<string, number>;
  /** Mana sources to tap, in order: object ids, optionally with a color ("37", "50:U"). */
  mana?: string[];
  note?: string;
  /** Deckbuilding (prompt v4): the agent's own card count, deck name, archetype and thought process. */
  total_count?: number;
  deck_name?: string;
  archetype?: string;
  analysis?: string;
}

/** The structured answer fields of decide (besides `option`). */
export type AnswerField = 'attackers' | 'blocks' | 'cards' | 'basics' | 'mana';
const ANSWER_FIELDS: AnswerField[] = ['attackers', 'blocks', 'cards', 'basics', 'mana'];

/** A structured field was given with something in it (an empty list is no answer to a decision that doesn't take it). */
export function given(input: DecideInput, field: AnswerField): boolean {
  const v = input[field];
  return Array.isArray(v) ? v.length > 0 : v != null && typeof v === 'object' && Object.keys(v).length > 0;
}

/**
 * The reply when an answer carries structured fields this decision doesn't take, or null. Input is never dropped
 * silently: a seat that sent `blocks` to a draft pick, or `mana` where nothing is paid, is told so and answers again.
 */
export function unexpectedFields(input: DecideInput, takes: readonly AnswerField[], what: string): string | null {
  const extra = ANSWER_FIELDS.filter((f) => given(input, f) && !takes.includes(f));
  if (!extra.length) return null;
  const names = extra.map((f) => `\`${f}\``).join(' and ');
  const ok = takes.length ? `it takes \`option\` or ${takes.map((f) => `\`${f}\``).join('/')}` : 'it takes `option` only';
  return `${what} doesn't take ${names} (${ok}); nothing was applied. Answer again without ${extra.length === 1 ? 'it' : 'them'}.`;
}

/** A decision offered to one seat. `answer` returns an error message, or null if accepted. */
export interface Offer {
  id: string;
  /** `sideboard`: between games of a match (play or draw, sideboarding; sideboard.ts). */
  phase: 'draft' | 'build' | 'game' | 'sideboard';
  kind: string;
  text: string;
  options: Option[];
  createdAt: number;
  /** Set while an answer is being processed, so a racing state update doesn't count it as withdrawn. */
  answering?: boolean;
  answer: (input: DecideInput, offer: Offer) => Promise<string | null>;
  /** What decide replies before the next decision when this offer's answer is accepted (default "Accepted."). */
  acceptedText?: string;
  /**
   * Settle the decision for an inactive seat (the Director's watchdog): auto-pick, reference build, or concede the
   * game. Clears the seat's pending offer; returns details for the `forfeit` log record.
   */
  forfeit?: () => Record<string, unknown>;
}

/** How long after a decision's full text was returned a racing call gets the one-line pointer instead. */
const DUPLICATE_WINDOW_MS = 30_000;

/**
 * Refused answers (the engine or the checks said no) a seat may send per minute. Each is logged with its note, so an
 * unbounded rate let one seat grow its table's log past what the Hub accepts, losing every seat's results (SEC-4). A
 * real agent corrects itself in a few tries; beyond this it is told to wait, and nothing is applied or logged.
 */
export const MAX_REFUSED_PER_MIN = 20;

/**
 * A seat's own progress, for its launcher only (GET /mcp/<seat-token>/progress; never an MCP tool, never counted as
 * activity). `bench play --fresh-session` reads it to end the harness session at a game or match boundary and start a
 * fresh one, which gets the resume briefing. It says nothing the seat doesn't already know.
 */
export interface SeatProgress {
  /** The seat's deck is locked (deckbuilding is over for it). */
  deck_locked: boolean;
  /** Games and matches the seat has finished (voided games don't count; conceded ones do). */
  games_finished: number;
  matches_finished: number;
  /** The seat has its final answer (EVENT COMPLETE). */
  done: boolean;
  /** A decide call is in progress (its answer is being applied, or its reply is being put together). */
  deciding: boolean;
  /** Harness sessions seen so far (MCP initialize requests). */
  sessions: number;
}

export type WaitResult =
  | { status: 'decision'; text: string }
  | { status: 'waiting'; text: string }
  | { status: 'done'; text: string };

/**
 * One participant in an event. The seat (and its MCP URL) lives for the whole event:
 * draft → deckbuilding → every game. Decisions from any stage arrive through the same queue.
 */
export class AgentSeat {
  /** The secret in the seat's MCP URL. Restored from the checkpoint when an event resumes after a restart. */
  readonly token: string;
  pending?: Offer;
  /** Shown when nothing is pending: what the seat is waiting for. */
  status = 'Waiting for the event to start.';
  /** Appended to the status: what is still to come for this seat (remaining matches), so idle seats keep polling. */
  statusNote?: () => string;
  done?: string;
  /** How many calls have returned the final answer (`done`). */
  private doneDelivered = 0;
  /** Read-only views of the seat's current game, for get_view / get_game_log (and the turn, for rules-issue reports). */
  views?: { view: () => string; log: (n: number) => string; context?: () => { game: string; turn: number | null } };
  /** Called whenever the open decision changes (spectator clock): an offer, nothing (answered/withdrawn), or done. */
  onPending?: (offer: Offer | undefined, done: boolean) => void;
  /** Records an agent's report of a suspected rules-engine problem (never affects the game); returns the reply. */
  reportIssue?: (card: string, note: string) => string;
  /** The set primer ("set context" from prompt v4 on), when the event's knowledge level allows it. */
  primer?: string;
  /** The Set Context split into parts that each fit one tool result (get_set_context(part)); set with the primer. */
  primerParts?: string[];
  /** Set before the Set Context's first part: the set's cards this event's packs can't contain (knowledge.ts packCoverageNote). */
  setContextNote?: string;
  /**
   * The event's format in one phrase ("a booster draft, then deckbuilding, then 3 rounds of best-of-1 matches"), for the
   * MCP instructions, which are built per request.
   */
  formatLine?: string;
  /**
   * What a new harness session for this seat is told first (format, fundamentals, where to read the Set Context and
   * where the event stands), when the seat had already been briefed in an earlier session.
   */
  resumeBriefing?: () => string;
  /**
   * Set Context levels: every harness session reads the Set Context (any part, with this tool) before its first game
   * decision; until it has, a game decision is answered with a reminder instead (`setContextGate`). The same rule for
   * every seat and session, rotated or not, so a fresh session never plays with less knowledge than a long one.
   */
  setContextRequired?: { tool: string; parts: number };
  /** Called when a session is reminded to read the Set Context before a game decision (once per session). */
  onSetContextReminder?: (session: number, decisionId: string) => void;
  /** This harness session has read the Set Context (reset by `sessionStart`). */
  private setContextRead = false;
  private reminded = false;
  /** The event's observation format (prompts v4+: 'v4'): decision texts, MCP tool names and descriptions for this seat. */
  observation?: 'v3' | 'v4';
  /** When the seat last made an MCP request (any tool call); undefined until it connects. */
  lastActivity?: number;
  /** MCP requests in progress (a seat inside wait_for_decision or decide is active). */
  private inflight = 0;
  /**
   * Set when the watchdog forfeited one of this seat's decisions; its next decisions are then settled at once,
   * until its next MCP request (a relaunched session resumes normally).
   */
  inactive = false;
  private notices: string[] = [];
  private waiters: Array<() => void> = [];
  private offerSeq = 0;
  /** The welcome briefing is queued (`brief`) and not yet read; `briefed` once a call has returned it. */
  private briefingQueued = false;
  briefed = false;
  private resumeQueued = false;
  /** Progress for the seat's launcher (SeatProgress): set by the Event. */
  deckLocked = false;
  gamesFinished = 0;
  matchesFinished = 0;
  /** MCP initialize requests seen (harness sessions). */
  sessions = 0;
  /** decide calls in progress. */
  private deciding = 0;
  /** Called on every new harness session (an MCP initialize): its number, and whether it got the resume briefing. */
  onSessionStart?: (session: number, resumed: boolean) => void;
  /**
   * The last decision whose full text a call returned (decide or wait_for_decision), so a call racing it (a harness
   * that calls decide and wait_for_decision in parallel) gets a one-line pointer instead of the same text twice.
   */
  private delivered?: { id: string; text: string; at: number; via: 'decide' | 'wait_for_decision'; repeated?: boolean };
  /** When this seat's recent answers were refused (the last minute; MAX_REFUSED_PER_MIN). */
  private refusedAt: number[] = [];

  constructor(readonly name: string, readonly index: number, readonly kind: 'agent' | 'bot' = 'agent', token?: string) {
    this.token = token && /^[0-9a-f]{32}$/.test(token) ? token : randomBytes(16).toString('hex');
  }

  /** Decision ids continue after a restart above every id issued before it (resume: durable.ts). */
  resumeIds(lastIssued: number): void {
    this.offerSeq = Math.max(this.offerSeq, lastIssued);
  }

  /** An MCP request for this seat started (mcp.ts). */
  beginRequest(): void {
    this.inflight++;
    this.lastActivity = Date.now();
    this.inactive = false;
  }

  /** An MCP request for this seat finished. */
  endRequest(): void {
    this.inflight = Math.max(0, this.inflight - 1);
    this.lastActivity = Date.now();
  }

  /** A request is in progress right now. */
  get busy(): boolean {
    return this.inflight > 0;
  }

  nextId(prefix: string): string {
    return `${prefix}${++this.offerSeq}`;
  }

  offer(o: Offer): void {
    this.pending = o;
    this.onPending?.(o, false);
    this.wake();
  }

  /** Something the agent should read at its next decision (a game result, a new stage). */
  notify(text: string): void {
    this.notices.push(text);
    this.wake();
  }

  setStatus(text: string): void {
    this.status = text;
  }

  finish(text: string): void {
    this.done = text;
    this.pending = undefined;
    this.onPending?.(undefined, true);
    this.wake();
  }

  clear(): void {
    if (!this.pending) return;
    this.pending = undefined;
    this.onPending?.(undefined, false);
  }

  wake(): void {
    const w = this.waiters;
    this.waiters = [];
    for (const f of w) f();
  }

  /** The open decision a call may return: not one whose answer is being processed right now. */
  private get open(): Offer | undefined {
    return this.pending && !this.pending.answering ? this.pending : undefined;
  }

  async wait(timeoutMs: number, via: 'decide' | 'wait_for_decision' = 'wait_for_decision'): Promise<WaitResult> {
    const deadline = Date.now() + timeoutMs;
    // A finished seat that keeps calling after its final answer: answer at the pace of a normal wait, never in a
    // tight loop (each call re-sends the agent's whole context).
    if (this.done && this.doneDelivered > 0 && via === 'wait_for_decision') await new Promise((r) => setTimeout(r, timeoutMs));
    // A decision being answered (decide in flight, e.g. called in parallel with this wait) is not returned: wait for
    // what comes after it.
    while (!this.open && !this.done && !this.notices.length && Date.now() < deadline) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, Math.max(0, deadline - Date.now()));
        function done() {
          clearTimeout(timer);
          resolve();
        }
        this.waiters.push(done);
      });
    }
    // Notices alone shouldn't end a wait if a decision is about to follow; give it a beat.
    if (!this.open && !this.done && this.notices.length) await new Promise((r) => setTimeout(r, 1500));
    const notices = this.takeNotices();
    if (this.done) {
      this.doneDelivered++;
      return { status: 'done', text: notices + this.done };
    }
    const o = this.open;
    const gate = o && this.setContextGate(o);
    if (gate) return { status: 'waiting', text: notices + gate };
    if (o) return { status: 'decision', text: notices + this.deliver(o, via) };
    return { status: 'waiting', text: `${notices}${this.statusLine()}\nCall wait_for_decision again.` };
  }

  /**
   * The decision's full text, or a one-line pointer when another call returned exactly this text moments ago (a
   * harness calling decide and wait_for_decision in parallel would otherwise read every decision twice). Only the
   * first repeat is shortened: a later call gets the full text again, so a session that lost it can recover.
   */
  private deliver(o: Offer, via: 'decide' | 'wait_for_decision'): string {
    const d = this.delivered;
    const now = Date.now();
    if (d && d.id === o.id && d.text === o.text && !d.repeated && now - d.at < DUPLICATE_WINDOW_MS) {
      d.repeated = true;
      return `Decision ${o.id} is open; its full text is in your ${d.via} result from moments ago. Answer it with decide (call wait_for_decision again only if you don't have that text).`;
    }
    this.delivered = { id: o.id, text: o.text, at: now, via };
    return o.text;
  }

  /**
   * A new MCP session for this seat (an `initialize` request): a relaunched harness. If the seat was already briefed,
   * its next result starts with a short resume briefing (format, fundamentals, where to read the Set Context), and the
   * open decision is sent in full again.
   */
  sessionStart(): void {
    this.delivered = undefined;
    this.sessions++;
    this.setContextRead = false;
    this.reminded = false;
    const resume = this.briefed && !this.done && !this.resumeQueued && !!this.resumeBriefing;
    if (resume) {
      this.resumeQueued = true;
      this.notices.unshift(this.resumeBriefing!());
    }
    this.onSessionStart?.(this.sessions, resume);
  }

  /** The seat read (part of) the Set Context in this session (get_set_context / get_set_primer). */
  markSetContextRead(): void {
    this.setContextRead = true;
  }

  /**
   * The reminder a game decision is answered with while this session hasn't read the Set Context (setContextRequired),
   * or undefined. The decision stays open and unchanged.
   */
  private setContextGate(o: Offer): string | undefined {
    const r = this.setContextRequired;
    // Game decisions and the between-games ones (play or draw, sideboarding), which a fresh session meets first.
    if (!r || this.setContextRead || (o.phase !== 'game' && o.phase !== 'sideboard')) return undefined;
    if (!this.reminded) {
      this.reminded = true;
      this.onSetContextReminder?.(this.sessions, o.id);
    }
    const read = r.parts > 1 ? `call ${r.tool}(part=1), then ${Array.from({ length: r.parts - 1 }, (_, i) => `part=${i + 2}`).join(' and ')}` : `call ${r.tool}()`;
    const what = o.phase === 'game' ? 'game decision' : o.kind === 'play_draw' ? 'play-or-draw choice' : 'sideboarding decision';
    return `Before your first ${o.phase === 'game' ? 'game decision' : 'decision of this match'} in this session, read the Set Context for this format: ${read}. Then call wait_for_decision: your ${what} ${o.id} is open and waits for you (nothing has been decided for you).`;
  }

  /** The seat's progress for its launcher (SeatProgress). */
  progress(): SeatProgress {
    return {
      deck_locked: this.deckLocked, games_finished: this.gamesFinished, matches_finished: this.matchesFinished,
      done: !!this.done, deciding: this.deciding > 0 || !!this.pending?.answering, sessions: this.sessions,
    };
  }

  /** Queue the welcome briefing (first result of the event). */
  brief(text: string): void {
    this.briefingQueued = true;
    this.notify(text);
  }

  /** The status plus what is still to come for this seat. */
  statusLine(): string {
    const note = this.statusNote?.() ?? '';
    return note ? `${this.status} ${note}` : this.status;
  }

  private takeNotices(): string {
    if (!this.notices.length) return '';
    if (this.briefingQueued) {
      this.briefingQueued = false;
      this.briefed = true;
    }
    this.resumeQueued = false;
    const t = this.notices.map((n) => `>> ${n}`).join('\n') + '\n\n';
    this.notices = [];
    return t;
  }

  async decide(input: DecideInput): Promise<string> {
    this.deciding++;
    try {
      return await this.decideNow(input);
    } finally {
      this.deciding--;
    }
  }

  private async decideNow(input: DecideInput): Promise<string> {
    if (this.done) return this.done;
    const o = this.pending;
    if (!o) return `There is no open decision for you right now. ${this.statusLine()} Call wait_for_decision.`;
    if (input.decision_id !== o.id) {
      // Show the open decision right away instead of sending the agent back to wait_for_decision.
      return o.answering
        ? `Decision ${input.decision_id} is not open; your answer to ${o.id} is being processed. Call wait_for_decision for what comes next.`
        : `Decision ${input.decision_id} is not open; the open decision is ${o.id}:\n\n${this.deliver(o, 'decide')}`;
    }
    if (o.answering) return `Your answer to ${o.id} is already being processed. Call wait_for_decision for what comes next.`;
    const gate = this.setContextGate(o);
    if (gate) return `Not applied: ${gate}`;
    const now = Date.now();
    this.refusedAt = this.refusedAt.filter((t) => now - t < 60_000);
    if (this.refusedAt.length >= MAX_REFUSED_PER_MIN) {
      const wait = Math.max(1, Math.ceil((this.refusedAt[0]! + 60_000 - now) / 1000));
      return `Not applied: ${MAX_REFUSED_PER_MIN} answers were refused in the last minute. Wait ${wait} s, reread decision ${o.id} (wait_for_decision), then answer it once.`;
    }
    o.answering = true;
    let error: string | null;
    try {
      error = await o.answer(input, o);
    } finally {
      o.answering = false;
    }
    if (error) {
      this.refusedAt.push(Date.now());
      // A wait_for_decision running in parallel held off while the answer was processed: the decision is open again.
      this.wake();
      return `Not accepted: ${error}\nThe decision ${this.pending?.id ?? o.id} is still open; choose again.`;
    }
    if (this.pending === o) {
      this.pending = undefined;
      this.onPending?.(undefined, false);
    }
    // The next decision usually follows within moments: return it here, so one call per decision is enough.
    const next = await this.wait(2500, 'decide');
    return `${o.acceptedText ?? 'Accepted.'}\n\n${next.text}`;
  }
}
