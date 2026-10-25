/**
 * `bench check` (what this machine has, what you can choose) and `bench setup`: the one setup flow.
 *
 * The engine asks the questions (private table or lobby, where it runs, set, seats as harness / model / effort,
 * knowledge), checks the answers against the Director and the model registry, runs a preflight for every harness
 * this machine will start, and ends in a Confirmation: the self-reported details the leaderboard will record, the
 * time and token estimate. Nothing is created until the person confirms.
 *
 * Three ways to drive it, all the same engine:
 *   bench setup                      a terminal wizard
 *   bench setup --agent [--answers]  JSON for a coding agent (prompts/setup.md): questions, sign-in, confirmation,
 *                                    then `--confirm <code>` starts it
 *   bench setup --set … --seat …     flags, `--yes` to confirm in one go
 *
 * Every table has 8 agent seats. A Private Table: you bring all 8 agents and play right away; repeat models as you like.
 * Join the Lobby: bring 1–4 agents; we seat you with other people's agents and start when 8 are ready
 * (`bench lobby join`, docs/LOBBY.md).
 *
 * Play One Table, or Keep Playing: new drafts back to back until you stop it (`bench stop <loop id>`) or a limit is
 * reached (tables, hours, tokens, dollars). The loop runs in the background (loop.ts, continuous.ts).
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import {
  BENCH, COMMANDS, CONFIG_DIR, DOCS, HOSTED_DIRECTOR_URL, JOIN_PROMPT, PACKAGED, REPO, RUNS, SWISS_ROUNDS, TABLE_SEATS, VERSION, WATCH_SITE, account,
  contributorToken, createEvent, die, directorUrl, env, hubUrl, loginStart, loginWait, startPlayInBackground, tilde, tryJson, type Created,
} from './core.js';
import { LAUNCHABLE, expandSeatSpecs, harnessFor, installedVersion, seatNames, type SeatSpec } from './harnesses.js';
import { effortChoice, effortLabel, modelChoices, modelLabel, resolveSeat } from './models.js';
import { preflight, type PreflightResult } from './preflight.js';
import {
  inAllText, limitFlags, limitsText, lobbyOverview, lobbyWait, parseLimits, queueKeyOf, type Limits, type LobbyView,
} from './continuous.js';
import { startLoop } from './loop.js';
import { effortFactor, fmtUsd, projectTokens, sumOf, tableUsd } from './estimate.js';
import { printable } from './trust.js';
import { consentBeforeLogin, ensureTerms, fetchTerms, finishLogin, termsStep, termsText } from './consent.js';
import { BEST_OF, bestOfProblem } from '../../packages/director/src/best-of.js';
import { registry } from '../../packages/registry/src/index.js';
import { DEFAULT_FRESH_SESSION, FRESH_SESSION_MODES, isFreshSession, modeOfPolicy, policyOfMode, type FreshSession } from './rotation.js';
import { adviceText, capabilities, detectApps, tableAdvice, type AppFound, type Capability, type MixSuggestion, type TableAdvice } from './mix.js';
import { loadBounties, neededForYou, neededHeadline, type Needed } from './needed.js';

/** The lobby's command (docs/LOBBY.md §3, `bench lobby join`), registered by its own module. */
const LOBBY_COMMAND = ['lobby', 'join'];
const LOBBY_MAX_SEATS = 4;

/** The two kinds of table, in one sentence each (the same words in the CLI help, the lobby help and COMMUNITY.md). */
export const TABLE_TEXT = {
  private: 'You bring all 8 agents and play right away; repeat models as you like.',
  lobby: "Bring 1–4 agents; we seat you with other people's agents and start when 8 are ready.",
} as const;
export const MODE_TEXT = {
  once: 'One table: the draft, deckbuilding and 3 Swiss rounds, then it stops.',
  continuous: 'New drafts back to back until you stop it, or until a limit you set is reached (tables, hours, tokens or dollars).',
} as const;

// ---------------------------------------------------------------------------
// Choices

export const KNOWLEDGE = [
  { id: 'none', label: 'No Set Context', what: 'card text and the Limited fundamentals only', aliases: ['none', 'no-context', 'no context', 'No Set Context'] },
  { id: 'primer', label: 'Set Context', what: "adds the MTG Deck Tools guide to the set's archetypes and key cards (recommended)", aliases: ['primer', 'context', 'Set Context', 'set-context'] },
  { id: 'primer+stats', label: 'Set Context + Human Stats', what: 'also shows 17Lands win rates from human drafters next to each card', aliases: ['primer+stats', 'context+stats', 'stats', 'Set Context + Human Stats', 'set-context+stats'] },
] as const;

export function normalizeKnowledge(x: string | undefined): string | undefined {
  if (x == null) return undefined;
  const n = x.trim().toLowerCase();
  return KNOWLEDGE.find((k) => k.id === n || (k.aliases as readonly string[]).some((x) => x.toLowerCase() === n))?.id;
}
const knowledgeLabel = (id: string) => KNOWLEDGE.find((k) => k.id === id)?.label ?? id;

interface SetChoice {
  code: string;
  name?: string;
  releaseDate?: string;
  /** On the site's featured list (sets/rotation.json). */
  featured?: boolean;
  /** A set context exists (knowledge "primer"); undefined: the Director didn't say. */
  set_context?: boolean;
  /** 17Lands human stats exist (knowledge "primer+stats"). */
  human_stats?: boolean;
  /** Share of the set's booster cards the engine runs (the rest are swapped for supported cards). */
  coverage?: number | null;
}

interface DirectorInfo {
  base: string;
  up: boolean;
  /** Sets this table runs, featured first, newest first within each group. */
  sets: SetChoice[];
  capacity?: { capacity: number; load: number; queued: number; draining: boolean };
}

async function directorInfo(base: string, hosted: boolean): Promise<DirectorInfo> {
  const [health, body, capacity] = await Promise.all([tryJson(`${base}/health`), tryJson(`${base}/api/sets`), hosted ? tryJson(`${base}/api/capacity`) : undefined]);
  // Set codes and names come from the Director and reach a coding agent with a shell: plain codes, short clean names.
  const all: SetChoice[] = Array.isArray(body?.sets)
    ? body.sets.map((x: any) => (typeof x === 'string' ? { code: x } : x)).filter((x: SetChoice) => typeof x?.code === 'string' && /^[A-Za-z0-9]{2,8}$/.test(x.code))
      .map((x: SetChoice) => ({ ...x, code: x.code.toUpperCase(), ...(x.name != null ? { name: printable(x.name, 60) } : {}), ...(x.releaseDate != null ? { releaseDate: printable(x.releaseDate, 10) } : {}) }))
    : [];
  const codes = (v: unknown) => (Array.isArray(v) ? v.map((c: any) => String(typeof c === 'string' ? c : c?.code ?? '').toUpperCase()).filter(Boolean) : []);
  const featured = new Set(codes(body?.featured));
  const hostable = new Set(codes(body?.hosted));
  for (const x of all) x.featured ??= featured.has(x.code);
  // A hosted table runs the sets it lists under `hosted` (every set unless the operator restricted it).
  const usable = hosted && hostable.size ? all.filter((x) => hostable.has(x.code)) : all;
  const byDate = (a: SetChoice, b: SetChoice) => String(b.releaseDate ?? '').localeCompare(String(a.releaseDate ?? ''));
  const sets = [...usable.filter((x) => x.featured).sort(byDate), ...usable.filter((x) => !x.featured).sort(byDate)];
  return { base, up: !!health || !!body, sets, capacity: capacity && typeof capacity.capacity === 'number' ? capacity : undefined };
}

/** Knowledge levels a set supports (unknown support: all of them; the Director has the last word). */
function knowledgeFor(set: SetChoice | undefined): Array<(typeof KNOWLEDGE)[number]> {
  return KNOWLEDGE.filter((k) => k.id === 'none' || (k.id === 'primer' ? set?.set_context !== false : set?.set_context !== false && set?.human_stats !== false));
}

/** "set context, human stats" or "no set context": what a set offers, for lists. */
function setOffers(x: SetChoice): string {
  if (x.set_context === undefined && x.human_stats === undefined) return '';
  const parts = [x.set_context ? 'Set Context' : 'No Set Context', ...(x.human_stats ? ['Human Stats'] : [])];
  if (typeof x.coverage === 'number' && x.coverage < 0.97) parts.push(`${Math.round(x.coverage * 100)}% of cards run`);
  return parts.join(', ');
}

/**
 * What a table asks of you, in words: no cost projection (owner, 2026-10-24: "this uses a lot of tokens, and you should
 * probably only partake if you have tokens to burn"). Measured costs stay in the results and the open data.
 */
export const TOKENS_NOTE =
  "A table uses a lot of tokens: every seat drafts, builds a deck and plays 6 to 9 games on your own harness subscription or API key. Take part only if you have tokens to burn, and set a spending limit with your provider. You're responsible for all costs and for your provider's terms; we can't refund costs or help with account actions.";

/**
 * How long an event takes, and its token and dollar sizes for Keep Playing's limits (never printed as a projection; best
 * of 3 with sideboarding). Time: our runs (the
 * first 8-seat hosted table, best of 1 with one session per seat, took 43 minutes; the second, with a fresh session per
 * game, 27; best of 3 plays about twice the games, plus a minute or two of sideboarding between games). Tokens and
 * dollars: estimate.ts, with the per-game sizes measured on those tables (one session per seat: 8× Claude Haiku 5.5 at
 * low effort, $56.37; a fresh session per game: 4× low and 4× medium, $5.93), projected for best of 3 with sideboarding,
 * for other effort levels and for other models from their list prices. `models` lists each LLM seat's model (registry
 * ids) and `efforts` their effort levels in the same order (low when not given); without models the dollars span
 * Claude Haiku 5.5 to Claude Opus 5.5.
 */
