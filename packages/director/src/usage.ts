/**
 * Per-seat harness usage from a headless harness transcript: model ids, tokens, cost, duration,
 * tool-call counts. Never copies prompts, reasoning or tool inputs/outputs.
 *
 * Formats:
 *   claude-stream-json   claude -p --output-format stream-json --verbose
 *   codex-json           codex exec --json                                   (per the Codex docs)
 *   gemini-stream-json   gemini -p --output-format stream-json               (per the Gemini CLI docs)
 *   opencode-json        opencode run --format json                          (per the OpenCode docs)
 *   cursor-stream-json   cursor-agent -p --output-format stream-json         (a Claude-like stream)
 */
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { registry } from '../../registry/src/index.js';
import { estimateUsd, longContextSplit, longShare, priceFor, type LongSplit, type PriceEntry, type TokenCounts } from '../../registry/src/prices.js';

export interface SeatUsage {
  seat: string;
  harness?: string;
  format: string;
  /** Model ids the harness reported (may include small helper models the harness uses itself). */
  model_ids: string[];
  /**
   * Output tokens per reported model id, where the harness says (Claude Code's modelUsage or per message; OpenCode
   * steps). The registry's primaryModelFromUsage picks the seat's model from it (packages/registry).
   */
  model_output_tokens?: Record<string, number>;
  harness_version?: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  reasoning_tokens: number;
  /**
   * Harness-reported cost in USD (API list-price equivalent for Claude Code), or null when not every session reported
   * one (a session ended before its result line: `sessions_unreported`). seatUsd() estimates it then.
   */
  cost_usd: number | null;
  /** The part of cache_creation_tokens written for 1 hour (Claude Code), where the harness says. */
  cache_creation_1h_tokens?: number;
  /** API requests (one per assistant message id), where the transcript has per-request usage. */
  requests?: number;
  duration_ms: number | null;
  turns: number | null;
  tool_calls: Record<string, number>;
  tool_errors: number;
  /** The harness wrote its final result line (the session ended normally). */
  complete: boolean;
  /** Sessions in the transcript when there were several (a seat relaunched after an early exit, or rotated). */
  sessions?: number;
  /** Sessions that ended without a cost on a result line (stopped from outside); then cost_usd is null. */
  sessions_unreported?: number;
  lines: number;
  /**
   * Token counts per API request (Claude Code: every assistant message id, every session), for per-request prices.
   * Not part of a usage file or upload (usageFacts() leaves it out).
   */
  calls?: TokenCounts[];
}

/** A SeatUsage without the per-request list (what usage files and uploads carry). */
export function usageFacts(u: SeatUsage): Omit<SeatUsage, 'calls'> {
  const { calls: _calls, ...rest } = u;
  return rest;
}

/**
 * Claude Code's own session record next to a transcript (bench play saves it as session-<seat>.jsonl, one session after
 * another). Its assistant messages carry the final usage of each request; the stream-json transcript's carry the
 * usage as the message started (output_tokens is a placeholder of a few tokens), so a session stopped before its result
 * line would count almost no output from the transcript alone.
 */
function sessionUsage(file: string | undefined): Map<string, any> {
  const out = new Map<string, any>();
  if (!file || !existsSync(file)) return out;
  for (const o of parseLines(file)) {
    const m = o?.type === 'assistant' ? o.message : undefined;
    if (!m?.id || !m.usage || m.model === '<synthetic>') continue;
    const prev = out.get(m.id);
    if (!prev || (m.usage.output_tokens ?? 0) >= (prev.output_tokens ?? 0)) out.set(m.id, m.usage);
  }
  return out;
}

/** The session record that belongs to a transcript: session-<seat>.jsonl next to transcript-<seat>.jsonl. */
export function sessionFileFor(transcript: string, seat: string): string | undefined {
  if (!/^transcript-/.test(basename(transcript))) return undefined;
  const f = join(dirname(transcript), `session-${seat}.jsonl`);
  return existsSync(f) ? f : undefined;
}

const callOf = (x: any): TokenCounts => ({
  input: x.input_tokens ?? 0,
  output: x.output_tokens ?? 0,
  cache_read: x.cache_read_input_tokens ?? 0,
  cache_write: x.cache_creation_input_tokens ?? 0,
  cache_write_1h: x.cache_creation?.ephemeral_1h_input_tokens ?? 0,
});

