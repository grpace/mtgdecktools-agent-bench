/**
 * The Hub's pipeline: receive a bundle → store it (content-addressed) → integrity checks → decide
 * (validated / held / rejected) → ingest (materialize the run folder, index rows) → incremental JSON export.
 *
 * Status lifecycle (submissions.status):
 *   received → validated → ingested
 *            ↘ held (anomalies, provenance, new contributor) → ingested (approve) | rejected (reject)
 *            ↘ rejected (structural errors, tamper evidence, duplicates)
 *   ingested → withdrawn (takedown)
 *
 * The server keeps every ingested event parsed in memory (packages/site EventData) so an export after an
 * ingest only re-derives what changed. Other processes (the admin CLI) write to the same database and data
 * directory and NOTIFY the server, which then reloads the affected events.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { CardDb as DirectorCardDb, overridesFingerprint } from '../../director/src/cards.js';
import { compileModeration, flagText, moderateLog, noteItem, scrubPublic, type CompiledModeration } from '../../director/src/public-text.js';
import { unpackTarGz } from '../../director/src/submissions.js';
import { makeContext, type Ctx } from '../../site/src/context.js';
import { CardDb, loadEvent, type EventData } from '../../site/src/data.js';
import { builder, derivedFilePaths, eventFilePaths, readMethodology, serialize, writeDerived, writeEvent, writeSet, type MethodologyDoc } from '../../site/src/export.js';
import { groupKey, Identities, unratedReason } from '../../site/src/scoring.js';
import type { SourceLabel } from '../../site/src/schema.js';
import { checkBundle, type CheckResult, type IntegrityReport } from './checks.js';
import { Contributors } from './contributors.js';
import type { HubConfig } from './config.js';
import type { Sql } from './db.js';
import { writeCardStats, writeEventRows, writeRatings } from './indexer.js';
import { loadModeration, logAction, scanLog } from './moderation.js';
import { SET_CODE_RE } from './sanity.js';
import { shapeErrors } from './shape.js';
import { type BundleStore, sha256 } from './store.js';
import type { Principal } from './tokens.js';
import { uploadedUsageFiles } from './usage-uploads.js';

export type Via = 'upload' | 'director' | 'import';
export type Severity = 'reject' | 'hold' | 'flag' | 'info';
export interface Reason { code: string; severity: Severity; message: string }

export interface ReceiveOptions {
  /** Derived inputs stored next to the bundle (imports): strength.json, draft-eval.json. */
  sidecars?: Map<string, Buffer>;
  /** Imports keep the label their run folder had. */
  label?: SourceLabel;
  exclude?: string;
}

export interface ReceiveResult {
  http: number;
  body: Record<string, unknown>;
}

const NOTIFY_CHANNEL = 'hub_events';
/** A moderation change made by another process (the admin CLI): refresh the list, rebuild open data early. */
const MODERATION_CHANNEL = 'hub_moderation';
const SIDECARS = new Set(['strength.json', 'draft-eval.json']);

/** What a non-passing check means, by how the bundle arrived (docs/METHODOLOGY.md §3.1). */
export function policy(c: CheckResult, via: Via): Severity | null {
  if (c.outcome === 'pass' || c.outcome === 'skip') return null;
  if (c.class === 'info') return 'info';
  // Not a product event (bot drafters at the table): never accepted from anyone; history imports keep a flag.
  if (c.class === 'eligibility') return via === 'import' ? 'flag' : 'reject';
  if (c.class === 'integrity') {
    // Tamper evidence: rejected from the community; our own Directors and imports are held (a bug, not a forgery).
    if (c.outcome === 'fail') return via === 'upload' ? 'reject' : 'hold';
    return via === 'upload' ? 'hold' : 'flag';
  }
  // provenance / anomaly: a reviewer looks before it counts; imports keep history as it was.
  return via === 'import' ? 'flag' : 'hold';
}

/**
 * Unpack an uploaded bundle: the unpacked size is bounded first (decompression bombs; unpackTarGz's own cap
 * is 300 MB), then unpackTarGz accepts only flat, regular files (no paths, links or devices).
 */
export function unpackBundle(gz: Buffer, maxUnpackedBytes: number): Map<string, Buffer> {
  try {
    gunzipSync(gz, { maxOutputLength: maxUnpackedBytes });
  } catch (e) {
    throw new Error(`not a valid .tar.gz (or larger than ${Math.round(maxUnpackedBytes / 2 ** 20)} MB unpacked): ${(e as Error).message}`);
  }
  return unpackTarGz(gz);
}

