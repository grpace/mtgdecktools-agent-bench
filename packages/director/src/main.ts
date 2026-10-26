import { installLogCap } from './log-cap.js';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, chownSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { resolvePromptsDir } from './prompts.js';
import { parseArgs } from 'node:util';
import { BEST_OF, bestOfProblem } from './best-of.js';
import { BoosterFactory } from './boosters.js';
import { adjustForOverrides, archiveBoosterData, BoosterFactories } from './booster-archive.js';
import { CardDb, overrideSupported } from './cards.js';
import { Event } from './event.js';
import { HubAuth } from './hub-auth.js';
import { HubHandoff, hubTargetFromEnv } from './hub-handoff.js';
import { compressEventLog, compressHandedOff } from './log-files.js';
import type { ManaMode } from './game.js';
import { DEFAULT_PRIMER_URL, type KnowledgeLevel } from './knowledge.js';
import { DEFAULT_MCP_LIMITS, startHttp } from './mcp.js';
import { boosterProvenance } from './provenance.js';
import { DEFAULT_LIMITS, EventServer } from './server.js';
import { DEFAULT_LOBBY, type Schedule } from './lobby.js';
import { DEFAULT_ADMISSION } from './admission.js';
import { SpectateHub } from './spectate-http.js';
import { normalizeEffort, resolveSeat } from '../../registry/src/index.js';
import { spectatePolicyFromEnv } from './spectate-policy.js';
import { parseSubmitTokens } from './submissions.js';
import { neutralSeatNames } from './seat-names.js';
import { CONTEXT_POLICIES, isContextPolicy } from './context-policy.js';

const root = resolve(import.meta.dirname, '../../..');
const env = process.env;
const { values } = parseArgs({
  options: {
    serve: { type: 'boolean', default: false },
    set: { type: 'string', default: 'fra' },
    agents: { type: 'string', default: 'agent-1,agent-2' },
    seed: { type: 'string' },
    pod: { type: 'string', default: '8' },
    /** Fixed at 3: every event plays best of 3 with sideboarding (best-of.ts). Kept so `--best-of 3` still works. */
    'best-of': { type: 'string', default: String(BEST_OF) },
    knowledge: { type: 'string', default: 'none' },
    mana: { type: 'string', default: 'manual' },
    phase: { type: 'string', default: env.PHASE_SERVER_URL ?? 'ws://127.0.0.1:9374/ws' },
    port: { type: 'string', default: env.PORT ?? '8787' },
    host: { type: 'string', default: env.HOST ?? '127.0.0.1' },
    'public-url': { type: 'string', default: env.PUBLIC_URL },
    /** Engine data (card-data.json, draft-pools.json): may be phase-server's read-only volume. */
    data: { type: 'string', default: env.DATA_DIR ?? resolve(root, 'data') },
    /** Writable caches (slim card index, fetched primers). Defaults to the data dir. */
    cache: { type: 'string', default: env.CACHE_DIR },
    runs: { type: 'string', default: env.RUNS_DIR ?? resolve(root, 'runs') },
    sets: { type: 'string', default: resolve(root, 'sets') },
    /** The current prompts (prompts/); the released set by name ("v9", "prompts/v9"). */
    prompts: { type: 'string', default: resolve(root, 'prompts') },
    'primer-url': { type: 'string', default: env.PRIMER_URL ?? DEFAULT_PRIMER_URL },
    'site-data': { type: 'string', default: env.SITE_DATA_DIR },
    /** One-shot only: swiss (3 rounds, default) or round-robin. */
    pairing: { type: 'string', default: 'swiss' },
    /** Dev only (engine testing): bot drafters fill the seats agents don't. The event is labeled Smoke, never rated. */
    'dev-bot-fill': { type: 'boolean', default: false },
    /**
     * One-shot only: declared context policies (context-policy.ts), logged in event_start.seats[]: "fresh-per-game" for
     * every seat with a model, or "seat-a=fresh-per-game,seat-b=fresh-per-match". `bench play` starts the seats with it.
     */
    'context-policy': { type: 'string' },
  },
});

const bestOfRefused = bestOfProblem(values['best-of']);
if (bestOfRefused) {
  console.error(`--best-of ${values['best-of']}: ${bestOfRefused}`);
  process.exit(2);
}

