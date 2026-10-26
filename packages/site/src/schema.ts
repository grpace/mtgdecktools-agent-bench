/**
 * Site data schema (JSON export, `npm run site:data`). Documented in docs/SITE-DATA.md.
 *
 * Conventions:
 * - Timestamps are Unix epoch milliseconds (numbers), except `generated_at` (ISO 8601 string).
 * - Rates and 17Lands win rates are fractions in 0..1. Regret is in percentage points ("_pp").
 * - Colors are WUBRG-ordered strings ("WU"); "" means colorless or unknown.
 * - A value that can't be computed is `null`; optional keys are omitted when the logs don't carry them.
 * - Additive changes (new keys) keep `schema_version`; renames/removals/meaning changes bump it.
 *
 * v2 (2026-10-21): ratings and diagnostics per comparability group (index.boards), seat identities,
 * comparability groups, per-event source label and conditions, context-aware draft fields. Every v1 key is
 * still present with the same meaning. See docs/SITE-DATA.md "Changelog".
 */

export const SCHEMA_VERSION = 2 as const;
/**
 * Additive revisions within a schema version (docs/SITE-DATA.md "Changelog"): 0 = v2 release, 1 = engine-issue
 * flags and live redaction, 2 = archetype build quality, deck norms, calibrated thresholds, 3 = core draft
 * metrics for every set (no human data needed), deck roles, the human-reference layer labeled as such,
 * 4 = canonical model identity from the registry (model/harness display names, provider, model verification),
 * 5 = event format (Swiss or round robin, rounds) and table kind (lobby, private); dev events with bot drafters,
 * 6 = concrete effort levels with their source and verification,
 * 7 = 17Lands snapshot ids: the data an event ran with (config.ratings_snapshot) and the data the export used (config.inputs.ratings_snapshot),
 * 8 = outcomes (match, play/draw, finishes), head to head, diagnostics with field medians and rank-of-N, cost with token
 *     estimates, generated summaries, model files (models/<model_id>.json), highlights, activity, set archetypes and deck shape,
 * 9 = contributors on seats and rows (contributor floor, leave-one-contributor-out influence), rank ranges from difference
 *     intervals within connected groups, groups keyed by prompt fingerprint, the explicit main board and side boards,
 *     Hosted / Community provenance, "Checked Against Logs" labels and who read the logs, the forfeit policy, expected
 *     score against an average opponent, the experimental pooled fit,
 * 10 = summary.json carries what Home needs without index.json (main-board outcomes, head to head, cost per game,
 *     influence, the contributor floor, provisional reasons, games needed, live rows); US spelling for every key
 *     ("colors", "open_colors", …), with the British keys still emitted next to them (deprecated, one release),
 * 11 = an event's rating status ("Rated" / "No Rated Games" / "Not Rated", with the rated game count and the reason), and
 *     Swiss finishes by setup for an event, a group and summary.json's board lines, whether or not any game was rated,
 * 12 = each LLM seat's context policy (`context_policy`: one harness conversation, or a fresh session per game or match),
 * 13 = best of 3 with sideboarding: Early Test Data labels (`test_data`, best of 1 or best of 3 without sideboarding,
 *     never rated), groups no longer split on best-of (keys and labels drop it), each game's play/draw decision and each
 *     seat's sideboarding before games 2–3, deck sizes per game,
 * 14 = the `known_issue_card` engine flag: a card on the known-issues list (engine/known-issues.json) was played and the
 *     event's card data had no override fixing it (docs/CARD-OVERRIDES.md),
 * 15 = the Effort Ladder and Harness Comparison on model files (a model's versions by effort level and by harness, with
 *     the steps between them, their cost per game and their head to head), `Board.version_differences` (difference
 *     intervals between two versions of one model) and the mirror check (`IndexFile.mirror_check`: games between two
 *     seats of the same setup, never rated, as a fairness monitor),
 * 16 = summary.json carries the mirror check (`SummaryFile.mirror_check`) and `methodology.mirror_games`, so the site's
 *     Methodology box never needs index.json,
 * 17 = the critic-review fixes (docs/SITE-DATA.md "2.17"): LLM seats classified from metadata (scripted tables are Test
 *     Runs everywhere); stopped events (status "stopped", `stop`, their finished games rated); table kinds and their
 *     sentence (`table_kind`, `table_text`; no winner "of N agents" at a mirror table); the play advantage and the mirror
 *     on-play rate from game 1 only; Effort Ladder step verdicts (Holm, provisional gating); `pick.human` on pick
 *     highlights; engine issues split into card swaps and rules errors; cost coverage on model pages; per-set deck norms;
 *     rated flags and difference intervals for the open data; the provisional rule in one sentence,
 * 18 = set findings only from all-agent tables (docs/SITE-DATA.md "2.18"): archetypes, deck shape, first picks, card pick
 *     counts and averages come only from finished tables whose 8 seats are all language-model agents
 *     (`in_set_findings`); the insight gate counts independent drafts (`pods`) and says how many tables are Early Test
 *     Data; one agents-vs-humans comparison (`pick_gaps`, real-choice picks only); `agent_pods` per card; `test_set`;
 *     model pages' card preferences by pick within the pack, from early picks.
 * 19 = launchers (docs/SITE-DATA.md "2.19"): a seat started from an app that launches harnesses (T3 Code) is its
 *     harness's identity ("claude-code", no longer "t3-code:claude-code"), with `launcher` / `launcher_display` on the
 *     seat.
 * 20 = identities are model and effort (docs/SITE-DATA.md "2.20"; owner decision 13): the harness is a seat detail, never
 *     part of a leaderboard identity ("claude-sonnet-5-5/high", "Claude Sonnet 5.5 · High"); `IdentityInfo.harnesses`;
 *     one Effort Ladder per model; `ModelFile.harness_split` (descriptive) replaces the Harness Comparison.
 * 21 = cost cross-checks (docs/SITE-DATA.md "2.21"): a reported cost of $0 with tokens, or more than 35% from the token
 *     estimate, isn't used; uploads are re-priced from their tokens; `CostInfo.seats_flagged`.
 * 22 = test tables (docs/SITE-DATA.md "2.22"): a table with any scripted or bot seat is `table_kind: "test"`, in no group,
 *     with no rated game or Swiss finish, and its sentence never says it was won.
 * 23 = visual replays (docs/SITE-DATA.md "2.23"): `TimelineEntry.state`, the board at each decision.
 * 24 = seats answer with their choice only (docs/SITE-DATA.md "2.24"): no `note` on picks, decks, decisions, play/draw or
 *     sideboarding, no `notes` count in seat stats or `note` on set first picks; highlights are moments without a quote.
 */
export const SCHEMA_MINOR = 24 as const;

// ---------------------------------------------------------------------------
// v2: provenance, conditions, identities, groups, ratings, diagnostics (docs/METHODOLOGY.md)

export type SourceLabel = 'verified' | 'community' | 'smoke';

export interface SourceRef {
  label: SourceLabel;
  submitter?: string;
  submitted_at?: string;
  /** Excluded from ratings and diagnostics by us, with the reason. */
  excluded?: string;
  note?: string;
  /** true when runs/<id>/source.json is absent and the label was inferred (LLM event → verified, else smoke). */
  inferred: boolean;
}

/** The event-wide conditions that decide what may be pooled (METHODOLOGY §3). */
export interface Conditions {
  set: string;
  knowledge: string | null; // 'none' | 'primer' | 'primer+stats'
  mana: string | null; // 'manual' | 'auto'
  best_of: number;
  /** 2.13: best of 3 with sideboarding between games (event_start.sideboarding). False: Early Test Data. */
  sideboarding?: boolean;
  prompt_version: string | null;
  /** 2.9: content hash of the prompt files (event_start.prompt_sha256); null for older logs. */
  prompt_sha256?: string | null;
  /** 2.9: what groups key on: "sha256:<first 12 hex>" of the prompt files, else (older logs) the prompts folder name. Never shown. */
  prompt_key?: string | null;
  engine: { server_version?: string; build_commit?: string; protocol_version?: number; digest?: string } | null;
  director: string | null; // Director commit
  primer_sha256: string | null;
}

/** A point estimate with a 95% interval (cluster bootstrap over events) and its sample size. */
export interface Est { value: number; ci: [number, number] | null; n: number; events: number }

export interface IdentityInfo {
  key: string; // 2.20: "claude-sonnet-5-5/high": canonical model / canonical effort (before: "claude-code/claude-sonnet-5-5/high")
  /** Deprecated (2.20): identities no longer have one harness; see `harnesses`. Absent from 2.20 on. */
  harness?: string;
  model: string; // = model_id
  model_aliases: string[]; // names the runners declared ("sonnet", "Claude Sonnet 5.5")
  model_verified: boolean; // every seat's harness usage showed the declared model (model_verification "verified")
  effort: string; // canonical effort: none | minimal | low | medium | high | xhigh | max | default
  label: string; // 2.20: "Claude Sonnet 5.5 · High" (2.4–2.19: "Claude Sonnet 5.5 · Claude Code · High")
  /** 2.4: canonical ids and registry display names (registry/README.md). Unlisted names show as declared. */
  model_id?: string; // "claude-sonnet-5-5"; "unlisted:<slug>" when the registry doesn't know the model
  model_display?: string; // "Claude Sonnet 5.5"
  provider?: string | null; // "anthropic"; null when unlisted
  provider_display?: string | null; // "Anthropic"
  /** Deprecated (2.20): see `harnesses`. Absent from 2.20 on. */
  harness_id?: string;
  harness_display?: string;
  effort_display?: string; // "High", "Extra High", "Default Effort"
  /** 2.20: the harnesses this identity's seats ran on, most seats first. Seat details: never a column, filter or row. */
  harnesses?: Array<{ id: string; display: string; seats: number }>;
  /** 2.4: how far the harness usage confirms the model (METHODOLOGY §2.1), over the identity's seats. */
  model_verification?: ModelVerification | 'mixed';
  /** 2.9: display label of model_verification: "Checked Against Logs" | "Self-Reported" | "Mismatch" | "Unlisted" | "Mixed". */
  model_verification_label?: string;
  verification_counts?: Partial<Record<ModelVerification, number>>;
  /** 2.4: false for Unlisted identities (model or harness not in the registry): listed, never rated. */
  rated?: boolean;
  /** 2.6: how the identity's seats got their effort level (counts per source) and how many the logs confirmed. */
  effort_sources?: Partial<Record<EffortSource, number>>;
  effort_verification_counts?: Partial<Record<'verified' | 'self-reported' | 'mismatch', number>>;
  /** 2.4: dated snapshots the seats' usage showed behind this model id; `unknown_snapshot` when one isn't in the registry. */
  snapshots?: string[];
  unknown_snapshot?: boolean;
}

/**
 * 2.4: the model check. Codes are historical; show the 2.9 labels: `verified` = "Checked Against Logs", `self-reported` =
 * "Self-Reported", `mismatch` = "Mismatch" (excluded from rating), `unlisted` = "Unlisted" (unrated until the registry lists it).
 */
export type ModelVerification = 'verified' | 'self-reported' | 'mismatch' | 'unlisted';