export class Hub {
  /** Ingested events, parsed (packages/site EventData), by id. */
  readonly events = new Map<string, EventData>();
  cards!: CardDb;
  methodology: MethodologyDoc | null = null;
  readonly siteDir: string;
  readonly runsDir: string;
  private exportQueue = new Set<string>();
  private exportFull = false;
  private deferred = false;
  private exporting: Promise<void> | null = null;
  /** What other events' files depend on, as of the last export (or load). */
  private lastSig: Signatures = { identities: new Map(), rarities: new Map() };
  /** Set code of every event ever loaded in this process (to refresh a set after a takedown). */
  private setOf = new Map<string, string>();
  lastExport: { at: string; files: number; ms: number; events: number } | null = null;
  /** Contributor points, leaderboard and profiles (contributors.ts), rebuilt after every export. */
  readonly contributors: Contributors;
  /**
   * The open dataset's scheduler (open-data/schedule.ts), in the server process only: a takedown or a hidden handle
   * asks it for an early rebuild, so the published files stop showing them before the night.
   */
  openData?: { privacyChange(why: string): void; nextAt: number | null; lastRun: { at: string; code: number | null; ms: number } | null };
  /**
   * The moderation list (moderation.ts), applied whenever a run folder is written: hidden notes and deck names read
   * `[Removed by moderators]`, hidden handles are dropped and erased contributors anonymized in the stored log, so the
   * export, the index and the open dataset all read the moderated text. The bundle store keeps the original.
   */
  private mod: CompiledModeration = compileModeration(null);

  constructor(readonly cfg: HubConfig, readonly sql: Sql, readonly store: BundleStore, readonly log: (msg: string) => void = (m) => console.log(m)) {
    this.siteDir = join(cfg.dataDir, 'site');
    this.runsDir = join(cfg.dataDir, 'events');
    this.contributors = new Contributors(this);
  }

  /** Load card data and every ingested event into memory. */
  async load(): Promise<void> {
    mkdirSync(this.siteDir, { recursive: true });
    mkdirSync(this.runsDir, { recursive: true });
    // The site fetches contributors.json from the first start on: an empty board until the first computation.
    this.contributors.ensureFile();
    this.cards = new CardDb(this.cardsSlim());
    this.methodology = readMethodology(this.cfg.methodologyPath);
    await this.refreshModeration();
    const rows = await this.sql`select e.id, s.bundle_sha256, s.contributor_id from events e join submissions s on s.id = e.submission_id`;
    for (const r of rows) await this.loadEvent(String(r.id), String(r.bundle_sha256), r.contributor_id == null ? null : Number(r.contributor_id));
    this.lastSig = signatures(this.context());
    this.log(`hub: ${this.events.size} event(s) loaded`);
  }

  /** card-data.slim.json for the export: derived from phase-rs card-data.json with the Director's CardDb. */
  private cardsSlim(): string {
    const cache = join(this.cfg.dataDir, 'cache');
    if (existsSync(this.cfg.cardData)) {
      try {
        new DirectorCardDb(this.cfg.cardData, cache);
        return join(cache, 'card-data.slim.json');
      } catch (e) {
        this.log(`card data unreadable (${(e as Error).message}); the export will lack card details`);
      }
    }
    const beside = join(dirname(this.cfg.cardData), 'card-data.slim.json');
    return existsSync(beside) ? beside : join(cache, 'card-data.slim.json');
  }

  private async loadEvent(id: string, bundleSha: string, contributorId?: number | null): Promise<EventData | null> {
    const dir = join(this.runsDir, id);
    if (!existsSync(join(dir, 'events.jsonl'))) await this.rematerialize(id, bundleSha);
    else if (contributorId !== undefined) scrubSource(dir, contributorId);
    const ev = loadEvent(dir, Date.now());
    if (ev) this.remember(ev);
    else this.events.delete(id);
    return ev;
  }

  private remember(ev: EventData): void {
    this.events.set(ev.id, ev);
    this.setOf.set(ev.id, ev.set.code.toUpperCase());
  }

  /** Re-read the moderation list from the database. */
  async refreshModeration(): Promise<CompiledModeration> {
    this.mod = await loadModeration(this.sql);
    return this.mod;
  }

  /** Rebuild a run folder from the stored bundle (e.g. on a fresh volume). */
  private async rematerialize(id: string, bundleSha: string): Promise<void> {
    await this.refreshModeration();
    const [s] = await this.sql`
      select s.id, s.label, s.sidecars, s.submitter_claimed, s.received_at, s.reasons, s.contributor_id, e.excluded, e.pack_regen
      from submissions s left join events e on e.submission_id = s.id
      where s.bundle_sha256 = ${bundleSha}`;
    if (!s) throw new Error(`no submission for bundle ${bundleSha}`);
    const files = unpackTarGz(await this.store.get(bundleSha));
    for (const [name, digest] of Object.entries((s.sidecars ?? {}) as Record<string, string>)) files.set(name, await this.store.get(digest));
    await this.addUploadedUsage(id, files);
    this.materialize(id, files, this.sourceJson(s, bundleSha));
  }

  /**
   * source.json of a materialized run folder. No uploader handle (PTS-4): the export would publish it on every event
   * the uploader sent, hidden or not. `submitter_id` is the Hub's id, which the export only ever uses salted and
   * hashed (an opaque contributor key, packages/site scoring.ts contributorOf); admins see handles in the Hub.
   */
  private sourceJson(s: Record<string, any>, bundleSha: string): Record<string, unknown> {
    // An erased uploader is named by their anonymous id (moderation.ts eraseContributor).
    const submitter = s.contributor_id != null ? (this.mod.erased.get(String(s.contributor_id)) ?? String(s.contributor_id)) : null;
    return {
      label: s.label, ...(submitter != null ? { submitter_id: submitter } : {}),
      submitted_at: new Date(s.received_at).toISOString(), bundle_sha256: bundleSha, submission_id: Number(s.id),
      flags: ((s.reasons ?? []) as Reason[]).filter((r) => r.severity !== 'info').map((r) => r.code),
      ...(s.pack_regen ? { pack_regeneration: s.pack_regen } : {}),
      ...(s.excluded ? { exclude: s.excluded } : {}),
    };
  }

