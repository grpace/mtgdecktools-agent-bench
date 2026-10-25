/**
 * `bench lobby`: the matchmaking lobby from the command line (docs/LOBBY.md §3).
 *
 *   bench lobby list                        open queues, scheduled tables, recent tables
 *   bench lobby join --set fra --seat claude-code/claude-opus-5-5/high [--seat …]
 *   bench lobby join --queue fra-primer-manual --seat …    or  --schedule fra-weekly --seat …
 *   bench lobby status                      your tickets
 *   bench lobby leave [ticket]              leave (every saved ticket by default)
 *
 * `join` holds your place with a long-poll (no model runs and no tokens are spent while you wait), confirms ready
 * checks, and when your table fires, starts your seats with `bench play <event>` (the usual headless launcher).
 *
 * What starts is what you joined with (trust.ts): the ticket file keeps your seats' harness, model and effort, and
 * a fired table whose seats aren't among them is refused. The Director only supplies the event id and the seat URLs,
 * both checked before use.
 *
 * Context policy (rotation.ts): the model seats this command starts get a fresh agent session per game unless
 * `--fresh-session per-match|off` says otherwise; the policy is declared with each seat at join, recorded in the
 * fired table's event_start, and `bench play` rotates the sessions. Seats you start yourself (`--no-launch`) keep one
 * session. Scripted players keep one too unless you pass `--fresh-session` (tests).
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { bestOfProblem } from '../../packages/director/src/best-of.js';
import { CONCRETE_EFFORTS, resolveSeat as resolveDeclared } from '../../packages/registry/src/index.js';
import { BENCH, CONFIG_DIR, HOSTED_DIRECTOR_URL, RUNS, contributorToken, die, env, isLoopback, requireTls, sleep, trustedOrigin } from './core.js';
import { assignSeats, eventIdFrom, printable, under, type LocalSeat } from './trust.js';
import { harnessFor, installedVersion } from './harnesses.js';
import { normalizeKnowledge } from './setup.js';
import { DEFAULT_FRESH_SESSION, FRESH_SESSION_MODES, isFreshSession, policyOfMode, type FreshSession } from './rotation.js';

const TICKETS = join(CONFIG_DIR, 'lobby-tickets');
const EFFORTS: string[] = [...CONCRETE_EFFORTS, 'default'];

function directorOf(flag?: string): string {
  const base = (flag ?? env.BENCH_DIRECTOR ?? HOSTED_DIRECTOR_URL).replace(/\/+$/, '');
  if (!/^https?:\/\//.test(base)) die(`--director must be a URL (got ${base})`);
  return base;
}

/** The token for joining: the saved one only goes to the hosted Director (core.ts contributorToken). */
function token(base: string, flag?: string): string {
  const t = contributorToken(flag, base);
  if (t) return t;
  return die(trustedOrigin(base) ? `not signed in: run \`${BENCH} login\` (GitHub sign-in) to get a contributor token`
    : `${base} isn't the hosted Director: give the token it issued you with --token (or BENCH_TOKEN); your saved contributor token only goes to the hosted Director and Hub`);
}

/** Write a private file whole or not at all (a reader never sees half of it). */
function writeAtomic(file: string, text: string): void {
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, file);
}

async function call(base: string, path: string, init: RequestInit & { auth?: string; timeoutMs?: number } = {}): Promise<{ status: number; body: any }> {
  const headers = new Headers(init.headers);
  if (init.auth) headers.set('Authorization', `Bearer ${init.auth}`);
  if (init.body) headers.set('Content-Type', 'application/json');
  const res = await fetch(`${base}${path}`, { ...init, headers, signal: AbortSignal.timeout(init.timeoutMs ?? 30_000) });
  const text = await res.text();
  let body: any = text;
  try {
    body = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: res.status, body };
}

