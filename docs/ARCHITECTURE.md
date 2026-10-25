# Architecture: backend, data and processes

_Updated 2026-10-22. §1–§5 describe the system as built; §6 is what runs on the hosted dev stack today; §8 is what is left._

## 1. Components and the principle behind them

The expensive part of an event is model tokens and seat time, and those belong to whoever brings the agents. The server never calls a model and holds no API keys: every seat is an agent in its contributor's own harness, connected over MCP. What we run centrally is light: the tables (rules engine and Director), the results service and the data.

```
 Contributors (many)                 MTG Deck Tools (central)                                Readers
 ┌────────────────────────┐  seats over MCP   ┌───────────────────────────────────────┐      ┌──────────────────┐
 │ their harnesses + tokens│ ───────────────▶ │ Hosted Director + phase-server         │      │ mtgdecktools.com │
 │ the bench CLI           │   (HTTPS)        │  (tables, lobby, live spectating)      │      │  /agent-bench    │
 └────────────────────────┘                   │        │ hand-off (service token)      │ JSON │                  │
 ┌────────────────────────┐   bundle upload   │        ▼                               │ ───▶ │ open data        │
 │ self-hosted Director    │ ───────────────▶ │ Hub API ──▶ Postgres (index, ratings)  │      │  (CC BY 4.0)     │
 │  + phase-server         │  (bench submit)  │   │      ──▶ bundle store (immutable)   │      └──────────────────┘
 │  (bench up)             │                  │   └──▶ JSON export /data, open data     │
 └────────────────────────┘                   └───────────────────────────────────────┘
```

- **phase-server** (upstream phase-rs image, pinned by digest in `engine/phase.lock.json`): the rules engine. Only the Director talks to it (docs/PROTOCOL.md §7).
- **Director** (`packages/director`): runs tables. It creates events, generates the boosters, runs the draft, deckbuilding, Swiss rounds of best-of-3 matches with sideboarding, translates engine states into seat decisions (docs/PROTOCOL.md), writes the event log, runs the matchmaking lobby (docs/LOBBY.md) and the live spectator stream (docs/SPECTATING.md), and hands finished events to the Hub.
- **Hub** (`packages/hub`, packages/hub/README.md): the single source of truth for results. Accounts and tokens (GitHub sign-in), submission intake and integrity checks, the immutable bundle store, the Postgres index, ratings and contributor points, the JSON export the site reads and the nightly open dataset (docs/OPEN-DATA.md).
- **Site export** (`packages/site`): the code that turns event logs into ratings, outcomes, diagnostics and the JSON tree (docs/SITE-DATA.md). The Hub runs it; `npm run site:data` runs it over local run folders.
- **Model registry** (`registry/`, resolver in `packages/registry`): the canonical model, harness and effort names every seat identity uses (registry/README.md).
- **bench CLI** (`scripts/bench`): what contributors run: setup, sign-in, seating agents, lobby, status, pulling logs, usage upload, bundles and submissions.
- **mtgdecktools.com `/agent-bench`**: the reader-facing site (a separate, closed-source repository). It reads finished events from the Hub's `/data` and live events from the Director.

Three ways a table runs:
1. **Hosted tables (the main rated path).** A Private Table or a lobby table on our hosted Director. Contributors bring the agents and pay for their tokens; we run the engine and write every log server-side. Finished events go to the Hub through the hand-off and are labeled **Hosted**.
2. **Self-hosted Directors.** `bench up` runs phase-server and a Director on the contributor's own machine (Docker or Podman). Results go to the Hub as bundles (`bench submit`), pass the integrity checks and are labeled **Community**. Central load per event is one upload plus one ingest.
3. **More hosted workers (later).** Today there is one hosted Director. More workers would each hand off with their own service token (§5, §8).

## 2. Capacity (measured)

Measured 2026-10-21 on a 16-core workstation with `scripts/load-test.sh`: N concurrent events, each an 8-seat draft plus a best-of-3 between two **scripted agents that answer instantly** (worst case; before sideboarding existed, which adds no engine work). No game-setup failures, retries or engine errors at any N.

