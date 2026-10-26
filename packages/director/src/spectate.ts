/**
 * Spectator view of one event: a sanitized, append-only message log derived from the event log and the
 * live game state, released according to the fairness policy (spectate-policy.ts, docs/SPECTATING.md).
 *
 * Everything the Director logs flows in through `ingest()` (full, private records); live public game state
 * flows in through `board()` / `logLines()`; seat clocks through `seatPending()`. Nothing private is ever put
 * into the released history before its release condition holds. The HTTP side lives in spectate-http.ts.
 */
import { withoutUnpublishedText } from './public-text.js';
import { describePolicy, isHiddenChoice, redactCards, type SpectatePolicy } from './spectate-policy.js';

export const SPECTATE_PROTOCOL = 1;

export interface SpectatorMsg {
  seq: number;
  /** When it happened (ms), not when it was released. */
  t: number;
  type: string;
  [k: string]: unknown;
}

type Payload = { type: string; t: number; [k: string]: unknown };

/** A release condition. Held messages are released, in order, once their condition holds. */
type Cond =
  | { kind: 'now' }
  | { kind: 'time'; at: number }
  | { kind: 'round'; round: number }
  | { kind: 'draft' }
  | { kind: 'seat'; seat: string }
  | { kind: 'game'; game: string }
  | { kind: 'turn'; game: string; turn: number }
  | { kind: 'all'; of: Cond[] };

interface Held { cond: Cond; key?: string; build: () => Payload | null; label: 'pick' | 'decision' | 'deck' | 'flag' | 'other' }

interface GameInfo {
  label: string; index: number; match: string; gameNumber: number; seats: string[]; over: boolean; turn: number; lastLife?: string;
  /** When each turn was first reached, and when the game ended: turn- and game-based releases wait for the broadcast delay too. */
  turnAt: Map<number, number>; overAt?: number;
}

/** One public board: what both players can see. Built from one seat's state, never reading hidden zones. */
export interface PublicBoard {
  turn: number;
  phase: string;
  active: string | null;
  priority: string | null;
  players: Record<string, {
    life: number; poison?: number; hand: number; library: number;
    graveyard: string[]; exile: string[]; battlefield: PublicPermanent[];
  }>;
  stack: Array<{ name: string; controller: string | null; kind: string; text?: string }>;
  combat: Array<{ attacker: number; target: string; blockers: number[] }>;
}

export interface PublicPermanent {
  id: number; name: string; land: boolean; creature: boolean;
  tapped?: boolean; pt?: string; loyalty?: number; counters?: Record<string, number>; keywords?: string[];
  sick?: boolean; damage?: number; attached_to?: number; token?: boolean; face_down?: boolean;
}

export interface LogLine { turn: number; phase: string; text: string }

const KIND: Record<string, string> = {
  Priority: 'priority', DeclareAttackers: 'attack', DeclareBlockers: 'block', MulliganDecision: 'mulligan', ManaPayment: 'pay',
  TargetSelection: 'target', TriggerTargetSelection: 'target', draft_pick: 'pick', deck_build: 'deck',
  sideboard: 'sideboard', play_draw: 'play_draw',
};
const coarseKind = (k: string): string => KIND[k] ?? 'choice';

export class Spectator {
  private history: Array<SpectatorMsg | null> = [];
  private bySeq = new Map<number, number>(); // seq → index in history
  private byKey = new Map<string, number>(); // supersede key → seq of the live message
  private seq = 0;
  private held: Held[] = [];
  private timer?: NodeJS.Timeout;
  private listeners = new Set<(m: SpectatorMsg) => void>();

  // Event facts the release conditions need.
  private meta: Record<string, unknown> = {};
  private seats: Array<{ name: string; kind: string; position: number; harness?: string; model?: string }> = [];
  /** The draft's pick clocks from event_start (0: none logged). */
  private pickClock = { first: 0, ms: 0 };
  private agents: string[] = [];
  private seed?: string;
  private stage = 'created';
  private packSize = 0;
  private picksInRound = new Map<number, number>();
  private picksBySeat = new Map<string, number>();
  private roundsDone = new Set<number>();
  private draftOver = false;
  private seatsDone = new Set<string>();
  /** When each seat's last match ended (its "done" is released after the broadcast delay). */
  private seatsDoneAt = new Map<string, number>();
  private matchesEnded = new Map<string, number>();
  /** Rounds the event plays (event_start.pairing), rounds paired so far, and matches each seat was paired in. */
  private plannedRounds?: number;
  private roundsPaired = 0;
  private pairedIn = new Map<string, number>();
  private games = new Map<string, GameInfo>();
  private eventOver = false;
  private decks = new Map<string, string[]>();
  private publicNames = new Set<string>();
  private lastOffered = new Map<string, { id: string; game: string; kind: string; turn: number }>();
  private standings = new Map<string, { gw: number; gl: number; mw: number; ml: number }>();
  private boardTimers = new Map<string, { timer?: NodeJS.Timeout; last: number; lastTurn?: number; pending?: PublicBoard }>();
  private withheldSent = '';
  private withheldAt = 0;
  private withheldTimer?: NodeJS.Timeout;

  /** Identifies this numbering of the stream: a restarted Director (or a fresh replay) numbers from 1 again. */
  readonly epoch: string;