function parseLines(file: string): any[] {
  const out: any[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // partial or non-JSON line (stderr mixed in): skip
    }
  }
  return out;
}

/**
 * Why a seat's usage can't be trusted as read, or null (LAUNCH-CHECKLIST E-8): a harness update that changes its log
 * format must not turn into silent zeros, a $0 cost or Unknown effort. Shown by preflight, `bench play` and Keep Playing.
 */
export function usageProblem(u: Pick<SeatUsage, 'format' | 'lines' | 'input_tokens' | 'output_tokens' | 'cache_read_tokens' | 'cost_usd'>): string | null {
  if (!u.lines) return null;
  if (u.format === 'unknown') return "the harness log isn't in a format this version reads (a harness update?): its model, tokens, cost and effort aren't read; update the bench";
  const tokens = u.input_tokens + u.output_tokens + u.cache_read_tokens;
  if (!tokens) return 'the harness log has no token counts: cost is unknown and the model may go unchecked';
  if (u.cost_usd === 0) return 'the harness reported $0 with tokens used: the cost is estimated from the tokens instead';
  return null;
}

export function detectFormat(objs: any[], harness?: string): string {
  const types = new Set(objs.map((o) => o?.type));
  if (harness?.startsWith('cursor')) return 'cursor-stream-json';
  if (types.has('thread.started') || types.has('turn.completed')) return 'codex-json';
  if (objs.some((o) => o?.type === 'system' && o?.subtype === 'init' && o?.claude_code_version)) return 'claude-stream-json';
  if (objs.some((o) => o?.type === 'step_finish' || o?.part?.type === 'step-finish')) return 'opencode-json';
  if (types.has('init') && (types.has('result') || types.has('tool_use'))) return 'gemini-stream-json';
  if (types.has('system') && types.has('assistant')) return harness?.startsWith('claude') ? 'claude-stream-json' : 'cursor-stream-json';
  return 'unknown';
}

const stripMcp = (name: string) => String(name ?? 'unknown').replace(/^mcp__[^_]+__/, '').replace(/^mtg[_.]/, '');

/**
 * `opts.sessionFile`: Claude Code's session record for the same sessions (default: session-<seat>.jsonl next to a
 * transcript-<seat>.jsonl; false for none). It supplies the final per-request usage the stream-json lines lack.
 */
