# Matchmaking Lobby

_Contract v1, 2026-10-22. Implemented in the Director (`packages/director/src/lobby*.ts`). The mtgdecktools.com site builds its lobby pages from the public API in §4; that section is a stable contract (additive changes only, breaking changes bump `api_version`)._

## 1. Why There Is a Lobby

Every event seats **8 agents**. There are no bot drafters in product events (METHODOLOGY §3). Two kinds of table, in the words the CLI, the setup prompt and the site use:
- **Private Table:** "You bring all 8 agents and play right away; repeat models as you like." (`bench setup --private`, or `bench new` with 8 seats.)
- **Join the Lobby:** "Bring 1–4 agents; we seat you with other people's agents and start when 8 are ready."

Either can be played once (**Play One Table**) or over and over (**Keep Playing**, §2.4). How the lobby works:

1. You join a public **queue** for one exact set of conditions (set, knowledge level, mana mode; the Director's current prompts are implied). Every table plays best of 3 with sideboarding, so the best-of is not a condition you choose. A queue is one comparability group (METHODOLOGY §3) on one set, so every lobby table is directly comparable with every other table from the same queue.
2. Your CLI holds your place with a cheap long-poll. **Waiting costs no model tokens**: no harness or LLM runs until your table fires.
3. When 8 seats are present, every holder gets a short **ready check**. A running CLI confirms on its own. Seats that miss it drop out, the next queued seats backfill, and the table checks again.
4. When 8 seats have confirmed, the table **fires**: the Director creates an 8-seat event (random seed, seat positions shuffled by the server), it passes through normal admission control, and each holder's CLI launches its own harness sessions on its own machine and subscription. As at a Private Table, each game starts a fresh agent session to keep costs down (§3, "Sessions").
5. The event plays a **3-round Swiss** (each seat plays 3 best-of-3 matches, with sideboarding between games), like a real draft pod. The results go to the Hub and the leaderboard like any hosted event (label Hosted).

**Scheduled tables** gather the community at a fixed time (for example a weekly FRA draft) so small communities don't wait forever.

## 2. Concepts

| Term | Meaning |
|---|---|
| **Queue** | Open waiting list for one condition set. Key `<set>-<knowledge>-<mana>`, e.g. `fra-primer-manual` (`primer+stats` is written `primer-stats`). Created on first join; admins can feature queues so they always show, even when empty. Keys from before best of 1 was removed still work: one ending in `-bo3` (an old invite link, featured list or schedule) is the same queue (`fra-primer-manual-bo3` is `fra-primer-manual`), and one ending in `-bo1` is refused with `Best of 1 was removed: Agent Bench plays best of 3 with sideboarding.` |
| **Entry** | One seat waiting in a queue: harness, model, effort, contributor. |
| **Ticket** | What one `join` returns: a secret (32 hex characters) that holds 1–4 entries. The CLI polls it. Treat it like a seat URL: whoever has it can confirm or leave for you. |
| **Present** | An entry whose ticket was polled in the last 2 minutes (`LOBBY_PRESENCE_S`). Only present entries count toward filling a table. Entries that aren't present keep their place until they expire. |
| **Forming table** | 8 entries selected for a ready check. |
| **Ready check** | Every ticket in a forming table confirms within `LOBBY_READY_S` (default 60 s). |
| **Table** | A fired lobby table: one event on the Director. |
| **Private Table** | An event whose 8 seats all belong to one contributor (`bench new`, `POST /api/events`). Not part of the lobby, but it counts in contribution stats. |
| **Scheduled table** | An admin-configured time: a separate queue that takes sign-ups ahead of time and fires only from `starts_at` on. |

### 2.1 Rules

- **8 agent seats per table.** No bots.
- **Seat cap per contributor:** at most 4 seats of any one contributor at one public table (`LOBBY_MAX_SEATS_PER_CONTRIBUTOR`). Holding more entries is fine: they go to the next table. A contributor may hold at most 8 entries across all queues (`LOBBY_MAX_ENTRIES`).
- **Order.** Entries fill tables first come, first served. The exception is contributors with poor **reliability** (below 0.7 over at least 5 finished-or-abandoned seats, `LOBBY_LOW_RELIABILITY`): their entries wait behind everyone else's and they may hold one entry at a time.
- **Missed ready checks.** A ticket that misses a ready check leaves the queue with all its entries. Three misses in 24 hours put the contributor on a 1-hour cooldown (`LOBBY_MISS_COOLDOWN_MIN`).
- **Expiry.** Entries expire 24 hours after joining (`LOBBY_ENTRY_TTL_HOURS`). The ticket then says so, and `bench lobby join` prints it before it stops: "Your 2 seats waited 24 hours without a full table and left the queue (nothing ran, no tokens were used). To keep waiting, join again: `… lobby join --queue fra-primer-manual --seat …`". Leave at any time with `bench lobby leave` or `DELETE /api/lobby/tickets/<ticket>`.
- **Seat positions** are shuffled by the server from the event's secret seed. Nobody chooses a seat, and agents never learn who sits where or which models are at their table.
- **Identity.** Every seat declares harness, model and an **explicit reasoning effort** (`low`, `medium`, `high`, … as the model offers; `default`, `unknown` or a missing effort are refused, so every seat's identity is exact). They are resolved to canonical ids (the model registry, §8). Unknown or unlisted models are refused. Declarations are self-reported and recorded as such in the event log (`seat_meta: "self-reported"`).
- **No scripted seats.** Scripted test seats (`script`) are refused in public queues (`400`): they would spend the other players' tokens on games that are never rated. Use a Private Table to test. `LOBBY_ALLOW_SCRIPT=1` allows them on a development Director (the lobby end-to-end tests). Scripted seats never count toward a contributor's seats, tables or reliability, at a lobby table or a Private Table.
- **The lobby has its own quota.** A fired table counts as one lobby table for every contributor seated at it, against their **lobby** quota: 2 lobby tables at a time and 12 a day by default (`HUB_LOBBY_CONCURRENT`, `HUB_LOBBY_DAILY` on the Hub; per contributor with `hub contributor quota <handle> --lobby-concurrent N --lobby-daily N`). It is counted separately from Private Tables (1 at a time and 6 a day, `HUB_PLAY_CONCURRENT`, `HUB_PLAY_DAILY`): a Private Table never holds up your lobby seats, and lobby tables never use up your Private Tables. A contributor whose lobby limit is in use (two lobby tables of theirs are running) keeps their place, and their seats join a table once one ends; the ticket says so. Once the daily lobby quota is spent, `join` answers `429` with `Retry-After`. A Director whose Hub sends no lobby quotas uses its own defaults (`LOBBY_CONTRIB_CONCURRENT` 2, `LOBBY_CONTRIB_DAILY` 12). Quotas are per person; capacity is shared: every fired table still passes the Director's admission control (§2.3).
- **Join rate.** At most 20 joins per contributor an hour (`LOBBY_MAX_JOINS_PER_HOUR`; `429` with `Retry-After`), and at most 2,000 waiting entries in all (`LOBBY_MAX_ACTIVE_ENTRIES`; `503`). Keep one `bench lobby join` running rather than joining again.
- **Sets.** Public queues are open for the featured sets (`sets/rotation.json`, `featured` in `GET /api/sets`) and for any set an admin features or schedules, so players concentrate instead of spreading over 175 sets. `LOBBY_ANY_SET=1` opens every hosted set. Other sets are played as Private Tables.
- **Contributors** need a contributor token from GitHub sign-in on the Hub (`bench login`). The hosted Hub only issues those to GitHub accounts at least 30 days old (`HUB_GITHUB_MIN_ACCOUNT_DAYS`: 30 in the hosted deployment, off by default in a Hub you run yourself).
- **Handles** are shown publicly unless you opt out (`--hide-handle`, `"show_handle": false`). The Leaderboard Visibility setting on your Hub account page wins over that choice: **Hide** hides you in the lobby too, **Show** shows you, and **Follow My Lobby Choice** uses `--hide-handle`. The Director reads the setting with every authenticated request and for everyone it knows every 5 minutes (`POST /api/internal/contributors/visibility` on the Hub), so hiding on the Hub takes effect in the lobby within minutes. Hidden contributors appear as "Anonymous Contributor" and have no public stats page; their seats still count toward model stats. Event logs written while you are hidden carry no handle (lobby seats, and the organizer of your Private Tables); logs written earlier keep the handle they were written with.

### 2.2 Mid-Event Drop-Outs

The existing inactivity watchdog handles them (METHODOLOGY §5.5). A seat silent for 10 minutes with a decision open has its picks made by the bot policy, its deck built by the reference builder, and its open games conceded. Those games count as losses for it in the rating (METHODOLOGY §5.5). The seat counts as **abandoned** in its contributor's reliability. A seat that played to the end without a forfeit counts as **finished**. Events stopped by the server (restart failures, maximum duration) count for nobody.

### 2.3 Capacity, Restarts and Deploys

- A fired table goes through normal admission control (`MAX_CONCURRENT_GAMES`; an 8-seat table holds 4 game slots). If the worker is full, the event waits in the Director's FIFO queue and every holder sees `queue_position`. Seat URLs work at once; agents are told to keep waiting.
- **Keep Playing never starves the lobby.** A contributor's Private Table created by a Keep Playing loop (`POST /api/events` with `"continuous": true`; logged as `event_start.table.continuous`) is admitted under stricter rules (`packages/director/src/admission.ts`):
  - it never starts ahead of a waiting lobby table or one-off table: those skip ahead of queued continuous tables in the queue;
  - it starts only while `load + 4 + CONTINUOUS_RESERVE_SLOTS <= MAX_CONCURRENT_GAMES` (default 8 slots, two lobby tables' worth, left free; never more than the capacity left after the table itself);
  - each contributor has at most `CONTINUOUS_PER_CONTRIBUTOR` (default 1) continuous tables running or queued (`429` otherwise);
  - it counts toward the contributor's daily Private Table quota like any other Private Table (`HUB_PLAY_DAILY`, default 6 a day), so Keep Playing on a hosted Private Table plays at most that many tables a day unless the quota is raised. Keep Playing in the lobby counts toward the lobby quota instead (12 a day).
  - `GET /api/capacity` reports `continuous: { running, queued, reserve, per_contributor }`. A continuous table still waiting after `QUEUE_MAX_WAIT_HOURS` is dropped like any queued event; the loop backs off and tries again.
- **Durability.** Lobby state (entries, tickets as sha256 hashes, forming tables, fired tables, stats, schedules) lives in the Director's private store, `<RUNS_DIR>/.lobby/state.json` (mode 600, atomic writes: a temp file, then a rename). It survives restarts. Ready checks that were in progress are restarted with a fresh window. Legacy queue keys in a state file (ending in `-bo3`) become the current key at start; best-of-1 entries end with a notice. Writes are batched (at most one a second, written asynchronously off the request path; a synchronous write on shutdown), and the state stays small: left, expired and dropped entries and their tickets are forgotten 10 minutes after they end, seated entries after a day.
- **Draining** (`deploy/deploy.sh --drain`, `POST /api/admin/drain`). The lobby forms no tables and fires nothing while the Director drains. Forming tables dissolve: confirmed entries go back to the front of their queue. Holders see `"paused": true`. Nothing is lost; the CLI keeps polling through the restart.

### 2.4 Keep Playing

`bench setup` asks **Play One Table** or **Keep Playing**. Keep Playing runs a loop in the background on the contributor's machine (`scripts/bench/loop.ts`): a new table as soon as one finishes, until `bench stop <loop id>` or a limit (tables, hours, tokens, dollars). In the lobby, each new table is a new `lobby join` with the same seats: they rejoin at the **back** of the queue, and every lobby rule above applies (at most 4 seats per table, 8 entries, ready checks, reliability). The server needs nothing special for lobby rejoins. Before each table the loop re-runs the harness preflight and stops if a harness stopped answering; errors back off (1, 2, 4 … 30 minutes) and five in a row stop it.

### 2.5 Hosted Configuration

What the hosted Director runs is committed, not set by hand: `deploy/lobby.json` ships in the image, and `deploy/compose.yaml` points the Director at it with `LOBBY_CONFIG=/app/deploy/lobby.json` and `LOBBY_CONFIG_APPLY=always`, so the file replaces the featured queues and schedules at every start (§6). Change it with a commit and a deploy; an admin `PUT /api/admin/lobby/config` lasts until the next start.

- **Featured queue:** one, the main condition (Set Context · Manual Mana) of the newest featured set, the first in `sets/rotation.json` (now `fra-primer-manual`). It always shows in `GET /api/lobby`, even empty, so contributors gather at one table instead of spreading over eight. The other featured sets stay joinable in any condition (`bench lobby join --queue sos-primer-manual …`) and show once someone waits; any set at all can be played as a Private Table. Every table the main condition fires lands on the headline board. A unit test (`lobby.test.ts`) fails when `deploy/lobby.json` doesn't feature the first set in the rotation, so a new set updates both.
- **Scheduled tables:** none right now. A weekly table helps once there are enough regular contributors to fill 8 seats at one time; until then the queues fill from whoever is around, and waiting costs nothing. To add one, put an entry in `schedules` in `deploy/lobby.json` (§6 has the format) and deploy.

## 3. CLI

```bash
npm run bench -- login                                    # once: GitHub sign-in, saves a contributor token
npm run bench -- lobby list                               # open queues, scheduled tables, recent tables
npm run bench -- lobby join --set fra --seat claude-code/claude-opus-5-5/high
npm run bench -- lobby join --queue fra-primer-manual --seat codex/gpt-6-astra/medium --seat claude-code/claude-sonnet-5-5/high
npm run bench -- lobby join --schedule fra-weekly --seat claude-code/claude-opus-5-5/high --notify
npm run bench -- lobby status                             # your tickets
npm run bench -- lobby leave [ticket]                     # leave (all your waiting entries by default)
```

`lobby join` holds the place in the foreground (or in the background with `--detach`, logging to a `runs/lobby-<timestamp>.log` file whose path it prints). It:
- polls the ticket (long-poll, about 40 s per request, no tokens spent);
- confirms ready checks on its own (`--no-auto-confirm` asks on the terminal instead);
- when the table fires, writes `runs/<event>/event.json` (your seats only) and starts your seats with `bench play <event>`, the same headless launcher as everywhere else (`--no-launch` prints the seat URLs to seat by hand instead);
- keeps going for the rest of your entries when you queued more seats than one table takes.
- for **Keep Playing** (`bench setup --lobby --keep-playing`), a background loop runs `lobby join` again with the same seats after each table (§2.4); `bench status <loop id>` and `bench stop <loop id> [--now]` follow and stop it. A graceful stop leaves the queue at once if your seats are still waiting, and otherwise lets the current table finish. `--now` stops your seats at a running table: the watchdog forfeits them and they count as abandoned.

Options: `--knowledge none|primer|primer+stats` (default `primer`), `--mana manual|auto` (default `manual`), `--hide-handle`, `--notify` (a desktop notification when the table fires, when its games begin and when it ends), `--webhook <https-url>` (the CLI POSTs the same notifications as JSON; the server never calls out), `--director <url>`, `--fresh-session per-game|per-match|off` (below). Every table plays best of 3 with sideboarding; `--best-of 3` is still accepted so older command lines work, and any other value is refused.

**Sessions.** Lobby seats get the same context policy as Private Tables (docs/HARNESSES.md "Fresh sessions"). The model seats `lobby join` starts get a fresh agent session per game by default (`--fresh-session per-game`): `bench play` ends the seat's session when its deck is locked and after every game, and starts a fresh one; every decision carries the full board and match history. `--fresh-session per-match` starts one after every match instead; `--fresh-session off` keeps one session. Seats you seat by hand (`--no-launch`, or a harness the CLI can't start or that isn't installed) keep their own session and record none. Scripted test seats keep one session unless `--fresh-session` is given. The policy is declared with each seat when you join (§5.1), kept with your ticket, and recorded per seat in the fired table's `event_start.seats[].context_policy`, exactly as at a Private Table. When the table fires, the CLI starts only seats whose recorded policy is the one you joined with. `bench setup --lobby` and Keep Playing pass the same choice on. A Director that doesn't record policies yet (no `context_policy` on the join answer's entries) gets the note "this Director doesn't record context policies yet" and your seats keep one session each.

## 4. Public API (Read-Only, for the Site)

Base: the Director, `https://bench.mtgdecktools.com`. All public responses:
- are JSON with `Access-Control-Allow-Origin: *`;
- are cached for 5 seconds on the server and send `Cache-Control: public, max-age=5` (stats: 60 s);
- are rate limited per client IP (shared with the rest of `/api`, 120 requests/minute by default; `429` with `Retry-After`);
- carry no secrets, contributor ids, IP addresses or tokens. Contributor handles appear only for contributors who allow it (`contributor: null` otherwise).

Timestamps are ISO 8601 UTC strings. Durations are seconds. Every response has `api_version: 1`.

### 4.1 `GET /api/lobby`

Everything the lobby page needs in one request.

```json
{
 "api_version": 1,
 "generated_at": "2026-10-22T18:00:05Z",
 "director": {
  "url": "https://bench.mtgdecktools.com",
  "prompt_version": "v5",
  "paused": false,
  "capacity": { "capacity": 30, "load": 8, "running": 2, "queued": 0 }
 },
 "policy": {
  "seats_per_table": 8,
  "max_seats_per_contributor": 4,
  "ready_window_s": 60,
  "entry_ttl_hours": 24,
  "format": { "pairing": "swiss", "rounds": 3 }
 },
 "queues": [
  {
   "key": "fra-primer-manual",
   "set": "FRA",
   "set_name": "Reality Fracture",
   "knowledge": "primer",
   "knowledge_label": "Set Context",
   "mana": "manual",
   "best_of": 3,
   "prompt_version": "v5",
   "group": "kn=primer;mana=manual;prompt=v5",
   "featured": true,
   "schedule": null,
   "not_in_packs": ["Command the Stage", "Jace's Machinations", "Loot, the Anomaly"],
   "seats_per_table": 8,
   "seats_filled": 6,
   "seats_needed": 2,
   "seats_away": 1,
   "status": "waiting",
   "oldest_wait_s": 5400,
   "seats": [
    { "model_id": "claude-opus-5-5", "model_display": "Claude Opus 5.5", "harness_id": "claude-code", "harness_display": "Claude Code", "effort": "high", "effort_display": "High", "identity_key": "claude-opus-5-5/high", "identity_label": "Claude Opus 5.5 · High", "contributor": "grpace", "waiting_since": "2026-10-22T16:30:00Z", "status": "waiting" },
    { "model_id": "gpt-6-astra", "model_display": "GPT-6 Astra", "harness_id": "codex", "harness_display": "Codex CLI", "effort": "medium", "effort_display": "Medium", "identity_key": "gpt-6-astra/medium", "identity_label": "GPT-6 Astra · Medium", "contributor": null, "waiting_since": "2026-10-22T17:10:00Z", "status": "waiting" }
   ],
   "forming": [],
   "invite_url": "https://www.mtgdecktools.com/agent-bench/lobby/fra-primer-manual",
   "join_command": "npm --prefix ~/mtgdt-bench run -s bench -- lobby join --queue fra-primer-manual --seat <harness>/<model>/<effort>"
  }
 ],
 "scheduled": [
  {
   "id": "fra-weekly",
   "occurrence": "fra-weekly-20261029",
   "name": "Weekly FRA Draft",
   "queue": "fra-primer-manual",
   "starts_at": "2026-10-29T18:00:00Z",
   "signup_opens_at": "2026-10-27T18:00:00Z",
   "closes_at": "2026-10-29T20:00:00Z",
   "state": "signup",
   "rsvps": 5,
   "seats_present": 2,
   "tables_fired": 0,
   "invite_url": "https://www.mtgdecktools.com/agent-bench/lobby/scheduled/fra-weekly",
   "join_command": "npm --prefix ~/mtgdt-bench run -s bench -- lobby join --schedule fra-weekly --seat <harness>/<model>/<effort>"
  }
 ],
 "recent": [
  {
   "table_id": "t-7f3a9c2e",
   "event_id": "2026-10-22-17-40-02-fra-1c2d",
   "queue": "fra-primer-manual",
   "kind": "lobby",
   "fired_at": "2026-10-22T17:40:02Z",
   "stage": "games",
   "queue_position": null,
   "contributors": 4,
   "seats": [],
   "seats_listed": "when the event ends",
   "status_url": "https://bench.mtgdecktools.com/api/events/2026-10-22-17-40-02-fra-1c2d",
   "live_url": "https://bench.mtgdecktools.com/api/events/2026-10-22-17-40-02-fra-1c2d/live",
   "watch_url": "https://www.mtgdecktools.com/agent-bench/watch/2026-10-22-17-40-02-fra-1c2d/live"
  }
 ]
}
```

Field notes:
- `queues`: featured queues plus every queue with at least one entry. Featured first, then by `seats_filled` (descending).
- `seats_filled`: present entries waiting in the queue (0–8), the "6/8" number. `seats_needed`: how many more seats it takes to form a table, **counting the per-contributor and same-setup caps** (§10). `seats_away`: entries whose holder isn't polling right now; they don't count until they come back.
- `status`: `waiting` (fewer than 8 present), `ready_check` (a table is forming), `paused` (the Director is draining for a restart), `scheduled` (a scheduled queue before `starts_at`).
- `seats[].status`: `waiting`, `ready_check` (in a forming table, not confirmed), `confirmed`. Order: queue order.
- `forming`: tables in a ready check: `[{ "table_id", "confirmed": 5, "seats": 8, "deadline": "…" }]`.
- `recent`: the last 20 fired tables (lobby and Private Tables, including the operator's own Private Tables created with the admin token, which have `contributors: 0` and never count in contribution stats; tables of scripted seats only are left out), newest first. `stage`: `queued` (waiting for capacity, with `queue_position`), `draft`, `build`, `games`, `done`, `aborted`. `watch_url` is the site's watch page; `live_url` the spectator stream (docs/SPECTATING.md: delays and redaction already applied). Once the event has ended, its seats are listed (seat objects as in `queues[].seats`, without `waiting_since` and `status`) in a canonical order (model, harness, effort), never in seat order. A table whose event is still running lists no seats (`seats: []`, `seats_listed: "when the event ends"`): while it plays, an agent with web tools could otherwise find its own table and learn its opponents' models. Seat names are neutral (`seat-<hex>`) at every table, lobby or Private Table, and never encode the model.
- `best_of`: always `3` (every table plays best of 3 with sideboarding). It stays in the view for older clients; queues and `group` don't split on it.
- `knowledge_label`: the display name (`No Set Knowledge`, `Set Context`, `Set Context + Human Stats`).
- **Every seat object** (queues, recent tables, tickets) carries the canonical identity, never free text: `model_id`, `model_display`, `harness_id`, `harness_display`, `effort`, `effort_display`, `identity_key` (`model/effort`, the leaderboard identity) and `identity_label` ("Claude Opus 5.5 · High"). Show `identity_label` wherever a seat is listed: the effort is part of who is playing.

### 4.2 `GET /api/lobby/queues/<key>`

One queue, the same object as in `queues[]`, plus `recent` (its last 10 fired tables). It works for any valid key, even an empty queue that has never been used (so an invite link always resolves). A legacy key ending in `-bo3` resolves to the same queue, and the answer's `key` is the current one. An unknown set or invalid key returns `404`; a key ending in `-bo1` returns `404` with `{ "error": "Best of 1 was removed: Agent Bench plays best of 3 with sideboarding." }`.

### 4.3 `GET /api/lobby/schedule`

`{ "api_version": 1, "scheduled": [ … ] }`: the next occurrence of every schedule, the same objects as `scheduled[]`, ordered by `starts_at`. `state`: `upcoming` (sign-ups not open yet), `signup` (sign-ups open, not started), `open` (started: fires whenever 8 are present), `closed` (window over; the remaining entries moved to the regular queue with their place kept).

### 4.4 `GET /api/lobby/stats`

Contribution stats for light gamification. Cached 60 s.

```json
{
 "api_version": 1,
 "generated_at": "2026-10-22T18:00:00Z",
 "totals": { "tables": 42, "seats": 336, "contributors": 51, "games": 1180 },
 "models": [
  {
   "model_id": "claude-opus-5-5",
   "model_display": "Claude Opus 5.5",
   "backers": 14,
   "seats": 61,
   "seats_finished": 58,
   "seats_abandoned": 3,
   "reliability": 0.951,
   "tables": 37,
   "games": 214,
   "harnesses": [ { "harness_id": "claude-code", "harness_display": "Claude Code", "seats": 55 }, { "harness_id": "opencode", "harness_display": "OpenCode", "seats": 6 } ],
   "last_played": "2026-10-22T17:40:02Z"
  }
 ],
 "contributors": [
  {
   "handle": "grpace",
   "tables": 9,
   "seats": 17,
   "seats_finished": 17,
   "seats_abandoned": 0,
   "reliability": 1,
   "games": 61,
   "models": ["claude-opus-5-5", "gpt-6-astra"],
   "first_seen": "2026-10-22T10:00:00Z",
   "last_played": "2026-10-22T17:40:02Z"
  }
 ]
}
```

- `backers`: distinct contributors who put at least one seat of this model at a table that fired (public and hidden contributors alike; only the count is shown).
- `reliability`: `seats_finished / (seats_finished + seats_abandoned)`; `null` below 3 such seats.
- `games`: finished games the seats played (forfeited ones included; rated or not).
- `contributors`: public handles only, ordered by `seats_finished`, at most 200.
- `seats`, `tables`: seats that fired at lobby tables and Private Tables. Queue time is not counted.

### 4.5 `GET /api/lobby/models/<model_id>` and `GET /api/lobby/contributors/<handle>`

One row from §4.4. A model row adds `contributors`: the public handles backing it (`[{ "handle", "seats" }]`, top 50) and `anonymous_backers` (a count). A contributor row adds `recent`: their last 20 tables (`table_id`, `event_id`, `fired_at`, `stage`, `kind`, their seats' `model_id`s, `watch_url`). `404` for an unknown model or a hidden or unknown contributor.

## 5. Contributor API (Token Required)

`Authorization: Bearer <contributor token>` (GitHub sign-in, `play` scope). `401` without a valid token with the `play` scope (the Hub reports other tokens as inactive), `503` when the Hub can't be reached to check it.

### 5.1 `POST /api/lobby/join`

```json
{
 "queue": "fra-primer-manual",
 "seats": [
  { "harness": "claude-code", "model": "claude-opus-5-5", "effort": "high" },
  { "harness": "codex", "model": "gpt-6-astra", "effort": "medium" }
 ],
 "show_handle": true
}
```

Instead of `queue`: `"set": "fra", "knowledge": "primer", "mana": "manual"` (same defaults as the CLI), or `"schedule": "fra-weekly"` (its next occurrence). `best_of` may be left out or given as `3`; anything else is refused (`1` with `Best of 1 was removed: Agent Bench plays best of 3 with sideboarding.`). A `queue` key ending in `-bo3` joins the same queue as the key without it; the answer's `queue` is the current key. 1–4 seats per join. A seat may add `"effort_basis": "launch"` (the CLI starts the seat with that effort) or `"self-report"` (seated by hand); it is logged with the seat (METHODOLOGY §2.2). `bench lobby join` sends `launch` unless `--no-launch`.

A seat may also add `"context_policy"`: `"fresh-per-game"` or `"fresh-per-match"` (its launcher starts a fresh harness session at those boundaries, docs/PROTOCOL.md §6), or `"harness"` (one conversation; the same as leaving it out). Any other value is a `400`. It is a launch condition, not identity. Seats with different policies share queues and tables, and the public API (§4) never shows it. The holder sees it on the ticket (§5.2), and the fired table logs it per seat in `event_start` (export `SeatRef.context_policy`). `bench lobby join` sends it for the seats it starts (§3, "Sessions").

`201`:

```json
{
 "api_version": 1,
 "ticket": "5d0c8e…(32 hex)",
 "poll_url": "https://bench.mtgdecktools.com/api/lobby/tickets/5d0c8e…",
 "queue": "fra-primer-manual",
 "schedule": null,
 "expires_at": "2026-10-23T18:00:05Z",
 "entries": [
  { "entry_id": "e-91ac04d2", "status": "waiting", "position": 7, "model_id": "claude-opus-5-5", "model_display": "Claude Opus 5.5", "harness_id": "claude-code", "harness_display": "Claude Code", "effort": "high", "effort_display": "High", "identity_key": "claude-opus-5-5/high", "identity_label": "Claude Opus 5.5 · High", "context_policy": "fresh-per-game" }
 ]
}
```

`show_handle` is the lobby choice; the Hub's Leaderboard Visibility setting, when set, wins over it (§2.1).

Errors (`{ "error": "…" }`): `400` invalid seats (none, or more than 4 in one join), unknown or unlisted model or harness, a missing or `default` effort, an unknown `context_policy`, a scripted test seat, unknown set, a set without a public queue, invalid key, a `best_of` other than 3 or a queue key ending in `-bo1` (`Best of 1 was removed: Agent Bench plays best of 3 with sideboarding.`); `403` an admin token, or a contributor token not from GitHub sign-in; `409` the per-contributor limits (more than 4 seats in this queue, more than 8 entries in all) or a cooldown (`Retry-After`); `429` more than 20 joins in an hour, or the daily lobby quota is spent (`Retry-After`); `503` paused (draining), the lobby is full, or the Hub is unreachable.

### 5.2 `GET /api/lobby/tickets/<ticket>?wait=40&rev=<n>`

The holder's view, and the long-poll that keeps entries present. With `rev`, it returns as soon as the state changes from that revision, or after `wait` seconds (at most 40). Without it, it returns at once.

```json
{
 "api_version": 1,
 "rev": 14,
 "state": "ready_check",
 "paused": false,
 "message": "Your table is full. Confirm within 52 s to take your seat.",
 "queue": { "key": "fra-primer-manual", "seats_filled": 8, "seats_needed": 0 },
 "ready_check": { "table_id": "t-7f3a9c2e", "deadline": "2026-10-22T17:41:00Z", "confirmed": false },
 "entries": [
  { "entry_id": "e-91ac04d2", "status": "ready_check", "table_id": "t-7f3a9c2e", "position": null, "model_id": "claude-opus-5-5", "model_display": "Claude Opus 5.5", "harness_id": "claude-code", "harness_display": "Claude Code", "effort": "high", "context_policy": "fresh-per-game" },
  { "entry_id": "e-0b77e1aa", "status": "waiting", "table_id": null, "position": 2, "model_id": "gpt-6-astra", "model_display": "GPT-6 Astra", "harness_id": "codex", "harness_display": "Codex CLI", "effort": "medium", "effort_display": "Medium", "identity_key": "gpt-6-astra/medium", "identity_label": "GPT-6 Astra · Medium", "context_policy": "harness" }
 ],
 "tables": [
  {
   "table_id": "t-11d2e0f4",
   "event_id": "2026-10-22-17-40-02-fra-1c2d",
   "stage": "queued",
   "queue_position": 2,
   "seats": { "seat-3fa0c1": { "entry_id": "e-55aa…", "url": "https://bench.mtgdecktools.com/mcp/<seat token>", "harness": "claude-code", "model": "claude-opus-5-5", "effort": "high", "context_policy": "fresh-per-game" } },
   "status_url": "https://bench.mtgdecktools.com/api/events/2026-10-22-17-40-02-fra-1c2d",
   "live_url": "https://bench.mtgdecktools.com/api/events/2026-10-22-17-40-02-fra-1c2d/live"
  }
 ],
 "expires_at": "2026-10-23T18:00:05Z"
}
```

- `state`: the most urgent across the ticket's entries: `ready_check` (confirm now) > `confirmed` (you confirmed; waiting for the other holders) > `starting` (the table's event is being created) > `seated` (a table is playing; see `tables`) > `waiting` > `done` (nothing left: all entries seated and finished, left, expired or dropped).
- `notice`: something the holder should know, when there is one (a table that couldn't start, a missed ready check).
- `entries[].status`: `waiting`, `ready_check`, `confirmed`, `seated`, `left`, `expired`, `dropped` (missed a ready check).
- `tables[].seats`: **only this ticket's seats**, with their MCP URLs (secret). These are the URLs the harness sessions connect to.
- `entries[].context_policy` and `tables[].seats.*.context_policy`: the seat's declared context policy, `harness` when none (§5.1). Only the holder sees it.
- `404` for an unknown ticket (or one whose entries have all ended more than 24 hours ago).

### 5.3 `POST /api/lobby/tickets/<ticket>/confirm`

Body `{ "table_id": "t-7f3a9c2e" }` → `200` with the ticket view. `409` when the ready check is over (the view says what happened).

### 5.4 `DELETE /api/lobby/tickets/<ticket>` and `DELETE /api/lobby/tickets/<ticket>/entries/<entry_id>`

Leave: every waiting or ready-check entry of the ticket, or one entry. Seated entries are unaffected; they belong to a running event (stop a seat by stopping its harness: the watchdog takes over). `200` with the ticket view.

## 6. Admin API (Admin Token)

- `GET /api/admin/lobby`: the full state (entries with contributor ids, tickets by hash prefix, forming tables, fired tables, schedules, config).
- `PUT /api/admin/lobby/config`: replace the featured queues and the schedules. The body is validated and persisted, and takes effect at once:

```json
{
 "featured": ["fra-primer-manual", "tla-primer-manual"],
 "schedules": [
  {
   "id": "fra-weekly",
   "name": "Weekly FRA Draft",
   "queue": "fra-primer-manual",
   "weekly": { "day": "thu", "time": "18:00" },
   "signup_hours": 48,
   "window_minutes": 120
  },
  { "id": "launch-night", "name": "Launch Night", "queue": "fra-primer-manual", "at": "2026-10-30T19:00:00Z", "signup_hours": 168, "window_minutes": 180 }
 ]
}
```

Times are UTC (`weekly.time` is `HH:MM` UTC; the site shows local time). `LOBBY_CONFIG` (a JSON file path with the same `featured` and `schedules`) seeds the config at the first start, when no state exists yet; with `LOBBY_CONFIG_APPLY=always` it replaces them at every start instead (the hosted stack, §2.5). An invalid file is logged and changes nothing. Queue keys ending in `-bo3` are stored without the suffix; a key ending in `-bo1` is refused (`400`).

- `DELETE /api/admin/lobby/entries/<entry_id>`: remove an entry (moderation).

## 7. Fairness and Integrity

**What the lobby enforces:**
- Seat positions come from the event seed (secret until the event ends). The Swiss pairings are a deterministic function of the seed, the seats' declared identities and the match results. The Hub regenerates and checks them (METHODOLOGY §3.1).
- At most 4 of the 8 seats belong to one contributor, so every lobby table has at least two contributors. Contributor tokens come from GitHub accounts at least 30 days old.
- The event log records per-seat provenance in `event_start.seats[]`: `contributor_id` (the Hub's id, opaque), `contributor` (the handle, only when public), `harness`, `model`, `effort` (canonical ids), plus `event_start.table` (`kind: "lobby" | "private"`, `queue`, `table_id`, `schedule`).
- Swiss pairing avoids, in priority order: rematches, two seats of the same identity (their games wouldn't be rated), two seats of the same contributor.

**Collusion, the mitigations and the residual risk:**

| Threat | Mitigation | Residual risk |
|---|---|---|
| **Hate-drafting or feeding** (a contributor's agents pass good cards to a friendly seat, or take cards to starve a rival). | Seats are shuffled from a secret seed, and agents never see seat owners, names or models. An agent can't tell which neighbor is "friendly". At most 4 of 8 seats belong to one contributor. Agents must use the standard join prompt (fairness rules, docs/COMMUNITY.md). | A contributor who modifies their harness could tell their agents to draft a fixed, unusual pattern that their other seats recognize. That is covert signaling through picks: hard to set up, weak with random positions, and visible as picks far off the expert model (the draft metrics, [METHODOLOGY.md](METHODOLOGY.md)) and as decision streams the Hub flags. Not prevented outright. |
| **Throwing games** to a friendly seat (conceding on purpose to lift a model's rating). | Among pairings equally good on records, the Swiss avoids pairing two seats of the same contributor, and same-identity games are never rated. Conceded and forfeited games are flagged (`end_reason`, `forfeited_by`); a watchdog forfeit is rated as a loss for the silent seat, like a concession. | When pairing can't avoid it (records come before contributors), a same-contributor match is played and rated. Its games are marked by the seats' `contributor_id`, so analyses can exclude them. A throw against an unrelated seat only gifts rating to a stranger. |
| **Sybil accounts** (one person, several GitHub accounts, to get around the 4-seat cap). | GitHub accounts must be 30+ days old; one token family per account; tokens can be revoked; each account's lobby tables count toward its lobby quota. | Several aged accounts would work. Hub anomaly checks (identical decision streams, latency profiles) and review are the backstop. Possible later: a per-IP cap on seats at one table. |
| **Queue selection** (joining queues with weaker models to farm rating). | The rating models opponent strength (Bradley–Terry), so beating weak opponents gains little. Queue contents are public, so selection is visible. | Small-sample noise only. |
| **Ready-check griefing** (joining and never confirming to stall tables). | Present-only filling (a gone holder doesn't block), 60 s window, the ticket leaves on a miss, a cooldown after 3 misses. | A few minutes of delay at most. |
| **Abandoning mid-event.** | Watchdog forfeits (games conceded, unrated); reliability is public and lowers queue priority. | The table plays on with a passive seat; its opponents' games against it don't count. |

## 8. Model and Harness Identity

Seats declare `harness`, `model` and `effort`. The lobby resolves them through the shared model registry (`registry/models.json`, `registry/harnesses.json`, `packages/registry` `resolveSeat`), via one integration point, `packages/director/src/seat-identity.ts` (`resolveSeatIdentity` with `requireEffort`). Public APIs always return canonical ids plus display names (`model_id`, `model_display`, `harness_id`, `harness_display`, `effort`, `effort_display`, `identity_key`, `identity_label`), never free text. Unknown or unlisted models are refused with `400` and a suggestion; so are missing, `default` and `unknown` efforts. The effort scale is the registry's (`none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`), limited to what each model offers. A seat's context policy (§5.1) is not part of its identity: it never splits a queue and isn't shown publicly.

## 9. Lobby Pages on mtgdecktools.com

The site builds its lobby pages from the public API (§4); they poll `GET /api/lobby` every 10 to 15 seconds while the tab is visible.
- **Lobby** (`/agent-bench/lobby`): open tables (one per queue, with its conditions, how many seats it still needs and the join command), scheduled tables, and recent tables with a **Watch** link.
- **Queue** (`/agent-bench/lobby/<key>`): the invite-link target, with the queue's conditions, its seats, the join command and its recent tables.
- **Contributor** (`/agent-bench/contributors/<handle>`): built from the Hub's contributor file (points, rank, seats, tables, games, reliability, models, recent tables). Points and ranks live on the Hub's Contributors Leaderboard (rules in docs/COMMUNITY.md); the lobby API doesn't carry them.

The site sends no notifications: `bench lobby join --notify` and `--webhook` do.

## 10. What a Table Needs, and Diversity-Aware Filling

_Additive to `api_version: 1`._

**Why.** Only games between different setups (model + effort; the harness isn't part of a setup) are rated ([METHODOLOGY.md](METHODOLOGY.md)). The Swiss avoids pairing two seats of one setup, floating a seat to the next record group before the last round and only among equal records in the last round (pairing version 4), so it needs the table to have the mix: a table of four setups at 2 seats each rates all 12 of its matches in most pods (mean 11.5), 4 + 4 of one model at two levels a median 10 (mean 10.5), 6 + 2 only 6, and a setup with more than half the seats leaves at most `(8 − k)` rated matches a round. First come, first served filling lets six seats of one popular setup into one table, which rates half its games. The lobby exists to produce rated games, so it should prefer distinct setups.

**Filling (`fill`).**
- Candidates keep the usual priority order (reliable contributors first, then first come), the 4-seat cap per contributor and presence.
- First pass: at most `LOBBY_MAX_SAME_SETUP` seats of one setup at a forming table (default 4, half the table: about 10 of 12 matches rated at 4 + 4, 11 at 4 + four single seats; 2–3 rates more). An entry over the cap keeps its place and goes to the next table; later entries of other setups may be seated ahead of it.
- Second pass, so nobody waits forever: an entry the cap has held back for `LOBBY_SAME_SETUP_WAIT_MIN` (default 60) may fill a seat still open, up to 7 of one setup. A table of one setup only, which could rate nothing, never forms in the lobby (that is a Private Table).
- Backfill after a missed ready check uses the same rules. Pairings, seat shuffling and every other rule are unchanged.

**What the public API adds.** Each queue in `GET /api/lobby` (and `GET /api/lobby/queues/<key>`) gains `needs`, about the table it would form next from the seats present now:

```json
"needs": {
 "seats": 6, "missing": 2, "setups": 2, "max_same_setup": 4,
 "at_cap": [ { "identity_key": "claude-opus-5-5/high", "identity_label": "Claude Opus 5.5 · High", "seats": 4 } ],
 "held_back": 1,
 "rated_games": 26, "games": 29, "rated_matches": 11, "matches": 12,
 "text": "Needs 2 more seats, any setup other than Claude Opus 5.5 · High; then about 11 of 12 matches rated."
}
```

- `seats`: seats the next table would take now (setup and contributor caps applied); `missing`: seats still to come; `setups`: distinct setups among them.
- `at_cap`: setups already at `max_same_setup`: more seats of them wait for the next table. `held_back`: present entries waiting for that reason.
- `rated_matches` of `matches`, and `rated_games` of `games` (2.4 games a match): what the table would rate if the missing seats are new setups. The estimate runs the Director's own Swiss pairing over 200 fixed simulated pods and takes the median, cached per composition (`packages/director/src/rated-estimate.ts`); setup's "Rated games this table can produce" reads the same estimate. `text`: one plain sentence for the queue card ("Needs 2 more seats, any setup other than …; then about 11 of 12 matches rated.", or "Ready to form: 3 setups, about 10 of 12 matches rated."; "all 12" only when every simulated pod rates every match, "nearly all 12" when most do).
- `policy` gains `max_same_setup` and `same_setup_wait_min`. `seats_needed` counts the setup cap like the contributor cap.

**Most Needed.** The Director makes no Hub calls for this: a client can combine a queue's `needs` with the Hub's bounties (`GET <hub>/api/bounties`, which `bench check` and setup already use; docs/MULTI-PROVIDER.md) to say which seats a queue needs most.

**Ticket view.** An entry held back by the cap stays `waiting` with its position, and joins the next table (or this one after `same_setup_wait_min`).
