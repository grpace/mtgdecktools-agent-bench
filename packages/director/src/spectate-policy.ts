/**
 * Spectator fairness policy: what a live viewer may see of an event, and when (docs/SPECTATING.md).
 *
 * Shared by the Director's live stream (spectate.ts) and the report export (packages/site), which must
 * withhold the same information for events still in progress. Pure: no Node APIs.
 *
 * The threat: anyone can watch a public live event, including the operator of one seat or an agent
 * with web tools. Whatever the stream shows, one agent could be fed. So the stream only shows, at any
 * moment, what no still-competing seat could use: public game state live, decisions after a delay with
 * hidden card names redacted, and private information once nobody can benefit from it.
 */

/** When a draft pick (the card and the pack it came from) becomes visible. */
export type DraftReveal =
  /** When every pack of that round is empty: no pack it describes can still be picked from (default). */
  | 'round'
  /** When the whole draft is over. */
  | 'draft'
  /** When the drafter has no games left (bots: when the draft is over). Strictest. */
  | 'seat';

/** When a seat's private game information (its hand, what it saw, its deck) becomes visible. */
export type HiddenReveal =
  /** When the seat has no games left in the event: its deck can't help a future opponent (default). */
  | 'seat'
  /** When the game ends (weaker: a seat's hands in game 1 reveal its deck for game 2). */
  | 'game';

/** When a game decision's choice becomes visible (redacted until `hidden` allows the full text). Env: SPECTATE_NOTES. */
export type NotesReveal = { turns: number } | 'game' | 'seat';

export interface SpectateLimits {
  /** Concurrent live streams per client IP. */
  perIp: number;
  /** Concurrent live streams per event. */
  perEvent: number;
  /** Concurrent live streams on the server. */
  total: number;
  /** A stream is closed after this long; EventSource reconnects with Last-Event-ID (proxies cut long streams anyway). */
  maxStreamMs: number;
  /** Polling requests per IP per minute. */
  pollsPerMinute: number;
  /** Most messages returned by one poll (the client asks again for the rest). */
  pollBatch: number;
}

export interface SpectatePolicy {
  /** public: anyone; admin: admin token required; off: the live endpoints answer 404. */
  access: 'public' | 'admin' | 'off';
  draft: DraftReveal;
  /** When a decision's choice is released (SPECTATE_NOTES). */
  notes: NotesReveal;
  hidden: HiddenReveal;
  /** Broadcast delay for public game information (boards, log, clock), in ms. 0 = live. */
  delayMs: number;
  limits: SpectateLimits;
}

export const DEFAULT_SPECTATE_POLICY: SpectatePolicy = {
  access: 'public',
  draft: 'round',
  notes: { turns: 2 },
  hidden: 'seat',
  // Safe by default (SPEC-3): live game information reaches viewers 90 s behind the table, so an agent watching its
  // own game can't use the stream (e.g. who holds priority right now). SPECTATE_DELAY_S=0 turns it off (local runs).
  delayMs: 90_000,
  limits: { perIp: 4, perEvent: 200, total: 1000, maxStreamMs: 8 * 60_000, pollsPerMinute: 60, pollBatch: 1500 },
};

const num = (v: string | undefined, d: number): number => (v != null && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : d);

/**
 * SPECTATE=public|admin|off, SPECTATE_DRAFT=round|draft|seat, SPECTATE_NOTES=<turns>|game|seat,
 * SPECTATE_HIDDEN=seat|game, SPECTATE_DELAY_S, SPECTATE_MAX_PER_IP, SPECTATE_MAX_PER_EVENT, SPECTATE_MAX_TOTAL,
 * SPECTATE_POLLS_PER_MIN. Unknown values fall back to the default (the stricter choice is never silently loosened).
 */
