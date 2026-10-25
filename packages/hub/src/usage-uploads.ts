/**
 * Usage uploads for hosted seats: POST /api/usage (docs/SITE-DATA.md "Usage uploads", METHODOLOGY §2).
 *
 * A hosted Director hands the Hub its events without harness logs (it never sees them), so every hosted seat was
 * Self-Reported. After the event, the bench CLI that started the seats sends each seat's usage summary
 * (packages/director/src/usage-upload.ts: model ids, token counts, the logged effort, the harness version). The Hub:
 *   - takes it only for events a hosted Director handed off (via 'director'), received and not withdrawn or rejected;
 *   - only from whoever seated those seats: a lobby seat's own contributor, the organizer of a contributor's Private
 *     Table, or the Hub admin token for admin-organized tables;
 *   - only for seats whose bundle carries no usage of its own, in the closed, bounded format, naming each seat's
 *     declared harness, model and effort as the event recorded them;
 *   - stores it (seat_usage, and the bundle store) and writes usage-<seat>.json into the run folder at every ingest,
 *     marked self-attested (`evidence.kind: "cli-local-logs"`, `self_attested: true`). An ingested event is
 *     re-ingested at once, so the export shows "Checked Against Logs" when the logs show the declared model; a held
 *     one picks it up when it is approved.
 * A re-send by the same sender replaces that seat's summary (identical: no change); another sender is refused.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readEventStart } from '../../director/src/bundle.js';
import { EVENT_ID_RE, unpackTarGz } from '../../director/src/submissions.js';
import { usageFileFromUpload, validateUsageUpload, type UploadSeat } from '../../director/src/usage-upload.js';
import { registry } from '../../registry/src/index.js';
import type { Sql } from './db.js';
import type { Hub } from './hub.js';
import { sha256 } from './store.js';

/** Who is sending: a contributor (their token) or the Hub admin token. */
export type UsageSender = { contributorId: number } | 'admin';

export interface UsageResult { http: number; body: Record<string, unknown> }

/** The usage-<seat>.json files uploaded for an event, for its run folder (ingest, rematerialize). */
export async function uploadedUsageFiles(sql: Sql, eventId: string): Promise<Map<string, Buffer>> {
  const rows = await sql`select seat_name, body, uploaded_by, received_at, updated_at from seat_usage where event_id = ${eventId} order by seat_name`;
  const out = new Map<string, Buffer>();
  for (const r of rows) {
    const file = usageFileFromUpload(r.body as UploadSeat, r.uploaded_by === 'admin' ? 'admin' : 'contributor', new Date(r.updated_at as string).toISOString());
    out.set(`usage-${String(r.seat_name)}.json`, Buffer.from(JSON.stringify(file, null, 1)));
  }
  return out;
}

/** event_start and the bundle's own file names: from the run folder when the event is materialized, else the bundle. */
async function eventFacts(hub: Hub, eventId: string, bundleSha: string): Promise<{ start: any; files: Set<string> } | null> {
  const dir = join(hub.runsDir, eventId);
  const manifest = join(dir, 'bundle-manifest.json');
  if (existsSync(join(dir, 'events.jsonl')) && existsSync(manifest)) {
    const start = readEventStart(dir);
    const files = new Set(Object.keys(JSON.parse(readFileSync(manifest, 'utf8')).files ?? {}));
    return start ? { start, files } : null;
  }
  const unpacked = unpackTarGz(await hub.store.get(bundleSha));
  const log = unpacked.get('events.jsonl');
  if (!log) return null;
  const nl = log.indexOf(0x0a);
  try {
    const start = JSON.parse(log.subarray(0, nl < 0 ? log.length : nl).toString('utf8'));
    return start?.type === 'event_start' ? { start, files: new Set(unpacked.keys()) } : null;
  } catch {
    return null;
  }
}

/** Whether `who` seated `seat` at this hosted event (what the Hub trusts from the Director's own log). */
export function seatedBy(start: any, seat: string, who: UsageSender): boolean {
  const lobby = start.table?.kind === 'lobby';
  if (who === 'admin') return !lobby && start.organizer?.kind !== 'contributor';
  if (lobby) {
    const s = (start.seats ?? []).find((x: any) => x?.name === seat);
    return s?.contributor_id != null && Number(s.contributor_id) === who.contributorId;
  }
  return start.organizer?.kind === 'contributor' && Number(start.organizer.contributor_id) === who.contributorId;
}