/**
 * 2.9: who read the harness logs behind a model check. `contributor-cli`: usage-<seat>.json written on the contributor's
 * machine (the bench CLI or the bundle tool); `export`: the export read a harness transcript the contributor submitted.
 * Both are contributor-supplied; there is no server-side check yet.
 */
export type LogsReadBy = 'contributor-cli' | 'export';

/** 2.6: where a seat's effort level came from (METHODOLOGY §2.1). */
export type EffortSource = 'declared-explicit' | 'detected' | 'harness-default' | 'self-reported' | 'unknown';

/** 2.6: one seat's effort resolution. */
export interface SeatEffortResolution {
  source: EffortSource;
  source_display: string; // "Set at Launch" | "Detected from Logs" | "Harness Default" | "Self-Reported" | "Unknown"
  status: 'verified' | 'self-reported' | 'mismatch'; // verified: the harness logs show the level
  reason: string;
  declared?: string; // the concrete level declared, if any
  detected?: string | null; // the level the harness logs showed
  harness_version?: string;
  default_source?: string; // documentation behind a harness default
  fast?: boolean; // the logs showed fast serving mode (Cursor "-fast" names): recorded, not part of the identity key
}

/** 2.4: one seat's model check (METHODOLOGY §2.1). */
export interface SeatModelVerification {
  status: ModelVerification;
  reason: string;
  reported?: string; // canonical id of the model that did the work, from harness usage
  reported_raw?: string; // as the harness reported it
  snapshot?: string; // a dated snapshot behind the canonical id
  snapshot_known?: boolean;
  /** 2.9: display label ("Checked Against Logs", "Self-Reported", "Mismatch", "Unlisted"). */
  label?: string;
  /** 2.9: who read the harness logs (null: none were read). */
  logs_read_by?: LogsReadBy | null;
}

/** 2.9: the contributor who seated a seat (METHODOLOGY §3.1). */
export interface SeatContributorRef {
  /** Opaque key, stable across events and exports (a salted hash; never a Hub id), or "admin" / "unattributed". */
  key: string;
  /**
   * A handle only for a contributor who is public now: the Hub's export checks its current setting (a log keeps the
   * handle a lobby seat showed then, even if its contributor hid later). Every other export: always null.
   */
  handle: string | null;
  /** uploader (community bundle) | lobby-seat | organizer (hosted Private Table) | admin | unattributed (older logs). */
  via: 'uploader' | 'lobby-seat' | 'organizer' | 'admin' | 'unattributed';
}

export interface GroupInfo {
  /** "kn=primer;mana=manual;prompt=sha256:3f2a9c01b7de" (older logs: "prompt=v2"). 2.13: no `bo=` part (exports before 2.13: "kn=…;mana=…;bo=3;prompt=…"). */
  key: string;
  label: string; // "Set Context · Manual Mana" (2.13: no "· Best of N")
  /**
   * prompt_sha256 / prompt_key: 2.9. Groups key on prompt_key. best_of: deprecated in 2.13, always 3 (only best of 3
   * with sideboarding is rated); kept for compatibility.
   */
  conditions: { knowledge: string; mana: string; best_of: number; prompt_version: string; prompt_sha256?: string | null; prompt_key?: string };
  events: number; // LLM events, not excluded
  sets: string[];
  sources: Partial<Record<SourceLabel, number>>;
  /** 2.9: events per provenance (hosted / community); `sources` keeps the historical codes. */
  provenance?: Partial<Record<'hosted' | 'community' | 'test', number>>;
  engines: string[]; // engine builds seen ("0.115.0 / protocol 159"); recorded, not split on (METHODOLOGY §3)
  identities: number;
  /** 2.9: distinct contributors who seated its seats. */
  contributors?: number;
  /** 2.9: "main" for the main condition with the current prompts (the default leaderboard), "side" for every other group. */
  role?: 'main' | 'side';
  /** 2.11: Swiss finishes by setup over the group's finished 8-agent Swiss tables, rated games or not. */
  swiss_finishes?: SwissFinishes[];
}

/**
 * 2.11: how often one setup (identity) finished each Swiss record at 8-agent, 3-round Swiss tables. A fact about the
 * tables, not a rating: exported even when no game was rated (a table of one setup has no rated games).
 */
export interface SwissFinishes {
  identity: string;
  events: number;
  seats: number;
  rounds: number;
  counts: Record<string, number>; // "3-0", "2-1", "1-2", "0-3"
  trophies: number; // seats that went undefeated
}

/**
 * 2.11: whether an event's games count toward a rating. "rated": at least one rated game; "no_rated_games": the event
 * is pooled, but no game was between two different rated setups (`reason`: "all games were between identical setups"
 * when every seat was the same setup); "not_rated": the event isn't pooled (`reason` = config.unrated_reason).
 */
export type RatingStatus = 'rated' | 'no_rated_games' | 'not_rated';
export const RATING_STATUS_LABELS: Record<RatingStatus, string> = { rated: 'Rated', no_rated_games: 'No Rated Games', not_rated: 'Not Rated' };

export interface DraftStage {
  seats: number;
  picks: number; // non-forced picks
  /** Naive baselines: raw 17Lands GIH WR, blind to pool, colors and pick context. */
  baseline: { rated_picks: number; top_pick_rate: Est | null; regret_pp: Est | null; lane_regret_pp: Est | null };
  /** Archetype-conditional value: GIH WR within the drafter's color pair (needs sets/<SET>/17lands-archetypes.json). */
  archetype: { picks: number; regret_pp: Est | null; current_regret_pp: Est | null } | null;
  /** Expert pick model (needs runs/<id>/draft-eval.json). */
  expert: {
    picks: number;
    mean_log_p: Est | null;
    top1: Est | null;
    top3: Est | null;
    ev_regret_pp: Est | null;
    by_pack: Array<{ pack: number; picks: number; top1: number | null; mean_log_p: number | null; ev_regret_pp: number | null }>;
  } | null;
  /** Hindsight: what the picks became. `signal_alignment` is human reference (17Lands GIH WR); 2.3 readers use `core`. */
  hindsight: { conversion: Est | null; p1_conversion: Est | null; commitment_pick: Est | null; signal_alignment: Est | null };
  /** 2.3: core draft metrics, from card data and the logs only (every set). `baseline`, `archetype`, `expert` and
   * `hindsight.signal_alignment` are the optional human-reference layer ("Compared with human drafters"). */
  core?: CoreDraftStage;
}

/** 2.3: draft metrics that need no human data (METHODOLOGY §5.1 "Core draft metrics"). */
export interface CoreDraftStage {
  conversion: Est | null; // share of real non-basic picks that made the final main deck
  p1_conversion: Est | null; // the same, pack 1 only
  commitment_pick: Est | null; // overall pick from which the top-two colors so far equal the final pair for good
  flow_alignment: Est | null; // share of the final colors among the two colors that flowed most in pack 1, picks 2–9
  on_color_rate: Est | null; // share of real non-land picks in packs 2–3 castable with the final colors
  pair_changes: Est | null; // changes of the top-two color pair from the 6th pick on (descriptive)
  role_coverage: Est | null; // share of generic deck-role checks passed by the final deck
  decks: number; // decks with role checks
  role_fails: Record<string, number>; // decks failing each role check
}

export interface BuildStage {
  decks: number;
  agent_built: number;
  auto_builds: number; // delegated to the reference builder
  legal_rate: number | null; // 40+ cards, agent-built decks
  sanity_rate: Est | null; // share of sanity checks passed (agent-built decks)
  failed_checks: Record<string, number>;
  avg_lands: number | null;
  gih_gap_pp: Est | null; // baseline: best same-color pool cards by GIH WR minus the deck's
  strength: Est | null; // deck_strength: bot-piloted win rate of the seat's deck
  build_delta: Est | null; // deck_strength(agent build) − deck_strength(reference build, same pool)
  /** 2.2: archetype build quality of agent-built decks (METHODOLOGY §5.2); null without archetype ratings. */
  archetype?: BuildArchetypeStage | null;
}

export interface BuildArchetypeStage {
  decks: number;
  quality: Est | null; // mean archetype value of the non-land cards in the deck's own pair (fraction, GIH WR scale)
  expected_wr: Est | null; // calibrated expected game win rate vs the 17Lands population (fraction)
  build_delta_pp: Est | null; // quality − reference build's quality (same pool), percentage points
  build_delta_wr_pp: Est | null; // the same in expected win rate, percentage points
  vs_best_pp: Est | null; // quality − best deck the pool could make under the same scoring, percentage points
  structural_pass_rate: Est | null; // share of structural checks inside the winners' p10–p90 band
  structural_flags: Record<string, number>; // decks failing each check
  /** Held-out validation label of the sets involved: validated | weak | mixed | unvalidated. */
  validation: string;
}

/** 2.2: one deck's archetype build quality (DeckDetail.build_quality). Qualities are fractions; *_pp in points. */
export interface DeckBuildQuality {
  pair: string;
  quality: number | null;
  expected_wr: number | null;
  reference: { pair: string; quality: number | null; expected_wr: number | null };
  best: { pair: string; quality: number; expected_wr: number | null } | null;
  build_delta_pp: number | null;
  build_delta_wr_pp: number | null;
  vs_best_pp: number | null;
  vs_best_wr_pp: number | null;
  shape: { lands: number; nonland: number; creatures: number; two_minus: number; five_plus: number; avg_mv: number; src_primary: number | null; src_secondary: number | null; src_splash: number | null };
  /** Checks run (those with a norm for the pair) and the ones outside the winners' band. */
  checked: string[];
  flags: Array<{ check: string; value: number; band: [number, number] }>;
  unrated: string[];
  uncastable: string[];
  splash: string[];
  validation: string;
}

export interface PlayStage {
  games: number; wins: number; losses: number; // LLM-vs-LLM games in this scope
  win_rate: Est | null;
  match_w: number; match_l: number;
  mulligans_per_game: number | null;
}

/**
 * Mana payment (METHODOLOGY §5.4). `manual`: payments the agent planned itself and that paid in full; `auto_tapper`:
 * payments it delegated to the auto-tapper option; `manual_share` = manual / (manual + auto_tapper). 2.9: `auto_paid`
 * counts payments the engine made by itself (abilities and prepared copies with no plan, and top-ups of a plan that fell
 * short), `topped_up` the planned payments the engine had to complete; neither is ever credited as the agent's tapping.
 * `failures_per_100`: refused plans per 100 accepted planned payments (topped-up ones included).
 */
export interface ManaStage { games_with_data: number; manual: number; auto_tapper: number; auto_paid?: number; topped_up?: number; manual_share: Est | null; failures_per_100: number | null }

export interface ReliabilityStage {
  decisions: number;
  rejected_per_100: Est | null;
  withdrawn_per_100: number | null; // decisions replaced before an answer (not necessarily the agent's fault)
  abandoned_games: number; // games of this seat that never finished in an event that is no longer running
  forfeits: number | null; // decisions settled for an inactive seat (draft picks, deck, conceded games); null: not logged (older Directors)
}

export interface EfficiencyStage {
  median_latency_ms: number | null;
  median_pick_latency_ms: number | null;
  cost_usd: number | null;
  cost_seats: number;
  cost_per_game_usd: number | null;
  output_tokens_per_decision: number | null;
}

