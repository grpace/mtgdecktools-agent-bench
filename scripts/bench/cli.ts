/**
 * mtgdt-bench: the contributor CLI. Run an event on your own harnesses and share the results.
 *
 *   bench setup                     guided: choose the table, set, seats and knowledge; creates the event and starts the seats
 *   bench check                     what this machine has (Node, sign-in, harnesses) and what you can choose (sets, knowledge)
 *   bench login                     contributor token (GitHub device flow) for hosted play and submissions
 *   bench new / seats / play        the same steps one at a time
 *   bench status / stop             follow or stop an event, or a Keep Playing loop
 *   bench pull / bundle / submit    results of an event on your own table
 *   bench up / down                 run your own table (phase-server + Director, Docker or Podman)
 *
 * `bench` is `npm --prefix ~/mtgdt-bench run -s bench --` from a git clone (`npm run bench --` inside it); the CLI is never
 * installed from npm. See docs/COMMUNITY.md.
 */
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { BEST_OF, bestOfProblem } from '../../packages/director/src/best-of.js';
import { buildBundle, type BuiltBundle } from '../../packages/director/src/bundle.js';
import { unpackTarGz, validateBundle } from '../../packages/director/src/submissions.js';
import { extractUsage, seatUsd, usageProblem, type SeatUsage } from '../../packages/director/src/usage.js';
import {
  BENCH, COMMANDS, DEFAULT_HUB_URL, DOCS, HOSTED_DIRECTOR_URL, JOIN_PROMPT, joinPromptFile, LOCAL, RANDOM_AGENT, REPO, RUNS, SETUP_PROMPT, TABLE_SEATS, VERSION, api, checkSeat, contributorToken, statusToken,
  createEvent, die, DIRECTOR_DOWN_MAX_MS, directorToken, directorUrl, env, eventDir, eventStatus, fmtTokens, seatStateAt, hubUrl, isLoopback, jsonOrDie, kitVersion, loadEvent,
  lockFile, loginStart, tryJson, loginWait, pendingLogin, playPid, readIf, rel, requireTls, shPath, shq, signOut, sleep, tilde, tokenFile, waitWhileQueued, type LocalEvent,
} from './core.js';
import {
  LAUNCHABLE, expandSeatSpecs, finishSeat, harnessFor, installedVersion, prepareSeat, removeHarnessProject, removeSeatDirs, seatDirs, seatEnv, seatNames, type Seat, type SeatSpec,
} from './harnesses.js';
import { SEAT_NAME_RE, printable, under } from './trust.js';
import { effortChoice, launchFor, resolveSeat } from './models.js';
import { saveEffortRecord } from './preflight.js';
import { cmdCheck, cmdSetup, MODE_TEXT, normalizeKnowledge, TABLE_TEXT } from './setup.js';
import { cmdLobby, LOBBY_HELP } from './lobby.js';
import { cmdAttachLogs } from './attach.js';
import { handedToHub, readByPlay, uploadHostedUsage } from './usage-upload.js';
import { cmdLoop, LOOP_ID_RE, printLoop, printLoops, stopLoop } from './loop.js';
import { account as signedInAs } from './core.js';
import { consentBeforeLogin, ensureTerms, finishLogin } from './consent.js';
import { DEFAULT_FRESH_SESSION, endSession, FRESH_SESSION_MODES, isFreshSession, policyOfMode, progressUrl, seatMode, SessionRotation, startKey, type FreshSession } from './rotation.js';

// ---------------------------------------------------------------------------
// Commands

async function cmdNew(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      set: { type: 'string', default: 'fra' },
      seat: { type: 'string', multiple: true },
      knowledge: { type: 'string', default: 'primer' },
      mana: { type: 'string', default: 'manual' },
      seed: { type: 'string' },
      // Fixed at 3 (best of 3 with sideboarding); kept so `--best-of 3` still works, anything else is refused.
      'best-of': { type: 'string' },
      director: { type: 'string' },
      token: { type: 'string' },
      hosted: { type: 'boolean' },
      'unlisted-model': { type: 'boolean' },
      'allow-downgrade': { type: 'boolean' },
      'fresh-session': { type: 'string' },
    },
  });
  const bestOfRefused = bestOfProblem(values['best-of']);
  if (bestOfRefused) die(`--best-of ${values['best-of']}: ${bestOfRefused}`);
  // Given explicitly, scripted seats get it too (rotation tests); by default only the model seats.
  const explicitFresh = values['fresh-session'] != null;
  const fresh = values['fresh-session'] ?? DEFAULT_FRESH_SESSION;
  if (!isFreshSession(fresh)) die(`--fresh-session: ${FRESH_SESSION_MODES.join(', ')}`);
  let specs: SeatSpec[] = [];
  try {
    specs = expandSeatSpecs(values.seat ?? []);
  } catch (e) {
    die((e as Error).message);
  }
  if (specs.length < 1) die(`add the seats: --seat "4x claude-code/claude-opus-5-5/high" --seat "4x codex/gpt-6-astra/medium" ([count x] [name=]harness/model/effort; ${TABLE_SEATS} in all)`);
  if (specs.length !== TABLE_SEATS) {
    die(`a table has ${TABLE_SEATS} agent seats; you gave ${specs.length}. Repeat models with a count ("4x claude-code/claude-opus-5-5/high"), or bring 1 to 4 seats to the lobby: \`${BENCH} setup --lobby\`. Scripted seats ("script/random") fill a table for tests.`);
  }
  specs = specs.map((s) => {
    const r = resolveSeat(s, { allowUnlisted: !!values['unlisted-model'] });
    if (!r.ok) return die(r.error);
    for (const w of r.warnings) console.warn(`note: ${w}`);
    // A concrete effort per seat: a level the harness takes for the model, or "unknown" for a seat started by hand.
    const c = effortChoice(r.seat.harness!, r.seat.model);
    if (c.settable && !r.seat.effortUnknown && ((!s.declared?.effort && !r.seat.effortFromName) || !c.levels.includes(r.seat.effort!))) {
      die(`${s.declared?.harness ?? r.seat.harness}/${s.declared?.model ?? r.seat.model}: which effort? ${c.levels.join(', ')} (recommended: ${c.recommended}: ${c.why}), or "unknown" for a seat you start by hand and don't know the setting of`);
    }
    if (!c.settable && !r.test) r.seat.effort = 'default'; // the registry records the harness's documented level
    // How the effort is known: set at launch when `bench play` can start this harness here, else declared by you.
    const h = harnessFor(r.seat.harness);
    if (c.settable && !r.seat.effortUnknown) r.seat.effortBasis = h?.launch && installedVersion(h) ? 'launch' : 'self-report';
    // A context policy is a launch condition: only for model seats `bench play` starts (a seat seated by hand keeps
    // its own; scripted players have no context, so only when --fresh-session is given, for tests).
    const policy = policyOfMode(fresh as FreshSession);
    if (policy && h?.launch && (!h.test || explicitFresh)) r.seat.contextPolicy = policy;
    return r.seat;
  });
  const names = seatNames(specs, (m) => console.warn(`note: ${m}`));
  const seats = specs.map((s, i) => ({ ...s, name: names[i]! }));
  const knowledge = normalizeKnowledge(values.knowledge) ?? die('--knowledge: none, primer (Set Context) or primer+stats (Set Context + Human Stats)');
  const base = directorUrl(values.director);
  const hosted = values.hosted || directorToken(base, values.token).contributor;
  for (const [i, s] of seats.entries()) {
    if (hosted) checkSeat(s, i);
    else if (!s.harness || !s.model) console.warn(`warning: seat ${s.name} has no harness/model; leaderboard entries need "name=harness/model/effort"`);
  }
  if (hosted && values.seed) die('the hosted table chooses the seed (a known seed would reveal the packs); drop --seed');
  const c = await createEvent({
    base, set: values.set!, seats, knowledge, mana: values.mana!, bestOf: BEST_OF, podSize: TABLE_SEATS, seed: values.seed, token: values.token, hosted,
    allowUnlisted: !!values['unlisted-model'], allowDowngrade: !!values['allow-downgrade'],
  });
  const { ev } = c;
  // No seed here (it stays secret until the event ends; `bench status` shows it then).
  console.log(`event ${ev.id}  (set ${ev.set}${ev.knowledge ? `, knowledge ${ev.knowledge}` : ''}, mana ${ev.mana})`);
  if (c.status === 'queued') {
    console.log(`queued: position ${c.queuePosition ?? '?'}. The table is full; the event starts on its own when one frees up.`);
    console.log('The seat URLs below work now: connect your agents and they wait until it starts.');
  }
  if (c.primer) console.log(`Set Context: ${c.primer.from} (sha256 ${String(c.primer.sha256).slice(0, 12)})`);
  for (const [name, url] of Object.entries(ev.seats)) console.log(`  seat ${name.padEnd(16)} ${url}`);
  console.log(`\nSeat URLs saved to ${rel(join(c.dir, 'event.json'))} (private: anyone with a URL can play that seat).`);
  console.log(`Next:  ${BENCH} play ${ev.id}      (start the seats this machine can run)`);
  console.log(`  or:  ${BENCH} seats ${ev.id}     (how to seat each one by hand)`);
}

