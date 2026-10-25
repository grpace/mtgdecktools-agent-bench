/** JSON export builders: the same derivations as the HTML pages, shaped for a client app (see schema.ts). */
import { boardStateOf } from './board-state.js';
import { mirrorCheck, MIRROR_MIN_GAMES } from './mirror.js';
import type { Ctx } from './context.js';
import { BASICS, playDrawOf, sideboardsOf, type EventData, type Game, type Ratings, type StopInfo, rating } from './data.js';
import {
  deckSummary, evaluateDraft, eventWinner, isLlmEvent, leaderboard, mean, median, playStats, seatColors, setStats, totals, type DraftSummary,
} from './metrics.js';
import {
  activeByTurn, decisionStatus, endReasonText, gameDuration, gameSides, kindLabel, lastTurn, lifeSeries, question, seatGameStats, sortedDecisions, splitView,
} from './replay-data.js';
import { DEFAULT_RATING_OPTIONS, ELO_CENTER } from './rating.js';
import { engineCards, engineSplit, gameFlags, impact } from './engine-flags.js';
import { deckRoles, pairNormOf } from './core-draft.js';
import {
  buildBoards, buildQualityOf, conditionsOf, contributorOf, harnessOf, draftContext, EARLY_TEST_DATA_LABEL, earlyTestData, FORFEIT_POLICY, groupKey, groupLabel, Identities, KNOWLEDGE_LABEL,
  MAIN_CONDITION, poolingEnabled, PROVENANCE, PROVENANCE_LABELS, unratedReason, eventRatingStatus, tableKind, tableSentence, type DraftContext,
} from './scoring.js';
import { CARD_QUALITY_VERSION } from '../../director/src/ratings.js';
import type { SeatBuildQuality } from './build-quality.js';
import { CALIBRATION } from './rating.js';
import {
  SCHEMA_MINOR, SCHEMA_VERSION, type DeckBuildQuality, type CardInfo, type CardTable, type DeckDetail, type DraftFile, type DraftSummaryRow, type EventFile, type EventSummary, type GameFile,
  type GameSummary, type GameSideboard, type GroupInfo, type Board, type Highlight, type HighlightsFile, type HistoryPoint, type IndexFile, type ModelFile, type ModelIndexRow, type SeatRef, type SetFile,
  type UsageRow, type SummaryFile, type RatingStatus,
} from './schema.js';
import { DIAGNOSTICS } from './diagnostics.js';
import { provisionalRule } from './summary.js';
import { isSwiss8, swissFinishes } from './outcomes.js';
import { autoNotes, resolveCurated, type CuratedEntry } from './highlights.js';
import { activity, buildModels, mainBoardId, ratingHistory, setSummary } from './models.js';
import { feedsSetFindings, isTestSet, PICK_GAP_RULE } from './set-findings.js';
import { PRICES } from '../../registry/src/prices.js';
import { EFFORT_SOURCE_LABELS, registryVersion } from '../../registry/src/index.js';

/** summary.json rows keep their newest event finishes only (2.10). */
export const SUMMARY_FINISHES = 10;

/**
 * A card's image, as the HTML report loads it: Scryfall's named-image endpoint, which redirects to the image on
 * cards.scryfall.io (the card data has no print ids). Loaded by the reader's browser; no image is stored here.
 */
export const scryfallImage = (name: string): string => `https://api.scryfall.com/cards/named?exact=${encodeURIComponent(name.split(' // ')[0]!)}&format=image&version=normal`;

/** Finished, countable LLM events (every finished agent table; set findings use the all-agent subset, set-findings.ts). */
const finished = (e: EventData): boolean => e.status === 'complete' && !e.source.exclude && !e.devBotFill && isLlmEvent(e);

const STOPPED_BY: Record<StopInfo['by'], string> = { organizer: 'Its Organizer', admin: 'An Admin', system: 'The Server', unknown: 'Not Recorded' };
const STOP_REASONS: Record<string, string> = {
  canceled: 'canceled', max_duration: 'it ran past the time limit', abandoned: 'no seat connected', resume_failed: 'it could not be resumed after a restart',
};

/**
 * 2.17: a stopped event's stop (METHODOLOGY §3.2 "Stopped events"), with one plain sentence for the event page. What
 * its finished games mean follows the table's rating status: rated only at a table that is rated.
 */
function stopSummary(st: StopInfo, rating?: { status: RatingStatus }): NonNullable<EventSummary['stop']> {
  const open = st.openGames.length;
  const lost = st.forfeitedGames.length;
  const why = STOP_REASONS[st.reason] ?? (st.reason && st.reason !== 'stopped' ? st.reason : null);
  const head = st.by === 'unknown'
    ? `Stopped before it finished (${why ? `${why}; ` : ''}who stopped it wasn't recorded).`
    : `Stopped by ${st.by === 'organizer' ? 'its organizer' : st.by === 'admin' ? 'an admin' : 'the server'}${why ? ` (${why})` : ''} before it finished.`;
  const finished = rating?.status === 'rated'
    ? 'Its finished games count and are rated; games never played are not results.'
    : rating?.status === 'no_rated_games'
      ? 'Its finished games count as results, but none of them is rated; games never played are not results.'
      : 'Its finished games are kept as results, but this table is not rated; games never played are not results.';
  const openText = !open ? '' : lost === open
    ? ` The ${open === 1 ? 'game' : `${open} games`} still being played ${open === 1 ? 'counts' : 'count'} as a loss for the organizer's own seat.`
    : ` ${open - lost === 1 ? 'The game' : `${open - lost} games`} still being played ${open - lost === 1 ? 'is' : 'are'} void (not results)${lost ? `, and ${lost} ${lost === 1 ? 'counts' : 'count'} as a loss for the organizer's own seat` : ''}.`;
  return {
    by: st.by, by_display: STOPPED_BY[st.by], reason: st.reason, open_games: open, forfeited_games: lost,
    text: `${head} ${finished}${openText}`,
  };
}

const r2 = (x: number): number => Math.round(x * 100) / 100;
const nul = <T>(x: T | undefined | null): T | null => (x == null || (typeof x === 'number' && Number.isNaN(x)) ? null : x);

/** How 17Lands-derived numbers are presented: an optional, credited comparison with human drafters (METHODOLOGY §5). */
export const HUMAN_REFERENCE = {
  label: 'Compared with human drafters',
  source: '17Lands public datasets',
  url: 'https://www.17lands.com/public_datasets',
  license: 'CC BY 4.0',
  note: 'Human reference from 17Lands public data (CC BY 4.0); derived aggregates, not endorsed by 17Lands.',
} as const;

/** event_start.ratings (the Director's Ratings.source) → the policy that valued fallback picks and reference builds. */
export function botPolicy(source: string | undefined): 'win_rates' | 'card_quality' | 'rarity_prior' | undefined {
  if (!source) return undefined;
  if (/card-quality/.test(source)) return 'card_quality';
  if (/rarity prior/.test(source)) return 'rarity_prior';
  if (/GIH WR|win rate/i.test(source)) return 'win_rates';
  return undefined;
}

