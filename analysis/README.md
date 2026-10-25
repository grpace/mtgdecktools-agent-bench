# analysis/ — context-aware draft evaluation

This package builds the optional **human-reference layer** of the benchmark ("Compared with human drafters", METHODOLOGY §5.1–5.2) from 17Lands public datasets. Nothing that ranks agents depends on it: the rating, play, mana, reliability, build sanity and the core draft metrics need only game results, card data and the logs, and work for every set. The card-quality heuristic used by the core metrics is checked against human win rates in `results/card-quality.md`.

Python package `draft_eval` (run with `uv`). It does four things:

1. **Archetype ratings.** From 17Lands game data it builds per-card ratings inside each color pair, shrunk toward the card's overall rating, plus deck-shape norms per archetype. Output: `sets/<SET>/17lands-archetypes.json`.
2. **Expert pick model.** A conditional-logit model of what strong 17Lands drafters pick from a pack, given their pool and the pick number. Trained per set. Outputs: `analysis/models/<SET>.json` and `analysis/results/validation-<SET>.json`.
3. **Run scorer.** It replays every seat's draft from `runs/<id>/events.jsonl` and scores each pick in context. Output: `runs/<id>/draft-eval.json`. A cross-event summary goes to `analysis/results/agent-draft-scores.json`.
4. **Build quality** (METHODOLOGY §5.2). It validates the archetype deck-quality score on held-out 17Lands games and writes per-pair norms of winning human decks. Outputs: `sets/<SET>/deck-norms.json` (read by `packages/site/src/build-quality.ts`), `analysis/results/build-quality.md`, `build-quality-<SET>.json`, and `noise-17lands.json` (game-level noise for the rating calibration in `analysis/results/calibration.md`).

Raw overall GIH WR agreement is only the naive baseline. Whether a pick is good depends on:
- the drafter's colors and how committed they are;
- curve and creature needs;
- duplicates;
- the pick number;
- what is flowing.

The model and scorer put all of these into the evaluation.

## Regenerate

```bash
cd analysis
uv sync
uv run python -m draft_eval prepare                 # 17Lands CSV.gz -> typed parquet cache (streaming, ~1 GB RAM, ~5 s/file)
uv run python -m draft_eval archetypes              # all sets, ~30-80 s each  -> sets/<SET>/17lands-archetypes.json
uv run python -m draft_eval train                   # all sets, ~2-3 min each  -> analysis/models, analysis/results
uv run python -m draft_eval score ../runs/<event>   # -> runs/<event>/draft-eval.json
uv run python -m draft_eval batch --extra ../tmp/smoke-runs/<run> ...   # all of runs/ + extras
uv run python -m draft_eval.report                  # markdown tables used below
uv run python -m draft_eval buildeval               # all sets, ~15-70 s each -> sets/<SET>/deck-norms.json, analysis/results/build-quality*.md|json
                                                    # (run after `archetypes`: the norms file records which archetypes file it matches)
uv run python -m draft_eval pipeline FRA KHM --json /tmp/status.json   # prepare -> archetypes -> train -> buildeval for each set,
                                                    # skipping outputs below the set-level thresholds (see below)
```

`scripts/draft-eval.sh <command> ...` does the same from the repo root. Normally you don't run these by hand: `npm run deps -- update 17lands` (docs/UPGRADING.md) downloads the 17Lands files, builds the card ratings, runs `pipeline` for each changed or new set, deletes the raw files and records everything in `deps/manifest.json`.

- **Sets:** the default list is every set with a 17Lands snapshot in `deps/manifest.json` (`config.sets()`); nothing is hardcoded. `sets/README.md` lists the covered sets. Name sets explicitly to run a subset (`archetypes FRA TLA`).
- **Set codes and formats:** sets are phase-rs codes (the `sets/<SET>/` directories). The raw file names use the 17Lands code and format recorded in `sets/<SET>/17lands.json` (`source_code`, `format`; mapping in `deps/set-codes.json`). Every covered set has PremierDraft data; a TradDraft-only set would work the same way, except that "winning deck" (≥ 6 game wins) means something different in best-of-three.
- **Set-level thresholds** (`config.py`): an output whose sample would be meaningless is not written, and the reason is recorded in the manifest (`17lands.sets.<SET>.skipped`):
  - archetype ratings: at least 20,000 game rows (`MIN_GAMES_ARCHETYPES`);
  - expert pick model: draft data with player-skill columns and at least 1,000 expert drafts (`MIN_EXPERT_DRAFTS`);
  - build-quality norms: archetype ratings and at least 5,000 decks (`MIN_DECKS_BUILDEVAL`).