/**
 * Diagnostics: how an identity drafts, builds and plays, per stage (METHODOLOGY §5). Descriptive only: none of them
 * feeds the rating, which comes from game results alone. Exported under the historical key `BoardRow.stages`.
 */
export interface Diagnostics { draft: DraftStage; build: BuildStage; play: PlayStage; mana: ManaStage; reliability: ReliabilityStage; efficiency: EfficiencyStage }
/** @deprecated Old name of {@link Diagnostics} (there are no "stage scores": the rating is outcomes only). */
export type StageScores = Diagnostics;

export interface BoardRow {
  identity: string;
  rating: number | null; // Elo scale, 1500 = field average; null without LLM-vs-LLM games
  ci: [number, number] | null; // reported 95% interval
  ci_bootstrap: [number, number] | null;
  se: number | null;
  rank: number | null;
  rank_ci: [number, number] | null;
  provisional: boolean;
  provisional_reasons: string[];
  component: number | null;
  games: number; wins: number; losses: number; events: number; opponents: number;
  /** Deck-adjusted ("pilot") rating, only when every game in the scope has deck_strength for both decks. */
  pilot: { rating: number; ci: [number, number] | null } | null;
  seats: Array<{ event_id: string; seat: string }>;
  /** Diagnostics (descriptive, never part of the rating). The key name is historical. */
  stages: Diagnostics;
  /**
   * Rank range on the default ranking, within its connected group: best = 1 + rows credibly ahead of it, worst = N −
   * rows credibly behind it, where "credibly ahead" means the 95% interval of the rating difference excludes 0
   * (2.9; in 2.8 it came from overlapping individual ranges, now `rank_range_overlap`). N = `rank_of`. Null without a
   * rating, without a bootstrap, and for rows off the default ranking (Unknown Effort: see `rank_range_all`).
   */
  rank_range?: [number, number] | null;
  /** 2.9: N for rank_range: default-ranking rows in its connected group. */
  rank_of?: number | null;
  /** 2.9: the same rank range among every rated row of its connected group, Unknown Effort included. */
  rank_range_all?: [number, number] | null;
  /** 2.9: the 2.8 rank range from overlapping individual intervals (kept for compatibility; not used for claims). */
  rank_range_overlap?: [number, number] | null;
  /** 2.9: on the default ranking (a recorded effort). false: Unknown Effort, kept in the fit and shown on request. */
  default_ranking?: boolean;
  /** 2.9: distinct contributors whose seats of this identity supplied its games. */
  contributors?: number;
  /** 2.9: share of its rated games from its top contributor (0–1). */
  top_contributor_share?: number | null;
  /** 2.9: at least 2 contributors and none above half of its games (otherwise provisional). */
  contributor_floor_met?: boolean;
  /**
   * 2.9: leave-one-contributor-out: the contributor (key) whose removal moves this row most, by how much (Elo; null
   * when it would leave no games), and whether that leaves its 95% range. Null with fewer than two contributors.
   */
  influence?: { contributor: string; shift: number | null; flagged: boolean } | null;
  /** 2.9: expected score (win probability) against an average opponent (1500) under the fit, with its range. */
  expected_score?: { value: number; ci: [number, number] | null } | null;
  /** 2.9, experimental (MTGDT_RATING_POOLING=1 only): the partially pooled rating next to the headline. */
  pooled?: { rating: number; ci: [number, number] | null } | null;
  /** 2.8: provisional rows: games still needed for the games threshold (0 when met). */
  games_needed?: number;
  /** 2.8: results in this board's rated games (outcomes only; the same games as the rating). */
  outcomes?: Outcomes;
  /** 2.8: headline diagnostics with the field median and rank-of-N (definitions: index.methodology.diagnostics). */
  diagnostics?: Record<string, DiagnosticValue>;
  /** 2.8: cost per game, harness-reported where available, else estimated from token counts and list prices. */
  cost?: CostInfo;
}

export interface Board {
  id: string; // "<group>|<set or *>|<source>"
  group: string;
  set: string | null; // null = all sets in the group
  source: 'all' | 'verified' | 'community';
  events: number;
  games: number;
  identities: number;
  components: number;
  /**
   * The fitted play advantage in Elo. 2.17: estimated from game 1 of each match only (the event seed decides who is on the
   * play); `games` counts those games. Games 2–3 (the previous loser chose) enter the fit without a play term.
   */
  play_advantage: { elo: number; ci: [number, number] | null; games: number } | null;
  deck_adjusted: boolean;
  replicates: number;
  rows: BoardRow[]; // rated rows first by rating, then unrated
  /** 2.8: generated plain-English summary ("As of Oct 22, 2026, …"); deterministic, honest about overlap. */
  summary?: string;
  /** 2.8: head to head within this board's rated games, one entry per pair of identities that met (a < b). */
  pairwise?: PairRecord[];
  /**
   * 2.15: the rating difference between two versions of one model (same model id, another effort level) that are
   * rated in the same connected group: a − b in Elo, its 95% interval (the wider of bootstrap and Laplace; null without a
   * bootstrap) and which side is credibly ahead (the interval excludes 0). The Effort Ladder and Harness Comparison use it.
   */
  version_differences?: VersionDifference[];
  /**
   * 2.17: every pair of rows in a connected group: a − b in Elo, its 95% interval and which side is credibly ahead.
   * Rank ranges are built from these (not from overlapping bars): two ratings whose bars overlap can still be ranked when
   * their difference's interval excludes 0, because they share opponents. Shipped in the open data (rating_pairs).
   */
  differences?: VersionDifference[];
  /** 2.17: the bootstrap seed of this board (DEFAULT_RATING_OPTIONS.seed + FNV-1a of the board id). */
  seed?: number;
  /** 2.8: field median of each headline diagnostic over this board's rows. Context only, never a score. */
  field?: Record<string, { median: number | null; n: number }>;
  /** 2.9: "main" for the main board's group (any set or source), "side" otherwise. */
  role?: 'main' | 'side';
  /** 2.9: the table provenance this board covers ("verified" in `source` is a hosted table). */
  provenance?: 'all' | 'hosted' | 'community';
  provenance_display?: string; // "All Tables" | "Hosted" | "Community"
  /** 2.9: what the bootstrap resampled: events, or contributors' events (5+ contributor clusters). */
  bootstrap_unit?: 'event' | 'contributor' | 'two-stage';
  clusters?: number;
  /** 2.9: distinct contributors in its rated games. */
  contributors?: number;
  /** 2.9: identities connected through games; ranks never compare across them. One entry when the board is connected. */
  connected_groups?: Array<{ component: number; identities: string[] }>;
  /** 2.9, experimental (MTGDT_RATING_POOLING=1 only): the pooled fit's model-level ratings and harness / effort offsets. */
  pooled?: {
    experimental: true;
    models: Array<{ model: string; display: string; rating: number; se: number }>;
    harnesses: Array<{ harness: string; offset: number; se: number }>;
    efforts: Array<{ model: string; effort: string; offset: number; se: number }>;
  };
}

export interface MethodologyInfo {
  doc: string | null; // "methodology.md" when the export carries docs/METHODOLOGY.md
  doc_sha256: string | null;
  rating: {
    model: 'bradley-terry'; scale: 'elo'; center: number; prior_sd_elo: number; play_prior_sd_elo: number; replicates: number; ci: number;
    /** 2.9: "clusters" (events, or contributors' events at 5+ contributor clusters); 2.8 and before: "events>games". */
    bootstrap: 'clusters' | 'events>games';
    interval: 'max(bootstrap, laplace)';
    /** 2.9: how rank ranges are decided. */
    ranking?: 'difference-intervals';
    /** 2.9: contributor clusters needed before the bootstrap resamples contributors. */
    contributor_cluster_min?: number;
    /** 2.9: per-contributor weight cap (null: off). */
    contributor_cap?: number | null;
    /** 2.9: the experimental pooled fit ran (MTGDT_RATING_POOLING=1). */
    pooling?: boolean;
  };
  /**
   * min_contributors, max_contributor_share: 2.9. 2.17: `rule`, the whole provisional rule in one sentence (the
   * contributor floor included, which usually binds): show it wherever the site states the rule, never a shorter one.
   */
  thresholds: { min_games: number; min_events: number; min_opponents: number; min_contributors?: number; max_contributor_share?: number; rule?: string };
  /** 2.9: how watchdog forfeits enter the rating (METHODOLOGY §5.5) and the alternatives. */
  forfeits?: { policy: 'exclude-game' | 'loss' | 'void-seat-event'; options: Array<'exclude-game' | 'loss' | 'void-seat-event'>; summary: string };
  /** 2.9: the main condition (the default leaderboard). */
  /** 2.13: best_of is always 3 and sideboarding always true (no longer tested); the label has no best-of. */
  main_condition?: { knowledge: string; mana: string; best_of: number; sideboarding?: boolean; prompts: 'current'; label: string };
  /** 2.13: how Early Test Data is labeled and why it isn't rated. */
  early_test_data?: { label: string; summary: string; reasons: string[] };
  /** 2.9: display labels for table provenance codes (EventSummary.source, Board.source). */
  source_labels?: Record<string, string>;
  unrated_events: Array<{ id: string; reason: string }>;
  /** 2.2: where the thresholds come from (calibration study) and what they buy. */
  calibration?: { doc: string; date: string; summary: string };
  /** 2.3: the optional human-reference layer: label, attribution, the sets that have it. */
  human_reference?: HumanReferenceInfo;
  /** 2.3: the card-quality heuristic behind the core metrics (and fallback picks where no human data exists). */
  card_quality?: { version: string; doc: string; summary: string };
  /** 2.4: the model registry that resolved the identities (content hash; registry/README.md). */
  registry?: { version: string; sha256: string; doc: string };
  /** 2.2: held-out 17Lands validation of the build-quality score, per set with deck-norms.json. */
  build_quality?: Record<string, { verdict: string; archetype_weight: number | null; auc_model: number | null; auc_overall_gih: number | null; deck_pearson: number | null; slope_logit_per_pp: number | null }>;
  /** 2.15: games between two seats of the same setup are never rated; the mirror check's sample floor (IndexFile.mirror_check). */
  mirror_games?: { rated: false; check_min_games: number };
  /** 2.8: the headline diagnostics (BoardRow.diagnostics keys): label, definition, unit and how rank-of-N orders them. */
  diagnostics?: DiagnosticDef[];
  /** 2.8: how outcome ranges and estimated costs are computed. */
  outcomes?: { interval: 'max(bootstrap, wilson)'; ci: number; trophy: string };
  cost?: { prices: string; checked: string | null; summary: string };
}

/** 2.3: how the site should present 17Lands-derived numbers: a credited, optional comparison layer. */
export interface HumanReferenceInfo {
  label: string; // "Compared with human drafters"
  source: string; // "17Lands public datasets"
  url: string;
  license: string; // "CC BY 4.0"
  note: string; // short source note for the footer of a section
  sets: string[]; // sets in this export that have human data
}

/** 2.17: "stopped": stopped for good before it finished (its organizer, an admin or the server); its finished games are rated. */
export type EventStatus = 'complete' | 'in-progress' | 'stalled' | 'stopped';
export type EventStage = 'draft' | 'build' | 'games' | 'done';

export interface SetRef { code: string; name: string; release_date?: string }