/** "harness/model/effort": a model id may contain slashes; the last part is the effort only when it's an effort word. */
export function parseSeat(spec: string): { harness: string; model?: string; effort?: string } {
  const parts = spec.trim().split('/').map((p) => p.trim()).filter(Boolean);
  const harness = parts.shift();
  if (!harness) die(`--seat: expected harness/model/effort, got "${spec}"`);
  const effort = parts.length >= 2 && EFFORTS.includes(parts[parts.length - 1]!.toLowerCase()) ? parts.pop() : undefined;
  return { harness: harness!, ...(parts.length ? { model: parts.join('/') } : {}), ...(effort ? { effort } : {}) };
}

/**
 * The context policy a lobby seat joins with (rotation.ts): the mode for seats this machine starts (`play`), none for
 * seats started by hand (`--no-launch`) or with a harness that isn't installed here. Scripted players have no context
 * to lose, so they get it only when `--fresh-session` was given (`explicit`: rotation tests).
 */
export function lobbySeatPolicy(harness: string, mode: FreshSession, o: { launch: boolean; explicit: boolean; installed?: (id: string) => boolean }): LocalSeat['context_policy'] {
  const h = harnessFor(harness);
  const policy = policyOfMode(mode);
  if (!policy || !o.launch || !h?.launch || (h.test && !o.explicit)) return undefined;
  return (o.installed ?? ((id) => !!installedVersion(harnessFor(id)!)))(h.id) ? policy : undefined;
}

/** A seat as this machine will start it: the registry's canonical harness, model and effort (what `play` launches). */
export function localSeat(x: { harness: string; model?: string; effort?: string }): LocalSeat {
  const r = resolveDeclared({ harness: x.harness, model: x.model, effort: x.effort }, { allowUnlisted: false });
  if (!r.ok) return die(`--seat ${[x.harness, x.model, x.effort].filter(Boolean).join('/')}: ${r.error}`);
  return {
    harness: r.seat.harness, ...(r.seat.model ? { model: r.seat.model } : {}), ...(r.seat.effort ? { effort: r.seat.effort } : {}),
    ...(r.hosted && x.model ? { launch_model: x.model } : {}),
  };
}

// ---------------------------------------------------------------------------
// Saved tickets (~/.config/mtgdt-bench/lobby-tickets/<prefix>.json, mode 600: a ticket confirms and leaves for you)

interface SavedTicket {
  ticket: string;
  director: string;
  queue: string;
  joined_at: string;
  /** The seats this ticket joined with, canonical: the only seats `play` may start for its tables. */
  seats?: LocalSeat[];
}

function saveTicket(t: SavedTicket): void {
  mkdirSync(TICKETS, { recursive: true, mode: 0o700 });
  if (!/^[\w-]{8,}$/.test(t.ticket)) die('the Director sent a ticket that isn\'t one');
  writeAtomic(join(TICKETS, `${t.ticket.slice(0, 8)}.json`), JSON.stringify(t, null, 1));
}

function savedTickets(prefix?: string): SavedTicket[] {
  if (!existsSync(TICKETS)) return [];
  return readdirSync(TICKETS).filter((f) => f.endsWith('.json') && (!prefix || f.startsWith(prefix.slice(0, 8))))
    .flatMap((f) => {
      try {
        return [JSON.parse(readFileSync(join(TICKETS, f), 'utf8')) as SavedTicket];
      } catch {
        return [];
      }
    });
}

function forgetTicket(t: SavedTicket): void {
  rmSync(join(TICKETS, `${t.ticket.slice(0, 8)}.json`), { force: true });
}

// ---------------------------------------------------------------------------
// Notifications (client-side only: the server never calls out)

