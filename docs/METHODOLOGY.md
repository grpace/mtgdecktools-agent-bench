# Methodology

This is the single source of truth for what the benchmark's numbers mean, which results may be pooled, and how sure we are about them. The report export ships it next to the data (`methodology.md`), and mtgdecktools.com renders it on the Methodology page. The code that implements it is `packages/site/src/rating.ts` (rating model), `packages/site/src/scoring.ts` (identities, contributors, groups, boards, diagnostics), `outcomes.ts` (results) and `summary.ts` (generated summaries). If this page and the code disagree, the code has a bug.

_Last updated Oct 23, 2026 (critic review: scripted seats by metadata, §3; Swiss version 2 and stopped events, §3.2; the play advantage from game 1, §3–4; several comparisons, §4; per-pair deck norms, §5.1; card swaps vs rules errors, §5.6; cost per condition, §5.7; the tier-score filter, §3). Decisions and their dates are listed in §10._

## 1. What we measure, in one paragraph

AI agents draft, build and play Magic: The Gathering Limited against each other. The **headline** is a rating from LLM-vs-LLM game results, with a 95% range. It is end to end: a seat that drafts and builds a better deck wins more, and that counts. The rating comes from game results and nothing else. Next to it we report **outcomes** (games, matches, play and draw, event finishes, head to head; §4.1) and **diagnostics**: descriptive numbers about how each agent drafts, builds, plays, handles mana, stays reliable and spends tokens (§5). Diagnostics may help explain results, but none of them feeds the rating: a poor deck shows up as lost games. Most events will be run by the community on their own harnesses, so every number is computed per **comparability group** (§3), carries its sample size and range, records who contributed the games behind it (§3.4), and is marked **provisional** until there is enough data from enough contributors (§4, §6).

## 2. Unit of analysis: the seat identity

A **seat** is one agent at one event. Seats are pooled across events by **seat identity**:

> **identity = canonical model + canonical effort** (for example `claude-sonnet-5-5/high`, shown as "Claude Sonnet 5.5 · High")

Both parts, and the harness each seat ran on, come from the **model registry** (`registry/models.json`, `registry/harnesses.json`; see `registry/README.md`), the one list of names every part of the benchmark uses:
- **Harness** (Claude Code, Codex CLI, Cursor CLI, OpenCode, …) is recorded per seat, never part of the identity (owner decision, Oct 23, 2026). Every seat plays through the same MCP game tools and is shut in to them, so the harness matters far less here than in coding benchmarks, and splitting each model by harness would spread its games thin and fill the board with near-duplicates. The harness still decides how a seat's effort and model are checked (its logs, its documented defaults), and its results stay visible as a descriptive split (§2.3). "Claude Code", "claude" and "claude-code" are the same harness.
- **Model** is the provider's exact API id. Case, spacing, punctuation, provider prefixes (`anthropic/claude-sonnet-5-5`) and dated snapshots never create a new row. Short names that move to each new release (Claude Code's `sonnet`) resolve to the model they meant on the event's start date.
- **Effort** is a concrete level on one canonical scale: `none`, `minimal`, `low`, `medium`, `high`, `xhigh` or `max`, plus Codex's `ultra` (subagents in parallel; its own unordered level, never treated as a higher `max`), or **Unknown** when it can't be established (§2.2). "Default" is never a row: a seat that ran at its harness's default gets the level that default actually is.
- **Prompts** are an event-wide condition (§3), not part of the identity.

**Resolved at entry, re-resolved at export.** The Director, the lobby and the `bench` CLI refuse names the registry doesn't know, with suggestions. `event_start` logs the canonical values and the strings as typed (`*_declared`). The export resolves those raw strings again with the current registry each time it runs. A registry fix, such as a new alias or a newly listed model, therefore merges or rates old rows at the next export without touching any stored log.

### 2.1 Model check

The declared model is self-reported. When the harness's usage is available (`usage-<seat>.json` in a bundle, a hosted seat's usage summary the `bench` CLI sent the Hub after the event, or the seat's transcript), the export checks it. The seat's **primary model** is the one with the most output tokens, ignoring the harness's helper models; Claude Code, for example, runs a small Haiku model for side tasks. Each seat gets one status:

| Status | When | Rated? |
|---|---|---|
| **Checked Against Logs** | The primary model in the harness logs resolves to the same canonical id as the declared model. | Yes |
| **Self-Reported** | No usage was submitted (a hosted seat whose usage summary never reached the Hub: started by hand without `bench attach-logs`, or the upload failed), or the harness doesn't report its model (Codex today). | Yes, and labeled |
| **Mismatch** | The usage shows another model doing the work, or several models without saying which did. | **No.** The seat stays on its event page with the reason. Its games are rated for nobody, and it contributes nothing to diagnostics. |
| **Unlisted** | The declared model, harness or effort isn't in the registry. This only happens on Private Tables run with `--unlisted-model`. | No, until the registry lists it. The next export then rates it. |

**Who read the logs.** "Checked Against Logs" means the logs agreed, not that we could see the agent play. Every check records who read the harness logs (`logs_read_by`): `contributor-cli` when the `bench` CLI or the bundle tool read them on the contributor's machine and wrote `usage-<seat>.json` (in a bundle, or for a hosted seat sent to the Hub after the event: `evidence.kind: "cli-local-logs"`, `self_attested: true`), or `export` when our export read a harness transcript the contributor submitted. Either way the logs come from the contributor; nothing stronger exists yet (see §11 for a server-side check).

An identity's check is the mix over its seats (`model_verification`: `verified` (Checked Against Logs), `self-reported` or `mixed`, plus counts). The Hub warns on a Mismatch (`anomaly.usage_model`), which holds a Community bundle for review, and records Unlisted and Self-Reported seats as info.

**Hosted seats send their usage after the event.** The hosted Director never sees harness logs. When the event ends, `bench play` (or `bench attach-logs`, for seats started by hand) sends the Hub a summary per seat it started: the model ids and token counts the harness logged, the effort level it logged and its version; never prompts or transcripts. The Hub takes it only from whoever seated those seats (a lobby seat's contributor, a Private Table's organizer, the Hub admin for admin tables), checks it against each seat's declaration and stores it as that seat's `usage-<seat>.json`, so the seat can be Checked Against Logs like a Community seat. It is self-attested evidence from the contributor's machine, no stronger than a bundle's.

**Self-Reported seats are rated, and labeled.** Hosted seats started by hand without their logs carry no harness usage, so excluding Self-Reported seats would leave much of the main path with no ratings. Their games count like any other; the label travels with every row, and the contributor checks in §3.4 apply to them as to everyone.

### 2.2 Effort

Effort changes what a model does, so it's part of the identity, and it must be a real level. Each seat's level comes from the best evidence available, in this order. The export records which (`effort_source`):

| Source | When | Label |
|---|---|---|
| `detected` | The harness's own logs show the level: Claude Code session files, Codex rollout files, OpenCode session exports, Cursor's model name (`registry/harnesses.json → effort_detection`). | Detected from Logs |
| `declared-explicit` | The `bench` CLI started the seat with an explicit effort flag (`effort_basis: "launch"`), and no logs say otherwise. The CLI never starts a seat on an implicit default. A level picked in an app seated by hand that keeps no usage logs (Claude Desktop, VS Code and the like; `registry/harnesses.json → seated: "by-hand"`) counts here too, unchecked. | Set at Launch |
| `self-reported` | A person declared the level for a seat they seated by hand (`effort_basis: "self-report"`, or older logs without a basis). | Self-Reported |
| `harness-default` | No level was set ("default", or "I don't know" in setup). The level is the harness's documented default for that model *at the harness version the usage reports* (`registry/harnesses.json → effort_defaults`, with source links and version ranges). This includes harnesses with no effort control (Gemini CLI). | Harness Default |
| `unknown` | No level was set, and the default isn't documented or the harness version is unknown. | Unknown |

Rules:
- **The logs win.** When detected and declared levels differ, the seat is rated at the detected level, and the Hub flags it (`anomaly.usage_effort`, which holds a Community bundle). If the level changed during the session (no level on 90% of turns), the effort is Unknown and flagged.
- **Unknown is its own row**, clearly labeled ("Unknown Effort"). It is never merged with a concrete level.
- **Unknown rows stay in the fit but off the default ranking.** Their games inform their opponents' ratings, so they are fitted like any other row. But an Unknown row mixes levels, so it isn't ranked next to concrete identities: boards rank rows with a recorded effort, and show Unknown rows on request ("Include Runs Without a Recorded Effort").
- **Rated tables need a level.** The lobby and the hosted table refuse seats without one wherever the harness can set effort. Unknown rows from Private Tables and older events are rated, and labeled.
- **Harness defaults assume a clean harness.** A settings file or environment variable can change the default (Claude Code: `CLAUDE_CODE_EFFORT_LEVEL`, project `effortLevel`; Gemini CLI: `modelConfigs`). Detected levels don't have this weakness, which is why detection comes first.
- **Old events re-resolve at every export**, like models. A newly documented default, or a version-range fix, applies to old seats without touching their logs.
- Agents aren't asked for their own settings: in probes they couldn't see them and guessed from the model name.
- **Fast serving mode** (Cursor's `-fast` models, Claude fast mode) is recorded per seat but isn't part of the identity: providers describe it as the same model served faster.
- **A launcher is not a harness.** The harness is what runs the model's tool loop (Claude Code, Codex CLI, Cursor CLI, OpenCode, Antigravity, Gemini CLI). An app that only starts harness sessions, such as T3 Code (which runs Claude through the Claude Agent SDK, Claude Code's harness, and Codex through the Codex App Server), is the seat's *launcher*. A seat declared `t3-code:claude-code` ("Claude Code via T3 Code") is Claude Code: that harness's levels, defaults and detection. The launcher is recorded on the seat (`launcher` in the export, shown in seat details) and its log is a fallback source for effort detection. Neither the launcher nor the harness is ever part of a row. T3 Code does give every session its own MCP server and adds instructions to it; that difference is recorded per seat, not ranked (§2.3).
- Seats seated by hand are matched to their harness's local session after the event (`bench attach-logs`), using decision text only that seat saw. Only the model, effort, fast mode, version and token counts are kept.

**Snapshots.** A dated snapshot behind a canonical id (`claude-sonnet-5-5-20261101`) is the same leaderboard row. The export records which snapshot each seat's usage showed (`snapshots`) and flags snapshots the registry doesn't list (`unknown_snapshot`), so a silent model change is visible without splitting the row. We split a row only when a provider ships materially different behavior under one id. That is a methodology change (§9): the new snapshot gets its own registry entry.

Two seats with the same identity in one event are one identity: their games against each other are not rated (self-play carries no information about relative strength), and both seats' picks, decks and decisions feed its diagnostics.

### 2.3 Effort comparisons, and harnesses

The same model at two effort levels is two identities, and games between them are rated like any other: Claude Haiku 5.5 · Low against Claude Haiku 5.5 · High is a rated game. The same model at one level on two harnesses is **one** identity: Claude Sonnet 5.5 · High through Claude Code and through Cursor CLI is a mirror, so games between them aren't rated (§2.4).

**Effort levels stay separate.** Effort changes how long a model thinks and what it spends, and finding out whether that changes results is the point. Merging "Claude Sonnet 5.5" across levels would hide exactly that, and would make a model's row depend on which levels contributors happened to bring. So every effort comparison is made between separate rows fitted together in one Bradley–Terry fit, never by pooling them (the experimental pooled fit in §4 estimates effort offsets as a side analysis; it never changes a headline row).

**Harnesses are pooled, and checked.** A harness changes the system prompt and the tools around the model, and could change results. We still pool them (§2.2): the game tools are the same for every seat, and per-harness rows divided each model's games across tools without anyone asking which harness plays best. To catch a harness that does matter, a model page shows a **harness split** (`ModelFile.harness_split`, export 2.20): for each effort level whose seats ran on two or more harnesses, the record and win rate per harness against other setups, with Wilson intervals. It is descriptive and never rated: the opponents, sets and contributors behind each row differ. Seats keep their `harness` (and `launcher`) in the export and the open data, so a harness effect can be checked as a side analysis; if one shows up, splitting rows by harness again is a methodology change (§9). **Calibrated** (`analysis/results/calibration-harnesses/`, 200 simulated communities each): with each contributor running each identity on one of two harnesses whose strengths differ by SD 40 Elo (a 70/30 mix), the 95% ranges cover the identity as its seats ran 96% of the time (RMSE 60 Elo, against 59 with no harness effect); with SD 80 and an even mix, 96% (RMSE 61). What a pooled row can't tell apart is the model from the harness mix it was run with: a model run mostly through a stronger harness rates a little higher (§8, "Harness differences are pooled into each row").

**Launchers are recorded, not ranked.** A launcher (T3 Code) can add tools and instructions of its own. Like the harness, it is a seat detail.

