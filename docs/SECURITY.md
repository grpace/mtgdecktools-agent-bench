# Security

This page covers how to report a vulnerability, what we protect, and the controls on each exposed surface. It also tells self-hosters how to run their own Director safely.

## Reporting a Vulnerability

**Please don't open a public issue for a security problem.** Report it privately through GitHub: on the repository page go to **Security → Report a vulnerability**, or open https://github.com/grpace/mtgdecktools-agent-bench/security/advisories/new. Only we can read these reports.

Include:
- what is affected (Director, Hub, bench CLI, deploy files, the results export or the mtgdecktools.com pages)
- the version or commit
- steps to reproduce
- what an attacker gains

Don't include real tokens. If you found a token or seat URL in the wild, say where, and we'll revoke it.

We aim to acknowledge reports within 3 days and to fix critical and high-severity issues before anything else. We credit reporters in the advisory and the changelog unless you'd rather we didn't.

**Please don't:**
- run load or denial-of-service tests against the hosted services (`*.mtgdecktools.com` and our development hosts)
- access other people's events, tokens or submissions
- submit forged results to the hosted Hub

Test against your own `npm run up` stack instead. Everything the hosted stack runs is in this repo.

**Supported versions:** the latest release and `main`. Fixes are not backported before 1.0.

## What We Protect

| Asset | Why it matters |
|---|---|
| **Benchmark integrity**: results, ratings, the leaderboard | The project's value. Forged or tampered results must not be rated. |
| **Fairness of live events** | Agents must never see hidden information, an opponent's identity or event names. The spectator stream must not become a side channel (docs/SPECTATING.md). |
| **Tokens** | **Admin** tokens create events and read seat URLs. **Seat** tokens play a seat. **Submission and contributor** tokens upload results. **Service** tokens hand events from a hosted Director to the Hub. |
| **Availability of the hosted stack** | A crash drops every live event. Live state is in memory, and the agents' token spend is lost with it. |
| **mtgdecktools.com visitors** | They render agent-written text (notes, card names, labels) from community bundles. That text must never become markup or script. |
| **Operator infrastructure** | The deploy host, Coolify, and secrets in `~/.config/mtgdt/`. |

The server never calls a model and holds no model API keys (CLAUDE.md). There is nothing of that kind to steal. Agents run in their owners' harnesses.

## Threat Model

**Actors**

- **Anonymous internet users.** They can reach the hosted Director (`/health`, the public live view, `/data`, `/api/events`) and the Hub's public read API, `/data` and its sign-in pages. They may try to crash or exhaust the servers, or to read hidden information from a live event.
- **An agent in a seat.** It holds one seat token. It may write hostile notes, card names or rules reports, or flood the server with requests. If it has web tools it may look for its opponent's hand through the spectator stream.
- **A contributor.** They hold a submission token and upload results bundles they built themselves. Every byte of a bundle is attacker-controlled: archive structure, sizes, every JSON field. They may try to forge a result, exploit the parser, or plant content that attacks mtgdecktools.com visitors or the Hub's file system.
- **A Director the bench CLI talks to.** `--director` can point at anyone's server, and a compromised hosted Director reaches every lobby participant. It may answer with hostile event ids, seat names, seat URLs or seat details, and its text reaches a terminal or a coding agent with a shell.
- **A self-hosting operator.** They run their own Director. We protect them with safe defaults, such as binding to loopback. We can't protect the benchmark from a dishonest operator except through the Hub's integrity checks and review.
- **Supply chain:** npm dependencies, base images, the upstream phase-rs image and GitHub Actions.

**Trust boundaries**

1. **Internet → Traefik (TLS) → Director or Hub.** Hosted only. Self-hosted Directors bind to `127.0.0.1` by default.
2. **Seat (MCP) → Director.** The seat token authorizes exactly one seat. The agent's input is decisions, notes and rules reports.
3. **Bundle → Hub.** The main untrusted-input path. The Hub validates it, checks its integrity and holds it for review before anything is exported.
4. **Hub or Director export → mtgdecktools.com.** The export is data (JSON). The site renders it as escaped text, never as HTML.
5. **Director ↔ phase-server.** Internal Docker network, not published. Agents never talk to the engine.
6. **Director → bench CLI → your harness.** The CLI treats every Director as untrusted (below): it decides locally what runs, and the harnesses it starts get only their seat's MCP tools, as far as each harness allows.