function notifier(opts: { desktop: boolean; webhook?: string }) {
  return async (type: string, text: string, extra: Record<string, unknown> = {}) => {
    console.log(`[${new Date().toLocaleTimeString()}] ${text}`);
    if (opts.desktop) {
      // The text goes in as an argument, never into AppleScript source (it contains the Director's words).
      const r = process.platform === 'darwin'
        ? spawnSync('osascript', ['-e', 'on run argv', '-e', 'display notification (item 1 of argv) with title "MTG Deck Tools Lobby"', '-e', 'end run', printable(text, 300)], { timeout: 5_000 })
        : spawnSync('notify-send', ['--', 'MTG Deck Tools Lobby', printable(text, 300)], { timeout: 5_000 });
      void r;
    }
    if (opts.webhook) {
      try {
        await fetch(opts.webhook, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(10_000),
          body: JSON.stringify({ type, text, at: new Date().toISOString(), ...extra }),
        });
      } catch (err) {
        console.warn(`webhook failed: ${(err as Error).message}`);
      }
    }
  };
}

// ---------------------------------------------------------------------------
// Commands

async function lobbyList(argv: string[]) {
  const { values } = parseArgs({ args: argv, options: { director: { type: 'string' }, json: { type: 'boolean' } } });
  const base = directorOf(values.director);
  const { status, body } = await call(base, '/api/lobby').catch((err) => die(`cannot reach ${base}: ${(err as Error).message}`));
  if (status !== 200) die(`${status} ${body?.error ?? JSON.stringify(body)}`);
  if (values.json) return console.log(JSON.stringify(body, null, 1));
  // The Director's words, for a terminal: each line without control characters.
  const out = (x = '') => console.log(x.split('\n').map((l) => printable(l, 400)).join('\n'));
  const p = body.policy;
  out(`Lobby on ${base}${body.director.paused ? '  (paused: server restarting)' : ''}`);
  out(`Tables seat ${p.seats_per_table} agents (at most ${p.max_seats_per_contributor} per contributor) and play a ${p.format.rounds}-round Swiss.\n`);
  out('Open Tables');
  if (!body.queues.length) out('  none yet: start one with `lobby join`');
  for (const q of body.queues) {
    out(`  ${q.key.padEnd(28)} ${q.set_name} · ${q.knowledge_label} · ${q.mana === 'manual' ? 'Manual' : 'Auto'} Mana · Best of 3`);
    const models = q.seats.map((s: any) => `${s.model_display} (${s.harness_display})`).join(', ');
    out(`  ${''.padEnd(28)} Table ${q.seats_filled}/${q.seats_per_table}${q.status === 'ready_check' ? ', ready check' : q.seats_needed ? `, waiting for ${q.seats_needed} more` : ''}${models ? `: ${models}` : ''}`);
  }
  if (body.scheduled.length) {
    out('\nScheduled Tables');
    for (const s of body.scheduled) out(`  ${s.id.padEnd(20)} ${s.name}: ${new Date(s.starts_at).toLocaleString()} (${s.state}, ${s.rsvps} signed up) → --schedule ${s.id}`);
  }
  if (body.recent.length) {
    out('\nRecent Tables');
    for (const t of body.recent.slice(0, 8)) out(`  ${t.event_id}  ${t.stage.padEnd(8)} ${t.seats.map((s: any) => s.model_display).join(', ')}`);
  }
  out(`\nJoin:  ${BENCH} lobby join --queue <key> --seat <harness>/<model>/<effort>`);
}

/** A legacy queue key for another best-of (`fra-primer-manual-bo1`): why it can't be joined. `-bo3` keys still work. */
export function queueBestOfProblem(key: string | undefined): string | undefined {
  const bo = /-bo(\d+)$/i.exec(key ?? '');
  return bo ? bestOfProblem(bo[1]) : undefined;
}

