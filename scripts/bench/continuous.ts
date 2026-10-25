/**
 * "Keep Playing" (continuous play): the pure parts, unit-tested on their own (test/continuous.test.ts).
 *
 *   parseLimits / limitsText      "5 tables, 8 hours, $50, 200M tokens" ⇄ { tables, hours, usd, tokens }
 *   nextStep                      before each table: go on, or stop (a limit, a stop request) and why
 *   backoffMs                     waits after errors: 1, 2, 4 … 30 minutes; the loop stops after 5 in a row
 *   setFor                        which set table n plays (same set, or a rotation)
 *   lobbyWait / lobbyOverview     honest wait information from GET /api/lobby (never invented numbers)
 */

export interface Limits {
  /** Tables to play, then stop. */
  tables?: number;
  /** Hours since the loop started. */
  hours?: number;
  /** Tokens: input plus output as the harnesses report them (cached re-reads not counted), in tokens. */
  tokens?: number;
  /** Dollars: the harnesses' reported cost where they report one, else the estimate's high end. */
  usd?: number;
}

const NUM = String.raw`(\d+(?:\.\d+)?)`;

/** "5 tables, 8 hours, $50, 200M tokens", "none", or an object (agent mode). Returns an error string when unreadable. */
export function parseLimits(x: unknown): Limits | string {
  if (x == null || x === '') return {};
  if (typeof x === 'object' && !Array.isArray(x)) {
    const o = x as Record<string, unknown>;
    const out: Limits = {};
    for (const k of ['tables', 'hours', 'tokens', 'usd'] as const) {
      if (o[k] == null) continue;
      const v = typeof o[k] === 'string' && k === 'tokens' ? tokenCount(String(o[k])) : Number(o[k]);
      if (v == null || !Number.isFinite(v) || v <= 0) return `limits.${k} must be a positive number`;
      out[k] = k === 'tables' ? Math.floor(v) : v;
    }
    return out;
  }
  if (typeof x !== 'string') return 'limits: give text like "5 tables, 8 hours, $50" or "none"';
  const text = x.trim().toLowerCase();
  if (/^(none|no|no limits?|unlimited|-)$/.test(text)) return {};
  const out: Limits = {};
  for (const part of text.split(/,|;|\band\b|\bor\b/).map((p) => p.trim()).filter(Boolean)) {
    let m: RegExpMatchArray | null;
    if ((m = part.match(new RegExp(`^${NUM}\\s*(tables?|drafts?|events?)$`)))) out.tables = Math.floor(Number(m[1]));
    else if ((m = part.match(new RegExp(`^${NUM}\\s*(h|hrs?|hours?)$`)))) out.hours = Number(m[1]);
    else if ((m = part.match(new RegExp(`^${NUM}\\s*(m|min|mins|minutes?)$`)))) out.hours = Number(m[1]) / 60;
    else if ((m = part.match(new RegExp(`^\\$\\s*${NUM}$`))) || (m = part.match(new RegExp(`^${NUM}\\s*(\\$|usd|dollars?)$`)))) out.usd = Number(m[1]);
    else if ((m = part.match(new RegExp(`^${NUM}\\s*([kmb])?\\s*(tokens?)$`)))) out.tokens = tokenCount(`${m[1]}${m[2] ?? ''}`)!;
    else return `"${part}" isn't a limit: use tables, hours, $ or tokens, e.g. "5 tables, 8 hours, $50, 200M tokens", or "none"`;
  }
  for (const [k, v] of Object.entries(out)) if (!(Number(v) > 0)) return `the ${k} limit must be more than 0`;
  return out;
}

/** "200M", "1.5b", "50000" → tokens. */
export function tokenCount(s: string): number | undefined {
  const m = s.trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*([kmb])?(?:\s*tokens?)?$/);
  if (!m) return undefined;
  return Math.round(Number(m[1]) * ({ k: 1e3, m: 1e6, b: 1e9 } as Record<string, number>)[m[2] ?? ''] || Number(m[1]));
}

