/**
 * Loading and normalizing the Director's run logs (runs/<id>/events.jsonl and friends),
 * the 17Lands ratings (sets/<SET>/17lands.json) and, when present, card data.
 */
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { constants as zlibConstants, gunzipSync } from 'node:zlib';
import { readDraftEval, readSource, readStrength, strengthFromRecords, type DraftEvalInfo, type SourceInfo, type StrengthInfo } from './inputs.js';
import { EVENT_ID_RE } from '../../director/src/submissions.js';
import { registry as defaultRegistry, type Registry } from '../../registry/src/index.js';

/**
 * Logs can come from community bundles. The Hub refuses ill-typed ones (packages/hub/src/sanity.ts); the loader
 * also coerces every number that reaches markup, paths or loops, so a log that bypasses the Hub (a local
 * runs/ folder, the Director's interim submissions) can't inject markup or blow up the export.
 */
export const SET_CODE_RE = /^[A-Za-z0-9]{2,8}$/;
const int = (x: unknown, d = 0): number => (typeof x === 'number' && Number.isFinite(x) ? Math.trunc(x) : d);
const intOpt = (x: unknown): number | undefined => (typeof x === 'number' && Number.isFinite(x) ? Math.trunc(x) : undefined);
const intRecord = <T extends object>(x: unknown): T | undefined =>
  x && typeof x === 'object' && !Array.isArray(x)
    ? (Object.fromEntries(Object.entries(x).map(([k, v]) => [k, v && typeof v === 'object' ? intRecord(v) : intOpt(v)])) as T)
    : undefined;

// ---------------------------------------------------------------------------
// Raw event shapes (only the fields the site reads)

export interface SetInfo { code: string; name: string; releaseDate?: string }
interface RawBase { t: number; type: string }
export interface KnowledgeConfig { level: string; primer?: boolean | string; guide?: boolean; stats?: boolean; warning?: string }
interface RawEventStart extends RawBase {
  id: string; set: SetInfo; seed?: string; best_of?: number; ratings?: string;
  /** The 17Lands snapshot behind fallback picks and reference builds (Ratings.snapshot; logs from 2026-10-22 on). */
  ratings_snapshot?: RatingsSnapshot;
  mana?: string; prompt_version?: string; knowledge?: KnowledgeConfig; provenance?: Provenance;
  /** Content hash of the prompts folder's files (logs from 2026-10-22 on). */
  prompt_sha256?: string;
  /** Who created the event on a hosted Director: a contributor (Private Table), the lobby, or the admin. */
  organizer?: { kind?: string; handle?: string; contributor_id?: unknown; table_id?: string };
  /** Inactivity forfeit timeout; present when the Director had the watchdog (2026-10-22 on), 0 = off. */
  seat_timeout_ms?: number;
  /** Match pairing (Swiss from 2026-10-22 on; older logs: round robin). */
  pairing?: { format: 'swiss' | 'round-robin'; rounds: number; version?: number };
  /** Lobby table or Private Table. */
  table?: { kind: 'lobby' | 'private'; queue?: string; table_id?: string; schedule?: string };
  /** Dev engine test: bot drafters filled the seats agents didn't. */
  dev_bot_fill?: boolean;
  /** Best of 3 with sideboarding between games (logs from 2026-10-22 on); absent: played without sideboarding. */
  sideboarding?: boolean;
  /** Who decides play or draw in games 2–3 ("loser-chooses"); game 1 is random from the seed. */
  play_draw?: string;
  seats: Array<{
    name: string; kind: string; position: number; harness?: string; model?: string; model_id?: string; effort?: string;
    /** As typed when it differed from the canonical value (registry; logs from 2026-10-22 on). */
    harness_declared?: string; model_declared?: string; effort_declared?: string;
    /** How the effort was declared: "launch" (set by the bench CLI) or "self-report" (2026-10-22 on). */
    effort_basis?: string;
    /** The seat's declared context policy ("fresh-per-game", "fresh-per-match"); absent: one harness conversation. */
    context_policy?: string;
    /** Lobby tables: the Hub's opaque contributor id, and the handle only when the contributor shows it. */
    contributor_id?: unknown; contributor?: unknown;
  }>;
}
/** event_start.ratings_snapshot: deps/manifest.json snapshot id + sha256 of the 17lands.json the event used. */
export interface RatingsSnapshot { id: string | null; sha256: string; date_range?: { first: string | null; last: string | null }; from?: 'sets' | 'pinned' }
/** Build provenance logged in event_start (newer logs). */
export interface Provenance {
  director?: string;
  engine?: { server_version?: string; build_commit?: string; protocol_version?: number; digest?: string };
}
interface RawPacksOpened extends RawBase { round: number; packs: string[][]; swaps?: Array<{ from: string; to: string }> }
interface RawPick extends RawBase {
  seat: string; pack_number: number; pick_number: number; overall_pick?: number; pack: string[]; pack_rarities?: string[]; pick: string; by: string;
  latency_ms?: number;
}
interface RawDeck extends RawBase { seat: string; by: string; main: string[]; sideboard: string[]; latency_ms?: number }
interface RawGameStart extends RawBase { game: string; game_code?: string; seats: string[]; mana?: string; deck_sizes?: Record<string, number> }
/** play_draw: who started a game, and who chose (games 2–3: the previous game's loser). One per game of a match. */
interface RawPlayDraw extends RawBase {
  match: string; game_number: number; on_play: string; by: string; chooser?: string | null; choice?: string | null; latency_ms?: number;
}
/** sideboarded: a seat's deck for games 2–3 of a match (in/out relative to its deck in the previous game). */
interface RawSideboarded extends RawBase {
  seat: string; match: string; game_number: number; by: string; kept?: boolean; in?: unknown; out?: unknown; main?: unknown; sideboard?: unknown;
  basics?: unknown; main_count?: number; latency_ms?: number;
}
interface RawOffered extends RawBase {
  game: string; seat: string; id: string; kind: string; turn: number; text: string;
  // Newer logs (2026-10-21 evening on) also carry the structured view header.
  phase?: string; active?: 'you' | 'opponent'; life?: { you?: number; opponent?: number }; hand?: { you?: number; opponent?: number }; options?: string[];
}
interface RawDecision extends RawBase {
  game: string; seat: string; id: string; kind: string; turn: number; latency_ms?: number; choice?: unknown; accepted?: boolean; structured?: boolean;
  /** Newer logs: the card the action was about, and for refused answers the action type and the engine's reason. */
  card?: string; action?: string; reason?: string;
  /** Newer logs: "auto" = the engine paid the mana itself (no plan); "manual+auto" = it tapped more after the agent's plan. */
  payment?: string;
}
interface RawCardPlayed extends RawBase { game: string; seat: string; card: string; how?: string; turn?: number | null }
interface RawUnimplemented extends RawBase { game: string; seat?: string | null; card: string; oracle_id?: string; turn?: number | null; mechanics?: string[] }
interface RawRulesIssue extends RawBase { seat: string; card?: string; note?: string; stage?: string; game?: string; turn?: number | null }
interface RawForfeit extends RawBase { seat: string; stage: string; reason?: string; idle_ms?: number; game?: string; kind?: string }
interface RawAuto extends RawBase { game: string; seat: string; action?: string; ok?: boolean; reason?: string }
export interface SeatStats {
  decisions: number; auto_passes: number; forced: number; rejections: number;
  manual_payments?: number; auto_tapper?: number; payment_failures?: number;
  /** Newer logs: payments the engine made by itself (no plan, or topping up a plan that fell short). */
  auto_paid?: number;
}
interface RawGameOver extends RawBase {
  game: string; winner: string | null; turns: number; stats?: Record<string, SeatStats>;
  on_play?: string; final_life?: Record<string, number>; end_reason?: unknown; mulligans?: Record<string, number>;
  cards_played?: Record<string, { cast?: Record<string, number>; activated?: Record<string, number> }>;
}
interface RawMatchEnd extends RawBase { a: string; b: string; wins: Record<string, number> }

// ---------------------------------------------------------------------------
// Normalized model

