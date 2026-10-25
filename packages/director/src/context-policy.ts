/**
 * A seat's context policy: how its launcher manages the harness's conversation (docs/PROTOCOL.md §6, METHODOLOGY open
 * questions). Declared per seat when the event is created and logged in `event_start.seats[].context_policy`; absent
 * means the harness keeps one conversation for as long as it runs (its own compaction, if any).
 *   fresh-per-game    the launcher ends the session when the deck is locked and after every game, and starts a fresh one
 *   fresh-per-match   the same after the deck is locked and after every match
 * A fresh session gets the resume briefing; every decision carries the board, card text, decklist and match so far.
 */
export const CONTEXT_POLICIES = ['fresh-per-match', 'fresh-per-game'] as const;
export type ContextPolicy = (typeof CONTEXT_POLICIES)[number];

export const isContextPolicy = (v: unknown): v is ContextPolicy => typeof v === 'string' && (CONTEXT_POLICIES as readonly string[]).includes(v);

/** The value that means "no policy": the harness keeps one conversation (also what an absent field means). */
export const NO_CONTEXT_POLICY = 'harness';

/**
 * A declared policy from a request (event creation, lobby join): `policy` undefined for none (absent, null or
 * "harness"), or an error for anything else. Only these values are ever stored or logged.
 */
export function parseContextPolicy(v: unknown): { policy?: ContextPolicy } | { error: string } {
  if (v == null || v === NO_CONTEXT_POLICY) return {};
  if (isContextPolicy(v)) return { policy: v };
  return { error: `context_policy must be ${CONTEXT_POLICIES.join(' or ')} (or "${NO_CONTEXT_POLICY}", or left out)` };
}