const cacheDir = values.cache ?? values.data!;
const cards = new CardDb(join(values.data!, 'card-data.json'), cacheDir);
// Every version of the booster data events ran on, by hash (booster-archive.ts): resumed events regenerate their packs
// from it after an engine upgrade. BOOSTER_ARCHIVE_DIRS: more places to look (the Hub's archive, a backup), colon-separated.
const boosterArchive = env.BOOSTER_ARCHIVE ?? join(cacheDir, 'booster-archive');
const archiveDirs = [boosterArchive, ...(env.BOOSTER_ARCHIVE_DIRS ?? '').split(':').filter(Boolean)];
// Unsupported cards: the curated list when present (build markers + published coverage, see
// scripts/refresh-phase-data.py), otherwise the markers found in this build's card data. The list this Director
// generated itself (in the cache, no `sources`) is for one card data file: after an engine upgrade it is archived (events
// that started on it resume on it) and built again.
// Keyed by the upstream card data when card overrides are applied (the sidecar says which): that is the base list. The
// cards an applied override makes supported (`marks_supported`) then come off it, below (docs/CARD-OVERRIDES.md
// "Supported Cards and Packs").
const cardDataSha = cards.provenance()?.upstream_sha256 ?? cards.provenance()?.sha256;
const cachedList = join(cacheDir, 'unsupported-cards.json');
if (existsSync(cachedList) && cardDataSha) {
  try {
    const raw = readFileSync(cachedList);
    const c = JSON.parse(raw.toString('utf8')) as { sources?: unknown; card_data_sha256?: string };
    if (!c.sources && c.card_data_sha256 !== cardDataSha) {
      const sha = createHash('sha256').update(raw).digest('hex');
      mkdirSync(boosterArchive, { recursive: true });
      if (!existsSync(join(boosterArchive, `${sha}.json`))) writeFileSync(join(boosterArchive, `${sha}.json`), raw);
      unlinkSync(cachedList);
      console.log(`unsupported-card list: built for other card data; archived as ${sha.slice(0, 12)}… and building it again`);
    }
  } catch (err) {
    console.error(`unsupported-card list: ${String((err as Error)?.message ?? err)}`);
  }
}
const unsupportedFile = [cachedList, join(values.data!, 'unsupported-cards.json')].find((p) => existsSync(p));
let unsupported = unsupportedFile ? (JSON.parse(readFileSync(unsupportedFile, 'utf8')).unsupported as string[]) : cards.unimplemented;
let unsupportedSource: { file: string } | { list: string[] } = unsupportedFile ? { file: unsupportedFile } : { list: unsupported };
if (!unsupportedFile) {
  // Same union as scripts/refresh-phase-data.py: add phase-rs's published coverage gaps, then cache.
  try {
    const res = await fetch('https://data.phase-rs.dev/coverage-data.json', { signal: AbortSignal.timeout(60_000) });
    const coverage = (await res.json()) as { cards: Array<{ card_name: string; supported: boolean }> };
    unsupported = [...new Set([...unsupported, ...coverage.cards.filter((c) => !c.supported).map((c) => c.card_name)])];
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, 'unsupported-cards.json'), JSON.stringify({ generated: new Date().toISOString(), ...(cardDataSha ? { card_data_sha256: cardDataSha } : {}), unsupported }));
    unsupportedSource = { file: join(cacheDir, 'unsupported-cards.json') };
  } catch {
    // offline: the build's own markers still apply
  }
}
// Card overrides that make a card supported take it off the list (docs/CARD-OVERRIDES.md "Supported Cards and Packs").
{
  const adj = adjustForOverrides(unsupportedSource, unsupported, overrideSupported(join(values.data!, 'card-data.json')), boosterArchive);
  if (adj) {
    ({ unsupported, source: unsupportedSource } = adj);
    console.log(`unsupported-card list: card overrides make supported: ${adj.removed.join(', ') || 'none'} (${unsupported.length} unsupported)`);
  }
}
const draftPools = join(values.data!, 'draft-pools.json');
const factory = new BoosterFactory(draftPools, unsupported);
// The exact files the factory was built from, logged in every event_start (the Hub regenerates packs from them).
const boosters = boosterProvenance(draftPools, unsupportedSource);
const archived = archiveBoosterData(boosterArchive, draftPools, boosters, unsupportedSource);
if (archived.length) console.log(`booster archive: kept ${archived.join(', ')} (${boosterArchive})`);
const boosterFactories = new BoosterFactories({ factory, boosters }, archiveDirs);
const port = Number(values.port);
const publicUrl = (values['public-url'] ?? `http://127.0.0.1:${port}`).replace(/\/+$/, '');
const spectate = spectatePolicyFromEnv(env);
// Director → Hub hand-off of finished events: only when HUB_URL (and HUB_SERVICE_TOKEN) are set.
const hubTarget = hubTargetFromEnv(env);
const base = {
  spectate,
  phaseUrl: values.phase!,
  runsDir: values.runs!,
  setsDir: values.sets!,
  promptsDir: resolvePromptsDir(values.prompts!),
  primerSources: { url: values['primer-url']!, cacheDir: join(cacheDir, 'primers') },
  boosters,
  // Inactivity forfeit (docs/METHODOLOGY.md §5.5): SEAT_TIMEOUT_MS (default 10 min, 0 = off), SEAT_CONNECT_TIMEOUT_MS (30 min).
  seatTimeoutMs: env.SEAT_TIMEOUT_MS ? Number(env.SEAT_TIMEOUT_MS) : undefined,
  seatConnectTimeoutMs: env.SEAT_CONNECT_TIMEOUT_MS ? Number(env.SEAT_CONNECT_TIMEOUT_MS) : undefined,
  // The most one decision may stay open however often the seat calls (DECISION_MAX_MS, default 30 min; 0 = off).
  decisionMaxMs: env.DECISION_MAX_MS ? Number(env.DECISION_MAX_MS) : undefined,
  // The draft clocks: DRAFT_PICK_MS (default 75 s) per pick, FIRST_PICK_MS (default 3 min) for the first pick; 0 = off.
  draftPickMs: env.DRAFT_PICK_MS ? Number(env.DRAFT_PICK_MS) : undefined,
  firstPickMs: env.FIRST_PICK_MS ? Number(env.FIRST_PICK_MS) : undefined,
};

