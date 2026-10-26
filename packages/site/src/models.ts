/**
 * Model files, activity, rating history and set summaries (SITE-DATA 2.8). Everything a model page, the activity line
 * and a set page need without loading every event file. Outcomes only for results; diagnostics are labeled behavior.
 */
import type { Ctx } from './context.js';
import { isSettled, type EventData } from './data.js';
import { deckRoles, pairNormOf, type DeckRoles } from './core-draft.js';
import { costInfo } from './cost.js';
import { autoHighlights } from './highlights.js';
import { eventWinner, isLlmEvent, median, seatColors } from './metrics.js';
import { finishOf, matchRecords, outcomesOf, rateEst, sidesOf, wilson, type OutcomeGame } from './outcomes.js';
import { DEFAULT_RATING_OPTIONS, rateGames } from './rating.js';
import { conditionsText, draftContext, earlyTestData, groupKey, KNOWLEDGE_LABEL, ratingGamesOf, tableKind, tableSentence, unratedReason, type Identities } from './scoring.js';
import { modelSummary } from './summary.js';
import { versionViews } from './ladder.js';
import type {
  ActivityItem, Board, CostCondition, GroupInfo, HarnessSplit, Highlight, HistoryPoint, ModelCardRow, ModelEventRow, ModelFile, ModelIndexRow, ModelOpponent, ModelRating, SetArchetype,
  SetDeckShape, SetFirstPick, SetInsight, SetRef,
} from './schema.js';
import { findingsScope, type FindingsScope } from './set-findings.js';
import { registry } from '../../registry/src/index.js';

const setRef = (ev: EventData): SetRef => ({ code: ev.set.code.toUpperCase(), name: ev.set.name, ...(ev.set.releaseDate ? { release_date: ev.set.releaseDate } : {}) });

/**
 * The default leaderboard: the all-sets, all-sources board of the main condition with the current prompts (scoring.ts
 * MAIN_CONDITION, buildBoards). null until that board has a rated game: the site then shows "No Rated Games Yet" rather
 * than an older prompt group or a side condition (a prompt change starts the headline afresh).
 */
export function mainBoardId(boards: Board[]): string | null {
  const main = boards.find((b) => b.set == null && b.source === 'all' && b.role === 'main');
  return main && main.games > 0 ? main.id : null;
}

/** Finished, rated events (pooled in some group), in the order they finished. */
const ratedEvents = (ctx: Ctx): EventData[] => ctx.events.filter((ev) => groupKey(ev) != null).sort((a, b) => a.lastT - b.lastT || a.id.localeCompare(b.id));

/**
 * Rating history per group: refit the group's rating after each of its events (in finishing order) and record every identity
 * that played in that event. No bootstrap (cheap): the interval is rating ± z·se. Keyed by group, then identity.
 */
export function ratingHistory(ctx: Ctx, ids: Identities): Map<string, Map<string, HistoryPoint[]>> {
  const out = new Map<string, Map<string, HistoryPoint[]>>();
  const z = 1.959964;
  const byGroup = new Map<string, EventData[]>();
  for (const ev of ratedEvents(ctx)) byGroup.set(groupKey(ev)!, [...(byGroup.get(groupKey(ev)!) ?? []), ev]);
  for (const [gk, evs] of byGroup) {
    const per = new Map<string, HistoryPoint[]>();
    const games: ReturnType<typeof ratingGamesOf> = [];
    for (const ev of evs) {
      const mine = ratingGamesOf([ev], ids);
      if (!mine.length) continue;
      games.push(...mine);
      const res = rateGames(games, { ...DEFAULT_RATING_OPTIONS, replicates: 0, influence: false });
      const played = new Set(mine.flatMap((g) => [g.a, g.b]));
      for (const r of res.rows) {
        if (!played.has(r.id)) continue;
        const ci: [number, number] | null = Number.isFinite(r.se) ? [r.rating - z * r.se, r.rating + z * r.se] : null;
        per.set(r.id, [...(per.get(r.id) ?? []), { event_id: ev.id, at: ev.lastT, rating: r.rating, ci, games: r.games, provisional: r.provisional }]);
      }
    }
    out.set(gk, per);
  }
  return out;
}