  /**
   * Usage summaries the contributor's CLI sent for hosted seats (usage-uploads.ts) join the run folder as
   * usage-<seat>.json; a bundle's own usage file for a seat always wins.
   */
  private async addUploadedUsage(eventId: string, files: Map<string, Buffer>): Promise<void> {
    for (const [name, data] of await uploadedUsageFiles(this.sql, eventId)) if (!files.has(name)) files.set(name, data);
  }

  /** Write a run folder (the layout packages/site reads) atomically, with the moderation list applied to its log. */
  private materialize(id: string, files: Map<string, Buffer>, source: Record<string, unknown>): string {
    const dir = join(this.runsDir, id);
    const tmp = join(this.runsDir, `.incoming-${id}-${randomBytes(3).toString('hex')}`);
    mkdirSync(tmp, { recursive: true });
    for (const [name, data] of files) {
      const body = name === 'events.jsonl' ? Buffer.from(moderateLog(data.toString('utf8'), this.mod), 'utf8') : data;
      writeFileSync(join(tmp, name === 'bundle.json' ? 'bundle-manifest.json' : name), body);
    }
    writeFileSync(join(tmp, 'source.json'), JSON.stringify(source, null, 1));
    const old = `${dir}.old-${randomBytes(3).toString('hex')}`;
    if (existsSync(dir)) renameSync(dir, old);
    renameSync(tmp, dir);
    rmSync(old, { recursive: true, force: true });
    return dir;
  }

  // -------------------------------------------------------------------------
  // Intake