**How the comparisons are read.** Within one board (§3.3), a model page lines up its rows (export 2.15 and 2.20, docs/SITE-DATA.md):
- **Effort Ladder:** the model's effort levels in order (none, minimal, low, medium, high, xhigh, max; Codex's `ultra` last, as its own unordered level), whatever harnesses ran them. For each level: the rating with its range, the record, the expected score against an average opponent, and the cost per game. Between neighboring levels: the rating difference with the 95% interval of the difference (§4, Ranking), and the cost difference per game. A step gets a verdict (`VersionStep.verdict`, export 2.17) only under two conditions: neither row is provisional (the contributor floor included), and the difference still holds after a **Holm correction over the ladder's steps** (§4, "Several comparisons"). Then the page says the higher level is "rated higher in these games"; it never says more thinking "helped" (one contributor's ladder can't show cause) or calls it "a clear gain". A step whose interval excludes 0 with a provisional row is "provisional"; one that excludes 0 but not after the correction is "unadjusted"; otherwise it is too early to say. The head to head between the model's own levels is shown as a record, next to the difference the fit gives (which also uses every game against common opponents).
- **Harness split:** descriptive only (above). Export 2.15–2.19 also had a Harness Comparison of per-harness rows; it is gone with them.
- Unknown Effort rows are left out of ladders (they mix levels). A comparison is provisional while any of its rows is (§4).

**What a table needs to measure it.** Effort Ladder tables (for example 4 seats at low and 4 at high, from one contributor) make these comparisons cheap. Round 1 pairs the two setups against each other, and round 2 moves a seat to the next record group rather than pair two seats of one setup; the last round is strictly by points (§3.2), so it sometimes pairs two seats of one setup. A 4 + 4 table rates a median 10 of its 12 matches (four setups at 2 seats each: 11; 6 + 2: 6). One contributor's ladder still carries that contributor's configuration, so the contributor floor (§4) applies to every row of a ladder as to any row: a firm answer needs ladders from several contributors. Setup shows how many rated games a planned table can produce and suggests such mixes (docs/MULTI-PROVIDER.md).

### 2.4 Mirror games

A **mirror game** is a game between two seats of the same identity. Mirror games are **never rated**: a game between two copies of one setup says nothing about how that setup compares with others (§4, "What counts as a game"). They are still used:
- **Format insights:** what agents draft, build and win with in a set. Mirror games count there like any other game at a table that feeds set findings (§5.8).
- **Play and draw, and deck data:** decks, sideboarding, play/draw choices and game length, like any game.
- **A fairness check.** With skill held equal, a mirror should be a coin flip: nothing but the cards should decide it. The export's mirror monitor (`index.json → mirror_check`, export 2.15) counts mirror games in finished, pooled events (not Early Test Data; forfeits and games without a winner left out) and reports, per identity:
  - each **contributor's** win rate in mirror games against another contributor's seats of the same identity. A rate far from 50% suggests their configuration differs from everyone else's (a settings file, a different harness version, a changed default), which §3.1 and the influence flags also watch for;
  - each **context policy's** win rate against the same identity under another policy (a fresh session per game or match, or one long session). This is the natural experiment for the open question in §10;
  - the **on-the-play** win rate in **game 1** of each mirror match (export 2.17), where the event seed decides who plays first: an estimate of the play advantage with skill held equal. In games 2–3 the previous game's loser chooses (§3), and that side more often holds the weaker deck, so the all-games rate (`on_play_all_games`, reported for reference) is biased toward 50% and is never called clean. It is expected to be above 50% and is reported, not checked.

  A check **deviates** when it has at least 20 games and its 95% Wilson range excludes 50%. This is a **screening flag, not a test**: games within a match or event are clustered, so the Wilson range is too narrow, and many checks run at once, so about one check in 20 deviates by chance. Deviations are listed with a one-line summary; they are a reason to look at those setups, never a correction to any rating.

## 3. Conditions and comparability

Some settings change what an agent knows or must do. They are fixed for a whole event, so seats under different settings never play each other and their numbers are not on a common scale. Results are pooled only within a **comparability group**, all of whose events share:

| Condition | Values | Why it splits groups |
|---|---|---|
| Knowledge level | No Set Context, Set Context, Set Context + Human Stats | What the agent is told about the format. With Human Stats the agent sees 17Lands win rates, so 17Lands-based draft metrics are partly circular. |
| Prompts | A content hash of the prompt files the event ran with (`event_start.prompt_sha256`) | What every seat is told and what each decision shows (below). Any change to the prompt files starts a new group, so an edit can never pool silently with earlier results. Events from before the hash was logged fall back to the name of their prompts folder. Groups are never labeled with a version: when two groups differ only in their prompts, the older ones are marked "Earlier Prompt". |
| Mana payment | manual, automatic | Manual payment is a skill and a source of errors. |

The group key combines the three conditions (`kn=<level>;mana=<mode>;prompt=<fingerprint>`, where the fingerprint is the first 12 hex digits of the prompt hash, or the folder name for older logs). Keys written before 2026-10-22 had a `bo=<n>` part; it no longer splits anything.

**The match format is fixed: best of 3 with sideboarding** (decided Oct 22, 2026; §10). Best of 1 vs best of 3 changes drafting and main-deck choices, not only sideboards, so the benchmark plays one format, the one real Limited tournaments play:
- Every match is best of 3. Game 1: the event seed picks who plays first. Games 2 and 3: the loser of the previous game chooses to play or draw (after a drawn game, the player who chose for it chooses again; after a drawn game 1, which nobody chose, the player who was on the play), and the Director makes the engine start with that player. **Only game 1's play/draw is random.** The loser of game 1 more often holds the weaker deck and usually chooses to play, so on-the-play win rates from games 2–3 understate the play advantage. The rating's play term, the outcome records' play/draw split and the mirror check's on-play rate therefore use game 1 only (export 2.17).
- Before games 2 and 3 both players sideboard at the same time, with their current deck, their whole sideboard (card JSON as at deckbuilding) and what they saw of the opponent's deck; the deckbuilding rules apply unchanged (only pool cards, at most the copies drafted, basics unlimited, at least 40 cards), and "keep" is an answer. Neither sees the other's changes, only the deck size. Each match starts from the registered deck. An inactive seat keeps its deck and plays first. The draft and deckbuilding prompts say so, so drafting and building can plan a sideboard. Details: docs/PROTOCOL.md §3.3.
- **Early test data.** Events played before this (every best-of-1 event, such as the two 8-seat hosted test tables `2026-10-22-10-18-50-tla-8a85` (TLA) and `2026-10-22-14-39-42-sos-909e` (SOS), and best-of-3 events without sideboarding, `event_start.sideboarding` absent) stay in the data, visible and labeled Early Test Data, outside every rating and board. They were played under a different condition and never pool with the main board.

**Recorded but not split on:**
- **Set.** Limited skill is mostly general. Ratings pool across sets within a group, and every group also has a per-set board.
- **Engine build** (phase-rs version and protocol, logged in `event_start.provenance`). We pool across engine builds. Card bugs are inevitable and can hit any seat that plays the card. We expect them to add noise more than bias, but bugs cluster by color and mechanic and models have color preferences, so that is tested rather than assumed (§5.6 impact test). Instead of splitting, every game is flagged when engine issues touched it (§5.6), and the impact is tested and reported. Each group lists the engine builds it contains. We split by engine epoch only if a release changes rules handling materially *and* the flagged-game analysis shows a real effect.
- **Card overrides** (`event_start.provenance.card_data`: the hash of the card data phase-server ran, and the local card overrides applied to it, by slug and fingerprint; docs/CARD-OVERRIDES.md). An override is a person's fix to one card phase-rs scripts wrongly, written against Oracle text and the Comprehensive Rules and tested in scripted games. Agent reports never apply one. Overrides make the engine more faithful to the printed cards and apply to both players alike, so they pool like engine builds; games where a known-bad card was played without its fix are flagged instead (§5.6).
- **Set Context version** (its sha256 is logged with the event, of the text after the tier-score filter). Set Contexts are edited over time; the hash shows which text each event used.
- **Pairing format** (Swiss or round robin, §3.2). It changes who meets whom, not what an agent knows or must do, so Swiss and round-robin events pool.
- **Table kind** (lobby table, Private Table, or an event we or a self-hoster ran; `event_start.table`).
- **Context policy** (`event_start.seats[].context_policy`, export `SeatRef.context_policy`). Seats `bench play` starts default to a fresh session per game (`--fresh-session per-game`, from Oct 22, 2026): the seat's session ends when its deck is locked and after every game, and a fresh one starts with the resume briefing. Every decision carries the board, the card text, the decklist and the match so far, including the opponent's cards from earlier games of the match (match memory), and every session reads the Set Context before its first game decision, so a fresh session knows what a long one knows. Lobby seats the CLI starts follow the same default. Seats seated by hand and `--fresh-session off` keep one harness conversation (`harness`), with the harness's own context handling. Boards pool across policies (a seat's policy doesn't split its row); results are reported per policy where they can differ: the mirror check's context-policy split (§2.4) and cost, which model pages give per condition and never pool (§5.7). §10 keeps the question open.

**Unrated events** are listed in the export with the reason and contribute to nothing pooled:
- early test data: best of 1, or best of 3 without sideboarding (above);
- test runs: no LLM seat. Whether a seat is an LLM seat comes from its `event_start` metadata, never its name (hosted seats are all `seat-<hex>`): the registry's test harness (`script`, aliases `scripted`, `random`, `random-agent`) or the scripted `random` model is never one. Only the earliest logs, with no harness or model recorded, fall back to the old `rand-*` / `bot-*` names. A table of scripted players is a Test Run everywhere: not in totals, set findings, activity, boards, rated-table counts or the latest event;
- dev events: bot drafters filled empty seats (`event_start.dev_bot_fill`, §3.2), whoever else sat at the table;
- events whose conditions were not logged (early prototypes);
- events excluded by hand (for example, an event broken by a Director bug), recorded in `runs/<id>/source.json`.

### Knowledge levels

All levels share the standard briefing (fundamentals + deckbuilding guide + pool analysis):

| Level | Adds |
|---|---|
| No Set Context | Nothing set-specific: general Limited skill only. |
| Set Context | The MTG Deck Tools Set Context (archetypes, lanes, format speed, card notes). Earlier prompts used a different name for it. |
| Set Context + Human Stats | Also 17Lands GIH WR / ATA next to cards in packs and pools. No level shows MTG Deck Tools tier scores: at every level agents judge cards with their own evaluation, and at this one they also have the 17Lands stats. |

**Reading it in every session (from Oct 22, 2026):** at the Set Context levels each harness session reads the Set Context before its first game decision (until it has, the Director answers a game decision with a reminder; PROTOCOL §6). A seat that starts a fresh session per game reads it again each game; one long session read it once. Either way every game decision is made by a session that has read it, so the context policy never changes the knowledge level.

**The tier-score filter (from Oct 23, 2026).** Set Contexts are the MTG Deck Tools author's text (CC0), written for the site's AI Deck Builder, whose card pool lists a tierScore (0–10) per card. Agents here get no tier scores at any level, so every copy an agent reads goes through one deterministic filter (`packages/director/src/set-context-filter.ts`): it drops claims that the prompt or pool lists tier scores and turns instructions to use them into the agent's own card evaluation. It runs wherever a Set Context reaches the repository or an agent: the export to `sets/<SET>/primer.md` (`scripts/export-mtgdt-primers.ts`, `npm run deps -- update set-context`) and the Director's loading of the live mtgdecktools.com copy, its cache and the repository copy. The site's own files are unchanged; the exported file and the sha256 logged in `event_start` are of the filtered text. The filter doesn't change comparability groups (they are keyed on the prompts). Where the owner's Set Context makes claims the 17Lands data contradicts (SOS archetypes), a note for the owner lists them (`docs/notes/set-context-sos-17lands.md`); we never edit the author's text.

**No Set Context for the set:** an event that asks for Set Context in a set MTG Deck Tools hasn't written one for is refused (since Oct 24, 2026), and lobby queues for such a set are refused too. An organizer who wants to run it anyway passes `allow_downgrade` (`bench new --allow-downgrade`); the event then runs at No Set Context, logs the level it asked for (`event_start.knowledge.requested`, with a warning) and pools with the other No Set Context events, since that is what its agents actually got. Set Context + Human Stats is refused for such a set (§7).

### What each decision shows

What each decision shows (the observation format) follows the event's prompts. Events from before Oct 22, 2026 used the earlier format; current events use the current one (PROTOCOL §3).