function cmdSeats(argv: string[]) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { harness: { type: 'string' } } });
  const ev = loadEvent(eventDir(positionals[0]));
  for (const [name, url] of Object.entries(ev.seats)) {
    const m = ev.meta[name] ?? {};
    const h = harnessFor(values.harness ?? m.harness) ?? harnessFor('generic')!;
    console.log(`\n=== seat ${name}: ${[m.harness, m.model, m.effort].filter(Boolean).join(' / ') || 'no metadata'}  [${h.label}]`);
    console.log(h.snippet({ name, url, ...m }));
    if (h.launch && !h.test) console.log(`# or start it headless on this machine:  ${BENCH} play ${ev.id} --seat ${name}`);
    if (m.effort && m.effort !== 'default') console.log(`# effort: ${h.effortNote}`);
  }
  console.log(`\nEach seat: an MCP server named "mtg" (Streamable HTTP) with the seat URL, a new session with only the mtg tools,`);
  console.log(`and the join prompt as the first message (\`${BENCH} prompt\` prints it; file: ${tilde(JOIN_PROMPT)}). It plays until EVENT COMPLETE.`);
  console.log(`One session per seat. See ${DOCS}HARNESSES.md.`);
  console.log(`\nWhen your seats finish: \`${BENCH} attach-logs ${ev.id}\` reads your harness's session logs (after asking) to verify each seat's model and effort.`);
}