export function estimate(seats: number, models?: Array<string | undefined>, fresh: FreshSession = 'off', efforts?: Array<string | undefined>, freshEach?: Array<FreshSession | undefined>) {
  const lo = Math.round(15 + 10 * SWISS_ROUNDS);
  const hi = Math.round(50 + 32 * SWISS_ROUNDS);
  const { low, high } = projectTokens(fresh);
  // Token counts scale with the seats' effort levels (low is the measured base).
  const ks = efforts?.length ? efforts.map((x) => effortFactor(x).tokens) : [1];
  const [kLo, kHi] = [Math.min(...ks), Math.max(...ks)];
  const input = [sumOf(low, 'write') * kLo, sumOf(high, 'write') * kHi];
  const cached = [sumOf(low, 'read') * kLo, sumOf(high, 'read') * kHi];
  const out = [Math.round(low.output * kLo), Math.round(high.output * kHi)];
  const tiers = models?.length ? models : ['claude-haiku-5-5', 'claude-opus-5-5'];
  const table = tableUsd(models?.length ? models : Array(seats).fill(undefined), fresh, models?.length ? efforts : undefined, models?.length ? freshEach : undefined);
  const span = models?.length ? null : tableUsd(tiers, fresh).perModel;
  // Per seat: the table's average (what Keep Playing multiplies by the seat count), or Haiku's low to Opus's high.
  const usd = span ? [span[0]!.usd[0], span[1]!.usd[1]] : [table.total[0] / seats, table.total[1] / seats];
  const fmt = (min: number) => (min >= 90 ? `${(min / 60).toFixed(1).replace(/\.0$/, '')} h` : `${min} min`);
  return {
    minutes: [lo, hi],
    time: `about ${fmt(lo)} to ${fmt(hi)}: the draft and deckbuilding, then ${SWISS_ROUNDS} Swiss rounds. A seat may wait 10 to 30 minutes between rounds while other matches finish; once its last match ends it stops.`,
    per_seat: { input: input.map(Math.round), cached_input: cached.map(Math.round), output: out, usd },
    table_usd: table.total,
  };
}

function printSets(sets: SetChoice[], max = 12) {
  const featured = sets.filter((x) => x.featured);
  const shown = (featured.length ? featured : sets).slice(0, max);
  console.log(`\n${featured.length ? 'Featured sets' : 'Sets'}, newest first (the first is recommended):`);
  for (const x of shown) console.log(`  ${x.code.padEnd(5)} ${(x.name ?? '').padEnd(32)} ${(x.releaseDate ?? '').padEnd(11)} ${setOffers(x)}`);
  const more = sets.length - shown.length;
  if (more > 0) console.log(`  … and ${more} more set${more === 1 ? '' : 's'} with booster data: any code works with --set (\`check --json\` lists them all)`);
}

// ---------------------------------------------------------------------------
// bench check

export async function cmdCheck(argv: string[]) {
  const { values } = parseArgs({ args: argv, options: { director: { type: 'string' }, hub: { type: 'string' }, local: { type: 'boolean' }, json: { type: 'boolean' } } });
  const hosted = !values.local;
  const base = values.director ? directorUrl(values.director) : hosted ? (env.BENCH_DIRECTOR ?? HOSTED_DIRECTOR_URL).replace(/\/+$/, '') : directorUrl();
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  const engines = ['docker', 'podman'].filter((e) => !spawnSync(e, ['--version'], { stdio: 'ignore', timeout: 10_000 }).error);
  const info = await directorInfo(base, hosted);
  const harnesses = LAUNCHABLE.map((h) => ({
    id: h.id, label: h.label, test: !!h.test, installed: installedVersion(h) ?? null,
    models: h.test ? [] : modelChoices(h.id).map((m) => ({ ...m, effort: effortChoice(h.id, m.id) })),
  }));
  const acct = account();
  // What this machine can seat (CLIs and apps), and the Hub's Most Needed matched against it (one cached call).
  const apps = detectApps();
  const caps = capabilities(new Map(harnesses.map((h) => [h.id, h.installed ?? undefined])), apps);
  const needed = await neededList(caps, values.hub);
  if (values.json) {
    console.log(JSON.stringify({
      kit: { version: VERSION, packaged: PACKAGED, events_folder: RUNS, checkout: REPO ?? null },
      node: { version: process.versions.node, ok: nodeMajor >= 22 },
      signed_in: !!acct, handle: acct?.handle ?? null,
      table: { kind: hosted ? 'hosted' : 'own', director: base, up: info.up, capacity: info.capacity ?? null, seats: TABLE_SEATS, rounds: SWISS_ROUNDS },
      sets: info.sets.map((s, i) => ({ ...s, recommended: i === 0 })),
      knowledge: KNOWLEDGE.map(({ id, label, what }) => ({ id, label, what, default: id === 'primer' })),
      harnesses,
      apps: apps.map((a) => ({ app: a.app, label: a.label, seated: 'by-hand', harnesses: a.harnesses.map((h) => ({ id: h, label: registry.harnessLabel(h) })) })),
      needed, needed_headline: neededHeadline(needed),
      lobby: { available: !!COMMANDS[LOBBY_COMMAND[0]!], max_seats: LOBBY_MAX_SEATS },
      tables: { private: TABLE_TEXT.private, lobby: TABLE_TEXT.lobby }, play_modes: { once: MODE_TEXT.once, continuous: MODE_TEXT.continuous },
      own_table: { container_engines: engines, checkout: !!REPO },
    }, null, 1));
    return;
  }
  console.log(`mtgdt-bench ${VERSION}`);
  console.log(`  Node.js ${process.versions.node}: ${nodeMajor >= 22 ? 'ok' : 'needs version 22 or later'}`);
  console.log(`  Signed in: ${acct ? `yes${acct.handle ? `, as ${acct.handle}` : ''}` : `no (run \`${BENCH} login\`; needed for the hosted table and the lobby)`}`);
  console.log(`\nTable: ${hosted ? 'hosted' : 'your own'} Director at ${base}: ${info.up ? 'up' : hosted ? 'not reachable right now' : `not running (start it with \`${BENCH} up\`)`}`);
  if (info.capacity) {
    const c = info.capacity;
    console.log(`  Load: ${c.load} of ${c.capacity} game slots in use, ${c.queued} event(s) queued${c.draining ? '. Not accepting new events right now (maintenance).' : ''}`);
  }
  if (info.sets.length) printSets(info.sets);
  console.log('\nKnowledge (what the agents are given; the same for every seat; a set offers the levels it has data for):');
  for (const k of KNOWLEDGE) console.log(`  ${k.label}: ${k.what} (--knowledge ${k.id})`);
  console.log('\nHarnesses this machine can start by itself:');
  // The reason for a recommended level is usually the same for every model: say it once, below the list.
  const whys = new Set<string>();
  for (const h of harnesses.filter((x) => !x.test)) {
    console.log(`  ${h.id.padEnd(12)} ${h.label.padEnd(26)} ${h.installed ? `installed (${h.installed})` : 'not installed'}`);
    for (const m of h.models) {
      const e = m.effort;
      if (e.settable && e.why) whys.add(e.why);
      console.log(`      ${m.label.padEnd(26)} ${e.settable ? `effort ${e.levels.join(', ')}; recommended ${e.recommended}` : e.why}`);
    }
  }
  for (const w of whys) console.log(`  Recommended effort: ${w}.`);
  console.log('  Not installed here, or another machine: `setup` prints how to seat it by hand. Other MCP clients need a registry entry (registry/README.md).');
  console.log('  script       a scripted random player: free, for checking a setup end to end');
  for (const a of apps) {
    console.log(`\nApps found here (you start their seats yourself; Play One Table): ${a.label}`);
    const launcher = a.harnesses.some((h) => registry.resolveHarness(h).ok && (registry.resolveHarness(h) as { launcher?: unknown }).launcher);
    // The leaderboard row is the model and effort; the harness (and a launcher) are recorded per seat.
    if (launcher) console.log(`  A launcher: it starts other harnesses (${a.harnesses.map((h) => registry.harnessDisplay(h)).join(', ')}). Each seat is recorded as the harness it runs, with ${a.label} noted in its details. \`${BENCH} seats <event>\` prints how to seat each one.`);
    else console.log(`  Its seats are recorded as ${a.harnesses.map((h) => registry.harnessDisplay(h)).join(', ')} seats; \`${BENCH} seats <event>\` prints how to seat each one.`);
  }
  if (needed.length) {
    console.log(`\nMost Needed Right Now, from what you can run (the Hub's bounties; ${DOCS}MULTI-PROVIDER.md):`);
    console.log(`  ${neededHeadline(needed)}`);
    for (const n of needed) console.log(`  ${n.text} (${n.label}, +${n.bonus} points a seat): --seat "${n.seat}"`);
  }
  if (caps.length) console.log(`\nOnly games between different setups are rated: mix models or effort levels at a Private Table (the harness doesn't make a different setup), or join the lobby (${DOCS}MULTI-PROVIDER.md).`);
  console.log(`\nTables (${TABLE_SEATS} agents each):\n  Private Table:  ${TABLE_TEXT.private}\n  Join the Lobby: ${TABLE_TEXT.lobby}`);
  console.log(`Play One Table, or Keep Playing: new drafts back to back until you stop it (\`${BENCH} stop <loop id>\`) or a limit is reached.`);
  if (!hosted) console.log(`Own table: ${engines.length ? engines.join(', ') : 'no Docker or Podman found'}; ${REPO ? `checkout at ${tilde(REPO)}` : 'needs a checkout of the repository'}.`);
}

/** The Hub's Most Needed, matched against what this person can run ([] when the Hub can't be reached). */
async function neededList(caps: Capability[], hubFlag?: string, o: { knowledge?: string; mana?: string } = {}): Promise<Needed[]> {
  if (!caps.length || env.BENCH_NO_NEEDED === '1') return [];
  let hub: string;
  try {
    hub = hubUrl(hubFlag);
  } catch {
    return [];
  }
  return neededForYou(await loadBounties(hub), caps, o);
}

// ---------------------------------------------------------------------------
// bench setup: the engine

/** The answers so far (the agent mode sends them back each time, adding the new ones). */
export interface Answers {
  table?: 'private' | 'lobby';
  /** Play One Table (`once`) or Keep Playing (`continuous`). */
  play_mode?: 'once' | 'continuous';
  /** Keep Playing: "5 tables, 8 hours, $50, 200M tokens", "none", or { tables, hours, tokens, usd }. */
  limits?: string | Limits;
  /** Keep Playing on a Private Table: "same", "featured", or set codes "fra,tla". */
  rotate_sets?: string;
  where?: 'hosted' | 'local';
  set?: string;
  /** One entry per line of seats: "[N x] harness / model [/ effort]", e.g. "4x Claude Code / Claude Opus 5.5 / high". */
  seats?: string[];
  /** Effort per "harness/model" (canonical ids, as the effort questions name them): a level, or "unknown". */
  efforts?: Record<string, string>;
  knowledge?: string;
  /** Not asked: every event plays best of 3 with sideboarding. Answers from older kits may carry 3; anything else is refused. */
  best_of?: number;
  mana?: string;
  /** Own table only: accept models or harnesses the registry doesn't list (unrated). */
  unlisted_models?: boolean;
  /**
   * Advanced, never asked: the model seats started here get a fresh agent session per game (default), per match, or
   * keep one session ("off") (rotation.ts), at a Private Table or in the lobby. Given explicitly, scripted seats
   * started here get it too (rotation tests).
   */
  fresh_session?: string;
}

interface Option {
  value: string;
  label: string;
  detail?: string;
  recommended?: boolean;
}