- **Training options:** `train --max-drafts N` (default 8000 expert drafts per set), `--seed`.
- **Paths:** set by environment variables (see `draft_eval/config.py`):

| Variable | Default |
|---|---|
| `DRAFT_EVAL_DATA` | `data/` |
| `DRAFT_EVAL_17L` | `data/17lands/` |
| `DRAFT_EVAL_CACHE` | `data/17lands/parquet/` |
| `DRAFT_EVAL_SETS` | `sets/` |
| `DRAFT_EVAL_MODELS` | `analysis/models/` |

**Inputs:**
- 17Lands `game_data_public.<SET>.PremierDraft.csv.gz` and `draft_data_public.<SET>.PremierDraft.csv.gz`.
- `sets/<SET>/17lands.json` (ATA, and the naive GIH used by the existing `scripts/compare-events.py`).
- phase-rs `data/card-data.slim.json` (mana costs, types, oracle text).
- `data/draft-pools.json` (rarity, cmc).

The parquet cache and `.venv` are not committed. Models are small JSON files (about 10 KB per set) and are committed.

## Data findings

- **Draft data** (one row per pick):
  - Columns: `draft_id, rank, event_match_wins/losses, pack_number, pick_number` (both 0-based), `pick`, `pick_2` (almost always empty), `pick_maindeck_rate`, `pick_sideboard_in_rate`, `user_n_games_bucket` (1/5/10/50/100/500), `user_game_win_rate_bucket` (0.02 steps).
  - Per card: `pack_card_<name>` (counts in the pack) and `pool_<name>` (counts in the pool before the pick).
  - Packs have 14 picks (13 in ECL and EOE). TMT and TLA drafts have 41 rows: one pick is missing from every draft, and the pool columns still reconstruct correctly.
- **Game data** (one row per game):
  - Columns: `main_colors`, `splash_colors`, `won`, `on_play`, `num_mulligans`, `build_index`, the user buckets, and per card `deck_ / sideboard_ / opening_hand_ / drawn_ / tutored_`.
  - EOE writes some counts as `0.0`, so the parquet conversion reads counts as floats and casts them to int8.
- **Older files** (2021 sets, re-exported January 2024: AFR, KHM, MID, STX, VOW) are gzipped tar archives holding the CSV (`prepare` unpacks them). Their game files name the skill bucket `user_win_rate_bucket` (renamed to `user_game_win_rate_bucket` on conversion) and have no `match_number`; STX and KHM have no `main_colors`; their draft files bucket skill by match win rate (`user_match_win_rate_bucket`, `user_n_matches_bucket`), so the expert definition below doesn't apply and no pick model is trained for them.
- **Expert definition:** `user_n_games_bucket >= 50` **and** `user_game_win_rate_bucket >= 0.60`.
  - That is the top ~16-22% of drafts, depending on the set. The population baseline is 0.55-0.56.
  - We use the drafter's long-run game win rate, not the outcome of this draft. `event_match_wins` would select on luck and on the picks being evaluated.
  - The `>= 50 games` floor removes buckets whose win rate rests on a handful of games.
  - Expert drafts in FRA average 3.8 match wins against 2.8 for everyone.

The table covers the first nine sets; every set's numbers are in `analysis/results/validation-<SET>.json` and in `deps/manifest.json` (`17lands.sets.<SET>.analysis`).

| Set | Expert / all drafts | Used for training (80/20 by draft hash) | Game rows |
|---|---|---|---|
| FRA | 9,129 / 56,527 | 8,000 | 297,964 |
| HOB | 11,127 / 58,017 | 8,000 | 323,114 |
| MSH | 14,104 / 68,633 | 8,000 | 377,514 |
| SOS | 20,083 / 107,502 | 8,000 | 582,914 |
| TMT | 6,997 / 32,151 | 6,997 | 180,204 |
| ECL | 15,944 / 99,290 | 8,000 | 536,566 |
| TLA | 20,984 / 102,793 | 8,000 | 562,924 |
| EOE | 18,120 / 104,377 | 8,000 | 563,418 |
| FIN | 25,928 / 140,237 | 8,000 | 769,659 |