function deckBuildQuality(q: SeatBuildQuality): DeckBuildQuality {
  const { sources: _sources, ...shape } = q.shape;
  return {
    pair: q.pair,
    quality: q.build_quality,
    expected_wr: q.expected_wr,
    reference: { pair: q.reference_pair, quality: q.reference_quality, expected_wr: q.reference_expected_wr },
    best: q.best_pair != null && q.best_quality != null ? { pair: q.best_pair, quality: q.best_quality, expected_wr: q.best_expected_wr } : null,
    build_delta_pp: q.build_delta_pp,
    build_delta_wr_pp: q.build_delta_wr_pp,
    vs_best_pp: q.vs_best_pp,
    vs_best_wr_pp: q.vs_best_wr_pp,
    shape,
    checked: q.checked,
    flags: q.flags,
    unrated: q.unrated,
    uncastable: q.dead,
    splash: q.splash,
    validation: q.verdict,
  };
}

export class JsonBuilder {
  readonly generatedAt: string;
  /** Rarity per card name, from the booster sheets seen in any event (pack_rarities). */
  private rarities = new Map<string, string>();
  readonly identities: Identities;

  constructor(
    readonly ctx: Ctx,
    /** docs/METHODOLOGY.md as shipped in the export (methodology.md), when found. */
    readonly methodologyDoc: { file: string; sha256: string } | null = null,
    /** 2.8: hand-curated highlights (highlights/curated.json). */
    readonly curated: CuratedEntry[] = [],
  ) {
    this.identities = new Identities(ctx.events);
    this.generatedAt = new Date(ctx.builtAt).toISOString();
    for (const ev of ctx.events) {
      for (const p of ev.picks) p.rarities?.forEach((r, i) => p.contents[i] && !this.rarities.has(p.contents[i]!) && this.rarities.set(p.contents[i]!, r));
    }
  }

  private head() {
    return { schema_version: SCHEMA_VERSION, schema_minor: SCHEMA_MINOR, generated_at: this.generatedAt };
  }

  private derivedCache?: {
    boards: Board[]; groups: GroupInfo[]; mainBoard: string | null; history: Map<string, Map<string, HistoryPoint[]>>;
    highlights: Highlight[]; unresolved: Array<{ id: string; reason: string }>; models?: { files: Map<string, ModelFile>; index: ModelIndexRow[] };
  };

  /** Boards, groups, rating history and resolved highlights: computed once per builder (index, model files and highlights share them). */
  private derived() {
    if (this.derivedCache) return this.derivedCache;
    const { ctx } = this;
    const { boards, groups } = buildBoards({
      events: ctx.events, identities: this.identities, replicates: ctx.replicates, cards: ctx.cards, ratingsFor: ctx.ratingsFor, archetypesFor: ctx.archetypesFor,
      normsFor: ctx.normsFor, asOf: ctx.builtAt, mainPrompts: ctx.mainPrompts,
    });
    for (const ev of ctx.events) for (const s of ev.seats.filter((x) => x.llm)) this.identities.of(ev, s.name);
    const { highlights, unresolved } = resolveCurated(this.curated, ctx.events, this.identities, ctx.ratingsFor);
    this.derivedCache = { boards, groups, mainBoard: mainBoardId(boards), history: ratingHistory(ctx, this.identities), highlights, unresolved };
    return this.derivedCache;
  }

  private modelData() {
    const d = this.derived();
    d.models ??= buildModels({ ctx: this.ctx, ids: this.identities, boards: d.boards, groups: d.groups, history: d.history, curated: d.highlights, mainBoard: d.mainBoard });
    return d.models;
  }

  /** 2.8: models/<model_id>.json for every registry-listed model with a seat. */
  models(): Array<[string, ModelFile]> {
    return [...this.modelData().files].map(([id, f]) => [id, { ...f, ...this.head() }]);
  }

  /** 2.8: highlights.json (every resolved curated highlight, and the ones that didn't resolve). */
  highlightsFile(): HighlightsFile {
    const d = this.derived();
    return { ...this.head(), highlights: d.highlights, unresolved: d.unresolved };
  }

  card(name: string, ratings: Ratings | null): CardInfo {
    const c = this.ctx.cards.get(name);
    const r = rating(ratings, name);
    const info: CardInfo = {
      cost: c ? c.cost : null,
      type_line: c ? c.typeLine : BASICS.has(name) ? 'Basic Land' : null,
      colors: this.ctx.cards.colors(name),
      mv: c && !/\bLand\b/.test(c.typeLine) ? (this.ctx.cards.mv(name) ?? null) : null,
      gih_wr: nul(r?.gih_wr),
      ata: nul(r?.ata),
    };
    if (c?.pt) info.pt = c.pt;
    if (c?.loyalty) info.loyalty = c.loyalty;
    if (c?.oracle) info.oracle = c.oracle;
    const rar = this.rarities.get(name);
    if (rar) info.rarity = rar;
    info.image_uri = scryfallImage(name);
    return info;
  }

  cardTable(names: Iterable<string>, ratings: Ratings | null): CardTable {
    const out: CardTable = {};
    for (const n of [...new Set(names)].sort()) out[n] = this.card(n, ratings);
    return out;
  }

  seatRef(ev: EventData, name: string): SeatRef {
    const s = ev.seats.find((x) => x.name === name);
    const tr = ev.transcripts.get(name);
    const ref: SeatRef = { name, kind: s?.kind ?? 'agent', position: s?.position ?? -1, llm: s?.llm ?? false, model: s?.model ?? name };
    const h = harnessOf(ev, name);
    const harness = s?.harness ?? (h === 'unknown' ? undefined : h);
    if (harness) ref.harness = harness;
    if (s?.modelId ?? tr?.model) ref.model_id = (s?.modelId ?? tr?.model)!;
    if (s?.effort) ref.effort = s.effort;
    if (s?.llm) {
      // 2.4: canonical identity from the registry, resolved from the log's raw strings at export time.
      const id = this.identities.of(ev, name);
      const info = this.identities.info.get(id.key);
      ref.identity = id.key;
      ref.harness = id.harness;
      ref.model_id = id.model;
      ref.effort = id.effort;
      // The seat's own harness (2.20: an identity spans harnesses).
      ref.harness_id = id.harness;
      ref.harness_display = this.identities.harnessDisplay(id.harness);
      if (info) {
        ref.model_display = info.model_display!;
        ref.provider = info.provider ?? null;
        ref.effort_display = info.effort_display!;
      }
      if (id.alias && id.alias !== id.model) ref.model_declared = id.alias;
      if (id.launcher) {
        ref.launcher = id.launcher;
        ref.launcher_display = this.identities.launcherDisplay(id.launcher);
      }
      ref.model_verification = id.verification;
      ref.rated = id.rated;
      ref.contributor = contributorOf(ev, name, this.ctx.contributorPublic);
      ref.context_policy = s.contextPolicy ?? 'harness';
      if (id.effortInfo) {
        const { effort: _e, source, ...rest } = id.effortInfo;
        ref.effort_source = source;
        ref.effort_resolution = { source, source_display: EFFORT_SOURCE_LABELS[source], ...rest };
      }
    }
    return ref;
  }

  // -------------------------------------------------------------------------

