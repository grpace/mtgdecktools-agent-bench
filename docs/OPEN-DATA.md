# Open Data

Everything MTG Deck Tools Agent Bench records is public once an event is over: every draft pick with the pack it came from, every deck, game and in-game decision, the full event logs, and the ratings. Download it, analyze it, build on it.

- **Where:** `<hub>/data/open/`. Start at [`latest.json`](#latestjson): <https://bench-data.mtgdecktools.com/data/open/latest.json>.
- **When:** updated nightly (03:30 server time, America/New_York; a night with nothing new publishes nothing new). Only finished, accepted LLM events, and stopped ones with finished games (their finished games are rated; METHODOLOGY §3.2 "Stopped events"). Early Test Data would be included and labeled (the pre-launch test tables aren't published, so the live archive has none); smoke and dev tests (scripted players only) are left out; never a running event.
- **License:** our data is [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/), attribution **"MTG Deck Tools Agent Bench"**. The `human_reference` table is 17Lands data with its own credit ([Licenses](#licenses)).
- **Data card:** `DATASET.md`, next to `latest.json` and inside every snapshot: collection method, populations, known biases, the schema of every table and how to cite.

The site's own JSON files (`/data/*.json`, [SITE-DATA.md](SITE-DATA.md)) stay as they are; this is the bulk dataset for your own analysis.

## Download

| File | What | Typical size |
|---|---|---|
| `latest.json` | The current snapshot (file, date, size, sha256), every table file with rows, size and sha256, earlier snapshots | a few KB |
| `snapshots/agent-bench-data-<date>.zip` | Everything: every table (CSV and Parquet), every event log, `DATASET.md`, `LICENSE.md`, `manifest.json` (with `reproducibility`), `methodology.md`, `reproduce_leaderboard.py`, `SHA256SUMS` | ~0.4 MB per early test event, 1–1.5 MB per 8-agent event |
| `tables/<table>.parquet`, `tables/<table>.csv.gz` | One table across all events | KB to MB |
| `tables/by-set/<SET>/<table>.parquet` / `.csv.gz` | The same, one set | |
| `events/<event_id>/events.jsonl.gz` | The full event log (redacted, see [Privacy](#privacy)) | 0.1–1.5 MB |
| `events/<event_id>/decision-texts.jsonl.gz` | Optional: the full text each agent saw at each decision (also in the log); not in the zip | 0.1–1.1 MB |
| `DATASET.md`, `LICENSE.md`, `SHA256SUMS` | Data card, licenses, checksums of every file | |

```bash
base=https://bench-data.mtgdecktools.com/data/open
snap=$(curl -s $base/latest.json | jq -r .snapshot.file)
curl -fLO "$base/$snap"                       # resumable: curl -C - -fLO …
curl -s $base/latest.json | jq -r '.snapshot | "\(.sha256)  \(.file | split("/") | last)"' | sha256sum -c
unzip -q "$(basename "$snap")"
```

Snapshots have dated names and never change (a takedown deletes them instead; see [Privacy](#privacy)); a later build on the same day (an early rebuild after a takedown, or a manual one) adds `-r2`, `-r3`, …. The seven newest snapshots and the newest of each of the last 12 months are kept. Serving: static files only, streamed, with `ETag`, single byte `Range` requests (resumable downloads; DuckDB and other Parquet readers fetch parts over HTTP), `Cache-Control: immutable` on snapshots, 5 minutes on `latest.json`, 1 hour on the rest. Per IP: 60 requests a minute and 4 downloads at a time; to fetch many event logs, take the snapshot zip instead.

### latest.json

```json
{
  "dataset": "MTG Deck Tools Agent Bench Open Data",
  "schema_version": 3,
  "updated": "nightly",
  "built_at": "2026-10-23T07:30:12.345Z",
  "snapshot": { "file": "snapshots/agent-bench-data-2026-10-23.zip", "date": "2026-10-23", "bytes": 3957699, "size": "3.8 MB", "sha256": "…" },
  "earlier_snapshots": [{ "file": "snapshots/agent-bench-data-2026-10-22.zip", "date": "2026-10-22", "bytes": 3901234, "size": "3.7 MB", "sha256": "…" }],
  "data_card": "DATASET.md",
  "checksums": "SHA256SUMS",
  "license": { "id": "CC-BY-4.0", "name": "Creative Commons Attribution 4.0 International", "url": "https://creativecommons.org/licenses/by/4.0/", "attribution": "MTG Deck Tools Agent Bench", "summary": "…" },
  "citation": "MTG Deck Tools Agent Bench (2026). MTG Deck Tools Agent Bench Open Data, snapshot 2026-10-23. …",
  "events": 9,
  "sets": ["FRA", "HOB", "MSH", "SOS", "TLA"],
  "tables": {
    "picks": {
      "description": "Every draft pick: …", "rows": 3024,
      "csv": { "path": "tables/picks.csv.gz", "bytes": 108544, "sha256": "…" },
      "parquet": { "path": "tables/picks.parquet", "bytes": 148480, "sha256": "…" },
      "by_set": { "FRA": { "rows": 1344, "csv": { "path": "tables/by-set/FRA/picks.csv.gz", "…": "…" }, "parquet": { "…": "…" } } }
    }
  },
  "event_logs": { "path": "events/{event_id}/events.jsonl.gz", "files": 9, "bytes": 3500000 },
  "decision_texts": { "path": "events/{event_id}/decision-texts.jsonl.gz", "optional": true, "in_snapshot": false, "bytes": 5100000 },
  "human_reference": { "included": true, "table": "human_reference", "source": "17Lands public datasets", "url": "https://www.17lands.com/public_datasets", "license": { "id": "CC-BY-4.0" }, "attribution": "Data from 17Lands (17lands.com)", "note": "Derived aggregates … not produced or endorsed by 17Lands." },
  "reproducibility": {
    "code_commit": "4ed554d", "registry_version": "sha256-…", "registry_sha256": "…", "methodology_sha256": "…",
    "prompt_sha256": ["606cd691…"], "card_data_sha256": ["a81ec87f…"],
    "rating": { "model": "bradley-terry MAP, Elo scale", "center": 1500, "prior_sd_elo": 200, "play_prior_sd_elo": 50, "play_term": "game 1 of each match only", "ci": 0.95, "replicates": 1000, "seed": 20261021, "…": "…" }
  }
}
```

`reproducibility` (also in each snapshot's `manifest.json`) says what the numbers were built from: the code commit, the model registry (identities are re-resolved against the current registry at every export, so the same logs can map to different rows after a registry fix; the hash says which registry this was), the methodology text, the prompt and card-data hashes the events ran with, and the rating settings.

## Formats and Conventions

- **Parquet** (snappy, column statistics) and **gzipped CSV** (RFC 4180, UTF-8, header row) carry the same columns. Parquet files carry the table description and license in their key-value metadata.
- **Timestamps** are UTC: ISO 8601 in CSV, `TIMESTAMP_MILLIS` in Parquet.
- **`json` columns** hold JSON text: lists of card names (`pack_contents`) or `{ name, qty }` objects (`main`, `cards_in`). DuckDB: `from_json(pack_contents, '["VARCHAR"]')`; pandas: `json.loads`. Parquet marks them with the JSON type.
- **Nulls** are empty CSV cells. Rates are fractions. Colors are WUBRG strings (`"WU"`).
- **Seat names** are neutral (`seat-<hex>`) and say nothing about the model: join `seats` on `(event_id, seat)` for the model, harness and effort.
- **Free text** (deck names, archetypes, rules reports) is kept as written, with tokens, paths, e-mail and IP addresses replaced. If you open the CSV files in a spreadsheet, remember these are free text.
- **Schema version** (`latest.json → schema_version`, the Parquet metadata): adding a column keeps it; renaming or removing one, or changing its meaning, bumps it. **3** (2026-10-25): `picks`, `decks`, `decisions` and `sideboarding` have no `note` column, and `games` has no `play_draw_note`. **2** (2026-10-23): a setup (`identity`) is a model at an effort level, `model/effort`; the harness is a seat detail (`seats.harness_id`), and `ratings.harness_id` is null. **1**: `harness/model/effort`.

## Example: Pick Rates

Agent pick rate per card: how often agents took a card when it was in the pack (one count per pack, duplicates folded).

**DuckDB** (in the unzipped snapshot folder; or put `https://…/data/open/` in front of each path to read over HTTP):

```sql
WITH offered AS (
  SELECT DISTINCT p.event_id, p.seat, p.overall_pick, p.pick,
         unnest(from_json(p.pack_contents, '["VARCHAR"]')) AS card
  FROM 'tables/picks.parquet' p
  JOIN 'tables/events.parquet' e USING (event_id)
  WHERE p.by = 'agent' AND NOT e.early_test_data
)
SELECT card, count(*) AS seen, count(*) FILTER (WHERE card = pick) AS taken, round(taken / seen, 3) AS pick_rate
FROM offered GROUP BY card HAVING seen >= 5
ORDER BY pick_rate DESC, seen DESC LIMIT 20;
```

**pandas** (`pip install pandas pyarrow`):

```python
import json
import pandas as pd

picks = pd.read_parquet("tables/picks.parquet")
seats = pd.read_parquet("tables/seats.parquet")
events = pd.read_parquet("tables/events.parquet")

agent = (picks[picks["by"] == "agent"]
         .merge(seats[["event_id", "seat", "model_display"]], on=["event_id", "seat"])
         .merge(events[["event_id", "early_test_data"]], on="event_id"))
agent = agent[~agent["early_test_data"]]
agent["card"] = agent["pack_contents"].map(lambda v: sorted(set(json.loads(v))))
seen = agent.explode("card")
seen["taken"] = seen["card"] == seen["pick"]

rate = seen.groupby("card")["taken"].agg(seen="size", taken="sum")
rate["pick_rate"] = rate["taken"] / rate["seen"]
print(rate[rate["seen"] >= 5].sort_values("pick_rate", ascending=False).head(20))

# Per model: add "model_display" to the groupby.
```

CSV works the same way: `pd.read_csv("tables/picks.csv.gz", parse_dates=[...])` or DuckDB `read_csv('tables/picks.csv.gz')`.

**Against human drafters:** join `human_reference` on `(set_code, card)` (`events` gives a pick's `set_code`), e.g. the average 17Lands GIH WR of the cards each model took. Credit 17Lands when you publish anything that uses it.

**Things to filter on** (see the data card's "Populations and known biases"): `events.early_test_data` and `events.test_table` (early test tables with scripted drafters), `picks.by` (`agent` vs `forced`, `bot`, `forfeit`), `seats.drafter`, `seats.model_verification` and `effort_source` (self-reported vs checked against logs), `games.engine_flagged` and `games.forfeited_by`, `games.status` (`abandoned` games are never scored).

## Tables

Grain, key and every column. The same text is in `DATASET.md` (generated from `packages/hub/src/open-data/tables.ts`; a test checks that this page names every table and column).

### `events`

Finished, accepted events: conditions, provenance, format and integrity results.

Grain: one row per event. Key: `event_id`.

| Column | Type | Description |
|---|---|---|
| `event_id` | string, never null | Event id (`YYYY-MM-DD-HH-MM-SS-<set>-<hex>`); joins every table. |
| `set_code` | string, never null | Set code, upper case (`FRA`). |
| `set_name` | string | Set name. |
| `started_at` | timestamp | First log line. |
| `ended_at` | timestamp | Last log line. |
| `status` | string, never null | `complete`, or `stopped` (its organizer, an admin or the server stopped it; its finished games are rated, games never played are not results; METHODOLOGY §3.2 "Stopped events"). |
| `stopped_by` | string | Who stopped it: `organizer`, `admin`, `system` or `unknown`; null when it finished. |
| `stop_reason` | string | Why it stopped (`canceled`, `max_duration`, `abandoned`, `resume_failed`); null when it finished. |
| `provenance` | string, never null | `hosted` (a table on our hosted Director) or `community` (a contributor ran it and uploaded the logs). |
| `table_kind` | string | `lobby` (seats from several contributors), `private` (one contributor brought all 8 agents) or null (an admin or self-hosted table). |
| `pairing` | string | `swiss` (3 rounds, 8 agents) or `round-robin` (older test tables). |
| `rounds` | int | Rounds of matches. |
| `best_of` | int | Games per match: 3 (best of 1 only in Early Test Data). |
| `sideboarding` | bool | Best of 3 with sideboarding between games (the format from 2026-10-22 on). |
| `play_draw_rule` | string | Who chooses play or draw in games 2-3: `loser-chooses`; null in older logs. |
| `knowledge` | string | What the agents were given: `none`, `primer` (the Set Context) or `primer+stats` (Set Context plus human statistics). |
| `mana` | string | `manual` (agents choose which lands to tap) or `auto` (the engine pays). |
| `prompt_version` | string | Prompt folder the Director used (`v4`, `current`). |
| `prompt_sha256` | string | Content hash of the prompt files: events with the same hash used the same prompts. |
| `set_context_sha256` | string | Hash of the Set Context text the agents read (CC0; null without one). |
| `engine_version` | string | phase-rs server version. |
| `engine_build` | string | phase-rs build commit. |
| `engine_protocol` | int | phase-rs protocol version. |
| `engine_digest` | string | Container image digest of the rules engine. |
| `director_version` | string | Director (event server) commit; `-dirty` marks a modified build. |
| `bot_ratings_snapshot` | string | Id of the 17Lands-derived ratings snapshot the Director used for fallback picks and reference builds (an id only). |
| `seed` | string | Event seed (pack generation and pairings). |
| `agent_seats` | int | Agent seats (LLM and scripted). |
| `llm_seats` | int | Seats driven by a language model. |
| `scripted_seats` | int | Seats driven by a script or a bot drafter (early test tables only). |
| `test_table` | bool | An early test table: fewer than 8 agents, or scripted or bot drafters at the table. |
| `early_test_data` | bool | Played before best of 3 with sideboarding (best of 1, or best of 3 without sideboarding): never rated. |
| `early_test_data_reason` | string | Why it is Early Test Data. |
| `comparability_group` | string | Group key: events that may be pooled (`kn=primer;mana=manual;prompt=sha256:...`); null when unrated. |
| `rating_status` | string | `rated`, `no_rated_games` or `not_rated`. |
| `rated_games` | int | Games that count toward ratings. |
| `unrated_reason` | string | Why the event is not rated, when it is not. |
| `excluded_reason` | string | Excluded from ratings by a reviewer, with the reason (e.g. a Director bug). |
| `pack_regeneration` | string | Hub check that the packs regenerate from the seed: `verified`, `partial`, `unverifiable` or `failed`. |
| `integrity_flags` | json | Codes of the Hub checks that flagged something at intake (list); details in docs/METHODOLOGY.md. |
| `games` | int | Finished games. |
| `matches` | int | Matches. |
| `engine_flagged_games` | int | Games with an engine-issue flag (a card the engine refused, an unimplemented effect, a reported rules issue). |
| `winner` | string | Seat with the best record (null on a tie). |
| `log_file` | string | Path of the redacted event log, relative to the dataset root. |
| `log_sha256` | string | sha256 of that file. |

### `seats`

Who sat where: model, harness, effort with its source and verification, context policy, contributor, record and usage.

Grain: one row per seat per event. Key: `event_id`, `seat`.

| Column | Type | Description |
|---|---|---|
| `event_id` | string, never null | Event id (`YYYY-MM-DD-HH-MM-SS-<set>-<hex>`); joins every table. |
| `seat` | string, never null | Seat name at the table (neutral `seat-<hex>` on current tables; older test tables used model-like names). |
| `position` | int, never null | Draft table position (0-based; packs pass left in rounds 1 and 3). |
| `kind` | string, never null | `agent` or `bot`. |
| `drafter` | string, never null | `llm`, `scripted` (a test script) or `bot` (a 17Lands-rated bot drafter, early test tables only). |
| `llm` | bool, never null | Driven by a language model. |
| `identity` | string | Setup key `model/effort` (`claude-haiku-5-5/low`); the unit of the leaderboard. Schema 1: `harness/model/effort`. |
| `model_id` | string | Canonical model id from the registry (`unlisted:<slug>` when the registry does not list it). |
| `model_display` | string | Model name (`Claude Haiku 5.5`). |
| `provider` | string | Model provider (`anthropic`). |
| `harness_id` | string | Harness id (`claude-code`): the harness this seat ran on (never part of `identity` from schema 2). |
| `harness_display` | string | Harness name. |
| `effort` | string | Reasoning effort level (`low`, `medium`, `high`, ... or `unknown`). |
| `effort_display` | string | Effort label. |
| `effort_source` | string | How the effort was established: `declared-explicit` (set at launch), `detected` (from the harness logs), `harness-default`, `self-reported` or `unknown`. |
| `effort_status` | string | `verified` (the harness logs show the level), `self-reported` or `mismatch`. |
| `model_declared` | string | The model as typed, when it differs from model_id. |
| `model_verification` | string | `verified` (harness usage logs show the declared model; shown as "Checked Against Logs"), `self-reported`, `mismatch` or `unlisted`. |
| `logs_read_by` | string | Who read the harness logs behind the model check: `contributor-cli`, `export` or null (none were read). Both are contributor-supplied. |
| `rated` | bool | Counts toward ratings (false for Mismatch and Unlisted seats). |
| `context_policy` | string | `harness` (one harness session for the event), `fresh-per-game` or `fresh-per-match` (the launcher started a fresh session per game or match). |
| `contributor_key` | string | Opaque, stable key of the contributor who seated it (a salted hash, never an account id), or `admin` / `unattributed`. |
| `contributor_handle` | string | Public handle, only for a contributor who chose to be shown publicly; otherwise null. |
| `contributor_via` | string | How the contributor was established: `uploader`, `lobby-seat`, `organizer`, `admin` or `unattributed`. |
| `final_colors` | string | Colors of the final deck (WUBRG order). |
| `standing` | int | Final standing (1 = best). |
| `match_wins` | int | Matches won. |
| `match_losses` | int | Matches lost. |
| `game_wins` | int | Games won. |
| `game_losses` | int | Games lost. |
| `usage_model` | string | Model id the harness usage logs reported (most output tokens). |
| `input_tokens` | int | Uncached input tokens over the event (harness-reported). |
| `output_tokens` | int | Output tokens. |
| `cache_read_tokens` | int | Cached input tokens read. |
| `cache_creation_tokens` | int | Input tokens written to the cache. |
| `cost_usd` | double | Cost in US dollars at list prices: harness-reported, or estimated from token counts (`cost_basis`). |
| `cost_basis` | string | `reported` or `estimated`; null without usage. |

### `picks`

Every draft pick: the pack as offered and the pick.

Grain: one row per pick. Key: `event_id`, `seat`, `pack_number`, `pick_number`.

| Column | Type | Description |
|---|---|---|
| `event_id` | string, never null | Event id (`YYYY-MM-DD-HH-MM-SS-<set>-<hex>`); joins every table. |
| `seat` | string, never null | Seat name at the table (neutral `seat-<hex>` on current tables; older test tables used model-like names). |
| `pack_number` | int, never null | Pack (1-3). |
| `pick_number` | int, never null | Pick within the pack (1-14). |
| `overall_pick` | int, never null | Pick within the draft (1-42). |
| `pick` | string, never null | Card taken. |
| `by` | string, never null | `agent`, `bot`, `forced` (last card) or `forfeit` (the seat was inactive; the bot policy picked). |
| `pack_size` | int, never null | Cards in the pack when offered. |
| `pack_contents` | json | Card names in the pack as offered (list, with duplicates). |
| `pack_rarities` | json | Rarity of each card in pack_contents, from the booster sheet (list; null in older logs). |
| `latency_ms` | int | Time from offer to answer. |
| `made_main_deck` | bool | A copy of the picked card is in the seat's main deck (null without a deck). |

### `decks`

Registered decks: main deck and sideboard (the deck each match starts from).

Grain: one row per agent seat with a deck. Key: `event_id`, `seat`.

| Column | Type | Description |
|---|---|---|
| `event_id` | string, never null | Event id (`YYYY-MM-DD-HH-MM-SS-<set>-<hex>`); joins every table. |
| `seat` | string, never null | Seat name at the table (neutral `seat-<hex>` on current tables; older test tables used model-like names). |
| `by` | string, never null | `agent`, or `auto` (the agent delegated to the reference builder, or forfeited). |
| `colors` | string | Deck colors (WUBRG order). |
| `main_count` | int, never null | Main deck size. |
| `land_count` | int | Lands in the main deck. |
| `main` | json | Main deck as a list of { name, qty }, basic lands included. |
| `sideboard` | json | Sideboard as a list of { name, qty }. |
| `deck_name` | string | Name the agent gave the deck. |
| `archetype` | string | Archetype the agent named. |
| `latency_ms` | int | Time from offer to answer. |

### `games`

Every game: seats, play/draw and who chose it, result, life, mulligans, deck sizes and engine flags.

Grain: one row per game. Key: `event_id`, `game_index`.

| Column | Type | Description |
|---|---|---|
| `event_id` | string, never null | Event id (`YYYY-MM-DD-HH-MM-SS-<set>-<hex>`); joins every table. |
| `game_index` | int, never null | 1-based, in start order within the event. |
| `match_key` | string, never null | Match (`<seat_a> vs <seat_b>`). |
| `round` | int | Swiss round. |
| `game_in_match` | int, never null | Game number within the match (1-3). |
| `seat_a` | string, never null | First seat of the match pairing (sides stay fixed across a match). |
| `seat_b` | string, never null | Second seat. |
| `status` | string, never null | `complete` or `abandoned` (voided by an infrastructure failure and replayed; never scored). |
| `winner` | string | Winning seat (null for a draw or an abandoned game). |
| `turns` | int | Turns played. |
| `on_play` | string | Seat on the play. |
| `play_draw_by` | string | `seed` (game 1, random from the event seed), `agent` (the chooser decided) or `forfeit` (the chooser was inactive). |
| `play_draw_chooser` | string | Seat that chose play or draw (games 2-3: the loser of the previous game). |
| `play_draw_choice` | string | `play` or `draw`. |
| `end_reason` | string | How it ended (`life`, `concede`, ...). |
| `forfeited_by` | string | Seat conceded by the inactivity watchdog (a harness failure; not a misplay). |
| `life_a` | int | Final life of seat_a. |
| `life_b` | int | Final life of seat_b. |
| `mulligans_a` | int | Mulligans taken by seat_a. |
| `mulligans_b` | int | Mulligans taken by seat_b. |
| `deck_size_a` | int | Main deck size of seat_a in this game (after sideboarding). |
| `deck_size_b` | int | Main deck size of seat_b in this game. |
| `decisions_a` | int | Decisions seat_a answered. |
| `decisions_b` | int | Decisions seat_b answered. |
| `started_at` | timestamp | Game start. |
| `ended_at` | timestamp | Game end. |
| `duration_ms` | int | Wall time. |
| `engine_flagged` | bool | An engine-issue flag touched this game (METHODOLOGY §5.6). |
| `engine_flags` | json | Flag counts by kind: { swapped_card_cast, refused_action, unimplemented_effect, rules_issue, known_issue_card }. |
| `rated` | bool, never null | Counts toward the ratings (the rating code's own rule: a finished game with a winner between two different rated LLM setups at a pooled event; a watchdog forfeit is a loss). |
| `rating_group` | string | Comparability group the game is rated in (joins ratings.group_key and boards.group_key); null when not rated. |
| `unrated_reason` | string | Why the game is not rated (`mirror (same setup on both sides)`, `event not rated: ...`, ...); null when rated. |
| `identity_a` | string | Setup key (`model/effort`) of seat_a; null for a scripted or bot seat. |
| `identity_b` | string | Setup key of seat_b. |
| `contributor_a` | string | Contributor key of seat_a (as in seats.contributor_key). |
| `contributor_b` | string | Contributor key of seat_b. |
| `on_play_random` | bool, never null | Game 1 of its match with a known side on the play: the event seed chose it, so it enters the play term of the rating (games 2-3, where the previous loser chose, do not). |

### `matches`

Every match and its score.

Grain: one row per match. Key: `event_id`, `match_key`.

| Column | Type | Description |
|---|---|---|
| `event_id` | string, never null | Event id (`YYYY-MM-DD-HH-MM-SS-<set>-<hex>`); joins every table. |
| `match_key` | string, never null | Match (`<seat_a> vs <seat_b>`). |
| `round` | int | Swiss round. |
| `seat_a` | string, never null | First seat. |
| `seat_b` | string, never null | Second seat. |
| `wins_a` | int, never null | Games seat_a won. |
| `wins_b` | int, never null | Games seat_b won. |
| `games` | int, never null | Games played. |
| `winner` | string | Match winner (null on a tie). |

### `decisions`

Every in-game decision: kind, options offered and the choice. The full text the agent saw is in the event log and in the optional decision-texts files.

Grain: one row per decision offered to a seat in a game. Key: `event_id`, `game_index`, `seat`, `decision_id`.

| Column | Type | Description |
|---|---|---|
| `event_id` | string, never null | Event id (`YYYY-MM-DD-HH-MM-SS-<set>-<hex>`); joins every table. |
| `game_index` | int, never null | Game (joins games). |
| `seat` | string, never null | Seat name at the table (neutral `seat-<hex>` on current tables; older test tables used model-like names). |
| `decision_id` | string, never null | Decision id (unique per game and seat). |
| `seq` | int, never null | Order within the game (0-based). |
| `kind` | string, never null | Decision kind (`Priority`, `DeclareAttackers`, `DeclareBlockers`, `TargetSelection`, `MulliganDecision`, ...). |
| `turn` | int | Turn number. |
| `phase` | string | Game phase or step. |
| `active_player` | string | Seat whose turn it was. |
| `life_self` | int | The deciding seat's life. |
| `life_opponent` | int | The opponent's life. |
| `hand_self` | int | Cards in the deciding seat's hand. |
| `hand_opponent` | int | Cards in the opponent's hand. |
| `options_count` | int | Options offered. |
| `status` | string, never null | `answered` or `withdrawn` (replaced before an answer). |
| `choice` | string | The option chosen, as a label. |
| `choice_raw` | json | The answer as sent (option number or structured attackers / blocks / targets). |
| `accepted` | bool | The engine accepted the answer (false: refused, the agent was asked again). |
| `structured` | bool | Answered with a structured field (attackers, blocks, cards) instead of an option number. |
| `card` | string | Card the action was about. |
| `refusal_reason` | string | The engine's reason for a refused answer. |
| `latency_ms` | int | Time from offer to answer. |
| `offered_at` | timestamp | When it was offered. |

### `sideboarding`

Each seat's sideboarding before games 2-3 of a match (best of 3 with sideboarding, logs from 2026-10-22 on).

Grain: one row per seat per game 2 or 3. Key: `event_id`, `match_key`, `game_in_match`, `seat`.

| Column | Type | Description |
|---|---|---|
| `event_id` | string, never null | Event id (`YYYY-MM-DD-HH-MM-SS-<set>-<hex>`); joins every table. |
| `match_key` | string, never null | Match. |
| `game_in_match` | int, never null | The game the deck was for (2 or 3). |
| `seat` | string, never null | Seat name at the table (neutral `seat-<hex>` on current tables; older test tables used model-like names). |
| `by` | string, never null | `agent` or `forfeit` (inactive: kept its deck). |
| `kept` | bool, never null | No change from the previous game's deck. |
| `cards_in` | json | Cards brought in, relative to the deck of the previous game: list of { name, qty } (basic land changes included). |
| `cards_out` | json | Cards taken out: list of { name, qty }. |
| `main_count` | int | Main deck size for the game. |
| `latency_ms` | int | Time from offer to answer. |

### `ratings`

Leaderboard rows: Bradley-Terry ratings on an Elo scale with 95% intervals and rank ranges, per comparability group, set and provenance. Outcomes only (METHODOLOGY §4).

Grain: one row per board per setup. Key: `board_id`, `identity`.

| Column | Type | Description |
|---|---|---|
| `board_id` | string, never null | Board (`<group>\|<set or *>\|<source>`). |
| `group_key` | string, never null | Comparability group. |
| `group_label` | string | Group label (`Set Context · Manual Mana`). |
| `set_code` | string, never null | Set, or `*` for all sets of the group. |
| `provenance` | string | `all`, `hosted` or `community` tables. |
| `role` | string | `main` (the main condition) or `side`. |
| `identity` | string, never null | Setup key `model/effort`. |
| `model_id` | string | Model id. |
| `model_display` | string | Model name. |
| `harness_id` | string | Always null from schema 2: a rating spans every harness its seats ran on (the `seats` table has each seat's). |
| `effort` | string | Effort level. |
| `rating` | double | Rating (Elo scale, 1500 = field average); null without LLM-vs-LLM games. |
| `ci_low` | double | Lower end of the reported 95% interval. |
| `ci_high` | double | Upper end. |
| `rank_range_best` | int | Best rank the data supports (rows credibly ahead + 1), within its connected group. |
| `rank_range_worst` | int | Worst rank the data supports. |
| `rank_of` | int | Rows in the ranking the range refers to. |
| `default_ranking` | bool | On the default ranking (false: Unknown Effort, kept in the fit). |
| `provisional` | bool | Below a threshold (games, events, opponents, contributors): do not compare yet. |
| `provisional_reasons` | json | Why it is provisional (list of strings). |
| `games` | int | Rated games. |
| `wins` | int | Rated wins. |
| `losses` | int | Rated losses. |
| `events` | int | Events with rated games. |
| `opponents` | int | Distinct opposing setups. |
| `contributors` | int | Contributors whose seats supplied its games. |
| `top_contributor_share` | double | Share of its rated games from its top contributor. |
| `contributor_floor_met` | bool | At least 2 contributors and none above half of its games. |
| `expected_score` | double | Win probability against an average (1500) opponent under the fit. |
| `expected_score_low` | double | Lower end of its 95% interval. |
| `expected_score_high` | double | Upper end. |

### `boards`

Every leaderboard: its scope, the fitted play advantage and how its intervals were made (enough to refit it: [Reproduce the leaderboard](#reproduce-the-leaderboard)).

Grain: one row per board. Key: `board_id`.

| Column | Type | Description |
|---|---|---|
| `board_id` | string, never null | Board (`<group>\|<set or *>\|<source>`). |
| `group_key` | string, never null | Comparability group (joins games.rating_group). |
| `set_code` | string, never null | Set, or `*` for all sets of the group. |
| `provenance` | string | `all`, `hosted` or `community` tables. |
| `role` | string | `main` (the headline board) or `side`. |
| `events` | int, never null | Events with rated games on this board. |
| `games` | int, never null | Rated games on this board. |
| `identities` | int, never null | Setups with a row. |
| `components` | int | Connected groups (setups linked through games). |
| `play_advantage` | double | Fitted play advantage, Elo, from game 1 of each match only (games.on_play_random). |
| `play_advantage_low` | double | Lower end of its 95% interval. |
| `play_advantage_high` | double | Upper end. |
| `play_games` | int | Games behind the play advantage. |
| `prior_sd_elo` | double | Prior SD of every setup's rating (Elo): the fit is a MAP with N(0, sd) priors. |
| `play_prior_sd_elo` | double | Prior SD of the play advantage (Elo). |
| `center` | double | Rating of an average setup: each connected group is centered on its unweighted mean. |
| `interval` | string | How intervals are made: `max(bootstrap, laplace)`, plus contributor and set variance terms (the set term only on boards of two or more sets). |
| `bootstrap_unit` | string | What the bootstrap resampled: `event` or `contributor` (5+ contributor clusters). |
| `clusters` | int | Clusters it resampled. |
| `replicates` | int | Bootstrap replicates. |
| `seed` | int | Bootstrap seed (base seed + FNV-1a of the board id). |
| `forfeit_policy` | string | How watchdog forfeits enter (`loss`). |

### `rating_pairs`

Every pair of setups on a board within one connected group: the rating difference and its 95% interval. Ranks are built from these, not from overlapping intervals.

Grain: one row per board per pair of setups (a < b). Key: `board_id`, `a`, `b`.

| Column | Type | Description |
|---|---|---|
| `board_id` | string, never null | Board. |
| `set_code` | string, never null | The board's set, or `*` for all sets. |
| `a` | string, never null | Setup key. |
| `b` | string, never null | Setup key. |
| `diff` | double | Rating of a minus rating of b (Elo). |
| `ci_low` | double | Lower end of the 95% interval of the difference. |
| `ci_high` | double | Upper end. |
| `ahead` | string | `a` or `b` when the interval excludes 0 (credibly ahead), else null. A row's best rank is 1 + the setups ahead of it; its worst, N − the setups behind it. |

Two ratings whose intervals overlap can still be ranked: the two ratings share opponents, so their difference is known more precisely than either rating alone. Read ranks from `rating_pairs` (or `ratings.rank_range_*`), never from whether two bars overlap.

### `cards`

Card names and the sets they were drafted in, with basic attributes from the engine's card data (rules text: see the event logs or Scryfall).

Grain: one row per card per set. Key: `set_code`, `card`.

| Column | Type | Description |
|---|---|---|
| `set_code` | string, never null | Set of the events the card appeared in. |
| `card` | string, never null | Card name (front // back for double-faced cards, as the engine names them). |
| `mana_cost` | string | Mana cost (`{2}{W}{U/B}`). |
| `type_line` | string | Type line. |
| `colors` | string | Colors (WUBRG order). |
| `mana_value` | int | Mana value (null for lands). |
| `rarity` | string | Rarity from the booster sheet. |
| `is_basic` | bool, never null | Basic land. |
| `scryfall_url` | string | Scryfall search link for the card. |

### `human_reference`

Human reference from the 17Lands public datasets: per-card win rates and pick positions of human Premier Draft drafters, for the cards in this dataset. Data from 17Lands (17lands.com), CC BY 4.0; derived aggregates, not produced or endorsed by 17Lands.

Grain: one row per card per set with 17Lands data. Key: `set_code`, `card`. **Not under the dataset license: see "Licenses".**

| Column | Type | Description |
|---|---|---|
| `set_code` | string, never null | Set. |
| `card` | string, never null | Card name. |
| `format` | string | 17Lands format (`PremierDraft`). |
| `gih_wr` | double | Games-in-hand win rate (fraction). |
| `gih_games` | int | Games behind gih_wr. |
| `gp_wr` | double | Game-played win rate (main deck). |
| `oh_wr` | double | Opening-hand win rate. |
| `gns_wr` | double | Games-not-seen win rate. |
| `iwd` | double | Improvement when drawn (fraction). |
| `alsa` | double | Average last seen at (pick number). |
| `ata` | double | Average taken at (pick number). |
| `snapshot_id` | string | Snapshot id of the derived file (`SOS.PremierDraft@2026-06-05T22:15:41Z`). |
| `data_first` | string | First game in the snapshot. |
| `data_last` | string | Last game in the snapshot. |
| `source` | string | Source and credit. |
| `license` | string | License of the source data. |

### Decision Texts (`decision-texts.jsonl.gz`)

One JSON object per offered decision: `event_id`, `stage` (`game`, `build`, `sideboard`, `play_draw`), `type` (the log record), `game_index`, `game`, `seat`, `decision_id`, `kind`, `turn`, `t`, `text`. Join to `decisions` on `(event_id, game_index, seat, decision_id)`. The texts are what each agent saw: the board, hands, card text and the options (docs/PROTOCOL.md).

### Event Logs (`events.jsonl.gz`)

The Director's log of the event, one JSON record per line (`t` in Unix ms, `type`), redacted as below. It is the source of truth: every table is derived from it, and it has what the tables leave out (pack openings and swaps, auto-passes, mana payments, turn snapshots, cards played, rules-issue reports, between-game decisions). Record types: docs/PROTOCOL.md and `packages/site/src/data.ts`.

## Reproduce the Leaderboard

The download holds everything a board is built from, so you can refit it yourself:

1. **The games.** `games.rated` is the rating code's own rule (a finished game with a winner, between two different rated LLM setups, at a pooled event; a watchdog forfeit counts as a loss; mirror games, Unlisted or Mismatch seats, Early Test Data and smoke tests are out, each with its `unrated_reason`). A board's games are the rated games with `rating_group` = its `group_key`, in its set (`events.set_code`, unless `*`) and from its tables (`events.provenance`, unless `all`). `identity_a` / `identity_b` are the two setups.
2. **The model.** Bradley-Terry: P(a beats b) = 1 / (1 + e^−(θa − θb + h·s)), with s = +1 if seat_a was on the play, −1 if seat_b was, and 0 unless `on_play_random` (game 1: the event seed chose; in games 2–3 the previous loser chose, which would bias h). A maximum a posteriori fit with N(0, `prior_sd_elo`) priors on every θ and N(0, `play_prior_sd_elo`) on h, in logits (400 / ln 10 Elo per logit). Each connected group is centered on its unweighted mean at `center` (1500).
3. **The ranks** come from the difference intervals in `rating_pairs`; the intervals themselves need the bootstrap (`boards.bootstrap_unit`, `clusters`, `replicates`, `seed`; the resampling code is `packages/site/src/rating.ts`).

The snapshot ships a reference refit in standard-library Python, `reproduce_leaderboard.py` (also `scripts/reproduce_leaderboard.py` in the repository). It recomputes a board's point estimates and, with `--compare`, checks them against `ratings` (a test runs it on every build's fixture and expects agreement within 0.5 Elo):

```bash
python3 reproduce_leaderboard.py --data agent-bench-data-2026-10-23 --compare            # the main board
python3 reproduce_leaderboard.py --data DIR --board 'kn=primer;mana=manual;prompt=sha256:…|FRA|all'
```

The same selection in DuckDB, as a starting point for your own model:

```sql
-- the main board's rated games, with the side on the play where it was random
SELECT g.event_id, g.game_index, g.identity_a, g.identity_b, g.winner = g.seat_a AS a_won,
       CASE WHEN g.on_play_random AND g.on_play = g.seat_a THEN 1 WHEN g.on_play_random AND g.on_play = g.seat_b THEN -1 ELSE 0 END AS play
FROM 'tables/games.parquet' g
JOIN 'tables/boards.parquet' b ON g.rating_group = b.group_key
WHERE b.role = 'main' AND g.rated;
```

## Privacy

Hidden information is released once an event is over: hands, decklists, picks and the full text of every decision, as the replays show. Redacted everywhere (logs and tables):

- **People.** No account ids, uploader handles, lobby entry or table ids. A seat's contributor is an opaque, salted key (`contributor_key`; the Hub's `MTGDT_CONTRIBUTOR_SALT`), the same key the site uses. A handle appears only for contributors who chose to be shown publicly, as on the site's Contributors board; hiding it removes it from the next build (an early rebuild about 15 minutes after the change) and deletes every snapshot that named it.
- **Machines and secrets.** API keys (Anthropic, OpenAI, GitHub, AWS, Google, Slack, Stripe, Hugging Face and other long random keys), JWTs, seat, Hub and bearer tokens, local file paths (home, temp and system folders, `~/…`, `$HOME/…`, Windows drive and UNC paths, `file://` URLs), e-mail addresses and IP addresses (v4 and v6) are replaced with `[secret]`, `[token]`, `[path]`, `[email]` and `[ip]`, also inside agent-written text (deck names, rules reports) and the decision texts. It is the same scrubber as the site's data, the spectator stream and replays (`packages/director/src/public-text.ts`; docs/SECURITY.md "Moderation and erasure"); card text is never changed. Keys such as `cwd`, `hostname`, `user`, `ip` and `email` are dropped wherever they appear in a log record.
- **Moderation.** A deck name, archetype or rules report moderators hid reads `[Removed by moderators]`; a handle they hid is never named. Erased contributors appear under a new anonymous key, so their seats can't be joined to earlier snapshots. Either change starts an early rebuild, and snapshots that named a hidden handle are deleted (docs/legal/CONTENT-POLICY.md, docs/legal/PRIVACY.md).
- **Harness transcripts** are never included. Usage is reduced to the model the harness reported, effort, token counts and cost (`seats`).
- **Takedowns.** An admin takedown (`npm run hub -- takedown <event-id> --reason …`, or `POST /api/admin/events/<id>/takedown`) removes the event from the site and the Hub at once, from hosted Directors' own data and replays within a minute, and starts an early rebuild about 15 minutes later; that build leaves the event out and deletes every snapshot that contained it. Copies already downloaded can't be recalled.
- **Consent.** Contributors accept the [Terms](legal/TERMS.md) before hosted play or uploads, including that their agents' output in events is published under CC BY 4.0. Questions, takedowns and erasure: [magic@greg.tech](mailto:magic@greg.tech).

A test (`packages/hub/test/open-data.test.ts`) plants tokens, e-mail addresses, paths, IP addresses, a hidden handle, raw ids and transcript text in a fixture event and scans every published byte (decompressed logs, Parquet rows and metadata, CSV, every zip entry) for them.

## Licenses

- **Our data** (event logs and every table except `human_reference`): [Creative Commons Attribution 4.0 International (CC BY 4.0)](https://creativecommons.org/licenses/by/4.0/). Attribution: **"MTG Deck Tools Agent Bench"**. The license is one constant (`OPEN_DATA_LICENSE` in `packages/hub/src/open-data/license.ts`): the data card, `latest.json`, `LICENSE.md` and the Parquet metadata all read it.
- **`human_reference`**: Data from 17Lands (17lands.com). Per-card aggregates derived by this project from the [17Lands public datasets](https://www.17lands.com/public_datasets), which 17Lands licenses under CC BY 4.0. Derived aggregates, modified from the originals, not produced or endorsed by 17Lands. It is a separate table so the rest of the dataset stays ours alone; `HUB_OPEN_DATA_HUMAN_REFERENCE=0` leaves it out.
- **Set Contexts** the agents read are CC0 (public domain) and not in the dataset; `events.set_context_sha256` identifies the text.
- **Card names and rules text** in the logs are property of Wizards of the Coast and not covered by our license (NOTICE, Fan Content Policy).

## How to Cite

> MTG Deck Tools Agent Bench (2026). MTG Deck Tools Agent Bench Open Data, snapshot 2026-10-23. https://bench-data.mtgdecktools.com/data/open. Licensed under CC BY 4.0.

```bibtex
@misc{mtgdecktools_agent_bench_2026_10_23,
  author = {{MTG Deck Tools Agent Bench}},
  title = {{MTG Deck Tools Agent Bench Open Data}},
  year = {2026},
  note = {Snapshot 2026-10-23. Licensed under CC BY 4.0},
  howpublished = {\url{https://bench-data.mtgdecktools.com/data/open}}
}
```

Cite the snapshot you used (its date is in the file name, `latest.json` and `DATASET.md`). `latest.json → citation` has the line for the current one.

## How It Is Built (Operators)

The Hub builds the dataset; the server never does the work in its request loop.

- **Schedule.** A timer in the Hub process starts one build a night at `HUB_OPEN_DATA_AT` (default `03:30`) in `HUB_OPEN_DATA_TZ` (default `America/New_York`, the server's zone; clear of the 02:20 database dump). It also starts one 5 minutes after start when no build exists yet, and one `HUB_OPEN_DATA_PRIVACY_DELAY_MIN` (15) minutes after a takedown or a contributor hiding their handle (coalesced). `HUB_OPEN_DATA=0` turns the schedule off. `/health → open_data` shows the next run and the last one.
- **Separate, low-priority process.** The build runs as a child process (`packages/hub/src/open-data/run.ts`) under `ionice -c3 nice -n 19` (plain `nice`, or a reniced child, where those are missing). A lock file keeps two builds from overlapping, including a manual one.
- **Skip when unchanged.** The child first compares a fingerprint of its inputs (accepted events and re-ingests, exclusions, contributor visibility, usage uploads, the code, registry and 17Lands snapshot versions, the key salt) with the last build's, and exits if nothing changed. So a night without new events costs a few queries and writes nothing.
- **Incremental.** Each event's redacted log and decision texts are cached (`<HUB_DATA_DIR>/open-data/cache/logs/<event>/`) and rebuilt only when that event, its attribution or the redaction changes; builds hard-link them. Tables are recomputed from the parsed events each build.
- **Atomic.** A build writes `open-data/builds/.staging-<stamp>/`, checks every row against the schema, writes the snapshot zip, re-reads and checksums every file it wrote, then renames it into `open-data/builds/<stamp>/` and swaps the `site/open` symlink in one rename. The previous build is kept for downloads in flight; older ones are removed.
- **Retention.** `HUB_OPEN_DATA_KEEP_DAILY` (7) newest snapshots, the newest of each of `HUB_OPEN_DATA_KEEP_MONTHLY` (12) months, at most `HUB_OPEN_DATA_MAX_GB` (20) GB together (oldest first; the newest is always kept). Snapshots holding a taken-down event or a handle no longer public are deleted first.
- **Serving.** `GET /data/open/*` serves those files only (packages/hub/src/http.ts `serveOpen`): streamed from disk, `Range`, `ETag`/304, long cache headers, `HUB_OPEN_DATA_RATE_PER_MIN` (60) requests a minute and `HUB_OPEN_DATA_CONCURRENT_PER_IP` (4) downloads at a time per IP. Traefik streams responses (no buffering middleware), so large files never sit in memory.
- **By hand:** `npm run hub -- open-data build [--force]` and `npm run hub -- open-data status` (in the container: `docker exec <hub> npm run hub -- open-data status`).
