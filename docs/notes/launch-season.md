# Launch Season: Seed Tables Plan

**Updated 2026-10-24 (owner):** the seed is **FRA only**, the newest set: one or two tables with the FRA roster below,
run **on production** before the site is switched on (LAUNCH-DAY.md, The Day step 6), so launch opens with real,
comparable results. The lobby features FRA's queue by default (deploy/lobby.json); other sets stay playable. SOS and
TLA follow when people run them. Costs below are the planning numbers we used; the site and CLI no longer show cost
projections (the owner: "this uses a lot of tokens").

Proposal for the owner (2026-10-23). Every board is empty until a best-of-3 table with sideboarding finishes under prompts v8 (LAUNCH-CHECKLIST A-5). These are the tables we'd run ourselves so the site opens with rated results across providers and effort levels. The community runs the benchmark after that.

Costs are projections per seat for one event (3 Swiss rounds of best of 3, a fresh session per game) at API list prices, from `seatUsd` in `scripts/bench/estimate.ts`. On a subscription (Claude Max, Cursor, Antigravity) a seat uses the plan's allowance instead of dollars.

## Ground Rules
- **8 different setups per table.** Mirror matches (same model and effort, whatever the harness) are unrated, so no setup appears twice at a table.
- **The same 8 setups at every seed table.** Ratings need repeated meetings to be precise; varying the roster spreads the games thin.
- **One set per table, three sets:** FRA (current), SOS and TLA, so a set-specific result can't carry the board (the rating's set variance term rewards more sets).
- **Run after the next deploy:** the mana-source fix changes how agents pay for spells, and results before it would sit in a different comparison group.

## Option 1: All Claude (Claude Max only)

Answers "does more effort help, and when is a bigger model worth it?" with the subscription that has the most headroom.

| Seat | Setup | Per seat (list) |
|---|---|---|
| 1 | Claude Haiku 5.5 · Claude Code · low | $0.52–3.38 |
| 2 | Claude Haiku 5.5 · Claude Code · medium | $0.68–4.47 |
| 3 | Claude Haiku 5.5 · Claude Code · high | $0.91–5.92 |
| 4 | Claude Sonnet 5.5 · Claude Code · low | $5.25–14.41 |
| 5 | Claude Sonnet 5.5 · Claude Code · medium | $6.93–19.02 |
| 6 | Claude Sonnet 5.5 · Claude Code · high | $9.19–25.22 |
| 7 | Claude Opus 5.5 · Claude Code · low | $10.50–28.82 |
| 8 | Claude Opus 5.5 · Claude Code · medium | $13.86–38.04 |
| | **Table** | **about $48–139** |

Three tables: about $145–420 at list prices.

## Option 2: Mixed Providers (Claude Max, Antigravity, Cursor, OpenCode)

Answers the question most visitors will ask first: how do the labs compare? Cursor is on the $20 plan, so its seat is a low-cost model.

| Seat | Setup | Per seat (list) |
|---|---|---|
| 1 | Claude Haiku 5.5 · Claude Code · low | $0.52–3.38 |
| 2 | Claude Haiku 5.5 · Claude Code · high | $0.91–5.92 |
| 3 | Claude Sonnet 5.5 · Claude Code · medium | $6.93–19.02 |
| 4 | Claude Opus 5.5 · Claude Code · medium | $13.86–38.04 |
| 5 | Gemini 3.8 Flash · Antigravity · high | $3.49–10.60 |
| 6 | Gemini 4 Argon · Antigravity · high | $6.55–18.86 |
| 7 | GPT-5.6 Luna · Cursor · medium | $0.77–2.30 |
| 8 | DeepSeek-V4.1-Flash (free) · OpenCode · high | $0 (free variant) |
| | **Table** | **about $33–98** |

Three tables: about $100–295 at list prices.

**Grok 4.7 (owner, 2026-10-23):** the Cursor plan is subsidized, not billed at API prices, and can carry one Grok 4.7 event. So the FRA table seats Grok 4.7 · Cursor · high in seat 7 (about $17–55 at list prices, paid by the plan), and the SOS and TLA tables seat GPT-5.6 Luna there. Grok gets one table of rated games, provisional, and every other setup still meets the same opponents at all three tables.

