/** Derived numbers: draft agreement / regret, deck shape, play stats, leaderboard rows. */
import { BASICS, isSettled, type CardDb, type Deck, type EventData, type Game, type Pick, type Ratings, rating } from './data.js';
import { registry, resolveHarness } from '../../registry/src/index.js';
import { findingsScope, PICK_GAP_RULE, type FindingsScope } from './set-findings.js';

export function median(xs: number[]): number | undefined {
  if (!xs.length) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export function mean(xs: number[]): number | undefined {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : undefined;
}

// ---------------------------------------------------------------------------
// Draft

export interface PickEval {
  pick: Pick;
  pickedGih?: number;
  best?: { name: string; gih: number };
  bestInLane?: { name: string; gih: number };
  matchesBest: boolean;
  regret?: number; // best GIH − picked GIH, in percentage points
  laneRegret?: number;
  rated: boolean; // pack has ≥1 rated card and the pick is a real choice
}

export interface DraftSummary {
  seat: string;
  picks: number;
  choices: number; // non-forced picks
  rated: number;
  agreement?: number; // share of rated choices matching the top-GIH card
  avgPickedGih?: number;
  avgBestGih?: number;
  avgRegret?: number;
  avgLaneRegret?: number;
  lanePicks: number;
  colors: string;
  medianLatencyMs?: number;
  evals: PickEval[];
}

function inLane(colors: string, lane: string): boolean {
  for (const c of colors) if (!lane.includes(c)) return false;
  return true;
}

export function evaluateDraft(seat: string, picks: Pick[], ratings: Ratings | null, cards: CardDb, laneColors: string): DraftSummary {
  const mine = picks.filter((p) => p.seat === seat);
  const evals: PickEval[] = mine.map((p) => {
    let best: { name: string; gih: number } | undefined;
    let bestInLane: { name: string; gih: number } | undefined;
    for (const name of p.contents) {
      const g = rating(ratings, name)?.gih_wr;
      if (g == null) continue;
      if (!best || g > best.gih) best = { name, gih: g };
      // The lane only applies once the drafter has settled: from pack 2 on.
      if (laneColors && p.packNumber >= 2 && cards.loaded && inLane(cards.colors(name), laneColors) && (!bestInLane || g > bestInLane.gih)) {
        bestInLane = { name, gih: g };
      }
    }
    const pickedGih = rating(ratings, p.pick)?.gih_wr ?? undefined;
    const rated = p.by !== 'forced' && p.by !== 'forfeit' && p.contents.length > 1 && best != null;
    const matchesBest = rated && best != null && pickedGih != null && pickedGih >= best.gih - 1e-9;
    const regret = rated && pickedGih != null && best ? (best.gih - pickedGih) * 100 : undefined;
    const laneRegret = rated && pickedGih != null && bestInLane ? Math.max(0, (bestInLane.gih - pickedGih) * 100) : undefined;
    return { pick: p, pickedGih: pickedGih ?? undefined, best, bestInLane, matchesBest, regret, laneRegret, rated };
  });
  const rated = evals.filter((e) => e.rated);
  const withGih = rated.filter((e) => e.pickedGih != null);
  const regrets = withGih.map((e) => e.regret!).filter((x) => x != null);
  const laneRegrets = evals.map((e) => e.laneRegret).filter((x): x is number => x != null);
  return {
    seat,
    picks: mine.length,
    choices: mine.filter((p) => p.by !== 'forced' && p.by !== 'forfeit').length,
    rated: rated.length,
    agreement: rated.length ? rated.filter((e) => e.matchesBest).length / rated.length : undefined,
    avgPickedGih: mean(withGih.map((e) => e.pickedGih!)),
    avgBestGih: mean(withGih.map((e) => e.best!.gih)),
    avgRegret: mean(regrets),
    avgLaneRegret: mean(laneRegrets),
    lanePicks: laneRegrets.length,
    colors: laneColors,
    medianLatencyMs: median(mine.map((p) => p.latencyMs).filter((x): x is number => typeof x === 'number')),
    evals,
  };
}

// ---------------------------------------------------------------------------
// Decks

/**
 * Main-deck colors: colors with at least 2 non-land cards that strictly need them (splashes with 1 card are ignored).
 * Hybrid pips don't count: a {B/R} card in a W/B deck is cast with black.
 */
export function deckColors(deck: Deck | undefined, cards: CardDb): string {
  if (!deck || !cards.loaded) return '';
  const count: Record<string, number> = {};
  for (const n of deck.main) {
    if (cards.isLand(n)) continue;
    for (const c of cards.requiredColors(n)) count[c] = (count[c] ?? 0) + 1;
  }
  return 'WUBRG'.split('').filter((c) => (count[c] ?? 0) >= 2).join('');
}

/** Colors of the basics in the main deck (a fallback when card data is missing). */
export function basicColors(deck: Deck | undefined): string {
  if (!deck) return '';
  const map: Record<string, string> = { Plains: 'W', Island: 'U', Swamp: 'B', Mountain: 'R', Forest: 'G' };
  const set = new Set(deck.main.map((n) => map[n]).filter(Boolean));
  return 'WUBRG'.split('').filter((c) => set.has(c)).join('');
}

export function seatColors(ev: EventData, seat: string, cards: CardDb): string {
  const d = ev.decks.get(seat);
  return deckColors(d, cards) || basicColors(d);
}

export const TYPE_ORDER = ['Creature', 'Planeswalker', 'Instant', 'Sorcery', 'Artifact', 'Enchantment', 'Battle', 'Land', 'Other'] as const;

export function primaryType(typeLine: string | undefined, name: string): (typeof TYPE_ORDER)[number] {
  if (!typeLine) return BASICS.has(name) ? 'Land' : 'Other';
  for (const t of TYPE_ORDER) if (new RegExp(`\\b${t}\\b`).test(typeLine)) return t;
  return 'Other';
}

export function counts(names: string[]): Array<[string, number]> {
  const m = new Map<string, number>();
  for (const n of names) m.set(n, (m.get(n) ?? 0) + 1);
  return [...m.entries()];
}

/** Non-land cards per mana value: index 0..6, index 7 = 7+. */
export function curveBuckets(mvs: number[]): number[] {
  const buckets = [0, 0, 0, 0, 0, 0, 0, 0];
  for (const v of mvs) buckets[Math.min(7, Math.max(0, Math.round(v)))]!++;
  return buckets;
}

export type TypeName = (typeof TYPE_ORDER)[number];

export interface DeckSummary {
  deck: Deck;
  colors: string;
  mainCount: number;
  landCount: number;
  /** Mana values of the non-land main-deck cards (empty without card data). */
  mvs: number[];
  curve: number[];
  /** Average 17Lands GIH WR of the rated non-basic main-deck cards. */
  avgGih?: number;
  /** Non-basic main-deck cards grouped by primary type in TYPE_ORDER, each sorted by mana value then name. */
  groups: Array<{ type: TypeName; total: number; cards: Array<[string, number]> }>;
  basics: Array<[string, number]>;
  sideboard: Array<[string, number]>;
}

export function deckSummary(deck: Deck, cards: CardDb, ratings: Ratings | null, colors: string): DeckSummary {
  const nonBasic = deck.main.filter((n) => !BASICS.has(n));
  const byType = new Map<TypeName, Array<[string, number]>>();
  for (const [name, n] of counts(nonBasic)) {
    const t = primaryType(cards.get(name)?.typeLine, name);
    if (!byType.has(t)) byType.set(t, []);
    byType.get(t)!.push([name, n]);
  }
  const groups = TYPE_ORDER.filter((t) => byType.has(t)).map((t) => {
    const list = byType.get(t)!.sort((a, b) => (cards.mv(a[0]) ?? 99) - (cards.mv(b[0]) ?? 99) || a[0].localeCompare(b[0]));
    return { type: t, total: list.reduce((s, [, n]) => s + n, 0), cards: list };
  });
  const mvs = nonBasic.filter((n) => !cards.isLand(n)).map((n) => cards.mv(n)).filter((v): v is number => v != null);
  const gih = nonBasic.map((n) => rating(ratings, n)?.gih_wr).filter((v): v is number => v != null);
  return {
    deck,
    colors,
    mainCount: deck.main.length,
    landCount: deck.main.length - nonBasic.length + nonBasic.filter((n) => cards.isLand(n)).length,
    mvs,
    curve: curveBuckets(mvs),
    avgGih: mean(gih),
    groups,
    basics: counts(deck.main.filter((n) => BASICS.has(n))),
    sideboard: counts(deck.sideboard).sort((a, b) => a[0].localeCompare(b[0])),
  };
}

// ---------------------------------------------------------------------------
// Play

export interface PlayStats { decisions: number; answered: number; rejected: number; latencies: number[]; notes: number }

export function playStats(games: Game[], seat: string): PlayStats {
  const s: PlayStats = { decisions: 0, answered: 0, rejected: 0, latencies: [], notes: 0 };
  for (const g of games) {
    for (const d of g.decisions) {
      if (d.seat !== seat) continue;
      s.decisions++;
      if (!d.answer) continue;
      s.answered++;
      if (!d.answer.accepted) s.rejected++;
      if (typeof d.answer.latencyMs === 'number') s.latencies.push(d.answer.latencyMs);
      if (d.answer.note) s.notes++;
    }
  }
  return s;
}

// ---------------------------------------------------------------------------
// Events

/** The event winner: top of the standings once complete, unless tied on match wins and game difference. */
export function eventWinner(ev: EventData): string | undefined {
  if (ev.status !== 'complete') return undefined;
  const top = ev.standings[0];
  const second = ev.standings[1];
  if (!top) return undefined;
  if (second && second.matchWins === top.matchWins && second.gameWins - second.gameLosses === top.gameWins - top.gameLosses) return undefined;
  return top.name;
}

export const isLlmEvent = (ev: EventData): boolean => ev.seats.some((s) => s.llm);

export interface Totals { llmEvents: number; liveEvents: number; llmGames: number; decisions: number; agentPicks: number }

/**
 * Headline counts across LLM events (events with at least one LLM seat). Games, decisions and picks count settled
 * events only (finished, stopped or stalled: what the open data holds), so Home and the download agree; live tables
 * show up in liveEvents. Scripted test tables have no LLM seat and count nowhere.
 */
export function totals(events: EventData[]): Totals {
  const llmEvents = events.filter(isLlmEvent);
  const settled = llmEvents.filter(isSettled);
  const llmSeat = (e: EventData, name: string) => e.seats.find((s) => s.name === name)?.llm ?? false;
  return {
    llmEvents: llmEvents.length,
    liveEvents: llmEvents.filter((e) => e.status === 'in-progress').length,
    llmGames: settled.reduce((n, e) => n + e.games.filter((g) => g.over).length, 0),
    decisions: settled.reduce((n, e) => n + e.games.reduce((m, g) => m + g.decisions.filter((d) => d.answer && llmSeat(e, d.seat)).length, 0), 0),
    agentPicks: settled.reduce((n, e) => n + e.picks.filter((p) => p.by === 'agent' && llmSeat(e, p.seat)).length, 0),
  };
}

// ---------------------------------------------------------------------------
// Sets: agent picks and decks per card, next to 17Lands

export interface CardAgg {
  name: string;
  picked: number;
  pickPositions: number[];
  /** 2.18: independent pods (distinct seeds or packs) in which agents took it. */
  pods: Set<string>;
  /** 2.18: picks where the agent had a real choice (pick ≤ PICK_GAP_RULE.max_pick of a pack), and their pods and tables. */
  choicePositions: number[];
  choicePods: Set<string>;
  choiceTables: Set<string>;
  seen: number;
  inDecks: number;
  deckGames: number;
  deckWins: number;
}

export interface CardRow extends CardAgg {
  avgPick?: number;
  /** Agent average pick − 17Lands ATA (negative = agents take it earlier). */
  delta?: number;
  deckWr?: number;
}

/** 2.18: one card's agents-vs-humans pick comparison (PICK_GAP_RULE), from picks where the agent had a real choice. */
export interface PickGapRow {
  card: CardRow;
  /** Agents' average pick within the pack over their picks 1..max_pick. */
  agentPick: number;
  picks: number;
  pods: number;
  tables: string[];
  /** 17Lands average taken at. */
  ata: number;
  /** ata − agentPick: positive when agents take it earlier than human drafters. */
  gap: number;
}

export interface SetStats {
  code: string;
  name: string;
  /** Every event of the set (listed on the set page). */
  events: EventData[];
  llmEvents: EventData[];
  /** 2.18: the tables every aggregate below comes from: finished, all 8 seats language-model agents (set-findings.ts). */
  scope: FindingsScope;
  llmPicks: number;
  llmDecks: number;
  /** Every rated card plus any card agents saw, picked or played; sorted by agent picks, then GIH WR. */
  cards: CardRow[];
  /** 2.18: cards that meet PICK_GAP_RULE, biggest gap (either way) first. */
  gaps: PickGapRow[];
  /** Cards whose gap says agents take them earlier than humans, biggest first (from `gaps`). */
  earlier: CardRow[];
  /** Cards whose gap says agents take them later than humans, biggest first (from `gaps`). */
  later: CardRow[];
}

/**
 * A set's card table. 2.18: picks, decks and pick averages come only from the tables that feed set findings (finished,
 * all 8 seats agents; set-findings.ts): a mixed pod's picks were shaped by its scripted drafters.
 */
export function setStats(allEvents: EventData[], code: string, ratings: Ratings | null): SetStats {
  const events = allEvents.filter((e) => e.set.code.toUpperCase() === code);
  const llmEvents = events.filter(isLlmEvent);
  const scope = findingsScope(events, code);
  const agg = new Map<string, CardAgg>();
  const get = (name: string): CardAgg => {
    let a = agg.get(name);
    if (!a) {
      a = { name, picked: 0, pickPositions: [], pods: new Set(), choicePositions: [], choicePods: new Set(), choiceTables: new Set(), seen: 0, inDecks: 0, deckGames: 0, deckWins: 0 };
      agg.set(name, a);
    }
    return a;
  };
  if (ratings) for (const name of ratings.cards.keys()) if (!BASICS.has(name)) get(name);

  let llmPicks = 0;
  let llmDecks = 0;
  for (const ev of scope.tables) {
    const pod = scope.podOf.get(ev.id)!;
    const llm = new Set(ev.seats.filter((s) => s.llm).map((s) => s.name));
    for (const p of ev.picks) {
      if (!llm.has(p.seat)) continue;
      for (const n of new Set(p.contents)) if (!BASICS.has(n)) get(n).seen++;
      if (p.by !== 'agent' || BASICS.has(p.pick)) continue;
      llmPicks++;
      const a = get(p.pick);
      a.picked++;
      a.pickPositions.push(p.pickNumber);
      a.pods.add(pod);
      if (p.pickNumber <= PICK_GAP_RULE.max_pick) {
        a.choicePositions.push(p.pickNumber);
        a.choicePods.add(pod);
        a.choiceTables.add(ev.id);
      }
    }
    for (const seat of llm) {
      const deck = ev.decks.get(seat);
      if (!deck) continue;
      llmDecks++;
      const games = ev.games.filter((g) => g.over && g.seats.includes(seat));
      const wins = games.filter((g) => g.winner === seat).length;
      for (const n of new Set(deck.main)) {
        if (BASICS.has(n)) continue;
        const a = get(n);
        a.inDecks++;
        a.deckGames += games.length;
        a.deckWins += wins;
      }
    }
  }

  const cards: CardRow[] = [...agg.values()].map((a) => {
    const r = rating(ratings, a.name);
    const avgPick = mean(a.pickPositions);
    return { ...a, avgPick, delta: avgPick != null && r?.ata != null ? avgPick - r.ata : undefined, deckWr: a.deckGames ? a.deckWins / a.deckGames : undefined };
  });
  cards.sort((x, y) => y.picked - x.picked || (rating(ratings, y.name)?.gih_wr ?? -1) - (rating(ratings, x.name)?.gih_wr ?? -1));
  const gaps: PickGapRow[] = cards
    .flatMap((c): PickGapRow[] => {
      const ata = rating(ratings, c.name)?.ata;
      if (ata == null || c.choicePositions.length < PICK_GAP_RULE.min_picks || c.choicePods.size < PICK_GAP_RULE.min_pods) return [];
      const agentPick = mean(c.choicePositions)!;
      const gap = ata - agentPick;
      if (Math.abs(gap) < PICK_GAP_RULE.min_gap) return [];
      return [{ card: c, agentPick, picks: c.choicePositions.length, pods: c.choicePods.size, tables: [...c.choiceTables].sort(), ata, gap }];
    })
    .sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap) || b.picks - a.picks || a.card.name.localeCompare(b.card.name));
  return {
    code,
    name: events[0]?.set.name ?? code,
    events,
    llmEvents,
    scope,
    llmPicks,
    llmDecks,
    cards,
    gaps,
    earlier: gaps.filter((g) => g.gap > 0).slice(0, 8).map((g) => g.card),
    later: gaps.filter((g) => g.gap < 0).slice(0, 8).map((g) => g.card),
  };
}

