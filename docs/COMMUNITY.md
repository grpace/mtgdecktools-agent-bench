# Play in the Benchmark and Share the Results

The MTG Deck Tools Agent Benchmark is run by its community: you bring the agents, on your own harnesses and tokens. Every table seats **8 agents**, who draft together, build decks and play three Swiss rounds of best-of-3 matches with sideboarding (the loser of a game chooses to play or draw the next one).

- **Private Table:** You bring all 8 agents and play right away; repeat models as you like. (4 models × 2 is a good comparison.)
- **Join the Lobby:** Bring 1–4 agents; we seat you with other people's agents and start when 8 are ready. Your seats wait at no cost until then ([LOBBY.md](LOBBY.md)).

Either way you choose **Play One Table** (one draft, then it stops) or **Keep Playing** (new drafts back to back until you stop it or a limit you set is reached; see [Keep Playing](#keep-playing)). Every seat you bring earns [points](#points-and-the-contributors-leaderboard) on the Contributors Leaderboard.

A private table runs **on the hosted table** (recommended: we run the rules engine and the Director, your agents connect over MCP, and results go straight to the leaderboard, labeled **Hosted**, METHODOLOGY §3) or **on your own machine** (you run phase-server and the Director, then submit the results bundle for the **Community** label; sections 1–5 below). The server never calls a model and needs no API key from you.

## Set Up an Event

There is one setup flow, `bench setup`. It asks the questions (Private Table or Lobby, one table or Keep Playing, where it runs, the set, each seat's harness, model and effort, what the agents may know), checks the answers against the server and the model registry, runs a quick preflight for every harness it will start, and ends in a **Confirmation**: the details the leaderboard will record for each seat, how long the table takes, and a note on tokens. Nothing starts until you confirm.

**With your coding agent (recommended).** Paste [`prompts/setup.md`](../prompts/setup.md) into a coding agent that can run commands (Claude Code, Codex, Gemini CLI, OpenCode, Cursor and the like). It installs the kit and runs `bench setup --agent`, asks you its questions in plain language, signs you in with GitHub once the questions are answered, shows you the confirmation and starts the event only after you say yes. Say "defaults" to take the recommended answer wherever a question has one (it still asks you for the seats). A dry run (`--dry-run`) shows the whole confirmation without signing in. The kit runs on macOS and Linux; on Windows, use WSL.

**Prefer your terminal?** The same wizard, step by step:

```bash
git clone https://github.com/grpace/mtgdecktools-agent-bench.git ~/mtgdt-bench
npm --prefix ~/mtgdt-bench ci
npm --prefix ~/mtgdt-bench run -s bench -- setup
```

Every command runs the same way from any folder: `npm --prefix ~/mtgdt-bench run -s bench -- <command>`. In this guide, `bench <command>` is short for that (with a clone somewhere else, put its path after `--prefix`). The CLI runs from a clone of this repository (it is not distributed on npm). `bench check` shows what your machine has (Node.js 22 or later, sign-in, installed harnesses and their models) and what you can choose.

### The Confirmation

For each seat (identical seats are grouped), one line in the leaderboard's order, **model · harness · effort**:
- the model's registry name, the harness and its version (when it starts on this machine), and the effort level, then how the effort is known: **set by flag** at launch (and seen in the harness's log where it logs one), **declared by you** for a seat you start yourself, or the harness's **documented default** where it has no setting or you don't know it;
- where it starts (this machine, or by you) and the preflight: **✓** it answered and the model it reported is the declared one; **⚠** it can't be checked here (it is Self-Reported); **✗** a problem to fix first (not installed, not signed in, a different model answered).

Then the table (private or lobby, hosted or your own), the set, the knowledge level, the format (best of 3 with sideboarding), the time (about 45 minutes to 2.4 hours) and a note on tokens. The preflight costs one short message per harness and model.

**Tokens.** A table uses a lot of tokens: every seat drafts, builds a deck and plays 6 to 9 games on your own harness subscription or API key, with a fresh agent session per game (one session per seat costs several times as much). Take part only if you have tokens to burn, and set a spending limit with your provider; on a subscription it counts against your plan's limits. We don't project what your table will cost. What seats have actually cost is on the leaderboard and in the open data (cost per game), and [HARNESSES.md](HARNESSES.md#expected-usage) has the measured token counts.

### Make Your Table Count

Only games between **different setups** (a different model or effort level; the harness doesn't count) are rated. A table of 8 identical seats plays a full event and still adds format data, but none of its games is rated. The Confirmation says how many games your table can rate ("Rated games this table can produce: 29 (of up to 29)"), and when the answer is few or none it warns you plainly and suggests mixes from what you can run: an **Effort Ladder** (one model at two effort levels, for example 4 seats at low and 4 at high), a **Model Mix** (two or three models from one provider), a **Provider Mix** (models from two providers, such as Claude Code and Cursor CLI seats; one model through two harnesses is still one setup), or **Join the Lobby**. Nothing is refused. `bench check` and the seats question also show which seats you can run are **most needed** right now, from the leaderboard's Most Needed list. Several providers, apps such as T3 Code and Cursor, and good tables for common subscriptions: [MULTI-PROVIDER.md](MULTI-PROVIDER.md).

### Flags, for Scripts

The same answers work as flags; `--yes` confirms (after the same checks and preflight):

```bash
npm --prefix ~/mtgdt-bench run -s bench -- setup --private --hosted --set fra --knowledge primer \
  --seat "4x Claude Code/Claude Opus 5.5/high" --seat "4x Claude Code/Claude Sonnet 5.5/high" --yes
```

- `--seat "[N x] harness/model/effort"`: by id or registry name (`Claude Code/Claude Opus 5.5/high` and `claude-code/claude-opus-5-5/high` are the same seat). A count fills several seats. A seat you start yourself may say `unknown` for the effort.
- `--knowledge`: `none` (None: card text and the Limited fundamentals only), `primer` (Set Context, the default: the MTG Deck Tools guide to the set's archetypes and key cards) or `primer+stats` (Set Context + Human Stats: human drafters' win rates from 17Lands' public data, Premier Draft where the set has it, next to each card, credited to 17Lands), as far as the set has the data.
- Without `--yes` it shows the confirmation and creates nothing. `--no-launch` starts no seat here; `--skip-preflight` skips the checks (the seats are then Self-Reported unless their logs show the model).

After confirming, the seats whose harness is installed here start in the background (they keep going if you close the terminal), and every other seat gets its URL and the steps to seat it by hand. Then:

```bash
npm --prefix ~/mtgdt-bench run -s bench -- status <event>   # stage, who is deciding, standings
npm --prefix ~/mtgdt-bench run -s bench -- stop <event>     # stop the event and the seats running here
```

## The Hosted Table in Detail

**Before you play: the terms.** The first `bench login` shows a short summary of the [Terms](legal/TERMS.md), [Privacy Notice](legal/PRIVACY.md) and [Content Policy](legal/CONTENT-POLICY.md) and asks for an explicit "yes" (a coding agent shows you the summary and passes `--accept-terms` only after you agree). In short: you run your agents on your own subscriptions or API keys and are responsible for all costs and for your providers' terms (we can't refund costs or help with account actions such as rate limits, flags or bans); finished events, including your agents' notes, are published and released as open data under CC BY 4.0; your handle shows only if you choose. When the terms change, hosted play and uploads stop until you accept again: run `bench login` (or `bench terms`), or press the button on your account page.

**1. Get a token** (once; `bench setup` asks you to sign in after its questions). The hosted Hub signs in GitHub accounts at least 30 days old. Either:
- run `bench login`: it prints a GitHub code to approve and saves the token to `~/.config/mtgdt-bench/token` (agents: `login --start` prints the code and exits, `login --wait` finishes once it's entered); or
- sign in with GitHub at https://bench-data.mtgdecktools.com/account: your token is shown once; copy it into `BENCH_TOKEN` or `~/.config/mtgdt-bench/token`.

One token covers hosted play and submissions. Manage, revoke or rotate your tokens on the same account page. Hosted play has two quotas per person, counted separately: **Private Tables**, 1 running or queued at a time and 6 a day, and **lobby tables**, 2 at a time and 12 a day (days are rolling 24 hours). Your account page shows yours; ask us if you need more.

**2. Create the event:** `bench setup` (above), `bench new`, or plain HTTP:

```bash
curl -X POST https://bench.mtgdecktools.com/api/events -H "Authorization: Bearer $BENCH_TOKEN" -H 'Content-Type: application/json' \
  -d '{"set":"fra","knowledge":"primer","agents":[{"name":"opus-1","harness":"claude-code","model":"claude-opus-5-5","effort":"high"}, …8 seats…]}'
```

Seat names are replaced by neutral `seat-<hex>` names (the answer's `renamed` lists them).

Hosted events use rated conditions only:
- any set with booster data (`GET /api/sets` lists them, featured sets first, each with whether it has a Set Context and Human Stats), best of 3 with sideboarding (best of 1 was removed), knowledge `none`, `primer` (default) or `primer+stats` as far as the set has the data for it, mana `manual` (default) or `auto`;
- 8 agent seats, each declared with harness, model and effort (an explicit level wherever the harness can set one). They must be in the model registry (`registry/models.json`; a typo gets a "did you mean"). They are **self-reported** and recorded as such (`event_start.seat_meta`) until the usage summary sent after the event checks them, so declare them honestly (see Fairness rules);
- a random seed you don't see until the event is over (a known seed means known packs), and the current join prompt.

The answer has the seat URLs right away: `201` when the event starts now, `202` with `queue_position` when the server is full (it starts on its own, first come first served, when a table frees up; seats that connect meanwhile are told to keep waiting). `429` means one of your quotas is used up (`Retry-After` says when to try again); `503` that the server is restarting or the queue is full.

**3. Seat the agents:** `bench play <event>` starts the seats whose harness is installed here; `bench seats <event>` prints how to seat each one by hand. Seat URLs are secrets: anyone with one can play that seat.

**After the event:** `bench play` sends the Hub each seat's usage summary (the model ids and token counts your harness logged, the effort level and the harness version; never prompts or transcripts), so your seats are **Checked Against Logs** instead of Self-Reported. Seats you started by hand: `bench attach-logs <event>` finds their sessions on this machine (it asks first) and sends the same summary. If the Hub didn't have the event yet, run `bench attach-logs <event>` again later; it resends. The Hub takes it only for seats you seated (METHODOLOGY §2.1).

**4. Follow it:** the Watch page on mtgdecktools.com (`/agent-bench/watch/<id>/live`), `bench status <event>` (or `GET /api/events/<id>`: stage, `queue_position` while queued, standings; while the event runs, per-seat details and standings need your token, which `bench status` sends: the admin token for a table created with it, else your contributor token), and `GET /api/capacity` for the server's load. Only you (and we) can see your event's seat URLs (`GET /api/events/<id>/seats`) and logs (`bench pull`). Cancel a queued event, or stop a running one, with `bench stop <event>` (`DELETE /api/events/<id>`). Stopping doesn't erase a table: its finished games still count and are rated; games never played are not results, and an open game is void, or a loss for your own seat if it faced someone else's (METHODOLOGY §3.2, "Stopped events").

**5. Results** go to the leaderboard by themselves: when the event ends, the Director hands it to the Hub, which checks it and lists it as Hosted. You don't submit anything.

**Good to know:**
- **Restarts don't lose your event.** If the server is redeployed mid-event, it picks up where it was: the draft at the same pick, decks already built, games reconnected to the rules engine. Your agents only see calls fail for a minute or two and a notice; they should just keep calling `wait_for_decision` (the seat URL stays the same). `bench play` waits out a restart for up to 10 minutes (`MTGDT_DIRECTOR_WAIT_MIN`) and starts a new session for a seat whose harness gave up meanwhile, without counting it as a relaunch; the inactivity watchdog gives every seat at least 15 minutes after a restart. If a game can't be reconnected, it is **voided** and replayed from the start; a voided game counts for nobody.
- **Limits:** an event may run at most 8 hours; a queued event that hasn't started after 4 hours is dropped; an event whose seats never connect is stopped after 30 minutes; a seat silent for 10 minutes with a decision open forfeits it (METHODOLOGY §5.5).
- Requests are rate limited (per address and per seat); a well-behaved agent never notices.

## Your Own Table

Set it up with `npm --prefix ~/mtgdt-bench run -s bench -- setup --local`, or step by step:

### 1. Start the Table (Once)

Your own table needs:
- Docker or Podman.
- Node.js 22 or later.
- At least one agent harness that speaks MCP. See [HARNESSES.md](HARNESSES.md).

```bash
git clone https://github.com/grpace/mtgdecktools-agent-bench.git ~/mtgdt-bench
npm --prefix ~/mtgdt-bench ci
npm --prefix ~/mtgdt-bench run up            # = bench up
```

`npm --prefix ~/mtgdt-bench run up` builds the Director image from your checkout and pulls the phase-rs rules engine at the exact build pinned in `engine/phase.lock.json`. It starts both and waits until the Director answers on `http://127.0.0.1:8787`. On the first start:
- phase-server downloads its card database into a volume. That takes a minute or two.
- The Director generates an **admin token**, saves it to `.bench/admin-token` (gitignored, readable only by you) and logs only where it is, never the token. The CLI reads it from there. You only need to copy it if you call the API yourself (`Authorization: Bearer <token>`).

The same thing without the CLI:

```bash
mkdir -p .bench                                         # so the token file belongs to you
docker compose -f deploy/compose.local.yaml up --build  # or: podman compose -f deploy/compose.local.yaml up --build
```

**No compose on your machine?** Run `npm --prefix ~/mtgdt-bench run -s bench -- up --plain`. It uses plain `podman run` / `docker run` commands: a network, the pinned phase-server, and the Director with the same volumes and settings. Run `npm --prefix ~/mtgdt-bench run -s bench -- up --plain --engine podman` and copy the printed commands to see exactly what it does.

Options: `BENCH_PORT=8820 npm --prefix ~/mtgdt-bench run up` changes the port. `npm --prefix ~/mtgdt-bench run down` stops the stack and keeps the data volumes.

To let agents on other machines connect, put the Director behind HTTPS and set `PUBLIC_URL=https://your-host`, so seat URLs use that address. Keep the admin token secret: anyone holding it can create events.

### 2. Create an Event

`npm --prefix ~/mtgdt-bench run -s bench -- setup --local` asks the same questions as on the hosted table and starts the Director if it isn't running. One step at a time:

```bash
npm --prefix ~/mtgdt-bench run -s bench -- new --set fra --knowledge primer \
  --seat "4x claude-code/claude-sonnet-5-5/high" \
  --seat "4x cursor/gpt-5.6-sol/high"
```

- `--seat "[N x] [name=]harness/model/effort"`: 8 seats in all. Seats are named `seat-<hex>` at every table, never after the model (names show in the logs, the live stream and the event status); a `name=` that isn't of that form is replaced, with a note. Use the model id your harness reports, and `default` for the effort if your harness has no setting.
- `--set`: any set with booster data in phase-rs. Featured sets (`sets/rotation.json`) have an MTG Deck Tools Set Context and 17Lands Human Stats; `bench check` shows what each set offers.
- `--unlisted-model`: on your own table only, accept a model or harness the registry doesn't list yet. Such seats are Unlisted and unrated until the registry knows them (add them in a pull request: `registry/README.md`).
- `--knowledge none | primer | primer+stats`: None, Set Context (the default), or Set Context + Human Stats.
- `--mana manual` (default) or `auto`, `--seed <text>`. Every event plays best of 3 with sideboarding; `--best-of 3` is still accepted, any other value is refused.

The seat URLs are saved to `runs/<event>/event.json` (gitignored). Anyone with a seat URL can play that seat, so don't share them.

### 3. Seat the Agents

```bash
npm --prefix ~/mtgdt-bench run -s bench -- play <event>             # launch every seat headless
npm --prefix ~/mtgdt-bench run -s bench -- play <event> --dry-run   # print the exact commands instead
npm --prefix ~/mtgdt-bench run -s bench -- seats <event>            # config snippets, to seat them by hand
```

`play` launches each seat with its harness's command line in an empty temp directory, gives it [`prompts/join.md`](../prompts/join.md), and saves the harness's own transcript to `runs/<event>/transcript-<seat>.jsonl`. If a session exits before its seat's EVENT COMPLETE (the Director's `GET /api/events/<id>` says the seat isn't done), `play` launches a fresh one, which resumes the seat, up to `--relaunch` times (default 3); every session is appended to the same transcript and the usage report sums them. A seat is done as soon as its own last match ends: the Director answers `EVENT COMPLETE. You're done…` with that seat's results, and `play` stops a session still running 2 minutes after that. On the hosted Director, `play` then waits for the event to end (no tokens spent) and sends your seats' usage to the Hub; the results go to the Hub on their own, with nothing to pull or bundle. A seat that stays silent for 10 minutes with a decision open forfeits it (METHODOLOGY §5.5), so a dead session never stalls the table. By default each game starts a fresh agent session to keep costs down, and every decision carries the full board and match history (`--fresh-session per-game`; `per-match` or `off` at `bench new`, `bench setup` or `bench lobby join`); it is recorded with each seat ([HARNESSES.md](HARNESSES.md), "Fresh sessions"). Supported harnesses and how each one is started: [HARNESSES.md](HARNESSES.md).

### 4. Watch It, Then Pull the Logs

```bash
npm --prefix ~/mtgdt-bench run -s bench -- status <event>   # stage, who is deciding, standings
npm --prefix ~/mtgdt-bench run -s bench -- pull <event>     # copy events.jsonl + summary.json from the Director into runs/<event>/
```

An event takes about 45 minutes to 2.4 hours (best of 3 with sideboarding). To browse your runs locally, use `npm --prefix ~/mtgdt-bench run site` (static viewer over `runs/`) or the Director's live report data at `http://127.0.0.1:8787/data/index.json`.

### 5. Bundle and Submit

```bash
npm --prefix ~/mtgdt-bench run -s bench -- bundle <event> --submitter <your-handle>
npm --prefix ~/mtgdt-bench run -s bench -- submit runs/<event>.bundle.tar.gz
```

A bundle is a `.tar.gz` containing:

| File | What |
|---|---|
| `bundle.json` | Manifest: event id, your handle, seats, a sha256 of every file |
| `events.jsonl` | The Director's full event log: every pick, build and decision. This is the source of truth |
| `summary.json` | Standings and match results |
| `seats-meta.json` | Each seat's kind, position, harness, model and effort. No seat URLs |
| `usage-<seat>.json` | Harness usage extracted from the transcript: model ids, tokens, cost, duration, tool-call counts |
| `transcript-<seat>.jsonl` | Claude Code seats: a **usage-only** copy (model, token counts, tool names; no text). With `--transcripts`: the full harness transcript |

By default nothing your agents wrote reaches the bundle except their decisions and the short notes they attach to each one, which are already in the event log. Full transcripts (reasoning, tool calls) are opt-in with `--transcripts`. They help with analysis, but they're yours to share or not.

`bundle` runs the same validation as the server and refuses to write a bundle that would be rejected. Check an existing bundle with `npm --prefix ~/mtgdt-bench run -s bench -- validate <file>`.

**Submission tokens:** submitting uses your contributor token (`bench login`, or `BENCH_TOKEN`).

**Where it goes:** results go to the **Hub**, the benchmark's results service (`--to <hub url>` or `BENCH_SUBMIT_URL`). `submit` prints the outcome: `ingested`, or `held` for review with the reasons, plus a status URL you can check with your token:

```bash
curl -H "Authorization: Bearer $BENCH_TOKEN" <hub>/api/submissions          # your recent submissions
curl -H "Authorization: Bearer $BENCH_TOKEN" <hub>/api/submissions/<id>     # one: status, reasons, every check
```

## The Lobby: Bring One to Four Agents

Every table seats 8 agents, so with fewer you join the **lobby** and are matched with other contributors' agents under the same conditions. Details and the full API: [LOBBY.md](LOBBY.md).

```bash
npm --prefix ~/mtgdt-bench run -s bench -- login                                   # once
npm --prefix ~/mtgdt-bench run -s bench -- lobby list                              # open tables, scheduled tables, recent tables
npm --prefix ~/mtgdt-bench run -s bench -- lobby join --set fra --seat claude-code/claude-opus-5-5/high --notify
```

- **Waiting is free.** `lobby join` holds your place with a long-poll; no harness runs and no tokens are spent until your table fills. Keep it running (or use `--detach`).
- **Ready check.** When 8 seats are present, every holder confirms within 60 seconds; the command does it for you. A missed check drops your seats from the queue, and the next seats in line take the places.
- **When the table fires,** the command starts your seats with `bench play` on this machine, exactly like a Private Table. Seat positions are random, and nobody sees who sits where.
- **Sessions:** as at a Private Table, each game starts a fresh agent session to keep costs down, and every decision carries the full board and match history (`--fresh-session per-match` or `off` on request). Your seats' policy is sent when you join and recorded with each seat; it isn't shown in the lobby. Seats you start yourself (`--no-launch`) keep their own session.
- **Rules:** a queue is one set, knowledge level and mana mode (one comparability group; every table plays best of 3 with sideboarding); at most 4 of a table's 8 seats can be yours; seats must name a listed model, harness and an explicit effort (`high`, not `default`); entries expire after 24 hours; `bench lobby leave` leaves at any time.
- **Reliability counts.** A seat that goes silent mid-event is played by the watchdog (picks, deck, conceded games; never rated) and counts as abandoned. Contributors who often abandon seats queue last and hold one seat at a time.
- **Scheduled tables** (for example a weekly FRA draft) gather players at a fixed time: `lobby join --schedule <id>` signs up ahead.
- Your GitHub handle is shown next to your seats and on your contributor page unless you add `--hide-handle` or hide it on your Hub account page (that setting wins).
- **No scripted seats** in the lobby: they would spend other players' tokens on games that are never rated.
- **Lobby quota:** at most 2 lobby tables of yours at a time and 12 a day, counted separately from your Private Tables (1 at a time, 6 a day). At the limit your seats keep their place and join a table once one of yours ends.

## Keep Playing

`bench setup` asks whether to play one table or keep playing. **Keep Playing** starts a new draft as soon as the last one finishes:
- **Private Table:** a new table with a new seed and the same 8 seats, on the same set or rotating through the sets you choose (`--rotate-sets featured` or `--rotate-sets fra,tla`).
- **Lobby:** your seats rejoin the queue after each table, at the back like any new join.

Every seat must start on this machine (each new table has new seat URLs), and every table uses your tokens. It runs in the background until you stop it or a limit you set is reached: a number of tables (`--max-tables 5`), hours (`--max-hours 8`), tokens (`--max-tokens 200M`, input plus output; cached re-reads aren't counted) or dollars (`--max-usd 50`), whichever comes first. It won't start a table that is expected to go past a limit. Tokens and dollars use what your harness reports in its usage logs where it does, and a measured per-table size (the high end) where it doesn't. The Confirmation shows the mode, the limits and how many tables they allow. Before each table the loop re-runs the quick preflight; if a harness stops answering (signed out, out of credits), the loop stops instead of seating a dead agent. When the hosted server is busy or your daily limit is used up, it waits as long as the server says; on other errors it backs off (1, 2, 4 … 30 minutes) and stops after five failures in a row. It writes a running summary (every table, your seats' results, tokens and cost) to `runs/loops/<loop id>/summary.json`.

```bash
npm --prefix ~/mtgdt-bench run -s bench -- status                    # your loops (and events on the Director)
npm --prefix ~/mtgdt-bench run -s bench -- status <loop id>          # one loop's summary
npm --prefix ~/mtgdt-bench run -s bench -- stop <loop id>            # finish the current table, then stop
npm --prefix ~/mtgdt-bench run -s bench -- stop <loop id> --now      # stop now (see below)
```

`stop --now` on a Private Table cancels the event (nothing from it is scored). In the lobby other people's agents are at your table, so stopping now leaves your seats to the watchdog: they count as abandoned, which lowers your reliability and earns no seat points. Prefer the graceful stop.

Seats you start yourself (one table only): after the event, `bench attach-logs <event>` asks before reading your client's session logs (it lists the folders first) to verify the model and effort. It keeps only those, the harness version and token counts, never conversation text.

Keep Playing shares the hosted server fairly: a continuous Private Table waits behind lobby tables and one-off tables, starts only while capacity is left for them, and you can have one running at a time. Each table counts toward your daily Private Table limit (6 a day by default; a lobby loop counts toward the separate lobby limit, 12 a day; ask us for more). Details: [LOBBY.md §2.3](LOBBY.md).

## Points and the Contributors Leaderboard

Every seat you bring that plays rated games earns points. Points reward **contributing**, not winning: a seat that loses every game earns as much as one that wins them all. Points never affect the model ratings. If we change a point value or the length of a season, the change is applied to all history (see Recomputable).

**What earns points** (per seat, at tables the Hub accepted; only seats with at least one rated game earn anything):

| | Points |
|---|---|
| A seat that plays its table to the end | 10 |
| Each rated game it plays (against a different model setup) | 2 |
| Lobby seats (tables the hosted lobby started; they let other people play) | × 1.5 |
| Seats not checked against harness logs (see "Harness logs" below) | × 0.5, and no bounties |
| **Bounties** for data the benchmark needs most (seats that played to the end, checked against harness logs, with at least 2 rated games at that table) | |
| First Games: the model has no rated games yet | + 20 |
| Needs Games: the setup (model · effort) has fewer than 30 rated games, 3 tables or 2 opponents in these conditions. Listed, current models at an explicit effort only, and at most 3 per setup per contributor in any 7 days | + 10 |
| New Set: the set has fewer than 3 rated tables | + 5 |

Then your **reliability** multiplies the seat's points: the share of your last 20 seats you played to the end (from your fifth seat on; at least × 0.5). A seat whose harness went silent and was finished by the watchdog is **abandoned**: it gets no seat points or bounties, keeps the points for the rated games it did play, and lowers your reliability.

**What earns nothing:** seats with no rated games (for example a table of 8 seats of one model setup: games between two seats of the same setup aren't rated, so such a table earns 0), Early Test Data (tables played best of 1, or best of 3 before sideboarding: they stay listed but are never rated), Smoke and dev tables (scripted players, bot drafters), tables the Hub rejected or that are still held for review, tables a reviewer excluded, seats whose harness logs show a different model than declared (a Mismatch), and seats of models not in the registry yet (they earn their points once the model is listed).

**Harness logs.** A seat earns full points and bounties when it is **Checked Against Logs**: its harness usage (model ids and token counts, never conversation text) names the model you declared. Otherwise it earns half and no bounties, so "Mismatch earns nothing" can't be dodged by leaving the logs out.
- **Seats `bench play` starts on a hosted table** count as checked from the start: the CLI launched them with the declared model and effort. The usage summary it sends after the event confirms it.
- **Seats you start by hand** (an app, a harness the CLI can't start, or `--no-launch`) earn half and no bounties until you run `bench attach-logs <event>`: it finds their sessions on this machine (it asks first) and sends the usage summary. Once the Hub has it and it shows the declared model, the seat is Checked Against Logs and earns in full, bounties included; the points are recomputed (they keep the table's date, see "The Hub's clock").
- **On your own table**, `bench bundle` attaches the usage logs (`bench attach-logs` finds them for seats you started by hand).
- Usage that names no model (some harness versions don't log it) checks nothing: the seat stays Self-Reported at half. Usage that names another model is a Mismatch and earns nothing.

**Limits, so points stay fair:**
- **Repeats:** once a setup is no longer short of games in its conditions, the data needs it less. Your 9th to 16th seat of the same setup in the same set within 7 days earns half, and from the 17th a quarter. Setups that still need games earn in full.
- **Daily cap:** 400 points per day (UTC) per contributor. Anything above it is shown in your ledger as over the cap.
- **The Hub's clock.** A table's points are dated when the Hub accepts it (for a held upload, when it is approved), never by the times inside the bundle. That date decides the day for the cap, the 7-day windows, the season, and which table was first to a bounty.
- **The lobby × 1.5** is only for tables the hosted lobby started and handed to the Hub itself. A bundle you upload counts as a Private Table, whatever its log says.

**Worked example.** A lobby table in FRA (Set Context, best of 3). You bring two seats of Claude Opus 5.5 · High, which still needs games (the model has rated games already, so no First Games); FRA has no rated tables yet; your 9 earlier seats all finished; `bench play` started both seats.
- Seat 1 plays to the end with 7 rated games: (10 + 7 × 2) × 1.5 = 36, plus 10 (Needs Games) + 5 (New Set) = 51.
- Seat 2 plays 2 rated games, then your harness goes silent: (0 + 2 × 2) × 1.5 = 6, no bounties.
- Your reliability is now 10 of your last 11 seats finished, × 0.909: seat 1 earns 46 and seat 2 earns 5, so the table earns **51 points**.
- Had you started seat 1 by hand, it would earn (10 + 7 × 2) × 1.5 × 0.5 = 18, no bounties, × 0.909 = **16** until you send its logs with `bench attach-logs`; once they show Claude Opus 5.5 it earns the full **46** like the launched seat.
- A Private Table of 8 seats of Claude Haiku 5.5 · Low earns **0**: every game is between two seats of the same setup, so none is rated.

**Seasons.** A season is a calendar month (UTC). The leaderboard shows the current season and all time.

**Bounties are computed from the data**, not picked by hand: the Hub lists what is most needed right now (models with no games, setups that need games and how far each is from 30, sets with few tables) under **Most Needed** on the leaderboard and at `GET /api/bounties`. We can add a bounty by hand (for example a launch week for a new set) or switch one kind off in [`packages/hub/bounties.json`](../packages/hub/bounties.json), which is public like the rest of the rules.

**Recomputable.** The points ledger is rebuilt from the accepted results with these rules, so anyone with the bundles and the Hub's acceptance times gets the same numbers. When we change a rule, we rescore all of history the same way (`npm run hub -- points recompute`) and say so in the changelog.

**Your profile** (`/agent-bench/contributors/<handle>` on mtgdecktools.com, from the Hub) shows your points and rank, the tables, seats and games you contributed, your reliability, the models you ran, and your own agents: for each model · harness · effort you seated, its record in your seats, how your seats did against the same setup's average over everyone's seats, your best Swiss finishes and highlights from your games.

**Your account page** (https://bench-data.mtgdecktools.com/account, after a GitHub sign-in) also shows what only you see: bundles still waiting or held for review (with the reasons), every points line with how it was computed, and your abandoned seats.

**Privacy.** Your GitHub handle appears on the leaderboard, your profile and in the lobby unless you hide it. Joining the lobby with `--hide-handle` hides you, and so does the setting on your account page, which wins over the lobby choice everywhere: on the leaderboard and in the lobby's queues, recent tables and stats (within a few minutes). Hidden contributors are left out of the boards and have no profile page (ranks count public contributors only), but their points still count and they see their own numbers on their account page. Event pages never name who uploaded a bundle. Moderators can hide a handle (it then stays hidden whatever you choose), a note or a deck name ([Content Policy](legal/CONTENT-POLICY.md)). To have an event taken down or your account erased, contact us at [magic@greg.tech](mailto:magic@greg.tech) ([Privacy Notice](legal/PRIVACY.md#erasure) lists what erasure removes and what remains).

## Troubleshooting

- **"Accept the current terms" (403):** the terms changed, or you signed in on the website and never accepted them. Run `bench login` (or `bench terms`) and answer "yes", or press **I Accept the Terms** on your account page.
- **Sign-in fails or a command says you have no token:** run `bench login` again (it shows a link and a code; the token lands in `~/.config/mtgdt-bench/token`). The hosted Hub only signs in GitHub accounts at least 30 days old.
- **`bench check` or the setup preflight marks a harness ✗:** install it, or sign it in (run it once by hand), then check again. Seats on a harness that isn't installed can still be seated by hand: `bench seats <event>`.
- **"Too many requests" or a quota message:** hosted play has per-contributor limits, one for Private Tables (1 at a time, 6 a day) and one for lobby tables (2 at a time, 12 a day); the message says which one you hit and when to try again.
- **The event is queued:** the hosted table is at capacity. `bench play` waits without starting any session, so nothing is spent, prints the queue position, and starts the seats when the event begins. An event queued for 4 hours is stopped.
- **A seat never connects, or its session keeps exiting:** `bench status <event>` shows each seat; `runs/<event>/harness-<seat>.log` has the harness's own output. `bench play` relaunches a session that exits early (3 times by default, `--relaunch N`). A seat that makes no call for 10 minutes while a decision is open (30 minutes before its first call) has its decisions settled for it, and games conceded that way count as losses.
- **Your computer went to sleep:** the same 10-minute rule applies, so keep the machine awake while a table runs (`systemd-inhibit` on Linux, `caffeinate -i` on macOS, or your power settings), especially with Keep Playing.
- **A lobby ticket disappeared:** tickets expire after 24 hours without a table; join again.
- **Set Context + Human Stats isn't offered for a new set:** it needs 17Lands' public data for the set, which usually arrives a few weeks after release. `bench check` shows what each set offers.

## Fairness Rules

Results are only comparable if everyone plays the same game. For leaderboard submissions:

1. **Use the join prompt unmodified.** Use the current join prompt (`prompts/join.md`) as the seat's first message. No extra system prompt, hints, strategy notes or examples. (`bench play --prompt` exists for experiments; those runs aren't leaderboard runs.)
2. **Report harness, model and effort honestly**, as specific as your harness allows (`claude-code/claude-opus-5-5/high`, not `claude/opus`). If a seat ran on something unusual (a custom system prompt in your global config, a proxy, a fallback model), say so in your submission.
3. **Fresh sessions that hold one seat only**, with only the `mtg` tools: a seat's sessions start empty (`bench play` starts a new one for every game by default) and never carry another seat or event. No file, shell or web access, no sub-agents with other tools, and no human in the loop.
4. **Don't modify the Director or the engine** for leaderboard runs. Run a clean checkout (`bench up` records the commit, and a `-dirty` suffix flags local changes) and the pinned engine build.
5. **Submit every completed event you ran for the leaderboard, not just the wins.** Restarts after a crash are fine. Mention them.
6. Experiments (other prompts, ablations, custom harness setups) are welcome. Submit them too and say what you changed. They're labeled and kept off the main board.

## What the Server Checks

`POST /api/submissions` on the Hub (`Authorization: Bearer <submission token>`, body: the `.tar.gz`, up to 25 MB, 30 per day). The Hub keeps your bundle byte-for-byte (content-addressed by sha256) and runs the checks in [METHODOLOGY.md §3.1](METHODOLOGY.md):

- **Rejected (400):** a malformed archive, files missing or not listed in the manifest, sha256 mismatches, an `events.jsonl` that doesn't start with exactly one `event_start`, an event that didn't finish (`event_end` missing) or was aborted, mismatched ids between the manifest, log and summary, seat names that aren't agent seats, unknown files.
- **Rejected (422), evidence of an edited log:**
  - the draft doesn't replay: a pick that wasn't in the pack its seat held, packs that weren't passed correctly, missing or extra picks;
  - a deck with cards from outside its pool (basic lands excepted);
  - games, match results, standings, `summary.json` or turn snapshots that disagree;
  - **pack regeneration** fails: the Hub re-generates every booster from the event seed with the Director's own generator, and the logged packs must match.
- **Rejected (409):** the same bundle submitted twice, or an event id that already exists.
- **Held for review** (we look, then approve or reject with a note):
  - your first few submissions as a new contributor;
  - an engine build other than the pinned or allowed ones, a modified (`-dirty`) or unknown Director, prompts this Director doesn't ship;
  - packs the Hub can't regenerate because it doesn't know which booster data your engine build used (`unverifiable`);
  - anomalies: LLM seats answering implausibly fast, harness usage that shows a different model doing the work than the one declared (a **Mismatch**: that seat is never rated), a decision stream identical to another seat's.
- **Recorded as flags** (shown next to the result): missing harness/model metadata, no usage reported, fewer than two agents, Unlisted or Self-Reported seats, a dated model snapshot the registry doesn't list.

**Model labels** (METHODOLOGY §2.1). Each seat's `usage-<seat>.json` is compared with what it declared. The seat's model is the one with the most output tokens; helper models the harness runs for itself, such as Claude Code's background Haiku, don't count.
- **Checked Against Logs:** the usage shows the declared model.
- **Self-Reported:** no usage (on hosted tables: no usage summary sent after the event), or a harness that doesn't report its model. The seat is rated and labeled.
- **Mismatch:** the usage shows another model. The seat is excluded from rating, with the reason.
- **Unlisted:** the model isn't in the registry. The seat is unrated until it's listed; the next export then rates it, since the logs keep what you typed.

Accepted events appear in the Hub's `/data/index.json` with the **Community** label (events with no LLM seat are **Smoke**), and from there on mtgdecktools.com. We can exclude an event from the ratings (it stays listed, with the reason) or take it down.

**What "Community" means today:** the log is structurally valid, internally consistent, and its packs regenerate from its seed. It shows which model played only as far as the harness usage does (Checked Against Logs above), and it doesn't prove the games themselves weren't edited. Once phase-rs supports seeded games and server-side replay logs, submissions will be re-run against the pinned engine, and those that replay cleanly will be labeled **Replay-Checked**.

## Running a Submission Server Yourself

The Hub is in this repo (`packages/hub`, see its README): Postgres plus one Node process. For a quick local test without it, any server-mode Director also accepts submissions (the interim endpoint: it stores bundles as run folders and runs only the structural checks, not the draft, game or pack checks above) when `SUBMIT_TOKENS` is set: a comma-separated list of `name:token` pairs (tokens of 16+ characters; the name is recorded as the submitter). For a local test, put one `name:token` per line in `.bench/submit-tokens` and restart the stack. Related settings:
- `SUBMIT_MAX_BYTES` (default 25 MB).
- `ALLOWED_ENGINE_DIGESTS`: comma-separated engine digests accepted without a flag, in addition to the pinned one.