  async receive(gz: Buffer, who: Principal, via: Via, opts: ReceiveOptions = {}): Promise<ReceiveResult> {
    const digest = sha256(gz);
    const [dup] = await this.sql`select id, status, event_id from submissions where bundle_sha256 = ${digest}`;
    if (dup) {
      return { http: 409, body: { error: `this bundle was already submitted (submission ${dup.id}, ${dup.status})`, submission_id: Number(dup.id), status: dup.status, id: dup.event_id } };
    }
    if (via === 'upload') {
      const [{ n }] = (await this.sql`select count(*)::int as n from submissions where contributor_id = ${who.contributorId} and received_at > now() - interval '1 day'`) as unknown as [{ n: number }];
      if (n >= this.cfg.submissionsPerDay) return { http: 429, body: { error: `rate limit: ${this.cfg.submissionsPerDay} submissions per day` } };
    }
    await this.store.put(gz);
    const sidecars: Record<string, string> = {};
    for (const [name, data] of opts.sidecars ?? []) if (SIDECARS.has(name)) sidecars[name] = await this.store.put(data);
    const [row] = await this.sql`
      insert into submissions (contributor_id, via, bundle_sha256, bundle_bytes, sidecars, status)
      values (${who.contributorId}, ${via}, ${digest}, ${gz.length}, ${this.sql.json(sidecars)}, 'received')
      on conflict (bundle_sha256) do nothing
      returning id`;
    if (!row) return { http: 409, body: { error: 'this bundle was already submitted (concurrently)' } };
    const id = Number(row.id);

    let files: Map<string, Buffer>;
    try {
      files = unpackBundle(gz, this.cfg.maxUnpackedBytes);
    } catch (e) {
      return this.reject(id, [{ code: 'bundle_unreadable', severity: 'reject', message: (e as Error).message }], null, 400);
    }
    // Nesting depth and record count before anything parses the files (HUB-33, shape.ts).
    const shape = shapeErrors(files);
    if (shape.length) return this.reject(id, shape.map((m) => ({ code: 'bundle_invalid', severity: 'reject' as const, message: m })), null, 400);
    const report = checkBundle(files, {
      allowedEngineDigests: this.cfg.allowedEngineDigests,
      boosters: { defaultDraftPools: this.cfg.draftPools, defaultUnsupported: this.cfg.unsupportedCards, archiveDir: this.cfg.boosterArchive, archiveDirs: this.cfg.boosterArchiveDirs },
      minLatencyMs: this.cfg.minLatencyMs,
      fastShare: this.cfg.fastShare,
      // The card data the event says it ran (upstream + card overrides) against this repository's pins and override files.
      ...(this.cfg.cardDataUpstream.length ? { cardData: { upstream: this.cfg.cardDataUpstream, fingerprint: (slugs: string[]) => overridesFingerprint(slugs) } } : {}),
    });
    let manifest: { submitter?: string } = {};
    try {
      manifest = JSON.parse(files.get('bundle.json')?.toString('utf8') ?? '{}');
    } catch {
      // reported by the checks
    }
    if (!report.structural) {
      return this.reject(id, report.errors.map((m) => ({ code: 'bundle_invalid', severity: 'reject' as const, message: m })), report, 400);
    }
    const eventId = report.eventId!;
    const label: SourceLabel = opts.label ?? (report.llm ? (via === 'upload' ? 'community' : 'verified') : 'smoke');
    await this.sql`update submissions set event_id = ${eventId}, label = ${label}, submitter_claimed = ${typeof manifest.submitter === 'string' ? manifest.submitter : null} where id = ${id}`;

    const reasons: Reason[] = [];
    for (const c of report.checks) {
      const sev = policy(c, via);
      if (sev) reasons.push({ code: c.id, severity: sev, message: c.message });
    }
    // Duplicates: the same event id, or the same decision stream as a seat elsewhere.
    const [taken] = await this.sql`
      select id, status from submissions where event_id = ${eventId} and id <> ${id} and status in ('received', 'validated', 'held', 'ingested') limit 1`;
    if (taken) reasons.push({ code: 'duplicate.event_id', severity: 'reject', message: `event ${eventId} already exists (submission ${taken.id}, ${taken.status})` });
    const fps = Object.values(report.fingerprints);
    if (fps.length) {
      const same = await this.sql`select event_id, name from seats where decision_fingerprint in ${this.sql(fps)} and event_id <> ${eventId} limit 5`;
      if (same.length) {
        reasons.push({ code: 'anomaly.duplicate_stream', severity: via === 'import' ? 'flag' : 'hold', message: `decision stream identical to ${same.map((r) => `${r.event_id}/${r.name}`).join(', ')}` });
      }
    }
    if (via === 'upload' && who.trust === 'new') {
      const [{ n }] = (await this.sql`select count(*)::int as n from submissions where contributor_id = ${who.contributorId} and status = 'ingested'`) as unknown as [{ n: number }];
      if (n < this.cfg.reviewFirst) reasons.push({ code: 'review.new_contributor', severity: 'hold', message: `a reviewer checks a new contributor's first ${this.cfg.reviewFirst} submissions` });
    }
    if (opts.exclude) reasons.push({ code: 'excluded', severity: 'info', message: opts.exclude });
    // HUB_MODERATION_HOLD=1: text the filter flags holds the bundle for a reviewer (default: publish, never feature it).
    if (this.cfg.moderationHold && via !== 'import') {
      const n = flaggedItems(files.get('events.jsonl')?.toString('utf8') ?? '');
      if (n) reasons.push({ code: 'review.flagged_text', severity: 'hold', message: `${n} note(s) or deck name(s) matched the content filter; a reviewer checks them first` });
    }

    const checks = this.checksJson(report);
    if (reasons.some((r) => r.severity === 'reject')) {
      const onlyDup = reasons.filter((r) => r.severity === 'reject').every((r) => r.code === 'duplicate.event_id');
      return this.reject(id, reasons, report, onlyDup ? 409 : 422);
    }
    const held = reasons.some((r) => r.severity === 'hold');
    await this.sql`
      update submissions set status = ${held ? 'held' : 'validated'}, reasons = ${this.sql.json(reasons as any)}, checks = ${this.sql.json(checks)},
        validated_at = now(), decided_at = ${held ? null : this.sql`now()`} where id = ${id}`;
    if (!held) await this.ingest(id, { exclude: opts.exclude });
    const [after] = await this.sql`select status from submissions where id = ${id}`;
    this.log(`submission ${id} (${via}, ${who.handle}): ${eventId} → ${after!.status}${reasons.length ? ` [${reasons.map((r) => `${r.code}:${r.severity}`).join(', ')}]` : ''}`);
    return { http: 201, body: this.response(id, eventId, String(after!.status), label, who.handle, reasons, report) };
  }

  private checksJson(report: IntegrityReport): any {
    return { checks: report.checks, regen: report.regen ?? null, validation: report.validation, fingerprints: report.fingerprints, errors: report.errors };
  }

  private response(id: number, eventId: string | undefined, status: string, label: string | null, handle: string, reasons: Reason[], report: IntegrityReport | null): Record<string, unknown> {
    return {
      submission_id: id,
      id: eventId ?? null,
      status,
      label,
      submitter: handle,
      flags: reasons.filter((r) => r.severity !== 'info').map((r) => r.code),
      reasons,
      pack_regeneration: report?.regen ? { status: report.regen.status, message: report.regen.message } : null,
      status_url: `${this.cfg.publicUrl}/api/submissions/${id}`,
      report: status === 'ingested' && eventId ? `${this.cfg.publicUrl}/data/events/${eventId}.json` : null,
    };
  }

  private async reject(id: number, reasons: Reason[], report: IntegrityReport | null, http: number): Promise<ReceiveResult> {
    await this.sql`
      update submissions set status = 'rejected', reasons = ${this.sql.json(reasons as any)}, checks = ${report ? this.sql.json(this.checksJson(report)) : null},
        validated_at = now(), decided_at = now() where id = ${id}`;
    const [s] = await this.sql`select s.event_id, s.label, c.handle from submissions s left join contributors c on c.id = s.contributor_id where s.id = ${id}`;
    this.log(`submission ${id}: rejected [${reasons.map((r) => r.code).join(', ')}]`);
    const body = this.response(id, s?.event_id ?? report?.eventId, 'rejected', s?.label ?? null, String(s?.handle ?? ''), reasons, report);
    return { http, body: { error: `bundle rejected: ${reasons.filter((r) => r.severity === 'reject').map((r) => r.message).slice(0, 3).join('; ')}`, ...body } };
  }