async function cmdPlay(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv, allowPositionals: true,
    options: {
      seat: { type: 'string', multiple: true }, 'dry-run': { type: 'boolean' }, 'use-api-key': { type: 'boolean' }, prompt: { type: 'string' },
      relaunch: { type: 'string', default: '3' }, 'fresh-session': { type: 'string' },
    },
  });
  const dir = eventDir(positionals[0]);
  const ev = loadEvent(dir);
  const maxRelaunch = Math.max(0, Number(values.relaunch) || 0);
  const promptFile = values.prompt ? joinPromptFile(values.prompt) : JOIN_PROMPT;
  const prompt = readFileSync(promptFile, 'utf8');
  if (values.prompt) console.warn('warning: custom join prompt: results from this run are not comparable with leaderboard runs');
  const names = values.seat?.length ? values.seat : Object.keys(ev.seats);
  const seats: Seat[] = names.map((n) => (ev.seats[n] ? { name: n, url: ev.seats[n]!, ...(ev.meta[n] ?? {}) } : die(`no seat "${n}" in event ${ev.id}`)));
  checkLaunchSource(dir, ev, seats);
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  const plans = seats.map((s) => {
    const h = harnessFor(s.harness);
    if (!h?.launch) die(`seat ${s.name} uses "${s.harness ?? '?'}", which isn't started from the command line. Seat it by hand: ${BENCH} seats ${ev.id}`);
    // Every seat started here runs at an explicit effort level when its harness takes one (registry launchSpec).
    const c = effortChoice(h!.id, s.model);
    const spec = launchFor(h!.id, s.model, s.effort, s.launch_model);
    if (c.settable && !spec.settable) {
      die(`seat ${s.name} has no effort level its harness takes (${s.effort ?? 'none'}), so it can't be started with an explicit one. ${h!.label} takes ${c.levels.join(', ')} for this model; create the event with one, or seat it by hand: ${BENCH} seats ${ev.id}`);
    }
    const launchAs = { ...s, model: spec.model };
    const opts = { useApiKey: values['use-api-key'], randomAgent: RANDOM_AGENT, effortArgs: spec.args };
    // Fresh sessions at game or match boundaries: the seat's declared context policy (rotation.ts).
    const m = seatMode(s.context_policy, values['fresh-session']);
    if ('error' in m) return die(`seat ${s.name}: ${m.error}`);
    // `launch` (placeholder folders) is for --dry-run and the version check; `make` builds it for real folders.
    return { seat: s, h: h!, fresh: m.mode, launch: h!.launch!(launchAs, prompt, opts), make: (ctx: { home: string; work: string }) => h!.launch!(launchAs, prompt, { ...opts, ctx }) };
  });

  if (values['dry-run']) {
    for (const p of plans) {
      console.log(`\n# seat ${p.seat.name} (${p.h.label}); runs in a fresh empty temp dir (<seat-dir>), with its config in <seat-config>`);
      if (p.h.isolation?.level === 'partial') console.log(`# isolation: partial: ${p.h.isolation.note}`);
      if (p.fresh !== 'off') console.log(`# fresh session ${p.fresh}: the session is ended and started again when the deck is locked and after every ${p.fresh === 'per-game' ? 'game' : 'match'}`);
      for (const [f, c] of Object.entries(p.launch.files)) console.log(`# file <seat-dir>/${f}:\n${c.replace(/^/gm, '#   ')}`);
      for (const [f, c] of Object.entries(p.launch.homeFiles ?? {})) console.log(`# file <seat-config>/${f}:\n${c.replace(/^/gm, '#   ')}`);
      for (const [f, t] of Object.entries(p.launch.links ?? {})) console.log(`# link <seat-config>/${f} -> ${tilde(t)} (if it exists)`);
      for (const [k, v] of Object.entries(p.launch.env)) console.log(v == null ? `unset ${k}` : `export ${k}=${shq(v)}`);
      console.log([p.launch.cmd, ...p.launch.args.map((a) => (a === prompt ? `"$(cat ${shPath(promptFile)})"` : shq(a)))].join(' '));
    }
    return;
  }

  const children: Array<ReturnType<typeof spawn>> = [];
  // Each seat's running harness session, and since when the Director has called that seat done.
  const running = new Map<string, ReturnType<typeof spawn>>();
  const doneSince = new Map<string, number>();
  const base = directorBase(ev, seats[0]);
  // A seat with no games left gets its final answer at once (EVENT COMPLETE, "you can stop now"); a session that
  // keeps going anyway is stopped after a grace period, so it doesn't spend tokens waiting for the event to end.
  const doneWatch = setInterval(async () => {
    if (!running.size) return;
    const st = await eventStatus(base, ev.id);
    const now = Date.now();
    for (const a of (st?.agents ?? []) as Array<{ name: string; status: string }>) {
      const child = running.get(a.name);
      if (a.status !== 'done' || !child) continue;
      if (!doneSince.has(a.name)) doneSince.set(a.name, now);
      if (now - doneSince.get(a.name)! < DONE_SESSION_GRACE_MS) continue;
      console.log(`seat ${a.name}: done on the Director, but its session is still running ${Math.round(DONE_SESSION_GRACE_MS / 60_000)} minutes later: stopping it (pid ${child.pid})`);
      running.delete(a.name);
      endSession(child);
    }
  }, 30_000);
  doneWatch.unref();
  const forward = (sig: NodeJS.Signals) => children.forEach((c) => c.exitCode == null && c.signalCode == null && c.kill(sig));
  // Sessions still being cleaned up (sign-in copied back, session record saved, the seat's folders and its harness
  // project folder removed): a signal waits for them, so a stopped `play` leaves nothing behind.
  const cleanups = new Set<Promise<void>>();
  let stopping = false;
  const stop = async (sig: NodeJS.Signals, code: number) => {
    if (stopping) return;
    stopping = true;
    console.log(`play: ${sig}: stopping the seats' sessions and cleaning up`);
    forward(sig);
    const kill = setTimeout(() => forward('SIGKILL'), 15_000);
    await Promise.race([Promise.all([...cleanups]), sleep(25_000)]);
    clearTimeout(kill);
    rmSync(join(dir, 'play.pid'), { force: true });
    process.exit(code);
  };
  process.on('SIGINT', () => void stop('SIGINT', 130));
  process.on('SIGTERM', () => void stop('SIGTERM', 143));

  // One harness session per seat; a session that exits before the seat's EVENT COMPLETE is relaunched (seats
  // resume: the Director keeps their state). Transcripts and harness logs are appended to, so every session of
  // a seat is in one file.
  const runOnce = (seat: Seat, h: NonNullable<ReturnType<typeof harnessFor>>, plan: (typeof plans)[number], key: string | null) => new Promise<{ code: number | null; rotated: boolean }>((done) => {
    // Each session gets fresh private folders: an empty working directory and the harness's config for this seat.
    const ctx = seatDirs(seat.name);
    const launch = plan.make(ctx);
    prepareSeat(launch, ctx);
    const out = createWriteStream(under(dir, `transcript-${seat.name}.jsonl`), { flags: 'a', mode: 0o600 });
    const err = createWriteStream(under(dir, `harness-${seat.name}.log`), { flags: 'a', mode: 0o600 });
    const child = spawn(launch.cmd, launch.args, { cwd: ctx.work, env: seatEnv(process.env, launch.env, { harness: h.id, useApiKey: values['use-api-key'] }), stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    running.set(seat.name, child);
    child.stdout!.pipe(out);
    child.stderr!.pipe(err);
    console.log(`seat ${seat.name}: ${h.label} ${seat.model ?? ''} ${seat.effort ?? ''} → pid ${child.pid}`);
    // --fresh-session: end this session at the next boundary, between decide calls. SIGINT first, so the harness
    // writes its result line (the session's cost); SIGTERM and SIGKILL only if it doesn't exit (rotation.ts endSession).
    let cancelEnd: (() => void) | undefined;
    const rotation = new SessionRotation({
      url: progressUrl(seat.url), mode: plan.fresh, startKey: key,
      end: (p) => {
        console.log(`seat ${seat.name}: ${!p.games_finished ? 'deck locked' : plan.fresh === 'per-match' ? `match ${p.matches_finished} over` : `game ${p.games_finished} over`}: ending this session for a fresh one (--fresh-session ${plan.fresh}; pid ${child.pid})`);
        cancelEnd = endSession(child);
      },
    }).start();
    let cleaned!: () => void;
    const cleanup = new Promise<void>((r) => (cleaned = r));
    cleanups.add(cleanup);
    child.on('close', (code) => {
      rotation.stop();
      cancelEnd?.();
      if (running.get(seat.name) === child) running.delete(seat.name);
      // The harness's own session record shows the effort level it ran at (effort detection reads it).
      out.end(() => {
        try {
          finishSeat(launch, ctx);
          saveEffortRecord(h.id, under(dir, `transcript-${seat.name}.jsonl`), dir, seat.name, ctx.home);
          removeSeatDirs(ctx.root);
          removeHarnessProject(h.id, ctx.work);
        } finally {
          cleanups.delete(cleanup);
          cleaned();
          done({ code, rotated: rotation.rotated });
        }
      });
    });
  });

  // A queued event (the hosted table is at capacity) has no decision to offer yet: start no session until it begins.
  const queued = await waitWhileQueued(base, ev.id);
  if (queued === 'aborted' || queued === 'gone') die(`event ${ev.id} ended before it started (${queued}); see \`${BENCH} status ${ev.id}\``);

  const results = await Promise.all(plans.map(async (plan) => {
    const { seat, h, launch } = plan;
    const version = spawnSync(launch.cmd, ['--version'], { encoding: 'utf8', timeout: 20_000 });
    if (version.error) {
      console.error(`seat ${seat.name}: \`${launch.cmd}\` not found (${h.label} isn't installed). Install it, or seat it by hand: ${BENCH} seats ${ev.id}`);
      return { seat: seat.name, code: 127 as number | null };
    }
    const info = {
      seat: seat.name, harness: h.id, cmd: basename(launch.cmd), harness_version: (version.stdout || version.stderr).trim().split('\n')[0], model: seat.model, effort: seat.effort,
      ...(plan.fresh !== 'off' ? { fresh_session: plan.fresh } : {}), started_at: new Date().toISOString(),
    };
    let code: number | null = null;
    let launches = 0;
    let rotations = 0;
    let fresh = plan.fresh;
    for (;;) {
      launches++;
      // The boundary this session starts at, read before it starts (a Director without seat progress: rotation off).
      let key: string | null = null;
      if (fresh !== 'off') {
        const k = await startKey(progressUrl(seat.url), fresh);
        if (k === 'unsupported') {
          console.warn(`seat ${seat.name}: this Director doesn't report seat progress, so --fresh-session ${fresh} can't find game boundaries; the seat keeps one session`);
          fresh = 'off';
        } else key = k;
      }
      const r = await runOnce(seat, h, { ...plan, fresh }, key);
      code = r.code;
      if (r.rotated) rotations++;
      writeFileSync(under(dir, `harness-${seat.name}.json`), JSON.stringify({ ...info, finished_at: new Date().toISOString(), exit_code: code, launches, ...(rotations ? { rotations } : {}) }, null, 1), { mode: 0o600 });
      if (stopping) break;
      const { state, waited } = await seatState(ev, seat);
      if (state !== 'running') {
        if (state === 'gone') console.warn(`seat ${seat.name}: the Director doesn't know the event any more; not relaunching`);
        if (state === 'unreachable') {
          console.warn(`seat ${seat.name}: the Director hasn't answered for ${Math.round(DIRECTOR_DOWN_MAX_MS / 60_000)} minutes; not relaunching. When it's back, start the seat again: ${BENCH} play ${ev.id} --seat ${seat.name}`);
        }
        break;
      }
      // Ended on purpose at a boundary: start the fresh session at once (it doesn't count as a relaunch).
      if (r.rotated) {
        launches--;
        continue;
      }
      // The Director was restarting (a deploy) when the session gave up: that isn't the harness's fault, so the
      // relaunch is free.
      if (waited) {
        launches--;
        console.warn(`seat ${seat.name}: session exited (code ${code}) while the Director was restarting; it's back, so starting a new session`);
        continue;
      }
      if (launches > maxRelaunch) {
        console.warn(`seat ${seat.name}: session exited (code ${code}) before EVENT COMPLETE; no relaunches left (--relaunch ${maxRelaunch}). Its log: ${tilde(join(dir, `harness-${seat.name}.log`))}`);
        break;
      }
      console.warn(`seat ${seat.name}: session exited (code ${code}) before EVENT COMPLETE; relaunching (${launches}/${maxRelaunch})`);
      await sleep(5000);
    }
    return { seat: seat.name, code };
  }));

  for (const r of results) {
    const t = join(dir, `transcript-${r.seat}.jsonl`);
    const meta = ev.meta[r.seat] ?? {};
    const u = existsSync(t) ? extractUsage(t, r.seat, meta.harness) : undefined;
    console.log(`seat ${r.seat}: exit ${r.code}${u && u.lines ? `; ${u.model_ids.join(',') || 'model ?'}; ${fmtTokens(u)}${fmtCost(u, meta.model, meta.harness, ev.created_at)}` : ''}`);
    const warn = u ? usageProblem(u) : null;
    if (warn) console.warn(`  warning: seat ${r.seat}: ${warn}`);
  }
  clearInterval(doneWatch);
  // Hosted events: the Hub gets each seat's usage summary from here (the Director never sees harness logs). Seats
  // finish when their own last match ends, so the event may still be running: wait for it (no tokens are spent).
  if (handedToHub(ev)) {
    const end = await waitForEventEnd(base, ev);
    if (end === 'done') await uploadHostedUsage(dir, ev, results.map((r) => r.seat), { readBy: readByPlay() });
    else console.log(`The event ${end === 'aborted' ? 'was stopped' : 'is still running'}; send your seats' usage once it has ended with \`${BENCH} attach-logs ${ev.id}\`.`);
  }
  rmSync(join(dir, 'play.pid'), { force: true });
  console.log(handedToHub(ev)
    ? `\nDone. The hosted Director hands the event to the Hub when it ends, and the leaderboard picks it up from there: nothing to pull or bundle. \`${BENCH} status ${ev.id}\` shows the final standings.`
    : `\nNext: ${BENCH} status ${ev.id}  then  ${BENCH} pull ${ev.id} && ${BENCH} bundle ${ev.id}`);
}

/**
 * A seat's cost for a summary line: what the harness reported (every session), else the per-request estimate at list
 * price, labeled (packages/director/src/usage.ts seatUsd).
 */
function fmtCost(u: SeatUsage, model: string | undefined, harness: string | undefined, at: unknown): string {
  const c = seatUsd(u, model, harness, typeof at === 'number' || typeof at === 'string' ? at : Date.now());
  if (!c) return '';
  return `; $${c.usd.toFixed(2)}${c.basis === 'estimated' ? ` (estimated at list price${u.sessions_unreported ? `: ${u.sessions_unreported} of ${u.sessions ?? 1} sessions reported no cost` : ''})` : ''}`;
}

/** How long a session may keep running after the Director called its seat done (it was told to stop). */
const DONE_SESSION_GRACE_MS = 2 * 60_000;

/** The Director an event runs on. */
function directorBase(ev: LocalEvent, seat: Seat | undefined): string {
  return (ev.director ?? seat?.url.replace(/\/mcp\/.*$/, '') ?? directorUrl()).replace(/\/+$/, '');
}

/** Wait (polling the public status, no tokens spent) until a hosted event has ended: 'done', 'aborted' or 'timeout'. */
async function waitForEventEnd(base: string, ev: LocalEvent, maxMs = 4 * 3600_000): Promise<'done' | 'aborted' | 'timeout'> {
  const until = Date.now() + maxMs;
  let told = false;
  for (;;) {
    const s = await eventStatus(base, ev.id);
    const stage = String(s?.stage ?? '');
    if (stage === 'done') return 'done';
    if (stage === 'aborted' || stage === 'gone' || stage.startsWith('not running')) return 'aborted';
    if (Date.now() > until) return 'timeout';
    if (!told) {
      console.log(`Your seats are done; other matches are still being played. Waiting for the event to end to send your seats' usage to the Hub (no tokens are spent; Ctrl-C is safe: \`${BENCH} attach-logs ${ev.id}\` sends it later).`);
      told = true;
    }
    await sleep(30_000);
  }
}

/**
 * What starts a seat must come from this machine (trust.ts): the plan you confirmed, or the seats a lobby ticket joined
 * with. Seat names name files, so they must be plain; a lobby record must say its harness, model and effort are local
 * (older versions copied them from the Director); a confirmed setup must match what it starts.
 */
function checkLaunchSource(dir: string, ev: LocalEvent, seats: Seat[]): void {
  for (const s of seats) if (!SEAT_NAME_RE.test(s.name) || /^\.+$/.test(s.name)) die(`seat "${printable(s.name, 60)}": not a seat name this CLI starts`);
  const raw = existsSync(join(dir, 'event.json')) ? JSON.parse(readFileSync(join(dir, 'event.json'), 'utf8')) : {};
  if (raw.lobby && raw.meta_source !== 'local') {
    die(`${tilde(join(dir, 'event.json'))} was written by an older version of this CLI, which took each seat's harness, model and effort from the Director. Seat them by hand (\`${BENCH} seats ${ev.id}\`) or join again.`);
  }
  const file = join(dir, 'confirmation.json');
  if (!existsSync(file)) return;
  const launch = JSON.parse(readFileSync(file, 'utf8'))?.launch as Record<string, { harness?: string; model?: string; effort?: string; context_policy?: string; launch_model?: string }> | undefined;
  if (!launch) return;
  for (const s of seats) {
    const c = launch[s.name];
    if (c && (c.context_policy ?? '') !== (s.context_policy ?? '')) die(`seat ${s.name}: its context policy (${s.context_policy ?? 'none'}) isn't what you confirmed (${c.context_policy ?? 'none'}); not starting it`);
    if (!c || c.harness !== s.harness || c.model !== s.model || (c.effort ?? '') !== (s.effort ?? '') || (c.launch_model ?? '') !== (s.launch_model ?? '')) {
      die(`seat ${s.name}: ${[s.harness, s.model, s.effort].filter(Boolean).join('/')} isn't what you confirmed${c ? ` (${[c.harness, c.model, c.effort].filter(Boolean).join('/')})` : ''}; not starting it`);
    }
  }
}

/** Whether a seat has finished the event (core.ts seatStateAt: waits out a Director that is restarting). */
function seatState(ev: LocalEvent, seat: Seat): ReturnType<typeof seatStateAt> {
  return seatStateAt(directorBase(ev, seat), ev.id, seat.name);
}

async function cmdStatus(argv: string[]) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { director: { type: 'string' }, token: { type: 'string' }, json: { type: 'boolean' } } });
  if (positionals[0] && LOOP_ID_RE.test(positionals[0])) return printLoop(positionals[0], values.json);
  if (!positionals[0]) {
    const loops = printLoops();
    const base = directorUrl(values.director);
    // With loops listed, a Director that isn't running here is just a note (the loops may use the hosted one).
    if (loops && !(await tryJson(`${base}/health`, 5000))) return console.log(`No Director answering at ${base} (events: \`${BENCH} status <event>\`).`);
    const list = await jsonOrDie(await api(base, '/api/events'));
    if (!list.length) console.log('no events on this Director since it started');
    for (const e of list) console.log(printable(`${e.id}  ${String(e.stage).padEnd(6)}  ${(e.agents ?? []).map((a: any) => `${a.name}: ${a.status}`).join(', ')}`, 400));
    return;
  }
  const dir = eventDir(positionals[0]);
  const ev = existsSync(join(dir, 'event.json')) ? loadEvent(dir) : undefined;
  const base = directorUrl(values.director, ev);
  // The token this machine has for the event (admin or contributor): the organizer's full view, not the public one.
  const { token: tok, as } = statusToken(base, ev, values.token);
  if (tok) requireTls(base);
  const s = await jsonOrDie(await api(base, `/api/events/${basename(dir)}`, tok ? { headers: { Authorization: `Bearer ${tok}` } } : {}));
  // The Director's text, for a terminal: no control characters.
  for (const a of [...(s.agents ?? []), ...(s.standings ?? [])]) if (a && typeof a === 'object') a.name = printable(a.name, 40);
  if (s.abort_reason) s.abort_reason = printable(s.abort_reason, 300);
  console.log(`${s.id}: ${s.stage}${s.knowledge ? ` (knowledge ${s.knowledge}${s.seed ? `, seed ${s.seed}` : ''})` : ''}`);
  // A running event's public view leaves out standings and per-seat states (docs/LOBBY.md, LOB-5).
  if (s.standings_after) console.log(`  public view${tok ? ` (the ${as ?? 'given'} token isn't this event's organizer's)` : ''}: standings and seat details come when the event ends${tok ? '' : '; give the token that created it (--token) for the full status'}`);
  else if (tok && s.stage !== 'done' && s.stage !== 'aborted') console.log(`  organizer's view (${as ?? 'given'} token)`);
  if (s.stage === 'queued') console.log(`  queued: position ${s.queue_position ?? '?'}; it starts on its own when a table frees up`);
  if (s.stage === 'aborted' && s.abort_reason) console.log(`  stopped: ${s.abort_reason}`);
  for (const a of s.agents ?? []) console.log(`  ${a.name.padEnd(20)} ${a.status}`);
  if (s.standings?.length) {
    console.log('  standings:');
    for (const x of s.standings) console.log(`    ${x.name.padEnd(20)} matches ${x.matchWins}-${x.matchLosses}  games ${x.gameWins}-${x.gameLosses}`);
  }
  const pid = ev ? playPid(dir) : undefined;
  if (pid) console.log(`  seats on this machine: running (pid ${pid}; log ${tilde(join(dir, 'play.log'))})`);
  // Finished, with seats started by hand whose model and effort aren't verified yet: offer attach-logs.
  if (ev && (s.stage === 'done' || s.stage === 'aborted')) {
    const byHand = Object.keys(ev.seats).filter((n) => !existsSync(join(dir, `transcript-${n}.jsonl`)) && !existsSync(join(dir, `harness-logs-${n}.json`)));
    if (byHand.length) console.log(`  seats you started by hand (${byHand.join(', ')}): \`${BENCH} attach-logs ${ev.id}\` verifies their model and effort from your session logs (it asks first)`);
  }
}

async function cmdStop(argv: string[]) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { director: { type: 'string' }, token: { type: 'string' }, now: { type: 'boolean' } } });
  if (positionals[0] && LOOP_ID_RE.test(positionals[0])) return stopLoop(positionals[0], !!values.now);
  const dir = eventDir(positionals[0]);
  const ev = loadEvent(dir);
  const base = directorUrl(values.director, ev);
  const res = await api(base, `/api/events/${ev.id}`, { method: 'DELETE', admin: true, token: values.token, as: ev.hosted ? 'contributor' : undefined });
  const body = await res.json().catch(() => ({}));
  console.log(res.ok ? `event ${ev.id}: stopped on the Director` : `event ${ev.id}: the Director answered ${res.status} ${body.error ?? ''}`);
  const pid = playPid(dir);
  if (pid) {
    process.kill(pid, 'SIGTERM'); // playPid checked it is this event's `play`
    console.log(`stopped the seats on this machine (pid ${pid})`);
  }
}