export const fmtTok = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1).replace(/\.0$/, '')} B` : n >= 1e7 ? `${Math.round(n / 1e6)} M` : n >= 1e5 ? `${(n / 1e6).toFixed(1).replace(/\.0$/, '')} M` : `${Math.round(n / 1e3)} k`);
const fmtH = (h: number) => (h < 1 ? `${Math.round(h * 60)} min` : `${Number(h.toFixed(1))} h`);
const fmtUsd = (n: number) => `$${n >= 100 ? Math.round(n) : Number(n.toFixed(2))}`;

/** "5 tables or 8 h or $60, whichever comes first"; "" for none. */
export function limitsText(l: Limits): string {
  const parts = [
    l.tables != null ? `${l.tables} table${l.tables === 1 ? '' : 's'}` : '',
    l.hours != null ? fmtH(l.hours) : '',
    l.usd != null ? `${fmtUsd(l.usd)} (estimated where a harness doesn't report its cost)` : '',
    l.tokens != null ? `${fmtTok(l.tokens)} tokens (input and output, cached re-reads not counted)` : '',
  ].filter(Boolean);
  return parts.length > 1 ? `${parts.join(' or ')}, whichever comes first` : parts[0] ?? '';
}

/** Flags for a plan's limits (`--max-tables 5 --max-hours 8 …`). */
export function limitFlags(l: Limits): string[] {
  return [
    ...(l.tables != null ? ['--max-tables', String(l.tables)] : []), ...(l.hours != null ? ['--max-hours', String(l.hours)] : []),
    ...(l.tokens != null ? ['--max-tokens', String(l.tokens)] : []), ...(l.usd != null ? ['--max-usd', String(l.usd)] : []),
  ];
}

// ---------------------------------------------------------------------------
// The loop's decisions

export interface Progress {
  /** Tables finished or stopped (each started table counts once it ends). */
  tables: number;
  startedAt: number;
  /** Input + output tokens so far (reported, else estimated). */
  tokens: number;
  usd: number;
}

export interface PerTable {
  /** Minutes, low and high. */
  minutes: [number, number];
  /** Input + output tokens for all your seats, low and high. */
  tokens: [number, number];
  usd: [number, number];
}

export type Step = { go: true } | { go: false; reason: 'stop_requested' | 'max_tables' | 'max_hours' | 'max_tokens' | 'max_usd'; text: string };

/**
 * Before each table: start it, or stop. A limit stops the loop when it is reached, or when the next table is
 * expected (at the middle of its estimate) to go past it, so the loop doesn't overshoot by a whole table.
 */
export function nextStep(p: Progress, l: Limits, per: PerTable, now: number, stop: 'graceful' | 'now' | null): Step {
  if (stop) return { go: false, reason: 'stop_requested', text: 'you asked it to stop' };
  if (l.tables != null && p.tables >= l.tables) return { go: false, reason: 'max_tables', text: `played ${p.tables} of ${l.tables} tables` };
  const mid = (r: [number, number]) => (r[0] + r[1]) / 2;
  const hours = (now - p.startedAt) / 3600_000;
  if (l.hours != null && (hours >= l.hours || hours + mid(per.minutes) / 60 > l.hours)) {
    return { go: false, reason: 'max_hours', text: `${fmtH(hours)} of ${fmtH(l.hours)} used; another table takes about ${Math.round(mid(per.minutes))} min` };
  }
  if (l.tokens != null && (p.tokens >= l.tokens || p.tokens + mid(per.tokens) > l.tokens)) {
    return { go: false, reason: 'max_tokens', text: `${fmtTok(p.tokens)} of ${fmtTok(l.tokens)} tokens used; another table uses about ${fmtTok(mid(per.tokens))}` };
  }
  if (l.usd != null && (p.usd >= l.usd || p.usd + mid(per.usd) > l.usd)) {
    return { go: false, reason: 'max_usd', text: `${fmtUsd(p.usd)} of ${fmtUsd(l.usd)} used; another table costs about ${fmtUsd(mid(per.usd))}` };
  }
  return { go: true };
}