**Out of scope**
- A contributor who puts a human in a seat. That's policy, not security: METHODOLOGY §3.1 and the review queue deal with it.
- Rules bugs in phase-rs. Report those upstream.
- Self-hosted stacks an operator deliberately exposes without TLS or auth.

## Controls by Surface

The codes in parentheses (SEC-, HUB-, LOB-, PTS-, LOG- and so on) name a control where it lives in the code and in its regression tests (for example `packages/director/src/security.test.ts`), so you can find both with a search.

### Director (`packages/director`)

- **MCP seats:**
  - One URL per seat, `/mcp/<128-bit random token>`.
  - The token is matched strictly, before any body is read. An unknown token gets a plain 404.
  - Stateless MCP: a fresh server per request, and the seat is re-resolved on every tool call.
  - A seat sees only its own view. Hidden information, opponent identity and event names are never in its text (docs/PROTOCOL.md).
  - Notes and rules reports are length-capped.
  - **What a seat can send** (SEC-2 to SEC-7): a body of at most 256 KB holding at most 4 JSON-RPC messages, each counted against the seat's 600 requests a minute; 4 requests in flight; 6 new sessions (`initialize`) a minute. Every tool argument is checked by its schema before any handler runs: object ids and pool numbers are whole numbers, every string has a maximum length, `basics` takes at most 12 names and 120 lands. Control, escape, bidi and zero-width characters are removed from agent text, and lone surrogates replaced, before it is logged.
  - At most 20 refused answers a minute per seat; beyond that an answer is turned away without reaching the game or the log, so one seat can't grow its table's log past what the Hub accepts (SEC-4).
  - Nothing a seat sends becomes a file path, a URL, a command or code. The Director builds every engine action itself, and phase-server checks each one against the game state again (SEC-8).
- **Connections** (SEC-5): at most 32 requests in flight per client address outside the seat endpoints, idle sockets closed after 150 s, header and request timeouts enforced every 5 s, 2,000 connections in all. Every console line is capped at 8 KB (SEC-9). Every response carries `nosniff` and a `default-src 'none'` Content-Security-Policy; the Director serves no HTML.
- **Admin API:**
  - Bearer token, compared in constant time.
  - Fails closed when no token is configured.
  - The token is checked before any body is read.
  - Generated tokens are 192-bit and stored with mode 600.
  - Seat URLs are only returned to the admin, and never logged in server mode or exported in bundles.
- **Spectator stream:**
  - A fairness policy releases information only when no competing seat could use it (docs/SPECTATING.md). It is tested in `spectate.test.ts` and checked by the smoke test.
  - Per-IP, per-event and total stream caps, poll limits, heartbeats, stream recycling, and a slow-reader cutoff.
  - Finished events are read back from disk in short slices that yield to live work, one at a time and at most 6 a minute in all (cache hits are free); beyond that the answer is `503` with `Retry-After` (SEC-1).
  - Live events in the `/data` export are redacted under the same policy. With `SPECTATE=admin|off`, live events are left out of the export entirely.
- **Matchmaking lobby (docs/LOBBY.md):**
  - Joins need a GitHub-linked contributor token with the `play` scope; at most 20 joins per contributor an hour and 2,000 waiting entries in all. Ended entries and their tickets are forgotten after 10 minutes, and the state file is written at most once a second, asynchronously and atomically (temp file, then rename), so join/leave churn can't grow it or stall live events (LOB-1).
  - Fired lobby tables count toward every seated contributor's hosted-play quotas, like their Private Tables (LOB-2).
  - The Hub's Leaderboard Visibility setting wins over the lobby's show choice: it arrives with every token check and is re-read for everyone the lobby knows every 5 minutes (LOB-3). Event logs written while a contributor is hidden carry no handle.
  - Scripted test seats are refused in public queues (`LOBBY_ALLOW_SCRIPT=1` only on development Directors) and never count toward contribution or reliability (LOB-4).
  - Long-polls: at most 2 per ticket and 500 in all; more answer at once (LOB-6, SEC-5).
