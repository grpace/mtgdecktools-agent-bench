# MTG Deck Tools Agent Bench: Design

The map of the project: its goals, components, engine choice and the reasoning behind them. Where this page differs from [METHODOLOGY.md](METHODOLOGY.md) (what the numbers mean) or [PROTOCOL.md](PROTOCOL.md) (what agents see and send), those are right.

In short: the engine is **phase-rs**, and the headline is **LLM vs LLM**. Every event seats 8 agents (no bot filler) and plays 3 rounds of Swiss, each match best of 3 with sideboarding; contributors with fewer agents use the matchmaking lobby ([LOBBY.md](LOBBY.md)).

## 0. Ownership: MTG Deck Tools Product, Open-Source Engine

This is an MTG Deck Tools project with an open-source component:

| | Where | What |
|---|---|---|
| **Product** (closed source) | mtgdecktools.com `/agent-bench` | Leaderboard, event and draft pages, replays, set insights, the Set Contexts (the Set Context knowledge level, `primer`), branding |
| **Open-source engine** (this repository) | GitHub | Director (phase-rs bridge, events, MCP seats, lobby), the Hub (results service, open data), protocol, prompts, the `bench` CLI, results/data export format, a local viewer for your own runs |

Data flows both ways:
- **mtgdecktools.com → engine:** Set Contexts, published at build time and fetched by the Director (copies in `sets/<SET>/primer.md`).
- **Engine → mtgdecktools.com:** results, as JSON exported from event logs (`docs/SITE-DATA.md`) or served by a hosted Director.

Hosted tables hand their results to the Hub on their own; self-hosted runs submit a results bundle (docs/COMMUNITY.md).

## 1. Goals

1. **Measure agents at limited Magic, playing each other.** Agents draft at the same table, build, and play LLM vs LLM. We give a headline rating from game results, plus outcomes (matches, finishes, head to head) and diagnostics that describe how each agent drafts, builds and plays. Diagnostics never feed the rating.
2. **Learn about formats.** Agent games are a cheap, endless source of draft and game data. Use them to rate cards, archetypes and strategies, and compare them with human data (17Lands).
3. **Agent-native.** Any agent that speaks MCP can sit down at a table. Two separate processes play each other with nothing shared but the game server.
4. **Easy to stand up.** One `docker compose up` on any small VPS gives you a table that agents anywhere can join.
5. **Open and reproducible.** Anyone can run an event and publish results. Every number can be recomputed from the logs; checking results by replaying games waits on seeded games in phase-rs.

Non-goals for v1: Constructed, Commander, a polished human client, ranked play against humans, training models.

## 2. Who It's For

| User | What they want | What we give them |
|---|---|---|
| Model and agent builders | "How does my agent rank, and where does it lose?" | Leaderboard, outcomes and diagnostics, replays of losses, decision-level failure analysis |
| Limited players and content creators | "What's good in FRA? What do the bots think?" | Format reports, card pages, agent vs human comparisons |
| Researchers | Data | The open dataset: Parquet and CSV tables plus full event logs, built nightly, CC BY 4.0 (docs/OPEN-DATA.md); deterministic replays later |
| MTG Deck Tools | Format insights for its tools | Embeddable format insights; the Set Contexts get a measurable "does this help?" test |

## 3. Architecture

```
┌─────────── Your harnesses (each LLM "thread" runs on your own machine & subscription) ───────────┐
│  Claude Code session        Codex session        Cursor CLI            OpenCode / Gemini CLI …  │
│  (all LLM thinking happens here; the server never calls a model and holds no API keys)         │
└──────────┬─────────────────────────┬─────────────────────┬────────────────────────┬──────────────┘
           │        MCP over Streamable HTTP, one seat URL per thread (bearer seat token)        │
           ▼                         ▼                     ▼                        ▼
┌──────────────────────────── Director (TypeScript) ──────────────────────────────────────────────┐
│ hosts the MCP endpoint · events · pods · seat tokens · clocks · stops · renders views · log     │
│ matchmaking lobby · 8-seat tables · Swiss pairings · inactivity watchdog                        │
└──────────────────────────────────────────┬───────────────────────────────────────────────────────┘
                                           │ phase-rs wire protocol (JSON over WebSocket, pinned version)
                                           ▼
┌──────────────────────── phase-server (Rust, MIT/Apache, pinned) ────────────────────────────────┐
│ rules engine · legal actions · hidden-info filter · drafts on MTGJSON boosters                  │
│ unmodified upstream image, pinned by digest (engine/phase.lock.json)                            │
└──────────────────────────────────────────┬───────────────────────────────────────────────────────┘
                                           ▼
     Event log (JSONL per event) ──▶ Hub (checks, export, nightly open data) ──▶ mtgdecktools.com
```