export interface KnowledgeConfig {
  level: string;
  primer?: boolean | string | Record<string, unknown>;
  guide?: boolean;
  stats?: boolean;
  warning?: string;
  /** 2.3: the level asked for when the set had no set context and the event ran at `none`. */
  requested?: string;
  /** 2.3: display label of `level` ('No Set Context' | 'Set Context' | 'Set Context + Human Stats'). */
  label?: string;
}

/** Resolved card info for hovers, deck lists and color pips. */
export interface CardInfo {
  cost: string | null; // "{2}{W}{U/B}", null when card data is missing
  type_line: string | null;
  colors: string;
  mv: number | null;
  pt?: string;
  loyalty?: string;
  oracle?: string;
  rarity?: string; // from the booster sheet, when the card was seen in a pack
  /** 2.9: card image URL (Scryfall's named-image endpoint, which redirects to cards.scryfall.io); loaded by the reader's browser. */
  image_uri?: string;
  gih_wr: number | null; // 17Lands games-in-hand win rate
  ata: number | null; // 17Lands average taken at (pick number)
}
export type CardTable = Record<string, CardInfo>;

export interface SeatRef {
  name: string;
  kind: string; // 'agent' | 'bot'
  position: number; // 0-based seat at the draft table
  llm: boolean; // agent seat driven by a language model (not a bot or scripted agent)
  model: string; // leaderboard grouping: seat name without the "-N" suffix
  harness?: string; // e.g. "claude-code", from event_start or inferred from a transcript (2.4: canonical)
  model_id?: string; // 2.4: canonical model id ("claude-sonnet-5-5"; "unlisted:<slug>" for unlisted models). Before: the transcript's id
  identity?: string; // v2: seat identity key (LLM seats)
  effort?: string; // v2: declared reasoning effort (2.4: canonical)
  // 2.4 (LLM seats): registry display names and the model check
  model_display?: string;
  provider?: string | null;
  harness_id?: string;
  harness_display?: string;
  effort_display?: string;
  model_declared?: string; // as typed when it differs from model_id
  model_verification?: SeatModelVerification;
  /** false: not rated (Mismatch or Unlisted, see model_verification.reason). */
  rated?: boolean;
  /** 2.6: how `effort` was decided: set at launch, detected from logs, harness default, self-reported, or Unknown. */
  effort_source?: EffortSource;
  effort_resolution?: SeatEffortResolution;
  /** 2.9: the contributor who seated it (LLM seats). */
  contributor?: SeatContributorRef;
  /**
   * 2.12 (LLM seats): how the seat's harness conversation was managed. "harness": one conversation for the whole event
   * (the harness's own context handling; every seat before 2.12); "fresh-per-game" / "fresh-per-match": the launcher
   * started a fresh session when the deck was locked and after every game or match (`bench play --fresh-session`).
   * A declared condition like effort; boards don't split on it yet (METHODOLOGY open questions).
   */
  context_policy?: 'harness' | 'fresh-per-game' | 'fresh-per-match';
  /**
   * 2.19 (LLM seats): the app that started the harness, when the seat declared one ("t3-code", "T3 Code"). Seat
   * details only: the seat's identity is its harness (METHODOLOGY §2.3), so a launcher never splits a row.
   */
  launcher?: string;
  launcher_display?: string;
}

export interface EventSummary {
  id: string;
  set: SetRef;
  started_at: number;
  last_activity_at: number;
  status: EventStatus;
  stage: EventStage;
  llm: boolean; // false for smoke tests (scripted agents and bots only)
  best_of: number;
  seed?: string;
  knowledge_level?: string; // 'none' | 'primer' | 'primer+stats'; absent in logs before knowledge levels existed
  mana?: string; // 'manual' | 'auto'
  agents: Array<{ name: string; model: string; llm: boolean; colors: string }>;
  bot_seats: number;
  winner: string | null;
  games_played: number;
  games_live: number;
  matches_done: number;
  matches_expected: number;
  /** v2.5: how matches were paired. Logs from before Swiss existed were round robins. */
  format: { pairing: 'swiss' | 'round-robin'; rounds: number };
  /** v2.5: lobby table, Private Table (one contributor's 8 seats), or null (maintainer or self-hosted event). */
  table: 'lobby' | 'private' | null;
  /** v2.5: a dev engine test with bot drafters (labeled smoke, never rated). Omitted otherwise. */
  dev_bot_fill?: true;
  source: SourceLabel; // v2
  /** 2.9: table provenance: "hosted" (source "verified"), "community", or "test" (source "smoke"). Show provenance_display. */
  provenance?: 'hosted' | 'community' | 'test';
  provenance_display?: string; // "Hosted" | "Community" | "Test Run"
  /** 2.9: an early test table: fewer than 8 agents, or scripted / bot drafters at the table. */
  test_table?: boolean;
  /** 2.9: agent seats driven by language models, and seats drafted by scripts or bots. */
  llm_agents?: number;
  scripted_seats?: number;
  /**
   * 2.18: the table feeds its set's findings (finished, all 8 seats language-model agents). False for a mixed pod
   * (agents with scripted drafters or players): watchable, never counted in a set finding. Count decks and pairs from
   * these tables only.
   */
  in_set_findings?: boolean;
  group: string | null; // v2: comparability group key; null = unrated (conditions incomplete, smoke, or excluded)
  conditions: Conditions; // v2
  /** 2.11: Rated / No Rated Games / Not Rated (show rating_display; rating_reason says why it isn't rated). */
  rating_status?: RatingStatus;
  rating_display?: string;
  rated_games?: number;
  rating_reason?: string;
  /**
   * 2.13: Early Test Data: an LLM event played before best of 3 with sideboarding (best of 1, or best of 3 without
   * sideboarding). Visible, never rated (rating_status "not_rated", rating_reason "early test data (…)"). Show
   * test_data_label ("Early Test Data"). False for smoke and dev events, which keep their own labels.
   */
  test_data?: boolean;
  test_data_label?: string | null;
  /** 2.13: best of 3 with sideboarding between games (event_start.sideboarding). */
  sideboarding?: boolean;
  /** 2.13: who chooses play or draw in games 2–3 ("loser-chooses"); null for logs that don't say. */
  play_draw?: string | null;
  /**
   * 2.17: a stopped event (status "stopped"): who stopped it ("organizer" | "admin" | "system" | "unknown"), why, the
   * games still being played (void, not results) and those counted as a loss for the stopping organizer's own seat.
   * Its finished games are rated like any other (METHODOLOGY §3.2 "Stopped events").
   */
  stop?: { by: 'organizer' | 'admin' | 'system' | 'unknown'; by_display: string; reason: string; open_games: number; forfeited_games: number; text: string };
  /**
   * 2.17: "scripted": every agent seat is a scripted test player (a Test Run, no LLM seat); "mirror": every LLM seat
   * is the same setup (model, harness and effort: no rated games); "single_model": one model at several harnesses or
   * efforts; "mixed": two models or more. Never present the winner of a scripted, mirror or single-model table as having
   * "won a table of N agents" (show table_text).
   */
  table_kind?: 'scripted' | 'test' | 'mirror' | 'single_model' | 'mixed'; // 'test': 2.22
  /** 2.17: one plain sentence for event cards and What's New: what kind of table it was and why it has no rated games. */
  table_text?: string;
}

export interface LeaderboardRow {
  model: string;
  model_ids: string[];
  harnesses: string[];
  events: number;
  in_progress: number;
  match_w: number; match_l: number; game_w: number; game_l: number;
  game_win_rate: number | null;
  top_pick_rate: number | null; // share of rated picks that took the pack's top 17Lands GIH WR card
  rated_picks: number;
  avg_regret_pp: number | null;
  decisions: number;
  median_latency_ms: number | null;
  median_pick_latency_ms: number | null;
  rejected_per_100: number | null;
  cost_usd: number | null; // API-equivalent cost reported by the harness, summed over seats that finished
  cost_seats: number;
  cost_per_game_usd: number | null;
  output_tokens: number;
  seats: Array<{ event_id: string; seat: string }>;
}

export interface IndexFile {
  schema_version: typeof SCHEMA_VERSION;
  /** Additive revision (2.2: build quality). Readers must not require it. */
  schema_minor?: number;
  generated_at: string;
  generator: string;
  /** llm_events_finished (2.9): finished, countable LLM events (no stalled, excluded or dev tables). */
  totals: { llm_events: number; llm_events_finished?: number; live_events: number; llm_games: number; decisions: number; agent_picks: number };
  leaderboard: LeaderboardRow[];
  events: EventSummary[]; // newest first, smoke tests included (llm: false)
  /** has_ratings / has_archetypes / has_deck_norms: human-reference data (17Lands). 2.3: featured (sets/rotation.json), has_set_context. */
  /** 2.9: llm_events_finished (finished LLM events only) and top_archetypes (the three most-played agent color pairs, with records against other agents). */
  sets: Array<{
    code: string; name: string; release_date?: string; events: number; llm_events: number; has_ratings: boolean; has_archetypes?: boolean; has_deck_norms?: boolean; featured?: boolean; has_set_context?: boolean;
    llm_events_finished?: number; top_archetypes?: Array<{ pair: string; decks: number; games: number; wins: number; losses: number }>;
    /**
     * 2.18: a set with no official release (a placeholder release date more than a year ahead, e.g. a custom set
     * phase-rs ships for testing). Hide it from Set Reports by default, or list it apart as a test set.
     */
    test_set?: boolean;
    /**
     * 2.17: how much agent data the set has (finished LLM tables, agent decks) and whether it is enough for archetype
     * findings (`ready`: at least min_decks decks from min_events tables). Below it top_archetypes is empty: show
     * `n_text` ("n = 4 agent decks from 2 tables …"), never a "most drafted" or "won the table" sentence.
     */
    insight?: SetInsight;
  }>;
  legacy_runs: Array<{ id: string; started_at: number; log_lines: number; decisions: number }>;
  // v2
  methodology: MethodologyInfo;
  identities: IdentityInfo[];
  groups: GroupInfo[];
  boards: Board[];
  // 2.8
  /** One row per model with any seat (rated or not), most rated games first; details in models/<model_id>.json. */
  models?: ModelIndexRow[];
  /** Live tables first, then finished events, agents' first rated games and ratings that became firm; newest first. */
  activity?: ActivityItem[];
  /** Featured highlights (hand-curated), resolved to the decision or pick and its situation. All highlights: highlights.json. */
  highlights?: Highlight[];
  /** The main board (the largest comparability group, all sets, all sources): the default leaderboard view. */
  main_board?: string | null;
  /** 2.15: mirror games (two seats of the same setup) as a fairness monitor; never rated. */
  mirror_check?: MirrorCheck;
}

/** 2.15: one rating difference between two versions of a model (Board.version_differences). */
export interface VersionDifference {
  a: string;
  b: string;
  /** R_a − R_b, Elo (1 decimal). */
  diff: number;
  ci: [number, number] | null;
  ahead: 'a' | 'b' | null;
}

/**
 * 2.15: games between two LLM seats of the same setup (identity) at finished, pooled events. Never rated: self-play says
 * nothing about relative strength. In a mirror both sides are the same setup, so anything that splits them other than
 * play or draw should win about half the time; a check that doesn't, with enough games, is reported as a deviation.
 */