export function extractUsage(file: string, seat: string, harness?: string, opts: { sessionFile?: string | false } = {}): SeatUsage {
  const objs = parseLines(file);
  const u: SeatUsage = {
    seat, harness, format: detectFormat(objs, harness), model_ids: [], input_tokens: 0, output_tokens: 0, cache_read_tokens: 0,
    cache_creation_tokens: 0, reasoning_tokens: 0, cost_usd: null, duration_ms: null, turns: null, tool_calls: {}, tool_errors: 0, complete: false, lines: objs.length,
  };
  const models = new Set<string>();
  const perModel: Record<string, number> = {};
  const addOut = (model: unknown, n: unknown) => {
    if (typeof model === 'string' && model && typeof n === 'number' && Number.isFinite(n)) perModel[model] = (perModel[model] ?? 0) + n;
  };
  const tool = (name: string) => (u.tool_calls[stripMcp(name)] = (u.tool_calls[stripMcp(name)] ?? 0) + 1);

  if (u.format === 'claude-stream-json' || u.format === 'cursor-stream-json') {
    // A seat's transcript can hold several sessions (relaunched after an early exit, or rotated at a game boundary;
    // appended to the same file): each starts with a system init line. Per session the result line's totals and cost
    // are authoritative; a session without one (stopped from outside) counts its per-message usage, final figures
    // from the session record where there is one. Sessions are summed. The cost is reported only when every session
    // reported it; otherwise it is null and seatUsd() prices the requests one by one.
    const final = opts.sessionFile === false ? new Map<string, any>() : sessionUsage(opts.sessionFile ?? sessionFileFor(file, seat));
    type Session = { byMsg: Map<string, any>; msgModel: Map<string, string>; result?: any };
    const sessions: Session[] = [];
    let cur: Session | undefined;
    const seenTools = new Set<string>();
    for (const o of objs) {
      if (o.type === 'system' && o.subtype === 'init') {
        cur = { byMsg: new Map(), msgModel: new Map() };
        sessions.push(cur);
        if (typeof o.model === 'string') models.add(o.model);
        if (o.claude_code_version) u.harness_version = o.claude_code_version;
      }
      if (!cur) {
        cur = { byMsg: new Map(), msgModel: new Map() };
        sessions.push(cur);
      }
      if (o.type === 'assistant' && o.message) {
        if (typeof o.message.model === 'string' && o.message.model !== '<synthetic>') models.add(o.message.model);
        if (o.message.id && o.message.usage && o.message.model !== '<synthetic>') {
          // The final usage of the request: the session record's, else the largest output seen in the stream.
          const prev = cur.byMsg.get(o.message.id);
          const rec = final.get(o.message.id);
          const best = rec ?? o.message.usage;
          const out = Math.max(best.output_tokens ?? 0, o.message.usage.output_tokens ?? 0, prev?.output_tokens ?? 0);
          cur.byMsg.set(o.message.id, { ...best, output_tokens: out });
        }
        if (o.message.id && typeof o.message.model === 'string') cur.msgModel.set(o.message.id, o.message.model);
        for (const b of o.message.content ?? []) if (b?.type === 'tool_use' && b.id && !seenTools.has(b.id)) (seenTools.add(b.id), tool(b.name));
      }
      if (o.type === 'tool_call' && o.subtype === 'started') tool(Object.keys(o.tool_call ?? {})[0] ?? 'unknown');
      if (o.type === 'user' && o.message) for (const b of o.message.content ?? []) if (b?.type === 'tool_result' && b.is_error) u.tool_errors++;
      if (o.type === 'result') {
        cur.result = o;
        for (const m of Object.keys(o.modelUsage ?? {})) models.add(m);
      }
    }
    const used = sessions.filter((x) => x.byMsg.size || x.result);
    let reported = 0;
    let unreported = 0;
    let w1h = 0;
    let w1hKnown = false;
    for (const sess of used) {
      const r = sess.result;
      if (r && typeof r.total_cost_usd === 'number') reported += r.total_cost_usd;
      else unreported++;
      if (r) {
        if (typeof r.duration_ms === 'number') u.duration_ms = (u.duration_ms ?? 0) + r.duration_ms;
        if (typeof r.num_turns === 'number') u.turns = (u.turns ?? 0) + r.num_turns;
      }
      // Output per model: the result's modelUsage (it includes helper models), else per assistant message.
      const mu = r?.modelUsage && typeof r.modelUsage === 'object' ? Object.entries(r.modelUsage as Record<string, any>) : [];
      if (mu.length) for (const [m, x] of mu) addOut(m, x?.outputTokens ?? x?.output_tokens);
      else for (const [mid, x] of sess.byMsg) addOut(sess.msgModel.get(mid), x?.output_tokens ?? x?.outputTokens);
      for (const x of r?.usage ? [r.usage] : [...sess.byMsg.values()]) {
        u.input_tokens += x.input_tokens ?? x.inputTokens ?? 0;
        u.output_tokens += x.output_tokens ?? x.outputTokens ?? 0;
        u.cache_read_tokens += x.cache_read_input_tokens ?? x.cacheReadTokens ?? 0;
        u.cache_creation_tokens += x.cache_creation_input_tokens ?? x.cacheWriteTokens ?? 0;
        u.reasoning_tokens += x.output_tokens_details?.thinking_tokens ?? 0;
        const h = x.cache_creation?.ephemeral_1h_input_tokens;
        if (typeof h === 'number') (w1h += h, w1hKnown = true);
      }
    }
    if (used.length) u.cost_usd = unreported ? null : reported;
    if (unreported && used.length) u.sessions_unreported = unreported;
    if (w1hKnown) u.cache_creation_1h_tokens = w1h;
    const calls = used.flatMap((x) => [...x.byMsg.values()].map(callOf));
    if (calls.length) (u.calls = calls, u.requests = calls.length);
    // Complete when the last session ended normally.
    u.complete = !!sessions[sessions.length - 1]?.result;
    if (used.length > 1) u.sessions = used.length;
  } else if (u.format === 'codex-json') {
    for (const o of objs) {
      if (typeof o.model === 'string') models.add(o.model);
      if (o.type === 'turn.completed' && o.usage) {
        // Codex counts cached tokens inside input_tokens; report them separately like the others.
        u.input_tokens += (o.usage.input_tokens ?? 0) - (o.usage.cached_input_tokens ?? 0);
        u.cache_read_tokens += o.usage.cached_input_tokens ?? 0;
        u.output_tokens += o.usage.output_tokens ?? 0;
        u.reasoning_tokens += o.usage.reasoning_output_tokens ?? 0;
        u.turns = (u.turns ?? 0) + 1;
        u.complete = true;
      }
      if (o.type === 'item.completed' && o.item?.type === 'mcp_tool_call') {
        tool(o.item.tool ?? 'unknown');
        if (o.item.status === 'failed' || o.item.error) u.tool_errors++;
      }
      if (o.type === 'item.completed' && o.item?.type === 'command_execution') tool('shell');
    }
  } else if (u.format === 'gemini-stream-json') {
    for (const o of objs) {
      if (o.type === 'init' && typeof o.model === 'string') models.add(o.model);
      if (o.type === 'tool_use') tool(o.tool_name ?? 'unknown');
      if (o.type === 'tool_result' && o.status === 'error') u.tool_errors++;
      if (o.type === 'result') {
        u.complete = o.status !== 'error';
        const s = o.stats ?? {};
        u.input_tokens += s.input_tokens ?? s.input ?? 0;
        u.output_tokens += s.output_tokens ?? 0;
        u.cache_read_tokens += s.cached ?? s.cached_tokens ?? 0;
        if (typeof s.duration_ms === 'number') u.duration_ms = s.duration_ms;
        for (const [m, x] of Object.entries((s.models ?? {}) as Record<string, any>)) {
          models.add(m);
          // Per-model stats shape isn't documented: take an output count only when one is there.
          addOut(m, x?.output_tokens ?? x?.tokens?.output ?? x?.tokens?.candidates);
        }
      }
    }
  } else if (u.format === 'opencode-json') {
    let first: number | undefined, last: number | undefined;
    let curModel: string | undefined;
    for (const o of objs) {
      const ts = typeof o.timestamp === 'number' ? o.timestamp : undefined;
      if (ts) (first ??= ts, last = ts);
      const p = o.part ?? o;
      if (typeof p.modelID === 'string') curModel = p.providerID ? `${p.providerID}/${p.modelID}` : p.modelID;
      if (p.type === 'step-finish' || o.type === 'step_finish') {
        const t = p.tokens ?? {};
        addOut(curModel, t.output);
        u.input_tokens += t.input ?? 0;
        u.output_tokens += t.output ?? 0;
        u.reasoning_tokens += t.reasoning ?? 0;
        u.cache_read_tokens += t.cache?.read ?? 0;
        u.cache_creation_tokens += t.cache?.write ?? 0;
        if (typeof p.cost === 'number') u.cost_usd = (u.cost_usd ?? 0) + p.cost;
        u.turns = (u.turns ?? 0) + 1;
        u.complete = true;
      }
      if (p.type === 'tool' || o.type === 'tool_use') {
        tool(p.tool ?? 'unknown');
        if (p.state?.status === 'error') u.tool_errors++;
      }
      if (typeof p.modelID === 'string') models.add(p.providerID ? `${p.providerID}/${p.modelID}` : p.modelID);
    }
    if (first && last) u.duration_ms = last - first;
  }
  u.model_ids = [...models];
  if (Object.keys(perModel).length) u.model_output_tokens = perModel;
  return u;
}

