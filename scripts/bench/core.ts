/**
 * Shared plumbing for the bench CLI: where things live (a checkout of the repo, or the built npm package), tokens,
 * Director API calls, local event records, creating events, sign-in, and starting the seats.
 */
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { BENCH_COMMAND } from '../../packages/director/src/bench-command.js';
import { BEST_OF, bestOfProblem } from '../../packages/director/src/best-of.js';
import { readEventStart } from '../../packages/director/src/bundle.js';
import { EVENT_ID_RE } from '../../packages/director/src/submissions.js';
import { HARNESSES, harnessFor, normalizeHarness, type SeatSpec } from './harnesses.js';
import { checkCreatedSeats, eventIdFrom, printable, under } from './trust.js';

// ---------------------------------------------------------------------------
// Where things live

/** Set by the package build (scripts/bench/build.mjs): the CLI runs from dist/ with its assets next to it. */
declare const __BENCH_VERSION__: string | undefined;
export const PACKAGED = typeof __BENCH_VERSION__ === 'string';
const HERE = import.meta.dirname;
/** A checkout of the repository, when there is one (needed only to run your own table). */
export const REPO = [resolve(HERE, '../..'), resolve(HERE, '../../..')]
  .find((d) => existsSync(join(d, 'deploy/compose.local.yaml')) && existsSync(join(d, 'packages/director/src/main.ts')));
