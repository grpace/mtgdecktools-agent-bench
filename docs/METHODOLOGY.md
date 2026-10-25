# Methodology

This page defines what the benchmark's numbers mean, which results may be pooled, and how sure we are about them. It ships with every data export (`methodology.md`), and mtgdecktools.com shows it on the Methodology page. The code that implements it is `packages/site/src/rating.ts` (the rating model), `scoring.ts` (identities, contributors, groups, boards, diagnostics), `outcomes.ts` (results) and `summary.ts` (generated summaries). If this page and the code disagree, the code has a bug: please report it.

## 1. What We Measure

AI agents draft, build and play Magic: The Gathering Limited against each other: an 8-seat booster draft, deckbuilding, then a 3-round Swiss of best-of-3 matches with sideboarding, played on the phase-rs rules engine. The **headline** is a rating from LLM-vs-LLM game results, with a 95% range. It is end to end: a seat that drafts and builds a better deck wins more, and that counts. The rating comes from game results and nothing else.

Next to it we report **outcomes** (games, matches, play and draw, event finishes, head to head; §4.1) and **diagnostics**: descriptive numbers about how each agent drafts, builds, plays, handles mana, stays reliable and spends tokens (§5). Diagnostics can help explain results, but none of them feeds the rating: a poor deck shows up as lost games.

Contributors run the agents on their own harnesses and their own tokens; our server runs the table and never calls a model. So every number is computed within a **comparability group** (§3), carries its sample size and range, records who contributed the games behind it (§3.4), and stays **provisional** until enough contributors have supplied enough games (§4).

### 1.1 Live, and How the Boards Fill

The benchmark has been live since October 25, 2026. Anyone can bring agents to the hosted table: a **Private Table** (you bring all 8 seats) or the **Matchmaking Lobby** (you bring 1–4 seats; a table starts when 8 are ready). Results reach the boards on their own:

- **A table counts when it ends.** When a table finishes, or is stopped with finished games (§3.2), the Hub checks it and updates the boards within minutes. Live tables can be watched but are never rated while they run.
- **Empty until the first rated game.** Until the main board (§3.3) has a rated game, it says "No Rated Games Yet". Nothing from earlier testing stands in for it.
- **Only games between different setups are rated.** A setup is a model at an effort level (§2). Two seats of the same setup can play each other, but that game says nothing about which is stronger, so it isn't rated (§2.4).
- **Early rows are provisional.** A row is marked provisional until it has 30 rated games from 3 events against 2 opponents, with games from at least 2 contributors and none supplying more than half (§4). The contributor part is usually what is still missing. Ranks say "too early to rank" until a rating difference is clear.
- **Early Test Data stays off the boards.** Tables from testing before launch (best of 1, or best of 3 without sideboarding) stay visible on the site, labeled Early Test Data, and are never rated or pooled (§3). Test tables with scripted players are never rated either (§3.2).
- **Open data** (CC BY 4.0) is rebuilt nightly from the same accepted events (docs/OPEN-DATA.md).

## 2. The Seat Identity

A **seat** is one agent at one event. Seats are pooled across events by **seat identity**:

> **identity = canonical model + canonical effort** (for example `claude-sonnet-5-5/high`, shown as "Claude Sonnet 5.5 · High")

Both parts, and the harness each seat ran on, come from the **model registry** (`registry/models.json`, `registry/harnesses.json`; see `registry/README.md`), the one list of names every part of the benchmark uses:
- **Harness** (Claude Code, Codex CLI, Cursor CLI, OpenCode, Gemini CLI, …) is recorded per seat and is never part of the identity. Every seat plays through the same MCP game tools and is shut in to them, so the harness matters far less here than in coding benchmarks, and splitting each model by harness would spread its games thin across near-duplicate rows. The harness still decides how a seat's model and effort are checked (its logs, its documented defaults), and results per harness stay visible as a descriptive split (§2.3). "Claude Code", "claude" and "claude-code" are the same harness.
- **Model** is the provider's exact API id. Case, spacing, punctuation, provider prefixes (`anthropic/claude-sonnet-5-5`) and dated snapshots never create a new row. Short names that move with each release (Claude Code's `sonnet`) resolve to the model they meant on the event's start date.
- **Effort** is one level on one canonical scale: `none`, `minimal`, `low`, `medium`, `high`, `xhigh` or `max`, plus Codex's `ultra` (subagents in parallel; its own level, never treated as a higher `max`), or **Unknown** when it can't be established (§2.2). "Default" is never a row: a seat that ran at its harness's default gets the level that default actually is.
- **Prompts** are an event-wide condition (§3), not part of the identity.

**Resolved at entry, re-resolved at export.** The Director, the lobby and the `bench` CLI refuse names the registry doesn't know, with suggestions. `event_start` logs the canonical values and the strings as typed (`*_declared`). Every export resolves those strings again with the current registry, so a registry fix (a new alias, a newly listed model) merges or rates old rows at the next export without touching any stored log.

### 2.1 Model Check

The declared model is self-reported. When the harness's usage is available, the export checks it: `usage-<seat>.json` in a bundle, the usage summary the `bench` CLI sends the Hub after a hosted event, or the seat's transcript. The seat's **primary model** is the one with the most output tokens, ignoring the harness's helper models (Claude Code, for example, runs a small model for side tasks). Each seat gets one status:

| Status | When | Rated? |
|---|---|---|
| **Checked Against Logs** | The primary model in the harness logs resolves to the same canonical id as the declared model. | Yes |
| **Self-Reported** | No usage was submitted (a hosted seat started by hand without `bench attach-logs`, or the upload failed), or the harness doesn't report its model. | Yes, and labeled |
| **Mismatch** | The usage shows another model doing the work, or several models without saying which did. | **No.** The seat stays on its event page with the reason. Its games are rated for nobody, and it contributes nothing to diagnostics. |
| **Unlisted** | The declared model, harness or effort isn't in the registry. This only happens on Private Tables run with `--unlisted-model`. | No, until the registry lists it. The next export then rates it. |

**What "Checked Against Logs" means.** The logs agreed with the declaration; we did not watch the agent play. Every check records who read the harness logs (`logs_read_by`): `contributor-cli` when the `bench` CLI read them on the contributor's machine (`evidence.kind: "cli-local-logs"`, `self_attested: true`), or `export` when our export read a transcript the contributor submitted. Either way the logs come from the contributor; nothing stronger exists yet (§11 describes a server-side check).

**Hosted seats send their usage after the event.** The hosted Director never sees harness logs. When the event ends, `bench play` (or `bench attach-logs`, for seats started by hand) sends the Hub a summary per seat it started: the model ids and token counts the harness logged, the effort level it logged and its version; never prompts or transcripts. The Hub accepts it only from whoever seated those seats (a lobby seat's contributor, a Private Table's organizer), checks it against each seat's declaration and stores it as that seat's `usage-<seat>.json`.

**Self-Reported seats are rated, and labeled.** Leaving them out would leave many hosted seats without ratings. Their games count like any other; the label travels with every row, and the contributor checks in §3.4 apply to them as to everyone. An identity's check is the mix over its seats (`model_verification`: `verified`, `self-reported` or `mixed`, with counts). A Mismatch raises an anomaly (`anomaly.usage_model`) that holds a Community bundle for review.

### 2.2 Effort

Effort changes what a model does, so it's part of the identity, and it must be a real level. Each seat's level comes from the best evidence available, in this order (`effort_source`):

| Source | When | Label |
|---|---|---|
| `detected` | The harness's own logs show the level: Claude Code session files, Codex rollout files, OpenCode session exports, Cursor's model name (`registry/harnesses.json → effort_detection`). | Detected from Logs |
| `declared-explicit` | The `bench` CLI started the seat with an explicit effort flag (`effort_basis: "launch"`), and no logs say otherwise. The CLI never starts a seat on an implicit default. A level picked in an app seated by hand that keeps no usage logs (`registry/harnesses.json → seated: "by-hand"`) counts here too, unchecked. | Set at Launch |
| `self-reported` | A person declared the level for a seat they seated by hand (`effort_basis: "self-report"`). | Self-Reported |
| `harness-default` | No level was set. The level is the harness's documented default for that model *at the harness version the usage reports* (`registry/harnesses.json → effort_defaults`, with source links and version ranges). This includes harnesses with no effort control (Gemini CLI). | Harness Default |
| `unknown` | No level was set, and the default isn't documented or the harness version is unknown. | Unknown |

Rules:
- **The logs win.** When detected and declared levels differ, the seat is rated at the detected level and flagged (`anomaly.usage_effort`, which holds a Community bundle). If the level changed during the session (no level on 90% of turns), the effort is Unknown and flagged.
- **Unknown is its own row** ("Unknown Effort"), never merged with a concrete level. Unknown rows are fitted like any other, since their games inform their opponents' ratings, but they mix levels, so boards rank only rows with a recorded effort and show Unknown rows on request ("Include Runs Without a Recorded Effort").
- **Rated tables need a level.** The lobby and the hosted table refuse seats without one wherever the harness can set effort.
- **Harness defaults assume a clean harness.** A settings file or environment variable can change the default (Claude Code: `CLAUDE_CODE_EFFORT_LEVEL`, project `effortLevel`; Gemini CLI: `modelConfigs`). Detected levels don't have this weakness, which is why detection comes first.
- **Old events re-resolve at every export**, like models: a newly documented default applies to old seats without touching their logs.
- Agents aren't asked for their own settings: in our probes they couldn't see them and guessed from the model name.
- **Fast serving modes** (Cursor's `-fast` models, Claude fast mode) are recorded per seat but aren't part of the identity: providers describe them as the same model served faster.
- **A launcher is not a harness.** The harness is what runs the model's tool loop (Claude Code, Codex CLI, Cursor CLI, OpenCode, Antigravity, Gemini CLI). An app that only starts harness sessions, such as T3 Code (which runs Claude through the Claude Agent SDK, Claude Code's harness, and Codex through the Codex App Server), is the seat's *launcher*. A seat declared "Claude Code via T3 Code" (`t3-code:claude-code`) is a Claude Code seat: that harness's levels, defaults and detection apply. The launcher is recorded on the seat (`launcher`) and its log is a fallback source for effort detection. T3 Code gives every session its own MCP server and adds instructions to it; that is recorded per seat, not ranked.
- Seats seated by hand are matched to their harness's local session after the event (`bench attach-logs`), using decision text only that seat saw. Only the model, effort, fast mode, version and token counts are kept.

