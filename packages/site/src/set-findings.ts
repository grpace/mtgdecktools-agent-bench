/**
 * Which tables a set's findings come from (export 2.18, docs/SITE-DATA.md "2.18", METHODOLOGY §5.8).
 *
 * A set finding (the most drafted pairs and their records, the typical deck, when colors settle, first picks, card pick
 * averages, the agents-vs-humans pick gaps) is a statement about how language-model agents draft a format. It only
 * means that when every seat at the table was an agent: a pod of two agents and six scripted drafters (the early test
 * tables) shapes what the agents could take, and a scripted player is not an agent at all. So:
 *   - a table feeds set findings only when it finished and all 8 seats are LLM seats (metadata rule, `isLlmSeat`);
 *   - mixed pods stay on the site to watch and study, and feed no set finding;
 *   - re-running one draft (the same seed, so the same packs) is one independent pod, however often it ran: sample-size
 *     gates count pods, not tables, so four replays of one seed never pass for four drafts.
 */
import { createHash } from 'node:crypto';
import type { EventData } from './data.js';

/** Seats at a full table: findings need every one of them to be a language-model agent. */
export const FINDINGS_TABLE_SEATS = 8;

/** A finished table whose 8 seats are all language-model agents (no scripted drafter, bot or scripted player). */
export function feedsSetFindings(ev: Pick<EventData, 'status' | 'source' | 'devBotFill' | 'seats'>): boolean {
  return (
    ev.status === 'complete' &&
    !ev.source.exclude &&
    ev.source.label !== 'smoke' &&
    !ev.devBotFill &&
    ev.seats.length >= FINDINGS_TABLE_SEATS &&
    ev.seats.every((s) => s.llm)
  );
}

/**
 * The independent draft a table ran: its set and seed (a re-run of a seed opens the same packs), else a hash of the
 * packs it opened, else the table itself.
 */
export function podKey(ev: Pick<EventData, 'id' | 'set' | 'seed' | 'packs'>): string {
  const set = ev.set.code.toUpperCase();
  if (ev.seed) return `${set}:seed:${ev.seed}`;
  if (ev.packs.length) {
    const rounds = [...ev.packs].sort((a, b) => a.round - b.round).map((p) => p.packs);
    return `${set}:packs:${createHash('sha256').update(JSON.stringify(rounds)).digest('hex').slice(0, 16)}`;
  }
  return `${set}:event:${ev.id}`;
}

export interface FindingsScope {
  /** The tables behind the set's findings, newest first. */
  tables: EventData[];
  /** Independent pods among them (distinct seeds or packs). */
  pods: number;
  /** podKey of each table. */
  podOf: Map<string, string>;
  /** Finished agent tables of the set left out because not every seat was an agent (mixed pods): watchable only. */
  excluded: EventData[];
}

/** The tables a set's findings come from, and the finished agent tables left out. */
export function findingsScope(events: EventData[], code: string): FindingsScope {
  const inSet = events.filter((e) => e.set.code.toUpperCase() === code.toUpperCase());
  const tables = inSet.filter(feedsSetFindings).sort((a, b) => b.startT - a.startT);
  const podOf = new Map(tables.map((ev) => [ev.id, podKey(ev)] as const));
  const excluded = inSet.filter(
    (e) => e.status === 'complete' && !e.source.exclude && e.source.label !== 'smoke' && !e.devBotFill && e.seats.some((s) => s.llm) && !feedsSetFindings(e),
  );
  return { tables, pods: new Set(podOf.values()).size, podOf, excluded };
}

/**
 * The agents-vs-humans pick comparison (2.18). In a closed pod every card is taken by the last pick, so a late pick is
 * forced, not an evaluation: only picks where the agent had a real choice count (the first `max_pick` picks of a pack).
 * A card needs `min_picks` such picks from `min_pods` independent pods, and its gap must be at least `min_gap` picks.
 */
export const PICK_GAP_RULE = { max_pick: 9, min_picks: 5, min_pods: 3, min_gap: 1.5 } as const;

/** Placeholder release dates (custom sets phase-rs ships for testing, e.g. 2099-01-01) are more than this far ahead. */
const TEST_SET_HORIZON_MS = 366 * 24 * 3600 * 1000;

/**
 * 2.18: a set with no official release: a placeholder release date more than a year after the export was built. A set
 * without a date is not called a test set (older logs recorded none).
 */
export function isTestSet(releaseDate: string | undefined, now: number): boolean {
  const t = releaseDate ? Date.parse(releaseDate) : NaN;
  return !Number.isNaN(t) && t - now > TEST_SET_HORIZON_MS;
}
