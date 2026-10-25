/**
 * The reasoning effort a harness actually used, from its own logs (METHODOLOGY §2.1, registry/harnesses.json
 * `effort_detection`). Never copies prompts or text: only levels, counts and versions.
 *
 * Sources, next to the seat's transcript in the run folder (the bench CLI saves them after a seat's session):
 *   session-<seat>.jsonl          Claude Code session file (~/.claude/projects/<cwd>/<session>.jsonl): `effort` on
 *                                 every assistant record, `version`. Tested on Claude Code 2.1.306. (Its stream-json
 *                                 output has no effort field.)
 *   rollout-<seat>.jsonl          Codex rollout file (~/.codex/sessions/…/rollout-*.jsonl): `turn_context` records
 *                                 with the model and effort. Untested (from the Codex docs and source).
 *   opencode-session-<seat>.json  `opencode session export <id>`: `model.variant` per assistant message. Tested on
 *                                 OpenCode 2.1.2.
 *   transcript-<seat>.jsonl       Cursor CLI stream-json: the init line's `model` is a display name with the level
 *                                 ("Gemini 3.8 Flash Low"). Tested on Cursor CLI 2026.10.01.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as zlib from 'node:zlib';
import { registry, type DetectedEffort } from '../../registry/src/index.js';

export interface EffortReport extends DetectedEffort {
  /** Whether this source has been checked against real files (registry/harnesses.json effort_detection). */
  status: 'tested' | 'untested';
  /** Harness version seen in the same file, if any. */
  harness_version?: string;
  /** Model as that source named it (Cursor display names). */
  model?: string;
  /** Cursor: a "Fast" model variant (same model, faster serving). */
  fast?: boolean;
}

function lines(file: string): any[] {
  const out: any[] = [];
  let text: string;
  if (file.endsWith('.zst')) {
    // Codex compresses older rollout files; zlib has zstd from Node 22.15.
    const z = zlib as unknown as { zstdDecompressSync?: (b: Buffer) => Buffer };
    if (!z.zstdDecompressSync) return out;
    text = z.zstdDecompressSync(readFileSync(file)).toString('utf8');
  } else text = readFileSync(file, 'utf8');
  for (const l of text.split('\n')) {
    if (!l.trim()) continue;
    try {
      out.push(JSON.parse(l));
    } catch {
      // partial line
    }
  }
  return out;
}

const tally = (counts: Record<string, number>, raw: unknown) => {
  if (typeof raw !== 'string' || !raw) return;
  const e = registry.normalizeEffort(raw);
  const k = e.ok ? e.effort : raw.toLowerCase().slice(0, 20);
  counts[k] = (counts[k] ?? 0) + 1;
};

const top = (counts: Record<string, number>): string | null =>
  Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null;

/** Claude Code session file: assistant records carry `effort` (and `perTurnEffort`) and `version`. */
export function claudeSessionEffort(file: string): EffortReport {
  const counts: Record<string, number> = {};
  let version: string | undefined;
  for (const o of lines(file)) {
    if (typeof o.version === 'string') version = o.version;
    if (o.type === 'assistant' && !o.isSidechain) tally(counts, o.effort ?? o.perTurnEffort);
  }
  return { level: top(counts), counts, source: 'claude-session', status: 'tested', ...(version ? { harness_version: version } : {}) };
}

/** Codex rollout file: `turn_context` records (payload.effort; older builds: payload.reasoning_effort). Untested. */
export function codexRolloutEffort(file: string): EffortReport {
  const counts: Record<string, number> = {};
  let version: string | undefined;
  let model: string | undefined;
  for (const o of lines(file)) {
    const p = o.payload ?? {};
    if (o.type === 'session_meta' && typeof p.cli_version === 'string') version = p.cli_version;
    if (o.type === 'turn_context') {
      tally(counts, p.effort ?? p.reasoning_effort ?? p.model_reasoning_effort);
      if (typeof p.model === 'string') model = p.model;
    }
  }
  return { level: top(counts), counts, source: 'codex-rollout', status: 'untested', ...(version ? { harness_version: version } : {}), ...(model ? { model } : {}) };
}

/** `opencode session export <id>` JSON: messages[] with type "assistant" and model { id, providerID, variant }. */
export function opencodeSessionEffort(file: string): EffortReport {
  const counts: Record<string, number> = {};
  let model: string | undefined;
  try {
    const d = JSON.parse(readFileSync(file, 'utf8'));
    for (const m of Array.isArray(d?.messages) ? d.messages : []) {
      const info = m?.info ?? m;
      if ((info?.type ?? info?.role) !== 'assistant') continue;
      const mm = info.model ?? {};
      tally(counts, mm.variant ?? info.variant);
      const id = mm.id ?? info.modelID;
      if (typeof id === 'string') model = mm.providerID ?? info.providerID ? `${mm.providerID ?? info.providerID}/${id}` : id;
    }
  } catch {
    // unreadable export
  }
  return { level: top(counts), counts, source: 'opencode-session', status: 'tested', ...(model ? { model } : {}) };
}

const CURSOR_LEVEL = /\s+(extra high|none|minimal|low|medium|high|max)$/i;

/**
 * A Cursor model display name ("Claude Opus 5.5 1M High", "Claude Haiku 5.5  Low No Thinking", "Claude Fable 5.1 1M
 * (NO ZDR)") → model and level. A name without a level is that model's Cursor default (level null).
 */
