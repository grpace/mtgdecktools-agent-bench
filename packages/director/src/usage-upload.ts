/**
 * Usage summaries for hosted seats (docs/SITE-DATA.md "Usage uploads"). A hosted Director never sees harness logs, so
 * after a hosted event the bench CLI that started the seats (`bench play`, or `bench attach-logs` for seats started by
 * hand) sends the Hub a small summary per seat: the declared model, harness and effort, the model ids and token
 * counts the harness logged, the effort level it logged and its version. Never prompts, transcripts, reasoning, tool
 * output, titles or paths: the format is closed (unknown keys are refused) and every value is bounded.
 *
 * The CLI builds it (`seatUploadFromRun`), the Hub checks it (`validateUsageUpload`) and stores each seat as
 * usage-<seat>.json in the event's run folder (`usageFileFromUpload`), marked self-attested evidence read from the
 * contributor's own machine (`evidence.kind: "cli-local-logs"`, `self_attested: true`), like the usage file a community
 * bundle carries.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { registry } from '../../registry/src/index.js';
import { detectSeatEffort } from './effort-detect.js';
import { cleanId } from './harness-logs.js';
import { EVENT_ID_RE } from './submissions.js';
import { extractUsage, longContextOf, seatPrice } from './usage.js';

export const USAGE_UPLOAD_VERSION = 1;
/** Request body cap (the Hub reads no more). */
export const USAGE_UPLOAD_MAX_BYTES = 32 * 1024;
const MAX_SEATS = 8;
const MAX_MODELS = 8;
const MAX_TOKENS = 1e12;
const MAX_COST_USD = 1e5;

const ID_RE = /^[\w.:@/[\]+-]{1,100}$/;
const SEAT_RE = /^[\w.-]{1,64}$/;
const VERSION_RE = /^[\w .()+-]{1,60}$/;
const READ_BY_RE = /^[\w .:@+/-]{1,80}$/;
const SOURCE_RE = /^[a-z0-9-]{1,40}$/;

/** One seat's summary. Exactly these keys; nothing else is accepted. */
export interface UploadSeat {
  seat: string;
  /** As declared for the seat (event_start): the upload must name the seat's own declaration. */
  harness: string;
  model: string;
  effort: string;
  /** Where the CLI read it: the transcript of a session it started, or a hand-started session's logs (attach-logs). */
  source: 'launch-transcript' | 'harness-logs';
  read_by: string;
  harness_version?: string;
  /** Model ids the harness logged, and its output tokens per model where it says. */
  model_ids: string[];
  model_output_tokens?: Record<string, number>;
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_creation_tokens?: number;
  reasoning_tokens?: number;
  /** The part of cache_creation_tokens written for 1 hour (Claude Code), which costs more than the default write. */
  cache_creation_1h_tokens?: number;
  /** API requests the seat made, where the transcript has per-request usage. */
  requests?: number;
  /**
   * The tokens of the requests whose prompt was over the declared model's long-context threshold (`above`), which pay
   * the higher prices on all of it (registry/prices.json). With the totals this prices the seat request by request.
   */
  long_context?: { above: number; requests: number; input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_creation_tokens: number; cache_creation_1h_tokens: number };
  /**
   * The harness-reported cost (Claude Code: list-price equivalent), only when every session of the seat reported one:
   * a session ended from outside (a fresh session per game) writes none, and a partial sum would undercount.
   */
  cost_usd?: number | null;
  /** The effort level the harness logged (packages/director/src/effort-detect.ts). */
  effort_reported?: { level: string | null; counts: Record<string, number>; source: string; status?: 'tested' | 'untested'; fast?: boolean };
}

export interface UsageUpload {
  version: typeof USAGE_UPLOAD_VERSION;
  event_id: string;
  seats: UploadSeat[];
}

