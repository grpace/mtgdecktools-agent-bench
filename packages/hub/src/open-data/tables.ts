/**
 * The open dataset's tables (docs/OPEN-DATA.md): one definition per table, read by the CSV and Parquet writers, the
 * schema check, the data card and the docs test. Change a column here and the files, DATASET.md and the check follow;
 * bump OPEN_DATA_SCHEMA_VERSION when a column is renamed or removed or its meaning changes (adding one is fine).
 */

/**
 * 3 (2026-10-25): seats answer with their choice only (no note columns on picks, decks, games, decisions, sideboarding);
 * 2 (2026-10-23): identities are model/effort (the harness is a seat detail); 1: harness/model/effort.
 */
export const OPEN_DATA_SCHEMA_VERSION = 3;

/**
 * - string, int, double, bool: as named (CSV: empty cell for null; booleans as true/false).
 * - json: a JSON value as text (CSV) or a Parquet JSON column (BYTE_ARRAY with the JSON converted type); lists of card
 *   names or { name, qty } objects. DuckDB: `from_json(col, '["VARCHAR"]')`; pandas: `json.loads`.
 * - timestamp: UTC; CSV ISO 8601 (`2026-10-22T14:39:42.890Z`), Parquet TIMESTAMP_MILLIS.
 */
export type ColumnType = 'string' | 'int' | 'double' | 'bool' | 'json' | 'timestamp';

export interface ColumnDef {
  name: string;
  type: ColumnType;
  description: string;
  /** Never null (the check enforces it). Default: nullable. */
  required?: boolean;
}

export interface TableDef {
  name: string;
  description: string;
  /** One row per … (the data card's "Grain"). */
  grain: string;
  /** Columns that identify a row. */
  key: string[];
  /** Split per set under tables/by-set/<SET>/ (every table has a set column or joins to events). */
  bySet: boolean;
  /** Not under our license: the human_reference table (17Lands-derived, CC BY 4.0 with its own credit). */
  thirdParty?: boolean;
  columns: ColumnDef[];
}

const s = (name: string, description: string, required = false): ColumnDef => ({ name, type: 'string', description, ...(required ? { required } : {}) });
const i = (name: string, description: string, required = false): ColumnDef => ({ name, type: 'int', description, ...(required ? { required } : {}) });
const d = (name: string, description: string): ColumnDef => ({ name, type: 'double', description });
const b = (name: string, description: string, required = false): ColumnDef => ({ name, type: 'bool', description, ...(required ? { required } : {}) });
const j = (name: string, description: string): ColumnDef => ({ name, type: 'json', description });
const t = (name: string, description: string): ColumnDef => ({ name, type: 'timestamp', description });

const EVENT_ID = s('event_id', 'Event id (`YYYY-MM-DD-HH-MM-SS-<set>-<hex>`); joins every table.', true);
const SEAT = s('seat', 'Seat name at the table (neutral `seat-<hex>` on current tables; older test tables used model-like names).', true);