**Archetype effects are real but small after shrinkage.**
- The method-of-moments prior is worth about 500-1,700 GIH games per card × archetype cell. That implies a between-archetype SD of a card's lift of about 1.2-2.2 points.
- Some cards still swing by 4-7 points with thousands of games in each cell:

| Set | Card | Shrunk GIH WR |
|---|---|---|
| TLA | Ran and Shaw | 62.7% in UR vs 56.6% in WR |
| FRA | Way of the Healer | 61.8% in WU vs 55.1% in WG |
| FRA | Room of Refuge | 59.5% in UB vs 54.8% in RG |

- Color pairs differ by up to about 7 points in baseline win rate. For example, MSH WU wins 58.8% (24% of games) and MSH BR wins 51.8%.

**Basic lands have a high GIH WR** (FRA Forest 55.7%, above the 55.4% baseline). Anything that ranks cards by raw GIH, including the naive regret metric, therefore treats a basic land as a decent pick. The Director's bots pick basics: 126 of 2,778 bot picks (4.5%) in the 11 scored events, 92 of them at pick 9 or earlier. LLM agents took none. That is a bot bug (in `packages/director`, not fixed here).

## 1. Archetype ratings: `sets/<SET>/17lands-archetypes.json`

**Buckets** are taken from `main_colors`:
- the 10 color pairs;
- mono-color (`W` … `G`);
- each 3-color combination with at least 1% of games;
- `3c+` for the rest.

Splashes count toward the main colors. They are reported in `archetypes[b].splash_share` and in a per-card `splash` block.

**Rates.** For each card × bucket the code counts GIH games (in opening hand or drawn), GP games (in the main deck) and GNS games (in the deck, never seen). Each rate is shrunk with an empirical-Bayes beta prior:

```
prior_mean[c,b] = R_c - offset_c + base_b
    R_c      = card's overall rate (itself shrunk toward the set baseline)
    base_b   = bucket win rate
    offset_c = Σ_b n[c,b]·base_b / n_c        (the bucket mix behind R_c)
posterior    = (wins + k·prior_mean) / (n + k)   with k estimated per set & metric
```

`iwd = shrunk GIH − shrunk GNS`. A cell is listed only if the card was in at least 50 main decks of that bucket. Otherwise use the prior.

**Schema (top level):**
- `set, format, source, license_note, generated_at, generator`
- `games, baseline_win_rate`
- `shrinkage: {gih|gp|gns: {overall_k, archetype_k}}`
- `by_archetype_fields: ["gih_wr","gih_games","gp_wr","gp_games","iwd","gih_wr_raw"]`
- `archetypes: {<bucket>: {...}}`, where each bucket has:
  - `games`, `share`, `win_rate`, `splash_share`
  - `deck_shape_all` and `deck_shape_winners`, each with:
    - `decks, games, win_rate`
    - `lands_p25_p50_p75`, `nonbasic_lands_mean`
    - `creatures_p25_p50_p75`, `noncreature_spells_p25_p50_p75`
    - `avg_mv_nonland_mean`
    - `curve_mean: {"0-1","2","3","4","5","6+"}`
  - `win_rate_by_lands: {"<=15","16","17","18+": {games, win_rate}}`
  - `win_rate_by_creatures: {"<=11","12-13","14-15","16-17","18+": {...}}`
- `cards: {<name>: {...}}`, where each card has:
  - `colors, mv, type, rarity`
  - `overall: {gih_wr, gih_games, gp_wr, gp_games, iwd}`
  - `splash: {gp_games, gp_wr_raw, gih_games, gih_wr_raw} | null`
  - `by_archetype: {<bucket>: [gih_wr, gih_games, gp_wr, gp_games, iwd, gih_wr_raw]}`

Deck stats are for build evaluation:
- **Decks:** a deck is one `(draft_id, build_index)` with 38-45 cards.
- **Winners:** decks with at least 6 recorded game wins (near-trophy in Bo1 PremierDraft).