  // -------------------------------------------------------------------------
  // Ingest

  /** Materialize and index a validated (or approved) submission, then queue its export. */
  async ingest(submissionId: number, opts: { exclude?: string } = {}): Promise<EventData> {
    const [s] = await this.sql`
      select s.*, c.handle from submissions s left join contributors c on c.id = s.contributor_id where s.id = ${submissionId}`;
    if (!s) throw new Error(`no submission ${submissionId}`);
    const files = unpackTarGz(await this.store.get(String(s.bundle_sha256)));
    for (const [name, digest] of Object.entries((s.sidecars ?? {}) as Record<string, string>)) files.set(name, await this.store.get(digest));
    const eventId = String(s.event_id);
    await this.refreshModeration();
    await this.addUploadedUsage(eventId, files);
    const checks = (s.checks ?? {}) as { regen?: { status?: string }; fingerprints?: Record<string, string> };
    const packRegen = checks.regen?.status ?? null;
    const exclude = opts.exclude ?? ((s.reasons ?? []) as Reason[]).find((r) => r.code === 'excluded')?.message ?? null;
    const source = this.sourceJson({ ...s, excluded: exclude, pack_regen: packRegen }, String(s.bundle_sha256));
    const dir = this.materialize(eventId, files, source);
    const ev = loadEvent(dir, Date.now());
    if (!ev) throw new Error(`event ${eventId}: run folder did not load`);
    // The review queue: notes and deck names the filter flags (moderation.ts). Never blocks an ingest.
    await scanLog(this.sql, eventId, readFileSync(join(dir, 'events.jsonl'), 'utf8')).catch((e) => this.log(`moderation scan of ${eventId} failed: ${(e as Error).message}`));
    if (ev.id !== eventId) throw new Error(`event id mismatch: ${ev.id} vs ${eventId}`);
    const all = [...this.events.values()].filter((e) => e.id !== eventId).concat(ev);
    const ctx = this.context(all);
    const ids = new Identities(all);
    await this.sql.begin(async (tx) => {
      await writeEventRows(tx, ev, ctx, ids, { submissionId, label: String(s.label), packRegen, fingerprints: checks.fingerprints ?? {} });
      await tx`update submissions set status = 'ingested', ingested_at = now(), decided_at = coalesce(decided_at, now()) where id = ${submissionId}`;
    });
    this.remember(ev);
    await this.sql`select pg_notify(${NOTIFY_CHANNEL}, ${eventId})`;
    this.requestExport([eventId]);
    return ev;
  }

  async approve(submissionId: number, reviewer: string, note?: string): Promise<string> {
    const [s] = await this.sql`select status from submissions where id = ${submissionId}`;
    if (!s) throw new Error(`no submission ${submissionId}`);
    if (s.status !== 'held') throw new Error(`submission ${submissionId} is ${s.status}, not held`);
    await this.sql`update submissions set reviewed_by = ${reviewer}, review_note = ${note ?? null}, decided_at = now() where id = ${submissionId}`;
    const ev = await this.ingest(submissionId);
    return ev.id;
  }

  async rejectHeld(submissionId: number, reviewer: string, note: string): Promise<void> {
    const [s] = await this.sql`select status, reasons from submissions where id = ${submissionId}`;
    if (!s) throw new Error(`no submission ${submissionId}`);
    if (s.status !== 'held') throw new Error(`submission ${submissionId} is ${s.status}, not held`);
    const reasons = [...((s.reasons ?? []) as Reason[]), { code: 'review.rejected', severity: 'reject' as const, message: note }];
    await this.sql`update submissions set status = 'rejected', reasons = ${this.sql.json(reasons as any)}, reviewed_by = ${reviewer}, review_note = ${note}, decided_at = now() where id = ${submissionId}`;
  }

  /** Exclude an ingested event from ratings (it stays listed with the reason), or include it again. */
  async setExcluded(eventId: string, reason: string | null): Promise<void> {
    const dir = join(this.runsDir, eventId);
    if (!existsSync(join(dir, 'source.json'))) throw new Error(`no event ${eventId}`);
    const src = JSON.parse(readFileSync(join(dir, 'source.json'), 'utf8'));
    if (reason) src.exclude = reason;
    else delete src.exclude;
    writeFileSync(join(dir, 'source.json'), JSON.stringify(src, null, 1));
    const ev = loadEvent(dir, Date.now());
    if (!ev) throw new Error(`event ${eventId} did not load`);
    this.remember(ev);
    const [e] = await this.sql`
      update events set excluded = ${reason}, comparability_group = ${groupKey(ev)}, unrated_reason = ${unratedReason(ev) ?? null}
      where id = ${eventId} returning id`;
    if (!e) throw new Error(`no event ${eventId}`);
    await this.sql`select pg_notify(${NOTIFY_CHANNEL}, ${eventId})`;
    this.requestExport([eventId]);
  }