## Recommendation

Option 2 first (the owner's go-ahead, 2026-10-23): three tables, one each for FRA, SOS and TLA. It makes the home page useful to both audiences on day one, and it exercises every harness path (Claude Code, Antigravity, Cursor, OpenCode) on the hosted stack before strangers do. Option 1 follows as the first Effort Ladder.

What three tables give: each setup 18 to 27 rated games (6 to 9 per table) against the other 7, with wide ranges (one contributor alone adds ±59 Elo). Every row stays provisional (one contributor), which the site says. That's honest launch data, not a final ranking: calibration says about 180 games separate two setups 100 Elo apart half the time.

## Before Running
1. Deploy the critic-round-2 fixes (mana sources, multi-face boosters, set findings) and the registry merge.
2. `bench setup` with the roster above, Private Table, Set Context, manual mana; check the Confirmation's cost and each harness's preflight.
3. Watch the first table live, then start the other two.

## Running the SOS Table

The first seed table: SOS, Private Table on the hosted Director, Set Context, manual mana, best of 3 with sideboarding, a fresh session per game for every seat `bench play` starts. FRA follows once its card fixes are deployed. `bench` below is `npm run bench --` in the main checkout (the fixes from the 2026-10-23 preflight are in it; the Director needs no deploy for them).

### Who Starts Which Seat

| Seat | Setup | Started by | Exact launch |
|---|---|---|---|
| 1 | Claude Haiku 5.5 · Claude Code · Low | `bench play` (automatic) | `claude -p … --model claude-haiku-5-5 --effort low` |
| 2 | Claude Haiku 5.5 · Claude Code · High | `bench play` | `--model claude-haiku-5-5 --effort high` |
| 3 | Claude Sonnet 5.5 · Claude Code · Medium | `bench play` | `--model claude-sonnet-5-5 --effort medium` |
| 4 | Claude Opus 5.5 · Claude Code · Medium | `bench play` | `--model claude-opus-5-5 --effort medium` |
| 5 | Gemini 3.8 Flash · Antigravity · High | you, in the Antigravity CLI | `agy --model 'gemini-3.8-flash-high'` |
| 6 | Gemini 4 Argon · Antigravity · High | you, in the Antigravity CLI | `agy --model 'gemini-4-argon-high'` |
| 7 | GPT-5.6 Luna · Cursor CLI · Medium | `bench play` | `cursor-agent -p --output-format stream-json --approve-mcps --trust --workspace . --model gpt-5.6-luna-medium` |
| 8 | DeepSeek-V4.1-Flash (free) · OpenCode · High | `bench play` | `opencode run --standalone --format json --model 'opencode/deepseek-v4.1-flash-free#high'` |

Every automatic seat runs in an empty temp folder with a private config that holds only its `mtg` server (HARNESSES.md "How headless launch works"). Claude Code and OpenCode seats are fully shut in; Cursor's built-in tools are refused when called (partial). `bench play <event> --dry-run` prints every command and file.

The Antigravity seats are seated by hand in the Antigravity CLI (`agy`). Launching them from T3 Code would be the same harness (Antigravity; T3 Code only launches it), but T3 Code has no per-thread MCP setting and gives every thread its own T3 Code tools (other threads, worktrees, pull requests), so the CLI seats a cleaner seat (HARNESSES.md "Antigravity"). In agy each seat gets a folder of its own whose workspace plugin holds only that seat's server (checked on agy 1.4.5: `/mcp` shows `mtg_mtg` with the seat's tools). Antigravity's own file, shell and browser tools stay; agy asks before it uses them.

### Projected Cost (the Confirmation)

`bench setup` with this roster shows **$88 to $250 for the 8 seats at API list prices**: Claude Haiku 5.5 low $0.5 to $3.4, Haiku high $0.9 to $5.9, Sonnet medium $6.9 to $19, Opus medium $14 to $38 (Claude Max), Gemini 3.8 Flash high $26 to $72 and Gemini 4 Argon high $38 to $100 (the Antigravity plan; one session each, because seats seated by hand keep one session), GPT-5.6 Luna medium $0.8 to $2.3 (Cursor), DeepSeek-V4.1-Flash $0.7 to $1.9 projected but $0 as a free variant. With a fresh session per game the two Gemini seats would be $3.5 to $11 and $6.6 to $19, which is why the earlier plan said $33 to $98: the Confirmation now prices hand-seated seats as one session. Everything runs on subscriptions, so this is plan allowance, not a bill; the Antigravity plan's quota is the one to watch.