export interface Seat {
  name: string;
  kind: string; // 'bot' | 'agent'
  position: number;
  llm: boolean; // an agent seat driven by a language model (not a bot or scripted agent)
  model: string; // from the seat metadata (seatModel); "unknown" when an old log has none and the name isn't a registry model
  harness?: string; // from event_start when the runner recorded it ("claude-code")
  modelHint?: string; // the model the runner asked for ("sonnet"), from event_start
  modelId?: string; // exact model id declared in event_start (future logs)
  effort?: string; // reasoning effort declared in event_start (future logs)
  /** The strings as typed, when the Director resolved them to canonical ids (registry; logs from 2026-10-22 on). */
  harnessDeclared?: string;
  modelDeclared?: string;
  effortDeclared?: string;
  /** "launch" (the bench CLI set the effort when it started the seat) or "self-report" (seated by hand). */
  effortBasis?: 'launch' | 'self-report';
  /** Declared context policy: the launcher started a fresh harness session per game or per match (2.12). */
  contextPolicy?: 'fresh-per-game' | 'fresh-per-match';
  /** Lobby tables: the Hub's opaque contributor id of whoever seated it, and the handle when shown publicly. */
  contributorId?: string;
  contributorHandle?: string;
}

export interface Pick {
  seat: string; packNumber: number; pickNumber: number; overallPick?: number; contents: string[]; rarities?: string[]; pick: string; by: string;
  latencyMs?: number; t: number;
}

export interface Deck { seat: string; by: string; main: string[]; sideboard: string[]; latencyMs?: number; t: number }

/** A game's play/draw decision (play_draw records, logs from 2026-10-22 on). */
export interface PlayDraw {
  match: string;
  gameNumber: number;
  onPlay: string;
  /** "seed": game 1, random from the event seed; "agent": the chooser decided; "forfeit": inactive chooser, defaulted to play. */
  by: 'seed' | 'agent' | 'forfeit';
  /** The seat that chose (the previous game's loser; after a draw, the previous chooser); null in game 1. */
  chooser: string | null;
  choice: 'play' | 'draw' | null;
  latencyMs?: number;
  t: number;
}

export interface CardCount { name: string; qty: number }

/** A seat's sideboarding before games 2–3 of a match (sideboarded records, logs from 2026-10-22 on). */
export interface Sideboarding {
  seat: string;
  match: string;
  gameNumber: number;
  by: 'agent' | 'forfeit';
  /** No change from the previous game's deck (in and out empty). */
  kept: boolean;
  /** Relative to the deck the seat played in the previous game of the match (basic land changes included). */
  in: CardCount[];
  out: CardCount[];
  main: string[];
  sideboard: string[];
  basics: Record<string, number>;
  /** Public: the main deck size for the game. */
  mainCount: number;
  latencyMs?: number;
  t: number;
  /** Live redaction: in, out, main, sideboard and basics are withheld until the seat has no games left. */
  withheld?: boolean;
}

export interface Answer {
  t: number; latencyMs?: number; choice: string; rawChoice: unknown; accepted: boolean; structured?: boolean;
  card?: string; action?: string; reason?: string;
  /** "auto": the engine paid the mana itself; "manual+auto": it topped up the agent's plan (never the agent's own tapping). */
  payment?: 'auto' | 'manual+auto';
  /** Withheld from spectators while the event runs (live redaction): the choice (the view: Decision.withheld). */
  withheld?: 'choice';
}

export interface Decision {
  game: string; seat: string; id: string; kind: string; turn: number; t: number; text: string; answer?: Answer;
  phase?: string; active?: 'you' | 'opponent'; life?: { you?: number; opponent?: number }; hand?: { you?: number; opponent?: number };
  options?: string[];
  /** The Director logged decision_withdrawn for it. Note: it can still have an answer (the log races the answer). */
  withdrawn?: boolean;
  /** The view the agent saw is withheld from spectators while the event runs (live redaction). */
  textWithheld?: boolean;
}

/** A card a seat cast or activated in a game (card_played lines, or game_over.cards_played in a summary). */
export interface CardPlay { seat: string; card: string; how: string; turn?: number | null; t: number }
/** An effect phase-rs could not carry out (Effect::Unimplemented) in a game. */
export interface UnimplementedHit { seat: string | null; card: string; turn?: number | null; t: number; mechanics?: string[] }
/** An agent's report_rules_issue. */
export interface RulesIssue { seat: string; card: string | null; note: string; stage?: string; game?: string; turn?: number | null; t: number; withheld?: boolean }
/** A decision the Director settled for an inactive seat (METHODOLOGY §5.5): draft pick, deck, or a conceded game. */
export interface Forfeit { seat: string; stage: string; reason: string; idleMs?: number; game?: string; t: number }
/** An automatic action (auto-pass, forced, payment) the engine refused for reasons other than a timeout. */
export interface RefusedAuto { seat: string; action?: string; reason?: string; t: number }

export interface Game {
  index: number; // 1-based, order of game_start within the event
  label: string;
  code?: string;
  seats: string[];
  matchKey: string;
  gameInMatch: number;
  startT: number;
  endT?: number;
  over: boolean;
  winner: string | null;
  turns?: number;
  stats?: Record<string, SeatStats>;
  decisions: Decision[];
  autoPasses: Record<string, number>;
  forced: Record<string, number>;
  payTaps: Record<string, number>; // manual-mana taps the Director carried out for the agent's plan
  failures: number; // phase_error / refused automatic actions
  mana?: string;
  onPlay?: string;
  finalLife?: Record<string, number>;
  endReason?: unknown;
  mulligans?: Record<string, number>;
  /** Seat that forfeited (watchdog: inactive harness). A loss for it in the rating (FORFEIT_POLICY), counted in reliability. */
  forfeitedBy?: string;
  /** Engine-issue inputs (METHODOLOGY §5.6). Empty for logs from before 2026-10-22. */
  plays: CardPlay[];
  /** true when the log carries card_played lines or game_over.cards_played (so an empty `plays` means none). */
  playsLogged: boolean;
  unimplemented: UnimplementedHit[];
  rulesIssues: RulesIssue[];
  refusedAuto: RefusedAuto[];
  /** Card names seen in public zones (turn snapshots, cards played): never redacted from released rules reports. */
  publicNames: Set<string>;
  /** game_start.deck_sizes: each seat's main deck size for this game (public; logs from 2026-10-22 on). */
  deckSizes?: Record<string, number>;
}

export interface Match {
  key: string; a: string; b: string; wins: Record<string, number>; games: Game[]; done: boolean;
  /** match_end.no_result: cut short by engine failures. Neither won, lost nor drawn; its finished games stand (METHODOLOGY §3.2). */
  noResult?: boolean;
}

export interface Standing { name: string; matchWins: number; matchLosses: number; gameWins: number; gameLosses: number }

export interface Transcript {
  seat: string;
  file: string;
  model?: string;
  /** Output tokens per model id the harness reported (result modelUsage, else per assistant message). */
  modelOutputTokens?: Record<string, number>;
  /** Harness version from the init line (claude_code_version). */
  harnessVersion?: string;
  done: boolean;
  /**
   * The harness-reported cost, only when every session reported one: a session stopped from outside (a fresh session
   * per game) writes no result line, and a partial sum would undercount (`sessionsUnreported`). cost.ts estimates it.
   */
  costUsd?: number;
  /** Sessions with usage but no reported cost (then costUsd is undefined). */
  sessionsUnreported?: number;
  durationMs?: number;
  apiDurationMs?: number;
  numTurns?: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** The part of cacheCreationTokens written for 1 hour (priced apart: registry/prices.json cache_write_1h). */
  cacheCreation1hTokens?: number;
  thinkingTokens?: number;
  /**
   * Token counts of each API request (one per assistant message id, every session), for long-context prices: a
   * request's prompt size decides its tier. The totals above stay authoritative; these only say which share was long.
   */
  calls?: Array<{ input: number; output: number; cache_read: number; cache_write: number; cache_write_1h?: number }>;
  toolCalls: Record<string, number>;
  toolErrors: number;
  isError?: boolean;
  lines: number;
}

/**
 * complete: event_end (or, in old logs, summary.json); stopped: event_abort (its organizer, an admin or the server
 * stopped it for good; its finished games are rated, METHODOLOGY §3.2 "Stopped events"); stalled: no record for 30
 * minutes and no ending; in-progress: live.
 */
export type EventStatus = 'complete' | 'in-progress' | 'stalled' | 'stopped';