**Snapshots.** A dated snapshot behind a canonical id (`claude-sonnet-5-5-20261101`) is the same row. The export records which snapshot each seat's usage showed (`snapshots`) and flags snapshots the registry doesn't list (`unknown_snapshot`), so a silent model change is visible without splitting the row. We split a row only when a provider ships materially different behavior under one id; that is a methodology change (§9).

Two seats with the same identity in one event are one identity: their games against each other are not rated, and both seats' picks, decks and decisions feed its diagnostics.

### 2.3 Effort Comparisons and Harnesses

The same model at two effort levels is two identities, and games between them are rated like any other: Claude Haiku 5.5 · Low against Claude Haiku 5.5 · High is a rated game. The same model at one level on two harnesses is **one** identity: Claude Sonnet 5.5 · High through Claude Code and through Cursor CLI is a mirror, so games between them aren't rated (§2.4).

**Effort levels stay separate.** Whether more thinking changes results is one of the questions worth answering. Merging "Claude Sonnet 5.5" across levels would hide exactly that, and would make a model's row depend on which levels contributors happened to bring. So effort comparisons are made between separate rows fitted together in one Bradley–Terry fit, never by pooling them.

**Harnesses are pooled, and checked.** A harness changes the system prompt and the tools around the model, and could change results. We pool them anyway, for the reasons in §2. To catch a harness that does matter, a model page shows a **harness split** (`ModelFile.harness_split`): for each effort level whose seats ran on two or more harnesses, the record and win rate per harness against other setups, with Wilson intervals. It is descriptive and never rated: the opponents, sets and contributors behind each line differ. Seats keep their `harness` and `launcher` in the export and the open data, so a harness effect can be checked as a side analysis; if one shows up, splitting rows by harness is a methodology change (§9).

*Calibrated in simulation* (`analysis/results/calibration-harnesses/`, 200 simulated communities each): with each contributor running each identity on one of two harnesses whose strengths differ by SD 40 Elo (a 70/30 mix), the 95% ranges cover the identity as its seats ran 96% of the time (RMSE 60 Elo, against 59 with no harness effect); with SD 80 and an even mix, 96% (RMSE 61). What a pooled row can't separate is the model from the harness mix it was run with (§7, "Harness differences are pooled into each row").

**How the comparisons are read.** Within one board (§3.3), a model page lines up its rows:
- **Effort Ladder:** the model's effort levels in order (Codex's `ultra` last, as its own level), whatever harnesses ran them. For each level: the rating with its range, the record, the expected score against an average opponent, and the cost per game. Between neighboring levels: the rating difference with the 95% interval of the difference (§4, "Ranking") and the cost difference per game. A step gets a verdict (`VersionStep.verdict`) only when neither row is provisional and the difference still holds after a **Holm correction over the ladder's steps** (§4, "Several Comparisons"). Then the page says the higher level is "rated higher in these games"; it never claims the extra effort caused it (one contributor's ladder can't show cause). A step whose interval excludes 0 with a provisional row is "provisional"; one that excludes 0 but not after the correction is "unadjusted"; otherwise it is too early to say.
- **Harness split:** descriptive only (above).
- Unknown Effort rows are left out of ladders (they mix levels). A comparison is provisional while any of its rows is.

**What a table needs to measure it.** An Effort Ladder table (for example 4 seats at low and 4 at high) makes these comparisons cheap: a 4 + 4 table rates a median 10 of its 12 matches (§3.2). One contributor's ladder still carries that contributor's configuration, so the contributor floor (§4) applies to every row of it: a firm answer needs ladders from several contributors. `bench setup` shows how many rated games a planned table can produce and suggests mixes (docs/MULTI-PROVIDER.md).

### 2.4 Mirror Games

A **mirror game** is a game between two seats of the same identity. Mirror games are **never rated**: a game between two copies of one setup says nothing about how that setup compares with others. They are still used:
- **Format insights:** what agents draft, build and win with in a set (§5.8).
- **Play and draw, and deck data:** decks, sideboarding, play/draw choices and game length, like any game.
- **A fairness check.** With skill held equal, a mirror should be a coin flip. The export's mirror monitor (`index.json → mirror_check`) counts mirror games in finished, pooled events (forfeits and games without a winner left out) and reports, per identity:
  - each **contributor's** win rate in mirror games against another contributor's seats of the same identity. A rate far from 50% suggests their configuration differs from everyone else's (a settings file, another harness version, a changed default);
  - each **context policy's** win rate against the same identity under another policy (a fresh session per game or match, or one long session), the natural experiment for the open question in §10;
  - the **on-the-play** win rate in **game 1** of each mirror match, where the event seed decides who plays first: an estimate of the play advantage with skill held equal. In games 2–3 the previous game's loser chooses, and that side more often holds the weaker deck, so the all-games rate (`on_play_all_games`, for reference) is biased toward 50%.

  A check **deviates** when it has at least 20 games and its 95% Wilson range excludes 50%. This is a **screening flag, not a test**: games within a match or event are clustered, so the Wilson range is too narrow, and with many checks about one in 20 deviates by chance. Deviations are a reason to look at those setups, never a correction to any rating.

## 3. Conditions and Comparability

Some settings change what an agent knows or must do. They are fixed for a whole event, so seats under different settings never play each other and their numbers aren't on a common scale. Results are pooled only within a **comparability group**, all of whose events share:

| Condition | Values | Why it splits groups |
|---|---|---|
| Knowledge level | No Set Context, Set Context, Set Context + Human Stats | What the agent is told about the format. With Human Stats the agent sees 17Lands win rates, so 17Lands-based draft metrics are partly circular. |
| Prompts | A content hash of the prompt files the event ran with (`event_start.prompt_sha256`) | What every seat is told and what each decision shows. Any change to the prompt files starts a new group, so an edit can never pool silently with earlier results. Groups are never labeled with a version: when two groups differ only in their prompts, the older one is marked "Earlier Prompt". |
| Mana payment | Manual, Automatic | Manual payment is a skill and a source of errors. |

The group key combines the three (`kn=<level>;mana=<mode>;prompt=<fingerprint>`, the fingerprint being the first 12 hex digits of the prompt hash).

**The match format is fixed: best of 3 with sideboarding.** Best of 1 and best of 3 call for different drafting and main-deck choices, not only different sideboards, so the benchmark plays one format, the one real Limited tournaments play:
- Game 1: the event seed picks who plays first. Games 2 and 3: the loser of the previous game chooses to play or draw (after a drawn game, the player who chose for it chooses again; after a drawn game 1, the player who was on the play), and the engine starts with that player. **Only game 1's play/draw is random.** The loser of game 1 more often holds the weaker deck and usually chooses to play, so on-the-play win rates from games 2–3 understate the play advantage. The rating's play term, the outcome records' play/draw split and the mirror check's on-play rate therefore use game 1 only.
- Before games 2 and 3 both players sideboard at the same time, with their current deck, their whole sideboard and what they saw of the opponent's deck; the deckbuilding rules apply unchanged (pool cards only, at most the copies drafted, unlimited basics, at least 40 cards), and keeping the deck is an answer. Neither sees the other's changes, only the deck size. Each match starts from the registered deck. The draft and deckbuilding prompts say so, so agents can plan a sideboard. Details: docs/PROTOCOL.md §3.3.
- **Early Test Data.** Events from testing before launch that played best of 1, or best of 3 without sideboarding (`event_start.sideboarding` absent), stay in the data, visible and labeled Early Test Data, outside every rating and board.

**Recorded but not split on:**
- **Set.** Limited skill is mostly general. Ratings pool across sets within a group, and every group also has a per-set board. A model may still know one set better than another, which the ranges account for (§4, "Set variance").
- **Engine build** (phase-rs version and protocol, `event_start.provenance`). Card bugs are inevitable and can hit any seat that plays the card. We expect them to add noise more than bias, but bugs cluster by color and mechanic and models have color preferences, so that is tested rather than assumed: every game is flagged when engine issues touched it, and the impact is measured and reported (§5.6). Each group lists the engine builds it contains. We would split by engine epoch only if a release changed rules handling materially *and* the flagged-game analysis showed a real effect.
- **Card overrides** (`event_start.provenance.card_data`: the hash of the card data phase-server ran, and the local card overrides applied to it; docs/CARD-OVERRIDES.md). An override is a person's fix to a card phase-rs scripts wrongly or can't run, written against the Oracle text and the Comprehensive Rules and tested in scripted games. Agent reports never apply one. Overrides make the engine more faithful to the printed cards and apply to both players alike, so they pool like engine builds (§7, "The engine isn't the game").
- **Set Context version** (the sha256 of the text the agents read, logged with the event). Set Contexts are edited over time; the hash shows which text each event used.
- **Pairing format** (Swiss or round robin, §3.2). It changes who meets whom, not what an agent knows or must do.
- **Table kind** (lobby table or Private Table; `event_start.table`).
- **Context policy** (`event_start.seats[].context_policy`). Seats the `bench` CLI starts default to a fresh harness session per game (`--fresh-session per-game`): the session ends when the deck is locked and after every game, and a fresh one starts with a resume briefing. Every decision carries the board, the card text, the decklist and the match so far, including the opponent's cards from earlier games of the match (match memory), and every session reads the Set Context before its first game decision, so a fresh session knows what a long one knows. Seats seated by hand, and `--fresh-session off`, keep one harness conversation with the harness's own context handling. Boards pool across policies; results are reported per policy where they can differ (§2.4, §5.7). §10 keeps the question open.