Example from FRA WU winners: 17 lands (p25-p75 17-17), 13 creatures (11-15), curve 1.4 / 8.9 / 5.8 / 4.0 / 1.5 / 1.7.

## 2. Expert pick model: `analysis/models/<SET>.json`

```
P(pick = c | pack, pool, t) = softmax over distinct cards in the pack of  u_c = x_c · β  (+ a_c)
```

### Lane model

This model is shared by the features and the scorer (see `features.py`).

- **Card value per pair.** For each card c and color pair P:
  - `val[c,P]` is the archetype rating above.
  - `cast[c,P]` is 1 if castable in P, 0.35 if splashable (exactly one off-color pip), and 0 otherwise. Hybrid and phyrexian costs are handled.
  - `repl[P]` is replacement level: the 25th percentile of `val` among castable non-land cards.
  - `lane_value = repl + cast·max(0, val − repl)`. Basics always get `repl`.
- **The drafter's lanes.** `w = softmax(λ·Σ_pool (lane_value − repl) + log share_P)`. An empty pool gives the population's archetype mix, and `w` sharpens as the pool commits.
  - λ is chosen per set from {3, 8, 15, 30, 60}: the value that minimizes the NLL of the archetype-aware baseline on a 40k-pick sample of the training split.
  - Chosen λ: 30 for most sets, 15 for HOB and SOS, 60 for EOE.
- **Context value.** `ctx_wr[c] = Σ_P w_P·lane_value[c,P]` is the archetype-aware GIH, in win-rate units.

### Features

`t` is the overall pick position scaled to 0..1. Features are standardized.

| Feature | Meaning |
|---|---|
| `gih`, `gih_x_t` | overall shrunk GIH lift (and its decay with pick number) |
| `ata`, `ata_x_t` | 17Lands average taken-at (population pick order) |
| `ctx`, `ctx_x_t` | archetype-aware value `ctx_wr` |
| `fit`, `fit_x_t` | `Σ_P w_P·cast[c,P]`: probability the card is castable in the drafter's lane |
| `offpip_x_t` | hard pips in colors the pool hasn't committed to |
| `gold`, `gold_x_t` | multicolor flexibility cost |
| `creature_need` | creature × (0.45·on-lane pool − on-lane creatures) |
| `cheap_need` | ≤2-MV × (0.25·on-lane pool − on-lane ≤2-drops) |
| `topend_excess` | ≥5-MV × (on-lane 5+ drops − 0.12·on-lane pool) |
| `dup`, `dup_x_legend` | copies already in the pool |
| `land`, `land_x_fit`, `basic` | nonbasic lands and fixing; basic lands |
| `rare`, `rare_x_t` | rare/mythic (Arena rare-drafting) |
| `unrated` | card has no 17Lands data (rarity-mean fallback) |

### Variants

| Variant | What it contains | What it is used for |
|---|---|---|
| `model_context_plus_card` (the **expert model**) | all features + per-card intercepts `a_c` (L2) | behavioral agreement: `p_pick`, rank, log-likelihood |
| `model_value` | only win-rate-derived ratings + pool context (no ATA, rarity or intercepts) | **EV regret**. It cannot reward human habits that aren't about winning, such as rare-drafting and popularity |
| `model_context` | all features, no intercepts | reported for comparison |
| `ablation_card_no_context` | intercepts + overall ratings, no pool features | measures how much context adds |

### Validation

Held-out expert drafts (20% by draft-id hash, about 60-70k picks per set). Each cell is **top-1 / top-3 / NLL**. The table covers the first nine sets; `analysis/results/validation-<SET>.json` has every set. Baselines are a softmax of the score with a temperature fitted on the training split. The `gih_overall` baseline excludes basics; with them included it is worse.