async function cmdPull(argv: string[]) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { director: { type: 'string' }, token: { type: 'string' } } });
  const dir = eventDir(positionals[0]);
  const id = basename(dir);
  const ev = existsSync(join(dir, 'event.json')) ? loadEvent(dir) : undefined;
  const base = directorUrl(values.director, ev);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const f of ['events.jsonl', 'summary.json']) {
    const res = await api(base, `/api/events/${id}/files/${f}`, { admin: true, token: values.token, as: ev?.hosted ? 'contributor' : undefined });
    if (res.status === 404) {
      console.log(`${f}: not on the Director yet${f === 'summary.json' ? ' (event still running?)' : ''}`);
      continue;
    }
    if (!res.ok) die(`${f}: ${res.status} ${await res.text()}`);
    const buf = Buffer.from(await res.arrayBuffer());
    writeFileSync(join(dir, f), buf, { mode: 0o600 });
    console.log(`${f}: ${buf.length} bytes → ${rel(join(dir, f))}`);
  }
}

async function cmdBundle(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv, allowPositionals: true,
    options: { transcripts: { type: 'boolean' }, 'transcripts-dir': { type: 'string' }, out: { type: 'string' }, submitter: { type: 'string' } },
  });
  const dir = eventDir(positionals[0]);
  const id = basename(dir);
  for (const f of ['events.jsonl', 'summary.json']) if (!existsSync(join(dir, f))) die(`${rel(join(dir, f))} is missing: run \`${BENCH} pull ${id}\` once the event has finished`);
  let b: BuiltBundle;
  try {
    b = buildBundle(dir, {
      createdBy: kitVersion(), submitter: values.submitter, fullTranscripts: !!values.transcripts,
      transcriptsDir: values['transcripts-dir'] ? resolve(values['transcripts-dir']) : undefined,
    });
  } catch (e) {
    return die((e as Error).message);
  }
  for (const s of b.seats) {
    if (s.usage === 'none') console.log(`seat ${s.seat}: no transcript (${rel(s.transcriptPath)}): usage not reported`);
    else if (s.report) {
      const u = s.report;
      const decl = (b.start?.seats ?? []).find((x: any) => x?.name === s.seat);
      console.log(`seat ${s.seat}: ${u.format}; ${u.model_ids.join(', ') || 'model ?'}; ${fmtTokens(u)}${fmtCost(u, decl?.model_declared ?? decl?.model, decl?.harness, b.start?.t)}${u.complete ? '' : '; session did not finish'}`);
    }
  }
  const v = validateBundle(b.files, { allowedEngineDigests: [lockFile().digest] });
  report(v);
  if (!v.ok) process.exit(1);
  const out = resolve(values.out ?? join(RUNS, `${id}.bundle.tar.gz`));
  writeFileSync(out, b.gz);
  console.log(`\nbundle: ${rel(out)} (${(b.gz.length / 1024).toFixed(0)} KB, sha256 ${b.sha256.slice(0, 16)}…)`);
  console.log(values.transcripts ? 'Includes FULL harness transcripts (your agents\' reasoning and tool calls).' : 'Usage only: no prompts, reasoning or tool outputs from your harness. Add --transcripts to include them.');
  console.log(`Next: ${BENCH} submit ${rel(out)}`);
}