async function lobbyJoin(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      queue: { type: 'string' }, set: { type: 'string' }, knowledge: { type: 'string', default: 'primer' }, mana: { type: 'string', default: 'manual' },
      // Fixed at 3 (best of 3 with sideboarding); kept so `--best-of 3` still works, anything else is refused.
      'best-of': { type: 'string' }, schedule: { type: 'string' }, seat: { type: 'string', multiple: true },
      'hide-handle': { type: 'boolean' }, notify: { type: 'boolean' }, webhook: { type: 'string' }, 'no-launch': { type: 'boolean' },
      'no-auto-confirm': { type: 'boolean' }, detach: { type: 'boolean' }, relaunch: { type: 'string', default: '3' },
      director: { type: 'string' }, token: { type: 'string' }, ticket: { type: 'string' }, 'fresh-session': { type: 'string' },
      // Keep Playing (loop.ts): where to write the new ticket, so the loop can leave the queue for a graceful stop.
      'ticket-file': { type: 'string' },
    },
  });
  const bestOfRefused = bestOfProblem(values['best-of']) ?? queueBestOfProblem(values.queue);
  if (bestOfRefused) die(values['best-of'] && bestOfProblem(values['best-of']) ? `--best-of ${values['best-of']}: ${bestOfRefused}` : `--queue ${values.queue}: ${bestOfRefused}`);
  const base = directorOf(values.director);
  requireTls(base);
  const explicit = values['fresh-session'];
  if (explicit != null && !isFreshSession(explicit)) die(`--fresh-session: ${FRESH_SESSION_MODES.join(', ')}`);
  if (explicit && explicit !== 'off' && values['no-launch']) die('--fresh-session is for seats this command starts; with --no-launch you start them yourself and each keeps one session');
  const fresh: FreshSession = (explicit as FreshSession | undefined) ?? DEFAULT_FRESH_SESSION;
  if (values.webhook && !/^https:\/\//.test(values.webhook) && !isLoopback(values.webhook)) die('--webhook must be an https:// URL');
  if (values.detach) {
    // Run the same command in the background, logging to a file.
    mkdirSync(RUNS, { recursive: true, mode: 0o700 });
    const log = join(RUNS, `lobby-${Date.now()}.log`);
    const fd = openSync(log, 'a', 0o600);
    const args = [...process.execArgv, process.argv[1]!, 'lobby', 'join', ...argv.filter((a) => a !== '--detach')];
    const child = spawn(process.execPath, args, { detached: true, stdio: ['ignore', fd, fd], env: { ...env, BENCH_RUNS_DIR: RUNS } });
    child.unref();
    console.log(`Holding your place in the background (pid ${child.pid}). Log: ${log}`);
    console.log(`Check with \`${BENCH} lobby status\`; leave with \`${BENCH} lobby leave\`.`);
    return;
  }
  const notify = notifier({ desktop: !!values.notify, webhook: values.webhook });
  let saved: SavedTicket;
  if (values.ticket) {
    saved = savedTickets(values.ticket)[0] ?? die(`no saved ticket ${values.ticket}`);
  } else {
    // The effort is set at launch when this command starts the seats (`bench play`), else declared by the person.
    const typed = (values.seat ?? []).map(parseSeat);
    const seats = typed.map((x) => ({ ...x, effort_basis: values['no-launch'] ? 'self-report' : 'launch' }));
    if (!seats.length) die('add 1–3 seats: --seat claude-code/claude-opus-5-5/high (harness/model/effort)');
    // Kept with the ticket: what this machine may start when a table fires (never the Director's account of it).
    let local = typed.map(localSeat).map((x) => {
      const policy = lobbySeatPolicy(x.harness, fresh, { launch: !values['no-launch'], explicit: explicit != null });
      return policy ? { ...x, context_policy: policy } : x;
    });
    const target = values.schedule ? { schedule: values.schedule }
      : values.queue ? { queue: values.queue }
        : values.set ? { set: values.set, knowledge: normalizeKnowledge(values.knowledge) ?? die('--knowledge: none, primer (Set Context) or primer+stats (Set Context + Human Stats)'), mana: values.mana }
          : die('which queue? --queue <key>, --set <code> [--knowledge --mana], or --schedule <id> (see `lobby list`)');
    const { status, body } = await call(base, '/api/lobby/join', {
      method: 'POST', auth: token(base, values.token),
      body: JSON.stringify({ ...target, seats: seats.map((x, i) => ({ ...x, ...(local[i]!.context_policy ? { context_policy: local[i]!.context_policy } : {}) })), ...(values['hide-handle'] ? { show_handle: false } : {}) }),
    }).catch((err) => die(`cannot reach ${base}: ${(err as Error).message}`));
    if (status !== 201) die(`${status} ${printable(body?.error ?? JSON.stringify(body), 500)}`);
    // A Director that doesn't record context policies (older builds: no context_policy on the entries) would label
    // rotated seats as one conversation: those seats play with one session.
    const echoed = Array.isArray(body.entries) && body.entries.length === local.length && body.entries.every((e: any) => typeof e?.context_policy === 'string');
    if (local.some((x) => x.context_policy) && !echoed) {
      console.warn("note: this Director doesn't record context policies yet, so your seats will keep one agent session each");
      local = local.map(({ context_policy, ...x }) => (void context_policy, x));
    }    saved = { ticket: String(body.ticket), director: base, queue: printable(body.queue, 80), joined_at: new Date().toISOString(), seats: local };
    saveTicket(saved);
    if (values['ticket-file']) writeAtomic(values['ticket-file'], JSON.stringify(saved));
    console.log(printable(`Joined ${body.queue}${body.schedule ? ` (scheduled table ${body.schedule.id}, starts ${new Date(body.schedule.starts_at).toLocaleString()})` : ''} with ${body.entries.length} seat(s):`, 300));
    for (const e of body.entries) console.log(printable(`  ${e.model_display} · ${e.harness_display} · ${e.effort}   (${e.entry_id}, place ${e.position ?? '-'})`, 300));
    const rotated = local.find((x) => x.context_policy)?.context_policy;
    if (rotated) console.log(`Sessions: each ${rotated === 'fresh-per-game' ? 'game' : 'match'} starts a fresh agent session to keep costs down; every decision carries the full board and match history.`);
    console.log(`Ticket ${body.ticket.slice(0, 8)}… saved. Your seats wait at no cost: nothing runs and no tokens are used until your table fills.`);
    console.log('Keep this running: it confirms the ready check and starts your agents. Ctrl-C leaves the queue.\n');
  }
  await hold(saved, { notify, autoConfirm: !values['no-auto-confirm'], launch: !values['no-launch'], relaunch: values.relaunch! });
}