export async function receiveUsage(hub: Hub, who: UsageSender, body: unknown): Promise<UsageResult> {
  const eventId = body && typeof body === 'object' ? (body as { event_id?: unknown }).event_id : undefined;
  if (typeof eventId !== 'string' || !EVENT_ID_RE.test(eventId)) return { http: 400, body: { error: 'the body must be JSON { version, event_id, seats } (packages/director/src/usage-upload.ts)' } };
  const [sub] = await hub.sql`
    select id, via, status, bundle_sha256 from submissions
    where event_id = ${eventId} and status not in ('rejected') order by id desc limit 1`;
  if (!sub) {
    return { http: 404, body: { error: `the Hub hasn't received event ${eventId} from its Director yet; send the usage again in a minute`, retry_after_s: 60 } };
  }
  if (sub.via !== 'director') return { http: 400, body: { error: 'usage uploads are for hosted events; an uploaded bundle carries its own usage files (bench bundle)' } };
  if (sub.status === 'withdrawn') return { http: 410, body: { error: `event ${eventId} was taken down` } };
  const facts = await eventFacts(hub, eventId, String(sub.bundle_sha256));
  if (!facts) return { http: 409, body: { error: `event ${eventId}: its log can't be read` } };
  const v = validateUsageUpload(body, facts.start);
  if (!v.ok) return { http: 422, body: { error: v.error } };
  const notMine = v.upload.seats.filter((s) => !seatedBy(facts.start, s.seat, who)).map((s) => s.seat);
  if (notMine.length) {
    return { http: 403, body: { error: `${notMine.join(', ')}: not seated by you at this event (a lobby seat's own contributor, a Private Table's organizer, or the Hub admin for admin tables)` } };
  }
  const inBundle = v.upload.seats.filter((s) => facts.files.has(`usage-${s.seat}.json`)).map((s) => s.seat);
  if (inBundle.length) return { http: 409, body: { error: `${inBundle.join(', ')}: the event's bundle has this seat's usage already` } };

  const uploadedBy = who === 'admin' ? 'admin' : 'contributor';
  const contributorId = who === 'admin' ? null : who.contributorId;
  const result: Record<string, string> = {};
  const checks: Record<string, string> = {};
  let changed = false;
  for (const s of v.upload.seats) {
    const raw = Buffer.from(JSON.stringify(s));
    const digest = sha256(raw);
    const [prev] = await hub.sql`select contributor_id, uploaded_by, body_sha256 from seat_usage where event_id = ${eventId} and seat_name = ${s.seat}`;
    if (prev && (prev.uploaded_by !== uploadedBy || (prev.contributor_id == null ? null : Number(prev.contributor_id)) !== contributorId)) {
      return { http: 409, body: { error: `seat ${s.seat}: its usage was sent by someone else` } };
    }
    const declared = registry.verifySeatModel({ model: s.model, harness: s.harness, at: facts.start.t }, { model_ids: s.model_ids, ...(s.model_output_tokens ? { model_output_tokens: s.model_output_tokens } : {}) });
    checks[s.seat] = declared.status;
    if (prev && prev.body_sha256 === digest) {
      result[s.seat] = 'unchanged';
      continue;
    }
    await hub.store.put(raw);
    await hub.sql`
      insert into seat_usage (event_id, seat_name, contributor_id, uploaded_by, body_sha256, body)
      values (${eventId}, ${s.seat}, ${contributorId}, ${uploadedBy}, ${digest}, ${hub.sql.json(s as never)})
      on conflict (event_id, seat_name) do update set body_sha256 = excluded.body_sha256, body = excluded.body, updated_at = now()`;
    result[s.seat] = prev ? 'replaced' : 'stored';
    changed = true;
  }
  // Ingested: re-ingest now (the run folder gets the usage files, the index and the export follow). Otherwise the
  // ingest that accepts the event (an approval) picks them up.
  let applied: 'now' | 'when the event is accepted' | 'unchanged' = changed ? 'when the event is accepted' : 'unchanged';
  if (changed && sub.status === 'ingested') {
    await hub.ingest(Number(sub.id));
    applied = 'now';
  }
  hub.log(`usage upload: ${eventId} ${Object.entries(result).map(([k, x]) => `${k} ${x}`).join(', ')} (${uploadedBy}${contributorId != null ? ` ${contributorId}` : ''})`);
  return {
    http: 200,
    body: {
      event_id: eventId, seats: result, model_check: checks, applied,
      evidence: { kind: 'cli-local-logs', self_attested: true },
    },
  };
}
