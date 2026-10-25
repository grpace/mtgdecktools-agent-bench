/**
 * Generated plain-English summaries (SITE-DATA 2.8): one per board and one per model, in the Vals.ai style ("As of
 * Oct 22, 2026, …"). Template-based and deterministic: the same export always says the same thing. They lead with
 * outcomes, never present diagnostics as a ranking, and say "too early to rank" until the interval of a rating difference
 * excludes zero (METHODOLOGY §4).
 */
import type { Outcomes } from './schema.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Oct 22, 2026" (UTC). */
export function asOfDate(ms: number): string {
  const d = new Date(ms);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

const NUM_WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
/** Small counts in words, larger ones as digits with separators. */
export const count = (n: number): string => (n >= 0 && n < NUM_WORDS.length ? NUM_WORDS[n]! : n.toLocaleString('en-US'));
export const plural = (n: number, one: string, many = `${one}s`): string => `${count(n)} ${n === 1 ? one : many}`;
/** Ratings without thousands separators ("1529"), as the site shows them. */
const elo = (x: number): string => String(Math.round(x));
const range = (ci: [number, number]): string => `${elo(ci[0])}–${elo(ci[1])}`;
const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
const ordinal = (n: number): string => (n === 1 ? 'first' : n === 2 ? 'second' : n === 3 ? 'third' : `${n}th`);
/** "a, b and c" */
export function list(xs: string[]): string {
  if (xs.length <= 1) return xs[0] ?? '';
  return `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
}

export interface SummaryRow {
  label: string; // "Claude Haiku 5.5 (Claude Code · Medium)"
  rating: number | null;
  ci: [number, number] | null;
  games: number;
  provisional: boolean;
  /** Rank range from difference intervals within its connected group (BoardRow.rank_range). */
  rankRange: [number, number] | null;
  /** Connected group (BoardRow.component). */
  group: number | null;
}

/**
 * The whole provisional rule in one sentence (METHODOLOGY §4 "Provisional"), from the thresholds in force. The
 * contributor floor is the part that usually binds (calibration: most rows stay provisional when few people play).
 */
export function provisionalRule(t: { minGames: number; minEvents: number; minOpponents: number; minContributors: number; maxContributorShare: number }): string {
  return `A rating is provisional until it has ${t.minGames} rated games, ${t.minEvents} events and ${t.minOpponents} different opponents, `
    + `with games from at least ${t.minContributors} contributors and none supplying more than ${Math.round(t.maxContributorShare * 100) === 50 ? 'half' : `${Math.round(t.maxContributorShare * 100)}%`} of them. `
    + 'The contributor part is usually the one still missing.';
}

export interface BoardSummaryInput {
  asOf: number;
  conditions: string; // "Set Context"
  set: string | null; // "Reality Fracture", or null for all sets
  events: number;
  games: number;
  rows: SummaryRow[]; // the default ranking, by rating, rated rows first
  minGames: number;
  /** Rated rows left off the default ranking (Unknown Effort). */
  unknownEffortRows?: number;
  /**
   * A set board or a single-source board (2.17): one of many boards, so a "ranks first" there needs the top row's
   * differences to hold after a Holm correction over its comparisons (`topHolds`), and is labeled exploratory.
   */
  exploratory?: boolean;
  /** The top row is ahead of every connected row after the Holm correction over those comparisons. */
  topHolds?: boolean;
  /** The provisional rule (provisionalRule). */
  provisionalRule?: string;
}

/** The board's summary sentence(s). */
export function boardSummary(x: BoardSummaryInput): string {
  const when = `As of ${asOfDate(x.asOf)}`;
  const where = `under ${x.conditions}${x.set ? ` in ${x.set}` : ''}`;
  const rated = x.rows.filter((r) => r.rating != null);
  if (!rated.length || !x.games) return `${when}, no games between agents have been rated ${where} yet.`;
  const parts = [`${when}, ${plural(rated.length, 'agent')} ${rated.length === 1 ? 'has' : 'have'} played ${plural(x.games, 'rated game')} across ${plural(x.events, 'event')} ${where}.`];
  const top = rated[0]!;
  const peers = rated.filter((r) => r.group === top.group);
  if (rated.some((r) => r.ci == null || r.rankRange == null)) {
    parts.push(`${top.label} has the highest rating, ${elo(top.rating!)}; this export has no ranges, so read it as a record, not a ranking.`);
  } else if (peers.length < 2) {
    parts.push(`${top.label} has the highest rating, ${elo(top.rating!)} (95% range ${range(top.ci!)}), but no other agent is connected to it through games yet.`);
  } else {
    const n = peers.length;
    const allOpen = peers.every((r) => r.rankRange![0] === 1 && r.rankRange![1] === n);
    const shared = peers.filter((r) => r.rankRange![0] === 1).length;
    if (allOpen) {
      parts.push(
        `No agent is clearly ahead of another yet, so it’s too early to rank them: ${top.label} has the highest rating so far, ${elo(top.rating!)} (95% range ${range(top.ci!)}), from ${plural(top.games, 'game')}.`,
      );
    } else if (top.rankRange![0] === 1 && top.rankRange![1] === 1) {
      // "Ranks first" only for a firm row, and on a set or single-source board only when it survives the correction.
      if (top.provisional) {
        parts.push(`${top.label} has the highest rating, ${elo(top.rating!)} (95% range ${range(top.ci!)}), and the differences put it ahead of every other agent, but its rating is provisional, so it doesn’t rank first yet.`);
      } else if (x.exploratory && !x.topHolds) {
        parts.push(`${top.label} has the highest rating, ${elo(top.rating!)} (95% range ${range(top.ci!)}), ahead of every other agent on its own ranges but not after correcting for the ${plural(peers.length - 1, 'comparison')}; this is one of many set and table boards, so read it as exploratory.`);
      } else {
        parts.push(`${top.label} ranks first: its rating, ${elo(top.rating!)} (95% range ${range(top.ci!)}), is clearly ahead of every other agent’s${x.exploratory ? ' (on this set or table board: exploratory, but it holds after correcting for its comparisons)' : ''}.`);
      }
    } else {
      parts.push(
        `${top.label} has the highest rating, ${elo(top.rating!)} (95% range ${range(top.ci!)}), but it isn’t clearly ahead of ${plural(shared - 1, 'other agent')}, so ${count(shared)} agents share the top spot.`,
      );
    }
  }
  const nGroups = new Set(rated.map((r) => r.group)).size;
  if (nGroups > 1) parts.push(`These agents form ${count(nGroups)} groups that haven’t played each other, so ranks compare agents within a group only.`);
  const prov = rated.filter((r) => r.provisional);
  const most = Math.max(...rated.map((r) => r.games));
  if (prov.length === rated.length) {
    parts.push(`Every rating is still provisional (${x.provisionalRule ?? `a rating firms up at ${x.minGames} games, 3 events, 2 opponents and games from 2 or more contributors, none supplying more than half`}); the most-played agent has ${plural(most, 'game')}.`);
  } else if (prov.length) {
    parts.push(`${prov.length} of ${rated.length} ratings are still provisional.`);
  }
  const u = x.unknownEffortRows ?? 0;
  if (u) parts.push(`${u === 1 ? 'One agent' : `${cap(count(u))} agents`} without a recorded effort ${u === 1 ? 'is' : 'are'} rated but left off this ranking.`);
  return parts.join(' ');
}

export interface ModelSummaryInput {
  asOf: number;
  model: string; // "Claude Sonnet 5.5"
  /** Its rated versions, main first: "Claude Code at Unknown Effort". */
  versions: string[];
  /** The main version on its board. */
  main: { version: string; conditions: string; rating: number | null; ci: [number, number] | null; rankRange: [number, number] | null; of: number; games: number; provisional: boolean } | null;
  outcomes: Outcomes;
  events: number;
  sets: number;
  minGames: number;
  /** A reason it isn't rated, when no version is (Unlisted, Mismatch). */
  unratedReason?: string | null;
}

/** The model page's summary paragraph: outcomes first, uncertainty stated plainly. */
export function modelSummary(x: ModelSummaryInput): string {
  const when = `As of ${asOfDate(x.asOf)}`;
  const g = x.outcomes.games;
  const played = g.w + g.l;
  const across = `${plural(x.events, 'event')}${x.sets > 1 ? ` and ${plural(x.sets, 'set')}` : ''}`;
  if (!x.main || x.main.rating == null || !played) {
    const why = x.unratedReason ? ` It isn’t rated: ${x.unratedReason}.` : ' It has no rated games against other models yet.';
    return `${when}, ${x.model} has sat at ${across}.${why}`;
  }
  const parts = [`${when}, ${x.model} has played ${plural(played, 'rated game')} against other models across ${across}.`];
  if (x.versions.length > 1) parts.push(`It is rated as ${plural(x.versions.length, 'version')}: ${list(x.versions)}.`);
  const m = x.main;
  const lead = x.versions.length > 1 ? `Its most-played version (${m.version}, ${m.conditions})` : `Its rating (${m.version}, ${m.conditions})`;
  const ratingText = `${elo(m.rating!)}${m.ci ? ` (95% range ${range(m.ci)})` : ''}`;
  if (!m.rankRange || m.of < 2) {
    parts.push(`${lead} is ${ratingText}${m.of < 2 ? ', with no other agent rated under the same conditions yet' : ''}.`);
  } else if (m.rankRange[0] === 1 && m.rankRange[1] === m.of) {
    parts.push(`${lead} is ${ratingText}, and it isn’t clearly ahead of or behind any other agent yet, so it’s too early to rank it.`);
  } else if (m.rankRange[0] === m.rankRange[1]) {
    parts.push(m.provisional
      ? `${lead} is ${ratingText}, which places it ${ordinal(m.rankRange[0])} of ${m.of} for now.`
      : `${lead} is ${ratingText}, which ranks it ${ordinal(m.rankRange[0])} of ${m.of}.`);
  } else {
    parts.push(`${lead} is ${ratingText}, which places it ${m.rankRange[0]}–${m.rankRange[1]} of ${m.of}.`);
  }
  if (m.provisional) parts.push(`That rating is provisional: it has ${count(m.games)} of the ${x.minGames} games a firm rating needs${m.games >= x.minGames ? ', and needs more events, opponents or contributors (games from at least two people, none supplying more than half)' : ''}.`);
  const mt = x.outcomes.matches;
  const ev = x.outcomes.events;
  const bits = [`won ${g.w}–${g.l}`];
  if (mt.w + mt.l) bits.push(`taken ${count(mt.w)} of its ${plural(mt.w + mt.l, 'match', 'matches')}`);
  if (ev.played) bits.push(`won ${count(ev.won)} of its ${plural(ev.played, 'event')}`);
  parts.push(`In those games it has ${list(bits)}.`);
  const sw = x.outcomes.swiss;
  if (sw && sw.events) {
    const top = sw.counts[`${sw.rounds}-0`] ?? 0;
    parts.push(`At eight-seat Swiss tables it went ${sw.rounds}–0 in ${count(top)} of ${plural(sw.events, 'event')}.`);
  }
  return parts.join(' ');
}