/**
 * Admin token for server mode: ADMIN_TOKEN, else the file at ADMIN_TOKEN_FILE. If that file doesn't
 * exist yet it is generated (first run of the self-hosted stack) and the token is printed once.
 */
function adminToken(): string | undefined {
  const weak = (t: string) => {
    if (t.length < 32) console.warn(`warning: the admin token is only ${t.length} characters; use at least 32 (openssl rand -hex 24).`);
    return t;
  };
  if (env.ADMIN_TOKEN) return weak(env.ADMIN_TOKEN.trim());
  const file = env.ADMIN_TOKEN_FILE;
  if (!file) return undefined;
  if (existsSync(file) && readFileSync(file, 'utf8').trim()) {
    try {
      chmodSync(file, 0o600); // an older file may have been created with a looser mode (DIR-17)
    } catch {
      // read-only mount: leave it
    }
    return weak(readFileSync(file, 'utf8').trim());
  }
  const token = randomBytes(24).toString('hex');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, token + '\n', { mode: 0o600 });
  // In a container the bind-mounted directory belongs to the host user: hand the file to them.
  try {
    const owner = statSync(dirname(file));
    chownSync(file, owner.uid, owner.gid);
  } catch {
    // not root, or not permitted: the file stays ours
  }
  // Never print the token itself: container and platform logs keep it (OPS-16). Say where it is instead.
  const where = env.ADMIN_TOKEN_HOST_PATH ?? file;
  console.log([
    '',
    '================ FIRST RUN: admin token generated ================',
    `  Saved to ${where} (gitignored, readable only by you).`,
    '  Create an event:   npm run bench -- new --set fra --seat alice=claude-code/sonnet --seat bob=claude-code/haiku',
    `  The CLI reads the token from that file; for curl use: Authorization: Bearer $(cat ${where})`,
    '==================================================================',
    '',
  ].join('\n'));
  return token;
}