/** event_abort as the export reads it (Director 2026-10-23 on: who stopped it and the games still being played). */
export interface StopInfo {
  reason: string;
  /** organizer | admin | system; "unknown" for logs from before the Director recorded it. */
  by: 'organizer' | 'admin' | 'system' | 'unknown';
  stage?: string;
  t: number;
  /** Games still being played when it stopped (void unless forfeited by the stopping organizer's seat). */
  openGames: Array<{ game: string; seats: string[] }>;
  /** Open games counted as a loss for the stopping organizer's seat (exactly one side theirs). */
  forfeitedGames: string[];
}

/** An event that will never continue: finished, stopped or stalled. Only these are rated (their finished games). */
export const isSettled = (ev: { status: EventStatus }): boolean => ev.status !== 'in-progress';

/** The parts of usage-<seat>.json the export reads (packages/director/src/usage.ts SeatUsage). */
export interface SeatUsageFile {
  model_ids?: string[];
  model_output_tokens?: Record<string, number>;
  harness_version?: string;
  /** The effort the harness logged (packages/director/src/effort-detect.ts). */
  effort_reported?: { level: string | null; counts?: Record<string, number>; source: string; status?: string; fast?: boolean };
  /** Token totals and the harness-reported cost (cost estimates for harnesses that don't report one; SITE-DATA 2.8). */
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_creation_tokens?: number;
  /** The part of cache_creation_tokens written for 1 hour. */
  cache_creation_1h_tokens?: number;
  cost_usd?: number | null;
  complete?: boolean;
  /** Sessions that reported no cost (packages/director/src/usage.ts): cost_usd is then not the seat's whole cost. */
  sessions_unreported?: number;
  /**
   * The tokens of the requests over a long-context threshold (`above`), from per-request usage (usage uploads): with
   * the totals they price the seat request by request.
   */
  long_context?: { above: number; requests: number; input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_creation_tokens: number; cache_creation_1h_tokens: number };
  /**
   * About how many API requests the seat made (the larger of the harness's turn count and its tool calls + 1). The
   * file has token totals only; long-context estimates use this for the mean prompt size (packages/registry prices.ts
   * longShareFromTotals).
   */
  requests?: number;
}

export interface EventData {
  id: string;
  dir: string;
  set: SetInfo;
  seed?: string;
  bestOf: number;
  ratingsSource?: string;
  /** event_start.ratings_snapshot (the data the event ran with; undefined for older logs and sets without 17Lands data). */
  ratingsSnapshot?: RatingsSnapshot;
  mana?: string;
  promptVersion?: string;
  /** event_start.prompt_sha256: content hash of the prompt files (newer logs). */
  promptSha256?: string;
  /** event_start.organizer (hosted events): who created the table. */
  organizer?: { kind: 'contributor' | 'lobby' | 'admin' | string; contributorId?: string; handle?: string };
  knowledge?: KnowledgeConfig;
  provenance?: Provenance;
  /** Verified / community / smoke, from runs/<id>/source.json (inferred when absent). */
  source: SourceInfo;
  /** Optional deck_strength records (runs/<id>/strength.json). */
  strength: StrengthInfo | null;
  /** Optional expert pick model scores (runs/<id>/draft-eval.json). */
  draftEval: DraftEvalInfo | null;
  startT: number;
  lastT: number;
  status: EventStatus;
  seats: Seat[];
  packs: RawPacksOpened[];
  picks: Pick[];
  decks: Map<string, Deck>;
  games: Game[];
  matches: Match[];
  standings: Standing[];
  transcripts: Map<string, Transcript>;
  /** Harness usage per seat from usage-<seat>.json (bundles and pulled runs): model ids and output tokens per model. */
  usage?: Map<string, SeatUsageFile>;
  hasSummary: boolean;
  stage: 'draft' | 'build' | 'games' | 'done';
  /** event_abort / event_error was logged: the event will never continue. */
  aborted: boolean;
  /** event_abort: who stopped it, why, and what happened to the games still being played. */
  stop?: StopInfo;
  /** draft_end was logged (or a later stage started). */
  draftEnded: boolean;
  /** How matches are paired (event_start.pairing); undefined for logs from before Swiss (round robins). */
  format?: { format: 'swiss' | 'round-robin'; rounds: number };
  /** Lobby table or Private Table (event_start.table). */
  table?: { kind: 'lobby' | 'private'; queue?: string; table_id?: string; schedule?: string };
  /** A dev engine test: bot drafters filled empty seats (event_start.dev_bot_fill). Smoke, never rated. */
  devBotFill?: boolean;
  /** event_start.sideboarding: best of 3 with sideboarding between games. Absent: played without (early test data). */
  sideboarding?: boolean;
  /** event_start.play_draw: who chooses play or draw in games 2–3 ("loser-chooses"). */
  playDrawRule?: string;
  /** play_draw records: one per game of a match (game 1: from the seed). Empty for older logs. */
  playDraws?: PlayDraw[];
  /** sideboarded records: one per seat before games 2–3 of a match. Empty for older logs. */
  sideboards?: Sideboarding[];
  /** report_rules_issue reports made outside a game (draft, deckbuilding). */
  rulesIssues: RulesIssue[];
  /** Inactivity forfeits; `forfeitsLogged` is false for logs from before the Director had the watchdog. */
  forfeits: Forfeit[];
  forfeitsLogged: boolean;
  /** Set when hidden information was withheld from this export because the event is still running (live redaction). */
  withheld?: { policy: string; picks: number; decks: number; decisions: number; views: number; sideboards?: number };
}

export interface LegacyGame { id: string; t: number; events: number; decisions: number }

// ---------------------------------------------------------------------------
// Helpers

/**
 * The seat-name convention of the earliest logs (rand-1, bot-3): the only signal a log without seat metadata has.
 * Never use it on its own: hosted tables name every seat `seat-<hex>`, scripted or not (use isLlmSeat).
 */
export function isLlmSeatName(name: string): boolean {
  return !/^(rand|bot-|bot$|random)/i.test(name);
}

/** Models the scripted test players declare (scripts/mcp-random-agent.mjs): never a language model. */
const SCRIPTED_MODEL_RE = /^(unlisted:)?(random|random-agent|scripted|script)$/i;

/**
 * Whether a seat is driven by a language model, from the seat metadata event_start records (METHODOLOGY §3):
 *   - bots (kind "bot") never are;
 *   - a harness the registry lists as a test harness (`script`, aliases scripted / random / random-agent) never is;
 *   - a declared model "random" (also unlisted, e.g. `unlisted:random`) that the registry doesn't list never is;
 *   - the earliest logs, with no harness or model recorded, fall back to the old seat-name convention (rand-*, bot-*).
 * Seat names are never the signal when metadata exists: hosted seats are all `seat-<hex>`.
 */
export function isLlmSeat(
  s: { name: string; kind?: string; harness?: unknown; model?: unknown; model_id?: unknown; harness_declared?: unknown; model_declared?: unknown },
  reg: Registry = defaultRegistry,
): boolean {
  if (s.kind !== 'agent') return false;
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  const harnesses = [str(s.harness), str(s.harness_declared)].filter((v): v is string => !!v);
  const models = [str(s.model_id), str(s.model), str(s.model_declared)].filter((v): v is string => !!v);
  for (const h of harnesses) {
    const r = reg.resolveHarness(h);
    if (r.ok && r.harness.kind === 'test') return false;
  }
  for (const m of models) if (SCRIPTED_MODEL_RE.test(m) && !reg.resolveModel(m.replace(/^unlisted:/i, '')).ok) return false;
  if (!harnesses.length && !models.length) return isLlmSeatName(s.name);
  return true;
}

/** The model a seat's log names when nothing else does: no metadata, and no registry model in the seat name. */
export const UNKNOWN_MODEL = 'unknown';

/**
 * A seat's model. Identity comes from the seat metadata the log records (event_start `model_id`, else `model`), never
 * from the seat name: names are free text ("claude-haiku-5-5-2", "seat-3fa2…"), and cutting a trailing "-<n>" turned
 * claude-haiku-5-5 into a phantom "claude-haiku-5". Only old logs without metadata fall back to the name, and only to a
 * name the registry knows: the whole name, else the name without a "-<n>" copy suffix. Anything else is "unknown".
 * Bot and scripted seats (not LLM seats) keep their name without the copy suffix as a plain label ("bot", "rand").
 */