  /**
   * Exclude some seats of an event from the ratings (their games become unrated; the event and its other games stay):
   * a banned contributor's seats at a table others played at. An empty map clears it.
   */
  async setSeatsExcluded(eventId: string, seats: Record<string, string>): Promise<void> {
    const dir = join(this.runsDir, eventId);
    if (!existsSync(join(dir, 'source.json'))) throw new Error(`no event ${eventId}`);
    const src = JSON.parse(readFileSync(join(dir, 'source.json'), 'utf8'));
    const merged = { ...(src.exclude_seats ?? {}), ...seats };
    if (Object.keys(seats).length) src.exclude_seats = merged;
    else delete src.exclude_seats;
    writeFileSync(join(dir, 'source.json'), JSON.stringify(src, null, 1));
    const ev = loadEvent(dir, Date.now());
    if (!ev) throw new Error(`event ${eventId} did not load`);
    this.remember(ev);
    await this.sql`select pg_notify(${NOTIFY_CHANNEL}, ${eventId})`;
    this.requestExport([eventId]);
  }

  /**
   * Takedown: remove an event from the index and the export (logged in moderation_log). The bundle is kept unless
   * purge is set. Hosted Directors drop their own copy when they next read the moderation list (within a minute).
   */
  async takedown(eventId: string, reason: string, purge = false, actor = 'admin'): Promise<void> {
    const [e] = await this.sql`select e.submission_id, s.bundle_sha256 from events e join submissions s on s.id = e.submission_id where e.id = ${eventId}`;
    if (!e) throw new Error(`no event ${eventId}`);
    await this.sql.begin(async (tx) => {
      await tx`delete from events where id = ${eventId}`;
      await tx`update submissions set status = 'withdrawn', review_note = ${reason}, decided_at = now() where id = ${e.submission_id as number}`;
    });
    await logAction(this.sql, actor, 'takedown', { event: eventId, purge }, reason);
    if (purge) await this.store.purge(String(e.bundle_sha256));
    rmSync(join(this.runsDir, eventId), { recursive: true, force: true });
    this.events.delete(eventId);
    await this.sql`select pg_notify(${NOTIFY_CHANNEL}, ${eventId})`;
    this.requestExport([eventId]);
    this.openData?.privacyChange(`takedown of ${eventId}`);
  }

  /**
   * After a moderation change: re-materialize and re-index the events it touches from their stored bundles (with the
   * new list applied), re-export them, tell the server process (if this is the CLI) and ask for an early open-data
   * rebuild. Hosted Directors pick the change up from GET /api/internal/moderation.
   */
  async remoderate(eventIds: string[], why: string): Promise<void> {
    await this.refreshModeration();
    const ids = [...new Set(eventIds)];
    if (ids.length) {
      const rows = await this.sql`select submission_id from events where id in ${this.sql(ids)}`;
      for (const r of rows) await this.ingest(Number(r.submission_id));
    }
    await this.sql`select pg_notify(${MODERATION_CHANNEL}, ${why})`;
    this.openData?.privacyChange(why);
  }

  /** Re-run ingestion for ingested events from their stored bundles (after a schema or code change). */
  async reingest(eventIds?: string[]): Promise<number> {
    const rows = eventIds?.length
      ? await this.sql`select submission_id from events where id in ${this.sql(eventIds)}`
      : await this.sql`select submission_id from events`;
    for (const r of rows) await this.ingest(Number(r.submission_id));
    return rows.length;
  }

  // -------------------------------------------------------------------------
  // Keeping several processes in step (the CLI ingests, the server exports)

  /** Reload one event from the database and data directory. */
  async sync(eventId: string): Promise<void> {
    const [r] = await this.sql`select s.bundle_sha256, s.contributor_id from events e join submissions s on s.id = e.submission_id where e.id = ${eventId}`;
    if (r) await this.loadEvent(eventId, String(r.bundle_sha256), r.contributor_id == null ? null : Number(r.contributor_id));
    else if (this.events.delete(eventId)) this.openData?.privacyChange(`${eventId} was taken down`);
    this.requestExport([eventId]);
  }

  /** Reconcile memory with the database (missed notifications). */
  async syncAll(): Promise<void> {
    const rows = await this.sql`select e.id, s.bundle_sha256 from events e join submissions s on s.id = e.submission_id`;
    const ids = new Set(rows.map((r) => String(r.id)));
    const changed: string[] = [];
    for (const r of rows) {
      if (!this.events.has(String(r.id))) {
        await this.loadEvent(String(r.id), String(r.bundle_sha256));
        changed.push(String(r.id));
      }
    }
    for (const id of [...this.events.keys()]) {
      if (!ids.has(id)) {
        this.events.delete(id);
        changed.push(id);
      }
    }
    if (changed.length) this.requestExport(changed);
  }

  async listen(): Promise<void> {
    await this.sql.listen(NOTIFY_CHANNEL, (id) => {
      this.sync(id).catch((e) => this.log(`sync ${id} failed: ${(e as Error).message}`));
    });
    await this.sql.listen(MODERATION_CHANNEL, (why) => {
      this.refreshModeration()
        .then(() => {
          this.openData?.privacyChange(why || 'moderation');
          return this.contributors.refresh();
        })
        .catch((e) => this.log(`moderation refresh failed: ${(e as Error).message}`));
    });
  }