export interface Question {
  /** Where the answer goes in Answers ("effort:claude-code/claude-opus-5-5" goes in `efforts`). */
  id: string;
  ask: string;
  help?: string;
  options?: Option[];
  recommended?: string;
  why?: string;
  /** The answer is free text (seats). */
  format?: string;
  /** The previous answer was refused, and why. */
  error?: string;
  /** Seats question: the Hub's Most Needed that this person can run, with a seat line each (needed.ts). */
  needed?: Needed[];
}

type Seats = Array<SeatSpec & { name: string }>;

export interface Plan {
  table: 'private' | 'lobby';
  hosted: boolean;
  base: string;
  set: string;
  setName?: string;
  knowledge: string;
  bestOf: number;
  mana: string;
  seats: Seats;
  unlisted: boolean;
  mode: 'once' | 'continuous';
  limits: Limits;
  /** Keep Playing on a Private Table: the sets tables rotate through (empty: the same set every table). */
  rotation: string[];
  /** The --fresh-session mode for the model seats started here (they carry it as `contextPolicy`). */
  fresh?: FreshSession;
  /** Rated games the table can produce, a warning when few, and mixes (mix.ts); null for a scripted test table. */
  advice?: TableAdvice | null;
}

interface Engine {
  noLaunch: boolean;
  directorFlag?: string;
  installed: Map<string, string | undefined>;
  infos: Map<string, DirectorInfo>;
  /** GET /api/lobby of the hosted Director (wait information), fetched once. */
  lobby?: { view: LobbyView | undefined };
  /** Apps found here that seat by hand (T3 Code), and the Hub flag for Most Needed. */
  apps?: AppFound[];
  hubFlag?: string;
  /** Most Needed for the seats question, fetched once per knowledge/mana. */
  needed?: Map<string, Needed[]>;
}

const capsOf = (e: Engine): Capability[] => capabilities(e.installed, e.noLaunch ? [] : e.apps ?? []);

async function neededFor(e: Engine, a: Answers): Promise<Needed[]> {
  const k = `${normalizeKnowledge(a.knowledge) ?? 'primer'}|${a.mana ?? 'manual'}`;
  e.needed ??= new Map();
  if (!e.needed.has(k)) e.needed.set(k, await neededList(capsOf(e), e.hubFlag, { knowledge: k.split('|')[0], mana: k.split('|')[1] }));
  return e.needed.get(k)!;
}

async function lobbyView(e: Engine, base: string): Promise<LobbyView | undefined> {
  e.lobby ??= { view: await tryJson(`${base}/api/lobby`) };
  return e.lobby.view;
}

const hostedBase = () => (env.BENCH_DIRECTOR ?? HOSTED_DIRECTOR_URL).replace(/\/+$/, '');
const launchHere = (e: Engine, s: SeatSpec) => !e.noLaunch && !!harnessFor(s.harness)?.launch && !!e.installed.get(harnessFor(s.harness)!.id);
const groupKey = (s: SeatSpec) => `${s.harness}/${s.model}`;

async function info(e: Engine, base: string, hosted: boolean): Promise<DirectorInfo> {
  const k = `${base} ${hosted}`;
  if (!e.infos.has(k)) e.infos.set(k, await directorInfo(base, hosted));
  return e.infos.get(k)!;
}

function parseSeats(lines: string[], allowUnlisted: boolean): SeatSpec[] | string {
  let specs: SeatSpec[];
  try {
    specs = expandSeatSpecs(lines.flatMap((l) => l.split(/\n|;/)));
  } catch (err) {
    return (err as Error).message;
  }
  const out: SeatSpec[] = [];
  for (const s of specs) {
    if (!s.harness) return 'give each seat as harness / model / effort, e.g. "4x Claude Code / Claude Opus 5.5 / high"';
    const r = resolveSeat(s, { allowUnlisted });
    if (!r.ok) return r.error;
    out.push(r.seat);
  }
  return out;
}

/**
 * The next questions for these answers (each with its options and recommendation, and an error when an answer was
 * refused), or the finished plan. Questions come in the order they depend on each other, as many at once as can be
 * asked together.
 */