**Unrated events** are listed in the export with the reason and contribute to nothing pooled:
- Early Test Data (above);
- test tables: any scripted or bot seat (§3.2). Whether a seat is an LLM seat comes from its `event_start` metadata, never its name: the registry's test harness (`script`) or the scripted `random` model is never one;
- dev events: bot drafters filled empty seats (`event_start.dev_bot_fill`);
- events whose conditions were not logged;
- events excluded by hand (for example, an event broken by a Director bug), recorded in `runs/<id>/source.json` with the reason.

### Knowledge Levels

Every level shares the standard briefing (Limited fundamentals, the deckbuilding guide and the pool analysis):

| Level | Adds |
|---|---|
| No Set Context | Nothing set-specific: general Limited skill only. |
| Set Context | The MTG Deck Tools Set Context for the set (archetypes, lanes, format speed, card notes). |
| Set Context + Human Stats | Also 17Lands GIH WR and ATA next to cards in packs and pools. |

No level shows MTG Deck Tools tier scores: agents judge cards with their own evaluation, and at the last level they also have the 17Lands stats.

**Read in every session.** At the Set Context levels each harness session reads the Set Context before its first game decision (until it has, the Director answers a game decision with a reminder; PROTOCOL §6). A seat with a fresh session per game reads it each game; one long session reads it once. Either way every game decision is made by a session that has read it, so the context policy never changes the knowledge level.

**The tier-score filter.** Set Contexts are the MTG Deck Tools author's text (CC0), written for the site's AI Deck Builder, whose card pool lists a 0–10 tier score per card. Agents here get no tier scores, so every copy an agent reads goes through one deterministic filter (`packages/director/src/set-context-filter.ts`): it drops claims that the pool lists tier scores and turns instructions to use them into the agent's own card evaluation. The logged sha256 is of the filtered text. We never edit the author's text itself.

**Sets without a Set Context.** An event that asks for Set Context in a set MTG Deck Tools hasn't written one for is refused, and so are lobby queues for it. An organizer who wants to run it anyway passes `--allow-downgrade`; the event then runs at No Set Context, logs the level it asked for (`event_start.knowledge.requested`, with a warning) and pools with the other No Set Context events, since that is what its agents actually got. Set Context + Human Stats is refused for a set without human data or a Set Context.

### What Each Decision Shows

Each decision is self-contained, so results depend less on how a harness manages a long context (PROTOCOL §3):

| Decision | What the agent gets |
|---|---|
| Game decisions | One JSON object with everything a player at the table would know: both players' life, counters, designations and zone counts, untapped mana by color, your hand, both battlefields with full permanent state, the stack with targets and modes, combat, both graveyards and exile, temporary effects, your library's remaining contents (from your decklist), and the match so far, with the opponent's cards from earlier games of the match. It includes the printed text of every card in every visible zone, all faces, at every decision, and the options with the cards they involve. About 2,450 tokens per decision (`scripts/measure-observation.py`). |
| Draft picks | Every card in the pack as card JSON, with full text at every pick; the picks so far with costs, types and the curve. |
| Deckbuilding | The 40-card rules of the MTG Deck Tools AI Deck Builder; one line of card JSON per card with its copy count; pool facts the Director counted; then a review of the submitted deck before it locks (PROTOCOL §3.1). |

Events under earlier prompts showed less (a text board, card text only the first time a card appeared). They are in other comparability groups by prompt hash and never pool with current results.

**Deckbuilding mirrors the MTG Deck Tools AI Deck Builder**: the same 40-card rules, the Set Context on or off, copies shown and requested as counts, and a review before the deck locks. The one difference is that the deck builder's tier scores are shown at no level. A parity test (`packages/director/src/deck-parity.test.ts`) checks every critical rule against a capture of the deck builder's prompt.

Hidden information stays hidden: libraries and the opponent's hand are counts only (plus cards the engine shows as revealed), the opponent's face-down cards show only their face-down characteristics, and the Director never passes raw engine objects through.

Packs follow Wizards of the Coast's Play Booster collation, including basic lands in the land slot. Basics are draftable; the fundamentals explain they are almost never the right pick, since every deck gets unlimited basics.

### Table Provenance

| Label | Meaning |
|---|---|
| **Hosted** | Played on our hosted Director. The engine, the draft and every log live on our server, whoever brings the agents. This is the main path for rated play. Logs can't be edited or fabricated; who or what played each seat is self-reported (§2.1, §3.4). |
| **Community** | Played on a self-hosted Director and submitted as a bundle. It must pass the integrity checks in §3.1. A determined bad actor could in principle fabricate its logs, so this label carries less weight. |
| **Test Run** | Scripted agents only, or a dev engine test with bot drafters. Never rated. |

The export keeps the historical codes (`verified` for Hosted, `smoke` for Test Run) next to the label (`provenance`, `provenance_display`). "Hosted" says where the table ran; it never means a result was verified. Boards exist for all tables together and for each provenance alone; the default view pools Hosted and Community tables.

### 3.1 Data Integrity

The goal is that nobody can quietly poison or edit results:
1. **Hosted tables first.** Rated play happens on our Directors, where the logs are written server-side. Contributors supply the agents and the tokens; we supply the table.
2. **Immutable raw data.** Every event and submission is stored content-addressed (sha256). Ingestion is repeatable, and every derived number can be recomputed from the raw logs.
3. **Checks on every event**, hosted or submitted:
   - **Pack regeneration:** booster packs are regenerated from the event seed, set and Director version and must match the logged packs exactly;
   - **Draft consistency:** every pick is in its pack, and every deck comes from its seat's pool plus basics;
   - **Game consistency:** turn snapshots, game results and match scores agree;
   - **Pairings:** every round regenerates from the seed, the seats and the logged results, under the pairing version the log records (§3.2);
   - **Seat positions:** each agent sits where the seed puts it;
   - **Eligibility:** an event with bot drafter seats is rejected;
   - **Provenance:** the engine build is on the allowed list, the Director isn't modified, and the prompt files are known;
   - **Duplicates:** the same bundle or event id is rejected.
4. **Accounts and limits.** GitHub sign-in (accounts at least 30 days old), per-contributor tokens (revocable), rate limits, and review of a contributor's first Community submissions before they count.
5. **Anomaly checks.** Impossible decision latencies, usage inconsistent with the declared model or effort (§2.1, §2.2) and identical decision streams. Flagged submissions are held for review.
6. **No single contributor makes a rating.** Every rated game records who seated each side (§3.4). A rating stays provisional until at least two contributors supplied its games and none supplied more than half; a leave-one-contributor-out check flags rows one contributor moves; the 95% ranges include the extra uncertainty of results carried by few contributors; and the bootstrap resamples a contributor's events together once a board has enough contributors (§4). We don't cap any contributor's weight: in simulation a 50% cap moved a deliberately sabotaged row by 2 Elo and a 30% cap by 11, while making every range 3–12% wider (`analysis/results/calibration.md`). An adversary simply stays under any cap; the floor and the flags cover what a cap was meant for. Takedowns trigger a full recompute.

**Private Tables rest on one person's honesty.** At a Private Table one contributor seats all 8 agents and so controls both sides of every game: the harness configuration, the settings, even which model really plays. A hosted table guarantees the games happened as logged, not who or what played them. That is why ratings need several contributors, and why the influence flags exist.

### 3.2 Tables: 8 Agent Seats, Swiss Pairings

**Every rated event seats 8 language-model agents, with no bot drafters or scripted players.** Bot drafters would shape what agents are passed, and a table that is mostly bots isn't the format we want to measure. A table with any scripted or bot seat is a **test table** (an operator's check of the software): visible, but in no rating group, with no rated game and no Swiss finish (`table_kind: "test"`). Two ways to fill a table:
- **Private Table:** one contributor brings all 8 seats, for example 4 models × 2 seats, or an Effort Ladder of 4 + 4.
- **Lobby table:** contributors with 1–4 seats each queue for one set and condition; a table starts when 8 seats are present and confirmed (docs/LOBBY.md). At most 4 seats per contributor per table, so every lobby table has at least two contributors.

The bot draft policy has exactly one role at rated tables: the inactivity watchdog uses it to pick for a seat that has gone silent (§5.5), and those picks are flagged and left out of the draft scores.

**Pairings: a 3-round Swiss**, so each seat plays 3 best-of-3 matches, as in a real draft pod (an 8-seat round robin would be 7 matches per seat, too slow and too costly for contributors). Lobby tables and every table the `bench` CLI creates are Swiss; a Private Table created through the Director's API may ask for a round robin. The Swiss (`packages/director/src/pairings.ts`):
- Round 1 is random, from the event seed.
- Each later round is paired when the previous one has finished, by match points (win 3, draw 1, loss 0).
- **Every round but the last:** among all pairings, the Director takes the one that, in priority order: has no rematches; doesn't pair two seats of the same identity (their games wouldn't be rated); **keeps equal records together** (the smallest sum of squared match-point differences: a seat moves to the adjacent record group only to avoid such a mirror or because a group is odd, the standard Swiss pair-down, and as little as possible); then doesn't pair two seats of the same contributor.
- **The last round is strictly by points.** No rematches, equal records together, and only among pairings equally good on records, no mirror, then no same-contributor pair. So the seats with the best records meet in the last round.
- Remaining ties follow a seeded random order. Every perfect matching of the table is considered (105 at 8 seats), so the choice is exact.
- **The trade-off, measured** over simulated pods with the real pairing code: a 4 + 4 table rates a median 10 of 12 matches, 5 + 3 rates 9, 6 + 2 rates 6, 7 + 1 rates 3, and four setups at 2 seats each rate all 12 in most pods. A float in round 2 can leave three 2–0 seats, so about 8% of 4 + 4 pods end with **two 3–0s**; the standings then break the tie by game difference, and an exact tie has no winner (§4.1).
- Pairings are a deterministic function of the seed, the seats' declared identities and contributors, and the results. Each round is logged (`round_start`) with the pairing version (`event_start.pairing.version`), and the Hub regenerates and checks it.
- A match with **no result** (below) gives neither seat match points, and the two seats count as having met.

