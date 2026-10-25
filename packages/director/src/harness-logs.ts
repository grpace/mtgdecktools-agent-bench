/**
 * Find a hand-seated seat's harness session on this machine and extract what it used (METHODOLOGY §2.2): model,
 * effort, fast mode, harness version and token counts. Nothing else: these stores hold the user's other
 * conversations, so no text, path or title ever leaves this module.
 *
 *   attachHarnessLogs(runDir, { seats? })  scan, then write harness-logs-<seat>.json (mode 600) into the run folder;
 *                                          `bench attach-logs <event>` calls it, and bundles read the result
 *   findSeatSessions(runDir, seat)         the same for one seat, without writing
 *
 * Matching: agents never see event or seat names, so a session is matched by content (`judge`). From events.jsonl we
 * take up to 32 lines of the decision texts this seat (and no other seat) was shown, spread over the event. A session
 * is this seat's when:
 *   - at least a quarter of them (3 or more) appear in it verbatim;
 *   - where the session is one ordered text (Claude Code, Codex, T3 Code, OpenCode messages), they appear in the order
 *     the seat was shown them (80% of them, allowing a re-read);
 *   - it holds no other seat's lines (2 or more of another seat's is a supervising session that read the event log,
 *     or one that played several seats) and no other event's (`otherEvents`: nearby events in the same runs folder).
 * Sessions set aside are listed in `rejected` (store, ref and reason only) instead of being merged.
 * Only sessions active since the event started are read.
 *
 * Stores (registry/harnesses.json effort_detection says which are tested):
 *   Claude Code   $CLAUDE_CONFIG_DIR/projects, ~/.claude/projects, ~/.claude-accounts/<account>/projects (*.jsonl)
 *   Codex         $CODEX_HOME/sessions, ~/.codex/sessions (rollout-*.jsonl[.zst]; untested)
 *   OpenCode      $XDG_DATA_HOME/opencode/opencode.db or ~/.local/share/opencode/opencode.db (session_v2, session_message)
 *   Antigravity   ~/.t3/userdata/providers/antigravity/<hash>/antigravity-acp/conversations/*.db,
 *                 ~/.gemini/antigravity-cli/conversations/*.db (standalone: untested)
 *   Cursor SDK    ~/.cursor/projects/<project>/sdk-agent-store/<hash>/agents/<agent>/store.db
 *   T3 Code       ~/.t3/userdata/logs/provider/events.*.log (the model and effort each provider session opened with)
 * SQLite stores: a snapshot with `VACUUM INTO` from a read-only connection (consistent while the harness writes; a
 * copy of the file and its -wal together when the live file can't be opened read-only), into a private folder under
 * ~/.cache/mtgdt-bench/scan (0700), opened read-only, and deleted after, also on Ctrl-C or SIGTERM. Stores larger
 * than `maxDbBytes` (256 MB) are skipped. Strings taken from the stores (model ids, versions) are kept only when
 * they look like ids (`cleanId`), never like paths.
 *
 * Provenance (METHODOLOGY §2.2): what this writes was read from the contributor's own machine by the contributor's
 * CLI. It is self-attested evidence (`provenance.self_attested`), weaker than anything the Director observes itself.
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, type Stats } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { registry, type DetectedEffort } from '../../registry/src/index.js';
import { claudeSessionEffort, codexRolloutEffort, parseCursorSlug } from './effort-detect.js';

export type StoreKind = 'claude-session' | 'codex-rollout' | 'opencode-db' | 'antigravity-db' | 'cursor-sdk-store' | 't3-log';

/** A session that held this seat's lines but was set aside: facts only, never text or paths. */
export interface Rejected {
  store: StoreKind;
  ref: string;
  reason: 'other seats' | 'another event' | 'out of order' | 'too large';
}

/** One matched session: facts only. `ref` is a short hash of the store path and session id, never the path itself. */
export interface SessionFact {
  store: StoreKind;
  ref: string;
  matched: number;
  model?: string;
  effort?: DetectedEffort;
  harness_version?: string;
  tokens?: { input?: number; output?: number; reasoning?: number; cache_read?: number };
  /** Output tokens per model (Claude session files). */
  model_output_tokens?: Record<string, number>;
}