export function seatModel(s: { name: string; kind?: string; model?: unknown; model_id?: unknown }, at?: number, reg: Registry = defaultRegistry): string {
  const meta = [s.model_id, s.model].find((v): v is string => typeof v === 'string' && v.trim() !== '');
  if (meta) return meta.trim();
  if (s.kind !== 'agent' || !isLlmSeatName(s.name)) return s.name.replace(/-\d+$/, '');
  // The part of the name the registry knows, as written (identity resolution maps aliases to ids with the event date).
  for (const candidate of [s.name, s.name.replace(/-\d+$/, '')]) {
    if (reg.resolveModel(candidate, undefined, at != null ? { at } : {}).ok) return candidate;
  }
  return UNKNOWN_MODEL;
}

/** A run folder's event log: events.jsonl, or events.jsonl.gz (a hosted Director keeps the logs the Hub has accepted gzipped). */
function logPath(dir: string): string | undefined {
  for (const f of ['events.jsonl', 'events.jsonl.gz']) if (existsSync(join(dir, f))) return join(dir, f);
  return undefined;
}

function readLogText(path: string): string {
  const raw = readFileSync(path);
  return (path.endsWith('.gz') ? gunzipSync(raw) : raw).toString('utf8');
}

/** The first 200 characters of a gzipped log, inflating only its start. */
function logHead(path: string): string {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(16 * 1024);
    const n = readSync(fd, buf, 0, buf.length, 0);
    return gunzipSync(buf.subarray(0, n), { finishFlush: zlibConstants.Z_SYNC_FLUSH }).toString('utf8').slice(0, 200);
  } catch {
    return '';
  } finally {
    closeSync(fd);
  }
}

function readJsonl(path: string): RawBase[] {
  const out: RawBase[] = [];
  for (const line of readLogText(path).split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as RawBase);
    } catch {
      // A partially written last line while an event is in progress: skip it.
    }
  }
  return out;
}

const strList = (x: unknown): string[] => (Array.isArray(x) ? x.filter((v): v is string => typeof v === 'string') : []);
/** [{ name, qty }] from an untrusted list (names as strings, quantities as positive integers). */
const cardCounts = (x: unknown): CardCount[] =>
  Array.isArray(x)
    ? x.flatMap((v) => (v && typeof v === 'object' && typeof (v as CardCount).name === 'string' && int((v as CardCount).qty) > 0 ? [{ name: (v as CardCount).name, qty: int((v as CardCount).qty) }] : []))
    : [];

/** A game's play/draw record (match key and game number), when the log has one. */
export function playDrawOf(ev: EventData, g: { matchKey: string; gameInMatch: number }): PlayDraw | undefined {
  return ev.playDraws?.find((p) => p.match === g.matchKey && p.gameNumber === g.gameInMatch);
}

/** Each seat's sideboarding before a game (games 2–3 of a match), when the log has it. */
export function sideboardsOf(ev: EventData, g: { matchKey: string; gameInMatch: number }): Sideboarding[] {
  return (ev.sideboards ?? []).filter((s) => s.match === g.matchKey && s.gameNumber === g.gameInMatch);
}

function matchKeyOf(label: string): { key: string; n: number } {
  const m = /^(.*?)\s+—\s+game\s+(\d+)$/.exec(label);
  return m ? { key: m[1]!, n: Number(m[2]) } : { key: label, n: 1 };
}

// ---------------------------------------------------------------------------
// Choice labels: structured answers carry object ids; map them to card names
// using the "[#id]" references in the text the agent saw.

export function objectNames(text: string): Map<number, string> {
  const names = new Map<number, string>();
  for (const line of text.split('\n')) {
    const re = /\[#(\d+)\]/g;
    let m: RegExpExecArray | null;
    let segStart = 0;
    while ((m = re.exec(line))) {
      let before = line.slice(segStart, m.index);
      // Cut at the last delimiter that can precede a name in the rendered views.
      const cuts = [': ', '], ', '] ', ' by ', ' with ', ' targets ', ' casts ', ' plays ', ' attacks ', ' blocks ', 'untapped): ', 'tapped: '];
      let cut = 0;
      for (const c of cuts) {
        const i = before.lastIndexOf(c);
        if (i >= 0 && i + c.length > cut) cut = i + c.length;
      }
      before = before.slice(cut).replace(/^[\s\-•*]+/, '').replace(/^\[\d+\]\s*/, '').replace(/^(Cast|Play land|Activate|Target|Attack with|Block with)\s+/, '').trim();
      const id = Number(m[1]);
      if (before && !names.has(id) && before.length < 60) names.set(id, before);
      segStart = m.index + m[0].length;
    }
  }
  return names;
}

export function choiceLabel(choice: unknown, text: string): string {
  if (choice == null) return '(no choice recorded)';
  if (typeof choice === 'string') return choice;
  const c = choice as { type?: string; data?: any };
  const names = objectNames(text);
  const nm = (id: unknown): string => {
    const n = typeof id === 'number' ? names.get(id) : undefined;
    return n ? `${n} [#${id}]` : `#${String(id)}`;
  };
  try {
    if (c.type === 'DeclareAttackers') {
      const attacks = (c.data?.attacks ?? []) as Array<[number, unknown]>;
      if (!attacks.length) return 'No attack';
      return `Attack with ${attacks.map((a) => nm(a[0])).join(', ')}`;
    }
    if (c.type === 'DeclareBlockers') {
      const as = (c.data?.assignments ?? []) as Array<[number, number]>;
      if (!as.length) return 'No blocks';
      return as.map(([b, a]) => `Block ${nm(a)} with ${nm(b)}`).join('; ');
    }
    if (c.type === 'SelectCards') {
      const cards = (c.data?.cards ?? []) as number[];
      return cards.length ? `Select ${cards.map(nm).join(', ')}` : 'Select nothing';
    }
  } catch {
    /* fall through */
  }
  return JSON.stringify(choice);
}

// ---------------------------------------------------------------------------
// Transcripts (Claude Code stream-json)

function readTranscript(seat: string, file: string): Transcript {
  const tr: Transcript = {
    seat, file, done: false, lines: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, toolCalls: {}, toolErrors: 0,
  };
  // A relaunched seat appends sessions to the same file (each starts with a system init line). Per session the
  // result line's totals are authoritative, else its per-message usage; sessions are summed.
  type Usage = { input: number; output: number; cr: number; cc: number; cc1h: number; model?: string };
  const sessions: Array<{ byMsg: Map<string, Usage>; result?: any }> = [];
  const session = () => {
    if (!sessions.length) sessions.push({ byMsg: new Map() });
    return sessions[sessions.length - 1]!;
  };
  const seenTools = new Set<string>();
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    tr.lines++;
    let o: any;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o.type === 'system' && o.subtype === 'init') {
      sessions.push({ byMsg: new Map() });
      if (typeof o.model === 'string') tr.model = o.model;
      if (typeof o.claude_code_version === 'string') tr.harnessVersion = o.claude_code_version.slice(0, 40);
    }
    if (o.type === 'assistant' && o.message) {
      const msg = o.message;
      if (msg.id && msg.usage) {
        session().byMsg.set(msg.id, {
          input: int(msg.usage.input_tokens),
          output: int(msg.usage.output_tokens),
          cr: int(msg.usage.cache_read_input_tokens),
          cc: int(msg.usage.cache_creation_input_tokens),
          cc1h: int(msg.usage.cache_creation?.ephemeral_1h_input_tokens),
          ...(typeof msg.model === 'string' ? { model: msg.model } : {}),
        });
      }
      for (const b of msg.content ?? []) {
        if (b?.type === 'tool_use' && b.id && !seenTools.has(b.id)) {
          seenTools.add(b.id);
          const name = String(b.name ?? 'unknown').replace(/^mcp__[^_]+__/, '');
          tr.toolCalls[name] = (tr.toolCalls[name] ?? 0) + 1;
        }
      }
    }
    if (o.type === 'user' && o.message) {
      for (const b of o.message.content ?? []) if (b?.type === 'tool_result' && b.is_error) tr.toolErrors++;
    }
    if (o.type === 'result') {
      session().result = o;
      tr.isError = Boolean(o.is_error);
      if (!tr.model && o.modelUsage) {
        const models = Object.entries(o.modelUsage as Record<string, { costUSD?: number }>).sort((a, b) => (b[1].costUSD ?? 0) - (a[1].costUSD ?? 0));
        tr.model = models[0]?.[0];
      }
    }
  }
  const add = (k: 'costUsd' | 'durationMs' | 'apiDurationMs' | 'numTurns', v: unknown) => {
    if (typeof v === 'number') tr[k] = (tr[k] ?? 0) + v;
  };
  const perModel: Record<string, number> = {};
  let unreported = 0;
  let cc1h = 0;
  let cc1hKnown = false;
  for (const sess of sessions) {
    const o = sess.result;
    if ((sess.byMsg.size || o) && typeof o?.total_cost_usd !== 'number') unreported++;
    // Output tokens per model: the result line's modelUsage (it includes the harness's helper models), else per message.
    const mu = o?.modelUsage && typeof o.modelUsage === 'object' ? (o.modelUsage as Record<string, { outputTokens?: number }>) : undefined;
    if (mu && Object.keys(mu).length) for (const [m, x] of Object.entries(mu)) perModel[m] = (perModel[m] ?? 0) + int(x?.outputTokens);
    else for (const u of sess.byMsg.values()) if (u.model) perModel[u.model] = (perModel[u.model] ?? 0) + u.output;
    if (o) {
      add('costUsd', o.total_cost_usd);
      add('durationMs', o.duration_ms);
      add('apiDurationMs', o.duration_api_ms);
      add('numTurns', o.num_turns);
      const u = o.usage ?? {};
      tr.inputTokens += int(u.input_tokens);
      tr.outputTokens += int(u.output_tokens);
      tr.cacheReadTokens += int(u.cache_read_input_tokens);
      tr.cacheCreationTokens += int(u.cache_creation_input_tokens);
      if (typeof u.cache_creation?.ephemeral_1h_input_tokens === 'number') (cc1h += int(u.cache_creation.ephemeral_1h_input_tokens), cc1hKnown = true);
      const th = u.output_tokens_details?.thinking_tokens;
      if (typeof th === 'number') tr.thinkingTokens = (tr.thinkingTokens ?? 0) + th;
    } else {
      for (const u of sess.byMsg.values()) {
        tr.inputTokens += u.input;
        tr.outputTokens += u.output;
        tr.cacheReadTokens += u.cr;
        tr.cacheCreationTokens += u.cc;
        cc1h += u.cc1h;
        cc1hKnown = true;
      }
    }
  }
  if (cc1hKnown) tr.cacheCreation1hTokens = cc1h;
  // A cost only when every session reported one (a partial sum would undercount).
  if (unreported) (tr.sessionsUnreported = unreported, delete tr.costUsd);
  if (Object.keys(perModel).length) tr.modelOutputTokens = perModel;
  const calls = sessions.flatMap((x) => [...x.byMsg.values()].map((u) => ({ input: u.input, output: u.output, cache_read: u.cr, cache_write: u.cc, cache_write_1h: u.cc1h })));
  if (calls.length) tr.calls = calls;
  // Done when the last session ended with a result line.
  tr.done = !!sessions[sessions.length - 1]?.result;
  return tr;
}

