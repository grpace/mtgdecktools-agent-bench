/**
 * Durability: live events survive a Director restart or redeploy (docs/ARCHITECTURE.md §5).
 *
 * The event log (events.jsonl) is already the source of truth for everything that happened: packs, every pick,
 * decks, games, results. What it doesn't hold (and must not, since it is published) lives in a private
 * checkpoint next to it, `state.json` (mode 600): who created the event, its request, the seat tokens (so seat
 * MCP URLs stay valid), and the phase-server reconnect credentials of the games in progress. `knowledge.json`
 * keeps the exact briefing and primer the seats were given, so a resumed event doesn't fetch a newer primer.
 *
 * On start, the server resumes every event whose checkpoint says `running` (and re-queues `queued` ones):
 * - the draft is replayed through the same code from the logged packs and picks (draft.ts DraftReplay): same
 *   seed, same Rng draws for the bots, so it continues at the pick it had reached, and the Hub's pack
 *   regeneration still verifies;
 * - decks already submitted are taken from the log; the others are asked for again;
 * - finished games and matches come from the log; a game in progress is re-attached on phase-server with the
 *   seats' saved credentials (Reconnect; phase-server keeps a disconnected seat for 120 s, across its own
 *   restarts too). If that fails, the game is voided (`game_failed` with `void: true`) and replayed from the
 *   start: a void is never a loss for anyone.
 */
import { closeSync, existsSync, ftruncateSync, openSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PackCard } from './boosters.js';
import type { BuiltDeck } from './build.js';
import type { DraftReplay } from './draft.js';
import type { GameResume, GameSession } from './game.js';
import type { Knowledge, KnowledgeLevel } from './knowledge.js';
import type { ManaMode } from './game.js';
import type { ContextPolicy } from './context-policy.js';

export type Raw = Record<string, any> & { t: number; type: string };

/** Who created an event: the admin token, a contributor's Hub token (hosted play), or the lobby (a fired table). */
export type Owner = { kind: 'admin' } | { kind: 'contributor'; id: number; handle: string; token_id?: number } | { kind: 'lobby'; table: string };

export interface AgentSpec {
  name: string;
  /** Canonical ids once resolved by the registry (packages/registry resolveSeat). */
  harness?: string;
  model?: string;
  effort?: string;
  /** The strings as declared, when they differ from the canonical ones (logged in event_start; the export re-resolves them). */
  harness_declared?: string;
  model_declared?: string;
  effort_declared?: string;
  /** How the effort was declared: "launch" (set explicitly when the bench CLI started the seat) or "self-report". */
  effort_basis?: 'launch' | 'self-report';
  /** Declared context policy (context-policy.ts): the launcher starts a fresh harness session per game or per match. */
  context_policy?: ContextPolicy;
}

/** Lobby tables: who brought each seat (provenance in event_start.seats[]; the handle only when shown publicly). */
export interface SeatProvenance {
  contributor_id?: string;
  contributor?: string;
  /** The lobby entry the seat came from (checkpoint only, never logged: finds the table again after a restart). */
  entry_id?: string;
}

/** What kind of table an event is (logged in event_start.table). */
export interface TableInfo {
  kind: 'lobby' | 'private';
  queue?: string;
  table_id?: string;
  schedule?: string;
  occurrence?: string;
  /** A Private Table created by a contributor's "Keep Playing" loop (bench setup --keep-playing). */
  continuous?: boolean;
}

export interface EventRequest {
  set: string;
  agents: Array<AgentSpec & SeatProvenance>;
  /** The event's actual seed (generated when the request had none). */
  seed: string;
  knowledge: KnowledgeLevel;
  mana: ManaMode;
  bestOf: number;
  podSize: number;
  /** Match pairing (default swiss). */
  pairing?: 'swiss' | 'round-robin';
  /** Lobby table or Private Table (contributor events). */
  table?: TableInfo;
}

export type CheckpointStatus = 'queued' | 'running' | 'done' | 'aborted';