| | Earlier format | Current format |
|---|---|---|
| Game decisions | A text board. A card's rules text appears only the first time the card is seen in the game (`get_card` afterwards). | One JSON object with everything a player at the table would know: both players' life, counters, designations and zone counts, untapped mana by color, your hand, both battlefields with full permanent state, the stack with targets and modes, combat, both graveyards and exile with each card's permissions, temporary effects, your library's remaining contents (from your decklist), and the match so far, with the opponent's cards from earlier games of the match (match memory, from Oct 22, 2026). It also has the printed data of **every card in every visible zone, all faces, at every decision**, and the options with the cards they involve. |
| Draft picks | One text line per card, rules text only the first time a card is seen in the draft. | Every card in the pack as card JSON, full text at every pick; the picks so far with costs, types and the curve. |
| Deckbuilding | One text line per pool card. | The MTG Deck Tools AI Deck Builder's 40-card rules; one line of card JSON per card with its copy count; pool facts the Director counted; then a review of the submitted deck before it locks (PROTOCOL §3.1). |

**Why the formats never pool:** the current format hands the agent far more context at each decision: card text it would otherwise have to remember or look up, the opponent's open mana, the targets of stack items, what is left in its library. Agents under the earlier format had to track that themselves, so their results measure something partly different. Self-contained decisions also make results less dependent on how a harness manages a long context (compaction drops card text the earlier format showed only once). A current game decision costs about 2,450 BPE tokens, against about 575 in the earlier format (PROTOCOL §3.1, `scripts/measure-observation.py`).

**Deckbuilding mirrors the MTG Deck Tools AI Deck Builder** (`docs/notes/mtgdt-deckbuilder-prompt.md`): the same 40-card rules, the Set Context on or off, copies shown and requested as counts, and a review before the deck locks. One difference, decided Oct 22, 2026: the deck builder's tier scores (its 0–10 grade per card) are shown at no knowledge level, so every agent uses its own card evaluation; human data reaches an agent only as the 17Lands win rates at Set Context + Human Stats. A parity checklist test (`packages/director/src/deck-parity.test.ts`) checks every critical rule against a capture of the deck builder's prompt.

Hidden information stays hidden in every format: libraries and the opponent's hand are counts only (plus cards the engine shows as revealed), the opponent's face-down cards show only their face-down characteristics, and the Director never passes raw engine objects through.

Packs follow WotC Play Booster collation exactly, including basic lands in the land slot. Basics are draftable; the fundamentals explain they are almost never the right pick, since every deck gets unlimited basics at deckbuilding.

### Table provenance

| Label | Meaning | Default |
|---|---|---|
| **Hosted** | Played on an official hosted Director. The engine, the draft and every log live on our server, whoever brings the agents. This is the main path for rated play ("bring your agent, we host the table"). Logs can't be edited or fabricated; who or what played each seat is self-reported (§2.1, §3.4). | events created on the hosted Director |
| **Community** | Played on a self-hosted Director and submitted as a bundle. It must pass the integrity checks in §3.1. Logs could in principle be fabricated by a determined bad actor, so this tier carries less weight. | set by the submission pipeline (`source.json`) |
| **Test Run** | Scripted agents only, or a dev engine test with bot drafters. Never rated. | events with no LLM seat, and dev events |

The export keeps the historical codes (`verified` for Hosted, `smoke` for Test Run) and adds the label (`provenance`, `provenance_display`). "Hosted" says where the table ran; it never means a result was verified.

### 3.1 Data integrity (keeping the data unpoisoned)

The goal is that bad actors can't poison or modify results:
1. **Hosted tables first.** Rated play happens on official Directors, where the logs are written server-side. Contributors supply the agents and the tokens; we supply the table.
2. **Immutable raw data.** Every event or submission is stored content-addressed (sha256). Ingestion is repeatable, and every derived number can be recomputed from the raw logs.
3. **Integrity checks on submitted bundles:**
   - **Pack regeneration:** booster packs are re-generated from the event seed, set and Director version and must match the logged packs exactly. A fabricated or edited draft fails this.
   - **Draft consistency:** every pick is in its pack, and every deck comes from its seat's pool plus basics.
   - **Game consistency:** turn snapshots, game results and match scores agree.
   - **Pairings:** every round's pairings regenerate from the seed, the seats and the logged results (§3.2).
   - **Seat positions:** each agent sits where the seed puts it (`event_start.agent_order`, the request order, makes this exact even when all 8 seats are agents).
   - **Eligibility:** a bundle with bot drafter seats is not a product event and is rejected, whoever sends it (§3.2).
   - **Provenance:** engine build is on the allowed list, the Director isn't modified (`-dirty`), and the prompt files are known. Planned: the card data an event claims (upstream file of a pinned build, overrides matching this repository's) is checked the same way (docs/CARD-OVERRIDES.md).
   - **Duplicates:** the same bundle or event id is rejected.
4. **Accounts and limits.** Per-contributor submission tokens (revocable), rate limits, and review of a contributor's first submissions before they count.
5. **Anomaly checks.** Impossible decision latencies, usage inconsistent with the claimed model or effort (§2.1, §2.2) and identical decision streams. Flagged submissions are held for review. A check for results far outside a contributor's history is planned, not built.
6. **No single contributor makes a rating.** Every rated game records who seated each side (§3.4). A rating stays provisional until at least two contributors have supplied its games and none supplied more than half of them; a leave-one-contributor-out check flags rows that one contributor moves; the 95% ranges include the extra uncertainty of results carried by few contributors; and the bootstrap resamples a contributor's events together once a board has enough contributors (§4). We don't cap any contributor's weight: in simulation a 50% cap moved a deliberately sabotaged row by 2 Elo and a 30% cap by 11, while making every range 3–12% wider (`analysis/results/calibration.md`, "Contributors"). An adversary simply stays under any cap; the floor and the flags cover what a cap was meant for. Takedowns trigger a full recompute.
7. **Later: replay verification.** Once the engine supports deterministic seeds, the Hub re-simulates submitted decision logs. Submissions that replay cleanly earn a **Replay-Checked** label.

Boards exist for all tables together and for each provenance alone. The default view pools Hosted and Community tables. Filter to Hosted when provenance matters more than sample size.

**Private Tables rest on one person's honesty.** At a Private Table one contributor seats all 8 agents, so the contributor controls both sides of every game: the harness configuration, the settings, even which model really plays. A hosted table guarantees the games happened as logged, not who or what played them. That is why ratings need several contributors, and why the influence flags exist.

### 3.2 Tables: 8 agent seats, Swiss pairings

**Every rated event seats 8 language-model agents. There are no bot drafters or scripted players in product events** (we decided this on Oct 22, 2026). A table with any scripted or bot seat is a **test table** (an operator's check of the software): visible, but in no rating group, with no rated game and no Swiss finish, and its sentence never says it was won (`table_kind: "test"`, export 2.22). Bot drafters shaped what agents were passed, and a table that is mostly bots is not the format we want to measure. Ways to fill a table:
- **Private Table:** one contributor brings all 8 seats, for example 4 models × 2 seats, or 8 copies of one model.
- **Lobby table:** contributors with 1–3 agents queue for one condition set; a table fires when 8 seats are present and confirmed (docs/LOBBY.md). At most 3 seats per contributor per table.
- **Dev events** (`--dev-bot-fill`, engine testing only): bot drafters fill the empty seats. They log `dev_bot_fill: true`, are labeled Test Run, are never rated, and the Hub rejects them (`eligibility.agent_seats`).

**Early test tables.** The first events (Oct 21–22, 2026), before this rule, seated 2–3 agents with scripted drafters in the other seats and played round robins. They are kept and labeled as test tables in the export (`test_table`, `table_kind: "test"`). None of them played best of 3 with sideboarding, so they are also Early Test Data (§3): visible, never rated, on no board. A test table in the current format (scripted seats, best of 3 with sideboarding) isn't Early Test Data, but it is never rated either, for the reason above.

The bot draft policy remains in exactly one product role: the inactivity watchdog uses it to pick for a seat that has gone silent (§5.5), and those picks are flagged and left out of the draft scores.

**Pairings: a 3-round Swiss** (each seat plays 3 best-of-3 matches, like a real draft pod). An 8-seat round robin would be 7 matches per seat, too slow and too costly in tokens for contributors. Lobby tables are always Swiss, and so is every table the `bench` CLI creates; a Private Table created through the Director's create-event API may ask for a round robin (`pairing: "round-robin"`), as may a one-shot Director run (`--pairing round-robin`). The Swiss (`packages/director/src/pairings.ts`, version 3 from Oct 23, 2026):
- Round 1 is random, from the event seed.
- Each later round is paired when the previous one has finished, by match points (win 3, draw 1, loss 0; a bye, only possible in odd dev events, counts 3).
- **Every round but the last:** among all pairings, the Director takes the one that, in priority order: has no rematches; doesn't pair two seats of the same identity (their games wouldn't be rated, §2); **keeps equal records together** (the smallest sum of squared match-point differences: a seat moves to the adjacent record group only to avoid such a mirror or because a group is odd, the standard Swiss pair-down float, and as little as possible); then doesn't pair two seats of the same contributor (lobby tables).
- **The last round: strictly by points.** No rematches; equal records together; only among pairings equally good on records, no mirror, then no same-contributor pair. So the seats with the best record meet in the last round.
- Remaining ties follow a seeded random order per round. Every perfect matching of the table is considered (105 at 8 seats), so the choice is exact.
- **The trade-off, measured** (the real pairing over simulated pods: `pairings.test.ts`, and `rated-estimate.ts`, which setup and the lobby show): a 4 + 4 table rates a median 10 of 12 matches (mean 10.5; 8–9 if every round were strictly by points), 5 + 3 rates 9 (mean 8.1), 6 + 2 rates 6 (5.7), 7 + 1 rates 3, and four setups at 2 seats rate all 12 in most pods (mean 11.5). A float in round 2 can leave three 2–0 seats; the last round then pairs one of them down, so about 8% of 4 + 4 pods (3% of 5 + 3, none with 8 distinct setups) end with **two 3–0s**; the standings then break the tie by game difference, and an exact tie has no winner (§4.1).
- History: version 1 (tables before Oct 23, 2026) put identity and contributor avoidance before records in every round, which could pair both 2–0 seats down in the last round and leave two 3–0s (SOS `2026-10-22-14-39-42-sos-909e`); version 2 (briefly, Oct 23) paired every round strictly by points (always one 3–0, but a 4 + 4 table rated only about 9 of 12 matches). The Hub verifies each table against the pairing version its log records (`event_start.pairing.version`), and a resumed event keeps its version.
- The number of rounds is at most half the table, so a rematch-free pairing always exists.
- Pairings are a deterministic function of the seed, the seats' declared identities and contributors, and the results. Each round is logged (`round_start`), and the Hub regenerates and checks them (§3.1).
- A match with **no result** (below) gives neither seat any match points, and the two seats count as having met (no rematch).

**No result: when infrastructure cuts a match short** (Oct 22, 2026). Infrastructure failures never decide a game or a match. A game the engine loses (a restart past its reconnect grace, a dropped connection) or can't start is **voided** and replayed from the start with the same decks and the same play/draw choice, after a pause that grows with each void (2 s, 30 s, 2 minutes: the engine may be restarting). A game voided four times (the first attempt and three replays) ends its match with **no result** (`match_end.no_result: true` with the `reason`):
- the match is neither won, lost nor drawn: no match points in the Swiss, no line in the standings' match record, no head-to-head match, and no event finish built on it;
- the voided game is never scored;
- games the match finished before the failure stand: they are complete outcomes and stay in the rating and the game records. Throwing them out would let a seat that can make the engine fail erase a game it had already lost.

Until this rule (Oct 22, 2026) a game the engine couldn't start ended its match at once, and a match cut short kept its partial score (a 1–0 lead was a match win; 0–0 a draw). The few early events this touched keep their logs as they were.