async function evaluate(e: Engine, a: Answers): Promise<{ questions: Question[]; table_check?: TableAdvice } | { plan: Plan }> {
  const qs: Question[] = [];
  // 1. Private table or the lobby
  if (a.table !== 'private' && a.table !== 'lobby') {
    const overview = lobbyOverview(await lobbyView(e, e.directorFlag ? directorUrl(e.directorFlag) : hostedBase()));
    qs.push({
      id: 'table', ask: 'How do you want to play? Every table seats 8 agents.', recommended: 'private',
      options: [
        { value: 'private', label: 'Private Table', detail: TABLE_TEXT.private, recommended: true },
        { value: 'lobby', label: 'Join the Lobby', detail: `${TABLE_TEXT.lobby}${overview ? ` ${overview}` : ''}` },
      ],
      ...(a.table ? { error: `"${a.table}" isn't one of the options` } : {}),
    });
  }
  // 1b. One table, or keep playing
  if (a.play_mode !== 'once' && a.play_mode !== 'continuous') {
    qs.push({
      id: 'play_mode', ask: 'Play one table, or keep playing?', recommended: 'once',
      help: 'Keep Playing starts a new table as soon as one finishes (a Private Table: new seed, same seats; the Lobby: your seats rejoin the queue). Every table uses your tokens.',
      options: [
        { value: 'once', label: 'Play One Table', detail: MODE_TEXT.once, recommended: true },
        { value: 'continuous', label: 'Keep Playing', detail: MODE_TEXT.continuous },
      ],
      ...(a.play_mode ? { error: `"${a.play_mode}" isn't one of the options` } : {}),
    });
  }
  const continuous = a.play_mode === 'continuous';
  const limits = continuous ? parseLimits(a.limits) : {};
  if (continuous && (a.limits == null || typeof limits === 'string')) {
    qs.push({
      id: 'limits', ask: 'Any limits for Keep Playing? It stops at the first one reached.', recommended: 'none',
      why: `it keeps going until you stop it (\`${BENCH} stop <loop id>\`), and the summary file shows every table and its tokens as it goes`,
      format: 'e.g. "5 tables", "8 hours", "$50", "200M tokens", several separated by commas, or "none". Tokens count input and output as the harnesses report them (cached re-reads not counted); dollars use the harnesses\' reported cost, else our estimate.',
      ...(typeof limits === 'string' ? { error: limits } : {}),
    });
  }
  // 2. Where (private tables)
  const where = a.table === 'lobby' ? 'hosted' : a.where;
  if (a.table !== 'lobby' && where !== 'hosted' && where !== 'local') {
    qs.push({
      id: 'where', ask: 'Where should the table run?', recommended: 'hosted', help: 'Only for a private table; the lobby is always hosted.',
      options: [
        { value: 'hosted', label: 'Hosted', detail: 'we run the game server; your agents connect from this machine; results go to the leaderboard as Hosted', recommended: true },
        { value: 'local', label: 'Your own machine', detail: 'needs Docker or Podman and a checkout of the repository; you submit the results' },
      ],
      ...(a.where ? { error: `"${a.where}" isn't one of the options` } : {}),
    });
  }
  const hosted = where !== 'local';
  const base = e.directorFlag ? directorUrl(e.directorFlag) : hosted ? hostedBase() : directorUrl();
  const di = await info(e, base, hosted);
  if (!di.up) {
    if (hosted) die(`the hosted table (${base}) isn't reachable right now; try again in a few minutes`);
    if (!REPO) die(`no Director is running at ${base}. Your own table needs a checkout of the repository (${DOCS}COMMUNITY.md), or choose the hosted table`);
    die(`no Director is running at ${base}: start your table with \`${BENCH} up\` (Docker or Podman; a few minutes the first time), then run setup again`);
  }
  // 3. Set
  const set = di.sets.find((x) => x.code.toUpperCase() === String(a.set ?? '').toUpperCase());
  if (!set) {
    const shown = di.sets.filter((x) => x.featured).slice(0, 12);
    const list = shown.length ? shown : di.sets.slice(0, 12);
    qs.push({
      id: 'set', ask: 'Which set?', recommended: di.sets[0]?.code.toLowerCase(), why: 'the newest featured set',
      help: di.sets.length > list.length ? `${di.sets.length - list.length} more sets with booster data work too: give any code (\`${BENCH} check --json\` lists them).` : undefined,
      options: list.map((x, i) => ({ value: x.code.toLowerCase(), label: `${x.code} · ${x.name ?? ''}`.trim(), ...(setOffers(x) ? { detail: setOffers(x) } : {}), recommended: i === 0 })),
      ...(a.set ? { error: `${a.set.toUpperCase()} isn't available here` } : {}),
    });
  }
  // 3b. Keep Playing on a Private Table: the same set, or a rotation
  let rotation: string[] = [];
  if (continuous && a.table === 'private' && set) {
    const r = String(a.rotate_sets ?? '').trim().toLowerCase();
    const featured = di.sets.filter((x) => x.featured).map((x) => x.code.toLowerCase());
    let err: string | undefined;
    if (r === 'featured') rotation = featured.length ? [set.code.toLowerCase(), ...featured.filter((c) => c !== set.code.toLowerCase())] : [];
    else if (r && r !== 'same') {
      const codes = r.split(/[\s,;]+/).filter(Boolean);
      const unknown = codes.filter((c) => !di.sets.some((x) => x.code.toLowerCase() === c));
      if (unknown.length) err = `${unknown.map((c) => c.toUpperCase()).join(', ')} ${unknown.length === 1 ? "isn't" : "aren't"} available here`;
      else rotation = [...new Set(codes)];
    }
    if (!r || err) {
      qs.push({
        id: 'rotate_sets', ask: 'Which set should each new table use?', recommended: 'same',
        options: [
          { value: 'same', label: 'Same Set Every Table', detail: `${set.code} every time: the most comparable results`, recommended: true },
          ...(featured.length > 1 ? [{ value: 'featured', label: 'Rotate the Featured Sets', detail: [set.code.toLowerCase(), ...featured.filter((c) => c !== set.code.toLowerCase())].map((c) => c.toUpperCase()).join(' → ') }] : []),
        ],
        format: 'or a list of set codes, e.g. "fra, tla": tables go round them in order',
        ...(err ? { error: err } : {}),
      });
    }
  }
  // 4. Seats
  const allowUnlisted = !hosted && !!a.unlisted_models;
  const want = a.table === 'lobby' ? [1, LOBBY_MAX_SEATS] : [TABLE_SEATS, TABLE_SEATS];
  let specs: SeatSpec[] | undefined;
  let seatError: string | undefined;
  if (a.unlisted_models && hosted) seatError = 'the hosted table and the lobby take only models in the registry; unlisted models work on your own table';
  else if (a.seats?.length) {
    const r = parseSeats(a.seats, allowUnlisted);
    if (typeof r === 'string') seatError = r;
    else if (r.length < want[0]! || r.length > want[1]!) {
      seatError = a.table === 'lobby' ? `the lobby takes 1 to ${LOBBY_MAX_SEATS} of your seats (you gave ${r.length}); for 8, choose a private table`
        : `a private table has ${TABLE_SEATS} seats (you gave ${r.length}): repeat models with a count, e.g. "4x Claude Code / Claude Opus 5.5 / high"`;
    } else if (continuous && !e.noLaunch && r.some((s) => !launchHere(e, s))) {
      const missing = [...new Set(r.filter((s) => !launchHere(e, s)).map((s) => harnessFor(s.harness)?.label ?? s.harness))];
      seatError = `Keep Playing starts every seat on this machine for each new table, so each harness must be installed here (${missing.join(', ')} ${missing.length === 1 ? "isn't" : "aren't"}). Install it, or choose Play One Table and seat those by hand`;
    } else if (continuous && e.noLaunch) {
      seatError = 'Keep Playing starts the seats on this machine for each new table: drop --no-launch, or choose Play One Table';
    } else specs = r;
  }
  if (!specs) {
    const here = LAUNCHABLE.filter((h) => !h.test && e.installed.get(h.id));
    const options: Option[] = here.flatMap((h) => modelChoices(h.id).map((m) => ({
      value: `${h.id}/${m.id}`, label: `${h.label} / ${m.label}`, detail: `${h.label} is installed here, so these seats start automatically`,
    })));
    const needed = await neededFor(e, a);
    const apps = e.noLaunch ? [] : e.apps ?? [];
    qs.push({
      id: 'seats',
      ask: a.table === 'lobby' ? `Which agents do you bring (1 to ${LOBBY_MAX_SEATS})?` : `Who plays the ${TABLE_SEATS} seats? Models can repeat.`,
      format: a.table === 'lobby'
        ? 'one line per model: "[count x] harness / model / effort", e.g. "2x Claude Code / Claude Opus 5.5 / high" and "2x Codex / GPT-6 Astra / high" (1 to 4 seats in all). The effort can be left out: it is asked next, with a recommendation.'
        : 'one line per model: "[count x] harness / model / effort", e.g. "4x Claude Code / Claude Opus 5.5 / high" and "4x Codex / GPT-6 Astra / high". The effort can be left out: it is asked next, with a recommendation.',
      help: `${here.length ? `Installed here, so their seats start automatically: ${here.map((h) => `${h.label} ${e.installed.get(h.id)}`).join(', ')}.` : 'No supported harness command line is installed here.'}${(() => {
        const other = LAUNCHABLE.filter((h) => !h.test && !e.installed.get(h.id)).map((h) => h.label);
        return other.length ? ` ${other.join(' and ')} ${other.length === 1 ? "isn't" : "aren't"} installed here: you can still choose ${other.length === 1 ? 'it' : 'them'} and start those seats yourself (setup prints the steps).` : '';
      })()}${apps.length && !continuous ? ` Also found here: ${apps.map((x) => `${x.label} (${x.harnesses.map((h) => registry.harnessDisplay(h)).join(', ')}), whose seats you start yourself`).join('; ')}.` : ''} Models are named by the registry: \`${BENCH} check\` lists them per harness.${a.table === 'private'
        ? ' Only games between different setups (a different model or effort level; the harness doesn\'t count) are rated, so mix them: for example 4 seats at low effort and 4 at high, or two models.'
        : ''}${needed.length ? ` ${neededHeadline(needed)} ${needed.map((n) => `"${n.seat}": ${n.text.charAt(0).toLowerCase()}${n.text.slice(1)}`).join('; ')}.` : ''}`,
      options,
      ...(needed.length ? { needed } : {}),
      ...(seatError ? { error: seatError } : {}),
    });
  }
  // 5. Knowledge (once the set is known)
  if (set) {
    const offered = knowledgeFor(set);
    const rec = offered.some((k) => k.id === 'primer') ? 'primer' : 'none';
    const k = normalizeKnowledge(a.knowledge);
    if (!k || !offered.some((x) => x.id === k)) {
      qs.push({
        id: 'knowledge', ask: 'What may the agents know? The same for every seat.', recommended: rec,
        why: rec === 'primer' ? 'the MTG Deck Tools guide to the set is what a prepared human drafter would know' : `${set.code} has no Set Context`,
        options: offered.map((x) => ({ value: x.id, label: x.label, detail: x.what.replace(' (recommended)', ''), recommended: x.id === rec })),
        ...(a.knowledge ? { error: k ? `${set.code} has ${setOffers(set) || 'no data for that'}` : `"${a.knowledge}" isn't one of the options` } : {}),
      });
    }
  }
  // 6. Effort, per harness and model (once the seats are known)
  if (specs) {
    const seen = new Set<string>();
    for (const s of specs) {
      const key = groupKey(s);
      if (seen.has(key)) continue;
      seen.add(key);
      const c = effortChoice(s.harness!, s.model);
      if (!c.settable) continue;
      const here = launchHere(e, s);
      const allowUnknown = !here && a.table !== 'lobby';
      const given = a.efforts?.[key] ?? (s.effortUnknown ? 'unknown' : s.declared?.effort || s.effortFromName ? s.effort : undefined);
      const okLevel = !!given && (c.levels.includes(given) || (given === 'unknown' && allowUnknown));
      if (okLevel) continue;
      const n = specs.filter((x) => groupKey(x) === key).length;
      qs.push({
        id: `effort:${key}`,
        ask: `Effort for ${n > 1 ? `the ${n} seats of ` : ''}${harnessFor(s.harness)?.label ?? s.harness} / ${modelLabel(s.model!)}?`,
        recommended: c.recommended, why: c.why,
        help: here ? `${n > 1 ? 'These seats start' : 'This seat starts'} on this machine at exactly this level.` : allowUnknown ? 'You start this seat yourself: declare the level you will set, or "unknown" if you don\'t know it (the harness\'s documented default is then recorded).' : 'Lobby seats need a level.',
        options: [
          ...c.levels.map((l) => ({ value: l, label: effortLabel(l), recommended: l === c.recommended })),
          ...(allowUnknown ? [{ value: 'unknown', label: "I don't know", detail: "recorded as the harness's documented default, or Unknown" }] : []),
        ],
        ...(given ? { error: given === 'unknown' ? 'this seat needs a level' : `${harnessFor(s.harness)?.label ?? s.harness} can't start ${modelLabel(s.model!)} at "${given}"` } : {}),
      });
    }
  }
  // Every event plays best of 3 with sideboarding (cmdSetup refuses any other best_of before this).
  const bestOf = BEST_OF;
  const mana = a.mana ?? 'manual';
  if (!['manual', 'auto'].includes(mana)) qs.push({ id: 'mana', ask: 'Mana payment?', recommended: 'manual', options: [{ value: 'manual', label: 'Manual', recommended: true }, { value: 'auto', label: 'Auto' }], error: `${a.mana} isn't manual or auto` });
  // A fresh agent session per game unless asked otherwise, at a Private Table and in the lobby alike.
  const freshDefault: FreshSession = DEFAULT_FRESH_SESSION;
  const fresh = a.fresh_session ?? freshDefault;
  if (!isFreshSession(fresh)) {
    qs.push({
      id: 'fresh_session', ask: 'Fresh agent sessions for the seats started here?', recommended: freshDefault,
      options: FRESH_SESSION_MODES.map((m) => ({ value: m, label: m === 'off' ? 'Off: One Session' : m === 'per-game' ? 'Per Game' : 'Per Match', recommended: m === freshDefault })),
      error: `${a.fresh_session} isn't ${FRESH_SESSION_MODES.join(', ')}`,
    });
  }
  // Make Your Table Count: once the seats are known, how many rated games they can produce (never blocks).
  const advice = specs ? tableAdvice(specs, { caps: capsOf(e), table: a.table === 'lobby' ? 'lobby' : 'private', continuous, efforts: a.efforts }) : null;
  if (qs.length) return { questions: qs, ...(advice?.warning ? { table_check: advice } : {}) };

  // Everything answered: settle each seat's effort and how it is known.
  for (const s of specs!) {
    const c = effortChoice(s.harness!, s.model);
    const here = launchHere(e, s);
    const given = a.efforts?.[groupKey(s)] ?? (s.effortUnknown ? 'unknown' : s.effort);
    if (!c.settable) s.effort = 'default'; // the harness can't set it: the registry records its documented level
    else if (given === 'unknown') {
      s.effort = 'unknown';
      s.effortUnknown = true;
    } else {
      s.effort = given;
      s.effortBasis = here ? 'launch' : 'self-report';
    }
    // The confirmed values are what the event records as declared.
    s.declared = { harness: s.harness, model: s.model, effort: s.effort };
    // A context policy is a launch condition: only for model seats `bench play` (or `bench lobby join`) starts here;
    // scripted seats only when asked for explicitly (lobby.ts lobbySeatPolicy applies the same rule).
    const policy = policyOfMode(fresh as FreshSession);
    if (policy && here && (!harnessFor(s.harness)?.test || a.fresh_session != null)) s.contextPolicy = policy;
  }
  const names = seatNames(specs!, (m) => console.warn(`note: ${m}`));
  return {
    plan: {
      table: a.table!, hosted, base, set: set!.code.toLowerCase(), setName: set!.name, knowledge: normalizeKnowledge(a.knowledge)!, bestOf, mana,
      seats: specs!.map((s, i) => ({ ...s, name: names[i]! })), unlisted: allowUnlisted,
      mode: continuous ? 'continuous' : 'once', limits: typeof limits === 'string' ? {} : limits, rotation, fresh: fresh as FreshSession,
      advice: tableAdvice(specs!, { caps: capsOf(e), table: a.table!, continuous }),
    },
  };
}

/** The plan's --fresh-session mode (plans saved before it was recorded: what their seats carry). */
export const freshOf = (p: Pick<Plan, 'fresh' | 'seats'>): FreshSession => p.fresh ?? modeOfPolicy(p.seats.find((s) => s.contextPolicy)?.contextPolicy);

/**
 * The --fresh-session value to pass on (`lobby join`, the setup flags), or undefined when the default gives the same
 * seats the same policies (scripted seats with one: it was given explicitly).
 */
export function freshFlag(p: Pick<Plan, 'fresh' | 'seats'>): FreshSession | undefined {
  const mode = freshOf(p);
  return mode !== DEFAULT_FRESH_SESSION || p.seats.some((s) => s.contextPolicy && harnessFor(s.harness)?.test) ? mode : undefined;
}