| Set | random | GIH overall | ATA | GIH archetype-aware | card, no context | value model | context model | **expert model** |
|---|---|---|---|---|---|---|---|---|
| FRA | .217/.492/1.80 | .455/.786/1.45 | .469/.810/1.39 | .515/.824/1.34 | .501/.827/1.31 | .551/.861/1.20 | .608/.897/1.05 | **.627/.908/0.997** |
| HOB | .270/.568/1.80 | .468/.802/1.45 | .478/.821/1.36 | .560/.845/1.25 | .507/.837/1.30 | .599/.879/1.12 | .632/.913/1.00 | **.653/.923/0.936** |
| MSH | .260/.540/1.80 | .468/.790/1.46 | .483/.820/1.36 | .518/.821/1.35 | .517/.836/1.29 | .570/.867/1.17 | .613/.902/1.04 | **.629/.910/0.992** |
| SOS | .237/.512/1.80 | .442/.779/1.49 | .457/.794/1.42 | .550/.841/1.27 | .488/.816/1.35 | .595/.884/1.12 | .628/.914/1.00 | **.650/.926/0.937** |
| TMT | .253/.549/1.77 | .464/.803/1.41 | .480/.828/1.35 | .510/.824/1.36 | .511/.846/1.28 | .558/.864/1.20 | .598/.897/1.07 | **.623/.907/1.007** |
| ECL | .230/.545/1.71 | .407/.759/1.52 | .449/.802/1.41 | .533/.830/1.26 | .465/.814/1.37 | .588/.880/1.13 | .618/.911/1.01 | **.639/.917/0.969** |
| TLA | .258/.518/1.78 | .448/.778/1.48 | .464/.808/1.39 | .517/.819/1.34 | .493/.824/1.32 | .568/.862/1.18 | .613/.899/1.04 | **.628/.909/0.996** |
| EOE | .258/.568/1.74 | .444/.790/1.47 | .467/.822/1.37 | .549/.842/1.23 | .493/.840/1.30 | .598/.887/1.11 | .643/.923/0.95 | **.653/.928/0.921** |
| FIN | .222/.506/1.80 | .434/.777/1.50 | .438/.788/1.45 | .527/.819/1.34 | .482/.819/1.35 | .560/.855/1.22 | .604/.893/1.07 | **.622/.905/1.023** |

**Context is most of the gain.**
- Adding pool context to ratings raises top-1 from about 45% (overall GIH) to about 52-56% (archetype-aware GIH, no fitting) and about 55-60% (value model).
- Per-card intercepts without context only reach 47-52%.

**Per pick phase (FRA, top-1 / NLL):**

| | picks 1-5 | picks 6-9 | picks 10+ |
|---|---|---|---|
| GIH overall | .364 / 1.92 | .345 / 1.68 | .635 / 0.81 |
| GIH archetype-aware | .426 / 1.72 | .447 / 1.52 | .659 / 0.81 |
| value model | .458 / 1.60 | .469 / 1.39 | .711 / 0.66 |
| expert model | .561 / 1.27 | .549 / 1.19 | .756 / 0.57 |

**Non-expert drafts are less predictable.** On 800 non-expert drafts per set, the expert model's top-1 is 0.59-0.62, against 0.62-0.65 on held-out experts.

**FRA coefficients (standardized, expert model):**

| Coefficient | Value | Reading |
|---|---|---|
| `fit` | +1.27 | lane fit matters most |
| `ata` | −1.53 | taken earlier by the population → more likely |
| `gih` | +0.61 | overall rating |
| `ctx` | +0.41 | archetype-aware value |
| `gold` | +0.40 | |
| `basic` | −1.11 | |

- `gih_x_t` is negative: raw power matters less as the draft goes on.
- The curve and creature-need terms are small (|β| < 0.12). Either the strong drafters' picks barely react to curve within a draft, or our proxies are too coarse. Treat curve as a build-stage metric, not a pick-stage one.

## 3. Run scorer: `runs/<id>/draft-eval.json`

`score` replays each seat's picks in order (pool = picks so far) and featurizes every pack with the set's model. Each seat (agents and bots) gets the fields below. Runs without a complete draft are skipped.

**Per pick (`seats[s].picks[]`):**

