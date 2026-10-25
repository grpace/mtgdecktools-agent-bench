import { EventEmitter } from 'node:events';
import { appendFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const WIRE_LOG = process.env.MTGDT_WIRE_LOG;
const MIN_SEND_GAP_MS = 60;
const ACTION_TIMEOUT_MS = 4_000;

/**
 * phase-server protocol version we speak. phase-server requires an exact match, so this comes from
 * the pin in engine/phase.lock.json (updated by scripts/upgrade-phase.sh), not from code.
 * PHASE_PROTOCOL_VERSION overrides it (used when smoke-testing a candidate upgrade).
 */
export const PROTOCOL_VERSION: number = Number(process.env.PHASE_PROTOCOL_VERSION) || JSON.parse(
  readFileSync(process.env.PHASE_LOCK ?? fileURLToPath(new URL('../../../engine/phase.lock.json', import.meta.url)), 'utf8'),
).protocol_version;

export const LIMITED_FORMAT = {
  format: 'Limited', starting_life: 20, min_players: 2, max_players: 2,
  deck_size: { type: 'Minimum', data: 40 }, singleton: false, command_zone: false,
  commander_damage_threshold: null, range_of_influence: null, team_based: false,
  uses_commander: false, supplies_fixed_deck: false, sideboard_policy: { type: 'Unlimited' },
  default_deck_copy_limit: { type: 'Unlimited' }, allow_debug_actions: false,
};

export interface DeckData {
  main_deck: string[];
  sideboard: string[];
}

export interface PhaseUpdate {
  revision: number;
  state: any;
  legal: any[];
  autoPassRecommended: boolean;
  events: any[];
  logEntries: any[];
  /** Per-object actions, including mana abilities (absent from `legal`). Values normalized to arrays. */
  byObject: Record<string, any[]>;
}

/** phase-server's identity for one lifetime of a game session (sent back verbatim with Reconnect). */
export interface FullSessionKey {
  game_code: string;
  generation: number;
}

export type ActionResult = { ok: true } | { ok: false; reason: string };

/** phase-ai difficulty levels accepted by phase-server (`AiDifficulty`, crates/phase-ai/src/config.rs). */
export type AiDifficulty = 'VeryEasy' | 'Easy' | 'Medium' | 'Hard' | 'VeryHard';

/**
 * An AI opponent seat for CreateGameWithSettings (`AiSeatRequest`, server-core protocol.rs; camelCase on
 * the wire). phase-server only accepts AI at seats 1..player_count-1: seat 0 is always the host.
 */
export interface AiSeatRequest {
  seatIndex: number;
  difficulty: AiDifficulty;
  deckName: null;
  deck: { type: 'DeckList'; data: DeckData };
}

/** phase-server answered a Reconnect with an Error (the game or the seat's session is gone), as opposed to not answering. */
export class ReconnectRefused extends Error {}

/**
 * One seat's WebSocket connection to phase-server. Each seat must have its own socket:
 * the server derives the acting player from the socket's session, never from the payload.
 *
 * Events: 'update' (PhaseUpdate), 'closed' (code).
 */
export class PhaseSeat extends EventEmitter {
  gameCode?: string;
  player?: number;
  revision = -1;
  /** This seat's reconnect credentials (GameCreated for the host, GameStarted / SessionAttached for the joiner). */
  playerToken?: string;
  fullKey?: FullSessionKey;
  private ws?: WebSocket;
  private pendingAction?: (r: ActionResult) => void;
  private created?: (code: string) => void;
  private createFailed?: (err: Error) => void;
  private reconnectFailed?: (err: Error) => void;
  private started = false;
  private startedWaiters: Array<() => void> = [];
  private lastSendAt = 0;

  /** `actionTimeoutMs`: how long act() waits for an answer (bot duels wait longer: phase-ai moves before we hear back). */
  constructor(private url: string, readonly displayName: string, private actionTimeoutMs = ACTION_TIMEOUT_MS) {
    super();
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url, { maxPayload: 64 * 1024 * 1024 });
      this.ws = ws;
      ws.on('error', reject);
      ws.on('close', (code) => this.emit('closed', code));
      ws.on('message', (raw) => {
        const msg = JSON.parse(String(raw));
        if (WIRE_LOG) {
          const d = msg.data ?? {};
          appendFileSync(WIRE_LOG, `${Date.now()} ${this.displayName} <- ${msg.type} rev=${d.state_revision ?? ''} wf=${d.state?.waiting_for?.type ?? ''} prio=${d.state?.priority_player ?? ''} legal=${(d.legal_actions ?? []).map((a: any) => a.type).join(',')} ${msg.type.includes('Reject') || msg.type.includes('Fail') || msg.type === 'Error' ? JSON.stringify(d) : ''}\n`);
        }
        if (msg.type === 'ServerHello') {
          if (msg.data.protocol_version !== PROTOCOL_VERSION) {
            reject(new Error(`phase-server speaks protocol ${msg.data.protocol_version} (build ${msg.data.build_commit}), but engine/phase.lock.json pins ${PROTOCOL_VERSION}. Run scripts/upgrade-phase.sh to move to the new build.`));
            return;
          }
          this.send('ClientHello', { client_version: 'mtgdt-director/0.1', build_commit: '', protocol_version: PROTOCOL_VERSION });
          resolve();
          return;
        }
        this.onMessage(msg);
      });
    });
  }

  /** Host a Bo1 limited game. With `aiSeats`, phase-server fills those seats with phase-ai and starts at once. */
  createGame(deck: DeckData, aiSeats: AiSeatRequest[] = []): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => fail(new Error('timed out waiting for GameCreated')), 15_000);
      const fail = (err: Error) => {
        clearTimeout(timer);
        this.created = undefined;
        this.createFailed = undefined;
        reject(err);
      };
      this.created = (code) => {
        clearTimeout(timer);
        this.createFailed = undefined;
        resolve(code);
      };
      this.createFailed = fail;
      this.send('CreateGameWithSettings', {
        deck, display_name: this.displayName, public: false, password: null, timer_seconds: null,
        player_count: 2, match_config: { match_type: 'Bo1' }, ai_seats: aiSeats, format_config: LIMITED_FORMAT,
        start_when_full: true, ranked: false,
      });
    });
  }

  /** Concede the current game (used to abandon stuck bot games). */
  concede(): void {
    this.send('Concede');
  }

  /**
   * Re-attach this (freshly connected) socket to a game it played before: after a Director restart, or when
   * the socket dropped. phase-server keeps a disconnected seat for its reconnect grace (120 s), also across its
   * own restarts (games are persisted), then forfeits the game. Resolves on GameStarted (the full current
   * state, which then reaches 'update' listeners like any update); rejects on an Error or after timeoutMs.
   */
  reconnect(code: string, playerToken: string, fullKey: FullSessionKey, timeoutMs = 15_000): Promise<void> {
    this.gameCode = code;
    this.playerToken = playerToken;
    this.fullKey = fullKey;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => fail(new Error('timed out waiting for GameStarted after Reconnect')), timeoutMs);
      const fail = (err: Error) => {
        clearTimeout(timer);
        this.reconnectFailed = undefined;
        reject(err);
      };
      this.reconnectFailed = fail;
      this.startedWaiters.push(() => {
        clearTimeout(timer);
        this.reconnectFailed = undefined;
        resolve();
      });
      this.send('Reconnect', { game_code: code, player_token: playerToken, full_key: fullKey });
    });
  }

  joinGame(code: string, deck: DeckData): void {
    this.gameCode = code;
    this.send('JoinGameWithPassword', { game_code: code, deck, display_name: this.displayName, password: null });
  }

  /**
   * Send a GameAction. Resolves when the server answers with a new state or a rejection.
   * phase-server allows 30 frames/s per socket and silently drops the excess, so actions are
   * spaced out, and an action with no answer is reported as a timeout for the caller to retry.
   */
  async act(action: unknown): Promise<ActionResult> {
    this.pendingAction?.({ ok: false, reason: 'superseded by a newer action' });
    const wait = this.lastSendAt + MIN_SEND_GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.pendingAction === done) this.pendingAction = undefined;
        resolve({ ok: false, reason: 'timeout' });
      }, this.actionTimeoutMs);
      const done = (r: ActionResult) => {
        clearTimeout(timer);
        resolve(r);
      };
      this.pendingAction = done;
      this.lastSendAt = Date.now();
      this.send('Action', { action });
    });
  }

  /** Resolves once this seat's game has started (both seats joined), or rejects after timeoutMs. */
  waitStarted(timeoutMs: number): Promise<void> {
    if (this.started) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for GameStarted')), timeoutMs);
      this.startedWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  close(): void {
    this.ws?.close();
  }

  private settleAction(r: ActionResult): void {
    const p = this.pendingAction;
    this.pendingAction = undefined;
    p?.(r);
  }

  private onMessage(msg: any): void {
    const d = msg.data ?? {};
    switch (msg.type) {
      case 'GameCreated':
        this.gameCode = d.game_code;
        if (d.player_token) this.playerToken = d.player_token;
        if (d.full_key) this.fullKey = d.full_key;
        this.created?.(d.game_code);
        break;
      case 'SessionAttached':
        if (d.player_token) this.playerToken = d.player_token;
        if (d.full_key) this.fullKey = d.full_key;
        break;
      case 'GameStarted':
        // Joiners get their reconnect token here (hosts got theirs with GameCreated; reconnects get none).
        if (d.player_token) this.playerToken = d.player_token;
        if (d.full_key) this.fullKey = d.full_key;
        if (!this.started) {
          this.started = true;
          for (const w of this.startedWaiters.splice(0)) w();
        }
        // falls through

      case 'StateUpdate': {
        if (typeof d.your_player === 'number') this.player = d.your_player;
        if (d.state_revision <= this.revision && msg.type === 'StateUpdate') break;
        this.revision = d.state_revision;
        this.settleAction({ ok: true });
        const update: PhaseUpdate = {
          revision: d.state_revision,
          state: d.state,
          legal: d.legal_actions ?? [],
          autoPassRecommended: !!d.auto_pass_recommended,
          events: d.events ?? [],
          logEntries: d.log_entries ?? [],
          byObject: Object.fromEntries(Object.entries(d.legal_actions_by_object ?? {}).map(([k, v]) => [k, Array.isArray(v) ? v : [v]])),
        };
        this.emit('update', update);
        break;
      }
      case 'ActionRejected':
        this.settleAction({ ok: false, reason: `${d.rejection?.code}: ${d.rejection?.message}` });
        break;
      case 'ActionFailed':
        this.settleAction({ ok: false, reason: d.message ?? 'action failed' });
        break;
      case 'ActionNoOp':
        this.settleAction({ ok: false, reason: 'the action had no effect' });
        break;
      case 'RequestRejected':
        this.settleAction({ ok: false, reason: d.reason ?? 'request rejected' });
        break;
      case 'AiDriverFault':
        // phase-ai gave up (e.g. ActionSafetyCapReached); the game will not progress further.
        this.emit('ai-fault', d.fault);
        break;
      case 'Error':
        this.createFailed?.(new Error(d.message ?? 'create failed'));
        this.reconnectFailed?.(new ReconnectRefused(d.message ?? 'reconnect failed'));
        this.emit('error-message', d);
        this.settleAction({ ok: false, reason: d.message ?? 'server error' });
        break;
    }
  }

  private send(type: string, data?: unknown): void {
    if (WIRE_LOG && type === 'Action') appendFileSync(WIRE_LOG, `${Date.now()} ${this.displayName} -> ${JSON.stringify(data)}\n`);
    this.ws?.send(JSON.stringify(data === undefined ? { type } : { type, data }));
  }
}

export function parseDeckList(text: string): DeckData {
  const main: string[] = [];
  for (const line of text.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(.+)$/);
    if (m) for (let i = 0; i < Number(m[1]); i++) main.push(m[2]!);
  }
  return { main_deck: main, sideboard: [] };
}