export interface MirrorCheck {
  games: number;
  events: number;
  identities: number;
  /**
   * Games won by the seat on the play. 2.17: game 1 only (`basis: "game_1"`), where the event seed decides who is on the
   * play: a play-advantage estimate free of skill differences. Context, never a deviation.
   */
  on_play: { games: number; wins: number; rate: { value: number; ci: [number, number] | null } | null; basis?: 'game_1' };
  /**
   * 2.17: the same over every mirror game, for reference only: in games 2–3 the previous game's loser chose, and that side
   * more often holds the weaker deck, so this rate is biased toward 50%. Never call it a clean estimate.
   */
  on_play_all_games?: { games: number; wins: number; rate: { value: number; ci: [number, number] | null } | null };
  /** Checks with at least this many games can deviate. */
  min_games: number;
  checks: MirrorCheckRow[];
  deviations: number;
  /** One plain-English sentence. */
  summary: string;
}

export interface MirrorCheckRow {
  /**
   * contributor: one contributor's seats of a setup against other contributors' seats of the same setup;
   * context_policy: seats of a setup with one context policy against seats of it with another.
   */
  kind: 'contributor' | 'context_policy';
  identity: string;
  label: string; // the setup's label, "Claude Haiku 5.5 · Claude Code · Low"
  /** The contributor's opaque key, or the policy: "fresh-per-game", "fresh-per-match", "harness". */
  value: string;
  /** The contributor's public handle, when shown. */
  handle?: string | null;
  games: number;
  wins: number;
  rate: { value: number; ci: [number, number] | null } | null;
  /** games ≥ min_games and the 95% Wilson range excludes 50%. */
  deviates: boolean;
}

// ---------------------------------------------------------------------------
// events/<id>.json

export type GameStatus = 'complete' | 'live' | 'abandoned';

export interface GameSummary {
  index: number; // 1-based, in start order; file events/<id>/game-<index>.json
  label: string; // "haiku-2 vs sonnet-1 — game 1"
  match_key: string;
  game_in_match: number;
  table_code?: string;
  seats: string[];
  sides: [string, string]; // [A, B]: match pairing order, stable across the match's games
  status: GameStatus;
  winner: string | null;
  turns: number | null;
  last_turn: number;
  started_at: number;
  ended_at: number | null;
  duration_ms: number;
  decisions: Record<string, number>; // answered decisions per seat
  mana?: string;
  on_play?: string;
  end_reason?: string;
  final_life?: Record<string, number>;
  mulligans?: Record<string, number>;
  /** v2 addition (2026-10-22): engine problems that may have touched this game (METHODOLOGY §5.6). */
  engine_flags?: EngineFlags;
  /** 2.13: who started the game and who chose (play_draw records; public). Absent for older logs. */
  play_draw?: GamePlayDraw;
  /** 2.13: each seat's sideboarding before this game (games 2–3 of a match; absent in game 1 and older logs). */
  sideboarding?: Record<string, GameSideboard>;
  /** 2.13: each seat's main deck size for this game (public). */
  deck_sizes?: Record<string, number>;
}

/**
 * 2.13: a game's play/draw decision. Game 1: `by: "seed"` (random from the event seed), chooser and choice null.
 * Games 2–3: the chooser is the previous game's loser (after a drawn game, the previous chooser); `by: "forfeit"`: the
 * chooser was inactive and defaulted to play. Show "<chooser> chose to play" / "… to draw" / "On the play: <seat> (random)".
 */
export interface GamePlayDraw {
  on_play: string;
  chooser: string | null;
  choice: 'play' | 'draw' | null;
  by: 'seed' | 'agent' | 'forfeit';
  latency_ms?: number;
}

/**
 * 2.13: one seat's sideboarding before a game (games 2–3). `in` / `out` are relative to the deck it played in the
 * previous game of the match (basic land changes appear as the basic's name). `kept`: no change. `by: "forfeit"`: the
 * seat was inactive and kept its deck. Show "Sideboarded: +2 X, −2 Y" or "Kept Its Deck". While the event runs,
 * in and out are withheld until the seat has no games left (`withheld: true`, lists empty); kept, by and
 * main_count are public.
 */
export interface GameSideboard {
  by: 'agent' | 'forfeit';
  kept: boolean;
  in: CardQty[];
  out: CardQty[];
  main_count: number;
  latency_ms?: number;
  withheld?: true;
}

// ---------------------------------------------------------------------------
// v2 additions (2026-10-22): engine-issue flags and live redaction

export type EngineFlagKind = 'swapped_card_cast' | 'refused_action' | 'unimplemented_effect' | 'rules_issue' | 'known_issue_card';

export interface EngineFlag {
  kind: EngineFlagKind;
  seat: string | null; // the seat whose card or action it was (null: unknown)
  card: string | null;
  turn: number | null;
  detail?: string; // the engine's refusal reason, or the agent's report
}

export interface EngineFlags {
  flagged: boolean;
  counts: Record<EngineFlagKind, number>;
  items: EngineFlag[];
  /** The log records casts and Unimplemented effects (Director from 2026-10-22); older games can only be flagged for refusals. */
  plays_logged: boolean;
}

export interface EngineCardRow {
  name: string;
  swapped_in: number; // times put into packs in place of an unsupported card
  played_games: number; // games where it was cast or activated (logs that record casts)
  flagged_games: number; // games with a flag naming it
  swapped_cast: number;
  refused: number;
  unimplemented: number;
  rules_issues: number;
  reports: Array<{ event_id: string; game: number | null; seat: string; note: string }>; // newest first, up to 3
}

/** Flagged vs unflagged finished games (METHODOLOGY §5.6 impact test). Intervals: two-stage bootstrap over events. */
/** 2.17: card swaps and rules errors, counted apart (engine-flags.ts engineSplit). */
export interface EngineSplit {
  games: number;
  card_swaps: { swaps: number; cards: number; games: number };
  rules_errors: {
    games: number;
    by_kind: { known_issue_card: number; unimplemented_effect: number; refused_action: number; rules_issue: number };
    implicated_single_seat: number;
    lost_by_implicated: number;
  };
  text: string;
}

export interface EngineImpact {
  scope: 'llm' | 'all'; // llm: games between two LLM seats; all: every agent game, scripted smoke tests included
  games: number;
  flagged: number;
  unflagged: number;
  /** Win rate of the one implicated seat in flagged games, and its swing from 50% in points. */
  flagged_seat: { games: number; win_rate: Est | null; swing_pp: Est | null };
  rejected_per_100: { flagged: Est | null; unflagged: Est | null; diff: Est | null };
  turns: { flagged: Est | null; unflagged: Est | null; diff: Est | null };
  by_kind: Record<EngineFlagKind, { games: number; swing_pp: Est | null }>;
}

/** What was withheld from an export of an event still in progress (docs/SPECTATING.md). */
export interface Withheld {
  policy: string; picks: number; decks: number; decisions: number; views: number;
  /** 2.13: sideboarding records whose contents are withheld (the seat still has games left). */
  sideboards?: number;
}

export interface MatchSummary {
  key: string; a: string; b: string; wins: Record<string, number>; done: boolean; games: number[];
  /** The match ended with no result (engine failures; METHODOLOGY §3.2): neither won, lost nor drawn. Its finished games stand. */
  no_result?: true;
}

export interface StandingRow {
  rank: number;
  name: string;
  llm: boolean;
  colors: string;
  match_w: number; match_l: number; game_w: number; game_l: number;
  decisions: number;
  median_latency_ms: number | null;
}

export interface CardQty { name: string; qty: number }

export interface DeckDetail {
  seat: string;
  by: string; // 'agent' | 'auto' (agent delegated to the reference builder)
  latency_ms?: number;
  colors: string;
  main_count: number;
  land_count: number;
  avg_gih_wr: number | null;
  curve: number[]; // non-land cards at mana value 0..6, then 7+
  groups: Array<{ type: string; label: string; count: number; cards: CardQty[] }>;
  basics: CardQty[];
  sideboard: CardQty[];
  /** 2.2: archetype build quality (human reference: needs sets/<SET>/17lands-archetypes.json; calibration and norms need deck-norms.json). */
  build_quality?: DeckBuildQuality;
  /** 2.3: deck roles against generic Limited norms (every set, card data only). */
  roles?: DeckRoles;
}

/** 2.3: what a deck covers (METHODOLOGY §5.1 role coverage). */
export interface DeckRoles {
  lands: number;
  nonland: number;
  creatures: number;
  early: number; // non-land cards at mana value ≤ 2
  top_end: number; // non-land cards at mana value ≥ 5
  avg_mv: number | null;
  interaction: number; // removal, sweepers, bounce, tapping, counters
  removal: number;
  evasive: number; // creatures with evasion
  checks: Record<string, boolean>; // lands_16_18, creatures_12_plus, early_6_plus, top_end_6_max, avg_mv_2_5_3_5, interaction_2_plus (keys keep their generic names)
  passed: number;
  total: number;
  /**
   * 2.17: the bands the checks used: "set_pair", the deck's set and color pair's 17Lands norms (p10–p90 of decks with 6+
   * wins; lands one wider each way), or "generic". `bands[check]`: lo, hi (null: no upper bound), label; show the labels.
   */
  basis?: 'set_pair' | 'generic';
  bands?: Record<string, { lo: number; hi: number | null; label: string }>;
  source?: string | null;
}

export interface DraftSummaryRow {
  seat: string;
  position: number;
  kind: string;
  drafter: 'llm' | 'bot' | 'scripted';
  colors: string; // final deck colors
  picks: number;
  choices: number; // non-forced picks
  rated: number;
  top_pick_rate: number | null;
  avg_picked_gih: number | null;
  avg_best_gih: number | null;
  avg_regret_pp: number | null;
  avg_lane_regret_pp: number | null;
  lane_picks: number;
  median_latency_ms: number | null;
  // v2 context-aware and hindsight fields (LLM and scripted seats with a deck; null when not computable)
  conversion?: number | null; // share of non-forced, non-basic picks that made the main deck
  p1_conversion?: number | null;
  commitment_pick?: number | null; // overall pick from which ≥ 80% of colored picks are in the final colors
  signal_alignment?: number | null; // share of final colors among the 2 most open colors passed in pack 1
  open_colors?: string;
  arch_pair?: string;
  arch_regret_pp?: number | null;
  arch_current_regret_pp?: number | null;
  expert_picks?: number;
  expert_top1?: number | null;
  expert_mean_log_p?: number | null;
  expert_ev_regret_pp?: number | null;
  deck_strength?: number | null;
  reference_strength?: number | null;
  // 2.3 core draft metrics (every set; null when not computable)
  flow?: Record<string, number>; // share of the above-filler quality passed per color in pack 1, picks 2–9 (WUBRG, sums to 1)
  flow_colors?: string; // the two colors that flowed most
  flow_alignment?: number | null;
  on_color_rate?: number | null;
  pair_changes?: number | null;
  role_coverage?: number | null; // share of deck-role checks passed (see DeckDetail.roles)
}

export interface UsageRow {
  seat: string;
  harness: string;
  model: string | null;
  done: boolean; // the transcript has its final result line (cost is only known then)
  empty: boolean; // transcript file exists but is empty
  cost_usd: number | null;
  duration_ms: number | null;
  api_duration_ms: number | null;
  num_turns: number | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  thinking_tokens: number | null;
  tool_calls: Record<string, number>;
  tool_errors: number;
  is_error: boolean;
}