/** The holding loop: long-poll the ticket, confirm ready checks, launch seats when tables fire. */
async function hold(saved: SavedTicket, o: { notify: ReturnType<typeof notifier>; autoConfirm: boolean; launch: boolean; relaunch: string }): Promise<void> {
  const base = saved.director;
  const path = `/api/lobby/tickets/${saved.ticket}`;
  const children = new Map<string, ChildProcess>();
  const launched = new Set<string>();
  const stages = new Map<string, string>();
  /** Event ids the Director sent that aren't ones; declared seats already given to a table of this ticket. */
  const refused = new Set<string>();
  const claimed = new Set<number>();
  let rev: number | undefined;
  let lastMessage = '';
  let failures = 0;
  let stopping = false;
  const onSignal = async (sig: NodeJS.Signals) => {
    if (stopping) process.exit(130);
    stopping = true;
    console.log('\nLeaving the queue (seats already at a table keep playing until you stop their harness)…');
    await call(base, path, { method: 'DELETE', timeoutMs: 10_000 }).catch(() => undefined);
    for (const c of children.values()) c.kill(sig);
    process.exit(130);
  };
  process.on('SIGINT', () => void onSignal('SIGINT'));
  process.on('SIGTERM', () => void onSignal('SIGTERM'));

  for (;;) {
    let view: any;
    const asked = Date.now();
    try {
      const q = rev == null ? '' : `?rev=${rev}&wait=40`;
      const r = await call(base, path + q, { timeoutMs: 60_000 });
      // Only the Director's own (JSON) 404 means the ticket is gone; the proxy's while it restarts is retried below.
      if (r.status === 404 && r.body && typeof r.body === 'object') {
        console.log('This ticket is no longer known to the Director (it ended more than a day ago).');
        forgetTicket(saved);
        break;
      }
      if (r.status !== 200) throw new Error(`${r.status} ${r.body?.error ?? ''}`);
      view = r.body;
      failures = 0;
    } catch (err) {
      // The Director restarting or a network blip: keep the place, retry (the server keeps the queue).
      failures++;
      if (failures === 1 || failures % 10 === 0) console.warn(`lobby: ${(err as Error).message}; retrying (your place is kept)`);
      await sleep(Math.min(30_000, 2_000 * failures));
      continue;
    }
    // Past the Director's long-poll caps (lobby-http.ts MAX_WAITS_PER_TICKET, MAX_WAITS) it answers at once with nothing
    // new: wait a little instead of asking again in a tight loop (LAUNCH-CHECKLIST C-7).
    if (rev != null && view.rev === rev && Date.now() - asked < 2_000) await sleep(5_000);
    rev = view.rev;
    const msg = printable(`${view.message}${view.notice ? ` ${view.notice}` : ''}`, 500);
    if (msg !== lastMessage) {
      lastMessage = msg;
      if (view.state === 'ready_check') await o.notify('ready_check', `Ready check: ${printable(view.message, 300)}`);
      else console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);
    }
    if (view.state === 'ready_check' && view.ready_check && !view.ready_check.confirmed) {
      if (o.autoConfirm || (await askYes(`Your table is full. Take your seat${view.entries.length > 1 ? 's' : ''}? [Y/n] `))) {
        const r = await call(base, `${path}/confirm`, { method: 'POST', body: JSON.stringify({ table_id: view.ready_check.table_id }) }).catch((err) => ({ status: 0, body: { error: (err as Error).message } }));
        console.log(r.status === 200 ? 'Confirmed.' : `Could not confirm: ${r.body?.error ?? r.status}`);
        rev = undefined;
      }
      continue;
    }
    for (const t of view.tables ?? []) {
      // The event id names a folder: checked before anything uses it (a bad one is skipped, not trusted).
      let eventId: string;
      try {
        eventId = eventIdFrom(t?.event_id);
      } catch (err) {
        if (!refused.has(String(t?.event_id))) console.warn(`lobby: ${(err as Error).message}; ignoring that table`);
        refused.add(String(t?.event_id));
        continue;
      }
      const liveUrl = printable(t.live_url, 300);
      const prev = stages.get(eventId);
      if (prev !== t.stage) {
        stages.set(eventId, String(t.stage));
        if (!prev) await o.notify('table_fired', `Your table fired: event ${eventId}${t.queue_position ? ` (waiting for capacity, position ${Number(t.queue_position)})` : ''}.`, { event_id: eventId, table_id: printable(t.table_id, 40), live_url: liveUrl });
        else if (t.stage === 'games') await o.notify('games_started', `Your agents' games have started (${eventId}). Watch: ${liveUrl}`, { event_id: eventId, live_url: liveUrl });
        else if (t.stage === 'done' || t.stage === 'aborted') await o.notify('event_finished', `Event ${eventId} ${t.stage === 'done' ? 'finished' : 'was stopped'}. ${BENCH} status ${eventId}`, { event_id: eventId });
      }
      if (launched.has(eventId)) continue;
      const seats = Object.entries((t.seats ?? {}) as Record<string, { url: string | null }>);
      if (!seats.length || seats.some(([, x]) => !x?.url)) continue;
      launched.add(eventId);
      // Which of the seats you joined with sat down: anything else is refused, and what starts is your own seat.
      const a = saved.seats ? assignSeats(t.seats, base, saved.seats, claimed) : { ok: false as const, error: 'this ticket was saved by an older version of the CLI, without your seats' };
      if (!a.ok) {
        await o.notify('table_refused', `Not starting seats for ${eventId}: ${a.error}. Leave the table (\`${BENCH} lobby leave\`) or seat it by hand if you trust it.`, { event_id: eventId });
        continue;
      }
      const dir = under(RUNS, eventId);
      mkdirSync(RUNS, { recursive: true, mode: 0o700 });
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(join(dir, 'event.json'), JSON.stringify({
        id: eventId, director: base, created_at: new Date().toISOString(), hosted: true, lobby: { table_id: printable(t.table_id, 40), queue: saved.queue },
        // meta: the seats you joined with (meta_source "local"); `bench play` refuses lobby records without it.
        meta_source: 'local',
        seats: Object.fromEntries(a.seats.map((x) => [x.name, x.url])), meta: Object.fromEntries(a.seats.map((x) => [x.name, { ...x.local }])),
      }, null, 1), { mode: 0o600 });
      if (!o.launch) {
        console.log(`Seat URLs for ${eventId} (secret) are in ${join(dir, 'event.json')}. Seat them by hand: ${BENCH} seats ${dir}`);
        continue;
      }
      console.log(`Starting ${a.seats.length} seat(s) for ${eventId}: ${BENCH} play ${dir}`);
      const child = spawn(process.execPath, [...process.execArgv, process.argv[1]!, 'play', dir, '--relaunch', o.relaunch], {
        stdio: 'inherit', env: { ...env, BENCH_RUNS_DIR: RUNS },
      });
      children.set(eventId, child);
      child.on('exit', () => children.delete(eventId));
    }
    const finished = (view.tables ?? []).every((t: any) => ['done', 'aborted', 'unknown'].includes(t.stage));
    if (view.state === 'done' || (view.state === 'seated' && finished && !(view.entries ?? []).some((e: any) => ['waiting', 'ready_check', 'confirmed'].includes(e.status)))) {
      if (!children.size) {
        // The server says why (seats that expired unseated get the command to join again).
        console.log(view.state === 'done' && typeof view.message === 'string' ? view.message : 'Nothing left on this ticket.');
        forgetTicket(saved);
        break;
      }
      await sleep(10_000);
      rev = undefined;
      continue;
    }
    if (!(view.entries ?? []).some((e: any) => ['waiting', 'ready_check', 'confirmed'].includes(e.status))) {
      // Only seated entries left: poll the event stages slowly (the ticket's rev doesn't change with them).
      await sleep(20_000);
      rev = undefined;
    }
  }
  await Promise.all([...children.values()].map((c) => new Promise((r) => c.on('exit', r))));
}

