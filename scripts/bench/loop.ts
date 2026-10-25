/**
 * Keep Playing: the loop that starts a new table as soon as one finishes, in the background.
 *
 *   startLoop(...)            after `bench setup --keep-playing` is confirmed: runs `loop run <id>` detached
 *   bench loop run <id>       (internal) the loop itself
 *   bench status [<loop id>]  loops on this machine, or one loop's summary
 *   bench stop <loop id> [--now]   finish the current table and stop; or stop at once
 *
 * A Private Table: each table is a new event (new seed, the same seats; the set rotates when asked), created with
 * `continuous: true` so the hosted Director queues it behind lobby and one-off tables (docs/LOBBY.md §2.3), and
 * played with `bench play`. The Lobby: each table is a `bench lobby join` with the same seats; the seats rejoin
 * the back of the queue when their table ends.
 *
 * Before every table: the limits (tables, hours, tokens, dollars: continuous.ts nextStep), a stop request, and the
 * cheap preflight again for every harness this machine starts (a harness that stopped answering ends the loop).
 * Errors back off (1, 2, 4 … 30 minutes) and five in a row end the loop. Everything it does goes to
 * <runs>/loops/<id>/: loop.json (the plan), summary.json (rewritten after every change), loop.log, stop.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { bestOfProblem } from '../../packages/director/src/best-of.js';
import { extractUsage, seatUsd, usageProblem } from '../../packages/director/src/usage.js';
import {
  ApiError, BENCH, RUNS, api, contributorToken, createEvent, die, env, eventStatus, ourProcess, readIf, sleep, tilde,
} from './core.js';
import { SEAT_NAME_RE, eventIdFrom, under } from './trust.js';
import { harnessFor } from './harnesses.js';
import { MAX_FAILURES, backoffMs, limitsText, nextStep, perTable, queueKeyOf, setFor, type Limits, type Progress } from './continuous.js';
import { leaveTicket, ticketView } from './lobby.js';
import { estimate, freshFlag, freshOf, recheckPreflight, type Plan } from './setup.js';

export const LOOPS = join(RUNS, 'loops');
export const LOOP_ID_RE = /^loop-\d{8}-\d{6}-[0-9a-f]{4}$/;

export interface LoopFile {
  id: string;
  created_at: string;
  plan: Plan;
  confirmation_code: string;
  relaunch?: string;
  use_api_key?: boolean;
  skip_preflight?: boolean;
  hub?: string;
  pid?: number;
}

export interface TableRecord {
  n: number;
  event_id: string | null;
  set: string;
  /** 'cancelled': summaries written before the US spelling sweep. */
  status: 'running' | 'done' | 'aborted' | 'canceled' | 'cancelled' | 'no_table';
  started_at: string;
  ended_at?: string;
  /** Your seats' results: matches and games won and lost. */
  standings?: Array<{ seat: string; matches: string; games: string }>;
  /** Per seat: tokens and cost as the harness reported them; `estimated` when it reported none. */
  usage?: Array<{ seat: string; input: number; cached: number; output: number; usd: number | null; estimated: boolean }>;
  tokens?: number;
  usd?: number;
  estimated?: boolean;
  note?: string;
}

export interface Summary {
  loop: string;
  table_kind: 'private' | 'lobby';
  state: 'running' | 'waiting' | 'stopping' | 'stopped';
  stop_reason: string | null;
  stop_text: string | null;
  started_at: string;
  updated_at: string;
  limits: Limits;
  limits_text: string;
  progress: { tables: number; hours: number; tokens: number; usd: number; estimated: boolean };
  current: { n: number; event_id: string | null; set: string; pid?: number; ticket?: string } | null;
  waiting: { until: string; why: string } | null;
  failures: number;
  tables: TableRecord[];
}

const dirOf = (id: string) => join(LOOPS, id);
const summaryFile = (id: string) => join(dirOf(id), 'summary.json');
const stopFile = (id: string) => join(dirOf(id), 'stop');

function writeAtomic(file: string, data: unknown): void {
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(data, null, 1), { mode: 0o600 });
  renameSync(tmp, file);
}

/** The loop's process, if it still runs (and the pid wasn't reused by something else after a reboot). */
const aliveLoop = (pid: number | undefined, id: string) => ourProcess(pid, ['loop', 'run', id]);

