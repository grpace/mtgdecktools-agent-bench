/**
 * What the open dataset leaves out of a finished event's log (docs/OPEN-DATA.md "Privacy"). Hidden information (hands,
 * decklists, picks, the full text each agent saw) is released: the event is over and replays show it anyway. What
 * goes is anything that identifies a machine or a person:
 *
 * - contributor and admin ids, entry and table ids, uploader handles: replaced by the salted contributor key, plus
 *   the handle only for a contributor who is public now;
 * - API keys, seat tokens, Hub tokens, bearer tokens and JWTs, file paths, e-mail addresses and IP addresses (v4 and
 *   v6), wherever they appear (a rules report can quote the agent's own working folder);
 * - free text on picks, decks, decisions, play/draw and sideboarding records (`note`, `analysis`: seats answer with
 *   their choice only; public-text.ts withoutUnpublishedText), so a log from an older Director or a harness that sent
 *   one anyway publishes none. Rules reports keep their `note`;
 * - post-event bookkeeping (the Director's hand-off records).
 *
 * Harness transcripts and usage files are never read here: usage reaches the dataset only as the seats table's token
 * counts and cost. Moderation (hidden rules reports, archetypes and deck names, hidden handles, erased contributors) is already applied
 * to the Hub's run folders when they are written (hub.ts materialize), so the logs read here carry it.
 */
import { scrubText, withoutUnpublishedText } from '../../../director/src/public-text.js';

/** Records that are not part of the event (the Director's hand-off bookkeeping). */
export const DROPPED_RECORD_TYPES = new Set(['hub_handoff']);

/** Keys removed at any depth: ids and handles of people, tokens, machine details. */
export const DENIED_KEYS = new Set([
  'contributor_id', 'contributor', 'entry_id', 'table_id', 'submitter', 'submitter_id', 'handle', 'github', 'github_login',
  'token', 'token_id', 'seat_token', 'seat_url', 'owner', 'email', 'ip', 'client_ip', 'cwd', 'home', 'hostname', 'user',
]);

/**
 * Strings are scrubbed by the one scrubber every public output uses (packages/director/src/public-text.ts): API keys
 * and tokens, JWTs, e-mail and IP addresses (v4 and v6), file paths.
 */
export { scrubText };

/** Deep copy without denied keys, every string scrubbed. */
export function scrubValue(v: unknown): unknown {
  if (typeof v === 'string') return scrubText(v);
  if (Array.isArray(v)) return v.map(scrubValue);
  if (v === null || typeof v !== 'object') return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) if (!DENIED_KEYS.has(k)) out[k] = scrubValue(x);
  return out;
}

export interface SeatAttribution {
  /** The salted contributor key (packages/site scoring.ts contributorOf), or admin / unattributed. */
  key: string;
  /** Only for a contributor public now. */
  handle: string | null;
}

export interface RedactContext {
  /** Attribution per seat name (LLM seats). */
  seats: Map<string, SeatAttribution>;
  /** event_start.organizer.contributor_id → its key (a hosted Private Table), when there is one. */
  organizerKey?: string;
}

/** event_start with seats, organizer and table rewritten to keys (everything else then goes through scrubValue). */
function eventStart(rec: Record<string, any>, rc: RedactContext): Record<string, any> {
  const out = { ...rec };
  if (Array.isArray(rec.seats)) {
    out.seats = rec.seats.map((s: Record<string, any>) => {
      const a = rc.seats.get(String(s?.name));
      const { contributor: _c, contributor_id: _id, entry_id: _e, ...rest } = s ?? {};
      return { ...rest, ...(a ? { contributor_key: a.key, ...(a.handle ? { contributor_handle: a.handle } : {}) } : {}) };
    });
  }
  if (rec.organizer && typeof rec.organizer === 'object') {
    out.organizer = { kind: String(rec.organizer.kind ?? 'unknown'), ...(rc.organizerKey ? { contributor_key: rc.organizerKey } : {}) };
  }
  if (rec.table && typeof rec.table === 'object') {
    const { kind, queue, schedule, continuous } = rec.table as Record<string, unknown>;
    out.table = { ...(kind != null ? { kind } : {}), ...(queue != null ? { queue } : {}), ...(schedule != null ? { schedule } : {}), ...(continuous != null ? { continuous } : {}) };
  }
  return out;
}

/** The redacted log: one JSON object per line; malformed lines are dropped. */
export function redactLog(text: string, rc: RedactContext): string {
  const out: string[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let rec: Record<string, any>;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (!rec || typeof rec !== 'object' || DROPPED_RECORD_TYPES.has(rec.type)) continue;
    const r = rec.type === 'event_start' ? eventStart(rec, rc) : withoutUnpublishedText(rec);
    // Keys event_start rewrote on purpose (contributor_key, contributor_handle) are not in DENIED_KEYS.
    out.push(JSON.stringify(scrubValue(r)));
  }
  return out.length ? `${out.join('\n')}\n` : '';
}

/** Record types whose `text` is the full view an agent saw (decision-texts files). */
export const TEXT_RECORD_TYPES = new Set(['decision_offered', 'decision_refreshed', 'build_offered', 'sideboard_offered', 'play_draw_offered', 'deck_review_offered']);