### Before You Start

1. **Claude account.** Seats use the `claude` sign-in of the shell that runs setup. For Claude Max, `export CLAUDE_CONFIG_DIR=~/.claude-accounts/other` first (the folder T3 Code's Claude Max instance uses); a plain terminal otherwise uses `~/.claude`.
2. **Cursor and OpenCode.** `cursor-agent` signed in (`cursor-agent models` lists `gpt-5.6-luna-medium`); `opencode models` lists `opencode/deepseek-v4.1-flash-free`.
3. **Antigravity.** `agy models` lists `gemini-3.8-flash-high` and `gemini-4-argon-high` (signed in to the Google AI Pro account). `~/.gemini/config/mcp_config.json` has no servers and `~/.gemini/GEMINI.md` is empty (both true today; global instructions would load into a hand-seated seat). Open two terminals for seats 5 and 6.
4. **Sign in to the Hub once:** `bench login` (GitHub, accept the terms). The table is then yours as a contributor (one concurrent Private Table, six a day).

### Start It

```bash
export CLAUDE_CONFIG_DIR=~/.claude-accounts/other
npm run bench -- setup --private --hosted --once --set sos --knowledge primer --mana manual \
  --seat "Claude Code / Claude Haiku 5.5 / low" \
  --seat "Claude Code / Claude Haiku 5.5 / high" \
  --seat "Claude Code / Claude Sonnet 5.5 / medium" \
  --seat "Claude Code / Claude Opus 5.5 / medium" \
  --seat "Antigravity / gemini-3.8-flash-high" \
  --seat "Antigravity / gemini-4-argon-high" \
  --seat "Cursor CLI / GPT-5.6 Luna / medium" \
  --seat "OpenCode / opencode/deepseek-v4.1-flash-free / high"
```

Setup checks each harness it will start with one short message (a few cents in all), shows the Confirmation (the seats as the leaderboard will record them, "Rated games this table can produce: 29", the cost above) and asks before creating anything. Once you confirm, it creates the event, starts seats 1–4, 7 and 8 in the background (`runs/<event>/play.log`) and prints the steps for seats 5 and 6 and the Watch link.

### Seat the Two Antigravity Seats (Right Away)

The draft starts as soon as the event exists, and a seat that makes no call for 10 minutes while a pick is open has that pick made for it. So seat both within a few minutes.

1. `npm run bench -- seats <event>` prints a block for each Antigravity seat (`seat-…` names are neutral; the block says which model). In terminal A, paste the block for the Gemini 3.8 Flash seat; in terminal B, the Gemini 4 Argon one. Each block makes `~/mtgdt-seats/<seat>/.agents/plugins/mtg/` with the seat's server and starts `agy` there with the seat's model.
2. Trust the folder when agy asks. Type `/mcp`: it should list `mtg_mtg` with a check mark and the seat's tools. Press Esc.
3. Paste the join prompt (`npm run bench -- prompt`) unchanged as the first message.
4. When agy asks to allow a tool, allow the `mtg_mtg` tools (for the session if it offers that) and refuse anything else. Never use `--dangerously-skip-permissions`.
5. Keep the terminal open until the seat's result says EVENT COMPLETE. If agy ends its turn early or crashes, run `agy --model …` again in the same folder and paste the prompt again: the seat picks up where it was. Note any restart.

**If you'd rather launch them from T3 Code** (the same harness, Antigravity): open `~/mtgdt-seats/<seat>` (made by the block above) as a T3 Code project, start a new Antigravity thread there with the seat's model (`gemini-3.8-flash-high` or `gemini-4-argon-high`) and send the join prompt as its first message. T3 Code's Antigravity should load the folder's plugin like the CLI does, but that isn't checked yet: if the thread can't call `wait_for_decision`, seat it from the CLI instead. The thread also has T3 Code's own tools, which the seat can't be kept from.

### What to Watch

- `npm run bench -- status <event>`: every seat's state and the standings (the organizer's view). The Watch link shows the games.
- `runs/<event>/play.log`: each automatic seat's sessions ("deck locked: ending this session for a fresh one", "game N over"). A seat that exits early is relaunched up to 3 times; `harness-<seat>.log` says why.
- The OpenCode seat's first `wait_for_decision` fails with "Unknown tool" and the second works (OpenCode 2 adds MCP tools after the first step); that's expected. Zen's free tier sometimes stalls for a minute.
- The two agy terminals: permission prompts, a turn that ends before EVENT COMPLETE, or the plan's quota running out (then the seat stops calling and forfeits after 10 minutes: restart it, or note it).
- About 45 minutes to 2.4 hours in all; seats wait 10 to 30 minutes between rounds.

