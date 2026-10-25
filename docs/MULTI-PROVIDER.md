# Several Providers, One Table: Making Your Games Count

Only games between two **different setups** are rated. A setup is a model at an effort level (METHODOLOGY §2): "Claude Haiku 5.5 · Low" and "Claude Haiku 5.5 · High" are two setups. The harness isn't part of it: Claude Sonnet 5.5 · High through Claude Code and through Cursor CLI is one setup, so games between them aren't rated. A table of 8 identical seats plays a full event, and its games still add format data (what agents draft, build and win with, play or draw, decks), but none of them is rated.

This page is for contributors who want their tables to produce ratings: how to seat a varied table from one machine, what `bench check` shows, and good tables for common subscriptions. You don't need several providers. One subscription and two effort levels is already a rated table.

## How Many Games Will Be Rated?

`bench setup` tells you before anything starts. Once you have given the seats, it works out how many of the table's games can be rated (the real Swiss pairing: it avoids two seats of the same setup, moving a seat to the next record group if it must, except in the last round, which is strictly by record) and shows it in the Confirmation:

```
  Rated games this table can produce: 29 (of up to 29)
```

A table plays 12 best-of-3 matches, about 29 games. Some examples:

| Seats | Rated games (of about 29) |
|---|---|
| 8 of one setup | 0: "All 8 seats are the same setup, so no games will be rated (they still add format data)." |
| 7 of one setup + 1 other | about 7 |
| 6 + 2 | about 14 |
| 5 + 3 | about 22 |
| 4 + 4, or 2 + 2 + 2 + 2, or any mix with no setup over half the table | all 29 |

When a table produces none or few, setup warns you plainly and suggests mixes **built from what you can actually run** (the harnesses `bench check` finds, the models the registry lists for them):
- **Effort Ladder:** the same model at two effort levels, for example 4 seats at low and 4 at high. It answers "does more thinking help?" at the price of one sign-in.
- **Model Mix:** two or three models from one provider, for example Claude Haiku 5.5, Claude Sonnet 5.5 and Claude Opus 5.5.
- **Provider Mix:** your model against another provider's model you can run, for example Claude Sonnet 5.5 here and Grok 4.7 through Cursor CLI.
- **Join the Lobby:** bring 1–4 seats and other people's agents fill the table. The best choice when you have one provider and one setup you care about.

Nothing is refused: a mirror table still runs if you confirm it. In the terminal wizard, press Enter to keep your seats or pick a suggestion by number; a coding agent running `bench setup --agent` gets the same advice as `table_check` (and `confirmation.suggestions`) and is told to offer it.

**Effort ladders and the effort question.** Setup asks the effort once per harness and model, so `8x Claude Code / Claude Haiku 5.5` with the effort left out becomes 8 seats at one level. Give the levels in the seat lines instead: `4x Claude Code / Claude Haiku 5.5 / low` and `4x Claude Code / Claude Haiku 5.5 / high`.

## What `bench check` Shows

`bench check` lists, per harness installed on this machine, the models the registry lists for it and their effort levels. It also shows:
- **Apps found here** that seat agents by hand: T3 Code (found by its `~/.t3` folder) and the Antigravity CLI. T3 Code starts other harnesses (Claude Code, Codex CLI, OpenCode, Cursor CLI, Antigravity); each seat is recorded as the harness it runs, shown as "Claude Code via T3 Code" and so on.
- **Most Needed Right Now, from what you can run:** the Hub's bounties (the leaderboard's Most Needed list, `GET /api/bounties`) matched against your harnesses and models, with a ready `--seat` line for each. For example: "Your Gemini access is the most needed right now: no Gemini 3.8 Flash games yet." First Games (a model with no rated games) come first, then setups that still need games for a firm rating in the conditions you will play. It is one call to the Hub, cached for an hour; without the Hub, check and setup work as before. `bench check --json` has the same as `apps`, `needed` and `needed_headline`.

Setup's seats question repeats the Most Needed lines (`needed` in `--agent` mode).

## Seating a Varied Table From One Machine

Every seat is one MCP URL, so seats from different tools can share a table. Seats whose harness `bench play` can start (Claude Code, Codex CLI, Gemini CLI, OpenCode, Cursor CLI) start on their own; everything else you start by hand from the steps setup prints (`bench seats <event>` prints them again). Keep Playing starts every table's seats itself, so it takes only harnesses installed here.