  eventSummary(ev: EventData): EventSummary {
    const agents = ev.seats.filter((s) => s.kind === 'agent');
    const done = ev.games.filter((g) => g.over).length;
    const out: EventSummary = {
      id: ev.id,
      set: setRef(ev),
      started_at: ev.startT,
      last_activity_at: ev.lastT,
      status: ev.status,
      stage: ev.stage,
      llm: isLlmEvent(ev),
      best_of: ev.bestOf,
      agents: agents.map((s) => ({ name: s.name, model: s.model, llm: s.llm, colors: seatColors(ev, s.name, this.ctx.cards) })),
      bot_seats: ev.seats.length - agents.length,
      winner: eventWinner(ev) ?? null,
      games_played: done,
      games_live: ev.status === 'complete' ? 0 : ev.games.length - done,
      matches_done: ev.matches.filter((m) => m.done).length,
      matches_expected: matchesExpected(ev, agents.length),
      format: ev.format ? { pairing: ev.format.format, rounds: ev.format.rounds } : { pairing: 'round-robin', rounds: agents.length < 2 ? 0 : agents.length % 2 ? agents.length : agents.length - 1 },
      table: ev.table?.kind === 'lobby' || ev.table?.kind === 'private' ? ev.table.kind : null,
      ...(ev.devBotFill ? { dev_bot_fill: true as const } : {}),
      source: ev.source.label,
      provenance: PROVENANCE[ev.source.label] as 'hosted' | 'community' | 'test',
      provenance_display: PROVENANCE_LABELS[PROVENANCE[ev.source.label]],
      // Early test tables: fewer than 8 agents, or scripted or bot drafters at the table.
      test_table: agents.length < 8 || ev.seats.some((s) => !s.llm),
      llm_agents: ev.seats.filter((s) => s.llm).length,
      scripted_seats: ev.seats.filter((s) => !s.llm).length,
      // 2.18: only finished tables whose 8 seats are all agents feed set findings (set-findings.ts).
      in_set_findings: feedsSetFindings(ev),
      group: groupKey(ev),
      conditions: conditionsOf(ev),
      // 2.13: Early Test Data (best of 1, or best of 3 without sideboarding): visible, never rated.
      test_data: earlyTestData(ev) != null,
      test_data_label: earlyTestData(ev) ? EARLY_TEST_DATA_LABEL : null,
      sideboarding: ev.sideboarding === true,
      play_draw: ev.playDrawRule ?? null,
    };
    // 2.11: "Rated" only with rated games; a table of one setup is pooled but has none ("No Rated Games").
    if (out.llm) {
      const r = eventRatingStatus(ev, this.identities);
      out.rating_status = r.status;
      out.rating_display = r.display;
      out.rated_games = r.rated_games;
      if (r.reason) out.rating_reason = r.reason;
    }
    // 2.17: the table kind and its sentence (no winner "of N agents" at a scripted, mirror or single-model table).
    out.table_kind = tableKind(ev, this.identities);
    out.table_text = tableSentence(ev, this.identities, (k) => this.identities.info.get(k)?.label ?? k, eventWinner(ev));
    if (ev.stop) out.stop = stopSummary(ev.stop, out.rating_status ? { status: out.rating_status } : undefined);
    if (ev.seed) out.seed = ev.seed;
    if (ev.knowledge?.level) out.knowledge_level = ev.knowledge.level;
    if (ev.mana) out.mana = ev.mana;
    return out;
  }