/** The Confirmation's Sessions line: how the model seats started here handle their context (none: no line). */
function sessionsText(p: Plan, launched: number, byHand: number): string | null {
  if (!launched) return null;
  const mode = freshOf(p);
  const text = mode === 'off'
    ? 'One agent session per seat for the whole event (--fresh-session off).'
    : `Each ${mode === 'per-game' ? 'game' : 'match'} starts a fresh agent session to keep costs down; every decision carries the full board and match history.`;
  return byHand ? `${text} Seats you start yourself keep their own session.` : text;
}

/** Put an answer where it belongs (questions are answered by id). */
function setAnswer(a: Answers, id: string, value: string): void {
  if (id === 'seats') a.seats = value.split(/\n|;/).map((x) => x.trim()).filter(Boolean);
  else if (id.startsWith('effort:')) a.efforts = { ...a.efforts, [id.slice(7)]: value.trim().toLowerCase() };
  else if (id === 'limits') a.limits = value.trim();
  else (a as Record<string, unknown>)[id] = value.trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// Confirmation

/** One group of identical seats, in the leaderboard's order: model · harness · effort. */
interface SeatLine {
  count: number;
  names: string[];
  model: { id: string; label: string };
  harness: { id: string; label: string; version: string | null };
  effort: { level: string; label: string; established: string };
  starts: 'here' | 'by hand';
  check: { status: 'verified' | 'unverified' | 'problem' | 'not checked'; text: string };
  /** Started here: how far the seat is shut in (harnesses.ts `isolation`); partial ones keep some local tools. */
  isolation?: { level: 'full' | 'partial'; text: string };
}

export interface Confirmation {
  code: string;
  ready: boolean;
  table: string;
  set: string;
  knowledge: string;
  format: string;
  /** How the model seats started here handle their context (fresh session per game by default); null: no such seats. */
  sessions: string | null;
  time: string;
  seats: SeatLine[];
  tokens: string;
  /** Play One Table or Keep Playing, in words. */
  mode: string;
  /** Keep Playing: the limits in words ("" for Play One Table). */
  limits: string;
  /** Keep Playing: the tokens note again (kept for older agents); "In all": how many tables the limits allow. */
  per_table: string | null;
  in_all: string | null;
  /** The lobby: how long seats in this queue are likely to wait, from the lobby's state right now. */
  wait: string | null;
  /**
   * Make Your Table Count (mix.ts): "Rated games this table can produce: N (of up to M)", the counts, a plain warning
   * when the table produces few or none (it is never refused), and mixes built from what this person can run.
   */
  rated: { line: string; rated_games: number; games: number; rated_matches: number; matches: number; level: TableAdvice['level'] } | null;
  table_warning: string | null;
  suggestions: MixSuggestion[];
  problems: string[];
  text: string;
}

/**
 * The plan's fingerprint: what the person confirms is exactly what starts. Seat names are left out: they are
 * neutral (`seat-<hex>`) and drawn afresh on every run, so the confirmed run would never match its confirmation.
 */
const planCode = (p: Plan) => createHash('sha256').update(JSON.stringify({
  t: p.table, h: p.hosted, b: p.base, s: p.set, k: p.knowledge, bo: p.bestOf, m: p.mana, u: p.unlisted, mo: p.mode, l: p.limits, r: p.rotation,
  seats: p.seats.map((s) => [s.harness, s.model, s.effort, s.effortBasis ?? '', ...(s.contextPolicy ? [s.contextPolicy] : [])]),
})).digest('hex').slice(0, 10);

async function runPreflights(e: Engine, p: Plan, opts: { skip?: boolean; useApiKey?: boolean; log?: (s: string) => void }): Promise<Map<string, PreflightResult>> {
  const out = new Map<string, PreflightResult>();
  if (opts.skip) return out;
  const todo = new Map<string, SeatSpec>();
  for (const s of p.seats) if (launchHere(e, s) && harnessFor(s.harness)?.preflight) todo.set(`${groupKey(s)}/${s.effort}`, s);
  for (const [k, s] of todo) {
    opts.log?.(`Checking ${harnessFor(s.harness)!.label} with ${modelLabel(s.model!)} (one short message)…`);
    out.set(k, await preflight(harnessFor(s.harness)!, s.model!, s.effort!, { useApiKey: opts.useApiKey, launchModel: s.launchModel }));
  }
  return out;
}

/**
 * Keep Playing, before every new table: the same cheap preflight for the harnesses this machine starts. Problems
 * (a harness gone, signed out, or answering as another model), or none.
 */
export async function recheckPreflight(p: Plan, o: { useApiKey?: boolean } = {}): Promise<string[]> {
  const e: Engine = { noLaunch: false, installed: new Map(LAUNCHABLE.map((h) => [h.id, installedVersion(h)])), infos: new Map() };
  const gone = [...new Set(p.seats.filter((s) => !launchHere(e, s)).map((s) => harnessFor(s.harness)?.label ?? s.harness))];
  if (gone.length) return [`${gone.join(', ')} ${gone.length === 1 ? 'is' : 'are'} no longer installed on this machine.`];
  const checks = await runPreflights(e, p, { useApiKey: o.useApiKey });
  return confirmation(e, p, checks, false).problems;
}

/** A seat group as the Confirmation names it: model · harness (and its version) · effort, always all three. */
export const seatLineText = (x: Pick<SeatLine, 'model' | 'harness' | 'effort'>): string =>
  `${x.model.label} · ${x.harness.label}${x.harness.version ? ` ${x.harness.version}` : ''} · ${x.effort.label || effortLabel(x.effort.level)}`;

function confirmation(e: Engine, p: Plan, checks: Map<string, PreflightResult>, skipped: boolean, lobby?: LobbyView): Confirmation {
  const groups = new Map<string, Seats>();
  for (const s of p.seats) groups.set(`${groupKey(s)}/${s.effort}/${launchHere(e, s)}`, [...(groups.get(`${groupKey(s)}/${s.effort}/${launchHere(e, s)}`) ?? []), s]);
  const problems: string[] = [];
  const seats: SeatLine[] = [...groups.values()].map((g) => {
    const s = g[0]!;
    const h = harnessFor(s.harness);
    const test = !!h?.test;
    const here = launchHere(e, s);
    const c = effortChoice(s.harness!, s.model);
    const version = here && !test ? e.installed.get(h!.id) ?? null : null;
    const pf = checks.get(`${groupKey(s)}/${s.effort}`);
    // The effort the leaderboard records, and how it is known.
    let level = s.effort!;
    let established: string;
    if (test) established = 'none (scripted player)';
    else if (!c.settable) {
      const d = registry.harnessDefaultEffort(s.harness!, s.model!, version?.split(' ')[0], { current: true });
      level = d?.level ?? c.recommended;
      established = c.why;
    } else if (s.effortUnknown) {
      // What the harness runs when nobody sets a level (the version is the person's own, so the current default).
      const d = registry.harnessDefaultEffort(s.harness!, s.model!, null, { current: true });
      level = d?.level ?? 'unknown';
      established = d ? `you don't know the setting, so ${h?.label}'s documented default (${effortLabel(d.level)}) is recorded` : "you don't know the setting and the harness's default isn't documented: recorded as Unknown";
    } else if (here) established = pf?.effort_detected ? `set by flag at launch; ${pf.effort_detected === s.effort ? 'confirmed' : `but the harness log showed ${pf.effort_detected}`} in the harness's log` : 'set by flag at launch';
    else established = 'declared by you';
    let check: SeatLine['check'];
    if (test) check = { status: 'verified', text: 'scripted player' };
    else if (!here) {
      const client = h?.label ?? registry.harnessLabel(s.harness!);
      check = { status: 'unverified', text: `you start it yourself, so it can't be checked here: Self-Reported. We'll check your ${client} session logs afterwards to verify the model and effort (\`${BENCH} attach-logs\`, it asks first)` };
    }
    else if (skipped || !pf) check = { status: 'unverified', text: 'not checked (--skip-preflight): Self-Reported unless the logs show the model' };
    else if (!pf.ok) {
      check = { status: 'problem', text: `didn't answer: ${pf.signed_in === false ? `${h!.label} doesn't look signed in` : pf.problem ?? 'no reply'}` };
      problems.push(`${h!.label} / ${modelLabel(s.model!)}: ${check.text}. Fix it (sign in to ${h!.label}, or check the model name) and run setup again, or start these seats yourself.`);
    } else if (pf.model_check === 'mismatch') {
      check = { status: 'problem', text: `answered as ${pf.model_reported}, not ${modelLabel(s.model!)}` };
      problems.push(`${h!.label} ran ${pf.model_reported} when asked for ${modelLabel(s.model!)}: such a seat would be a Mismatch and unrated. Check the model name or your ${h!.label} settings.`);
    } else if (pf.usage_warning) {
      check = { status: 'problem', text: `answered, but ${pf.usage_warning}` };
      problems.push(`${h!.label}: ${pf.usage_warning}.`);
    } else if (pf.model_check === 'verified') check = { status: 'verified', text: `answered in ${pf.seconds} s; model verified${pf.effort_detected ? `; effort ${pf.effort_detected} in its log` : ''}` };
    else check = { status: 'unverified', text: `answered in ${pf.seconds} s; it doesn't report its model: Self-Reported` };
    return {
      count: g.length, names: g.map((x) => x.name),
      model: { id: s.model!, label: test ? s.model! : modelLabel(s.model!) },
      harness: { id: s.harness!, label: h?.label ?? s.harness!, version },
      // Every line names an effort, a scripted player's included (it has none).
      effort: { level, label: test ? 'No Effort Setting' : effortLabel(level), established },
      starts: here ? 'here' : 'by hand', check,
      ...(here && !test && h?.isolation ? { isolation: { level: h.isolation.level, text: h.isolation.note } } : {}),
    };
  });
  const llmSeats = p.seats.filter((s) => !harnessFor(s.harness)?.test).length;
  const launchedLlm = p.seats.filter((s) => !harnessFor(s.harness)?.test && launchHere(e, s)).length;
  const sessions = sessionsText(p, launchedLlm, llmSeats - launchedLlm);
  const llm = p.seats.filter((s) => !harnessFor(s.harness)?.test);
  // Seats seated by hand keep one session (docs/HARNESSES.md), so they are priced that way.
  const est = estimate(llmSeats, llm.map((s) => s.model), launchedLlm ? freshOf(p) : 'off', llm.map((s) => s.effort), llm.map((s) => (launchHere(e, s) ? undefined : 'off')));
  const tableText = p.table === 'lobby' ? `Join the Lobby (hosted): your ${p.seats.length} seat${p.seats.length === 1 ? '' : 's'} plus other people's agents, ${TABLE_SEATS} in all`
    : p.hosted ? `Private Table, hosted (${p.base.replace(/^https?:\/\//, '')}); results go to the leaderboard as Hosted` : `Private Table, on your own machine (${p.base}); you submit the results afterwards`;
  const scripted = llmSeats === 0;
  const tokens = scripted ? 'Scripted players use no model tokens.' : TOKENS_NOTE;
  const cont = p.mode === 'continuous';
  const rotationText = p.rotation.length > 1 ? `, sets rotate ${p.rotation.map((x) => x.toUpperCase()).join(' → ')}` : '';
  const c: Omit<Confirmation, 'text'> = {
    code: planCode(p), ready: problems.length === 0, table: tableText, set: `${p.set.toUpperCase()}${p.setName ? ` · ${p.setName}` : ''}`,
    knowledge: KNOWLEDGE.find((k) => k.id === p.knowledge)?.label ?? p.knowledge,
    format: `${TABLE_SEATS}-player booster draft, 40-card decks, ${SWISS_ROUNDS} Swiss rounds, best of 3 with sideboarding`, sessions,
    time: est.time, seats, tokens,
    mode: cont
      ? `Keep Playing: a new table starts when one finishes (${p.table === 'lobby' ? 'your seats rejoin the queue' : `new seed, same seats${rotationText}`}), until you stop it with \`${BENCH} stop <loop id>\` or a limit is reached`
      : 'Play One Table',
    limits: cont ? limitsText(p.limits) || 'None: it keeps going until you stop it' : '',
    per_table: cont ? tokens : null,
    in_all: cont ? inAllText({ limits: p.limits, minutes: est.minutes, hostedPrivate: p.hosted && p.table === 'private', dailyLimit: account()?.quotas?.play_daily, lobby: p.table === 'lobby' }) : null,
    wait: p.table === 'lobby' ? lobbyWait(lobby, queueKeyOf(p.set, p.knowledge, p.mana), p.seats.length, Date.now()) : null,
    rated: p.advice ? { line: p.advice.line, rated_games: p.advice.rated_games, games: p.advice.games, rated_matches: p.advice.rated_matches, matches: p.advice.matches, level: p.advice.level } : null,
    table_warning: p.advice?.warning ?? null,
    suggestions: p.advice?.suggestions ?? [],
    problems,
  };
  const mark = (st: SeatLine['check']['status']) => (st === 'verified' ? '✓' : st === 'problem' ? '✗' : '⚠');
  const lines = [
    'Please confirm your event. These are the details the leaderboard will record.', '',
    `  Table       ${c.table}`,
    `  Set         ${c.set}`,
    `  Knowledge   ${c.knowledge}`,
    `  Format      ${c.format}`,
    ...(sessions ? [`  Sessions    ${sessions}`] : []),
    `  Mode        ${c.mode}`,
    ...(cont ? [`  Limits      ${c.limits}`] : []),
    `  Time        ${cont ? 'Per table, ' : ''}${c.time}`,
    ...(c.wait ? [`  Wait        ${c.wait}`] : []),
    ...(c.rated ? [`  ${c.rated.line}`] : []),
    ...(p.advice?.warning ? adviceText(p.advice, '    ') : []), '',
    '  Seats',
    ...seats.flatMap((x) => [
      // Model · harness · effort on every line, the order the leaderboard uses (seatLineText).
      `    ${`${x.count}x`.padEnd(4)}${seatLineText(x)}`,
      `        ${x.starts === 'here' ? 'starts on this machine' : 'you start it yourself'}; effort: ${x.effort.established}`,
      `        ${mark(x.check.status)} ${x.check.text}`,
      ...(x.isolation?.level === 'partial'
        ? [`        ⚠ ${x.harness.label} can't be fully shut in: ${x.isolation.text}. For a seat that can't reach your files, run it in a container or VM.`]
        : []),
    ]), '',
    ...(seats.some((x) => x.starts === 'here')
      ? [`  Game text reaches your agents and could try to steer them. A seat with only its mtg tools has nothing to act on it with${seats.some((x) => x.isolation?.level === 'partial') ? '; see the warnings above for seats that keep some' : ''}.`, '']
      : []),
    `  Tokens      ${c.tokens}`,
    ...(cont ? [`  In all      ${c.in_all}`] : []),
    ...(problems.length ? ['', '  Fix before starting:', ...problems.map((x) => `    ✗ ${x}`)] : ['', 'Nothing starts until you confirm.']),
  ];
  return { ...c, text: lines.join('\n') };
}

// ---------------------------------------------------------------------------
// The command

export async function cmdSetup(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      agent: { type: 'boolean' }, answers: { type: 'string' }, confirm: { type: 'string' },
      private: { type: 'boolean' }, lobby: { type: 'boolean' }, hosted: { type: 'boolean' }, local: { type: 'boolean' },
      set: { type: 'string' }, seat: { type: 'string', multiple: true }, knowledge: { type: 'string' },
      director: { type: 'string' }, hub: { type: 'string' }, token: { type: 'string' },
      'best-of': { type: 'string' }, mana: { type: 'string' }, yes: { type: 'boolean', short: 'y' }, 'dry-run': { type: 'boolean' },
      'no-launch': { type: 'boolean' }, interactive: { type: 'boolean', short: 'i' }, relaunch: { type: 'string' }, 'use-api-key': { type: 'boolean' },
      'unlisted-model': { type: 'boolean' }, 'skip-preflight': { type: 'boolean' }, 'fresh-session': { type: 'string' },
      'keep-playing': { type: 'boolean' }, once: { type: 'boolean' }, 'max-tables': { type: 'string' }, 'max-hours': { type: 'string' },
      'max-tokens': { type: 'string' }, 'max-usd': { type: 'string' }, 'rotate-sets': { type: 'string' },
    },
  });
  // Answers: from --answers (JSON or a file), then flags on top.
  let a: Answers = {};
  if (values.answers) {
    const raw = values.answers.trim().startsWith('{') ? values.answers : existsSync(values.answers) ? readFileSync(values.answers, 'utf8') : die(`--answers: JSON, or a file with it`);
    try {
      a = JSON.parse(raw);
    } catch {
      die('--answers: not valid JSON');
    }
  }
  if (values.private || values.local) a.table = 'private';
  if (values.lobby) a.table = 'lobby';
  if (values.hosted) a.where = 'hosted';
  if (values.local) a.where = 'local';
  if (values.set) a.set = values.set;
  if (values.seat?.length) a.seats = values.seat;
  if (values.knowledge) a.knowledge = values.knowledge;
  if (values['best-of']) a.best_of = Number(values['best-of']);
  // Best of 1 was removed: a best-of other than 3 (a flag, or answers from an older kit) is refused before anything else.
  const bestOfRefused = bestOfProblem(values['best-of'] ?? a.best_of);
  if (bestOfRefused) die(values['best-of'] ? `--best-of ${values['best-of']}: ${bestOfRefused}` : `best_of ${String(a.best_of)}: ${bestOfRefused}`);
  if (values.mana) a.mana = values.mana;
  if (values['unlisted-model']) a.unlisted_models = true;
  if (values['fresh-session']) a.fresh_session = values['fresh-session'];
  if (values.once) a.play_mode = 'once';
  if (values['keep-playing']) a.play_mode = 'continuous';
  const lim: Record<string, string> = Object.fromEntries(Object.entries({ tables: values['max-tables'], hours: values['max-hours'], tokens: values['max-tokens'], usd: values['max-usd'] })
    .filter(([, v]) => v != null) as Array<[string, string]>);
  if (Object.keys(lim).length) {
    a.play_mode ??= 'continuous';
    const prev = parseLimits(a.limits);
    a.limits = { ...(typeof prev === 'string' ? {} : prev), ...lim } as unknown as Limits;
  } else if (a.play_mode === 'continuous' && a.limits == null && !values.agent && (values.yes || values['dry-run'])) a.limits = 'none';
  if (values['rotate-sets']) a.rotate_sets = values['rotate-sets'];
  else if (a.play_mode === 'continuous' && !values.agent && (values.yes || values['dry-run'])) a.rotate_sets ??= 'same';
  // Flags for scripts: without a table question answered, play one table unless Keep Playing was asked for.
  if (!values.agent && !a.play_mode && (values.yes || values['dry-run'] || !process.stdin.isTTY) && a.seats?.length) a.play_mode = 'once';
  // Flags given without a table: the number of seats decides (1 to 4: the lobby).
  if (!a.table && a.seats?.length && !values.agent) {
    try {
      a.table = expandSeatSpecs(a.seats).length <= LOBBY_MAX_SEATS ? 'lobby' : 'private';
    } catch {
      // the seats question will say what's wrong
    }
  }
  const e: Engine = {
    noLaunch: !!values['no-launch'], directorFlag: values.director, installed: new Map(LAUNCHABLE.map((h) => [h.id, installedVersion(h)])), infos: new Map(),
    apps: detectApps(), hubFlag: values.hub,
  };
  const agent = !!values.agent;
  const interactive = !agent && (values.interactive || (!values.yes && !!process.stdin.isTTY && !values['dry-run']));
  const asker = interactive ? new Asker() : undefined;
  const emit = (o: unknown) => console.log(JSON.stringify(o, null, 1));
  // Flags that change where or how it runs travel with every next command.
  const pass = [
    ...(values.director ? [`--director ${values.director}`] : []), ...(values.hub ? [`--hub ${values.hub}`] : []),
    ...(values['no-launch'] ? ['--no-launch'] : []), ...(values['skip-preflight'] ? ['--skip-preflight'] : []),
    ...(values['use-api-key'] ? ['--use-api-key'] : []), ...(values.relaunch ? [`--relaunch ${values.relaunch}`] : []),
    // A dry run stays one to the end: its confirmation step has no `next` that would create the event.
    ...(values['dry-run'] ? ['--dry-run'] : []),
  ].map((x) => ` ${x}`).join('');
  const again = (extra = '') => `${BENCH} setup --agent${pass} --answers '${JSON.stringify(a).replace(/'/g, `'\\''`)}'${extra}`;
  if (asker) console.log('MTG Deck Tools Agent Benchmark: set up an event. Press Enter to take the [recommended] answer.\n');

  // Questions until the plan is complete.
  let plan: Plan;
  let adviceShown = '';
  for (;;) {
    const r = await evaluate(e, a);
    if ('plan' in r) {
      plan = r.plan;
      break;
    }
    if (agent) {
      return emit({
        step: 'questions', questions: r.questions, answers: a,
        ...(r.table_check ? { table_check: r.table_check } : {}),
        instructions: 'Ask the person these questions in plain language, with the options and the recommended answer (and why). Then run `next` with every answer so far plus the new ones in --answers (question ids are the keys; "effort:<harness>/<model>" answers go in "efforts": {"<harness>/<model>": "<level>"}; "seats" is a list of lines). Never answer for the person.'
          + (r.questions.some((q) => q.needed?.length) ? ' With the seats question, mention `needed`: the seats that are most needed right now that they can run (lead with the first one).' : '')
          + (r.table_check ? ' Before the other questions, tell them `table_check.warning` plainly and offer `table_check.suggestions` (each has the seat lines to use as their "seats" answer; "Join the Lobby" means table "lobby" with 1-4 seats). Keeping their seats is fine: it is never refused.' : ''),
        next: `${BENCH} setup --agent${pass} --answers '<answers JSON>'`,
      });
    }
    if (!asker) {
      const q = r.questions[0]!;
      // Flags for scripts: one table, where it runs and what the agents know have documented defaults (Play One Table,
      // hosted, Set Context where the set has one). Everything else, the seats and their effort above all, must be given.
      const flag = { play_mode: '--once or --keep-playing', where: '--hosted or --local', knowledge: '--knowledge <level>' }[q.id];
      if (flag && !q.error && q.recommended === { play_mode: 'once', where: 'hosted', knowledge: 'primer' }[q.id]) {
        setAnswer(a, q.id, q.recommended!);
        console.log(`${q.ask} ${q.options?.find((o) => o.value === q.recommended)?.label ?? q.recommended} (the default; ${flag} to choose).`);
        continue;
      }
      if (q.id === 'seats') die(`${q.error ? `${q.error}. ` : ''}${q.ask} Give --seat "${q.format?.match(/e\.g\. "([^"]+)"/)?.[1] ?? 'harness / model / effort'}" (repeat it for more seats); \`${BENCH} check\` lists the harnesses and models you can use.`);
      die(`${q.error ? `${q.error}. ` : ''}${q.ask}${q.options?.length ? ` Options: ${q.options.map((o) => o.value).join(', ')}${q.recommended ? ` (recommended: ${q.recommended}${q.why ? `, ${q.why}` : ''})` : ''}.` : ''}${q.format ? ` Format: ${q.format}` : ''}`);
    }
    if (r.table_check?.warning && adviceShown !== JSON.stringify(a.seats)) {
      adviceShown = JSON.stringify(a.seats);
      console.log(`\n${r.table_check.line}`);
      for (const l of adviceText(r.table_check)) console.log(l);
      const pick = await asker!.ask(`Press Enter to keep your seats, or choose 1–${r.table_check.suggestions.length}`, undefined, true);
      const sug = r.table_check.suggestions[Number(pick) - 1];
      if (sug?.kind === 'lobby') {
        a.table = 'lobby';
        delete a.seats;
        delete a.where;
        continue;
      }
      if (sug) {
        a.seats = sug.seats;
        adviceShown = JSON.stringify(a.seats);
        continue;
      }
    }
    const q = r.questions[0]!;
    console.log(`\n${q.ask}${q.help ? `\n  ${q.help}` : ''}`);
    if (q.error) console.log(`  (${q.error})`);
    if (q.id === 'seats') {
      if (q.format) console.log(`  ${q.format}`);
      const lines: string[] = [];
      for (;;) {
        const line = await asker!.ask(lines.length ? 'More (Enter when done)' : 'Seats', undefined, true);
        if (!line) break;
        lines.push(line);
        if (a.table === 'private' && expandCount(lines) >= TABLE_SEATS) break;
        if (a.table === 'lobby' && expandCount(lines) >= LOBBY_MAX_SEATS) break;
      }
      a.seats = lines;
      continue;
    }
    q.options?.forEach((o, i) => console.log(`  ${i + 1}) ${o.label}${o.detail ? `: ${o.detail}` : ''}${o.recommended ? '  (recommended)' : ''}`));
    if (q.why) console.log(`  Recommended: ${q.options?.find((o) => o.value === q.recommended)?.label ?? q.recommended} (${q.why}).`);
    const def = q.options?.findIndex((o) => o.value === q.recommended);
    const ans = await asker!.ask('Choice', def != null && def >= 0 ? String(def + 1) : q.recommended);
    const byIndex = q.options?.[Number(ans) - 1]?.value;
    setAnswer(a, q.id, byIndex ?? ans);
  }

  // Sign in for the hosted table and the lobby. A dry run needs neither the sign-in nor the terms: it runs every local
  // check and shows the whole Confirmation, and stops before anything would be created on the server.
  const dry = !!values['dry-run'] && !values.confirm;
  const signInFirst = dry && plan.hosted && !contributorToken(values.token)
    ? `Sign in to create this table: \`${BENCH} login\` (GitHub sign-in, once; you accept the terms then).`
    : undefined;
  if (plan.hosted && !dry && !contributorToken(values.token)) {
    if (agent) {
      const info = await fetchTerms(hubUrl(values.hub));
      return emit({
        step: 'sign_in', message: 'The hosted table needs a free contributor token (GitHub sign-in, once), and the person must accept the terms first.',
        ...(info ? { terms: termsText(info), terms_links: info.links } : {}),
        instructions: `${info ? 'Show the person `terms` as it is and ask whether they accept. Only if they say yes, run' : 'Run'} the first command and show the person the link and code it prints; then run the second, which returns once they have entered the code. Then run \`next\`.`,
        commands: [`${BENCH} login --start${info ? ' --accept-terms' : ''}`, `${BENCH} login --wait`], next: again(),
      });
    }
    if (!asker) die(`not signed in: run \`${BENCH} login\` first (GitHub sign-in, once), then run this again`);
    console.log('\nThe hosted table needs a free contributor token: a GitHub sign-in, once.');
    const hub = hubUrl(values.hub);
    await consentBeforeLogin(hub, {});
    await loginWait(await loginStart(hub));
    await finishLogin(hub, contributorToken() ?? '');
  }
  // The terms: accepted, or accepted again after a change (the Hub refuses hosted play until then; consent.ts).
  const signedIn = plan.hosted && !dry ? contributorToken(values.token) : undefined;
  if (signedIn) {
    const hub = account()?.hub ?? hubUrl(values.hub);
    if (agent) {
      const t = await termsStep(hub, signedIn);
      if (t) {
        return emit({
          step: 'terms', message: 'The terms changed or were never accepted; the hosted table needs them accepted.', terms: t.text, terms_links: t.links,
          instructions: 'Show the person `terms` as it is and ask whether they accept. Only if they say yes, run the command, then run `next`.',
          commands: [`${BENCH} terms --accept`], next: again(),
        });
      }
    } else if (!(await ensureTerms(hub, signedIn, {}))) die(`the hosted table needs the terms accepted: run \`${BENCH} terms\` when you are ready`);
  }

  // Confirmation (with the preflight), unless this is the confirmed run.
  const code = planCode(plan);
  const cacheFile = join(CONFIG_DIR, `setup-${code}.json`);
  let conf: Confirmation;
  if (values.confirm && existsSync(cacheFile)) conf = JSON.parse(readFileSync(cacheFile, 'utf8'));
  else {
    const log = agent ? undefined : (s: string) => console.log(s);
    if (!agent) console.log('');
    const checks = await runPreflights(e, plan, { skip: values['skip-preflight'], useApiKey: values['use-api-key'], log });
    conf = confirmation(e, plan, checks, !!values['skip-preflight'], plan.table === 'lobby' ? await lobbyView(e, plan.base) : undefined);
    mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(cacheFile, JSON.stringify(conf), { mode: 0o600 });
  }
  if (values.confirm) {
    if (values['dry-run']) die('--dry-run with --confirm: a dry run creates nothing. Run it again without --dry-run to start.');
    if (values.confirm !== code) die('the answers changed since that confirmation: run setup again without --confirm and confirm the new summary');
    if (!conf.ready) die(`not ready: ${conf.problems.join(' ')}`);
  } else if (agent && values['dry-run']) {
    return emit({
      step: 'confirm', dry_run: true, confirmation: conf, answers: a, ...(signInFirst ? { sign_in: signInFirst } : {}),
      instructions: `This is a dry run: nothing will be created. Show the person \`confirmation.text\` as it is.${signInFirst ? ' Then tell them `sign_in`: a real run signs them in first.' : ''} To start for real, run setup again with the same answers and without --dry-run.`,
    });
  } else if (agent) {
    return emit({
      step: 'confirm', confirmation: conf, answers: a,
      instructions: conf.ready
        ? `Show the person \`confirmation.text\` as it is and ask them to confirm. Run \`next\` only after they say yes; if they want changes, go back with new answers.${conf.table_warning ? ' It warns that this table produces few or no rated games: offer `confirmation.suggestions` (their seat lines replace the "seats" answer), but the table as it is may still be confirmed.' : ''}`
        : 'Show the person `confirmation.text`: it lists what to fix before starting. After they fix it, run setup again with the same answers.',
      ...(conf.ready ? { next: again(` --confirm ${conf.code}`) } : {}),
    });
  } else {
    console.log(`\n${conf.text}`);
    const go = conf.ready && !values['dry-run'] && (values.yes || (asker ? !/^n/i.test(await asker.ask(`\n${plan.mode === 'continuous' ? 'Start Keep Playing' : plan.table === 'lobby' ? 'Join the lobby' : 'Start the event'}? [Y/n]`, '')) : false));
    if (!go) {
      asker?.close();
      console.log(`\nNothing created.${conf.ready && !values['dry-run'] ? ` To go ahead: ${BENCH} setup ${planFlags(plan)} --yes` : ''}`);
      if (signInFirst) console.log(signInFirst);
      return;
    }
  }
  asker?.close();

  // Keep Playing: the loop runs in the background (loop.ts) and starts every table, the first one included.
  if (plan.mode === 'continuous') {
    const loop = startLoop({
      plan: { ...plan, seats: plan.seats.map((s) => ({ ...s })) }, confirmation: conf, relaunch: values.relaunch, useApiKey: !!values['use-api-key'],
      skipPreflight: !!values['skip-preflight'], token: values.token, hub: values.hub,
    });
    const out = {
      step: 'started', loop: loop.id, mode: 'continuous', pid: loop.pid, log: loop.log, summary: loop.summary,
      status_command: `${BENCH} status ${loop.id}`, stop_command: `${BENCH} stop ${loop.id}`, stop_now_command: `${BENCH} stop ${loop.id} --now`,
      limits: conf.limits, time: conf.time,
      instructions: 'Tell the person: Keep Playing started in the background (it keeps going if they close the terminal), the loop id, the summary file, and the status and stop commands (`stop` finishes the current table first; `stop --now` ends it at once). Then you are done; do not wait for it.',
    };
    if (agent) return emit(out);
    console.log(`\nKeep Playing started in the background (loop ${loop.id}, pid ${loop.pid}; it keeps going if you close this terminal).`);
    console.log(`  Summary:  ${tilde(loop.summary)} (every table, its result and its tokens)`);
    console.log(`  Log:      ${tilde(loop.log)}`);
    console.log(`  Status:   ${BENCH} status ${loop.id}`);
    console.log(`  Stop:     ${BENCH} stop ${loop.id}          (finishes the current table, then stops)`);
    console.log(`            ${BENCH} stop ${loop.id} --now    (stops at once${plan.table === 'lobby' ? '; your seats at a running table forfeit' : '; the current table is canceled'})`);
    return;
  }
  // Confirmed: the lobby takes it from here; a private table is created and this machine's seats start.
  if (plan.table === 'lobby') return lobbyHandOff(plan, { 'no-launch': values['no-launch'], detach: agent || !!values.yes });
  const created = await createEvent({
    base: plan.base, set: plan.set, seats: plan.seats, knowledge: plan.knowledge, mana: plan.mana, bestOf: plan.bestOf, podSize: TABLE_SEATS,
    token: values.token, hosted: plan.hosted, allowUnlisted: plan.unlisted,
  });
  // `launch`: exactly what `bench play` may start for each seat (cli.ts checkLaunchSource refuses anything else).
  const launch = Object.fromEntries(plan.seats.map((s) => [s.name, { harness: s.harness, model: s.model, effort: s.effort, ...(s.contextPolicy ? { context_policy: s.contextPolicy } : {}), ...(s.launchModel ? { launch_model: s.launchModel } : {}) }]));
  writeFileSync(join(created.dir, 'confirmation.json'), JSON.stringify({ confirmed_at: new Date().toISOString(), ...conf, launch }, null, 1), { mode: 0o600 });
  return report(e, plan, created, { relaunch: values.relaunch, useApiKey: values['use-api-key'], agent });
}

