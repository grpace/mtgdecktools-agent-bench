/**
 * What the CLI accepts from a Director (docs/SECURITY.md, "The bench CLI and a Director it doesn't trust").
 *
 * A Director is a remote server, and with `--director` it can be anyone's. So nothing it sends chooses a local path,
 * a program, a model or an effort level:
 *   - event ids and seat names are checked against strict patterns before they name a file, and every path built
 *     from them is resolved and must stay inside its folder (`under`);
 *   - seat URLs must be `<the Director's own base>/mcp/<token>`;
 *   - the harness, model and effort a seat is started with come from this machine (the confirmed plan, or the
 *     `--seat` flags a lobby ticket was joined with). The Director only says which of those seats sat down, and a
 *     table whose seats don't match them is refused (`assignSeats`).
 */
import { resolve, sep } from 'node:path';
import { EVENT_ID_RE } from '../../packages/director/src/submissions.js';
import { registry } from '../../packages/registry/src/index.js';

/** Seat names: the same rule `bench new` applies to names people type, and harness-logs to its file names. */
export const SEAT_NAME_RE = /^[\w.-]{1,40}$/;

export class UntrustedValue extends Error {}

const show = (v: unknown) => JSON.stringify(String(v)).slice(0, 60);

export function eventIdFrom(v: unknown): string {
  if (typeof v !== 'string' || !EVENT_ID_RE.test(v)) throw new UntrustedValue(`the Director sent an event id that isn't one: ${show(v)}`);
  return v;
}

export function seatNameFrom(v: unknown): string {
  if (typeof v !== 'string' || !SEAT_NAME_RE.test(v) || /^\.+$/.test(v)) throw new UntrustedValue(`the Director sent a seat name that isn't one: ${show(v)}`);
  return v;
}

/**
 * A seat URL must be on the Director it came from: `<base>/mcp/<token>`, plain characters only. Your own Director on
 * this machine may publish its seats under another address (PUBLIC_URL, for agents elsewhere): any plain
 * `http(s)://<host>/…/mcp/<token>` is accepted from a loopback base.
 */
export function seatUrlFrom(v: unknown, base: string): string {
  const b = base.replace(/\/+$/, '');
  const plain = typeof v === 'string' && v.length <= 300 && /^[\w./:[\]-]+$/.test(v);
  const onBase = plain && v.startsWith(`${b}/mcp/`) && /^[\w-]{8,128}$/.test(v.slice(b.length + 5));
  const ownMachine = plain && /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(b) && /^https?:\/\/[\w.:[\]-]+(\/[\w.-]+)*\/mcp\/[\w-]{8,128}$/.test(v);
  if (!onBase && !ownMachine) throw new UntrustedValue(`the Director sent a seat URL that isn't on ${b}: ${show(v)}`);
  return v as string;
}

/** `root/...parts`, resolved; refuses anything that would land outside `root`. */
export function under(root: string, ...parts: string[]): string {
  const r = resolve(root);
  const p = resolve(r, ...parts);
  if (p !== r && !p.startsWith(r + sep)) throw new UntrustedValue(`refusing a path outside ${r}: ${parts.join('/')}`);
  return p;
}

