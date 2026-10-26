# Metrics

Design notes for how stages could be measured. **What the benchmark actually computes, and how to read it, is [METHODOLOGY.md](METHODOLOGY.md); where the two differ, METHODOLOGY.md is right.** Items marked *planned* or *not used* are ideas, not numbers anyone can see.

**Rule:** to measure a stage, hold its input fixed, vary who performs it, and measure the output with a yardstick that doesn't depend on the agent being judged. The end-to-end rating, from game results only, is the headline. Stage measurements are diagnostics: they describe behavior and may help explain results, but never feed the rating (METHODOLOGY §5).

## 0. Variance First

Limited is noisy. In mtg-bench, two *identical* bot seats ended up 330 Elo apart after one pod. More games alone won't fix this, so we design for it:

1. **Common random numbers** (*planned*). When comparing models or conditions, use the same packs, seeds and library orders, so luck cancels out in the difference. Packs are seeded today; games aren't (phase-rs picks its own seed).
2. **Duplicate format** (*not possible yet*): every pairing played twice with decks swapped, canceling deck strength and play/draw advantage (as in duplicate bridge and poker). It needs seeded games. A related deck-swap round is future work.
3. **Balanced seating.** Seat positions come from the event seed, so over many events every model drafts from every position.
4. **Noise floor before claims.** The calibration study (`analysis/results/calibration.md`) simulates the noise of real tables (deck luck from 17Lands data, play/draw, contributor effects) and sets how many games a claim needs. The rating's ranges and rank ranges carry that uncertainty (METHODOLOGY §4, §6).
5. **Pre-registered analysis** for research studies: the config hash and analysis plan are fixed before an event runs, and the report states what was planned and what was exploratory.

## 1. Headline Rating

The headline is a rating from game outcomes between LLM seats only: no games against bots or the engine's AI, and no anchor agent. Leaderboard entries are **model + effort** (for example Claude Opus 5.5 · High); the harness each seat ran on is recorded per seat. How the rating is fit, its uncertainty ranges and ranks are in [METHODOLOGY.md](METHODOLOGY.md).

- *Not used:* fitting player and deck effects together (`skill + deck`). It needs each model to pilot several decks, which only a deck-swap design gives.

## 2. Draft (T1 Pick, T5 Pod)