export interface SeatLogs {
  seat: string;
  event_id: string;
  scanned_at: string;
  snippets: number;
  facts: SessionFact[];
  /** The summary bundles and the export use (same shape as usage-<seat>.json). */
  model_ids: string[];
  model_output_tokens?: Record<string, number>;
  harness_version?: string;
  effort_reported?: DetectedEffort & { status: 'tested' | 'untested' };
  /** matched: sessions found; ambiguous: only sessions that also hold other seats' or events' text; none. */
  status: 'matched' | 'ambiguous' | 'none';
  rejected: Rejected[];
  /** Lines sampled for this seat, and how many a session needs. */
  match: { sampled: number; need: number };
  /** Where these facts come from: the contributor's CLI reading this machine's logs (self-attested). */
  provenance: { kind: 'cli-local-logs'; read_by: string; self_attested: true; stores: StoreKind[] };
}

export interface ScanOptions {
  home?: string;
  env?: NodeJS.ProcessEnv;
  /** How long before the event's start a session may have begun (default 2 h). */
  slackMs?: number;
  /** Skip files larger than this (default 200 MB: read whole, and well under V8's string limit). */
  maxBytes?: number;
  /** Skip SQLite stores larger than this, file plus -wal (default 256 MB). */
  maxDbBytes?: number;
  /** Run folders of other events: a session holding their decision text isn't this seat's. */
  otherEvents?: string[];
  /** Who read the logs, for `provenance` (e.g. "bench attach-logs 0.1.0"). */
  readBy?: string;
}

const ref = (...parts: string[]) => createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 12);

