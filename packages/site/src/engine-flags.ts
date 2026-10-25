/**
 * Engine-issue flags (METHODOLOGY §5.6): per game, which engine problems may have touched it; per card, how often;
 * and an impact test comparing flagged with unflagged games.
 *
 * Flags:
 * - swapped_card_cast: a card that was swapped into the packs (replacing an unsupported card) was cast.
 * - refused_action: the engine refused an action it had listed as legal (an agent's listed option, or an
 *   automatic pass/payment the Director made). Refused structured answers (attackers, blocks, cards) are agent
 *   errors, scored under reliability, not flagged.
 * - unimplemented_effect: phase-rs resolved an Effect::Unimplemented (the effect silently did nothing).
 * - rules_issue: an agent called report_rules_issue during the game.
 * - known_issue_card: a card on the known-issues list (engine/known-issues.json, suspected or confirmed) was played,
 *   and the event's card data had no override fixing it (event_start.provenance.card_data; docs/CARD-OVERRIDES.md).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { engineRefusal, type EventData, type Game } from './data.js';
import { isLlmEvent } from './metrics.js';
import { clusterBootstrap } from './rating.js';
import type { Est } from './schema.js';

export const FLAG_KINDS = ['swapped_card_cast', 'refused_action', 'unimplemented_effect', 'rules_issue', 'known_issue_card'] as const;
export type FlagKind = (typeof FLAG_KINDS)[number];

export interface GameFlag { kind: FlagKind; seat: string | null; card: string | null; turn: number | null; detail?: string }

export interface GameFlags {
  flagged: boolean;
  counts: Record<FlagKind, number>;
  items: GameFlag[];
  /** The log records casts and Unimplemented effects (newer logs); without it only refusals and reports can be flagged. */
  plays_logged: boolean;
}

/** One card on the known-issues list (engine/known-issues.json). */
export interface KnownIssue {
  card: string;
  status: 'suspected' | 'confirmed' | 'not-a-bug' | 'fixed';
  upstream_issue?: string | null;
  /** The override in engine/overrides/ that fixes it locally. */
  override?: string | null;
  /** status fixed: the phase-rs server_version with the fix (events on older builds stay flagged). */
  fixed_in?: string | null;
}

let knownCache: Map<string, KnownIssue> | undefined;

/** The known-issues list by lower-case card name ({} when the file is missing or unreadable). */
export function knownIssues(): Map<string, KnownIssue> {
  if (knownCache) return knownCache;
  knownCache = new Map();
  try {
    const raw = JSON.parse(readFileSync(fileURLToPath(new URL('../../../engine/known-issues.json', import.meta.url)), 'utf8'));
    for (const i of raw.issues ?? []) if (i && typeof i.card === 'string') knownCache.set(i.card.toLowerCase(), i as KnownIssue);
  } catch {
    // no list: nothing is flagged as a known issue
  }
  return knownCache;
}