  index(): IndexFile {
    const { ctx } = this;
    const llmEvents = ctx.events.filter(isLlmEvent);
    const lb = leaderboard(llmEvents, ctx.ratingsFor, ctx.cards);
    const t = totals(ctx.events);
    const { boards, groups, mainBoard, history, highlights } = this.derived();
    const models = this.modelData();
    return {
      ...this.head(),
      generator: '@mtgdt/site',
      totals: { llm_events: t.llmEvents, llm_events_finished: llmEvents.filter(finished).length, live_events: t.liveEvents, llm_games: t.llmGames, decisions: t.decisions, agent_picks: t.agentPicks },
      leaderboard: lb.map((r) => {
        const gp = r.gameW + r.gameL;
        return {
          model: r.model,
          model_ids: [...r.modelIds],
          harnesses: [...r.harness],
          events: r.events,
          in_progress: r.inProgress,
          match_w: r.matchW, match_l: r.matchL, game_w: r.gameW, game_l: r.gameL,
          game_win_rate: gp ? r.gameW / gp : null,
          top_pick_rate: r.agreementN ? r.agreementHits / r.agreementN : null,
          rated_picks: r.agreementN,
          avg_regret_pp: nul(mean(r.regrets)),
          decisions: r.decisions,
          median_latency_ms: nul(median(r.latencies)),
          median_pick_latency_ms: nul(median(r.pickLatencies)),
          rejected_per_100: r.decisions ? (r.rejected / r.decisions) * 100 : null,
          cost_usd: r.costSeats ? r.costUsd : null,
          cost_seats: r.costSeats,
          cost_per_game_usd: r.costSeats && r.gamesPlayedWithCost ? r.costUsd / r.gamesPlayedWithCost : null,
          output_tokens: r.outputTokens,
          seats: r.seats.map((s) => ({ event_id: s.event.id, seat: s.seat })),
        };
      }),
      events: ctx.events.map((ev) => this.eventSummary(ev)),
      sets: ctx.sets.map((code) => {
        const evs = ctx.events.filter((e) => e.set.code.toUpperCase() === code);
        const first = evs[0]!;
        const out: IndexFile['sets'][number] = {
          code, name: first.set.name, events: evs.length, llm_events: evs.filter(isLlmEvent).length, has_ratings: ctx.ratingsFor(code) != null,
        };
        if (first.set.releaseDate) out.release_date = first.set.releaseDate;
        if (isTestSet(first.set.releaseDate, ctx.builtAt)) out.test_set = true;
        if (ctx.archetypesFor(code)) out.has_archetypes = true;
        if (ctx.normsFor(code)) out.has_deck_norms = true;
        out.featured = ctx.featured.has(code);
        out.has_set_context = ctx.hasSetContext(code);
        out.llm_events_finished = evs.filter(finished).length;
        // 2.17: archetype findings only with enough decks and tables (SET_INSIGHT_MIN); n always. 2.18: only from
        // all-agent tables, the minimum counted in independent drafts (setSummary).
        const sum = setSummary(ctx, code, this.identities);
        out.insight = sum.insight;
        out.top_archetypes = sum.insight.ready ? sum.archetypes.slice(0, 3).map((a) => ({ pair: a.pair, decks: a.decks, games: a.games, wins: a.wins, losses: a.losses })) : [];
        return out;
      }),
      legacy_runs: ctx.legacy.map((l) => ({ id: l.id, started_at: l.t, log_lines: l.events, decisions: l.decisions })),
      methodology: {
        doc: this.methodologyDoc?.file ?? null,
        doc_sha256: this.methodologyDoc?.sha256 ?? null,
        rating: {
          model: 'bradley-terry', scale: 'elo', center: ELO_CENTER, prior_sd_elo: DEFAULT_RATING_OPTIONS.priorSdElo, play_prior_sd_elo: DEFAULT_RATING_OPTIONS.playPriorSdElo,
          replicates: ctx.replicates, ci: DEFAULT_RATING_OPTIONS.ci, bootstrap: 'clusters', interval: 'max(bootstrap, laplace)', ranking: 'difference-intervals',
          contributor_cluster_min: DEFAULT_RATING_OPTIONS.contributorClusterMin, contributor_cap: DEFAULT_RATING_OPTIONS.contributorCap, pooling: poolingEnabled(),
        },
        thresholds: {
          min_games: DEFAULT_RATING_OPTIONS.minGames, min_events: DEFAULT_RATING_OPTIONS.minEvents, min_opponents: DEFAULT_RATING_OPTIONS.minOpponents,
          min_contributors: DEFAULT_RATING_OPTIONS.minContributors, max_contributor_share: DEFAULT_RATING_OPTIONS.maxContributorShare,
          rule: provisionalRule(DEFAULT_RATING_OPTIONS),
        },
        forfeits: {
          policy: FORFEIT_POLICY,
          options: ['exclude-game', 'loss', 'void-seat-event'],
          summary: FORFEIT_POLICY === 'exclude-game'
            ? 'A game the inactivity watchdog concedes for a silent seat is left out of the rating; the seat\u2019s other games count. It counts against the seat\u2019s reliability and stays a loss in the match record.'
            : FORFEIT_POLICY === 'loss'
              ? 'A game the inactivity watchdog concedes for a silent seat counts as a loss for that seat and a win for its opponent, in the rating and the outcomes, as when a player leaves a tournament. It also counts against the seat\u2019s reliability. Voided games (engine failures, replayed from the start) stay unrated.'
              : 'Every rated game of a seat that forfeited anything in an event is left out, wins included.',
        },
        main_condition: { ...MAIN_CONDITION, prompts: 'current', label: groupLabel(MAIN_CONDITION) },
        early_test_data: {
          label: EARLY_TEST_DATA_LABEL,
          summary: 'Events played before the benchmark standardized on best of 3 with sideboarding (best of 1, or best of 3 without sideboarding). They stay visible, with their games and replays, but are never rated and never count toward a board, a diagnostic or rated games.',
          reasons: ['early test data (best of 1)', 'early test data (best of 3 without sideboarding)'],
        },
        source_labels: { verified: PROVENANCE_LABELS.hosted, community: PROVENANCE_LABELS.community, smoke: PROVENANCE_LABELS.test, hosted: PROVENANCE_LABELS.hosted, test: PROVENANCE_LABELS.test },
        unrated_events: llmEvents.filter((ev) => unratedReason(ev)).map((ev) => ({ id: ev.id, reason: unratedReason(ev)! })),
        calibration: { ...CALIBRATION },
        human_reference: { ...HUMAN_REFERENCE, sets: ctx.sets.filter((code) => ctx.ratingsFor(code) != null) },
        // 2.4: which model registry resolved the identities (registry/README.md).
        registry: { version: registryVersion().version, sha256: registryVersion().sha256, doc: 'registry/README.md' },
        card_quality: {
          version: CARD_QUALITY_VERSION,
          doc: 'methodology.md#51-draft',
          summary: 'Card value from card data alone (rarity, mana value, power and toughness for the cost, combat keywords, removal and other interaction, card advantage, color requirements). Powers the core draft metrics and fallback picks in sets without human data.',
        },
        build_quality: Object.fromEntries(
          ctx.sets.flatMap((code) => {
            const n = ctx.normsFor(code);
            if (!n) return [];
            const v = n.validation as Record<string, unknown>;
            const f = (k: string) => (typeof v[k] === 'number' ? (v[k] as number) : null);
            return [[code, { verdict: n.verdict, archetype_weight: n.archetypeWeight, auc_model: f('auc_model'), auc_overall_gih: f('auc_overall_gih'), deck_pearson: f('deck_pearson'), slope_logit_per_pp: nul(n.slope) }]];
          }),
        ),
        diagnostics: DIAGNOSTICS,
        // 2.15: mirror games are never rated; the mirror check below monitors them.
        mirror_games: { rated: false, check_min_games: MIRROR_MIN_GAMES },
        outcomes: { interval: 'max(bootstrap, wilson)', ci: DEFAULT_RATING_OPTIONS.ci, trophy: 'a 3–0 finish at a three-round Swiss event of 8 agents' },
        cost: {
          prices: 'registry/prices.json',
          checked: PRICES.prices.map((p) => p.checked).sort().pop() ?? null,
          summary: 'Cost per game is the harness-reported cost where there is one (an API-equivalent figure for subscriptions), else an estimate: the seat’s token counts at the model’s list price on the event’s start day, from the provider’s official pricing page. Drafting and deckbuilding are included. basis says which kind a number is.',
        },
      },
      groups,
      boards,
      identities: [...this.identities.info.values()].sort((a, b) => a.key.localeCompare(b.key)),
      models: models.index,
      activity: activity(ctx, this.identities, history, groups),
      highlights: highlights.filter((h) => h.featured),
      main_board: mainBoard,
      mirror_check: mirrorCheck(ctx, this.identities),
    };
  }

  // -------------------------------------------------------------------------

  gameSummary(ev: EventData, g: Game): GameSummary {
    const out: GameSummary = {
      index: g.index,
      label: g.label,
      match_key: g.matchKey,
      game_in_match: g.gameInMatch,
      seats: g.seats,
      sides: gameSides(g),
      status: g.over ? 'complete' : ev.status === 'in-progress' ? 'live' : 'abandoned',
      winner: g.winner,
      turns: nul(g.turns),
      last_turn: lastTurn(g),
      started_at: g.startT,
      ended_at: nul(g.endT),
      duration_ms: gameDuration(ev, g),
      decisions: Object.fromEntries(g.seats.map((s) => [s, g.decisions.filter((d) => d.seat === s && d.answer).length])),
    };
    if (g.code) out.table_code = g.code;
    if (g.mana ?? ev.mana) out.mana = (g.mana ?? ev.mana)!;
    if (g.onPlay) out.on_play = g.onPlay;
    const reason = endReasonText(g.endReason);
    if (reason) out.end_reason = reason;
    if (g.finalLife) out.final_life = g.finalLife;
    if (g.mulligans) out.mulligans = g.mulligans;
    out.engine_flags = gameFlags(ev, g);
    // 2.13: the play/draw decision and each seat's sideboarding before the game (public parts only while live).
    const pd = playDrawOf(ev, g);
    if (pd) {
      out.play_draw = { on_play: pd.onPlay, chooser: pd.chooser, choice: pd.choice, by: pd.by };
      if (pd.note) out.play_draw.note = pd.note;
      if (pd.latencyMs != null) out.play_draw.latency_ms = pd.latencyMs;
    }
    const sbs = sideboardsOf(ev, g);
    if (sbs.length) {
      out.sideboarding = Object.fromEntries(sbs.map((sb) => {
        const row: GameSideboard = { by: sb.by, kept: sb.kept, in: sb.in, out: sb.out, main_count: sb.mainCount };
        if (sb.note) row.note = sb.note;
        if (sb.latencyMs != null) row.latency_ms = sb.latencyMs;
        if (sb.withheld) row.withheld = true;
        return [sb.seat, row];
      }));
    }
    if (g.deckSizes && Object.keys(g.deckSizes).length) out.deck_sizes = g.deckSizes;
    return out;
  }