- **Interim submissions endpoint:** a token per contributor, a size cap, and the bundle validator (flat regular files only, an allow-listed set of names, sha256 manifest, validated event and seat ids).
- **Data serving:** URL normalization plus a prefix check confine reads to the export directory. There is no directory listing.
- **CORS:** `*` only on the public read routes (the report export, live streams, the lobby's public views), on their errors too, so a page can tell "not found" from "unreachable". No credentials anywhere; authentication is by bearer header, so there is no CSRF surface on the APIs.

### Hub (`packages/hub`)

- **Tokens:**
  - Random tokens, shown once: 240 bits for contributor tokens, 192 bits for the generated service and admin tokens.
  - Stored only as sha256. A fast hash is fine for tokens this random.
  - Scoped (`submit`, `play`, `ingest`) and revocable. Introspection reports a token as active to a Director only with the scope it asks for (`play` by default).
  - The admin token is compared in constant time, and the admin API is off when no token is set.
- **Bundle intake:**
  1. The upload is size-capped (`HUB_MAX_BUNDLE_BYTES`), and an oversized chunked body is cut off.
  2. The unpacked size is capped before parsing (`HUB_MAX_UNPACKED_BYTES`), against decompression bombs. Before anything parses them, no JSON file may nest deeper than 64 levels (the recursive scrubbers would overflow) and the log may hold at most 250,000 records (millions of tiny records once held the event loop for seconds) (HUB-33, `src/shape.ts`).
  3. The archive may hold only flat, regular, uniquely named files: no paths, `..`, links or devices.
  4. Content limits (`src/sanity.ts`) check the type and size of every field that reaches a file path, markup or a loop. For example, set codes must match `^[A-Za-z0-9]{2,8}$`, and turns, counts and positions must be integers.
  5. Integrity checks, then review: a new contributor's first submissions are held, as are provenance and anomaly findings.
  6. Per-contributor daily rate limit.

  Tests: `test/security.test.ts`, `test/e2e.ts`.
- **Storage:**
  - Bundles are content-addressed (sha256) and read-only.
  - Export writes are confined to the served tree.
  - SQL goes only through parameterized tagged templates; `sql.unsafe` runs only the repository's own migration files.
- **Terms (`src/terms.ts`):** hosted play and uploads need the current terms version accepted (`bench login`, `bench terms --accept`, or the button on `/account`); the Hub records each acceptance (`consents`). Introspection tells a Director, which refuses new tables with the Hub's message; `POST /api/submissions` and `POST /api/usage` answer `403` with it. Admin and service accounts are never asked. `HUB_TERMS_REQUIRED=0` turns the check off (tests only).
- **`/data`:** every file goes through the shared scrubber before it is written (`scrubPublic`); malformed and traversal paths answer 404, ETag and gzip are supported, `X-Content-Type-Options: nosniff` is set on every response, and a stream error ends the response instead of the process.
- **`/data/open/` (open dataset, docs/OPEN-DATA.md):** prebuilt static files only, never computed per request; the build runs once a night in a separate process at the lowest CPU and I/O priority, skips unchanged inputs and swaps the served tree atomically. Per IP: 60 requests a minute and 4 downloads at a time (429 with `Retry-After`). Files stream from disk (no buffering); single byte ranges only. Privacy: the redaction (`src/open-data/redact.ts`: attribution rewritten to salted keys, identifying keys dropped at any depth, every string through the shared scrubber, [Moderation and Erasure](#moderation-and-erasure)) removes API keys and tokens, JWTs, paths, e-mail and IP addresses (v4 and v6), account ids and hidden handles from logs and notes; transcripts never enter it; a test scans every published byte of a fixture with planted secrets. A takedown or a hidden handle triggers an early rebuild and deletes every snapshot that held it.
- **Contributor points (`src/points.ts`, `src/contributors.ts`):**
  - **Attribution only from trusted data.** Hosted events credit the contributor ids the Director logged (lobby seats; the organizer of a Private Table). A community upload credits the uploader for every seat, whatever its log claims, so a forged log can't hand points to someone else. The lobby multiplier needs the hosted Director's hand-off (a lobby table it fired); an upload claiming a lobby table earns as a Private Table (PTS-3).
  - **The Hub's clock.** Ordering, the daily cap, the 7-day windows, admin bounty windows and seasons use the Hub's acceptance time (`decided_at`, else `received_at`), never the times inside a bundle, so backdating can't dodge the cap or take bounties (PTS-1). Record times in a bundle must be Unix milliseconds before 2100.
  - **Anti-farming.** Points never reward wins (nothing to gain from throwing games or colluding). Only rated play earns: a seat with no rated games earns nothing, so a table of one model setup earns 0. Bounties need 2 rated games at that table and harness logs (on hosted tables: a seat the bench CLI launched); Needs Games only for listed, current models at an explicit effort, at most 3 per contributor and setup in 7 days. Seats without logs earn half (PTS-2). Only accepted events count: Smoke, dev, held, rejected and excluded events earn nothing, and the review queue holds a new contributor's first uploads. Mismatch seats (declared one model, ran another) earn nothing. Repeats of one setup in one set beyond what the data needs taper (half from the 9th seat in 7 days, a quarter from the 17th), there is a daily cap of 400 points, abandoned seats earn no seat points and lower a reliability multiplier, and hosted quotas (tables a day, lobby tables included; one continuous table) bound how fast anyone can play. Bounties are computed from public data and capped (admin bounties at 100 a seat). Residual risk: usage files and `effort_basis` are written by the contributor's own machine (LOG-1), so the logs rule raises the cost of lying without proving the model; several aged GitHub accounts (sybils) can each farm up to the cap; review, anomaly checks (duplicate decision streams, latencies) and takedowns are the backstop, and a takedown or exclusion removes the points at the next recompute.
  - **Privacy.** The public boards and profiles carry handles, GitHub avatars and contribution counts only: no contributor ids, tokens, pending or rejected submissions. Contributors who hide their handle (`--hide-handle` in the lobby or the account setting) are left out of the boards and get no profile file or API answer (`404`, the same as an unknown handle); contributor files are cached for at most 60 s. Their private view (pending bundles, ledger lines, abandoned seats) is only on `/account` behind a GitHub session. The export never names an uploader (`source.json` keeps only the Hub id, which the export salts and hashes), and `GET /api/events/<id>` names the uploader only for contributors on the public leaderboard (PTS-4).
  - **Public API.** `GET /api/contributors`, `/api/contributors/<handle>` and `/api/bounties` are read-only, per-IP rate limited (120 a minute; IPv6 by /64), cached for 60 s (oldest entries evicted first) and validate the handle, season and offset parameters. `/api/events`, `/api/events/<id>` and `/health` have their own per-IP limit (HUB-16).
- **Hostile text and requests** (HUB-22 to HUB-31): every text and JSON value reaches Postgres without NUL or lone surrogates (so one note can't stop a table's ingest); console lines are capped and terminal-safe, and the review CLI strips control characters; CSV cells that would start a spreadsheet formula get a leading `'` (Parquet keeps the exact text); failed token checks are limited to 60 a minute per address (behind Cloudflare, the address is `CF-Connecting-IP`, believed only on requests that came from a Cloudflare edge, so visitors near one edge don't share a limit and a client reaching the origin directly can't choose its own; `HUB_TRUST_CLOUDFLARE`, HUB-32); a body still unread when an answer starts closes the connection; JSON and data answers carry a `default-src 'none'` CSP, and `/data` refuses dot segments.
- **Intake on the event loop:** bundles are checked one at a time, with a short waiting line (`HUB_INTAKE_QUEUE`) and `429` beyond it, so one large bundle at a time holds the loop (HUB-8, mitigated; a worker thread is the full fix).
- **GitHub sign-in and `/account`:** for self-serve tokens. It is off unless `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` are set. Over https the cookies are host-locked (`__Host-` names); signing out ends every session of the account (a session epoch); the token cap is checked and the token issued under a row lock. GitHub accounts younger than `HUB_GITHUB_MIN_ACCOUNT_DAYS` (30) are refused on both the web and the device flow, and an account whose creation date is missing or unreadable is refused too (HUB-34).

### The bench CLI and a Director It Doesn't Trust (`scripts/bench`)

- **Nothing from a Director picks a path, a program, a model or an effort** (`trust.ts`):
  - Event ids must match the event-id pattern and seat names `^[\w.-]{1,40}$`. Every path built from them is resolved and must stay inside its folder.
  - Seat URLs must be `<that Director's base>/mcp/<token>` in plain characters.
  - A created event must come back with exactly the seats asked for.
  - The harness, model and effort a seat starts with come from this machine: the plan you confirmed (`confirmation.json` → `launch`, which `bench play` checks), or the seats a lobby ticket joined with (kept in the ticket file). A fired lobby table whose seats aren't among yours, or that has more of them, is refused, and `bench play` refuses lobby records written by older versions that took these from the Director.
  - Tests: `scripts/bench/test/trust.test.ts` (hostile answers, swapped harnesses, path seat names).
- **Tokens are scoped to their issuer.** The saved contributor token goes only to the hosted Director, the Hub that issued it, and this machine (`BENCH_TOKEN_ORIGINS` adds origins). A community Director gets its own token with `--token` or `BENCH_TOKEN`, with a warning, or none. The `~/.config/mtgdt/admin-token` file goes only to the hosted Director. Tokens never travel over plain HTTP to another host.
- **Seats started here are shut in** (`harnesses.ts`, details per harness in [HARNESSES.md](HARNESSES.md#how-headless-launch-works)):
  - An empty working folder, and a private config folder with only the seat's MCP server. Your global config, global MCP servers, plugins, hooks and instruction files don't load, and the seat URL is in a file, not in `ps`.
  - No shell, file or web tools: removed (Claude Code), or switched off and denied as far as the harness allows. Codex, Gemini CLI and Cursor can't be fully shut in, and the setup Confirmation says so for each seat. For a seat that must not reach your files, run it in a container or VM.
  - The harness's environment is built from an allowlist (the basics a CLI needs and the harness's own sign-in variables; API keys only with `--use-api-key`), so the bench's own tokens (`BENCH_*`, `HUB_*`), other tools' tokens and the variables of the session that runs `bench` (a coding agent's `CLAUDE_*` session and messaging variables) never reach a seat (docs/HARNESSES.md).
- **Prompt injection.** Game text (card names and rules text from phase-rs and MTGJSON) reaches every agent. Other agents' notes and rules reports are never in a seat's text, but they are public in the spectator stream and the export, so a seat with web access could read them. A seat with only its MCP tools has nothing to act on an injection with beyond its own decisions. Where a harness keeps some tools (above), the risk is what those tools can do, which is why the Confirmation names them.
- **Director text in a terminal or an agent:** control characters are stripped from what the CLI prints, set codes are checked, and the setup prompt tells the coding agent to run only the commands in `next` and `commands`.
- **Local files:** event folders, transcripts, logs and the lobby ticket files are private (0700 folders, 0600 files). Saved pids are checked against the process's command line before the CLI signals them.
- **Harness logs (`bench attach-logs`):** a session counts for a seat only on a strong, unique match: a quarter (at least 3) of 32 sampled lines only that seat saw, in order, and none of another seat's or another event's lines. SQLite stores are read from a private snapshot that is removed even on Ctrl-C. Only ids, levels and counts are kept, never text or paths. What it writes is **self-attested** (`provenance.self_attested`, `evidence.kind: "cli-local-logs"` in the bundle): it was read by the contributor's CLI from files the contributor controls, so it never counts as evidence the Director observed.
- **Not distributed on npm.** Every instruction uses a clone of this repository (`npm --prefix ~/mtgdt-bench run -s bench --`); no instruction runs `npx` or installs an npm package (docs/RELEASING.md).

### Results Export and Site (`packages/site`, mtgdecktools.com)

- **Public text:** `build-data.ts` (the hosted Director's own `/data`) writes every file through the shared scrubber and applies the Hub's moderation list (`MTGDT_MODERATION_FILE`: taken-down events left out, hidden notes replaced, hidden handles dropped, erased contributors anonymized). Automatic highlights and model-page notes take only notes that pass the content filter ([Moderation and Erasure](#moderation-and-erasure)).
- The static report escapes every interpolated string (`esc()`), embeds JSON with `<` escaped, and builds card-image URLs with `encodeURIComponent`.
- **The loader distrusts logs:**
  - It drops events whose id or set code isn't path-safe.
  - It coerces every number that reaches markup or a loop, de-duplicates standings, and caps expansion loops.
  - It uses bounded regexes on agent text.
- **mtgdecktools.com** renders agent text as React text nodes. Markdown is used only for first-party content, without raw HTML.

### Deployment (`deploy/`, `Dockerfile`)

- **Ports:**
  - phase-server, the Hub's Postgres, and the Director's and Hub's own ports are not published.
  - On the hosted stack, Traefik terminates TLS.
  - Self-host compose binds the Director to `127.0.0.1`.
- **Secrets:**
  - Generated locally (`openssl rand`), stored in `~/.config/mtgdt/` with mode 600, and never printed.
  - Passed to the deploy through the environment, not argv. The deploy staging is written with `umask 077` and removed afterwards.
  - Local `.bench/` and `.env*` files are never synced to the build host.
- **Images:**
  - The engine image is pinned by digest, and CI checks that the compose defaults match `engine/phase.lock.json`.
  - The Node and Postgres base images are pinned by digest too; Dependabot proposes updates.
  - Director images are built by Coolify from the commit it deploys (a clone from GitHub; the `.dockerignore` allow-list decides what goes in) and tagged with it, so uncommitted changes never ship. Secrets are Coolify variables, runtime only: none reaches the image build.
  - CI builds the image from the real build context, checks it holds every repository file the code reads at run time, and boots the hosted compose stack from it.
- **Containers:**
  - The Director and Hub run as uid 999 (the image's `app` user) with every capability dropped and `no-new-privileges`. Their code is root-owned and read-only to them; they write only their volumes (the Director's report export is the `director-export` volume at `/app/var`).
  - Every service has a read-only root file system and a small `/tmp` (tmpfs), a memory limit and a process limit (`*_MEM_LIMIT`, `*_PIDS_LIMIT` override them) (SEC-11).
  - Networks: phase-server is only on `engine` (with the Director); Postgres only on `db` (with the Hub), which is internal, so Postgres has no way out. The Hub can't reach the engine and the Director can't reach the database. phase-server keeps outbound access, to download card data on its first start. Postgres runs with only the capabilities its entrypoint needs (`CHOWN`, `DAC_OVERRIDE`, `FOWNER`, `SETUID`, `SETGID`) and `no-new-privileges`.
  - `scripts/image-check.sh` boots this compose file and fails if a root file system is writable or the networks let the Hub reach phase-server or the Director reach Postgres. Coolify attaches its project network to every service as well, so phase-server and Postgres listen only on their private networks (`--bind`, `listen_addresses`), and Postgres's pg_hba.conf admits only the hub role from the `db` subnet (scram-sha-256) and the local socket; the image check runs with a shared network standing in for Coolify's (OPERATIONS "Networks"). Self-hosting (`compose.local.yaml`, `bench up`) keeps root inside the container, because the Director writes the admin token into a bind-mounted `.bench/` owned by the host user (with rootless Podman, root in the container is that user).
  - phase-server's entrypoint starts as root only to chown its data directory, then drops to its own user (uid 999) with gosu; it keeps `CHOWN`, `SETUID` and `SETGID` and nothing else.
  - Coolify puts every service variable, secrets included, into every container. phase-server is therefore started through `env -i` with only its image defaults, so the third-party engine never sees our secrets, and the upstream of its unused `/jev/systemone` relay points at a closed local port.

### Supply Chain and CI

- `npm ci` from a committed lockfile. CI runs `npm audit --omit=dev --audit-level=high`, and Dependabot proposes minor and patch updates monthly.
- **GitHub Actions:**
  - Pinned by commit SHA.
  - The workflow token is read-only (`permissions: contents: read`) and no checkout persists credentials.
  - The one exception is the weekly dependency workflow's pull-request step (`deps.yml`, `data-pr` and `phase-pr`). It gets `contents`, `pull-requests` and `actions` write, but runs only `git` and `gh`: no `npm ci`, no project code, no upstream image. It takes the change as a patch from the read-only job that did the work, refuses one touching anything outside the refreshed paths (or adding executables or symlinks), and hands the token to `git push` through a credential helper, never `.git/config`.
  - Triggered by `pull_request`, never `pull_request_target`, so a fork's code never runs with secrets. The workflows use no secrets.

## Moderation and Erasure

Agent text, deck names and handles are public, so everything that publishes them shares one module, `packages/director/src/public-text.ts` (docs/legal/CONTENT-POLICY.md, docs/legal/PRIVACY.md):

- **The scrubber** (`scrubText`, `scrubPublic`) replaces API keys and tokens (Anthropic `sk-ant-…`, OpenAI `sk-…`, GitHub `ghp_`/`gho_`/`github_pat_`, AWS `AKIA…` and named secrets, Google `AIza…`/`ya29.`, Slack, Stripe, Hugging Face, PEM private keys, `key=value` secrets, and any long high-entropy base64 string), JWTs, seat and Hub tokens, e-mail addresses, IPv4 and IPv6 addresses and file paths (Unix, macOS, `~`, `$HOME`, Windows drive and UNC paths, `file://`). It runs on the Hub's `/data` export, the Hub's stored run folders, the open dataset, the Director's own `/data` export, its spectator stream and replays. `public-text.test.ts` checks fixtures of every format and that no card's name or rules text changes (every card when `data/card-data.slim.json` is present).
- **The review filter** (`flagText`, `flagHandle`): a word list (extend it with `MTGDT_MODERATION_WORDLIST`, a private file) and patterns for links and look-alike official handles. At ingest the Hub queues every flagged note and deck name (`moderation_flags`), and every flagged handle at sign-in. Flagged text is published but never featured automatically (`highlights.ts quotable`); `HUB_MODERATION_HOLD=1` holds such bundles for review instead.
- **Hides** (Hub admin CLI `npm run hub -- moderation …` and `/api/admin/moderation/*`, admin token): a single note (event, seat, note key), a deck name, or a handle (force-hidden: the contributor can't show it again). The Hub applies the list whenever it writes a run folder, so a hide re-materializes the event from its stored bundle (which keeps the original), re-exports it, and starts an early open-data rebuild. Every action needs a reason and is logged in `moderation_log` with who, when and why.
- **Hosted Directors** read the list (`GET /api/internal/moderation`, service token) every minute and on `POST /api/admin/moderation/sync`: a taken-down event's run folder and exported files are deleted, it leaves `/api/events` and the spectator stream, and the export is rebuilt; hidden text and erasures apply to the export and to replays (a finished event touched by a hide is replayed from its log, not from memory). The last list survives restarts (`runs/.moderation.json`) and stays in force while the Hub is unreachable.
- **Erasure** (`npm run hub -- contributor erase <handle> --reason …`, `POST /api/admin/contributors/<handle>/erase`): the account loses its GitHub id, login, avatar, handle and tokens; its Hub id is replaced by a random anonymous id in every event log (a new contributor key, so old and new exports can't be joined); points and profile disappear; every output is rebuilt. `--remove-events` also takes down the events the contributor uploaded or ran as Private Tables, with their bundles. What remains is listed in PRIVACY.md "Erasure". Tests: `packages/hub/test/moderation-db.test.ts`, `packages/site/src/moderation.test.ts`, `packages/director/src/public-text.test.ts`.

## What a Malicious Seat Can and Can't Do

Someone who controls a seat (or rewrites the bench CLI) can send any bytes to that seat's URL. We test this against a local stack (`scripts/security/`, `packages/director/src/security.test.ts`). In short:

- **It can't run code** on the Director or the Hub, read or write their files, reach phase-server, Postgres or any other internal service, or make either server fetch a URL. Its input is checked against fixed schemas, used only as data, and turned into engine actions the Director builds and the engine checks again.
- **It can't see** other seats' hands, decks, notes or identities, and its own notes never reach other agents.
- **It can play badly, stall, or concede.** The inactivity watchdog settles a silent seat's decisions, and any decision still open after 30 minutes however often the seat calls meanwhile, so a seat that keeps calling without answering can't hold its table (METHODOLOGY §5.5, SEC-15).
- **It can annoy, within limits:** requests, sessions, refused answers, rules reports, long-polls and log growth are all capped per seat or per address, so it can't slow other tables, crash the process or push its table's log past what the Hub accepts.
- **Its words reach people.** Notes and deck names are public in the spectator stream and the export after the fairness delay. They are cleaned of control characters and always rendered as text, never as markup. They can still say anything, so treat them like any other user content.

## Running Your Own Director Safely

- **Keep the default bind** (`127.0.0.1`).
- **If agents elsewhere must reach it,** put a TLS reverse proxy in front.
  - Set `PUBLIC_URL` to the HTTPS address.
  - Set `TRUST_PROXY=1` only when the proxy is the only way in. Otherwise clients can forge `X-Forwarded-For` and dodge the per-IP limits.
- **Treat seat URLs as passwords.** Anyone with one can play that seat. Don't paste them into issues or screenshots.
- **Never put the admin token in a URL** other than the EventSource `?token=` fallback for `SPECTATE=admin`, and prefer `SPECTATE=public` with the default fairness policy.
- **Keep tokens out of command lines.** Use `ADMIN_TOKEN` / `BENCH_SUBMIT_TOKEN` or the token files (`.bench/`, `~/.config/mtgdt/`) rather than flags. The `bench` CLI refuses to send a token over plain HTTP to another host unless you set `BENCH_ALLOW_HTTP=1`.
- **Upgrade the engine with `scripts/upgrade-phase.sh`.** It only pins a build that passes the smoke test.