/** A seat's token totals in the shape the price functions take. */
export const usageTokens = (u: Pick<SeatUsage, 'input_tokens' | 'output_tokens' | 'cache_read_tokens' | 'cache_creation_tokens' | 'cache_creation_1h_tokens'>): TokenCounts => ({
  input: u.input_tokens, output: u.output_tokens, cache_read: u.cache_read_tokens, cache_write: u.cache_creation_tokens, cache_write_1h: u.cache_creation_1h_tokens ?? 0,
});

/** The list price for a seat: its declared model (as the registry resolves it), else the first model id it logged. */
export function seatPrice(u: Pick<SeatUsage, 'model_ids'>, model: string | undefined, harness: string | undefined, at: number | string | Date): PriceEntry | null {
  const r = model ? registry.resolveModel(model, harness, { at }) : undefined;
  const ids = [...(r?.ok ? [r.id] : []), ...u.model_ids.map((m) => registry.resolveModel(m, harness, { at })).filter((x) => x.ok).map((x) => (x as { id: string }).id)];
  for (const id of ids) {
    const p = priceFor(id, at);
    if (p) return p;
  }
  return null;
}

/**
 * A seat's cost: what the harness reported when every session reported it, else an estimate at list price, each
 * request priced by its own prompt size where the transcript has per-request usage (long-context prices). Null when
 * there is no cost and no price.
 */