/** Server text for a terminal or an agent: no control characters (terminal escapes), at most `max` characters. */
export const printable = (v: unknown, max = 200) => String(v ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ').slice(0, max);

/**
 * The seats of an event the Director created for this machine: exactly the names asked for, each with a URL on that
 * Director. Throws on anything else.
 */
export function checkCreatedSeats(seats: unknown, base: string, names: string[]): Record<string, string> {
  if (!seats || typeof seats !== 'object' || Array.isArray(seats)) throw new UntrustedValue('the Director sent no seats');
  const got = Object.keys(seats).sort();
  const want = [...names].sort();
  if (got.length !== want.length || got.some((n, i) => n !== want[i])) {
    throw new UntrustedValue(`the Director answered with other seats than the ones asked for (${got.slice(0, 8).map((n) => show(n)).join(', ')})`);
  }
  return Object.fromEntries(got.map((n) => [seatNameFrom(n), seatUrlFrom((seats as Record<string, unknown>)[n], base)]));
}

// ---------------------------------------------------------------------------
// Lobby tables: which of the seats this machine declared sat down

export interface LocalSeat {
  harness: string;
  model?: string;
  effort?: string;
  /** The context policy this machine starts the seat with (rotation.ts); none: one harness session. */
  context_policy?: 'fresh-per-game' | 'fresh-per-match';
  /** A hosted variant's own name (OpenCode Zen `opencode/<id>-free`), which `play` launches as typed. */
  launch_model?: string;
}

/** A seat's context policy for comparing (none and "harness" alike; anything unknown never matches). */
const policyKey = (v: unknown): string => (v == null || v === 'harness' ? '' : v === 'fresh-per-game' || v === 'fresh-per-match' ? v : '?');

/** Canonical "harness/model/effort" for comparing a declared seat with the Director's account of it. */
function key(s: { harness?: unknown; model?: unknown; effort?: unknown }): string | undefined {
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 120) : undefined);
  const h = registry.resolveHarness(str(s.harness) ?? '');
  if (!h.ok) return undefined;
  const m = str(s.model) ? registry.resolveModel(str(s.model)!, h.id) : undefined;
  const model = m ? (m.ok ? m.id : str(s.model)!.toLowerCase()) : '';
  const e = str(s.effort) ? registry.normalizeEffort(str(s.effort)!) : undefined;
  const effort = e ? (e.ok ? e.effort : str(s.effort)!.toLowerCase()) : '';
  return `${h.id}/${model}/${effort}`;
}

export type Assignment = { ok: true; seats: Array<{ name: string; url: string; local: LocalSeat; index: number }> } | { ok: false; error: string };

/**
 * A fired lobby table, as the Director describes it (seat name → URL, harness, model, effort), against the seats this
 * machine joined with. Every seat must be one of ours, each of ours used at most once (`used` carries over between the
 * tables of one ticket). What starts is our own declaration, never the Director's.
 */
export function assignSeats(tableSeats: unknown, base: string, declared: LocalSeat[], used: Set<number> = new Set()): Assignment {
  if (!tableSeats || typeof tableSeats !== 'object' || Array.isArray(tableSeats)) return { ok: false, error: 'the Director sent no seats for this table' };
  const entries = Object.entries(tableSeats as Record<string, any>);
  if (!entries.length) return { ok: false, error: 'the Director sent no seats for this table' };
  const taken = new Set(used);
  const out: Array<{ name: string; url: string; local: LocalSeat; index: number }> = [];
  try {
    for (const [rawName, s] of entries) {
      const name = seatNameFrom(rawName);
      const url = seatUrlFrom(s?.url, base);
      const k = key(s ?? {});
      // The context policy the event records for the seat must be the one this machine starts it with (a Director
      // that doesn't report one recorded none).
      const p = policyKey(s?.context_policy);
      const i = declared.findIndex((d, j) => !taken.has(j) && k !== undefined && key(d) === k && policyKey(d.context_policy) === p);
      if (i < 0) {
        const pol = (v: unknown) => (policyKey(v) ? ` (${printable(String(v), 40)})` : '');
        return { ok: false, error: `the Director seated ${printable(name, 40)} as ${printable(`${s?.harness}/${s?.model}/${s?.effort}`, 120)}${pol(s?.context_policy)}, which isn't one of the seats you joined with (${declared.map((d) => [d.harness, d.model, d.effort].filter(Boolean).join('/') + pol(d.context_policy)).join(', ')})` };
      }
      taken.add(i);
      out.push({ name, url, local: declared[i]!, index: i });
    }
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  for (const s of out) used.add(s.index);
  return { ok: true, seats: out };
}