export function readLoop(id: string): { loop: LoopFile; summary: Summary | undefined } | undefined {
  if (!LOOP_ID_RE.test(id) || !existsSync(join(dirOf(id), 'loop.json'))) return undefined;
  const loop = JSON.parse(readFileSync(join(dirOf(id), 'loop.json'), 'utf8')) as LoopFile;
  const summary = existsSync(summaryFile(id)) ? (JSON.parse(readFileSync(summaryFile(id), 'utf8')) as Summary) : undefined;
  return { loop, summary };
}

export function listLoops(): Array<{ loop: LoopFile; summary: Summary | undefined; running: boolean }> {
  if (!existsSync(LOOPS)) return [];
  return readdirSync(LOOPS).filter((d) => LOOP_ID_RE.test(d)).sort().reverse().flatMap((id) => {
    const r = readLoop(id);
    return r ? [{ ...r, running: aliveLoop(r.loop.pid, id) && r.summary?.state !== 'stopped' }] : [];
  });
}

// ---------------------------------------------------------------------------
// Starting a loop (from setup)

export function startLoop(o: { plan: Plan; confirmation: { code: string }; relaunch?: string; useApiKey?: boolean; skipPreflight?: boolean; token?: string; hub?: string }): { id: string; pid: number; log: string; summary: string } {
  const now = new Date();
  const stamp = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const id = `loop-${stamp}-${randomBytes(2).toString('hex')}`;
  const dir = dirOf(id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const loop: LoopFile = {
    id, created_at: now.toISOString(), plan: o.plan, confirmation_code: o.confirmation.code,
    ...(o.relaunch ? { relaunch: o.relaunch } : {}), ...(o.useApiKey ? { use_api_key: true } : {}), ...(o.skipPreflight ? { skip_preflight: true } : {}), ...(o.hub ? { hub: o.hub } : {}),
  };
  writeAtomic(join(dir, 'loop.json'), loop);
  const log = join(dir, 'loop.log');
  const fd = openSync(log, 'a', 0o600);
  const child = spawn(process.execPath, [...process.execArgv, process.argv[1]!, 'loop', 'run', id], {
    detached: true, stdio: ['ignore', fd, fd],
    // A --token given to setup reaches the loop through its environment, never a file.
    env: { ...env, BENCH_RUNS_DIR: RUNS, ...(o.token ? { BENCH_TOKEN: o.token } : {}) },
  });
  closeSync(fd);
  child.unref();
  writeAtomic(join(dir, 'loop.json'), { ...loop, pid: child.pid });
  return { id, pid: child.pid!, log, summary: summaryFile(id) };
}

// ---------------------------------------------------------------------------
// The loop

class Runner {
  private s: Summary;
  private child: ChildProcess | undefined;
  private plan: Plan;
  private seatsHere: string[];
  private per: ReturnType<typeof perTable>;
  private est: ReturnType<typeof estimate>;
  private llmSeats: number;

  constructor(private loop: LoopFile) {
    this.plan = loop.plan;
    this.llmSeats = this.plan.seats.filter((x) => !harnessFor(x.harness)?.test).length;
    const llm = this.plan.seats.filter((x) => !harnessFor(x.harness)?.test);
    this.est = estimate(Math.max(1, this.llmSeats), llm.map((x) => x.model), freshOf(this.plan), llm.map((x) => x.effort));
    this.per = perTable(this.est.minutes, this.est.per_seat, this.llmSeats);
    this.seatsHere = this.plan.seats.map((x) => x.name);
    this.s = readLoop(loop.id)?.summary ?? {
      loop: loop.id, table_kind: this.plan.table, state: 'running', stop_reason: null, stop_text: null,
      started_at: new Date().toISOString(), updated_at: new Date().toISOString(), limits: this.plan.limits, limits_text: limitsText(this.plan.limits) || 'none',
      progress: { tables: 0, hours: 0, tokens: 0, usd: 0, estimated: false }, current: null, waiting: null, failures: 0, tables: [],
    };
  }

  private log(msg: string) {
    console.log(`[${new Date().toISOString()}] ${msg}`);
  }

  private save() {
    const started = Date.parse(this.s.started_at);
    this.s.progress.hours = Math.round(((Date.now() - started) / 3600_000) * 100) / 100;
    this.s.updated_at = new Date().toISOString();
    writeAtomic(summaryFile(this.loop.id), this.s);
  }

  private stopRequest(): 'graceful' | 'now' | null {
    const v = readIf(stopFile(this.loop.id));
    return v === 'now' ? 'now' : v ? 'graceful' : null;
  }

  private finish(reason: string, text: string): void {
    this.s.state = 'stopped';
    this.s.stop_reason = reason;
    this.s.stop_text = text;
    this.s.current = null;
    this.s.waiting = null;
    this.save();
    this.log(`stopped: ${text}`);
  }

  /** Sleep, waking early for a stop request; true when it was interrupted. */
  private async wait(ms: number, why: string): Promise<boolean> {
    this.s.state = 'waiting';
    this.s.waiting = { until: new Date(Date.now() + ms).toISOString(), why };
    this.save();
    this.log(`waiting ${Math.round(ms / 1000)} s: ${why}`);
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (this.stopRequest()) break;
      await sleep(Math.min(5000, until - Date.now()));
    }
    this.s.waiting = null;
    this.s.state = 'running';
    this.save();
    return !!this.stopRequest();
  }

  private progress(): Progress {
    return { tables: this.s.progress.tables, startedAt: Date.parse(this.s.started_at), tokens: this.s.progress.tokens, usd: this.s.progress.usd };
  }

  async run(): Promise<void> {
    process.on('SIGTERM', () => void this.onSignal());
    process.on('SIGINT', () => void this.onSignal());
    this.log(`Keep Playing ${this.loop.id}: ${this.plan.table === 'lobby' ? 'the Lobby' : 'a Private Table'}, ${this.plan.set.toUpperCase()}, ${this.plan.seats.length} seat(s); limits: ${this.s.limits_text}`);
    this.save();
    // Every table plays best of 3 with sideboarding: a loop set up for best of 1 by an older kit stops here.
    const bestOfRefused = bestOfProblem(this.plan.bestOf);
    if (bestOfRefused) return this.finish('refused', `this loop was set up for best of ${this.plan.bestOf}. ${bestOfRefused} Set it up again with \`${BENCH} setup\`.`);
    for (;;) {
      const step = nextStep(this.progress(), this.plan.limits, this.per, Date.now(), this.stopRequest());
      if (!step.go) return this.finish(step.reason, step.text);
      // The cheap preflight again: a harness that signed out or lost its model ends the loop before it spends a table.
      if (!this.loop.skip_preflight) {
        const problems = await recheckPreflight(this.plan, { useApiKey: this.loop.use_api_key });
        if (problems.length) return this.finish('preflight_failed', `the preflight failed before table ${this.s.progress.tables + 1}: ${problems.join(' ')}`);
      }
      const n = this.s.tables.length + 1;
      let rec: TableRecord;
      try {
        rec = this.plan.table === 'lobby' ? await this.lobbyTable(n) : await this.privateTable(n);
      } catch (err) {
        const e = err instanceof ApiError ? err : new ApiError(0, (err as Error).message);
        this.s.current = null;
        // Refusals that waiting can't fix end the loop.
        if ([400, 401, 403, 404].includes(e.status)) return this.finish('refused', `the Director refused table ${n}: ${e.message}`);
        if (e.status === 429 || e.status === 503) {
          // Quotas (your daily limit, your concurrent tables) and server restarts: wait as long as the Director says.
          const ms = Math.max(30_000, (e.retryAfterS ?? (e.status === 503 ? 120 : 300)) * 1000);
          if (await this.wait(ms, `${e.status === 429 ? 'a limit on the hosted table' : 'the server is busy or restarting'}: ${e.message}`)) continue;
          continue;
        }
        this.s.failures++;
        if (this.s.failures >= MAX_FAILURES) return this.finish('errors', `${this.s.failures} errors in a row; the last: ${e.message}`);
        await this.wait(backoffMs(this.s.failures), `error ${this.s.failures} of ${MAX_FAILURES} in a row: ${e.message}`);
        continue;
      }
      this.s.current = null;
      if (rec.status === 'no_table') {
        this.s.tables.push(rec);
        this.s.failures++;
        if (this.s.failures >= MAX_FAILURES) return this.finish('errors', `${this.s.failures} tries in a row ended without a table: ${rec.note ?? ''}`);
        if (this.stopRequest()) continue;
        await this.wait(backoffMs(this.s.failures), `no table: ${rec.note ?? 'the queue ticket ended'}`);
        continue;
      }
      this.s.failures = rec.status === 'done' ? 0 : this.s.failures + 1;
      this.s.tables.push(rec);
      this.s.progress.tables++;
      this.s.progress.tokens += rec.tokens ?? 0;
      this.s.progress.usd = Math.round((this.s.progress.usd + (rec.usd ?? 0)) * 100) / 100;
      this.s.progress.estimated ||= !!rec.estimated;
      this.save();
      this.log(`table ${n} ${rec.status}: ${rec.event_id ?? ''} (${this.s.progress.tables} played; ${Math.round(this.s.progress.tokens / 1e6 * 10) / 10} M tokens, $${this.s.progress.usd})`);
      if (rec.status !== 'done' && this.s.failures >= MAX_FAILURES) return this.finish('errors', `${this.s.failures} tables in a row didn't finish`);
    }
  }

  private async onSignal(): Promise<void> {
    const cur = this.s.current;
    this.log('stop requested: stopping now');
    if (this.child?.pid) {
      try {
        process.kill(this.child.pid, 'SIGTERM');
      } catch {
        // already gone
      }
    }
    if (cur?.event_id && this.plan.table === 'private') await cancelEvent(this.plan, cur.event_id);
    if (cur?.ticket) await leaveTicket({ director: this.plan.base, ticket: cur.ticket });
    if (cur) {
      this.s.tables.push({ n: cur.n, event_id: cur.event_id, set: cur.set, status: 'canceled', started_at: new Date().toISOString(), ended_at: new Date().toISOString(), note: 'stopped at once (bench stop --now)' });
    }
    this.finish('stop_requested_now', 'you stopped it at once (bench stop --now)');
    process.exit(0);
  }

  /** Run a child CLI command (play, lobby join) in the foreground of the loop; resolves with its exit code. */
  private runChild(args: string[]): Promise<number | null> {
    return new Promise((done) => {
      const child = spawn(process.execPath, [...process.execArgv, process.argv[1]!, ...args], { stdio: ['ignore', 'inherit', 'inherit'], env: { ...env, BENCH_RUNS_DIR: RUNS } });
      this.child = child;
      if (this.s.current) this.s.current.pid = child.pid;
      this.save();
      child.on('exit', (code) => {
        this.child = undefined;
        done(code);
      });
      child.on('error', () => done(127));
    });
  }

  private async privateTable(n: number): Promise<TableRecord> {
    const p = this.plan;
    const set = setFor(n - 1, p.set, p.rotation);
    this.log(`table ${n}: creating a ${set.toUpperCase()} Private Table`);
    const created = await createEvent({
      base: p.base, set, seats: p.seats, knowledge: p.knowledge, mana: p.mana, bestOf: p.bestOf, podSize: p.seats.length,
      hosted: p.hosted, allowUnlisted: p.unlisted, continuous: true, throwOnError: true,
    });
    const id = created.ev.id;
    const rec: TableRecord = { n, event_id: id, set, status: 'running', started_at: new Date().toISOString() };
    this.s.current = { n, event_id: id, set };
    this.s.state = 'running';
    this.save();
    this.log(`table ${n}: event ${id} ${created.status === 'queued' ? `queued (position ${created.queuePosition ?? '?'})` : 'running'}; starting the seats`);
    writeFileSync(join(created.dir, 'loop.txt'), `${this.loop.id}\n`);
    // What `play` may start for each seat: this loop's confirmed plan (cli.ts checkLaunchSource).
    writeFileSync(join(created.dir, 'confirmation.json'), JSON.stringify({
      confirmation_code: this.loop.confirmation_code, launch: Object.fromEntries(p.seats.map((x) => [x.name, { harness: x.harness, model: x.model, effort: x.effort, ...(x.contextPolicy ? { context_policy: x.contextPolicy } : {}) }])),
    }, null, 1), { mode: 0o600 });
    const extra = [...(this.loop.relaunch ? ['--relaunch', this.loop.relaunch] : []), ...(this.loop.use_api_key ? ['--use-api-key'] : [])];
    const code = await this.runChild(['play', id, ...this.seatsHere.flatMap((x) => ['--seat', x]), ...extra]);
    // play returns when every seat is done or out of relaunches: wait for the event itself to end.
    const final = await this.waitEvent(id);
    rec.status = final.stage === 'done' ? 'done' : 'aborted';
    if (code !== 0 && rec.status === 'done') rec.note = `the seat launcher exited with ${code}`;
    rec.ended_at = new Date().toISOString();
    rec.standings = (final.standings ?? []).map((x: any) => ({ seat: x.name, matches: `${x.matchWins}-${x.matchLosses}`, games: `${x.gameWins}-${x.gameLosses}` }));
    this.usage(rec, created.dir, this.seatsHere);
    return rec;
  }

  private async waitEvent(id: string): Promise<any> {
    const token = this.plan.hosted ? contributorToken(undefined, this.plan.base) : undefined;
    const until = Date.now() + 10 * 3600_000;
    let last: any = { stage: 'unknown' };
    while (Date.now() < until) {
      const s = await eventStatus(this.plan.base, id, token);
      if (s) last = s;
      if (s && ['done', 'aborted', 'gone'].includes(String(s.stage))) return s;
      if (s && String(s.stage).startsWith('not running')) return s;
      await sleep(15_000);
    }
    return last;
  }

  private async lobbyTable(n: number): Promise<TableRecord> {
    const p = this.plan;
    const key = queueKeyOf(p.set, p.knowledge, p.mana);
    const ticketFile = join(dirOf(this.loop.id), 'ticket.json');
    rmSync(ticketFile, { force: true });
    const rec: TableRecord = { n, event_id: null, set: p.set, status: 'running', started_at: new Date().toISOString() };
    this.s.current = { n, event_id: null, set: p.set };
    this.s.state = 'running';
    this.save();
    this.log(`table ${n}: joining the ${key} queue with ${p.seats.length} seat(s)`);
    const args = [
      // A concrete effort only (scripted seats have none).
      'lobby', 'join', '--queue', key, ...p.seats.flatMap((x) => ['--seat', [x.harness, x.model, x.effort].filter((v) => v && v !== 'default' && v !== 'unknown').join('/')]),
      '--director', p.base, '--ticket-file', ticketFile, ...(this.loop.relaunch ? ['--relaunch', this.loop.relaunch] : []),
      // The confirmed context policy (setup.ts freshFlag): the default unless it was set otherwise.
      ...(freshFlag(p) ? ['--fresh-session', freshFlag(p)!] : []),
    ];
    // While the seats wait in the queue, a graceful stop leaves it (a seated table always plays to the end).
    const readTicket = () => {
      try {
        return existsSync(ticketFile) ? (JSON.parse(readFileSync(ticketFile, 'utf8')) as { ticket: string; director: string }) : undefined;
      } catch {
        return undefined; // half-written: the next tick reads it
      }
    };
    const watcher = setInterval(() => void (async () => {
      const t = readTicket();
      if (!t) return;
      if (this.s.current && !this.s.current.ticket) {
        this.s.current.ticket = t.ticket;
        this.save();
      }
      const v = await ticketView(t);
      // The table's event, once it fires (status, and stop --now's warning).
      const firedRaw = (v?.body?.tables ?? []).at(-1)?.event_id;
      let fired: string | undefined;
      try {
        fired = firedRaw ? eventIdFrom(firedRaw) : undefined;
      } catch {
        fired = undefined;
      }
      if (fired && this.s.current && this.s.current.event_id !== fired) {
        this.s.current.event_id = fired;
        this.save();
      }
      if (this.stopRequest() !== 'graceful') return;
      const seated = (v?.body?.entries ?? []).some((e: any) => e.status === 'seated');
      if (v?.status === 200 && !seated) {
        this.log('graceful stop while waiting in the queue: leaving it');
        await leaveTicket(t);
      }
    })().catch((err) => this.log(`lobby watcher: ${(err as Error).message}`)), 10_000);
    const code = await this.runChild(args);
    clearInterval(watcher);
    const t = readTicket();
    const v = t ? await ticketView(t) : undefined;
    const tables = (v?.body?.tables ?? []) as Array<{ event_id: string; stage: string; seats: Record<string, unknown> }>;
    rec.ended_at = new Date().toISOString();
    if (!tables.length) {
      rec.status = 'no_table';
      rec.note = !t ? `lobby join exited with ${code} before joining (see the log)` : this.stopRequest() ? 'left the queue (stop requested)' : String(v?.body?.notice ?? v?.body?.message ?? 'the ticket ended without a table');
      return rec;
    }
    const tb = tables[tables.length - 1]!;
    let eventId: string;
    try {
      eventId = eventIdFrom(tb.event_id);
    } catch (err) {
      rec.status = 'aborted';
      rec.note = (err as Error).message;
      return rec;
    }
    rec.event_id = eventId;
    rec.status = tb.stage === 'done' ? 'done' : 'aborted';
    const mine = Object.keys(tb.seats ?? {}).filter((n) => SEAT_NAME_RE.test(n) && !/^\.+$/.test(n));
    const token = contributorToken(undefined, p.base);
    const st = await eventStatus(p.base, eventId, token);
    rec.standings = (st?.standings ?? []).filter((x: any) => mine.includes(x.name)).map((x: any) => ({ seat: x.name, matches: `${x.matchWins}-${x.matchLosses}`, games: `${x.gameWins}-${x.gameLosses}` }));
    this.usage(rec, under(RUNS, eventId), mine);
    return rec;
  }

  /**
   * Tokens and cost per seat from the harness transcripts: the reported cost when every session reported one, else
   * priced per request at list price (estimated); the estimate's high end for a seat with no usage at all.
   */
  private usage(rec: TableRecord, dir: string, seats: string[]): void {
    rec.usage = [];
    let tokens = 0;
    let usd = 0;
    let estimated = false;
    const evFile = join(dir, 'event.json');
    const evJson = existsSync(evFile) ? JSON.parse(readFileSync(evFile, 'utf8')) : {};
    const meta = evJson.meta ?? {};
    for (const seat of seats) {
      const harness = meta[seat]?.harness;
      if (harnessFor(harness)?.test) continue;
      const file = under(dir, `transcript-${seat}.jsonl`);
      const u = existsSync(file) ? extractUsage(file, seat, harness) : undefined;
      const warn = u ? usageProblem(u) : null;
      if (warn) console.warn(`warning: seat ${seat}: ${warn}`);
      const reported = !!u && u.input_tokens + u.output_tokens + u.cache_read_tokens > 0;
      const input = reported ? u!.input_tokens + u!.cache_creation_tokens : this.est.per_seat.input[1]!;
      const output = reported ? u!.output_tokens : this.est.per_seat.output[1]!;
      const cost = reported ? seatUsd(u!, meta[seat]?.model, harness, evJson.created_at ?? Date.now()) : null;
      const est = !cost || cost.basis === 'estimated';
      rec.usage.push({ seat, input, cached: reported ? u!.cache_read_tokens : 0, output, usd: cost?.usd ?? null, estimated: est });
      tokens += input + output;
      usd += cost?.usd ?? this.est.per_seat.usd[1]!;
      estimated ||= est;
    }
    rec.tokens = tokens;
    rec.usd = Math.round(usd * 100) / 100;
    rec.estimated = estimated;
  }
}