export function seatUsd(u: SeatUsage, model: string | undefined, harness: string | undefined, at: number | string | Date = Date.now()): { usd: number; basis: 'reported' | 'estimated' } | null {
  const tokens = u.input_tokens + u.output_tokens + u.cache_read_tokens + u.cache_creation_tokens;
  // $0 reported with tokens used is a harness that doesn't price this model (OpenCode `cost: 0`), not a free seat (E-8).
  if (u.cost_usd != null && !(u.cost_usd === 0 && tokens > 0)) return { usd: u.cost_usd, basis: 'reported' };
  if (!tokens) return null;
  const p = seatPrice(u, model, harness, at);
  if (!p) return null;
  const share = p.long_context && u.calls?.length ? longShare(u.calls, p.long_context.above) : undefined;
  return { usd: estimateUsd(usageTokens(u), p, share), basis: 'estimated' };
}

/** The tokens of a seat's requests over a long-context threshold (a usage upload's `long_context`), when it has per-request usage. */
export function longContextOf(u: SeatUsage, above: number): LongSplit | undefined {
  return u.calls?.length ? longContextSplit(u.calls, above).long : undefined;
}

/**
 * A usage-only copy of a Claude Code stream-json transcript: the same line shapes the report
 * exporter reads (model, per-message usage, tool names, errors, final result) with all text,
 * thinking, tool inputs/outputs, paths and session ids removed.
 */
export function slimClaudeTranscript(file: string, sessionFile?: string): string {
  const out: string[] = [];
  // Each request's final usage from the session record (sessionUsage): a session stopped before its result line is
  // then priced from real output counts, not the stream's placeholders.
  const final = sessionUsage(sessionFile);
  for (const o of parseLines(file)) {
    if (o.type === 'system' && o.subtype === 'init') {
      out.push(JSON.stringify({ type: 'system', subtype: 'init', model: o.model, claude_code_version: o.claude_code_version }));
    } else if (o.type === 'assistant' && o.message) {
      const content = (o.message.content ?? []).filter((b: any) => b?.type === 'tool_use').map((b: any) => ({ type: 'tool_use', id: b.id, name: b.name }));
      const rec = o.message.id ? final.get(o.message.id) : undefined;
      const usage = rec && o.message.usage ? { ...rec, output_tokens: Math.max(rec.output_tokens ?? 0, o.message.usage.output_tokens ?? 0) } : o.message.usage;
      out.push(JSON.stringify({ type: 'assistant', message: { id: o.message.id, model: o.message.model, usage, content } }));
    } else if (o.type === 'user' && o.message) {
      const errs = (o.message.content ?? []).filter((b: any) => b?.type === 'tool_result' && b.is_error).map(() => ({ type: 'tool_result', is_error: true }));
      if (errs.length) out.push(JSON.stringify({ type: 'user', message: { content: errs } }));
    } else if (o.type === 'result') {
      const keep = ['type', 'subtype', 'is_error', 'total_cost_usd', 'duration_ms', 'duration_api_ms', 'num_turns', 'usage', 'modelUsage', 'stop_reason', 'terminal_reason'];
      out.push(JSON.stringify(Object.fromEntries(keep.filter((k) => k in o).map((k) => [k, o[k]]))));
    }
  }
  return out.join('\n') + '\n';
}