  // -------------------------------------------------------------------------
  // Incremental export (docs/SITE-DATA.md tree under <dataDir>/site)

  context(events = [...this.events.values()], publicIds?: Set<string>): Ctx {
    return makeContext({
      events, cards: this.cards, setsDir: this.cfg.setsDir, replicates: this.cfg.bootstrap,
      ...(publicIds ? { contributorPublic: (id: string) => publicIds.has(id) } : {}),
    });
  }

  /**
   * A contributor showed or hid their handle: re-export every event that could name them (the export reads who is
   * public afresh), which also rebuilds the contributor boards. Nothing to re-export: just the boards.
   */
  visibilityChanged(contributorId: number): void {
    const id = String(contributorId);
    const ids = [...this.events.values()].filter((ev) => ev.source.submitterId === id || ev.seats.some((s) => s.contributorId === id)).map((ev) => ev.id);
    if (ids.length) this.requestExport(ids);
    else void this.contributors.refresh();
    // Shown or hidden: the open dataset names a handle only while it is public.
    if (ids.length) this.openData?.privacyChange('a contributor changed their visibility');
  }

  /** While deferred (bulk imports), export requests only accumulate; deferExports(false) runs them once. */
  deferExports(on: boolean): void {
    this.deferred = on;
    if (!on && (this.exportFull || this.exportQueue.size)) this.requestExport([]);
  }

  requestExport(ids: string[] | 'full'): void {
    if (ids === 'full') this.exportFull = true;
    else for (const id of ids) this.exportQueue.add(id);
    if (!this.exporting && !this.deferred) {
      this.exporting = this.drain().finally(() => {
        this.exporting = null;
      });
    }
  }

  /** Resolves once every requested export has been written. */
  async idle(): Promise<void> {
    while (this.exporting) await this.exporting;
  }

  private async drain(): Promise<void> {
    await new Promise((r) => setTimeout(r, 50)); // coalesce bursts (imports)
    while (this.exportFull || this.exportQueue.size) {
      const full = this.exportFull;
      const ids = [...this.exportQueue];
      this.exportFull = false;
      this.exportQueue.clear();
      try {
        await this.exportNow(full ? 'full' : ids);
      } catch (e) {
        this.log(`export failed: ${(e as Error).stack ?? e}`);
      }
    }
  }