| Field | Meaning |
|---|---|
| `p_pick`, `logp`, `rank`, `n_options` | expert-model probability and rank of the actual pick |
| `model_top`, `p_model_top`, `regret_model_logit` | expert model's choice; utility gap (behavioral) |
| `value_top`, `value_rank`, `regret_value_logit` | **context-aware EV regret** in model-value units (value model) |
| `ctx_wr_pick`, `ctx_best`, `regret_ctx_wr_pts` | **context-aware regret in win-rate points**: max over the pack of `ctx_wr` − the pick's `ctx_wr`, with lane weights from the pool *before* the pick |
| `regret_ctx_wr_pts_vs_model_top` | same, measured against the expert model's top card |
| `gih_pick`, `naive_best`, `naive_regret_gih_pts` | naive baseline: max overall GIH in the pack − the pick's (same as `scripts/compare-events.py`) |
| `in_final_colors` | castable in the final main colors (deck colors for agents; leading pair of the final pool for bots) |
| `made_deck` | this copy is in the submitted main deck (agents) |
| `wasted` | off the final colors (or a basic) while the pack had a castable, above-replacement card in the final lane |
| `unplayed_with_alternative` | agents only: not in the main deck while such an alternative existed |
| `lane_before`, `lane_conf_before`, `note` | leading lane and its weight before the pick; the agent's note |