/** Activity: live tables, finished events, first rated games and ratings that became firm; newest first, live first. */
export function activity(ctx: Ctx, ids: Identities, history: Map<string, Map<string, HistoryPoint[]>>, groups: GroupInfo[], limit = 40): ActivityItem[] {
  // Plain names in sentences: what isn't known is left out rather than said ("Unknown Effort"): the model, then the
  // effort when known.
  const label = (id: string) => {
    const i = ids.info.get(id);
    if (!i) return id;
    return i.effort !== 'unknown' ? i.label : (i.model_display ?? i.model);
  };
  const live: ActivityItem[] = [];
  const rest: ActivityItem[] = [];
  for (const ev of ctx.events.filter(isLlmEvent)) {
    const agents = ev.seats.filter((s) => s.kind === 'agent').length;
    if (ev.status === 'in-progress') {
      const doing = ev.stage === 'draft' ? 'drafting' : ev.stage === 'build' ? 'building decks' : `playing (${ev.matches.filter((m) => m.done).length} matches done)`;
      live.push({ kind: 'event_live', at: ev.lastT, event_id: ev.id, set: setRef(ev), ...(earlyTestData(ev) ? { test_data: true as const } : {}), text: `Live now: ${agents} agents ${doing} in ${ev.set.name}.` });
    } else if ((ev.status === 'complete' || ev.status === 'stopped') && !ev.source.exclude && !ev.devBotFill) {
      // A winner "of N agents" only at a table of different models (2.17): a mirror or single-model table says whose
      // seats played each other; a stopped table names no winner.
      const kind = tableKind(ev, ids);
      const w = ev.status === 'complete' ? eventWinner(ev) : undefined;
      const ws = w ? ev.seats.find((s) => s.name === w) : undefined;
      const wl = kind === 'mixed' && ws?.llm ? label(ids.of(ev, w!).key) : null;
      rest.push({
        kind: 'event_finished', at: ev.lastT, event_id: ev.id, set: setRef(ev), winner_label: wl, table_kind: kind, ...(earlyTestData(ev) ? { test_data: true as const } : {}),
        ...(ev.status === 'stopped' ? { stopped: true as const } : {}),
        text: tableSentence(ev, ids, label, w),
      });
    }
  }
  const gLabel = new Map(groups.map((g) => [g.key, g.label]));
  for (const [gk, per] of history) {
    for (const [id, pts] of per) {
      const first = pts[0]!;
      const ev = ctx.events.find((e) => e.id === first.event_id);
      rest.push({ kind: 'first_rated_game', at: first.at, event_id: first.event_id, set: ev ? setRef(ev) : null, identity: id, identity_label: label(id), text: `${label(id)} played its first rated games (${gLabel.get(gk) ?? gk}).` });
      const firm = pts.find((p) => !p.provisional);
      if (firm) {
        const fev = ctx.events.find((e) => e.id === firm.event_id);
        rest.push({ kind: 'rating_firm', at: firm.at, event_id: firm.event_id, set: fev ? setRef(fev) : null, identity: id, identity_label: label(id), text: `${label(id)} now has a firm rating (${gLabel.get(gk) ?? gk}).` });
      }
    }
  }
  live.sort((a, b) => b.at - a.at);
  rest.sort((a, b) => b.at - a.at || a.kind.localeCompare(b.kind) || (a.identity ?? '').localeCompare(b.identity ?? ''));
  return [...live, ...rest].slice(0, limit);
}

// ---------------------------------------------------------------------------
// Model files

export interface ModelsInput {
  ctx: Ctx;
  ids: Identities;
  boards: Board[];
  groups: GroupInfo[];
  history: Map<string, Map<string, HistoryPoint[]>>;
  curated: Highlight[];
  mainBoard: string | null;
}

interface SeatOf { ev: EventData; seat: string; identity: string }

/**
 * 2.20: a model's results by harness, per effort level whose seats ran on 2+ harnesses. Only finished games against an
 * LLM seat of another setup (the games that can be rated), from rated seats; raw counts, never a rating.
 */