/** After the n-th error in a row: 1, 2, 4, 8, 16, 30, 30 … minutes. */
export function backoffMs(failures: number): number {
  return Math.min(30, 2 ** Math.max(0, failures - 1)) * 60_000;
}

export const MAX_FAILURES = 5;

/** The set table n (0-based) plays: a rotation goes round in order. */
export function setFor(n: number, set: string, rotation: string[]): string {
  return rotation.length ? rotation[n % rotation.length]! : set;
}

// ---------------------------------------------------------------------------
// Lobby wait information (GET /api/lobby, docs/LOBBY.md §4.1)

export interface LobbyView {
  director?: { paused?: boolean };
  queues?: Array<{ key: string; set: string; seats_filled: number; seats_needed: number; seats_per_table?: number; oldest_wait_s?: number | null; status: string }>;
  scheduled?: Array<{ name: string; queue: string; starts_at: string; state: string }>;
  recent?: Array<{ queue: string | null; kind?: string; fired_at: string }>;
}

const ago = (s: number) => (s < 90 ? `${Math.max(1, Math.round(s))} s` : s < 5400 ? `${Math.round(s / 60)} min` : s < 172_800 ? `${Math.round(s / 3600)} h` : `${Math.round(s / 86_400)} days`);

/** The lobby queue key for these conditions (docs/LOBBY.md §2); every queue plays best of 3, so it has no best-of. */
export const queueKeyOf = (set: string, knowledge: string, mana: string) => `${set.toLowerCase()}-${knowledge.replace('+', '-')}-${mana}`;

/** A queue key in its current form: a Director from before the change still names queues `fra-primer-manual-bo3`. */
export const sameQueueKey = (key: string | null | undefined) => String(key ?? '').toLowerCase().replace(/-bo3$/, '');

/** One or two sentences on how long seats in this queue are likely to wait; only facts from the lobby's own state. */
export function lobbyWait(view: LobbyView | undefined, key: string, mySeats: number, now: number): string {
  if (!view) return "Wait time unknown: the lobby didn't answer just now (`lobby list` shows the queues).";
  if (view.director?.paused) return 'The lobby is paused for a server update; seats keep their place and tables start again after it.';
  key = sameQueueKey(key);
  const q = view.queues?.find((x) => sameQueueKey(x.key) === key);
  const per = q?.seats_per_table ?? 8;
  const set = key.split('-')[0]!.toUpperCase();
  const cadence = (() => {
    const fired = (view.recent ?? []).filter((t) => sameQueueKey(t.queue) === key && t.kind !== 'private').map((t) => Date.parse(t.fired_at)).filter((t) => Number.isFinite(t) && now - t < 7 * 86_400_000);
    if (!fired.length) return '';
    const last = Math.max(...fired);
    return ` ${fired.length} table${fired.length === 1 ? '' : 's'} started from this queue in the last 7 days, the last one ${ago((now - last) / 1000)} ago.`;
  })();
  const sched = (view.scheduled ?? []).filter((s) => sameQueueKey(s.queue) === key && s.state !== 'closed').sort((a, b) => a.starts_at.localeCompare(b.starts_at))[0];
  const schedText = sched ? ` Next scheduled table: ${sched.name}, ${new Date(sched.starts_at).toUTCString().replace(/:00 GMT$/, ' UTC')}.` : '';
  if (!q || q.seats_filled === 0) {
    return `No one is waiting in this queue right now: your seats may wait hours unless others join.${cadence}${schedText || ' Waiting costs nothing: your seats hold their place for up to 24 hours.'}`;
  }
  const oldest = q.oldest_wait_s ? `; the oldest seat has waited ${ago(q.oldest_wait_s)}` : '';
  const head = `Right now: ${set} table ${q.seats_filled}/${per}, waiting for ${q.seats_needed} more${oldest}.`;
  if (q.status === 'ready_check') return `${head} A ready check is running for a full table; your seats go into the next one.${cadence}`;
  if (mySeats >= q.seats_needed) return `${head} Your seats would fill it, so it should start within a few minutes (after a 60-second ready check).`;
  return `${head}${cadence}${schedText}`;
}

