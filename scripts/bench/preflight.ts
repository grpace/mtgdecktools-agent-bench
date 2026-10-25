/**
 * Preflight (before the Confirmation step of `bench setup`) and the harness records that show which model and
 * effort really ran.
 *
 *   preflight(...)       start the harness with the chosen model and effort, ask it to reply "ok", read what it
 *                        reports: installed (version), signed in, the model (registry primaryModelFromUsage) and,
 *                        where the harness logs it, the effort level (packages/director/src/effort-detect.ts).
 *   saveEffortRecord()   after a seat's session (bench play) or a preflight: copy the harness's own session record
 *                        next to the transcript, where effort detection reads it: Claude Code session file
 *                        (session-<seat>.jsonl), Codex rollout (rollout-<seat>.jsonl), OpenCode session export
 *                        (opencode-session-<seat>.json). Only the run folder keeps it; bundles copy levels and counts.
 */
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, createWriteStream, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { detectSeatEffort } from '../../packages/director/src/effort-detect.js';
import { extractUsage, usageProblem } from '../../packages/director/src/usage.js';
import { primaryModelFromUsage, registry } from '../../packages/registry/src/index.js';
import { finishSeat, harnessFor, installedVersion, prepareSeat, removeSeatDirs, seatDirs, seatEnv, type HarnessInfo } from './harnesses.js';
import { launchFor } from './models.js';

const PROMPT = 'This is a connection check. Reply with the single word: ok';
const TIMEOUT_MS = 150_000;

export interface PreflightResult {
  harness: string;
  model: string;
  effort: string;
  /** The harness's version line, when installed. */
  version: string | null;
  /** It answered (so it is installed and signed in). */
  ok: boolean;
  signed_in: boolean | null;
  /** The model the harness reported, canonical when the registry knows it. */
  model_reported: string | null;
  /** verified: the reported model is the declared one; mismatch: another one; unreported: the harness didn't say. */
  model_check: 'verified' | 'mismatch' | 'unreported';
  /** The effort level found in the harness's own log, when it logs one. */
  effort_detected: string | null;
  seconds: number;
  /** A short reason when it didn't answer. */
  problem?: string;
  /** Its usage log can't be read as expected (unknown format, no tokens, $0): usage.ts usageProblem (E-8). */
  usage_warning?: string;
}

const lines = (file: string): any[] => {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').flatMap((l) => {
    try {
      return l.trim() ? [JSON.parse(l)] : [];
    } catch {
      return [];
    }
  });
};

/** The newest file under `root` (a few levels deep) whose name passes `test`. */
function findFile(root: string, test: (name: string) => boolean, depth = 5): string | undefined {
  let best: { path: string; mtime: number } | undefined;
  const walk = (d: string, left: number) => {
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(d, e);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (left > 0) walk(p, left - 1);
      } else if (test(e) && (!best || st.mtimeMs > best.mtime)) best = { path: p, mtime: st.mtimeMs };
    }
  };
  walk(root, depth);
  return best?.path;
}

/**
 * Copy the harness's own session record for a finished session into `dir` (see the header). `transcript` is the
 * session's stdout; `cwd` the temp directory it ran in. Best effort: a harness that keeps no record is skipped.
 */
export function saveEffortRecord(harness: string, transcript: string, dir: string, seat: string, seatHome?: string): void {
  try {
    const objs = lines(transcript);
    if (harness === 'claude-code') {
      // The init line names the session; the file is ~/.claude/projects/<cwd as a path slug>/<session>.jsonl.
      const id = [...objs].reverse().find((o) => o?.type === 'system' && o.subtype === 'init' && o.session_id)?.session_id;
      const file = id && findFile(join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects'), (n) => n === `${id}.jsonl`, 1);
      if (file) {
        appendCopy(file, join(dir, `session-${seat}.jsonl`));
        // The project folder belonged to this session's empty temp directory only: remove it.
        if (basename(dirname(file)).includes('mtgdt-')) rmSync(dirname(file), { recursive: true, force: true });
        else rmSync(file, { force: true });
      }
    } else if (harness === 'codex') {
      const id = objs.find((o) => o?.type === 'thread.started' && o.thread_id)?.thread_id;
      // bench play gives Codex a private CODEX_HOME (harnesses.ts): its sessions are there, else in yours.
      const roots = [...(seatHome ? [join(seatHome, 'codex', 'sessions')] : []), join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'sessions')];
      const file = id && roots.map((r) => findFile(r, (n) => n.startsWith('rollout-') && n.includes(id), 4)).find(Boolean);
      if (file) copyFileSync(file, join(dir, `rollout-${seat}.jsonl${file.endsWith('.zst') ? '.zst' : ''}`));
    } else if (harness === 'opencode') {
      const id = objs.map((o) => o?.sessionID ?? o?.part?.sessionID ?? o?.properties?.sessionID).find((x) => typeof x === 'string');
      if (id) {
        const r = spawnSync('opencode', ['session', 'export', id], { encoding: 'utf8', timeout: 60_000 });
        if (r.status === 0 && r.stdout.trim()) writeFileSync(join(dir, `opencode-session-${seat}.json`), r.stdout);
      }
    }
  } catch {
    // a missing record only means the effort can't be detected
  }
}