function readLog(runDir: string): any[] {
  const out: any[] = [];
  let text = '';
  try {
    text = readFileSync(join(runDir, 'events.jsonl'), 'utf8');
  } catch {
    return out;
  }
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

/**
 * Lines of the decision texts only this seat was shown: ASCII, 30+ characters, no quotes or backslashes (so they
 * appear byte for byte inside JSON and SQLite text), spread over the event. At most `max`.
 */
export function seatSnippets(events: any[], seat: string, max = 32): string[] {
  const linesOf = (s: string) => events.filter((e) => e.type === 'decision_offered' && e.seat === s && typeof e.text === 'string').flatMap((e) => (e.text as string).split('\n'));
  const others = new Set(events.filter((e) => e.type === 'decision_offered' && e.seat !== seat && typeof e.text === 'string').flatMap((e) => (e.text as string).split('\n').map((l) => l.trim())));
  const seen = new Set<string>();
  const pool: string[] = [];
  for (const raw of linesOf(seat)) {
    const l = raw.trim();
    if (l.length < 30 || !/^[\x20-\x7e]+$/.test(l) || /["\\]/.test(l) || others.has(l) || seen.has(l)) continue;
    seen.add(l);
    pool.push(l.slice(0, 120));
  }
  if (pool.length <= max) return pool;
  return Array.from({ length: max }, (_, i) => pool[Math.floor((i * pool.length) / max)]!);
}

/** Every line ≥ 30 characters a decision text of this event showed (for telling events apart). */
const decisionLines = (events: any[]) => new Set(events.filter((e) => e.type === 'decision_offered' && typeof e.text === 'string')
  .flatMap((e) => (e.text as string).split('\n').map((l) => l.trim().slice(0, 120))).filter((l) => l.length >= 30));

/** Lines of another event's decision texts that this event never showed, at most `max`, spread over it. */
function otherEventSnippets(other: any[], mine: Set<string>, max = 32): string[] {
  const pool = [...decisionLines(other)].filter((l) => /^[\x20-\x7e]+$/.test(l) && !/["\\]/.test(l) && !mine.has(l));
  if (pool.length <= max) return pool;
  return Array.from({ length: max }, (_, i) => pool[Math.floor((i * pool.length) / max)]!);
}

/** How many of a seat's sampled lines a session must hold (see the header). */
export const needFor = (sampled: number) => (sampled < 3 ? Infinity : Math.max(3, Math.ceil(sampled / 4)));

/** The longest run of positions in increasing order (how much of the session follows the seat's order). */
function longestIncreasing(xs: number[]): number {
  const tails: number[] = [];
  for (const x of xs) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (tails[mid]! < x) lo = mid + 1;
      else hi = mid;
    }
    tails[lo] = x;
  }
  return tails.length;
}

export interface Matcher {
  seat: string;
  mine: string[];
  need: number;
  /** Other seats of this event: their sampled lines. */
  others: Array<{ seat: string; lines: string[] }>;
  /** Other events: their sampled lines. */
  events: string[][];
}

export function buildMatcher(events: any[], seat: string, otherEvents: any[][] = []): Matcher {
  const seats = [...new Set(events.filter((e) => e.type === 'decision_offered' && typeof e.seat === 'string').map((e) => e.seat as string))];
  const mine = seatSnippets(events, seat);
  const lines = decisionLines(events);
  return {
    seat, mine, need: needFor(mine.length),
    others: seats.filter((x) => x !== seat).map((x) => ({ seat: x, lines: seatSnippets(events, x) })),
    events: otherEvents.map((o) => otherEventSnippets(o, lines)).filter((l) => l.length > 0),
  };
}

export type Verdict = { ok: true; hits: number } | { ok: false; reason: Rejected['reason'] } | null;

/**
 * Whether one session (its text; `ordered`: one text in the order things happened) is this seat's: null when it
 * doesn't hold enough of the seat's lines, else matched, or set aside with a reason.
 */
export function judge(m: Matcher, hay: string, ordered: boolean): Verdict {
  const pos = m.mine.map((s) => hay.indexOf(s)).filter((p) => p >= 0);
  if (pos.length < m.need) return null;
  if (m.others.some((o) => o.lines.filter((s) => hay.includes(s)).length >= 2)) return { ok: false, reason: 'other seats' };
  if (m.events.some((lines) => lines.filter((s) => hay.includes(s)).length >= 2)) return { ok: false, reason: 'another event' };
  if (ordered && longestIncreasing(pos) < Math.max(m.need, Math.ceil(pos.length * 0.8))) return { ok: false, reason: 'out of order' };
  return { ok: true, hits: pos.length };
}

/** A string from a store that names a model or a version: an id, never a path or free text. */
export function cleanId(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  if (!/^[A-Za-z0-9._:@+/-]{1,80}$/.test(t) || /^[./~]|\/\/|\/(Users|home|root|tmp|var|private|mnt|opt)\//i.test(t) || /\.(gguf|bin|safetensors)$/i.test(t)) return undefined;
  return t;
}

const statOf = (f: string): Stats | undefined => {
  try {
    return statSync(f);
  } catch {
    return undefined; // deleted while scanning
  }
};

function walk(dir: string, accept: (name: string) => boolean, depth = 6, out: string[] = []): string[] {
  if (depth < 0 || !existsSync(dir)) return out;
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, accept, depth - 1, out);
    else if (e.isFile() && accept(e.name)) out.push(p);
  }
  return out;
}

/** Folders in `dir`, following symlinks (a ~/.claude-accounts/<name> is often a link to another disk). */
const subdirs = (dir: string) => {
  try {
    return readdirSync(dir).map((n) => join(dir, n)).filter((p) => statOf(p)?.isDirectory());
  } catch {
    return [];
  }
};

// ---------------------------------------------------------------------------
// SQLite snapshots (see the header)

const scratch = new Set<string>();
const dropScratch = () => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
  scratch.clear();
};

/** Run a scan with its temporary snapshots removed however it ends: normally, by an error, Ctrl-C or SIGTERM. */
function withCleanup<T>(f: () => T): T {
  const onSignal = (sig: NodeJS.Signals) => {
    dropScratch();
    process.exit(sig === 'SIGINT' ? 130 : 143);
  };
  process.on('exit', dropScratch);
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  try {
    return f();
  } finally {
    dropScratch();
    process.off('exit', dropScratch);
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
}

/** ~/.cache/mtgdt-bench/scan (0700); snapshots a crash left behind more than an hour ago are removed. */
function scratchRoot(o: Required<Pick<ScanOptions, 'home' | 'env'>>): string {
  const root = join(o.env.XDG_CACHE_HOME || join(o.home, '.cache'), 'mtgdt-bench', 'scan');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  for (const d of readdirSync(root)) {
    const st = statOf(join(root, d));
    if (st && Date.now() - st.mtimeMs > 3600_000) rmSync(join(root, d), { recursive: true, force: true });
  }
  return root;
}

type DbResult<T> = { value: T | undefined } | { tooLarge: true };

/** A read-only snapshot of a SQLite store (see the header): run `f` on it, then delete it. */
function withDb<T>(o: Required<Pick<ScanOptions, 'home' | 'env'>>, file: string, maxDbBytes: number, f: (db: import('node:sqlite').DatabaseSync) => T): DbResult<T> {
  const size = (statOf(file)?.size ?? 0) + (statOf(file + '-wal')?.size ?? 0);
  if (size > maxDbBytes) return { tooLarge: true };
  let dir: string | undefined;
  try {
    // node:sqlite (Node 22.5+): loaded lazily so the Director runs where it's unavailable.
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
    dir = mkdtempSync(join(scratchRoot(o), 'db-'));
    scratch.add(dir);
    const snap = join(dir, 'snapshot.sqlite');
    try {
      const live = new DatabaseSync(file, { readOnly: true });
      try {
        live.exec(`VACUUM INTO '${snap.replace(/'/g, "''")}'`);
      } finally {
        live.close();
      }
    } catch {
      // The live file can't be opened read-only here: copy it with its WAL, together.
      rmSync(snap, { force: true });
      copyFileSync(file, snap);
      if (existsSync(file + '-wal')) copyFileSync(file + '-wal', snap + '-wal');
    }
    const db = new DatabaseSync(snap, { readOnly: true });
    try {
      return { value: f(db) };
    } finally {
      db.close();
    }
  } catch {
    return { value: undefined };
  } finally {
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
      scratch.delete(dir);
    }
  }
}

const tally = (counts: Record<string, number>, raw: unknown) => {
  if (typeof raw !== 'string' || !raw) return;
  const e = registry.normalizeEffort(raw);
  const k = e.ok ? e.effort : cleanId(raw.toLowerCase().slice(0, 20));
  if (k) counts[k] = (counts[k] ?? 0) + 1;
};
const top = (counts: Record<string, number>) => Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null;

// ---------------------------------------------------------------------------
// Per store

type O = Required<Pick<ScanOptions, 'home' | 'env'>>;
interface Ctx {
  m: Matcher;
  since: number;
  maxBytes: number;
  maxDbBytes: number;
  rejected: Rejected[];
}

/** Judge one session; record a rejection. True when it is this seat's (then `hits` is set). */
function accept(c: Ctx, store: StoreKind, r: string, hay: string, ordered: boolean): number | undefined {
  const v = judge(c.m, hay, ordered);
  if (!v) return undefined;
  if (!v.ok) {
    c.rejected.push({ store, ref: r, reason: v.reason });
    return undefined;
  }
  return v.hits;
}

/** A text file worth reading: changed since the event started and not too big to read whole. */
const readable = (f: string, c: Ctx) => {
  const st = statOf(f);
  return !!st && st.mtimeMs >= c.since && st.size <= c.maxBytes;
};

const readText = (f: string) => {
  try {
    return readFileSync(f, 'utf8');
  } catch {
    return undefined;
  }
};

function claudeSessions(o: O, c: Ctx): SessionFact[] {
  const roots = [o.env.CLAUDE_CONFIG_DIR && join(o.env.CLAUDE_CONFIG_DIR, 'projects'), join(o.home, '.claude', 'projects'), ...subdirs(join(o.home, '.claude-accounts')).map((d) => join(d, 'projects'))]
    .filter((d): d is string => !!d);
  const facts: SessionFact[] = [];
  const seen = new Set<string>();
  for (const root of [...new Set(roots)]) {
    for (const f of walk(root, (n) => n.endsWith('.jsonl'), 3)) {
      if (seen.has(basename(f)) || !readable(f, c)) continue;
      const text = readText(f);
      if (text === undefined) continue;
      const hits = accept(c, 'claude-session', ref(f), text, true);
      if (hits === undefined) continue;
      seen.add(basename(f));
      const e = claudeSessionEffort(f);
      const perModel: Record<string, number> = {};
      for (const line of text.split('\n')) {
        if (!line.includes('"assistant"')) continue;
        try {
          const r = JSON.parse(line);
          const model = cleanId(r.message?.model);
          if (r.type === 'assistant' && !r.isSidechain && model) perModel[model] = (perModel[model] ?? 0) + (Number(r.message?.usage?.output_tokens) || 0);
        } catch {
          // partial line
        }
      }
      const model = top(perModel);
      const version = cleanId(e.harness_version);
      facts.push({
        store: 'claude-session', ref: ref(f), matched: hits, ...(model ? { model } : {}), model_output_tokens: perModel,
        effort: { level: e.level, counts: e.counts ?? {}, source: 'claude-session' }, ...(version ? { harness_version: version } : {}),
      });
    }
  }
  return facts;
}

function codexRollouts(o: O, c: Ctx): SessionFact[] {
  const roots = [o.env.CODEX_HOME && join(o.env.CODEX_HOME, 'sessions'), join(o.home, '.codex', 'sessions')].filter((d): d is string => !!d);
  const facts: SessionFact[] = [];
  for (const root of [...new Set(roots)]) {
    for (const f of walk(root, (n) => /^rollout-.*\.jsonl$/.test(n), 4)) {
      if (!readable(f, c)) continue;
      const text = readText(f);
      if (text === undefined) continue;
      const hits = accept(c, 'codex-rollout', ref(f), text, true);
      if (hits === undefined) continue;
      const e = codexRolloutEffort(f);
      const model = cleanId(e.model);
      const version = cleanId(e.harness_version);
      facts.push({
        store: 'codex-rollout', ref: ref(f), matched: hits, ...(model ? { model } : {}),
        effort: { level: e.level, counts: e.counts ?? {}, source: 'codex-rollout' }, ...(version ? { harness_version: version } : {}),
      });
    }
  }
  return facts;
}

/** A SQLite store changed since the event started (the file or its WAL). */
const dbChanged = (f: string, since: number) => (statOf(f)?.mtimeMs ?? 0) >= since || (statOf(f + '-wal')?.mtimeMs ?? 0) >= since;

function opencodeDb(o: O, c: Ctx): SessionFact[] {
  const files = [o.env.XDG_DATA_HOME && join(o.env.XDG_DATA_HOME, 'opencode', 'opencode.db'), join(o.home, '.local', 'share', 'opencode', 'opencode.db')]
    .filter((f): f is string => !!f && existsSync(f));
  const facts: SessionFact[] = [];
  for (const file of [...new Set(files)]) {
    if (!dbChanged(file, c.since)) continue;
    const found = withDb(o, file, c.maxDbBytes, (db) => {
      const tables = new Set((db.prepare("select name from sqlite_master where type='table'").all() as Array<{ name: string }>).map((r) => r.name));
      const out: SessionFact[] = [];
      // Candidate sessions: any that holds one of this seat's lines. Each is then judged on its messages in order.
      const candidates = new Set<string>();
      const msgTable = tables.has('session_message') ? 'session_message' : tables.has('part') ? 'part' : undefined;
      if (!msgTable) return out;
      for (const sn of c.m.mine) {
        for (const r of db.prepare(`select distinct session_id as sid from ${msgTable} where instr(data, ?) > 0 and time_updated >= ?`).all(sn, c.since) as Array<{ sid: string }>) candidates.add(r.sid);
      }
      for (const sid of candidates) {
        const rows = db.prepare(`select data from ${msgTable} where session_id = ? order by time_created, rowid`).all(sid) as Array<{ data: unknown }>;
        const hay = rows.map((r) => String(r.data ?? '')).join('\n');
        const hits = accept(c, 'opencode-db', ref(file, sid), hay, true);
        if (hits === undefined) continue;
        const counts: Record<string, number> = {};
        let model: string | undefined;
        let version: string | undefined;
        let tokens: SessionFact['tokens'];
        if (tables.has('session_v2')) {
          const s = db.prepare('select model, version, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read from session_v2 where id = ?').get(sid) as Record<string, unknown> | undefined;
          if (s) {
            try {
              const m = JSON.parse(String(s.model ?? '{}'));
              if (m?.id) model = cleanId(m.providerID ? `${m.providerID}/${m.id}` : m.id);
            } catch {
              // not JSON
            }
            version = cleanId(s.version);
            tokens = { input: Number(s.tokens_input) || 0, output: Number(s.tokens_output) || 0, reasoning: Number(s.tokens_reasoning) || 0, cache_read: Number(s.tokens_cache_read) || 0 };
          }
          for (const r of db.prepare("select json_extract(data, '$.model.variant') as v, json_extract(data, '$.model.id') as id, json_extract(data, '$.model.providerID') as p from session_message where session_id = ? and type = 'assistant'").all(sid) as Array<{ v: unknown; id: unknown; p: unknown }>) {
            tally(counts, r.v);
            if (typeof r.id === 'string') model = cleanId(typeof r.p === 'string' ? `${r.p}/${r.id}` : r.id) ?? model;
          }
        }
        if (!Object.keys(counts).length && tables.has('message')) {
          for (const r of db.prepare("select json_extract(data, '$.variant') as v, json_extract(data, '$.modelID') as id, json_extract(data, '$.providerID') as p from message where session_id = ? and json_extract(data, '$.role') = 'assistant'").all(sid) as Array<{ v: unknown; id: unknown; p: unknown }>) {
            tally(counts, r.v);
            if (typeof r.id === 'string') model = cleanId(typeof r.p === 'string' ? `${r.p}/${r.id}` : r.id) ?? model;
          }
        }
        out.push({
          store: 'opencode-db', ref: ref(file, sid), matched: hits, ...(model ? { model } : {}), ...(version ? { harness_version: version } : {}), ...(tokens ? { tokens } : {}),
          effort: { level: top(counts), counts, source: 'opencode-db' },
        });
      }
      return out;
    });
    if ('tooLarge' in found) c.rejected.push({ store: 'opencode-db', ref: ref(file), reason: 'too large' });
    else facts.push(...(found.value ?? []));
  }
  return facts;
}

/** Every text and blob value of a table, as one string (latin1, so binary blobs keep their ASCII runs). */
const blobsOf = (db: import('node:sqlite').DatabaseSync, table: string): string[] => {
  if (!/^\w+$/.test(table)) return [];
  const cols = (db.prepare(`pragma table_info("${table}")`).all() as Array<{ name: string; type: string }>).filter((c) => /blob|text/i.test(c.type)).map((c) => c.name);
  const out: string[] = [];
  for (const r of db.prepare(`select ${cols.map((c) => `"${c.replace(/"/g, '""')}"`).join(', ') || '*'} from "${table}"`).all() as Array<Record<string, unknown>>) {
    for (const v of Object.values(r)) if (v instanceof Uint8Array) out.push(Buffer.from(v).toString('latin1'));
    else if (typeof v === 'string') out.push(v);
  }
  return out;
};