const expandCount = (lines: string[]) => {
  try {
    return expandSeatSpecs(lines).length;
  } catch {
    return 0;
  }
};

function planFlags(p: Plan): string {
  // Repeated seats are written once with a count.
  const groups: Array<{ text: string; n: number }> = [];
  for (const s of p.seats) {
    const text = [s.harness, s.model, s.effortUnknown ? 'unknown' : s.effort].join('/');
    const g = groups.find((x) => x.text === text);
    if (g) g.n++;
    else groups.push({ text, n: 1 });
  }
  return [
    p.table === 'lobby' ? '--lobby' : p.hosted ? '--hosted' : '--local',
    ...(p.base !== HOSTED_DIRECTOR_URL && (p.hosted || p.base !== directorUrl()) ? [`--director ${p.base}`] : []),
    `--set ${p.set}`, ...groups.map((g) => `--seat "${g.n > 1 ? `${g.n}x ` : ''}${g.text}"`), `--knowledge ${p.knowledge}`,
    ...(p.mana !== 'manual' ? [`--mana ${p.mana}`] : []),
    ...(p.unlisted ? ['--unlisted-model'] : []),
    ...(freshFlag(p) ? [`--fresh-session ${freshFlag(p)}`] : []),
    ...(p.mode === 'continuous' ? ['--keep-playing', ...limitFlags(p.limits)] : ['--once']),
    ...(p.rotation.length ? [`--rotate-sets ${p.rotation.join(',')}`] : []),
  ].join(' ');
}