export interface EventCheckpoint {
  version: 1;
  id: string;
  status: CheckpointStatus;
  owner: Owner;
  /** Capacity units the event holds while it runs (admission.ts). */
  weight: number;
  created_at: number;
  admitted_at?: number;
  ended_at?: number;
  abort_reason?: string;
  request: EventRequest;
  /** Seat name → the token in its MCP URL. */
  tokens: Record<string, string>;
  /** Games in progress → phase-server reconnect credentials. */
  games: Record<string, GameSession & { on_play?: string }>;
  /** Per seat: has it ever made an MCP request; is it currently forfeited by the watchdog. */
  seats: Record<string, { seen?: boolean; inactive?: boolean }>;
  /** How often this event was resumed after a restart. */
  resumes?: number;
  /** A contributor's "Keep Playing" Private Table (lower admission priority; admission.ts). */
  continuous?: boolean;
}

export const CHECKPOINT_FILE = 'state.json';
export const KNOWLEDGE_FILE = 'knowledge.json';

/** Write a JSON file atomically (tmp + rename), private to the Director's user. */
export function writePrivateJson(file: string, value: unknown): void {
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(value, null, 1), { mode: 0o600 });
  renameSync(tmp, file);
}

export function writeCheckpoint(dir: string, cp: EventCheckpoint): void {
  writePrivateJson(join(dir, CHECKPOINT_FILE), cp);
}

export function readCheckpoint(dir: string): EventCheckpoint | undefined {
  const f = join(dir, CHECKPOINT_FILE);
  if (!existsSync(f)) return undefined;
  try {
    const cp = JSON.parse(readFileSync(f, 'utf8')) as EventCheckpoint;
    return cp?.version === 1 && cp.id ? cp : undefined;
  } catch {
    return undefined;
  }
}

export function writeKnowledge(dir: string, k: Knowledge): void {
  writePrivateJson(join(dir, KNOWLEDGE_FILE), k);
}

export function readKnowledge(dir: string): Knowledge | undefined {
  const f = join(dir, KNOWLEDGE_FILE);
  if (!existsSync(f)) return undefined;
  try {
    return JSON.parse(readFileSync(f, 'utf8')) as Knowledge;
  } catch {
    return undefined;
  }
}

/**
 * Cut a partial last line (the process died in the middle of an append), so the next record starts on its own
 * line. Returns the number of bytes removed.
 */
export function repairLog(file: string): number {
  if (!existsSync(file)) return 0;
  const size = statSync(file).size;
  if (!size) return 0;
  const fd = openSync(file, 'r+');
  try {
    const tail = Buffer.alloc(Math.min(size, 1 << 20));
    readSync(fd, tail, 0, tail.length, size - tail.length);
    if (tail[tail.length - 1] === 0x0a) return 0;
    const nl = tail.lastIndexOf(0x0a);
    const keep = nl < 0 ? size - tail.length : size - tail.length + nl + 1;
    ftruncateSync(fd, keep);
    return size - keep;
  } finally {
    closeSync(fd);
  }
}

export function readLog(file: string): Raw[] {
  if (!existsSync(file)) return [];
  const out: Raw[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // a damaged line (repairLog removes a partial last one before resuming)
    }
  }
  return out;
}

type Counters = GameResume['counters'][string];

/** One game label's latest attempt (after its last void), read back from the log. */
export interface LoggedGame {
  label: string;
  start?: Raw;
  over?: Raw;
  /** game_failed of the latest attempt (setup failure, or a void not yet followed by a replay). */
  failed?: Raw;
  voids: number;
  records: Raw[];
}

/** Everything a resumed event needs from its log. */
export interface ResumeLog {
  records: Raw[];
  started: boolean;
  ended: boolean;
  aborted: boolean;
  draftEnded: boolean;
  buildEnded: boolean;
  draft: DraftReplay;
  decks: Map<string, Raw>;
  games: Map<string, LoggedGame>;
  /** `${a} vs ${b}` → match_end */
  matchEnds: Map<string, Raw>;
  /** `${match}|${game}` → play_draw (who played first in that game, and who chose). */
  playDraw: Map<string, Raw>;
  /** `${match}|${game}|${seat}` → sideboarded (the seat's deck for that game). */
  sideboards: Map<string, Raw>;
  /** Seats told they have no games left (`seat_done`), so a resumed event doesn't log it twice. */
  seatsDone: Set<string>;
  /** Highest decision number each seat was given (new ids continue above it). */
  lastIds: Map<string, number>;
  /** Seats that made at least one decision themselves. */
  active: Set<string>;
  /** Forfeit records, in order. */
  forfeits: Raw[];
  lastT: number;
}