export function harnessSplit(seats: SeatOf[], ids: Identities): HarnessSplit[] {
  const by = new Map<string, Map<string, { seats: Set<string>; games: number; wins: number }>>();
  for (const s of seats) {
    const id = ids.of(s.ev, s.seat);
    if (!id.rated) continue;
    const hs = by.get(id.key) ?? new Map();
    by.set(id.key, hs);
    const row = hs.get(id.harness) ?? { seats: new Set<string>(), games: 0, wins: 0 };
    hs.set(id.harness, row);
    row.seats.add(`${s.ev.id}|${s.seat}`);
    for (const g of s.ev.games) {
      if (!g.over || !g.seats.includes(s.seat)) continue;
      const opp = g.seats.find((x) => x !== s.seat);
      if (!opp || !s.ev.seats.find((x) => x.name === opp)?.llm || ids.of(s.ev, opp).key === id.key) continue;
      row.games++;
      if (g.winner === s.seat) row.wins++;
    }
  }
  const out: HarnessSplit[] = [];
  for (const [key, hs] of by) {
    if (hs.size < 2) continue;
    const info = ids.info.get(key);
    const rows = [...hs.entries()].map(([h, r]) => ({
      harness: h, harness_display: ids.harnessDisplay(h), seats: r.seats.size, games: r.games, wins: r.wins,
      win_rate: r.games ? { value: r.wins / r.games, ci: wilson(r.wins, r.games) } : null,
    })).sort((a, b) => b.games - a.games || a.harness.localeCompare(b.harness));
    const pct = (x: number) => `${Math.round(x * 100)}%`;
    out.push({
      identity: key, effort: info?.effort ?? key.split('/')[1]!, effort_display: info?.effort_display ?? key.split('/')[1]!, rows,
      text: `${info?.label ?? key} by harness, against other setups: ${rows.map((r) => `${r.harness_display} ${r.wins}–${r.games - r.wins}${r.win_rate ? ` (${pct(r.win_rate.value)})` : ''}`).join(', ')}. One rating covers them all; this split isn't rated, and the opponents behind each row differ.`,
    });
  }
  return out.sort((a, b) => a.identity.localeCompare(b.identity));
}

/** Every LLM seat by registry-listed model id. */
function seatsByModel(ctx: Ctx, ids: Identities): Map<string, SeatOf[]> {
  const out = new Map<string, SeatOf[]>();
  for (const ev of ctx.events) {
    for (const s of ev.seats.filter((x) => x.llm)) {
      const id = ids.of(ev, s.name);
      if (!registry.model(id.model)) continue; // unlisted models get no page (their events show them)
      out.set(id.model, [...(out.get(id.model) ?? []), { ev, seat: s.name, identity: id.key }]);
    }
  }
  return out;
}

const effortPhrase = (e: string) => (e === 'Unknown Effort' ? 'Unknown Effort' : e);
const POLICY_LABEL: Record<'fresh-per-game' | 'fresh-per-match' | 'harness', string> = {
  'fresh-per-game': 'Fresh Session per Game', 'fresh-per-match': 'Fresh Session per Match', harness: 'One Session',
};

