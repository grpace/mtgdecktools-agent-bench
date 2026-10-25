/**
 * Seat session rotation (`bench play --fresh-session per-game|per-match`): end a seat's harness session at a game or
 * match boundary and start a fresh one, which gets the resume briefing (docs/PROTOCOL.md §6). Every game decision
 * already carries the board, card text, decklist and the match so far, so a seat doesn't need its old conversation to
 * play; a fresh one keeps each request small (a harness re-sends its whole conversation on every call).
 *
 * The boundary signal is the seat's own progress (GET <seat url>/progress: deck locked, games and matches finished,
 * whether a decide call is in progress). It is not an MCP tool and doesn't count as activity for the inactivity
 * watchdog. A session is ended only between decide calls: an answer being applied is never cut off, and decision ids
 * are stable, so the fresh session gets the open decision in full again and an answer to an old id is refused.
 */
import { CONTEXT_POLICIES, type ContextPolicy, isContextPolicy } from '../../packages/director/src/context-policy.js';
import type { SeatProgress } from '../../packages/director/src/seat.js';

/** What endSession needs of a child process. */
export interface Killable { kill(signal?: NodeJS.Signals | number): boolean; exitCode: number | null; signalCode: NodeJS.Signals | null }

/** How long a session gets after SIGINT before SIGTERM, and after SIGTERM before SIGKILL. */
export const END_GRACE_MS = 10_000;
export const END_KILL_MS = 15_000;

/**
 * End a harness session so that it still writes its final usage: SIGINT first (Claude Code then writes its result
 * line, with the session's cost and token totals, and exits at once: checked with 2.1.306), SIGTERM if it is still
 * running after `graceMs`, SIGKILL after `killMs` more. A rotated session that is killed outright writes no result
 * line, and its cost has to be estimated from per-request usage. Returns a function that cancels the escalation
 * (call it when the process exits).
 */
export function endSession(child: Killable, o: { graceMs?: number; killMs?: number } = {}): () => void {
  const alive = () => child.exitCode == null && child.signalCode == null;
  const timers: Array<ReturnType<typeof setTimeout>> = [];
  child.kill('SIGINT');
  timers.push(setTimeout(() => {
    if (!alive()) return;
    child.kill('SIGTERM');
    timers.push(setTimeout(() => alive() && child.kill('SIGKILL'), o.killMs ?? END_KILL_MS));
  }, o.graceMs ?? END_GRACE_MS));
  return () => timers.forEach(clearTimeout);
}

export type FreshSession = 'off' | 'per-match' | 'per-game';
export const FRESH_SESSION_MODES: readonly FreshSession[] = ['off', 'per-match', 'per-game'];
export { CONTEXT_POLICIES, type ContextPolicy, isContextPolicy };

/**
 * The mode seats `bench new` / `bench setup` launch get unless told otherwise (owner, 2026-10-22): a fresh session per
 * game cut a Claude Haiku 5.5 seat's cost for the draft and 4 games from $5.05 to $1.11 (with the Set Context re-read
 * each game and match memory), with no sign of worse play (docs/HARNESSES.md, "Expected usage"). `bench lobby join` gives its seats the same
 * default (lobby.ts lobbySeatPolicy). Seats seated by hand record no policy (`harness`).
 */
export const DEFAULT_FRESH_SESSION: FreshSession = 'per-game';

export const isFreshSession = (v: unknown): v is FreshSession => typeof v === 'string' && (FRESH_SESSION_MODES as readonly string[]).includes(v);

/** The `--fresh-session` mode as the policy logged in event_start (none for off). */
export const policyOfMode = (m: FreshSession): ContextPolicy | undefined => (m === 'per-game' ? 'fresh-per-game' : m === 'per-match' ? 'fresh-per-match' : undefined);
export const modeOfPolicy = (p: unknown): FreshSession => (p === 'fresh-per-game' ? 'per-game' : p === 'fresh-per-match' ? 'per-match' : 'off');

/**
 * The mode `bench play` runs a seat with: the declared policy (event_start / event.json), which `--fresh-session` may
 * repeat but not change, since the export labels the seat with the declared one. Returns an error message, or the mode.
 */
