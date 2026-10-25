# Hub: the central results service

The Hub is the single source of truth for benchmark **results** (not games). It takes finished events as
results bundles, checks them (METHODOLOGY §3.1), stores them immutably, indexes them in Postgres and
serves the JSON tree mtgdecktools.com reads (docs/SITE-DATA.md, schema 2.14) and the nightly open dataset (docs/OPEN-DATA.md). Design: docs/ARCHITECTURE.md §1, §3, §4.

```
 bench submit ──▶ POST /api/submissions ─┐                       ┌─▶ Postgres index (events, seats, picks, decks,
 (contributor token)                     │                       │    games, seat_game_stats, card_stats, ratings,
                                         ├─▶ bundle store ─▶ checks ─▶ decide ─▶ ingest ─┤    points_ledger, seat_usage)
 hosted Director ─▶ POST /api/internal/events                    │                       ├─▶ incremental export ─▶ /data/*
 (service token)                         │                       held ─▶ admin review    └─▶ nightly open data ─▶ /data/open/*
 hub import runs/ (admin) ───────────────┘                          (CLI / admin API)
```

- **Bundle store:** every received bundle (`.tar.gz`, the format `npm run bench -- bundle` writes) is kept
  byte-for-byte, content-addressed by sha256, including rejected ones (evidence). A directory today
  (`FsBundleStore`); the `BundleStore` interface (put/get/has/purge) is what an S3/R2 store implements.
- **Postgres** holds the index: what the site and ratings need across events. Per-decision rows stay in
  the bundles. Everything in Postgres can be rebuilt from the bundles (`hub reingest`).
- **Export:** the Hub keeps every ingested event parsed in memory (packages/site `EventData`) and, after an
  ingest, rewrites only the files that changed: that event's files, its set, any event whose seat
  identities or card rarities changed because of it, and `index.json` (which carries every board). The
  tree is identical to `npm run site:data` over the same run folders (checked in development).

## Quick start (local)

```bash
# Postgres on 127.0.0.1:5440, its own volume
podman run -d --name mtgdt-hub-dev-pg -e POSTGRES_USER=hub -e POSTGRES_PASSWORD=hub -e POSTGRES_DB=hub \
  -p 127.0.0.1:5440:5432 -v mtgdt-hub-dev-pgdata:/var/lib/postgresql/data docker.io/library/postgres:17-alpine
#   or: podman compose -f packages/hub/compose.dev.yaml up -d     (needs the podman socket / docker)

npm run hub -- migrate                     # also runs at every start
npm run hub -- import runs                 # first data: your local runs (labels kept)
npm run hub:serve                          # http://127.0.0.1:8840 (data in tmp/hub-data)

npm run hub -- contributor add alice       # new contributors' first submissions are held for review
npm run hub -- token issue alice           # prints the token once; stored as sha256 only
npm run bench -- submit runs/<id>.bundle.tar.gz --to http://127.0.0.1:8840 --token <token>
npm run hub -- submissions --status held   # review queue
npm run hub -- approve <submission-id>
curl -s http://127.0.0.1:8840/data/index.json | head -c 300
```

Defaults: `DATABASE_URL=postgres://hub:hub@127.0.0.1:5440/hub`, `HUB_DATA_DIR=tmp/hub-data`, engine data
(`draft-pools.json`, `card-data.json`, `unsupported-cards.json`) from `data/`.

## Configuration