**No result: infrastructure never decides a game.** A game the engine loses (a restart past its reconnect grace, a dropped connection) or can't start is **voided** and replayed from the start with the same decks and the same play/draw choice, after a growing pause (2 seconds, 30 seconds, 2 minutes). A game voided four times ends its match with **no result** (`match_end.no_result: true`, with the reason):
- the match is neither won, lost nor drawn: no match points, no line in the standings' match record, no head-to-head match, no event finish built on it;
- the voided game is never scored;
- games the match finished before the failure stand: they are complete outcomes and stay in the rating. Throwing them out would let a seat that can make the engine fail erase a game it had already lost.

**Stopped events: stopping a table can't erase it.** An organizer can stop their own table (`bench stop`), an admin can stop any, and the server stops a table that runs past its time limit, that no seat connects to, or that can't be resumed after a restart. If only finished events counted, an organizer could erase a table that was going badly by stopping it. So a stopped event is handled like a no-result match for the whole table:
- `event_abort` records who stopped it (`by`: organizer, admin or system), why, and the games still being played. The event is handed to the Hub like a finished one (when at least one game had finished), with status `stopped` and one sentence on what counts.
- **Finished games are results and are rated**, whoever stopped the table.
- **Games never played are not results.** Unfinished matches get no match result; the event has no final standings, finishes or winner.
- **A game in progress** is void, with one exception: when the table's **organizer** stopped it and exactly one side of that game is the organizer's own seat (a lobby seat they queued facing someone else's), that side **forfeits** the game, as a silent seat would (§5.5). At a Private Table every seat is the organizer's, so an open game has no side to charge and is void.
- Stops by an admin or by the server void every open game: neither seat chose it.

**Ratings don't depend on pairing.** The headline is the Bradley–Terry fit over every rated game (§4). Swiss pairing is adaptive, but it depends only on observed outcomes and the seed, so it is ignorable for the likelihood: the fit stays consistent, as chess ratings from Swiss events do. Each seat meets 3 of the 7 others, so identities connect through more events rather than within one.

**What that means for the thresholds.** A seat plays about 7 games per event (3 matches × about 2.4 games), against 3 opponents. The 30-game floor takes 4–5 events for an identity with one seat per event, or about 3 with two seats per event (where the 3-event floor then binds). The 2-opponent floor is met within one event. The contributor floor (§4) is what usually binds.

### 3.3 The Main Board and Side Boards

**The main condition is Set Context · Manual Mana, best of 3 with sideboarding, with the current prompts** (the prompt files in this repository's `prompts/`, which the hosted Director runs). Its all-sets board is the default leaderboard (`main_board`; `GroupInfo.role: "main"`), and the lobby's featured queue plays it. Until it has a rated game there is no headline board ("No Rated Games Yet"). When the prompts change, the new group becomes the main board and the earlier one stays as a side board labeled "Earlier Prompt"; it never stands in for the new one. Every other group (other knowledge levels, automatic mana, earlier prompts) is a **side board**: rated the same way, shown on request, never compared with the main board.

Model pages show one group: the main board's when the model has rated games there, else the group where it has the most. Their records, head-to-head results and summaries never pool across groups.

### 3.4 Contributors

Every rated game records which contributor seated each side, resolved in this order:
- a **Community bundle**: the uploader, whatever the log says (`source.json`);
- a **lobby seat**: the contributor who queued it (`event_start.seats[].contributor_id`);
- a hosted **Private Table**: its organizer (`event_start.organizer.contributor_id`);
- an event **we ran**: "admin";
- **logs that recorded none**: "unattributed", counted as one contributor.

The export shows each seat's contributor as an opaque key (a salted hash, never an account id), with the public handle only where the contributor chose to show it. Boards report, per row, how many contributors supplied its games and the largest share any one supplied, and they use those contributors in the provisional floor, the influence flags and the ranges (§4).

## 4. Headline Rating

### Model

A Bradley–Terry model on individual game outcomes between LLM seats, on the Elo scale:

```
P(A beats B) = 1 / (1 + 10^(−(R_A − R_B + h·s) / 400))
```

- `R` is one rating per seat identity in the scope (a group, optionally one set, optionally one provenance). 1500 is the **unweighted** average of the identities in each connected group of the scope.
- `h` is a common play/draw advantage. `s` is +1 when A was on the play and −1 when B was, **in game 1 of each match only**, where the event seed chose. In games 2–3 the previous game's loser chose, and that side more often holds the weaker deck, so those games would bias `h` toward 0: they enter the fit with `s` = 0.
- **Prior.** Each `R` has a normal prior centered on 1500 with SD 200 Elo; `h` has SD 50. The prior keeps a 2–0 sweep from producing an infinite rating and pulls small samples toward the field average. With a lot of data it hardly matters.
- The fit is the posterior mode (Newton–Raphson; the problem is strictly concave). The output is deterministic: every board's bootstrap is seeded from the board's id.

**What counts as a game:**
- A finished game between two LLM seats of different identities, with a winner. Concessions count as losses: the agent chose them.
- A game the inactivity watchdog conceded for a silent seat counts as a **loss for that seat** and a win for its opponent (§5.5); so does an open game the stopping organizer's own seat forfeits (§3.2, "Stopped events").
- Not counted: scripted or bot opponents, unfinished games (voided, void at a stop, or still running), draws, and mirror games (§2.4).
- A finished game of a match that later ended with no result counts like any other game.
- Games count once their event has finished or stopped; a live event is never rated.

**Why games, not matches:** a game is the smallest outcome, and best-of-3 match wins add little information beyond the games. Match records are shown alongside.

**Not separated:** deck quality. The rating credits the whole pipeline, draft and build included. Deck quality is described without simulated games (§5.2).

### No Fixed Anchor

Ratings are model against model only. There are no games against the engine's built-in AI: it isn't a meaningful opponent, and it changes as phase-rs evolves. Ratings are centered so the unweighted mean of the identities in each connected group is 1500 (every identity counts once, however many games it has).
- **Consequence:** a group's absolute scale can shift as its population changes; a new, sparse row moves 1500 a little. Differences between ratings don't depend on the centering. Compare within a group and a time window.
- **Stability** comes from overlap: widely played models appear across many events and tie the scale together.

### Uncertainty

- **Replication unit: the event, and the contributor.** Games in one pod share decks, packs and opponents, so they aren't independent; a contributor's tables share a configuration too.
- **Bootstrap.** Resample events with replacement, keeping each event's games together; refit; take the 2.5th and 97.5th percentiles (1,000 replicates, seeded). Once a board has 5 or more contributor clusters, a contributor's events are resampled together as one cluster (an event with several contributors, such as a lobby table, stays its own cluster). Deviations are scaled by √(G/(G−1)) for G clusters, the usual small-sample correction.
- **Laplace floor.** With very few events the bootstrap can't see enough variation (a single 3–0 match resamples to the same data every time). So the **reported range is the wider of** the bootstrap interval and the Laplace interval `R ± 1.96·SE` from the posterior curvature, with SE relative to the group average.
- **Contributor variance.** The Laplace SE adds a contributor component in quadrature: 30 Elo × √(Σ share²), where the shares are the fractions of the identity's games each contributor supplied. For a rating carried by one contributor that alone is ±59 Elo at 95%; spread evenly over ten contributors, about ±19. Configurations differ between contributors, and a rating should describe the model, not one person's setup.
- **Set variance.** A set component is added the same way: 30 Elo × √(Σ set share²) over the sets the identity's games were played in. A model may know one set's cards and archetypes better than another's (a set released after its training data, say); every event of that set shares the effect, so resampling events can't see it. A rating from one set gets ±59 Elo from this alone; one spread evenly over eight sets, about ±21. A set board rates strength in its own set, so it has no set component. Without it, simulated ranges fell short as samples grew (93% at 120+ games in the central scenario); with it, 95%.
- **Calibration.** In simulation these ranges cover the truth 94–97% of the time across the design scenarios, 96% in the central one (§6). Stress tests that break the model's assumptions on purpose (a spread wider than the prior, non-transitive matchups, large set effects) cover 83–92%.
- **Connectivity.** Ratings are comparable only between identities connected by games, directly or through common opponents. When a scope splits into disconnected groups, the export lists them (`connected_groups`), each row says which it is in (`component`), and ranks never compare across groups.

### Ranking

We rank A above B only when the **95% interval of the difference R_A − R_B excludes 0**. The interval is the wider of the bootstrap interval of the difference and the Laplace interval from the posterior covariance (with the contributor component for both rows). Testing the difference directly is sharper than asking whether two ranges overlap: overlapping ranges need a gap of about 3.9 standard errors, a difference test about 2.8, and the difference uses what two ratings fitted against common opponents share.
- **Rank range:** best = 1 + rows credibly ahead, worst = N − rows credibly behind, where N counts the rows on the default ranking in the same connected group (`rank_range`, `rank_of`). A row whose range is 1–N is "too early to rank". Unknown Effort rows get a range only among all rows (`rank_range_all`).
- In simulation this ranks 28% of pairs against 13% for non-overlapping ranges, and 1.1% of ranked pairs are in the wrong order (central scenario; 0.7–3.6% across the design scenarios, worst when models are close). Two identities 100 Elo apart at 4 × 2 Private Tables are told apart half the time after about 180 games each, and 80% of the time after about 570.
- **Overlapping bars don't mean "not separated".** Two ratings fitted against common opponents share much of their uncertainty, so their difference is known more precisely than either rating. Every rank, rank range and "ahead of" sentence comes from the difference intervals (published per board as `Board.differences`, and in the open data as `rating_pairs`), never from whether bars overlap.
- The generated summaries ("too early to rank", "ranks first", "share the top spot") follow these decisions.

### Several Comparisons

A board makes many comparisons at once, and the export builds many boards (every group × set × provenance), so some "credibly ahead" calls will be chance. Two places guard against it (`packages/site/src/multiplicity.ts`):
- **Effort Ladders** (§2.3): each step's p-value is read off its difference interval, and the steps of one ladder are **Holm-corrected** together. A step is "rated higher" only when it holds after the correction and neither row is provisional.
- **"Ranks first"** is said only of a row that is not provisional and is credibly ahead of every row in its group. On a set board or a single-provenance board (exploratory, one of many) it also needs those differences to hold after a Holm correction over its comparisons; otherwise the summary says the lead is exploratory. The main all-sets, all-tables board is the pre-specified headline and is not corrected.
- Rank ranges stay uncorrected per pair: in simulation they cover the true rank 99–100% of the time (§6).

### Provisional Ratings

A rating is **provisional** until the identity has, in that scope:
- at least **30 rated games** (at 50%, ±18 percentage points of win rate, about ±130 Elo);
- at least **3 events** (so one lucky pod can't carry it);
- at least **2 distinct opponent identities** (with one opponent, a rating is just a head-to-head record);
- games from at least **2 contributors**, with **none supplying more than half** of them. With exactly two contributors this needs an even split, so in practice a firm rating needs three or more.

Provisional rows are shown with their numeric range, marked, and sorted with the rest, but shouldn't be quoted as rankings. In one sentence, as the export carries it (`methodology.thresholds.rule`): "A rating is provisional until it has 30 rated games, 3 events and 2 different opponents, with games from at least 2 contributors and none supplying more than half of them."

### Contributor Influence

At every export each contributor's games are removed in turn and the scope is refitted. For each row the export keeps (`influence`):
- the contributor whose removal moves it most, and by how much (Elo, relative to the identities still rated);
- **flagged**: without that contributor the rating would leave its own 95% range, or would have no games left;
- **inconsistent**: the largest shift measured in its own standard errors (√(Var without − Var with), from the two fits' covariances) is at least 3.5, or no games would be left. This catches results from one contributor that disagree with everyone else's, such as a hostile configuration.

In simulation the range flag fires on about 2% of honest rows (4% averaged over every scenario) and the 3.5-z flag on about 4%. A contributor who ran 30% of all tables and seated a rival 150 Elo below its strength pulled that rival's rating down about 45 Elo while supplying under half of its games; the floor caught it early (26% at 6 tables), and the z flag caught it 39% of the time at 48 tables. No check is complete: a determined contributor below half of a row's games can bias it within its range. Read flagged rows with care, and prefer rows supplied by many contributors.

### Partial Pooling (Experimental, Off)

An optional fit (`MTGDT_RATING_POOLING=1`) replaces each free rating with `θ = μ(model) + ε(model, effort) + u(identity)`, with prior SDs 200 (model), 40 per effort level (80 for Unknown Effort) and 60 for the residual. A sparse row then shrinks toward its own model rather than toward the field, and the fit gives a model-level board and effort offsets. When on, the export adds them next to the headline (`BoardRow.pooled`, `Board.pooled`); the headline never changes.

In simulation it cuts the error from 85 to 57 Elo when the structure holds; when effort interactions are larger than its prior allows, the error still falls (89 to 74) but its ranges cover only 94%. It stays off until several models have two or more effort rows and real data can set its variance components.

### Validation

`npm test -w @mtgdt/site` runs the model on synthetic data where the truth is known: it recovers the true order of 6 identities over 60 pods; 95% ranges cover the true ratings; it recovers a planted play advantage and a planted deck-strength coefficient; relabeling sides gives the same answer; a 3–0 sweep stays finite with a wide range; disconnected groups are detected and never ranked against each other; a pair can be ranked by its difference while the two ranges overlap; the contributor floor and influence flags catch a planted sandbagging contributor; a sparse row moves toward its own model under partial pooling; and a seeded run is deterministic. The calibration (`packages/site/src/calibrate.ts`, §6) simulates whole communities and is reported in `analysis/results/calibration.md`.

### 4.1 Outcomes

Outcomes are what an agent achieved against other agents, from **the same rated games as its rating**. They are results, not inputs to the rating: the rating summarizes them.
- **Games won** and **matches won.** A match is one pairing of two seats in an event, decided by its rated games. A match whose rated games are level (for example when one of its games isn't rated) counts as drawn and is left out of the match rate. A match with no result (§3.2) counts its finished games and no match.
- **On the play** and **on the draw**: games won by who went first, **in game 1 of each match** only (random, by seed).
- **Event finishes**: the seat's place in the final standings, and events won (a tie at the top has no winner).
- **Swiss finishes**: the count of 3–0, 2–1, 1–2 and 0–3 finishes and the **3–0 rate** (12.5% is average with 8 seats).
- **Head to head**: games and matches between each pair of identities.
- **Records, not rankings.** Raw win rates depend on who else sat at the tables: under Swiss pairing a strong seat meets strong seats from round 2 on, which pulls its raw rate toward 50%, and a 3–0 at one table is a 0–3 for someone else. They are shown as records with their context, never sorted or compared across rows. The comparable number is the rating, and its **expected score against an average opponent** (`expected_score`: the win probability against a 1500 opponent, with its range).
- **Ranges.** Every rate carries a 95% range: the wider of a two-stage cluster bootstrap (events, then items) and the **Wilson** score interval, since with few events the bootstrap alone makes a 3–0 look certain.
- **Model level.** A model's results pool its effort levels within one group (§3.3) and leave out games between two of its own levels.
- **Summaries.** Each board and model gets a generated sentence ("As of <date>, …"). They are deterministic templates over these numbers, lead with outcomes and say "too early to rank" until a difference interval excludes 0.

## 5. Diagnostics: How Agents Draft, Build and Play

Diagnostics describe behavior. They are not scores, none of them feeds the rating, and they are never ranked. They help explain results (a deck that fails basic checks tends to lose) and show where agents differ. Model pages show them next to the median of all agents.

The rule (docs/METRICS.md): to measure a stage, hold its input fixed, vary who performs it, and measure the output with a yardstick that doesn't depend on the agent. Each diagnostic is aggregated per identity over the same scope as its rating. Ranges use a two-stage bootstrap (events, then items within events: picks, decisions, games). An estimate from a single event is shown, but its range reflects only within-event noise.

### 5.1 Draft

Good picks depend on context: what you already have (colors, curve, creature count, duplicates, synergies), the pick number, and what the neighbors are passing. Every set gets the **core draft metrics** below. They need only card data and the event log, so a set with no human data is scored as fully as any other. Sets with 17Lands public data also get a **comparison with human drafters**, shown next to the core metrics, never in place of them.

**Card quality (card data only).** Where a metric needs to know whether a card is good, it uses a heuristic estimate of its Limited value computed from phase-rs card data (`cardQuality` in `packages/director/src/ratings.ts`, version `cq-1`). The same estimate makes fallback picks for a silent seat and builds reference decks in sets without human data. It is on the scale of a games-in-hand win rate (about 0.47–0.63; filler is about 0.535) and adds up:
- a base by rarity (common 0.535 to mythic 0.560), plus a little for creatures;
- for creatures, power + toughness against twice the mana value (±0.012 at most), and a little for an enters-the-battlefield effect; defenders lose a little;
- combat keywords (flying, menace, deathtouch, double strike, …; at most +0.02);
- the strongest interaction in the rules text: destroy or exile, damage to a creature, −N/−N, fight and bite, Pacifism-style auras, edicts (+0.015 to +0.025); sweepers, bounce, counters, tapping (less);
- card draw and token makers (at most +0.012);
- what it costs to play: three or more colors, three or more pips of one color, colorless filler, expensive non-creature spells without interaction; non-creature cards that neither interact nor draw lose 0.01.

Against human games-in-hand win rates it is a rough guide, not a substitute: Spearman ρ = **0.19–0.40** over the 9 sets with 17Lands data, against 0.08–0.35 for rarity alone (`analysis/results/card-quality.md`). Its weights were set by inspection on those same sets, so this is not a held-out test. The core metrics use it only to decide which passed cards were worth taking, never to grade a pick.

**Core draft metrics (every set)**
- **Pick-to-deck conversion:** the share of real (not forced, not forfeited), non-basic picks that made the final main deck, overall and for pack 1. Wasted picks are speculation that didn't pay off, or poor reading.
- **Commitment pick:** the overall pick (1–42) from which the seat's two most-taken colors equal its final pair and never change again. Descriptive: early is not better. Empty when the pool's most-drafted colors aren't the deck's.
- **Color flow and flow alignment (signal reading):** which colors were open in pack 1, picks 2–9 (the cards upstream seats chose to pass). Each non-land card in those packs adds its card quality above filler (`max(0, quality − 0.535)`) to the colors it needs, split evenly for gold cards; colorless and hybrid-only cards add nothing. `flow` is each color's share; `flow_colors` are the top two. **Flow alignment** is the share of the final pair among those two. A random pair scores 0.4 on average.
- **On-color rate:** the share of real, non-land picks in packs 2–3 that the final colors can cast (colorless and hybrid cards count as on-color).
- **Pair changes:** how many times the seat's two most-drafted colors changed from its 6th pick on. Descriptive: one change can be good reading; many are wandering.
- **Role coverage:** the final main deck against 40-card Limited norms, as the share of checks passed. A two-color deck is checked against **its set and color pair's 17Lands norms** when `sets/<SET>/deck-norms.json` has at least 200 winning decks of that pair: the 10th–90th percentile of decks with 6+ wins (lands one wider each way, since nearly every winning deck runs 17). Each deck says which (`basis`, `bands`, `source`). Other decks (mono-color, three colors, thin pairs, sets without 17Lands data) use generic bands:

  | Check | Passes when |
  |---|---|
  | `lands_16_18` | 16–18 lands |
  | `creatures_12_plus` | at least 12 creatures |
  | `early_6_plus` | at least 6 non-land cards at mana value ≤ 2 |
  | `top_end_6_max` | at most 6 non-land cards at mana value ≥ 5 |
  | `avg_mv_2_5_3_5` | average mana value of non-land cards 2.5–3.5 |
  | `interaction_2_plus` | at least 2 interaction spells (removal, sweepers, bounce, tapping, counters, from rules-text patterns) |

  The generic bands are common Limited guidance and line up with the 10th–90th percentile of winning human decks in the 9 sets with 17Lands data, but they aren't fitted to any set. Creature-light formats and archetypes (FIN's winning decks run 8–15 creatures; SOS Prismari control runs 4–13) are why per-pair norms replace them where data exists. Each deck's counts are exported with the checks. Role coverage covers every deck, delegated builds included, because it reflects the pool as much as the build.

**Compared with human drafters (sets with 17Lands data only)**

These measure agreement with strong human drafters. They are a reference layer: shown where the data exists, labeled as a comparison with humans, and never a headline number. At Set Context + Human Stats the agent sees 17Lands numbers itself, so they are partly circular there.

- **Archetype-conditional value** (needs `sets/<SET>/17lands-archetypes.json`):
  - A card's value is its 17Lands games-in-hand win rate **in decks of the drafter's color pair** (`analysis/draft_eval/archetypes.py`), listed only if it was in at least 50 main decks of that archetype, and shrunk toward the card's overall rate (empirical Bayes).
  - **Archetype regret (hindsight):** for each real pick, the best value in the pack minus the value of the card taken, both within the pair of the seat's final deck.
  - **Archetype regret (current):** the same, within the two colors the drafter had taken most up to that pick (from pick 6 on): the pick judged by what the drafter knew then.
  - A card with no value in the pair counts as replacement level (the pair's 10th-percentile card). Only listed cards can be the pack's best, so an off-color bomb doesn't count as a missed pick.
  - In percentage points of win rate; lower is better.
- **Expert pick model** (needs `runs/<id>/draft-eval.json`): a model trained on 17Lands draft data from strong human drafters reads the pack and the pool so far and gives each card a probability. Per identity: **mean log-likelihood** of the agent's picks (`p` floored at 10⁻⁴), **top-1 and top-3 agreement**, and **mean EV regret** in percentage points, each also by pack (early picks are about power, later picks about fit). Held-out strong human drafters are scored the same way for reference. Agreement with humans is not the same as being right.
- **Signal alignment by win rate:** color flow with each passed card weighted by `GIH WR − set average` (floored at 0) instead of card quality.
- **Naive baselines:** the **top-pick rate** (picks of the pack's highest-GIH-WR card), **GIH regret** and **in-lane GIH regret**. They ignore the pool and the pick context and reward rare-drafting: sanity checks, never a draft score.

### 5.2 Build

- **Legality:** the main deck has at least 40 cards, all from the pool, never more copies than were drafted. The Director enforces the pool and the copies; we report the 40-card share.
- **Deck review:** the Director shows its exact count of the submitted deck and flags rule breaks before the deck locks; the agent confirms or resubmits once. `deck_built` logs the outcome (`review.outcome`: confirmed, resubmitted, forfeit), the flags of the submitted and the final deck, and every rejected answer, so build scores can separate a model's first attempt from its corrected one.
- **Sanity checks:** 40–41 cards; 15–18 lands; at least 6 sources for every color two or more non-land cards need, and 3 for a single-card splash; every non-land card castable from the deck's lands. The score is the share passed; the export also counts each failed check.
- **Delegation:** how often the agent handed the build to the reference builder. Those decks are excluded from build scores.
- **Role coverage** (§5.1) applies to every deck.

**Compared with human decks (sets with 17Lands data only).** A reference layer, never a headline number.
- **GIH build gap (baseline):** the average GIH WR of the best same-colored pool cards minus the deck's, over as many cards as the deck has non-land cards. Positive means playable cards stayed in the sideboard, by raw win rate.
- **Archetype build quality** (`packages/site/src/build-quality.ts`, mirrored and validated by `analysis/draft_eval/build_eval.py`):
  - *Card value in the deck's pair P*: `w · lift + (1 − w) · overall`, where `lift` is the card's shrunk GIH WR in P minus P's base win rate plus the set baseline, and `overall` its overall GIH WR. Thin cells use the overall rate. A splashed card uses its value in P if 17Lands has enough splashed copies, else overall plus the set's splash penalty (−1 to −2 points). A card with a colored pip no land in the deck produces is **dead**: P's replacement level.
  - *Build quality* is the mean value of the non-land cards. *Expected win rate* = `σ(logit(baseline) + b·(quality − ref)·100 + c·(base[P] − baseline)·100)`.
  - *Reference build*: the Director's `autoBuild`, re-implemented read-only. *Best build*: for every pair, the top castable cards by value with the median land count of winning human decks in that pair; the pair with the highest expected win rate.
  - *Per seat*: `build_quality`, `reference_quality`, `build_delta_pp`, `vs_best_pp`, the same deltas in expected win rate, and **structural flags**: counts outside the p10–p90 band of **winning human decks** (6+ wins) in the same pair (`sets/<SET>/deck-norms.json`).
  - **Validation** (held-out 17Lands games, `analysis/results/build-quality.md`): per-game AUC **0.548–0.567** over 9 sets, which beats or ties (within 0.001) the mean overall GIH WR of the same cards in every set; deck-level correlation with win rate **r = 0.18–0.25**. With player skill and play/draw held fixed, b = 0.11–0.24 logits per point, 8–20 standard errors from zero. A set's `validated` label means only that it **beats or ties the naive baseline**; the gain is 0.001–0.014 AUC at most, not a meaningful improvement.
  - **Reading it.** It is a modest predictor: one game is mostly luck, play and the opponent. The structural flags add no predictive power on human decks; they are **descriptive**, showing where a deck departs from what winning humans do. The reference builder ranks cards by overall GIH WR, close to this yardstick, so agent decks usually score a little below it; synergy and play patterns that 17Lands averages miss are invisible to the score. Read `build_delta_pp` together with the flags and the deck.

### 5.3 Play

- **Game and match record** against LLM opponents in the scope. Records, not rankings (§4.1).
- **Mulligans per game:** descriptive.
- **Not yet reported:** decision quality from win probability added and counterfactual rollouts (docs/METRICS.md).

### 5.4 Mana

Only for events with manual mana.
- **Manual-payment share:** payments the agent planned itself (its own tap plan, paid in full), out of those plus the payments it delegated to the auto-tapper option, which is allowed and recorded.
- **Engine-paid payments** are counted separately and never as the agent's own tapping (`auto_paid`), as are plans the engine had to top up (`topped_up`).
- **Payment failures per 100 planned payments.**
- Mis-taps (a payment that left a castable spell uncastable) are not detected yet.

### 5.5 Reliability

- **Rejected answers per 100 decisions:** answers the engine refused (illegal or malformed).
- **Withdrawn per 100 offers:** decisions replaced before an answer, usually because the game moved on. Diagnostic, not a fault.
- **Abandoned games:** the seat's games that never finished in an event that stopped.
- **Forfeits:** decisions the Director settled because the seat made no MCP call for 10 minutes while a decision was open: draft picks by the bot policy (`draft_pick.by = "forfeit"`, left out of the draft scores), the deck by the reference builder (`deck_built.by = "auto"`), and open games conceded (`game_over.forfeited_by`). After one forfeit, the seat's later decisions are settled at once until it calls again. A seat's first request gets a 30-minute grace, for seats connected by hand. A decision open for 30 minutes is settled the same way however often the seat calls meanwhile (`reason: "decision_limit"`; `DECISION_MAX_MS`), so a seat that keeps calling without answering can't hold its table.
- **Contributor reliability** (docs/LOBBY.md): a seat that played to the end without a forfeit is *finished*; one with any watchdog forfeit is *abandoned*. A contributor's reliability is finished / (finished + abandoned), shown from 3 seats on; contributors below 0.7 over 5 or more seats queue behind everyone else. Events the server stopped count for nobody.
- **Contributor points never affect ratings.** The Contributors Leaderboard (docs/COMMUNITY.md) rewards finished seats, rated games played, lobby seats and bounties for under-sampled models and sets, and pays nothing for winning. No rating, range, diagnostic or provisional flag reads points.

**How a forfeited game enters the rating.** A game the watchdog concedes for a silent seat counts as a **loss for that seat and a win for its opponent** everywhere: the match record, the standings, the rating, the outcomes and head to head (`FORFEIT_POLICY = 'loss'` in `packages/site/src/scoring.ts`; the export reports it as `methodology.forfeits`). This is the tournament rule: a player who leaves forfeits, so stopping a harness while losing can't remove the game. A harness that crashes is part of the agent system being measured, and short hiccups are absorbed: launchers relaunch a session that exits, and the watchdog waits 10 minutes before conceding anything. The cost is that a harness that crashes in long games is rated as playing worse. Only seat inactivity is a loss: voided games (engine failures) stay unrated, and a forfeited pick or deck isn't rated (only games are). Two other policies stay implemented for sensitivity runs: leaving the conceded game out (`exclude-game`), and leaving out every rated game of a seat that forfeited anything in the event (`void-seat-event`). Server-side failures are excluded under every option.

**Restarts are never held against a seat.** The watchdog pauses while the Director restarts for a deploy. After a resume, a seat that hasn't called since gets at least 15 minutes before the watchdog settles anything for it: its CLI may still be waiting out the deploy and its harness restarting.

### 5.6 Engine Issues (Card Bugs)

Each game is flagged when engine issues may have touched it (`packages/site/src/engine-flags.ts`):
- **swapped card cast:** a card swapped into the packs in place of an unsupported card was cast (§7);
- **refused action:** the engine refused an action it had listed as legal (an agent's listed option, or an automatic pass or payment the Director made for it). Refused *structured* answers (attackers, blocks, card lists) are agent errors and count under reliability (§5.5);
- **unimplemented effect:** phase-rs resolved an effect it doesn't implement (it does nothing), or a card whose mechanics phase-rs lists as not implemented was cast (from phase-rs's own diagnostics, logged as `unimplemented_effect`);
- **rules issue:** an agent called `report_rules_issue(card, note)` during the game (the tool never affects the game);
- **known-issue card:** a card on the known-issues list (`engine/known-issues.json`: suspected or confirmed, or fixed only in a later phase-rs release) was played without an override fixing it. A card becomes *suspected* when at least two different seats report it in at least two different games; a person confirms it by reproducing it in a scripted game, or marks it not a bug (docs/CARD-OVERRIDES.md). Agents agreeing is a reason to look, never proof.

The Director logs `card_played` for every spell cast and non-mana ability activated, and the card on every decision. Flags are published per game (`engine_flags`) and per card (the set page's engine section). **Card swaps are not engine faults**: the game is played by the rules with a different card. So the export counts them apart from **rules errors** (known-issue cards without their fix, unimplemented effects, refused actions, rules reports), with the games where the implicated seat lost as an upper bound on the games where an error mattered (`engine.split`). A set page leads with rules errors.
- **Impact test:** flagged against unflagged finished games, for games between two LLM seats and for all agent games. *Win-rate swing:* in flagged games where exactly one seat is implicated, how often that seat won, minus 50% (negative means engine problems cost the player they touch), also per kind of flag; and the differences in rejected answers per 100 decisions and in game length. Ranges: the event bootstrap, and for the swing the wider of that and the Wilson interval.
- **When it matters:** a card or mechanic with a real effect is listed on the set page, its games can be left out of the rating in a sensitivity analysis, and it becomes a priority upstream fix.
- **Fixing a card locally:** a card override changes the card data phase-server runs from the next event on, never during one. Finished events keep the card behavior they ran with (their `card_data` record), and their flags stay as they were.

### 5.7 Efficiency

- **Median seconds per decision** and **per pick**, measured by the server from offer to answer.
- **API-equivalent cost** as the harness reports it for the whole seat (for Claude Code, the transcript's `total_cost_usd` at list prices, summed over its sessions), per seat and per game, only when every session of the seat reported one. Seats on a subscription didn't pay this.
- **Estimated cost** where the harness doesn't report one: the seat's token counts (input, output, cache reads, cache writes) at the model's list price on the event's start day, from the provider's official pricing page (`registry/prices.json`, with the source and the date it was read). Long-prompt pricing tiers and 1-hour cache writes are priced as the provider lists them. Checked against a harness's own report on a full 8-seat table, the estimate came within 0.2%. Every cost says whether it is `reported`, `estimated` or `mixed`; models without a listed price show none.
- **Cross-checked:** a reported cost of $0 with tokens used, or one more than 35% from the estimate, is replaced by the estimate and the seat counts in `seats_flagged`. A cost from an uploaded usage summary is the contributor's own figure, so it is re-priced from its token counts where it has them. A harness log the CLI can't read is reported as such, never turned into a silent $0.
- **Output tokens per decision**, where transcripts exist.
- **Per condition, with its coverage.** Cost per game is never pooled across conditions that change it: the table format and the seat's context policy (one long session cost about five times a fresh session per game for the same seat, §10). `cost` is the main condition's (best of 3, fresh session per game); `cost_conditions` lists every condition. Each says what it covers ("Based on 9 of 22 seats, at 2 of 8 tables").
- **Games played** on a model page count each game once: a game between two of the model's own seats is one game (`played.games`, with `played.mirror_games`).

### 5.8 Set Findings

A set page describes how language-model agents draft and build a format: the most drafted color pairs and their records, the typical deck, when colors settle, first picks, which cards agents take and how early, and where their picks differ from human drafters'. The rules:
- **Only all-agent tables.** A table feeds set findings only when it finished and all 8 seats are language-model agents (§3). Other tables stay on the site (`in_set_findings: false`, counted in `insight.excluded_events`).
- **Independent drafts, not tables.** Running one seed again opens the same packs, so re-runs of a seed are **one draft**. A finding about pairs needs at least **8 agent decks from 3 different drafts** (`SET_INSIGHT_MIN`); below that the set shows only its sample size.
- **Early Test Data is named.** A finding drawn from Early Test Data tables says so, with the number of tables.
- **Agents against human drafters: picks with a real choice only.** In a closed pod every card is taken by the last pick, so late picks are forced. The comparison with 17Lands' average taken at (ATA) uses only an agent's picks **1–9 of a pack**, and lists a card only with at least **5 such picks from 3 different drafts** and a gap of at least **1.5 picks** (`pick_gaps`). It is a reference layer, never part of a rating.
- **Model pages** show the cards a model reaches for by pick within the pack, first picks from every pack, and "most picked" from picks 1–5 only: at a table where one model holds every seat it takes every card, so its late picks say nothing about preference.

## 6. Reading the Numbers: Thresholds and Calibration

| What | Shown | Treated as reliable when |
|---|---|---|
| Rating | always, with its range | not provisional: ≥ 30 games, ≥ 3 events, ≥ 2 opponents, ≥ 2 contributors with none above half |
| Rank | always, as a rank range | the 95% interval of a rating difference excludes 0 (in simulation, 0.7–3.6% of ranked pairs in the wrong order) |
| Influence flags | when two or more contributors supplied a board | a flagged row depends on one contributor; read it with care |
| Core draft metrics (§5.1) | always | range from ≥ 2 events |
| Human-reference build quality (§5.2) | sets with archetype data | the set beats or ties the naive baseline; ≥ 2 events for an identity's mean |
| Other diagnostics (§5) | when computable | range from ≥ 2 events |
| Human-reference draft metrics | sets with the input files | ≥ 100 rated picks |
| Outcome rates (§4.1) | always, as records with ranges | range from ≥ 2 events |
| Cost (§5.7) | finished seats with a harness report or token counts and a listed price | ≥ 3 seats; per condition, with the seats and tables it covers |

Never compare numbers across comparability groups: a model with the Set Context and a model without one never met.

**Calibration** (`analysis/results/calibration.md`). Pure simulation with the production rating model: 17 scenarios × 200 simulated communities, fitted after 6, 12, 24 and 48 tables, plus 400 simulations of two identities 100 Elo apart.
- *Tables:* every table seats 8 agents and plays a 3-round Swiss, best of 3, paired by the Director's own code; half are Private Tables (one contributor, 4 identities × 2 seats), half lobby mixes of 3–4 contributors with 1–3 seats each. Only game 1 of a match enters the play term, as in the fit.
- *Identities and contributors:* 12 or 24 identities with Zipf popularity (48 in the pooling scenarios); 4 or 10 contributors with Zipf activity, whose configurations shift an identity by SD 0, 30 or 60 Elo.
- *True skill:* SD 50 or 100 Elo, with model × set effects of SD 30 Elo; one scenario drifts each identity by SD 100 Elo over the 48 tables.
- *Deck luck:* a per-seat, per-event deck effect of SD 0.25 or 0.5 logits (17Lands decks spread at least 0.23–0.29 logits).
- *Play advantage:* 20 Elo (17Lands: 15–33).
- *Forfeits and no-result matches:* a setup goes silent in 0.5% of its games (a flaky tenth of setups 4%; one scenario 30% at 8%) and loses them; 0.5% of games (2% in that scenario) are lost to infrastructure and end their match with no result.
- *Adversary:* one contributor runs 30% of the tables and seats a rival identity 150 Elo below its strength.
- *Stress tests* (data that break an assumption on purpose): skill SD 200 and 300 (as wide as the prior, and wider), a non-transitive matchup term, and model × set effects of SD 80.

| Finding | Evidence |
|---|---|
| Ranges are **calibrated in simulation** | 94–97% coverage across the 13 design scenarios, 96% in the central one, at every sample size (95% with 120+ games). Without the set component the same design covered 92–96%, falling with sample size. |
| **Stress tests** fall short, as they should | 83–92%: a spread as wide as the prior 92%, wider than it 83% (the strongest and weakest rows are pulled about 140 Elo toward the middle and covered 59% of the time), non-transitive matchups 92%, model × set effects of SD 80 91%. Predictive checks on real data are the guard. |
| **Difference-based ranking** needs far fewer games | 28% of pairs ranked (13% by non-overlap), 1.1% of them in the wrong order. 100 Elo apart at 4 × 2 Private Tables: told apart half the time after about 180 games each (13 tables), 80% after about 570 (41 tables); at lobby tables, half the time after about 200 games (27 tables), 80% not within 48 tables. |
| **30 games** is the smallest floor that's more signal than noise | At 30–59 games ratings explain 63% of the true-strength variance (RMSE about 60 Elo) in the central scenario. |
| The **contributor floor** is what binds | Among rows with 30+ games it keeps about a fifth to a third provisional when half the tables are Private Tables, 6% when every table is a lobby mix, and 75% when 4 contributors run only Private Tables. |
| **Weight caps** don't pay | A 50% cap moved the sabotaged row by 2 Elo, a 30% cap by 11, at the cost of 3–12% wider ranges for everyone. |
| **Partial pooling** helps accuracy but isn't ready | Error 85 → 57 Elo with the true structure; coverage 94% when its prior is too narrow. Off (§4). |

**Caveats.** These are simulations of an assumed world, not measurements of real models. If real models differ by only about 50 Elo (SD), small samples resolve little: read the rank ranges, not just the provisional flag. The lobby now allows up to 4 seats per contributor, so a lobby table can hold just two contributors, a mix the simulation didn't include; rows from such tables lean on the contributor floor and the influence flags like Private Tables do. We will recheck the prior and thresholds once real data shows the actual spread of skill.

## 7. Known Biases and Limitations

- **Who played is self-reported.** On hosted tables the games are genuine, but the harness configuration, the effort and even the model are what the contributor says, checked against the contributor's own logs where they send them (§2.1). At a Private Table one contributor controls every seat (§3.1). The contributor floor and influence flags limit what one contributor can do; they can't rule out a determined contributor below half of a row's games.
- **The engine isn't the game.** phase-rs runs cards from parsed Oracle text, and some cards are wrong or unsupported:
  - Cards the engine can't run are **swapped out of packs** for a supported card of the same rarity from the same sheet. Every swap is logged with the event and published, and games where a swapped-in card was cast are flagged (§5.6). In sets with many unsupported cards, the draft differs noticeably from the printed set; `bench check` and `GET /api/sets` report each set's coverage, and older sets have more swaps.
  - **Card overrides** fix cards phase-rs scripts wrongly, and some make an unsupported card play as printed so it stays in packs (docs/CARD-OVERRIDES.md). Each is written by a person against the Oracle text and the Comprehensive Rules, tested in scripted games, pinned to the exact upstream card entry and retired once phase-rs fixes the card. Overrides cover only what card data can express; cards that need engine code stay swapped out.
  - Misparsed cards can still misbehave silently until someone notices. Agents can report rules issues, and reported cards are triaged (§5.6), but agent reports are a reason to look, never proof.
  - Both seats of a pod draw from the same card pool, so engine problems mostly add noise; card-level conclusions are flagged.
- **Harness differences are pooled into each row.** A row is a model at an effort level, whatever harness ran it, so a model run mostly through a stronger harness rates a little higher than the model alone would. The harness split (§2.3) shows how each harness did.
- **Forfeits count as losses** (§5.5), so a harness that crashes or stalls is rated on the games it lost that way. Voided games (engine or server failures) are never rated.
- **No bot drafters at rated tables.** The bot draft policy only picks for a seat the watchdog found silent (17Lands ratings where the set has them, otherwise the card-quality heuristic); those picks are flagged and excluded from draft scores. A silent seat still drafts passively for the rest of the table, which affects what its neighbors are passed.
- **Early Test Data isn't rated.** Tables from testing before launch (best of 1, or best of 3 without sideboarding, some with only 2–3 agents and scripted drafters) stay visible and labeled. Treat what they show as a first look, not results.
- **Lobby tables mix contributors.** A contributor holds at most 4 of 8 seats, seat positions come from a secret seed, and agents never see who sits where. Covert cooperation between one contributor's seats (signaling through picks, throwing games) is not prevented outright; the mitigations and residual risk are in docs/LOBBY.md §7.
- **Human reference data is about humans.** 17Lands values come from human players on MTG Arena. A card that's strong against humans may be weaker against agents, and the other way around. That is why it is a comparison layer and nothing that ranks agents depends on it.
- **The human reference is Premier Draft data, on purpose.** Our matches are best of 3; the 17Lands data behind the human-reference layer is Premier Draft (best of 1), by far the richest public 17Lands data. Card quality, archetype strength and deck-building norms carry over in aggregate; cards whose value depends on sideboarding are where the two differ most.
- **The card-quality heuristic is rough** (ρ ≈ 0.2–0.4 with human win rates). The core metrics use it only to weigh which colors were flowing.
- **The draft yardsticks are human-derived.** An agent that finds a genuinely new, better strategy would score badly on them and well on the rating. That is one more reason the rating stays the headline.
- **Set Contexts exist only for some sets** and differ in depth. Their effects are set-specific.
- **Any set can be played.** Every set with phase-rs booster data (about 175) can run as a Private Table; the lobby features the newest sets.
- **Samples are small at first.** The rating model handles unbalanced designs, but not selection effects: Community submitters might send only events their agents won. Hosted tables report every finished or stopped event, which is why they are the main path. Until replay verification exists, Community results rest on trust.
- **No common random numbers yet.** Games aren't seeded (phase-rs picks its own seed), so a pairing can't be replayed with decks swapped. Expect more luck per game than a duplicate format would have.

## 8. Inputs Other Tools Provide

The export reads these files when present and ignores them otherwise. Field names are what the reader accepts; producers should use the first form.

| File | Producer | Fields read |
|---|---|---|
| `runs/<id>/source.json` | the submission pipeline (the Hub) | `label` (`verified` for a hosted table, `community`, `smoke` for a test run), `submitter?` (the uploader's public handle), `submitter_id?` / `contributor_id?` (the uploader's Hub id; the export shows only a salted hash of it), `submitted_at?`, `exclude?` (reason string), `note?` |
| `deck_strength` lines in `runs/<id>/events.jsonl` (else `runs/<id>/strength.json` → `results`) | `packages/director/src/strength.ts` (experimental bot duels, not part of the methodology) | `seat`, `deck` (`submitted` or `reference`), `games`, `win_rate`, `ci95`, `build_delta`, `method`, `gauntlet`, `pilots`, `engine`. The latest record per seat and deck wins. |
| `runs/<id>/draft-eval.json` | expert pick model (`analysis/draft_eval`) | `seats: { <seat>: { picks: [{ pack_number, pick_number, card, p_pick, rank, ev_regret_pp, in_lane, top }] } }` (or a flat `picks` list with `seat`). `rank` is 1-based; a file with `rank_base: 0` or any rank 0 is read as 0-based. Also `model: {name, version, trained_on}` and `reference: {top1, top3, mean_log_p, …}` for held-out strong humans. |
| `sets/<SET>/deck-norms.json` | `analysis/draft_eval/build_eval.py` | `scoring: { baseline_win_rate, splash_delta, archetype_weight, quality_ref, slope_logit_per_pp, pair_base_logit_per_pp, validation, verdict }`, `pairs[<pair>] = { decks, lands, nonland, creatures, two_minus, five_plus, avg_mv, src_primary, src_secondary, src_splash (each [p10, p25, p50, p75, p90] of winning human decks), splash_share, quality, replacement }`. Regenerate after `17lands-archetypes.json`. |
| `sets/<SET>/17lands-archetypes.json` | `analysis/draft_eval/archetypes.py` | `cards[<name>].by_archetype[<pair>]` = an array ordered by `by_archetype_fields` (`gih_wr`, `gih_games`, …), or `archetypes[<pair>].cards[<name>] = {gih_wr, gih_games}`. Optional `min_games`. Mono-color buckets are kept; 3-color buckets are ignored. |

## 9. Reproducibility and Changes

- Every event logs its seed (packs), conditions, the hash of its prompt files, the engine build and protocol, the hash of the card data phase-server ran and the overrides in it, the Director commit and the hash of its Set Context.
- The export records the methodology text it was built with (`index.json → methodology.doc_sha256`), the rating settings, thresholds and the forfeit policy.
- The rating and bootstrap are seeded per board, so the same logs give the same numbers.
- The open data (docs/OPEN-DATA.md) carries the redacted event logs, so anyone can recompute every board.
- Changing a definition on this page is a methodology change: it is listed in `CHANGELOG.md` with its date, the export schema is bumped if a value changes meaning (docs/SITE-DATA.md), and every board is regenerated, so old and new numbers are never mixed.

## 10. Open Questions

- **Context policy: part of the identity, a condition, or neither?** A fresh harness session per game is the default for seats the `bench` CLI starts: on a one-seat test it cost about a fifth as much as one long session for the draft and four games. What a fresh session would lose is carried by the decision text (the match so far, with the opponent's cards from earlier games) and by reading the Set Context in every session, so the knowledge level is the same under every policy. Its effect on play is untested. Boards pool across policies and report results per policy (`SeatRef.context_policy`, the mirror check's policy split, cost per condition). We will compare win rates between policies for the same model and effort once both have enough rated games, and split rows only if the difference holds. How a harness carries a long conversation is arguably part of what a row measures, so the question stays open until then.
- **The prior and the thresholds.** SD 200 Elo and the 30-game, 3-event, 2-opponent floors come from the simulation in §6. We will recheck them once real data shows the actual spread of skill.
- **Harness effects.** Harnesses are pooled (§2.3). If the harness split shows a consistent effect, splitting rows by harness would be a methodology change.
- **Partial pooling** stays off until several models have two or more effort rows (§4).

## 11. Future Work

- **Replay verification.** Once the engine supports deterministic seeds, the Hub re-simulates submitted decision logs, and Community submissions that replay cleanly earn a **Replay-Checked** label.
- **Latency-profile check for hosted seats.** The hosted Director measures every decision's latency, which a contributor can't forge. Reference profiles per model from seats Checked Against Logs could flag seats whose latency is far from their declared model's. Until there are enough checked seats per model, latency is shown as a diagnostic only.
- **Deck-swap rounds.** A round in which paired seats replay with their decks exchanged would separate piloting from deckbuilding. It needs a deck-familiarity term in the model and a lot of games (about 110 swap games per pilot to separate a 100-Elo gap), so it would run as a pre-registered study, off the headline.
- **A common minimal harness**, which would remove the harness question for the rows that use it.
- **Declaring prompt fingerprints equivalent**, so a typo fix doesn't split a group: a recorded mapping from prompt hashes to epochs, each entry a methodology change.
- **Display centering on a reference identity** per board, so sparse rows can't move 1500.
- **A seat-event random effect** (deck luck) in the fit itself, so the Laplace interval accounts for deck clustering without the bootstrap.
- **Drift checks** per identity (a model changing behind an undated id), and a check for results far outside a contributor's history.
