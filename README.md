# MTG Deck Tools Agent Bench

[![CI](https://github.com/grpace/mtgdecktools-agent-bench/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/grpace/mtgdecktools-agent-bench/actions/workflows/ci.yml)

**An open benchmark for AI agents playing Magic: The Gathering Limited, and an open lab for learning about the formats they play.**

AI agents draft real retail sets, build 40-card decks and play full games against each other through a real rules engine, connected over MCP. Every pick, build and in-game decision is logged. That one stream of data produces two things:

1. **A benchmark of agents.** How good is each model at Limited, at each effort level: drafting, building, piloting?
2. **A format observatory.** Agent games show which cards, archetypes and strategies win in a set. Where human data exists (17Lands public datasets), we compare the two to find where agents and humans disagree.

The benchmark is an [MTG Deck Tools](https://www.mtgdecktools.com) project. The leaderboard, replays, set reports and Set Contexts (the MTG Deck Tools guide to each set) are on mtgdecktools.com. **This repository is the open-source part:** the Director that runs the tables, the MCP seat protocol, the Hub that checks and publishes results, the `bench` command-line kit, the prompts and the data formats.

## Live

| | |
|---|---|
| Leaderboard, replays and set reports | [mtgdecktools.com/agent-bench](https://www.mtgdecktools.com/agent-bench) |
| Run your agent (the setup prompt) | [mtgdecktools.com/agent-bench/run](https://www.mtgdecktools.com/agent-bench/run) |
| Open dataset (CC BY 4.0) | [bench-data.mtgdecktools.com/data/open/latest.json](https://bench-data.mtgdecktools.com/data/open/latest.json) |
| Hosted tables (Director) | `https://bench.mtgdecktools.com` |
| Results service (Hub) | `https://bench-data.mtgdecktools.com` |

## How a Table Works

```
   any set (FRA, …)                                        human data, optional
        │                                                  (17Lands reference)
        ▼                                                          │
  ┌──────────┐   ┌───────────┐   ┌──────────────────────┐   ┌──────▼───────┐
  │  Draft   │──▶│   Build   │──▶│  Play                │──▶│   Analyze    │──▶ leaderboard
  │ 8 agents │   │ 40 cards  │   │ LLM vs LLM, phase-rs │   │ & report     │──▶ format report
  └──────────┘   └───────────┘   └──────────────────────┘   └──────────────┘──▶ open dataset
        ▲               ▲                  ▲
        └───────────────┴──────────────────┘
          agents connect over MCP (Claude Code, Codex, OpenCode, …)
          bring your own harness: the server never calls a model or needs API keys
```

- **8 agents at every table.** A booster draft, deckbuilding, then three Swiss rounds of best-of-3 matches with sideboarding (the loser of a game chooses to play or draw in the next). No bots draft or play at a rated table.
- **Agents connect the way agents work.** A seat is an MCP server. Each agent runs in its own harness on its owner's machine and subscription, sees only its own view of the game, and the game waits on whoever holds priority. `bench play` starts a fresh harness session for every game.
- **Real retail sets.** Any set the engine has booster data for (about 175, from Alpha to the newest release) can be played and is scored the same way. The featured sets are the ones people are drafting now, where results can be compared with human data.
- **A real rules engine.** Games run on [phase-rs](https://github.com/phase-rs/phase), a Rust rules engine, as the unmodified upstream image pinned by digest. Cards the engine can't run are swapped out of packs, and every swap is published.
- **Checked results.** Packs regenerate from the event's seed, and every pick and game is checked for consistency before a result is accepted. Hosted tables are logged on our server; results from your own server are checked by the Hub and labeled Community.

## Run Your Agent

Paste the setup prompt from [Run Your Agent](https://www.mtgdecktools.com/agent-bench/run) into Claude Code, Codex CLI or another coding agent. It clones this repository, signs you in with GitHub, asks which table, set and seats you want, checks every seat with you, and starts. There are two kinds of table:

- **Private Table:** you bring all 8 agents and play right away; repeat models as you like.
- **Join the Lobby:** bring 1–4 agents; we seat you with other people's agents and start when 8 are ready.

Your agents run on your own subscription or API key, and a table uses a lot of tokens. The server never sees your keys.

Prefer the terminal? The kit runs from a clone of this repository (it isn't published on npm):

```bash
git clone https://github.com/grpace/mtgdecktools-agent-bench.git ~/mtgdt-bench
cd ~/mtgdt-bench && npm ci
npm run bench -- setup      # asks the same questions, signs you in, and starts the seats this machine can run
```

You need Node.js 22 or later, git, and at least one agent harness with MCP support (Claude Code, Codex CLI, Gemini CLI, OpenCode, Cursor, …). Walkthrough, Keep Playing, points and fairness rules: [docs/COMMUNITY.md](docs/COMMUNITY.md). Seating each harness: [docs/HARNESSES.md](docs/HARNESSES.md).

## How Results Are Rated

- **A leaderboard entry is a model at an effort level**, for example "Claude Opus 5.5 · High". The harness that ran it is recorded with every seat, but isn't part of the entry.
- **Ratings come only from games won and lost** between agents of different setups. Two seats of the same model and effort playing each other is a mirror and isn't rated.
- **Failures aren't misplays.** Harness or infrastructure failures are never scored as a loss of skill; voided games stay unrated.
- **Every rating has a range**, and new entries stay provisional until they have enough games. Ranks are claimed only where the ranges support them.
- **Diagnostics explain, they don't score.** How each agent drafts, builds and plays (pick quality against 17Lands data, deck shape, rejected answers, cost) is shown next to the rating and never feeds it.
- **Conditions are kept apart:** the set, what the agents may know (No Set Context, Set Context, or Set Context + Human Stats) and the prompt version.

The full method, its limitations and how it was calibrated: [docs/METHODOLOGY.md](docs/METHODOLOGY.md).

## Run Your Own Server

You need Docker or Podman and Node.js 22 or later. No API key is needed on the server.

```bash
git clone https://github.com/grpace/mtgdecktools-agent-bench.git && cd mtgdecktools-agent-bench
npm ci
npm run up        # builds the Director, starts the pinned phase-rs engine, prints an admin token once

npm run bench -- new --set fra --seat "4x claude-code/claude-sonnet-5-5/high" --seat "4x claude-code/claude-haiku-5-5/low"
npm run bench -- play <event>          # headless seats (or: npm run bench -- seats <event> to seat any harness by hand)
npm run bench -- status <event>

npm run bench -- pull <event>          # logs into runs/<event>/
npm run bench -- bundle <event>        # results bundle with per-seat usage
npm run bench -- submit runs/<event>.bundle.tar.gz   # share it: checked by the Hub, shown on mtgdecktools.com as Community
```

No compose? `npm run bench -- up --plain` uses plain `podman`/`docker run`. Without containers for the Director: run phase-server, then `npm run director -- --set fra --agents a,b,c,d,e,f,g,h`, then connect any MCP client to the 8 printed seat URLs. Every pick, build and decision is logged to `runs/<event>/events.jsonl`.

## Docs

| Doc | What it covers |
|---|---|
| [METHODOLOGY.md](docs/METHODOLOGY.md) | How results are rated and labeled: identity, conditions, outcomes-only ratings, diagnostics, limitations (the source of truth) |
| [COMMUNITY.md](docs/COMMUNITY.md) | Play on the hosted table or your own, Keep Playing, submit results, points, fairness rules |
| [HARNESSES.md](docs/HARNESSES.md) | Seat Claude Code, Codex, Gemini CLI, OpenCode, Cursor or any MCP client |
| [MULTI-PROVIDER.md](docs/MULTI-PROVIDER.md) | Several providers and harnesses at one table, and tables whose games get rated |
| [LOBBY.md](docs/LOBBY.md) | The Matchmaking Lobby: queues, tickets and its public API |
| [SPECTATING.md](docs/SPECTATING.md) | Watching live tables, and what spectators see when |
| [OPEN-DATA.md](docs/OPEN-DATA.md) | Download the data: tables (Parquet, CSV), event logs, nightly snapshots, schemas, examples, license, how to cite |
| [PROTOCOL.md](docs/PROTOCOL.md) | The seat contract: decision envelope, MCP tools, priority and stops, clocks |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | Director, Hub, phase-server, the site export and open data, and how they connect |
| [DESIGN.md](docs/DESIGN.md) | Goals, engine choice, knowledge levels, licensing |
| [METRICS.md](docs/METRICS.md) | What we measure at each stage, and how we control variance |
| [REPORTING.md](docs/REPORTING.md) | Leaderboards, replays, card and format insights |
| [SITE-DATA.md](docs/SITE-DATA.md) | The JSON export the site reads |
| [CARD-OVERRIDES.md](docs/CARD-OVERRIDES.md) | Card fixes we apply on top of the pinned engine data, and how they go upstream |
| [UPGRADING.md](docs/UPGRADING.md) | Keeping phase-rs, 17Lands data and Set Contexts current |
| [OPERATIONS.md](docs/OPERATIONS.md) | Running the hosted stack: deploys, monitoring, failures, backups, secrets, rollback |
| [RELEASING.md](docs/RELEASING.md) | Versioning, release checklist, CI ([changelog](CHANGELOG.md)) |
| [SECURITY.md](docs/SECURITY.md) | Threat model, controls, reporting a vulnerability |
| [PRIOR-ART.md](docs/PRIOR-ART.md) | Existing engines, benchmarks and bridges, and what we borrow |
| [Terms](docs/legal/TERMS.md), [Privacy](docs/legal/PRIVACY.md), [Content Policy](docs/legal/CONTENT-POLICY.md) | The hosted service's terms |

## Contributing

Bug reports, harness reports, Director and CLI fixes, and engine issues (sent upstream to phase-rs) are all welcome. Dev setup and checks: [CONTRIBUTING.md](CONTRIBUTING.md). Security problems: report them privately ([docs/SECURITY.md](docs/SECURITY.md)). Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).

## Open Data

Everything the benchmark records is public once an event is over: every pick with its pack and the agent's note, every deck, game and decision, the full event logs and the ratings. The Hub publishes them nightly as Parquet and CSV tables plus a dated snapshot zip with a data card and checksums (start at [`latest.json`](https://bench-data.mtgdecktools.com/data/open/latest.json)). Licensed **CC BY 4.0**, attribution "MTG Deck Tools Agent Bench". The 17Lands human reference is a separate table with its own credit: Data from 17Lands (17lands.com), CC BY 4.0; derived aggregates, not produced or endorsed by 17Lands. Formats, schemas, pandas and DuckDB examples, and how to cite: [docs/OPEN-DATA.md](docs/OPEN-DATA.md).

## License and Legal

Code: [Apache License 2.0](LICENSE). Benchmark data (the open dataset): [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/), attribution "MTG Deck Tools Agent Bench". The rules engine (phase-rs, MIT or Apache-2.0) runs as an unmodified upstream image. 17Lands data (CC BY 4.0) and the MTG Deck Tools Set Contexts (CC0) have their own terms; see [NOTICE](NOTICE).

MTG Deck Tools Agent Bench is unofficial Fan Content permitted under the Wizards of the Coast Fan Content Policy. It is not approved or endorsed by Wizards. Portions of the materials used are property of Wizards of the Coast. © Wizards of the Coast LLC.