| Concurrent events | Games | Wall time | Agent decisions/s | Director CPU (1 core = 100%) | Director RSS | phase-server CPU |
|---|---|---|---|---|---|---|
| 5 | 10 | 169 s | 9.0 | 31% (max 41%) | 476 MB | 275% |
| 15 | 38 | 399 s | 12.7 | 42% (max 65%) | 583 MB | 428% |
| 30 | 73 | 722 s | 15.0 | 41% (max 77%) | 580 MB | 799% |

**Rerun 2026-10-24** (phase-rs 0.116.0, the current format: 8 scripted seats per table, an 8-seat draft, a 3-round Swiss of best-of-3 matches with sideboarding; `scripts/load-test.sh`, 30-minute cap, same 16-core workstation). No game-setup failures, retries or engine errors:

| Concurrent tables | Games in 30 min | Agent decisions/s | Director CPU (1 core = 100%) | Director RSS | phase-server CPU | Seats finished |
|---|---|---|---|---|---|---|
| 7 | 189 | 15.4 | 93% (max 108%) | 619 MB | 979% (max 1158%) | 42 of 56 |
| 10 | 179 | 15.9 | 85% (max 106%) | 638 MB | 1040% (max 1140%) | 0 of 80 (all mid-event at the cap) |

- **Throughput is flat at about 16 decisions/s**: more tables share it, so each one runs slower (at 10, no table finished in 30 minutes). phase-server uses about 10 cores; the Director (one Node process) now sits near one full core, so it is the second limit, ahead of memory.
- **For LLM seats** (0.3–0.5 decisions/s per game), that is roughly **40 concurrent LLM games, about 10 full tables**, per worker; the admission limit (`capacity 30 game slots`) stays below it. Beyond that, add a worker or move phase-server to its own host.

- **phase-server is the bottleneck.** It saturates at about 15 agent decisions/s on about 8 cores (about 0.5 core-seconds per decision, including the auto-passes and full-state updates of about 200 KB to both seats). The Director stays under one core and about 600 MB.
- **LLM games are far lighter.** A real seat makes about 0.3–0.5 decisions/s per game (2–3 s of thinking each). One worker (Director + phase-server on about 8 cores) therefore handles roughly **30–40 concurrent LLM games**; phase-server's own default cap is 100 games.
- **On gr3g-server** (14 cores shared with other apps), plan for about 30 concurrent LLM games. Add workers, or move phase-server to its own host, beyond that.
- **Draft phases are cheap** (no engine work); deckbuilding is free.

## 3. Data model

**Raw layer (immutable, source of truth):** each event is a results bundle (`npm run bench -- bundle`, `bundle_version` 1; built by `packages/director/src/bundle.ts` for the CLI, `hub import` and the hand-off alike):
- `bundle.json` (manifest: event id, seats, sha256 of every file)
- `events.jsonl` (every pick, deck, decision with the text the agent saw, answer and note, turn snapshots, results, provenance)
- `summary.json`, `seats-meta.json`
- per-seat harness usage (`usage-<seat>.json`, usage-only transcripts). Hosted seats have no bundle upload; `bench play` / `bench attach-logs` send their usage summary to the Hub after the event (`POST /api/usage`), and the Hub writes it into the run folder as `usage-<seat>.json`.

The Hub keeps the **original bundle bytes**, content-addressed by sha256 (`bundles/<ab>/<sha256>.blob`), including rejected ones as evidence. The store is a directory behind a small `BundleStore` interface (put / get / has / purge), so S3 or R2 can replace it. Derived analysis inputs that aren't part of a bundle (`strength.json`, `draft-eval.json` from imports) are stored the same way and referenced from the submission. Ingestion is repeatable: `hub reingest` rebuilds every index row from the stored bundles.

**Index layer (Postgres, `packages/hub/migrations/`):** what the site and the ratings need, queryable across events. Plain SQL migrations (`001`–`007`, listed in packages/hub/README.md) run at startup under an advisory lock.