export function seatMode(declared: unknown, flag: string | undefined): { mode: FreshSession } | { error: string } {
  if (flag != null && !isFreshSession(flag)) return { error: `--fresh-session: ${FRESH_SESSION_MODES.join(', ')}` };
  const was = modeOfPolicy(declared);
  if (flag == null || flag === was) return { mode: was };
  return {
    error: was === 'off'
      ? `it was created without a context policy, so it can't be started with --fresh-session ${flag} (its results would be labeled as one harness conversation). Create the event with \`--fresh-session ${flag}\`, or play it with --fresh-session off`
      : `it was created with context policy ${String(declared)}; play it with --fresh-session ${was} (or leave the flag out)`,
  };
}

/** The boundary a session belongs to: the deck lock, then each game (per-game) or match (per-match). */
export function boundaryKey(p: SeatProgress, mode: FreshSession): string | null {
  if (mode === 'off') return null;
  return `${p.deck_locked ? 1 : 0}/${mode === 'per-game' ? p.games_finished : p.matches_finished}`;
}

/**
 * What to do with a running session that started at `startKey`, given the seat's progress now: keep it (no boundary
 * crossed, or the seat is done), hold (a boundary was crossed but a decide call is in progress), or rotate.
 */
export function rotationStep(startKey: string | null, p: SeatProgress, mode: FreshSession): 'stay' | 'hold' | 'rotate' {
  if (mode === 'off' || startKey == null || p.done) return 'stay';
  if (boundaryKey(p, mode) === startKey) return 'stay';
  return p.deciding ? 'hold' : 'rotate';
}

/** The progress URL of a seat URL (…/mcp/<token> → …/mcp/<token>/progress). */
export function progressUrl(seatUrl: string): string {
  return `${seatUrl.replace(/\/+$/, '')}/progress`;
}

const isProgress = (x: any): x is SeatProgress =>
  !!x && typeof x === 'object' && typeof x.deck_locked === 'boolean' && Number.isInteger(x.games_finished) && Number.isInteger(x.matches_finished)
  && typeof x.done === 'boolean' && typeof x.deciding === 'boolean';

export type ProgressFetch = (url: string) => Promise<SeatProgress | 'unsupported' | null>;

/** GET the seat's progress: the progress, 'unsupported' (a Director without the endpoint), or null (not reachable now). */
export const fetchProgress: ProgressFetch = async (url) => {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (res.status === 404 || res.status === 405) return 'unsupported';
    if (!res.ok) return null;
    const body = await res.json();
    return isProgress(body) ? body : 'unsupported';
  } catch {
    return null;
  }
};

export interface RotationOptions {
  url: string;
  mode: FreshSession;
  /** Ends the running session (bench play: endSession, SIGINT then SIGTERM then SIGKILL). Called at most once. */
  end: (p: SeatProgress) => void;
  /** The boundary the session started at (from `startKey`). */
  startKey: string | null;
  pollMs?: number;
  fetch?: ProgressFetch;
}

/** The current boundary key of a seat, or null when its Director doesn't report progress (rotation is then off). */
export async function startKey(url: string, mode: FreshSession, get: ProgressFetch = fetchProgress): Promise<string | null | 'unsupported'> {
  if (mode === 'off') return null;
  for (let i = 0; i < 3; i++) {
    const p = await get(url);
    if (p === 'unsupported') return 'unsupported';
    if (p) return boundaryKey(p, mode);
    await new Promise((r) => setTimeout(r, 1000));
  }
  return null;
}

/**
 * Watches one harness session: polls the seat's progress and ends the session once, when the seat has crossed a
 * boundary since the session started and no decide call is in progress. `stop()` when the session exits.
 */
export class SessionRotation {
  rotated = false;
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;

  constructor(private o: RotationOptions) {}

  start(): this {
    if (this.o.mode !== 'off' && this.o.startKey != null) this.schedule();
    return this;
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  /** One poll (exported for tests): returns what it did. */
  async poll(): Promise<'stay' | 'hold' | 'rotate' | 'unknown'> {
    const p = await (this.o.fetch ?? fetchProgress)(this.o.url);
    if (this.stopped || this.rotated) return 'stay';
    if (!p || p === 'unsupported') return 'unknown';
    const step = rotationStep(this.o.startKey, p, this.o.mode);
    if (step === 'rotate') {
      this.rotated = true;
      this.stop();
      this.o.end(p);
    }
    return step;
  }

  private schedule(delay = this.o.pollMs ?? 3_000): void {
    if (this.stopped) return;
    this.timer = setTimeout(async () => {
      const step = await this.poll();
      // A decide call in progress takes a few seconds at most: look again soon.
      if (!this.rotated) this.schedule(step === 'hold' ? Math.min(500, this.o.pollMs ?? 3_000) : undefined);
    }, delay);
    this.timer.unref?.();
  }
}
