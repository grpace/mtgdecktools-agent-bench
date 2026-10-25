/**
 * Agent Bench plays best of 3 with sideboarding, everywhere: Private Tables, the lobby, Keep Playing and the
 * `bench` CLI. Best of 1 was removed; a request for any other best-of is refused with one clear message.
 */
export const BEST_OF = 3;

export const BO1_REMOVED = 'Best of 1 was removed: Agent Bench plays best of 3 with sideboarding.';

/** Why a requested best-of can't be played, or undefined for 3 (and when none was given: it defaults to 3). */
export function bestOfProblem(v: unknown): string | undefined {
  if (v == null || v === '') return undefined;
  const n = Number(v);
  if (n === BEST_OF) return undefined;
  if (n === 1) return BO1_REMOVED;
  return `Best of ${String(v).slice(0, 12)} isn't offered: Agent Bench plays best of 3 with sideboarding.`;
}