| Table | Key fields |
|---|---|
| `contributors` | id, handle, kind (`person`; `director` for a hosted Director's service account; `maintainers` for the admin and import account), status (active / suspended), trust (new / trusted), GitHub id, login and account date, hosted-play quotas, Leaderboard Visibility, session epoch |
| `tokens` | contributor, scope and scopes (`submit` for uploads, `play` for hosted events, `contributor` = both, from GitHub sign-in; `ingest` for hosted Directors), sha256 of the token, prefix, last used, revoked |
| `submissions` | contributor, via (upload / director / import), bundle sha256 (unique), event id, label, status (received → validated → ingested / held / rejected / withdrawn), reasons, full check report, review note |
| `events` | id, submission, label, set, seed, knowledge, mana, best-of, sideboarding, pod size, engine digest/version/protocol, Director version, prompt version, Set Context sha256 (`primer_sha256`), comparability group (null = unrated, with the reason, for example Early Test Data), pack regeneration result, exclusion |
| `seats` | event, name, kind, position, LLM, harness, model, model id, effort, seat identity, final colors, decision-stream fingerprint |
| `picks` | event, seat, pack/pick/overall, pack contents, pick, by, note, latency, context-eval fields (expert model p and rank, EV regret, in-lane, archetype regret, made the deck) |
| `decks` | event, seat, main/side, basics, by (agent/auto), colors, deck-strength results |
| `games` | event, game index, match, game no, seats, winner, turns, on_play, end_reason, final life, mulligans, play/draw choice, sideboarding per seat, deck sizes |
| `seat_game_stats` | event, game, seat: decisions, auto-passes, forced, rejections, manual payments, auto-tapper, payment failures, median latency, notes |
| `card_stats` | comparability group (`*` = all events) × set × card: agent picks, avg pick, seen, deck inclusion, deck win rate (refreshed for the ingested event's set) |
| `ratings` | board (group × set or `*` × source) × seat identity: rating, CI, SE, rank, games, W/L, events, opponents, provisional flag and reasons, diagnostics (column `stages`, a historical name). The rating comes from game outcomes only; the diagnostics never feed it (METHODOLOGY §4, §5). |
| `points_ledger` | event, seat, contributor, season, scheme, the points breakdown (derived: `hub points recompute` rebuilds it) |
| `seat_usage` | event, seat, who sent it, the usage summary of a hosted seat (`POST /api/usage`) |

Rows are derived with the same code as the JSON export (`packages/site`: `loadEvent`, `draftContext`, `seatGameStats`, `setStats`, `buildBoards`), so the database and the site never disagree. Per-decision rows (thousands per event) stay in the bundle. Replays and decision-level analysis read bundles directly; heavy research uses DuckDB over Parquet exports of bundles.

**Serving layer:** the Hub keeps every ingested event parsed in memory and, after each ingest, rewrites only what changed: the event's files, its set, any other event whose seat identities or pooled card rarities changed because of it, and `index.json` (which carries every board and comparability group). The tree is the one `npm run site:data` writes (docs/SITE-DATA.md, schema 2.13), byte-identical over the same run folders apart from `generated_at`. `/data/*` is served with CORS, `Cache-Control` (60 s for the index, sets and contributor files, 300 s for events), ETags and gzip; a CDN can sit in front later. mtgdecktools.com never queries Postgres directly. A full export runs at every Hub start.

**Open data:** once a night (03:30 America/New_York) a low-priority child process of the Hub builds the open dataset from the same accepted events: tables in Parquet and gzipped CSV, redacted event logs and a dated snapshot zip, CC BY 4.0, with the 17Lands human reference as its own credited table. It is served as static files at `/data/open/` (docs/OPEN-DATA.md).

## 4. Processes

**Submission (community):**
1. `bench submit runs/<id>.bundle.tar.gz` uploads the bundle to `POST /api/submissions` with a contributor token (from GitHub sign-in at the Hub's `/account` or `bench login`, or issued by the admin with the Hub CLI; stored as sha256 only; revocable).
2. The Hub stores it (sha256; the same bytes again → 409) and runs the checks in METHODOLOGY §3.1 (`packages/hub/src/checks.ts`):
   - schema and hashes (the Director's own `validateBundle`), finished and not aborted
   - provenance: engine build on the allowed list, Director not `-dirty`, known prompts
   - draft consistency: the draft replayed from `packs_opened` (every pick from the pack its seat held after the passes), decks from their pools plus basics
   - game consistency: games, match results, best-of, play/draw choices and sideboarding, `event_end` standings, `summary.json` and turn snapshots agree
   - pairings: every `round_start` regenerates from the seed, the seats and the earlier results (`packages/director/src/pairings.ts`, `verifyPairings`); seat positions follow the seed agent by agent (`event_start.agent_order`)
   - eligibility: every seat is an agent; a bundle with bot drafters (a dev event or an older Director) is rejected from uploads and Directors (`eligibility.agent_seats`; history imports keep a flag)
   - **pack regeneration** from the seed and set with the Director's `BoosterFactory` and `Rng` (`verified` / `partial` / `mismatch` / `unverifiable`, see `packages/hub/README.md`)
   - duplicates (event id, identical decision streams anywhere in the index) and anomalies (impossible or implausibly fast LLM latencies, usage that doesn't match the declared model)
3. Decision: tamper evidence is **rejected**; provenance, anomalies, an unverifiable regeneration and a new contributor's first submissions are **held** for review by the admin; everything else is ingested at once. The answer carries the status, every reason and a status URL.
4. Ingest writes the run folder, the index rows and the affected JSON files, and recomputes the ratings table.
5. The contributor sees the status in the CLI and at `GET /api/submissions/:id` (their own only).

**Hosted Directors:** a hosted Director hands each finished event to `POST /api/internal/events` with a service token (`HUB_SERVICE_TOKENS`), as the same bundle format. Same checks; integrity failures are held (a Director bug, not a forgery) instead of rejected, and there is no new-contributor review. The contract is in `packages/hub/README.md`; the Director side is `packages/director/src/hub-handoff.ts`.

**Import:** `hub import runs/` turns existing run folders (local, or hosted ones pulled with `scripts/pull-hosted-runs.sh`) into bundles and ingests them with their labels; checks are recorded as flags.

**Labels and trust** (METHODOLOGY §3, "Table provenance"; the export keeps the historical codes):
- **Hosted** (code `verified`): played on our hosted Director (or imported runs of ours). "Hosted" says where the table ran, not that a result was verified.
- **Community** (code `community`): validated uploads from self-hosted Directors.
- **Test Run** (code `smoke`): no LLM seat, or a dev event with bot drafters; never rated.
- **Early Test Data:** best-of-1 events and best-of-3 events without sideboarding; visible, outside every rating.
- **Replay-Checked:** later, once games are deterministic (needs the upstream phase-rs seed and replay-log patches); the Hub would re-simulate the decision log. Not built.
- We can't prove which model a contributor used, so trust comes from review of new contributors, anomaly checks (latency profiles, usage vs the claimed model, identical decision streams), and takedowns (`hub takedown`, which removes the event from the index and the export and triggers a recompute).

**Comparability:** results are only pooled when knowledge level, mana mode and the prompts (by content hash) all match (`kn=…;mana=…;prompt=…`; every match is best of 3 with sideboarding, earlier formats are Early Test Data; METHODOLOGY §3). Engine builds are recorded and pooled.

**Engine upgrades:** `npm run deps -- update phase` (wrapping `scripts/upgrade-phase.sh`) pins a new build after its smoke test and records the outgoing pin in `deps/manifest.json` → `phase_rs.history`. The Hub accepts the pinned digest, every earlier pin in that history and `HUB_ALLOWED_ENGINE_DIGESTS`; `deploy/deploy.sh` copies the running booster data (`<sha256>.json` per `draft-pools.json` and unsupported list) into the Hub's archive before restarting anything, and the hosted Director is drained before redeploying. See docs/UPGRADING.md.

**Backups:** the server's nightly job tars every docker volume. Bundles are immutable files, so that covers them. Postgres also gets a nightly logical dump (`pg_dump -Fc` into the `hub-pgdump` volume at 02:20, seven rolling days, a Coolify scheduled task on `hub-db`), because a tar of a live data directory is only crash-consistent. Index tables can be rebuilt from bundles; contributors, tokens, submissions and review decisions only from the dump.

**Moderation and privacy:**
- Agent notes and post-game text are untrusted. The site renders them as escaped text, never HTML.
- Takedown removes a submission from the index, the export and the open data (snapshots that held it are deleted; the bundle is kept unless purged) and triggers recomputation.
- Transcripts aren't uploaded by default (usage only), and the open data never includes them.

**Rate limits:** submissions per contributor per day (`HUB_SUBMISSIONS_PER_DAY`), bundle size caps (`HUB_MAX_BUNDLE_BYTES`, `HUB_MAX_UNPACKED_BYTES`), a bounded intake queue (`HUB_INTAKE_QUEUE`), usage uploads per hour (`HUB_USAGE_UPLOADS_PER_HOUR`), per-IP limits on reads and open-data downloads (packages/hub/README.md).

## 5. Hosted play pool sizing

- One worker = one Director process + one phase-server container.
- Measured capacity per worker is in §2.
- Scale out by adding workers (more containers on the same server, or other hosts later). Planned, not built: a coordinator assigns new events to the least-loaded worker, and seat URLs carry the worker (`https://play.agent-bench…/w/<worker>/mcp/<token>`, routed by Traefik). Today there is one worker.

### Hosted play: who may create events (built)

Contributors bring their agents; the worker hosts the table. Events are created with `POST /api/events` and either the admin token or a contributor's Hub token with the `play` scope (GitHub sign-in or `bench login`, packages/hub/README.md).
- **Token check: introspection, not signed capabilities.** The Director asks the Hub (`POST /api/internal/tokens/introspect`, with its service token) and caches the answer (60 s; 15 s for a refusal). Revocation, suspension and quota changes take effect within a minute, there are no keys to distribute or rotate between services, and contributors keep one long-lived token for play and submissions. The Hub is needed only to create an event; running events never depend on it.
- **Allowed values for contributors:** any set with booster data (an operator can restrict this with `HOSTED_SETS`), 8 agent seats (a Private Table; every event seats 8 agents, admin events too), Swiss (default) or round-robin pairings, best of 3 only (best of 1 is refused), any knowledge level and mana mode, seats each declared with harness and model (self-reported: `event_start.organizer` and `event_start.seat_meta = "self-reported"`), no chosen seed (seeds stay secret until the end), no `force`. The admin keeps full power (any set, seed, pod, `force`).
- **Visibility:** event status is public (no tokens). Seat URLs (`/api/events/:id/seats`), logs (`/files/*`) and canceling (`DELETE /api/events/:id`) are for the event's owner and the admin only; a contributor's `GET /api/events` lists their own events.

### Admission control (built, `packages/director/src/admission.ts`)

- **Capacity in game slots,** `MAX_CONCURRENT_GAMES` (default 30, from §2). An event's weight is the most games it can play at once, `floor(agents / 2)`, at least 1; it is reserved from admission to the end, so drafts and deckbuilding count and an admitted event never waits for capacity halfway through.
- **FIFO queue** when full (`MAX_QUEUE` 50): `202` with `queue_position`; queued events start on their own when slots free, strictly in order (a small event doesn't overtake a big one at the head, so nothing starves). Seats of a queued event can already connect; they are told to keep waiting. `GET /api/capacity` (public) and `GET /api/admin/status` show load and queue.
- **Per-contributor quotas** from the Hub, two of them, counted separately: Private Tables (`HUB_PLAY_CONCURRENT` 1 running or queued, `HUB_PLAY_DAILY` 6 per rolling 24 h) and lobby tables (`HUB_LOBBY_CONCURRENT` 2, `HUB_LOBBY_DAILY` 12; a lobby table counts for every contributor seated at it). `hub contributor quota` raises either: `429` with `Retry-After`. Daily counts survive restarts (rebuilt from checkpoints).
- **Limits:** API requests 120/min per client IP (`API_RATE_PER_MIN`), event creation 10/min per IP, JSON bodies 64 KB; MCP 600 requests/min and 4 in flight per seat, 256 KB bodies, 30/min per IP for unknown seat URLs; the spectator stream keeps its own limits (SPECTATING.md).
- **Abuse protections:** unguessable seat tokens (128-bit), the idle-seat watchdog (METHODOLOGY §5.5), events stopped after `EVENT_MAX_HOURS` (8), queued events dropped after `QUEUE_MAX_WAIT_HOURS` (4), events whose seats never connect stopped as `abandoned` after the connect grace (30 min, instead of letting them play themselves), finished events evicted from memory after an hour (served from disk). Stopped events log `event_abort` with the reason and are never handed to the Hub.

### Live event durability (built, `packages/director/src/durable.ts`)

Live events survive a Director restart or redeploy:
- **Checkpoint.** The event log is already the record of everything that happened. What it must not hold (it is published) goes to a private `state.json` (mode 600) next to it: owner, request, seat tokens (so seat URLs stay valid), status (queued / running / done / aborted), and the phase-server reconnect credentials of each game in progress, written when the game starts. `knowledge.json` keeps the exact briefing and Set Context. A crash at any point is recoverable; a partial last log line is cut on resume.
- **Resume at start.** Queued events go back in the queue in order. Running ones are rebuilt and replayed from their logs: the draft runs through the same code with the logged packs and picks (same seed, same Rng draws; bot drafters exist only in dev events), so it continues at the current pick, logs nothing twice, and the Hub's pack regeneration still verifies (a log that doesn't regenerate stops the event as `resume_failed` instead of continuing on different packs); submitted decks come from the log; finished games and matches too. Decision ids continue above every id handed out before. Each resume logs `event_resume`; seats get a notice and their open decision again.
- **Games.** phase-server persists games and keeps a disconnected seat for 120 s (also across its own restarts). The Director re-attaches both seats with `Reconnect {game_code, player_token, full_key}` (`game_reconnect`, `after: "restart"`), retrying with backoff for about 105 s (`RESUME_RETRY_MS` in `game.ts`, each retry logged as `game_reconnect_retry`: a deploy can start the Director before phase-server answers), and does the same live when a socket drops (`after: "socket_closed"`, e.g. a phase-server restart). If that fails (grace expired), the game is **voided** (`game_failed` with `void: true`, `reason`, `replay: true`) and replayed from the start under the same label, after a pause (2 s, 30 s, 2 min): a void is never a loss for anyone, and the Hub's game check accepts the replay. A game the engine can't start (`reason: "setup_failed"`) is voided and replayed the same way. After three replays the match ends with **no result** (`match_end.no_result`; METHODOLOGY §3.2).
- **The watchdog** pauses while the Director shuts down, and after a resume gives each seat that hasn't called since at least 15 minutes (METHODOLOGY §5.5).
- **Graceful shutdown.** On SIGTERM the Director stops admitting, checkpoints, and exits within a second (the image runs it as PID 1 via `exec node`; compose gives it 30 s). `deploy/deploy.sh` redeploys at once and relies on resume, or with `--drain [minutes]` first stops admitting events and starting new games (running games finish) and waits until no game is in progress, or with `--drain-events [minutes]` stops admitting events only (`POST /api/admin/drain {"games": false}`) and waits until no event is live (engine upgrades; it refuses an engine change while events are live otherwise). Coolify recreates every container of the service on a deploy, phase-server included; the Director starts once phase-server's healthcheck passes.
- **Booster data by version.** A resumed event replays its draft from the seed, so it needs the booster data it started on. The Director archives the data it runs on at every start (`director-cache/booster-archive/<sha256>.json`), and a resumed event whose `event_start.boosters` name other hashes (an engine upgrade happened) builds its packs from the archive (`booster-archive.ts`); missing files stop it as `resume_failed`.
- **Clients through a restart.** The proxy answers 404, 502 or 503 while the Director restarts; the `bench` CLI treats only the Director's own JSON 404 as "gone", waits out the rest with backoff for up to 10 minutes, and relaunches a seat session that ended meanwhile without counting it. The scripted agent retries for 10 minutes.
- **Tested** by `packages/director/test/hosted-e2e.sh` (SIGTERM mid-draft, SIGKILL mid-game, phase-server restart mid-game, a downtime past the grace that voids and replays a game) and `durable.test.ts` (a draft cut at any point resumes to the identical log).

### Matchmaking lobby (built, `packages/director/src/lobby.ts`, `lobby-http.ts`; contract in docs/LOBBY.md)

Contributors with 1–3 agents queue per condition set; 8 present seats get a ready check; a confirmed table fires as an 8-seat Swiss event on this Director.
- **Owner: the Director, not the Hub.** A lobby schedules live tables, and tables live on a Director. Firing is then a local call through the same admission control, checkpoint and seat tokens as any hosted event; holders' long-polls end at the process that fires; draining and restarts reuse the Director's durability. The Hub stays the source of truth for results only, and introspects contributor tokens as before. With several workers, the lobby moves to a coordinator (the Hub or a small service) that fires tables on the least-loaded worker; the public API stays the same.
- **State:** one private file, `<RUNS_DIR>/.lobby/state.json` (mode 600, atomic tmp+rename, written within 200 ms of a change and at shutdown): entries, tickets (sha256 only), forming tables, fired tables, contribution stats, featured queues and schedules. Restored at start after the live events (a table that was being created when the process stopped is found again through its event's checkpoint owner, `{ kind: "lobby", table }`); ready checks restart with a fresh window, and holders count as present for two minutes so their CLIs can reconnect.
- **Drain and deploys:** while the Director drains (`deploy.sh --drain`, `POST /api/admin/drain`), nothing forms or fires, forming tables dissolve with places kept, joins get `503`, and tickets show `paused`. Running lobby events drain like any other.
- **Capacity:** a fired table is an 8-seat event (4 game slots). When the worker is full it waits in the admission FIFO, and holders see `queue_position`. If the queue itself is full, the table dissolves with places kept and the queue waits a minute before trying again.
- **Clock:** a 2-second tick handles ready-check deadlines, expiry (24 h), scheduled tables and backfill.
- **Public API:** `/api/lobby*` reads are cached (5 s; stats 60 s), CORS `*`, under the shared per-IP API rate limit, and carry no contributor ids, IPs or tokens; handles only for contributors who show them.
- **Tested** by `lobby.test.ts` (ready check and backfill, presence, per-contributor cap, expiry, cooldowns, reliability, scheduled tables, draining, stats, restart durability) and `packages/director/test/lobby-e2e.sh` (three contributors queue 8 scripted seats with `bench lobby join`; the table fires, the event completes, the handed-off bundle passes the Hub's checks; in CI).

## 6. Today (hosted dev stack)

Not public yet: the hosts below are unlisted development hosts, and the site's `/agent-bench` pages are behind a default-off flag.

- **One Coolify service, four containers** (`deploy/compose.yaml`, deployed with `deploy/deploy.sh`):
  - `phase-server` (the pinned engine image);
  - `director` (`bench.mtgdecktools.com`): events created over the API by the admin or by contributors with a Hub `play` token, the lobby, admission control, a queue and quotas (§5); logs and private checkpoints in the `director-runs` volume; live events survive restarts and redeploys (§5);
  - `hub` (`bench-data.mtgdecktools.com`) and `hub-db` (Postgres 17).
- **Director → Hub hand-off** (`packages/director/src/hub-handoff.ts`): after `event_end` and `summary.json`, the Director POSTs the event's bundle to `HUB_URL/api/internal/events` with `HUB_SERVICE_TOKEN` (both set by the compose file), retries with backoff, logs each attempt as a `hub_handoff` record, and resends unfinished hand-offs at start. `event_start.boosters` names the booster data for exact pack regeneration. Events from before the hand-off existed went in with `hub import` of pulled hosted runs.
- **Where the site reads:** finished events from the Hub's `/data`; live events from the Director, which still writes its own report export to `/data` every 2 minutes while anything is running (live events included, for spectating).
- **Submissions:** `bench submit` sends bundles to the Hub. The Director's older interim endpoint (`POST /api/submissions`, `SUBMIT_TOKENS`) still exists for compatibility and is off unless tokens are configured.
- **Backups:** every volume is in the nightly encrypted backup, and the `hub-db` dump runs nightly at 02:20 (seven rolling days).
- **What is deployed** at any moment, and what is built but waiting for a deploy (for example the open data or the latest Director changes), is tracked in STATUS.md.

## 7. Measurements

The load-test results are in §2 (`scripts/load-test.sh`). Rerun it after an engine upgrade or a change to the Director's game loop, and record the new numbers there with the date.

## 8. Migration path

1. **Done:**
   - the Hub (`packages/hub`) with Postgres, deployed on the dev host; incremental JSON export; `hub import` of earlier runs;
   - the hosted Director as "worker 1", handing finished events to the Hub (`POST /api/internal/events`);
   - contributor tokens through GitHub sign-in and `bench login`; `bench submit` pointed at the Hub; Community labels;
   - hosted Private Tables and the matchmaking lobby; event resume across restarts (§5);
   - the nightly open dataset.
2. **Launch:** make the repository and the site public (the owner's call), publish the CLI package (docs/RELEASING.md), production hosts.
3. **Scale when needed:** more workers with a coordinator (§5), a CDN in front of the JSON, replay verification (needs upstream phase-rs seed and replay-log support).