/** usage-<seat>.json: only model ids, per-model output tokens, token totals, the reported cost and the effort are kept. */
function readUsageFile(file: string): SeatUsageFile | undefined {
  try {
    const o = JSON.parse(readFileSync(file, 'utf8'));
    if (!o || typeof o !== 'object') return undefined;
    const out: SeatUsageFile = {};
    if (Array.isArray(o.model_ids)) out.model_ids = o.model_ids.filter((x: unknown): x is string => typeof x === 'string' && x.length <= 200).slice(0, 20);
    if (o.model_output_tokens && typeof o.model_output_tokens === 'object') {
      const t: Record<string, number> = {};
      for (const [k, v] of Object.entries(o.model_output_tokens).slice(0, 20)) if (k.length <= 200 && typeof v === 'number' && Number.isFinite(v) && v >= 0) t[k] = v;
      out.model_output_tokens = t;
    }
    if (typeof o.harness_version === 'string') out.harness_version = o.harness_version.slice(0, 80);
    const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);
    for (const k of ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_creation_tokens', 'cache_creation_1h_tokens'] as const) {
      const v = num(o[k]);
      if (v != null) out[k] = v;
    }
    if (o.cost_usd === null || num(o.cost_usd) != null) out.cost_usd = o.cost_usd === null ? null : num(o.cost_usd)!;
    if (typeof o.complete === 'boolean') out.complete = o.complete;
    if (num(o.sessions_unreported)) out.sessions_unreported = Math.round(num(o.sessions_unreported)!);
    // Requests: counted from per-request usage where the file says, else about as many as turns or tool calls + 1.
    const toolCalls = o.tool_calls && typeof o.tool_calls === 'object' ? Object.values(o.tool_calls).reduce<number>((n, v) => n + (num(v) ?? 0), 0) : 0;
    const requests = num(o.requests) || Math.max(num(o.turns) ?? 0, toolCalls ? toolCalls + 1 : 0);
    if (requests) out.requests = Math.round(requests);
    const lc = o.long_context;
    const lk = ['requests', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_creation_tokens', 'cache_creation_1h_tokens'] as const;
    if (lc && typeof lc === 'object' && num(lc.above) && lk.every((k) => num(lc[k]) != null)) {
      out.long_context = { above: num(lc.above)!, ...Object.fromEntries(lk.map((k) => [k, num(lc[k])!])) } as NonNullable<SeatUsageFile['long_context']>;
    }
    const er = o.effort_reported;
    if (er && typeof er === 'object' && typeof er.source === 'string') {
      const counts: Record<string, number> = {};
      for (const [k, v] of Object.entries(er.counts ?? {}).slice(0, 12)) if (k.length <= 20 && typeof v === 'number' && Number.isFinite(v) && v >= 0) counts[k] = v;
      out.effort_reported = {
        level: typeof er.level === 'string' ? er.level.slice(0, 20) : null, counts, source: er.source.slice(0, 40),
        ...(typeof er.status === 'string' ? { status: er.status.slice(0, 20) } : {}),
        ...(er.fast === true ? { fast: true } : {}),
      };
    }
    return out;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Events

const STALL_MS = 30 * 60 * 1000;

/**
 * A table its organizer stopped mid-game (METHODOLOGY §3.2 "Stopped events"): an open game where exactly one side is
 * the organizer's seat (a lobby seat they queued, or any seat of their Private Table facing a seat that isn't theirs)
 * counts as a loss for that side, like a watchdog forfeit, since stopping is their choice. An open game between two of
 * their own seats (every game at a Private Table) has no side to charge: it is void, like an unplayed game. Stops by an
 * admin or the server void every open game. Finished games are rated whoever stopped the table.
 */
function applyOrganizerStop(ev: EventData, stop: StopInfo): void {
  if (stop.by !== 'organizer') return;
  const organizer = ev.organizer?.contributorId ?? (ev.organizer?.kind === 'admin' ? 'admin' : undefined);
  if (!organizer) return;
  const ownerOf = (seat: string) => ev.seats.find((s) => s.name === seat)?.contributorId ?? organizer;
  for (const o of stop.openGames) {
    const g = ev.games.find((x) => x.label === o.game);
    if (!g || g.over || g.seats.length !== 2) continue;
    const mine = g.seats.filter((s) => ownerOf(s) === organizer);
    if (mine.length !== 1) continue;
    const loser = mine[0]!;
    g.over = true;
    g.winner = g.seats.find((s) => s !== loser)!;
    g.forfeitedBy = loser;
    g.endReason = 'organizer_stop';
    g.endT = stop.t;
    stop.forfeitedGames.push(g.label);
  }
}

export function loadEvent(dir: string, now: number): EventData | null {
  const path = logPath(dir);
  if (!path) return null;
  const raw = readJsonl(path);
  const start = raw[0];
  if (!start || start.type !== 'event_start') return null;
  const es = start as RawEventStart;
  // Ids and set codes become file paths and URLs (events/<id>.json, sets/<CODE>.json).
  if (typeof es.id !== 'string' || !EVENT_ID_RE.test(es.id) || typeof es.set?.code !== 'string' || !SET_CODE_RE.test(es.set.code) || !Array.isArray(es.seats)) return null;

  const seats: Seat[] = es.seats.map((s) => ({
    name: s.name, kind: s.kind, position: int(s.position, -1),
    // From the seat metadata (registry test harness, scripted model), never the seat name alone (isLlmSeat).
    llm: isLlmSeat(s),
    // From the seat metadata; seat names (seat-<hex> on hosted tables) never carry identity (seatModel).
    model: seatModel(s, typeof es.t === 'number' ? es.t : undefined),
    harness: s.harness,
    modelHint: s.model,
    modelId: s.model_id,
    effort: s.effort,
    ...(typeof s.harness_declared === 'string' ? { harnessDeclared: s.harness_declared } : {}),
    ...(typeof s.model_declared === 'string' ? { modelDeclared: s.model_declared } : {}),
    ...(typeof s.effort_declared === 'string' ? { effortDeclared: s.effort_declared } : {}),
    ...(s.effort_basis === 'launch' || s.effort_basis === 'self-report' ? { effortBasis: s.effort_basis } : {}),
    ...(s.context_policy === 'fresh-per-game' || s.context_policy === 'fresh-per-match' ? { contextPolicy: s.context_policy } : {}),
    ...(s.contributor_id != null && String(s.contributor_id) !== '' ? { contributorId: String(s.contributor_id).slice(0, 80) } : {}),
    ...(typeof s.contributor === 'string' && s.contributor ? { contributorHandle: s.contributor.slice(0, 80) } : {}),
  }));
  const ev: EventData = {
    id: es.id, dir, set: es.set, seed: es.seed, bestOf: es.best_of ?? 3, ratingsSource: es.ratings, ...(es.ratings_snapshot ? { ratingsSnapshot: es.ratings_snapshot } : {}),
    mana: es.mana, promptVersion: es.prompt_version, knowledge: es.knowledge, provenance: es.provenance,
    ...(typeof es.prompt_sha256 === 'string' && /^[0-9a-f]{16,64}$/.test(es.prompt_sha256) ? { promptSha256: es.prompt_sha256 } : {}),
    ...(es.organizer && typeof es.organizer === 'object' && typeof es.organizer.kind === 'string'
      ? { organizer: {
          kind: es.organizer.kind.slice(0, 20),
          ...(es.organizer.contributor_id != null && String(es.organizer.contributor_id) !== '' ? { contributorId: String(es.organizer.contributor_id).slice(0, 80) } : {}),
          ...(typeof es.organizer.handle === 'string' && es.organizer.handle ? { handle: es.organizer.handle.slice(0, 80) } : {}),
        } }
      : {}),
    // Dev events (bot drafters filled seats) are smoke tests whoever sat at them.
    source: readSource(dir, seats.some((s) => s.llm) && !es.dev_bot_fill), strength: readStrength(dir), draftEval: readDraftEval(dir),
    ...(es.pairing && typeof es.pairing === 'object' ? { format: { format: es.pairing.format, rounds: Number(es.pairing.rounds) || 0 } } : {}),
    ...(es.table && typeof es.table === 'object' ? { table: es.table } : {}),
    ...(es.dev_bot_fill ? { devBotFill: true } : {}),
    ...(es.sideboarding === true ? { sideboarding: true } : {}),
    ...(typeof es.play_draw === 'string' && es.play_draw ? { playDrawRule: es.play_draw.slice(0, 40) } : {}),
    playDraws: [], sideboards: [],
    startT: es.t, lastT: es.t, status: 'in-progress', seats, packs: [], picks: [], decks: new Map(), games: [], matches: [],
    standings: [], transcripts: new Map(), usage: new Map(), hasSummary: false, stage: 'draft', aborted: false, draftEnded: false, rulesIssues: [],
    forfeits: [], forfeitsLogged: typeof es.seat_timeout_ms === 'number' && es.seat_timeout_ms > 0,
  };
  const gameByLabel = new Map<string, Game>();
  const offered = new Map<string, Decision>();
  let ended = false;
  const matchEnds: RawMatchEnd[] = [];
  const strengthRecords: RawBase[] = [];

  for (const e of raw) {
    ev.lastT = Math.max(ev.lastT, e.t ?? 0);
    switch (e.type) {
      case 'packs_opened':
        ev.packs.push(e as RawPacksOpened);
        break;
      case 'draft_pick': {
        const p = e as RawPick;
        ev.picks.push({
          seat: p.seat, packNumber: p.pack_number, pickNumber: p.pick_number, overallPick: p.overall_pick, contents: p.pack, rarities: p.pack_rarities,
          pick: p.pick, by: p.by,
          latencyMs: p.latency_ms, t: p.t,
        });
        break;
      }
      case 'deck_built': {
        const d = e as RawDeck;
        ev.stage = 'build';
        ev.draftEnded = true;
        ev.decks.set(d.seat, { seat: d.seat, by: d.by, main: d.main ?? [], sideboard: d.sideboard ?? [], latencyMs: d.latency_ms, t: d.t });
        break;
      }
      case 'game_start': {
        const g = e as RawGameStart;
        ev.stage = 'games';
        const mk = matchKeyOf(g.game);
        const game: Game = {
          index: ev.games.length + 1, label: g.game, code: g.game_code, seats: g.seats, matchKey: mk.key, gameInMatch: mk.n,
          startT: g.t, over: false, winner: null, decisions: [], autoPasses: {}, forced: {}, payTaps: {}, failures: 0, mana: g.mana,
          plays: [], playsLogged: false, unimplemented: [], rulesIssues: [], refusedAuto: [], publicNames: new Set(),
        };
        const sizes = intRecord<Record<string, number>>(g.deck_sizes);
        if (sizes) game.deckSizes = Object.fromEntries(Object.entries(sizes).filter(([, n]) => typeof n === 'number'));
        ev.games.push(game);
        gameByLabel.set(g.game, game);
        break;
      }
      case 'decision_offered': {
        const o = e as RawOffered;
        const game = gameByLabel.get(o.game);
        const d: Decision = {
          game: o.game, seat: o.seat, id: o.id, kind: o.kind, turn: int(o.turn), t: o.t, text: typeof o.text === 'string' ? o.text : '',
          phase: o.phase, active: o.active, life: o.life, hand: o.hand, options: Array.isArray(o.options) ? o.options.map(String) : undefined,
        };
        game?.decisions.push(d);
        offered.set(`${o.game}|${o.seat}|${o.id}`, d);
        break;
      }
      case 'agent_decision': {
        const a = e as RawDecision;
        const d = offered.get(`${a.game}|${a.seat}|${a.id}`);
        if (d) {
          d.answer = {
            t: a.t, latencyMs: a.latency_ms, rawChoice: a.choice, choice: choiceLabel(a.choice, d.text), accepted: a.accepted !== false,
            structured: a.structured,
          };
          if (a.card) d.answer.card = a.card;
          if (a.action) d.answer.action = a.action;
          if (a.reason) d.answer.reason = a.reason;
          if (a.payment === 'auto' || a.payment === 'manual+auto') d.answer.payment = a.payment;
        }
        break;
      }
      case 'decision_withdrawn': {
        const a = e as RawAuto & { id: string };
        const d = offered.get(`${a.game}|${a.seat}|${a.id}`);
        if (d) d.withdrawn = true;
        break;
      }
      case 'pay_tap': {
        const a = e as RawAuto;
        const game = gameByLabel.get(a.game);
        if (game) game.payTaps[a.seat] = (game.payTaps[a.seat] ?? 0) + 1;
        if (game && a.ok === false) game.failures++;
        break;
      }
      case 'auto_pass':
      case 'forced': {
        const a = e as RawAuto;
        const game = gameByLabel.get(a.game);
        if (!game) break;
        const bucket = e.type === 'auto_pass' ? game.autoPasses : game.forced;
        bucket[a.seat] = (bucket[a.seat] ?? 0) + 1;
        if (a.ok === false) {
          game.failures++;
          if (engineRefusal(a.reason)) game.refusedAuto.push({ seat: a.seat, action: a.action, reason: a.reason, t: a.t });
        }
        break;
      }
      case 'pay_finish':
      case 'auto_pay': {
        const a = e as RawAuto;
        const game = gameByLabel.get(a.game);
        if (game && a.ok === false) {
          game.failures++;
          if (engineRefusal(a.reason)) game.refusedAuto.push({ seat: a.seat, action: a.action, reason: a.reason, t: a.t });
        }
        break;
      }
      case 'card_played': {
        const c = e as RawCardPlayed;
        const game = gameByLabel.get(c.game);
        if (game) {
          game.playsLogged = true;
          game.plays.push({ seat: c.seat, card: c.card, how: c.how ?? 'cast', turn: c.turn, t: c.t });
          game.publicNames.add(c.card);
        }
        break;
      }
      // turn_snapshot never makes a name public (SPEC-1): it is the host seat's projection, and logs written before
      // 2026-10-22 name that seat's face-down permanents in it. Public names come from cards played only; anything
      // else stays redacted in live rules reports until the event's hidden information is released.
      case 'draft_end':
        ev.draftEnded = true;
        break;
      case 'unimplemented_effect': {
        const u = e as RawUnimplemented;
        const game = gameByLabel.get(u.game);
        if (game && !game.unimplemented.some((x) => x.card === u.card && x.seat === (u.seat ?? null))) {
          game.unimplemented.push({ seat: u.seat ?? null, card: u.card, turn: u.turn, t: u.t, ...(u.mechanics?.length ? { mechanics: u.mechanics } : {}) });
        }
        break;
      }
      case 'rules_issue': {
        const r = e as RawRulesIssue;
        const issue: RulesIssue = { seat: r.seat, card: r.card ?? null, note: r.note ?? '', stage: r.stage, game: r.game, turn: r.turn, t: r.t };
        const game = r.game ? gameByLabel.get(r.game) : undefined;
        if (game) game.rulesIssues.push(issue);
        else ev.rulesIssues.push(issue);
        break;
      }
      case 'forfeit': {
        const f = e as RawForfeit;
        ev.forfeits.push({ seat: f.seat, stage: f.stage, reason: f.reason ?? 'inactive', idleMs: f.idle_ms, game: f.game, t: f.t });
        break;
      }
      case 'event_abort': {
        ev.aborted = true;
        const a = e as RawBase & { reason?: unknown; by?: unknown; stage?: unknown; open_games?: unknown };
        const by = a.by === 'organizer' || a.by === 'admin' || a.by === 'system' ? a.by : 'unknown';
        const open = Array.isArray(a.open_games)
          ? a.open_games
            .filter((g): g is { game: string; seats: string[] } => !!g && typeof g.game === 'string' && Array.isArray(g.seats) && g.seats.every((x: unknown) => typeof x === 'string'))
            .slice(0, 16).map((g) => ({ game: g.game.slice(0, 200), seats: g.seats.slice(0, 2) }))
          : [];
        ev.stop = { reason: typeof a.reason === 'string' ? a.reason.slice(0, 40) : 'stopped', by, ...(typeof a.stage === 'string' ? { stage: a.stage.slice(0, 20) } : {}), t: e.t, openGames: open, forfeitedGames: [] };
        break;
      }
      case 'event_error':
        ev.aborted = true;
        break;
      case 'pay_error':
      case 'phase_error': {
        const game = gameByLabel.get((e as RawAuto).game);
        if (game) game.failures++;
        break;
      }
      case 'game_over': {
        const g = e as RawGameOver;
        const game = gameByLabel.get(g.game);
        if (game) {
          game.over = true;
          game.winner = g.winner;
          game.turns = int(g.turns);
          game.stats = intRecord(g.stats);
          game.endT = g.t;
          game.onPlay = g.on_play;
          game.finalLife = g.final_life;
          game.endReason = g.end_reason;
          game.mulligans = g.mulligans;
          game.forfeitedBy = (g as { forfeited_by?: string }).forfeited_by ?? undefined;
          // Summary lists (newer logs) stand in for card_played lines if those are missing.
          if (g.cards_played && !game.playsLogged) {
            for (const [seat, rec] of Object.entries(g.cards_played)) {
              for (const [how, counts] of [['cast', rec.cast], ['activate', rec.activated]] as const) {
                for (const [card, n] of Object.entries(counts ?? {})) for (let i = 0; i < Math.min(int(n), 1000); i++) game.plays.push({ seat, card, how, t: g.t });
              }
            }
          }
          if (g.cards_played) game.playsLogged = true;
        }
        break;
      }
      case 'match_end':
        matchEnds.push(e as RawMatchEnd);
        break;
      case 'play_draw': {
        const p = e as RawPlayDraw;
        if (typeof p.match !== 'string' || typeof p.on_play !== 'string') break;
        // One per game: a voided and replayed game keeps its record (none is written again).
        const n = int(p.game_number, 1);
        if (ev.playDraws!.some((x) => x.match === p.match && x.gameNumber === n)) break;
        ev.playDraws!.push({
          match: p.match, gameNumber: n, onPlay: p.on_play,
          by: p.by === 'agent' || p.by === 'forfeit' ? p.by : 'seed',
          chooser: typeof p.chooser === 'string' ? p.chooser : null,
          choice: p.choice === 'play' || p.choice === 'draw' ? p.choice : null,
          ...(intOpt(p.latency_ms) != null ? { latencyMs: intOpt(p.latency_ms) } : {}),
          t: p.t,
        });
        break;
      }
      case 'sideboarded': {
        const r = e as RawSideboarded;
        if (typeof r.seat !== 'string' || typeof r.match !== 'string') break;
        const n = int(r.game_number, 2);
        if (ev.sideboards!.some((x) => x.seat === r.seat && x.match === r.match && x.gameNumber === n)) break;
        const main = strList(r.main);
        const inn = cardCounts(r.in);
        const out = cardCounts(r.out);
        ev.sideboards!.push({
          seat: r.seat, match: r.match, gameNumber: n, by: r.by === 'forfeit' ? 'forfeit' : 'agent',
          kept: typeof r.kept === 'boolean' ? r.kept : !inn.length && !out.length,
          in: inn, out, main, sideboard: strList(r.sideboard),
          basics: Object.fromEntries(Object.entries(intRecord<Record<string, number>>(r.basics) ?? {}).filter((kv): kv is [string, number] => typeof kv[1] === 'number')),
          mainCount: intOpt(r.main_count) ?? main.length,
          ...(intOpt(r.latency_ms) != null ? { latencyMs: intOpt(r.latency_ms) } : {}),
          t: r.t,
        });
        break;
      }
      case 'deck_strength':
        strengthRecords.push(e);
        break;
      case 'event_end':
        ended = true;
        ev.stage = 'done';
        break;
    }
  }
  ev.picks.sort((a, b) => a.packNumber - b.packNumber || a.pickNumber - b.pickNumber || a.t - b.t);
  // deck_strength records in the log (packages/director/src/strength.ts) win over strength.json.
  if (strengthRecords.length) ev.strength = strengthFromRecords(strengthRecords) ?? ev.strength;

  // Matches, from game labels; closed by match_end.
  const byKey = new Map<string, Match>();
  for (const g of ev.games) {
    let m = byKey.get(g.matchKey);
    if (!m) {
      const [a, b] = g.matchKey.split(' vs ');
      m = { key: g.matchKey, a: a ?? g.seats[0] ?? '?', b: b ?? g.seats[1] ?? '?', wins: {}, games: [], done: false };
      m.wins[m.a] = 0;
      m.wins[m.b] = 0;
      byKey.set(g.matchKey, m);
      ev.matches.push(m);
    }
    m.games.push(g);
    if (g.over && g.winner) m.wins[g.winner] = (m.wins[g.winner] ?? 0) + 1;
  }
  for (const me of matchEnds) {
    const m = byKey.get(`${me.a} vs ${me.b}`);
    if (m) {
      m.done = true;
      m.wins = { ...me.wins };
      if ((me as { no_result?: unknown }).no_result === true) m.noResult = true;
    }
  }

  // Standings: summary.json when present, else computed from games so far.
  const summaryPath = join(dir, 'summary.json');
  if (existsSync(summaryPath)) {
    try {
      const s = JSON.parse(readFileSync(summaryPath, 'utf8')) as { standings?: Standing[] };
      if (Array.isArray(s.standings)) {
        // One row per agent, numbers only (summary.json is as untrusted as the log).
        const seen = new Set<string>();
        ev.standings = s.standings
          .filter((r) => r && typeof r.name === 'string' && !seen.has(r.name) && seen.add(r.name))
          .map((r) => ({ name: r.name, matchWins: int(r.matchWins), matchLosses: int(r.matchLosses), gameWins: int(r.gameWins), gameLosses: int(r.gameLosses) }));
      }
      ev.hasSummary = true;
    } catch {
      /* written mid-build: ignore */
    }
  }
  if (!ev.standings.length) {
    const agents = seats.filter((s) => s.kind === 'agent');
    ev.standings = agents.map((s) => {
      const st: Standing = { name: s.name, matchWins: 0, matchLosses: 0, gameWins: 0, gameLosses: 0 };
      for (const m of ev.matches) {
        if (m.a !== s.name && m.b !== s.name) continue;
        const opp = m.a === s.name ? m.b : m.a;
        st.gameWins += m.wins[s.name] ?? 0;
        st.gameLosses += m.wins[opp] ?? 0;
        if (m.done && !m.noResult) {
          if ((m.wins[s.name] ?? 0) > (m.wins[opp] ?? 0)) st.matchWins++;
          else if ((m.wins[s.name] ?? 0) < (m.wins[opp] ?? 0)) st.matchLosses++;
        }
      }
      return st;
    });
    ev.standings.sort((a, b) => b.matchWins - a.matchWins || b.gameWins - b.gameLosses - (a.gameWins - a.gameLosses));
  }

  ev.status = ended || (ev.hasSummary && !ev.aborted) ? 'complete' : ev.aborted ? 'stopped' : now - ev.lastT > STALL_MS ? 'stalled' : 'in-progress';
  if (ev.stop) applyOrganizerStop(ev, ev.stop);

  for (const f of readdirSync(dir)) {
    const m = /^transcript-(.+)\.jsonl$/.exec(f);
    if (m) ev.transcripts.set(m[1]!, readTranscript(m[1]!, join(dir, f)));
    const u = /^usage-(.+)\.json$/.exec(f);
    if (u) {
      const file = readUsageFile(join(dir, f));
      if (file) ev.usage!.set(u[1]!, file);
    }
  }
  return ev;
}

export function loadRuns(runsDir: string, now: number): { events: EventData[]; legacy: LegacyGame[] } {
  const events: EventData[] = [];
  const legacy: LegacyGame[] = [];
  if (!existsSync(runsDir)) return { events, legacy };
  for (const name of readdirSync(runsDir).sort()) {
    const dir = join(runsDir, name);
    if (!statSync(dir).isDirectory()) continue;
    const path = logPath(dir);
    if (!path) continue;
    const head = path.endsWith('.gz') ? logHead(path) : readFileSync(path, 'utf8').slice(0, 200);
    if (head.includes('"type":"event_start"')) {
      const ev = loadEvent(dir, now);
      if (ev) events.push(ev);
    } else if (head.includes('"type":"match_start"')) {
      const raw = readJsonl(path);
      legacy.push({ id: name, t: raw[0]?.t ?? 0, events: raw.length, decisions: raw.filter((e) => e.type === 'agent_decision' || e.type === 'decision').length });
    }
  }
  events.sort((a, b) => b.startT - a.startT);
  legacy.sort((a, b) => b.t - a.t);
  return { events, legacy };
}

// ---------------------------------------------------------------------------
// 17Lands ratings

export interface CardRating {
  gih_wr: number | null; gp_wr?: number | null; oh_wr?: number | null; gns_wr?: number | null; iwd?: number | null;
  gih_games?: number; alsa?: number | null; ata?: number | null; picked?: number; seen?: number;
}

export interface Ratings {
  set: string; format?: string; games?: number; drafts?: number; baseline?: number; generatedAt?: string;
  /** deps/manifest.json snapshot id and the date range of the games (files from 2026-10-22 on). */
  snapshot?: string; dateRange?: { first: string | null; last: string | null };
  cards: Map<string, CardRating>;
}

export function loadRatings(setsDir: string, code: string): Ratings | null {
  const path = join(setsDir, code.toUpperCase(), '17lands.json');
  if (!existsSync(path)) return null;
  const j = JSON.parse(readFileSync(path, 'utf8')) as {
    set: string; format?: string; games?: number; drafts?: number; baseline_win_rate?: number; generated_at?: string; cards: Record<string, CardRating>;
    snapshot?: string; date_range?: { first: string | null; last: string | null };
  };
  const cards = new Map<string, CardRating>();
  for (const [k, v] of Object.entries(j.cards ?? {})) cards.set(k, v);
  return {
    set: j.set, format: j.format, games: j.games, drafts: j.drafts, baseline: j.baseline_win_rate, generatedAt: j.generated_at, cards,
    ...(j.snapshot ? { snapshot: j.snapshot } : {}), ...(j.date_range ? { dateRange: { first: j.date_range.first ?? null, last: j.date_range.last ?? null } } : {}),
  };
}

export function rating(r: Ratings | null | undefined, name: string): CardRating | undefined {
  if (!r) return undefined;
  return r.cards.get(name) ?? r.cards.get(name.split(' // ')[0]!);
}

// ---------------------------------------------------------------------------
// Card data (optional; phase-rs card-data.slim.json written by the Director)

export interface CardInfo { name: string; cost: string; typeLine: string; pt?: string; loyalty?: string; oracle: string }

export class CardDb {
  private byName = new Map<string, CardInfo>();
  readonly loaded: boolean;

  constructor(path: string | undefined) {
    if (path && existsSync(path)) {
      for (const c of JSON.parse(readFileSync(path, 'utf8')) as CardInfo[]) this.byName.set(c.name.toLowerCase(), c);
      this.loaded = true;
    } else {
      this.loaded = false;
    }
  }

  get(name: string): CardInfo | undefined {
    return this.byName.get(name.toLowerCase()) ?? this.byName.get(name.split(' // ')[0]!.toLowerCase());
  }

  /** Mana value from a "{2}{W}{U/B}" cost string. */
  mv(name: string): number | undefined {
    const c = this.get(name);
    if (!c) return undefined;
    return manaValue(c.cost);
  }

  colors(name: string): string {
    const c = this.get(name);
    if (!c) return '';
    if (/\bLand\b/.test(c.typeLine) && !c.cost) {
      const produced = new Set<string>();
      for (const m of c.oracle.matchAll(/\{([WUBRG])\}/g)) produced.add(m[1]!);
      return 'WUBRG'.split('').filter((x) => produced.has(x)).join('');
    }
    return colorsOfCost(c.cost);
  }

  /** Colors the card strictly needs: single-color mana symbols only ({G/W} hybrid and {W/P} Phyrexian pips need neither). */
  requiredColors(name: string): string {
    const c = this.get(name);
    if (!c) return '';
    const set = new Set<string>();
    for (const m of c.cost.matchAll(/\{([WUBRG])\}/g)) set.add(m[1]!);
    return 'WUBRG'.split('').filter((x) => set.has(x)).join('');
  }

  isLand(name: string): boolean {
    const c = this.get(name);
    return c ? /\bLand\b/.test(c.typeLine) : BASICS.has(name);
  }
}

export const BASICS = new Set(['Plains', 'Island', 'Swamp', 'Mountain', 'Forest', 'Wastes']);

export function manaValue(cost: string): number {
  let n = 0;
  for (const m of cost.matchAll(/\{([^}]+)\}/g)) {
    const s = m[1]!;
    if (/^\d+$/.test(s)) n += Number(s);
    else if (s === 'X') n += 0;
    else n += 1;
  }
  return n;
}

export function colorsOfCost(cost: string): string {
  const set = new Set<string>();
  for (const m of cost.matchAll(/\{([^}]+)\}/g)) for (const ch of m[1]!) if ('WUBRG'.includes(ch)) set.add(ch);
  return 'WUBRG'.split('').filter((x) => set.has(x)).join('');
}

/** A refusal that says something about the engine (not our own timeouts or superseded resends). */
export function engineRefusal(reason: string | undefined): boolean {
  return !!reason && !/^(timeout|superseded)/.test(reason);
}
