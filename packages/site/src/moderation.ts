/**
 * The Hub's moderation list applied to parsed events, for exports built from a Director's own run folders (build-data:
 * the hosted Director's `/data`). The Hub applies the same list to the logs it stores (packages/hub hub.ts), so its
 * export needs nothing here. Keys and rules: packages/director/src/public-text.ts (moderateRecord does the same to raw
 * records). Also: every export file goes through scrubPublic, the scrubber every public output uses.
 */
import { REMOVED_TEXT, scrubText, type CompiledModeration } from '../../director/src/public-text.js';
import type { EventData } from './data.js';

/** Hide, anonymize and scrub one event in place (call before building any export from it). */
export function moderateEvent(ev: EventData, c: CompiledModeration): void {
  const hidden = (seat: string | null | undefined, item: string) => !!seat && c.notes.has(`${ev.id}\u0000${seat}\u0000${item}`);
  const text = (seat: string | null | undefined, item: string, note: string): string =>
    note === '' ? note : hidden(seat, item) ? REMOVED_TEXT : scrubText(note);
  // Every rules report is scrubbed; hidden ones are replaced.
  for (const g of ev.games) for (const r of g.rulesIssues) r.note = text(r.seat, `rules-${r.t}`, r.note);
  for (const r of ev.rulesIssues) r.note = text(r.seat, `rules-${r.t}`, r.note);
  // Handles moderators hid are dropped; erased contributors are named by their anonymous id, with no handle.
  for (const s of ev.seats) {
    if (!s.contributorId) continue;
    const anon = c.erased.get(s.contributorId);
    if (anon) s.contributorId = anon;
    if (anon || c.hiddenHandles.has(s.contributorId)) delete s.contributorHandle;
  }
  if (ev.organizer?.contributorId) {
    const anon = c.erased.get(ev.organizer.contributorId);
    if (anon) ev.organizer.contributorId = anon;
    if (anon || c.hiddenHandles.has(ev.organizer.contributorId)) delete ev.organizer.handle;
  }
  if (ev.source.submitterId) {
    const anon = c.erased.get(ev.source.submitterId);
    if (anon) {
      ev.source.submitterId = anon;
      delete ev.source.submitter;
    }
  }
}

/** Events with taken-down ones removed, the rest moderated in place. */
export function moderateEvents(events: EventData[], c: CompiledModeration): EventData[] {
  const kept = events.filter((ev) => !c.takedowns.has(ev.id));
  for (const ev of kept) moderateEvent(ev, c);
  return kept;
}