export function buildModels(inp: ModelsInput): { files: Map<string, ModelFile>; index: ModelIndexRow[] } {
  const { ctx, ids, boards, groups } = inp;
  const replicates = Math.min(ctx.replicates, 500);
  const rated = ratedEvents(ctx);
  // Results never pool across comparability groups (METHODOLOGY §6): a model page shows one group, the main board's
  // when the model has rated games there, else the group where it has the most.
  const gamesByGroup = new Map<string, OutcomeGame[]>();
  for (const ev of rated) {
    const gk = groupKey(ev)!;
    gamesByGroup.set(gk, [...(gamesByGroup.get(gk) ?? []), ...ratingGamesOf([ev], ids)]);
  }
  const mainGroup = boards.find((b) => b.id === inp.mainBoard)?.group ?? null;
  const modelOf = (identity: string) => ids.info.get(identity)?.model_id ?? identity.split('/')[0]!;
  const files = new Map<string, ModelFile>();
  const index: ModelIndexRow[] = [];
  const allBoards = boards.filter((b) => b.set == null && b.source === 'all');
  const gLabel = new Map(groups.map((g) => [g.key, g.label]));
  const gCond = new Map(groups.map((g) => [g.key, conditionsText(g.conditions)]));
  let seed = 9001;
  for (const [modelId, seats] of [...seatsByModel(ctx, ids)].sort((a, b) => a[0].localeCompare(b[0]))) {
    seed += 17;
    const entry = registry.model(modelId)!;
    const identities = [...new Set(seats.map((s) => s.identity))].sort();
    const mine = (id: string) => modelOf(id) === modelId;
    const sidesIn = (gk: string) => sidesOf(gamesByGroup.get(gk) ?? [], mine).length;
    const byCount = [...gamesByGroup.keys()].filter((gk) => sidesIn(gk) > 0).sort((a, b) => sidesIn(b) - sidesIn(a) || a.localeCompare(b));
    const pageGroup = mainGroup && sidesIn(mainGroup) > 0 ? mainGroup : (byCount[0] ?? mainGroup);
    const allGames: OutcomeGame[] = pageGroup ? (gamesByGroup.get(pageGroup) ?? []) : [];
    const ratedAll = [...gamesByGroup.values()].reduce((n, gs) => n + sidesOf(gs, mine).length, 0);

    // Ratings: every row of its identities on the all-sets boards; main board first, then most games.
    const ratings: ModelRating[] = [];
    for (const b of allBoards) {
      for (const r of b.rows) {
        if (!identities.includes(r.identity) || r.rating == null) continue;
        const info = ids.info.get(r.identity);
        ratings.push({
          identity: r.identity,
          label: info?.label ?? r.identity,
          effort_display: info?.effort_display ?? '',
          effort_known: info?.effort !== 'unknown',
          model_verification: info?.model_verification ?? null,
          board: b.id,
          group: b.group,
          group_label: gLabel.get(b.group) ?? b.group,
          rating: r.rating,
          ci: r.ci,
          rank: r.rank,
          rank_range: r.rank_range ?? null,
          of: r.rank_of ?? b.rows.filter((x) => x.rating != null && x.default_ranking !== false).length,
          role: b.role ?? 'side',
          default_ranking: r.default_ranking ?? true,
          games: r.games, wins: r.wins, losses: r.losses, events: r.events, opponents: r.opponents,
          provisional: r.provisional,
          provisional_reasons: r.provisional_reasons,
          games_needed: r.games_needed ?? 0,
          outcomes: r.outcomes ?? null,
          diagnostics: r.diagnostics ?? {},
          cost: r.cost ?? null,
          history: inp.history.get(b.group)?.get(r.identity) ?? [],
        });
      }
    }
    ratings.sort((a, b) => Number(b.group === pageGroup) - Number(a.group === pageGroup) || Number(b.board === inp.mainBoard) - Number(a.board === inp.mainBoard) || b.games - a.games || a.identity.localeCompare(b.identity));
    const main = ratings[0] ?? null;

    // Results across all its versions in the page's group: rated games against other models.
    const ratedSeats = seats.filter((s) => groupKey(s.ev) != null && groupKey(s.ev) === pageGroup && ids.of(s.ev, s.seat).rated);
    const outcomes = outcomesOf(allGames, mine, ratedSeats, { replicates, seed });
    const sides = sidesOf(allGames, mine);
    const oppModel = (x: (typeof sides)[number]) => modelOf(mine(x.game.a) ? x.game.b : x.game.a);
    const oppIds = [...new Set(sides.map(oppModel))].sort();
    const opponents: ModelOpponent[] = oppIds.map((om, k) => {
      const xs = sides.filter((x) => oppModel(x) === om);
      const byEvent = new Map<string, number[]>();
      for (const s of xs) byEvent.set(s.game.event, [...(byEvent.get(s.game.event) ?? []), s.won ? 1 : 0]);
      const mr = matchRecords(xs);
      const mw = [...mr.byEvent.values()].flat();
      return {
        model_id: om,
        model_display: registry.model(om)?.display ?? om,
        games: xs.length,
        wins: xs.filter((s) => s.won).length,
        matches: mw.length,
        match_wins: mw.filter((x) => x === 1).length,
        win_rate: rateEst([...byEvent.values()], { replicates, seed: seed + 50 + k }),
      };
    }).sort((a, b) => b.games - a.games || a.model_id.localeCompare(b.model_id));

    // Cost per condition (format × context policy), never pooled across them (2.17); the main condition on top.
    const finishedSeats = seats.filter((s) => s.ev.status === 'complete' && !s.ev.source.exclude);
    const settledSeats = seats.filter((s) => isSettled(s.ev) && !s.ev.source.exclude);
    const condOf = (s: SeatOf) => {
      const early = earlyTestData(s.ev) != null;
      const policy: CostCondition['context_policy'] = s.ev.seats.find((x) => x.name === s.seat)?.contextPolicy ?? 'harness';
      return { key: `${early ? 'early' : 'bo3'}|${policy}`, early, policy };
    };
    const condKeys = [...new Set(settledSeats.map((s) => condOf(s).key))];
    const cost_conditions: CostCondition[] = condKeys.map((key, k) => {
      const group = settledSeats.filter((s) => condOf(s).key === key);
      const { early, policy } = condOf(group[0]!);
      const info = costInfo(group.map((s) => ({ ev: s.ev, seat: s.seat, modelId })), { replicates, seed: seed + 7 + k });
      return { ...info, key, label: `${early ? `Early Test Data (${earlyTestData(group[0]!.ev)!.replace(/^early test data \((.*)\)$/, '$1')})` : 'Best of 3 with Sideboarding'} · ${POLICY_LABEL[policy]}`, early_test_data: early, context_policy: policy };
    }).sort((a, b) => Number(b.key === 'bo3|fresh-per-game') - Number(a.key === 'bo3|fresh-per-game') || Number(a.early_test_data) - Number(b.early_test_data) || b.games - a.games || a.key.localeCompare(b.key));
    const primary = cost_conditions.find((c) => c.per_game_usd) ?? cost_conditions[0];
    const cost: ModelFile['cost'] = primary
      ? (({ key: _k, label, early_test_data: _e, context_policy: _p, ...rest }) => ({ ...rest, condition: label }))(primary)
      : { ...costInfo([], { replicates: 0, seed }), condition: null };
    // Distinct games (a game between two of its own seats counts once) and the games it played against itself.
    let gamesPlayed = 0;
    let mirrorGames = 0;
    const seatSet = new Set(settledSeats.map((s) => `${s.ev.id}|${s.seat}`));
    for (const ev of new Set(settledSeats.map((s) => s.ev))) {
      for (const g of ev.games) {
        if (!g.over) continue;
        const n = g.seats.filter((x) => seatSet.has(`${ev.id}|${x}`)).length;
        if (!n) continue;
        gamesPlayed++;
        if (n === 2) mirrorGames++;
      }
    }
    const playedEvents = new Set(settledSeats.map((s) => s.ev.id)).size;
    const played = {
      games: gamesPlayed, mirror_games: mirrorGames, events: playedEvents, seats: settledSeats.length,
      text: `${gamesPlayed} game${gamesPlayed === 1 ? '' : 's'} at ${playedEvents} table${playedEvents === 1 ? '' : 's'}${mirrorGames ? `, ${mirrorGames} of them against itself` : ''}.`,
    };

    // Cards it reaches for (finished drafts, its own picks). 2.18: the pick within the pack (1–14), first picks of every
    // pack, and "most picked" from early picks only (MODEL_EARLY_PICK): late picks are forced in a closed pod, and at a
    // table where one model holds every seat it takes every card, so leftovers say nothing about preference.
    const cardMap = new Map<string, { name: string; set: string; picks: number; early: number; drafts: Set<string>; sum: number; first: number; inDecks: number }>();
    for (const s of finishedSeats) {
      const deck = s.ev.decks.get(s.seat);
      for (const p of s.ev.picks) {
        if (p.seat !== s.seat || p.by !== 'agent') continue;
        const set = s.ev.set.code.toUpperCase();
        const k = `${set}|${p.pick}`;
        const c = cardMap.get(k) ?? { name: p.pick, set, picks: 0, early: 0, drafts: new Set<string>(), sum: 0, first: 0, inDecks: 0 };
        c.picks++;
        if (p.pickNumber <= MODEL_EARLY_PICK) c.early++;
        c.drafts.add(`${s.ev.id}|${s.seat}`);
        c.sum += p.pickNumber;
        if (p.pickNumber === 1) c.first++;
        if (deck?.main.includes(p.pick)) c.inDecks++;
        cardMap.set(k, c);
      }
    }
    const cardRows: ModelCardRow[] = [...cardMap.values()].map((c) => ({
      name: c.name, set: c.set, picks: c.picks, early_picks: c.early, drafts: c.drafts.size, avg_pick: Math.round((c.sum / c.picks) * 10) / 10, first_picks: c.first, in_decks: c.inDecks,
    }));
    const mostPicked = cardRows
      .filter((c) => (c.early_picks ?? 0) > 0)
      .sort((a, b) => b.early_picks! - a.early_picks! || a.avg_pick - b.avg_pick || a.name.localeCompare(b.name))
      .slice(0, 10);
    const earliest = cardRows.filter((c) => c.picks >= 2).sort((a, b) => a.avg_pick - b.avg_pick || b.picks - a.picks || a.name.localeCompare(b.name)).slice(0, 10);

    // Events, newest first.
    const events: ModelEventRow[] = seats
      .map((s) => {
        const st = s.ev.standings.find((x) => x.name === s.seat);
        const f = s.ev.status === 'complete' ? finishOf(s.ev, s.seat) : null;
        const agents = s.ev.seats.filter((x) => x.kind === 'agent').length;
        return {
          event_id: s.ev.id,
          set: setRef(s.ev),
          started_at: s.ev.startT,
          status: s.ev.status,
          seat: s.seat,
          identity: s.identity,
          rated: groupKey(s.ev) != null && ids.of(s.ev, s.seat).rated,
          group: groupKey(s.ev),
          knowledge_label: s.ev.knowledge?.level ? (KNOWLEDGE_LABEL[s.ev.knowledge.level] ?? s.ev.knowledge.level) : null,
          colors: seatColors(s.ev, s.seat, ctx.cards),
          game_w: st?.gameWins ?? 0, game_l: st?.gameLosses ?? 0,
          match_w: st?.matchWins ?? 0, match_l: st?.matchLosses ?? 0,
          rank: f?.rank ?? null, of: f?.of ?? agents,
          won: f?.won ?? false,
          format: s.ev.format?.format ?? 'round-robin',
        } satisfies ModelEventRow;
      })
      .sort((a, b) => b.started_at - a.started_at || a.seat.localeCompare(b.seat));

    // Highlights (the `notes` key): curated first, then automatic.
    const curated = inp.curated.filter((h) => h.model_id === modelId);
    const notes = [...curated.slice(0, 3)];
    if (notes.length < 3) notes.push(...autoHighlights(finishedSeats, ids, 3 - notes.length, ctx.ratingsFor).filter((h) => !notes.some((x) => x.id === h.id)));

    const versions = [...new Set(ratings.map((r) => r.identity))].map((id) => {
      const info = ids.info.get(id);
      return effortPhrase(info?.effort_display ?? '?');
    });
    const unrated = !ratings.length
      ? (() => {
          const reasons = [...new Set(seats.map((s) => (ids.of(s.ev, s.seat).rated ? unratedReason(s.ev) : ids.of(s.ev, s.seat).verification.reason)).filter((x): x is string => !!x))];
          return reasons[0] ?? null;
        })()
      : null;
    const eventIds = new Set(ratedSeats.map((s) => s.ev.id));
    const setCodes = new Set(ratedSeats.map((s) => s.ev.set.code.toUpperCase()));
    const summary = modelSummary({
      asOf: ctx.builtAt,
      model: entry.display,
      versions,
      main: main
        ? {
            version: main.effort_display,
            conditions: gCond.get(main.group) ?? main.group_label,
            rating: main.rating, ci: main.ci, rankRange: main.rank_range, of: main.of, games: main.games, provisional: main.provisional,
          }
        : null,
      outcomes,
      events: eventIds.size || new Set(seats.map((s) => s.ev.id)).size,
      sets: eventIds.size ? setCodes.size : new Set(seats.map((s) => s.ev.set.code.toUpperCase())).size,
      minGames: DEFAULT_RATING_OPTIONS.minGames,
      unratedReason: unrated,
    });
    // 2.15: the Effort Ladder, from the board its main version is on; 2.20: the harness split, descriptive.
    const pageBoard = main ? boards.find((b) => b.id === main.board) : undefined;
    const views = pageBoard ? versionViews({ board: pageBoard, modelId, modelDisplay: entry.display, groupLabel: gLabel.get(pageBoard.group) ?? pageBoard.group, ids }) : null;
    const split = harnessSplit(settledSeats, ids);
    const provider = entry.provider ?? null;
    files.set(modelId, {
      schema_version: 2, generated_at: '', // head filled by the builder
      model: { id: modelId, display: entry.display, provider, provider_display: provider ? registry.providerDisplay(provider) : null, released: entry.released, status: entry.status, source: entry.source },
      group: pageGroup,
      group_label: pageGroup ? (gLabel.get(pageGroup) ?? pageGroup) : null,
      summary,
      ratings,
      outcomes,
      opponents,
      cost,
      cost_conditions,
      played,
      cards: { most_picked: mostPicked, earliest },
      events,
      notes,
      ...(views?.effort_ladder.length ? { effort_ladder: views.effort_ladder } : {}),
      ...(split.length ? { harness_split: split } : {}),
    });
    index.push({
      model_id: modelId,
      model_display: entry.display,
      provider,
      provider_display: provider ? registry.providerDisplay(provider) : null,
      identities,
      rated_games: outcomes.games.w + outcomes.games.l,
      rated_games_all_groups: ratedAll,
      group: pageGroup,
      events: new Set(seats.map((s) => s.ev.id)).size,
      effort_levels: views?.effort_levels ?? 0,
      harness_variants: new Set(settledSeats.map((s) => ids.of(s.ev, s.seat).harness)).size,
      main: main ? { identity: main.identity, board: main.board, rating: main.rating, ci: main.ci, rank_range: main.rank_range, of: main.of, provisional: main.provisional } : null,
      summary,
      file: `models/${modelId}.json`,
    });
  }
  index.sort((a, b) => b.rated_games - a.rated_games || a.model_id.localeCompare(b.model_id));
  return { files, index };
}