  draftRow(ev: EventData, ds: DraftSummary, dc?: DraftContext): DraftSummaryRow {
    const s = ev.seats.find((x) => x.name === ds.seat)!;
    const row: DraftSummaryRow = {
      seat: ds.seat,
      position: s.position,
      kind: s.kind,
      drafter: s.kind === 'bot' ? 'bot' : s.llm ? 'llm' : 'scripted',
      colors: ds.colors,
      picks: ds.picks,
      choices: ds.choices,
      rated: ds.rated,
      top_pick_rate: nul(ds.agreement),
      avg_picked_gih: nul(ds.avgPickedGih),
      avg_best_gih: nul(ds.avgBestGih),
      avg_regret_pp: nul(ds.avgRegret),
      avg_lane_regret_pp: nul(ds.avgLaneRegret),
      lane_picks: ds.lanePicks,
      median_latency_ms: nul(ds.medianLatencyMs),
    };
    if (dc) {
      const m = (xs: number[]) => nul(mean(xs));
      row.conversion = m(dc.conversion);
      row.p1_conversion = m(dc.p1Conversion);
      row.commitment_pick = nul(dc.commitmentPick);
      row.signal_alignment = nul(dc.signalAlignment);
      if (dc.openColors) row.open_colors = dc.openColors;
      if (dc.pair) row.arch_pair = dc.pair;
      if (dc.archRegret.length || dc.archCurrentRegret.length) {
        row.arch_regret_pp = m(dc.archRegret);
        row.arch_current_regret_pp = m(dc.archCurrentRegret);
      }
      if (dc.expert.length) {
        const ranked = dc.expert.filter((e) => e.rank != null);
        row.expert_picks = dc.expert.length;
        row.expert_top1 = ranked.length ? ranked.filter((e) => e.rank === 1).length / ranked.length : null;
        row.expert_mean_log_p = m(dc.expert.filter((e) => e.p != null).map((e) => Math.log(Math.max(1e-4, e.p!))));
        row.expert_ev_regret_pp = m(dc.expert.filter((e) => e.evRegretPp != null).map((e) => e.evRegretPp!));
      }
      const st = ev.strength?.seats.get(ds.seat);
      if (st) {
        row.deck_strength = nul(st.agent?.winRate);
        row.reference_strength = nul(st.reference?.winRate);
      }
      // 2.3 core metrics (card data only)
      if (dc.flow) {
        row.flow = Object.fromEntries(Object.entries(dc.flow.shares).map(([c, v]) => [c, Math.round(v * 1000) / 1000]));
        row.flow_colors = dc.flow.top;
      }
      row.flow_alignment = nul(dc.flowAlignment);
      row.on_color_rate = m(dc.onColor);
      row.pair_changes = nul(dc.pairChanges);
      row.role_coverage = dc.roles ? dc.roles.passed / dc.roles.total : null;
    }
    return row;
  }

  private draftOf(ev: EventData, seat: string): DraftSummary {
    return evaluateDraft(seat, ev.picks, this.ctx.ratingsFor(ev.set.code), this.ctx.cards, seatColors(ev, seat, this.ctx.cards));
  }

  private contextOf(ev: EventData, seat: string): DraftContext {
    return draftContext(ev, seat, this.ctx.cards, this.ctx.ratingsFor(ev.set.code), this.ctx.archetypesFor(ev.set.code), this.ctx.normsFor(ev.set.code));
  }

