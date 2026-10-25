/**
 * The nightly open-data build (docs/OPEN-DATA.md). Runs in its own low-priority process (schedule.ts, run.ts), never
 * per request and never in the Hub's request loop.
 *
 * Layout under <root> (= <HUB_DATA_DIR>/open-data):
 *   builds/<stamp>/        one complete, self-contained tree per build (served through the <site>/open symlink)
 *   snapshots/*.zip        the dated snapshot zips (hard-linked into every build) and snapshots.json (what each holds)
 *   cache/logs/<event>/    each event's redacted log and decision texts, rebuilt only when the event changed
 *   state.json             the last build (its input fingerprint: run.ts skips a build when nothing changed)
 *
 * A build writes a staging folder, verifies every checksum, then swaps the symlink atomically: readers see the old
 * tree or the new one, never a half-written one.
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync, copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import type { Ctx } from '../../../site/src/context.js';
import { isSettled, type EventData } from '../../../site/src/data.js';
import { builder, type MethodologyDoc } from '../../../site/src/export.js';
import { repoRoot } from '../../../site/src/context.js';
import { isLlmEvent } from '../../../site/src/metrics.js';
import { boardRows, cardRows, eventRows, humanReferenceRows, logExtras, ratingPairRows, ratingRows, redactContextOf, type LogExtras } from './rows.js';
import { DEFAULT_RATING_OPTIONS, ELO_CENTER } from '../../../site/src/rating.js';
import { FORFEIT_POLICY } from '../../../site/src/scoring.js';
import { directorVersion } from '../../../director/src/provenance.js';
import { registryVersion } from '../../../registry/src/index.js';
import { dataCard, fmtBytes, licenseText, type CardStats } from './datacard.js';
import { gzip, toCsvGz, toParquet, writeZip, type ZipEntry } from './formats.js';
import { citation, DATASET_NAME, HUMAN_REFERENCE_CREDIT, OPEN_DATA_LICENSE } from './license.js';
import { redactLog, TEXT_RECORD_TYPES } from './redact.js';
import { checkRows, OPEN_DATA_SCHEMA_VERSION, TABLES, type Row } from './tables.js';

/** Bump when redaction or the decision-texts format changes: every cached log is rebuilt once. */
export const LOG_VERSION = 2; // 2: the shared scrubber (API keys, JWTs, IPv6, more paths), 2026-10-22
const SNAPSHOT_PREFIX = 'agent-bench-data-';

export interface Retention {
  /** Newest snapshots kept (one a night). */
  daily: number;
  /** Plus the newest snapshot of each of this many months. */
  monthly: number;
  /** Cap on all snapshots together; the oldest go first (the newest is always kept). */
  maxBytes: number;
}

export const DEFAULT_RETENTION: Retention = { daily: 7, monthly: 12, maxBytes: 20 * 1024 ** 3 };

export interface BuildOptions {
  root: string;
  /** The served path: <HUB_DATA_DIR>/site/open, a symlink to the current build. */
  siteLink: string;
  /** Every ingested event, with contributorPublic set (who may be named now). */
  ctx: Ctx;
  methodology: MethodologyDoc | null;
  /** Public URL of the dataset folder (<HUB_PUBLIC_URL>/data/open), for the citation. */
  url: string;
  /** What the build was made from (run.ts inputsFingerprint), stored so the next run can skip an unchanged build. */
  fingerprint: string;
  humanReference?: boolean;
  retention?: Retention;
  now?: number;
  log?: (m: string) => void;
}

export interface FileInfo { path: string; bytes: number; sha256: string; rows?: number }

export interface BuildResult {
  build: string;
  dir: string;
  snapshot: FileInfo & { date: string };
  events: number;
  rows: Record<string, number>;
  files: number;
  bytes: number;
  ms: number;
  logsRebuilt: number;
  snapshotsDeleted: string[];
}

/**
 * Settled, accepted LLM events with no live redaction: finished, or stopped with finished games (METHODOLOGY §3.2
 * "Stopped events": their finished games are rated, so they are data). A Director error is never data. Smoke tests
 * (scripted agents only) are pipeline checks: out.
 */