| Metric | How | Why |
|---|---|---|
| **Human-agreement@1** | On real 17Lands packs: how often the pick matches what top-quartile human drafters took (17Lands `user_game_win_rate_bucket`). *Planned* (T1); on our own packs the expert pick model's top-1 agreement is built (METHODOLOGY §5.1). | Cheap and interpretable. Doesn't need the engine. |
| **Pick regret (GIH WR points)** | Best available card's GIH WR minus the picked card's, **adjusted for colors** (only cards in the drafter's lane, once committed). Built as archetype regret and in-lane GIH regret (METHODOLOGY §5.1). | Measures value left on the table. Synergy is the known blind spot, reported alongside. |
| **Grader agreement** | Magic Deck Builder's draft-tutor rubric applied automatically: GIH WR bands, plus rules for when synergy beats the raw numbers. *Planned.* | Uses rules we already have. |
| **Lane reading** | Overlap between the seat's final colors and the most open colors, judged by what upstream seats passed. Built as flow alignment (METHODOLOGY §5.1). | Measures reading signals, which is a real skill. |
| **Commitment curve** | Pick number where the agent's top two colors settle. Compare to human distributions. Built as the commitment pick (METHODOLOGY §5.1); the human comparison is planned. | Shows forcing vs. flexibility. |
| **Pool strength (independent)** | A fixed reference builder builds the pool, then bot duels (below) score it against a fixed gauntlet. Win rate. **Implemented, experimental** (the `reference` row of `deck_strength`); not part of the methodology, and no rating uses it. | Draft skill separated from build and play skill. Free (bot games only). |

## 3. Build (T2 Build, T5 Pod)

| Metric | How |
|---|---|
| **Legality and sanity** | 40+ cards; every card from the pool; land count; color sources vs Karsten requirements; curve; uncastable cards. Built (METHODOLOGY §5.2); reported as a diagnostic, never scored. |
| **Build delta** | Agent's deck vs reference builder's deck **from the same pool**, both scored by bot duels against the same gauntlet. Δ win rate. **Implemented, experimental** (`build_delta` on the `submitted` row of `deck_strength`); not part of the methodology. |
| **Cross-build** | Every model builds every pool in the pod. Gives a clean build-skill estimate with pool effects removed. *Planned.* |
| **Human comparison** | On 17Lands pools from the public game data (where the human deck is known), agent deck vs human deck. *Planned*; what is built instead is archetype build quality against 17Lands archetype ratings and winning-deck norms, with no simulated games (METHODOLOGY §5.2). |

### Deck Strength (Bot Duels, Experimental)

Not part of the methodology (METHODOLOGY §5.2): nothing on the leaderboard or in the diagnostics uses it.


`npx tsx packages/director/src/strength.ts --run runs/<event-id> [--games 24] [--gauntlet bots|a.txt,b.txt] [--difficulty Medium]` scores every agent seat's **submitted** deck and the **reference** deck (`autoBuild` on the same pool, rebuilt from the `draft_pick` log) against a gauntlet: by default the bot seats' reference decks from the same event (`--gauntlet bots`), which exist only in early test events and dev events with bot drafters; for an 8-agent event pass deck lists (`--gauntlet a.txt,b.txt`). No LLM calls. Output: one `deck_strength` record per (seat, deck) appended to `events.jsonl` (`games`, `wins`, `losses`, `win_rate`, Wilson `ci95`, `by_pilot`, `build_delta`, settings) and `runs/<id>/strength.json` with every game. Re-running appends new records; readers take the latest per (seat, deck, method).

How a game is played (`botduel.ts`): **phase-server can't put AI on both seats.** AI seats are only accepted at seats 1..n-1 and seat 0 is always the connected host (phase-rs `ai_seats_wire_guard.rs`, `seat-reducer` `apply_set_kind`). Tricks to remove the host fail: in a 3-seat game the conceded host leaves the AIs running, but phase-ai stops with `ActionSafetyCapReached` after 200 consecutive AI actions (about 9 turns), and a host who stays in gets attacked. So each game is **phase-ai (seat 1) vs the Director's scripted sparring pilot (seat 0)**, real 2-player Limited rules. The sparring pilot plays a land, casts its most expensive castable spells in its main phases, attacks when no blocker eats the attacker, blocks when the block is free or a fair trade (chump only against lethal), and aims removal at the best enemy creature. It never responds at instant speed or activates abilities. It is simpler than phase-ai but close in strength: in the first two events phase-ai Medium's side won only 52% of 192 games. To keep pilot skill out of the score, games come in pairs against the same gauntlet deck with the pilots swapped (`--pilots alternate`, the default), so each deck is played once by each pilot. `by_pilot` shows the split.

Caveats: the gauntlet is only as good as the bot decks; each gauntlet game is a single bot-vs-bot game (not an agent match, which is best of 3 with sideboarding) and its play/draw is the engine's coin flip (recorded per game as `onPlay`, not controlled); the engine seed and phase-ai's choices are unseeded, so games can't be replayed; at 24 games a deck the 95% CI is about ±18 points. Two independent 24-game passes over the same decks moved single build deltas by up to 21 points, so pool deltas across events (or play 100+ games a deck) before reading them. With 6 games in flight on the local phase-server a game takes 35–45 s (median) and a 96-game batch 11–18 minutes (7–11 s per game). The clean fix is upstream: a headless phase-ai vs phase-ai runner that takes deck lists. phase-rs's `ai-duel` binary already plays AI vs AI headlessly, but only on built-in matchups and Commander feeds.

## 4. Play (T3 Puzzles, T4 Duel, T5 Pod)

**Outcomes** (the T3 and T4 tracks are *planned*; the pod rating and outcomes are METHODOLOGY §4)
- Head-to-head LLM vs LLM on fixed decks, duplicate format (T4): pure play skill.
- Puzzle solve rate (T3): binary, deterministic, low noise.
- Pilot skill from the player + deck model (T5).

**Decision quality** (*planned*, except mulligans per game, mana payment and reliability, which are built as diagnostics: METHODOLOGY §5.3–§5.5)

| Metric | How |
|---|---|
| **Win probability added (WPA)** | Train a win-probability model on the game corpus (board, life, cards, turn, deck strength). Each decision's score is the change in P(win) it caused. A model's average WPA per decision is its **accuracy score**, like chess "accuracy." |
| **Blunder detection** | At sampled decision points, run counterfactual rollouts: try each legal alternative and finish the game N times with phase-ai on both sides (determinized hidden info; about 1.5 s per game). *Planned*; it needs a headless phase-ai vs phase-ai runner, since phase-server can't put AI on both seats today (§3). Flag choices that score far below the best alternative. Expensive, so run it on a sample and on "key moments." |
| **Mana efficiency** | Unspent mana per turn while a castable, useful spell was in hand; missed land drops; wrong lands tapped (manual-pay ablation). |
| **Combat** | Attacks into obviously bad blocks; lethal missed (detected by a solver on the decision snapshot); chump-blocks that weren't needed. |
| **Mulligans** | Keep/mull decisions vs a reference policy (lands, spells, curve) and vs a mulligan WR model trained on 17Lands data. |
| **Reliability** | Illegal or malformed answers per 100 decisions; re-asks; timeouts; forfeited decisions; delegation rate by kind. |

## 5. Efficiency

Always measured by the server: **seconds per decision**, decisions per game, tool calls per decision, reconnects. Where the harness reports it (collected by `bench play` and `bench attach-logs`): tokens and $ per seat and per game, reported or estimated from token counts (METHODOLOGY §5.7); **cost per Elo** is an idea, not built. Seats on a subscription didn't pay the API-equivalent figure. Pricing for $ estimates comes from one pinned pricing file, `registry/prices.json` (runebench lesson).

## 6. Format Insights (What Agent Games Teach Us About the Set)

These are computed per set over all agent games, and always shown next to the 17Lands human numbers. Built today (the set file, docs/SITE-DATA.md): agent picks and average pick against 17Lands ATA, per-card deck records, archetype records and the average deck shape. The other rows are *planned*.

| Stat | Definition |
|---|---|
| **Agent GIH WR** | Win rate of games where the card was seen in hand. Same definition as 17Lands. |
| **Adjusted card value** | A logistic regression of game outcome on cards seen, with player-skill and deck-strength terms. Reduces "good drafters pick good cards" confounding. |
| **Agent ALSA / ATA** | Average last seen / taken pick in agent drafts. |
| **Δ vs human** | Agent minus human (GIH WR, ATA), ranked. The interesting lists: "agents overrate," "agents underrate," "better in agent games than human games." |
| **Archetype WR** | Win rate by color pair and by deck shape (aggro/midrange/control, from curve and creature count). |
| **Play patterns** | Combat-trick timing, removal on tempo vs value, how often each card is cast on curve, how often it's stranded. |

**Caveats, always stated next to these numbers:** agents are a different population from humans. Engine card bugs affect results. A card that's strong against agents may not be strong against people. Cards the engine can't run are swapped out of packs and every swap is published; games touched by engine issues are flagged (METHODOLOGY §5.6). A per-set card trust list is an idea, not built.

## 7. What We Explicitly Don't Score

- Speed, beyond what the clock already enforces.
- Anything that depends on knowing who the opponent is.