| Variable | Default | What |
|---|---|---|
| `DATABASE_URL` | `postgres://hub:hub@127.0.0.1:5440/hub` | Postgres |
| `HUB_DATA_DIR` | `tmp/hub-data` | bundles/, events/ (run folders), site/ (served JSON), cache/, booster-data/ |
| `HUB_BUNDLE_DIR` | `$HUB_DATA_DIR/bundles` | bundle store |
| `PORT` / `HUB_PORT`, `HOST` | 8840, 127.0.0.1 | listen address (8787 in the container) |
| `HUB_PUBLIC_URL` | `http://127.0.0.1:<port>` | links in responses |
| `HUB_ADMIN_TOKEN` (`_FILE`) | none (admin API off) | admin API bearer token |
| `HUB_SERVICE_TOKENS` (`_FILE`) | none | hosted Directors: `name:token,…` (≥ 24 chars), upserted as hashed `ingest` tokens at start |
| `HUB_ENGINE_DATA_DIR` | `data/` | where `draft-pools.json`, `card-data.json`, `unsupported-cards.json` live |
| `HUB_DRAFT_POOLS`, `HUB_UNSUPPORTED_CARDS`, `HUB_CARD_DATA` | in the engine data dir | individual overrides |
| `HUB_BOOSTER_ARCHIVE` | `$HUB_DATA_DIR/booster-data` | older booster sheets / unsupported lists, named `<sha256>.json` |
| `HUB_BOOSTER_ARCHIVE_DIRS` | (none) | more archives to search, colon-separated, read-only (the hosted stack: the Director's `/director-cache/booster-archive`) |
| `HUB_ALLOWED_ENGINE_DIGESTS` | (the pinned digest and every earlier pin in `deps/manifest.json` → `phase_rs.history` are always allowed) | more engine builds accepted without a hold |
| `HUB_ALLOWED_CARD_DATA`, `HUB_CHECK_CARD_DATA` | (the pinned build's and earlier pins' upstream card data); on | the `provenance.card_data` check (docs/CARD-OVERRIDES.md): more upstream `card-data.json` sha256s vouched for, comma-separated; `HUB_CHECK_CARD_DATA=0` turns the check off. Card data that is neither a pinned upstream file nor one with this repository's override files holds the bundle |
| `HUB_MAX_BUNDLE_BYTES` | 25 MB | upload cap |
| `HUB_MAX_UNPACKED_BYTES` | 150 MB | cap on a bundle's unpacked size (decompression bombs) |
| `HUB_INTAKE_QUEUE` | 8 | bundles are checked one at a time; this many may wait behind the one being checked, then `429` with `Retry-After` |
| `HUB_SUBMISSIONS_PER_DAY` | 30 | per contributor |
| `HUB_REVIEW_FIRST` | 3 | a new contributor's first N submissions are held |
| `HUB_MIN_LATENCY_MS`, `HUB_FAST_SHARE` | 300, 0.1 | LLM seats answering faster than this, more often than this share, are held |
| `HUB_BOOTSTRAP` | 1000 | bootstrap replicates for rating intervals |
| `HUB_CORS_ORIGIN` | `*` | `Access-Control-Allow-Origin` on /data and the API |
| `HUB_USAGE_UPLOADS_PER_HOUR` | 30 | usage uploads for hosted seats (`POST /api/usage`, `src/usage-uploads.ts`) per contributor, or the admin token, per hour |
| `HUB_OPEN_DATA` | 1 | `0`: no nightly open-data build (docs/OPEN-DATA.md); the served files stay until removed |
| `HUB_OPEN_DATA_AT`, `HUB_OPEN_DATA_TZ` | `03:30`, `America/New_York` | when the nightly build starts (server time; the database dump runs at 02:20) |
| `HUB_OPEN_DATA_HUMAN_REFERENCE` | 1 | `0`: leave the 17Lands-derived `human_reference` table out |
| `HUB_OPEN_DATA_KEEP_DAILY`, `HUB_OPEN_DATA_KEEP_MONTHLY`, `HUB_OPEN_DATA_MAX_GB` | 7, 12, 20 | snapshot retention: newest N, newest of each of M months, size cap over all snapshots |
| `HUB_OPEN_DATA_PRIVACY_DELAY_MIN` | 15 | a rebuild this long after a takedown or a hidden handle (0: wait for the night) |
| `HUB_OPEN_DATA_RATE_PER_MIN`, `HUB_OPEN_DATA_CONCURRENT_PER_IP` | 60, 4 | `/data/open/` requests per IP per minute, downloads in flight per IP |
| `HUB_BOUNTIES_FILE` | `packages/hub/bounties.json` | admin bounties for contributor points, and computed bounty kinds switched off |
| `HUB_SETS_DIR` | `sets/` | per-set inputs the export reads (17Lands files, Set Contexts) and the featured list (`rotation.json`) for bounties |
| `HUB_METHODOLOGY` | `docs/METHODOLOGY.md` | published with the export as `methodology.md` (with its sha256) |
| `HUB_EXPORT_ON_START` | 1 | full re-export at start (keeps the tree in step with the code version) |
| `HUB_PLAY_CONCURRENT`, `HUB_PLAY_DAILY` | 1, 6 | Private Table quotas for contributors without their own (`contributor quota`): tables at a time, tables per rolling day. Returned by token introspection (`play_*`); the hosted Director enforces them |
| `HUB_LOBBY_CONCURRENT`, `HUB_LOBBY_DAILY` | 2, 12 | lobby quotas, counted separately from Private Tables (`contributor quota --lobby-*`): lobby tables at a time and per rolling day. Introspection `lobby_*` (migration 009) |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` (`_FILE`) | none (sign-in off) | the GitHub OAuth App for self-serve tokens |
| `HUB_SESSION_SECRET` (`_FILE`) | derived from the client secret | HMAC key for the sign-in and session cookies; set it so rotating the GitHub secret doesn't end sessions |
| `HUB_GITHUB_MIN_ACCOUNT_DAYS` | 30 | refuse GitHub accounts younger than this (`0`: off; HUB-7) |
| `HUB_TERMS_REQUIRED` | 1 | hosted play and uploads need the current terms accepted (`src/terms.ts`); `0` only for tests |
| `MTGDT_CONTACT_URL` | none (a visible placeholder) | the contact for takedowns, privacy and conduct: in the data card and the served legal documents. **Owner: set before launch** |
| `MTGDT_TERMS_URL`, `MTGDT_PRIVACY_URL`, `MTGDT_CONTENT_POLICY_URL` | the Hub's `/legal/*` | where `bench login` and the account page link the documents (the site's pages, at launch) |
| `HUB_MODERATION_HOLD` | 0 | `1`: hold bundles whose notes or deck names the content filter flags, for review (default: publish, never feature) |
| `MTGDT_MODERATION_WORDLIST` | none | a private file of extra filter terms, one per line (`#` comments), added to the default list (public-text.ts) |
| `HUB_TRUST_PROXY` | unset | `1`: client IP for sign-in rate limits from the last `X-Forwarded-For` hop (behind Traefik) |
| `GITHUB_OAUTH_URL`, `GITHUB_API_URL` | `https://github.com`, `https://api.github.com` | only for tests (a mock GitHub) |

## Contributor points

Points reward contributing, never winning (rules: docs/COMMUNITY.md "Points and the Contributors Leaderboard"; contract:
docs/SITE-DATA.md "Contributors"). `src/points.ts` is the scheme (pure, unit-tested); `src/contributors.ts` applies it to
the accepted events after every export:

- rebuilds `points_ledger` (migrations 003, 004) from scratch: one line per attributed seat with the full breakdown;
- writes `contributors.json` and `contributors/<handle>.json` into the served tree (public contributors only);
  `contributors.json` exists from the first start on (an empty board with the rules and open bounties), so the site
  never gets a 404;
- uses the Hub's clock: events are ordered, capped per day and put in a season by when the Hub accepted them
  (`submissions.decided_at`, else `received_at`), never by times inside a bundle (admin imports keep their log's end,
  capped at the import time); the lobby multiplier only for
  tables the hosted Director handed off as lobby tables;
- serves `GET /api/contributors`, `GET /api/contributors/<handle>` and `GET /api/bounties` (60 s cache, 120 requests a
  minute per IP);
- gives `/account` the signed-in contributor's points, ledger lines, abandoned seats and pending bundles, and a
  Leaderboard Visibility setting (`contributors.board_visibility`; null follows their latest lobby `--hide-handle`).

```bash
npm run hub -- points recompute --dry-run   # what a rescore would change, per contributor
npm run hub -- points recompute             # rewrite the ledger and the files (the server picks it up at its next export)
npm run hub -- points show alice            # a contributor's points, rank and ledger lines
```

Change the rules by editing `SCHEME` in `src/points.ts` (bump `SCHEME.id`) or `bounties.json`, then recompute: history is
rescored with the new rules. Note the change in CHANGELOG.md.

## Status lifecycle and policy

```
received → validated → ingested
         ↘ held (review) → ingested (approve) | rejected (reject, with a note)
         ↘ rejected
ingested → withdrawn (takedown)
```

Every check returns pass / fail / warn / unverifiable / skip and has a class. What a non-pass means
depends on how the bundle arrived:

| Class | Community upload | Hosted Director (`verified`) | Import (admin) |
|---|---|---|---|
| Structural (archive, manifest, sha256, unfinished or aborted event) | reject 400 | reject | skip / reject |
| Integrity **fail** (draft, decks, games, pack mismatch) | **reject 422** | hold (a Director bug, not a forgery) | hold |
| Integrity **unverifiable** (pack regeneration) | hold | flag | flag |
| Provenance (engine build not allowed, `-dirty` or unknown Director, unknown prompt) | hold | hold | flag |
| Anomaly (latencies, usage vs declared model, duplicate decision streams, timestamps) | hold | hold | flag |
| Duplicate bundle (sha256) | 409 | 409 | no-op |
| Duplicate event id | reject 409 | reject 409 | reject 409 |
| New contributor (first `HUB_REVIEW_FIRST`) | hold | n/a | n/a |

Labels: uploads are `community`, hosted Directors `verified`, events without an LLM seat `smoke` (shown as
Community, Hosted and Test Run; METHODOLOGY §3 "Table provenance"). Imports keep the label their run folder had
(`source.json`, else inferred: LLM events `verified`, others `smoke`), and an exclusion recorded there
(`source.json` `exclude`) is carried over. Best-of-1 events and best-of-3 events without sideboarding are ingested
as Early Test Data: indexed and exported, never rated (`events.comparability_group` null, `unrated_reason`).

## Integrity checks (`src/checks.ts`, `src/packs.ts`)

- **Schema and hashes:** the Director's own `validateBundle` (packages/director/src/submissions.ts):
  manifest, sha256 of every file, known files only, exactly one `event_start`, finished (`event_end`), not
  aborted, ids agree, plus its provenance flags.
- **Draft consistency:** replays the whole draft from `packs_opened`: every `draft_pick` shows exactly the
  pack its seat held (after the passes), the pick is in it, one record per seat per pick, `by` matches the
  seat kind, `overall_pick` agrees. **Decks:** every agent deck is its pool plus basic lands (main +
  sideboard = pool), at least 40 cards.
- **Game consistency:** two agent seats per game, one `game_over` each, winners played, `match_end` agrees
  with game winners, best-of respected (no games after a player reached the needed wins, no early stops),
  one `play_draw` per game with the right chooser and `on_play` (`games.play_draw`), every `sideboarded` deck
  legal from the seat's pool (main at least 40) with `in` / `out` matching the change from the deck it played
  in the previous game (`games.sideboarding`),
  `event_end` standings and `summary.json` agree with the matches, turn snapshots move forward and match
  the game length, life totals agree with a life-based end, decision latencies fit their timestamps.
- **Pack regeneration:** re-generates every round's boosters from the event seed and set with the
  Director's `BoosterFactory` and `Rng` (imported read-only from packages/director) and compares them with
  the logged packs, including the agent seat positions the same seed decides. Bot picks (dev events with bot
  drafters only) draw from the same Rng (one `next()` per card in the pack), and the log has every bot pick, so
  the stream can be replayed.
  Results:
  - `verified`: every pack and swap regenerated exactly.
  - `partial`: every pack regenerated, but the replacements for unsupported cards could only be checked
    for plausibility (same sheet and rarity), because the full unsupported-card list isn't logged.
  - `mismatch`: the packs differ and the hub demonstrably has the right booster data (the log names it by
    sha256, or round 1 regenerates ≥ 90%, which only the same sheets can do). Tamper evidence.
  - `unverifiable`: the hub can't tell (booster data not named and round 1 differs, an unknown
    generator version, no seed). Never a failure by itself.
- **Anomalies:** LLM seats answering faster than `HUB_MIN_LATENCY_MS` in more than `HUB_FAST_SHARE` of
  decisions (mana-payment continuations excluded); harness-reported model ids (`usage-<seat>.json`) not
  matching the declared model; a seat's decision stream (picks, deck, every answer with its note) identical
  to another seat's, in this or any ingested event.

### What the Director logs for full verification

Since 2026-10-22 every `event_start` names the booster data it was generated from
(packages/director/src/provenance.ts):

```json
"boosters": {
  "generator": "boosters-v1",                 // BOOSTER_GENERATOR: bumped with any generator change
  "draft_pools_sha256": "<sha256 of the draft-pools.json bytes>",
  "unsupported_sha256": "<sha256 of the unsupported-cards.json bytes the factory was built with>",
  "unsupported_count": 123,
  "unsupported_source": "file"                // or "markers": no file, hashed as JSON.stringify({unsupported})
}
```

The hub looks the files up in `HUB_BOOSTER_ARCHIVE` (drop each published `draft-pools.json` / unsupported
list there as `<sha256>.json`; `npm run deps -- update phase` does it locally) and then in `HUB_BOOSTER_ARCHIVE_DIRS`
(colon-separated, read-only: on the hosted stack the Director's own archive, `/director-cache/booster-archive`, where
the Director keeps the data it runs on at every start), or uses its defaults when their
hashes agree, so every check becomes `verified` or `mismatch`. Older logs (without `boosters`) regenerate
exactly only when the hub has the same files as the Director that ran them (true for local runs and for the
hosted Director, whose cache the hub mounts).

Two rules keep this sound: (1) `BOOSTER_GENERATOR` (provenance.ts) is bumped in the same commit as any
change to `boosters.ts`, `rng.ts`, the seat shuffle or the bots' Rng use, because the hub regenerates with
the code it runs (`GENERATOR_VERSION` here is the same constant); (2) the Director version carries `-dirty`
when the tree has local changes (`git describe --dirty` locally; `bench up` puts it in `DIRECTOR_TAG`; the hosted
stack reports the commit Coolify deployed, `SOURCE_COMMIT`).

## HTTP API

| Method + path | Auth | What |
|---|---|---|
| `GET /health` | none | `{ ok, version, events, loaded, last_export, open_data }` (`version`: the image's `DIRECTOR_TAG`; `open_data`: next and last nightly build) |
| `POST /api/submissions` | contributor token (`submit`) | body: the bundle. 201 `{ submission_id, id, status, label, flags, reasons, pack_regeneration, status_url, report }`; 400/422 rejected; 409 duplicate; 401; 413; 429 |
| `GET /api/submissions` | contributor token | your last 50 submissions |
| `POST /api/usage` | contributor token (`submit`) or admin | a hosted seat's usage summary after the event (`bench play` / `bench attach-logs`; `src/usage-uploads.ts`), only from whoever seated that seat; stored in `seat_usage` and written into the run folder as `usage-<seat>.json`. 401; 413; 429 |
| `GET /api/submissions/:id` | contributor token (own) or admin | status, reasons, every check's outcome, pack regeneration |
| `POST /api/internal/events` | service token (`ingest`) | a finished event from an official hosted Director; same body and answers as above, label `verified` |
| `POST /api/internal/tokens/introspect` | service token (`ingest`) | body `{ "token": "…", "scope"?: "play" \| "submit" }`: who a contributor token belongs to, its scopes, hosted-play quotas and leaderboard visibility (see "Hosted play") |
| `POST /api/internal/contributors/visibility` | service token (`ingest`) | body `{ "ids": [12, 13] }`: `{ "visibility": { "12": "hidden", "13": null } }`, the Leaderboard Visibility setting (null: follow the lobby choice; suspended: hidden). The lobby honors it |
| `GET /auth/github`, `GET /auth/github/callback` | none | GitHub sign-in (self-serve tokens) |
| `GET /account`, `POST /account/tokens`, `POST /account/tokens/:id/revoke`, `POST /account/rotate`, `POST /account/visibility`, `POST /account/signout` | session cookie + CSRF | your tokens, quotas, points and Leaderboard Visibility |
| `POST /auth/device/start`, `POST /auth/device/poll` | none | GitHub device flow for `bench login` (see "CLI login (device flow)") |
| `GET /api/events[?label=&set=&group=]` | none | ingested events from Postgres |
| `GET /api/events/:id` | none | event row, seats, games, decks, submission summary |
| `GET /api/contributors`, `GET /api/contributors/<handle>`, `GET /api/bounties` | none | the Contributors Leaderboard, one contributor, open bounties (see "Contributor points") |
| `GET /api/admin/submissions?status=held` | admin | review queue |
| `POST /api/admin/submissions/:id/approve` / `reject` | admin | body `{ "note": "…" }` (required to reject) |
| `POST /api/admin/events/:id/exclude` / `include` / `takedown` | admin | body `{ "reason": "…", "purge": false }` |
| `POST /api/admin/export` | admin | full re-export |
| `GET /api/terms` | none | the current terms version, the short summary and the links (`bench login` shows them) |
| `GET /api/account/terms`, `POST /api/account/terms` | contributor token | whether you accepted the current terms; body `{ "version": "…" }` accepts it (409 for any other version) |
| `GET /legal/terms`, `/legal/privacy`, `/legal/content-policy` | none | docs/legal/*.md as plain text |
| `GET /api/internal/moderation` | service token (`ingest`) | the moderation list hosted Directors apply: `{ version, takedowns, hides, hiddenHandles, erased }` |
| `GET /api/admin/moderation/queue?status=open\|kept\|hidden`, `/hides`, `/log` | admin | the review queue, current hides, the last 100 actions |
| `POST /api/admin/moderation/flags/:id/keep` / `hide` | admin | body `{ "reason": "…", "actor"?: "…" }` |
| `POST /api/admin/moderation/notes/hide`, `/deck-names/hide` | admin | body `{ "event", "seat", "item" (notes), "reason", "actor"? }` |
| `POST /api/admin/moderation/hides/:id/undo`, `/handles/:handle/hide` / `show` | admin | body `{ "reason": "…" }` |
| `GET /api/admin/events/:id/notes?seat=&grep=` | admin | an event's agent notes with their keys |
| `POST /api/admin/contributors/:handle/erase` | admin | body `{ "reason": "…", "remove_events"?: true }` (docs/legal/PRIVACY.md "Erasure") |
| `GET /data/*` | none | the JSON export: CORS, `Cache-Control: public, max-age=60` (index, sets, contributor files) or `300` (events), ETag / 304, gzip |
| `GET /data/open/*` | none | the open dataset (docs/OPEN-DATA.md): prebuilt files only, streamed; `Range`, ETag / 304; snapshots `immutable`, `latest.json` 5 minutes, the rest 1 hour; per-IP rate and concurrency limits |

## CLI (`npm run hub -- …`; in the container `docker exec <hub> npm run hub -- …`)

```
migrate
contributor add <handle> [--trusted] [--note text] | list | suspend | activate | trust | untrust <handle>
contributor quota <handle> [--concurrent N|default] [--daily N|default] [--lobby-concurrent N|default] [--lobby-daily N|default]
                                                                       Private Table quotas (default: HUB_PLAY_*) and lobby quotas (HUB_LOBBY_*)
token issue <handle> [--scope submit|ingest|play|contributor] [--label text]     prints the token once
token list [<handle>] | token revoke <token-id>
submissions [--status held|rejected|ingested|…] | show <submission-id>
approve <id> [--note] | reject <id> --note <reason>
exclude <event-id> --reason <text> | include <event-id> | takedown <event-id> --reason <text> [--purge]
contributor ban <handle> --reason <text>  suspected manipulation: suspend (tokens stop, sign-in refused), exclude their own
                                         events, unrate their seats' games at lobby tables, recompute points; logged
include-seats <event-id>                 undo a seat exclusion (after `contributor activate`)
import <runs-dir or run folder>...      first data; bundles built like `bench bundle`, deterministic sha
reingest [<event-id>...]                 rebuild index rows from the stored bundles (all when none given)
export                                   full JSON export (when no server is running)
points recompute [--dry-run]             rebuild the points ledger from the accepted events (see "Contributor points")
points show <handle>                     a contributor's points, rank and ledger lines
open-data build [--force]                build the open dataset now (skips when nothing changed; the server builds nightly)
open-data status                         the current build, its snapshot and table sizes
contributor terms <handle>               whether they accepted the current terms
contributor erase <handle> --reason <text> [--remove-events]   erasure (docs/legal/PRIVACY.md)
moderation queue [--status open|kept|hidden] | keep|hide <flag-id> --reason <text>
moderation notes <event-id> [--seat s] [--grep text]      an event's agent notes with their keys
moderation hide-note <event-id> <seat> <key> | hide-deck-name <event-id> <seat> | hide-handle|show-handle <handle>  (--reason)
moderation hides | unhide <hide-id> --reason <text> | log
```

Every moderation action needs `--reason` and is logged (`moderation_log`: who, when, what, why); it re-materializes the
events it touches from their stored bundles and sends `NOTIFY hub_moderation`, so the server rebuilds open data early.

The CLI writes to Postgres and the data directory and sends `NOTIFY hub_events`; the running server
reloads that event and re-exports (and reconciles every 60 s in case a notification was missed).

## Tokens and scopes

| Scope (`tokens.scope`) | Prefix | Can (`tokens.scopes`) | Issued by |
|---|---|---|---|
| `submit` | `mtgdt_sub_` | submit bundles | CLI |
| `play` | `mtgdt_ply_` | create events on a hosted Director | CLI |
| `contributor` | `mtgdt_con_` | submit + play | GitHub sign-in (or CLI) |
| `ingest` | `mtgdt_ing_` | hand-off and token introspection (hosted Directors only) | `HUB_SERVICE_TOKENS` |

Tokens are random, shown once and stored as sha256 only. Suspending a contributor disables all their tokens;
`token revoke <id>` disables one.

## Hosted play (token introspection)

Contributors create events on the official hosted Director with a `play` or `contributor` token. The Director
asks the Hub who the token belongs to (and caches the answer briefly), so revocation and suspension take effect
within the cache time and the Hub stays the only place that knows contributors:

```
POST /api/internal/tokens/introspect
Authorization: Bearer <service token, scope ingest>
{"token": "<contributor token>"}                ("scope": "submit" checks a submit token instead; default "play")

200 {"active": true, "contributor": {"id": 12, "handle": "alice", "kind": "person", "trust": "new", "github_login": "alice"},
     "board_visibility": null, "scopes": ["submit", "play"], "token_id": 34, "token_prefix": "mtgdt_con_abc",
     "quotas": {"play_concurrent": 1, "play_daily": 6, "lobby_concurrent": 2, "lobby_daily": 12}}
200 {"active": false}                    unknown or revoked token, a suspended contributor, or a token without the scope
400 malformed body; 401 bad service token
```

`quotas` are the contributor's own (`contributor quota`) or the defaults: `play_concurrent` / `play_daily` (Private Tables, `HUB_PLAY_*`) and `lobby_concurrent` / `lobby_daily` (lobby tables, `HUB_LOBBY_*`, counted separately).
The Director enforces them (it knows what is live), and lobby tables count toward them for every seated
contributor. `board_visibility` is the contributor's Leaderboard Visibility setting (`public`, `hidden`, or null to
follow the lobby's `--hide-handle`): the Director's lobby honors it.

## Self-serve tokens (GitHub sign-in)

`/account` (and `/auth/github`) let anyone with a GitHub account get a `contributor` token (submit + play):

- **Flow:** authorization code with PKCE (S256), scope `read:user` only. `state` and the PKCE verifier live in a
  signed, HttpOnly cookie for 10 minutes. The callback exchanges the code, reads `/user`, and finds or creates
  the contributor by GitHub user id (`github_id`; the handle is the lowercased login, with `-gh` appended if
  another contributor already has it; system handles such as `maintainers`, `admin` or `director-…` get a `gh-`
  prefix instead). Login, avatar and account creation date are stored.
- **First sign-in** issues a token at once. A token is shown only in the response that issues it (`no-store`),
  with a copy button and next steps (https://www.mtgdecktools.com/agent-bench/play).
- **Account page:** handle, review status, hosted-play quotas, active tokens (prefix, scopes, created, last
  used) with Revoke; Create Token (at most 5 active) and Rotate (revokes every active token, issues one).
  Every change needs a sign-in within the last 10 minutes (signed SameSite=Strict session cookie) and the
  page's CSRF token; cross-origin POSTs are refused.
- **Who is refused:** GitHub accounts with `suspended_at`, suspended contributors, and (optionally) accounts
  younger than `HUB_GITHUB_MIN_ACCOUNT_DAYS`. Sign-ins are rate limited per IP (20 requests per 15 minutes,
  start and callback each count), account changes per contributor (20 per 10 minutes).
- **Review:** GitHub contributors start as `trust = new`, so their first `HUB_REVIEW_FIRST` community
  submissions are held for review as before. Hosted play is governed by the quotas.
- **Admin:** `contributor list` shows GitHub logins and quotas; `contributor quota`, `trust`, `suspend` and
  `token revoke` work for GitHub contributors like any other.
- Pages are plain server-rendered HTML with a strict CSP (no external assets). Tokens, codes, GitHub access
  tokens and cookies are never logged. Off (503 with a message) until both GitHub settings are present.

**Setting up the GitHub OAuth App (owner, once):**
1. On github.com: Settings → Developer settings → OAuth Apps → New OAuth App (for an organization: the
   organization's Settings → Developer settings → OAuth Apps).
2. Application name `MTG Deck Tools Agent Bench`; Homepage URL `https://www.mtgdecktools.com/agent-bench`;
   Authorization callback URL `https://bench-data.mtgdecktools.com/auth/github/callback`. Tick
   "Enable Device Flow" (`npm run bench -- login` uses it). Register application.
3. Copy the Client ID. Click "Generate a new client secret" and copy it (GitHub shows it once).
4. Give the Hub the two values. Either way works; the Coolify UI is preferred (the secret never leaves the server):
   - **Coolify UI (preferred):** project `agent-bench-prod` (or `agent-bench`) → the application → Environment
     Variables: set `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`, then Redeploy.
   - **Local files:** `deploy/coolify-setup.sh` passes them when these files exist on the workstation
     (`~/.config/mtgdt-prod/` for production):
     ```bash
     umask 077; mkdir -p ~/.config/mtgdt
     printf '%s\n' '<client id>'     > ~/.config/mtgdt/github-oauth-client-id
     printf '%s\n' '<client secret>' > ~/.config/mtgdt/github-oauth-client-secret
     chmod 600 ~/.config/mtgdt/github-oauth-client-*
     ```
   `HUB_SESSION_SECRET` needs nothing from you: `deploy/coolify-setup.sh` generates `hub-session-secret` when it
   creates the instance and sets it in Coolify.
5. Check `https://bench-data.mtgdecktools.com/account` shows "Sign In With GitHub", and that
   `npm run bench -- login` prints a code. If the Hub's public URL changes, update the callback URL in the app to
   match `HUB_PUBLIC_URL/auth/github/callback` exactly. Device Flow must stay enabled for `bench login`.

## CLI login (device flow)

`npm run bench -- login` gets a contributor token in the terminal, without a browser on the same machine:

```
POST /auth/device/start
  200 { "device_id": "<opaque>", "user_code": "WDJB-MJHT", "verification_uri": "https://github.com/login/device",
        "interval": 5, "expires_in": 900 }
  429 too many starts from your network (10 per 15 minutes) · 503 sign-in off, or too many sign-ins in progress
POST /auth/device/poll   { "device_id": "<opaque>" }
  200 { "status": "pending", "interval": 5 }
  429 { "status": "slow_down", "interval": 10 }        wait `interval` seconds (GitHub asked, or you polled early)
  200 { "status": "ok", "token": "mtgdt_con_…", "handle": "alice", "scopes": ["submit", "play"],
        "quotas": { "play_concurrent": 1, "play_daily": 6, "lobby_concurrent": 2, "lobby_daily": 12 } }      exactly once; the device session is then gone
  410 { "status": "expired" | "denied", "error": "…" }               start again
  403 { "status": "refused", "error": "…" }    suspended GitHub user or contributor, account too new
  409 { "status": "refused", "error": "…" }    already 5 active tokens: revoke one at /account
  404 { "status": "expired", "error": "…" }    unknown device_id
```

- GitHub's `device_code` stays on the Hub (the client only gets the opaque `device_id`); the GitHub access token
  is used once to read the user and is never stored or logged. Same checks and find-or-create as the web flow.
- Device sessions live in memory until `expires_in` (at most 1,000 at once); a Hub restart ends them (run
  `login` again). Polls faster than `interval` get `slow_down` with the interval raised by 5 seconds.
- The CLI saves the token to `$XDG_CONFIG_HOME/mtgdt-bench/token` (default `~/.config/mtgdt-bench/token`;
  directory 700, file 600) and never prints it. `npm run bench -- logout` deletes the file (the token keeps
  working until revoked at `/account`). `--hub <url>` or `BENCH_HUB` picks another Hub.

**Which token the CLI sends:** one contributor token for everything hosted: `--token`, else `BENCH_TOKEN`, else
the `login` file. `bench new`, `status` and `pull` against a hosted Director use it unless `ADMIN_TOKEN` is set
(the admin); the local stack (`bench up`) keeps using its admin token. `bench submit` reads `--token`,
`BENCH_TOKEN`, then `BENCH_SUBMIT_TOKEN` (deprecated), the `login` file, then `.bench/submit-token` (deprecated).

**Prompt for an AI agent** (paste as is; the agent needs a shell in a checkout of this repo):

```text
Log me in to the MTG Deck Tools Agent Bench so I can run hosted events.
1. In the repository root, run: npm run bench -- login
   Keep it running in the foreground; it waits for me.
2. It prints a GitHub URL (https://github.com/login/device) and a code like WDJB-MJHT.
   Show me both exactly as printed, and ask me to open the URL, enter the code and approve.
3. Wait for the command to finish. Success is the line "Signed in as <handle>".
   If it says the code expired or was canceled, run it again and show me the new code.
4. Never print, copy or paste the token: it is saved to ~/.config/mtgdt-bench/token and
   the bench CLI reads it from there. Tell me my handle and hosted-play quotas.
```

## Hosted Director → Hub hand-off (contract)

- **Endpoint:** `POST $HUB_URL/api/internal/events` (in the Coolify stack `HUB_URL=http://hub:8787`, on
  the internal network; the public URL works too).
- **Auth:** `Authorization: Bearer $HUB_SERVICE_TOKEN` (a token listed in the hub's `HUB_SERVICE_TOKENS`
  as `worker-1:<token>`; deploy/coolify-setup.sh generates it into `~/.config/mtgdt/hub-service-token`).
- **Body:** a results bundle exactly as `npm run bench -- bundle` builds it (`bundle_version` 1:
  `bundle.json`, `events.jsonl`, `summary.json`, `seats-meta.json`, `usage-<seat>.json`, usage-only
  `transcript-<seat>.jsonl`). `Content-Type: application/gzip`.
- **When:** once per event, after `event_end` and `summary.json` are written. Aborted events are not sent.
- **Answers:** 201 with `status` `ingested` or `held`; 409 when already received (safe to retry: the
  same bytes are a no-op, so a Director can resend after a timeout); 400/422 with reasons; 5xx → retry with
  backoff.
- **Director side** (`packages/director/src/hub-handoff.ts`, on when `HUB_URL` and `HUB_SERVICE_TOKEN` are
  set): builds the bundle with the shared `bundle.ts` (created_at = the event's end, so resends are
  byte-identical), POSTs it, and appends a `hub_handoff` record per attempt to the event log (`attempt`, `ok`,
  `status`, `final`, `http`, `bundle_sha256`, `submission_id`, `pack_regeneration`, `holds`, `message`;
  these records are left out of bundles). 201/409 are done; 400/413/422 are `rejected` and never resent;
  401/403 stop until the next start; network errors, 429 and 5xx retry after 10 s, 30 s, 1, 2, 5, 10, 10,
  10 min (one-shot Directors: 5, 15, 30 s). At every start it resends finished events whose hand-off never
  completed, limited to events that log `event_start.boosters` (older runs and community submissions go in
  with `hub import`).

## Migrations (`migrations/`)

Applied in order at every start (and by `npm run hub -- migrate`), each in its own transaction under an advisory lock.
Keep them additive (RELEASING.md "Deploying").

| File | What |
|---|---|
| `001_init.sql` | contributors, tokens, submissions and the index tables (events, seats, picks, decks, games, seat_game_stats, card_stats, ratings) |
| `002_contributor_play.sql` | token scopes (`play`, `contributor`), GitHub accounts, hosted-play quotas |
| `003_contributor_points.sql` | `points_ledger`, Leaderboard Visibility |
| `004_points_v2_sessions.sql` | points v2 (the Hub's acceptance time orders and dates events), session epoch for sign-out |
| `005_us_spelling.sql` | US spelling for column names |
| `006_seat_usage.sql` | `seat_usage`: usage summaries of hosted seats |
| `007_best_of_three.sql` | best of 3 with sideboarding: group keys without `bo=`, earlier formats unrated, `events.sideboarding`, `games.play_draw` / `sideboarding` / `deck_sizes`. Run `npm run hub -- reingest` after deploying it |
| `008_terms_moderation.sql` | terms acceptance (`contributors.terms_version` / `terms_accepted_at`, `consents`), moderation (`moderation_hides`, `moderation_flags`, `moderation_log`, `contributors.moderation_hidden`) and erasure (`erasures`, status `erased`). Run `npm run hub -- reingest` after deploying it, so stored run folders get the shared scrubber |

## Tests

```bash
npm run test -w packages/hub          # unit tests (store, tokens, every integrity check on a real run)
HUB_TEST_DATABASE_URL=postgres://hub:hub@127.0.0.1:5451/hub npm run test -w packages/hub
                                      # + scopes, introspection, quotas and GitHub sign-in against a throwaway
                                      #   Postgres (the test drops its schema) and a mocked GitHub (test/play.test.ts)
bash packages/hub/test/e2e.sh         # end to end: throwaway Postgres (127.0.0.1:5441, tmpfs), hub on :8841,
                                      # a scripted smoke event (needs phase-server on :9374), the bench CLI
HUB_E2E_RUN=tmp/smoke-runs/<id> bash packages/hub/test/e2e.sh   # reuse a finished smoke run
bash packages/hub/test/handoff-e2e.sh # Director → Hub hand-off: Postgres :5445, hub :8845, two smoke events
                                      # (hub down, then up: resend at start, 'verified' packs, 409 on resend)
```

The unit tests need a finished run (`scripts/smoke-event.sh` makes one) and `data/draft-pools.json`; they
skip otherwise. The e2e covers: contributor and token creation, 401s, `bench submit` against the hub,
held-for-review, the status API (own submissions only), 409 on resubmission, approve → NOTIFY → export,
the exported files, CORS/ETag/gzip, the read API, a hash-mismatch bundle (400), a re-hashed forgery that
replays as a draft but fails pack regeneration (422), the hosted-Director path (duplicate decision stream
held), the admin review API, and a takedown.

## Backups

- **Bundles** (`hub-data` volume, `bundles/`) are immutable files: the nightly volume tar is enough.
- **Postgres:** a tar of a live data directory is only crash-consistent, so a logical dump runs nightly into
  the `hub-pgdump` volume (also in the volume tar): the Coolify scheduled task `hub-db nightly pg_dump` on the
  `hub-db` container (set up on the hosted stack; a new deployment must create it):

  ```
  sh -c 'pg_dump -U hub -Fc -f /dumps/hub-$(date +%a).dump hub'     # 7 rolling dumps, daily at 02:20
  ```

  Restore: `pg_restore -U hub -d hub --clean --if-exists /dumps/hub-<Day>.dump`. The nightly open-data build
  starts after it (03:30).
- The index tables can be rebuilt from the bundles (`npm run hub -- reingest`), but contributors, tokens,
  submissions and review decisions exist only in Postgres, so the dump is what protects them.