**Deployment:** `npm run bench -- up` (Docker Compose, `deploy/compose.local.yaml`) brings up `phase-server` (the pinned upstream image) and the `director`, plus volumes; the hosted service adds the Hub and its Postgres (`deploy/compose.yaml`). Measured on the upstream image (2026-10-21):
- 226 MB image, about 20 s to healthy (including the first-boot card download)
- 36,004 cards and 175 draft sets loaded
- about 580 MB RAM idle
- 100 concurrent games per process by default

Agents connect from anywhere with a URL and a seat token.

### Components

| Package | Language | Role |
|---|---|---|
| `engine/` | config | The phase-rs server image we run: the unmodified upstream `ghcr.io/phase-rs/phase-server`, pinned by digest (`engine/phase.lock.json`; docs/UPGRADING.md). The patches in §4.1 were planned for a fork; none is applied, and any we pursue would go upstream. |
| PROTOCOL.md | spec | Our agent-facing contract: decision envelope, events, results. Planned: a `packages/protocol` with JSON Schema that generates docs and types, with CI failing on drift (rs-sdk lesson). |
| `packages/director` | TS (Node) | Runs events and **hosts the MCP server** (Streamable HTTP, one seat URL per agent). Creates drafts and games on phase-server, renders the filtered state + legal actions into our decision envelope, enforces clocks and stop policy, pairs the Swiss rounds, runs the matchmaking lobby, writes the event log. **Never calls an LLM.** |
| `scripts/bench` | TS | The `bench` CLI (`npm --prefix ~/mtgdt-bench run -s bench -- <command>`): setup, creating events, joining the lobby, and `bench play`, which launches your harness CLIs headless with a seat URL (`claude -p`, `codex exec`, `opencode run`…) on your subscription, starts a fresh session per game by default, and restarts a session if it dies. It collects whatever usage the harness logs itself. You can also skip it and paste a join prompt into any open thread. |
| `packages/hub` | TS (Node) + Postgres | The results service: takes hosted hand-offs and submitted bundles, runs the integrity checks, exports the site data, contributor accounts and points, the nightly open dataset. |
| `packages/registry` + `registry/` | TS + JSON | The one list of harness, model and effort names, aliases, effort defaults and prices (METHODOLOGY §2). |
| `prompts/` | md | The current join prompt and agent instructions handed to every harness, so every seat gets the same briefing; earlier sets in `prompts/archive/vN/`. |
| `analysis/` | Python | The human-reference layer from 17Lands public data: archetype ratings, the expert pick model, build-quality validation. A win-probability model is planned. |
| `packages/site` | TS | The export: ratings, outcomes, diagnostics, card stats and summaries as JSON (docs/SITE-DATA.md), plus static report pages for your own runs. The public site is mtgdecktools.com. |
| `sets/<CODE>/` | data | Optional per-set extras: the Set Context (`primer.md`), 17Lands aggregates and archetype ratings, deck norms (sets/README.md). A card trust list (§4.2) is planned. |

Why the Director sits in the middle instead of agents talking to phase-server directly:
- phase-server's protocol version must match exactly and changes almost daily, with about 144 `WaitingFor` and 139 `GameAction` variants. Agents should never depend on that.
- The Director turns it into our small, stable envelope and keeps the engine swappable (Forge stays a possible second backend).
- It is also where clocks, stops, logging and fairness rules live.

## 4. Engine Choice: phase-rs

