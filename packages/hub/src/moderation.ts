/**
 * Moderation and erasure on the Hub (docs/legal/CONTENT-POLICY.md, docs/SECURITY.md "Moderation and erasure").
 *
 * - **Hides:** a single agent note (event, seat, note key), a deck name, or a contributor's handle (force-hidden: the
 *   contributor can't show it again). Public outputs show `[Removed by moderators]` (public-text.ts) or no handle.
 * - **Rebuild:** every hide re-materializes the events it touches from their stored bundles (hub.ts applies the list
 *   when it writes a run folder), re-exports them and asks for an early open-data rebuild. Hosted Directors pick the
 *   list up from GET /api/internal/moderation within a minute and drop or rewrite what they serve.
 * - **Review queue:** the filter (public-text.ts flagText / flagHandle) flags notes, deck names and handles. Flagged
 *   text stays published but is never featured automatically; a reviewer keeps it or hides it.
 * - **Erasure:** a contributor's identity is removed from the Hub (GitHub id, login, avatar, handle, tokens) and their
 *   Hub id is replaced in every event log by an anonymous id, so earlier exports can't be joined to the new ones.
 * - **Log:** every action goes to `moderation_log` with who, when, what and why.
 */
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { compileModeration, flagHandle, flagText, isRemovedText, noteItem, type CompiledModeration, type ModerationList } from '../../director/src/public-text.js';
import type { Sql } from './db.js';
import type { Hub } from './hub.js';

export type Actor = string;

export async function logAction(sql: Sql, actor: Actor, action: string, target: Record<string, unknown>, reason: string | null): Promise<void> {
  await sql`insert into moderation_log (actor, action, target, reason) values (${actor}, ${action}, ${sql.json(target as any)}, ${reason})`;
}

/** Event ids taken down (withdrawn and not re-accepted since). */
export async function takedownIds(sql: Sql): Promise<string[]> {
  const rows = await sql`
    select distinct s.event_id from submissions s
    where s.status = 'withdrawn' and s.event_id is not null and not exists (select 1 from events e where e.id = s.event_id)
    order by s.event_id`;
  return rows.map((r) => String(r.event_id));
}

/** The whole list, as hosted Directors and the Hub's own run folders apply it. */
export async function moderationList(sql: Sql): Promise<ModerationList> {
  const [hides, hidden, erased, takedowns] = await Promise.all([
    sql`select kind, event_id, seat, item from moderation_hides order by id`,
    sql`select id from contributors where moderation_hidden is not null and status <> 'erased' order by id`,
    sql`select contributor_id, anon_id from erasures order by contributor_id`,
    takedownIds(sql),
  ]);
  const body = {
    takedowns,
    hides: hides.map((h) => ({ kind: h.kind as 'note' | 'deck_name', event: String(h.event_id), seat: String(h.seat), item: String(h.item) })),
    hiddenHandles: hidden.map((r) => String(r.id)),
    erased: erased.map((r) => ({ id: String(r.contributor_id), anon: String(r.anon_id) })),
  };
  return { version: createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 16), ...body };
}

export async function loadModeration(sql: Sql): Promise<CompiledModeration> {
  return compileModeration(await moderationList(sql));
}

// ---------------------------------------------------------------------------
// Review queue

const excerpt = (s: string) => (s.length > 300 ? `${s.slice(0, 297)}…` : s);

/**
 * Flag what the filter catches in one event's log (notes, deck details, rules reports, deck names). Idempotent: a flag
 * that exists keeps its review status. Returns how many items the filter flagged (new or not).
 */
export async function scanLog(sql: Sql, eventId: string, logText: string): Promise<number> {
  const rows: Array<Record<string, unknown>> = [];
  for (const line of logText.split('\n')) {
    if (!line || !/"(note|analysis|archetype|deck_name)"/.test(line)) continue;
    let r: Record<string, any>;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    const n = noteItem(r);
    if (!n) continue;
    const text = ['note', 'analysis', 'archetype'].map((k) => r[k]).filter((v): v is string => typeof v === 'string' && !!v && !isRemovedText(v)).join(' · ');
    const reasons = flagText(text);
    if (reasons.length) rows.push({ key: `note|${eventId}|${n.seat}|${n.item}`, kind: 'note', event_id: eventId, seat: n.seat, item: n.item, excerpt: excerpt(text), reasons });
    if (r.type === 'deck_built' && typeof r.deck_name === 'string' && !isRemovedText(r.deck_name)) {
      const dr = flagText(r.deck_name);
      if (dr.length) rows.push({ key: `deck_name|${eventId}|${n.seat}`, kind: 'deck_name', event_id: eventId, seat: n.seat, item: '', excerpt: excerpt(r.deck_name), reasons: dr });
    }
  }
  for (const row of rows) await sql`insert into moderation_flags ${sql(row)} on conflict (key) do nothing`;
  return rows.length;
}