async function cancelEvent(plan: Plan, id: string): Promise<void> {
  try {
    await api(plan.base, `/api/events/${id}`, { method: 'DELETE', admin: true, as: plan.hosted ? 'contributor' : undefined });
  } catch {
    // best effort: the Director stops seats that never come back anyway
  }
}

// ---------------------------------------------------------------------------
// Commands

export async function cmdLoop(argv: string[]): Promise<void> {
  const [sub, id] = argv;
  if (sub === 'run' && id) {
    const r = readLoop(id) ?? die(`no loop ${id}`);
    await new Runner(r.loop).run();
    return;
  }
  if (sub === 'list' || !sub) {
    if (!printLoops()) console.log('No Keep Playing loops on this machine.');
    return;
  }
  die('usage: bench status [<loop id>] · bench stop <loop id> [--now]');
}

const progressLine = (s: Summary | undefined) => {
  if (!s) return 'starting';
  const l = s.limits;
  const parts = [
    `${s.progress.tables}${l.tables != null ? `/${l.tables}` : ''} table${s.progress.tables === 1 && l.tables == null ? '' : 's'}`,
    `${s.progress.hours} h${l.hours != null ? `/${l.hours} h` : ''}`,
    `${Math.round(s.progress.tokens / 1e5) / 10} M tokens${l.tokens != null ? `/${Math.round(l.tokens / 1e5) / 10} M` : ''}`,
    `$${s.progress.usd}${l.usd != null ? `/$${l.usd}` : ''}${s.progress.estimated ? ' (partly estimated)' : ''}`,
  ];
  return parts.join(', ');
};