### Afterwards

1. `bench play` sends the usage of the six seats it started to the Hub when the event ends (`play.log` lists "Checked Against Logs" per seat).
2. For seats 5 and 6: `npm run bench -- attach-logs <event> --seat <flash seat> --seat <argon seat>` (it asks first). It reads the Antigravity CLI's conversation store (`~/.gemini/antigravity-cli/conversations/`; the standalone CLI's store is not yet checked on a real event, so if it finds nothing the two seats stay Self-Reported at half points) and sends the model and level to the Hub.
3. `npm run bench -- status <event>` for the final standings; `rm -rf ~/mtgdt-seats/<seat>` for both folders (they hold the seat URLs).

### Preflight Check (2026-10-23)

Two operator tables on the hosted Director (admin token, so `contributors: 0` and no quota), SOS, Set Context, manual mana, 6 scripted seats plus GPT-5.6 Luna · Cursor CLI · Low and DeepSeek-V4.1-Flash (free) · OpenCode · High:
- `2026-10-23-04-05-24-sos-7c57`: found four problems, all fixed: the OpenCode seat launched the paid `opencode/deepseek-v4.1-flash` (the free name was dropped), Zen refused it without OpenCode's `read` tool (403 `FreeTierError`), OpenCode 2 reached no MCP tools with `execute` denied (Code Mode), and the Cursor seat's usage was never sent (its stream names the model "GPT-5.6 Luna 272K Low"). The Cursor seat played its six games with a fresh session per game (level Low detected).
- `2026-10-23-04-54-27-sos-22da`: the check after the fixes. Both model seats drafted, built (a fresh session after the deck lock and after each game) and won their round-1 matches; the OpenCode seat played through Code Mode (first call "Unknown tool", then every call worked). Stopped by us in round 2 (the owner's usage limit), so the end-of-event usage upload wasn't seen live; the upload bodies built from the run folders name `gpt-5.6-luna` (level low, detected) and `opencode/deepseek-v4.1-flash-free` (level high, from OpenCode's session record). The setup preflight for these two seats now reports both as model verified (it called the Cursor seat a Mismatch before, which would have stopped setup).

### Open Questions
- **The standalone agy CLI's conversation store** (`~/.gemini/antigravity-cli/conversations/`) is not yet checked by `bench attach-logs` on a real seat. If it finds nothing, seats 5 and 6 stay Self-Reported (half points). Check after the table.
- **agy's tool permission prompts** for `mtg_mtg` tools weren't seen (that needs a model call). If agy asks on every call, the seat needs a person at the terminal; look for an "allow for this session" choice.
- **T3 Code launching Antigravity with the folder's plugin** is not checked (the CLI is).
- **A headless Antigravity launcher** (`agy -p --output-format stream-json` in the seat folder, maybe a custom agent with `excludeDefaultComponents: true` to drop the built-in tools) would give these seats a fresh session per game and full isolation. Not built: it needs one real Antigravity run to check.
- **OpenCode Zen free tier** stalled for a minute or more on some requests during testing; the seat's 10-minute watchdog is far above that, but watch it.
- **Hub quota:** a contributor gets one concurrent Private Table; don't start this table while another of yours is running.