/** Flag a handle the filter catches (offensive words, impersonation). */
export async function scanHandle(sql: Sql, contributorId: number, handle: string): Promise<boolean> {
  const reasons = flagHandle(handle);
  if (!reasons.length) return false;
  await sql`
    insert into moderation_flags (key, kind, contributor_id, excerpt, reasons)
    values (${`handle|${contributorId}|${handle}`}, 'handle', ${contributorId}, ${handle}, ${reasons}) on conflict (key) do nothing`;
  return true;
}

export interface FlagRow {
  id: number; kind: string; event_id: string | null; seat: string | null; item: string | null; contributor_id: number | null;
  excerpt: string; reasons: string[]; status: string; created_at: Date;
}

export async function reviewQueue(sql: Sql, status = 'open', limit = 200): Promise<FlagRow[]> {
  const rows = await sql`select id, kind, event_id, seat, item, contributor_id, excerpt, reasons, status, created_at from moderation_flags where status = ${status} order by id limit ${limit}`;
  return rows.map((r) => ({ ...r, id: Number(r.id), contributor_id: r.contributor_id == null ? null : Number(r.contributor_id) })) as unknown as FlagRow[];
}

// ---------------------------------------------------------------------------
// Actions (each logged, each followed by a rebuild of what it touches)

export interface NoteTarget { event: string; seat: string; item: string }

/** Rebuild after a change: re-materialize and re-export the events, refresh boards, early open-data rebuild. */
async function rebuild(hub: Hub, eventIds: string[], why: string): Promise<void> {
  await hub.remoderate(eventIds, why);
}

export async function hideNote(hub: Hub, actor: Actor, t: NoteTarget, reason: string): Promise<void> {
  await requireEvent(hub, t.event);
  await hub.sql`insert into moderation_hides (kind, event_id, seat, item, reason, created_by) values ('note', ${t.event}, ${t.seat}, ${t.item}, ${reason}, ${actor}) on conflict do nothing`;
  await hub.sql`update moderation_flags set status = 'hidden', reviewed_by = ${actor}, reviewed_at = now() where key = ${`note|${t.event}|${t.seat}|${t.item}`}`;
  await logAction(hub.sql, actor, 'hide_note', { ...t }, reason);
  await rebuild(hub, [t.event], 'a note was hidden');
}

export async function hideDeckName(hub: Hub, actor: Actor, t: { event: string; seat: string }, reason: string): Promise<void> {
  await requireEvent(hub, t.event);
  await hub.sql`insert into moderation_hides (kind, event_id, seat, item, reason, created_by) values ('deck_name', ${t.event}, ${t.seat}, '', ${reason}, ${actor}) on conflict do nothing`;
  await hub.sql`update moderation_flags set status = 'hidden', reviewed_by = ${actor}, reviewed_at = now() where key = ${`deck_name|${t.event}|${t.seat}`}`;
  await logAction(hub.sql, actor, 'hide_deck_name', { ...t }, reason);
  await rebuild(hub, [t.event], 'a deck name was hidden');
}

/** Undo a hide (by its id): the text is public again after the rebuild. */
export async function unhide(hub: Hub, actor: Actor, id: number, reason: string): Promise<void> {
  const [h] = await hub.sql`delete from moderation_hides where id = ${id} returning kind, event_id, seat, item`;
  if (!h) throw new Error(`no hide ${id}`);
  await hub.sql`update moderation_flags set status = 'kept', reviewed_by = ${actor}, reviewed_at = now() where key = ${h.kind === 'note' ? `note|${h.event_id}|${h.seat}|${h.item}` : `deck_name|${h.event_id}|${h.seat}`}`;
  await logAction(hub.sql, actor, 'unhide', { id, kind: h.kind, event: h.event_id, seat: h.seat, item: h.item }, reason);
  await rebuild(hub, [String(h.event_id)], 'a hide was undone');
}

export async function listHides(sql: Sql): Promise<Array<Record<string, unknown>>> {
  return [...await sql`select id, kind, event_id, seat, item, reason, created_by, created_at from moderation_hides order by id`];
}

async function contributorByHandle(sql: Sql, handle: string): Promise<{ id: number; handle: string; kind: string; status: string }> {
  const [c] = await sql`select id, handle, kind, status from contributors where handle = ${handle.toLowerCase()}`;
  if (!c) throw new Error(`no contributor ${handle}`);
  return { id: Number(c.id), handle: String(c.handle), kind: String(c.kind), status: String(c.status) };
}