const versionTuple = (v: string) => v.replace(/^v/, '').split('.').map((x) => Number.parseInt(x, 10) || 0);
function versionBefore(a: string, b: string): boolean {
  const [x, y] = [versionTuple(a), versionTuple(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0);
  return false;
}

/**
 * Whether a known issue could have touched this event: suspected or confirmed, or fixed only in a later phase-rs
 * release than the event ran; and not fixed for this event by an override in its card data.
 */
export function knownIssueApplies(issue: KnownIssue, ev: EventData): boolean {
  const prov = ev.provenance as { engine?: { server_version?: string }; card_data?: { overrides?: unknown } } | undefined;
  const overrides = Array.isArray(prov?.card_data?.overrides) ? (prov!.card_data!.overrides as unknown[]) : [];
  if (issue.override && overrides.includes(issue.override)) return false;
  if (issue.status === 'suspected' || issue.status === 'confirmed') return true;
  if (issue.status === 'fixed' && issue.fixed_in) {
    const v = prov?.engine?.server_version;
    return typeof v === 'string' && versionBefore(v, issue.fixed_in);
  }
  return false;
}

/** Cards swapped into this event's packs (the replacements for unsupported cards). */
export function swappedIn(ev: EventData): Set<string> {
  return new Set(ev.packs.flatMap((p) => (p.swaps ?? []).map((s) => s.to)));
}

/** "Cast Foo [#12] {1}{R}" → "Foo" (older logs don't carry the card on agent_decision). */
export function cardFromChoice(choice: string): string | null {
  // Bounded: choices come from untrusted logs, and an unbounded lazy group is quadratic on long input.
  const m = /^(?:Cast|Activate|Play land|Crew)\s{1,4}(.{1,200}?)\s{1,4}\[#\d{1,9}\]/.exec(choice.slice(0, 300));
  return m ? m[1]! : null;
}

export function gameFlags(ev: EventData, g: Game, swaps = swappedIn(ev), known = knownIssues()): GameFlags {
  const items: GameFlag[] = [];
  const seen = new Set<string>();
  const add = (f: GameFlag) => {
    const k = `${f.kind}|${f.seat}|${f.card}|${f.kind === 'refused_action' || f.kind === 'rules_issue' ? f.turn : ''}|${f.detail ?? ''}`;
    if (seen.has(k)) return;
    seen.add(k);
    items.push(f);
  };
  for (const p of g.plays) {
    if (p.how === 'cast' && swaps.has(p.card)) add({ kind: 'swapped_card_cast', seat: p.seat, card: p.card, turn: p.turn ?? null });
    const issue = known.get(p.card.toLowerCase());
    if (issue && knownIssueApplies(issue, ev)) {
      add({ kind: 'known_issue_card', seat: p.seat, card: p.card, turn: p.turn ?? null, detail: [issue.status, issue.upstream_issue].filter(Boolean).join(': ') });
    }
  }
  for (const d of g.decisions) {
    const a = d.answer;
    if (!a || a.accepted || a.withheld) continue;
    const structured = a.structured ?? (a.rawChoice != null && typeof a.rawChoice === 'object');
    if (structured) continue;
    // Our own timeouts (a closed socket, a lost frame) are infrastructure, not the engine refusing anything.
    if (a.reason && !engineRefusal(a.reason)) continue;
    add({ kind: 'refused_action', seat: d.seat, card: a.card ?? cardFromChoice(a.choice), turn: d.turn, detail: a.reason ?? a.action });
  }
  for (const r of g.refusedAuto) add({ kind: 'refused_action', seat: r.seat, card: null, turn: null, detail: [r.action, r.reason].filter(Boolean).join(': ') || undefined });
  for (const u of g.unimplemented) {
    add({ kind: 'unimplemented_effect', seat: u.seat, card: u.card, turn: u.turn ?? null, detail: u.mechanics?.length ? `not implemented: ${u.mechanics.join(', ')}` : 'an effect did nothing' });
  }
  for (const r of g.rulesIssues) add({ kind: 'rules_issue', seat: r.seat, card: r.card, turn: r.turn ?? null, detail: r.note });
  const counts = Object.fromEntries(FLAG_KINDS.map((k) => [k, items.filter((i) => i.kind === k).length])) as Record<FlagKind, number>;
  return { flagged: items.length > 0, counts, items, plays_logged: g.playsLogged };
}

// ---------------------------------------------------------------------------
// Per card

export interface EngineCardRow {
  name: string;
  /** Times the card was put into packs to replace an unsupported card. */
  swapped_in: number;
  /** Games in which the card was cast or activated (any seat), from logs that record casts. */
  played_games: number;
  /** Games with at least one flag naming this card. */
  flagged_games: number;
  swapped_cast: number;
  refused: number;
  unimplemented: number;
  rules_issues: number;
  /** Up to three agent reports, newest first. */
  reports: Array<{ event_id: string; game: number | null; seat: string; note: string }>;
}

export function engineCards(events: EventData[]): EngineCardRow[] {
  const rows = new Map<string, EngineCardRow>();
  const row = (name: string) => {
    let r = rows.get(name);
    if (!r) rows.set(name, (r = { name, swapped_in: 0, played_games: 0, flagged_games: 0, swapped_cast: 0, refused: 0, unimplemented: 0, rules_issues: 0, reports: [] }));
    return r;
  };
  const reports: Array<{ t: number; card: string; r: EngineCardRow['reports'][number] }> = [];
  const playedGames = new Map<string, number>();
  for (const ev of events) {
    for (const p of ev.packs) for (const s of p.swaps ?? []) row(s.to).swapped_in++;
    const swaps = swappedIn(ev);
    for (const g of ev.games) {
      const flags = gameFlags(ev, g, swaps);
      for (const name of new Set(g.plays.map((p) => p.card))) playedGames.set(name, (playedGames.get(name) ?? 0) + 1);
      const flaggedHere = new Set<string>();
      for (const f of flags.items) {
        if (!f.card) continue;
        const r = row(f.card);
        flaggedHere.add(f.card);
        if (f.kind === 'swapped_card_cast') r.swapped_cast++;
        else if (f.kind === 'refused_action') r.refused++;
        else if (f.kind === 'unimplemented_effect') r.unimplemented++;
        else if (f.kind === 'rules_issue') r.rules_issues++;
      }
      for (const c of flaggedHere) row(c).flagged_games++;
      for (const ri of g.rulesIssues) if (ri.card) reports.push({ t: ri.t, card: ri.card, r: { event_id: ev.id, game: g.index, seat: ri.seat, note: ri.note } });
    }
    for (const ri of ev.rulesIssues) {
      if (!ri.card) continue;
      row(ri.card).rules_issues++;
      reports.push({ t: ri.t, card: ri.card, r: { event_id: ev.id, game: null, seat: ri.seat, note: ri.note } });
    }
  }
  for (const rep of reports.sort((a, b) => b.t - a.t)) {
    const r = rows.get(rep.card);
    if (r && r.reports.length < 3) r.reports.push(rep.r);
  }
  for (const r of rows.values()) r.played_games = playedGames.get(r.name) ?? 0;
  return [...rows.values()]
    .filter((r) => r.flagged_games || r.swapped_in || r.rules_issues)
    .sort((a, b) => b.flagged_games - a.flagged_games || b.rules_issues - a.rules_issues || b.swapped_in - a.swapped_in || a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// Impact: flagged vs unflagged games

export interface ImpactResult {
  scope: 'llm' | 'all';
  /** Finished games between two agent seats (LLM-only for scope llm) with a winner. */
  games: number;
  flagged: number;
  unflagged: number;
  /**
   * In flagged games where only one seat is implicated, how often that seat won. Engine problems that hurt the
   * player whose card misbehaved show up below 50%. Swing = (win rate − 50%) in points.
   */
  flagged_seat: { games: number; win_rate: Est | null; swing_pp: Est | null };
  /** Answers refused per 100 decisions (all refusals, agent errors included). */
  rejected_per_100: { flagged: Est | null; unflagged: Est | null; diff: Est | null };
  /** Game length in turns. */
  turns: { flagged: Est | null; unflagged: Est | null; diff: Est | null };
  /** The same win-rate swing restricted to one kind of flag. */
  by_kind: Record<FlagKind, { games: number; swing_pp: Est | null }>;
}

interface GameItem { flagged: boolean; turns: number; decisions: number; rejected: number; seatWin: number | null; kinds: Set<FlagKind>; kindWin: Partial<Record<FlagKind, number>> }

const toEst = (r: ReturnType<typeof clusterBootstrap>, scale = 1, shift = 0): Est | null =>
  r ? { value: r.value * scale + shift, ci: r.ci ? [r.ci[0] * scale + shift, r.ci[1] * scale + shift] : null, n: r.n, events: r.clusters } : null;

/** 95% Wilson score interval for k successes in n. */
export function wilson(k: number, n: number, z = 1.959964): [number, number] {
  if (!n) return [0, 1];
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}

/**
 * A win-rate bootstrap widened to at least the Wilson interval: with a handful of games the bootstrap collapses
 * (0 wins in 2 games resamples to 0 every time), the same reason ratings use the wider of two intervals (§4).
 */
function widenWinRate(r: ReturnType<typeof clusterBootstrap>, wins: number, n: number): ReturnType<typeof clusterBootstrap> {
  if (!r) return r;
  const w = wilson(wins, n);
  return { ...r, ci: r.ci ? [Math.min(r.ci[0], w[0]), Math.max(r.ci[1], w[1])] : w };
}

export function impact(events: EventData[], scope: 'llm' | 'all', replicates: number, seed = 11): ImpactResult {
  const clusters: GameItem[][] = [];
  for (const ev of events) {
    if (scope === 'llm' && !isLlmEvent(ev)) continue;
    const swaps = swappedIn(ev);
    const items: GameItem[] = [];
    for (const g of ev.games) {
      if (!g.over || !g.winner || g.turns == null || g.seats.length !== 2) continue;
      if (scope === 'llm' && !g.seats.every((s) => ev.seats.find((x) => x.name === s)?.llm)) continue;
      const f = gameFlags(ev, g, swaps);
      const answered = g.decisions.filter((d) => d.answer);
      const seatWinFor = (fl: GameFlag[]): number | null => {
        const seats = new Set(fl.map((x) => x.seat).filter((s): s is string => !!s));
        if (seats.size !== 1) return null;
        return g.winner === [...seats][0] ? 1 : 0;
      };
      const kindWin: GameItem['kindWin'] = {};
      for (const k of FLAG_KINDS) {
        const w = seatWinFor(f.items.filter((x) => x.kind === k));
        if (w != null) kindWin[k] = w;
      }
      items.push({
        flagged: f.flagged, turns: g.turns, decisions: answered.length, rejected: answered.filter((d) => !d.answer!.accepted).length,
        seatWin: f.flagged ? seatWinFor(f.items) : null, kinds: new Set(f.items.map((x) => x.kind)), kindWin,
      });
    }
    if (items.length) clusters.push(items);
  }
  const opts = { replicates, seed };
  const all = clusters.flat();
  const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : undefined);
  const rate = (xs: GameItem[]) => {
    const d = xs.reduce((s, x) => s + x.decisions, 0);
    return d ? (xs.reduce((s, x) => s + x.rejected, 0) / d) * 100 : undefined;
  };
  const diff = (f: (xs: GameItem[]) => number | undefined) => (xs: GameItem[]) => {
    const a = f(xs.filter((x) => x.flagged));
    const b = f(xs.filter((x) => !x.flagged));
    return a == null || b == null ? undefined : a - b;
  };
  const only = (pred: (x: GameItem) => boolean) => clusters.map((c) => c.filter(pred));
  const winStat = (xs: GameItem[]) => mean(xs.map((x) => x.seatWin!).filter((x) => x != null));
  const turnsOf = (xs: GameItem[]) => mean(xs.map((x) => x.turns));
  const flaggedSeat = only((x) => x.seatWin != null);
  const fsItems = flaggedSeat.flat();
  const wr = widenWinRate(clusterBootstrap(flaggedSeat, winStat, opts), fsItems.filter((x) => x.seatWin === 1).length, fsItems.length);
  return {
    scope,
    games: all.length,
    flagged: all.filter((x) => x.flagged).length,
    unflagged: all.filter((x) => !x.flagged).length,
    flagged_seat: { games: flaggedSeat.flat().length, win_rate: toEst(wr), swing_pp: toEst(wr, 100, -50) },
    rejected_per_100: {
      flagged: toEst(clusterBootstrap(only((x) => x.flagged), rate, opts)),
      unflagged: toEst(clusterBootstrap(only((x) => !x.flagged), rate, opts)),
      diff: toEst(clusterBootstrap(clusters, diff(rate), opts)),
    },
    turns: {
      flagged: toEst(clusterBootstrap(only((x) => x.flagged), turnsOf, opts)),
      unflagged: toEst(clusterBootstrap(only((x) => !x.flagged), turnsOf, opts)),
      diff: toEst(clusterBootstrap(clusters, diff(turnsOf), opts)),
    },
    by_kind: Object.fromEntries(FLAG_KINDS.map((k) => {
      const cl = clusters.map((c) => c.filter((x) => x.kindWin[k] != null));
      const items = cl.flat();
      const r = widenWinRate(clusterBootstrap(cl, (xs) => mean(xs.map((x) => x.kindWin[k]!)), opts), items.filter((x) => x.kindWin[k] === 1).length, items.length);
      return [k, { games: cl.flat().length, swing_pp: toEst(r, 100, -50) }];
    })) as ImpactResult['by_kind'],
  };
}

// ---------------------------------------------------------------------------
// Card swaps vs rules errors (2.17)

/** Flags that say the engine (or a card it scripts) may have played a rule wrong. A swapped-in card being cast isn't one. */
export const RULES_ERROR_KINDS = ['known_issue_card', 'unimplemented_effect', 'refused_action', 'rules_issue'] as const satisfies readonly FlagKind[];

export interface EngineSplit {
  /** Finished games in scope: between two LLM seats at LLM tables (`llm`), or every finished game (`all`). */
  games: number;
  /**
   * Card swaps: unsupported cards replaced in the packs by playable ones (METHODOLOGY §5.6). Not an engine fault: the
   * games are played by the rules with a different card. `games`: games where a swapped-in card was cast.
   */
  card_swaps: { swaps: number; cards: number; games: number };
  /**
   * Rules errors: a known-issue card played without its fix, an effect the engine didn't implement, an action it listed
   * and then refused, or an agent's rules report. `lost_by_implicated`: games where exactly one seat was implicated and
   * that seat lost (an upper bound on the games where it mattered); `implicated_single_seat`: games with one seat implicated.
   */
  rules_errors: { games: number; by_kind: Record<(typeof RULES_ERROR_KINDS)[number], number>; implicated_single_seat: number; lost_by_implicated: number };
  /** One plain sentence for the set page, rules errors first. */
  text: string;
}

export function engineSplit(events: EventData[], scope: 'llm' | 'all'): EngineSplit {
  let games = 0, swapGames = 0, errGames = 0, single = 0, lost = 0, swaps = 0;
  const swapCards = new Set<string>();
  const byKind = Object.fromEntries(RULES_ERROR_KINDS.map((k) => [k, 0])) as EngineSplit['rules_errors']['by_kind'];
  for (const ev of events) {
    if (scope === 'llm' && !isLlmEvent(ev)) continue;
    for (const p of ev.packs) for (const s of p.swaps ?? []) (swaps++, swapCards.add(s.to));
    const sw = swappedIn(ev);
    for (const g of ev.games) {
      if (!g.over || g.seats.length !== 2) continue;
      if (scope === 'llm' && !g.seats.every((s) => ev.seats.find((x) => x.name === s)?.llm)) continue;
      games++;
      const f = gameFlags(ev, g, sw);
      if (f.counts.swapped_card_cast) swapGames++;
      const errs = f.items.filter((i) => (RULES_ERROR_KINDS as readonly string[]).includes(i.kind));
      if (!errs.length) continue;
      errGames++;
      for (const k of RULES_ERROR_KINDS) if (f.counts[k]) byKind[k]++;
      const seats = new Set(errs.map((e) => e.seat).filter((s): s is string => !!s));
      if (seats.size === 1) {
        single++;
        if (g.winner && g.winner !== [...seats][0]) lost++;
      }
    }
  }
  const of = (n: number) => `${n} of ${games} game${games === 1 ? '' : 's'}`;
  const text = !games
    ? 'No finished games yet.'
    : `Rules errors touched ${of(errGames)}${errGames ? ` (the seat whose card misbehaved lost ${lost} of the ${single} where one seat was implicated, an upper bound on games where it mattered)` : ''}. `
      + `Swapped-in cards (unsupported cards replaced in the packs, not an engine fault) were cast in ${of(swapGames)}.`;
  return { games, card_swaps: { swaps, cards: swapCards.size, games: swapGames }, rules_errors: { games: errGames, by_kind: byKind, implicated_single_seat: single, lost_by_implicated: lost }, text };
}