async function askYes(q: string): Promise<boolean> {
  if (!process.stdin.isTTY) return true;
  process.stdout.write(q);
  return new Promise((done) => {
    process.stdin.once('data', (d) => done(!/^n/i.test(String(d).trim())));
  });
}

async function lobbyStatus(argv: string[]) {
  const { values } = parseArgs({ args: argv, options: { json: { type: 'boolean' } } });
  const list = savedTickets();
  if (!list.length) return console.log(`No lobby tickets saved on this machine. Join with \`${BENCH} lobby join\`.`);
  for (const t of list) {
    const r = await call(t.director, `/api/lobby/tickets/${t.ticket}`).catch((err) => ({ status: 0, body: { error: (err as Error).message } }));
    if (values.json) {
      console.log(JSON.stringify({ ticket: t.ticket.slice(0, 8), ...r.body }, null, 1));
      continue;
    }
    if (r.status === 404) {
      console.log(`${t.ticket.slice(0, 8)}  ${t.queue}: ended (forgotten)`);
      forgetTicket(t);
      continue;
    }
    if (r.status !== 200) {
      console.log(printable(`${t.ticket.slice(0, 8)}  ${t.queue}: ${r.body?.error ?? r.status}`, 300));
      continue;
    }
    const v = r.body;
    console.log(printable(`${t.ticket.slice(0, 8)}  ${t.queue}  ${v.state}: ${v.message}`, 500));
    const sessions = (p: unknown) => (p === 'fresh-per-game' ? ', fresh session per game' : p === 'fresh-per-match' ? ', fresh session per match' : '');
    for (const e of v.entries ?? []) console.log(printable(`    ${e.model_display} · ${e.harness_display} · ${e.effort}${sessions(e.context_policy)}: ${e.status}${e.position ? ` (place ${e.position})` : ''}`, 300));
    for (const tb of v.tables ?? []) console.log(printable(`    table ${tb.event_id}: ${tb.stage}  ${tb.live_url}`, 400));
  }
}