/** Model ids with a level suffix in Antigravity blobs: registry names first, then any gemini/claude/gpt id. */
function antigravityModels(text: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const m of text.matchAll(/((?:gemini|claude|gpt)-[a-z0-9.]+(?:-[a-z0-9.]+)*?)-(low|medium|high)/g)) counts[`${m[1]}-${m[2]}`] = (counts[`${m[1]}-${m[2]}`] ?? 0) + 1;
  return counts;
}

function antigravityDbs(o: O, c: Ctx): SessionFact[] {
  const dirs = [
    ...subdirs(join(o.home, '.t3', 'userdata', 'providers', 'antigravity')).map((d) => join(d, 'antigravity-acp', 'conversations')),
    join(o.home, '.gemini', 'antigravity-cli', 'conversations'),
  ];
  const facts: SessionFact[] = [];
  for (const dir of dirs) {
    for (const f of walk(dir, (n) => n.endsWith('.db'), 0)) {
      if (!dbChanged(f, c.since)) continue;
      const r = withDb(o, f, c.maxDbBytes, (db) => {
        const tables = (db.prepare("select name from sqlite_master where type='table'").all() as Array<{ name: string }>).map((x) => x.name);
        // One conversation per file; rows aren't in a known order, so order isn't checked.
        const hay = tables.flatMap((t) => blobsOf(db, t)).join('\n');
        const hits = accept(c, 'antigravity-db', ref(f), hay, false);
        if (hits === undefined) return undefined;
        const ids = antigravityModels(hay);
        const best = Object.entries(ids).sort((a, b) => b[1] - a[1])[0]?.[0];
        const lv = best ? /-(low|medium|high)$/.exec(best)![1]! : null;
        const counts: Record<string, number> = {};
        for (const [id, n] of Object.entries(ids)) if (best && id.replace(/-(low|medium|high)$/, '') === best.replace(/-(low|medium|high)$/, '')) counts[/-(low|medium|high)$/.exec(id)![1]!] = (counts[/-(low|medium|high)$/.exec(id)![1]!] ?? 0) + n;
        const model = cleanId(best);
        return { store: 'antigravity-db', ref: ref(f), matched: hits, ...(model ? { model } : {}), effort: { level: lv, counts, source: 'antigravity-db' } } as SessionFact;
      });
      if ('tooLarge' in r) c.rejected.push({ store: 'antigravity-db', ref: ref(f), reason: 'too large' });
      else if (r.value) facts.push(r.value);
    }
  }
  return facts;
}