// ---------------------------------------------------------------------------
// Set summaries: what agents drafted, built and won with (no human data)

/** 2.18: model pages count a card as reached for when taken in the first picks of a pack (1–5). */
export const MODEL_EARLY_PICK = 5;

/**
 * Below these, a set's agent decks are too few for archetype findings ("most drafted", "won the table"): show n only.
 * 2.18: `events` counts independent pods (distinct seeds or packs) among the tables that feed set findings (all 8 seats
 * agents; set-findings.ts), so four re-runs of one seed are one pod.
 */
export const SET_INSIGHT_MIN = { decks: 8, events: 3 } as const;
/** An archetype's win rate needs this many games against other agents; below it only the record is shown. */
export const ARCHETYPE_RATE_MIN_GAMES = 20;

/**
 * What agents drafted, built and won with in a set. 2.18: only from tables that feed set findings (finished, all 8 seats
 * language-model agents; set-findings.ts). Mixed pods (agents with scripted drafters) are watchable and counted in
 * `insight.excluded_events`, never in a finding.
 */
export function setSummary(ctx: Ctx, code: string, ids: Identities): {
  archetypes: SetArchetype[]; deck_shape: SetDeckShape | null; commitment_median: number | null; first_picks: SetFirstPick[];
  insight: SetInsight;
} {
  const scope = findingsScope(ctx.events, code);
  const evs = scope.tables;
  const replicates = Math.min(ctx.replicates, 500);
  const pairs = new Map<string, { decks: number; byEvent: Map<string, number[]> }>();
  const roles: DeckRoles[] = [];
  const commits: number[] = [];
  const firstPicks: SetFirstPick[] = [];
  for (const ev of [...evs].sort((a, b) => b.startT - a.startT)) {
    const llm = ev.seats.filter((s) => s.llm);
    const colors = new Map(llm.filter((s) => ev.decks.has(s.name)).map((s) => [s.name, seatColors(ev, s.name, ctx.cards)]));
    for (const [seat, c] of colors) {
      const p = pairs.get(c) ?? { decks: 0, byEvent: new Map<string, number[]>() };
      p.decks++;
      pairs.set(c, p);
      const r = deckRoles(ev.decks.get(seat)!.main, ctx.cards, pairNormOf(ctx.normsFor(ev.set.code), c));
      if (r) roles.push(r);
    }
    for (const g of ev.games) {
      if (!g.over || !g.winner || g.forfeitedBy || g.seats.length !== 2 || !g.seats.every((s) => colors.has(s))) continue;
      for (const s of g.seats) {
        const p = pairs.get(colors.get(s)!)!;
        p.byEvent.set(ev.id, [...(p.byEvent.get(ev.id) ?? []), g.winner === s ? 1 : 0]);
      }
    }
    for (const s of llm) {
      const dc = draftContext(ev, s.name, ctx.cards, ctx.ratingsFor(ev.set.code), ctx.archetypesFor(ev.set.code), ctx.normsFor(ev.set.code));
      if (dc.commitmentPick != null) commits.push(dc.commitmentPick);
      const p1 = ev.picks.find((p) => p.seat === s.name && p.packNumber === 1 && p.pickNumber === 1 && p.by === 'agent');
      if (p1) {
        const id = ids.of(ev, s.name);
        firstPicks.push({ event_id: ev.id, seat: s.name, identity: id.key, model_display: ids.info.get(id.key)?.model_display ?? null, pick: p1.pick, colors: colors.get(s.name) ?? '' });
      }
    }
  }
  let k = 0;
  const archetypes: SetArchetype[] = [...pairs.entries()].map(([pair, p]) => {
    const all = [...p.byEvent.values()].flat();
    const wins = all.filter((x) => x === 1).length;
    const wr = rateEst([...p.byEvent.values()], { replicates, seed: 4242 + k++ });
    return { pair, decks: p.decks, games: all.length, wins, losses: all.length - wins, win_rate: all.length >= ARCHETYPE_RATE_MIN_GAMES ? wr : null };
  }).sort((a, b) => b.decks - a.decks || b.games - a.games || a.pair.localeCompare(b.pair));
  const avg = (f: (r: DeckRoles) => number) => Math.round((roles.reduce((n, r) => n + f(r), 0) / roles.length) * 100) / 100;
  const mvs = roles.map((r) => r.avg_mv).filter((x): x is number => x != null);
  const mvAvg = mvs.length ? Math.round((mvs.reduce((n, x) => n + x, 0) / mvs.length) * 100) / 100 : null;
  const checks: Record<string, number> = {};
  for (const r of roles) for (const [c, ok] of Object.entries(r.checks)) checks[c] = (checks[c] ?? 0) + (ok ? 1 : 0);
  return {
    archetypes,
    deck_shape: roles.length
      ? {
          decks: roles.length, lands: avg((r) => r.lands), creatures: avg((r) => r.creatures), early: avg((r) => r.early), top_end: avg((r) => r.top_end), avg_mv: mvAvg, interaction: avg((r) => r.interaction), removal: avg((r) => r.removal), passed_all: roles.filter((r) => r.passed === r.total).length, checks,
          // 2.17: how many decks were checked against their set and pair's 17Lands norms, how many against generic bands.
          norms: { set_pair: roles.filter((r) => r.basis === 'set_pair').length, generic: roles.filter((r) => r.basis === 'generic').length },
        }
      : null,
    commitment_median: commits.length ? median(commits)! : null,
    first_picks: firstPicks,
    // Every agent deck at those tables (deck roles need card data; a deck counts without it).
    insight: setInsight(scope, [...pairs.values()].reduce((n, p) => n + p.decks, 0)),
  };
}

/** 2.18: the sample behind a set's findings, in numbers and one line ("n = 16 agent decks from 2 all-agent tables"). */
export function setInsight(scope: FindingsScope, decks: number): SetInsight {
  const events = scope.tables.length;
  const pods = scope.pods;
  const early = scope.tables.filter((e) => earlyTestData(e) != null).length;
  const ready = decks >= SET_INSIGHT_MIN.decks && pods >= SET_INSIGHT_MIN.events;
  const s = (n: number) => (n === 1 ? '' : 's');
  const repeats = pods < events ? `, ${pods} different draft${s(pods)}` : '';
  const need = ready ? '' : ` (findings need ${SET_INSIGHT_MIN.decks} decks from ${SET_INSIGHT_MIN.events} different drafts)`;
  return {
    ready, decks, events, pods, early_test_events: early, excluded_events: scope.excluded.length,
    min_decks: SET_INSIGHT_MIN.decks, min_events: SET_INSIGHT_MIN.events,
    n_text: events ? `n = ${decks} agent deck${s(decks)} from ${events} all-agent table${s(events)}${repeats}${need}` : `n = 0: no all-agent tables yet${need}`,
    rule: 'all_agent_tables',
  };
}