const GAME_TYPES = new Set([
  'game_start', 'game_over', 'game_failed', 'turn_snapshot', 'decision_offered', 'agent_decision', 'decision_withdrawn', 'auto_pass', 'auto_pay',
  'forced', 'pay_tap', 'pay_color', 'pay_finish', 'pay_error', 'card_played', 'unimplemented_effect', 'resend', 'phase_error', 'game_setup_retry', 'game_reconnect', 'game_reconnect_retry',
]);

export function resumeLog(records: Raw[]): ResumeLog {
  const r: ResumeLog = {
    records, started: false, ended: false, aborted: false, draftEnded: false, buildEnded: false,
    draft: { packs: new Map(), picks: new Map() }, decks: new Map(), games: new Map(), matchEnds: new Map(), playDraw: new Map(), sideboards: new Map(), seatsDone: new Set(),
    lastIds: new Map(), active: new Set(), forfeits: [], lastT: 0,
  };
  const draftOffers = new Map<string, number>();
  const bumpId = (seat: unknown, id: unknown) => {
    const m = /^[A-Z](\d+)$/.exec(String(id ?? ''));
    if (seat && m) r.lastIds.set(String(seat), Math.max(r.lastIds.get(String(seat)) ?? 0, Number(m[1])));
  };
  for (const e of records) {
    r.lastT = Math.max(r.lastT, Number(e.t) || 0);
    switch (e.type) {
      case 'event_start': r.started = true; break;
      case 'event_end': r.ended = true; break;
      case 'event_abort': case 'event_error': r.aborted = true; break;
      case 'packs_opened': r.draft.packs.set(Number(e.round), { packs: e.packs, swaps: e.swaps ?? [] }); break;
      case 'draft_pick':
        r.draft.picks.set(`${e.seat}|${e.pack_number}|${e.pick_number}`, { pick: e.pick, by: e.by });
        if (e.by === 'agent' || e.by === 'forfeit') draftOffers.set(e.seat, (draftOffers.get(e.seat) ?? 0) + 1);
        if (e.by === 'agent') r.active.add(e.seat);
        break;
      case 'draft_end': r.draftEnded = true; break;
      case 'build_offered': bumpId(e.seat, e.id); break;
      case 'deck_built':
        r.decks.set(e.seat, e);
        if (e.by === 'agent' || (e.by === 'auto' && !e.forfeit)) r.active.add(e.seat);
        break;
      case 'build_end': r.buildEnded = true; break;
      case 'match_end': r.matchEnds.set(`${e.a} vs ${e.b}`, e); break;
      case 'play_draw':
        r.playDraw.set(`${e.match}|${e.game_number}`, e);
        if (e.by === 'agent' && e.chooser) r.active.add(e.chooser);
        break;
      case 'sideboarded':
        r.sideboards.set(`${e.match}|${e.game_number}|${e.seat}`, e);
        if (e.by === 'agent') r.active.add(e.seat);
        break;
      case 'sideboard_offered': case 'play_draw_offered': bumpId(e.seat, e.id); break;
      case 'seat_done': r.seatsDone.add(String(e.seat)); break;
      case 'forfeit': r.forfeits.push(e); bumpId(e.seat, e.decision); break;
    }
    if (e.type === 'decision_offered' || e.type === 'agent_decision') bumpId(e.seat, e.id);
    if (e.type === 'agent_decision') r.active.add(e.seat);
    if (GAME_TYPES.has(e.type) && typeof e.game === 'string') {
      let g = r.games.get(e.game);
      if (!g) r.games.set(e.game, (g = { label: e.game, voids: 0, records: [] }));
      if (e.type === 'game_failed' && e.void) {
        // A void ends this attempt: the replay starts from scratch under the same label.
        g.voids++;
        g.start = undefined;
        g.over = undefined;
        g.failed = e;
        g.records = [];
        continue;
      }
      if (e.type === 'game_start') {
        g.start = e;
        g.failed = undefined;
      } else if (e.type === 'game_over') g.over = e;
      else if (e.type === 'game_failed') g.failed = e;
      g.records.push(e);
    }
  }
  // Draft offers aren't logged with their ids: every agent pick (and the one that was open) used one.
  for (const [seat, n] of draftOffers) r.lastIds.set(seat, Math.max(r.lastIds.get(seat) ?? 0, n + 1));
  return r;
}