function cursorStores(o: O, c: Ctx): SessionFact[] {
  const facts: SessionFact[] = [];
  for (const proj of subdirs(join(o.home, '.cursor', 'projects'))) {
    for (const f of walk(join(proj, 'sdk-agent-store'), (n) => n === 'store.db', 4)) {
      if (!dbChanged(f, c.since)) continue;
      const r = withDb(o, f, c.maxDbBytes, (db) => {
        const hay = blobsOf(db, 'blobs').join('\n');
        const hits = accept(c, 'cursor-sdk-store', ref(f), hay, false);
        if (hits === undefined) return undefined;
        const names: Record<string, number> = {};
        for (const m of hay.matchAll(/"modelName":"([a-z0-9][a-z0-9.-]{1,80})"/g)) names[m[1]!] = (names[m[1]!] ?? 0) + 1;
        const slug = Object.entries(names).sort((a, b) => b[1] - a[1])[0]?.[0];
        const p = slug ? parseCursorSlug(slug) : undefined;
        const model = cleanId(p?.model);
        return {
          store: 'cursor-sdk-store', ref: ref(f), matched: hits, ...(model ? { model } : {}),
          effort: { level: p?.level ?? null, counts: p?.level ? { [p.level]: 1 } : {}, source: 'cursor-sdk-store', ...(p?.fast ? { fast: true } : {}) },
        } as SessionFact;
      });
      if ('tooLarge' in r) c.rejected.push({ store: 'cursor-sdk-store', ref: ref(f), reason: 'too large' });
      else if (r.value) facts.push(r.value);
    }
  }
  return facts;
}