export interface EventFile {
  schema_version: typeof SCHEMA_VERSION;
  /** Additive revision (2.2: build quality). Readers must not require it. */
  schema_minor?: number;
  generated_at: string;
  event: EventSummary;
  config: {
    seed?: string;
    best_of: number;
    mana?: string;
    prompt_version?: string;
    knowledge: KnowledgeConfig | null;
    ratings_source?: string;
    /** 17Lands snapshot the event ran with (fallback picks, reference builds), from event_start; logs from 2026-10-22 on. */
    ratings_snapshot?: { id: string | null; sha256: string; date_range?: { first: string | null; last: string | null }; from?: 'sets' | 'pinned' };
    seats: SeatRef[];
    // v2
    source: SourceRef;
    conditions: Conditions;
    group: string | null;
    unrated_reason?: string;
    /** 2.13: best of 3 with sideboarding (event_start.sideboarding), and who chooses play or draw in games 2–3. */
    sideboarding?: boolean;
    play_draw?: string | null;
    /** ratings_snapshot: the 17Lands snapshot the human-reference numbers were computed from at export time (the latest). */
    inputs: {
      strength: boolean; draft_eval: boolean; archetypes: boolean; deck_norms?: boolean; ratings?: boolean;
      ratings_snapshot?: { id: string | null; date_range: { first: string | null; last: string | null } | null };
    };
    /** 2.3: how fallback picks and reference decks were valued: human win rates, the card-quality heuristic, or (older logs) a rarity prior. */
    bot_policy?: 'win_rates' | 'card_quality' | 'rarity_prior';
  };
  stages: {
    draft: { picks: number; done: boolean };
    build: { decks: number; agents: number; done: boolean };
    games: { played: number; live: number; done: boolean };
  };
  standings: StandingRow[];
  standings_final: boolean;
  /** 2.11: Swiss finishes by setup at this table (finished 8-agent Swiss events), rated games or not. */
  swiss_finishes?: SwissFinishes[];
  matches: MatchSummary[];
  games: GameSummary[];
  decks: DeckDetail[]; // agent seats, in seat order
  drafts: DraftSummaryRow[]; // every seat, in seat order
  usage: UsageRow[];
  swaps: Array<{ round: number; from: string; to: string }>;
  cards: CardTable; // every card named in decks, sideboards and swaps
  /** v2 addition: present while the event runs and information is withheld under the spectator policy. */
  withheld?: Withheld;
  /** v2 addition: report_rules_issue reports made outside games (draft, deckbuilding). */
  rules_issues?: Array<{ seat: string; card: string | null; note: string; stage?: string; t: number }>;
  /** 2.9: the event's best moments: curated highlights first, then automatic candidates from finished games (up to 3). */
  highlights?: Highlight[];
}

// ---------------------------------------------------------------------------
// events/<id>/draft-<seat>.json

export interface PackCard { name: string; rarity?: string; colors: string; gih_wr: number | null; ata: number | null }

export interface PickDetail {
  label: string; // "P1p1"
  pack_number: number;
  pick_number: number;
  overall_pick: number;
  by: string; // 'agent' | 'bot' | 'forced' | 'forfeit' (bot policy for an inactive agent seat)
  pick: string;
  picked_gih: number | null;
  best: { name: string; gih_wr: number } | null;
  best_in_lane: { name: string; gih_wr: number } | null; // packs 2-3, final colors only
  rated: boolean; // a real choice with at least one rated card
  matches_best: boolean;
  regret_pp: number | null;
  lane_regret_pp: number | null;
  latency_ms?: number;
  contents: PackCard[]; // pack as offered
  // v2
  arch?: { pair: string; picked: number | null; best: { name: string; value: number } | null; regret_pp: number | null };
  expert?: { p: number | null; rank: number | null; ev_regret_pp: number | null; in_lane: boolean | null; top: string | null };
}

export interface DraftFile {
  schema_version: typeof SCHEMA_VERSION;
  /** Additive revision (2.2: build quality). Readers must not require it. */
  schema_minor?: number;
  generated_at: string;
  event_id: string;
  event_status: EventStatus;
  set: SetRef;
  seat: SeatRef;
  baseline_win_rate: number | null;
  summary: DraftSummaryRow;
  picks: PickDetail[];
  cards: CardTable; // every card seen in this seat's packs
}

// ---------------------------------------------------------------------------
// events/<id>/game-<n>.json

export type DecisionStatus = 'answered' | 'withdrawn' | 'pending';

export interface TimelineEntry {
  seq: number;
  t: number;
  seat: string;
  side: 'a' | 'b';
  id: string; // decision id, e.g. "G41"
  kind: string; // phase-rs waiting_for type
  kind_label: string;
  turn: number;
  phase?: string;
  active_player: string | null;
  prompt: string;
  options_count: number;
  options?: string[];
  life?: { you?: number; opponent?: number };
  hand?: { you?: number; opponent?: number };
  since: string; // "Since your last decision" log the agent saw ("" if none)
  board: string; // the rest of the view: board, hand, card reference, the question and options
  status: DecisionStatus;
  answer: { t: number; choice: string; latency_ms?: number; accepted: boolean; structured?: boolean; card?: string; withheld?: boolean } | null;
  /** v2 addition: the view (since/board/options) is withheld while the event runs; `answer.withheld`: the choice too. */
  withheld?: boolean;
  /** 2.23: the board at this decision (visual replays), from the view; absent when the view is withheld or has no JSON. */
  state?: BoardState;
}

export interface SeatGameStatsRow {
  llm: boolean;
  model: string;
  colors: string;
  decisions: number;
  median_latency_ms: number | null;
  auto_passes: number;
  forced: number;
  rejected: number;
  manual_payments?: number;
  auto_tapper?: number;
  payment_failures?: number;
  /** 2.9: payments the engine made by itself (no plan, or topping up a plan); never the agent's own tapping. */
  auto_paid?: number;
  mulligans?: number;
}

export interface GameFile {
  schema_version: typeof SCHEMA_VERSION;
  /** Additive revision (2.2: build quality). Readers must not require it. */
  schema_minor?: number;
  generated_at: string;
  event_id: string;
  event_status: EventStatus;
  set: SetRef;
  game: GameSummary;
  seat_stats: Record<string, SeatGameStatsRow>;
  life: Array<{ turn: number; life: Record<string, number> }>;
  turns: Array<{ turn: number; active: string | null }>;
  timeline: TimelineEntry[];
  auto_passes_total: number;
  prev: { index: number; label: string } | null;
  next: { index: number; label: string } | null;
  cards: CardTable; // both decks (main + sideboard)
  /** v2 addition: present while the event runs and information is withheld. */
  withheld?: Withheld;
}

// ---------------------------------------------------------------------------
// sets/<SET>.json

export interface SetCardRow {
  name: string;
  colors: string;
  rarity?: string;
  cost: string | null;
  type_line: string | null;
  agent_picks: number;
  agent_avg_pick: number | null;
  seen: number; // packs LLM seats saw it in
  ata: number | null;
  alsa: number | null;
  delta: number | null; // agent_avg_pick − ata
  gih_wr: number | null;
  iwd: number | null; // improvement when drawn, fraction
  gih_games: number | null;
  in_decks: number;
  deck_games: number;
  deck_wins: number;
  deck_wr: number | null;
  /** 2.18: independent drafts (distinct seeds or packs) agents took it in. Thresholds on picks need pods too. */
  agent_pods?: number;
}

/**
 * 2.18: one card's agents-vs-humans pick comparison. Only picks where the agent had a real choice count (picks
 * 1–`rule.max_pick` of a pack: in a closed pod the last picks are forced), from tables that feed set findings; at least
 * `rule.min_picks` of them from `rule.min_pods` independent drafts, and a gap of at least `rule.min_gap` picks.
 */
export interface PickGap {
  name: string;
  /** Agents' average pick within the pack, over their picks 1..max_pick of the card. */
  agent_pick: number;
  picks: number;
  pods: number;
  /** Tables those picks came from, and how many of them are Early Test Data. */
  tables: number;
  early_test_tables: number;
  /** 17Lands average taken at (all picks). */
  ata: number;
  /** ata − agent_pick: positive when agents take it earlier than human drafters, negative when later. */
  gap: number;
  direction: 'earlier' | 'later';
}

export interface PickGapRule { max_pick: number; min_picks: number; min_pods: number; min_gap: number }

export interface SetFile {
  schema_version: typeof SCHEMA_VERSION;
  /** Additive revision (2.2: build quality). Readers must not require it. */
  schema_minor?: number;
  generated_at: string;
  set: SetRef;
  ratings: { source: '17lands'; format?: string; games?: number; drafts?: number; baseline_win_rate?: number; generated_at?: string } | null;
  /**
   * finished_*: 2.9, finished events only; the others include running and stalled tables. 2.18: agent_picks,
   * agent_decks, distinct_picked, finished_agent_picks and finished_agent_decks count only the tables that feed set
   * findings (finished, all 8 seats agents), like archetypes, deck_shape and cards; finished_llm_events counts every
   * finished agent table (mixed pods too).
   */
  totals: { events: number; llm_events: number; agent_picks: number; agent_decks: number; distinct_picked: number; finished_llm_events?: number; finished_agent_picks?: number; finished_agent_decks?: number };
  cards: SetCardRow[]; // sorted by agent picks, then GIH WR
  earlier: string[]; // card names agents take earliest vs 17Lands ATA (picked ≥ 2 times)
  later: string[];
  events: EventSummary[];
  /** 2.8: color pairs of agents' decks and how those decks did against other agents. */
  archetypes?: SetArchetype[];
  /** 2.8: the average agent deck in this set (DeckRoles averages) against common Limited guidance. */
  deck_shape?: SetDeckShape | null;
  /** 2.8: median overall pick from which agents' two main colors never changed (null without drafts). */
  commitment_median?: number | null;
  /** 2.8: every agent first pick (P1p1) in finished events. */
  first_picks?: SetFirstPick[];
  /** 2.17: sample size behind archetypes and deck_shape, and whether it supports findings (IndexFile.sets[].insight). */
  insight?: SetInsight;
  /**
   * 2.18: the agents-vs-humans pick gaps (PickGap), biggest first, the one definition every page uses ("biggest gap" is
   * pick_gaps[0]); empty when no card meets the rule or the set has no 17Lands data. Absent before 2.18: show no gap.
   */
  pick_gaps?: PickGap[];
  pick_gap_rule?: PickGapRule;
  /** v2 addition (2026-10-22): engine issues in this set's games (METHODOLOGY §5.6). */
  engine?: {
    games: number; // finished or live games in the set
    flagged_games: number;
    cards: EngineCardRow[]; // cards with a flag, a report or a swap; most flagged first
    impact: { llm: EngineImpact; all: EngineImpact };
    /**
     * 2.17: card swaps (unsupported cards replaced in packs: not an engine fault) apart from rules errors (known-issue
     * cards without their fix, unimplemented effects, refused actions, agents' rules reports), with counts and an upper
     * bound on the games where an error mattered; `llm` covers games between two LLM seats. Lead with `llm.text`;
     * never headline `flagged_games` (it counts swaps too).
     */
    split?: { llm: EngineSplit; all: EngineSplit };
  };
  /** 2.9: best moments in the set: curated highlights first, then automatic candidates (up to 6). */
  highlights?: Highlight[];
}