**Seat summary (`seats[s].summary`, and `by_phase` for p1-p3 × early (picks 1-5) / mid (6-9) / late (10+)):**
- `mean_logp`, plus `mean_logp_floored` (each pick floored at log 0.01, so one absurd pick can't dominate) and `random_mean_logp` (uniform over the pack) for reference.
- `median_p_pick`.
- `flagged_rate`: share of picks with p < 5%.
- `top1_agree`, `top3_agree`, `value_top1_agree`.
- `mean_regret_model_logit`, `mean_regret_value_logit`, `mean_regret_ctx_wr_pts`, `mean_naive_regret_gih_pts`, `naive_top1_agree`.
- `wasted_rate`, `unplayed_with_alternative_rate`, `in_final_colors_rate`, `made_deck_rate`, `basic_land_picks`.
- `final_lane_from_pool`, `deck_main_colors` (colors with at least 3 non-land cards), `deck_splash`.
- `commitment_pick_lane`: the first pick after which the pool's leading color pair never changes. `commitment_pick_colors` is the same for the top two colors.
- `signal`:
  - `flow_z[color]`: the quality of each color in the packs the seat saw at pack 1 picks 4-9. Quality is Σ max(0, GIH − replacement)/3 pts, split across a card's colors. It is z-scored against every seat in the pod at the same picks, so positive means the color flowed to this seat more than to others.
  - `most_open`, `alignment` (mean `flow_z` of the final colors), `overlap_with_top2_open`.
  - `upstream_pack1`: the seat that passed to it, inferred by matching pack contents, with the colors that seat took and the overlap.

Top level: `schema` (`draft-eval/1`), `event_id, set, knowledge`, `model` (file, λ, expert definition, holdout numbers, `unrated_cards_in_event`) and `definitions`.

## Results on existing runs

Scored runs:
- 6 LLM events in `runs/`;
- a FRA scripted smoke event in `runs/`;
- 4 smoke runs from `tmp/smoke-runs/`, with scripted random agents.

The HOB 3-agent pod was not in local `runs/` and isn't scored. Group means:

| Group | Seats | mean logp | top-1 (expert) | top-1 (value) | value regret (logit) | ctx regret (WR pts) | naive regret (GIH pts) | naive top-1 | wasted | in final colors |
|---|---|---|---|---|---|---|---|---|---|---|
| bots | 66 | −1.45 | .523 | .609 | 0.53 | 0.48 | 0.79 | .578 | .133 | .76 |
| haiku | 5 | −1.38 | .543 | .514 | 0.59 | 0.86 | 2.13 | .324 | .014 | .90 |
| sonnet | 6 | −1.55 | .464 | .452 | 0.66 | 0.88 | 2.23 | .294 | .020 | .87 |
| opus | 1 | −1.59 | .357 | .476 | 0.63 | 0.80 | 1.61 | .333 | .191 | .62 |
| random (scripted) | 10 | −2.65 | .245 | .250 | 1.45 | 1.52 | 2.79 | .233 | .286 | .62 |

The uniform-random log-likelihood is −1.79. Scripted random agents score −2.65, worse than uniform, because the model is confident and they often pick what it rules out.

### Does context change the conclusions? Yes

**1. LLM drafting looks much better in context.**
- On the naive metric, LLM regret (2.1-2.2 GIH pts) is close to random's (2.8) and nearly 3× the bots' (0.8).
- In context, LLMs sit near the bots:
  - Value-model regret: 0.59-0.66 vs bots 0.53 and random 1.45.
  - Expert agreement: haiku .54 vs bots .52.
- Most of the naive "regret" comes from staying in lane. The agents are actually more disciplined than the bots about colors: 1-2% wasted picks against 13%. Bots draft by raw GIH early (and take basics), then commit.

**2. MSH (opus vs sonnet).**
- The naive metric says opus drafted much better: 1.61 vs 2.72 pts regret, and 11/39 vs 6/39 17Lands-top picks in STATUS.
- In context, the gap almost disappears:
  - ctx regret 0.80 vs 0.95;
  - value regret 0.63 vs 0.69.
- On expert agreement sonnet is better: top-1 .50 vs .36, logp −1.49 vs −1.59.
- Opus's lane settled at pick 36 (sonnet: pick 5), only 62% of its picks were in its final colors, and 19% were wasted (sonnet 2%). Opus took the highest-rated card and kept switching. Sonnet read red (`flow_z` R = +2.3, alignment +1.43) and stayed. Sonnet won 2-0.

**3. FRA primer ablation (seed `abl-fra-1`).**
- Both views agree on the direction: none → primer+stats improves both agents.
- The context view shrinks the size of the effect:

| Condition | Naive regret (sonnet / haiku) | Value regret (sonnet / haiku) |
|---|---|---|
| none | 2.86 / 3.16 | 0.61 / 0.80 |
| primer | 2.67 / 1.60 | 0.87 / 0.36 |
| primer+stats | 1.38 / 1.10 | 0.32 / 0.33 |

- Sonnet with the primer alone was its worst draft by the model (logp −1.88, top-1 .36). The naive metric didn't separate it from "none".

**Picks the naive metric calls mistakes but the model calls correct:**

| Event | Seat, pick | Took | Naive best | Naive regret | Why it was right |
|---|---|---|---|---|---|
| fra-b3fa / fra-957e | sonnet P2p2 (UB) | Extended Absence (59.8) | Vraska, the Cutting Glare (63.2, BG gold) | 3.4 pts | Value top choice, ctx regret 0, made the deck |
| 21-02-05 FRA | haiku P3p2 (WB, committed .88) | Blossom-Blessed Angel (56.2) | Kiora of Fire and Ashes (61.8) | 5.5 pts | Value and ctx top, made the deck |
| msh-bf47 | sonnet P2p10 (RG) | HYDRA Assault Robot | **Forest** | 4.2 pts | Taking any spell over a Forest is right |
| fra-b3fa | haiku P2p13 (RG) | Tomik, Izzet Sparkmage | Mind Meanderer (57.6) | 4.75 pts | "the only card here I could play"; expert p = .71 |

**Picks the naive metric calls fine but the model flags:**

| Event | Seat, pick | Took | Model view |
|---|---|---|---|
| MSH | opus P2p12 (pool leaning UG) | Unliving Legionnaire (top GIH in pack) | Expert p = .16, ctx regret 0.95. It did make opus's eventual BG deck, so this is the hindsight limit of a pool-so-far lane model. |
| TLA | sonnet P2p1 (UB) | Ran and Shaw | A near-top GIH card, but red; value rank 9. The note says "keeps red open"; it didn't make the deck. |
| FRA | haiku P1p6 | Vindictive Triumph (top GIH) | ctx regret 1.4: the pool was leaning WU (weight .31). Haiku ended WB, so here the agent was ahead of the lane model. |

Where the expert model and the value model disagree, it is mostly rare-drafting and low-GIH legendaries that humans take:
- **FRA Samut, Tyrant of Naktamun** (GIH 46%): the expert model makes it the favorite at P3p9 and P3p12, and haiku and sonnet both took it. At haiku's P3p9 the value model ranks it 3rd and ctx regret is 2.8 pts.
- **MSH Shang-Chi over Killmonger** at P2p4: the expert model agrees with sonnet; the value model ranks Shang-Chi 6th.

This is why EV regret uses the value model, and agreement uses the expert model.

## 4. Build quality: `sets/<SET>/deck-norms.json`

`analysis/draft_eval/build_eval.py`; the TypeScript twin is `packages/site/src/build-quality.ts`. The two agree to 1e-15 on every agent deck in `runs/`.

**Score.**
- The value of a card in pair P is `w · (GIH WR in P − base[P] + baseline) + (1 − w) · overall GIH WR`:
  - a cell that isn't listed falls back to the overall rate;
  - a splash card without its own cell gets the overall rate plus `splash_delta`;
  - a card with a pip the deck's lands can't produce is valued at P's 10th-percentile card.
- Deck quality is the mean over the non-land cards.
- Expected win rate is a logistic in quality and P's base rate.

**Validation.**
- Ratings are rebuilt on the training drafts (the same 80/20 hash split as the pick model).
- The held-out decks are halved: one half fits `w`, the slope and the base-rate weight; the other half is scored.
- Including P's base win rate 1:1 *hurts*: FRA AUC 0.539 against 0.556 for the lift alone. The base rate mostly reflects who plays an archetype. So its weight is fitted, and it comes out small (−0.015 to +0.055 logits per point).
- The pure lift loses to overall GIH in some sets (SOS 0.527 vs 0.558), so `w` is fitted too: 0 (FIN) to 1 (FRA).
- Results (`results/build-quality.md`):
  - per-game AUC 0.548–0.567, never below the overall-GIH baseline;
  - deck r 0.18–0.25;
  - slope 0.11–0.24 logits per point with player skill held fixed;
  - all sets `validated`.
- GP WR instead of GIH WR validates slightly better in some sets (FRA 0.564 vs 0.556). We keep GIH WR, the standard.

**Norms.**
- Computed over winning decks (≥ 6 wins, 38–45 cards) per pair: p10/p25/p50/p75/p90 of lands, non-land cards, creatures, two-drops, five-plus, average mana value, and primary, secondary and splash sources.
- Deviations from the norms add nothing beyond quality on held-out games (coefficients within about 2 SE of 0). They are descriptive.

**Noise for the rating calibration.**
- Game 1 / game 2 outcomes of the same deck are uncorrelated (about 0) because Arena pairs players by record. Whole-deck win-rate variance is compressed for the same reason.
- That makes the method-of-moments deck spread (0.23–0.29 logits) a lower bound.
- Play advantage is 15–33 Elo.

## Limitations

**Population.**
- These are human Arena PremierDraft drafters, a different population from agents. "Expert" means a ≥60% game win rate over ≥50 games, not pro level.
- Picks include Arena incentives: rare-drafting for the collection, and pick-order habits. The expert model learns them through ATA and card intercepts. Use the value model and ctx regret for "what wins".

**Pods.**
- Our pods have 6 bots and 2-3 agents. Bots draft by GIH + color commitment and take basics, so signals and wheels differ from human pods.
- The signal score compares seats within one pod. With 6-8 seats and one pack round it is noisy; treat a single event's value as anecdotal.

**Packs.**
- Our packs come from MTGJSON play boosters via phase-rs, with unsupported cards swapped. Arena packs differ in collation (sheets, print runs, bonus sheets).
- Every card in the existing runs has 17Lands data. Unknown cards get a rarity-mean fallback and are listed in `unrated_cards_in_event`.

**Hindsight.**
- `in_final_colors`, `made_deck` and `wasted` use the final deck.
- The lane weights for regret use only the pool before the pick, so a drafter who reads a lane early can look "wrong" for a few picks (Vindictive Triumph above).
- Bots don't build decks, so their final colors are the pool's leading pair.

**Ratings.**
- GIH WR is confounded: good players and good decks draw more cards, and IWD is noisy.
- Shrinkage stops small-sample artifacts but also flattens real archetype effects for rarely played cards.
- 17Lands ratings (and ATA) are computed on the same population the model trains on. That is a population-level aggregate, not label leakage per draft.

**Model.**
- A linear conditional logit, with hand-built curve and synergy proxies. Synergy beyond color pairs (tribal, build-arounds) is only seen through per-card intercepts and archetype ratings.
- Top-1 is about 0.62-0.65, so a third of expert picks are still "surprises" to the model. A nonlinear ranker (e.g. LightGBM lambdarank on the same features) is a natural next step.

**Sample size.** 12 LLM seat-drafts in total, one per condition. None of the agent comparisons above are significant. They show what the metric can separate, not results.