/** T3 Code provider logs: threads whose payloads contain the snippets, and the model/effort they opened with. */
function t3Logs(o: O, c: Ctx): SessionFact[] {
  const dir = join(o.home, '.t3', 'userdata', 'logs', 'provider');
  const facts: SessionFact[] = [];
  for (const f of walk(dir, (n) => /^events\..+\.log(\.\d+)?$/.test(n), 0)) {
    if (!readable(f, c)) continue;
    const text = readText(f);
    if (text === undefined) continue;
    const lines = text.split('\n');
    const threadOf = (l: string) => /:thread:([0-9a-f-]{36})/.exec(l)?.[1];
    // Candidate threads: any line holding one of this seat's lines; each is judged on its own lines, in order.
    const candidates = new Set<string>();
    for (const l of lines) if (c.m.mine.some((s) => l.includes(s))) {
      const t = threadOf(l);
      if (t) candidates.add(t);
    }
    for (const thread of candidates) {
      const own = lines.filter((l) => threadOf(l) === thread);
      const hits = accept(c, 't3-log', ref(f, thread), own.join('\n'), true);
      if (hits === undefined) continue;
      let model: string | undefined;
      const counts: Record<string, number> = {};
      let fast: boolean | undefined;
      let version: string | undefined;
      const tokens = { output: 0, reasoning: 0 };
      for (const l of own) {
        const j = l.indexOf('{');
        if (j < 0) continue;
        let rec: any;
        try {
          rec = JSON.parse(l.slice(j));
        } catch {
          continue;
        }
        const pl = rec?.event?.payload;
        if (!pl || typeof pl !== 'object') continue;
        const opt = pl.options ?? pl.params ?? {};
        // claudeAgent query.open: options.model, options.effort
        if (typeof opt.model === 'string') model = cleanId(opt.model) ?? model;
        if (typeof opt.effort === 'string') tally(counts, opt.effort);
        // cursor run.start / agent.open: options.model { id, params: [{ id: reasoning_effort | reasoning | effort | fast, value }] }
        // (the level's parameter name depends on the model: reasoning_effort for Grok 4.7 and Gemini, reasoning for GPT,
        // Kimi and GLM, effort for Grok 4.6/4.5 and some Claude models, in T3 Code's Cursor model options)
        if (opt.model && typeof opt.model === 'object' && typeof opt.model.id === 'string') {
          model = cleanId(opt.model.id) ?? model;
          for (const p of Array.isArray(opt.model.params) ? opt.model.params : []) {
            if (p?.id === 'reasoning_effort' || p?.id === 'reasoning' || p?.id === 'effort') tally(counts, String(p.value));
            if (p?.id === 'fast') fast = String(p.value) === 'true';
          }
        }
        // opencode session.updated: model { id, providerID, variant }, version
        const m = pl.properties?.info?.model ?? pl.info?.model ?? (pl.type === 'session.updated' ? pl.model : undefined);
        if (m && typeof m === 'object' && typeof m.id === 'string') {
          model = cleanId(m.providerID ? `${m.providerID}/${m.id}` : m.id) ?? model;
          if (typeof m.variant === 'string') tally(counts, m.variant);
        }
        const v = cleanId(pl.properties?.info?.version ?? pl.info?.version);
        if (v) version = v;
        const u = pl.update?.usage ?? pl.usage;
        if (pl.update?.type === 'turn-ended' && u) {
          tokens.output += Number(u.outputTokens) || 0;
          tokens.reasoning += Number(u.reasoningTokens) || 0;
        }
      }
      facts.push({
        store: 't3-log', ref: ref(f, thread), matched: hits, ...(model ? { model } : {}), ...(version ? { harness_version: version } : {}),
        ...(tokens.output || tokens.reasoning ? { tokens } : {}),
        effort: { level: top(counts), counts, source: 't3-log', ...(fast ? { fast: true } : {}) },
      });
    }
  }
  return facts;
}