/** 2.9: summary.json, the small file for Home, Watch and Learn (everything in it is also in index.json). */
export interface SummaryFile {
  schema_version: typeof SCHEMA_VERSION;
  schema_minor?: number;
  generated_at: string;
  generator: string;
  totals: IndexFile['totals'];
  main_board: string | null;
  /** The main board without diagnostics or seats (2.10: with outcomes, cost per game and head to head). */
  main: {
    id: string; group: string; label: string; summary: string; events: number; games: number;
    connected_groups: Array<{ component: number; identities: string[] }>;
    /** 2.10: head to head within the main board's rated games (Board.pairwise). */
    pairwise: PairRecord[];
    rows: Array<{
      identity: string; label: string; model_id: string | null; model_display: string | null; harness_display: string | null; effort_display: string | null;
      rating: number | null; ci: [number, number] | null; rank_range: [number, number] | null; rank_of: number | null; default_ranking: boolean;
      provisional: boolean; games: number; wins: number; losses: number; events: number; contributors: number | null;
      expected_score: { value: number; ci: [number, number] | null } | null;
      /** 2.10: as on BoardRow. */
      provisional_reasons: string[];
      games_needed: number;
      contributor_floor_met: boolean | null;
      influence: { contributor: string; shift: number | null; flagged: boolean } | null;
      /** 2.10: BoardRow.cost, per game only. */
      cost: { per_game_usd: Est | null; basis: CostInfo['basis'] } | null;
      /** 2.10: BoardRow.outcomes (games, matches, play/draw, events, Swiss); `events.finishes` keeps the newest 10 only. */
      outcomes: Outcomes | null;
      /** 2.10: one of its seats is at a table still in progress. */
      live: boolean;
    }>;
  } | null;
  /** Every comparability group's all-sets, all-tables board, one line each (role: main or side). */
  /** swiss_finishes: 2.11 (the group's, for the all-sets board line). */
  boards: Array<{ id: string; group: string; label: string; role: 'main' | 'side'; events: number; games: number; identities: number; summary: string; swiss_finishes?: SwissFinishes[] }>;
  models: ModelIndexRow[];
  activity: ActivityItem[];
  highlights: Highlight[];
  sets: IndexFile['sets'];
  recent_events: EventSummary[]; // newest 20
  methodology: {
    doc: string | null; calibration: MethodologyInfo['calibration'] | null; thresholds: MethodologyInfo['thresholds'];
    main_condition: MethodologyInfo['main_condition'] | null; source_labels: Record<string, string>;
    /** 2.16: as in index.json (MethodologyInfo.mirror_games). */
    mirror_games: MethodologyInfo['mirror_games'] | null;
  };
  /** 2.16: the mirror check, as in index.json (IndexFile.mirror_check); null when the export has none. */
  mirror_check: MirrorCheck | null;
}

// ---------------------------------------------------------------------------
// 2.8: outcomes, head to head, diagnostics context, cost, summaries, model files, highlights, activity, set summaries

/** A won–lost record. `win_rate.ci`: the wider of the cluster bootstrap (events, then items) and the Wilson interval. */
export interface WinLoss { w: number; l: number; win_rate: Est | null }

/** One event a seat sat in: its finish among the agent seats. */
export interface EventFinish {
  event_id: string;
  seat: string;
  started_at: number;
  format: 'swiss' | 'round-robin';
  rank: number; // place among agent seats in the final standings
  of: number; // agent seats
  won: boolean; // the event's winner (EventSummary.winner); false on a tie
  match_w: number; match_l: number; // every match of the seat in the event
}

/** Outcomes only: what an identity (or model) achieved against other agents. */
export interface Outcomes {
  games: WinLoss;
  /** Matches decided by the rated games (a match whose rated games are level, after a voided game, is `drawn`). */
  matches: WinLoss & { drawn: number };
  /** 2.17: game 1 of each match only (random play/draw). Games 2–3, where the previous loser chose, are in neither split. */
  on_play: WinLoss;
  on_draw: WinLoss;
  side_unknown: number; // rated games whose log didn't say who was on the play
  events: { played: number; won: number; finishes: EventFinish[] };
  /** Three-round Swiss events with 8 agents: finishes by match record ("3-0", "2-1", "1-2", "0-3") and the 3–0 rate. Null without such events. */
  swiss: { events: number; rounds: number; counts: Record<string, number>; trophy_rate: Est | null } | null;
}

/** Head to head between identities a and b (a < b): games and matches decided by rated games. */
export interface PairRecord { a: string; b: string; games: number; a_wins: number; matches: number; a_match_wins: number; drawn_matches: number; events: number }

/** A headline diagnostic: descriptive behavior, never a score. */
export interface DiagnosticDef {
  key: string; // "on_color_rate"
  stage: 'draft' | 'build' | 'play' | 'cost';
  label: string; // "Picks Their Deck Could Cast"
  definition: string;
  unit: 'share' | 'pick' | 'count' | 'per_100' | 'ms' | 'usd' | 'tokens';
  /** How rank-of-N orders rows: "desc" = highest value is rank 1. null: not ranked (no meaningful order). */
  order: 'desc' | 'asc' | null;
  rank_label: string | null; // "highest first"
  /** Where the full value lives in BoardRow.stages (dot path), or "cost.per_game_usd". */
  path: string;
}

export interface DiagnosticValue {
  value: number | null;
  ci: [number, number] | null;
  n: number;
  field_median: number | null;
  rank: number | null; // 1 = first in DiagnosticDef.order; ties share a rank
  of: number; // rows with a value
}

export interface CostInfo {
  /** Total cost of the seats with a cost, over their finished games. `ci` is a cluster bootstrap over events. */
  per_game_usd: Est | null;
  /** reported: every costed seat's harness reported it; estimated: none did; mixed: some of each; null: no cost. */
  basis: 'reported' | 'estimated' | 'mixed' | null;
  total_usd: number | null;
  seats_reported: number;
  seats_estimated: number;
  seats_missing: number; // no reported cost and no token counts (or no price for the model)
  /** 2.21: costed seats whose reported cost wasn't used: $0 with tokens, more than 35% from the token estimate, or a self-reported upload re-priced from its tokens. */
  seats_flagged?: number;
  games: number; // finished games of the costed seats
  /** Prices behind the estimates (registry/prices.json). */
  prices: Array<{ model_id: string; from: string; source: string; checked: string }>;
  /** 2.17: seats and tables the number covers, of all in scope, and one sentence saying so ("Based on 9 of 22 seats, at 2 of 8 tables …"). */
  seats_total?: number;
  seats_covered?: number;
  events_total?: number;
  events_covered?: number;
  coverage_text?: string;
}

/**
 * 2.17: cost under one condition: the table format (best of 3 with sideboarding, or Early Test Data) and the seat's
 * context policy. Costs under different conditions aren't comparable (a fresh session per game cost about a fifth of one
 * long session for the same seat), so a model's cost is reported per condition, never pooled across them.
 */
export interface CostCondition extends CostInfo {
  key: string; // "<format>|<context policy>": "bo3|fresh-per-game", "early|harness"
  label: string; // "Best of 3 with Sideboarding · Fresh Session per Game"
  early_test_data: boolean;
  context_policy: 'fresh-per-game' | 'fresh-per-match' | 'harness';
}

/** One rated version of a model (2.20: its effort level) on one comparability group's all-sets board. */
export interface ModelRating {
  identity: string;
  label: string; // "Claude Sonnet 5.5 · Medium"
  /** Deprecated (2.20): absent; a version is a model at an effort level. */
  harness_display?: string;
  effort_display: string; // "Unknown Effort" rows stay listed and labeled
  effort_known: boolean;
  model_verification: string | null;
  board: string; // Board.id
  group: string;
  group_label: string;
  rating: number | null;
  ci: [number, number] | null;
  rank: number | null;
  rank_range: [number, number] | null;
  of: number; // 2.9: rows on the default ranking in its connected group (BoardRow.rank_of); before: rated rows on the board
  /** 2.9: the board's group is the main condition ("main") or a side board ("side"). */
  role?: 'main' | 'side';
  /** 2.9: false for Unknown Effort (rank_range is then null; the row stays listed). */
  default_ranking?: boolean;
  games: number; wins: number; losses: number; events: number; opponents: number;
  provisional: boolean;
  provisional_reasons: string[];
  games_needed: number;
  outcomes: Outcomes | null;
  diagnostics: Record<string, DiagnosticValue>;
  cost: CostInfo | null;
  /** Rating after each event of this board's group in which it played (no bootstrap: rating ± 1.96·se). */
  history: HistoryPoint[];
}

export interface ModelOpponent { model_id: string; model_display: string; games: number; wins: number; matches: number; match_wins: number; win_rate: Est | null }

/** A card a model drafts: picks across its finished drafts. */
/**
 * A card on a model page. 2.18: `avg_pick` is the pick within the pack (1–14; was the overall pick 1–42), `first_picks`
 * counts pick 1 of every pack (was pack 1 only), `early_picks` the picks 1–5 of a pack; `most_picked` is sorted by
 * early_picks (late picks are forced, and a one-model table takes every card).
 */
export interface ModelCardRow { name: string; set: string; picks: number; early_picks?: number; drafts: number; avg_pick: number; first_picks: number; in_decks: number }

export interface ModelEventRow {
  event_id: string;
  set: SetRef;
  started_at: number;
  status: EventStatus;
  seat: string;
  identity: string;
  rated: boolean; // the seat's games count toward a rating
  group: string | null;
  knowledge_label: string | null;
  colors: string;
  game_w: number; game_l: number; // finished games against other agents (any identity)
  match_w: number; match_l: number;
  rank: number | null; of: number;
  won: boolean;
  format: 'swiss' | 'round-robin';
}

export interface HistoryPoint { event_id: string; at: number; rating: number; ci: [number, number] | null; games: number; provisional: boolean }

export interface ModelIndexRow {
  model_id: string;
  model_display: string;
  provider: string | null;
  provider_display: string | null;
  identities: string[];
  rated_games: number; // rated games against other models, in the model page's group (2.9; before: every group)
  /** 2.9: rated games against other models across every group (never pooled into one number on the page). */
  rated_games_all_groups?: number;
  /** 2.9: the comparability group the model page's results come from. */
  group?: string | null;
  events: number;
  /** 2.15: concrete effort levels of its rated versions on the model page's board (show the Effort Ladder from 2 levels). */
  effort_levels?: number;
  /** 2.20 (meaning): the harnesses its settled seats ran on (descriptive; see ModelFile.harness_split). */
  harness_variants?: number;
  /** Its most-played rated version on the main board, else on any board. */
  main: { identity: string; board: string; rating: number | null; ci: [number, number] | null; rank_range: [number, number] | null; of: number; provisional: boolean } | null;
  summary: string;
  file: string; // "models/claude-sonnet-5-5.json"
}

