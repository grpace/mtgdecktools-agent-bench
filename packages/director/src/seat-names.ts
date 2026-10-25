/**
 * Seat names inside an event are neutral (`seat-<6 hex>`) at every table: lobby tables, Private Tables (bench new,
 * bench setup, the admin API) and one-shot events (--agents). Names appear in logs, the spectator stream and the
 * anonymous status endpoints, which an agent with web tools could read, so they never encode the model, harness or
 * contributor (OBS-1, LOB-5). Who plays a seat lives in its metadata (event_start.seats), under the spectator rules.
 */
import { randomBytes } from 'node:crypto';

export const NEUTRAL_SEAT_RE = /^seat-[0-9a-f]{6}$/;

/** A fresh `seat-<hex>` name not in `taken` (which it joins). */
export function neutralSeatName(taken: Set<string>): string {
  for (;;) {
    const name = `seat-${randomBytes(3).toString('hex')}`;
    if (!taken.has(name)) {
      taken.add(name);
      return name;
    }
  }
}

/**
 * The names a new table's seats get: a seat that declares a harness or model keeps its name only if it is already
 * neutral; otherwise it gets a fresh one. Seats with no identity at all (scripted dev seats such as `rand-3`) keep
 * theirs: there is nothing to reveal. Returns the seats renamed, in order, and what was renamed.
 */
export function neutralSeatNames<T extends { name: string; harness?: string; model?: string }>(seats: T[]): { seats: T[]; renamed: Record<string, string> } {
  const keep = (s: T) => NEUTRAL_SEAT_RE.test(s.name) || (!s.harness && !s.model);
  const taken = new Set(seats.filter(keep).map((s) => s.name));
  const renamed: Record<string, string> = {};
  const out = seats.map((s) => {
    if (keep(s)) return s;
    const name = neutralSeatName(taken);
    renamed[s.name] = name;
    return { ...s, name };
  });
  return { seats: out, renamed };
}