function cmdValidate(argv: string[]) {
  const { positionals } = parseArgs({ args: argv, allowPositionals: true, options: {} });
  const files = unpackTarGz(readFileSync(positionals[0] ?? die('give a bundle path')));
  const v = validateBundle(files, { allowedEngineDigests: [lockFile().digest] });
  console.log(`files: ${[...files.keys()].join(', ')}`);
  report(v);
  if (!v.ok) process.exit(1);
}

async function cmdSubmit(argv: string[]) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { to: { type: 'string' }, token: { type: 'string' } } });
  const path = positionals[0] ?? die(`give a bundle path (\`${BENCH} bundle <event>\` makes one)`);
  const gz = readFileSync(path);
  const v = validateBundle(unpackTarGz(gz), { allowedEngineDigests: [lockFile().digest] });
  if (!v.ok) {
    report(v);
    die('the bundle does not validate; not submitting');
  }
  const to = (values.to ?? env.BENCH_SUBMIT_URL ?? DEFAULT_HUB_URL).replace(/\/+$/, '');
  // BENCH_SUBMIT_TOKEN and .bench/submit-token are deprecated fallbacks (before `bench login` and BENCH_TOKEN).
  // The saved token only goes to the Hub that issued it (contributorToken); --token or BENCH_TOKEN go where you send them.
  const token = contributorToken(values.token, to) || env.BENCH_SUBMIT_TOKEN || (isLoopback(to) ? readIf(join(LOCAL, 'submit-token')) : '');
  if (!token) die(`no token for ${to}: run \`${BENCH} login\` (GitHub) for the hosted Hub, or give the token that Hub issued with --token. See ${DOCS}COMMUNITY.md`);
  requireTls(to);
  const res = await fetch(`${to}/api/submissions`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/gzip' }, body: gz })
    .catch((e) => die(`cannot reach ${to}: ${(e as Error).message}`));
  const body = await jsonOrDie(res);
  // The Hub answers with a status (ingested / held for review); the Director's interim endpoint stores directly.
  console.log(`${body.status ?? 'accepted'}: event ${body.id} as ${body.label} (submitter ${body.submitter})`);
  if (body.flags?.length) console.log(`flags: ${body.flags.join(', ')}`);
  for (const r of (body.reasons ?? []).filter((x: { severity: string }) => x.severity === 'hold')) console.log(`  held: ${r.code}: ${r.message}`);
  if (body.pack_regeneration) console.log(`pack regeneration: ${body.pack_regeneration.status} (${body.pack_regeneration.message})`);
  if (body.status_url) console.log(`status: curl -H "Authorization: Bearer $BENCH_TOKEN" ${body.status_url}`);
  if (body.report) console.log(`report data: ${body.report}`);
}