async function lobbyLeave(argv: string[]) {
  const { positionals } = parseArgs({ args: argv, allowPositionals: true, options: {} });
  const list = savedTickets(positionals[0]);
  if (!list.length) return console.log(positionals[0] ? `No saved ticket ${positionals[0]}.` : 'No lobby tickets saved on this machine.');
  for (const t of list) {
    const r = await call(t.director, `/api/lobby/tickets/${t.ticket}`, { method: 'DELETE' }).catch((err) => ({ status: 0, body: { error: (err as Error).message } }));
    console.log(`${t.ticket.slice(0, 8)}  ${t.queue}: ${r.status === 200 ? 'left the queue (seats already at a table keep playing)' : r.status === 404 ? 'already ended' : `${r.body?.error ?? r.status}`}`);
    if (r.status === 200 || r.status === 404) {
      const seated = r.status === 200 && (r.body.entries ?? []).some((e: any) => e.status === 'seated');
      if (!seated) forgetTicket(t);
    }
  }
}

/** A ticket's holder view (GET /api/lobby/tickets/<ticket>), or undefined when the Director can't be reached. */
export async function ticketView(t: { director: string; ticket: string }): Promise<{ status: number; body: any } | undefined> {
  return call(t.director, `/api/lobby/tickets/${t.ticket}`).catch(() => undefined);
}