export interface ModelFile {
  schema_version: typeof SCHEMA_VERSION;
  schema_minor?: number;
  generated_at: string;
  model: { id: string; display: string; provider: string | null; provider_display: string | null; released?: string; status?: string; source?: string };
  /**
   * 2.9: the comparability group behind `summary`, `outcomes` and `opponents`: the main board's group when the model
   * has rated games there, else the group where it has the most. Results never pool across groups.
   */
  group?: string | null;
  group_label?: string | null;
  /** Generated plain-English summary, outcomes first; says "too early to rank" until it is clearly ahead of or behind someone. */
  summary: string;
  /** Every rated version on every comparability group's all-sets board; the main one (most games, main board first) first. */
  ratings: ModelRating[];
  /** Results across all its versions in `group`: rated games against other models only (games between two versions of it are left out). */
  outcomes: Outcomes;
  opponents: ModelOpponent[];
  /**
   * Cost per game. 2.17: under its main condition only (`cost_conditions[0]`: best of 3 with sideboarding and the
   * default fresh session per game when it has such seats, else the condition with the most costed games), with
   * `coverage_text`; never pooled across conditions. Show `cost_conditions` for the rest.
   */
  cost: CostInfo & { condition?: string | null };
  /** 2.17: cost per condition (format × context policy), main condition first. */
  cost_conditions?: CostCondition[];
  /**
   * 2.17: distinct games and tables this model played (a game between two of its own seats counts once, not twice):
   * use these for "Games Played", never a sum over seats. `mirror_games`: games where it played itself.
   */
  played?: { games: number; mirror_games: number; events: number; seats: number; text: string };
  cards: { most_picked: ModelCardRow[]; earliest: ModelCardRow[] };
  events: ModelEventRow[]; // newest first
  /** Three of its highlights (moments): curated ones first, else recent automatic ones. */
  notes: Highlight[];
  /** 2.15: ratings, results and cost by effort (2.20: one ladder per model, across harnesses). */
  effort_ladder?: EffortLadder[];
  /** Deprecated (2.20): absent. A harness is never a separate rating; see `harness_split`. */
  harness_comparison?: HarnessComparison[];
  /** 2.20: per effort level whose seats ran on 2+ harnesses: results by harness. Descriptive, never rated (METHODOLOGY §2.3). */
  harness_split?: HarnessSplit[];
}

/**
 * 2.20: one effort level of a model, its games against other setups split by the harness its seat ran on. Raw results
 * with Wilson intervals, never a rating: opponents, sets and contributors differ between the rows. Show it as a check
 * ("does the harness seem to matter?"), never as a ranking.
 */
export interface HarnessSplit {
  identity: string;
  effort: string;
  effort_display: string;
  rows: Array<{ harness: string; harness_display: string; seats: number; games: number; wins: number; win_rate: { value: number; ci: [number, number] | null } | null }>;
  text: string;
}

/** 2.15: one rated version of a model on a board, as the Effort Ladder and Harness Comparison show it. */
export interface VersionRung {
  identity: string;
  label: string; // "Claude Haiku 5.5 · High"
  /** Deprecated (2.20): absent; a rung is a model at an effort level, whatever harness ran it. */
  harness?: string;
  harness_display?: string;
  effort: string;
  effort_display: string;
  rating: number | null;
  ci: [number, number] | null;
  expected_score: { value: number; ci: [number, number] | null } | null;
  provisional: boolean;
  provisional_reasons: string[];
  games: number;
  wins: number;
  losses: number;
  events: number;
  /** Rated games won (the board's outcomes; else wins / games with a Wilson range). */
  game_win_rate: Est | null;
  cost_per_game_usd: Est | null;
  cost_basis: 'reported' | 'estimated' | 'mixed' | null;
}

/** 2.15: from one version to the next: rating and cost change, with the interval of the rating difference. */
export interface VersionStep {
  from: string; // identity
  to: string;
  /** R_to − R_from, Elo. */
  rating_change: number | null;
  ci: [number, number] | null;
  /** up: `to` is ahead on its own 95% range (the interval excludes 0); down: behind; null: too early to say. Show `verdict`. */
  credible: 'up' | 'down' | null;
  cost_change_per_game_usd: number | null;
  /** 2.17: two-sided p-value read off the difference interval, and Holm-adjusted over this ladder's (or comparison's) steps. */
  p_value?: number | null;
  p_holm?: number | null;
  /** 2.17: steps in this family (the Holm correction's size). */
  comparisons?: number;
  /** 2.17: either row is provisional (the contributor floor included). */
  provisional?: boolean;
  /**
   * 2.17: what to say. higher / lower: both rows firm and the difference holds after the Holm correction (say "rated
   * higher", never "a clear gain" or "helped"); provisional: the range excludes 0 but a row is provisional; unadjusted:
   * it does on its own range, not after the correction; open: too early to say.
   */
  verdict?: 'higher' | 'lower' | 'provisional' | 'unadjusted' | 'open';
}

/** 2.15: games between two versions of one model (a < b), with their rating difference. */
export interface VersionHeadToHead {
  a: string;
  b: string;
  a_label: string;
  b_label: string;
  games: number;
  a_wins: number;
  matches: number;
  a_match_wins: number;
  a_win_rate: { value: number; ci: [number, number] | null } | null;
  difference: { diff: number; ci: [number, number] | null; ahead: 'a' | 'b' | null } | null;
}

/** 2.15: one harness's versions of a model, ordered by effort (none … max, then ultra, which has no order). */
export interface EffortLadder {
  /** Deprecated (2.20): absent; one ladder per model, across harnesses. */
  harness?: string;
  harness_display?: string;
  board: string;
  group: string;
  group_label: string;
  rungs: VersionRung[];
  /** Consecutive rungs, lower effort to higher (ultra after max, labeled as its own level). */
  steps: VersionStep[];
  head_to_head: VersionHeadToHead[];
  /** Any rung provisional. */
  provisional: boolean;
  /** Rows of this model with Unknown Effort on the board (left out of the ladder). */
  unknown_effort_rows: number;
  summary: string;
}

/** 2.15: one effort level of a model through different harnesses (most rated games first). */
export interface HarnessComparison {
  effort: string;
  effort_display: string;
  board: string;
  group: string;
  group_label: string;
  rows: VersionRung[];
  /** Every pair of rows, against the first (most games). */
  steps: VersionStep[];
  head_to_head: VersionHeadToHead[];
  provisional: boolean;
  summary: string;
}

/** A moment worth showing: an agent's decision or pick, with its situation and the choice it made. */
export interface Highlight {
  id: string;
  source: 'curated' | 'auto';
  label: string; // "Lethal Setup", "First Pick"
  why: string | null; // curated: why it's notable
  featured: boolean;
  event_id: string;
  set: SetRef;
  seat: string;
  identity: string | null;
  model_id: string | null;
  model_display: string | null;
  identity_label: string | null;
  kind: 'game' | 'pick';
  choice: string;
  game?: { index: number; label: string; decision_id: string; seq: number; turn: number; life: { you: number | null; opponent: number | null } | null; won: boolean | null; turns: number | null; final_turn: boolean };
  pick?: {
    label: string; pack_number: number; pick_number: number; pick: string;
    /**
     * 2.17: the 17Lands human reference for the pick, when the set has 17Lands data (null otherwise): the card's average
     * pick position (ATA, 1 = first) and games-in-hand win rate, and the pack's best card by GIH WR when it isn't the pick.
     * Show it next to the quote so a pick reads as data, not an endorsement.
     */
    human?: { source: '17Lands'; ata: number | null; gih_wr: number | null; pack_best: { name: string; gih_wr: number } | null } | null;
  };
}

export interface ActivityItem {
  kind: 'event_live' | 'event_finished' | 'first_rated_game' | 'rating_firm';
  at: number;
  event_id: string | null;
  set: SetRef | null;
  identity?: string;
  identity_label?: string;
  /**
   * event_finished: the winning seat's identity label (null on a tie). 2.17: only at a mixed table (two models or more):
   * null at a mirror or single-model table, and at a stopped one.
   */
  winner_label?: string | null;
  /** 2.17: event_finished: the table kind (EventSummary.table_kind). */
  table_kind?: 'scripted' | 'test' | 'mirror' | 'single_model' | 'mixed'; // 'test': 2.22
  /** 2.17: event_finished for a table stopped before it finished (its finished games count). */
  stopped?: true;
  /** 2.13: event items of Early Test Data (show "Early Test Data" with them). */
  test_data?: true;
  text: string; // one plain-English line
}

/** 2.17: win_rate is null under 20 games against other agents (the record is still given). */
export interface SetArchetype { pair: string; decks: number; games: number; wins: number; losses: number; win_rate: Est | null }

/**
 * 2.17: see IndexFile.sets[].insight. 2.18: every number is about the tables that feed set findings (finished, all 8
 * seats language-model agents): `events` those tables, `pods` the independent drafts among them (distinct seeds or
 * packs; `ready` needs min_events of these), `early_test_events` how many of them are Early Test Data (say so with the
 * finding: "from N early test tables"), `excluded_events` finished agent tables of the set left out because scripted
 * drafters or players sat at them (watchable, never in a finding). `rule` is "all_agent_tables".
 */
export interface SetInsight {
  ready: boolean; decks: number; events: number; min_decks: number; min_events: number; n_text: string;
  pods?: number; early_test_events?: number; excluded_events?: number; rule?: 'all_agent_tables';
}

export interface SetDeckShape {
  decks: number;
  lands: number; creatures: number; early: number; top_end: number; avg_mv: number | null; interaction: number; removal: number;
  passed_all: number; // decks passing every deck check
  checks: Record<string, number>; // decks passing each check
  /**
   * 2.17: decks checked against their set and color pair's 17Lands norms (p10–p90 of winning decks; DeckRoles.source)
   * and decks checked against the generic bands (mono, three-color, or a pair with too few 17Lands decks). Say which.
   */
  norms?: { set_pair: number; generic: number };
}

export interface SetFirstPick { event_id: string; seat: string; identity: string | null; model_display: string | null; pick: string; colors: string }

/** highlights.json */
export interface HighlightsFile {
  schema_version: typeof SCHEMA_VERSION;
  schema_minor?: number;
  generated_at: string;
  highlights: Highlight[];
  /** Curated entries that could not be resolved against the logs (wrong id, event not exported), with the reason. */
  unresolved: Array<{ id: string; reason: string }>;
}

/** 2.23: one permanent on a replay board (grouped objects in the view become one entry per object). */
export interface BoardPerm {
  id: number; // the game's object id (-1 when the view gave none)
  card: string;
  tapped?: boolean;
  pt?: string; // current power/toughness
  loyalty?: number;
  counters?: Record<string, number>;
  keywords?: string[]; // printed and granted
  sick?: boolean;
  damage?: number;
  token?: boolean;
  attached_to?: number;
}

/**
 * 2.23: the board at a decision, as the deciding seat saw it: both players' public zones, life, hand and library
 * counts, the stack, and the deciding seat's own hand. Released with the decision's view (never while it's withheld).
 */
export interface BoardState {
  turn: number;
  step: string | null;
  active: string | null; // seat
  priority: string | null; // seat
  players: Record<string, { life: number; hand: number; library: number; poison?: number; graveyard: string[]; exile: string[]; battlefield: BoardPerm[] }>;
  stack: Array<{ card: string; controller: string | null; kind: string; text?: string; targets?: string[] }>;
  hand: { seat: string; cards: string[] };
}