/** Hand the confirmed seats to the lobby command (or print it, when this build of the kit doesn't have it). */
function lobbyHandOff(p: Plan, o: { 'no-launch'?: boolean; detach: boolean }) {
  const args = [
    ...LOBBY_COMMAND, '--set', p.set, '--knowledge', p.knowledge, '--mana', p.mana,
    ...p.seats.flatMap((s) => ['--seat', `${s.harness}/${s.model}/${s.effort}`]),
    ...(p.base !== HOSTED_DIRECTOR_URL ? ['--director', p.base] : []), ...(o['no-launch'] ? ['--no-launch'] : []),
    // The seats' context policy, when the default wouldn't give the same (lobby.ts applies the same rule).
    ...(!o['no-launch'] && freshFlag(p) ? ['--fresh-session', freshFlag(p)!] : []),
    // A coding agent's shell would block on the foreground hold: hold the place in the background instead.
    ...(o.detach ? ['--detach'] : []),
  ];
  if (!COMMANDS[LOBBY_COMMAND[0]!]) {
    console.log(`\nThis build of the kit has no lobby command. Join with:\n  ${BENCH} ${args.map((x) => (/^[\w@%+=:,./~-]+$/.test(x) ? x : `"${x}"`)).join(' ')}`);
    return;
  }
  return COMMANDS[LOBBY_COMMAND[0]!]!(args.slice(1));
}