/**
 * Sign in with GitHub (device flow through the Hub). `login` shows a code and waits; agents whose shell can't show
 * output while a command runs use `login --start` (prints the link and code, exits) then `login --wait`.
 */
async function cmdLogin(argv: string[]) {
  const { values } = parseArgs({ args: argv, options: { hub: { type: 'string' }, start: { type: 'boolean' }, wait: { type: 'boolean' }, force: { type: 'boolean' }, 'accept-terms': { type: 'boolean' } } });
  const accept = values['accept-terms'];
  const saved = contributorToken();
  if (!values.force && !values.wait && saved) {
    console.log(`Already signed in (token in ${tilde(tokenFile())}). \`${BENCH} login --force\` signs in again; \`${BENCH} logout\` forgets the token.`);
    // The terms changed since you accepted them (or you never did): accept them here (consent.ts).
    if (!(await ensureTerms(signedInAs()?.hub ?? hubUrl(values.hub), saved, { accept }))) process.exitCode = 1;
    return;
  }
  if (values.wait) {
    const p = pendingLogin() ?? die(`no sign-in in progress (or its code expired): run \`${BENCH} login --start\``);
    await loginWait(p);
    await finishLogin(p.hub, readIf(tokenFile()));
  } else {
    const hub = hubUrl(values.hub);
    // The terms first: a short summary and the links, and an explicit yes (docs/legal/TERMS.md).
    await consentBeforeLogin(hub, { accept });
    const p = await loginStart(hub);
    if (values.start) {
      console.log(`Then run \`${BENCH} login --wait\`: it finishes as soon as the code has been entered.`);
      return;
    }
    console.log('(Keep this command running until it prints "Signed in".)');
    await loginWait(p);
    await finishLogin(p.hub, readIf(tokenFile()));
  }
  console.log(`Next: ${BENCH} setup`);
}

/** `bench terms [--accept]`: whether you accepted the current terms; shows them and asks (or records --accept). */
async function cmdTerms(argv: string[]) {
  const { values } = parseArgs({ args: argv, options: { hub: { type: 'string' }, accept: { type: 'boolean' } } });
  const token = contributorToken() ?? die(`not signed in: run \`${BENCH} login\` (it shows the terms before you sign in)`);
  const hub = signedInAs()?.hub ?? hubUrl(values.hub);
  if (await ensureTerms(hub, token, { accept: values.accept })) console.log(`You have accepted the current terms of ${hub}.`);
  else process.exitCode = 1;
}

function cmdPrompt(argv: string[]) {
  const { positionals } = parseArgs({ args: argv, allowPositionals: true, options: {} });
  const which = positionals[0] ?? 'join';
  const file = which === 'join' ? JOIN_PROMPT : which === 'setup' ? SETUP_PROMPT : die('`prompt join` (the seats\' first message) or `prompt setup` (for your coding agent)');
  process.stdout.write(readFileSync(file, 'utf8'));
}

// ---------------------------------------------------------------------------
// Self-hosting: compose (docker or podman), or plain container commands as a fallback

function has(cmd: string, args: string[]): boolean {
  const r = spawnSync(cmd, args, { stdio: 'ignore', timeout: 20_000 });
  return !r.error && r.status === 0;
}