/** Counters, cards played and engine flags of a game's latest attempt, for its game_over record. */
export function gameResume(g: LoggedGame, session: GameSession & { on_play?: string }, forfeits: Raw[]): GameResume {
  const counters: Record<string, Counters> = {};
  const c = (seat: string) => (counters[seat] ??= {});
  const inc = (seat: unknown, k: keyof Counters) => {
    if (typeof seat !== 'string') return;
    const x = c(seat);
    x[k] = (x[k] ?? 0) + 1;
  };
  const played: GameResume['played'] = {};
  const unimplemented: GameResume['unimplemented'] = [];
  let lastSnapshotTurn = 0;
  let onPlay = session.on_play;
  for (const e of g.records) {
    switch (e.type) {
      case 'decision_offered':
        inc(e.seat, 'decisions');
        if (!onPlay && e.turn === 1 && typeof e.active === 'string') {
          const seats = (g.start?.seats as string[]) ?? [];
          onPlay = e.active === 'you' ? e.seat : seats.find((s) => s !== e.seat);
        }
        break;
      case 'auto_pass': inc(e.seat, 'autoPasses'); break;
      case 'forced': case 'auto_pay': inc(e.seat, 'forced'); break;
      case 'pay_error': inc(e.seat, 'payFailures'); break;
      case 'pay_tap': if (e.ok === false) inc(e.seat, 'payFailures'); break;
      case 'pay_color': if (e.ok === false) inc(e.seat, 'payFailures'); break;
      // The pool already paid the cost: the agent's own payment when it tapped its sources as options (by_hand).
      case 'pay_finish': if (e.by_hand === true) inc(e.seat, 'manualPayments'); break;
      case 'agent_decision': {
        const choice = String(e.choice ?? '');
        if (e.accepted === false) inc(e.seat, 'rejections');
        if (choice.startsWith('Tap ') || choice.includes(' (tapping ')) inc(e.seat, 'manualPayments');
        // Only the auto-tapper option itself (a mana ability or Cancel picked in a payment is not the auto-tapper).
        else if (e.kind === 'ManaPayment' && e.accepted !== false && choice.startsWith('Let the auto-tapper')) inc(e.seat, 'autoTapper');
        if (e.accepted !== false && (e.payment === 'auto' || e.payment === 'manual+auto')) inc(e.seat, 'autoPaid');
        if (e.kind === 'MulliganDecision' && e.accepted !== false && /^mulligan/i.test(choice)) inc(e.seat, 'mulligans');
        break;
      }
      case 'card_played': {
        const rec = (played[e.seat] ??= { cast: {}, activated: {} });
        const bucket = e.how === 'cast' ? rec.cast : rec.activated;
        bucket[e.card] = (bucket[e.card] ?? 0) + 1;
        break;
      }
      case 'unimplemented_effect':
        unimplemented.push({ key: e.source === 'mechanics' ? `${e.card}|mechanics` : String(e.oracle_id ?? e.card), card: e.card, seat: e.seat ?? null });
        break;
      case 'turn_snapshot': lastSnapshotTurn = Math.max(lastSnapshotTurn, Number(e.turn) || 0); break;
    }
  }
  const forfeitedBy = forfeits.find((f) => f.stage === 'game' && f.game === g.label)?.seat;
  return { session, onPlay, forfeitedBy, lastSnapshotTurn, counters, played, unimplemented };
}

/** A deck submitted before the restart, as the games need it. */
export function deckFromLog(rec: Raw, pool: PackCard[]): BuiltDeck {
  const main: string[] = rec.main ?? [];
  const basics: Record<string, number> = {};
  const left = [...pool];
  const mainCards: PackCard[] = [];
  for (const name of main) {
    const i = left.findIndex((c) => c.name === name);
    if (i >= 0) mainCards.push(left.splice(i, 1)[0]!);
    else basics[name] = (basics[name] ?? 0) + 1;
  }
  return { deck: { main_deck: main, sideboard: rec.sideboard ?? [] }, mainCards, basics, by: rec.by === 'agent' ? 'agent' : 'auto' };
}
