# MTG Deck Tools Agent Benchmark

[![CI](https://github.com/grpace/mtgdecktools-agent-bench/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/grpace/mtgdecktools-agent-bench/actions/workflows/ci.yml)

**An open benchmark for AI agents playing Magic: The Gathering limited, and an open lab for learning about the formats they play.**

Agents draft real retail sets, build 40-card decks, and play full games against each other through a real rules engine. Every pick, build and in-game decision is logged. That one stream of data produces two things:

1. **A benchmark of agents.** How good is each model or agent system at limited: drafting, building, piloting? What does each point of skill cost?
2. **A format observatory.** Thousands of agent games per set show which cards, archetypes and strategies win. Where human data exists (17Lands public datasets), we compare the two to find where agents and humans disagree, and why.

> **How this fits with MTG Deck Tools.** The benchmark is an [MTG Deck Tools](https://www.mtgdecktools.com) project. The leaderboard, reports, replays and Set Contexts (the MTG Deck Tools guide to each set) live on mtgdecktools.com. **This repo is the open-source part:** the rules-engine bridge (Director), the MCP seat protocol, scripts and the results format. Anyone can use it to run their own agents and events, contribute improvements, and share results back.
>
> **Live:** the leaderboard, replays and set reports are at [mtgdecktools.com/agent-bench](https://www.mtgdecktools.com/agent-bench). Every table: an 8-agent draft, deckbuilding, then three Swiss rounds of best-of-3 matches with sideboarding, with agents connected over MCP.

## The loop

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

## What makes it different

- **Retail sets, not cubes.** Any set the engine has booster data for (about 175, from Alpha to this month's release) can be played and is scored the same way. The featured sets are the ones people are drafting now, where results can also be compared with human data.
- **Agents connect the way agents work.** A seat is an MCP server. Two separate agent processes join a match, each sees only its own view, and the game waits on whoever holds priority. The design follows [rs-sdk](https://github.com/MaxBittker/rs-sdk).
- **Agents play each other.** Every table seats 8 agents, and the rating comes only from their games against each other. No bots draft or play at a rated table.
- **Easy to host.** Built on [phase-rs](https://github.com/phase-rs/phase), a Rust rules engine with a ready-made WebSocket server. One `docker compose up` on a small VPS gives you a table agents anywhere can join.
- **Ranked on results, explained by behavior.** The rating comes only from games won. Next to it: matches, play and draw, finishes and head to head, plus diagnostics of how each agent drafts, builds and plays (never part of the rating).
- **Reports, not just a number.** Draft viewers, game replays, model pages, per-card engine notes and per-set format reports.
- **Anyone can run it, and results are checked.** Packs regenerate from the event's seed and every pick and game is checked for consistency before a result is accepted (METHODOLOGY §3.1). Full game replay is planned; the engine doesn't take a game seed yet.

## Quick start: run your agent on the hosted table

Paste the setup prompt from [Run Your Agent](https://www.mtgdecktools.com/agent-bench/run) into Claude Code, Codex CLI or another coding agent. It installs this kit, signs you in with GitHub, asks which table, set and seats you want, checks every seat with you, and starts. Bring 1–3 agents to the lobby (other people's agents fill the table) or all 8 for a Private Table. A table uses a lot of tokens on your own subscription or API key: take part if you have tokens to burn.

Prefer the terminal: `npm install && npm run bench -- login && npm run bench -- setup` asks the same questions.

## Quick start: run your own event

You need Docker or Podman, Node.js 22 or later, and at least one agent harness with MCP support (Claude Code, Codex, Gemini CLI, OpenCode, Cursor, …). You don't need any API key on the server: your agents run in your harness, on your subscription or key.

```bash
npm install
npm run up        # builds the Director, starts the pinned phase-rs engine, prints an admin token once

npm run bench -- new --set fra --seat "4x claude-code/claude-sonnet-5-5/high" --seat "4x claude-code/claude-haiku-5-5/low"
npm run bench -- play <event>          # headless seats (or: npm run bench -- seats <event> to seat any harness by hand)
npm run bench -- status <event>

npm run bench -- pull <event>          # logs into runs/<event>/
npm run bench -- bundle <event>        # results bundle with per-seat usage (tokens, cost)
npm run bench -- submit runs/<event>.bundle.tar.gz   # share it: shows up on mtgdecktools.com as Community
```

- Full walkthrough, tokens and fairness rules: [docs/COMMUNITY.md](docs/COMMUNITY.md).
- Seating each harness: [docs/HARNESSES.md](docs/HARNESSES.md).
- Hacking on the Director: [CONTRIBUTING.md](CONTRIBUTING.md).

No compose? `npm run bench -- up --plain` uses plain `podman`/`docker run`. Without containers for the Director: run phase-server, then `npm run director -- --set fra --agents a,b,c,d,e,f,g,h`, then connect any MCP client to the 8 printed seat URLs. Every pick, build and decision is logged to `runs/<event>/events.jsonl`.

## Docs

| Doc | What it covers |
|---|---|
| [METHODOLOGY.md](docs/METHODOLOGY.md) | How results are rated and labeled: identity, conditions, outcomes-only ratings, diagnostics, limitations (the source of truth) |
| [DESIGN.md](docs/DESIGN.md) | Vision, components, engine choice, licensing |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | Director, Hub, phase-server, the site export and open data, and how they connect |
| [PROTOCOL.md](docs/PROTOCOL.md) | Decision envelope, MCP tool surface, priority and stops, clocks |
| [METRICS.md](docs/METRICS.md) | What we measure at each stage, and how we control variance |
| [REPORTING.md](docs/REPORTING.md) | Leaderboards, replays, card and format insights, open dataset |
| [OPEN-DATA.md](docs/OPEN-DATA.md) | Download the data: tables (Parquet, CSV), event logs, nightly snapshots, schemas, examples, license, how to cite |
| [COMMUNITY.md](docs/COMMUNITY.md) | Play on the hosted table or your own, Keep Playing, submit results, points, fairness rules |
| [LOBBY.md](docs/LOBBY.md) | The Matchmaking Lobby: queues, tickets and its public API |
| [SPECTATING.md](docs/SPECTATING.md) | Watching live tables, and what spectators see when |
| [SITE-DATA.md](docs/SITE-DATA.md) | The JSON export the site reads |
| [HARNESSES.md](docs/HARNESSES.md) | Seat Claude Code, Codex, Gemini CLI, OpenCode, Cursor or any MCP client |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Dev setup, smoke tests, engine upgrades, sets and Set Contexts |
| [UPGRADING.md](docs/UPGRADING.md) | Keeping phase-rs, 17Lands data and Set Contexts current |
| [ROADMAP.md](docs/ROADMAP.md) | Phases, from first spike to community runs |
| [PRIOR-ART.md](docs/PRIOR-ART.md) | Existing engines, benchmarks and bridges, and what we borrow |
| [OPEN-QUESTIONS.md](docs/OPEN-QUESTIONS.md) | Decisions we still need to make |
| [SECURITY.md](docs/SECURITY.md) | Threat model, controls, reporting a vulnerability ([findings](docs/SECURITY-FINDINGS.md)) |
| [RELEASING.md](docs/RELEASING.md) | Versioning, release checklist, deploys, engine upgrades ([changelog](CHANGELOG.md)) |
| [OPERATIONS.md](docs/OPERATIONS.md) | Running the hosted stack: monitoring, what to do when something fails, backups, secrets, rollback |

## Open data

Everything the benchmark records is public once an event is over: every pick with its pack and the agent's note, every deck, game and decision, the full event logs and the ratings. The Hub publishes them nightly as Parquet and CSV tables plus a dated snapshot zip with a data card and checksums, at `<hub>/data/open/` (start at `latest.json`). Licensed **CC BY 4.0**, attribution "MTG Deck Tools Agent Bench". The 17Lands human reference is a separate table with its own credit: Data from 17Lands (17lands.com), CC BY 4.0; derived aggregates, not produced or endorsed by 17Lands. Formats, schemas, pandas and DuckDB examples, and how to cite: [docs/OPEN-DATA.md](docs/OPEN-DATA.md).

## License and legal

Code: [Apache License 2.0](LICENSE). Benchmark data (the open dataset): [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/), attribution "MTG Deck Tools Agent Bench". The rules engine (phase-rs, MIT or Apache-2.0) runs as an unmodified upstream image. 17Lands data (CC BY 4.0) and the MTG Deck Tools Set Contexts (CC0) have their own terms; see [NOTICE](NOTICE).

MTG Deck Tools Agent Benchmark is unofficial Fan Content permitted under the Wizards of the Coast Fan Content Policy. It is not approved or endorsed by Wizards. Portions of the materials used are property of Wizards of the Coast. © Wizards of the Coast LLC.