export function printLoops(): boolean {
  const loops = listLoops();
  if (!loops.length) return false;
  console.log('Keep Playing on this machine:');
  for (const { loop, summary: s, running } of loops.slice(0, 10)) {
    const state = running ? (s?.state === 'waiting' ? `waiting (${s.waiting?.why ?? ''})` : s?.current ? `table ${s.current.n}${s.current.event_id ? ` ${s.current.event_id}` : ' (in the queue)'}` : s?.state ?? 'running')
      : `stopped${s?.stop_text ? `: ${s.stop_text}` : ''}`;
    console.log(`  ${loop.id}  ${loop.plan.table === 'lobby' ? 'Lobby' : 'Private Table'} ${loop.plan.set.toUpperCase()}  ${state}`);
    console.log(`      ${progressLine(s)}${s?.limits_text && s.limits_text !== 'none' ? `; limits: ${s.limits_text}` : ''}`);
  }
  console.log('');
  return true;
}

export function printLoop(id: string, json = false): void {
  const r = readLoop(id) ?? die(`no loop ${id} on this machine`);
  const s = r.summary;
  if (json) return console.log(JSON.stringify(s ?? {}, null, 1));
  const running = aliveLoop(r.loop.pid, id) && s?.state !== 'stopped';
  console.log(`${id}: Keep Playing, ${r.loop.plan.table === 'lobby' ? 'the Lobby' : 'a Private Table'}, ${r.loop.plan.set.toUpperCase()}${r.loop.plan.rotation.length > 1 ? ` (sets rotate ${r.loop.plan.rotation.map((x) => x.toUpperCase()).join(' → ')})` : ''}`);
  console.log(`  State:    ${running ? s?.state ?? 'running' : `stopped${s?.stop_text ? `: ${s.stop_text}` : ''}`}${s?.waiting ? `, until ${s.waiting.until}: ${s.waiting.why}` : ''}`);
  console.log(`  Progress: ${progressLine(s)}`);
  console.log(`  Limits:   ${s?.limits_text ?? 'none'}`);
  for (const t of s?.tables ?? []) {
    const res = (t.standings ?? []).map((x) => `${x.seat} ${x.matches}`).join(', ');
    console.log(`  ${String(t.n).padStart(3)}. ${t.event_id ?? '(no table)'}  ${t.set.toUpperCase()}  ${t.status}${res ? `  ${res}` : ''}${t.tokens ? `  ${Math.round(t.tokens / 1e5) / 10} M tokens` : ''}${t.usd ? `  $${t.usd}${t.estimated ? ' est.' : ''}` : ''}${t.note ? `  (${t.note})` : ''}`);
  }
  if (s?.current) console.log(`  Now:      table ${s.current.n}${s.current.event_id ? `, event ${s.current.event_id} (${BENCH} status ${s.current.event_id})` : ', waiting in the queue'}`);
  console.log(`  Files:    ${tilde(dirOf(id))} (summary.json, loop.log)`);
  if (running) console.log(`  Stop:     ${BENCH} stop ${id}  (after the current table)  ·  ${BENCH} stop ${id} --now`);
}