/** One line for the table question, before the set is chosen. */
export function lobbyOverview(view: LobbyView | undefined): string {
  if (!view) return '';
  if (view.director?.paused) return 'The lobby is paused for a server update right now.';
  const open = (view.queues ?? []).filter((q) => q.seats_filled > 0);
  if (!open.length) return 'Right now no one is waiting in the lobby, so expect a wait unless others join.';
  const top = [...open].sort((a, b) => b.seats_filled - a.seats_filled)[0]!;
  const seats = open.reduce((n, q) => n + q.seats_filled, 0);
  return `Right now: ${seats} seat${seats === 1 ? '' : 's'} waiting at ${open.length} open table${open.length === 1 ? '' : 's'} (fullest: ${top.set.toUpperCase()} ${top.seats_filled}/${top.seats_per_table ?? 8}).`;
}

// ---------------------------------------------------------------------------
// Per-table sizes for Keep Playing's limits (loop.ts; never printed as a projection)

export interface SeatEstimate { input: number[]; cached_input: number[]; output: number[]; usd: number[] }

export function perTable(minutes: number[], perSeat: SeatEstimate, seats: number): PerTable {
  return {
    minutes: [minutes[0]!, minutes[1]!],
    tokens: [(perSeat.input[0]! + perSeat.output[0]!) * seats, (perSeat.input[1]! + perSeat.output[1]!) * seats],
    usd: [perSeat.usd[0]! * seats, perSeat.usd[1]! * seats],
  };
}

/** The "In all" line of the Confirmation. */
export function inAllText(o: { limits: Limits; minutes: number[]; hostedPrivate: boolean; dailyLimit?: number; lobby?: boolean }): string {
  const { limits: l, minutes } = o;
  const quota = o.hostedPrivate ? ` Each table counts toward your daily Private Table limit (${o.dailyLimit ?? 6} a day by default), so the loop waits when it is used up.` : '';
  // Token and dollar limits are checked against what the seats report, never projected here.
  const usage = [l.tokens != null ? `${fmtTok(l.tokens)} tokens` : null, l.usd != null ? fmtUsd(l.usd) : null].filter((x): x is string => !!x).join(' or ');
  const usageText = usage ? ` It also stops before a table would take your seats' reported usage past ${usage}.` : '';
  // How many tables the table and hour limits allow: most with fast tables, fewest with slow ones.
  const caps = (fast: boolean) => [l.tables, l.hours != null ? Math.max(1, Math.floor((l.hours * 60) / minutes[fast ? 0 : 1]!)) : undefined].filter((x): x is number => x != null);
  if (caps(true).length) {
    const most = Math.min(...caps(true));
    const fewest = Math.min(most, ...caps(false));
    const s = (n: number) => (n === 1 ? '' : 's');
    const how = fewest === most ? `up to ${most} table${s(most)}` : `${fewest} to ${most} tables before a limit is reached, depending on how long each takes`;
    return `${how}.${usageText}${quota}`;
  }
  if (usage) return `one table at a time until your seats' reported usage would pass ${usage}.${quota} Stop it any time.`;
  const perDay = [Math.floor((24 * 60) / minutes[1]!), Math.floor((24 * 60) / minutes[0]!)];
  const days = o.hostedPrivate ? [Math.min(perDay[0]!, o.dailyLimit ?? 6), Math.min(perDay[1]!, o.dailyLimit ?? 6)] : perDay;
  const lo = Math.max(1, days[0]!);
  const hi = Math.max(lo, days[1]!);
  if (o.lobby) return `no limit: one table at a time, as often as the queue fills (at most about ${hi} a day). Stop it any time.`;
  return `no limit: about ${lo === hi ? lo : `${lo} to ${hi}`} table${hi === 1 ? '' : 's'} a day at one table at a time.${quota} Stop it any time.`;
}