export const TABLES: TableDef[] = [
  {
    name: 'events',
    description: 'Finished, accepted events: conditions, provenance, format and integrity results.',
    grain: 'one row per event',
    key: ['event_id'],
    bySet: true,
    columns: [
      EVENT_ID,
      s('set_code', 'Set code, upper case (`FRA`).', true),
      s('set_name', 'Set name.'),
      t('started_at', 'First log line.'),
      t('ended_at', 'Last log line.'),
      s('status', '`complete`, or `stopped` (its organizer, an admin or the server stopped it; its finished games are rated, games never played are not results; METHODOLOGY §3.2 "Stopped events").', true),
      s('stopped_by', 'Who stopped it: `organizer`, `admin`, `system` or `unknown`; null when it finished.'),
      s('stop_reason', 'Why it stopped (`canceled`, `max_duration`, `abandoned`, `resume_failed`); null when it finished.'),
      s('provenance', '`hosted` (a table on our hosted Director) or `community` (a contributor ran it and uploaded the logs).', true),
      s('table_kind', '`lobby` (seats from several contributors), `private` (one contributor brought all 8 agents) or null (an admin or self-hosted table).'),
      s('pairing', '`swiss` (3 rounds, 8 agents) or `round-robin` (older test tables).'),
      i('rounds', 'Rounds of matches.'),
      i('best_of', 'Games per match: 3 (best of 1 only in Early Test Data).'),
      b('sideboarding', 'Best of 3 with sideboarding between games (the format from 2026-10-22 on).'),
      s('play_draw_rule', 'Who chooses play or draw in games 2-3: `loser-chooses`; null in older logs.'),
      s('knowledge', 'What the agents were given: `none`, `primer` (the Set Context) or `primer+stats` (Set Context plus human statistics).'),
      s('mana', '`manual` (agents choose which lands to tap) or `auto` (the engine pays).'),
      s('prompt_version', 'Prompt folder the Director used (`v4`, `current`).'),
      s('prompt_sha256', 'Content hash of the prompt files: events with the same hash used the same prompts.'),
      s('set_context_sha256', 'Hash of the Set Context text the agents read (CC0; null without one).'),
      s('engine_version', 'phase-rs server version.'),
      s('engine_build', 'phase-rs build commit.'),
      i('engine_protocol', 'phase-rs protocol version.'),
      s('engine_digest', 'Container image digest of the rules engine.'),
      s('director_version', 'Director (event server) commit; `-dirty` marks a modified build.'),
      s('bot_ratings_snapshot', 'Id of the 17Lands-derived ratings snapshot the Director used for fallback picks and reference builds (an id only).'),
      s('seed', 'Event seed (pack generation and pairings).'),
      i('agent_seats', 'Agent seats (LLM and scripted).'),
      i('llm_seats', 'Seats driven by a language model.'),
      i('scripted_seats', 'Seats driven by a script or a bot drafter (early test tables only).'),
      b('test_table', 'An early test table: fewer than 8 agents, or scripted or bot drafters at the table.'),
      b('early_test_data', 'Played before best of 3 with sideboarding (best of 1, or best of 3 without sideboarding): never rated.'),
      s('early_test_data_reason', 'Why it is Early Test Data.'),
      s('comparability_group', 'Group key: events that may be pooled (`kn=primer;mana=manual;prompt=sha256:...`); null when unrated.'),
      s('rating_status', '`rated`, `no_rated_games` or `not_rated`.'),
      i('rated_games', 'Games that count toward ratings.'),
      s('unrated_reason', 'Why the event is not rated, when it is not.'),
      s('excluded_reason', 'Excluded from ratings by a reviewer, with the reason (e.g. a Director bug).'),
      s('pack_regeneration', 'Hub check that the packs regenerate from the seed: `verified`, `partial`, `unverifiable` or `failed`.'),
      j('integrity_flags', 'Codes of the Hub checks that flagged something at intake (list); details in docs/METHODOLOGY.md.'),
      i('games', 'Finished games.'),
      i('matches', 'Matches.'),
      i('engine_flagged_games', 'Games with an engine-issue flag (a card the engine refused, an unimplemented effect, a reported rules issue).'),
      s('winner', 'Seat with the best record (null on a tie).'),
      s('log_file', 'Path of the redacted event log, relative to the dataset root.'),
      s('log_sha256', 'sha256 of that file.'),
    ],
  },
  {
    name: 'seats',
    description: 'Who sat where: model, harness, effort with its source and verification, context policy, contributor, record and usage.',
    grain: 'one row per seat per event',
    key: ['event_id', 'seat'],
    bySet: true,
    columns: [
      EVENT_ID,
      SEAT,
      i('position', 'Draft table position (0-based; packs pass left in rounds 1 and 3).', true),
      s('kind', '`agent` or `bot`.', true),
      s('drafter', '`llm`, `scripted` (a test script) or `bot` (a 17Lands-rated bot drafter, early test tables only).', true),
      b('llm', 'Driven by a language model.', true),
      s('identity', 'Setup key `harness/model/effort` (`claude-code/claude-haiku-5-5/low`); the unit of the leaderboard.'),
      s('model_id', 'Canonical model id from the registry (`unlisted:<slug>` when the registry does not list it).'),
      s('model_display', 'Model name (`Claude Haiku 5.5`).'),
      s('provider', 'Model provider (`anthropic`).'),
      s('harness_id', 'Harness id (`claude-code`).'),
      s('harness_display', 'Harness name.'),
      s('effort', 'Reasoning effort level (`low`, `medium`, `high`, ... or `unknown`).'),
      s('effort_display', 'Effort label.'),
      s('effort_source', 'How the effort was established: `declared-explicit` (set at launch), `detected` (from the harness logs), `harness-default`, `self-reported` or `unknown`.'),
      s('effort_status', '`verified` (the harness logs show the level), `self-reported` or `mismatch`.'),
      s('model_declared', 'The model as typed, when it differs from model_id.'),
      s('model_verification', '`verified` (harness usage logs show the declared model; shown as "Checked Against Logs"), `self-reported`, `mismatch` or `unlisted`.'),
      s('logs_read_by', 'Who read the harness logs behind the model check: `contributor-cli`, `export` or null (none were read). Both are contributor-supplied.'),
      b('rated', 'Counts toward ratings (false for Mismatch and Unlisted seats).'),
      s('context_policy', '`harness` (one harness session for the event), `fresh-per-game` or `fresh-per-match` (the launcher started a fresh session per game or match).'),
      s('contributor_key', 'Opaque, stable key of the contributor who seated it (a salted hash, never an account id), or `admin` / `unattributed`.'),
      s('contributor_handle', 'Public handle, only for a contributor who chose to be shown publicly; otherwise null.'),
      s('contributor_via', 'How the contributor was established: `uploader`, `lobby-seat`, `organizer`, `admin` or `unattributed`.'),
      s('final_colors', 'Colors of the final deck (WUBRG order).'),
      i('standing', 'Final standing (1 = best).'),
      i('match_wins', 'Matches won.'),
      i('match_losses', 'Matches lost.'),
      i('game_wins', 'Games won.'),
      i('game_losses', 'Games lost.'),
      s('usage_model', 'Model id the harness usage logs reported (most output tokens).'),
      i('input_tokens', 'Uncached input tokens over the event (harness-reported).'),
      i('output_tokens', 'Output tokens.'),
      i('cache_read_tokens', 'Cached input tokens read.'),
      i('cache_creation_tokens', 'Input tokens written to the cache.'),
      d('cost_usd', 'Cost in US dollars at list prices: harness-reported, or estimated from token counts (`cost_basis`).'),
      s('cost_basis', '`reported` or `estimated`; null without usage.'),
    ],
  },
  {
    name: 'picks',
    description: 'Every draft pick: the pack as offered and the pick.',
    grain: 'one row per pick',
    key: ['event_id', 'seat', 'pack_number', 'pick_number'],
    bySet: true,
    columns: [
      EVENT_ID,
      SEAT,
      i('pack_number', 'Pack (1-3).', true),
      i('pick_number', 'Pick within the pack (1-14).', true),
      i('overall_pick', 'Pick within the draft (1-42).', true),
      s('pick', 'Card taken.', true),
      s('by', '`agent`, `bot`, `forced` (last card) or `forfeit` (the seat was inactive; the bot policy picked).', true),
      i('pack_size', 'Cards in the pack when offered.', true),
      j('pack_contents', 'Card names in the pack as offered (list, with duplicates).'),
      j('pack_rarities', 'Rarity of each card in pack_contents, from the booster sheet (list; null in older logs).'),
      i('latency_ms', 'Time from offer to answer.'),
      b('made_main_deck', 'A copy of the picked card is in the seat\'s main deck (null without a deck).'),
    ],
  },
  {
    name: 'decks',
    description: 'Registered decks: main deck and sideboard (the deck each match starts from).',
    grain: 'one row per agent seat with a deck',
    key: ['event_id', 'seat'],
    bySet: true,
    columns: [
      EVENT_ID,
      SEAT,
      s('by', '`agent`, or `auto` (the agent delegated to the reference builder, or forfeited).', true),
      s('colors', 'Deck colors (WUBRG order).'),
      i('main_count', 'Main deck size.', true),
      i('land_count', 'Lands in the main deck.'),
      j('main', 'Main deck as a list of { name, qty }, basic lands included.'),
      j('sideboard', 'Sideboard as a list of { name, qty }.'),
      s('deck_name', 'Name the agent gave the deck.'),
      s('archetype', 'Archetype the agent named.'),
      i('latency_ms', 'Time from offer to answer.'),
    ],
  },
  {
    name: 'games',
    description: 'Every game: seats, play/draw and who chose it, result, life, mulligans, deck sizes and engine flags.',
    grain: 'one row per game',
    key: ['event_id', 'game_index'],
    bySet: true,
    columns: [
      EVENT_ID,
      i('game_index', '1-based, in start order within the event.', true),
      s('match_key', 'Match (`<seat_a> vs <seat_b>`).', true),
      i('round', 'Swiss round.'),
      i('game_in_match', 'Game number within the match (1-3).', true),
      s('seat_a', 'First seat of the match pairing (sides stay fixed across a match).', true),
      s('seat_b', 'Second seat.', true),
      s('status', '`complete` or `abandoned` (voided by an infrastructure failure and replayed; never scored).', true),
      s('winner', 'Winning seat (null for a draw or an abandoned game).'),
      i('turns', 'Turns played.'),
      s('on_play', 'Seat on the play.'),
      s('play_draw_by', '`seed` (game 1, random from the event seed), `agent` (the chooser decided) or `forfeit` (the chooser was inactive).'),
      s('play_draw_chooser', 'Seat that chose play or draw (games 2-3: the loser of the previous game).'),
      s('play_draw_choice', '`play` or `draw`.'),
      s('end_reason', 'How it ended (`life`, `concede`, ...).'),
      s('forfeited_by', 'Seat conceded by the inactivity watchdog (a harness failure; not a misplay).'),
      i('life_a', 'Final life of seat_a.'),
      i('life_b', 'Final life of seat_b.'),
      i('mulligans_a', 'Mulligans taken by seat_a.'),
      i('mulligans_b', 'Mulligans taken by seat_b.'),
      i('deck_size_a', 'Main deck size of seat_a in this game (after sideboarding).'),
      i('deck_size_b', 'Main deck size of seat_b in this game.'),
      i('decisions_a', 'Decisions seat_a answered.'),
      i('decisions_b', 'Decisions seat_b answered.'),
      t('started_at', 'Game start.'),
      t('ended_at', 'Game end.'),
      i('duration_ms', 'Wall time.'),
      b('engine_flagged', 'An engine-issue flag touched this game (METHODOLOGY §5.6).'),
      j('engine_flags', 'Flag counts by kind: { swapped_card_cast, refused_action, unimplemented_effect, rules_issue, known_issue_card }.'),
      b('rated', 'Counts toward the ratings (the rating code\'s own rule: a finished game with a winner between two different rated LLM setups at a pooled event; a watchdog forfeit is a loss).', true),
      s('rating_group', 'Comparability group the game is rated in (joins ratings.group_key and boards.group_key); null when not rated.'),
      s('unrated_reason', 'Why the game is not rated (`mirror (same setup on both sides)`, `event not rated: ...`, ...); null when rated.'),
      s('identity_a', 'Setup key (`harness/model/effort`) of seat_a; null for a scripted or bot seat.'),
      s('identity_b', 'Setup key of seat_b.'),
      s('contributor_a', 'Contributor key of seat_a (as in seats.contributor_key).'),
      s('contributor_b', 'Contributor key of seat_b.'),
      b('on_play_random', 'Game 1 of its match with a known side on the play: the event seed chose it, so it enters the play term of the rating (games 2-3, where the previous loser chose, do not).', true),
    ],
  },
  {
    name: 'matches',
    description: 'Every match and its score.',
    grain: 'one row per match',
    key: ['event_id', 'match_key'],
    bySet: true,
    columns: [
      EVENT_ID,
      s('match_key', 'Match (`<seat_a> vs <seat_b>`).', true),
      i('round', 'Swiss round.'),
      s('seat_a', 'First seat.', true),
      s('seat_b', 'Second seat.', true),
      i('wins_a', 'Games seat_a won.', true),
      i('wins_b', 'Games seat_b won.', true),
      i('games', 'Games played.', true),
      s('winner', 'Match winner (null on a tie).'),
    ],
  },
  {
    name: 'decisions',
    description: 'Every in-game decision: kind, options offered and the choice. The full text the agent saw is in the event log and in the optional decision-texts files.',
    grain: 'one row per decision offered to a seat in a game',
    key: ['event_id', 'game_index', 'seat', 'decision_id'],
    bySet: true,
    columns: [
      EVENT_ID,
      i('game_index', 'Game (joins games).', true),
      SEAT,
      s('decision_id', 'Decision id (unique per game and seat).', true),
      i('seq', 'Order within the game (0-based).', true),
      s('kind', 'Decision kind (`Priority`, `DeclareAttackers`, `DeclareBlockers`, `TargetSelection`, `MulliganDecision`, ...).', true),
      i('turn', 'Turn number.'),
      s('phase', 'Game phase or step.'),
      s('active_player', 'Seat whose turn it was.'),
      i('life_self', 'The deciding seat\'s life.'),
      i('life_opponent', 'The opponent\'s life.'),
      i('hand_self', 'Cards in the deciding seat\'s hand.'),
      i('hand_opponent', 'Cards in the opponent\'s hand.'),
      i('options_count', 'Options offered.'),
      s('status', '`answered` or `withdrawn` (replaced before an answer).', true),
      s('choice', 'The option chosen, as a label.'),
      j('choice_raw', 'The answer as sent (option number or structured attackers / blocks / targets).'),
      b('accepted', 'The engine accepted the answer (false: refused, the agent was asked again).'),
      b('structured', 'Answered with a structured field (attackers, blocks, cards) instead of an option number.'),
      s('card', 'Card the action was about.'),
      s('refusal_reason', 'The engine\'s reason for a refused answer.'),
      i('latency_ms', 'Time from offer to answer.'),
      t('offered_at', 'When it was offered.'),
    ],
  },
  {
    name: 'sideboarding',
    description: 'Each seat\'s sideboarding before games 2-3 of a match (best of 3 with sideboarding, logs from 2026-10-22 on).',
    grain: 'one row per seat per game 2 or 3',
    key: ['event_id', 'match_key', 'game_in_match', 'seat'],
    bySet: true,
    columns: [
      EVENT_ID,
      s('match_key', 'Match.', true),
      i('game_in_match', 'The game the deck was for (2 or 3).', true),
      SEAT,
      s('by', '`agent` or `forfeit` (inactive: kept its deck).', true),
      b('kept', 'No change from the previous game\'s deck.', true),
      j('cards_in', 'Cards brought in, relative to the deck of the previous game: list of { name, qty } (basic land changes included).'),
      j('cards_out', 'Cards taken out: list of { name, qty }.'),
      i('main_count', 'Main deck size for the game.'),
      i('latency_ms', 'Time from offer to answer.'),
    ],
  },
  {
    name: 'ratings',
    description: 'Leaderboard rows: Bradley-Terry ratings on an Elo scale with 95% intervals and rank ranges, per comparability group, set and provenance. Outcomes only (METHODOLOGY §4).',
    grain: 'one row per board per setup',
    key: ['board_id', 'identity'],
    bySet: true,
    columns: [
      s('board_id', 'Board (`<group>|<set or *>|<source>`).', true),
      s('group_key', 'Comparability group.', true),
      s('group_label', 'Group label (`Set Context · Manual Mana`).'),
      s('set_code', 'Set, or `*` for all sets of the group.', true),
      s('provenance', '`all`, `hosted` or `community` tables.'),
      s('role', '`main` (the main condition) or `side`.'),
      s('identity', 'Setup key `harness/model/effort`.', true),
      s('model_id', 'Model id.'),
      s('model_display', 'Model name.'),
      s('harness_id', 'Harness id.'),
      s('effort', 'Effort level.'),
      d('rating', 'Rating (Elo scale, 1500 = field average); null without LLM-vs-LLM games.'),
      d('ci_low', 'Lower end of the reported 95% interval.'),
      d('ci_high', 'Upper end.'),
      i('rank_range_best', 'Best rank the data supports (rows credibly ahead + 1), within its connected group.'),
      i('rank_range_worst', 'Worst rank the data supports.'),
      i('rank_of', 'Rows in the ranking the range refers to.'),
      b('default_ranking', 'On the default ranking (false: Unknown Effort, kept in the fit).'),
      b('provisional', 'Below a threshold (games, events, opponents, contributors): do not compare yet.'),
      j('provisional_reasons', 'Why it is provisional (list of strings).'),
      i('games', 'Rated games.'),
      i('wins', 'Rated wins.'),
      i('losses', 'Rated losses.'),
      i('events', 'Events with rated games.'),
      i('opponents', 'Distinct opposing setups.'),
      i('contributors', 'Contributors whose seats supplied its games.'),
      d('top_contributor_share', 'Share of its rated games from its top contributor.'),
      b('contributor_floor_met', 'At least 2 contributors and none above half of its games.'),
      d('expected_score', 'Win probability against an average (1500) opponent under the fit.'),
      d('expected_score_low', 'Lower end of its 95% interval.'),
      d('expected_score_high', 'Upper end.'),
    ],
  },
  {
    name: 'boards',
    description: 'Every leaderboard: its scope, the fitted play advantage and how its intervals were made (enough to refit it: docs/OPEN-DATA.md "Reproduce the leaderboard").',
    grain: 'one row per board',
    key: ['board_id'],
    bySet: true,
    columns: [
      s('board_id', 'Board (`<group>|<set or *>|<source>`).', true),
      s('group_key', 'Comparability group (joins games.rating_group).', true),
      s('set_code', 'Set, or `*` for all sets of the group.', true),
      s('provenance', '`all`, `hosted` or `community` tables.'),
      s('role', '`main` (the headline board) or `side`.'),
      i('events', 'Events with rated games on this board.', true),
      i('games', 'Rated games on this board.', true),
      i('identities', 'Setups with a row.', true),
      i('components', 'Connected groups (setups linked through games).'),
      d('play_advantage', 'Fitted play advantage, Elo, from game 1 of each match only (games.on_play_random).'),
      d('play_advantage_low', 'Lower end of its 95% interval.'),
      d('play_advantage_high', 'Upper end.'),
      i('play_games', 'Games behind the play advantage.'),
      d('prior_sd_elo', 'Prior SD of every setup\'s rating (Elo): the fit is a MAP with N(0, sd) priors.'),
      d('play_prior_sd_elo', 'Prior SD of the play advantage (Elo).'),
      d('center', 'Rating of an average setup: each connected group is centered on its unweighted mean.'),
      s('interval', 'How intervals are made: `max(bootstrap, laplace)`, plus contributor and set variance terms (the set term only on boards of two or more sets).'),
      s('bootstrap_unit', 'What the bootstrap resampled: `event` or `contributor` (5+ contributor clusters).'),
      i('clusters', 'Clusters it resampled.'),
      i('replicates', 'Bootstrap replicates.'),
      i('seed', 'Bootstrap seed (base seed + FNV-1a of the board id).'),
      s('forfeit_policy', 'How watchdog forfeits enter (`loss`).'),
    ],
  },
  {
    name: 'rating_pairs',
    description: 'Every pair of setups on a board within one connected group: the rating difference and its 95% interval. Ranks are built from these, not from overlapping intervals.',
    grain: 'one row per board per pair of setups (a < b)',
    key: ['board_id', 'a', 'b'],
    bySet: true,
    columns: [
      s('board_id', 'Board.', true),
      s('set_code', 'The board\'s set, or `*` for all sets.', true),
      s('a', 'Setup key.', true),
      s('b', 'Setup key.', true),
      d('diff', 'Rating of a minus rating of b (Elo).'),
      d('ci_low', 'Lower end of the 95% interval of the difference.'),
      d('ci_high', 'Upper end.'),
      s('ahead', '`a` or `b` when the interval excludes 0 (credibly ahead), else null. A row\'s best rank is 1 + the setups ahead of it; its worst, N − the setups behind it.'),
    ],
  },
  {
    name: 'cards',
    description: 'Card names and the sets they were drafted in, with basic attributes from the engine\'s card data (rules text: see the event logs or Scryfall).',
    grain: 'one row per card per set',
    key: ['set_code', 'card'],
    bySet: true,
    columns: [
      s('set_code', 'Set of the events the card appeared in.', true),
      s('card', 'Card name (front // back for double-faced cards, as the engine names them).', true),
      s('mana_cost', 'Mana cost (`{2}{W}{U/B}`).'),
      s('type_line', 'Type line.'),
      s('colors', 'Colors (WUBRG order).'),
      i('mana_value', 'Mana value (null for lands).'),
      s('rarity', 'Rarity from the booster sheet.'),
      b('is_basic', 'Basic land.', true),
      s('scryfall_url', 'Scryfall search link for the card.'),
    ],
  },
  {
    name: 'human_reference',
    description: 'Human reference from the 17Lands public datasets: per-card win rates and pick positions of human Premier Draft drafters, for the cards in this dataset. Data from 17Lands (17lands.com), CC BY 4.0; derived aggregates, not produced or endorsed by 17Lands.',
    grain: 'one row per card per set with 17Lands data',
    key: ['set_code', 'card'],
    bySet: true,
    thirdParty: true,
    columns: [
      s('set_code', 'Set.', true),
      s('card', 'Card name.', true),
      s('format', '17Lands format (`PremierDraft`).'),
      d('gih_wr', 'Games-in-hand win rate (fraction).'),
      i('gih_games', 'Games behind gih_wr.'),
      d('gp_wr', 'Game-played win rate (main deck).'),
      d('oh_wr', 'Opening-hand win rate.'),
      d('gns_wr', 'Games-not-seen win rate.'),
      d('iwd', 'Improvement when drawn (fraction).'),
      d('alsa', 'Average last seen at (pick number).'),
      d('ata', 'Average taken at (pick number).'),
      s('snapshot_id', 'Snapshot id of the derived file (`SOS.PremierDraft@2026-06-05T22:15:41Z`).'),
      s('data_first', 'First game in the snapshot.'),
      s('data_last', 'Last game in the snapshot.'),
      s('source', 'Source and credit.'),
      s('license', 'License of the source data.'),
    ],
  },
];