**Stopped events: stopping a table can't erase it** (Oct 23, 2026). An organizer can stop their own table (`bench stop`), an admin can stop any, and the server stops a table that runs past its time limit, that no seat connects to, or that can't be resumed after a restart. Until this rule only finished events were rated, so stopping a Private Table that was going badly erased every game it had played: optional stopping. Now a stopped event is handled like a no-result match, for the whole table:
- `event_abort` records who stopped it (`by`: organizer, admin or system), why, and the games still being played. The Director writes the results so far and hands the event to the Hub like a finished one (when at least one game had finished); the export shows it as status `stopped` with one sentence on what counts.
- **Finished games are results and are rated**, whoever stopped the table, like the finished games of a no-result match.
- **Games never played are not results.** Matches that didn't finish get no match result; the event has no final standings, finishes or winner.
- **A game in progress** is void (like a voided game), with one exception: when the table's **organizer** stopped it, and exactly one side of that game is the organizer's own seat (a lobby seat they queued, or any seat of their table facing a seat that isn't theirs), that side **forfeits** it: a loss, as when a silent seat's game is conceded (§5.5). Stopping is the organizer's choice, so it is charged to them where it can be. At a Private Table every seat is the organizer's, so an open game has no side to charge and is void; the most an organizer can remove by stopping is the game in progress in each open match, which tells nothing an unplayed game wouldn't.
- Stops by an admin or by the server void every open game: neither seat chose it.
- A live event is never rated; a log that stopped without an ending (stalled for 30 minutes, local runs only) rates its finished games the same way.

This makes stopping consistent with the other two rules: a seat that goes silent forfeits its game (§5.5), infrastructure never decides a game (no result, above), and an organizer's stop keeps what was played.

**Ratings are unchanged.** The headline is still the Bradley–Terry fit over every rated game (§4); only who meets whom changes. Swiss pairing is adaptive (it depends on earlier results), but it depends only on observed outcomes and the seed, so it is ignorable for the likelihood: the fit stays consistent, as it is for chess ratings from Swiss events. What changes is information per event: each seat meets 3 of the 7 others instead of all of them, so identities connect through more events rather than within one.

**Provisional thresholds with 3 matches per seat.** A seat plays about 7 games per event (3 best-of-3 matches × 2.4 games), with 3 distinct opponents.
- The **30-game** floor takes about 4–5 events for an identity with one seat per event. With 2 seats per event (a Private Table of 4 models × 2), 3 events give about 40 games and the event floor binds.
- The **2-opponent** floor is met within one event; the **contributor** floor (§4) is what usually binds: games from at least 2 contributors, none supplying more than half.
- The calibration (§6) simulates exactly this design: 8-seat, 3-round Swiss tables, Private Tables and lobby mixes, with contributor effects.

### 3.3 The main board and side boards

**One main condition at launch:** Set Context · Manual Mana, best of 3 with sideboarding, with the current prompts (the fingerprint of the prompts in this repository's `prompts/`, which the Director runs). Its all-sets board is the default leaderboard (`main_board`; `GroupInfo.role: "main"`). Until that board has a rated game there is no headline board ("No Rated Games Yet"): a prompt change starts a new group, and the earlier group never stands in for it; it stays as a side board labeled "Earlier Prompt". Every other group (other knowledge levels, automatic mana, earlier prompts) is a **side board**: rated the same way, shown on request, never compared with the main board. Lobby queues are meant to concentrate on the main condition, so the data that matters most fills up first.

Model pages show one group too: the main board's group when the model has rated games there, else the group where it has the most. Their records, head-to-head results and summaries never pool across groups.

### 3.4 Contributors

Every rated game records which contributor seated each side. The export resolves it from what the logs and the Hub record, in this order:
- a **Community bundle**: the uploader, whatever the log says (`source.json`);
- a **lobby seat**: the Hub contributor who queued it (`event_start.seats[].contributor_id`);
- a hosted **Private Table**: its organizer (`event_start.organizer.contributor_id`);
- an event **we ran**: "admin";
- **older logs** that recorded none: "unattributed", counted as one contributor.

The export shows each seat's contributor as an opaque key (a salted hash; never a Hub id), with the public handle only where the contributor shows it. Boards report, per row, how many contributors supplied its games and the largest share any one supplied, and they use those contributors in the provisional floor, the influence flags and the ranges (§4).

## 4. Headline rating

### Model

A Bradley–Terry model on individual game outcomes between LLM seats, on the Elo scale:

```
P(A beats B) = 1 / (1 + 10^(−(R_A − R_B + h·s) / 400))
```

- `R` is one rating per seat identity in the scope (a group, optionally one set, optionally one provenance). 1500 is the **unweighted** average of the identities in each connected group of the scope.
- `h` is a common play/draw advantage. `s` is +1 when A was on the play and −1 when B was, **in game 1 of each match only**, where the event seed chose (export 2.17). In games 2–3 the previous game's loser chose, and that side more often holds the weaker deck, so those games would bias `h` toward 0: they enter the fit with `s` = 0. It is fitted only when the logs record who was on the play.
- **Prior.** Each `R` has a normal prior centered on 1500 with SD 200 Elo; `h` has SD 50. The prior keeps a 2–0 sweep from producing an infinite rating, and pulls small samples toward the field average. With a lot of data it hardly matters.
- The fit is the posterior mode (Newton–Raphson; the problem is strictly concave). The output is deterministic: every board's bootstrap is seeded from the board's id.

**What counts as a game:**
- A finished game between two LLM seats with a winner. Concessions count as losses; the agent chose them.
- A game the inactivity watchdog conceded for a silent seat **counts as a loss for that seat** and a win for its opponent (§5.5); so does an open game the stopping organizer's own seat forfeits (§3.2, "Stopped events").
- Not counted: bot or scripted opponents, unfinished games (voided, void at a stop, or still running), draws, and self-play (mirror games, §2.4).
- A finished game of a match that later ended with no result (§3.2) counts like any other game.
- Games of an event in progress count once the event has finished or stopped; a live event is never rated.

**Why games, not matches:** a game is the smallest outcome, and best-of-3 match wins add little information beyond the games. Match records are shown alongside.

**Not separated:** deck quality. The headline rating credits the whole pipeline, draft and build included. Deck quality is estimated without simulated games (§5.2).

### Anchor (none)

We decided (Oct 21, 2026) to rate model against model only. No games against the engine's built-in AI: it isn't a meaningful opponent to benchmark against, and it changes as phase-rs evolves. Ratings are centered so the **unweighted** mean of the identities in each connected group is 1500 (every identity counts once, however many games it has).
- **Consequence:** a group's absolute scale can shift as its population changes: a new, sparse row moves 1500 a little. Differences between ratings don't depend on the centering. Comparisons are always *within* a group and a time window.
- **Stability:** comes from overlap. Widely used models appear across many events and tie the scale together. Rating history pages show which identities connect each period.

### Uncertainty

- **Replication unit: the event, and the contributor.** Games in one pod share decks, packs and opponents, so they are not independent. A contributor's tables share a configuration too.
- **Bootstrap.** Resample events with replacement, keeping each event's games together; refit; take the 2.5th and 97.5th percentiles (1,000 replicates, seeded). Once a board has 5 or more contributor clusters, a contributor's events are resampled together as one cluster (an event with several contributors, such as a lobby table, stays its own cluster). Deviations are scaled by √(G/(G−1)) for G clusters, the usual small-sample correction.
- **Laplace floor.** With very few events the bootstrap can't see enough variation. A single 3–0 match, for example, resamples to the same data every time. So the **reported range is the wider of** the bootstrap interval and the Laplace (posterior curvature) interval `R ± 1.96·SE`, where SE is measured relative to the group average.
- **Contributor variance.** The Laplace SE adds a contributor component in quadrature: 30 Elo × √(Σ share²), where the shares are the fractions of the identity's games each contributor supplied. For a rating carried by one contributor that component alone is ±59 Elo at 95%; for one spread evenly over ten contributors, about ±19. Configurations differ from contributor to contributor, and a rating should describe the model, not one person's setup.
- **Set variance** (Oct 23, 2026). It adds a set component the same way: 30 Elo × √(Σ set share²), over the sets the identity's games were played in. A model may know one set's cards and archetypes better than another's (a set released after its training data, say); every event of that set shares the effect, so resampling events can't see it. A rating from one set gets ±59 Elo from this alone; one spread evenly over eight sets, about ±21. A set board rates strength in its own set, so it has no set component. The calibration found ranges falling short as samples grew without it (93% at 120+ games in the central scenario); with it, 95%.
- **Calibration.** In simulation these ranges cover the truth 94–97% of the time across the design scenarios, 96% in the central one (§6). The earlier two-stage bootstrap (events, then games within events) covered 94–97% with ranges about 8% wider; the event bootstrap alone, without the two components, covered 90–95%. Stress tests that break the model's assumptions on purpose (a spread wider than the prior, non-transitive matchups, large set effects) cover 83–92%.
- **Connectivity.** Ratings are comparable only between identities connected by games, directly or through common opponents. When a scope splits into disconnected groups, the export lists them (`connected_groups`), each row says which it is in (`component`), and ranks never compare across groups.

### Ranking

We rank A above B only when the **95% interval of the difference R_A − R_B excludes 0**. The interval is the wider of the bootstrap interval of the difference and the Laplace interval from the posterior covariance (with the contributor component for both rows). Comparing the difference directly is sharper than asking whether two individual ranges overlap: overlapping ranges need a gap of about 3.9 standard errors, a difference test about 2.8, and the difference uses what two ratings fitted against common opponents share.
- **Rank range:** best = 1 + rows credibly ahead, worst = N − rows credibly behind, where N counts the rows on the default ranking in the same connected group (`rank_range`, `rank_of`). A row whose range is 1–N is "too early to rank". Unknown Effort rows get a range only among all rows (`rank_range_all`).
- In simulation this ranks 28% of pairs against 13% for non-overlapping ranges, and 1.1% of ranked pairs are in the wrong order (central scenario; 0.7–3.6% across the design scenarios, worst when models are close). Two identities 100 Elo apart at 4 × 2 Private Tables are told apart half the time after about 180 games each, and 80% of the time after about 570; non-overlapping ranges needed about 500 games for half the time and didn't reach 80% within 48 tables (about 670 games).
- **Overlapping bars don't mean "not separated".** Two ratings fitted against common opponents share much of their uncertainty, so their difference is known more precisely than either rating. A row can therefore rank above another while the two ranges, drawn as bars, overlap. Every rank, rank range and "ahead of" sentence comes from the difference intervals (published per board: `Board.differences`, the open data's `rating_pairs`), never from whether bars overlap.
- The summaries ("too early to rank", "ranks first", "share the top spot") are driven by these decisions.

### Several comparisons

A board makes many comparisons at once, and the export builds many boards (every group × set × provenance), so some "credibly ahead" calls will be chance. Two places guard against it (export 2.17, `packages/site/src/multiplicity.ts`):
- **Effort Ladders** (§2.3): each step's p-value is read off its difference interval, and the steps of one ladder are **Holm-corrected** together. A step is "rated higher" only when it holds after the correction and neither row is provisional.
- **"Ranks first"** is said only of a row that is not provisional and is credibly ahead of every row in its group. On a set board or a single-provenance board (exploratory: one of many) it also needs those differences to hold after a Holm correction over its comparisons; otherwise the summary says the lead is exploratory. The main all-sets, all-tables board is the pre-specified headline and is not corrected.
- Rank ranges themselves stay uncorrected per pair: in simulation they cover the true rank 99–100% of the time (§6).

### Provisional ratings

A rating is **provisional** until the identity has, in that scope:
- at least **30 rated games** (at 50%, ±18 percentage points of win rate, about ±130 Elo);
- at least **3 events** (so one lucky pod can't carry it);
- at least **2 distinct opponent identities** (with one opponent, a rating is just a head-to-head record);
- games from at least **2 contributors**, with **none supplying more than half** of them. With exactly two contributors this needs an even split, so in practice a firm rating needs three or more.

Provisional rows are shown with their numeric range, marked, and sorted with the rest, but shouldn't be quoted as rankings. **The contributor floor is the part that usually binds** (§6): a row with 30+ games from one person stays provisional. Wherever the rule is stated in short, it is stated whole; the export carries it as one sentence (`methodology.thresholds.rule`): "A rating is provisional until it has 30 rated games, 3 events and 2 different opponents, with games from at least 2 contributors and none supplying more than half of them."

### Contributor influence

At every export each contributor's games are removed in turn and the scope is refitted. For each row the export keeps (`influence`):
- the contributor whose removal moves it most, and by how much (Elo, relative to the identities still rated);
- **flagged**: without that contributor the rating would leave its own 95% range, or would have no games left;
- **inconsistent**: the largest shift measured in its own standard errors (√(Var without − Var with), from the two fits' covariances) is at least 3.5, or no games would be left. This catches results from one contributor that disagree with everyone else's, such as a hostile configuration.

In simulation the range flag fires on about 2% of honest rows (4% averaged over every scenario) and the 3.5-z flag on about 4%. A contributor who ran 30% of all tables and seated a rival 150 Elo below its strength pulled that rival's rating down about 45 Elo while supplying under half of its games; the floor caught it early (26% at 6 tables), and the z flag caught it 39% of the time at 48 tables. No check is complete: a determined contributor below half of a row's games can bias it within its range. Read flagged rows with care, and prefer rows supplied by many contributors.

### Partial pooling (experimental, off)

An optional fit (`MTGDT_RATING_POOLING=1`) replaces each free rating with `θ = μ(model) + ε(model, effort) + u(identity)` (the harness term γ is constant since identities stopped differing by harness, 2.20), with prior SDs 200 (model), 40 per effort level (80 for Unknown Effort) and 60 for the residual. A sparse row then shrinks toward its own model rather than toward the field, and the fit gives a model-level board (μ per model) and effort offsets. When on, the export adds them next to the headline (`BoardRow.pooled`, `Board.pooled`); the headline never changes.

In simulation it cuts the error from 85 to 57 Elo when the structure holds; when harness × effort interactions are larger than its prior allows, the error still falls (89 to 74) but its ranges cover only 94% (94% for sparse rows). At launch there is one main condition with few versions per model, so it would buy little. We plan to turn it on once several models have two or more effort rows, after estimating its variance components from real data.

### Validation

`npm test -w @mtgdt/site` runs the model on synthetic data where the truth is known:
- it recovers the true order of 6 identities (60 pods);
- 95% ranges cover the true ratings;
- it estimates a planted play advantage and a planted deck-strength coefficient;
- relabeling sides gives the same answer;
- a 3–0 sweep stays finite with a wide range;
- disconnected groups are detected and never ranked against each other;
- a pair can be ranked by its difference while the two ranges still overlap;
- the contributor floor, the influence flags (a planted sandbagging contributor) and the weight-cap arithmetic;
- a sparse row moves toward its own model under partial pooling;
- a seeded run is deterministic.

The calibration (`packages/site/src/calibrate.ts`, §6) simulates whole communities and is reported in `analysis/results/calibration.md`.

### 4.1 Outcomes

Outcomes are what an agent achieved against other agents, from **the same rated games as its rating** (a board's scope). They are results, not inputs to the rating: the rating summarizes them.
- **Games won** and **matches won.** A match is one pairing of two seats in an event, decided by its rated games. A match whose rated games are level (for example when one of its games isn't rated) is counted as drawn and left out of the match rate; a game the watchdog conceded is rated, as a loss (§5.5). A match with no result (§3.2) counts its finished games and no match.
- **On the play** and **on the draw**: games won by who went first, **in game 1 of each match** (random, by seed; export 2.17). Games 2–3 are left out of the split: the previous loser chose who went first.
- **Event finishes**: the seat's place among the agent seats of the final standings, and events won (the event's winner; a tie at the top has none).
- **Swiss finishes**: at three-round Swiss events of 8 agents (§3.2), the count of 3–0, 2–1, 1–2 and 0–3 finishes and the **3–0 rate** (12.5% is average with 8 seats).
- **Head to head**: games and matches between each pair of identities.
- **Records, not rankings.** Raw win rates depend on who else sat at the tables: under Swiss pairing a strong seat meets strong seats from round 2 on, which pulls its raw rate toward 50%, and a 3–0 at one table is a 0–3 for someone else. Show them as records with their context (opponents, events), never sorted or compared across rows. The comparable number is the rating, and its **expected score against an average opponent** (`expected_score`: the win probability against a 1500 opponent under the fit, with its range).
- **Ranges.** Every rate carries a 95% range: the wider of the two-stage cluster bootstrap (events, then items) and the **Wilson** score interval, for the same reason the rating uses its Laplace floor: with few events the bootstrap alone makes a 3–0 look certain.
- **Model level.** A model's results pool its versions (effort levels) within one group (§3.3) and leave out games between two versions of itself.
- **Summaries.** Each board and model gets a generated sentence ("As of Oct 22, 2026, …"). They are templates over these numbers, deterministic, lead with outcomes and say "too early to rank" until a difference interval excludes 0.

## 5. Diagnostics: how agents draft, build and play

Diagnostics describe behavior; they are not scores and none of them feeds the rating. They help explain results (a deck that fails basic checks tends to lose) and show where agents differ. The site shows them on model pages next to the median of all agents. They are never ranked.

Rule (from METRICS.md): to measure a stage, hold its input fixed, vary who performs it, and measure the output with a yardstick that doesn't depend on the agent. Each diagnostic is aggregated per identity over the same scope as its rating. Ranges use a two-stage bootstrap (events, then items within events: picks, decisions, games). An estimate from a single event is shown but its range only reflects within-event noise.

### 5.1 Draft

Good picks depend on context: what you already have (colors, curve, creature count, duplicates, synergies), the pick number, and what the neighbors are passing. Every set gets the **core draft metrics** below. They need only card data and the event log, so a set with no human data is as fully scored as any other. Sets with human data (17Lands public datasets) also get an optional **comparison with human drafters**, shown next to the core metrics, never in place of them.

**Card quality (card data only).** Where a metric needs to know whether a card is good, it uses a heuristic estimate of its Limited value, computed from phase-rs card data (`cardQuality` in `packages/director/src/ratings.ts`, version `cq-1`). The same estimate makes fallback picks (a seat forfeited by the inactivity watchdog) and builds reference decks in sets without human data. It is on the scale of a games-in-hand win rate (about 0.47–0.63; filler is about 0.535) and adds up:
- a base by rarity (common 0.535 to mythic 0.560), plus a little for creatures;
- for creatures, power + toughness against twice the mana value (±0.012 at most), and a little for an enters-the-battlefield effect; defenders lose a little;
- combat keywords on keyword lines (flying, menace, deathtouch, double strike, …; at most +0.02);
- the strongest interaction in the rules text: destroy/exile, damage to a creature, −N/−N, fight/bite, Pacifism-style auras, edicts (+0.015 to +0.025), sweepers, bounce, counters, tapping (less);
- card draw and token makers (at most +0.012);
- what it costs to play: three or more colors, three or more pips of one color, colorless filler, expensive non-creature spells without interaction; and non-creature cards that neither interact nor draw are mostly tricks and filler (−0.01).

Against human games-in-hand win rates it is a rough guide, not a substitute: Spearman ρ = **0.19–0.40** over the 9 sets with 17Lands data, against 0.08–0.35 for rarity alone (`analysis/results/card-quality.md`; `npx tsx packages/director/src/ratings.test.ts --validate`). Its weights were set by inspection on those same sets, so this is not a held-out test. The core metrics use it only to decide which passed cards were worth taking, never to grade a pick.

**Core draft metrics (every set)**
- **Pick → deck conversion:** the share of real (non-forced, non-forfeited), non-basic picks that made the final main deck, plus the same for pack 1 alone. Wasted picks are speculation that didn't pay off, or poor reading.
- **Commitment pick:** the overall pick (1–42) from which the two colors the seat had taken most equal its final pair and never change again. Descriptive: early is not better. Null when the pool's most-drafted colors aren't the deck's.
- **Color flow and flow alignment (signal reading):** which colors were open in pack 1, picks 2–9 (the cards the upstream seats chose to pass; pick 1 is an unopened pack, later picks are leftovers). Each non-land card in those packs adds its card quality above filler (`max(0, quality − 0.535)`) to the colors it strictly needs, split evenly for gold cards; colorless and hybrid-only cards add nothing. `flow` is each color's share; `flow_colors` are the top two. **Flow alignment** is the share of the final pair among those two. A random pair scores 0.4 on average.
- **On-color rate (consistency):** the share of real, non-land picks in packs 2–3 that the final colors can cast (colorless and hybrid cards count as on-color). Low values mean picks spent on cards the deck could not use.
- **Pair changes (consistency):** how many times the seat's two most-drafted colors changed from its 6th pick on. Descriptive: one change can be good reading; many are wandering.
- **Role coverage:** the final main deck against 40-card Limited norms, the share of checks passed. From export 2.17 a two-color deck is checked against **its set and color pair's 17Lands norms** when the set has `sets/<SET>/deck-norms.json` with at least 200 winning decks of that pair: the 10th–90th percentile of decks with 6+ wins (lands one wider each way, since nearly every winning deck runs 17). Each deck says which (`basis`, `bands`, `source`), and the set's deck shape counts both. Other decks (mono-color, three colors, thin pairs, sets without 17Lands data) use the generic bands:

  | Check | Passes when |
  |---|---|
  | `lands_16_18` | 16–18 lands |
  | `creatures_12_plus` | at least 12 creatures |
  | `early_6_plus` | at least 6 non-land cards at mana value ≤ 2 |
  | `top_end_6_max` | at most 6 non-land cards at mana value ≥ 5 |
  | `avg_mv_2_5_3_5` | average mana value of non-land cards 2.5–3.5 |
  | `interaction_2_plus` | at least 2 interaction spells (removal, sweepers, bounce, tapping, counters, from rules-text patterns) |

  The bands are common Limited guidance. They line up with the 10th–90th percentile band of winning human decks in the 9 sets with 17Lands data (per set, typical pair: lands 16–17, creatures p10 8–14 and p90 14–18, two-or-less p10 6.5–9, five-plus p90 4–6, average mana value 2.5–2.7 to 3.2–3.5), but they are not fitted to any set. Creature-light formats and archetypes (FIN's winning decks run 8–15; SOS Prismari control runs 4–13) are why per-pair norms replace these bands where 17Lands data exists. Each deck's counts (creatures, early plays, top end, interaction, removal, evasive creatures, average mana value) are exported with the checks. Role coverage covers every deck, delegated builds included, because it reflects the pool as much as the build.

**Compared with human drafters (sets with 17Lands data only)**

These metrics measure agreement with strong human drafters. They are a reference layer: shown where the data exists, labeled as a comparison with humans, and never a headline number. At the Set Context + Human Stats level the agent sees 17Lands numbers itself, so they are partly circular there.

- **Archetype-conditional value** (needs `sets/<SET>/17lands-archetypes.json`):
  - The value of a card is its 17Lands games-in-hand win rate **in decks of the drafter's color pair**, from 17Lands game data (`analysis/draft_eval/archetypes.py`). The file lists a card in a pair only if it was in at least 50 main decks of that archetype, and shrinks the value toward the card's overall rate (empirical Bayes).
  - **Archetype regret (hindsight):** for each real pick, the best value in the pack minus the value of the card taken, both within the pair of the seat's final deck. The final pair is the two colors with the most non-land cards that need them.
  - **Archetype regret (current):** the same, within the two colors the drafter had taken most up to that pick (from pick 6 on). This judges the pick by what the drafter knew then.
  - A card with no value in the pair (off-color or too rarely played there) counts as replacement level: the pair's 10th-percentile card. Only listed cards can be the pack's best, so an off-color bomb doesn't count as a missed pick.
  - Reported in percentage points of win rate. Lower is better.
- **Expert pick model** (needs `runs/<id>/draft-eval.json`):
  - A model trained on 17Lands draft data from strong human drafters. It reads the pack and the pool so far and gives a probability for each card.
  - Per pick it supplies the probability of the card the agent took, its rank under the model, a context-aware expected-value regret, and whether the pick was in lane.
  - We aggregate per identity: **mean log-likelihood** `mean(ln p)`, with `p` floored at 10⁻⁴ (how human-expert-like the picks are); **top-1 and top-3 agreement**; **mean EV regret** in percentage points; each of these by pack (P1, P2, P3), because early picks are about power and later picks about fit.
  - The producer should report the same scores for held-out strong human drafters, so agent scores can be read against them. Agreement with humans is not the same as being right.
- **Signal alignment by win rate:** the color-flow idea above, with each passed card weighted by `GIH WR − set average` (floored at 0) instead of card quality (`hindsight.signal_alignment`, `open_colors`).
- **Naive baselines:** the **top-pick rate** (the share of real picks that took the pack's highest-GIH-WR card), **GIH regret** (the best GIH WR in the pack minus the picked card's, in points) and **in-lane GIH regret** (the same within the final colors, from pack 2 on). They ignore the pool and the pick context and reward rare-drafting: sanity checks, never a draft score.

### 5.2 Build

- **Legality:** the main deck has at least 40 cards, all from the pool, never more copies of a card than were drafted. The Director enforces the pool and the copies; we report the 40-card share of agent-built decks.
- **Deck review:** the Director shows its exact count of the submitted deck and flags rule breaks before the deck locks; the agent confirms or resubmits once. `deck_built` logs the outcome (`review.outcome`: confirmed, resubmitted, forfeit), the flags of the submitted and the final deck, and every rejected answer (`rejected`), so build scores can separate a model's first attempt from its corrected one.
- **Sanity checks:**
  - 40–41 cards;
  - 15–18 lands;
  - at least 6 sources for every color two or more non-land cards need, and 3 for a single-card splash;
  - every non-land card castable from the deck's lands.

  The score is the share passed; the export also counts each failed check.
- **Delegation:** how often the agent handed the build to the reference builder. Those decks are excluded from build scores.
- **Role coverage** (§5.1) applies to every deck, in every set.

**Compared with human decks (sets with 17Lands data only).** Like the draft comparisons, these are a reference layer, never a headline number.
- **GIH build gap (baseline):** the average GIH WR of the best same-colored pool cards minus the deck's, over as many cards as the deck has non-land cards. Positive means playable cards were left in the sideboard, by raw win rate.
- **Archetype build quality (no simulated games, by decision).** Code: `packages/site/src/build-quality.ts`, mirrored and validated by `analysis/draft_eval/build_eval.py`.
  - *Card value in the deck's pair P* (the two colors ≥ 2 non-land cards need): `w · lift + (1 − w) · overall`, where `lift` = the card's shrunk GIH WR in P − P's base win rate + the set baseline, and `overall` = its overall GIH WR. Cells with too little data use the overall rate. A card needing a color outside P (a **splash**) uses its value in P if 17Lands has enough splashed copies, else overall + the set's splash penalty (splash GIH WR − overall, games-weighted; −1 to −2 points). A card with a colored pip no land in the deck produces is **dead**: P's replacement level (10th-percentile card). Hybrid pips are satisfied by either color; colorless cards and Phyrexian pips need nothing.
  - *Build quality* = the mean value of the non-land cards. *Expected win rate* = `σ(logit(baseline) + b·(quality − ref)·100 + c·(base[P] − baseline)·100)`.
  - *Reference build*: the Director's `autoBuild` re-implemented read-only (it reproduces every logged auto deck exactly). *Best build*: for every pair, the top 40 − L castable cards by value, L = the median land count of winning human decks in that pair, missing playables at replacement level, no splash; the pair with the highest expected win rate.
  - *Per seat*: `build_quality`, `reference_quality`, `build_delta_pp` (build − reference), `vs_best_pp` (build − best), the same deltas in expected win rate, and **structural flags**: land, creature, two-drop, five-plus and average mana value counts outside the p10–p90 band of **winning human decks** (≥ 6 wins) in the same pair, primary/secondary color sources below p10, splash sources below max(3, p10), uncastable cards. Norms per set and pair: `sets/<SET>/deck-norms.json`.
  - **Validation (held-out 17Lands games, `analysis/results/build-quality.md`).** Ratings are rebuilt on 80% of drafts; held-out decks are split into a fit half (w, b, c) and an evaluation half. Per game, the model's AUC is **0.548–0.567** over the 9 sets. That beats or ties (within 0.001) the mean overall GIH WR of the same cards (0.546–0.567) in every set. The lift alone loses in some sets (SOS 0.527), which is why w is fitted: from 0 in FIN to 1 in FRA. The deck-level correlation with win rate is **r = 0.18–0.25**. By decile of predicted win rate, the worst decile is off by 0.8–3.5 points. With player skill and play/draw held fixed, b = 0.11–0.24 logits per point, 8–20 standard errors from zero. Every set's file carries the label `validated`, which means only **checked: it beats or ties the naive baseline** (the mean overall GIH WR) on held-out games. It is not a meaningful improvement over that baseline: the per-game AUC gain is 0.001–0.014 at most and some sets tie.
  - **Reading it.** It is a modest predictor: one game is mostly luck, play and the opponent. On human decks, player skill plus play/draw reaches AUC 0.58–0.62, and adding quality gives +0.005–0.015. The structural flags do not add predictive power on human decks (coefficients within about 2 SE of 0); they are **descriptive**: where a deck departs from what winning humans do.
  - **Bias.** The reference builder ranks cards by overall GIH WR, which is close to this yardstick. Agent decks therefore usually score a little below it (−0.2 to −0.9 points in our first 17 decks). Synergy, curve and play patterns that 17Lands averages don't capture are invisible to the score. Read `build_delta_pp` together with the flags and the deck, never as the build score alone.
- (The phase-ai bot-duel tool in `packages/director/src/strength.ts` is **experimental and not part of the methodology**; no rating uses it.)

### 5.3 Play

- **Game and match record** against LLM opponents in the scope. Records, not rankings (§4.1): a raw win rate is confounded with deck quality and opponent strength. That is why the rating, not the win rate, is the headline.
- **Mulligans per game:** descriptive.
- **Later:** decision quality from win-probability-added and counterfactual rollouts (METRICS.md §4). Not reported yet.

### 5.4 Mana

Only for events with manual mana.
- **Manual-payment share:** payments the agent planned itself (its own tap plan, paid in full), out of those plus the payments it delegated to the auto-tapper option, which is allowed and recorded.
- **Engine-paid payments** are counted separately and never as the agent's own tapping (`auto_paid`): activated abilities and prepared copies with no tap plan, which the engine pays by itself, and plans the engine had to top up (`topped_up`, logged `payment: "manual+auto"`).
- **Payment failures per 100 planned payments.**
- Mis-taps (a payment that left a castable spell uncastable) are not detected yet.
- **Events before Oct 23, 2026 overstate both figures.** A Director bug refused tap plans that named mana creatures, mana rocks or Treasures, and the spell then had to be finished with the auto-tapper option. On the two 8-agent tables (TLA `2026-10-22-10-18-50`, SOS `2026-10-22-14-39-42`) it caused all 15 payment failures and 14 of 22 auto-tapper uses, each costing about two extra decisions. The logs aren't rewritten: treat those events' mana figures as upper bounds, not evidence about agent skill.

### 5.5 Reliability

- **Rejected answers per 100 decisions:** answers the engine refused (illegal or malformed).
- **Withdrawn per 100 offers:** decisions replaced before an answer. Usually the game moved on (for example, the opponent mulliganed), so this is diagnostic, not a fault.
- **Abandoned games:** the seat's games that never finished in an event that has stopped.
- **Forfeits:** decisions the Director settled because the seat made no MCP call for 10 minutes (`SEAT_TIMEOUT_MS`) while a decision was open: draft picks by the bot policy (`draft_pick.by = "forfeit"`; left out of the draft scores like forced last picks), the deck by the reference builder (`deck_built.by = "auto"`, `forfeit: true`), and open games conceded (`game_over.forfeited_by`). Each is a `forfeit` record (`seat`, `stage`, `reason: "inactive"`, `idle_ms`, `game`). After one forfeit, the seat's later decisions are settled at once until it calls again (a relaunched session resumes normally). Counted per seat; `null` for events from Directors without the watchdog (before Oct 22, 2026). A seat's first request gets a 30-minute grace (`SEAT_CONNECT_TIMEOUT_MS`), for seats connected by hand.
- **Lobby reliability** (contribution stats, docs/LOBBY.md): a lobby or Private Table seat that played to the end without a forfeit is *finished*; one with any watchdog forfeit is *abandoned*. A contributor's reliability is finished / (finished + abandoned), shown from 3 seats on. Contributors below 0.7 over 5 or more seats queue behind everyone else and hold one lobby seat at a time. Events stopped by the server count for nobody.
- **Contributor points never affect ratings.** The Contributors Leaderboard (docs/COMMUNITY.md, "Points and the Contributors Leaderboard"; `packages/hub/src/points.ts`) rewards finished seats, rated games played, lobby seats and bounties for under-sampled setups, models and sets. It reads the same accepted events, uses this section's finished / abandoned definition for its reliability multiplier, and pays nothing for winning. No rating, range, diagnostic or provisional flag reads points; bounties only point contributors at setups that are still provisional (§4).

**How a forfeited game enters the rating** (decided Oct 22, 2026; §10). A game the watchdog concedes for a silent seat counts as a **loss for that seat and a win for its opponent** everywhere: the match record, the standings, the rating, the outcomes and the head-to-head records (`FORFEIT_POLICY = 'loss'` in `packages/site/src/scoring.ts`; the export reports the policy it used as `methodology.forfeits`). It also counts against the seat's reliability. The reason is the tournament rule: a player who leaves forfeits. Stopping a harness while losing therefore can't remove the game. A harness that crashes is part of the agent system being measured, and short hiccups are already absorbed: launchers relaunch a session that exits, and the watchdog waits 10 minutes before it concedes anything. The cost is that a harness that crashes in long games is rated as playing worse. Only seat inactivity is a loss: voided games (engine failures, replayed from the start) stay unrated. A forfeited draft pick or deck isn't rated (only games are). Exports built before this change report `exclude-game` there: the conceded game was left out of the rating.

Two other policies stay implemented behind the same setting, for sensitivity runs:
- **Exclude the game** (`exclude-game`, the earlier default): the conceded game is left out of the rating; the seat's other games count. Its weakness is the one above.
- **Void the forfeiting seat's event** (`void-seat-event`): every rated game of a seat that forfeited anything in an event is left out, wins included.

Server-side failures (voided games, Director or engine faults, events the server stopped) are excluded under every option.

**Restarts are never held against a seat.** The watchdog pauses while the Director shuts down for a restart or deploy. After a resume, a seat that hasn't called since gets at least 15 minutes (`resumeGraceMs`) before the watchdog settles anything for it, instead of the usual 10: its CLI may still be waiting out the deploy (the `bench` CLI retries for up to 10 minutes) and its harness restarting.

### 5.6 Engine issues (card bugs)

Each game is flagged when engine issues may have touched it (`packages/site/src/engine-flags.ts`):
- **swapped card cast:** a card that was swapped into the packs in place of an unsupported card was cast;
- **refused action:** the engine refused an action it had listed as legal: an agent's listed option, or an automatic pass or payment the Director made for it. Refused *structured* answers (attackers, blocks, card lists) are agent errors and count under reliability (§5.5), not here;
- **unimplemented effect:** phase-rs resolved an `Effect::Unimplemented` (it does nothing), or a card whose mechanics phase-rs lists as not implemented (`unimplemented_mechanics`) was cast. The Director reads phase-rs's own diagnostics (`unimplemented_oracle_ids` in the game state) and logs `unimplemented_effect`;
- **rules issue:** an agent called `report_rules_issue(card, note)` during the game. The tool never affects the game;
- **known-issue card:** a card on the known-issues list (`engine/known-issues.json`: suspected or confirmed, or fixed only in a later phase-rs release) was played, and the event's card data had no override fixing it. A card becomes *suspected* when at least two different seats report it in at least two different games; a person confirms it by reproducing it in a scripted game, or marks it not-a-bug (docs/CARD-OVERRIDES.md). Agents agreeing is a reason to look, never proof.

The Director logs `card_played` for every spell cast and non-mana ability activated (and a per-seat summary in `game_over.cards_played`), and the card on every `agent_decision`. Logs from before Oct 22, 2026 have no casts, so their games can only be flagged for refusals; the export says so per game (`plays_logged`).

Flags are published per game (`engine_flags` on every game) and per card (the set page's engine section). **Card swaps are not engine faults**: the game is played by the rules with a different card. So the export counts them apart from **rules errors** (known-issue cards without their fix, unimplemented effects, refused actions, agents' rules reports), for games between two LLM seats and for all games, with the games where the implicated seat lost as an upper bound on the games where an error mattered (`engine.split`, export 2.17). A set page leads with rules errors; "games touched" counting both is never a headline.
- **Impact test:** flagged versus unflagged finished games, in two scopes: games between two LLM seats, and all agent games (scripted test runs find engine bugs cheaply but say nothing about models).
  - *Win-rate swing:* in flagged games where exactly one seat is implicated (its card was cast, refused, hit an unimplemented effect, or it reported), how often that seat won, minus 50%. Negative means engine problems cost the player they touch. Also per kind of flag.
  - *Rejected answers per 100 decisions* and *game length in turns*, flagged minus unflagged.
  - Ranges: the two-stage bootstrap over events (§5). For the win-rate swing, the wider of the bootstrap and the Wilson score interval: with a handful of games the bootstrap collapses (0 wins in 2 games resamples to 0 every time).
- **When it matters:** if a card or mechanic shows a real effect, it's listed on the set page. Its games can be excluded from the rating in a sensitivity analysis, and the card becomes a priority upstream fix.
- **Fixing a card locally:** a card override (docs/CARD-OVERRIDES.md) changes the card data phase-server runs from the next event on, never during one. Finished events keep the card behavior they ran with (their `card_data` record), and their flags stay as they were: an override is never applied to games retroactively.

### 5.7 Efficiency

- **Median seconds per decision** and **per pick**, measured by the server from offer to answer.
- **API-equivalent cost** as the harness reports it for the whole seat (for Claude Code, the transcript's `total_cost_usd` at list prices, summed over its sessions), **per seat and per game**, only when every session of the seat reported one. A seat with a fresh session per game has a session per game; one that ended without its result line (stopped from outside) would make the sum cover only part of the seat, so such a seat is estimated instead (below). Seats on a subscription didn't pay this.
- **Estimated cost** where the harness doesn't report one: the seat's token counts (input, output, cache reads, cache writes) at the model's list price on the event's start day, from the provider's official pricing page (`registry/prices.json`, with the source and the date it was read). Where the provider lists higher prices for long prompts (Claude Haiku 5.5 over 100,000 tokens, GPT-6 over 272,000, Gemini 3.1 Pro over 200,000), a request over the size pays them on all of its tokens: from a Claude Code transcript each request is priced by its own prompt size (its final usage from the session record), and so is a usage upload that carries the tokens of its requests over the threshold (`long_context`); from a usage summary with only totals, the share of long requests is approximated by taking the prompt sizes as spread evenly from 0 to twice their mean (prompt tokens over the request count). 1-hour cache writes, which Claude Code uses, are priced at the 1-hour rate (`cache_write_1h`). Priced this way the first 8-seat Haiku table came to $56.25 against Claude Code's reported $56.37 (0.2% under). Every cost says whether it is `reported`, `estimated` or `mixed`; models without a listed price show none.
- **Cross-checked** (export 2.21): the estimate is computed whenever token counts and a price exist. A reported cost of $0 with tokens used, or one more than 35% from the estimate, is not used: the estimate is, and the seat counts in `seats_flagged`. A cost from an uploaded usage summary is the contributor's own figure, so where the upload has token counts it is re-priced from them. A harness log this version can't read, or one with no token counts, is said out loud by preflight, `bench play` and Keep Playing, never turned into a silent $0.
- **Output tokens per decision**, where transcripts exist.
- Cost is comparable only between harnesses that price the same way.
- **Per condition, with its coverage** (export 2.17). A model page's cost per game is never pooled across conditions that change it: the table format (best of 3 with sideboarding, or Early Test Data) and the seat's context policy (one long session cost about five times a fresh session per game for the same seat, §10). `cost` is the main condition's (best of 3, fresh session per game, when the model has such seats); `cost_conditions` lists every condition. Each says what it covers ("Based on 9 of 22 seats, at 2 of 8 tables"), never "every table" unless it is.
- **Games played** on a model page count each game once: a game between two of the model's own seats is one game, not two (`played.games`, with `played.mirror_games`).

### 5.8 Set findings

A set page (and the Home and Learn lines drawn from it) describes how language-model agents draft and build a format: the most drafted color pairs and their records, the typical deck, when colors settle, first picks, which cards agents take and how early, and where their picks differ from human drafters'. Export 2.18 states the rules these follow:

- **Only all-agent tables.** A table feeds set findings only when it finished and **all 8 seats are language-model agents** (the metadata rule of §3: no scripted drafter, bot or scripted player). The early test pods of 2–3 agents with scripted drafters in the other seats are left out: the scripted drafters decided what the agents were passed, so the agents' colors and picks there describe the pod as much as the agents. Those tables stay on the site to watch and study (`in_set_findings: false`, counted in `insight.excluded_events`), and feed no set finding. A set whose agent tables are all mixed pods publishes no finding.
- **Independent drafts, not tables.** Running one seed again opens the same packs, so re-runs of a seed are **one draft**, however often they ran. The sample-size gate counts drafts: a finding about pairs needs at least **8 agent decks from 3 different drafts** (`SET_INSIGHT_MIN`); below it the set shows only its sample size (`insight.n_text`, e.g. "n = 8 agent decks from 1 all-agent table").
- **Early Test Data is named.** A finding drawn from Early Test Data tables (§3) says so with the number of tables ("from 2 early test tables"); `insight.early_test_events` and each pick gap's `early_test_tables` carry it.
- **Agents vs human drafters: picks with a real choice only.** In a closed pod every card is taken by the last pick, so a late pick is forced, not an evaluation. The comparison with 17Lands' average taken at (ATA) uses only an agent's picks **1–9 of a pack**, and lists a card only with at least **5 such picks from 3 different drafts** and a gap of at least **1.5 picks** (`pick_gaps`, `PICK_GAP_RULE`). It compares the agents' average over those picks with the human average over all picks, so a card agents take late shows a smaller gap than a full average would, and one they take early a slightly larger one. Every page uses this one list ("the biggest gap" is its first row). It is a reference layer like the rest of §5.1's human comparison: never part of a rating.
- **Model pages** show the cards a model reaches for by its pick within the pack (1–14), first picks from every pack, and "most picked" from picks 1–5 of a pack only: at a table where one model holds every seat it takes every card, so its late picks say nothing about preference.

## 6. Reading the numbers: thresholds

| What | Shown | Treated as reliable when |
|---|---|---|
| Rating | always, with its range | not provisional: ≥ 30 games, ≥ 3 events, ≥ 2 opponents, ≥ 2 contributors with none above half; prior SD 200 Elo (calibrated below) |
| Rank | always, as a rank range | the 95% interval of a rating difference excludes 0 (wrong order for 0.7–3.6% of ranked pairs in simulation: 1.1% in the central scenario, 3.6% in the close-field one) |
| Influence flags | when two or more contributors supplied a board | a flagged row depends on one contributor; read it with care |
| Core draft metrics (§5.1) | always (card data) | range from ≥ 2 events |
| Human-reference build quality (§5.2) | sets with archetype ratings | set checked against the naive baseline (`validated` in `deck-norms.json`: beats or ties it, no more); ≥ 2 events for an identity's mean |
| Diagnostic (§5) | when computable | range from ≥ 2 events |
| Human-reference draft metrics (expert, archetype) | sets with the input files | ≥ 100 rated picks |
| Outcome rate (§4.1) | always, with its range, as a record | range from ≥ 2 events; Swiss finishes once a model plays 8-seat Swiss tables |
| Cost | finished seats with a harness report or token counts and a listed price | ≥ 3 seats; estimates labeled; per condition (format × context policy), never pooled across conditions, with the seats and tables it covers |

Never compare numbers across comparability groups. A model with the Set Context and a model without one never met.

**Calibration (`analysis/results/calibration.md`, rerun Oct 23, 2026).** Pure simulation with the production rating model: 17 scenarios × 200 simulated communities, fitted after 6, 12, 24 and 48 tables, plus 400 simulations of two identities 100 Elo apart.
- *Tables:* every table seats 8 agents and plays a 3-round Swiss, best of 3, paired by the Director's own code (pairing version 3); half are Private Tables (one contributor, 4 identities × 2 seats), half lobby mixes of 3–4 contributors. Only game 1 of a match enters the play term, as in the fit.
- *Identities and contributors:* 12 or 24 identities with Zipf popularity (48 in the pooling scenarios); 4 or 10 contributors with Zipf activity, whose configurations shift an identity by SD 0 / 30 / 60 Elo.
- *True skill:* SD 50 / 100 Elo, with model × set effects of SD 30 Elo; one scenario drifts each identity by SD 100 Elo over the 48 tables.
- *Deck luck:* a per-seat, per-event deck effect of SD 0.25 / 0.5 logits. The 17Lands deck-strength spread is at least 0.23–0.29 logits, and the quality score alone explains 0.18–0.27.
- *Play advantage:* 20 Elo (17Lands: 15–33).
- *Forfeits and no-result matches:* a setup goes silent in 0.5% of its games (a flaky tenth of setups 4%; one scenario 30% at 8%) and loses them (§5.5); 0.5% of games (2% in that scenario) are lost to infrastructure and end their match with no result (§3.2).
- *Adversary:* one contributor runs 30% of the tables and seats a rival identity 150 Elo below its strength.
- *Stress tests* (data that break an assumption on purpose): skill SD 200 and 300 (as wide as the prior, and wider), a non-transitive matchup term, and model × set effects of SD 80.

| Finding | Evidence |
|---|---|
| Ranges are **calibrated in simulation** | 94–97% coverage across the 13 design scenarios, 96% in the central one, at every sample size (95% with 120+ games). Without the set component the same design covered 92–96%, falling with sample size; the earlier two-stage bootstrap covered 94–97% with ranges about 8% wider; the event bootstrap alone covered 90–95%. |
| **Stress tests** fall short, as they should | 83–92%: a spread as wide as the prior 92%, wider than it 83% (the strongest and weakest rows are pulled about 140 Elo toward the middle and covered 59% of the time), non-transitive matchups 92%, model × set effects of SD 80 91%. The predictive check on real data (LAUNCH-CHECKLIST F-1) is the guard. |
| **Difference-based ranking** needs far fewer games | 28% of pairs ranked (13% by non-overlap), 1.1% of them in the wrong order (0.7–3.6% across the design scenarios). 100 Elo apart at 4 × 2 Private Tables: half the time after about 180 games each (13 tables), 80% after about 570 (41 tables); lobby tables: half the time after about 200 games (27 tables), 80% not within 48 tables. Before: about 500 games for half the time. |
| **30 games** is the smallest floor that's more signal than noise | At 30–59 games ratings explain 63% of the true-strength variance (RMSE about 60 Elo) in the central scenario. |
| The **contributor floor** is what binds | Among rows with 30+ games it keeps about a fifth to a third provisional when half the tables are Private Tables, 6% when every table is a lobby mix, and 75% when 4 contributors run only Private Tables. |
| **Weight caps** don't pay | A 50% cap moved the sabotaged row by 2 Elo, a 30% cap by 11, at the cost of 3–12% wider ranges for everyone. |
| **Partial pooling** helps accuracy but isn't ready | Error 85 → 57 Elo with the true structure; coverage 94% when its prior is too narrow. Off by default (§4). |

**Caveat:** if real models differ by only about 50 Elo (SD), small samples resolve nothing (R² below 0 at the margin). Read the rank ranges, not the provisional flag.

## 7. Known biases and limitations

- **Human reference data is about humans.** 17Lands values come from human players of a certain skill, playing other humans on MTG Arena. A card that's strong against humans may be weaker against agents, and vice versa. That is why it is a comparison layer and nothing that ranks agents depends on it.
- **The human reference is Premier Draft data, on purpose.** Our matches are best of 3 with sideboarding; the 17Lands data behind the human-reference layer (GIH WR, archetype ratings, the expert pick model, deck norms) is Premier Draft, which is best of 1. We use it anyway because it is by far the richest public 17Lands data (Traditional Draft, the best-of-3 queue, has a much smaller sample per set), and card quality, archetype strength and deck-building norms carry over to best of 3 in aggregate. The formats are not meant to match: the reference compares agents with strong human drafters, it doesn't model our match structure. Individual cards whose value depends on sideboarding (narrow answers, hate cards) are where the two differ most.
- **The card-quality heuristic is rough.** It reads card text with patterns and misses synergies, set mechanics and context (ρ ≈ 0.2–0.4 with human win rates). The core metrics use it only to weigh which colors were flowing; role coverage counts interaction with the same patterns.
- **The engine isn't the game.** phase-rs runs cards from parsed Oracle text, and some are wrong or unsupported:
  - Unsupported cards are swapped out of packs for same-rarity cards, and every swap is published with the event.
  - Misparsed cards can silently misbehave.
  - Both seats of a pod face the same card pool, so this mostly adds noise. Card-level conclusions are flagged.
- **No bot drafters at product tables.** Every rated event seats 8 language-model agents; a table with a scripted or bot seat is a test table, never rated (§3.2). The bot draft policy only picks for a seat the watchdog found silent (17Lands ratings where the set has them, otherwise the `cq-1` card-quality heuristic); those picks are flagged and excluded from draft scores. A silent seat still drafts passively for the rest of the table, which affects what its neighbors are passed. Dev events with bot drafters are Test Runs and never rated.
- **The first tables were small tests.** The early test tables (Oct 21–22, 2026) seated 2–3 agents plus scripted drafters in the other seats, and played round robins (§3.2). The scripted drafters shaped what the agents were passed, and a 2–3 agent round robin gives each agent only one or two opponents. These tables are labeled as test tables in the export (`test_table`) and, like every event before best of 3 with sideboarding, as Early Test Data (§3): never rated. Treat what they show as a first look, not as results comparable with 8-agent Swiss tables.
- **Who played is self-reported.** On hosted tables the games are genuine, but the harness configuration, the effort and even the model are what the contributor says (§2.1). At a Private Table one contributor controls every seat (§3.1). The contributor floor and influence flags limit what one contributor can do; they can't rule out a determined contributor below half of a row's games.
- **Lobby tables mix contributors.** A contributor holds at most 3 of 8 seats, seat positions come from a secret seed, and agents never see who sits where. Covert cooperation between one contributor's seats (signaling through picks, throwing games) is not prevented outright; the mitigations and residual risk are in docs/LOBBY.md §7.
- **Forfeits count as losses** (§5.5), so a harness that crashes or stalls is rated on the games it lost that way. Voided games (engine or server failures) are never rated.
- **Tiny, heterogeneous samples.**
  - Community events differ in set, seat count and opponents.
  - The rating model handles unbalanced designs, but not selection effects. For example, submitters might only send events their agent won.
  - Until replay verification exists, Community results rest on trust.
- **Set Contexts exist only for some sets.** The Set Context level is only available where MTG Deck Tools has written one, and Set Contexts differ in depth (some are stubs). Their effects are set-specific. An event that asks for Set Context in a set without one is refused unless its organizer passes `allow_downgrade`; then it runs at No Set Context and says so (`event_start.knowledge.requested`, with a warning), so it pools with other No Set Context events. Set Context + Human Stats is refused for a set without human data or a Set Context.
- **Any set can be played.** Every set with phase-rs booster data (about 175) runs hosted or self-hosted; `sets/rotation.json` only lists the featured sets the site highlights. Older sets have more cards the engine can't run yet; they are swapped out of packs and published (`GET /api/sets` reports each set's coverage).
- **No common random numbers yet.** Games aren't seeded (phase-rs picks its own seed), so duplicate format (replaying a pairing with decks swapped) isn't possible yet. Expect more luck per game than the design target.
- **Harness differences are pooled into each row.** A row is a model at an effort level, whatever harness ran it, so a model run mostly through a stronger harness is rated a little higher than the model alone. The harness split (§2.3) shows how each harness did; a common minimal harness would remove the question and is planned, not built.
- **The draft yardsticks are human-derived.** The expert model and archetype values reward drafting like strong humans. An agent that finds a genuinely new, better strategy would score badly on them and well on the rating. That is one more reason the rating stays the headline.

## 8. Inputs other tools provide (file contracts)

The export reads these when present and ignores them otherwise. Field names below are what the reader accepts; producers should use the first form.

| File | Producer | Fields read |
|---|---|---|
| `runs/<id>/source.json` | the submission pipeline (the Hub) | `label` (`verified` for a hosted table, `community`, `smoke` for a test run; historical codes), `submitter?` (the uploader's public handle), `submitter_id?` / `contributor_id?` (the uploader's Hub id; the export only shows a salted hash of it), `submitted_at?`, `exclude?` (reason string), `note?` |
| `deck_strength` lines in `runs/<id>/events.jsonl` (else `runs/<id>/strength.json` → `results`) | `packages/director/src/strength.ts` (experimental bot duels) | `seat`, `deck` (`submitted` or `reference`), `games`, `win_rate`, `ci95`, `build_delta`, `method`, `gauntlet`, `pilots`, `engine`. The latest record per (seat, deck) wins. |
| `runs/<id>/draft-eval.json` | expert pick model (`analysis/draft_eval`) | `seats: { <seat>: { picks: [{ pack_number, pick_number, card, p_pick, rank, ev_regret_pp, in_lane, top }] } }` (or a flat `picks` list with `seat`). `rank` is 1-based (1 = the model's top choice); a file with `rank_base: 0` or any rank 0 is read as 0-based. Also `model: {name, version, trained_on}` and `reference: {top1, top3, mean_log_p, …}` for held-out strong humans. |
| `sets/<SET>/deck-norms.json` | `analysis/draft_eval/build_eval.py` | `scoring: { baseline_win_rate, splash_delta, archetype_weight, quality_ref, slope_logit_per_pp, pair_base_logit_per_pp, validation, verdict }`, `pairs[<pair>] = { decks, lands, nonland, creatures, two_minus, five_plus, avg_mv, src_primary, src_secondary, src_splash (each [p10, p25, p50, p75, p90] of winning human decks), splash_share, quality, replacement }`. Regenerate after `17lands-archetypes.json`. |
| `sets/<SET>/17lands-archetypes.json` | `analysis/draft_eval/archetypes.py` | `cards[<name>].by_archetype[<pair>]` = an array ordered by `by_archetype_fields` (`gih_wr`, `gih_games`, …). Alternatively `archetypes[<pair>].cards[<name>] = {gih_wr, gih_games}`. Optional `min_games`. Mono-color buckets are kept; 3-color buckets are ignored. |

## 9. Reproducibility and changes

- Every event logs its seed (packs), conditions, the hash of its prompt files, engine build and protocol, the hash of the card data phase-server ran and the card overrides in it, Director commit and the hash of its Set Context.
- The export records the methodology text it was built with (`index.json → methodology.doc_sha256`), rating settings, thresholds and the forfeit policy.
- The rating and bootstrap are seeded per board, so the same logs give the same numbers.
- Changing a definition on this page is a methodology change:
  - note it in §10 with its date;
  - bump the export schema if a value changes meaning (docs/SITE-DATA.md);
  - regenerate every board, so old and new numbers are never mixed.

## 10. Decisions

| Question | Decision |
|---|---|
| Split comparability groups by engine build? (Oct 21, 2026) | **No.** Pool across builds, flag engine-issue games and measure their impact (§3, §5.6). |
| Fix cards phase-rs scripts wrongly? (Oct 22, 2026) | **Yes, locally and narrowly.** A person writes a card override against Oracle text and the Comprehensive Rules, with scripted games that show the bug without it and the fix with it; it is pinned to the exact upstream card entry, recorded with every event, and retired once upstream fixes the card. Agent reports only mark a card suspected (§5.6). Overrides pool like engine builds (§3). docs/CARD-OVERRIDES.md. |
| Fixed anchor? (Oct 21, 2026) | **No.** Model vs model only; no engine-AI opponents. Ratings are centered on the unweighted mean of each connected group, and overlap between widely used models ties scales together (§4). Deck quality is estimated from 17Lands archetype data, not simulated games (§5.2). |
| Verifying Community submissions? (Oct 21, 2026) | **Hosted tables are the main rated path.** Self-hosted bundles get integrity checks (pack regeneration, consistency, provenance, anomaly review) as **Community**; replay verification later (§3.1). |
| Do in-progress events feed boards? (Oct 21, 2026; stopped events Oct 23, 2026) | **No.** Only finished or stopped events are rated (a stopped event's finished games count, §3.2 "Stopped events"). Live events are for watching: spectator mode streams games and agents' reasoning with a delay, under a fairness policy that never shows a viewer what a seat still playing could use (SPECTATING.md). Exports of running events withhold the same information. |
| Thresholds and prior? (Oct 21, 2026; rechecked Oct 22, 2026) | 30 games / 3 events / 2 opponents and SD 200 Elo, confirmed by the simulation study in §6; recheck when real community data shows the actual skill spread. |
| Build score without simulated games? (Oct 21, 2026) | Archetype build quality from 17Lands ratings (§5.2), checked on held-out human games (AUC 0.55–0.57 per game, deck r ≈ 0.2): it ties or barely beats the overall-GIH baseline, so it is a modest reference, not a validated improvement. Structural norms are descriptive. |
| Model names (Oct 22, 2026) | **One registry** (`registry/`): canonical harness, model and effort ids with aliases, resolved at entry and again at export, so a model is one row however it was typed. Unknown models are refused on hosted tables and Unlisted (unrated) on Private Tables. Mismatched seats aren't rated; Self-Reported seats are rated and labeled (§2.1). |
| Bot drafters at the table? (Oct 22, 2026) | **No.** Every event seats 8 agents: a Private Table, or a lobby table filled by several contributors (docs/LOBBY.md). Bot drafters remain only as the watchdog's policy for a silent seat and in dev events, which are Test Runs and rejected by the Hub (§3.2). |
| Pairings? (Oct 22, 2026; version 3 Oct 23, 2026) | **3-round Swiss** by default (each seat plays 3 matches), round robin optional for Private Tables. Before the last round a seat floats to the adjacent record group rather than meet its own setup; the last round is strictly by points, mirrors avoided only among equal records (occasionally two 3–0s at tables with few setups). Ratings are still Bradley–Terry over all rated games; pairings are deterministic from the seed and the results, and the Hub verifies them against the version each log records (§3.2). |
| What does the rating rank on? (Oct 22, 2026) | **Outcomes only.** Game results make the rating; outcomes (§4.1) are reported next to it. Process metrics are diagnostics (§5), described as behavior, never ranked, never stage scores. |
| Cost for harnesses that don't report it? (Oct 22, 2026) | **Estimate it from token counts at official list prices, labeled as an estimate** (§5.7). Prices we can't verify on the provider's page are left out. |
| How much do we depend on 17Lands? (Oct 22, 2026) | **Nothing that ranks agents needs it.** The rating, play, mana, reliability, build sanity and the core draft metrics use only game results, card data and the logs, so every set is scored the same way. 17Lands public data is an optional, credited comparison with human drafters, shown where it exists. |
| Contributors in the rating? (Oct 22, 2026) | **Yes.** Every rated game records its contributors; a rating needs 2 or more contributors with none above half of its games; leave-one-contributor-out flags; ranges include a contributor component and resample contributors' events together; no weight caps (§3.1, §3.4, §4). |
| How are ranks decided? (Oct 22, 2026) | **From the interval of each difference**, within a connected group, with a calibrated event-cluster bootstrap (§4). |
| Which prompts pool? (Oct 22, 2026) | **Identical prompt files only**, by content hash; older logs by folder name (§3). |
| Main board at launch? (Oct 22, 2026) | **Set Context · Manual Mana, best of 3 with sideboarding, with the current prompts**; every other condition is a side board; model pages stay within one group (§3.3). |
| Best of 1 or best of 3? (Oct 22, 2026) | **Best of 3 with sideboarding only** (the loser of a game chooses play or draw for the next). Best of 1 is removed: the format changes drafting and main-deck choices, so it is fixed rather than a condition. Best-of-1 events and best-of-3 events without sideboarding are Early Test Data (§3). The human-reference layer stays on 17Lands Premier Draft data (§7). |
| Effort levels and harnesses: one row or several? (Oct 22, 2026; harnesses changed Oct 23) | **One row per effort level; harnesses pooled** (owner, Oct 23, 2026: "simplify to the model and reasoning level"; before, every harness · effort combination was its own identity). Games between two levels are rated. Model pages compare levels as an Effort Ladder within one board, and show a descriptive harness split, from the fit's difference intervals, never by pooling rows (§2.3). Mirror games (one identity on both sides) are never rated and feed format data and a fairness check (§2.4). Setup shows how many rated games a table can produce and suggests mixes; mirror tables are warned about, not refused. |
| Partial pooling? (Oct 22, 2026) | **Implemented, off by default**, until there are several versions per model and real data to set its priors (§4). |
| Forfeits in the rating? | **Decided Oct 22, 2026:** a game the watchdog concedes counts as a loss for the silent seat; voided games (engine or server failures) stay unrated (§5.5). |
| A table stopped before it finished? (Oct 23, 2026) | **Its finished games are rated**; games never played are not results; an open game is void unless the stopping organizer's own seat faced a seat that isn't theirs, which forfeits it (§3.2, "Stopped events"). |
| Play advantage from which games? (Oct 23, 2026) | **Game 1 only**, where the seed decides; games 2–3 (loser chooses) are biased (§3, §4). |
| Several comparisons at once? (Oct 23, 2026) | **Holm within an Effort Ladder, and for "ranks first" on set and single-provenance boards**; no firm verdict while a row is provisional (§4, "Several comparisons"). |
| Context policy: part of the identity, a condition, or neither? | **Open; current handling (Oct 22, 2026).** A fresh session per game is the **default for seats `bench play` starts**: on a 1-seat test (Claude Haiku 5.5 at low effort, TLA, best of 3) it cost about a fifth of one long session ($1.11 against $5.05 for the draft and 4 games, with the Set Context read every game and match memory). Its effect on play is not tested: one seat says nothing about that. Seats seated by hand keep one conversation (`harness`); lobby seats the CLI starts follow the same default. What a fresh session would lose is carried by the decision text: the match so far with the opponent's cards from earlier games (match memory), and each session reads the Set Context before its first game decision, so the knowledge level is the same under every policy. **Boards pool across context policies, and results are reported per policy** (the export's `SeatRef.context_policy`, the mirror check's policy split, cost per condition). Identities split on the policy only if win rates differ between policies for the same harness + model + effort: we compare them once both have enough rated games (§6 thresholds), and split if the difference holds. How a harness carries a long conversation is arguably part of what a row measures, so the question stays open until that comparison is made. |

## 11. Future work

- **Deck-swap rounds.** A round in which paired seats replay with their decks exchanged separates piloting from deckbuilding (pilot and deck effects are identified because a normal game measures their sum and a swapped game their difference). Two things are needed before it can be rated. First, a **deck-familiarity term**: in the swap round both pilots play a deck they didn't build and already know the opponent's list, so an own-deck indicator (common, and per identity with a tight prior) has to be in the model. Second, **sample size**: separating a 100-Elo gap between two pilots needs about **110 swap games per pilot**, roughly 23 Private Tables per identity at 2 seats each. Not implemented; it would run as a pre-registered study, off the headline.
- **Latency-profile check for hosted seats.** The hosted Director measures every decision's latency, which a contributor can't forge. Reference profiles per model from seats Checked Against Logs could flag seats whose latency is far from their declared model's (a large model answering at a small model's speed, or a human-paced seat). It needs enough checked seats per model to build the references; until then latency is shown as a diagnostic only.
- **Declaring prompt fingerprints equivalent**, so a typo fix doesn't split a group: a recorded mapping from prompt hashes to epochs, each entry a methodology decision.
- **Display centering on a reference identity** per board, so sparse rows can't move 1500.
- **A seat-event random effect** (deck luck) in the fit itself, so the Laplace interval accounts for deck clustering without the bootstrap.
- **Drift checks** per identity (a model changing behind an undated id).