export function parseCursorModelName(name: string): { model: string; level: string | null; fast: boolean } {
  let s = name.replace(/\(no zdr\)/i, ' ').replace(/\s+/g, ' ').trim();
  const fast = /\sfast$/i.test(s);
  if (fast) s = s.replace(/\sfast$/i, '');
  let level: string | null = null;
  if (/\sno thinking$/i.test(s)) {
    s = s.replace(/\sno thinking$/i, '');
    s = s.replace(CURSOR_LEVEL, '');
    level = 'none'; // thinking off
  } else {
    const m = CURSOR_LEVEL.exec(s);
    if (m) {
      level = m[1]!.toLowerCase() === 'extra high' ? 'xhigh' : m[1]!.toLowerCase();
      s = s.slice(0, m.index);
    }
  }
  // The context size Cursor names some variants with ("GPT-5.6 Luna 1M", "GPT-5.6 Luna 272K Low" in the CLI's stream).
  s = s.replace(/\s+\d+(?:\.\d+)?[km]$/i, '').replace(/\s+thinking$/i, '').trim();
  return { model: s, level, fast };
}

/**
 * A Cursor model slug ("grok-4.7-xhigh-fast", "claude-opus-5-5-high", "claude-haiku-5-5-thinking-low") → model, level
 * and fast mode. A slug the registry lists as a Cursor launch string ("cursor-grok-4.6-high", "gpt-5.5-extra-high")
 * gives its canonical model id and level; otherwise the level is read off the end, and a slug without one is that
 * model's Cursor default (level from the registry, else null).
 */
export function parseCursorSlug(slug: string): { model: string; level: string | null; fast: boolean } {
  let s = slug.trim().toLowerCase();
  const fast = s.endsWith('-fast');
  if (fast) s = s.slice(0, -5);
  const known = registry.resolveModel(s, 'cursor');
  if (known.ok && known.via === 'launch' && known.effortHint) return { model: known.id, level: known.effortHint, fast };
  let level: string | null = null;
  const m = /-(none|minimal|low|medium|high|xhigh|extra-high|max)$/.exec(s);
  if (m) {
    level = m[1] === 'extra-high' ? 'xhigh' : m[1]!;
    s = s.slice(0, m.index);
  }
  s = s.replace(/-thinking$/, '');
  if (!level) {
    const r = registry.resolveModel(s, 'cursor');
    level = r.ok ? registry.harnessDefaultEffort('cursor', r.id)?.level ?? null : null;
  }
  return { model: s, level, fast };
}

/** Cursor CLI stream-json transcript: the init line's model display name. */
export function cursorTranscriptEffort(file: string): EffortReport {
  for (const o of lines(file)) {
    if (o.type === 'system' && o.subtype === 'init' && typeof o.model === 'string') {
      const p = parseCursorModelName(o.model);
      // A name without a level is that model's default variant in Cursor's model list (registry effort_defaults).
      const m = registry.resolveModel(p.model, 'cursor');
      const level = p.level ?? (m.ok ? registry.harnessDefaultEffort('cursor', m.id)?.level ?? null : null);
      return { level, counts: level ? { [level]: 1 } : {}, source: 'cursor-model-name', status: 'tested', model: m.ok ? m.id : p.model, ...(p.fast ? { fast: true } : {}) };
    }
  }
  return { level: null, source: 'cursor-model-name', status: 'tested' };
}

/** The effort a seat's harness reported, from whichever source its run folder has; null when none. */
export function detectSeatEffort(dir: string, seat: string, harness: string | undefined, transcriptPath?: string): EffortReport | null {
  const h = harness ? registry.resolveHarness(harness) : undefined;
  // A launched seat (t3-code:claude-code) is its harness: detected through the harness's own records.
  const id = h?.ok ? h.id : undefined;
  const at = (f: string) => (existsSync(join(dir, f)) ? join(dir, f) : undefined);
  // `bench attach-logs` (harness-logs.ts) found the seat's session on this machine: facts only.
  const logs = at(`harness-logs-${seat}.json`);
  if (logs) {
    try {
      const r = JSON.parse(readFileSync(logs, 'utf8'));
      const e = r?.effort_reported;
      if (e && typeof e.source === 'string') {
        return {
          level: typeof e.level === 'string' ? e.level : null, counts: e.counts ?? {}, source: e.source, status: e.status === 'tested' ? 'tested' : 'untested',
          ...(typeof r.harness_version === 'string' ? { harness_version: r.harness_version } : {}), ...(e.fast ? { fast: true } : {}),
        };
      }
    } catch {
      // unreadable: fall through to the other sources
    }
  }
  const claude = at(`session-${seat}.jsonl`);
  if (claude && (!id || id === 'claude-code')) return claudeSessionEffort(claude);
  const codex = at(`rollout-${seat}.jsonl`) ?? at(`rollout-${seat}.jsonl.zst`);
  if (codex && (!id || id === 'codex')) return codexRolloutEffort(codex);
  const oc = at(`opencode-session-${seat}.json`);
  if (oc && (!id || id === 'opencode')) return opencodeSessionEffort(oc);
  const tr = transcriptPath ?? at(`transcript-${seat}.jsonl`);
  if (id === 'cursor' && tr && existsSync(tr)) return cursorTranscriptEffort(tr);
  return null;
}