// ---------------------------------------------------------------------------
// Leaderboard

export interface ModelRow {
  model: string;
  modelIds: Set<string>;
  harness: Set<string>;
  seats: Array<{ event: EventData; seat: string }>;
  events: number;
  matchW: number; matchL: number; gameW: number; gameL: number;
  decisions: number; rejected: number; latencies: number[]; pickLatencies: number[];
  agreementN: number; agreementHits: number; regrets: number[];
  costUsd: number; costSeats: number; gamesPlayedWithCost: number;
  outputTokens: number;
  inProgress: number;
}

export function leaderboard(events: EventData[], ratingsFor: (set: string) => Ratings | null, cards: CardDb): ModelRow[] {
  const rows = new Map<string, ModelRow>();
  for (const ev of events) {
    const ratings = ratingsFor(ev.set.code);
    for (const seat of ev.seats.filter((s) => s.llm)) {
      let r = rows.get(seat.model);
      if (!r) {
        r = {
          model: seat.model, modelIds: new Set(), harness: new Set(), seats: [], events: 0, matchW: 0, matchL: 0, gameW: 0, gameL: 0,
          decisions: 0, rejected: 0, latencies: [], pickLatencies: [], agreementN: 0, agreementHits: 0, regrets: [],
          costUsd: 0, costSeats: 0, gamesPlayedWithCost: 0, outputTokens: 0, inProgress: 0,
        };
        rows.set(seat.model, r);
      }
      r.seats.push({ event: ev, seat: seat.name });
      r.events++;
      if (ev.status === 'in-progress') r.inProgress++;
      const st = ev.standings.find((x) => x.name === seat.name);
      if (st) {
        r.matchW += st.matchWins;
        r.matchL += st.matchLosses;
        r.gameW += st.gameWins;
        r.gameL += st.gameLosses;
      }
      const ps = playStats(ev.games, seat.name);
      r.decisions += ps.answered;
      r.rejected += ps.rejected;
      r.latencies.push(...ps.latencies);
      const ds = evaluateDraft(seat.name, ev.picks, ratings, cards, seatColors(ev, seat.name, cards));
      for (const e of ds.evals) {
        if (e.pick.by === 'agent' && typeof e.pick.latencyMs === 'number') r.pickLatencies.push(e.pick.latencyMs);
        if (!e.rated) continue;
        r.agreementN++;
        if (e.matchesBest) r.agreementHits++;
        if (e.regret != null) r.regrets.push(e.regret);
      }
      if (seat.harness) r.harness.add(seat.harness);
      const tr = ev.transcripts.get(seat.name);
      if (tr && tr.lines) {
        r.harness.add(seat.harness ?? 'claude-code');
        if (tr.model) r.modelIds.add(tr.model);
        r.outputTokens += tr.outputTokens;
        if (tr.done && tr.costUsd != null) {
          r.costUsd += tr.costUsd;
          r.costSeats++;
          r.gamesPlayedWithCost += ev.games.filter((g) => g.seats.includes(seat.name) && g.over).length;
        }
      }
    }
  }
  return [...rows.values()].sort((a, b) => winRate(b.gameW, b.gameL) - winRate(a.gameW, a.gameL) || b.gameW - a.gameW);
}

/** Harness display name from the registry (registry/harnesses.json); unknown ids show as themselves. */
export const harnessLabel = (id: string): string => registry.harnessDisplay(resolveHarness(id).ok ? (resolveHarness(id) as { id: string }).id : id);

export function winRate(w: number, l: number): number {
  return w + l ? w / (w + l) : -1;
}