export const TABLE = Object.fromEntries(TABLES.map((x) => [x.name, x])) as Record<string, TableDef>;

export type Cell = string | number | boolean | null | unknown[] | Record<string, unknown>;
export type Row = Record<string, Cell>;

/** Problems with rows against a table definition (unknown or missing columns, wrong types, nulls in required columns). */
export function checkRows(def: TableDef, rows: Row[], max = 20): string[] {
  const errs: string[] = [];
  const names = new Set(def.columns.map((c) => c.name));
  for (const [n, r] of rows.entries()) {
    for (const k of Object.keys(r)) if (!names.has(k)) errs.push(`${def.name}[${n}]: unknown column ${k}`);
    for (const c of def.columns) {
      const v = r[c.name];
      if (v === undefined) errs.push(`${def.name}[${n}].${c.name}: missing`);
      else if (v === null) {
        if (c.required) errs.push(`${def.name}[${n}].${c.name}: null in a required column`);
      } else if (!typeOk(c.type, v)) errs.push(`${def.name}[${n}].${c.name}: ${JSON.stringify(v).slice(0, 60)} is not ${c.type}`);
    }
    if (errs.length >= max) break;
  }
  return errs.slice(0, max);
}

function typeOk(type: ColumnType, v: Cell): boolean {
  switch (type) {
    case 'string': return typeof v === 'string';
    case 'int': return typeof v === 'number' && Number.isSafeInteger(v);
    case 'double': return typeof v === 'number' && Number.isFinite(v);
    case 'bool': return typeof v === 'boolean';
    case 'json': return true;
    case 'timestamp': return typeof v === 'number' && Number.isFinite(v) && v > 0;
  }
}