function composeTool(engine?: string): string[] | undefined {
  const tries: string[][] = engine === 'podman' ? [['podman', 'compose'], ['podman-compose']] : engine === 'docker' ? [['docker', 'compose'], ['docker-compose']]
    : [['docker', 'compose'], ['podman', 'compose'], ['podman-compose'], ['docker-compose']];
  return tries.find((t) => has(t[0]!, [...t.slice(1), 'version']));
}

function phaseImage(): string {
  const lock = lockFile();
  return `${lock.image}@${lock.digest}`;
}

const needCheckout = (): string => REPO ?? die('running your own table needs a checkout of the repository: git clone https://github.com/grpace/mtgdecktools-agent-bench.git && cd mtgdecktools-agent-bench && npm ci && npm run up (or use the hosted table: `setup --hosted`)');

async function waitHealthy(url: string, seconds: number): Promise<boolean> {
  for (let i = 0; i < seconds; i += 3) {
    try {
      if ((await fetch(`${url}/health`, { signal: AbortSignal.timeout(3000) })).ok) return true;
    } catch {
      // not up yet
    }
    await sleep(3000);
  }
  return false;
}

async function cmdUp(argv: string[]) {
  const { values } = parseArgs({ args: argv, options: { engine: { type: 'string' }, plain: { type: 'boolean' }, port: { type: 'string' } } });
  const root = needCheckout();
  const compose = join(root, 'deploy/compose.local.yaml');
  const port = values.port ?? env.BENCH_PORT ?? '8787';
  mkdirSync(LOCAL, { recursive: true, mode: 0o700 });
  chmodSync(LOCAL, 0o700);
  const hadToken = !!readIf(join(LOCAL, 'admin-token'));
  const tag = spawnSync('git', ['describe', '--always', '--dirty', '--exclude', '*'], { cwd: root, encoding: 'utf8' }).stdout?.trim() || 'local';
  const childEnv = { ...process.env, BENCH_PORT: port, PHASE_IMAGE: phaseImage(), DIRECTOR_TAG: env.DIRECTOR_TAG ?? tag };
  const tool = values.plain ? undefined : composeTool(values.engine);
  if (tool) {
    console.log(`$ ${tool.join(' ')} -f deploy/compose.local.yaml up -d --build`);
    const r = spawnSync(tool[0]!, [...tool.slice(1), '-f', compose, 'up', '-d', '--build'], { stdio: 'inherit', env: childEnv, cwd: root });
    if (r.status !== 0) die(`compose failed (exit ${r.status}). Try \`${BENCH} up --plain\` (plain ${values.engine ?? 'podman/docker'} commands).`);
  } else {
    const engine = values.engine ?? (has('podman', ['--version']) ? 'podman' : has('docker', ['--version']) ? 'docker' : die('need Docker or Podman'));
    console.log(`no compose provider found${values.plain ? ' (or --plain)' : ''}: using plain \`${engine}\` commands`);
    for (const { args, mayFail } of plainCommands(engine!, port, childEnv.DIRECTOR_TAG)) {
      console.log(`$ ${args.map(shq).join(' ')}`);
      const r = spawnSync(args[0]!, args.slice(1), { stdio: mayFail ? 'ignore' : 'inherit', cwd: root });
      if (r.status !== 0 && !mayFail) die(`command failed (exit ${r.status})`);
    }
  }
  const url = `http://127.0.0.1:${port}`;
  console.log(`waiting for the Director at ${url} (first start downloads card data, a minute or two)…`);
  if (!(await waitHealthy(url, 600))) die('the Director did not become healthy; check the container logs');
  const token = readIf(join(LOCAL, 'admin-token'));
  console.log(`\nDirector up at ${url}  (report data: ${url}/data/index.json)`);
  if (!hadToken && token) console.log(`Admin token (generated now, saved in .bench/admin-token, shown once): ${token}`);
  console.log(`Create an event:  ${BENCH} setup --local`);
}

/** The compose stack as plain container commands (for hosts without a compose provider). */
function plainCommands(engine: string, port: string, tag: string): Array<{ args: string[]; mayFail?: boolean }> {
  const net = 'mtgdt-bench';
  return [
    [engine, 'build', ...(engine === 'podman' ? ['--format', 'docker'] : []), '-t', 'mtgdt-director:local', '.'], // docker format keeps the HEALTHCHECK
    { args: [engine, 'network', 'create', net], mayFail: true }, // exists already: fine
    { args: [engine, 'rm', '-f', 'mtgdt-bench-phase', 'mtgdt-bench-director'], mayFail: true },
    [engine, 'run', '-d', '--name', 'mtgdt-bench-phase', '--network', net, '--network-alias', 'phase-server', '--restart', 'unless-stopped',
      '-v', 'mtgdt-bench-phase-data:/var/lib/phase-server', phaseImage()],
    [engine, 'run', '-d', '--name', 'mtgdt-bench-director', '--network', net, '--restart', 'unless-stopped',
      '-p', `127.0.0.1:${port}:8787`,
      '-e', 'PHASE_SERVER_URL=ws://phase-server:9374/ws', '-e', `DIRECTOR_TAG=${tag}`, '-e', `PUBLIC_URL=${env.PUBLIC_URL ?? `http://127.0.0.1:${port}`}`,
      '-e', 'ADMIN_TOKEN_FILE=/app/.bench/admin-token', '-e', 'ADMIN_TOKEN_HOST_PATH=.bench/admin-token',
      '-e', 'SUBMIT_TOKENS_FILE=/app/.bench/submit-tokens', '-e', 'SITE_DATA_DIR=/app/site-data',
      '-v', 'mtgdt-bench-phase-data:/phase-data:ro', '-v', 'mtgdt-bench-runs:/app/runs', '-v', 'mtgdt-bench-cache:/app/cache',
      '-v', `${LOCAL}:/app/.bench:z`, 'mtgdt-director:local'],
  ].map((x) => (Array.isArray(x) ? { args: x } : x));
}

function cmdDown(argv: string[]) {
  const { values } = parseArgs({ args: argv, options: { engine: { type: 'string' }, plain: { type: 'boolean' } } });
  const root = needCheckout();
  const tool = values.plain ? undefined : composeTool(values.engine);
  if (tool) {
    spawnSync(tool[0]!, [...tool.slice(1), '-f', join(root, 'deploy/compose.local.yaml'), 'down'], { stdio: 'inherit', cwd: root, env: { ...process.env, PHASE_IMAGE: phaseImage() } });
  } else {
    const engine = values.engine ?? (has('podman', ['--version']) ? 'podman' : 'docker');
    spawnSync(engine, ['rm', '-f', 'mtgdt-bench-director', 'mtgdt-bench-phase'], { stdio: 'inherit' });
  }
  console.log('stopped (volumes kept: runs and card data survive; event logs stay on the Director until you pull them)');
}

// ---------------------------------------------------------------------------

function report(v: ReturnType<typeof validateBundle>) {
  console.log(v.ok ? `\nvalid: event ${v.eventId}, agents ${v.agents.join(', ')}` : '\nINVALID bundle:');
  for (const e of v.errors) console.log(`  error: ${e}`);
  for (const f of v.flags) console.log(`  flag:  ${f}`);
  for (const w of v.warnings) console.log(`  note:  ${w}`);
}