  event(ev: EventData): EventFile {
    const { ctx } = this;
    const ratings = ctx.ratingsFor(ev.set.code);
    const agents = ev.seats.filter((s) => s.kind === 'agent');
    const done = ev.games.filter((g) => g.over).length;
    const decks: DeckDetail[] = [];
    for (const s of agents) {
      const d = ev.decks.get(s.name);
      if (!d) continue;
      const sum = deckSummary(d, ctx.cards, ratings, seatColors(ev, s.name, ctx.cards));
      const qty = (xs: Array<[string, number]>) => xs.map(([name, n]) => ({ name, qty: n }));
      const dd: DeckDetail = {
        seat: d.seat,
        by: d.by,
        colors: sum.colors,
        main_count: sum.mainCount,
        land_count: sum.landCount,
        avg_gih_wr: nul(sum.avgGih),
        curve: sum.curve,
        groups: sum.groups.map((g) => ({
          type: g.type,
          label: g.type === 'Other' && !ctx.cards.loaded ? 'Spells' : g.type === 'Sorcery' ? 'Sorceries' : `${g.type}s`,
          count: g.total,
          cards: qty(g.cards),
        })),
        basics: qty(sum.basics),
        sideboard: qty(sum.sideboard),
      };
      if (d.note) dd.note = d.note;
      if (d.latencyMs != null) dd.latency_ms = d.latencyMs;
      const bq = buildQualityOf(ev, s.name, ctx.cards, ratings, ctx.archetypesFor(ev.set.code), ctx.normsFor(ev.set.code));
      if (bq) dd.build_quality = deckBuildQuality(bq);
      const roles = deckRoles(d.main, ctx.cards, pairNormOf(ctx.normsFor(ev.set.code), seatColors(ev, s.name, ctx.cards)));
      if (roles) dd.roles = roles;
      decks.push(dd);
    }
    const usage: UsageRow[] = [];
    for (const s of agents) {
      const tr = ev.transcripts.get(s.name);
      if (!tr) continue;
      const row: UsageRow = {
        seat: s.name,
        harness: s.harness ?? 'claude-code',
        model: nul(tr.model),
        done: tr.done,
        empty: tr.lines === 0,
        cost_usd: tr.done ? nul(tr.costUsd) : null,
        duration_ms: nul(tr.durationMs),
        api_duration_ms: nul(tr.apiDurationMs),
        num_turns: nul(tr.numTurns),
        input_tokens: tr.inputTokens,
        output_tokens: tr.outputTokens,
        cache_read_tokens: tr.cacheReadTokens,
        cache_creation_tokens: tr.cacheCreationTokens,
        thinking_tokens: nul(tr.thinkingTokens),
        tool_calls: tr.toolCalls,
        tool_errors: tr.toolErrors,
        is_error: tr.isError ?? false,
      };
      if (tr.resultText) row.result_text = tr.resultText;
      usage.push(row);
    }
    const swaps = ev.packs.flatMap((p) => (p.swaps ?? []).map((s) => ({ round: p.round, from: s.from, to: s.to })));
    const cardNames = [
      ...[...ev.decks.values()].filter((d) => agents.some((a) => a.name === d.seat)).flatMap((d) => [...d.main, ...d.sideboard]),
      ...swaps.flatMap((s) => [s.from, s.to]),
      ...(ev.sideboards ?? []).flatMap((sb) => [...sb.in, ...sb.out].map((c) => c.name)),
    ];
    const seatsByPos = [...ev.seats].sort((a, b) => a.position - b.position);
    return {
      ...this.head(),
      event: this.eventSummary(ev),
      config: {
        seed: ev.seed,
        best_of: ev.bestOf,
        mana: ev.mana,
        prompt_version: ev.promptVersion,
        knowledge: ev.knowledge ? { ...ev.knowledge, label: KNOWLEDGE_LABEL[ev.knowledge.level] ?? ev.knowledge.level } : null,
        ratings_source: ev.ratingsSource,
        // The 17Lands snapshot the event ran with (fallback picks, reference builds): fixed by the log.
        ...(ev.ratingsSnapshot ? { ratings_snapshot: ev.ratingsSnapshot } : {}),
        ...(botPolicy(ev.ratingsSource) ? { bot_policy: botPolicy(ev.ratingsSource) } : {}),
        seats: seatsByPos.map((s) => this.seatRef(ev, s.name)),
        source: {
          label: ev.source.label,
          inferred: ev.source.inferred,
          // The uploader's handle only for a contributor public now (contributorOf); never by default.
          ...(ev.source.submitter && ev.source.submitterId && ctx.contributorPublic?.(ev.source.submitterId) ? { submitter: ev.source.submitter } : {}),
          ...(ev.source.submittedAt ? { submitted_at: ev.source.submittedAt } : {}),
          ...(ev.source.exclude ? { excluded: ev.source.exclude } : {}),
          ...(ev.source.note ? { note: ev.source.note } : {}),
        },
        conditions: conditionsOf(ev),
        group: groupKey(ev),
        ...(unratedReason(ev) ? { unrated_reason: unratedReason(ev) } : {}),
        sideboarding: ev.sideboarding === true,
        play_draw: ev.playDrawRule ?? null,
        inputs: {
          strength: ev.strength != null, draft_eval: ev.draftEval != null, archetypes: ctx.archetypesFor(ev.set.code) != null, deck_norms: ctx.normsFor(ev.set.code) != null,
          ratings: ratings != null,
          // The human-reference layer is recomputed at export time from the latest 17Lands snapshot (docs/UPGRADING.md).
          ...(ratings ? { ratings_snapshot: { id: ratings.snapshot ?? null, date_range: ratings.dateRange ?? null } } : {}),
        },
      },
      stages: {
        draft: { picks: ev.picks.length, done: ev.stage !== 'draft' },
        build: { decks: agents.filter((a) => ev.decks.has(a.name)).length, agents: agents.length, done: agents.length > 0 && agents.every((a) => ev.decks.has(a.name)) },
        games: { played: done, live: ev.status === 'complete' ? 0 : ev.games.length - done, done: ev.status === 'complete' },
      },
      standings: ev.standings.map((st, i) => {
        const ps = playStats(ev.games, st.name);
        return {
          rank: i + 1,
          name: st.name,
          llm: ev.seats.find((s) => s.name === st.name)?.llm ?? false,
          colors: seatColors(ev, st.name, ctx.cards),
          match_w: st.matchWins, match_l: st.matchLosses, game_w: st.gameWins, game_l: st.gameLosses,
          decisions: ps.answered,
          median_latency_ms: nul(median(ps.latencies)),
        };
      }),
      standings_final: ev.status === 'complete',
      // 2.11: a fact about the table, rated games or not.
      ...(ev.status === 'complete' && isSwiss8(ev) ? { swiss_finishes: swissFinishes([ev], (e, seat) => this.identities.of(e, seat).key) } : {}),
      matches: ev.matches.map((m) => ({ key: m.key, a: m.a, b: m.b, wins: m.wins, done: m.done, games: m.games.map((g) => g.index), ...(m.noResult ? { no_result: true as const } : {}) })),
      games: ev.games.map((g) => this.gameSummary(ev, g)),
      decks,
      drafts: seatsByPos.map((s) => this.draftRow(ev, this.draftOf(ev, s.name), this.contextOf(ev, s.name))),
      usage,
      swaps,
      cards: this.cardTable(cardNames, ratings),
      ...(ev.withheld ? { withheld: ev.withheld } : {}),
      ...(ev.rulesIssues.length ? { rules_issues: ev.rulesIssues.map((r) => ({ seat: r.seat, card: r.card, note: r.note, ...(r.stage ? { stage: r.stage } : {}), t: r.t })) } : {}),
      highlights: this.eventHighlights(ev),
    };
  }

  /** 2.9: an event's best moments: curated highlights first, then automatic candidates (finished games only). */
  eventHighlights(ev: EventData, n = 3): Highlight[] {
    const curated = this.derived().highlights.filter((h) => h.event_id === ev.id);
    const seats = ev.seats.filter((s) => s.llm).map((s) => ({ ev, seat: s.name }));
    const auto = curated.length >= n || ev.status !== 'complete' ? [] : autoNotes(seats, this.identities, n - curated.length, this.ctx.ratingsFor);
    return [...curated.slice(0, n), ...auto.filter((h) => !curated.some((c) => c.id === h.id))];
  }

  /**
   * 2.9: summary.json, the small file Home, Watch and Learn need: totals, the main board without diagnostics, every
   * condition group's all-sets board as one line, models, activity, featured highlights, sets and the latest events.
   */
  /** summary.json (2.9): what Home, Watch and Learn need, kept small (docs/SITE-DATA.md "summary.json"). */
  summaryOf(idx: IndexFile): SummaryFile {
    const label = (k: string) => idx.identities.find((i) => i.key === k);
    const main = idx.boards.find((b) => b.id === idx.main_board) ?? null;
    const glabel = new Map(idx.groups.map((g) => [g.key, g.label]));
    // A row is live while one of its seats sits at a table still in progress (the board's "Playing Now" mark).
    const liveEvents = new Set(idx.events.filter((e) => e.status === 'in-progress').map((e) => e.id));
    return {
      ...this.head(),
      generator: '@mtgdt/site',
      totals: idx.totals,
      main_board: idx.main_board ?? null,
      main: main
        ? {
            id: main.id, group: main.group, label: glabel.get(main.group) ?? main.group, summary: main.summary ?? '', events: main.events, games: main.games,
            connected_groups: main.connected_groups ?? [],
            // 2.10: head to head on the main board, so Home's Results never need index.json.
            pairwise: main.pairwise ?? [],
            rows: main.rows.filter((r) => r.rating != null).map((r) => {
              const i = label(r.identity);
              return {
                identity: r.identity, label: i?.label ?? r.identity, model_id: i?.model_id ?? null, model_display: i?.model_display ?? null,
                harness_display: null, effort_display: i?.effort_display ?? null,
                rating: r.rating, ci: r.ci, rank_range: r.rank_range ?? null, rank_of: r.rank_of ?? null, default_ranking: r.default_ranking ?? true,
                provisional: r.provisional, games: r.games, wins: r.wins, losses: r.losses, events: r.events, contributors: r.contributors ?? null,
                expected_score: r.expected_score ?? null,
                // 2.10: what the board row shows without index.json.
                provisional_reasons: r.provisional_reasons,
                games_needed: r.games_needed ?? 0,
                contributor_floor_met: r.contributor_floor_met ?? null,
                influence: r.influence ?? null,
                cost: r.cost ? { per_game_usd: r.cost.per_game_usd, basis: r.cost.basis } : null,
                // The newest few finishes only, to keep the file small; events.played and events.won count them all.
                outcomes: r.outcomes
                  ? { ...r.outcomes, events: { ...r.outcomes.events, finishes: [...r.outcomes.events.finishes].sort((a, b) => b.started_at - a.started_at).slice(0, SUMMARY_FINISHES) } }
                  : null,
                live: r.seats.some((x) => liveEvents.has(x.event_id)),
              };
            }),
          }
        : null,
      boards: idx.boards.filter((b) => b.set == null && b.source === 'all').map((b) => ({
        id: b.id, group: b.group, label: glabel.get(b.group) ?? b.group, role: b.role ?? 'side', events: b.events, games: b.games, identities: b.identities, summary: b.summary ?? '',
        swiss_finishes: idx.groups.find((g) => g.key === b.group)?.swiss_finishes ?? [],
      })),
      models: idx.models ?? [],
      activity: idx.activity ?? [],
      highlights: idx.highlights ?? [],
      sets: idx.sets,
      recent_events: idx.events.slice(0, 20),
      methodology: {
        doc: idx.methodology.doc, calibration: idx.methodology.calibration ?? null, thresholds: idx.methodology.thresholds,
        main_condition: idx.methodology.main_condition ?? null, source_labels: idx.methodology.source_labels ?? {},
        mirror_games: idx.methodology.mirror_games ?? null,
      },
      // 2.16: the Methodology box's mirror check without index.json.
      mirror_check: idx.mirror_check ?? null,
    };
  }