/** Prompts and the engine lock: next to dist/cli.js in the package, at the repo root otherwise. */
export const ASSETS = PACKAGED || !REPO ? HERE : REPO;
export const VERSION: string = PACKAGED ? __BENCH_VERSION__! : (() => {
  try {
    return JSON.parse(readFileSync(join(REPO ?? HERE, 'package.json'), 'utf8')).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

export const env = process.env;
const home = homedir();
export const CONFIG_DIR = join(env.XDG_CONFIG_HOME || join(home, '.config'), 'mtgdt-bench');
const DATA_DIR = join(env.XDG_DATA_HOME || join(home, '.local/share'), 'mtgdt-bench');
/** Event records (seat URLs), transcripts, bundles: runs/ in a checkout, ~/.local/share/mtgdt-bench/runs for the package. */
export const RUNS = resolve(env.BENCH_RUNS_DIR ?? (PACKAGED || !REPO ? join(DATA_DIR, 'runs') : join(REPO, 'runs')));
/** Local stack state (the admin token): .bench/ in a checkout. */
export const LOCAL = REPO ? join(REPO, '.bench') : join(CONFIG_DIR, 'local');
/** The current join prompt (prompts/join.md). The released copy is prompts/archive/v9. */
export const JOIN_PROMPT = join(ASSETS, 'prompts/join.md');
export const SETUP_PROMPT = join(ASSETS, 'prompts/setup.md');

/**
 * `bench play --prompt`: a file, or the released set by folder name ("v9", "prompts/v9", "prompts/archive/v9")
 * → that set's join.md (in a checkout; the package ships the current prompts only).
 */
export function joinPromptFile(arg: string): string {
  if (existsSync(arg) && !statSync(arg).isDirectory()) return arg;
  const v = /(?:^|\/)(v\d+)\/?$/.exec(arg.trim())?.[1];
  const archived = v ? join(ASSETS, 'prompts/archive', v, 'join.md') : undefined;
  if (archived && existsSync(archived)) return archived;
  if (existsSync(arg) && existsSync(join(arg, 'join.md'))) return join(arg, 'join.md');
  return arg;
}
/** The scripted random player (the `script` harness). */
export const RANDOM_AGENT = PACKAGED ? join(HERE, 'random-agent.mjs') : join(REPO ?? HERE, 'scripts/mcp-random-agent.mjs');

/** The hosted Director (BENCH_DIRECTOR overrides) and the Hub (sign-in, results). */
export const HOSTED_DIRECTOR_URL = 'https://bench.mtgdecktools.com';
export const DEFAULT_HUB_URL = 'https://bench-data.mtgdecktools.com';
/** Where the Watch page lives: <site>/agent-bench/watch/<id>/live (BENCH_WATCH_URL overrides the site). */
export const WATCH_SITE = (env.BENCH_WATCH_URL ?? 'https://mtgdecktools.com').replace(/\/+$/, '');

export const tilde = (p: string) => (p === home || p.startsWith(home + '/') ? '~' + p.slice(home.length) : p);
export const rel = (p: string) => (REPO && p.startsWith(REPO + '/') && process.cwd() === REPO ? p.slice(REPO.length + 1) : tilde(p));
export const shq = (s: string) => (/^[\w@%+=:,./~-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
/** A path for a shell command line, with ~ for the home directory (kept outside the quotes so it expands). */
export const shPath = (p: string) => {
  const t = tilde(p);
  return t.startsWith('~/') ? `~/${shq(t.slice(2))}` : shq(t);
};
/** Where the docs are: the checkout, or the repository on GitHub for the package. */
export const DOCS = REPO && !PACKAGED ? 'docs/' : 'https://github.com/grpace/mtgdecktools-agent-bench/blob/main/docs/';

/** How to run this CLI again, for the hints it prints (BENCH_CMD overrides). */
export const BENCH: string = env.BENCH_CMD || (() => {
  if (PACKAGED) {
    // Run through npx: say how to run it from a checkout instead (BENCH_COMMAND; never an unpinned npx line).
    if (env.npm_command === 'exec') return BENCH_COMMAND;
    if (basename(process.argv[1] ?? '') === 'mtgdt-bench') return 'mtgdt-bench';
    return `node ${shPath(process.argv[1] ?? 'dist/cli.js')}`;
  }
  // npm runs scripts in the package folder; INIT_CWD is where the person ran npm (`npm --prefix <checkout> run bench`).
  const from = env.INIT_CWD ?? process.cwd();
  return REPO && from !== REPO ? `npm --prefix ${shPath(REPO)} run -s bench --` : 'npm run bench --';
})();

/** The CLI's commands, registered by cli.ts (and by command modules such as the lobby's), so `setup` can hand off. */
export const COMMANDS: Record<string, (argv: string[]) => unknown> = {};

/** Every event has 8 agent seats (owner, 2026-10-22): a private table, or a lobby table filled by several contributors. */
export const TABLE_SEATS = 8;
/** Swiss rounds per event (each agent plays this many matches). */
export const SWISS_ROUNDS = 3;

export const die = (msg: string): never => {
  console.error(`error: ${msg}`);
  process.exit(1);
};
export const readIf = (p: string) => (existsSync(p) ? readFileSync(p, 'utf8').trim() : '');
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * How long the CLI waits out a Director that doesn't answer before it gives up: a deploy restarts it (usually 1–3
 * minutes, during which the proxy answers 404, 502 or 503). MTGDT_DIRECTOR_WAIT_MIN, default 10.
 */
export const DIRECTOR_DOWN_MAX_MS = Math.max(1, Number(env.MTGDT_DIRECTOR_WAIT_MIN) || 10) * 60_000;
/** Pause before the n-th retry (1-based) while the Director doesn't answer: 5 s, 10 s, 20 s, then every 30 s. */
export const downBackoffMs = (n: number): number => Math.min(30_000, 5_000 * 2 ** Math.max(0, n - 1));

/**
 * Whether a response is the Director's own answer. Its errors are JSON; while it restarts, the proxy in front of it
 * answers plain text (Traefik: "404 page not found" with no backend, 502, 503), which says nothing about the event.
 */
export function fromDirector(res: Response, body?: string): boolean {
  if (!(res.headers.get('content-type') ?? '').includes('application/json')) return false;
  if (body == null) return true;
  try {
    JSON.parse(body);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Directors and tokens

export function directorUrl(flag?: string, ev?: LocalEvent): string {
  const port = env.BENCH_PORT ?? '8787';
  return (flag ?? env.BENCH_DIRECTOR ?? ev?.director ?? `http://127.0.0.1:${port}`).replace(/\/+$/, '');
}

export const isLoopback = (base: string) => /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(base);

/** Tokens only travel over HTTPS, except to this machine (or with BENCH_ALLOW_HTTP=1, e.g. a private network). */
export function requireTls(base: string): void {
  if (base.startsWith('https://') || isLoopback(base) || env.BENCH_ALLOW_HTTP === '1') return;
  die(`refusing to send a token to ${base} over plain HTTP; use https:// (or set BENCH_ALLOW_HTTP=1 on a trusted network)`);
}

/** Admin token for a Director: ADMIN_TOKEN, else .bench/admin-token for a local one, else ~/.config/mtgdt/admin-token. */
export function adminToken(base: string): string {
  requireTls(base);
  const local = isLoopback(base);
  const t = adminTokenIfAny(base);
  return t || die(local ? `no admin token for the Director on this machine: set ADMIN_TOKEN, or start it with \`${BENCH} up\` (it writes .bench/admin-token)`
    : `not signed in: run \`${BENCH} login\` (or set BENCH_TOKEN) to get a contributor token`);
}

/** The admin token this machine has for `base`, if any (never dies). */
export function adminTokenIfAny(base: string): string | undefined {
  const local = isLoopback(base);
  // The admin token file is for the hosted Director: never sent to another host (ADMIN_TOKEN is your explicit choice).
  const files = local ? [join(LOCAL, 'admin-token'), join(home, '.config/mtgdt/admin-token')] : trustedOrigin(base) ? [join(home, '.config/mtgdt/admin-token')] : [];
  return env.ADMIN_TOKEN || files.map(readIf).find(Boolean) || undefined;
}

/**
 * The token `bench status` sends for an event: the one it was created with when this machine has it (--token; the
 * contributor token for a hosted table; the admin token for a table created with it, on this machine or the hosted
 * Director), else whichever this machine has. With it the organizer gets the full status, not the public one.
 */
export function statusToken(base: string, ev: LocalEvent | undefined, flag?: string): { token?: string; as?: 'admin' | 'contributor' } {
  if (flag) return { token: flag };
  const admin = () => adminTokenIfAny(base);
  const contributor = () => contributorToken(undefined, base);
  if (ev?.hosted) return contributor() ? { token: contributor(), as: 'contributor' } : {};
  if (ev) return admin() ? { token: admin(), as: 'admin' } : contributor() ? { token: contributor(), as: 'contributor' } : {};
  return contributor() ? { token: contributor(), as: 'contributor' } : admin() ? { token: admin(), as: 'admin' } : {};
}

/** Where `bench login` keeps the contributor token: $XDG_CONFIG_HOME/mtgdt-bench/token (default ~/.config). */
export const tokenFile = () => join(CONFIG_DIR, 'token');
const accountFile = () => join(CONFIG_DIR, 'account.json');
const pendingFile = () => join(CONFIG_DIR, 'login-pending.json');

/**
 * The origins the saved contributor token may go to: it is a Hub token (scopes play and submit), so only the Hub
 * that issued it and the official Director. A community Director gets its own token (--token or BENCH_TOKEN), or none:
 * otherwise its operator could replay yours on the hosted Director and the Hub. BENCH_TOKEN_ORIGINS (comma-separated
 * origins) adds others, e.g. a staging pair.
 */
export function tokenOrigins(): string[] {
  const o = (u: string | undefined) => {
    try {
      return u ? new URL(u).origin : undefined;
    } catch {
      return undefined;
    }
  };
  let issuer: string | undefined;
  try {
    issuer = JSON.parse(readFileSync(accountFile(), 'utf8'))?.hub;
  } catch {
    // no account file: the default Hub
  }
  return [...new Set([HOSTED_DIRECTOR_URL, DEFAULT_HUB_URL, issuer, ...(env.BENCH_TOKEN_ORIGINS ?? '').split(',')].map((x) => o(x?.trim())).filter((x): x is string => !!x))];
}

/** Whether the saved token may be sent to `base` (an official origin, or this machine). */
export function trustedOrigin(base: string): boolean {
  if (isLoopback(base)) return true;
  try {
    return tokenOrigins().includes(new URL(base).origin);
  } catch {
    return false;
  }
}

const warned = new Set<string>();
const warnOnce = (k: string, msg: string) => {
  if (warned.has(k)) return;
  warned.add(k);
  console.warn(msg);
};

/**
 * The contributor token: --token, else BENCH_TOKEN, else the `bench login` file. With `base` (where it will be sent),
 * the saved file's token goes only to the origins it was issued for (tokenOrigins); a token you give explicitly goes
 * where you send it, with a warning when that isn't an official host.
 */
export function contributorToken(flag?: string, base?: string): string | undefined {
  const explicit = flag || env.BENCH_TOKEN;
  if (base && !trustedOrigin(base)) {
    let host = base;
    try {
      host = new URL(base).host;
    } catch {
      // as given
    }
    if (explicit) {
      warnOnce(`x ${host}`, `note: ${host} isn't the hosted Director or Hub; sending it the token you gave (--token or BENCH_TOKEN). Only do that if that Director issued it.`);
      return explicit;
    }
    if (readIf(tokenFile())) warnOnce(`s ${host}`, `note: ${host} isn't the hosted Director or Hub, so your saved contributor token isn't sent to it. A community Director needs its own token (--token or BENCH_TOKEN), or none.`);
    return undefined;
  }
  return explicit || readIf(tokenFile()) || undefined;
}

/** Who `bench login` signed in as (saved next to the token), if known. */
export function account(): { handle?: string; hub?: string; quotas?: Record<string, number> } | undefined {
  try {
    return contributorToken() ? JSON.parse(readFileSync(accountFile(), 'utf8')) : undefined;
  } catch {
    return contributorToken() ? {} : undefined;
  }
}

/**
 * The token for a Director's authenticated endpoints. `as: 'contributor'` (hosted play) always uses the contributor
 * token, even on this machine (tests). Otherwise: a local stack takes the admin token; a hosted Director --token,
 * else ADMIN_TOKEN when set explicitly (the operator), else the contributor token, else ~/.config/mtgdt/admin-token.
 */
export function directorToken(base: string, flag?: string, as?: 'contributor' | 'admin'): { token: string; contributor: boolean } {
  requireTls(base);
  if (as === 'contributor') {
    const c = contributorToken(flag, base);
    return c ? { token: c, contributor: true } : die(trustedOrigin(base) ? `not signed in: run \`${BENCH} login\` first (GitHub sign-in; it saves a contributor token)`
      : `${base} isn't the hosted Director: give the token it issued you with --token (or BENCH_TOKEN); your saved contributor token only goes to the hosted Director and Hub`);
  }
  if (flag) return { token: flag, contributor: !isLoopback(base) && as !== 'admin' };
  if (isLoopback(base) || env.ADMIN_TOKEN || as === 'admin') return { token: adminToken(base), contributor: false };
  const c = contributorToken(undefined, base);
  return c ? { token: c, contributor: true } : { token: adminToken(base), contributor: false };
}

export async function api(base: string, path: string, init: RequestInit & { admin?: boolean; token?: string; as?: 'contributor' | 'admin' } = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (init.admin) headers.set('Authorization', `Bearer ${directorToken(base, init.token, init.as).token}`);
  try {
    return await fetch(`${base}${path}`, { ...init, headers });
  } catch (err) {
    return die(`cannot reach the Director at ${base} (${(err as Error).message}).${isLoopback(base) ? ` Is it running? Try \`${BENCH} up\`.` : ''}`);
  }
}

export async function jsonOrDie(res: Response): Promise<any> {
  const text = await res.text();
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  if (!res.ok) die(`${res.status} ${printable(typeof body === 'object' ? (body.error ?? JSON.stringify(body, null, 1)) : body, 500)}`);
  return body;
}

/** GET a JSON document, or undefined (unreachable, not JSON, an error status): for checks that must not stop the CLI. */
export async function tryJson(url: string, ms = 10_000): Promise<any | undefined> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(ms) });
    return r.ok ? await r.json() : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Local event records (runs/<id>/event.json holds the seat URLs: keep it private)

export interface LocalEvent {
  id: string;
  director?: string;
  created_at?: string;
  set?: string;
  knowledge?: string;
  mana?: string;
  /** Written by older versions only: the seed stays secret until the event ends (bench status shows it then). */
  seed?: string;
  hosted?: boolean;
  seats: Record<string, string>;
  meta: Record<string, { harness?: string; model?: string; effort?: string; context_policy?: string; launch_model?: string }>;
}

export function eventDir(arg: string | undefined): string {
  if (!arg) die('which event? give an event id (or runs/<id>)');
  const asPath = resolve(arg!);
  if (existsSync(join(asPath, 'events.jsonl')) || existsSync(join(asPath, 'event.json')) || existsSync(join(asPath, 'seats.json'))) return asPath;
  const id = basename(arg!.replace(/\/+$/, ''));
  if (!EVENT_ID_RE.test(id)) die(`not an event id: ${arg}`);
  return under(RUNS, id);
}

export function loadEvent(dir: string): LocalEvent {
  const id = basename(dir);
  const f = join(dir, 'event.json');
  if (existsSync(f)) return JSON.parse(readFileSync(f, 'utf8'));
  // An event run with the one-shot Director (npm run director): seats.json + event_start metadata.
  const seatsFile = join(dir, 'seats.json');
  const start: any = readEventStart(dir);
  const meta: LocalEvent['meta'] = {};
  for (const s of start?.seats ?? []) if (s.kind === 'agent') meta[s.name] = { harness: s.harness, model: s.model, effort: s.effort, ...(s.context_policy ? { context_policy: s.context_policy } : {}) };
  if (!existsSync(seatsFile) && !start) die(`no event at ${tilde(dir)} (create one with \`${BENCH} setup\`)`);
  return { id, seats: existsSync(seatsFile) ? JSON.parse(readFileSync(seatsFile, 'utf8')) : {}, meta };
}

export interface CreateOptions {
  base: string;
  set: string;
  seats: Array<SeatSpec & { name: string }>;
  knowledge: string;
  mana: string;
  /** Every event plays best of 3 with sideboarding (best-of.ts): 3 or left out; anything else is refused. */
  bestOf?: number;
  podSize: number;
  seed?: string;
  token?: string;
  /** Hosted play: create with the contributor token (rated conditions; the Director picks the seed). */
  hosted: boolean;
  /** Own table only: seats with models or harnesses the registry doesn't list (unrated). */
  allowUnlisted?: boolean;
  /** Run a Set Context level as "none" on a set without a Set Context (the Director refuses it otherwise). */
  allowDowngrade?: boolean;
  /** A "Keep Playing" loop's table (the hosted Director gives it lower priority: docs/LOBBY.md §2.3). */
  continuous?: boolean;
  /** Throw an ApiError instead of exiting (the loop retries). */
  throwOnError?: boolean;
}

/** A Director answer that wasn't a success (or no answer at all: status 0). */
export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly retryAfterS?: number) {
    super(message);
  }
}

export interface Created {
  ev: LocalEvent;
  dir: string;
  status: 'running' | 'queued';
  queuePosition?: number;
  primer?: { from: string; sha256: string } | null;
}

/** POST /api/events and save runs/<id>/event.json (0600). */
export async function createEvent(o: CreateOptions): Promise<Created> {
  const bestOfRefused = bestOfProblem(o.bestOf);
  if (bestOfRefused) {
    if (o.throwOnError) throw new ApiError(400, bestOfRefused);
    return die(bestOfRefused);
  }
  // The Director resolves each seat with the same registry and logs canonical ids plus what was typed.
  const agents = o.seats.map((s) => {
    const d = s.declared ?? {};
    const pick = (typed: string | undefined, canon: string | undefined) => typed ?? canon;
    return Object.fromEntries(Object.entries({
      name: s.name, harness: pick(d.harness, s.harness), model: pick(d.model, s.model), effort: pick(d.effort, s.effort), effort_basis: s.effortBasis,
      context_policy: s.contextPolicy,
    }).filter(([, v]) => v));
  });
  const body = {
    set: o.set, agents, knowledge: o.knowledge, mana: o.mana, bestOf: BEST_OF, podSize: o.podSize, ...(o.seed ? { seed: o.seed } : {}),
    ...(o.allowUnlisted ? { allow_unlisted: true } : {}), ...(o.allowDowngrade ? { allow_downgrade: true } : {}), ...(o.continuous ? { continuous: true } : {}),
  };
  const init = { method: 'POST', admin: true, token: o.token, as: o.hosted ? ('contributor' as const) : undefined, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  let res: any;
  if (o.throwOnError) {
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${directorToken(o.base, o.token, init.as).token}`);
    let r: Response;
    try {
      r = await fetch(`${o.base}/api/events`, { method: 'POST', headers, body: init.body, signal: AbortSignal.timeout(60_000) });
    } catch (err) {
      throw new ApiError(0, `cannot reach the Director at ${o.base} (${(err as Error).message})`);
    }
    const text = await r.text();
    try {
      res = JSON.parse(text);
    } catch {
      res = { error: text.slice(0, 300) };
    }
    // The proxy answering for a Director that is restarting (a deploy): a temporary 503, never a refusal.
    if (!r.ok && [404, 502, 503, 504].includes(r.status) && !fromDirector(r, text)) {
      throw new ApiError(503, `the Director is restarting (the proxy answered ${r.status})`, 60);
    }
    if (!r.ok) throw new ApiError(r.status, String(res?.error ?? r.statusText), Number(r.headers.get('retry-after')) || res?.retry_after_s || undefined);
  } else res = await jsonOrDie(await api(o.base, '/api/events', init));
  // The answer names a folder and the seats: an event id, and exactly the seats asked for, on this Director.
  let id: string;
  let seats: Record<string, string>;
  try {
    id = eventIdFrom(res?.id);
    seats = checkCreatedSeats(res?.seats, o.base, o.seats.map((s) => s.name));
  } catch (err) {
    if (o.throwOnError) throw new ApiError(400, (err as Error).message);
    return die((err as Error).message);
  }
  // A Director that doesn't record context policies (older builds) would label rotated seats as one conversation:
  // such seats play with --fresh-session off.
  const meta = res?.seat_meta && typeof res.seat_meta === 'object' ? res.seat_meta : undefined;
  const unrecorded = meta ? o.seats.filter((s) => s.contextPolicy && meta[s.name]?.context_policy !== s.contextPolicy) : [];
  if (unrecorded.length) {
    console.warn(`note: this Director doesn't record context policies yet, so ${unrecorded.map((s) => s.name).join(', ')} will play with --fresh-session off`);
    o = { ...o, seats: o.seats.map((s) => (unrecorded.includes(s) ? { ...s, contextPolicy: undefined } : s)) };
  }
  const dir = under(RUNS, id);
  mkdirSync(RUNS, { recursive: true, mode: 0o700 });
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // What starts each seat (bench play) is this plan's harness, model and effort: never the Director's answer.
  const ev: LocalEvent = {
    id, director: o.base, created_at: new Date().toISOString(), set: o.set, knowledge: typeof res.knowledge === 'string' ? printable(res.knowledge, 40) : undefined,
    // No seed, even if an older Director sent one: it regenerates the packs, so it stays secret until the event ends
    // (docs/COMMUNITY.md); `bench status` shows it once the event is done.
    mana: o.mana, hosted: o.hosted,
    seats, meta: Object.fromEntries(o.seats.map(({ name, harness, model, effort, contextPolicy, launchModel }) => [name, { harness, model, effort, ...(contextPolicy ? { context_policy: contextPolicy } : {}), ...(launchModel ? { launch_model: launchModel } : {}) }])),
  };
  writeFileSync(join(dir, 'event.json'), JSON.stringify(ev, null, 1), { mode: 0o600 });
  return { ev, dir, status: res.status === 'queued' ? 'queued' : 'running', queuePosition: Number(res.queue_position) || undefined, primer: res.primer && typeof res.primer === 'object' ? { from: printable(res.primer.from, 120), sha256: printable(res.primer.sha256, 64) } : res.primer === null ? null : undefined };
}

/** Seat names for `new`/`setup` specs: "[name=]harness/model/effort"; checks names and the hosted rules' metadata. */
export function checkSeat(s: SeatSpec, i: number): void {
  const label = s.name ? `seat ${s.name}` : `seat ${i + 1}`;
  if (s.name && !/^[\w.-]{1,40}$/.test(s.name)) die(`${label}: use letters, digits, dot, dash or underscore in the name`);
  if (!s.harness) die(`${label}: which harness? e.g. "Claude Code/claude-opus-5-5/high"`);
  if (!s.model) die(`${label}: which model? e.g. "${harnessFor(s.harness)?.label ?? s.harness}/<model id>/<effort>"`);
  for (const k of ['harness', 'model', 'effort'] as const) {
    if (s[k] != null && !/^[\w.:@+/-]{1,80}$/.test(s[k]!)) die(`${label}: the ${k} "${s[k]}" can only use letters, digits and . : @ + / - _ (80 at most)`);
  }
}

export { HARNESSES, harnessFor, normalizeHarness };

// ---------------------------------------------------------------------------
// Event status and the seats' launcher

export async function eventStatus(base: string, id: string, token?: string): Promise<any | undefined> {
  try {
    const res = await fetch(`${base}/api/events/${id}`, { headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(20_000) });
    const text = await res.text();
    // Gone only when the Director itself says so: a proxy's 404 during a deploy is "no answer" (try again).
    if (res.status === 404) return fromDirector(res, text) ? { stage: 'gone' } : undefined;
    return res.ok ? JSON.parse(text) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether a seat has finished the event, per the Director's GET /api/events/:id. While the Director doesn't answer (a
 * deploy restarts it: the proxy's 404, 502 or 503, or no connection), keep asking with backoff for up to `maxDownMs`
 * (DIRECTOR_DOWN_MAX_MS) and then say 'unreachable'. `waited`: it didn't answer at first.
 */
export async function seatStateAt(
  base: string, id: string, seat: string, opts: { maxDownMs?: number; backoffMs?: (n: number) => number; log?: (line: string) => void } = {},
): Promise<{ state: 'done' | 'running' | 'gone' | 'unreachable'; waited: boolean }> {
  const { maxDownMs = DIRECTOR_DOWN_MAX_MS, backoffMs = downBackoffMs, log = console.warn } = opts;
  const since = Date.now();
  for (let i = 1; ; i++) {
    const s = await eventStatus(base, id);
    const waited = i > 1;
    if (s?.stage === 'gone') return { state: 'gone', waited };
    if (s) {
      const mine = s.agents?.find((a: { name: string }) => a.name === seat);
      if (s.stage === 'done' || mine?.status === 'done') return { state: 'done', waited };
      return { state: String(s.stage ?? '').startsWith('not running') || s.stage === 'aborted' || !mine ? 'gone' : 'running', waited };
    }
    if (Date.now() - since >= maxDownMs) return { state: 'unreachable', waited };
    if (i === 1) log(`seat ${seat}: the Director isn't answering (restarting?); waiting up to ${Math.round(maxDownMs / 60_000)} minutes before giving up`);
    await sleep(Math.max(1, Math.min(backoffMs(i), maxDownMs - (Date.now() - since))));
  }
}

/**
 * Wait (polling the public status, no tokens spent) while the Director holds an event in its capacity queue, so no
 * harness session is started, and paid for, before the event has a decision to offer. Resolves with the stage it
 * left the queue for ('running' covers every stage after the queue), or 'unknown' when the Director stopped answering
 * (for DIRECTOR_DOWN_MAX_MS, or `maxFailures` polls in a row when given).
 */
export async function waitWhileQueued(
  base: string, id: string, opts: { pollMs?: number; maxFailures?: number; maxDownMs?: number; log?: (line: string) => void } = {},
): Promise<'running' | 'aborted' | 'gone' | 'unknown'> {
  const { pollMs = 30_000, maxFailures, maxDownMs = DIRECTOR_DOWN_MAX_MS, log = console.log } = opts;
  let told: number | null | undefined;
  let failures = 0;
  let downSince: number | undefined;
  for (;;) {
    const s = await eventStatus(base, id);
    if (!s) {
      failures++;
      downSince ??= Date.now();
      if (maxFailures != null ? failures >= maxFailures : Date.now() - downSince >= maxDownMs) return 'unknown';
      if (failures === 1) log(`event ${id}: the Director isn't answering (restarting?); waiting up to ${Math.round(maxDownMs / 60_000)} minutes`);
    } else {
      downSince = undefined;
      failures = 0;
      if (s.stage === 'gone') return 'gone';
      if (s.stage === 'aborted') return 'aborted';
      if (s.stage !== 'queued') return 'running';
      const pos = typeof s.queue_position === 'number' ? s.queue_position : null;
      if (pos !== told) log(`event ${id}: queued for hosted capacity (position ${pos ?? '?'}); the seats start when it begins, and nothing is spent while it waits`);
      told = pos;
    }
    await sleep(pollMs);
  }
}

/**
 * Whether `pid` is alive and still one of ours: its command line has every word in `words`. A saved pid can belong
 * to an unrelated process after a reboot, and must not be signaled then.
 */
export function ourProcess(pid: number | undefined, words: string[]): boolean {
  if (!pid || !Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  let cmdline = '';
  try {
    cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' ');
  } catch {
    const r = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', timeout: 5_000 });
    if (r.error || r.status !== 0) return false;
    cmdline = r.stdout;
  }
  return words.every((w) => cmdline.includes(w));
}

/** The pid of a background `play` for this event, when it is still running. */
export function playPid(dir: string): number | undefined {
  const pid = Number(readIf(join(dir, 'play.pid')));
  return ourProcess(pid, ['play', basename(dir)]) ? pid : undefined;
}

/**
 * Start `play <event> --seat …` in the background, detached from this terminal (it relaunches seats until the
 * event completes, then exits). Output goes to runs/<id>/play.log; the pid to runs/<id>/play.pid.
 */
export function startPlayInBackground(dir: string, id: string, seats: string[], extra: string[] = []): { pid: number; log: string } {
  const log = join(dir, 'play.log');
  const fd = openSync(log, 'a', 0o600);
  // Same runtime as this process: plain node for the package, node + the tsx loader in a checkout.
  const child = spawn(process.execPath, [...process.execArgv, process.argv[1]!, 'play', id, ...seats.flatMap((s) => ['--seat', s]), ...extra], {
    detached: true, stdio: ['ignore', fd, fd], env: { ...env, BENCH_RUNS_DIR: RUNS },
  });
  closeSync(fd);
  child.unref();
  writeFileSync(join(dir, 'play.pid'), String(child.pid), { mode: 0o600 });
  return { pid: child.pid!, log };
}

// ---------------------------------------------------------------------------
// Contributor token: GitHub device flow through the Hub (packages/hub/README.md "CLI login (device flow)")

export function hubUrl(flag?: string): string {
  const hub = (flag ?? env.BENCH_HUB ?? DEFAULT_HUB_URL).replace(/\/+$/, '');
  requireTls(hub);
  return hub;
}

async function hubPost(hub: string, path: string, body?: unknown): Promise<Record<string, any>> {
  const res = await fetch(`${hub}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000),
  }).catch((e) => die(`cannot reach the Hub at ${hub} (${(e as Error).message})`));
  const j = (await res.json().catch(() => ({}))) as Record<string, any>;
  return { ...j, http: res.status };
}

interface Pending {
  hub: string;
  device_id: string;
  user_code: string;
  verification_uri: string;
  interval: number;
  expires_at: number;
}

/** Ask the Hub for a sign-in code; print the link and the code. */
export async function loginStart(hub: string): Promise<Pending> {
  const start = await hubPost(hub, '/auth/device/start');
  if (start.http !== 200 || !start.device_id) die(`${start.http}: ${start.error ?? 'could not start the sign-in'}`);
  const p: Pending = {
    hub, device_id: start.device_id, user_code: start.user_code, verification_uri: start.verification_uri,
    interval: Number(start.interval) || 5, expires_at: Date.now() + Number(start.expires_in) * 1000,
  };
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  chmodSync(CONFIG_DIR, 0o700);
  writeFileSync(pendingFile(), JSON.stringify(p), { mode: 0o600 });
  console.log(`\nSign in with GitHub: open ${p.verification_uri} and enter the code\n\n    ${p.user_code}\n`);
  console.log(`The code expires in ${Math.round((p.expires_at - Date.now()) / 60_000)} minutes.`);
  return p;
}

/** The sign-in started by `login --start`, if it hasn't expired. */
export function pendingLogin(): Pending | undefined {
  try {
    const p = JSON.parse(readFileSync(pendingFile(), 'utf8')) as Pending;
    return p.expires_at > Date.now() ? p : undefined;
  } catch {
    return undefined;
  }
}

/** Poll until the user has entered the code; save the token (0600) and who it belongs to. */
export async function loginWait(p: Pending): Promise<void> {
  console.log('Waiting for GitHub...');
  let interval = p.interval;
  while (Date.now() < p.expires_at) {
    await sleep(interval * 1000 + 200);
    const r = await hubPost(p.hub, '/auth/device/poll', { device_id: p.device_id });
    if (r.status === 'pending') continue;
    if (r.status === 'slow_down') {
      interval = Math.max(interval, Number(r.interval) || interval + 5);
      continue;
    }
    rmSync(pendingFile(), { force: true });
    if (r.status === 'ok' && typeof r.token === 'string') {
      const file = tokenFile();
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      chmodSync(dirname(file), 0o700);
      writeFileSync(file, r.token + '\n', { mode: 0o600 });
      chmodSync(file, 0o600);
      const q = r.quotas ?? {};
      // `hub` is the token's issuer: tokenOrigins() sends the token there and to the official Director only.
      writeFileSync(accountFile(), JSON.stringify({ handle: r.handle, hub: p.hub, scopes: r.scopes, quotas: q, signed_in_at: new Date().toISOString() }, null, 1), { mode: 0o600 });
      console.log(`\nSigned in as ${r.handle}. Token saved to ${tilde(file)} (private; scopes ${(r.scopes ?? []).join(', ')}).`);
      console.log(`Hosted play: Private Tables ${q.play_concurrent ?? '?'} at a time, ${q.play_daily ?? '?'} per day${q.lobby_daily != null ? `; lobby tables ${q.lobby_concurrent ?? '?'} at a time, ${q.lobby_daily} per day` : ''}. Manage or revoke tokens: ${p.hub}/account`);
      return;
    }
    die(r.error ?? `sign-in failed (${r.status ?? r.http})`);
  }
  rmSync(pendingFile(), { force: true });
  die(`the code expired before it was entered; run \`${BENCH} login\` again`);
}

export function signOut(): void {
  const file = tokenFile();
  rmSync(accountFile(), { force: true });
  rmSync(pendingFile(), { force: true });
  if (!existsSync(file)) {
    console.log(`not signed in (no ${tilde(file)})`);
    return;
  }
  rmSync(file);
  console.log(`removed ${tilde(file)}. The token still works until you revoke it: ${DEFAULT_HUB_URL}/account`);
}

// ---------------------------------------------------------------------------
// Misc

export function lockFile(): { image: string; digest: string } {
  return JSON.parse(readFileSync(join(ASSETS, 'engine/phase.lock.json'), 'utf8'));
}

export function kitVersion(): string {
  if (PACKAGED || !REPO) return `mtgdt-bench ${VERSION}`;
  const r = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO, encoding: 'utf8' });
  return `mtgdt-bench ${r.status === 0 ? r.stdout.trim() : 'unknown'}`;
}

export function fmtTokens(u: { input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_creation_tokens: number }): string {
  const k = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${(n / 1e3).toFixed(0)}k`);
  return `in ${k(u.input_tokens + u.cache_creation_tokens)} + cache read ${k(u.cache_read_tokens)}, out ${k(u.output_tokens)}`;
}

export const launchableHarnessIds = () => HARNESSES.filter((h) => h.launch && !h.test).map((h) => h.id);