const HELP = `mtgdt-bench ${VERSION}: run MTG Deck Tools Agent Benchmark events with your own agents.

Start here
  setup                     the setup wizard: the table, Play One Table or Keep Playing, hosted or your own machine,
                            set, seats (harness / model / effort), knowledge; checks each harness it will start, then a
                            Confirmation of what the leaderboard will record. Nothing starts before you confirm.
                              Private Table:  ${TABLE_TEXT.private}
                              Join the Lobby: ${TABLE_TEXT.lobby}
                              Play One Table: ${MODE_TEXT.once}
                              Keep Playing:   ${MODE_TEXT.continuous}
          [--agent [--answers JSON|file] [--confirm code]]   the same wizard as JSON, for a coding agent (prompts/setup.md)
          [--private | --lobby] [--hosted | --local] [--set fra] [--seat "4x Claude Code/Claude Opus 5.5/high" …]
          [--knowledge primer] [--yes] [--dry-run] [--no-launch] [--skip-preflight] [--unlisted-model]
          [--fresh-session per-game|per-match|off]   (default per-game, the lobby too)
          [--once | --keep-playing [--max-tables 5] [--max-hours 8] [--max-tokens 200M] [--max-usd 50]
                                   [--rotate-sets same|featured|fra,tla]]
  check   [--local] [--json]      Node, sign-in, installed harnesses, sets and knowledge levels
  login   [--start | --wait] [--force] [--accept-terms]   GitHub sign-in (device flow) after you accept the terms; saves a contributor token
  terms   [--accept]                     whether you accepted the current terms; shows them and asks again when they changed
  logout                    forget the saved token (revoke it at <hub>/account)
  prompt  [join | setup]    print the seats' join prompt, or the setup prompt for a coding agent

One step at a time
  new     --set fra --seat "[Nx] [name=]harness/model/effort" …   create an event with ${TABLE_SEATS} seats (prints seat URLs)
          [--knowledge none|primer|primer+stats] [--mana manual|auto] [--seed s] [--unlisted-model] [--allow-downgrade]
          [--fresh-session per-game|per-match|off]   seats play starts: a fresh agent session when the deck is locked
                                                     and after every game (default) or match; off: one session (logged)
  seats   <event> [--harness h]                          how to seat each one by hand (MCP config)
  attach-logs <event> [--seat name …] [--yes]            seats started by hand: verify model and effort from your
                                                         session logs (asks first; keeps numbers only, never text);
                                                         hosted events: sends them to the Hub (and resends play's)
  play    <event> [--seat name …] [--dry-run] [--use-api-key] [--relaunch 3]   run seats headless here
          [--fresh-session off|per-match|per-game]       as the event declared it (bench new / setup)
  status  [event | loop id]                              progress and standings; with nothing, your Keep Playing loops too
  stop    <event>                                        stop the event and the seats running here
  stop    <loop id> [--now]                              Keep Playing: finish the current table, then stop (--now: at once)

${LOBBY_HELP}

Your own table
  up      [--engine docker|podman] [--plain] [--port 8787]   start phase-server + Director (needs a checkout)
  down    [--engine …] [--plain]                             stop them (data volumes are kept)
  pull    <event>                                            copy events.jsonl + summary.json into the event folder
  bundle  <event> [--transcripts] [--submitter handle] [--out f.tar.gz]
  validate <bundle.tar.gz>                                   check a bundle locally
  submit  <bundle.tar.gz> [--to url] [--token t]             upload to the Hub

Seats: harness/model/effort, e.g. "Claude Code/claude-opus-5-5/high", "codex/gpt-6-astra/medium",
  "opencode/anthropic/claude-sonnet-5-5/high"; "4x …" fills four seats. Started on this machine: ${LAUNCHABLE.filter((h) => !h.test).map((h) => h.id).join(', ')}
  (and \`script\`, a free random player for testing). Any other MCP client is seated by hand.
Knowledge: none (No Set Context), primer (Set Context, the default), primer+stats (Set Context + Human Stats).
Hosted table: ${HOSTED_DIRECTOR_URL} (BENCH_DIRECTOR); sign in once with \`login\`. Event folders: ${tilde(RUNS)}.
Docs: ${DOCS}COMMUNITY.md, ${DOCS}HARNESSES.md.`;

Object.assign(COMMANDS, {
  setup: cmdSetup, check: cmdCheck, doctor: cmdCheck, login: cmdLogin, terms: cmdTerms, logout: signOut, prompt: cmdPrompt,
  up: cmdUp, down: cmdDown, new: cmdNew, seats: cmdSeats, play: cmdPlay, status: cmdStatus, stop: cmdStop, pull: cmdPull,
  bundle: cmdBundle, validate: cmdValidate, submit: cmdSubmit, lobby: cmdLobby, loop: cmdLoop, 'attach-logs': cmdAttachLogs,
});

/** Aliases and internal commands whose help is another command's. */
const HELP_OF: Record<string, string> = { doctor: 'check', loop: 'status' };

/**
 * One command's part of HELP: its line(s) (`stop` has two) and their continuation lines; the lobby's own help for
 * `lobby`. Undefined for a command HELP doesn't list.
 */
function commandHelp(name: string): string | undefined {
  const c = HELP_OF[name] ?? name;
  if (c === 'lobby') return LOBBY_HELP;
  const lines = HELP.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!new RegExp(`^  ${c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`).test(lines[i]!)) continue;
    out.push(lines[i]!);
    // Continuation lines are indented further than a command line (which starts with exactly two spaces).
    while (i + 1 < lines.length && /^ {3,}\S/.test(lines[i + 1]!)) out.push(lines[++i]!);
  }
  if (c === 'status' && name === 'loop') out.push(...lines.filter((l) => /^ {2}stop {4}<loop id>/.test(l) && !out.includes(l)));
  return out.length ? `Usage (after \`${BENCH}\`):\n${out.join('\n')}\n\nAll commands: ${BENCH} help` : undefined;
}

/** `--help` or `-h` among a command's arguments (before a `--` that ends the options). */
const asksHelp = (args: string[]) => {
  const end = args.indexOf('--');
  return (end < 0 ? args : args.slice(0, end)).some((a) => a === '--help' || a === '-h');
};

const [cmd, ...rest] = process.argv.slice(2);
if (!cmd || cmd === '--help' || cmd === '-h' || (cmd === 'help' && !rest[0])) console.log(HELP);
else if (cmd === 'help') console.log(commandHelp(rest[0]!) ?? `unknown command "${rest[0]}"\n\n${HELP}`);
else if (cmd === '--version' || cmd === '-v' || cmd === 'version') console.log(VERSION);
else if (!COMMANDS[cmd]) die(`unknown command "${cmd}"\n\n${HELP}`);
else if (asksHelp(rest)) console.log(commandHelp(cmd) ?? HELP);
else {
  try {
    await COMMANDS[cmd]!(rest);
  } catch (e) {
    // An option the command doesn't take, a missing value, an unexpected argument: say so with the usage, no stack trace.
    const code = (e as { code?: unknown })?.code;
    if (typeof code !== 'string' || !code.startsWith('ERR_PARSE_ARGS')) throw e;
    console.error(`${BENCH} ${cmd}: ${(e as Error).message}\n\n${commandHelp(cmd) ?? HELP}`);
    process.exit(2);
  }
}