  /** Seats that get a draft file: every seat with picks (bots included, for comparison). */
  draftSeats(ev: EventData): string[] {
    return ev.seats.filter((s) => ev.picks.some((p) => p.seat === s.name)).map((s) => s.name);
  }

  draft(ev: EventData, seat: string): DraftFile {
    const ratings = this.ctx.ratingsFor(ev.set.code);
    const ds = this.draftOf(ev, seat);
    const dc = this.contextOf(ev, seat);
    const cards = this.ctx.cards;
    return {
      ...this.head(),
      event_id: ev.id,
      event_status: ev.status,
      set: setRef(ev),
      seat: this.seatRef(ev, seat),
      baseline_win_rate: nul(ratings?.baseline),
      summary: this.draftRow(ev, ds, dc),
      picks: ds.evals.map((e) => {
        const p = e.pick;
        const out: DraftFile['picks'][number] = {
          label: `P${p.packNumber}p${p.pickNumber}`,
          pack_number: p.packNumber,
          pick_number: p.pickNumber,
          overall_pick: p.overallPick ?? (p.packNumber - 1) * 14 + p.pickNumber,
          by: p.by,
          pick: p.pick,
          picked_gih: nul(e.pickedGih),
          best: e.best ? { name: e.best.name, gih_wr: e.best.gih } : null,
          best_in_lane: e.bestInLane ? { name: e.bestInLane.name, gih_wr: e.bestInLane.gih } : null,
          rated: e.rated,
          matches_best: e.matchesBest,
          regret_pp: nul(e.regret),
          lane_regret_pp: nul(e.laneRegret),
          contents: p.contents.map((name, i) => {
            const r = rating(ratings, name);
            const pc: DraftFile['picks'][number]['contents'][number] = { name, colors: cards.colors(name), gih_wr: nul(r?.gih_wr), ata: nul(r?.ata) };
            const rar = p.rarities?.[i];
            if (rar) pc.rarity = rar;
            return pc;
          }),
        };
        if (p.note) out.note = p.note;
        if (p.latencyMs != null) out.latency_ms = p.latencyMs;
        const pc = dc.picks.get(p);
        if (pc?.arch) out.arch = { pair: pc.arch.pair, picked: pc.arch.picked, best: pc.arch.best, regret_pp: pc.arch.regret };
        if (pc?.expert) {
          const e = pc.expert;
          out.expert = { p: nul(e.p), rank: nul(e.rank), ev_regret_pp: nul(e.evRegretPp), in_lane: e.inLane ?? null, top: e.top ?? null };
        }
        return out;
      }),
      cards: this.cardTable(ds.evals.flatMap((e) => e.pick.contents), ratings),
    };
  }

  game(ev: EventData, g: Game): GameFile {
    const ratings = this.ctx.ratingsFor(ev.set.code);
    const sides = gameSides(g);
    const active = activeByTurn(g);
    const decisions = sortedDecisions(g);
    const idx = ev.games.indexOf(g);
    const prev = ev.games[idx - 1];
    const next = ev.games[idx + 1];
    const turns = [...new Set(decisions.map((d) => d.turn))].sort((a, b) => a - b);
    return {
      ...this.head(),
      event_id: ev.id,
      event_status: ev.status,
      set: setRef(ev),
      game: this.gameSummary(ev, g),
      seat_stats: Object.fromEntries(
        sides.map((s) => {
          const st = seatGameStats(g, s);
          const seat = ev.seats.find((x) => x.name === s);
          const row: GameFile['seat_stats'][string] = {
            llm: seat?.llm ?? false,
            model: seat?.model ?? s,
            colors: seatColors(ev, s, this.ctx.cards),
            decisions: st.decisions,
            median_latency_ms: nul(st.medianLatencyMs),
            auto_passes: st.autoPasses,
            forced: st.forced,
            rejected: st.rejected,
            notes: st.notes,
          };
          if (st.manualPayments != null) row.manual_payments = st.manualPayments;
          if (st.autoTapper != null) row.auto_tapper = st.autoTapper;
          if (st.paymentFailures != null) row.payment_failures = st.paymentFailures;
          if (st.autoPaid != null) row.auto_paid = st.autoPaid;
          if (st.mulligans != null) row.mulligans = st.mulligans;
          return [s, row];
        }),
      ),
      life: lifeSeries(g, sides).map((p) => {
        const life: Record<string, number> = {};
        if (p.a != null) life[sides[0]] = p.a;
        if (p.b != null) life[sides[1]] = p.b;
        return { turn: p.turn, life };
      }),
      turns: turns.map((turn) => ({ turn, active: active.get(turn) ?? null })),
      timeline: decisions.map((d, seq) => {
        const { since, board } = splitView(d.text);
        const q = question(d);
        const a = d.answer;
        const out: GameFile['timeline'][number] = {
          seq,
          t: d.t,
          seat: d.seat,
          side: d.seat === sides[0] ? 'a' : 'b',
          id: d.id,
          kind: d.kind,
          kind_label: kindLabel(d.kind),
          turn: d.turn,
          active_player: active.get(d.turn) ?? null,
          prompt: q.prompt,
          options_count: q.options,
          since,
          board,
          status: decisionStatus(d, g),
          answer: a ? { t: a.t, choice: a.choice, accepted: a.accepted } : null,
        };
        if (d.textWithheld) out.withheld = true;
        else {
          // 2.23: the board at this decision, from the same view (withheld text has none: live-redact.ts).
          const state = boardStateOf(d.text, d.seat, d.seat === sides[0] ? sides[1] : sides[0]);
          if (state) out.state = state;
        }
        if (a?.withheld && out.answer) out.answer.withheld = true;
        if (a?.card && out.answer) out.answer.card = a.card;
        if (d.phase) out.phase = d.phase;
        if (d.options) out.options = d.options;
        if (d.life) out.life = d.life;
        if (d.hand) out.hand = d.hand;
        if (a && out.answer) {
          if (a.note) out.answer.note = a.note;
          if (a.latencyMs != null) out.answer.latency_ms = a.latencyMs;
          if (a.structured != null) out.answer.structured = a.structured;
        }
        return out;
      }),
      auto_passes_total: Object.values(g.autoPasses).reduce((a, b) => a + b, 0),
      prev: prev ? { index: prev.index, label: prev.label } : null,
      next: next ? { index: next.index, label: next.label } : null,
      cards: this.cardTable([
        ...g.seats.flatMap((s) => [...(ev.decks.get(s)?.main ?? []), ...(ev.decks.get(s)?.sideboard ?? [])]),
        ...sideboardsOf(ev, g).flatMap((sb) => [...sb.in, ...sb.out].map((c) => c.name)),
      ], ratings),
      ...(ev.withheld ? { withheld: ev.withheld } : {}),
    };
  }