/** Leave the queue (the ticket's waiting entries; seated ones keep playing). */
export async function leaveTicket(t: { director: string; ticket: string }): Promise<number> {
  const r = await call(t.director, `/api/lobby/tickets/${t.ticket}`, { method: 'DELETE' }).catch(() => ({ status: 0 }));
  return r.status;
}

export const LOBBY_HELP = `Join the Lobby: bring 1–3 agents; we seat you with other people's agents and start when 8 are ready (docs/LOBBY.md)
  lobby list    [--director url] [--json]               open tables, scheduled tables, recent tables
  lobby join    --set fra | --queue <key> | --schedule <id>   --seat harness/model/effort (1–3)
                [--knowledge primer] [--mana manual] [--hide-handle] [--notify] [--webhook url]
                [--no-launch] [--no-auto-confirm] [--detach]   holds your place at no cost, then starts your seats
                [--fresh-session per-game|per-match|off]   seats started here: a fresh agent session per game
                                                           (default) or match, or one session (off); recorded
  lobby status                                          your tickets
  lobby leave   [ticket]                                leave the queue`;

export async function cmdLobby(argv: string[]): Promise<void> {
  const [sub, ...rest] = argv;
  const subs: Record<string, (a: string[]) => Promise<void>> = { list: lobbyList, join: lobbyJoin, status: lobbyStatus, leave: lobbyLeave };
  if (!sub || sub === 'help' || sub === '--help') return console.log(LOBBY_HELP);
  if (!subs[sub]) die(`unknown lobby command "${sub}"\n\n${LOBBY_HELP}`);
  await subs[sub]!(rest);
}