export async function stopLoop(id: string, now: boolean): Promise<void> {
  const r = readLoop(id) ?? die(`no loop ${id} on this machine`);
  const running = aliveLoop(r.loop.pid, id) && r.summary?.state !== 'stopped';
  writeFileSync(stopFile(id), now ? 'now' : 'graceful');
  if (!running) {
    console.log(`${id} isn't running${r.summary?.stop_text ? ` (stopped: ${r.summary.stop_text})` : ''}.`);
    return;
  }
  if (!now) {
    console.log(`${id}: stopping after the current table${r.loop.plan.table === 'lobby' ? ' (seats still waiting in the queue leave it now)' : ''}. Nothing new starts.`);
    console.log(`  \`${BENCH} stop ${id} --now\` stops at once instead.`);
    return;
  }
  if (r.loop.plan.table === 'lobby' && r.summary?.current?.event_id) {
    console.log(`Warning: your seats at the running table stop playing. The watchdog forfeits them after 10 minutes: they count as abandoned in your reliability and earn no seat points.`);
  }
  process.kill(r.loop.pid!, 'SIGTERM');
  for (let i = 0; i < 20 && aliveLoop(r.loop.pid, id); i++) await sleep(500);
  console.log(`${id}: stopped${r.loop.plan.table === 'private' && r.summary?.current?.event_id ? `; event ${r.summary.current.event_id} was canceled (nothing from it is scored)` : ''}.`);
}