/** Events that name a contributor: uploaded by them, seated by them in the lobby, or organized by them. */
export function eventsOf(hub: Hub, contributorId: number): string[] {
  const id = String(contributorId);
  return [...hub.events.values()]
    .filter((ev) => ev.source.submitterId === id || ev.seats.some((s) => s.contributorId === id) || ev.organizer?.contributorId === id)
    .map((ev) => ev.id);
}

/**
 * Ban a contributor we suspect of faking or manipulating results (owner decision, 2026-10-24: uploads are trusted,
 * and can be invalidated later). Suspends the account, so every token stops working at once and sign-in is refused
 * (device flow and /account), excludes from the ratings every event they uploaded or ran as a Private Table, and at
 * lobby tables excludes only their seats' games (the other contributors' games stand). Points are recomputed.
 * Reversible: `contributor activate`, then `include` / `include-seats` (logged like every moderation action).
 */
export async function banContributor(hub: Hub, actor: Actor, handle: string, reason: string): Promise<{ contributorId: number; events: string[]; seats: Array<{ event: string; seats: string[] }> }> {
  const sql = hub.sql;
  const c = await contributorByHandle(sql, handle);
  if (c.kind !== 'person') throw new Error(`${handle} is a ${c.kind} account, not a person`);
  const id = String(c.id);
  await sql`update contributors set status = 'suspended', session_epoch = session_epoch + 1 where id = ${c.id}`;
  const events: string[] = [];
  const seats: Array<{ event: string; seats: string[] }> = [];
  for (const e of eventsOf(hub, c.id)) {
    const ev = hub.events.get(e);
    if (!ev) continue;
    const own = ev.source.submitterId === id || (ev.organizer?.contributorId === id && ev.table?.kind !== 'lobby');
    if (own) {
      await hub.setExcluded(e, `contributor banned: ${reason}`);
      events.push(e);
    } else {
      const mine = ev.seats.filter((s) => s.contributorId === id).map((s) => s.name);
      if (!mine.length) continue;
      await hub.setSeatsExcluded(e, Object.fromEntries(mine.map((s) => [s, `contributor banned: ${reason}`])));
      seats.push({ event: e, seats: mine });
    }
  }
  await logAction(sql, actor, 'ban_contributor', { contributor_id: c.id, handle, events, seats }, reason);
  await hub.contributors.refresh();
  return { contributorId: c.id, events, seats };
}

/** Force-hide a handle (or show it again): no public output names it, whatever the contributor's own setting. */
export async function setHandleHidden(hub: Hub, actor: Actor, handle: string, hidden: boolean, reason: string): Promise<void> {
  const c = await contributorByHandle(hub.sql, handle);
  await hub.sql`update contributors set moderation_hidden = ${hidden ? reason : null} where id = ${c.id}`;
  await hub.sql`update moderation_flags set status = ${hidden ? 'hidden' : 'kept'}, reviewed_by = ${actor}, reviewed_at = now() where kind = 'handle' and contributor_id = ${c.id} and status = 'open'`;
  await logAction(hub.sql, actor, hidden ? 'hide_handle' : 'show_handle', { contributor_id: c.id, handle: c.handle }, reason);
  await rebuild(hub, eventsOf(hub, c.id), hidden ? 'a handle was hidden' : 'a handle may be shown again');
  hub.visibilityChanged(c.id);
}

/** Decide a flag: keep (published, still never featured automatically) or hide (as the matching hide action). */
export async function reviewFlag(hub: Hub, actor: Actor, id: number, decision: 'keep' | 'hide', reason: string): Promise<void> {
  const [f] = await hub.sql`select kind, event_id, seat, item, contributor_id, status from moderation_flags where id = ${id}`;
  if (!f) throw new Error(`no flag ${id}`);
  if (decision === 'keep') {
    await hub.sql`update moderation_flags set status = 'kept', reviewed_by = ${actor}, reviewed_at = now() where id = ${id}`;
    await logAction(hub.sql, actor, 'keep_flag', { flag: id, kind: f.kind, event: f.event_id, seat: f.seat, item: f.item, contributor_id: f.contributor_id }, reason);
    return;
  }
  if (f.kind === 'note') return hideNote(hub, actor, { event: String(f.event_id), seat: String(f.seat), item: String(f.item) }, reason);
  if (f.kind === 'deck_name') return hideDeckName(hub, actor, { event: String(f.event_id), seat: String(f.seat) }, reason);
  const [c] = await hub.sql`select handle from contributors where id = ${f.contributor_id as number}`;
  if (!c) throw new Error(`flag ${id}: contributor ${f.contributor_id} is gone`);
  return setHandleHidden(hub, actor, String(c.handle), true, reason);
}

async function requireEvent(hub: Hub, eventId: string): Promise<void> {
  const [e] = await hub.sql`select 1 from events where id = ${eventId}`;
  if (!e) throw new Error(`no ingested event ${eventId}`);
}