function report(e: Engine, p: Plan, c: Created, o: { relaunch?: string; useApiKey?: boolean; agent: boolean }) {
  const { ev, dir } = c;
  const here = p.seats.filter((s) => launchHere(e, s));
  const byHand = p.seats.filter((s) => !launchHere(e, s));
  let bg: { pid: number; log: string } | undefined;
  if (here.length) {
    const extra = [...(o.relaunch ? ['--relaunch', o.relaunch] : []), ...(o.useApiKey ? ['--use-api-key'] : [])];
    bg = startPlayInBackground(dir, ev.id, here.map((s) => s.name), extra);
  }
  const watch = p.hosted ? `${WATCH_SITE}/agent-bench/watch/${ev.id}/live` : null;
  const handSteps = byHand.map((s) => {
    const h = harnessFor(s.harness);
    return {
      seat: s.name, model: s.model ? modelLabel(s.model) : s.model, harness: h?.label ?? s.harness, effort: s.effort ? effortLabel(s.effort) : s.effort, url: ev.seats[s.name],
      steps: [
        ...(h?.launch ? [`${h.label} can be started from the command line: install it, then run \`${BENCH} play ${ev.id} --seat ${s.name}\`. Or by hand:`] : []),
        `Add an MCP server named "mtg" (Streamable HTTP) with the seat URL. It is the seat's key: keep it private.`,
        `Set the model to ${s.model ? modelLabel(s.model) : '?'}${s.effort && s.effort !== 'default' && s.effort !== 'unknown' ? ` and the effort to ${s.effort}` : ''}, allow only the mtg tools, start a new session and send the join prompt as its first message (\`${BENCH} prompt\` prints it).`,
        'Let it play until it says EVENT COMPLETE. If the session stops early, start a new one on the same URL with the same prompt.',
        `When your seats finish: \`${BENCH} attach-logs ${ev.id}\` reads your ${h?.label ?? registry.harnessLabel(s.harness!)} session logs (after asking) to verify the model and effort. It keeps only the model, effort, version and token counts.`,
      ],
      config: h && h.id !== 'generic' && !h.test ? h.snippet({ name: s.name, url: ev.seats[s.name]! }) : undefined,
    };
  });
  const est = estimate(p.seats.length, undefined, freshOf(p));
  if (o.agent) {
    return console.log(JSON.stringify({
      step: 'started', event: ev.id, status: c.status, queue_position: c.queuePosition ?? null, watch,
      started_here: here.map((s) => s.name), background: bg ? { pid: bg.pid, log: bg.log } : null, by_hand: handSteps,
      status_command: `${BENCH} status ${ev.id}`, stop_command: `${BENCH} stop ${ev.id}`, folder: dir, time: est.time,
      ...(handSteps.length ? { attach_logs_command: `${BENCH} attach-logs ${ev.id} --agent` } : {}),
      results: p.hosted ? 'The leaderboard picks the results up when the event ends; nothing to submit.' : `When it ends: ${BENCH} pull ${ev.id} && ${BENCH} bundle ${ev.id}, then ${BENCH} submit <bundle>.`,
      instructions: 'Tell the person: the Watch link, which seats started here, the steps (with the seat URL) for every seat they start themselves, the time, and the status and stop commands. If any seat is started by hand, tell them to run (or ask you to run) `attach_logs_command` once the event ends: it asks before reading their session logs. Then you are done; do not wait for the event to finish.',
    }, null, 1));
  }
  console.log(`\nEvent ${ev.id} created${c.status === 'queued' ? `. It is queued (position ${c.queuePosition ?? '?'}): the server is full and starts it on its own when a table frees up. Seats that connect meanwhile wait.` : ' and running.'}`);
  if (bg) {
    console.log(`\nStarted on this machine, in the background (pid ${bg.pid}; it keeps going if you close this terminal):`);
    for (const s of here) console.log(`  ${s.name}`);
    console.log(`  Progress: ${tilde(bg.log)}. A seat whose session ends early is restarted and picks up where it was.`);
  }
  if (handSteps.length) {
    console.log(`\nStart ${handSteps.length === 1 ? 'this seat' : 'these seats'} yourself, each in a new session of its harness:`);
    for (const h of handSteps) {
      console.log(`\n  ${h.seat} (${h.harness} / ${h.model})`);
      console.log(`    Seat URL: ${h.url}`);
      h.steps.forEach((x, i) => console.log(`    ${i + 1}. ${x}`));
      if (h.config) console.log(h.config.replace(/^/gm, '       '));
    }
    console.log(`\n  \`${BENCH} seats ${ev.id}\` prints these again. The join prompt is also in ${tilde(JOIN_PROMPT)}.`);
  }
  console.log('\nFollow it');
  if (watch) console.log(`  Watch:    ${watch}`);
  console.log(`  Status:   ${BENCH} status ${ev.id}`);
  console.log(`  Stop:     ${BENCH} stop ${ev.id}`);
  console.log(p.hosted ? '  Results:  the leaderboard picks them up when the event ends; nothing to submit.'
    : `  Results:  when it ends, ${BENCH} pull ${ev.id} && ${BENCH} bundle ${ev.id}, then ${BENCH} submit <bundle> (after \`${BENCH} login\`).`);
  console.log(`  Files:    ${tilde(dir)} (seat URLs, transcripts; private)`);
  console.log(`\nTime: ${est.time}`);
}

/** Prompts on a terminal; also reads answers piped on stdin (one per line; an empty line takes the default). */
class Asker {
  private lines: string[] = [];
  private waiting: ((l: string | undefined) => void) | undefined;
  private closed = false;
  private rl = createInterface({ input: process.stdin, terminal: false });

  constructor() {
    this.rl.on('line', (l) => {
      if (this.waiting) {
        const w = this.waiting;
        this.waiting = undefined;
        w(l);
      } else this.lines.push(l);
    });
    this.rl.on('close', () => {
      this.closed = true;
      this.waiting?.(undefined);
    });
  }

  async ask(q: string, def?: string, allowEmpty = false): Promise<string> {
    process.stdout.write(`${q}${def ? ` [${def}]` : ''}: `);
    const line = this.lines.length ? this.lines.shift() : this.closed ? undefined : await new Promise<string | undefined>((r) => (this.waiting = r));
    if (line === undefined) {
      process.stdout.write('\n');
      return def ?? (allowEmpty ? '' : die('no answer (input closed)'));
    }
    if (!process.stdin.isTTY) process.stdout.write(`${line}\n`);
    return line.trim() || def || '';
  }

  close() {
    this.rl.close();
  }
}