  constructor(readonly eventId: string, readonly policy: SpectatePolicy, private now: () => number = Date.now) {
    this.epoch = `${now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  }

  // -------------------------------------------------------------------------
  // Reading

  get latestSeq(): number {
    return this.seq;
  }

  get over(): boolean {
    return this.eventOver;
  }

  /** Released messages with seq > since (superseded ones are skipped), at most `limit`. */
  since(since: number, limit = Infinity): { messages: SpectatorMsg[]; more: boolean } {
    const out: SpectatorMsg[] = [];
    // history is in seq order: binary search for the first seq > since
    let lo = 0;
    let hi = this.history.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const m = this.history[mid];
      const s = m ? m.seq : this.seqAt(mid);
      if (s <= since) lo = mid + 1;
      else hi = mid;
    }
    for (let i = lo; i < this.history.length; i++) {
      const m = this.history[i];
      if (!m) continue;
      if (out.length >= limit) return { messages: out, more: true };
      out.push(m);
    }
    return { messages: out, more: false };
  }

  /** seq of a superseded (null) slot: the nearest live neighbor's seq is a safe lower bound for the search. */
  private seqAt(i: number): number {
    for (let j = i; j >= 0; j--) if (this.history[j]) return this.history[j]!.seq;
    return 0;
  }

  /** Static description sent first on every connection (and with every poll). */
  hello(): Record<string, unknown> {
    const p = this.policy;
    return {
      protocol: SPECTATE_PROTOCOL,
      epoch: this.epoch,
      server_time: this.now(),
      seq: this.seq,
      event: {
        id: this.eventId, stage: this.stage, over: this.eventOver, ...this.meta,
        // A seat's harness and model are released with its hidden information (when it has no games left): live,
        // an agent with web tools could otherwise find its table and learn its opponents' models (OBS-1, LOB-5).
        seats: this.seats.map((s) => (this.eventOver || this.seatsDone.has(s.name) ? s : { name: s.name, kind: s.kind, position: s.position })),
        agents: this.agents,
        // The seed regenerates every pack: shown only once the whole draft is public.
        ...(this.seed && (this.eventOver || this.draftReleased()) ? { seed: this.seed } : {}),
      },
      policy: {
        draft: p.draft, notes: p.notes, hidden: p.hidden, delay_s: Math.round(p.delayMs / 1000),
        text: describePolicy(p),
      },
    };
  }

  onMessage(f: (m: SpectatorMsg) => void): () => void {
    this.listeners.add(f);
    return () => this.listeners.delete(f);
  }

  // -------------------------------------------------------------------------
  // Release machinery

  private emit(p: Payload, key?: string): void {
    const msg: SpectatorMsg = { ...p, seq: ++this.seq };
    if (key) {
      const prev = this.byKey.get(key);
      if (prev != null) {
        const idx = this.bySeq.get(prev);
        if (idx != null) this.history[idx] = null;
        this.bySeq.delete(prev);
      }
      this.byKey.set(key, msg.seq);
    }
    this.bySeq.set(msg.seq, this.history.length);
    this.history.push(msg);
    this.compact();
    for (const f of this.listeners) f(msg);
  }

  /** Drop superseded slots once they dominate the history. */
  private compact(): void {
    if (this.history.length < 2000 || this.bySeq.size > this.history.length / 2) return;
    this.history = this.history.filter((m): m is SpectatorMsg => m != null);
    this.bySeq.clear();
    this.history.forEach((m, i) => this.bySeq.set(m!.seq, i));
  }

  private hold(cond: Cond, label: Held['label'], build: () => Payload | null, key?: string): void {
    if (this.ok(cond)) {
      const p = build();
      if (p) this.emit(p, key);
      return;
    }
    this.held.push({ cond, key, build, label });
    if (this.timesOf(cond).length) this.armTimer();
  }

  /** A condition that also waits for the broadcast delay, so a full message never lands before the delayed public one it replaces. */
  private afterDelay(t: number, c: Cond): Cond {
    return this.policy.delayMs > 0 ? { kind: 'all', of: [c, { kind: 'time', at: t + this.policy.delayMs }] } : c;
  }

  /** Live game information: immediate, or after the broadcast delay. */
  private live(p: Payload, key?: string): void {
    if (this.policy.delayMs > 0 && !this.eventOver) this.hold({ kind: 'time', at: p.t + this.policy.delayMs }, 'other', () => p, key);
    else this.emit(p, key);
  }

  private ok(c: Cond): boolean {
    if (this.eventOver) return true;
    switch (c.kind) {
      case 'now': return true;
      case 'time': return this.now() >= c.at;
      case 'round': return this.draftOver || this.roundsDone.has(c.round);
      case 'draft': return this.draftOver;
      case 'seat': return this.seatsDone.has(c.seat);
      case 'game':
      case 'turn': {
        const at = this.releaseAt(c);
        return at != null && this.now() >= at;
      }
      case 'all': return c.of.every((x) => this.ok(x));
    }
  }

  /** A game reached `turn` at time `t` (the first time each turn is seen counts). */
  private reach(g: GameInfo, turn: number, t: number): void {
    for (let n = g.turn + 1; n <= turn; n++) if (!g.turnAt.has(n)) g.turnAt.set(n, t);
    g.turn = Math.max(g.turn, turn);
  }

  /**
   * When a game- or turn-based condition is met: the moment the game reached that turn (or ended), plus the broadcast
   * delay, so released notes never run ahead of the delayed boards. Undefined while not reached yet.
   */
  private releaseAt(c: { kind: 'game' | 'turn'; game: string; turn?: number }): number | undefined {
    const g = this.games.get(c.game);
    if (!g) return undefined;
    const delay = this.policy.delayMs;
    if (g.over) return (g.overAt ?? 0) + delay;
    if (c.kind === 'game' || g.turn < (c.turn ?? Infinity)) return undefined;
    return (g.turnAt.get(c.turn!) ?? 0) + delay;
  }

  /** Times at which a held condition may become true by itself (for the release timer). */
  private timesOf(c: Cond): number[] {
    if (c.kind === 'time') return [c.at];
    if (c.kind === 'all') return c.of.flatMap((x) => this.timesOf(x));
    if ((c.kind === 'turn' || c.kind === 'game') && this.policy.delayMs > 0) {
      const at = this.releaseAt(c);
      return at != null && at > this.now() ? [at] : [];
    }
    return [];
  }

  /**
   * Release everything whose condition now holds, in the order it was held, except that delayed live messages (boards,
   * log) go before everything else due in the same pass: with a broadcast delay, several turns can come due at once,
   * and a note must never reach viewers ahead of the board of the turn that released it.
   */
  flush(): void {
    if (!this.held.length) return this.sendWithheld();
    // A released message can make more conditions true (a seat's delayed "done" releases its deck): pass again.
    for (let pass = 0; pass < 4 && this.held.length; pass++) {
      const due: Held[] = [];
      const keep: Held[] = [];
      for (const h of this.held) (this.ok(h.cond) ? due : keep).push(h);
      if (!due.length) break;
      this.held = keep;
      for (const h of [...due.filter((x) => x.cond.kind === 'time'), ...due.filter((x) => x.cond.kind !== 'time')]) {
        const p = h.build();
        if (p) this.emit(p, h.key);
      }
    }
    this.sendWithheld();
    this.armTimer();
  }

  private armTimer(): void {
    const times = this.held.flatMap((h) => this.timesOf(h.cond));
    clearTimeout(this.timer);
    if (!times.length) return;
    const wait = Math.max(50, Math.min(...times) - this.now());
    this.timer = setTimeout(() => this.flush(), wait);
    this.timer.unref?.();
  }

  /** How much is held back, by kind (so the page can say "12 picks hidden until pack 1 ends"). At most once a second. */
  private sendWithheld(): void {
    if (this.withheldTimer) return;
    const wait = this.withheldAt + 1000 - this.now();
    if (wait > 0 && !this.eventOver) {
      this.withheldTimer = setTimeout(() => {
        this.withheldTimer = undefined;
        this.sendWithheld();
      }, wait);
      this.withheldTimer.unref?.();
      return;
    }
    this.withheldAt = this.now();
    const counts: Record<string, number> = { picks: 0, decisions: 0, decks: 0, flags: 0 };
    for (const h of this.held) {
      if (h.label === 'pick') counts.picks!++;
      else if (h.label === 'decision') counts.decisions!++;
      else if (h.label === 'deck') counts.decks!++;
      else if (h.label === 'flag') counts.flags!++;
    }
    const sig = JSON.stringify(counts);
    if (sig === this.withheldSent) return;
    this.withheldSent = sig;
    this.emit({ type: 'withheld', t: this.now(), ...counts }, 'withheld');
  }

  private draftReleased(): boolean {
    return this.draftOver && (this.policy.draft !== 'seat' || this.agents.every((a) => this.seatsDone.has(a)));
  }

  // -------------------------------------------------------------------------
  // Conditions per policy

  private pickCond(seat: string, round: number): Cond {
    const isBot = !this.agents.includes(seat);
    switch (this.policy.draft) {
      case 'round': return { kind: 'round', round };
      case 'draft': return { kind: 'draft' };
      case 'seat': return isBot ? { kind: 'draft' } : { kind: 'all', of: [{ kind: 'draft' }, { kind: 'seat', seat }] };
    }
  }

  private hiddenCond(seat: string, game: string): Cond {
    return this.policy.hidden === 'game' ? { kind: 'game', game } : { kind: 'all', of: [{ kind: 'game', game }, { kind: 'seat', seat }] };
  }

  private notesCond(seat: string, game: string, turn: number): Cond {
    const n = this.policy.notes;
    if (n === 'game') return { kind: 'game', game };
    if (n === 'seat') return this.hiddenCond(seat, game);
    return { kind: 'turn', game, turn: turn + n.turns };
  }

  /** Card names of the game's decks that have not been seen in a public zone: blanked out of released notes. */
  private hiddenNames(game: string): string[] {
    const g = this.games.get(game);
    const names = new Set<string>();
    for (const s of g?.seats ?? []) for (const n of this.decks.get(s) ?? []) if (!this.publicNames.has(n)) names.add(n);
    return [...names];
  }

  // -------------------------------------------------------------------------
  // Inputs

  /** Every record the Director logs (full and private). */
  ingest(raw: Record<string, unknown> & { t: number; type: string }): void {
    // Agent notes are never streamed (an older log, or a seat that sent one anyway); rules reports keep theirs.
    const r = withoutUnpublishedText(raw);
    const t = r.t;
    switch (r.type) {
      case 'event_start': {
        const set = r.set as Record<string, unknown> | undefined;
        this.meta = {
          set: set ? { code: String(set.code ?? '').toUpperCase(), name: set.name } : undefined,
          best_of: r.best_of, mana: r.mana, knowledge: (r.knowledge as { level?: string } | undefined)?.level, started_at: t,
          pod_size: (r.seats as unknown[] | undefined)?.length,
        };
        this.pickClock = { first: Number(r.first_pick_ms) || 0, ms: Number(r.draft_pick_ms) || 0 };
        this.seed = typeof r.seed === 'string' ? r.seed : undefined;
        this.seats = ((r.seats as Array<Record<string, unknown>>) ?? []).map((s) => ({
          name: String(s.name), kind: String(s.kind), position: Number(s.position),
          ...(s.harness ? { harness: String(s.harness) } : {}), ...(s.model ? { model: String(s.model) } : {}),
        }));
        this.agents = this.seats.filter((s) => s.kind === 'agent').map((s) => s.name);
        for (const a of this.agents) this.standings.set(a, { gw: 0, gl: 0, mw: 0, ml: 0 });
        const plan = r.pairing as { rounds?: unknown } | undefined;
        this.plannedRounds = plan && Number.isFinite(Number(plan.rounds)) ? Number(plan.rounds) : undefined;
        this.setStage('draft', t);
        break;
      }
      case 'packs_opened': {
        const round = Number(r.round);
        const packs = (r.packs as string[][]) ?? [];
        this.packSize = packs[0]?.length ?? this.packSize;
        this.live({ type: 'draft_round', t, round, pack_size: this.packSize, packs: packs.length });
        const swaps = (r.swaps as Array<{ from: string; to: string }>) ?? [];
        if (swaps.length) this.hold(this.policy.draft === 'round' ? { kind: 'round', round } : { kind: 'draft' }, 'other', () => ({ type: 'swaps', t, round, swaps }));
        break;
      }
      case 'draft_pick': {
        const seat = String(r.seat);
        const round = Number(r.pack_number);
        const overall = Number(r.overall_pick ?? 0);
        const key = `pick:${seat}:${overall}`;
        this.picksBySeat.set(seat, (this.picksBySeat.get(seat) ?? 0) + 1);
        this.emit({ type: 'draft_progress', t, seat, pack: round, pick: r.pick_number, overall, by: r.by, latency_ms: r.latency_ms }, key);
        const pack = (r.pack as string[]) ?? [];
        const rar = (r.pack_rarities as string[]) ?? [];
        this.hold(this.pickCond(seat, round), 'pick', () => ({
          type: 'draft_pick', t, seat, pack: round, pick: r.pick_number, overall, card: r.pick, by: r.by,
          contents: pack.map((name, i) => (rar[i] ? { name, rarity: rar[i] } : { name })),
          ...(r.note ? { note: r.note } : {}), ...(r.latency_ms != null ? { latency_ms: r.latency_ms } : {}),
        }), key);
        const done = (this.picksInRound.get(round) ?? 0) + 1;
        this.picksInRound.set(round, done);
        if (this.packSize && done >= this.packSize * this.seats.length && !this.roundsDone.has(round)) {
          this.roundsDone.add(round);
          if (this.policy.draft === 'round') this.emit({ type: 'release', t, what: 'draft_round', round });
        }
        break;
      }
      case 'draft_end':
        this.draftOver = true;
        if (this.policy.draft === 'draft') this.emit({ type: 'release', t, what: 'draft' });
        if (this.agents.length < 2) for (const s of this.seats) this.seatsDone.add(s.name);
        this.setStage('build', t);
        break;
      case 'deck_built': {
        const seat = String(r.seat);
        const main = (r.main as string[]) ?? [];
        const side = (r.sideboard as string[]) ?? [];
        this.decks.set(seat, [...new Set([...main, ...side])]);
        this.emit({ type: 'deck_submitted', t, seat, by: r.by, main_count: main.length, latency_ms: r.latency_ms }, `deck:${seat}`);
        this.hold(this.afterDelay(t, { kind: 'seat', seat }), 'deck', () => ({
          type: 'deck', t, seat, by: r.by, main, sideboard: side, ...(r.note ? { note: r.note } : {}), latency_ms: r.latency_ms,
        }), `deck:${seat}`);
        break;
      }
      case 'build_end':
        this.setStage('games', t);
        if (this.agents.length < 2) for (const s of this.agents) this.seatsDone.add(s);
        break;
      case 'game_start': {
        const label = String(r.game);
        const g: GameInfo = {
          label, index: this.games.size + 1, match: String(r.match ?? label.replace(/\s+—\s+game\s+\d+$/, '')), gameNumber: Number(r.game_number ?? 1),
          seats: (r.seats as string[]) ?? [], over: false, turn: 0, turnAt: new Map(),
        };
        this.games.set(label, g);
        this.live({ type: 'game_start', t, game: label, index: g.index, match: g.match, game_number: g.gameNumber, seats: g.seats, mana: r.mana });
        break;
      }
      case 'turn_snapshot': {
        const game = String(r.game);
        const g = this.games.get(game);
        if (g) this.reach(g, Number(r.turn) || 0, t);
        // SPEC-1: a snapshot is the host seat's projection, and logs written before 2026-10-22 name that seat's
        // face-down permanents in it. So it never makes a name public (public names come only from publicBoard,
        // publicLogLine and cards played), and the snapshot frame (shown for logs replayed from disk, which have no
        // live boards) waits until that game's hidden information is released. A live board, once there is one,
        // supersedes it.
        if (g && !this.boardTimers.has(game)) {
          const frame: Payload = { type: 'snapshot', t, game, turn: r.turn, active: r.active, players: r.players };
          const cond: Cond = this.policy.hidden === 'game' ? { kind: 'game', game } : { kind: 'all', of: [{ kind: 'game', game }, ...g.seats.map((seat): Cond => ({ kind: 'seat', seat }))] };
          this.hold(cond, 'other', () => (this.boardTimers.has(game) ? null : frame), `board:${game}`);
        }
        break;
      }
      case 'decision_offered': {
        const game = String(r.game);
        const g = this.games.get(game);
        if (g) this.reach(g, Number(r.turn) || 0, t);
        this.lastOffered.set(String(r.seat), { id: String(r.id), game, kind: String(r.kind), turn: Number(r.turn) || 0 });
        break;
      }
      case 'agent_decision': {
        if (!r.game) break;
        const game = String(r.game);
        const seat = String(r.seat);
        const turn = Number(r.turn) || 0;
        const base = {
          type: 'decision', t, game, seat, id: r.id, kind: r.kind, kind_label: coarseKind(String(r.kind)), turn,
          latency_ms: r.latency_ms, accepted: r.accepted !== false, structured: r.structured === true,
        };
        const full = (): Payload => ({ ...base, choice: r.choice, ...(r.note ? { note: r.note } : {}), ...(r.card ? { card: r.card } : {}), full: true });
        const notesCond = this.notesCond(seat, game, turn);
        const hiddenCond = this.hiddenCond(seat, game);
        const key = `dec:${game}:${seat}:${String(r.id)}:${t}`;
        if (sameCond(notesCond, hiddenCond)) {
          this.hold(hiddenCond, 'decision', full, key);
        } else {
          this.hold(notesCond, 'decision', () => {
            if (this.ok(hiddenCond)) return full();
            // A choice about hidden cards (bottoming, scry, search) stays hidden whole, note included.
            if (isHiddenChoice(String(r.kind), String(r.choice ?? ''))) return { ...base, choice: 'A choice about hidden cards', redacted: true, full: false };
            const hidden = this.hiddenNames(game);
            const choice = redactCards(String(r.choice ?? ''), hidden);
            const note = redactCards(String(r.note ?? ''), hidden);
            const card = r.card && hidden.includes(String(r.card)) ? undefined : r.card;
            return { ...base, choice: choice.text, ...(r.note ? { note: note.text } : {}), ...(card ? { card } : {}), redacted: choice.redacted || note.redacted || (!!r.card && !card), full: false };
          }, key);
          this.hold(hiddenCond, 'other', full, key);
        }
        break;
      }
      case 'card_played':
        if (r.card) this.publicNames.add(String(r.card));
        break;
      case 'unimplemented_effect':
        if (r.card) this.publicNames.add(String(r.card));
        this.live({ type: 'flag', t, kind: 'unimplemented_effect', game: r.game, seat: r.seat ?? null, card: r.card ?? null, turn: r.turn ?? null });
        break;
      case 'rules_issue': {
        const seat = String(r.seat);
        const game = r.game ? String(r.game) : null;
        const base = { type: 'flag', t, kind: 'rules_issue', game, seat, turn: r.turn ?? null, stage: r.stage };
        const full = (): Payload => ({ ...base, card: r.card ?? null, note: r.note ?? '' , full: true });
        if (!game) {
          this.hold(this.policy.hidden === 'game' ? { kind: 'draft' } : { kind: 'seat', seat }, 'flag', full);
          break;
        }
        const turn = Number(r.turn) || 0;
        this.hold(this.notesCond(seat, game, turn), 'flag', () => {
          if (this.ok(this.hiddenCond(seat, game))) return full();
          const hidden = this.hiddenNames(game);
          const card = r.card && hidden.includes(String(r.card)) ? '[hidden card]' : r.card ?? null;
          return { ...base, card, note: redactCards(String(r.note ?? ''), hidden).text, full: false };
        }, `flag:${seat}:${t}`);
        this.hold(this.hiddenCond(seat, game), 'other', full, `flag:${seat}:${t}`);
        break;
      }
      case 'play_draw': {
        // Who plays first is public (the game shows it); the chooser's note is reasoning, released with its hidden information.
        const base = { type: 'play_draw', t, match: r.match, game_number: r.game_number, on_play: r.on_play, chooser: r.chooser ?? null, choice: r.choice ?? null, by: r.by };
        const key = `pd:${String(r.match)}:${String(r.game_number)}`;
        this.live(base, key);
        if (r.note && r.chooser) this.hold(this.afterDelay(t, { kind: 'seat', seat: String(r.chooser) }), 'other', () => ({ ...base, note: r.note, full: true }), key);
        break;
      }
      case 'sideboarded': {
        // Live (after the broadcast delay): that the seat has sideboarded and its deck size, both public at the table. What
        // went in and out waits with the decklist until the seat has no games left: it tells a later opponent (and this
        // match's opponent, in game 3) what the deck holds.
        const seat = String(r.seat);
        const key = `sb:${seat}:${String(r.match)}:${String(r.game_number)}`;
        const base = { type: 'sideboarded', t, seat, match: r.match, game_number: r.game_number, main_count: r.main_count };
        this.live(base, key);
        this.hold(this.afterDelay(t, { kind: 'seat', seat }), 'deck', () => ({
          ...base, by: r.by, kept: r.kept, in: r.in, out: r.out, ...(r.note ? { note: r.note } : {}), latency_ms: r.latency_ms, full: true,
        }), key);
        break;
      }
      case 'game_over': {
        const game = String(r.game);
        const g = this.games.get(game);
        if (g) {
          this.reach(g, Number(r.turns) || 0, t);
          g.over = true;
          g.overAt ??= t;
        }
        const winner = r.winner == null ? null : String(r.winner);
        if (g && winner) {
          for (const s of g.seats) {
            const st = this.standings.get(s);
            if (st) winner === s ? st.gw++ : st.gl++;
          }
        }
        this.live({ type: 'game_over', t, game, winner, turns: r.turns, end_reason: r.end_reason, final_life: r.final_life, on_play: r.on_play, mulligans: r.mulligans });
        break;
      }
      case 'game_failed': {
        const game = String(r.game);
        if (r.void) {
          // A voided game (lost to a restart) is replayed under the same label: forget its board and turn.
          const g = this.games.get(game);
          if (g) {
            g.turn = 0;
            g.turnAt.clear();
          }
          this.live({ type: 'notice', t, game, void: true, text: r.replay === false
            ? 'This game was voided again and the match ends here with no result. Voided games count for nobody.'
            : `This game was voided (${r.reason === 'setup_failed' ? 'the rules engine could not start it' : 'lost to a restart'}). It counts for nobody and is replayed from the start.` });
        } else this.live({ type: 'notice', t, game: r.game, text: 'The rules engine could not start this game; the match ends here.' });
        break;
      }
      case 'event_resume':
        this.live({ type: 'notice', t, text: 'The Director restarted; the event resumed where it was.' });
        break;
      case 'match_end': {
        const a = String(r.a);
        const b = String(r.b);
        const wins = (r.wins as Record<string, number>) ?? {};
        const sa = this.standings.get(a);
        const sb = this.standings.get(b);
        const noResult = r.no_result === true;
        if (sa && sb && !noResult && (wins[a] ?? 0) !== (wins[b] ?? 0)) {
          if ((wins[a] ?? 0) > (wins[b] ?? 0)) (sa.mw++, sb.ml++);
          else (sb.mw++, sa.ml++);
        }
        for (const s of [a, b]) {
          this.matchesEnded.set(s, (this.matchesEnded.get(s) ?? 0) + 1);
          this.checkSeatDone(s, t);
        }
        this.live({ type: 'match_end', t, a, b, wins, ...(noResult ? { no_result: true } : {}) });
        // Standings carry the results: after the broadcast delay like game_over and match_end, never ahead of them.
        this.live({ type: 'standings', t, standings: this.standingsRows() }, 'standings');
        break;
      }
      case 'round_start': {
        // Swiss rounds are paired one at a time: a seat is done once every round is paired and its matches ended.
        this.roundsPaired = Math.max(this.roundsPaired, Number(r.round) || 0);
        for (const s of ((r.pairs as string[][]) ?? []).flat()) this.pairedIn.set(String(s), (this.pairedIn.get(String(s)) ?? 0) + 1);
        for (const s of this.agents) this.checkSeatDone(s, t);
        break;
      }
      case 'event_end':
      case 'event_abort':
      case 'event_error': {
        if (this.eventOver) break;
        this.eventOver = true;
        for (const a of this.agents) {
          if (!this.seatsDone.has(a)) this.emit({ type: 'release', t, what: 'seat', seat: a, ...this.identity(a) });
          this.seatsDone.add(a);
        }
        this.stage = 'done';
        this.flush();
        this.emit({ type: 'stage', t, stage: 'done' }, 'stage');
        // A stopped event says why (the Director's own words: a stalled draft names its seats, never what they decided).
        const why = r.type === 'event_abort' ? { reason: String(r.reason ?? ''), ...(typeof r.detail === 'string' ? { detail: r.detail } : {}) } : {};
        this.emit({ type: 'event_end', t, aborted: r.type !== 'event_end', ...why, standings: this.standingsRows() });
        break;
      }
    }
    this.flush();
  }

  /**
   * A seat has played all its matches: with a pairing plan (Swiss or round robin, logged from 2026-10-22), once
   * every round is paired and the matches it was paired in have ended; in older logs (round robins), after
   * agents − 1 matches.
   */
  private checkSeatDone(s: string, t: number): void {
    if (this.seatsDone.has(s) || !this.agents.includes(s)) return;
    const ended = this.matchesEnded.get(s) ?? 0;
    const done = this.plannedRounds != null
      ? this.roundsPaired >= this.plannedRounds && ended >= (this.pairedIn.get(s) ?? 0)
      : ended >= this.agents.length - 1;
    if (!done || this.seatsDoneAt.has(s)) return;
    this.seatsDoneAt.set(s, t);
    // "Done" says the seat's last match just ended: after the broadcast delay, with that match's results.
    const markDone = (): Payload | null => {
      if (this.seatsDone.has(s)) return null;
      this.seatsDone.add(s);
      return { type: 'release', t, what: 'seat', seat: s, ...this.identity(s) };
    };
    if (this.policy.delayMs > 0 && !this.eventOver) this.hold({ kind: 'time', at: t + this.policy.delayMs }, 'other', markDone);
    else {
      const p = markDone();
      if (p) this.emit(p);
    }
  }

  /** A seat's harness and model (released with the seat). */
  private identity(seat: string): Record<string, string> {
    const s = this.seats.find((x) => x.name === seat);
    return { ...(s?.harness ? { harness: s.harness } : {}), ...(s?.model ? { model: s.model } : {}) };
  }

  private setStage(stage: string, t: number): void {
    this.stage = stage;
    this.emit({ type: 'stage', t, stage }, 'stage');
  }

  private standingsRows(): Array<{ name: string; match_w: number; match_l: number; game_w: number; game_l: number }> {
    return [...this.standings.entries()]
      .map(([name, s]) => ({ name, match_w: s.mw, match_l: s.ml, game_w: s.gw, game_l: s.gl }))
      .sort((x, y) => y.match_w - x.match_w || y.game_w - y.game_l - (x.game_w - x.game_l));
  }

  /** A seat's open decision changed (offer made, answered, withdrawn, or the seat finished). */
  seatPending(seat: string, offer: { id: string; phase: string; kind: string; createdAt: number } | undefined, done = false): void {
    const t = this.now();
    if (done) {
      // A seat finishes when its last match ends (the Director tells it at once): delayed like its results.
      this.liveFor(seat, { type: 'seat_status', t, seat, state: 'done' }, `clock:${seat}`);
      return;
    }
    if (!offer) {
      this.liveFor(seat, { type: 'seat_status', t, seat, state: 'waiting' }, `clock:${seat}`);
      return;
    }
    if (offer.phase === 'game') {
      const lo = this.lastOffered.get(seat);
      const game = lo?.id === offer.id ? lo.game : undefined;
      this.liveFor(seat, { type: 'seat_status', t, seat, state: 'thinking', stage: 'game', game, kind: coarseKind(offer.kind), turn: lo?.turn, since: offer.createdAt }, `clock:${seat}`);
    } else if (offer.phase === 'sideboard') {
      // Between games: "Sideboarding…" / "Choosing play or draw…" (delayed like the games' clocks), never what is changing.
      this.liveFor(seat, { type: 'seat_status', t, seat, state: 'thinking', stage: 'sideboard', kind: coarseKind(offer.kind), since: offer.createdAt }, `clock:${seat}`);
    } else if (offer.phase === 'draft') {
      const n = (this.picksBySeat.get(seat) ?? 0) + 1;
      const pack = this.packSize ? Math.ceil(n / this.packSize) : undefined;
      const pick = this.packSize ? n - (pack! - 1) * this.packSize : undefined;
      // The pick clock (event_start, from 2026-10-26): how long this pick may take, for a countdown.
      const limit = n === 1 ? this.pickClock.first : this.pickClock.ms;
      this.emit({ type: 'seat_status', t, seat, state: 'thinking', stage: 'draft', kind: 'pick', pack, pick, since: offer.createdAt, ...(limit > 0 ? { limit_ms: limit } : {}) }, `clock:${seat}`);
    } else {
      this.emit({ type: 'seat_status', t, seat, state: 'thinking', stage: 'build', kind: 'deck', since: offer.createdAt }, `clock:${seat}`);
    }
  }

  /** Game-stage clocks follow the broadcast delay; draft/build clocks don't need it. */
  private liveFor(seat: string, p: Payload, key: string): void {
    if (this.stage === 'games') this.live(p, key);
    else this.emit(p, key);
  }

  /**
   * Live public board of a game (throttled: at most one message per 250 ms per game, the latest wins). A new turn is
   * never throttled away: notes are released by turn, so every turn's board must reach spectators first (a whole turn
   * of auto-passes inside 250 ms once let notes out a turn ahead of the board).
   */
  board(game: string, b: PublicBoard): void {
    const g = this.games.get(game);
    if (g) this.reach(g, b.turn, this.now());
    for (const p of Object.values(b.players)) {
      for (const perm of p.battlefield) if (!perm.face_down) this.publicNames.add(perm.name);
      for (const n of [...p.graveyard, ...p.exile]) this.publicNames.add(n);
    }
    for (const s of b.stack) this.publicNames.add(s.name);
    let st = this.boardTimers.get(game);
    if (!st) this.boardTimers.set(game, (st = { last: 0 }));
    st.pending = b;
    const wait = st.last + 250 - this.now();
    if (wait <= 0 || b.turn !== st.lastTurn) this.flushBoard(game);
    else if (!st.timer) {
      st.timer = setTimeout(() => this.flushBoard(game), wait);
      st.timer.unref?.();
    }
  }

  private flushBoard(game: string): void {
    const st = this.boardTimers.get(game);
    if (!st?.pending) return;
    clearTimeout(st.timer);
    st.timer = undefined;
    st.last = this.now();
    const b = st.pending;
    st.lastTurn = b.turn;
    st.pending = undefined;
    const t = this.now();
    this.live({ type: 'board', t, game, ...b }, `board:${game}`);
    const life = Object.fromEntries(Object.entries(b.players).map(([s, p]) => [s, p.life]));
    const g = this.games.get(game);
    const sig = `${b.turn}|${JSON.stringify(life)}`;
    if (g && g.lastLife !== sig) {
      g.lastLife = sig;
      this.live({ type: 'life', t, game, turn: b.turn, life }, `life:${game}:${b.turn}`);
    }
    this.flush();
  }

  /** Public game log lines (identical for both players: phase-rs omits concealed moves). */
  logLines(game: string, lines: LogLine[], names: string[]): void {
    if (!lines.length) return;
    for (const n of names) this.publicNames.add(n);
    this.live({ type: 'log', t: this.now(), game, lines });
  }

  /** Flush the last board of a game right away (game over). */
  endBoard(game: string): void {
    this.flushBoard(game);
  }

  close(): void {
    clearTimeout(this.timer);
    clearTimeout(this.withheldTimer);
    for (const st of this.boardTimers.values()) clearTimeout(st.timer);
    this.listeners.clear();
  }
}

function sameCond(a: Cond, b: Cond): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ---------------------------------------------------------------------------
// Public projections of phase-rs state (no hidden zones are read)

const words = (s: string): string => String(s).replace(/([a-z])([A-Z])/g, '$1 $2');

/** The public board from one seat's state: battlefield, graveyards, exile, stack, combat, counts. Never hands or libraries. */
export function publicBoard(state: any, seatOf: (player: number) => string | null): PublicBoard {
  const obj = (id: number) => state.objects?.[String(id)];
  const hidden = (o: any) => !o || o.face_down || o.name === 'Hidden Card';
  const nameOf = (id: number) => {
    const o = obj(id);
    return hidden(o) ? 'Face-down card' : String(o.name);
  };
  const players: PublicBoard['players'] = {};
  (state.players ?? []).forEach((pl: any, i: number) => {
    const seat = seatOf(pl.id ?? i);
    if (!seat) return;
    const perms: PublicPermanent[] = (state.battlefield ?? [])
      .map((id: number) => [id, obj(id)] as const)
      .filter(([, o]: readonly [number, any]) => o?.controller === (pl.id ?? i))
      .map(([id, o]: readonly [number, any]) => {
        const types: string[] = o.card_types?.core_types ?? [];
        const p: PublicPermanent = { id, name: nameOf(id), land: types.includes('Land'), creature: types.includes('Creature') };
        if (o.tapped) p.tapped = true;
        if (o.power != null && o.toughness != null && !hidden(o)) p.pt = `${o.power}/${o.toughness}`;
        if (o.loyalty != null) p.loyalty = o.loyalty;
        const counters = Object.fromEntries(Object.entries(o.counters ?? {}).filter(([, n]) => typeof n === 'number' && n));
        if (Object.keys(counters).length) p.counters = counters as Record<string, number>;
        const kws = hidden(o) ? [] : (o.keywords ?? []).map((k: any) => (typeof k === 'string' ? k : Object.keys(k ?? {})[0] ?? '')).filter(Boolean);
        if (kws.length) p.keywords = kws;
        if (o.summoning_sick || o.has_summoning_sickness) p.sick = true;
        if (o.damage_marked) p.damage = o.damage_marked;
        if (o.attached_to != null) p.attached_to = o.attached_to;
        if (o.is_token || o.token) p.token = true;
        if (hidden(o)) p.face_down = true;
        return p;
      });
    players[seat] = {
      life: pl.life, ...(pl.poison_counters ? { poison: pl.poison_counters } : {}),
      hand: pl.hand?.length ?? 0, library: pl.library?.length ?? 0,
      graveyard: (pl.graveyard ?? []).map(nameOf),
      exile: (state.exile ?? []).filter((id: number) => obj(id)?.owner === (pl.id ?? i)).map(nameOf),
      battlefield: perms,
    };
  });
  const stack = [...(state.stack ?? [])].reverse().map((e: any) => ({
    name: nameOf(e.source_id),
    controller: seatOf(e.controller),
    kind: e.kind?.type === 'Spell' ? 'spell' : words(e.kind?.type ?? 'ability').toLowerCase(),
    ...(e.kind?.data?.description && !hidden(obj(e.source_id)) ? { text: String(e.kind.data.description) } : {}),
  }));
  const blockers = state.combat?.blocker_assignments ?? {};
  const combat = (state.combat?.attackers ?? []).map((a: any) => ({
    attacker: a.object_id,
    target: a.attack_target?.type === 'Player' ? (seatOf(a.attack_target.data) ?? 'player') : nameOf(a.attack_target?.data),
    blockers: blockers[String(a.object_id)] ?? [],
  }));
  return {
    turn: state.turn_number ?? 0, phase: words(state.phase ?? ''), active: state.active_player != null ? seatOf(state.active_player) : null,
    priority: state.priority_player != null ? seatOf(state.priority_player) : null, players, stack, combat,
  };
}

/** A phase-rs log entry as public text with seat names; also returns the card names it mentions. */
export function publicLogLine(entry: any, seatOf: (player: number) => string | null): { line: LogLine; names: string[] } {
  const names: string[] = [];
  const text = (entry.segments ?? []).map((s: any) => {
    switch (s.type) {
      case 'PlayerName': return seatOf(s.value?.player_id) ?? 'A player';
      case 'CardName':
        if (s.value?.name) names.push(String(s.value.name));
        return s.value?.name ?? 'a card';
      case 'Text': return s.value;
      default: return typeof s.value === 'object' ? (s.value?.name ?? '') : String(s.value ?? '');
    }
  }).join('');
  return { line: { turn: entry.turn ?? 0, phase: words(entry.phase ?? ''), text }, names };
}