/** Engine builds accepted for submissions without a flag: the pinned one plus ALLOWED_ENGINE_DIGESTS. */
function allowedEngineDigests(): string[] {
  const list = (env.ALLOWED_ENGINE_DIGESTS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  try {
    list.push(JSON.parse(readFileSync(resolve(root, 'engine/phase.lock.json'), 'utf8')).digest);
  } catch {
    // no lock file: only the listed digests
  }
  return [...new Set(list)];
}

// A bug in one request or event must never take every live event down with the process: log, keep serving.
// (Requests are already isolated in mcp.ts; this is the safety net for stray promise rejections and errors.)
// Every console line is capped (log-cap.ts), so a hostile request can't write megabyte lines.
installLogCap();
// Until the server is up, a failure is a failed start: exit 1 (a top-level await that rejects would otherwise end up
// here and the process would exit 0, as if it had stopped cleanly).
let serving = false;
process.on('unhandledRejection', (err) => {
  console.error(`unhandled rejection: ${String((err as Error)?.stack ?? err)}`);
  if (!serving) process.exit(1);
});
process.on('uncaughtException', (err) => {
  console.error(`uncaught exception: ${String(err?.stack ?? err)}`);
  if (!serving) process.exit(1);
});

if (values.serve) {
  const admin = adminToken();
  if (!admin) console.warn('warning: ADMIN_TOKEN is not set; events cannot be created over the API.');
  // COMPRESS_HANDED_OFF=1 (the hosted stack): once the Hub has accepted an event, keep its log gzipped (log-files.ts).
  const compress = env.COMPRESS_HANDED_OFF === '1' || env.COMPRESS_HANDED_OFF === 'true';
  const handoff = hubTarget ? new HubHandoff(hubTarget, compress ? { afterAccepted: (dir) => void compressEventLog(dir) } : {}) : undefined;
  if (handoff) {
    console.log(`hub hand-off on: finished events go to ${hubTarget!.url}`);
    handoff.resendPending(values.runs!)
      .then(async () => {
        if (!compress) return;
        const done = await compressHandedOff(values.runs!);
        if (done.length) console.log(`compressed the logs of ${done.length} event(s) the Hub has accepted`);
      })
      .catch((err) => console.error(`hub hand-off: resend failed: ${String(err?.stack ?? err)}`));
  }
  const submitTokens = parseSubmitTokens(env.SUBMIT_TOKENS ?? (env.SUBMIT_TOKENS_FILE && existsSync(env.SUBMIT_TOKENS_FILE) ? readFileSync(env.SUBMIT_TOKENS_FILE, 'utf8') : ''));
  if (submitTokens.length) console.log(`submissions enabled for ${submitTokens.length} token(s)`);
  const trustProxy = env.TRUST_PROXY === '1' || env.TRUST_PROXY === 'true';
  const proxyHops = Math.max(1, Number(env.TRUST_PROXY_HOPS) || 1);
  // Hosted play: contributor tokens are checked with the Hub (the same HUB_URL + service token as the hand-off).
  const hubAuth = hubTarget ? new HubAuth(hubTarget) : undefined;
  const num = (v: string | undefined, d: number) => (v != null && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : d);
  const limits = {
    admission: {
      capacity: num(env.MAX_CONCURRENT_GAMES, DEFAULT_ADMISSION.capacity),
      maxQueue: num(env.MAX_QUEUE, DEFAULT_ADMISSION.maxQueue),
      contributor: { concurrent: num(env.CONTRIB_CONCURRENT, DEFAULT_ADMISSION.contributor.concurrent), daily: num(env.CONTRIB_DAILY, DEFAULT_ADMISSION.contributor.daily) },
      // Lobby tables have their own quota (defaults when the Hub sends none; the Hub's HUB_LOBBY_* normally win).
      lobby: { concurrent: num(env.LOBBY_CONTRIB_CONCURRENT, DEFAULT_ADMISSION.lobby!.concurrent), daily: num(env.LOBBY_CONTRIB_DAILY, DEFAULT_ADMISSION.lobby!.daily) },
      continuousReserve: num(env.CONTINUOUS_RESERVE_SLOTS, DEFAULT_ADMISSION.continuousReserve!),
      continuousPerContributor: num(env.CONTINUOUS_PER_CONTRIBUTOR, DEFAULT_ADMISSION.continuousPerContributor!),
    },
    eventMaxMs: num(env.EVENT_MAX_HOURS, DEFAULT_LIMITS.eventMaxMs / 3600_000) * 3600_000,
    queueMaxWaitMs: num(env.QUEUE_MAX_WAIT_HOURS, DEFAULT_LIMITS.queueMaxWaitMs / 3600_000) * 3600_000,
    retainMs: DEFAULT_LIMITS.retainMs,
    hostedSets: (env.HOSTED_SETS ?? '').split(',').map((x) => x.trim()).filter(Boolean),
    apiPerMin: num(env.API_RATE_PER_MIN, DEFAULT_LIMITS.apiPerMin),
    createPerMin: num(env.CREATE_RATE_PER_MIN, DEFAULT_LIMITS.createPerMin),
    jsonMaxBytes: num(env.API_MAX_BODY, DEFAULT_LIMITS.jsonMaxBytes),
  };
  // The matchmaking lobby (docs/LOBBY.md): LOBBY_* settings. LOBBY_CONFIG (a JSON file) holds featured queues and schedules:
  // it seeds a lobby without state, or with LOBBY_CONFIG_APPLY=always (the hosted stack, deploy/lobby.json) replaces them
  // at every start. A missing or unreadable file is logged and the stored config stays.
  let lobbyInitial: { featured?: string[]; schedules?: Schedule[] } | undefined;
  if (env.LOBBY_CONFIG) {
    try {
      lobbyInitial = JSON.parse(readFileSync(env.LOBBY_CONFIG, 'utf8'));
    } catch (err) {
      console.error(`LOBBY_CONFIG ${env.LOBBY_CONFIG} unreadable, ignored: ${String((err as Error).message)}`);
    }
  }
  const applyInitial = env.LOBBY_CONFIG_APPLY === 'always' ? 'always' as const : 'seed' as const;
  const lobbySeatsPerPerson = num(env.LOBBY_MAX_SEATS_PER_CONTRIBUTOR, DEFAULT_LOBBY.maxSeatsPerContributor);
  const lobby = {
    config: {
      // One person's seats at a lobby table, and so also the most one join can bring (docs/LOBBY.md).
      maxSeatsPerContributor: lobbySeatsPerPerson,
      maxSeatsPerJoin: lobbySeatsPerPerson,
      maxEntries: num(env.LOBBY_MAX_ENTRIES, DEFAULT_LOBBY.maxEntries),
      readyWindowMs: num(env.LOBBY_READY_S, 60) * 1000,
      presenceMs: num(env.LOBBY_PRESENCE_S, 120) * 1000,
      entryTtlMs: num(env.LOBBY_ENTRY_TTL_HOURS, 24) * 3600_000,
      lowReliability: num(env.LOBBY_LOW_RELIABILITY, 0.7),
      missCooldownMs: num(env.LOBBY_MISS_COOLDOWN_MIN, 60) * 60_000,
      maxJoinsPerHour: num(env.LOBBY_MAX_JOINS_PER_HOUR, 20),
      maxActiveEntries: num(env.LOBBY_MAX_ACTIVE_ENTRIES, 2000),
      // Scripted test seats in public queues: development only (LOB-4).
      allowScript: env.LOBBY_ALLOW_SCRIPT === '1' || env.LOBBY_ALLOW_SCRIPT === 'true',
      // Diversity-aware filling (docs/LOBBY.md §10): at most this many seats of one setup at a forming table, relaxed after a wait.
      maxSameSetup: num(env.LOBBY_MAX_SAME_SETUP, 4),
      sameSetupWaitMs: num(env.LOBBY_SAME_SETUP_WAIT_MIN, 60) * 60_000,
    },
    siteUrl: env.LOBBY_SITE_URL || undefined,
    anySet: env.LOBBY_ANY_SET === '1' || env.LOBBY_ANY_SET === 'true',
    ...(lobbyInitial ? { initial: lobbyInitial, applyInitial } : {}),
  };
  const server = new EventServer({
    base, adminToken: admin, publicUrl, dataDir: values['site-data'], cardsSlim: join(cacheDir, 'card-data.slim.json'),
    submitTokens, submitMaxBytes: env.SUBMIT_MAX_BYTES ? Number(env.SUBMIT_MAX_BYTES) : undefined, allowedEngineDigests: allowedEngineDigests(),
    trustProxy, proxyHops, spectateToken: env.SPECTATE_TOKEN?.trim() || undefined, handoff, hubAuth, limits, lobby, boosterFactories,
  }, factory, cards);
  // Durability: resume what was live before this start (docs/ARCHITECTURE.md §5), before accepting requests.
  const restored = await server.restore();
  if (restored.resumed.length || restored.queued.length || restored.closed.length) {
    console.log(`resumed ${restored.resumed.length} live event(s)${restored.resumed.length ? ` (${restored.resumed.join(', ')})` : ''}; ${restored.queued.length} queued; ${restored.closed.length} closed`);
  }
  server.startSweeper();
  const http = startHttp(server.seatByToken, cards, port, values.host, server.routes, {
    ...DEFAULT_MCP_LIMITS, trustProxy, proxyHops,
    perSeatPerMin: num(env.MCP_RATE_PER_MIN, DEFAULT_MCP_LIMITS.perSeatPerMin),
    inflightPerSeat: num(env.MCP_INFLIGHT_PER_SEAT, DEFAULT_MCP_LIMITS.inflightPerSeat),
    inflightPerIp: num(env.MAX_INFLIGHT_PER_IP, DEFAULT_MCP_LIMITS.inflightPerIp!),
  });
  http.once('listening', () => (serving = true));
  // Graceful shutdown (redeploys): stop admitting, checkpoint every live event, exit. Live events are not aborted:
  // the next start resumes them; phase-server keeps their games for 120 s (and across its own restarts).
  let stopping = false;
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      if (stopping) process.exit(1);
      stopping = true;
      const live = server.liveCounts();
      server.shutdown();
      console.log(`${sig}: checkpointed ${live.events} live event(s) (${live.games} game(s) in progress, ${live.queued} queued); they resume at the next start`);
      http.close();
      setTimeout(() => process.exit(0), 200).unref();
    });
  }
  console.log(`director serving on ${values.host}:${port} (public ${publicUrl}); ${unsupported.length} unsupported cards; phase ${values.phase}; spectating ${spectate.access} (draft ${spectate.draft}, hidden ${spectate.hidden}); capacity ${limits.admission.capacity} game slot(s)${hubAuth ? '; contributor tokens checked with the hub' : ''}`);
} else {
  // One-shot: run a single event from the command line, then exit.
  // --agents "sonnet-1=claude-code/sonnet/high,haiku-2=claude-code/haiku": name, then optional harness/model/effort.
  const agentSpecs = values.agents!.split(',').map((s) => s.trim()).filter(Boolean).map((spec) => {
    const [name, meta] = spec.split('=') as [string, string | undefined];
    // harness/model[/effort]; a model id may contain slashes (OpenCode's anthropic/claude-sonnet-5-5).
    const [harness, ...rest] = (meta ?? '').split('/');
    const effort = rest.length >= 2 && normalizeEffort(rest[rest.length - 1]).ok ? rest.pop() : undefined;
    const model = rest.join('/') || undefined;
    if (!harness && !model) return { name, meta: {} as Record<string, string> };
    // Canonical names (registry/README.md); a local one-shot table may run models the registry doesn't list (Unlisted).
    const r = resolveSeat({ harness, model, effort }, { allowUnlisted: true });
    if (!r.ok) {
      console.error(`--agents ${name}: ${r.error}`);
      process.exit(2);
    }
    for (const w of r.warnings) console.warn(`--agents ${name}: ${w}`);
    return { name, meta: Object.fromEntries(Object.entries(r.seat).filter(([, v]) => v)) as Record<string, string> };
  });
  if (values['context-policy']) {
    for (const item of values['context-policy'].split(',').map((x) => x.trim()).filter(Boolean)) {
      const [who, policy] = item.includes('=') ? (item.split('=') as [string, string]) : [undefined, item];
      if (!isContextPolicy(policy)) {
        console.error(`--context-policy ${item}: use ${CONTEXT_POLICIES.join(' or ')}`);
        process.exit(2);
      }
      const targets = who ? agentSpecs.filter((a) => a.name === who) : agentSpecs.filter((a) => a.meta.model && a.meta.harness !== 'script');
      if (!targets.length) {
        console.error(`--context-policy ${item}: ${who ? `no seat named ${who} in --agents` : 'no seat with a model in --agents'}`);
        process.exit(2);
      }
      for (const a of targets) a.meta.context_policy = policy;
    }
  }
  // Neutral seat names here too (seat-names.ts): "sonnet-1=claude-code/sonnet/high" plays as seat-<hex>.
  const named = neutralSeatNames(agentSpecs.map((a) => ({ ...a, harness: a.meta.harness, model: a.meta.model })));
  for (const [from, to] of Object.entries(named.renamed)) console.log(`--agents ${from}: plays as ${to} (seat names never name a model)`);
  agentSpecs.splice(0, agentSpecs.length, ...named.seats.map(({ name, meta }) => ({ name, meta })));
  if (agentSpecs.length < Number(values.pod) && !values['dev-bot-fill']) {
    console.error(`An event needs an agent in each of its ${values.pod} seats (got ${agentSpecs.length}). Seat ${values.pod} agents (scripted ones work: scripts/mcp-random-agent.mjs), or add --dev-bot-fill for an engine test with bot drafters (labeled Smoke, never rated).`);
    process.exit(2);
  }
  const event = new Event({
    ...base,
    set: values.set!,
    agents: agentSpecs.map((a) => a.name),
    agentMeta: Object.fromEntries(agentSpecs.map((a) => [a.name, a.meta])),
    mana: values.mana as ManaMode,
    seed: values.seed,
    podSize: Number(values.pod),
    bestOf: BEST_OF,
    knowledge: values.knowledge as KnowledgeLevel,
    pairing: values.pairing === 'round-robin' ? 'round-robin' : 'swiss',
    devBotFill: values['dev-bot-fill'],
  }, factory, cards);
  if (values['dev-bot-fill'] && event.agents.length < event.seats.length) {
    console.log(`dev event: ${event.seats.length - event.agents.length} bot drafter(s) fill the empty seats; labeled Smoke, never rated or accepted by the Hub`);
  }
  await event.prepare();

  // The one event's spectator stream, at the same path as in server mode: /api/events/<id>/live.
  const hub = new SpectateHub(spectate, { adminToken: env.ADMIN_TOKEN, spectateToken: env.SPECTATE_TOKEN?.trim() || undefined, runsDir: values.runs! });
  const http = startHttp((t) => event.seatByToken(t), cards, port, values.host, async (req, res) => {
    // Status, as in server mode (seat launchers use it to tell a finished seat from a crashed session).
    const st = (req.url ?? '').match(/^\/api\/events\/([\w-]+)\/?(?:\?|$)/);
    if (st && req.method === 'GET') {
      const found = st[1] === event.id;
      res.writeHead(found ? 200 : 404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
        .end(JSON.stringify(found ? event.summary() : { error: 'no such event' }, null, 1));
      return true;
    }
    const m = (req.url ?? '').match(/^\/api\/events\/([\w-]+)\/live(?:\?|$)/);
    if (!m) return false;
    if (m[1] === event.id) return hub.handle(req, res, event.id, event.spectator);
    res.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'no such event' }));
    return true;
  });
  http.once('listening', () => (serving = true));
  const seatUrls = Object.fromEntries(event.agents.map((s) => [s.name, `${publicUrl}/mcp/${s.token}`]));
  writeFileSync(join(event.dir, 'seats.json'), JSON.stringify(seatUrls, null, 1));
  console.log(`event ${event.id} (set ${values.set}, seed ${event.seed}, knowledge ${event.knowledge.level}, mana ${values.mana})`);
  if (event.knowledge.warning) console.log(`warning: ${event.knowledge.warning}`);
  if (event.knowledge.primerSource) console.log(`primer: ${event.knowledge.primerSource.from} (${event.knowledge.primerSource.bytes} bytes, sha256 ${event.knowledge.primerSource.sha256.slice(0, 12)})`);
  for (const [name, url] of Object.entries(seatUrls)) console.log(`seat ${name}: ${url}`);
  if (spectate.access !== 'off') console.log(`spectate: ${publicUrl}/api/events/${event.id}/live`);
  console.log(`seats written to ${join(event.dir, 'seats.json')}`);

  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      if (event.stage !== 'done') event.log('event_abort', { signal: sig, stage: event.stage });
      process.exit(130);
    });
  }
  // Hand-off (HUB_URL): earlier unsent events in the background, this one once it ends (a few quick retries;
  // whatever is still unsent is retried by the next Director start).
  const handoff = hubTarget ? new HubHandoff(hubTarget, { delaysMs: [5_000, 15_000, 30_000] }) : undefined;
  handoff?.resendPending(values.runs!).catch((err) => console.error(`hub hand-off: resend failed: ${String(err?.stack ?? err)}`));
  await event.run();
  console.log(`event complete: ${JSON.stringify(event.standings())}`);
  if (handoff) await handoff.send(event.dir).catch((err) => console.error(`hub hand-off: ${String(err?.stack ?? err)}`));
  setTimeout(() => process.exit(0), 5000);
}