  /** Write the files an ingest affects: its event files, its set, events whose identities changed, index. */
  async exportNow(ids: string[] | 'full'): Promise<void> {
    const t0 = Date.now();
    // Handles in the logs are named only for contributors public right now (a lobby seat's log keeps the handle it
    // showed then, even after its contributor hid). Read fresh for every export; if that fails, name nobody.
    const publicIds = await this.contributors.publicIds().catch((e) => {
      this.log(`export: contributor visibility unavailable, no handles exported: ${(e as Error).message}`);
      return new Set<string>();
    });
    const ctx = this.context(undefined, publicIds);
    const b = builder(ctx, this.methodology);
    let files = 0;
    const written = new Set<string>();
    const write = (path: string, data: unknown) => {
      const full = join(this.siteDir, path);
      // Paths carry event ids, seat names and set codes: never write outside the served tree.
      if (!full.startsWith(join(this.siteDir, '/'))) throw new Error(`export path escapes the site directory: ${path}`);
      const tmp = `${full}.tmp-${process.pid}`;
      // Every value through the scrubber every public output uses (public-text.ts); moderation is already in the logs.
      const body = serialize(typeof data === 'string' ? data : scrubPublic(data));
      // Another process (the CLI's `approve`, `export`) may be re-exporting the same event and remove its folder
      // between our mkdir and write: make the folder again and retry.
      for (let attempt = 1; ; attempt++) {
        try {
          mkdirSync(dirname(full), { recursive: true });
          writeFileSync(tmp, body);
          renameSync(tmp, full);
          break;
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ENOENT' || attempt >= 5) throw e;
        }
      }
      written.add(path);
      files++;
    };

    // Two things in an event's files depend on other events: seat identities (an alias resolves to an exact
    // model id once some transcript reports it) and card rarities (pooled from every log that records them).
    // Re-export every event whose identity keys or card rarities changed since the last export.
    const sig = signatures(ctx);
    const targets = new Set<string>(ids === 'full' ? ctx.events.map((e) => e.id) : ids);
    if (ids !== 'full') {
      for (const [id, key] of sig.identities) if (this.lastSig.identities.has(id) && this.lastSig.identities.get(id) !== key) targets.add(id);
      const changed = new Set([...sig.rarities].filter(([n, r]) => this.lastSig.rarities.get(n) !== r).map(([n]) => n));
      if (changed.size) {
        for (const ev of ctx.events) {
          if (targets.has(ev.id)) continue;
          const names = [...ev.picks.flatMap((p) => p.contents), ...[...ev.decks.values()].flatMap((d) => [...d.main, ...d.sideboard]), ...ev.packs.flatMap((p) => (p.swaps ?? []).flatMap((x) => [x.from, x.to]))];
          if (names.some((n) => changed.has(n))) targets.add(ev.id);
        }
      }
    }
    // Set files show pooled rarities too; there are few sets, so rewrite them all when any rarity changed.
    const raritiesChanged = [...sig.rarities].some(([n, r]) => this.lastSig.rarities.get(n) !== r);
    const sets = new Set<string>(ids === 'full' || raritiesChanged ? ctx.sets : []);

    for (const id of targets) {
      const ev = ctx.events.find((e) => e.id === id);
      // maxRetries: a concurrent export (another process) may add a file while the folder is being removed (ENOTEMPTY).
      rmSync(join(this.siteDir, 'events', id), { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      if (!ev) {
        rmSync(join(this.siteDir, 'events', `${id}.json`), { force: true });
        const code = this.setOf.get(id);
        if (code) sets.add(code);
        continue;
      }
      writeEvent(b, ev, write);
      sets.add(ev.set.code.toUpperCase());
    }
    // Sets that lost their last event (takedown): drop their file.
    for (const code of sets) {
      if (ctx.sets.includes(code)) writeSet(b, code, write);
      else if (SET_CODE_RE.test(code)) rmSync(join(this.siteDir, 'sets', `${code}.json`), { force: true });
    }
    const index = b.index();
    write('index.json', index);
    // 2.9: the small file Home, Watch and Learn read (the same as export.ts writeIndex).
    write('summary.json', b.summaryOf(index));
    if (this.methodology) write('methodology.md', this.methodology.text);
    // 2.8: model files and highlights depend on every event: rewrite them with the index.
    writeDerived(b, write);

    if (ids === 'full') this.pruneStale(ctx, b, written);
    this.lastSig = sig;
    const nRatings = await writeRatings(this.sql, index.boards);
    for (const code of sets) await writeCardStats(this.sql, ctx, code);
    // Points depend on every accepted event (bounties, repeats): rebuild the ledger and contributors files.
    await this.contributors.refresh();
    this.lastExport = { at: new Date().toISOString(), files, ms: Date.now() - t0, events: ctx.events.length };
    this.log(`export: ${files} file(s) for ${ids === 'full' ? 'all events' : `${targets.size} event(s)`} and ${sets.size} set(s), ${nRatings} rating rows in ${Date.now() - t0} ms`);
  }

  /** After a full export: remove files of events and sets that no longer exist. */
  private pruneStale(ctx: Ctx, b: ReturnType<typeof builder>, written: Set<string>): void {
    const keep = new Set<string>(written);
    for (const ev of ctx.events) for (const p of eventFilePaths(b, ev)) keep.add(p);
    for (const p of derivedFilePaths(b)) keep.add(p);
    const walk = (rel: string) => {
      const abs = join(this.siteDir, rel);
      if (!existsSync(abs)) return;
      for (const entry of readdirSync(abs, { withFileTypes: true })) {
        const p = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(p);
        else if (!keep.has(p)) rmSync(join(this.siteDir, p), { force: true });
      }
    };
    walk('events');
    walk('sets');
    walk('models');
  }
}

/** How many notes or deck names in a log the content filter flags (public-text.ts flagText). */
function flaggedItems(log: string): number {
  let n = 0;
  for (const line of log.split('\n')) {
    if (!line || !/"(note|analysis|archetype|deck_name)"/.test(line)) continue;
    try {
      const r = JSON.parse(line) as Record<string, unknown>;
      if (!noteItem(r)) continue;
      if (['note', 'analysis', 'archetype', 'deck_name'].some((k) => typeof r[k] === 'string' && flagText(r[k] as string).length)) n++;
    } catch {
      // malformed lines are the checks' business
    }
  }
  return n;
}

/**
 * Run folders written before PTS-4 carry the uploader's handle in source.json (`submitter`): replace it with the
 * Hub id (as sourceJson writes it now). The next export then drops it from the public files.
 */
function scrubSource(dir: string, contributorId: number | null): void {
  const file = join(dir, 'source.json');
  try {
    const src = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    if (!('submitter' in src)) return;
    delete src.submitter;
    if (contributorId != null) src.submitter_id = String(contributorId);
    writeFileSync(file, JSON.stringify(src, null, 1));
  } catch {
    // no source.json (not ours) or unreadable: loadEvent reports it
  }
}

interface Signatures {
  /** Event id → its LLM seats' identity keys. */
  identities: Map<string, string>;
  /** Card name → rarity, pooled exactly like JsonBuilder does (first event in ctx order that logged it). */
  rarities: Map<string, string>;
}

function signatures(ctx: Ctx): Signatures {
  const ids = new Identities(ctx.events);
  const identities = new Map<string, string>();
  for (const ev of ctx.events) identities.set(ev.id, ev.seats.filter((s) => s.llm).map((s) => ids.of(ev, s.name).key).join('|'));
  const rarities = new Map<string, string>();
  for (const ev of ctx.events) {
    for (const p of ev.picks) p.rarities?.forEach((r, i) => p.contents[i] && !rarities.has(p.contents[i]!) && rarities.set(p.contents[i]!, r));
  }
  return { identities, rarities };
}