/**
 * Every agent note of one event with its key (for `hub moderation notes`), read from the stored run folder.
 * Optionally only one seat's, or only text containing `grep`.
 */
export function eventNotes(hub: Hub, eventId: string, opts: { seat?: string; grep?: string } = {}): Array<{ seat: string; item: string; type: string; text: string; flagged: string[] }> {
  const out: Array<{ seat: string; item: string; type: string; text: string; flagged: string[] }> = [];
  let raw: string;
  try {
    raw = readFileSync(join(hub.runsDir, eventId, 'events.jsonl'), 'utf8');
  } catch {
    throw new Error(`no ingested event ${eventId}`);
  }
  const g = opts.grep?.toLowerCase();
  for (const line of raw.split('\n')) {
    if (!line || !/"(note|analysis|deck_name)"/.test(line)) continue;
    const r = JSON.parse(line) as Record<string, any>;
    const n = noteItem(r);
    if (!n || (opts.seat && n.seat !== opts.seat)) continue;
    const parts = [r.deck_name ? `deck name: ${r.deck_name}` : '', ...['note', 'analysis', 'archetype'].map((k) => (typeof r[k] === 'string' && r[k] ? String(r[k]) : ''))].filter(Boolean);
    const text = parts.join(' · ');
    if (!text || (g && !text.toLowerCase().includes(g))) continue;
    out.push({ seat: n.seat, item: n.item, type: String(r.type), text, flagged: flagText(text) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Erasure

export interface ErasureResult {
  contributorId: number;
  anon: string;
  /** Events re-materialized with the anonymous id. */
  anonymized: string[];
  /** Events taken down (--remove-events: their own uploads and Private Tables). */
  removed: string[];
}

/**
 * Erase a contributor: delete their identity (GitHub id, login, avatar, handle, tokens, claimed uploader name),
 * replace their Hub id in every event log with an anonymous id, recompute points and rebuild every public output.
 * With removeEvents, events they uploaded or organized are taken down (bundles purged) instead of anonymized; lobby
 * tables they sat at with others are always anonymized, never removed. What remains: docs/legal/PRIVACY.md "Erasure".
 */
export async function eraseContributor(hub: Hub, actor: Actor, handle: string, reason: string, opts: { removeEvents?: boolean } = {}): Promise<ErasureResult> {
  const sql = hub.sql;
  const c = await contributorByHandle(sql, handle);
  if (c.kind !== 'person') throw new Error(`${handle} is a ${c.kind} account, not a person`);
  if (c.status === 'erased') throw new Error(`${handle} is already erased`);
  const id = String(c.id);
  const involved = eventsOf(hub, c.id);
  const own = new Set(involved.filter((e) => {
    const ev = hub.events.get(e);
    return !!ev && (ev.source.submitterId === id || (ev.organizer?.contributorId === id && ev.table?.kind !== 'lobby'));
  }));
  const anon = `erased-${randomBytes(6).toString('hex')}`;
  await sql.begin(async (tx) => {
    await tx`insert into erasures (contributor_id, anon_id) values (${c.id}, ${anon})`;
    await tx`
      update contributors set handle = ${`erased-${c.id}`}, github_id = null, github_login = null, avatar_url = null, github_created_at = null,
        note = null, status = 'erased', board_visibility = 'hidden', moderation_hidden = null, erased_at = now(), last_login_at = null,
        session_epoch = session_epoch + 1, play_concurrent = null, play_daily = null, lobby_concurrent = null, lobby_daily = null
      where id = ${c.id}`;
    await tx`delete from tokens where contributor_id = ${c.id}`;
    await tx`update submissions set submitter_claimed = null where contributor_id = ${c.id}`;
    await tx`delete from moderation_flags where kind = 'handle' and contributor_id = ${c.id}`;
    // The log names the account by its Hub id only: the handle is part of what is erased.
    await tx`update moderation_log set target = target - 'handle' where target->>'contributor_id' = ${id}`;
    await tx`insert into moderation_log (actor, action, target, reason) values (${actor}, 'erase_contributor', ${tx.json({ contributor_id: c.id, remove_events: !!opts.removeEvents, events: involved.length })}, ${reason})`;
  });
  const removed: string[] = [];
  if (opts.removeEvents) {
    for (const e of own) {
      await hub.takedown(e, `contributor erasure: ${reason}`, true, actor);
      removed.push(e);
    }
  }
  const anonymized = involved.filter((e) => !removed.includes(e));
  await hub.remoderate(anonymized, 'a contributor was erased');
  hub.visibilityChanged(c.id);
  return { contributorId: c.id, anon, anonymized, removed };
}

export async function moderationLog(sql: Sql, limit = 100): Promise<Array<Record<string, unknown>>> {
  return [...await sql`select id, at, actor, action, target, reason from moderation_log order by id desc limit ${limit}`];
}