export function included(ev: EventData): boolean {
  return isSettled(ev) && !(ev.aborted && !ev.stop) && !ev.withheld && isLlmEvent(ev) && ev.source.label !== 'smoke' && !ev.devBotFill;
}

const sha256 = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');

/**
 * What a snapshot was built from (2.17, docs/OPEN-DATA.md "Reproduce the leaderboard"): the code commit, the model
 * registry, the methodology text, the prompt and card-data hashes the events ran with, and the rating settings.
 * Identities are re-resolved against the registry at every export, so the registry hash says which one was used.
 */
export function reproducibility(events: EventData[], methodologySha256: string | null) {
  const reg = registryVersion();
  const uniq = (xs: Array<string | undefined | null>) => [...new Set(xs.filter((x): x is string => typeof x === 'string' && x !== ''))].sort();
  const cardData = (ev: EventData) => (ev.provenance as { card_data?: { sha256?: string } } | undefined)?.card_data?.sha256;
  const o = DEFAULT_RATING_OPTIONS;
  return {
    code_commit: directorVersion(),
    registry_version: reg.version,
    registry_sha256: reg.sha256,
    methodology_sha256: methodologySha256,
    prompt_sha256: uniq(events.map((e) => e.promptSha256)),
    card_data_sha256: uniq(events.map(cardData)),
    rating: {
      model: 'bradley-terry MAP, Elo scale', center: ELO_CENTER, prior_sd_elo: o.priorSdElo, play_prior_sd_elo: o.playPriorSdElo, play_term: 'game 1 of each match only',
      ci: o.ci, replicates: o.replicates, seed: o.seed, interval: 'max(bootstrap, laplace) with contributor and set variance terms', contributor_sd_elo: o.contributorSdElo, set_sd_elo: o.setSdElo,
      contributor_cluster_min: o.contributorClusterMin, forfeit_policy: FORFEIT_POLICY,
      thresholds: { min_games: o.minGames, min_events: o.minEvents, min_opponents: o.minOpponents, min_contributors: o.minContributors, max_contributor_share: o.maxContributorShare },
    },
  };
}

function sha256File(path: string): string {
  const h = createHash('sha256');
  const fd = openSync(path, 'r');
  const buf = Buffer.alloc(1 << 20);
  try {
    for (let n; (n = readSync(fd, buf, 0, buf.length, null)) > 0;) h.update(buf.subarray(0, n));
  } finally {
    closeSync(fd);
  }
  return h.digest('hex');
}

