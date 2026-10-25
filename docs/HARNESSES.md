# Seating agents: harness guide

Every seat in an event is one MCP server URL: `https://<director>/mcp/<seat-token>`. Any agent harness that can connect to an MCP server over **Streamable HTTP** can play. The Director never calls a model and holds no API keys. Your agent runs in your harness, on your subscription or your API key.

**What a leaderboard entry is:** *model + effort*, e.g. Claude Opus 5.5 · High (`claude-opus-5-5/high`). The harness isn't part of the row, but it decides how the seat is launched and checked, so a seat still declares all three (`claude-code/claude-opus-5-5/high`). Declare them honestly when you create the event. The harness's scaffolding is part of what's measured. A seat can be started on this machine or by hand in another session of the same harness (on another machine, or interactively); either way it is declared as that harness.

## The short version

1. `bench setup` (or your coding agent, with [the setup prompt](../prompts/setup.md)) asks which harness, model and effort plays each seat (or take them as flags: `--seat "4x Claude Code/claude-opus-5-5/high"`), creates the event and starts every seat whose harness is installed on this machine, each at its explicit effort level (the registry's `launchSpec` gives the flag or model string).
2. For any other seat it prints the seat URL and the steps to seat it by hand (`bench seats <event>` prints them again).
3. Each seat's session gets the join prompt, [`prompts/join.md`](../prompts/join.md) (`bench prompt` prints it), unmodified, and plays until a result says `EVENT COMPLETE` (for a seat with no games left, that comes as soon as its own last match ends).

`bench` is `npm run bench --` in a checkout of this repository (see [COMMUNITY.md](COMMUNITY.md)).

**Seating several providers or harnesses at one table** (T3 Code, Cursor, OpenCode and the CLIs side by side), what `bench check` shows, and tables whose games get rated: [MULTI-PROVIDER.md](MULTI-PROVIDER.md). Only games between different setups are rated, and a wrapper app is its own harness: T3 Code (Claude Code) is a different row from Claude Code.

## Supported harnesses

| Harness | Seat id (`--seat` accepts the name too) | How `bench play` starts a seat | Effort |
|---|---|---|---|
| Claude Code | `claude-code` | `claude -p` with an `--mcp-config` file | `--effort <level>` |
| Codex CLI | `codex` | `codex exec --json` with a private `CODEX_HOME` | `-c model_reasoning_effort="<level>"` |
| Gemini CLI | `gemini-cli` | `gemini -p --output-format stream-json` with a private `GEMINI_CLI_HOME` | no setting: its documented default level |
| OpenCode | `opencode` | `opencode run --standalone --format json` with a private config folder | model variant: `--model <provider>/<model>#<level>` |
| Cursor CLI | `cursor` | `cursor-agent -p --output-format stream-json` with a private `HOME` | in the model name: `--model claude-opus-5-5-high` |
| Antigravity CLI | `antigravity` | by hand: `bench seats` prints a folder and an `agy` command per seat ("Antigravity" below) | in the model id: `gemini-4-argon-high` |
| Any other MCP client (Claude Desktop, Cline, Zed, your own) | once listed in `registry/harnesses.json` | by hand (below) | whatever the client calls it |
| A harness started from T3 Code | `t3-code:<harness>`, e.g. `t3-code:claude-code` (ranks as the harness) | by hand: one thread per seat | the harness's levels, in the thread's model options |
| Scripted random player | `script` | `node scripts/mcp-random-agent.mjs <seat-url>` | none |

The `script` harness costs nothing and is there to check a setup end to end. Events where no seat is an LLM are kept off the leaderboard.

Seats are named by the model registry (`registry/models.json`, `registry/harnesses.json`; see `registry/README.md`): display names, ids and known aliases all resolve to one canonical id, and a typo gets a "did you mean". The hosted table and the lobby take listed harnesses and models only; to add one, send a pull request to the registry. Your own table also takes unlisted ones with `--unlisted-model` (unrated).

Model ids may contain slashes (OpenCode's `anthropic/claude-sonnet-5-5`): the harness is the part before the first `/`, and the last part is the effort only when it's an effort word (`none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `default`, `unknown`).

## How headless launch works

`bench play <event>` (which `bench setup` runs in the background) starts one session per seat:
- in a **fresh empty temp directory outside any git repository**, so project instruction files (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`) and your files never reach the agent;
- with a **private config folder** next to it that holds only the seat's `mtg` MCP server, so your global config, global MCP servers, plugins, hooks and global instruction files don't load. The seat URL is in that folder, not on the command line, where `ps` would show it. Sign-in files are linked in, not copied, and a refreshed sign-in is copied back when the session ends;
- with the join prompt as its first message;
- with an environment built from an **allowlist**, not a copy of yours: the basics a CLI needs (`PATH`, `HOME`, `USER`, `SHELL`, locale `LANG`/`LC_*`, `TZ`, `TERM`, temp folders, the `XDG_*` folders and `DBUS_SESSION_BUS_ADDRESS` where sign-ins live, proxy and CA settings, the Windows basics) and the variables the harness's sign-in needs (Claude Code: `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_OAUTH_TOKEN`; Gemini CLI: your Google Cloud project). API keys and provider switches pass only with `--use-api-key`, and only the harness's own (Claude Code: `ANTHROPIC_API_KEY`, a gateway, Bedrock or Vertex; Codex: `OPENAI_API_KEY`, `CODEX_API_KEY`; Gemini CLI: `GEMINI_API_KEY`, `GOOGLE_API_KEY`, Vertex; OpenCode: the providers' `*_API_KEY`; Cursor: `CURSOR_API_KEY`). Everything else stays out: the bench's own tokens (`BENCH_*`, `HUB_*`), other tools' tokens, and the variables of the session that runs `bench`. That matters when a coding agent runs it: a Claude Code session's `CLAUDE_EFFORT`, `CLAUDE_CODE_SESSION_ID` or messaging socket would otherwise reach the seat's harness, which reads some of them (scripts/bench/harnesses.ts `seatEnv`).

**What each seat can do.** A seat should have only its `mtg` tools: no shell, no files, no web. Not every harness can be shut in that far, and the setup Confirmation tells you which seats keep something:

| Harness | Isolation | How |
|---|---|---|
| Claude Code | **Full.** No built-in tools. | `--tools ''`, `--strict-mcp-config` with the seat's `--mcp-config` file, `--restricted` (Claude Code 2.1.300 or later: your user, project and local settings, hooks and plugins are left out), `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1`. Checked against `claude --help` 2.1.306 and the [CLI reference](https://code.claude.com/docs/en/cli-reference). |
| OpenCode | **Full.** Every tool except `mtg_*` is denied. | `--standalone` (a private server that honors the seat's environment; the shared background service ignores it), `XDG_CONFIG_HOME` and `OPENCODE_CONFIG` in the seat's folder with `"permission": {"*": "deny", "execute": "allow", "mtg_*": "allow"}`, `OPENCODE_DISABLE_PROJECT_CONFIG=1`, `OPENCODE_DISABLE_CLAUDE_CODE=1`, no `--auto`. OpenCode 2 reaches MCP tools only through its Code Mode tool `execute` (the model writes `await tools.mtg.wait_for_decision()`), and checks every call inside it against the same rules, so OpenCode's own Code Mode tools stay denied. An OpenCode Zen free model also keeps `read`, confined to the seat's empty folder (`external_directory` denied): Zen refuses free requests without it. Sign-in and sessions stay in your data folder. Checked on 2.1.2 in a hosted table (2026-10-23; [permissions](https://opencode.ai/v2/docs/permissions/)). |
| Codex CLI | **Partial.** Shell, web search and image tools are off, but `apply_patch` can't be switched off; the read-only sandbox refuses its writes. **Not yet run on a real Codex install.** | A private `CODEX_HOME` with only `auth.json` (linked) and a `config.toml`: `features.shell_tool = false`, `view_image`, `multi_agent`, `apps`, `plugins` off, `web_search = "disabled"`, `project_doc_max_bytes = 0`, and the `mtg` server with `default_tools_approval_mode = "approve"`. `--sandbox read-only`. From the [Codex docs](https://learn.chatgpt.com/docs/extend/mcp) and source. |
| Gemini CLI | **Partial.** File, shell and web tools are excluded by name, and with no `--approval-mode yolo` anything that asks for approval is refused in headless mode; a built-in tool a later version adds that needs no approval would still be there. **Not yet run on a real Gemini CLI install.** | `GEMINI_CLI_HOME` in the seat's folder (your `~/.gemini` settings, extensions and MCP servers don't load; your sign-in files are linked and your auth choice copied), `tools.exclude`, the `mtg` server with `trust: true`, `--allowed-mcp-server-names mtg`, `-e none`. From the [Gemini CLI docs](https://geminicli.com/docs). |
| Cursor CLI | **Partial.** Shell, writes, reads and web fetch are denied by permission rules, but Cursor can't remove its built-in tools, so they are refused when called rather than gone. | `HOME` in the seat's folder, so only its `~/.cursor/mcp.json` (the `mtg` server) and `cli-config.json` load (deny `Shell(*)`, `Read(**)`, `Write(**)`, `WebFetch(*)`; allow `Mcp(mtg:*)`); `XDG_CONFIG_HOME` stays yours, where the sign-in lives. No `--force`. Checked on 2026.10.19 ([permissions](https://cursor.com/docs/cli/reference/permissions)). On macOS, if the seat reports it isn't signed in, set `CURSOR_API_KEY` and pass `--use-api-key`. |
| Antigravity CLI (by hand) | **Partial.** Only the seat's server is added, from a folder of its own; Antigravity's file, shell and browser tools stay, and it asks before using them. | A workspace plugin with only the `mtg` server (`bench seats <event>` prints the commands; "Antigravity" below). Refuse anything but the `mtg_mtg` tools when it asks. |
| Claude Desktop and other clients; any harness launched from T3 Code | Seated by hand: whatever you set up. | Turn off file, shell and web tools in the client if it lets you. T3 Code also gives every thread its own `t3-code` tools (threads, worktrees, pull requests), which a seat can't be kept from. |

For a seat that must not be able to reach your files at all, run its harness in a container or VM.

**Prompt injection.** Game text (card names and rules text) reaches every agent, and so would anything a hostile Director put in a decision. Other agents' notes and rules reports are never in a seat's text, but they are public in the spectator stream. A seat with only its `mtg` tools has nothing to act on an injection with beyond its own decisions; a seat that keeps tools (above) is exposed through them.

**What runs is your choice, never the Director's.** `bench play` starts each seat with the harness, model and effort you confirmed in setup, or the ones a lobby ticket joined with. A Director that answers with other seats, other harnesses or names that look like paths is refused (docs/SECURITY.md).

Each seat's output goes to `transcript-<seat>.jsonl` in the event's folder and errors to `harness-<seat>.log`. If a session ends before its seat's `EVENT COMPLETE`, `play` starts a new one on the same seat, which picks up where it was (up to `--relaunch`, default 3). `bench play <event> --dry-run` prints the exact commands without running them.

**Fresh sessions (`--fresh-session per-game`, the default).** A harness re-sends its whole conversation on every call, so a seat that keeps one session gets more expensive with every game (on Claude Code most requests of a best-of-1 table were over 100,000 tokens, where Claude Haiku 5.5 costs 5× its base price). So `play` ends each seat's session when its deck is locked and after every game (SIGINT, so the harness writes its usage; see Claude Code below), and starts a fresh one in a new empty folder: each game starts a fresh agent session to keep costs down, and every decision carries the full board and match history. The fresh session gets the resume briefing and the open decision in full; nothing is lost or answered twice (docs/PROTOCOL.md §6). Before its first game decision every session reads the Set Context (at the Set Context levels), and every game decision lists the opponent's cards from earlier games of the match, so a fresh session knows what a long one would. `--fresh-session per-match` (at `bench new`, `bench setup` or `bench lobby join`) starts a fresh session after every match instead; `--fresh-session off` keeps one session for the whole event. It works the same for every harness `play` starts, since each launch is a new session; it has been measured with Claude Code. The policy is recorded with each seat (METHODOLOGY §3) and can't be changed at `play` time. Lobby seats work the same way: `bench lobby join` declares the policy with each seat it will start, the fired table records it, and `play` rotates the sessions (docs/LOBBY.md §3, "Sessions"). Seats you seat by hand keep one session. Scripted test seats keep one too unless `--fresh-session` is given.

## Claude Code

```bash
printf '{"mcpServers":{"mtg":{"type":"http","url":"%s"}}}' '<seat-url>' > "$SEAT_CONFIG/mcp.json"
CLAUDE_CODE_DISABLE_CLAUDE_MDS=1 claude -p "$(cat prompts/join.md)" --model claude-sonnet-5-5 --effort high \
  --mcp-config "$SEAT_CONFIG/mcp.json" --strict-mcp-config --restricted \
  --tools '' \
  --allowedTools 'mcp__mtg__wait_for_decision mcp__mtg__decide mcp__mtg__get_view mcp__mtg__get_card mcp__mtg__get_game_log mcp__mtg__get_set_context mcp__mtg__report_rules_issue' \
  --output-format stream-json --verbose > transcript.jsonl
```

- `--tools ''` removes every built-in tool, so the seat sees only the `mtg` tools.
- The session is kept (no `--no-session-persistence`): its session file is the only place Claude Code logs the effort level. `bench play` (and `scripts/play-claude-seat.sh`) append it to `session-<seat>.jsonl` in the event folder and remove it from `~/.claude/projects`.
- Seats use your Claude login (`CLAUDE_CONFIG_DIR` and `CLAUDE_CODE_OAUTH_TOKEN` pass through); `ANTHROPIC_API_KEY` doesn't reach them. Pass `--use-api-key` to bill an API key (or a gateway, Bedrock or Vertex) instead.
- Usage and cost come from the `result` line each session writes at its end (`total_cost_usd` is the API list-price equivalent, even on a subscription), summed over the seat's sessions. A session `play` ends (a fresh session per game, a seat done on the Director) gets SIGINT first, which makes Claude Code write that line and exit; SIGTERM follows after 10 seconds and SIGKILL 15 seconds later only if it is still running. A session that still ended without one (killed, crashed) counts the final per-request usage from its session record (`session-<seat>.jsonl`: the stream's own message lines carry placeholder output counts). The cost is `reported` only when every session reported it; otherwise the seat is priced request by request at list price and labeled an estimate.
- By hand: `claude mcp add --transport http mtg <seat-url>` in an empty directory, start `claude`, paste the join prompt.

## Codex CLI

`bench play` gives the seat its own `CODEX_HOME` (see "What each seat can do"; `bench play <event> --dry-run` prints the files):

```bash
CODEX_HOME="$SEAT_CONFIG/codex" codex exec --json --skip-git-repo-check --sandbox read-only -m gpt-6-astra \
  -c 'model_reasoning_effort="medium"' "$(cat prompts/join.md)" > transcript.jsonl
```

By hand, in `~/.codex/config.toml`:

```toml
[mcp_servers.mtg]
url = "<seat-url>"
tool_timeout_sec = 120
```

`wait_for_decision` can block for about 40 s, so keep `tool_timeout_sec` above 60. Usage comes from `turn.completed` events; Codex doesn't report cost.

## Gemini CLI

`.gemini/settings.json` in the seat's working directory (or `~/.gemini/settings.json`):

```json
{ "mcpServers": { "mtg": { "httpUrl": "<seat-url>", "trust": true, "timeout": 120000 } } }
```

```bash
GEMINI_CLI_HOME="$SEAT_CONFIG/gemini" gemini -p "$(cat prompts/join.md)" -m gemini-3.8-flash --output-format stream-json \
  --allowed-mcp-server-names mtg -e none > transcript.jsonl
```

`bench play` writes that settings file in the seat's own `GEMINI_CLI_HOME`, with the built-in file, shell and web tools excluded, and doesn't use `--approval-mode yolo`. Gemini CLI has no effort setting, so the seat is logged at `default` and its leaderboard row shows Gemini CLI's documented default for the model (high for Gemini 3.8 Flash), or Unknown where none is documented.

## OpenCode

```bash
# $SEAT_CONFIG/opencode.json: {"mcp":{"mtg":{"type":"remote","url":"<seat-url>","enabled":true}},"permission":{"*":"deny","mtg_*":"allow"}}
XDG_CONFIG_HOME="$SEAT_CONFIG/config" OPENCODE_CONFIG="$SEAT_CONFIG/opencode.json" OPENCODE_DISABLE_PROJECT_CONFIG=1 \
  opencode run --standalone --format json --model anthropic/claude-sonnet-5-5#high "$(cat prompts/join.md)" > transcript.jsonl
```

`--standalone` keeps the seat's config private to this session (without it, `opencode` talks to the shared background service, which never sees it). Effort is a model variant (`#high`). Usage comes from `step_finish` parts; the model and its variant from OpenCode's session record (2.x's json events don't name the model).

- **Code Mode (OpenCode 2).** MCP tools are called from inside the `execute` tool (`await tools.mtg.decide({...})`), so `execute` is allowed and one step can make several `mtg` calls. A server's tools join the catalog after the session's first step, so a seat's first `wait_for_decision` usually fails with "Unknown tool" and the second works (seen on 2.1.2). `"codemode": false` on the server gives no direct tools in 2.1.2.
- **OpenCode Zen free models** (`opencode/<id>-free`) start under the name as typed (`--model opencode/deepseek-v4.1-flash-free#high`; the registry's launch string would be the paid route), and keep the `read` tool in the seat's empty folder: without it Zen answers 403 `FreeTierError` ("can only be used from within OpenCode").

## Cursor CLI

`bench play` gives the seat its own `HOME`, whose `.cursor/mcp.json` holds only the seat's server:

```json
{ "mcpServers": { "mtg": { "url": "<seat-url>" } } }
```

```bash
XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}" HOME="$SEAT_CONFIG/home" cursor-agent -p --output-format stream-json --approve-mcps --trust --workspace . \
  --model claude-opus-5-5-high "$(cat prompts/join.md)" > transcript.jsonl
```

(`XDG_CONFIG_HOME` stays your real one, so it is set before `HOME`: Cursor keeps its sign-in there.) `bench play` also writes `cli-config.json` there and `.cursor/cli.json` in the working directory, which deny shell, reads, writes and web fetch and allow only `Mcp(mtg:*)`. With only the seat's server in that `HOME`, `--approve-mcps` approves just `mtg`.

## Antigravity (by hand)

`bench play` doesn't start Antigravity seats yet; you seat each one in the Antigravity CLI (`agy`, 1.4 or later), signed in to your Google account. The CLI reads MCP servers from its global config (`~/.gemini/config/mcp_config.json`, shared by every session) or from plugins, and a folder's `.agents/plugins/<name>/` is a plugin for sessions started in that folder. So each seat gets a folder of its own holding only its server, and your global config isn't touched. `bench seats <event>` prints the commands for each Antigravity seat:

```bash
mkdir -p ~/mtgdt-seats/seat-1a2b3c/.agents/plugins/mtg && cd ~/mtgdt-seats/seat-1a2b3c
printf '%s\n' '{"name":"mtg"}' > .agents/plugins/mtg/plugin.json
printf '%s\n' '{"mcpServers":{"mtg":{"url":"<seat-url>"}}}' > .agents/plugins/mtg/mcp_config.json
agy --model 'gemini-4-argon-high'
```

- Trust the folder when asked, then paste the join prompt (`bench prompt`). `/mcp` shows the server as `mtg_mtg` (plugin servers are always named `<plugin>_<server>`) with the seat's tools; checked on agy 1.4.5 (2026-10-23).
- The level is part of the model id (`agy models` lists them: `gemini-3.8-flash-high`, `gemini-4-argon-high`). Don't add `--effort`.
- If agy asks to allow a tool, allow the `mtg_mtg` tools (for the session, if it offers that) and refuse anything else. Never start a seat with `--dangerously-skip-permissions`: it approves shell and file tools too.
- A seat seated by hand keeps one session for the whole event, which costs several times a fresh session per game (Expected usage, below). If the session stops (context limit, crash), start `agy` again in the same folder with the same prompt; the seat picks up where it was.
- Afterwards, `bench attach-logs <event>` looks for the session in `~/.gemini/antigravity-cli/conversations/` (standalone: not yet checked on a real event) and T3 Code's Antigravity profile.

**Launched from T3 Code instead.** The seat is still harness Antigravity (T3 Code only launches it), but seating it there is harder to keep clean. T3 Code has no per-thread MCP setting. Its Antigravity threads run with their own Antigravity home (`~/.t3/userdata/providers/antigravity/<hash>/`): a server in its `config/mcp_config.json` reaches every Antigravity thread (and T3 Code then turns off Antigravity for commit messages and titles), while the plugin folder above, opened as the thread's project, should reach only that thread (the same Antigravity runtime; not yet checked through T3 Code). Every T3 Code thread also gets T3 Code's own `t3-code` tools (start and message other threads, worktrees, pull requests, previews), which a seat can't be kept from. `bench attach-logs` reads T3 Code's Antigravity conversations too.

## Any other MCP client, by hand

1. Add a Streamable HTTP MCP server named **`mtg`** with the seat URL. The URL is the only credential; there's no auth header.
2. Start a **new** session and send the join prompt (`bench prompt`) as the first message.
3. Allow the `mtg` tools without per-call approval (otherwise you'll approve a few hundred calls), and turn off file, shell and web tools if your client lets you.
4. If the session stops early (context limit, crash), start a fresh one on the same seat URL with the same prompt. Seats are durable: the next `wait_for_decision` picks up where the seat is. Mention the restart when you submit.

To look at a seat without an LLM, run `node scripts/peek-seat.mjs <seat-url>`. It shows the current decision.

## Which model played: usage and verification

The leaderboard checks each seat's declared model against its harness usage (METHODOLOGY §2.1; how each harness reports its model is in `registry/harnesses.json → reports`):

| Harness | Reports its model | Verification |
|---|---|---|
| Claude Code | `system/init` model, every message's model, and per-model tokens in the final `result` line | Checked Against Logs. Its background Haiku is a helper model and doesn't count. |
| Codex CLI | not in `codex exec --json` | Self-Reported |
| Gemini CLI | `init` model; per-model stats where present | Checked Against Logs when reported |
| OpenCode | provider/model on each step | Checked Against Logs |
| Cursor CLI | a display name in the `system` init line (`GPT-5.6 Luna 272K Low`: the model, its context size and the level); the SDK store's `modelName` | Checked Against Logs when the registry knows the name (the context size is dropped) |
| Antigravity | the model id with its level in the conversation DB (`gemini-4-argon-high`) | Checked Against Logs (via `bench attach-logs`) |

Transcripts never leave your machine. On the hosted table, `bench play` sends the Hub a usage summary for the seats it started once the event ends (`bench attach-logs` does it for seats you started by hand), and those seats are checked like the rows above. A hosted seat whose summary is never sent, or whose harness doesn't report its model, is Self-Reported. Self-Reported seats are rated and labeled.

## Effort: how it's set, detected and defaulted

Effort is part of a leaderboard row, so every seat needs a concrete level (METHODOLOGY §2.2). `bench play` always starts a seat with an explicit level, and the setup interview preselects the recommended one (`high` where the model has it). Data: `registry/harnesses.json` (`effort`, `effort_detection`, `effort_defaults`). "Tested" means checked on real files on the machine and version shown.

| Harness | Set | Detected from | Default when nothing is set |
|---|---|---|---|
| Claude Code | `--effort low\|medium\|high\|xhigh\|max` | Session file `<config dir>/projects/<cwd>/<session>.jsonl`, where the config dir is `$CLAUDE_CONFIG_DIR` or `~/.claude`: `effort` and `version` on every assistant record. **Tested** on 2.1.306, headless and via T3 Code (2026-10-22). Stream-json has no effort field. | Opus, Sonnet and Haiku 5.5: medium. Fable 5.1: high. Settings and `CLAUDE_CODE_EFFORT_LEVEL` override these ([docs](https://code.claude.com/docs/en/model-config#adjust-effort-level)). |
| Codex CLI | `-c model_reasoning_effort="<level>"`, including `ultra` on GPT-6 Astra and GPT-6.1 Sol | Rollout file `$CODEX_HOME/sessions` or `~/.codex/sessions/…/rollout-*.jsonl`: `turn_context.effort`, absent when no level was chosen. **Untested** (from docs and source; Codex isn't installed on our test machine). `bench play` gives Codex a private `CODEX_HOME`, so the seat's rollout is in that folder; the CLI copies it to `rollout-<seat>.jsonl` before removing the folder. | GPT-6 Astra low (≥ 0.153.1), GPT-6.1 Sol low (≥ 0.159.1), GPT-6 Luna medium (≥ 0.156.1), from the bundled catalog; OpenAI's server can replace these. |
| Gemini CLI | No flag. Set in `settings.json` (`modelConfigs`). | Not recorded: neither stream-json nor session files carry the thinking level. | Gemini 3.8 Flash high (≥ 0.62.0). Gemini 3.1 Pro (Preview) high (≥ 0.44.0). Gemini 4 Argon: Unknown. |
| OpenCode | `-m <provider>/<model>#<variant>` | `~/.local/share/opencode/opencode.db`, read from a copy. The `session_v2` table carries model (`id`, `providerID`, `variant`), `version` and tokens; assistant `session_message` rows carry `data.model.variant`. 1.x uses the `session`/`message` tables. **Tested** on 2.1.2, standalone and via T3 Code (2026-10-22). | Not documented, so Unknown. A session without a variant records none. |
| Cursor CLI | Level (and fast mode) in the model name: `claude-opus-5-5-high`, `grok-4.7-xhigh-fast`, `cursor-grok-4.6-low`, `gpt-5.5-extra-high` (`cursor-agent models` lists them) | Stream-json init `model` gives a display name with the level. The cursor-agent SDK store `~/.cursor/projects/<p>/sdk-agent-store/…/store.db` gives `modelName`, e.g. `grok-4.7-xhigh-fast`. **Tested** on 2026.10.01 and via T3 Code (2026-10-22); the names checked against `cursor-agent models` 2026.10.19. Its `agent-transcripts` have no model. | Names without a level, from Cursor's model list: Opus 5.5, GPT-5.6 Sol, Terra and Luna, GPT-5.5 medium; Fable 5.1, Grok 4.6, Grok 4.5, Muse Spark 1.3 high; Kimi K3 max. Grok 4.7, Gemini and Muse Wonder names always carry a level. |
| Antigravity (Google) | Thinking level in the model id: `<model>-low\|medium\|high`, e.g. `gemini-4-argon-high`, `gemini-3.8-flash-medium` (T3 Code's catalog; [docs](https://antigravity.google/docs/models/)) | Conversation DB `<uuid>.db`: `steps` and `gen_metadata` blobs carry the id with its level. **Tested** via T3 Code (`~/.t3/userdata/providers/antigravity/<hash>/antigravity-acp/conversations/`, 2026-10-22). Standalone `~/.gemini/antigravity-cli/conversations/` is untested. | Never needed: every model id carries its level. No default is documented. |
| T3 Code (a launcher, not a harness) | The thread's model options, with the harness's levels. Declare the seat as `t3-code:<harness>`, e.g. `t3-code:claude-code`, shown as "Claude Code via T3 Code"; it ranks as that harness. | The harness's own record (above), plus T3's provider log `~/.t3/userdata/logs/provider/events.<thread>.log`: the model and effort each provider session opened with (`query.open` options.model and options.effort; Cursor `run.start` model params, whose level is `reasoning_effort`, `reasoning` or `effort` depending on the model, and `fast`), and turn usage. Several threads can share a file, so lines are filtered by thread id. **Tested** 2026-10-22 with Claude Code, OpenCode, Cursor and Antigravity. | The harness's default (T3 Code leaves an unset level to the provider). |
| Claude Desktop, Cline, Continue, GitHub Copilot in VS Code, Devin Desktop | In the app (table below) | No documented local record | A level declared for these counts as Set at Launch, verification Self-Reported. Cline's extension and Continue have no levels, so Unknown. |

**Fast mode** (Cursor `-fast`, Claude fast mode) is recorded per seat (`effort_resolution.fast`) but isn't part of the leaderboard row. The Claude API docs describe it as the same model served faster.

**A launcher is not a harness.** T3 Code starts harness sessions (Claude through the Claude Agent SDK, Codex through the Codex App Server, and so on) without running the model loop itself. A seat declared `t3-code:claude-code` is Claude Code on the leaderboard; T3 Code is recorded as its launcher in the seat details. T3 Code gives every session its own `t3-code` MCP tools and adds instructions, which the seat details note (METHODOLOGY §2.2–2.3).

### Levels in Model Names (Antigravity, Cursor, OpenCode)

Some harnesses put the level in the model name: Antigravity always (`gemini-4-argon-high`), the Cursor CLI (`grok-4.7-xhigh`, plus `-fast`), and OpenCode's `#variant`. The registry reads the level off the name for that harness and for T3 Code running it (`t3-code:antigravity`, `t3-code:cursor`, `t3-code:opencode`):
- **Antigravity names resolve generically:** any registry model followed by `-low`, `-medium` or `-high` is that model at that level, so a new Antigravity model needs only its model entry. A level the model doesn't have (`gemini-4-argon-xhigh`) is refused with the names it does have. Without a harness, such a name isn't resolved (`gpt-5.1-codex-max` must never quietly become another model at max); the error says which model and level it reads as and asks for the harness.
- **The level in the name is the seat's level.** A separate effort may repeat it. One that names another level is **refused** at entry (`gemini-4-argon-high` with effort `low`): there's no way to tell which one ran, and the logs record the name. `default`, `unknown` or no effort defer to the name. The lobby counts the name's level as declared.
- **Cursor through T3 Code** takes plain ids (`grok-4.7`, `gpt-5.6-sol`, `glm-5p3`) with the level as a separate model option (`reasoning_effort`, `reasoning` or `effort`, by model; `extra-high` is Extra High).
- **OpenCode Zen:** `opencode/<id>` is OpenCode's own model service. It resolves to the registry model, flagged as hosted; `opencode/<id>-free` is a free variant of it, flagged as free (MULTI-PROVIDER.md "OpenCode Zen Free Models").

**Where a Cursor or Antigravity seat's level comes from,** in order (`resolveSeatEffort`, METHODOLOGY §2.2):
1. **The harness logs** (`bench attach-logs`): the Antigravity conversation DB's model id, the Cursor SDK store's `modelName` or the CLI's init display name, or T3 Code's provider log. A declared level the logs contradict is a Mismatch, and the logs win.
2. **The declared level:** the level in the model name (Antigravity always has one), or the effort given with the seat. Set at Launch for seats `bench play` started or picked in an app seated by hand; Self-Reported otherwise.
3. **The documented default:** Cursor names without a level (table above). Antigravity has none, and never needs one.
4. **Unknown.**

**Finding a hand-seated seat's session:** `bench attach-logs <event> [--seat X]` (it runs `attachHarnessLogs` in `packages/director/src/harness-logs.ts`).
- It scans the stores above for sessions active since the event started. It samples up to 32 lines of decision text that only that seat was shown, spread over the event. A session matches only when it holds at least a quarter of them (3 or more), in the order the seat saw them where the store keeps order, and **none** of another seat's lines or of another event's (nearby events in the same runs folder). A session that also holds other seats' text, such as a coding agent that read `events.jsonl`, is set aside as ambiguous and never merged.
- It writes `runs/<event>/harness-logs-<seat>.json`, readable only by you, with the model, effort, fast mode, harness version and token counts, the sessions set aside (store and reason only), and its provenance. It never stores text, titles or paths, and keeps model ids and versions only when they look like ids, never like paths.
- SQLite stores are read from a private snapshot (`VACUUM INTO` from a read-only connection) under `~/.cache/mtgdt-bench/scan`, removed even on Ctrl-C. Stores over 256 MB are skipped.
- `bench bundle` builds the seat's `usage-<seat>.json` from that file, marked `evidence.kind: "cli-local-logs"`, `self_attested: true`: you read your own machine's logs, so it is evidence you supply, not something the Director observed.
- On a hosted event, `bench attach-logs` sends the same facts to the Hub right away (`POST /api/usage`), as `bench play` does for the seats it started.

**Apps seated by hand** (`seated: "by-hand"` in the registry). None of these writes a documented local record of the model and effort, so a level picked in the app counts as **Set at Launch** with **Self-Reported** verification:

| Client | Picking the model | Picking the effort | Add the seat URL |
|---|---|---|---|
| Claude Desktop | Model menu next to send | Model menu → Effort: Low, Medium, High, Extra high, Max | Custom connector, no sign-in ([docs](https://support.claude.com/en/articles/11175166-getting-started-with-custom-connectors-using-remote-mcp)) |
| T3 Code | Thread model picker | Thread model options (the provider's levels; values not documented) | Not documented (it uses the provider's config) ([repo](https://github.com/pingdotgg/t3code)) |
| Cline | Settings → API Provider → model | Extension: an on/off "Extended Thinking" checkbox only, so Unknown. The CLI takes `--thinking`. | Remote server, transport Streamable HTTP ([docs](https://docs.cline.bot/mcp/configuring-mcp-servers)) |
| Continue | `config.yaml` models | Reasoning on/off plus a token budget, no levels, so Unknown | `config.yaml` with `type: streamable-http`, agent mode ([docs](https://docs.continue.dev/customize/deep-dives/mcp)) |
| GitHub Copilot in VS Code | Chat model picker | Model picker → Thinking Effort: low…max | `.vscode/mcp.json`, `"type": "http"` ([docs](https://code.visualstudio.com/docs/copilot/reference/mcp-configuration)) |
| Devin Desktop (formerly Windsurf) | Model menu below the input | Per-model effort variant (low…xhigh, depending on the model) | `~/.config/devin/mcp_config.json`, `serverUrl` ([docs](https://docs.devin.ai/desktop/cascade/mcp)) |

Seated by hand? Declare the level you set. If you don't know it, choose "I don't know": the seat then gets the documented default for your harness version, or Unknown.

## Tips

- **One session per seat.** Never let one session hold two seats, or two sessions share one.
- **Allow-list the tools.** The agent needs only `wait_for_decision`, `decide`, `get_view`, `get_card`, `get_game_log`, `get_set_context` and `report_rules_issue`. A seat that can read files or browse isn't a fair seat.
- **Keep the prompt unmodified** for leaderboard runs (see [COMMUNITY.md](COMMUNITY.md#fairness-rules)).
- **Long-polls:** `wait_for_decision` returns within about 40 s with a status line when nothing is ready. Harness tool timeouts must be above that.
- **Global instruction files** (for example `~/.claude/CLAUDE.md` or a global `AGENTS.md`) don't load in seats `bench play` starts: each harness gets a private config folder (Claude Code: `CLAUDE_CODE_DISABLE_CLAUDE_MDS`). In a seat you start by hand they do load: keep them neutral, or note them in your submission.
- **If a seat doesn't start,** its `harness-<seat>.log` says why; `bench play <event> --dry-run --seat <seat>` shows the exact command. You can always seat it by hand instead.

## Expected usage

Every match is best of 3 with sideboarding (best of 1 was removed on 2026-10-22). What one game costs was measured on the first two 8-seat hosted tables, which played best of 1 before that decision; the estimate (scripts/bench/estimate.ts) plays 6 to 9 such games per seat and adds the decisions between games.

**With a fresh session per game (the default for seats `bench play` starts): measured per game.** Each game's session starts small (about 30 k tokens on Claude Code: the harness's start, the resume briefing and the Set Context) instead of re-reading every game before it. The second 8-seat hosted table (2026-10-22: SOS, Set Context, manual mana, 3 Swiss rounds of best of 1; 4× Claude Haiku 5.5 · Claude Code · low and 4× medium, a fresh session per game) cost **$5.93** at API list prices, priced request by request with the long-context prices and Claude Code's 1-hour cache writes. The seats finished in 21 minutes and the event ended at 27. Per seat:

| | Low effort (4 seats) | Medium effort (4 seats) |
|---|---|---|
| Requests | 151 to 195 | 183 to 222 |
| Fresh input (cache writes) | 0.39 to 0.63 M | 0.51 to 0.76 M |
| Cache reads | 7.3 to 15 M | 11.6 to 22 M |
| Output | 40 to 63 k | 48 to 62 k |
| Cost | $0.27 to $0.93 ($2.56 in all) | $0.55 to $1.46 ($3.37 in all) |
| Per game played (3 per seat) | about $0.21 | about $0.28 |

The draft and deckbuilding session took 44 to 56 requests, 2.4 to 3.0 M cache reads and $0.08 per seat, as in one long session. Each game's session took 20 to 82 requests and $0.02 to $0.88: a long game's prompt grows from about 30 k to 380 k, and every request over 100 k pays Claude Haiku 5.5's 5× long-context price. **Effort:** medium cost 1.32× low, with about 1.2× the tokens. The estimate uses those factors and extrapolates the higher levels (high 1.75×, xhigh 2.3×, max 3×, rounded up: not measured); the harness default or an unknown level counts as medium.

**Between games (best of 3).** Before every game after a match's first, the loser of the previous game chooses to play or draw (a few hundred tokens) and both seats get the sideboarding decision: their deck and sideboard as card JSON plus the match memory, 15 to 24 k characters (about 5 to 7.5 k tokens). With a fresh session per game it arrives at the start of the next game's session, so every request of that game re-reads it. A seat meets 3 (2-game matches) to 6 (3-game matches) of these. Measured on one seat (2026-10-22, event `2026-10-22-16-57-21-tla-086a`: TLA, Set Context, Claude Haiku 5.5 · Claude Code · low against 7 scripted seats, a fresh session per game): each sideboarding was one request of about 42 k tokens that added about 9 k to the game's session, with 165 to 518 output tokens, under $0.01, and 8 to 9 seconds. The seat played 5 games (5–0) and part of a sixth for **$2.82** at list price before the $2.80 cap stopped it; one 26-turn game reached a 425 k prompt and cost $1.18 on its own. The estimate puts the decisions between games at about 4 to 7% of a seat's cost (11 to 17% for Claude Haiku 5.5, where the added text pushes more requests over the 100 k long-context size).

Tokens per seat with a fresh session per game, at low effort: 0.75 to 1.8 M fresh input, 16 to 54 M cache reads and 67 to 176 k output. Earlier, a 1-seat test (Claude Haiku 5.5 · low against 7 scripted seats, TLA, best of 3 without sideboarding) cost $1.11 for the draft and 4 games with a fresh session per game against $5.05 with one session.

The rest of this section is one session per seat (`--fresh-session off`, seats seated by hand), measured on the first 8-seat table at low effort (multiply by 1.32 for medium).

**Measured per game: a full table.** The first 8-seat hosted table (2026-10-22: TLA, Set Context, manual mana, 3 Swiss rounds of best of 1; 8× Claude Haiku 5.5 · Claude Code · low) took 43 minutes and cost **$56.37** at API list prices. Per seat:

| | Low | High | Mean |
|---|---|---|---|
| Harness calls | 232 | 387 | 303 |
| Fresh input (cache writes) | 0.55 M | 1.13 M | 0.85 M |
| Cache reads | 69 M | 169 M | 124 M |
| Output | 57 k | 100 k | 74 k |
| Cost (Claude Code's own figure) | $3.97 | $9.52 | $7.05 |
| The draft and deckbuilding (about 45 calls) | 2.1 M cache reads, $0.05 | 3.0 M, $0.13 | |
| Waiting after its last match (6 of 8 seats) | 15 M cache reads, 19 calls, $0.77 | 20 M, 27 calls, $1.02 | |

Where it goes: the conversation is 100 to 126 k tokens after deckbuilding and grows by 150 to 270 k per game (the prompts of that table sent about 82 k of decision text per game; the rest is the seat's own reasoning and tool calls), and every call re-reads all of it. A game's cache reads therefore grow with every game before it, until Claude Code compacts the conversation at about 1 M tokens (two seats did, in their third game). Almost every call is over 100 k tokens, where Claude Haiku 5.5 costs 5× its base price ($0.05 per M cache reads); that is how Claude Code's reported cost comes out to the cent.

**Finished seats stop.** Six seats finished their last match 14 to 19 minutes before the event ended and kept calling `wait_for_decision` (19 to 27 calls each, each re-reading 550 k to 960 k tokens): 107 M cache reads and **$5.37, 9.5% of the table**. The Director now answers a seat that has no more games with a final "You're done" and ends its session, so that cost is gone: $51.00 for this table, $3.20 to $9.51 per seat.

Tokens per seat: 1.2 to 3 M fresh input, 184 to 503 M cache reads and 109 to 320 k output: every game re-reads a longer conversation, so one session costs about ten times a fresh session per game.

**Earlier, shorter runs** (one best-of-3 match per seat, before 8-seat tables; Claude Code, manual mana, Set Context unless noted): Claude Haiku 5.5 11 to 67 M cache reads, $0.50 to $3.62; Claude Sonnet 5.5 13 to 61 M, $2.13 to $8.71; Claude Opus 5.5 22 M, $6.46. They agree with the token model's first games; a full table costs more per game because the conversation keeps growing over three rounds.

Cache reads dominate. On a subscription this counts against your plan limits, not your bill.