function appendCopy(from: string, to: string) {
  writeFileSync(to, readFileSync(from), { flag: 'a' });
}

/** Run the harness once with the chosen model and effort; see PreflightResult. */
export async function preflight(h: HarnessInfo, model: string, effort: string, opts: { useApiKey?: boolean; launchModel?: string } = {}): Promise<PreflightResult> {
  const base: PreflightResult = {
    harness: h.id, model, effort, version: installedVersion(h) ?? null, ok: false, signed_in: null, model_reported: null,
    model_check: 'unreported', effort_detected: null, seconds: 0,
  };
  if (!h.preflight) return { ...base, problem: 'no preflight for this harness' };
  if (!base.version) return { ...base, problem: `${h.label} isn't installed here` };
  // The name the seat will launch with (an OpenCode Zen free variant runs as typed), so the check is of that route.
  const spec = launchFor(h.id, model, effort, opts.launchModel);
  const seatDir = seatDirs('preflight');
  const launch = h.preflight(spec.model, spec.args, PROMPT, { useApiKey: opts.useApiKey, ctx: seatDir });
  const cwd = seatDir.work;
  const dir = mkdtempSync(join(tmpdir(), 'mtgdt-preflight-out-'));
  const transcript = join(dir, 'transcript-preflight.jsonl');
  const started = Date.now();
  try {
    prepareSeat(launch, seatDir);
    const childEnv = seatEnv(process.env, launch.env, { harness: h.id, useApiKey: opts.useApiKey });
    let stderr = '';
    const code = await new Promise<number | null>((done) => {
      const out = createWriteStream(transcript);
      const child = spawn(launch.cmd, launch.args, { cwd, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout!.pipe(out);
      child.stderr!.on('data', (b) => (stderr = (stderr + b.toString()).slice(-4000)));
      const timer = setTimeout(() => child.kill('SIGTERM'), TIMEOUT_MS);
      child.on('close', (c) => {
        clearTimeout(timer);
        out.end(() => done(c));
      });
      child.on('error', () => done(127));
    });
    const text = existsSync(transcript) ? readFileSync(transcript, 'utf8') : '';
    const answered = code === 0 && /\bok\b/i.test(text);
    const authProblem = /log ?in|sign ?in|auth|unauthori[sz]ed|credential|api key|401|403/i.test(stderr + (answered ? '' : text.slice(-2000)));
    const usage = extractUsage(transcript, 'preflight', h.id);
    const primary = primaryModelFromUsage({ model_ids: usage.model_ids, model_output_tokens: (usage as { model_output_tokens?: Record<string, number> }).model_output_tokens }, h.id);
    const declared = registry.resolveModel(model, h.id);
    finishSeat(launch, seatDir);
    saveEffortRecord(h.id, transcript, dir, 'preflight', seatDir.home);
    const eff = detectSeatEffort(dir, 'preflight', h.id, transcript);
    // A stream that names the model only for people (Cursor CLI: "GPT-5.6 Luna 272K Medium") or not at all (OpenCode 2's
    // json events) is read through the effort record, which resolves those names (OpenCode: its session record).
    const recorded = eff?.model ? registry.resolveModel(eff.model, h.id) : undefined;
    const reportedId = (primary.listed ? primary.id : null) ?? (recorded?.ok ? recorded.id : null) ?? primary.id;
    const reported = reportedId ?? primary.raw;
    return {
      ...base, ok: answered, signed_in: answered ? true : authProblem ? false : null,
      model_reported: reported ?? null,
      model_check: !reported ? 'unreported' : declared.ok && reportedId === declared.id ? 'verified' : 'mismatch',
      effort_detected: eff?.level ?? null,
      seconds: Math.round((Date.now() - started) / 1000),
      ...(answered && usageProblem(usage) ? { usage_warning: usageProblem(usage)! } : {}),
      ...(answered ? {} : { problem: code === null ? 'no answer within the time limit' : (stderr.trim().split('\n').pop() || `exit ${code}`).slice(0, 200) }),
    };
  } finally {
    removeSeatDirs(seatDir.root);
    rmSync(dir, { recursive: true, force: true });
  }
}

export const preflightable = (harness: string | undefined) => !!harnessFor(harness)?.preflight;