/** The keys a Hub before the per-request fields (2026-10-22) knows; scripts/bench/usage-upload.ts falls back to them. */
export const SEAT_KEYS_V1 = ['seat', 'harness', 'model', 'effort', 'source', 'read_by', 'harness_version', 'model_ids', 'model_output_tokens', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_creation_tokens', 'reasoning_tokens', 'cost_usd', 'effort_reported'] as const;
const SEAT_KEYS = new Set<string>([...SEAT_KEYS_V1, 'cache_creation_1h_tokens', 'requests', 'long_context']);
const TOKEN_KEYS = ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_creation_tokens', 'reasoning_tokens', 'cache_creation_1h_tokens', 'requests'] as const;
const LONG_KEYS = ['requests', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_creation_tokens', 'cache_creation_1h_tokens'] as const;
const EFFORT_KEYS = new Set(['level', 'counts', 'source', 'status', 'fast']);

const count = (v: unknown, max = MAX_TOKENS): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * The summary of one seat from the run folder on this machine, or undefined when there is nothing to send: the
 * transcript of the sessions `bench play` started (with the effort the harness's session record shows), else the facts
 * `bench attach-logs` found (harness-logs-<seat>.json). No model ids: nothing that checks the model, so nothing sent.
 */
export function seatUploadFromRun(dir: string, seat: string, declared: { harness?: string; model?: string; effort?: string }, readBy: string, at: number = Date.now()): UploadSeat | undefined {
  if (!declared.harness || !declared.model || !declared.effort) return undefined;
  const base = { seat, harness: declared.harness, model: declared.model, effort: declared.effort, read_by: readBy.slice(0, 80) };
  const effortOf = (e: ReturnType<typeof detectSeatEffort>): UploadSeat['effort_reported'] | undefined => (e
    ? { level: e.level, counts: Object.fromEntries(Object.entries(e.counts ?? {}).filter(([k, v]) => k.length <= 20 && count(v)).slice(0, 12)), source: e.source, status: e.status, ...(e.fast ? { fast: true } : {}) }
    : undefined);
  const transcript = join(dir, `transcript-${seat}.jsonl`);
  if (existsSync(transcript)) {
    const u = extractUsage(transcript, seat, declared.harness);
    const effort = detectSeatEffort(dir, seat, declared.harness, transcript);
    // A stream without a model id (Cursor CLI names it for people: "GPT-5.6 Luna 272K Low"; OpenCode 2's json events
    // name none) takes the model the effort record found (the registry id of Cursor's name, OpenCode's session record).
    const streamIds = u.model_ids.map(cleanId).filter((x): x is string => !!x && ID_RE.test(x));
    const recorded = cleanId(effort?.model);
    const ids = (streamIds.length ? streamIds : recorded && ID_RE.test(recorded) ? [recorded] : []).slice(0, MAX_MODELS);
    if (!ids.length) return undefined;
    let runVersion: string | undefined;
    try {
      runVersion = JSON.parse(readFileSync(join(dir, `harness-${seat}.json`), 'utf8'))?.harness_version;
    } catch {
      // no launch record
    }
    const version = [u.harness_version, effort?.harness_version, runVersion].map((v) => (typeof v === 'string' ? v.trim().slice(0, 60) : '')).find((v) => VERSION_RE.test(v));
    const perModel = Object.entries(u.model_output_tokens ?? {}).filter(([k, v]) => ID_RE.test(k) && count(v)).slice(0, MAX_MODELS);
    const er = effortOf(effort);
    // Per-request prices: the tokens of the requests over the declared model's long-context threshold.
    const above = seatPrice(u, declared.model, declared.harness, at)?.long_context?.above;
    const lc = above ? longContextOf(u, above) : undefined;
    return {
      ...base, source: 'launch-transcript', ...(version ? { harness_version: version } : {}), model_ids: ids,
      ...(perModel.length ? { model_output_tokens: Object.fromEntries(perModel) } : {}),
      ...Object.fromEntries(TOKEN_KEYS.filter((k) => count(u[k])).map((k) => [k, u[k]])),
      ...(lc ? {
        long_context: {
          above: lc.above, requests: lc.requests, input_tokens: lc.input, output_tokens: lc.output, cache_read_tokens: lc.cache_read,
          cache_creation_tokens: lc.cache_write, cache_creation_1h_tokens: lc.cache_write_1h,
        },
      } : {}),
      ...(u.cost_usd != null && Number.isFinite(u.cost_usd) && u.cost_usd >= 0 && u.cost_usd <= MAX_COST_USD ? { cost_usd: Math.round(u.cost_usd * 1e4) / 1e4 } : {}),
      ...(er ? { effort_reported: er } : {}),
    };
  }
  const logs = join(dir, `harness-logs-${seat}.json`);
  if (!existsSync(logs)) return undefined;
  let l: any;
  try {
    l = JSON.parse(readFileSync(logs, 'utf8'));
  } catch {
    return undefined;
  }
  const ids = (Array.isArray(l?.model_ids) ? l.model_ids : []).map(cleanId).filter((x: string | undefined): x is string => !!x && ID_RE.test(x)).slice(0, MAX_MODELS);
  if (!ids.length) return undefined;
  const perModel = isObj(l.model_output_tokens)
    ? (Object.entries(l.model_output_tokens).filter(([k, v]) => ID_RE.test(k) && count(v)) as Array<[string, number]>).slice(0, MAX_MODELS) : [];
  const version = typeof l.harness_version === 'string' ? cleanId(l.harness_version) : undefined;
  const er = effortOf(detectSeatEffort(dir, seat, declared.harness));
  return {
    ...base, source: 'harness-logs', ...(version && VERSION_RE.test(version) ? { harness_version: version } : {}), model_ids: ids,
    ...(perModel.length ? { model_output_tokens: Object.fromEntries(perModel) } : {}),
    ...(er ? { effort_reported: er } : {}),
  };
}

/** The event_start seat fields the check reads. */
interface StartSeat { name: string; kind?: string; harness?: string; model?: string; effort?: string; model_declared?: string; effort_declared?: string }

/**
 * Check an upload against the event it names (its event_start record): a closed format with bounded values, seats of
 * this event that are agents, each naming its own declared harness, model and effort, all resolvable in the registry.
 * Ownership (who may send which seat) is the Hub's check.
 */
export function validateUsageUpload(body: unknown, start: { id?: string; t?: number; seats?: StartSeat[] }): { ok: true; upload: UsageUpload } | { ok: false; error: string } {
  const bad = (error: string) => ({ ok: false as const, error });
  if (!isObj(body)) return bad('the body must be a JSON object { version, event_id, seats }');
  const extraTop = Object.keys(body).filter((k) => !['version', 'event_id', 'seats'].includes(k));
  if (extraTop.length) return bad(`unknown field${extraTop.length === 1 ? '' : 's'}: ${extraTop.slice(0, 5).join(', ')} (usage uploads carry only version, event_id and seats)`);
  if (body.version !== USAGE_UPLOAD_VERSION) return bad(`version must be ${USAGE_UPLOAD_VERSION}`);
  if (typeof body.event_id !== 'string' || !EVENT_ID_RE.test(body.event_id)) return bad('event_id is not an event id');
  if (start.id && body.event_id !== start.id) return bad('event_id does not match the event');
  if (!Array.isArray(body.seats) || !body.seats.length || body.seats.length > MAX_SEATS) return bad(`seats must list 1 to ${MAX_SEATS} seats`);
  const agents = new Map((start.seats ?? []).filter((s) => s.kind === 'agent').map((s) => [s.name, s]));
  const seen = new Set<string>();
  const seats: UploadSeat[] = [];
  for (const raw of body.seats) {
    if (!isObj(raw)) return bad('every seat must be an object');
    const name = typeof raw.seat === 'string' && SEAT_RE.test(raw.seat) ? raw.seat : undefined;
    if (!name) return bad('every seat needs its seat name');
    const at = `seat ${name}`;
    const extra = Object.keys(raw).filter((k) => !SEAT_KEYS.has(k));
    if (extra.length) return bad(`${at}: unknown field${extra.length === 1 ? '' : 's'}: ${extra.slice(0, 5).join(', ')} (only the model, effort, harness version and token counts)`);
    if (seen.has(name)) return bad(`${at} is listed twice`);
    seen.add(name);
    const s = agents.get(name);
    if (!s) return bad(`${at} is not an agent seat of this event`);
    // The seat's own declaration, exactly as the event recorded it.
    const declared = { harness: s.harness, model: s.model_declared ?? s.model, effort: s.effort_declared ?? s.effort };
    const h = registry.resolveHarness(declared.harness);
    if (!h.ok) return bad(`${at}: harness "${declared.harness}" isn't in the registry`);
    const m = registry.resolveModel(declared.model, h.id, { at: start.t });
    if (!m.ok) return bad(`${at}: model "${declared.model}" isn't in the registry`);
    const e = registry.normalizeEffort(declared.effort, m.model, h.harness);
    if (!e.ok) return bad(`${at}: effort "${declared.effort}" isn't a level the registry knows for this model`);
    // The same declaration, as written or as the registry resolves it (an id for a display name, say).
    const rh = typeof raw.harness === 'string' ? registry.resolveHarness(raw.harness) : undefined;
    const rm = typeof raw.model === 'string' ? registry.resolveModel(raw.model, h.id, { at: start.t }) : undefined;
    const re = typeof raw.effort === 'string' ? registry.normalizeEffort(raw.effort, m.model, h.harness) : undefined;
    const same = {
      harness: raw.harness === declared.harness || (!!rh?.ok && rh.id === h.id),
      model: raw.model === declared.model || (!!rm?.ok && rm.id === m.id),
      effort: raw.effort === declared.effort || (!!re?.ok && re.effort === e.effort),
    };
    for (const k of ['harness', 'model', 'effort'] as const) {
      if (!same[k]) return bad(`${at}: ${k} "${String(raw[k]).slice(0, 60)}" is not what the seat declared ("${declared[k] ?? ''}")`);
    }
    if (raw.source !== 'launch-transcript' && raw.source !== 'harness-logs') return bad(`${at}: source must be "launch-transcript" or "harness-logs"`);
    if (typeof raw.read_by !== 'string' || !READ_BY_RE.test(raw.read_by)) return bad(`${at}: read_by must be a short tool name and version`);
    if (raw.harness_version !== undefined && (typeof raw.harness_version !== 'string' || !VERSION_RE.test(raw.harness_version))) return bad(`${at}: harness_version must be a short version string`);
    if (!Array.isArray(raw.model_ids) || !raw.model_ids.length || raw.model_ids.length > MAX_MODELS || !raw.model_ids.every((x) => typeof x === 'string' && ID_RE.test(x))) {
      return bad(`${at}: model_ids must list 1 to ${MAX_MODELS} model ids`);
    }
    if (raw.model_output_tokens !== undefined) {
      const e = isObj(raw.model_output_tokens) ? Object.entries(raw.model_output_tokens) : null;
      if (!e || e.length > MAX_MODELS || !e.every(([k, v]) => ID_RE.test(k) && count(v))) return bad(`${at}: model_output_tokens must map model ids to token counts`);
    }
    for (const k of TOKEN_KEYS) if (raw[k] !== undefined && !count(raw[k])) return bad(`${at}: ${k} must be a whole number from 0 to ${MAX_TOKENS}`);
    if (raw.long_context !== undefined) {
      const l = raw.long_context;
      if (!isObj(l) || Object.keys(l).some((k) => k !== 'above' && !(LONG_KEYS as readonly string[]).includes(k)) || !count(l.above, 1e8) || !(l.above as number) || !LONG_KEYS.every((k) => count(l[k]))) {
        return bad(`${at}: long_context takes above, ${LONG_KEYS.join(', ')} (whole numbers)`);
      }
      const totals: Record<string, unknown> = { requests: raw.requests, input_tokens: raw.input_tokens, output_tokens: raw.output_tokens, cache_read_tokens: raw.cache_read_tokens, cache_creation_tokens: raw.cache_creation_tokens, cache_creation_1h_tokens: raw.cache_creation_1h_tokens };
      if (LONG_KEYS.some((k) => (l[k] as number) > ((totals[k] as number | undefined) ?? 0))) return bad(`${at}: long_context counts can't exceed the seat's totals`);
    }
    if (raw.cost_usd !== undefined && raw.cost_usd !== null && !(typeof raw.cost_usd === 'number' && Number.isFinite(raw.cost_usd) && raw.cost_usd >= 0 && raw.cost_usd <= MAX_COST_USD)) {
      return bad(`${at}: cost_usd must be a number from 0 to ${MAX_COST_USD}`);
    }
    if (raw.effort_reported !== undefined) {
      const e = raw.effort_reported;
      if (!isObj(e) || Object.keys(e).some((k) => !EFFORT_KEYS.has(k))) return bad(`${at}: effort_reported takes level, counts, source, status and fast only`);
      if (e.level !== null && !(typeof e.level === 'string' && registry.normalizeEffort(e.level).ok)) return bad(`${at}: effort_reported.level must be an effort level or null`);
      if (typeof e.source !== 'string' || !SOURCE_RE.test(e.source)) return bad(`${at}: effort_reported.source must be a short source name`);
      const counts = isObj(e.counts) ? Object.entries(e.counts) : null;
      if (!counts || counts.length > 12 || !counts.every(([k, v]) => /^[a-z]{1,20}$/.test(k) && count(v, 1e7))) return bad(`${at}: effort_reported.counts must map levels to counts`);
      if (e.status !== undefined && e.status !== 'tested' && e.status !== 'untested') return bad(`${at}: effort_reported.status must be "tested" or "untested"`);
      if (e.fast !== undefined && typeof e.fast !== 'boolean') return bad(`${at}: effort_reported.fast must be true or false`);
    }
    seats.push(raw as unknown as UploadSeat);
  }
  return { ok: true, upload: { version: USAGE_UPLOAD_VERSION, event_id: body.event_id, seats } };
}

/**
 * usage-<seat>.json for the run folder (packages/site reads it as any bundle's usage file): the summary, the seat's
 * declaration, and where it came from: read on the contributor's machine by their CLI, self-attested, received by the
 * Hub after the event.
 */
export function usageFileFromUpload(s: UploadSeat, uploadedBy: 'contributor' | 'admin', receivedAt: string): Record<string, unknown> {
  const { seat, harness, model, effort, source, read_by, ...facts } = s;
  return {
    seat, harness, format: source === 'harness-logs' ? 'harness-logs' : 'usage-upload', ...facts,
    model_declared: model, effort_declared: effort,
    evidence: { kind: 'cli-local-logs', self_attested: true, read_by, via: 'hub-usage-upload', source, uploaded_by: uploadedBy, received_at: receivedAt },
  };
}