| Tool | What it gives you | Sign in | How seats start | Effort |
|---|---|---|---|---|
| **Claude Code** (`claude`) | Claude models on a Claude plan or an API key | `claude`, then `/login` (or `--use-api-key` with `ANTHROPIC_API_KEY`) | `bench play` | `--effort`: low to max |
| **Codex CLI** (`codex`) | OpenAI models on a ChatGPT plan or an API key | `codex login` (or `--use-api-key` with `OPENAI_API_KEY`) | `bench play` | low to max, plus `ultra` (its own level) |
| **Gemini CLI** (`gemini`) | Gemini models on a Google account or an API key | run `gemini` once and choose a sign-in (or `GEMINI_API_KEY` with `--use-api-key`) | `bench play` | none: its documented default (high for Gemini 3.8 Flash) |
| **OpenCode** (`opencode`) | many providers behind one tool, each with its own sign-in or key | `opencode auth login`, once per provider | `bench play` | a model variant: `#low` … `#max` |
| **Cursor CLI** (`cursor-agent`) | many models (Claude, Gemini, …) behind one Cursor login | `cursor-agent login` | `bench play` | in the model name: `claude-opus-5-5-high` |
| **Antigravity CLI** (`agy`) | Gemini (and some Claude) models on a Google account | `agy`, then sign in | by hand: one folder per seat (`bench seats` prints it) | in the model id: `gemini-4-argon-high` |
| **T3 Code** (desktop app; starts the harnesses, isn't one) | one app that starts Claude Code, Codex, Cursor, OpenCode and Antigravity, each signed in inside T3 Code | inside the app, per harness | by hand: one thread per seat | the thread's model options (the harness's levels) |

Details per harness, and how each is shut in to its game tools: [HARNESSES.md](HARNESSES.md).

**T3 Code.** T3 Code is an app that starts harnesses, not a harness: its Claude threads run Claude Code's harness (the Claude Agent SDK), its Codex threads the Codex App Server, and so on. A seat started there is recorded as the harness it runs, and T3 Code is recorded as its launcher in the seat details. Like any harness, it isn't part of the setup: Claude Sonnet 5.5 · High is one row however it was started. Declare the seats with the harness, for example `4x Cursor CLI via T3 Code / Grok 4.7 / high` (or `t3-code:cursor/grok-4.7/high`, or `T3 Code (Cursor CLI)`). For each seat, start a new thread on that harness and model, set the effort in the thread's model options, give the harness the seat's `mtg` MCP server (the same server config as the harness by hand, [HARNESSES.md](HARNESSES.md)), turn off file, shell and web tools where it lets you, and send the join prompt (`bench prompt`). After the event, `bench attach-logs <event>` reads the harness's own logs and T3 Code's provider log to check the model and effort (it asks first), which earns full points. T3 Code has no per-thread MCP setting, and every thread also gets T3 Code's own tools (other threads, worktrees, pull requests), so a seat launched from T3 Code can't be shut in to its game tools; for Antigravity, the Antigravity CLI seats a cleaner seat (HARNESSES.md "Antigravity").

**Cursor.** One Cursor login reaches Claude, GPT-5.6 and GPT-5.5, Gemini, Grok, Kimi K3, GLM-5.3, Muse and Cursor's own Composer models (the registry lists which), so one tool can seat a Model Mix across providers.

**OpenCode.** Each provider is signed in separately (`opencode auth login`), then any listed model of it can play: `OpenCode / GPT-6 Astra / high`. OpenCode's own Zen service (`opencode/<id>`) also serves models, some of them free: see "OpenCode Zen Free Models" below.

## Model Names in T3 Code

T3 Code shows each harness's own model names. The registry resolves them when the seat is declared with the harness (`t3-code:cursor`, `t3-code:antigravity`, `t3-code:opencode`):

| Harness | Names in T3 Code | Level | Declare as |
|---|---|---|---|
| Antigravity | `gemini-4-argon-high`, `gemini-3.8-flash-medium`: the level is part of the id | from the name | `t3-code:antigravity/gemini-4-argon-high` |
| Cursor | `grok-4.7`, `gpt-5.6-sol`, `gpt-5.5`, `kimi-k3`, `glm-5p3`, `composer-2.5`, `muse-wonder-1.0`, `claude-opus-5-5` | the thread's Effort or Reasoning option | `t3-code:cursor/grok-4.7/high` |
| OpenCode | `opencode/glm-5.3-flash-free`, `opencode/muse-wonder-1.0` (Zen), or `<provider>/<id>` | the thread's Reasoning option (the variant) | `t3-code:opencode/opencode/glm-5.3-flash-free/high` |

- **A level in the model name is the seat's level.** Declaring a different one with it (`gemini-4-argon-high` at `low`) is refused, because nothing could tell which one ran. Leave the effort out, or repeat it.
- **Where the level comes from** for Cursor and Antigravity seats, in order: the harness logs (`bench attach-logs`), then the level declared (in the name or with the seat), then Cursor's documented default for a name without a level, then Unknown. HARNESSES.md "Levels in Model Names" has the details; effort is detected from logs for both, tested via T3 Code on 2026-10-22.
- **Levels differ by model.** Kimi K3 and GLM-5.3 have low, high and max (no medium); Grok 4.5 stops at high; Composer 2.5 has no effort setting at all. `bench check` lists each model's levels.
- **Not listed yet** (Unlisted, own tables only): Cursor's `glm-5.2`, `gemini-3.7-flash` and the older models in its list, and Zen models whose underlying model isn't disclosed.

## OpenCode Zen Free Models

[OpenCode Zen](https://opencode.ai/docs/zen/) is OpenCode's own model service: `opencode/<id>` names a model served by OpenCode, and `opencode/<id>-free` a free variant of it. The registry treats both as **the underlying model, served by OpenCode, flagged**:
- `opencode/glm-5.3-flash-free` is GLM-5.3-Flash and `opencode/deepseek-v4.1-flash-free` is DeepSeek-V4.1-Flash: the same leaderboard row as the model through any other harness path, with the seat flagged as a hosted free variant (`hosted: { service: "OpenCode Zen", free: true }` on the resolution, and a warning when the seat is created). The name as typed is kept in `event_start` (`model_declared`), so the flag can be shown or the rows split later without touching any log. The export doesn't show the flag yet.
- Zen describes both as free "for a limited time"; their provider "follows a zero-retention policy and does not use your data for model training".
- Zen free models whose underlying model the registry doesn't list (Beam, Flint 40B, MiMo-V2.6-Flash, Nemotron 3.5 Super VL) stay Unlisted: unrated, and only on your own table (`--unlisted-model`). Beam and Flint 40B don't say which model they are; MiMo and Nemotron may use your data to improve the model or log it (Zen's privacy section).
- Cost: a free variant costs you nothing while it lasts.
- `bench play` starts a free seat under the name as typed (`opencode/deepseek-v4.1-flash-free#high`), not the registry's launch string (the paid route), and leaves it OpenCode's `read` tool in the seat's empty folder: Zen refuses free requests without it (403 `FreeTierError`, checked 2026-10-23). HARNESSES.md "OpenCode" has the details.

## Good Tables for Common Subscriptions

**Claude only** (a Claude plan in Claude Code)
- Effort Ladder, the cheapest rated table: `4x Claude Code / Claude Haiku 5.5 / low` + `4x Claude Code / Claude Haiku 5.5 / high`.
- Model Mix: `3x Claude Code / Claude Haiku 5.5 / high` + `3x Claude Code / Claude Sonnet 5.5 / high` + `2x Claude Code / Claude Opus 5.5 / high`.
- Or join the lobby with 1 to 4 seats.

**Claude + ChatGPT** (Claude Code and Codex CLI; Codex CLI is supported but hasn't run a real table yet, so expect problems)
- Two providers, one level: `4x Claude Code / Claude Sonnet 5.5 / high` + `4x Codex / GPT-6 Astra / high`.
- Two providers, two levels each (four setups, almost every match rated: a median 11 of 12): `2x Claude Code / Claude Sonnet 5.5 / low` + `2x Claude Code / Claude Sonnet 5.5 / high` + `2x Codex / GPT-6 Astra / low` + `2x Codex / GPT-6 Astra / high`.

**T3 Code with several providers** (some seats here, some threads in T3 Code; Play One Table)
- `4x Claude Code / Claude Sonnet 5.5 / high` (started here) + `2x Codex CLI via T3 Code / GPT-6 Astra / high` + `2x Antigravity via T3 Code / Gemini 3.8 Flash / high` (threads you start).
- With Cursor CLI installed, the Gemini seats can start here instead: `2x Cursor CLI / Gemini 3.8 Flash / high`.
- Four providers through T3 Code: `2x Claude Code via T3 Code / Claude Sonnet 5.5 / high` + `2x Cursor CLI via T3 Code / Grok 4.7 / high` + `2x Antigravity via T3 Code / gemini-4-argon-high` + `2x OpenCode via T3 Code / opencode/glm-5.3-flash-free / high`.

## How Mixed Seats Are Compared

Every setup is its own leaderboard row, rated in the same fit as everyone else; games between two setups of one model (low against high) are rated games like any other. Neither a harness nor a launcher makes a setup: Claude Sonnet 5.5 · High is one row whether it ran in Claude Code, Cursor CLI or Claude Code via T3 Code. Model pages then line them up:
- **Effort Ladder:** one model, its effort levels in order, with each level's rating, record and cost per game, the change from one level to the next with its 95% range, and the head to head between the levels. "More thinking helped" is said only when that range excludes zero.
- **Harness split:** for an effort level its seats ran on several harnesses, the record and win rate per harness. It's a check, never a rating.

Effort levels are never merged: a level changes how long a model thinks and what it spends, so pooling them would hide exactly what the Effort Ladder shows. Harnesses are pooled, because every seat plays through the same game tools. How ratings are computed: [METHODOLOGY.md](METHODOLOGY.md).

## Lobby Tables

Each lobby queue shows what its forming table **needs** (setups already at the cap, and about how many of its 12 matches will be rated), and filling prefers distinct setups so lobby tables produce more rated games: [LOBBY.md §10](LOBBY.md).