  set(code: string): SetFile {
    const ratings = this.ctx.ratingsFor(code);
    const st = setStats(this.ctx.events, code, ratings);
    const first = st.events[0];
    return {
      ...this.head(),
      set: first ? setRef(first) : { code, name: code },
      ratings: ratings
        ? { source: '17lands', format: ratings.format, games: ratings.games, drafts: ratings.drafts, baseline_win_rate: ratings.baseline, generated_at: ratings.generatedAt }
        : null,
      totals: {
        events: st.events.length,
        llm_events: st.llmEvents.length,
        agent_picks: st.llmPicks,
        agent_decks: st.llmDecks,
        distinct_picked: st.cards.filter((c) => c.picked > 0).length,
        ...finishedSetTotals(st.llmEvents),
      },
      cards: st.cards.map((a) => {
        const r = rating(ratings, a.name);
        const c = this.ctx.cards.get(a.name);
        const row: SetFile['cards'][number] = {
          name: a.name,
          colors: this.ctx.cards.colors(a.name),
          cost: c ? c.cost : null,
          type_line: c ? c.typeLine : null,
          agent_picks: a.picked,
          agent_avg_pick: nul(a.avgPick),
          seen: a.seen,
          ata: nul(r?.ata),
          alsa: nul(r?.alsa),
          delta: nul(a.delta),
          gih_wr: nul(r?.gih_wr),
          iwd: nul(r?.iwd),
          gih_games: nul(r?.gih_games),
          in_decks: a.inDecks,
          deck_games: a.deckGames,
          deck_wins: a.deckWins,
          deck_wr: nul(a.deckWr),
          agent_pods: a.pods.size,
        };
        const rar = this.rarities.get(a.name);
        if (rar) row.rarity = rar;
        return row;
      }),
      earlier: st.earlier.map((x) => x.name),
      later: st.later.map((x) => x.name),
      // 2.18: one agents-vs-humans comparison for every page (real-choice picks, enough picks from enough drafts).
      pick_gaps: st.gaps.map((g) => ({
        name: g.card.name, agent_pick: r2(g.agentPick), picks: g.picks, pods: g.pods, tables: g.tables.length,
        early_test_tables: g.tables.filter((id) => { const ev = st.scope.tables.find((e) => e.id === id); return ev != null && earlyTestData(ev) != null; }).length,
        ata: r2(g.ata), gap: r2(g.gap), direction: g.gap > 0 ? ('earlier' as const) : ('later' as const),
      })),
      pick_gap_rule: { ...PICK_GAP_RULE },
      events: st.events.map((ev) => this.eventSummary(ev)),
      ...setSummary(this.ctx, code, this.identities),
      engine: this.engine(code),
      highlights: this.setHighlights(code),
    };
  }

  /** 2.9: a set's best moments: curated highlights in the set first, then automatic candidates from its finished events. */
  setHighlights(code: string, n = 6): Highlight[] {
    const curated = this.derived().highlights.filter((h) => h.set.code.toUpperCase() === code.toUpperCase());
    const seats = this.ctx.events.filter((e) => e.set.code.toUpperCase() === code.toUpperCase() && finished(e)).flatMap((ev) => ev.seats.filter((s) => s.llm).map((s) => ({ ev, seat: s.name })));
    const auto = curated.length >= n ? [] : autoNotes(seats, this.identities, n - curated.length, this.ctx.ratingsFor);
    return [...curated.slice(0, n), ...auto.filter((h) => !curated.some((c) => c.id === h.id))];
  }

  /** Engine issues in a set: every event in it (smoke tests find engine bugs too), impact for LLM games and for all. */
  engine(code: string): NonNullable<SetFile['engine']> {
    const evs = this.ctx.events.filter((e) => e.set.code.toUpperCase() === code.toUpperCase() && !e.source.exclude);
    const games = evs.flatMap((ev) => ev.games.map((g) => gameFlags(ev, g)));
    return {
      games: games.length,
      flagged_games: games.filter((f) => f.flagged).length,
      cards: engineCards(evs),
      impact: { llm: impact(evs, 'llm', this.ctx.replicates), all: impact(evs, 'all', this.ctx.replicates) },
      // 2.17: card swaps (not a fault) apart from rules errors, for agent games and for all.
      split: { llm: engineSplit(evs, 'llm'), all: engineSplit(evs, 'all') },
    };
  }
}

function setRef(ev: EventData) {
  const out: { code: string; name: string; release_date?: string } = { code: ev.set.code.toUpperCase(), name: ev.set.name };
  if (ev.set.releaseDate) out.release_date = ev.set.releaseDate;
  return out;
}

/**
 * Set totals over finished events. finished_llm_events: every finished agent table (mixed pods too: they're watchable).
 * 2.18: finished_agent_picks and finished_agent_decks count the tables that feed set findings (all 8 seats agents), the
 * same tables as archetypes, deck shape and the card table.
 */
function finishedSetTotals(llmEvents: EventData[]): { finished_llm_events: number; finished_agent_picks: number; finished_agent_decks: number } {
  const evs = llmEvents.filter(finished);
  let picks = 0;
  let decks = 0;
  for (const ev of evs.filter(feedsSetFindings)) {
    const llm = new Set(ev.seats.filter((s) => s.llm).map((s) => s.name));
    picks += ev.picks.filter((p) => llm.has(p.seat) && p.by === 'agent' && !BASICS.has(p.pick)).length;
    decks += [...llm].filter((s) => ev.decks.has(s)).length;
  }
  return { finished_llm_events: evs.length, finished_agent_picks: picks, finished_agent_decks: decks };
}

/** Matches an event plays: Swiss rounds × pairs per round, or every pair once (round robin, and logs before Swiss). */
function matchesExpected(ev: EventData, agents: number): number {
  if (ev.format?.format === 'swiss') return ev.format.rounds * Math.floor(agents / 2);
  return (agents * (agents - 1)) / 2;
}