**[phase-rs/phase](https://github.com/phase-rs/phase)**: a Rust rules engine built as a pure reducer, MIT/Apache-2.0, with an Axum WebSocket server. Compared against Forge in [PRIOR-ART.md](PRIOR-ART.md).

Why phase-rs over Forge:
- **Easy to run as a server.** There's an official multi-arch Docker image and Helm chart, many games per process, SQLite persistence, Prometheus metrics and spectators. Forge has no server image: mtg-bench starts a separate JVM for each match and builds Forge from source.
- **Already the right shape.** The server filters hidden information for each seat. Every update carries that seat's `legal_actions`. The engine re-validates every action (`AiDecisionContract`). Everything is plain JSON. An outside client can join as a player today.
- **Real retail boosters** from MTGJSON booster sheets. That includes FRA's matched Echoed Pair slot, which Forge's own edition file says it can't build. Also Premier/Traditional/Sealed draft modes and Swiss pairing.
- **Determinism built in.** ChaCha20 RNG and a `ReplayLog{seed, decks, actions}` with deterministic re-apply and desync detection.
- **A permissive license**, so the whole project can be Apache/MIT with no GPL boundary.
- **LLM-ready prior art.** The `phase-llm` crate already renders a filtered state and numbered candidates for a model, with stale-answer fingerprints. It runs only in the browser client, but it's a strong reference.
- **Fast.** About 1.5 s per AI-vs-AI game with search. The engine will never be the bottleneck; model latency will.

### 4.1 Engine Changes We'd Like Upstream

We run the unmodified upstream image, so none of these is applied. The Director covers what it can (it picks for a silent seat with its own bot draft policy, exposes structured attacks and blocks, and makes the engine start a game with the chosen player); seeded games and a server-side replay log still need phase-rs, and anything we pursue would be proposed upstream.


1. **Settable game and draft seed.** The server currently seeds with `rand::rng()`.
2. **Server-side `ReplayLog` dump** for every game. Today only the WASM client records one.
3. **Server-side bot drafter.** Server bot seats currently pick at random on timeout. Wire in `phase_ai::draft_eval` (already used by the client's Quick Draft) so a seat the watchdog drafts for picks sensibly.
4. **Structured combat declaration.** The AI candidate list only offers "no attack / each single attacker / all-in". The server already accepts any legal `DeclareAttackers`/`DeclareBlockers`, so we expose that as a structured choice (`attackers: [ids]`) in our envelope and validate it.
5. Optional: a way to start a game from a state snapshot (for puzzles, T3).

### 4.2 The Main Risk: Card Correctness, and How We Handle It

phase-rs builds cards by parsing Oracle text, not hand scripting.
- **"Supported" is not the same as correct.** Its own backlog lists thousands of cards with suspected misparses, including dozens of booster cards in each recent set.
- **Not every card is supported.** A few cards in each set can't run yet; a set missing from the misparse backlog has an unknown misparse rate, not a zero one.
- **Unimplemented effects silently do nothing.**

Defenses, which are part of the benchmark rather than an afterthought:
- **Swaps.** Cards the engine can't run are swapped out of generated packs for another card of the same rarity from the same booster sheet. Every swap is logged and published with the event.
- **Card overrides.** Fixes for cards that matter in featured sets, applied on top of the pinned card data and sent upstream ([CARD-OVERRIDES.md](CARD-OVERRIDES.md)).
- **Engine-issue flags.** Every game is flagged when engine issues may have touched it, and the impact is measured (METHODOLOGY §5.6).
- **Card trust list per set (planned):** each card `trusted | suspect | excluded`, built from phase-rs coverage data + the semantic audit + the misparse backlog + our own tests, with a threshold for rated events (for example ≥ 98% of pack-weighted cards trusted).
- **Anomaly reporting.** Agents may call `report_rules_issue(card, note)`. Reports, together with `Unimplemented` engine events, feed the engine-issue flags and the set page's engine section. That becomes a stream of upstream bug reports.
- **Give back.** phase-rs accepts LLM-written card fixes (`docs/AI-CONTRIBUTOR.md`). The cards that come up most in our events become our contribution queue. Fixing the cards we need also fixes them for everyone.
- **Later: differential testing** against Forge on the same scripted scenarios, to catch misparses automatically.

### 4.3 Other Risks
- **Protocol churn:** pin a commit, upgrade on purpose per release, keep the Director adapter small, and run a conformance suite (fixed-seed bot games must give identical results) before any engine bump.
- **A young engine, mostly one developer:** pinning by digest and upstreaming fixes help. Forge stays the fallback backend behind the same Director interface.

## 5. LLM vs LLM Is the Benchmark

- **The headline rating comes only from games where LLM seats play LLM seats** (T5 pods; T4 head-to-head with fixed decks is planned).
- **Every event seats 8 agents.** One contributor can fill a Private Table (e.g. 4 models × 2 seats); contributors with 1–4 agents meet in the matchmaking lobby ([LOBBY.md](LOBBY.md)). Tables play a 3-round Swiss (METHODOLOGY §3.2).
- Built-in bots (phase-ai's heuristic player and drafter) have no seat in product events. There are no filler seats, no games against the engine's AI, no anchor and no bot-duel deck strength in the methodology (METHODOLOGY §4, §5.2). What remains:
  1. the **inactivity watchdog** uses the bot draft policy to pick for a seat that has gone silent (flagged, never scored);
  2. **dev engine tests** may fill empty seats with bot drafters (`--dev-bot-fill`); those events are labeled Test Run, never rated, and the Hub rejects them.

## 6. Tracks

Only **T5** is built; the others are planned.

| Track | Engine? | Opponent | What it isolates |
|---|---|---|---|
| **T1 Pick** | No | None | Draft picks on real human packs from the 17Lands draft dataset |
| **T2 Build** | No | None | Building 40 from fixed pools, scored without simulated games (17Lands archetype build quality, METHODOLOGY §5.2) |
| **T3 Puzzles** (later) | Yes | Scripted state | Tactical play from fixed positions |
| **T4 Duel** | Yes | **Another LLM** | Head-to-head on fixed decks, duplicate format (swap decks, same seeds): pure play skill |
| **T5 Pod** | Yes | **Other LLMs** | 8-seat draft → build → 3-round Swiss, best of 3 with sideboarding. **The headline.** |
| **T6 Season** (later) | Yes | Other LLMs | Several pods in a row with persistent notes: does the agent learn the format? |

T1–T2 need no games, so they are the cheapest tracks to add next.

## 7. Knowledge Conditions (MTG Deck Tools Integration)

What agents may know is a per-event setting (`--knowledge`), identical for every seat and logged in `event_start`. Every level gets the standard briefing: the Limited fundamentals, the **MTG Deck Tools deckbuilding guide** (`prompts/deckbuilding-guide.md`, condensed from the MTG Deck Tools AI Deck Builder rules) and an **MTG Deck Tools-style pool analysis** at deckbuilding (METHODOLOGY §3, "Knowledge levels").

| Level | Contents |
|---|---|
| No Set Context (`none`) | Card text only (cost, type, P/T, Oracle text), in full at every decision and via `get_card`. |
| Set Context (`primer`) | + the **MTG Deck Tools Set Context** (`sets/<SET>/primer.md`, refreshed with `npm run deps -- update set-context`), read in parts via `get_set_context`; every harness session reads it before its first game decision. |
| Set Context + Human Stats (`primer+stats`) | + 17Lands public-data **GIH WR and ATA** next to every card in packs and in the pool, the best-23 average GIH WR per color pair in the pool analysis. No level shows tier scores. |

Running the same packs and seeds under the three levels measures, in rating points and in draft/build metrics, what the MTG Deck Tools Set Contexts and the human data are worth. That is a research result and a direct proof point for mtgdecktools.com.

Anti-leak rules: agents never see the event name, the opponent's identity or model, or hidden information.

## 8. How Agents Join: Bring Your Own Harness

**The server never runs a model and never needs an API key.** Each seat is an LLM "thread" running in a harness you already have: a Claude Code session, a Codex session, OpenCode, Gemini CLI, Cursor (a launcher such as T3 Code can start them). It runs on your machine and your subscription. The Director only processes moves and relays turns.

1. Create an event with 8 seats (a Private Table), or join the matchmaking lobby with 1–4 seats and wait for a table ([LOBBY.md](LOBBY.md)). The Director gives back one **seat URL** per seat (`https://<host>/mcp/<seat-token>`).
2. Connect each thread to its seat:
   - **By hand:** paste the join prompt plus the seat URL into any thread (e.g. `claude mcp add --transport http mtg-seat <seat-url>`, or the equivalent in another harness), then say "play".
   - **Automated:** `bench setup` (or `bench new`, then `bench play`) starts headless harness sessions (`claude -p …`, `codex exec …`) with the MCP config already set (docs/COMMUNITY.md, docs/HARNESSES.md).
3. Each thread loops `wait_for_decision` → think → `decide` until the event ends. The Director blocks on whoever holds the decision and wakes the other thread when it's their turn.

**What a leaderboard entry is.** *model + effort setting* (e.g. "Claude Opus 5.5 · High", "GPT-6 Astra · Medium"). The harness is recorded per seat and shown as a descriptive split, not a separate row ([METHODOLOGY.md](METHODOLOGY.md)). A thinner "plain" harness configuration (no extra tools, standard prompt) can be added later for model-only comparisons.

**Long events vs context windows.** a pod is 42 picks + a build + 3 best-of-3 matches (about 7 games, with sideboarding between them), i.e. hundreds of tool calls. Seats are durable on the server: a thread can be restarted mid-event and resume from `get_view` + its notes. `bench play` starts a fresh harness session per game by default (`--fresh-session`, PROTOCOL §6); each decision carries the board, the match so far and the opponent's cards from earlier games, and each session reads the Set Context before its first game decision.

**Usage and cost.** the server can't see tokens. It measures wall time per decision. `bench play` (or `bench attach-logs`) collects whatever the harness logs itself (e.g. `claude -p --output-format stream-json` reports usage and cost). Leaderboards show a reported cost where the harness gave one and an estimate from token counts at list prices otherwise, always labeled ([METHODOLOGY.md](METHODOLOGY.md)).

## 9. Licensing

- Engine: phase-rs, **MIT/Apache-2.0**, not included in the repo. Our code: **Apache-2.0** (`LICENSE`, `NOTICE`). No GPL anywhere unless we add Forge as a second backend; that adapter would live in its own GPL package.
- Set Contexts from MTG Deck Tools: **CC0 1.0** (public domain).
- 17Lands: **public datasets only**, credited; derived aggregates redistributed under CC BY 4.0 with the 17Lands credit.
- The open dataset of benchmark results: **CC BY 4.0**, attribution "MTG Deck Tools Agent Bench" (docs/OPEN-DATA.md).
- Card data: MTGJSON/Scryfall via phase-rs; no card images in the repo; show the Fan Content Policy notice.

## 10. Security and Fair Play

- Agents are separate, untrusted processes holding only a seat token. They never touch the engine, the Director's internals or the logs.
- Hidden information is filtered by phase-server **and** re-checked by the Director before anything leaves the server.
- No free-text chat between seats in v1 (it's a prompt-injection surface).
- **Verification:** **Hosted** tables are played on our Director, so their logs are written server-side. A self-hosted result bundle is checked by the Hub (pack regeneration from the seed, draft and game consistency, pairings, provenance, anomalies) and labeled **Community** (METHODOLOGY §3.1). Replaying every game with the pinned engine, for a **Replay-Checked** label, waits on seeded games in phase-rs. None of these proves which model played; that rests on the harness logs (METHODOLOGY §2.1).

## 11. Reproducibility

- Pin and record everything in every result: engine image digest, card-data hash, protocol, the hash of the prompt files, the Set Context hash, the Director commit.
- Image tags are never re-pushed (runebench lesson).
- Seed → packs, seat positions, pairings and the game 1 starter. Game shuffles aren't seeded yet (phase-rs picks its own seed), so games can't be replayed exactly.
- Conformance suite before every engine upgrade.

## 12. How This Connects to MTG Deck Tools

- **Inputs:** the Set Contexts, and the deckbuilding rules of the MTG Deck Tools AI Deck Builder (condensed in `prompts/deckbuilding-guide.md`).
- **Outputs:** format insights for mtgdecktools.com, feedback into the Set Contexts, and a measurable test of whether they help.
- The MTG Deck Tools apps stay closed source; only content approved for publishing moves into this repository.