// ---------------------------------------------------------------------------

const ENGINE_FIRST: StoreKind[] = ['claude-session', 'codex-rollout', 'opencode-db', 'cursor-sdk-store', 'antigravity-db', 't3-log'];
const TESTED: Record<StoreKind, boolean> = { 'claude-session': true, 'codex-rollout': false, 'opencode-db': true, 'cursor-sdk-store': true, 'antigravity-db': true, 't3-log': true };

/** Scan this machine's harness stores for one seat's session(s). */
export function findSeatSessions(runDir: string, seat: string, opts: ScanOptions = {}): SeatLogs {
  const events = readLog(runDir);
  const start = events.find((e) => e.type === 'event_start');
  const t0 = typeof start?.t === 'number' ? start.t : 0;
  const o = { home: opts.home ?? homedir(), env: opts.env ?? process.env };
  const m = buildMatcher(events, seat, (opts.otherEvents ?? []).filter((d) => d !== runDir).map(readLog));
  const c: Ctx = {
    m, since: t0 - (opts.slackMs ?? 2 * 3600_000), maxBytes: opts.maxBytes ?? 200 * 1024 * 1024, maxDbBytes: opts.maxDbBytes ?? 256 * 1024 * 1024, rejected: [],
  };
  const facts = m.mine.length < 3 ? [] : withCleanup(() => [
    ...claudeSessions(o, c), ...codexRollouts(o, c), ...opencodeDb(o, c), ...antigravityDbs(o, c), ...cursorStores(o, c), ...t3Logs(o, c),
  ]);
  const out: SeatLogs = {
    seat, event_id: String(start?.id ?? basename(runDir)), scanned_at: new Date().toISOString(), snippets: m.mine.length, facts, model_ids: [],
    status: facts.length ? 'matched' : c.rejected.some((r) => r.reason !== 'too large') ? 'ambiguous' : 'none', rejected: c.rejected,
    match: { sampled: m.mine.length, need: Number.isFinite(m.need) ? m.need : m.mine.length },
    provenance: { kind: 'cli-local-logs', read_by: typeof opts.readBy === 'string' && /^[\w .:@+/-]{1,80}$/.test(opts.readBy) ? opts.readBy : 'harness-logs', self_attested: true, stores: [...new Set(facts.map((f) => f.store))] },
  };
  // Summary: an engine's own record first, T3 Code's log as the fallback.
  const ordered = [...facts].sort((a, b) => ENGINE_FIRST.indexOf(a.store) - ENGINE_FIRST.indexOf(b.store) || b.matched - a.matched);
  out.model_ids = [...new Set(ordered.map((f) => f.model).filter((x): x is string => !!x))];
  const perModel: Record<string, number> = {};
  for (const f of facts) for (const [k, n] of Object.entries(f.model_output_tokens ?? {})) perModel[k] = (perModel[k] ?? 0) + n;
  if (Object.keys(perModel).length) out.model_output_tokens = perModel;
  const v = ordered.find((f) => f.harness_version)?.harness_version;
  if (v) out.harness_version = v;
  const e = ordered.find((f) => f.effort?.level);
  if (e?.effort) out.effort_reported = { ...e.effort, status: TESTED[e.store] ? 'tested' : 'untested' };
  return out;
}

/** Scan for every LLM agent seat (or the given ones) and write harness-logs-<seat>.json next to the event log. */
export function attachHarnessLogs(runDir: string, opts: ScanOptions & { seats?: string[] } = {}): SeatLogs[] {
  const start = readLog(runDir).find((e) => e.type === 'event_start');
  const seats: string[] = opts.seats ?? (start?.seats ?? []).filter((s: any) => s.kind === 'agent' && !/^(rand|bot-|bot$|random)/i.test(s.name)).map((s: any) => String(s.name));
  const out: SeatLogs[] = [];
  for (const seat of seats) {
    if (!/^[\w.-]{1,40}$/.test(seat)) continue;
    const r = findSeatSessions(runDir, seat, opts);
    writeFileSync(join(runDir, `harness-logs-${seat}.json`), JSON.stringify(r, null, 1), { mode: 0o600 });
    out.push(r);
  }
  return out;
}