function writeAtomic(path: string, data: Buffer | string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${randomBytes(3).toString('hex')}`;
  writeFileSync(tmp, data, { mode: 0o644 });
  renameSync(tmp, path);
}

/** Hard link (same volume, no copy), else copy. */
function linkOrCopy(from: string, to: string): void {
  mkdirSync(dirname(to), { recursive: true });
  try {
    linkSync(from, to);
  } catch {
    copyFileSync(from, to);
  }
}

// ---------------------------------------------------------------------------
// Per-event logs (cached: rebuilt only when the event, its attribution or the redaction changed)

interface LogCache {
  key: string;
  log: { bytes: number; sha256: string };
  texts: { bytes: number; sha256: string; lines: number };
  extras: { decks: Array<[string, { deck_name?: string; archetype?: string }]>; rounds: Array<[string, number]> };
}

function logKey(ev: EventData, attribution: unknown): string {
  const st = statSync(join(ev.dir, 'events.jsonl'));
  return sha256(JSON.stringify({ v: LOG_VERSION, size: st.size, mtime: Math.floor(st.mtimeMs), attribution }));
}

/** Decision texts from a redacted log: one line per offered decision. */
function decisionTexts(redacted: string, eventId: string, gameIndex: Map<string, number>): { text: string; lines: number } {
  const out: string[] = [];
  for (const line of redacted.split('\n')) {
    if (!line || !line.includes('"text"')) continue;
    const r = JSON.parse(line) as Record<string, any>;
    if (!TEXT_RECORD_TYPES.has(r.type) || typeof r.text !== 'string') continue;
    const stage = r.type === 'build_offered' ? 'build' : r.type === 'sideboard_offered' ? 'sideboard' : r.type === 'play_draw_offered' ? 'play_draw' : 'game';
    out.push(JSON.stringify({
      event_id: eventId, stage, type: r.type, game_index: typeof r.game === 'string' ? (gameIndex.get(r.game) ?? null) : null, game: r.game ?? r.match ?? null,
      seat: r.seat ?? null, decision_id: r.id ?? null, kind: r.kind ?? null, turn: r.turn ?? null, t: r.t ?? null, text: r.text,
    }));
  }
  return { text: out.length ? `${out.join('\n')}\n` : '', lines: out.length };
}

function eventLog(root: string, ev: EventData, ctx: Ctx): { dir: string; cache: LogCache; rebuilt: boolean } {
  const rc = redactContextOf(ev, ctx);
  const key = logKey(ev, { seats: [...rc.seats], organizer: rc.organizerKey ?? null });
  const dir = join(root, 'cache', 'logs', ev.id);
  const meta = join(dir, 'cache.json');
  if (existsSync(meta)) {
    try {
      const c = JSON.parse(readFileSync(meta, 'utf8')) as LogCache;
      if (c.key === key && existsSync(join(dir, 'events.jsonl.gz')) && existsSync(join(dir, 'decision-texts.jsonl.gz'))) return { dir, cache: c, rebuilt: false };
    } catch {
      // rebuild
    }
  }
  const raw = readFileSync(join(ev.dir, 'events.jsonl'), 'utf8');
  const redacted = redactLog(raw, rc);
  const texts = decisionTexts(redacted, ev.id, new Map(ev.games.map((g) => [g.label, g.index])));
  const x = logExtras(raw);
  const logGz = gzip(redacted);
  const textsGz = gzip(texts.text);
  const cache: LogCache = {
    key,
    log: { bytes: logGz.length, sha256: sha256(logGz) },
    texts: { bytes: textsGz.length, sha256: sha256(textsGz), lines: texts.lines },
    extras: { decks: [...x.decks], rounds: [...x.rounds] },
  };
  writeAtomic(join(dir, 'events.jsonl.gz'), logGz);
  writeAtomic(join(dir, 'decision-texts.jsonl.gz'), textsGz);
  writeAtomic(meta, JSON.stringify(cache));
  return { dir, cache, rebuilt: true };
}

// ---------------------------------------------------------------------------
// Snapshots: what each holds (for privacy pruning) and retention

export interface SnapshotRecord {
  file: string;
  date: string;
  built_at: string;
  bytes: number;
  sha256: string;
  events: string[];
  handles: string[];
}

function readSnapshots(root: string): SnapshotRecord[] {
  try {
    const list = JSON.parse(readFileSync(join(root, 'snapshots', 'snapshots.json'), 'utf8')) as SnapshotRecord[];
    return list.filter((s) => existsSync(join(root, 'snapshots', s.file)));
  } catch {
    return [];
  }
}

/**
 * Which snapshots to delete: any holding an event that is no longer published (taken down) or a handle that is no
 * longer public; then everything outside the retention (daily, monthly, size cap). The newest is always kept.
 */
export function pruneSnapshots(list: SnapshotRecord[], current: { events: Set<string>; handles: Set<string> }, r: Retention): { keep: SnapshotRecord[]; drop: Array<{ file: string; why: string }> } {
  const drop: Array<{ file: string; why: string }> = [];
  const sorted = [...list].sort((a, b) => b.built_at.localeCompare(a.built_at));
  const newest = sorted[0];
  let alive = sorted.filter((s) => {
    const gone = s.events.find((e) => !current.events.has(e));
    const hidden = s.handles.find((h) => !current.handles.has(h));
    if (gone || hidden) drop.push({ file: s.file, why: gone ? `holds ${gone}, no longer published` : 'holds a handle that is no longer public' });
    return !gone && !hidden;
  });
  const months = new Set<string>();
  alive = alive.filter((s, n) => {
    const month = s.date.slice(0, 7);
    const monthly = !months.has(month) && months.size < r.monthly;
    if (!months.has(month)) months.add(month);
    const ok = s === newest || n < r.daily || monthly;
    if (!ok) drop.push({ file: s.file, why: 'retention' });
    return ok;
  });
  let total = alive.reduce((n, s) => n + s.bytes, 0);
  for (let k = alive.length - 1; k > 0 && total > r.maxBytes; k--) {
    if (alive[k] === newest) continue;
    total -= alive[k]!.bytes;
    drop.push({ file: alive[k]!.file, why: `size cap ${fmtBytes(r.maxBytes)}` });
    alive.splice(k, 1);
  }
  return { keep: alive, drop };
}

function snapshotName(root: string, date: string): string {
  const base = `${SNAPSHOT_PREFIX}${date}`;
  if (!existsSync(join(root, 'snapshots', `${base}.zip`))) return `${base}.zip`;
  for (let n = 2; ; n++) if (!existsSync(join(root, 'snapshots', `${base}-r${n}.zip`))) return `${base}-r${n}.zip`;
}

// ---------------------------------------------------------------------------
// Lock: one build at a time (the scheduler's child and a manual `hub open-data build`)

export function acquireLock(root: string, staleMs = 6 * 3600_000): (() => void) | null {
  mkdirSync(root, { recursive: true });
  const path = join(root, 'build.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx', 0o644);
      writeFileSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
      closeSync(fd);
      return () => rmSync(path, { force: true });
    } catch {
      let stale = true;
      try {
        const l = JSON.parse(readFileSync(path, 'utf8')) as { pid: number; at: number };
        let running = false;
        try {
          process.kill(l.pid, 0);
          running = true;
        } catch {
          running = false;
        }
        stale = !running || Date.now() - l.at > staleMs;
      } catch {
        stale = true;
      }
      if (!stale) return null;
      rmSync(path, { force: true });
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// The build

export async function buildOpenData(o: BuildOptions): Promise<BuildResult> {
  const t0 = Date.now();
  const now = o.now ?? Date.now();
  const log = o.log ?? (() => {});
  const retention = o.retention ?? DEFAULT_RETENTION;
  const humanReference = o.humanReference !== false;
  const { ctx } = o;
  for (const d of ['builds', 'snapshots', 'cache/logs']) mkdirSync(join(o.root, d), { recursive: true });

  const events = ctx.events.filter(included).sort((a, b) => a.startT - b.startT || a.id.localeCompare(b.id));
  const b = builder(ctx, o.methodology);
  const stamp = new Date(now).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const buildId = `${stamp}-${randomBytes(2).toString('hex')}`;
  const staging = join(o.root, 'builds', `.staging-${buildId}`);
  mkdirSync(staging, { recursive: true });
  const files = new Map<string, FileInfo>();
  const put = (rel: string, data: Buffer | string, rows?: number) => {
    const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    const path = join(staging, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, buf, { mode: 0o644 });
    files.set(rel, { path: rel, bytes: buf.length, sha256: sha256(buf), ...(rows != null ? { rows } : {}) });
  };
  const link = (rel: string, from: string, info: { bytes: number; sha256: string }) => {
    linkOrCopy(from, join(staging, rel));
    files.set(rel, { path: rel, bytes: info.bytes, sha256: info.sha256 });
  };

  try {
    // 1. Per-event logs and rows.
    const all: Record<string, Row[]> = Object.fromEntries(TABLES.map((t) => [t.name, []]));
    const namesBySet = new Map<string, Set<string>>();
    const setOfEvent = new Map<string, string>();
    let logsRebuilt = 0;
    let textBytes = 0;
    for (const ev of events) {
      const { dir, cache, rebuilt } = eventLog(o.root, ev, ctx);
      if (rebuilt) logsRebuilt++;
      const logRel = `events/${ev.id}/events.jsonl.gz`;
      link(logRel, join(dir, 'events.jsonl.gz'), cache.log);
      link(`events/${ev.id}/decision-texts.jsonl.gz`, join(dir, 'decision-texts.jsonl.gz'), cache.texts);
      textBytes += cache.texts.bytes;
      const x: LogExtras = { decks: new Map(cache.extras.decks), rounds: new Map(cache.extras.rounds) };
      const r = eventRows(ev, b, ctx, x, { file: logRel, sha256: cache.log.sha256 });
      for (const k of ['events', 'seats', 'picks', 'decks', 'games', 'matches', 'decisions', 'sideboarding'] as const) all[k]!.push(...r[k]);
      const set = ev.set.code.toUpperCase();
      setOfEvent.set(ev.id, set);
      const names = namesBySet.get(set) ?? new Set<string>();
      for (const n of r.cardNames) names.add(n);
      namesBySet.set(set, names);
    }
    all.cards = cardRows(b, namesBySet);
    if (humanReference) all.human_reference = humanReferenceRows(ctx, namesBySet);
    // Ratings: the boards of every event the Hub holds (only finished, rated events feed them), outcomes only.
    const index = b.index();
    const labels = new Map(index.groups.map((g) => [g.key, g.label]));
    all.ratings = ratingRows(index.boards, index.identities, (k) => labels.get(k) ?? null);
    all.boards = boardRows(index.boards, { priorSdElo: DEFAULT_RATING_OPTIONS.priorSdElo, playPriorSdElo: DEFAULT_RATING_OPTIONS.playPriorSdElo, center: ELO_CENTER, forfeitPolicy: FORFEIT_POLICY });
    all.rating_pairs = ratingPairRows(index.boards);
    // The boards and the tables must describe the same games: every all-sets, all-tables board's rated games are the
    // games rows marked rated in its group (a refit from the download reproduces it).
    for (const bd of index.boards.filter((x) => x.set == null && x.source === 'all')) {
      const n = all.games!.filter((g) => g.rated === true && g.rating_group === bd.group).length;
      if (n !== bd.games) throw new Error(`open data: board ${bd.id} has ${bd.games} rated games but the games table marks ${n} rated in its group`);
    }

    // 2. Check every row against its table definition before anything is published.
    const tables = TABLES.filter((t) => humanReference || t.name !== 'human_reference');
    const problems = tables.flatMap((t) => checkRows(t, all[t.name]!));
    if (problems.length) throw new Error(`open data: rows do not match the schema:\n${problems.join('\n')}`);

    // 3. Tables: all events, then per set.
    const meta = (thirdParty: boolean): Record<string, string> => thirdParty
      ? { license: HUMAN_REFERENCE_CREDIT.license.id, license_url: HUMAN_REFERENCE_CREDIT.license.url, attribution: HUMAN_REFERENCE_CREDIT.attribution, source: HUMAN_REFERENCE_CREDIT.url, note: HUMAN_REFERENCE_CREDIT.note, dataset: DATASET_NAME }
      : { license: OPEN_DATA_LICENSE.id, license_url: OPEN_DATA_LICENSE.url, attribution: OPEN_DATA_LICENSE.attribution, dataset: DATASET_NAME, schema_version: String(OPEN_DATA_SCHEMA_VERSION) };
    const sets = [...new Set(events.map((e) => e.set.code.toUpperCase()))].sort();
    const setOf = (table: string, row: Row): string | null =>
      typeof row.set_code === 'string' ? row.set_code : typeof row.event_id === 'string' ? (setOfEvent.get(row.event_id) ?? null) : null;
    for (const t of tables) {
      const rows = all[t.name]!;
      put(`tables/${t.name}.csv.gz`, toCsvGz(t, rows), rows.length);
      put(`tables/${t.name}.parquet`, toParquet(t, rows, meta(!!t.thirdParty)), rows.length);
      if (!t.bySet) continue;
      for (const set of sets) {
        const part = rows.filter((row) => setOf(t.name, row) === set);
        put(`tables/by-set/${set}/${t.name}.csv.gz`, toCsvGz(t, part), part.length);
        put(`tables/by-set/${set}/${t.name}.parquet`, toParquet(t, part, { ...meta(!!t.thirdParty), set }), part.length);
      }
    }
    const rowCounts = Object.fromEntries(tables.map((t) => [t.name, all[t.name]!.length]));

    // 4. The snapshot zip (at most one a night: the scheduler runs once a night and skips unchanged inputs).
    const date = new Date(now).toISOString().slice(0, 10);
    const snapFile = snapshotName(o.root, date);
    const folder = snapFile.replace(/\.zip$/, '');
    const handles = new Set(all.seats!.map((r) => r.contributor_handle).filter((h): h is string => typeof h === 'string'));
    const stats = cardStats(o, date, now, events, all, rowCounts, humanReference, null, null);
    const card0 = dataCard(stats);
    const repro = reproducibility(events, o.methodology?.sha256 ?? null);
    const manifest = (extra: object) => JSON.stringify({
      dataset: DATASET_NAME, schema_version: OPEN_DATA_SCHEMA_VERSION, snapshot_date: date, built_at: new Date(now).toISOString(),
      license: OPEN_DATA_LICENSE, events: events.map((e) => e.id), reproducibility: repro, ...extra,
    }, null, 1);
    const zipEntries: ZipEntry[] = [];
    const zipFiles = [...files.values()].filter((f) => (f.path.startsWith('tables/') && !f.path.startsWith('tables/by-set/')) || f.path.endsWith('/events.jsonl.gz'));
    const sums = zipFiles.map((f) => `${f.sha256}  ${f.path}`);
    const lic = licenseText();
    const man = manifest({ files: zipFiles });
    sums.push(`${sha256(card0)}  DATASET.md`, `${sha256(lic)}  LICENSE.md`, `${sha256(man)}  manifest.json`);
    // The reference refit (docs/OPEN-DATA.md "Reproduce the leaderboard") and the methodology travel with the numbers.
    const refit = readFileSync(join(repoRoot, 'scripts', 'reproduce_leaderboard.py'));
    sums.push(`${sha256(refit)}  reproduce_leaderboard.py`);
    zipEntries.push({ name: `${folder}/reproduce_leaderboard.py`, data: refit });
    if (o.methodology) {
      sums.push(`${sha256(o.methodology.text)}  methodology.md`);
      zipEntries.push({ name: `${folder}/methodology.md`, data: Buffer.from(o.methodology.text) });
    }
    zipEntries.push({ name: `${folder}/DATASET.md`, data: Buffer.from(card0) }, { name: `${folder}/LICENSE.md`, data: Buffer.from(lic) }, { name: `${folder}/manifest.json`, data: Buffer.from(man) }, { name: `${folder}/SHA256SUMS`, data: Buffer.from(`${sums.join('\n')}\n`) });
    for (const f of zipFiles) zipEntries.push({ name: `${folder}/${f.path}`, file: join(staging, f.path), store: true });
    const snapTmp = join(o.root, 'snapshots', `.${snapFile}.tmp-${randomBytes(3).toString('hex')}`);
    writeZip(snapTmp, zipEntries, new Date(now));
    const snapSha = sha256File(snapTmp);
    const snapBytes = statSync(snapTmp).size;
    renameSync(snapTmp, join(o.root, 'snapshots', snapFile));
    const record: SnapshotRecord = { file: snapFile, date, built_at: new Date(now).toISOString(), bytes: snapBytes, sha256: snapSha, events: events.map((e) => e.id), handles: [...handles].sort() };

    // 5. Retention and privacy: drop snapshots holding taken-down events or hidden handles, then by age and size.
    const { keep, drop } = pruneSnapshots([record, ...readSnapshots(o.root).filter((s) => s.file !== snapFile)], { events: new Set(events.map((e) => e.id)), handles }, retention);
    for (const d of drop) {
      rmSync(join(o.root, 'snapshots', d.file), { force: true });
      log(`open data: snapshot ${d.file} deleted (${d.why})`);
    }
    writeAtomic(join(o.root, 'snapshots', 'snapshots.json'), JSON.stringify(keep, null, 1));
    for (const s of keep) link(`snapshots/${s.file}`, join(o.root, 'snapshots', s.file), s);

    // 6. The data card, license, latest.json and SHA256SUMS of the served tree.
    const snapInfo = { path: `snapshots/${snapFile}`, bytes: snapBytes, sha256: snapSha, date };
    const card = dataCard(cardStats(o, date, now, events, all, rowCounts, humanReference, snapInfo.path, snapBytes));
    put('DATASET.md', card);
    put('LICENSE.md', lic);
    const latest = { ...latestJson(o, now, date, snapInfo, keep.filter((s) => s.file !== snapFile), tables, sets, files, rowCounts, events.length, textBytes, humanReference), reproducibility: repro };
    put('latest.json', JSON.stringify(latest, null, 1));
    const sumsAll = [...files.values()].sort((a, c) => a.path.localeCompare(c.path)).map((f) => `${f.sha256}  ${f.path}`);
    put('SHA256SUMS', `${sumsAll.join('\n')}\n`);

    // 7. Verify: every file this build wrote is re-read and hashed; linked files (cached logs, kept snapshots) are
    // checked by size, and the new snapshot by hash.
    for (const f of files.values()) {
      const p = join(staging, f.path);
      const st = statSync(p);
      if (st.size !== f.bytes) throw new Error(`open data: ${f.path} is ${st.size} bytes, expected ${f.bytes}`);
      const linked = f.path.startsWith('events/') || (f.path.startsWith('snapshots/') && f.path !== snapInfo.path);
      if (!linked && sha256File(p) !== f.sha256) throw new Error(`open data: checksum mismatch for ${f.path}`);
    }

    // 8. Swap: rename staging into place, then point the served symlink at it in one rename.
    const final = join(o.root, 'builds', buildId);
    renameSync(staging, final);
    swapLink(o.siteLink, final);
    writeAtomic(join(o.root, 'state.json'), JSON.stringify({ fingerprint: o.fingerprint, build: buildId, built_at: new Date(now).toISOString(), snapshot: snapInfo, events: events.length }, null, 1));

    // 9. Clean up: builds other than this one and the one before (in-flight downloads keep their open files), and
    // cached logs of events no longer published.
    const builds = readdirSync(join(o.root, 'builds'));
    // Leftovers of a build that crashed before its swap, and builds older than the previous one.
    for (const n of builds.filter((x) => x.startsWith('.staging-'))) rmSync(join(o.root, 'builds', n), { recursive: true, force: true });
    for (const n of builds.filter((x) => !x.startsWith('.')).sort().slice(0, -2)) rmSync(join(o.root, 'builds', n), { recursive: true, force: true });
    const ids = new Set(events.map((e) => e.id));
    for (const n of readdirSync(join(o.root, 'cache', 'logs'))) if (!ids.has(n)) rmSync(join(o.root, 'cache', 'logs', n), { recursive: true, force: true });

    const bytes = [...files.values()].reduce((n, f) => n + f.bytes, 0);
    const result: BuildResult = {
      build: buildId, dir: final, snapshot: snapInfo, events: events.length, rows: rowCounts, files: files.size, bytes, ms: Date.now() - t0, logsRebuilt, snapshotsDeleted: drop.map((d) => d.file),
    };
    log(`open data: build ${buildId}: ${events.length} event(s), ${files.size} files (${fmtBytes(bytes)}), snapshot ${snapFile} ${fmtBytes(snapBytes)}, ${logsRebuilt} log(s) rebuilt, ${result.ms} ms`);
    return result;
  } catch (e) {
    rmSync(staging, { recursive: true, force: true });
    throw e;
  }
}

/** Point <site>/open at a build in one rename (a relative symlink, so the data folder can move). */
export function swapLink(linkPath: string, target: string): void {
  mkdirSync(dirname(linkPath), { recursive: true });
  const tmp = `${linkPath}.tmp-${randomBytes(3).toString('hex')}`;
  symlinkSync(relative(dirname(linkPath), target), tmp);
  try {
    const st = lstatSync(linkPath);
    if (st.isDirectory() && !st.isSymbolicLink()) rmSync(linkPath, { recursive: true, force: true });
  } catch {
    // nothing there yet
  }
  try {
    renameSync(tmp, linkPath);
  } catch (e) {
    unlinkSync(tmp);
    throw e;
  }
}

function cardStats(o: BuildOptions, date: string, now: number, events: EventData[], all: Record<string, Row[]>, rows: Record<string, number>, humanReference: boolean, snapshotFile: string | null, snapshotBytes: number | null): CardStats {
  const count = (xs: string[]) => xs.reduce<Record<string, number>>((m, k) => ((m[k] = (m[k] ?? 0) + 1), m), {});
  const seats = all.seats!;
  const llm = seats.filter((s) => s.llm === true);
  const uniq = (k: string) => [...new Set(llm.map((s) => s[k]).filter((v): v is string => typeof v === 'string'))].sort();
  return {
    snapshotDate: date, builtAt: new Date(now).toISOString(), url: o.url, events: events.length,
    byProvenance: count(all.events!.map((e) => String(e.provenance))), bySet: count(all.events!.map((e) => String(e.set_code))),
    earlyTestData: all.events!.filter((e) => e.early_test_data === true).length, testTables: all.events!.filter((e) => e.test_table === true).length,
    seats: seats.length, llmSeats: llm.length, models: uniq('model_display'), harnesses: uniq('harness_display'),
    contributors: new Set(llm.map((s) => s.contributor_key).filter((k) => typeof k === 'string' && k !== 'admin' && k !== 'unattributed')).size,
    games: all.games!.filter((g) => g.status === 'complete').length, decisions: all.decisions!.length, picks: all.picks!.length,
    engineFlaggedGames: all.games!.filter((g) => g.engine_flagged === true).length,
    selfReportedSeats: llm.filter((s) => s.model_verification === 'self-reported').length, checkedSeats: llm.filter((s) => s.model_verification === 'verified').length,
    humanReference, rows, snapshotBytes, snapshotFile,
  };
}

function latestJson(
  o: BuildOptions, now: number, date: string, snap: FileInfo & { date: string }, earlier: SnapshotRecord[], tables: typeof TABLES, sets: string[],
  files: Map<string, FileInfo>, rows: Record<string, number>, events: number, textBytes: number, humanReference: boolean,
) {
  const f = (p: string) => {
    const x = files.get(p);
    return x ? { path: x.path, bytes: x.bytes, sha256: x.sha256 } : null;
  };
  const logs = [...files.values()].filter((x) => x.path.endsWith('/events.jsonl.gz'));
  return {
    dataset: DATASET_NAME,
    schema_version: OPEN_DATA_SCHEMA_VERSION,
    updated: 'nightly',
    built_at: new Date(now).toISOString(),
    snapshot: { file: snap.path, date: snap.date, bytes: snap.bytes, size: fmtBytes(snap.bytes), sha256: snap.sha256 },
    earlier_snapshots: earlier.map((s) => ({ file: `snapshots/${s.file}`, date: s.date, bytes: s.bytes, size: fmtBytes(s.bytes), sha256: s.sha256 })),
    data_card: 'DATASET.md',
    checksums: 'SHA256SUMS',
    license: { ...OPEN_DATA_LICENSE },
    citation: citation(date, o.url).text,
    events,
    sets,
    tables: Object.fromEntries(tables.map((t) => [t.name, {
      description: t.description,
      rows: rows[t.name] ?? 0,
      ...(t.thirdParty ? { license: HUMAN_REFERENCE_CREDIT.license.id, attribution: HUMAN_REFERENCE_CREDIT.attribution, note: HUMAN_REFERENCE_CREDIT.note, source: HUMAN_REFERENCE_CREDIT.url } : {}),
      csv: f(`tables/${t.name}.csv.gz`),
      parquet: f(`tables/${t.name}.parquet`),
      by_set: t.bySet ? Object.fromEntries(sets.map((s) => [s, { rows: files.get(`tables/by-set/${s}/${t.name}.csv.gz`)?.rows ?? 0, csv: f(`tables/by-set/${s}/${t.name}.csv.gz`), parquet: f(`tables/by-set/${s}/${t.name}.parquet`) }])) : undefined,
    }])),
    event_logs: { path: 'events/{event_id}/events.jsonl.gz', files: logs.length, bytes: logs.reduce((n, x) => n + x.bytes, 0) },
    decision_texts: { path: 'events/{event_id}/decision-texts.jsonl.gz', optional: true, in_snapshot: false, bytes: textBytes },
    human_reference: humanReference
      ? { included: true, table: 'human_reference', ...HUMAN_REFERENCE_CREDIT }
      : { included: false },
  };
}

