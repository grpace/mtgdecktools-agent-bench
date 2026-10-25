# Site Data (JSON Export)

`npm run site:data` turns the event logs into a set of JSON files that a client app can lazy-load. The MTG Deck Tools site renders the benchmark at `mtgdecktools.com/agent-bench` from these files. The static HTML report (`npm run site`) and this export share one data layer (`packages/site/src/data.ts`, `metrics.ts`, `replay-data.ts`), so the two never disagree.

```bash
npm run site:data                     # runs/ + sets/ + data/card-data.slim.json → packages/site/dist-data/
npm run site:data -- --runs <dir> --sets <dir> --cards <card-data.slim.json> --out <dir> [--bootstrap 1000]
```

`--bootstrap` sets the bootstrap replicates behind every interval (default 1000; 0 turns intervals off). With 19 events the export takes about 3 s.

The export is written to a temporary directory and swapped in at the end, so a server never serves a half-written tree. Rerun it any time, including while an event is running.

**Schema version: 2.23** (`schema_version: 2`, `schema_minor: 23`). Every file carries `schema_version`, `schema_minor` and `generated_at`. Adding keys does not bump `schema_version`; each additive release bumps `schema_minor`. Renaming or removing keys, or changing what a value means, bumps `schema_version`. Readers must not require `schema_minor` (files before 2.2 don't have it). TypeScript definitions: [`packages/site/src/schema.ts`](../packages/site/src/schema.ts) (the source of truth; this page summarizes it). What the numbers mean: [METHODOLOGY.md](METHODOLOGY.md).

## Changelog

**v2.23 (2026-10-24): visual replays.** Additive.
- Every file gains `schema_minor: 23`.
- **`TimelineEntry.state`** (game files): the board at each decision, read from the view the deciding seat saw: `{ turn, step, active, priority, players: { [seat]: { life, hand, library, poison?, graveyard[], exile[], battlefield: BoardPerm[] } }, stack: { card, controller, kind, text?, targets? }[], hand: { seat, cards[] } }`; `BoardPerm` is `{ id, card, tapped?, pt?, loyalty?, counters?, keywords?, sick?, damage?, token?, attached_to? }` (grouped objects become one entry per object). Absent when the view is withheld (a live event's hidden information: it is read from the same, blanked text) or older than the JSON view (prompts before v4). About 1.3 KB per decision. Render it as the replay board, stepping with the timeline; `hand` is the deciding seat's own hand.

**v2.22 (2026-10-24): test tables.** METHODOLOGY §3.2.
- Every file gains `schema_minor: 22`.
- **(meaning) A table with any scripted or bot seat is a test table**, whatever its format: `table_kind: "test"`, `unrated_reason: "test table (N scripted seats)"`, no comparability group, no rated game, no Swiss finish, and `table_text` names the models and the scripted players without saying anyone won. Model files mark its seats `rated: false`. Every rated table is 8 language-model seats. Pick a game to feature only from a table whose every seat is a language model.

**v2.21 (2026-10-24): cost cross-checks.** METHODOLOGY §5.7.
- Every file gains `schema_minor: 21`.
- **(meaning) A reported cost is checked against the token estimate.** $0 reported with tokens used, or a reported cost more than 35% from the estimate, isn't used: the estimate is (`basis: "estimated"`). A cost from an uploaded usage file is the contributor's own figure, so with token counts the upload is re-priced from them. Costs drop only by being estimated, never silently.
- **`CostInfo.seats_flagged`**: costed seats whose reported cost wasn't used for one of those reasons.

**v2.20 (2026-10-23): an identity is a model at an effort level.** METHODOLOGY §2.2–2.3. Value-meaning changes marked **(meaning)**.
- Every file gains `schema_minor: 20`.
- **(meaning) Identity keys are `<model id>/<effort>`** (`claude-sonnet-5-5/high`; before: `claude-code/claude-sonnet-5-5/high`) everywhere a key appears: `IdentityInfo.key`, `SeatRef.identity`, board rows, pairwise, `version_differences`, activity, highlights, model pages, lobby `identity_key`. Labels are "Claude Sonnet 5.5 · High". Seats of one model and level on different harnesses are one identity, so games between them are mirror games (never rated). Split a key with `key.split('/')`: `[model, effort]`.
- **`IdentityInfo.harnesses`**: `{ id, display, seats }[]`, the harnesses its seats ran on, most seats first. `IdentityInfo.harness`, `harness_id`, `harness_display` are gone (deprecated). `SeatRef.harness_id` / `harness_display` stay: the seat's own harness.
- **(meaning) `ModelFile.effort_ladder`**: at most one ladder per model, across harnesses; `EffortLadder.harness` / `harness_display` and `VersionRung.harness` / `harness_display` are gone. `ModelRating.harness_display` is gone; the summary's `version` is the effort level.
- **`ModelFile.harness_comparison`** is gone. New **`ModelFile.harness_split`**: `{ identity, effort, effort_display, rows: { harness, harness_display, seats, games, wins, win_rate: { value, ci } | null }[], text }[]`, one per effort level whose seats ran on 2+ harnesses: games against other setups by harness. Descriptive, never a rating; show it as a check ("By Harness"), never as a ranking. **(meaning)** `ModelIndexRow.harness_variants` counts the harnesses its settled seats ran on.
- Summary rows on the main board carry `harness_display: null`.

**v2.19 (2026-10-23): launchers are not harnesses.** METHODOLOGY §2.2–2.3.
- Every file gains `schema_minor: 19`.
- **(meaning) A seat started from a launcher is its harness.** An app that starts harness sessions without running the model loop (T3 Code) is a launcher, not a harness. A seat declared `t3-code:claude-code` has `harness: "claude-code"`, `harness_display: "Claude Code"` and the identity `claude-code/<model>/<effort>` (it was `t3-code:claude-code`, "T3 Code (Claude Code)", a row of its own). Games between it and Claude Code started elsewhere are one identity, so unrated. No stored event used a `t3-code:` harness, so no published row changes.
- **`SeatRef.launcher`** (`"t3-code"`) and **`launcher_display`** (`"T3 Code"`) on LLM seats that declared one. Show it in seat details ("Started from T3 Code"), never as a leaderboard column, filter or row. T3 Code adds its own MCP tools and instructions to every session: say so where the launcher is shown.
- **(meaning)** `ModelFile.harness_comparison` and `harness_variants` never list a launcher.

**v2.18 (2026-10-23): set findings only from all-agent tables.** Additive keys, plus value-meaning changes marked **(meaning)**. METHODOLOGY §5.8.
- Every file gains `schema_minor: 18`.
- **(meaning) Set findings come only from all-agent tables**: finished tables whose 8 seats are all language-model agents. `SetFile.archetypes`, `deck_shape`, `commitment_median`, `first_picks`, `cards[]` (`agent_picks`, `agent_avg_pick`, `seen`, `in_decks`, deck records, `delta`), `earlier`, `later`, `totals.agent_picks`, `agent_decks`, `distinct_picked`, `finished_agent_picks`, `finished_agent_decks`, and `IndexFile.sets[].top_archetypes` and `insight` leave out mixed pods (agents with scripted drafters or players). `totals.events`, `llm_events` and `finished_llm_events` still count every table. **`EventSummary.in_set_findings`** says whether a table feeds its set's findings; count decks and pairs from events where it's true (mixed pods stay listed and watchable).
- **(meaning) `insight` counts independent drafts.** `ready` needs `min_decks` decks from `min_events` **different drafts** (re-runs of one seed are one draft). New: **`insight.pods`** (different drafts), **`early_test_events`** (tables behind the findings that are Early Test Data: say "from N early test tables" with any finding while it's above 0), **`excluded_events`** (finished agent tables left out as mixed pods), **`rule: "all_agent_tables"`**. `n_text` reads "n = 8 agent decks from 1 all-agent table (findings need 8 decks from 3 different drafts)".
- **Agents vs human drafters: one definition.** **`SetFile.pick_gaps`**: `{ name, agent_pick, picks, pods, tables, early_test_tables, ata, gap, direction: "earlier" | "later" }[]`, biggest gap first, and **`SetFile.pick_gap_rule`** `{ max_pick: 9, min_picks: 5, min_pods: 3, min_gap: 1.5 }`. Only picks 1–9 of a pack count (late picks are forced in a closed pod), at least 5 of them from 3 different drafts. Home and the set page both use this list ("the biggest gap" is `pick_gaps[0]`); never compute a gap from `cards[].agent_avg_pick` and `ata` again. Say what's compared ("over picks 1–9 of a pack, where agents had a real choice, against 17Lands' average pick"). Before 2.18 there is no list: show no gap. **(meaning)** `earlier` / `later` now list `pick_gaps` names by direction.
- **`SetFile.cards[].agent_pods`**: different drafts in which agents took the card. A threshold on picks needs one on drafts too.
- **`IndexFile.sets[].test_set: true`**: a set with a placeholder release date more than a year ahead (a custom set for testing): hide it from Set Reports by default.
- **(meaning) Model pages' cards.** `ModelCardRow.avg_pick` is the pick within the pack (1–14; it was the overall pick 1–42), `first_picks` counts pick 1 of every pack (it was pack 1 only), new **`early_picks`** counts picks 1–5 of a pack, and `cards.most_picked` is sorted by `early_picks` (a one-model table takes every card, so late picks aren't preference). Show "Pick 3.2 of 14 on average" and the set code next to each card when a model has played several sets.

**v2.17 (2026-10-23): accuracy fixes.** Additive keys, plus value-meaning changes marked **(meaning)**.
- Every file gains `schema_minor: 17`.
- **(meaning) LLM seats come from seat metadata**, never the seat name. A seat of the registry's test harness (`script`) or the scripted `random` model is `llm: false` whatever it is called (hosted seats are all `seat-<hex>`). A table of scripted players is therefore `llm: false`, `provenance: "test"` ("Test Run"), in no group, and counts in no total, set finding, activity item, board, rated-table count or "latest event" (it was counted as eight LLM agents: home totals 72 games and 8,200 decisions instead of 46 and 4,413). Pick the latest event from `llm: true` events.
- **(meaning) `totals.llm_games`, `decisions`, `agent_picks`** count settled events only (finished, stopped, or stalled locally), like the open data; live tables show in `live_events`.
- **Stopped events.** `EventSummary.status` can be **`"stopped"`** (its organizer, an admin or the server stopped it before it finished). Its finished games are rated (`rating_status` "rated" when it has any); it has no winner, no final standings and no Swiss finishes. **`EventSummary.stop`**: `{ by, by_display, reason, open_games, forfeited_games, text }`; show `text` on the event page ("Stopped by its organizer (canceled) before it finished. Its finished games count and are rated; …"). The sentence follows `rating_status`: only a rated table says its finished games are rated (a table with no rated games, or one that isn't rated, such as Early Test Data, says so instead), and a stop that recorded no stopper reads "Stopped before it finished (who stopped it wasn't recorded)." `ActivityItem.stopped: true` on its What's New item. METHODOLOGY §3.2 "Stopped events".
- **Table kinds.** **`EventSummary.table_kind`** (`scripted` | `mirror` | `single_model` | `mixed`) and **`EventSummary.table_text`** (one sentence); **`ActivityItem.table_kind`**. **(meaning)** `ActivityItem.winner_label` is set only at a mixed table; the activity `text` of a mirror table says "Eight identical … seats played each other …: a mirror table, so no game is rated and no setup won it", of a single-model table "Eight Claude Haiku 5.5 seats played each other … A … seat finished first." Never write "won a table of N agents" for a scripted, mirror or single-model table; give scripted tables their own reason ("a software check with no models"). Setup names in activity `text` and `winner_label` leave out what isn't known: no "Unknown Effort" and no "Harness Not Recorded" (the model, then the harness and the effort when known); the row's `effort_display` still says Unknown Effort where a label is shown.
- **(meaning) Play/draw from game 1 only.** `Board.play_advantage` is fitted on game 1 of each match (random, by seed); `Outcomes.on_play` / `on_draw` count game 1 only; `MirrorCheck.on_play` is game 1 only (`basis: "game_1"`), with **`MirrorCheck.on_play_all_games`** for reference (biased toward 50%: never call it clean).
- **Effort Ladder and Harness Comparison verdicts.** **`VersionStep.verdict`** (`higher` | `lower` | `provisional` | `unadjusted` | `open`), **`p_value`**, **`p_holm`** (Holm over the ladder's steps), **`comparisons`**, **`provisional`**. Drive the copy from `verdict`: "rated higher in these games" only for `higher`; never "a clear gain" or "more thinking helped". The ladder `summary` sentences already follow this.
- **Board summaries**: "ranks first" only for a non-provisional top row, and on set or single-provenance boards only when it survives a Holm correction (else "read it as exploratory").
- **`methodology.thresholds.rule`**: the whole provisional rule in one sentence, contributor floor included. Use it wherever the site states the rule (Explainers, FAQ, Leaderboard, the model page's "Not Rated Yet"); never the shorter "30 games, 3 events, 2 opponents".
- **`Board.differences`**: every pair's difference interval (`a`, `b`, `diff`, `ci`, `ahead`) on the board, and **`Board.seed`**. Ranks come from these, not from overlapping bars.
- **Model files.** **`ModelFile.played`** `{ games, mirror_games, events, seats, text }`: distinct games (a game between two of its own seats counts once); use `played.games` for "Games Played", never a sum over `events[].game_w + game_l`. **(meaning)** `ModelFile.cost` is the main condition's cost only (`cost.condition` names it), and **`ModelFile.cost_conditions`** lists cost per condition (format × context policy). **`CostInfo.seats_total`, `seats_covered`, `events_total`, `events_covered`, `coverage_text`** ("Based on 9 of 22 seats, at 2 of 8 tables …"): show it instead of "every table", and show `per_game_usd.ci`.
- **Engine issues.** **`SetFile.engine.split.{llm,all}`**: `card_swaps` (swaps, cards, games where a swapped-in card was cast; not a fault) apart from `rules_errors` (games, `by_kind`, `implicated_single_seat`, `lost_by_implicated`: an upper bound on games where it mattered), and `text`. Lead the set page with `split.llm.text`; don't headline `flagged_games` ("Games Touched by Engine Issues"), which counts swaps.
- **Deck checks.** **`DeckRoles.basis`** (`set_pair` | `generic`), **`bands`** (per check: `lo`, `hi` (null: no upper bound), `label`) and **`source`** ("17Lands SOS UR decks with 6+ wins (2,666 decks), p10–p90"). **(meaning)** a two-color deck in a set with `deck-norms.json` is checked against its pair's 17Lands norms; check keys keep their old names (`creatures_12_plus` …), so show `bands[key].label`, not a label derived from the key. **`SetDeckShape.norms`** `{ set_pair, generic }`.
- **Set findings.** **`IndexFile.sets[].insight`** and **`SetFile.insight`**: `{ ready, decks, events, min_decks: 8, min_events: 3, n_text }`. **(meaning)** `top_archetypes` is empty until `ready`; show `n_text` and no "most drafted" or "won the table" sentence below it. **(meaning)** `SetArchetype.win_rate` is null under 20 games (show the record).
- **Highlights.** **`Highlight.pick.human`**: `{ source: "17Lands", ata, gih_wr, pack_best: { name, gih_wr } | null } | null`; show it next to pick quotes. Auto highlights never feature land drops, passes, single-option decisions or trivial alpha strikes; Last Stand needs a real action at 3 life or less in a game the seat went on to win. The curated `fra-b3fa-last-stand` (Sureshot Sower) is gone.
- Provisional rows keep `rating` and `ci`: show the numeric range on every row, with "Provisional" as a marker next to it, never instead of it.

**v2.16 (2026-10-22): the mirror check in summary.json; the main board is the current prompts only.**
- Every file gains `schema_minor: 16`.
- **`summary.json → mirror_check`** (the same `MirrorCheck` object as `index.json`, or null) and **`summary.json → methodology.mirror_games`**: the Methodology box no longer needs `index.json`.
- **`main_board`** (index.json and summary.json) is the main condition's all-sets board **with the current prompts** (the Director's `prompts/`, matched by fingerprint), and only once that board has a rated game. Before that it is `null` and `summary.json → main` is `null`: show "No Rated Games Yet", never an older prompt group or a side condition in its place. A prompt change (a new comparability group) therefore empties the headline until the first rated game under the new prompts; the earlier group stays as a side board ("· Earlier Prompt"). `GroupInfo.role: "main"` marks the current group as soon as it has an event, even before its first rated game. Value meaning only; no key changed.

**v2.15 (2026-10-22): the Effort Ladder, the Harness Comparison and the mirror check.** Additive.
- Every file gains `schema_minor: 15`.
- **`ModelFile.effort_ladder`**: one entry per harness with two or more rated effort levels of the model on the model page's board (the board `ratings[0]` is on: the main board when the model has rows there). Rungs in effort order, the step from each level to the next with the interval of its rating difference, the cost per game at each level, and the games between the model's own levels. See "Effort Ladder and Harness Comparison (2.15)".
- **`ModelFile.harness_comparison`**: one entry per effort level with two or more harnesses rated on that board (a launcher such as T3 Code is never a harness: 2.19).
- **`ModelIndexRow.effort_levels`** and **`harness_variants`**: how many concrete effort levels and harnesses the model's rated versions have on its page board, so a page knows whether to show the sections without loading the model file.
- **`Board.version_differences`**: for every pair of one model's versions rated in the same connected group, R_a − R_b in Elo, its 95% interval and which side is credibly ahead. The same intervals decide rank ranges.
- **`IndexFile.mirror_check`** and **`methodology.mirror_games`**: games between two seats of the same setup (never rated) as a fairness monitor. See "Mirror Check (2.15)".

**v2.14 (2026-10-22): known-issue cards.** Additive.
- Every file gains `schema_minor: 14`.
- **`EngineFlag.kind: 'known_issue_card'`** (and `engine_flags.counts.known_issue_card`): a card on the known-issues list (`engine/known-issues.json`, suspected or confirmed, or fixed only in a later phase-rs release) was played in the game, and the event's card data had no card override fixing it (docs/CARD-OVERRIDES.md). `detail` is the status and the upstream issue link ("confirmed: https://github.com/phase-rs/phase/issues/10205"); `turn` is when it was first played. It counts toward `flagged` and the impact test like the other kinds, and toward a card's `flagged_games` (not its `rules_issues`). Show it as "Known Card Issue".

**v2.13 (2026-10-22): best of 3 with sideboarding; Early Test Data.** Additive keys, plus group keys and labels without the best-of (below). MTG Deck Tools Agent Benchmark plays best of 3 with sideboarding everywhere; best of 1 is gone. Only best of 3 with sideboarding is rated.
- Every file gains `schema_minor: 13`.
- **Early Test Data.** An LLM event played before that standard (best of 1, or best of 3 without `event_start.sideboarding: true`) stays visible (event page, replays, every export file) but is never rated, never on a board or diagnostic and never counted as rated games. `EventSummary.test_data: true` and `test_data_label: "Early Test Data"` mark it (show the label next to the event, Title Case as given); `rating_status` is `not_rated` with `rating_reason` (and `config.unrated_reason`) `early test data (best of 1)` or `early test data (best of 3 without sideboarding)`. Smoke and dev events keep their own labels (`test_data: false`, "Test Run"). `methodology.early_test_data: { label, summary, reasons }` describes it; `activity[]` event items gain `test_data: true`. Every event before 2026-10-22 evening is Early Test Data, so a fresh export can have no boards at all (`boards: []`, `main_board: null`, `summary.json → main: null`): show an empty state.
- **Groups no longer split on best-of.** `GroupInfo.key` (and `EventSummary.group`, board ids, `main_board`) drop the `bo=` part: `kn=primer;mana=manual;prompt=sha256:3f2a9c01b7de`. `GroupInfo.label` drops "· Best of N": "Set Context · Manual Mana". Sentences (board summaries, model pages) no longer mention a best-of. `methodology.main_condition` keeps `best_of: 3` and gains `sideboarding: true` (neither is tested any more); its label is "Set Context · Manual Mana". `GroupInfo.conditions.best_of` is **deprecated** (always 3; see "Deprecated keys"). Readers holding keys from earlier exports (bookmarks, URLs) can drop a `;bo=<n>` part to get today's key; the Hub's `GET /api/events?group=` accepts both forms.
- **Event format.** `EventSummary.sideboarding` (event_start.sideboarding) and `play_draw` (`"loser-chooses"`, or null); the same two keys on `config`; `Conditions.sideboarding`.
- **Play or draw, per game.** `GameSummary.play_draw: { on_play, chooser, choice, by, note?, latency_ms? }` from the log's `play_draw` record. Game 1: `by: "seed"`, `chooser` and `choice` null (random from the event seed: "On the Play: X (Random)"). Games 2–3: the loser of the previous game chooses (after a drawn game, the previous chooser), `choice` is `play` or `draw` ("Y Chose to Draw"); `by: "forfeit"` means the chooser was inactive and was put on the play. `on_play` agrees with the game's `on_play`. Public, also while the event runs (a still-hidden card named in the chooser's note is blanked until the chooser has no games left).
- **Sideboarding, per game.** `GameSummary.sideboarding: { [seat]: { by, kept, in, out, main_count, note?, latency_ms?, withheld? } }` on games 2–3, from `sideboarded` records. `in` / `out` are `{ name, qty }[]` relative to the deck the seat played in the previous game of the match (each match starts again from the registered deck in `decks[]`); basic land changes appear under the basic's name. Show "Sideboarded: +2 X, −2 Y" (`kept: true`: "Kept Its Deck"); `by: "forfeit"`: the seat was inactive and kept its deck. `GameSummary.deck_sizes: { [seat]: n }` is each seat's main deck size in that game. The game file's `cards` table resolves the names in `in` / `out`.
- **Live redaction.** While an event runs, a seat's sideboarding is private like its decklist: `in`, `out` and `note` are emptied and `withheld: true` until the seat has no games left; `by`, `kept`, `main_count` and `deck_sizes` are public. `Withheld.sideboards` counts the withheld records.
- Hub: `GET /api/events` rows gain `sideboarding`; `GET /api/events/:id` games gain `play_draw`, `sideboarding` and `deck_sizes` (migration 007, which also drops `bo=` from stored group keys and marks stored best-of-1 rows as Early Test Data; run `hub reingest` to re-derive best-of-3 rows without sideboarding). Contributor points: Early Test Data earns nothing (see "Contributors").

**v2.12 (2026-10-22): context policy per seat.** Additive.
- Every file gains `schema_minor: 12`.
- **`SeatRef.context_policy`** (LLM seats): `harness` (one harness conversation for the whole event, the harness's own context handling; every seat before 2.12), `fresh-per-game` or `fresh-per-match` (`bench play --fresh-session`: a fresh harness session when the deck was locked and after every game or match). From `event_start.seats[].context_policy`. A declared condition like effort. Model seats the `bench` CLI launches (`bench new`, `bench setup`, `bench lobby join`) default to `fresh-per-game` (from Oct 22, 2026; `--fresh-session per-match|off` on request); seats seated by hand or joined with `--no-launch` are `harness`. Boards pool across policies for now; report results per policy from this field (METHODOLOGY "Open questions").

**v2.11 (2026-10-22): rating status; Swiss finishes without rated games.** Additive.
- Every file gains `schema_minor: 11`.
- **`EventSummary.rating_status`** (`rated` | `no_rated_games` | `not_rated`), `rating_display` ("Rated", "No Rated Games", "Not Rated"), `rated_games` and `rating_reason`, on LLM events. "Rated" means at least one rated game. A table where every seat was the same setup is pooled but has none: `no_rated_games` with the reason "all games were between identical setups" (show "No rated games (all seats were the same setup)", never "Rated"). `not_rated` repeats `config.unrated_reason`.
- **`swiss_finishes: SwissFinishes[]`** on `events/<id>.json` (finished 8-agent Swiss tables), on `GroupInfo` and on summary.json's `boards[]` lines: per setup, `{ identity, events, seats, rounds, counts: { "3-0", "2-1", "1-2", "0-3" }, trophies }`. A fact about the tables, so it is there whether or not any game was rated (`BoardRow.outcomes.swiss` already was, for rows on a board).
- **`provisional_reasons`** of a row with no rated games says "all games were between identical setups" when every game its seats played was against the same setup (was "no LLM-vs-LLM games").
- **Models from metadata.** `EventSummary.agents[].model` and `LeaderboardRow.model` come from the seat metadata (`model_id`, else `model`), never from the seat name; an old log without metadata names a model only if its seat name is one the registry knows (else "unknown"). Before, "-<n>" was cut from the seat name (`claude-haiku-5-5` became `claude-haiku-5`).

**v2.10 (2026-10-22): US spelling for every key; summary.json carries what Home needs.** `schema_version` stays 2 for this release because every renamed key is still emitted under its old name too; removing the old names is the `schema_version: 3` change. Readers should move to the new names now.
- Every file gains `schema_minor: 10`.
- **Renamed keys** (new name first; the old one is still written next to it, with the same value, until `schema_version: 3`; see "Deprecated keys" below):
  - `colors` (was `colours`): `CardInfo`, `PackCard`, `EventSummary.agents[]`, deck and draft rows, set first picks and archetype rows, everywhere a WUBRG string is given.
  - `open_colors` (was `open_colours`): draft rows (2.3).
- **Text** is US English throughout ("color", "colorless", "labeled", "canceled"): labels, definitions, generated summaries, `methodology.md`.
- **summary.json** rows gain `provisional_reasons`, `games_needed`, `contributor_floor_met`, `influence`, `cost` (`per_game_usd` with its `basis`), `outcomes` (with the newest 10 event finishes) and `live`; `main.pairwise` is the main board's head to head. Home needs nothing from `index.json`. See "summary.json (2.9)".
- **Handles.** `SeatRef.contributor.handle` (and `config.source.submitter`) is filled only for a contributor public now: the Hub's export checks its current setting; other exports never carry one.
- **Harness.** Seats whose log never named a harness resolve it from the logs where they can (the 2026-10-21 Claude Code transcripts); the rest say "Harness Not Recorded" (was "Unknown Harness").
- Hub API: `GET /api/events/:id` returns `seats[].final_colors` and `decks[].colors` (Hub migration 005), with `final_colours` and `colours` alongside for one release.

### Deprecated Keys

| New key (use this) | Deprecated key (same value, removed with `schema_version: 3`) | Where |
|---|---|---|
| `colors` | `colours` | every object that has `colors` (card tables, pack cards, agents, decks, draft and set rows) |
| `open_colors` | `open_colours` | draft summary rows (`events/<id>.json → drafts[]`, draft files) |
| (Hub API) `seats[].final_colors` | `seats[].final_colours` | `GET /api/events/:id` |
| (Hub API) `decks[].colors` | `decks[].colours` | `GET /api/events/:id` |

Exports written before 2.10 carry only the old names: a reader that supports both releases reads `x.colors ?? x.colours`.

Deprecated values (2.13): `GroupInfo.conditions.best_of` and `methodology.main_condition.best_of` are always 3 (only best of 3 with sideboarding is rated) and go with `schema_version: 3`; don't show them. `EventSummary.best_of` and `config.best_of` keep their meaning (what the event was played as): Early Test Data can be best of 1.

**v2.9 (2026-10-22): contributors, difference-based ranks, prompt fingerprints, the main board, provenance labels.** Additive keys only; `schema_version` stays 2. Definitions: METHODOLOGY §2.1, §3, §3.3, §3.4, §4, §5.4, §5.5. Every old key is still present; where a value's computation changed, its use on the site didn't.
- Every file gains `schema_minor: 9`. New file **`summary.json`** (about 30 KB): what Home, Watch and Learn need without the full `index.json` (which carries every board, about 350 KB). See "summary.json (2.9)".
- **Ranks.** `BoardRow.rank_range` is now decided by the interval of each rating difference (A above B only when the 95% interval of A − B excludes 0), **within a connected group**, among rows on the default ranking. Show it as before ("1–3 of 5"), with the new `rank_of` as N. New: `rank_range_all` (every rated row, Unknown Effort included), `rank_range_overlap` (the 2.8 overlap rule, kept for compatibility; don't use it for claims), `default_ranking` (false for Unknown Effort rows: list them, but off the default ranking, behind "Include Runs Without a Recorded Effort"). `Board.connected_groups` lists identities that never met through games: show them as separate groups and never rank across them.
- **Contributors.** `SeatRef.contributor: { key, handle, via }` (opaque key, public handle or null, how it was established). `BoardRow` gains `contributors`, `top_contributor_share`, `contributor_floor_met`, `influence: { contributor, shift, flagged } | null` and `provisional_reasons` may now say "games from fewer than 2 contributors" or "one contributor supplied more than 50% of its games". Show `influence.flagged` as "Depends on One Contributor". `GroupInfo.contributors`, `Board.contributors`, `Board.bootstrap_unit` (`event` | `contributor`) and `Board.clusters`.
- **Intervals.** `ci` is wider for rows carried by few contributors (a 30 Elo contributor component) and, on boards of several sets, for rows played in few sets (a 30 Elo set component, 2026-10-23), and comes from an event-cluster bootstrap (`methodology.rating.bootstrap: "clusters"`; was `"events>games"`). Same key, same display.
- **Prompt fingerprints.** Groups key on a content hash of the prompt files: `GroupInfo.key` and `EventSummary.group` look like `kn=primer;mana=manual;bo=3;prompt=sha256:3f2a9c01b7de` (older logs keep `prompt=v2`). `Conditions` gains `prompt_sha256` and `prompt_key`; `GroupInfo.conditions` gains them too. Never show either: labels stay version-free, and older groups under the same label say "· Earlier Prompt" (with the date of their last event when there are several).
- **Main board.** `GroupInfo.role` and `Board.role`: `main` for Set Context · Manual Mana · Best of 3 with the current prompts, `side` for every other group. `main_board` is the main condition's all-sets board (before any event runs under it: the group with the most games). `methodology.main_condition` describes it.
- **Model pages** stay within one group: `ModelFile.group` / `group_label` say which (the main board's group when the model has rated games there, else its most-played group). `summary`, `outcomes` and `opponents` cover that group only; `ModelIndexRow.rated_games` counts it, `rated_games_all_groups` counts every group, `ModelIndexRow.group` names it. `ModelRating` gains `role` and `default_ranking`; its `of` is now `rank_of`.
- **Provenance labels.** `EventSummary.provenance` (`hosted` | `community` | `test`) and `provenance_display` ("Hosted", "Community", "Test Run"); `Board.provenance` (`all` | `hosted` | `community`) and `provenance_display`; `GroupInfo.provenance`; `methodology.source_labels`. The `source` codes stay (`verified` means a hosted table, never a verified result): don't show them.
- **Model check labels.** `SeatModelVerification.label` ("Checked Against Logs", "Self-Reported", "Mismatch", "Unlisted") and `logs_read_by` (`contributor-cli` | `export` | null: who read the harness logs); `IdentityInfo.model_verification_label` (also "Mixed"). The status codes stay; show the labels.
- **Test tables.** `EventSummary.test_table` (fewer than 8 agents, or scripted or bot drafters at the table), `llm_agents`, `scripted_seats`.
- **Records with context.** `BoardRow.expected_score: { value, ci }`: win probability against an average (1500) opponent under the fit, the comparable number. Raw win rates (`outcomes`) are records: never sort or rank rows by them.
- **Diagnostics are never ranked.** `DiagnosticValue.rank` and `DiagnosticDef.rank_label` stay and are always `null`.
- **Mana.** `ManaStage` gains `auto_paid` (payments the engine made by itself) and `topped_up` (planned payments the engine completed); `manual` and `manual_share` now count only payments the agent planned and that paid in full. Game files' `seat_stats` gain `auto_paid`.
- **Forfeits.** `methodology.forfeits: { policy, options, summary }`: how a game the watchdog conceded enters the rating (`loss` from the decision of Oct 22, 2026; exports built before it say `exclude-game`, so read `policy` rather than assume it).
- **Counts.** `totals.llm_events_finished`; `sets[].llm_events_finished` and `sets[].top_archetypes` (`{ pair, decks, games, wins, losses }`, top 3); set files' `totals.finished_llm_events`, `finished_agent_picks`, `finished_agent_decks` (the same finished events as `archetypes` and `deck_shape`).
- **Highlights.** `events/<id>.json → highlights` (up to 3) and `sets/<SET>.json → highlights` (up to 6): curated highlights first, then automatic candidates from finished games ("Lethal Setup", "First Pick", "Last Stand").
- **Cards.** `CardInfo.image_uri`: Scryfall's named-image URL (it redirects to `cards.scryfall.io`), loaded by the reader's browser.
- `methodology.rating` gains `ranking: "difference-intervals"`, `contributor_cluster_min`, `contributor_cap` (null: no caps), `pooling`; `methodology.thresholds` gains `min_contributors` and `max_contributor_share`.
- **Experimental, off by default** (`MTGDT_RATING_POOLING=1` on the export): `BoardRow.pooled: { rating, ci }` and `Board.pooled: { experimental, models, harnesses, efforts }` from the partially pooled fit (METHODOLOGY §4). Don't show them unless `methodology.rating.pooling` is true.
- Hosted exports should set `MTGDT_CONTRIBUTOR_SALT` (the salt of contributor keys); without it a fixed default is used.

**v2.8 (2026-10-22): outcomes, model files, highlights, activity, set summaries.** Additive keys only; `schema_version` stays 2. Definitions: METHODOLOGY §4.1 (outcomes) and §5 (diagnostics). Field reference and examples: "Outcomes and model pages (2.8)" below.
- Every file gains `schema_minor: 8`.
- **No "stage scores".** The rating comes from game results only. `BoardRow.stages` keeps its key for compatibility, but its type is now `Diagnostics` (`StageScores` remains as a deprecated alias): descriptive behavior that never feeds the rating. Don't label it as scores or as what the rating is made of.
- `BoardRow` gains `rank_range` (from interval overlap; use it for the rank column), `games_needed`, `outcomes` (games, matches with a range, on the play / on the draw, event finishes, Swiss finishes with the 3–0 rate), `diagnostics` (headline diagnostics with `field_median` and rank-of-N) and `cost` (`per_game_usd` as an `Est`, `basis: reported | estimated | mixed`).
- `Board` gains `summary` (a generated sentence), `pairwise` (head to head) and `field` (median of each headline diagnostic).
- `index.json` gains `models[]`, `activity[]`, `highlights[]` (featured), `main_board` and `methodology.diagnostics`, `methodology.outcomes`, `methodology.cost`. Contributor data stays in the Hub-only files ("Contributors" below); its profiles reuse the `Highlight` type defined here.
- `GroupInfo.label` no longer carries the prompt version: "Set Context · Manual Mana · Best of 3". Groups that differ only by prompt get "· Earlier Prompt" on all but the newest. The group key still has it.
- New files: `models/<model_id>.json` (one per registry-listed model with a seat) and `highlights.json`.
- `sets/<SET>.json` gains `archetypes[]`, `deck_shape`, `commitment_median` and `first_picks[]` (agents only, no human data).
- New inputs: `registry/prices.json` (official list prices, for cost estimates) and `highlights/curated.json` (hand-curated highlights).

**v2.7 (2026-10-22): 17Lands snapshot ids.** Additive keys only; `schema_version` stays 2. Policy: docs/UPGRADING.md, "Reproducibility".
- Every file gains `schema_minor: 7`.
- `events/<id>.json → config.ratings_snapshot`: the 17Lands data the event ran with (fallback picks for inactive seats, reference builds), from `event_start.ratings_snapshot`: `{ id, sha256, date_range?, from? }`. `id` is the `deps/manifest.json` snapshot id (`FRA.PremierDraft@2026-10-19T16:20:26Z`), `sha256` hashes the `17lands.json` bytes. Logs from before 2026-10-22, and sets without 17Lands data, have none.
- `events/<id>.json → config.inputs.ratings_snapshot`: `{ id, date_range: { first, last } | null }`, the snapshot the human-reference numbers in this export were computed from. That is always the latest data, so it can differ from `config.ratings_snapshot`; show its date range next to "Compared with human drafters".

**v2.5 (2026-10-22): event format, table kind, dev events.** Additive keys only; `schema_version` stays 2. Definitions: METHODOLOGY §3 (8 agent seats, Swiss pairings), docs/LOBBY.md.
- `EventSummary.format`: `{ pairing: "swiss" | "round-robin", rounds }`. Events seat 8 agents and play a 3-round Swiss by default; Private Tables may choose a round robin. Logs from before Swiss existed are reported as round robins (which they were).
- `EventSummary.matches_expected` follows the format: Swiss `rounds × floor(agents / 2)`, round robin every pair once.
- `EventSummary.table`: `"lobby"` (a matchmaking lobby table), `"private"` (one contributor's 8 seats) or `null` (admin and self-hosted events).
- `EventSummary.dev_bot_fill: true` marks a dev engine test where bot drafters filled empty seats (`--dev-bot-fill`). Such events are labeled `smoke` and never rated (`unrated_reason: "dev event (bot drafters at the table)"`); the Hub never accepts them.

**v2.6 (2026-10-22): concrete effort levels.** Additive keys only; `schema_version` stays 2. Definitions: METHODOLOGY §2.2. (v2.5 is the event format and table kind.)
- Every file gains `schema_minor: 6`.
- **Identity keys never contain `default`.** The effort part is a concrete level, or `unknown` ("Unknown Effort", its own row). A seat that ran at its harness's default gets the documented default for its harness version. Earlier keys like `claude-sonnet-5-5/default` become `…/medium` (when the logs carry the Claude Code version) or `…/unknown`.
- `SeatRef` (LLM seats) gains `effort_source` (`declared-explicit` | `detected` | `harness-default` | `self-reported` | `unknown`) and `effort_resolution`: `{ source, source_display, status, reason, declared?, detected?, harness_version?, default_source?, fast? }`. `fast: true` means the logs showed fast serving mode, which is recorded but not part of the identity key. Wrapper harnesses appear as `t3-code:claude-code`, displayed "T3 Code (Claude Code)". `source_display` values are "Set at Launch", "Detected from Logs", "Harness Default", "Self-Reported" and "Unknown". `status` is `verified` (the harness logs show the level), `self-reported` or `mismatch`.
- `IdentityInfo` gains `effort_sources` (seats per source) and `effort_verification_counts`.

**v2.4 (2026-10-22): canonical model identity from the registry; model verification.** Additive keys only; `schema_version` stays 2. Definitions: METHODOLOGY §2 and §2.1, `registry/README.md`.
- Every file gains `schema_minor: 4`.
- **Identity keys are canonical:** `<harness id>/<model id>/<effort>` from the model registry, resolved at export time from the raw strings in the logs. Spellings of one model ("sonnet", "Claude Sonnet 5.5", "anthropic/claude-sonnet-5-5") are one key. Keys of earlier exports may change: `claude-code/opus/default` became `claude-opus-5-5/default`. Names the registry doesn't know get `unlisted:<slug>` as their model (or effort).
- `IdentityInfo` gains `model_id`, `model_display` ("Claude Sonnet 5.5"), `provider` / `provider_display`, `harness_id`, `harness_display` ("Claude Code"), `effort_display` ("High", "Extra High", "Default Effort"), `model_verification` (`verified` | `self-reported` | `mismatch` | `unlisted` | `mixed`), `verification_counts`, `rated` (false for Unlisted identities), `snapshots` and `unknown_snapshot`. `label` is now "Claude Sonnet 5.5 · High". `model_verified` now means every seat is a Verified Model.
- `SeatRef` (LLM seats) gains the same display fields, `model_declared` (as typed, when it differs), `model_verification` (`SeatModelVerification`: `{ status, reason, reported?, reported_raw?, snapshot?, snapshot_known? }`) and `rated`. Its `harness`, `model_id` and `effort` are now the canonical values; before 2.4, `model_id` was the transcript's id, which is the same string for every listed model.
- `index.json → methodology.registry: { version, sha256, doc }`: the registry (content hash) that resolved the identities.
- Boards leave out Mismatch and Unlisted seats: their games are rated for nobody. They are still listed on their events, with the reason.

**v2.3 (2026-10-22): core draft metrics for every set; human data as an optional reference.** Additive keys only; `schema_version` stays 2. Definitions: METHODOLOGY §5.1.
- Every file gains `schema_minor: 3`.
- `StageScores.draft.core` (`CoreDraftStage`): metrics from card data and the logs only, present for every set: `conversion`, `p1_conversion`, `commitment_pick`, `flow_alignment`, `on_color_rate`, `pair_changes`, `role_coverage` (each an `Est`), `decks`, `role_fails` (decks failing each role check). `conversion`, `p1_conversion` and `commitment_pick` repeat the `hindsight` values so a reader can take everything from `core`.
- `DraftSummaryRow` gains `flow` (share of the above-filler card quality passed per color in pack 1, picks 2–9), `flow_colors`, `flow_alignment`, `on_color_rate`, `pair_changes`, `role_coverage`.
- `DeckDetail.roles` (`DeckRoles`): `lands`, `nonland`, `creatures`, `early`, `top_end`, `avg_mv`, `interaction`, `removal`, `evasive`, `checks` (`lands_16_18`, `creatures_12_plus`, `early_6_plus`, `top_end_6_max`, `avg_mv_2_5_3_5`, `interaction_2_plus`), `passed`, `total`.
- **Human-reference layer.** These keys keep their meaning but are now presented as an optional comparison with human drafters, shown only where 17Lands data exists and never as a headline: `draft.baseline`, `draft.archetype`, `draft.expert`, `draft.hindsight.signal_alignment` (and `open_colors`), `build.gih_gap_pp`, `build.archetype`, `DeckDetail.build_quality`, `DeckDetail.avg_gih_wr`, the `gih_wr` / `ata` card fields, the GIH fields of draft files, the 17Lands columns of set files, and the v1 `leaderboard` draft columns. `index.json → methodology.human_reference` gives the label and attribution to show with them: `{ label: "Compared with human drafters", source: "17Lands public datasets", url, license: "CC BY 4.0", note, sets }`.
- `index.json → methodology.card_quality: { version, doc, summary }`: the heuristic behind the core metrics.
- `index.json → sets[]` gains `featured` (listed in `sets/rotation.json`) and `has_set_context`.
- `events/<id>.json → config` gains `bot_policy` (`win_rates` | `card_quality` | `rarity_prior`: how fallback picks and reference decks were valued) and `inputs.ratings`; `config.knowledge` gains `label` (`No Set Context` | `Set Context` | `Set Context + Human Stats`) and, when a set had no set context and the event ran at `none`, `requested`.

**v2.2 (2026-10-22): archetype build quality, deck norms, calibrated thresholds.** Additive keys only; `schema_version` stays 2. Definitions: METHODOLOGY §5.2 and §6.
- Every file gains `schema_minor: 2`.
- `DeckDetail.build_quality` (`DeckBuildQuality`):
  - quality of the deck in its own color pair, from 17Lands archetype ratings, and its calibrated `expected_wr`;
  - the `reference` build of the same pool and the `best` deck the pool could make under the same scoring;
  - `build_delta_pp` / `build_delta_wr_pp` (build − reference) and `vs_best_pp` / `vs_best_wr_pp` (build − best);
  - the deck `shape` (lands, creatures, two-drops, five-plus, average mana value, color sources);
  - `checked` and `flags` (structural checks outside the p10–p90 band of winning human decks in the pair), `unrated`, `uncastable`, `splash`;
  - `validation`: the set's held-out label (`validated` | `weak` | `unvalidated`).
- `StageScores.build.archetype` (`BuildArchetypeStage`, agent-built decks only, `null` without archetype ratings): `decks`, `quality`, `expected_wr`, `build_delta_pp`, `build_delta_wr_pp`, `vs_best_pp`, `structural_pass_rate` (`Est`), `structural_flags` (decks per failed check), `validation` (`validated` | `weak` | `mixed` | `unvalidated`).
- `index.json → methodology` gains:
  - `calibration: { doc, date, summary }`: where the thresholds come from (`analysis/results/calibration.md`);
  - `build_quality: { [SET]: { verdict, archetype_weight, auc_model, auc_overall_gih, deck_pearson, slope_logit_per_pp } }`.
- `index.json → sets[]` gains `has_deck_norms`; `events/<id>.json → config.inputs` gains `deck_norms`.
- New input file `sets/<SET>/deck-norms.json` (METHODOLOGY §12.4).
- The bot-duel `build.strength` / `build.build_delta` keys are unchanged (experimental, not part of the methodology).

**v2.1 (2026-10-22): engine-issue flags, live redaction.** Additive keys only; `schema_version` stays 2.
- `GameSummary.engine_flags`: `{ flagged, counts, items: EngineFlag[], plays_logged }` (METHODOLOGY §5.6). `EngineFlag = { kind: 'swapped_card_cast' | 'refused_action' | 'unimplemented_effect' | 'rules_issue' | 'known_issue_card', seat, card, turn, detail? }` (`known_issue_card` from 2.14). `plays_logged: false` for logs from before casts were recorded (only refusals and reports can be flagged there).
- `sets/<SET>.json` gains `engine: { games, flagged_games, cards: EngineCardRow[], impact: { llm: EngineImpact, all: EngineImpact } }`: per-card counts (`swapped_in`, `played_games`, `flagged_games`, `swapped_cast`, `refused`, `unimplemented`, `rules_issues`, up to three `reports`) and the flagged-vs-unflagged impact test (win-rate swing of the implicated seat, rejected answers per 100 decisions, game length; `Est` values with bootstrap intervals; `by_kind` swings).
- `events/<id>.json` gains `rules_issues` (reports made outside games) when there are any.
- **Events still in progress are exported under the spectator fairness policy** ([SPECTATING.md](SPECTATING.md)): unreleased picks and their packs are left out, decks of seats still playing are left out, the seed is omitted, and in game files the agent's view is blanked (`TimelineEntry.withheld: true`, `since`/`board` empty, no `options`) and unreleased choices and notes are withheld (`answer.withheld: true`, `choice` empty) or have hidden card names blanked (`[hidden card]`; a choice that would name one reads "A choice about hidden cards"). An agent seat with games left also hides who plays it: its `SeatRef` keeps only `name`, `kind`, `position`, `llm` and `model` (the seat name). `EventFile.withheld` and `GameFile.withheld` (`{ policy, picks, decks, decisions, views }`) say what was held back. Finished and aborted events are exported in full, as before.

**v2 (2026-10-21): ratings, diagnostics (then called stage scores), provenance.** Every v1 key is still present with the same meaning, so a v1 reader that ignores unknown keys keeps working once it accepts `schema_version: 2`.
- `index.json` gains:
  - `methodology`: rating settings, thresholds, the methodology doc hash, and unrated events with reasons;
  - `identities`: seat identities (harness + model + effort);
  - `groups`: comparability groups;
  - `boards`: one Bradley–Terry rating table per group × set (or all sets) × source label, each row with diagnostics and 95% intervals.
- `EventSummary` gains `source` (`verified` | `community` | `smoke`), `group` (comparability group key, or null when unrated) and `conditions`.
- `events/<id>.json` `config` gains:
  - `source` (full provenance: submitter, exclusion);
  - `conditions`, `group` and `unrated_reason`;
  - `inputs`, saying which optional inputs were found (deck strength, expert draft eval, archetype ratings).
- `SeatRef` gains `identity` (LLM seats) and `effort`.
- `DraftSummaryRow` gains context-aware and hindsight fields: `conversion`, `p1_conversion`, `commitment_pick`, `signal_alignment`, `open_colors`, `arch_pair`, `arch_regret_pp`, `arch_current_regret_pp`, `expert_*`, `deck_strength`, `reference_strength`.
- `PickDetail` (draft files) gains `arch` (value within the final color pair) and `expert` (expert pick model), when those inputs exist.
- `sets[]` in `index.json` gains `has_archetypes`.
- New file `methodology.md`: a copy of docs/METHODOLOGY.md, so the definitions travel with the numbers.
- The v1 `leaderboard` (one row per seat-name model, raw records) is kept for compatibility. It is **not** the rating; new UIs should use `boards`.

**v1 (2026-10-21):** first release.

## Files

| Path | Size (typical) | Load when |
|---|---|---|
| `index.json` | 300+ KB | everything: every board with every row, events, sets, identities, methodology |
| `summary.json` | about 36 KB | 2.9: Home, Watch and Learn (main board rows with outcomes and head to head, one line per group, models, activity, highlights, sets, latest events) |
| `events/<id>.json` | 20–60 KB | event page |
| `events/<id>/draft-<seat>.json` | ~80 KB | draft viewer (every seat with picks, bots included) |
| `events/<id>/game-<n>.json` | 100–400 KB | replay (n is 1-based, in game start order) |
| (Director) `GET /api/events/<id>/live` | streamed | Watch page for running events: SSE or JSON polling, see [SPECTATING.md](SPECTATING.md) |
| `sets/<SET>.json` | ~100 KB | set page (agent picks and decks; human reference columns where 17Lands data exists) |
| `models/<model_id>.json` | 20–60 KB | model page (2.8): ratings by version, outcomes, head to head, diagnostics, cards, events, notes |
| `highlights.json` | a few KB | every resolved highlight (2.8); the featured ones are also in `index.json` |
| `methodology.md` | ~20 KB | methodology page (docs/METHODOLOGY.md, verbatim) |
| `contributors.json`, `contributors/<handle>.json` | a few KB each | Contributors leaderboard and profiles (Hub only; see [Contributors](#contributors-hub-only)) |
| `open/latest.json`, `open/DATASET.md`, `open/snapshots/…` | | The open dataset for download (Hub only; see [Open dataset](#open-dataset-hub-only)) |

Seat names and event ids are path-safe (`[a-z0-9-]`). Set codes are upper case (`FRA`, `TLA`). Everything compresses well (serve with gzip or brotli).

## Conventions

- Timestamps are Unix epoch **milliseconds**. `generated_at` is ISO 8601.
- Rates and 17Lands win rates are **fractions** (0.553). Regret is in **percentage points** (`*_pp`). `iwd` is a fraction too.
- Colors are WUBRG-ordered strings (`"WU"`); `""` is colorless or unknown. Key names use US spelling (`colors`); the British names (`colours`, `open_colours`) are still written next to them until `schema_version: 3` (see "Deprecated keys").
- `null` means "can't be computed" (no ratings for the set, transcript still running, …). Optional keys are left out when older logs don't carry them (for example `knowledge_level`, `mana`, `rarity`).
- `status` of an event: `complete` (has `event_end` or `summary.json`), `in-progress`, or `stalled` (no new log line for 30 minutes and no `event_end`). In-progress events have standings computed from the games finished so far (`standings_final: false`).
- Card names are the keys everywhere. A `cards` table (`CardTable`) in each file resolves the names that file mentions:

```ts
interface CardInfo {
  cost: string | null;      // "{2}{W}{U/B}"
  type_line: string | null;
  colors: string;
  mv: number | null;        // null for lands
  pt?: string; loyalty?: string; oracle?: string;
  rarity?: string;          // from the booster sheet (newer logs)
  image_uri?: string;       // 2.9: Scryfall image URL (redirects to cards.scryfall.io)
  gih_wr: number | null;    // 17Lands GIH WR
  ata: number | null;       // 17Lands average taken at
}
```

## `index.json`

```ts
{
  schema_version: 2, schema_minor: 14, generated_at, generator: "@mtgdt/site",
  totals: { llm_events, llm_events_finished, live_events, llm_games, decisions, agent_picks },   // llm_events_finished: 2.9
  leaderboard: LeaderboardRow[],   // v1 raw scoreboard, one row per seat-name model (kept for compatibility)
  events: EventSummary[],          // newest first; smoke tests included with llm: false
  sets: { code, name, release_date?, events, llm_events, has_ratings, has_archetypes?, has_deck_norms?, featured?, has_set_context?,
          llm_events_finished?, top_archetypes?: { pair, decks, games, wins, losses }[] }[],   // 2.9
  legacy_runs: { id, started_at, log_lines, decisions }[],  // pre-event single-game spikes, not rendered
  // v2
  methodology: MethodologyInfo,
  identities: IdentityInfo[],
  groups: GroupInfo[],
  boards: Board[],
  // 2.8
  models: ModelIndexRow[],         // one per registry-listed model with a seat, most rated games first
  activity: ActivityItem[],        // live tables first, then newest first (up to 40)
  highlights: Highlight[],         // featured, hand-curated highlights (all of them: highlights.json)
  main_board: string | null        // the default leaderboard: the main condition's all-sets board with the current prompts, once it has a rated game (2.16); else null
}

MethodologyInfo {
  doc: "methodology.md" | null, doc_sha256,
  rating: { model: "bradley-terry", scale: "elo", center: 1500, prior_sd_elo, play_prior_sd_elo, replicates, ci: 0.95,
            bootstrap: "clusters", interval: "max(bootstrap, laplace)",          // 2.9; before: "events>games"
            ranking: "difference-intervals", contributor_cluster_min, contributor_cap, pooling },   // 2.9
  thresholds: { min_games, min_events, min_opponents, min_contributors, max_contributor_share },   // below any (or above the share): provisional
  forfeits: { policy: "exclude-game" | "loss" | "void-seat-event", options[], summary },   // 2.9, METHODOLOGY §5.5
  main_condition: { knowledge: "primer", mana: "manual", best_of: 3, sideboarding: true, prompts: "current", label },   // 2.9; label "Set Context · Manual Mana" (2.13: no best-of; best_of deprecated, sideboarding added)
  early_test_data: { label: "Early Test Data", summary, reasons[] },                                // 2.13
  source_labels: { verified: "Hosted", community: "Community", smoke: "Test Run", … },              // 2.9
  unrated_events: { id, reason }[],                          // LLM events not pooled anywhere, and why
  calibration: { doc, date, summary },                       // 2.2: threshold calibration study
  human_reference: { label, source, url, license, note, sets[] },   // 2.3: how to label 17Lands-derived numbers
  card_quality: { version, doc, summary },                   // 2.3: heuristic behind the core draft metrics
  registry: { version, sha256, doc },                        // 2.4: the model registry that resolved the identities
  build_quality: { [SET]: { verdict, archetype_weight, auc_model, auc_overall_gih, deck_pearson, slope_logit_per_pp } },  // 2.2
  diagnostics: DiagnosticDef[],                              // 2.8: the headline diagnostics (keys of BoardRow.diagnostics)
  outcomes: { interval: "max(bootstrap, wilson)", ci: 0.95, trophy },   // 2.8
  cost: { prices: "registry/prices.json", checked, summary }            // 2.8: how costs are reported or estimated
}

IdentityInfo { key, model, model_aliases[], model_verified, effort, label,   // key "claude-sonnet-5-5/high" (2.20: model/effort)
  // 2.4: registry display names and verification
  model_id, model_display, provider, provider_display, effort_display,
  harnesses,                                 // 2.20: [{ id, display, seats }], the harnesses its seats ran on
  model_verification, model_verification_label, verification_counts, rated, snapshots?, unknown_snapshot?,   // model_verification_label: 2.9
  effort_sources?, effort_verification_counts? }   // 2.6

GroupInfo {
  key,            // "kn=primer;mana=manual;prompt=sha256:3f2a9c01b7de" (2.13: no bo= part; 2.9–2.12: "kn=…;mana=…;bo=3;prompt=…"; older logs: "prompt=v2")
  label,          // "Set Context · Manual Mana" (2.13: no "· Best of N"; no prompt version; older prompts: "· Earlier Prompt")
  conditions: { knowledge, mana, best_of, prompt_version, prompt_sha256, prompt_key },   // prompt_sha256, prompt_key: 2.9 (never shown); best_of: deprecated 2.13, always 3
  events, sets[], sources: { verified?, community?, smoke? }, engines[], identities,
  provenance: { hosted?, community?, test? }, contributors, role: "main" | "side",  // 2.9
  swiss_finishes: SwissFinishes[]   // 2.11: per setup over the group's finished 8-agent Swiss tables, rated games or not
}

SwissFinishes { identity, events, seats, rounds, counts: { "3-0", "2-1", "1-2", "0-3" }, trophies }   // 2.11

Board {
  id,             // "<group>|<SET or *>|<all|verified|community>"
  group, set: string | null, source: "all" | "verified" | "community",
  events, games, identities, components,
  play_advantage: { elo, ci, games } | null,
  deck_adjusted: boolean,   // every game had deck strength for both decks: rows carry a pilot rating
  replicates,
  rows: BoardRow[],         // by rating; identities without LLM-vs-LLM games last (rating null)
  summary,                  // 2.8: generated sentence ("As of Oct 22, 2026, …")
  pairwise: PairRecord[],   // 2.8: head to head
  field: { [diagnostic]: { median, n } },  // 2.8: field medians, context only
  // 2.9
  role: "main" | "side",
  provenance: "all" | "hosted" | "community", provenance_display,   // "All Tables" | "Hosted" | "Community"
  bootstrap_unit: "event" | "contributor" | "two-stage", clusters, contributors,   // two-stage: calibration runs only
  connected_groups: { component, identities[] }[],   // never rank across groups
  pooled?: { experimental: true, models: { model, display, rating, se }[], harnesses: { harness, offset, se }[], efforts: { model, effort, offset, se }[] }   // MTGDT_RATING_POOLING=1 only
}

BoardRow {
  identity, rating, ci: [lo, hi], ci_bootstrap, se, rank, rank_ci: [best, worst],
  provisional, provisional_reasons[], component,
  games, wins, losses, events, opponents,
  pilot: { rating, ci } | null,
  seats: { event_id, seat }[],
  stages: Diagnostics,      // descriptive only, never part of the rating (key name kept for compatibility)
  // 2.8
  rank_range: [best, worst] | null,   // show this as the rank ("1–5 of rank_of"); 2.9: from difference intervals, within its connected group, default ranking only
  games_needed,                       // games still needed for the 30-game threshold
  outcomes: Outcomes,
  diagnostics: { [key]: DiagnosticValue },
  cost: CostInfo,
  // 2.9
  rank_of, rank_range_all, rank_range_overlap, default_ranking,
  contributors, top_contributor_share, contributor_floor_met,
  influence: { contributor, shift, flagged } | null,   // leave-one-contributor-out; flagged → "Depends on One Contributor"
  expected_score: { value, ci } | null,                // win probability against an average (1500) opponent
  pooled?: { rating, ci } | null                       // MTGDT_RATING_POOLING=1 only
}

Est { value, ci: [lo, hi] | null, n, events }   // n = items (picks, decisions, games…); events = clusters

Diagnostics {                // was StageScores; descriptive behavior, METHODOLOGY §5
  draft: {
    seats, picks,
    baseline: { rated_picks, top_pick_rate: Est, regret_pp: Est, lane_regret_pp: Est },     // human reference: naive, raw GIH WR
    archetype: { picks, regret_pp: Est, current_regret_pp: Est } | null,                   // needs 17lands-archetypes.json
    expert: { picks, mean_log_p: Est, top1: Est, top3: Est, ev_regret_pp: Est,
              by_pack: { pack, picks, top1, mean_log_p, ev_regret_pp }[] } | null,          // needs draft-eval.json
    hindsight: { conversion: Est, p1_conversion: Est, commitment_pick: Est, signal_alignment: Est },   // signal_alignment: human reference
    core: { conversion: Est, p1_conversion: Est, commitment_pick: Est, flow_alignment: Est, on_color_rate: Est,  // 2.3: every set
            pair_changes: Est, role_coverage: Est, decks, role_fails: { [check]: n } }
  },
  build: { decks, agent_built, auto_builds, legal_rate, sanity_rate: Est, failed_checks: { [check]: n }, avg_lands,
           gih_gap_pp: Est, strength: Est, build_delta: Est,                                // strength needs strength.json (experimental)
           archetype: {                                                                     // 2.2, METHODOLOGY §5.2; null without archetype ratings
             decks, quality: Est, expected_wr: Est, build_delta_pp: Est, build_delta_wr_pp: Est, vs_best_pp: Est,
             structural_pass_rate: Est, structural_flags: { [check]: n }, validation } | null },
  play: { games, wins, losses, win_rate: Est, match_w, match_l, mulligans_per_game },
  mana: { games_with_data, manual, auto_tapper, auto_paid, topped_up, manual_share: Est, failures_per_100 },   // auto_paid, topped_up: 2.9 (never the agent's own tapping)
  reliability: { decisions, rejected_per_100: Est, withdrawn_per_100, abandoned_games, forfeits: number | null }, // forfeits: null before the watchdog (2026-10-22)
  efficiency: { median_latency_ms, median_pick_latency_ms, cost_usd, cost_seats, cost_per_game_usd, output_tokens_per_decision }
}

LeaderboardRow {
  model,                     // from the seat metadata (model_id, else model), never the seat name; "unknown" for an old log with neither, unless its seat name is a registry model
  model_ids[], harnesses[],  // exact model ids from transcripts; harness ids ("claude-code")
  events, in_progress,
  match_w, match_l, game_w, game_l, game_win_rate,
  top_pick_rate, rated_picks, avg_regret_pp,          // draft vs 17Lands, over rated non-forced picks
  decisions, median_latency_ms, median_pick_latency_ms, rejected_per_100,
  cost_usd, cost_seats, cost_per_game_usd, output_tokens,   // harness-reported API-equivalent cost
  seats: { event_id, seat }[]
}

EventSummary {
  id, set: { code, name, release_date? }, started_at, last_activity_at,
  status, stage: "draft" | "build" | "games" | "done", llm, best_of, seed?,
  knowledge_level?: "none" | "primer" | "primer+stats", mana?: "manual" | "auto",
  agents: { name, model, llm, colors }[], bot_seats,
  winner: string | null,    // null while running, and on a tie
  games_played, games_live, matches_done, matches_expected,
  format: { pairing: "swiss" | "round-robin", rounds },   // v2.5
  table: "lobby" | "private" | null, dev_bot_fill?: true,  // v2.5
  source: "verified" | "community" | "smoke",   // v2 (historical codes: don't show them)
  provenance: "hosted" | "community" | "test", provenance_display,   // 2.9: "Hosted" | "Community" | "Test Run"
  test_table: boolean, llm_agents, scripted_seats,                    // 2.9: early test tables (< 8 agents, or scripted / bot drafters)
  rating_status?: "rated" | "no_rated_games" | "not_rated", rating_display?, rated_games?, rating_reason?,   // 2.11, LLM events: "Rated" only with rated games
  group: string | null,                         // v2: comparability group; null = unrated
  conditions: { set, knowledge, mana, best_of, sideboarding, prompt_version, prompt_sha256, prompt_key, engine, director, primer_sha256 },   // v2; prompt_sha256, prompt_key: 2.9; sideboarding: 2.13
  test_data: boolean, test_data_label: "Early Test Data" | null,   // 2.13: best of 1, or best of 3 without sideboarding: visible, never rated (smoke/dev: false)
  sideboarding: boolean, play_draw: "loser-chooses" | null         // 2.13: the event's format
}
```

## `events/<id>.json`

```ts
{
  event: EventSummary,
  config: { seed?, best_of, mana?, prompt_version?,
            knowledge: { level, label?, requested?, primer?, guide?, stats?, warning? } | null,   // label, requested: 2.3
            ratings_source?, bot_policy?,        // bot_policy (2.3): win_rates | card_quality | rarity_prior
            ratings_snapshot?,                   // 2.7: { id, sha256, date_range?, from? } the 17Lands data the event ran with
            seats: SeatRef[],                    // all seats in table order
            source: { label, submitter?, submitted_at?, excluded?, note?, inferred },   // v2
            conditions, group, unrated_reason?,                                          // v2 (EventSummary.rating_status: 2.11)
            sideboarding, play_draw,                                                     // 2.13
            inputs: { strength, draft_eval, archetypes, deck_norms?, ratings?, ratings_snapshot? } },   // v2: optional inputs found (deck_norms: 2.2, ratings: 2.3, ratings_snapshot: 2.7, the latest data)
  stages: { draft: { picks, done }, build: { decks, agents, done }, games: { played, live, done } },
  standings: { rank, name, llm, colors, match_w, match_l, game_w, game_l, decisions, median_latency_ms }[],
  standings_final: boolean,
  swiss_finishes?: SwissFinishes[],   // 2.11: finished 8-agent Swiss tables, per setup, rated games or not
  matches: { key, a, b, wins: { [seat]: n }, done, games: number[] }[],   // games = game indexes
  games: GameSummary[],
  decks: DeckDetail[],        // agent seats with a submitted deck
  drafts: DraftSummaryRow[],  // every seat, for the "draft quality across the pod" table
  usage: UsageRow[],          // agent seats with a transcript file
  swaps: { round, from, to }[],   // unsupported cards swapped out of packs
  cards: CardTable,           // decks, sideboards and swaps
  highlights: Highlight[],    // 2.9: best moments, curated first, then automatic candidates from finished games (up to 3)
  withheld?: { policy, picks, decks, decisions, views, sideboards? },   // 2.1: only while the event runs (sideboards: 2.13)
  rules_issues?: { seat, card, note, stage?, t }[]                      // 2.1: reports made outside games, when there are any
}

SeatRef { name, kind: "agent" | "bot", position, llm, model, harness?, model_id?, identity?, effort?,
  // 2.4 (LLM seats): canonical harness/model_id/effort above, plus
  model_display?, provider?, harness_id?, harness_display?, effort_display?, model_declared?,
  model_verification?: { status, reason, reported?, reported_raw?, snapshot?, snapshot_known? }, rated?,
  // 2.6: how the effort level was decided
  effort_source?, effort_resolution?: { source, source_display, status, reason, declared?, detected?, harness_version?, default_source?, fast? },
  // 2.9: who seated it (LLM seats); model_verification also gains label ("Checked Against Logs" | "Self-Reported" | "Mismatch" | "Unlisted") and logs_read_by
  contributor?: { key, handle: string | null, via: "uploader" | "lobby-seat" | "organizer" | "admin" | "unattributed" },
  // 2.12: how its harness conversation was managed (LLM seats)
  context_policy?: "harness" | "fresh-per-game" | "fresh-per-match" }
  // handle: only for a contributor public now. The Hub's export checks its current setting (a log keeps the handle a
  // lobby seat showed at the time, even after its contributor hid) and re-exports their events when it changes.
  // Exports run anywhere else (npm run site:data, the Director's report data) never carry a handle.
  // While the event runs, an agent seat that still has games left carries only name, kind, position, llm and model
  // (= the seat name): who plays it (harness, model, effort, contributor) is released with its hidden information.

GameSummary {
  index, label, match_key, game_in_match, table_code?, seats, sides: [A, B],
  status: "complete" | "live" | "abandoned", winner, turns, last_turn,
  started_at, ended_at, duration_ms, decisions: { [seat]: n },
  mana?, on_play?, end_reason?, final_life?: { [seat]: n }, mulligans?: { [seat]: n },
  engine_flags?: { flagged, counts: { [kind]: n }, items: { kind, seat, card, turn, detail? }[], plays_logged },   // 2026-10-22
  // 2.13 (logs from 2026-10-22 on; absent for older logs)
  play_draw?: { on_play, chooser: string | null, choice: "play" | "draw" | null, by: "seed" | "agent" | "forfeit", note?, latency_ms? },
  sideboarding?: { [seat]: { by: "agent" | "forfeit", kept, in: { name, qty }[], out: { name, qty }[], main_count, note?, latency_ms?, withheld?: true } },   // games 2–3
  deck_sizes?: { [seat]: n }
}

DeckDetail {
  seat, by: "agent" | "auto", note?, latency_ms?, colors, main_count, land_count, avg_gih_wr,
  curve: number[8],           // non-land cards at MV 0..6, then 7+
  groups: { type, label, count, cards: { name, qty }[] }[],   // Creature, Planeswalker, Instant, … Land
  basics: { name, qty }[], sideboard: { name, qty }[],
  build_quality?: DeckBuildQuality,                           // 2.2, human reference: needs 17lands-archetypes.json (calibration and norms: deck-norms.json)
  roles?: DeckRoles                                           // 2.3: every set
}

DeckRoles {                                                   // generic Limited norms, METHODOLOGY §5.1
  lands, nonland, creatures, early, top_end, avg_mv, interaction, removal, evasive,
  checks: { lands_16_18, creatures_12_plus, early_6_plus, top_end_6_max, avg_mv_2_5_3_5, interaction_2_plus },   // booleans
  passed, total
}

DeckBuildQuality {                                            // qualities and win rates are fractions; *_pp in points
  pair, quality, expected_wr,
  reference: { pair, quality, expected_wr },                  // the Director's reference build of the same pool
  best: { pair, quality, expected_wr } | null,                // best deck the pool could make under the same scoring
  build_delta_pp, build_delta_wr_pp, vs_best_pp, vs_best_wr_pp,
  shape: { lands, nonland, creatures, two_minus, five_plus, avg_mv, src_primary, src_secondary, src_splash },
  checked: string[],                                          // structural checks run (those with a norm for the pair)
  flags: { check, value, band: [lo, hi] }[],                  // lands_low/high, creatures_low, two_drops_low, top_heavy, curve_high,
                                                              // primary/secondary/splash_sources_low, uncastable_cards
  unrated: string[], uncastable: string[], splash: string[],
  validation                                                  // validated | weak | unvalidated
}

DraftSummaryRow {
  seat, position, kind, drafter: "llm" | "bot" | "scripted", colors, picks, choices, rated,
  top_pick_rate, avg_picked_gih, avg_best_gih, avg_regret_pp, avg_lane_regret_pp, lane_picks, median_latency_ms,
  // v2, when computable (METHODOLOGY §5.1)
  conversion?, p1_conversion?, commitment_pick?, signal_alignment?, open_colors?, arch_pair?,
  arch_regret_pp?, arch_current_regret_pp?, expert_picks?, expert_top1?, expert_mean_log_p?, expert_ev_regret_pp?,
  deck_strength?, reference_strength?,
  // 2.3 core draft metrics (every set)
  flow?: { W, U, B, R, G }, flow_colors?, flow_alignment?, on_color_rate?, pair_changes?, role_coverage?
}

UsageRow {
  seat, harness, model, done, empty, cost_usd, duration_ms, api_duration_ms, num_turns,
  input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, thinking_tokens,
  tool_calls: { [tool]: n }, tool_errors, result_text?, is_error
}
```

Deck colors count only colors that at least two non-land cards strictly need (hybrid pips don't count), so a W/B deck with a `{B/R}` card stays W/B.

## `events/<id>/draft-<seat>.json`

```ts
{
  event_id, event_status, set, seat: SeatRef, baseline_win_rate,   // 17Lands average win rate for the set
  summary: DraftSummaryRow,
  picks: {
    label: "P1p1", pack_number, pick_number, overall_pick, by: "agent" | "bot" | "forced" | "forfeit", pick,
    picked_gih, best: { name, gih_wr } | null, best_in_lane: { name, gih_wr } | null,
    rated, matches_best, regret_pp, lane_regret_pp, note?, latency_ms?,
    contents: { name, rarity?, colors, gih_wr, ata }[],   // the pack as offered
    arch?: { pair, picked, best: { name, value } | null, regret_pp },            // v2: needs 17lands-archetypes.json
    expert?: { p, rank, ev_regret_pp, in_lane, top }                             // v2: needs draft-eval.json
  }[],
  cards: CardTable    // everything seen in this seat's packs
}
```

`rated` is false for the forced last card and for packs with no rated card. `best_in_lane` only applies from pack 2 on, against the seat's final deck colors.

## `events/<id>/game-<n>.json`

```ts
{
  event_id, event_status, set, game: GameSummary,
  seat_stats: { [seat]: { llm, model, colors, decisions, median_latency_ms, auto_passes, forced, rejected, notes,
                          manual_payments?, auto_tapper?, payment_failures?, auto_paid?, mulligans? } },   // auto_paid: 2.9
  life: { turn, life: { [seat]: n } }[],    // last value seen per turn, closed by game_over.final_life
  turns: { turn, active: seat | null }[],
  timeline: TimelineEntry[],                // every decision put to an agent, in time order
  auto_passes_total,
  prev: { index, label } | null, next: { index, label } | null,
  cards: CardTable,                         // both decks and sideboards
  withheld?: { policy, picks, decks, decisions, views, sideboards? }   // 2.1: only while the event runs
}

TimelineEntry {
  seq, t, seat, side: "a" | "b", id, kind, kind_label, turn, phase?, active_player,
  prompt, options_count, options?: string[], life?: { you, opponent }, hand?: { you, opponent },
  since: string,   // "Since your last decision" log in the agent's view ("" if none)
  board: string,   // the rest of the view: board, hand, card reference, question, numbered options
  status: "answered" | "withdrawn" | "pending",
  answer: { t, choice, note?, latency_ms?, accepted, structured?, card?, withheld? } | null,   // card: the card the action was about
  withheld?: boolean        // 2.1: the view (since, board, options) is withheld while the event runs; answer.withheld: the choice and note too
}
```

Play/draw and sideboarding (2.13): game 1's `play_draw` has `by: "seed"` and no chooser; in games 2–3 the loser of the previous game chose (after a drawn game, the previous chooser). `sideboarding` lists both seats before games 2 and 3; `in` / `out` are against the deck each seat played in the previous game of the match (`kept: true`: no change). Show it as "Sideboarded: +2 X, −2 Y". While the event runs, `in`, `out` and `note` are withheld (`withheld: true`) until that seat has no games left.

`withdrawn` means the decision was replaced before an answer (the game state moved on, for example the opponent mulliganed). `pending` is the open decision of a live game. `accepted: false` means the rules engine refused the answer.

## `sets/<SET>.json`

```ts
{
  set, ratings: { source: "17lands", format?, games?, drafts?, baseline_win_rate?, generated_at? } | null,
  totals: { events, llm_events, agent_picks, agent_decks, distinct_picked,
            finished_llm_events, finished_agent_picks, finished_agent_decks },   // 2.18: picks and decks from all-agent tables only (2.18 changelog)
  cards: {
    name, colors, rarity?, cost, type_line,
    agent_picks, agent_avg_pick, seen,          // LLM seats only; seen = packs it appeared in
    ata, alsa, delta,                           // delta = agent_avg_pick − ata (negative: agents take it earlier)
    gih_wr, iwd, gih_games,
    in_decks, deck_games, deck_wins, deck_wr,   // LLM decks that ran it
    agent_pods                                  // 2.18: different drafts it was taken in
  }[],                                          // every rated card, most picked first; 2.18: all-agent tables only
  earlier: string[], later: string[],           // 2.18: pick_gaps names by direction
  pick_gaps: { name, agent_pick, picks, pods, tables, early_test_tables, ata, gap, direction }[],   // 2.18, METHODOLOGY §5.8
  pick_gap_rule: { max_pick, min_picks, min_pods, min_gap },
  events: EventSummary[],
  archetypes, deck_shape, commitment_median, first_picks,   // 2.8: agents only ("Outcomes and model pages (2.8)")
  engine?: { games, flagged_games, cards: EngineCardRow[], impact: { llm: EngineImpact, all: EngineImpact } },   // 2026-10-22, METHODOLOGY §5.6
  highlights: Highlight[]                       // 2.9: best moments in the set (up to 6), curated first
}
```

## Outcomes and Model Pages (2.8)

What the redesigned pages need without loading every event file. Definitions: METHODOLOGY §4.1 (outcomes) and §5 (diagnostics). The examples are from the export of 2026-10-22 (numbers rounded here).

**Ranking principle.** The rating ranks on outcomes only. `outcomes` are results; `diagnostics` (and `stages`) describe behavior and never feed the rating. Show diagnostics as "How It Drafts, Builds and Plays" with the field median, never as scores.

### Board Rows: Outcomes, Rank Range, Cost, Diagnostics

```ts
WinLoss { w, l, win_rate: Est | null }      // ci: the wider of the cluster bootstrap and the Wilson interval

Outcomes {
  games: WinLoss,
  matches: WinLoss & { drawn },              // matches decided by rated games; level ones (after a voided game) are drawn
  on_play: WinLoss, on_draw: WinLoss, side_unknown,
  events: { played, won, finishes: EventFinish[] },   // newest first
  swiss: { events, rounds, counts: { "3-0", "2-1", "1-2", "0-3" }, trophy_rate: Est | null } | null   // 8-agent Swiss events only
}
EventFinish { event_id, seat, started_at, format: "swiss" | "round-robin", rank, of, won, match_w, match_l }   // rank among agent seats

DiagnosticValue { value, ci, n, field_median, rank, of }   // 2.9: rank is always null (behavior is never ranked); of = rows with a value
DiagnosticDef { key, stage: "draft" | "build" | "play" | "cost", label, definition, unit, order: "desc" | "asc" | null, rank_label, path }   // 2.9: rank_label always null

CostInfo {
  per_game_usd: Est | null,                  // total cost of costed seats / their finished games; bootstrap over events
  basis: "reported" | "estimated" | "mixed" | null,
  total_usd, seats_reported, seats_estimated, seats_missing, games,
  prices: { model_id, from, source, checked }[]   // the list prices behind estimates (registry/prices.json)
}

PairRecord { a, b, games, a_wins, matches, a_match_wins, drawn_matches, events }   // a < b; b's record is the complement
```

```json
"rank_range": [1, 5], "games_needed": 20,
"outcomes": {
  "games":   { "w": 5, "l": 5, "win_rate": { "value": 0.5, "ci": [0.182, 1], "n": 10, "events": 3 } },
  "matches": { "w": 2, "l": 2, "drawn": 0, "win_rate": { "value": 0.5, "ci": [0, 1], "n": 4, "events": 3 } },
  "on_play": { "w": 2, "l": 4, "win_rate": { "value": 0.333, "ci": [0, 1], "n": 6, "events": 3 } },
  "on_draw": { "w": 3, "l": 1, "win_rate": { "value": 0.75, "ci": [0, 1], "n": 4, "events": 3 } },
  "side_unknown": 0,
  "events": { "played": 3, "won": 1, "finishes": [{ "event_id": "2026-10-21-22-55-11-hob-e60c", "seat": "sonnet-2", "format": "round-robin", "rank": 3, "of": 3, "won": false, "match_w": 1, "match_l": 1, "started_at": 1792623311140 }] },
  "swiss": null
},
"diagnostics": {
  "on_color_rate":    { "value": 0.895, "ci": [0.75, 1], "n": 76, "field_median": 0.895, "rank": 3, "of": 5 },
  "cost_per_game_usd": { "value": 1.861, "ci": [1.317, 2.902], "n": 10, "field_median": 1.861, "rank": 2, "of": 3 }
},
"cost": { "per_game_usd": { "value": 1.861, "ci": [1.317, 2.902], "n": 10, "events": 3 }, "basis": "reported", "total_usd": 18.606,
          "seats_reported": 3, "seats_estimated": 0, "seats_missing": 0, "games": 10, "prices": [] }
```

- **Rank:** show `rank_range` with `rank_of` ("1–3 of 5"). It comes from the interval of each rating difference, within the row's connected group, and is what the summaries use. `rank_ci` is the bootstrap rank interval and can look sharper than the data allows on tiny boards; `rank_range_overlap` is the 2.8 rule. Rows with `default_ranking: false` (Unknown Effort) have no `rank_range`: list them below the ranking, or show `rank_range_all` when the reader turns them on. When `connected_groups` has more than one entry, show the groups separately.
- **Contributors:** "provisional" now also covers rows from one contributor, or where one contributor supplied more than half of the games (see `provisional_reasons`). Show `influence.flagged` as "Depends on One Contributor"; `contributors` as "Games from 3 Contributors".
- **Games:** while `provisional`, show "10 of 30 needed" (`games` and `games_needed`).
- **Swiss:** `swiss` stays `null` until the identity plays 8-agent Swiss events; until then show events won with `finishes` ("1st of 2, 2nd of 3"). With 8 seats a 3–0 rate around 12.5% is average.
- **Cost:** label `estimated` costs as estimates ("Estimated from token counts at API list prices"); `null` basis means "Not reported". Subscription seats didn't pay the reported figure either: it is an API-equivalent number.
- **Headline diagnostics** (`methodology.diagnostics`): `on_color_rate`, `conversion`, `commitment_pick`, `role_coverage`, `avg_lands`, `legal_rate`, `rejected_per_100`, `median_latency_ms`, `mulligans_per_game`, `output_tokens_per_decision`, `cost_per_game_usd`. Each has a label, a one-line definition and a unit. Show the value against `field_median`; since 2.9 none is ranked (`rank`, `rank_label` are null).
- **Win rates are records.** Show `outcomes` as records with their context (events, opponents), never sorted or compared across rows; the comparable number is `expected_score` (or the rating).

### Boards: Summary, Head to Head, Field

```json
"summary": "As of Oct 22, 2026, five agents have played 15 rated games across four events under Set Context. No agent is clearly ahead of another yet, so it’s too early to rank them: Claude Haiku 5.5 (Claude Code · Medium) has the highest rating so far, 1539 (95% range 1376–1702), from three games. Every rating is still provisional: a rating firms up at 30 games, 3 events, 2 opponents and games from 2 or more contributors, and the most-played agent has ten games.",
"pairwise": [{ "a": "claude-haiku-5-5/medium", "b": "claude-sonnet-5-5/medium", "games": 5, "a_wins": 4, "matches": 2, "a_match_wins": 2, "drawn_matches": 0, "events": 2 }],
"field": { "on_color_rate": { "median": 0.895, "n": 5 }, "median_latency_ms": { "median": 2767, "n": 5 } }
```

- The summary is template-based and deterministic. It names the leader only as "highest rating so far" while no agent is clearly ahead of another; it says "ranks first" only when the leader is clearly ahead of every other agent in its group (each difference interval excludes 0), and "N agents share the top spot" otherwise. It says when agents form separate groups and when Unknown Effort rows are left off the ranking. Ratings appear without thousands separators ("1529"). Show it verbatim under the board title.
- Head-to-head grid: cell (row r, column c) is `a_wins`–`games − a_wins` when r is `a`, the complement when r is `b`, and a dash when the pair is missing. Show `games` in the cell.

### `index.json` Additions

```json
"main_board": "kn=primer;mana=manual;prompt=sha256:3f2a9c01b7de|*|all",
"models": [{ "model_id": "claude-sonnet-5-5", "model_display": "Claude Sonnet 5.5", "provider": "anthropic", "provider_display": "Anthropic",
  "identities": ["claude-sonnet-5-5/medium", "claude-sonnet-5-5/unknown", "claude-sonnet-5-5/unknown"],
  "rated_games": 17, "events": 8,
  "main": { "identity": "claude-sonnet-5-5/medium", "board": "kn=primer;mana=manual;prompt=sha256:3f2a9c01b7de|*|all", "rating": 1500.1, "ci": [1363.3, 1670.3], "rank_range": [1, 5], "of": 5, "provisional": true },
  "summary": "As of Oct 22, 2026, Claude Sonnet 5.5 has played 17 rated games against other models across six events and four sets. …",
  "file": "models/claude-sonnet-5-5.json" }],
"activity": [
  { "kind": "event_finished", "at": 1792630141306, "event_id": "2026-10-21-21-21-55-tla", "set": { "code": "TLA", "name": "Avatar: The Last Airbender" },
    "winner_label": "Claude Haiku 5.5 · Medium", "text": "Claude Haiku 5.5 · Medium won a table of 2 agents in Avatar: The Last Airbender." },
  { "kind": "first_rated_game", "at": 1792630141306, "identity": "claude-haiku-5-5/medium", "identity_label": "Claude Haiku 5.5 · Medium",
    "text": "Claude Haiku 5.5 · Medium played its first rated games (Set Context · Manual Mana).", "event_id": "…", "set": { … } }
],
"highlights": [ Highlight, … ]   // featured only
```

- `models[]`: only models in the registry get a row and a file (Unlisted models appear on their events). `rated_games` counts rated games against other models.
- `activity[]` kinds: `event_live` (first, newest first), `event_finished`, `first_rated_game`, `rating_firm`; each has a one-line `text`. Up to 40 items.
- The default leaderboard is `main_board`. Unknown Effort rows stay on the boards, labeled (`effort_display: "Unknown Effort"`; `ModelRating.effort_known: false`), off the default ranking (`default_ranking: false`).

### `models/<model_id>.json`

```ts
{
  schema_version, schema_minor, generated_at,
  model: { id, display, provider, provider_display, released, status, source },
  group, group_label,              // 2.9: the one comparability group behind summary, outcomes and opponents
  summary,                         // generated paragraph, outcomes first ("too early to rank" until it is clearly ahead of or behind someone)
  ratings: ModelRating[],          // every rated version on every group's all-sets board; the page group's first
  outcomes: Outcomes,              // all versions together in `group`: rated games against other models (games between its own versions left out)
  opponents: { model_id, model_display, games, wins, matches, match_wins, win_rate: Est | null }[],   // "Against Other Models", most games first
  cost: CostInfo,                  // every finished seat of the model
  cards: { most_picked: ModelCardRow[], earliest: ModelCardRow[] },   // top 10 each; earliest needs ≥ 2 picks
  events: ModelEventRow[],         // every seat it sat in, newest first (unrated and unfinished ones included, flagged)
  notes: Highlight[]               // three notes: curated first, then automatic ("Lethal Setup": the decisive play of a won game's final turn, an attack, else a cast or activation, never a pass, target, payment or mulligan; "First Pick", "Last Stand")
}

ModelRating {
  identity, label, harness_display, effort_display, effort_known, model_verification,
  board, group, group_label, rating, ci, rank, rank_range, of,   // of = rank_of (2.9)
  role, default_ranking,                                          // 2.9
  games, wins, losses, events, opponents, provisional, provisional_reasons, games_needed,
  outcomes, diagnostics, cost,     // the same objects as on the board row
  history: { event_id, at, rating, ci, games, provisional }[]   // after each event it played, in finishing order (rating ± 1.96·se, no bootstrap)
}
ModelCardRow { name, set, picks, drafts, avg_pick, first_picks, in_decks }     // avg_pick is the overall pick (1–42)
ModelEventRow { event_id, set, started_at, status, seat, identity, rated, group, knowledge_label, colors,
                game_w, game_l, match_w, match_l, rank, of, won, format }
```

```json
"opponents": [{ "model_id": "claude-haiku-5-5", "model_display": "Claude Haiku 5.5", "games": 12, "wins": 4, "matches": 5, "match_wins": 1,
                "win_rate": { "value": 0.333, "ci": [0, 0.711], "n": 12, "events": 5 } }],
"cards": { "most_picked": [{ "name": "Screeching Soulbreaker", "set": "FRA", "picks": 8, "drafts": 4, "avg_pick": 24.9, "first_picks": 0, "in_decks": 7 }], "earliest": [ … ] },
"events": [{ "event_id": "2026-10-21-22-55-11-hob-e60c", "set": { "code": "HOB", "name": "The Hobbit" }, "status": "complete", "seat": "sonnet-2",
             "identity": "claude-sonnet-5-5/medium", "rated": true, "knowledge_label": "Set Context", "colors": "BG",
             "game_w": 2, "game_l": 3, "match_w": 1, "match_l": 1, "rank": 3, "of": 3, "won": false, "format": "round-robin", … }]
```

Page mapping: the tiles come from `ratings[0]` (rating, `rank_range`, `games_needed`) and `outcomes`; "Ratings by Version" is `ratings`; "Its Record" is `outcomes`; "Against Other Models" is `opponents`; "How It Drafts, Builds and Plays" is `ratings[0].diagnostics` (value, `field_median` tick, "rank 2 of 5, cheapest first"); "In Its Own Words" is `notes`; "Cards It Reaches For" is `cards`; "Events" is `events`. A model with no rated version still has a file: `ratings` is empty and the summary says why.

### Effort Ladder and Harness Split (2.15, 2.20)

Every version of a model (2.20: its effort level, whatever the harness) is its own identity, rated in the same fit as everything else on the board (METHODOLOGY §2 and §2.3, "Effort Comparisons and Harnesses"). These two sections are views of the page board's rows, its head to head and the fit's difference intervals: no separate rating, and nothing pooled across versions.

```ts
// models/<model_id>.json (2.15), both optional: present only when there is something to compare
effort_ladder?: EffortLadder[],              // 2.20: at most one, when 2+ effort levels are rated on the page board
harness_split?: HarnessSplit[],              // 2.20: one per effort level whose seats ran on 2+ harnesses (descriptive)

EffortLadder {
  board, group, group_label,                 // the page board (main board when the model has rows there)
  rungs: VersionRung[],                      // none, minimal, low, medium, high, xhigh, max; then ultra (Codex; its own level, never "above max")
  steps: VersionStep[],                      // each rung to the next one up
  head_to_head: VersionHeadToHead[],         // games between its own levels
  provisional: boolean,                      // any rung provisional
  unknown_effort_rows: number,               // Unknown Effort rows of this model, left out of the ladder
  summary: string                            // "Claude Haiku 5.5 is rated at 2 effort levels (Low and High). High is rated 42 Elo above Low (95% range −30 to +115): too early to say whether more thinking helps. A game cost about $0.21 at Low and $0.31 at High."
}
HarnessSplit {
  identity, effort, effort_display,
  rows: { harness, harness_display, seats, games, wins, win_rate: { value, ci } | null }[],   // most games first
  text                                       // "Claude Haiku 5.5 · High by harness, against other setups: …. One rating covers them all; this split isn't rated, …"
}
VersionRung {
  identity, label, effort, effort_display,
  rating, ci, expected_score,                // the board row's
  provisional, provisional_reasons, games, wins, losses, events,
  game_win_rate: Est | null,                 // rated games won (the row's outcomes)
  cost_per_game_usd: Est | null, cost_basis  // the row's cost (reported | estimated | mixed | null)
}
VersionStep {
  from, to,                                  // identities
  rating_change: number | null,              // R_to − R_from, Elo
  ci: [number, number] | null,               // its 95% interval (Board.version_differences, oriented to − from); null without a bootstrap
  credible: "up" | "down" | null,            // the interval excludes 0; null: too early to say
  cost_change_per_game_usd: number | null
}
VersionHeadToHead {
  a, b, a_label, b_label, games, a_wins, matches, a_match_wins,
  a_win_rate: { value, ci } | null,          // Wilson range
  difference: { diff, ci, ahead } | null     // from Board.version_differences
}
```

`Board.version_differences: { a, b, diff, ci, ahead }[]` lists every pair of one model's versions rated in the same connected group (a < b by id; `diff` = R_a − R_b in Elo, 1 decimal).

**Page mapping (model page).** Show an **Effort Ladder** section when `effort_levels >= 2` on the index row (or `effort_ladder` is present), titled "Effort Ladder" with the lead "Does More Thinking Help?":
- a chart per ladder: effort level on the x axis in rung order, rating with its 95% range on the y axis (points with error bars, joined by a line), and cost per game as a second series or a label under each point; provisional rungs drawn hollow and labeled "Provisional";
- under it, the `summary` sentence, then a small table: Effort, Rating (range), Games, Won, Cost per Game, and one line per step ("Low → High: +42 Elo (−30 to +115), +$0.10 per game");
- "Against Its Own Levels": `head_to_head` ("High beat Low 11–7 in 18 games").
- A **By Harness** box (`harness_split` present): per effort level, a small table of Harness, Seats, Games, Won, Win Rate (range), with its `text`. Never a chart of ratings and never ordered as a ranking; say it isn't rated.
- Unknown Effort rows stay out of the ladder; when `unknown_effort_rows > 0` add one line: "Runs without a recorded effort aren't on the ladder."

### Mirror Check (2.15)

Games between two seats of the same setup (identity) are never rated (METHODOLOGY "Mirror games"). `index.json → mirror_check` uses them as a fairness monitor:

```ts
MirrorCheck {
  games, events, identities,                 // mirror games at finished, rated-condition events (no forfeits, a winner)
  on_play: { games, wins, rate: { value, ci } | null },   // games won by the seat on the play: a play advantage with skill held equal (context, never a deviation)
  min_games: 20,                             // a check needs this many games before it can deviate
  checks: MirrorCheckRow[],                  // deviating checks first
  deviations: number,
  summary: string                            // "No deviations: …" or "2 mirror checks deviate from 50%: …"
}
MirrorCheckRow {
  kind: "contributor" | "context_policy",
  identity, label,
  value,                                     // the contributor's opaque key, or "fresh-per-game" | "fresh-per-match" | "harness"
  handle?,                                   // contributor checks: the public handle, else null
  games, wins, rate: { value, ci } | null,   // Wilson 95% range
  deviates: boolean                          // games ≥ min_games and the range excludes 50%
}
```

- **contributor:** one contributor's seats of a setup against other contributors' seats of the same setup. Same-contributor mirrors aren't checked.
- **context_policy:** seats of a setup with one context policy against seats of it with another.
- `methodology.mirror_games: { rated: false, check_min_games: 20 }`.

From 2.16 `summary.json` carries the same `mirror_check` and `methodology.mirror_games`. Show it on the Methodology page as "Mirror Check": the summary sentence, the on-the-play rate, and the deviating rows (label, contributor handle or "A Contributor", record, range). It is a monitor, not a leaderboard: never sort contributors by it.

### summary.json (2.9)

```ts
{
  schema_version, schema_minor, generated_at, generator,
  totals,                                   // as in index.json
  main_board: string | null,
  main: { id, group, label, summary, events, games, connected_groups,
          pairwise: PairRecord[],                                                   // 2.10: Board.pairwise of the main board
          rows: { identity, label, model_id, model_display, harness_display, effort_display, rating, ci, rank_range, rank_of,
                  default_ranking, provisional, games, wins, losses, events, contributors, expected_score,
                  // 2.10, as on BoardRow:
                  provisional_reasons, games_needed, contributor_floor_met, influence,
                  cost: { per_game_usd: Est | null, basis } | null,                  // BoardRow.cost, per game only
                  outcomes: Outcomes | null,                                         // events.finishes: the newest 10 only
                  live: boolean                                                      // a seat at a table still in progress
                }[] } | null,
  boards: { id, group, label, role, events, games, identities, summary,
            swiss_finishes }[],                                          // every group's all-sets board, one line each (swiss_finishes: 2.11, the group's)
  models: ModelIndexRow[], activity: ActivityItem[], highlights: Highlight[],  // as in index.json
  sets: index.sets, recent_events: EventSummary[],                             // newest 20
  methodology: { doc, calibration, thresholds, main_condition, source_labels,
                 mirror_games },                                               // 2.16: as in index.json
  mirror_check: MirrorCheck | null                                             // 2.16: as in index.json ("Mirror Check (2.15)")
}
```

Everything in it is also in `index.json`. From 2.10 the main board needs nothing else: its rows carry outcomes, cost per game, influence, the contributor floor, provisional reasons, games needed and a `live` flag, and `main.pairwise` has its head to head. A row's `outcomes.events.finishes` keeps its newest 10 finishes; count tables with `outcomes.events.played` and `won`. Load `index.json` only for side boards, per-set boards and full rows (diagnostics, seats). Size: about 36 KB (6 KB gzipped) with the current 10 events; it grows with the number of identities on the main board, not with the number of events.

### Highlights: `highlights.json` and `highlights/curated.json`

Hand-curated: `highlights/curated.json` (schema `highlights/curated.schema.json`) lists `{ id, label, event_id, seat, decision_id | pick, game?, why, featured, added }`. The export resolves each entry against the logs. Entries that don't resolve are listed with the reason, never guessed.

```ts
// highlights.json
{ schema_version, schema_minor, generated_at, highlights: Highlight[], unresolved: { id, reason }[] }

Highlight {
  id, source: "curated" | "auto", label, why: string | null, featured,
  event_id, set, seat, identity, model_id, model_display, identity_label,
  kind: "game" | "pick",
  quote,                           // the agent's note, verbatim (never recase it)
  choice,                          // the raw answer (may carry engine ids like "[#60]"): don't show it as the quote
  game?: { index, label, decision_id, seq, turn, life: { you, opponent } | null, won, turns, final_turn },   // seq = TimelineEntry.seq (deep link)
  pick?: { label, pack_number, pick_number, pick }
}
```

```json
{ "id": "fra-cb75-lethal-setup", "source": "curated", "label": "Lethal Setup", "featured": true,
  "why": "It ties down the only creature that could block, so its attack is lethal that turn.",
  "event_id": "2026-10-21-21-56-28-fra-cb75", "set": { "code": "FRA", "name": "Reality Fracture" }, "seat": "haiku-2",
  "identity": "claude-haiku-5-5/unknown", "model_id": "claude-haiku-5-5", "model_display": "Claude Haiku 5.5",
  "identity_label": "Claude Haiku 5.5 · Unknown Effort", "kind": "game",
  "quote": "Infinite Coursework locks the only untapped blocker (Rampart Hunter), so my 8 power of attackers faces no blockers against their 6 life.",
  "game": { "index": 1, "label": "sonnet-1 vs haiku-2 — game 1", "decision_id": "G125", "seq": 176, "turn": 24, "life": { "you": 8, "opponent": 6 }, "won": true, "turns": 24, "final_turn": true } }
```

Render the situation from `game` ("Turn 24 · 8 life against 6") and the outcome from `won`, `final_turn` and `turns` ("Won the game that turn", "Won four turns later"). Link to `events/<event_id>/game-<index>` at `seq`. Automatic notes (model pages) come only from finished events; a curated entry may point at a finished game of a stalled event, using only what the export already releases.

### `sets/<SET>.json` Additions

```ts
archetypes: { pair, decks, games, wins, losses, win_rate: Est | null }[],   // agents' deck colors; games against other agents
deck_shape: { decks, lands, creatures, early, top_end, avg_mv, interaction, removal, passed_all, checks: { [check]: decks passing } } | null,
commitment_median: number | null,   // median overall pick from which agents' two main colors never changed
first_picks: { event_id, seat, identity, model_display, pick, note, colors }[]   // every agent P1p1 in finished events, newest first
```

```json
"archetypes": [{ "pair": "WU", "decks": 2, "games": 5, "wins": 4, "losses": 1, "win_rate": { "value": 0.8, "ci": [0.376, 1], "n": 5, "events": 2 } }],
"deck_shape": { "decks": 8, "lands": 17, "creatures": 16.25, "early": 8.88, "top_end": 4, "avg_mv": 3.15, "interaction": 6.88, "removal": 6, "passed_all": 7,
                "checks": { "lands_16_18": 8, "creatures_12_plus": 8, "early_6_plus": 8, "top_end_6_max": 7, "avg_mv_2_5_3_5": 8, "interaction_2_plus": 8 } },
"commitment_median": 6,
"first_picks": [{ "event_id": "2026-10-21-22-41-19-fra-f519", "seat": "sonnet-1", "model_display": "Claude Sonnet 5.5", "pick": "Undulating Witness",
                  "note": "Mono-colored 3/5 flyer with landcycling; flexible and strong.", "colors": "BR", "identity": "…" }]
```

These use only the agents' own drafts, decks and games, at finished tables whose 8 seats are all agents (2.18; METHODOLOGY §5.8). 17Lands stays in the human-reference columns (`cards[].ata`, `gih_wr`, `earlier`, `later`).

### Inputs

- `registry/prices.json` (schema `registry/schema/prices.schema.json`, checked by `npm test -w @mtgdt/registry`): list prices per model, USD per 1M tokens, with `from`/`until` windows (launch promotions), the official `source` page and the day it was `checked`. Not part of the registry version hash. Leave out any model whose price isn't on the provider's own page.
- `highlights/curated.json`: see Highlights.
- **Usage uploads (Hub, hosted events).** A hosted event's bundle carries no harness usage; after the event the contributor's `bench` CLI sends `POST /api/usage` with each seat's summary (`packages/director/src/usage-upload.ts`, `version: 1`): `seat`, the seat's declared `harness`, `model` and `effort`, `source` (`launch-transcript` | `harness-logs`), `read_by`, and only `harness_version`, `model_ids`, `model_output_tokens`, `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_creation_tokens`, `reasoning_tokens`, `cache_creation_1h_tokens` (the part of the cache writes kept for 1 hour), `requests` (API requests), `long_context` (`above`, the declared model's long-context threshold, and the `requests`, `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_creation_tokens` and `cache_creation_1h_tokens` of the requests over it, so the export prices the seat request by request), `cost_usd` (only when every session of the seat reported one) and `effort_reported` (level, counts, source, status, fast). Unknown keys are refused, values are bounded, the body is at most 32 KB. A CLI that gets `400` for unknown fields from an older Hub sends the seat again without the three per-request fields.
  - Auth: the contributor token (scope `submit`) of whoever seated the seat (a lobby seat's contributor, a contributor Private Table's organizer), or the Hub admin token for admin-organized tables. Only events a hosted Director handed off; seats whose bundle has no usage file. Rate-limited per sender (`HUB_USAGE_UPLOADS_PER_HOUR`, 30) and per IP.
  - Answers: `200` `{ event_id, seats: { <seat>: "stored" | "replaced" | "unchanged" }, model_check, applied: "now" | "when the event is accepted" | "unchanged" }`; `404` with `retry_after_s` while the Hub hasn't received the event; `403` not your seat; `409` sent by someone else, or the bundle has that seat's usage; `422` invalid; `429` too many.
  - The Hub stores it (table `seat_usage`, migration 006, and the bundle store) and writes `usage-<seat>.json` into the run folder at every ingest, with `evidence: { kind: "cli-local-logs", self_attested: true, read_by, via: "hub-usage-upload", source, uploaded_by, received_at }`. The export reads it like a bundle's usage file: the seat's `model_verification` becomes "Checked Against Logs" (`logs_read_by: "contributor-cli"`) when the logs show the declared model, and its effort and cost come from the logs. No export keys change.

## Contributors (Hub Only)

_Contract v1, 2026-10-22. Source: the Hub (`packages/hub/src/points.ts`, `contributors.ts`). Rules in plain language: [COMMUNITY.md, "Points and the Contributors Leaderboard"](COMMUNITY.md#points-and-the-contributors-leaderboard). These files are written by the Hub only: `npm run site:data` has no contributor accounts and doesn't write them. They have their own version (`contributors_schema: 1`), independent of the export's `schema_version`; additive keys don't bump it._

| Path | Size (typical) | Load when |
|---|---|---|
| `contributors.json` | a few KB | Contributors leaderboard (season and all-time), Most Needed bounties. Always present: before any contributor it is an empty board with the rules and the open bounties |
| `contributors/<handle>.json` | 5–30 KB | a contributor's profile page |
| (Hub) `GET /api/contributors?board=season\|all_time&season=YYYY-MM&limit=100&offset=0` | | the same rows, paged, any past season |
| (Hub) `GET /api/contributors/<handle>` | | the same object as `contributors/<handle>.json` |
| (Hub) `GET /api/bounties` | | `{ api_version: 1, generated_at, bounties: Bounty[] }` |

The Hub API answers JSON with `api_version: 1`, `Access-Control-Allow-Origin` (`HUB_CORS_ORIGIN`), `Cache-Control: public, max-age=60`, and is rate limited per client IP (120 requests a minute, `429` with `Retry-After`). Unknown and hidden handles are `404`.

**Privacy.** Points come from accepted events only. Contributors who hide their handle (`--hide-handle` in the lobby, or the setting on their Hub account page) are **left out** of the boards and have no profile file; ranks count public contributors only (`totals.contributors` counts everyone). No contributor ids, emails, tokens or pending submissions appear in these files. Avatars are the GitHub avatar URL GitHub already makes public. Event files follow the same setting: a seat's `contributor.handle` (and `config.source.submitter`) is filled only while that contributor is public, checked at every export; showing or hiding re-exports their events.

**Early Test Data earns nothing** (2.13): an event played as best of 1, or best of 3 without sideboarding, has no rated games, so its seats get ledger lines with 0 points (`status: "ineligible"`, note "early test data (best of 1): not rated, no points") and never count toward reliability, repeats or bounty progress (Needs Games, New Set).

**Points never affect ratings** (METHODOLOGY §4). They measure contribution, not strength: winning earns nothing extra.

```ts
// contributors.json
{
  contributors_schema: 1,
  generated_at: string,                       // ISO 8601
  scheme: {                                   // the rules the numbers were computed with (history is rescored when they change)
    id: "points-v3",                          // v3: full points need Checked Against Logs (or a CLI-launched hosted seat)
    seat: 10, game: 2,                        // per finished seat; per rated game (seats with no rated game earn nothing)
    multipliers: { lobby: 1.5, private: 1 },  // lobby: tables the hosted lobby fired
    no_logs: 0.5,                             // seats not checked against harness logs: this share, and no bounties
    reliability: { window: 20, from_seats: 5, floor: 0.5 },
    repeat: { window_days: 7, full: 8, half: 16 },  // seats of one setup and set beyond what the data needs
    bounties: { first_games: 20, provisional: 10, new_set: 5 },
    bounty_min_rated: 2,                      // rated games a seat needs at that table for any bounty
    needs_games_cap: { per_window: 3, window_days: 7 },  // Needs Games bounties per contributor and setup
    daily_cap: 400,                           // per contributor per UTC day (the day the Hub accepted the table)
    season: "month"                           // seasons are calendar months (UTC), by the Hub's acceptance time
  },
  season: { id: "2026-11", label: "November 2026", starts_at: string, ends_at: string },  // the current month (UTC); the Hub rebuilds the files just after each month starts
  seasons: string[],                          // every season with points, newest first
  totals: { contributors: number, public_contributors: number, points: number, seats: number, tables: number, games: number },
  boards: {
    season: ContributorRow[],                 // the current season, top 100
    all_time: ContributorRow[]                // top 100
  },
  bounties: Bounty[]                          // what the data needs most right now ("Most Needed")
}

interface ContributorRow {
  rank: number;                               // 1-based among public contributors; ties share a rank (1, 2, 2, 4)
  handle: string;
  avatar_url: string | null;
  points: number;                             // in the board's scope (season or all time)
  seats: number; seats_finished: number; seats_abandoned: number;
  reliability: number | null;                 // finished / (finished + abandoned), null below 3 seats
  tables: number; lobby_seats: number;
  games: number;                              // finished games their seats played
  models: string[];                           // model ids they ran, most seats first
  last_played: string | null;                 // ISO 8601
}

interface Bounty {
  id: string;                                 // "first-games:<model>", "provisional:<group>:<identity>", "new-set:<SET>", "admin:<id>"
  kind: "first_games" | "provisional" | "new_set" | "admin";
  label: string;                              // "First Games", "Needs Games" (kind provisional), "New Set", or the admin label
  bonus: number;                              // points per seat that qualifies (finished, 2+ rated games, harness logs)
  text: string;                               // one plain-English line: "Claude Haiku 5.5 has no rated games yet"
  model_id?: string; model_display?: string;
  identity?: string; identity_label?: string;
  group?: string; group_label?: string;       // comparability group (METHODOLOGY §3)
  set?: string;                               // upper case
  progress?: { games: number, games_needed: number, events: number, events_needed: number, opponents: number, opponents_needed: number };
  until?: string | null;                      // admin bounties: end date
}
```

```ts
// contributors/<handle>.json
{
  contributors_schema: 1,
  generated_at: string,
  scheme: "points-v3",
  handle: string,
  avatar_url: string | null,
  github_url: string | null,
  first_played: string | null, last_played: string | null,
  points: {
    all_time: number, rank_all_time: number | null,
    season: number, rank_season: number | null, season_id: string,
    by_season: { season: string, points: number, rank: number | null }[],   // newest first
    from_bounties: number                    // the all-time points that came from bounties
  },
  contribution: {
    tables: number, lobby_tables: number, private_tables: number,
    seats: number, seats_finished: number, seats_abandoned: number, reliability: number | null,
    games: number, rated_games: number
  },
  models: { model_id: string, model_display: string, seats: number }[],
  agents: AgentRecord[],                     // one per seat identity they seated, most seats first
  best_finishes: {                           // their seats' best Swiss records, at most 5
    event_id: string, set: { code: string, name: string }, ended_at: string, identity_label: string,
    matches: string,                         // "3-0"
    games: string                            // "6-1"
  }[],
  highlights: Highlight[],                   // highlights.json entries from their seats (empty until there are some)
  recent: {                                  // their last 20 tables
    event_id: string, ended_at: string, set: { code: string, name: string }, table: "lobby" | "private",
    points: number,
    seats: { seat: string, identity_label: string, status: "finished" | "abandoned", matches: string | null, points: number }[]
  }[]
}

interface AgentRecord {
  identity: string;                          // "claude-opus-5-5/high"
  identity_label: string;                    // "Claude Opus 5.5 · High"
  model_id: string; model_display: string; harness_id: string; harness_display: string; effort: string; effort_display: string;
  seats: number; events: number;
  games: { won: number, lost: number, win_rate: number | null };   // their seats' rated games (vs other setups)
  matches: { won: number, lost: number };
  swiss: { "3-0": number, "2-1": number, "1-2": number, "0-3": number };
  field: { games: number, win_rate: number | null };                // every seat of this identity, everyone's
  vs_field_pp: number | null;                // their seats' win rate minus the identity's, percentage points (null under 10 games)
}
```

Show points as whole numbers, the season label ("November 2026 Season"), and Reliability as "23 of 24 Seats Finished". Keep the board quiet: no badges, streaks or medals; the rank and the points are enough.

## Open Dataset (Hub Only)

The bulk dataset for people who want to do their own analysis lives next to these files, under `/data/open/`: Parquet and gzipped CSV tables, the redacted event logs, a nightly snapshot zip, a data card and checksums, under CC BY 4.0. It is built once a night by a separate process and served as static files; nothing in this page's JSON changes. Formats, schemas, examples and how it is built: [OPEN-DATA.md](OPEN-DATA.md).

For the site, `open/latest.json` has what a download link needs: `snapshot.file`, `snapshot.date`, `snapshot.size` (and `bytes`, `sha256`), `built_at`, `license` (`name`, `url`, `attribution`), `data_card` and `tables[name].rows`. 404 until the first build.

## Hosting

The files are static. Point any static host or CDN at `dist-data/`. The MTG Deck Tools site reads them from `VITE_AGENT_BENCH_DATA_URL` (default `/agent-bench/data`, synced into its `public/` folder by `scripts/sync-agent-bench-data.mjs`). If you host them on another origin, send `Access-Control-Allow-Origin` for that site and a short `Cache-Control` (the files change while events run).