export function spectatePolicyFromEnv(env: Record<string, string | undefined>): SpectatePolicy {
  const d = DEFAULT_SPECTATE_POLICY;
  const access = env.SPECTATE === 'off' || env.SPECTATE === 'admin' || env.SPECTATE === 'public' ? env.SPECTATE : d.access;
  const draft = env.SPECTATE_DRAFT === 'draft' || env.SPECTATE_DRAFT === 'seat' || env.SPECTATE_DRAFT === 'round' ? env.SPECTATE_DRAFT : d.draft;
  const hidden = env.SPECTATE_HIDDEN === 'game' || env.SPECTATE_HIDDEN === 'seat' ? env.SPECTATE_HIDDEN : d.hidden;
  let notes: NotesReveal = d.notes;
  const n = env.SPECTATE_NOTES?.trim();
  if (n === 'game' || n === 'seat') notes = n;
  else if (n && /^\d+$/.test(n)) notes = { turns: Math.max(1, Number(n)) };
  return {
    access,
    draft,
    notes,
    hidden,
    delayMs: Math.max(0, num(env.SPECTATE_DELAY_S, d.delayMs / 1000)) * 1000,
    limits: {
      ...d.limits,
      perIp: Math.max(1, num(env.SPECTATE_MAX_PER_IP, d.limits.perIp)),
      perEvent: Math.max(1, num(env.SPECTATE_MAX_PER_EVENT, d.limits.perEvent)),
      total: Math.max(1, num(env.SPECTATE_MAX_TOTAL, d.limits.total)),
      pollsPerMinute: Math.max(1, num(env.SPECTATE_POLLS_PER_MIN, d.limits.pollsPerMinute)),
    },
  };
}

/** Plain-language summary of the policy, shown to viewers (hello message, Watch page) and in exports. */
export function describePolicy(p: SpectatePolicy): { public: string; draft: string; decisions: string; hidden: string; decks: string } {
  const notes = p.notes === 'game' ? 'when the game ends' : p.notes === 'seat' ? 'when that seat has no games left' : `${p.notes.turns} turns after it was made`;
  return {
    public: p.delayMs ? `Boards, life totals and the game log, ${Math.round(p.delayMs / 1000)} s behind the table.` : 'Boards, life totals, the game log and who is on the clock, as they happen.',
    draft:
      p.draft === 'round'
        ? 'Picks and packs once every pack of that round is empty (live: who has picked, not what).'
        : p.draft === 'draft'
          ? 'Picks and packs once the draft is over.'
          : 'Picks and packs once the drafter has no games left (bots: after the draft).',
    decisions: `Each game decision’s choice ${notes}, with any card that is still hidden (in a hand or library) blanked out.`,
    hidden: p.hidden === 'seat' ? 'Hands and what each agent saw once that seat has no games left.' : 'Hands and what each agent saw when the game ends.',
    decks: 'Decklists and what each seat sideboarded once the seat has no games left; until then, the cards it has shown in play and its deck size.',
  };
}

// ---------------------------------------------------------------------------
// Decisions about hidden cards

/** Decision kinds whose choice is itself about hidden cards (what went to the bottom, what was kept on top, found…). */
const HIDDEN_CHOICE_KINDS = new Set(['ScryChoice', 'SurveilChoice', 'SearchChoice', 'EffectZoneChoice', 'DigChoice', 'RevealChoice', 'ManifestDreadChoice', 'ChooseFromLibrary']);

/**
 * True when a decision's choice reveals hidden cards whatever their names: bottoming cards after a mulligan, scry or
 * surveil, library searches, selections from hidden zones. Such choices wait for the hidden release:
 * blanking names is not enough when the card is a basic land whose name is public.
 */
export function isHiddenChoice(kind: string, choice: string): boolean {
  if (HIDDEN_CHOICE_KINDS.has(kind)) return true;
  if (kind === 'MulliganDecision') return !/^(Keep this hand|Mulligan)$/.test(choice);
  return /^Select\b/.test(choice) && !/^Discard/.test(kind);
}

// ---------------------------------------------------------------------------
// Card-name redaction for released choices and rules reports

/** Escape a string for use inside a RegExp. */
const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Blank out card names that are still hidden: `hidden` names (cards of either deck not seen in a public zone)
 * are replaced by "[hidden card]", together with a following object id ("Shock [#23]"). Returns the text and
 * whether anything was redacted.
 */
export function redactCards(text: string, hidden: Iterable<string>): { text: string; redacted: boolean } {
  const names = [...new Set(hidden)].filter((n) => n.length >= 3).sort((a, b) => b.length - a.length);
  if (!text || !names.length) return { text, redacted: false };
  // Match each face of split/double-faced names too ("Fire // Ice" is written "Fire" or "Ice").
  const variants = new Set<string>();
  for (const n of names) {
    variants.add(n);
    for (const face of n.split(' // ')) if (face.length >= 3) variants.add(face);
  }
  const re = new RegExp(`(?<![\\w'])(${[...variants].sort((a, b) => b.length - a.length).map(esc).join('|')})(?![\\w'])(\\s*\\[#\\d+\\])?`, 'gi');
  let redacted = false;
  const out = text.replace(re, () => {
    redacted = true;
    return '[hidden card]';
  });
  return { text: out, redacted };
}
