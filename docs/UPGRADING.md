# Keeping Dependencies Current

The benchmark builds on upstreams that move on their own schedule: phase-rs ships engine builds and new sets almost daily, 17Lands publishes new data files as sets are played, and MTG Deck Tools set contexts get revised. This guide covers how we track all of them with **one manifest** and **one command**, without silently changing results that are already published.

## At a Glance

```bash
npm run deps -- check                         # what's out of date? changes nothing
npm run deps -- update 17lands                # refresh changed and newly published 17Lands sets
npm run deps -- update set-context            # re-export the MTG Deck Tools set contexts
npm run deps -- update phase --dry-run        # full check of the newest engine, never switches
npm run deps -- update phase                  # switch the engine pin (only if the smoke event passes)
npm run deps -- update all                    # all of the above
```

A GitHub Actions workflow runs `check` every Monday and opens pull requests for whatever changed ([Automation](#automation)). Nothing is ever pushed to `main` or deployed automatically.

## What We Depend On

| Upstream | What we pin | Where it's recorded | How it updates |
| --- | --- | --- | --- |
| **phase-rs engine** (`ghcr.io/phase-rs/phase-server`) | Image digest, server version, build commit, wire-protocol version | `engine/phase.lock.json` (the manifest references it by hash) | `npm run deps -- update phase` (wraps `scripts/upgrade-phase.sh`) |
| **phase-rs card and booster data** (`card-data.json`, `draft-pools.json`, built by phase-rs from MTGJSON) | Comes with the engine image | `deps/manifest.json` → `phase_rs.data` (sha256, size, card and set counts) and `phase_rs.booster_sets` | With the engine |
| **Card overrides** (ours: `engine/overrides/`, docs/CARD-OVERRIDES.md) | Each override's upstream card entry (`applies_to.entry_sha256`) and build | The override files; applied sets in `data/card-overrides.json` and `event_start.provenance.card_data` | `npm run overrides -- check` (part of `deps -- check`), then test, re-pin or retire by hand |
| **phase-rs card coverage** (`https://data.phase-rs.dev/coverage-data.json`) | The unsupported-card list packs swap out | `data/unsupported-cards.json`; sha256 in the manifest | With the engine (`scripts/refresh-phase-data.py`) |
| **17Lands public datasets** (S3, CC BY 4.0) | One snapshot per set: source files, ETag, Last-Modified, rows, date range | `deps/manifest.json` → `17lands.sets.<SET>`, plus `sets/<SET>/17lands.json` | `npm run deps -- update 17lands` |
| **MTG Deck Tools Set Context** (written on mtgdecktools.com; published at `/agent-bench/set-contexts/<SET>.md`) | The exported text of each featured set, after the tier-score filter (`packages/director/src/set-context-filter.ts`, METHODOLOGY §3 "The tier-score filter"; the header notes it, and the published-copy check compares the filtered site copy) | `sets/<SET>/primer.md` (the Set Context file); source commit and sha256 in the manifest | `npm run deps -- update set-context` |
| **Model registry** (`registry/`, resolver in `packages/registry`) | Its content-hash version | `deps/manifest.json` → `registry.current` (reference only) | Edited by hand, see `registry/README.md` |
| **Scryfall** | Not pinned: the report site loads card images at view time | `deps/manifest.json` → `scryfall` | Nothing to do |
| **npm packages, GitHub Actions** | `package-lock.json`, action SHAs | Dependabot (monthly, minor and patch) | Dependabot pull requests |
| **Python analysis environment** | `analysis/uv.lock` | Its hash is in `17lands.generators.analysis` | `cd analysis && uv lock --upgrade`, then rebuild the analysis outputs |

Set codes differ between sources now and then. **`deps/set-codes.json`** is the one place that maps them (phase-rs code → 17Lands code, MTG Deck Tools file name → phase-rs code). Edit that file, never the scripts.

## The Manifest

`deps/manifest.json` is the single answer to "what versions of everything are we on?". It is written by `scripts/deps.py` (`npm run deps -- manifest` recomputes it from the files on disk); don't edit it by hand. CI runs `npm run deps -- verify`, which fails if a derived file no longer matches its recorded sha256, so derived data can't change without the manifest noticing.

```jsonc
{
  "schema": "deps-manifest/1",
  "updated_at": "2026-10-22T05:12:09Z",
  "phase_rs": {
    "lock_file": "engine/phase.lock.json", "lock_sha256": "…", "server_version": "0.115.0", "protocol_version": 159,
    "data": {
      "card_data": { "file": "data/card-data.json", "sha256": "…", "cards": 36004 },
      "booster_data": { "file": "data/draft-pools.json", "sha256": "…", "sets": 175 },
      "unsupported": { "file": "data/unsupported-cards.json", "sha256": "…", "count": 1234 }
    },
    "booster_sets": ["10E", "2ED", "…"],
    "history": [ { "digest": "sha256:…", "server_version": "0.114.0", "replaced_at": "…" } ]   // earlier pins; the Hub accepts them
  },
  "17lands": {
    "source": "https://17lands-public.s3.amazonaws.com/analysis_data", "codes_file": "deps/set-codes.json",
    "generators": { "ratings": "scripts/build-17lands-ratings.py v2", "analysis": "analysis/draft_eval (uv.lock sha256 …)" },
    "thresholds": { "ratings_min_game_rows": 20000, "min_expert_drafts": 1000, "…": "…" },
    "checked_at": "…",
    "sets": {
      "FRA": {
        "code": "FRA", "format": "PremierDraft", "snapshot": "FRA.PremierDraft@2026-10-19T16:20:26Z",
        "files": { "game_data": { "url": "…", "etag": "…", "last_modified": "Mon, 19 Oct 2026 16:20:14 GMT", "bytes": 24570968, "rows": 297964 },
                   "draft_data": { "…": "…" } },
        "date_range": ["2026-09-29 …", "2026-10-18 …"],
        "games": 297964, "drafts": 56527, "cards": 295, "rated_cards": 284, "sampled": false,
        "outputs": { "sets/FRA/17lands.json": "<sha256>", "sets/FRA/ratings.tsv": "…", "analysis/models/FRA.json": "…" },
        "skipped": { "model": "1,204 expert drafts < …" },          // outputs deliberately not built, and why
        "analysis": { "model": { "holdout_top1": 0.627 }, "norms": { "verdict": "validated" } }
      }
    },
    "no_public_data": ["10E", "…"],          // phase-rs sets 17Lands has no public file for
    "unmapped": { "SPM": "…" }               // sets deps/set-codes.json deliberately leaves out
  },
  "set_context": { "source_commit": "<Magic-Deck-Builder commit> <date>", "sets": { "FRA": { "file": "sets/FRA/primer.md", "sha256": "…" } } },
  "registry": { "current": { "version": "sha256-…", "models": 12, "harnesses": 6 } },
  "scryfall": { "pinned": false }
}
```

The **snapshot id** (`<17Lands code>.<format>@<newest Last-Modified of its files>`) is what events and exports record, so any number can be traced to the exact data behind it.

## 17Lands

### What We Use

- Only the documented public files: `https://17lands-public.s3.amazonaws.com/analysis_data/{game_data,draft_data}/…_public.<CODE>.<FORMAT>.csv.gz`. Never the 17lands.com website API.
- **PremierDraft**, or **TradDraft** when a set has no PremierDraft file at all. Other formats (QuickDraft, PickTwoDraft, Sealed, Cube) are ignored.
- The bucket doesn't allow listing, so discovery probes candidate codes with HEAD requests: every phase-rs booster set plus `deps/set-codes.json`. A set phase-rs doesn't have can't be played anyway; once phase-rs adds it, the next `check` probes it.
- Downloads are sequential, retried with exponential backoff, and send a User-Agent naming the project. Raw files go to `data/17lands/` (gitignored) and are deleted after deriving unless `--keep-raw`.
- Attribution stays as described in `sets/README.md` (CC BY 4.0, derived aggregates, not endorsed by 17Lands).

`sets/README.md` lists which sets are covered and which codes are mapped or left out.

### What Gets Built per Set

| Step | Output | Skipped (and recorded in the manifest) when |
| --- | --- | --- |
| `ratings` | `sets/<SET>/17lands.json`, `ratings.tsv` | fewer than 20,000 game rows |
| `archetypes` | `sets/<SET>/17lands-archetypes.json` | fewer than 20,000 game rows |
| `model` | `analysis/models/<SET>.json`, `analysis/results/validation-<SET>.json` | no draft data file, no player-skill columns, or fewer than 1,000 expert drafts |
| `norms` | `sets/<SET>/deck-norms.json`, `analysis/results/build-quality-<SET>.json` | no archetype ratings or fewer than 5,000 decks |

Per-card thresholds (200 games in hand for win rates, 30 picks for ATA/ALSA, 50 main decks for an archetype cell) are unchanged. The set-level thresholds live in `scripts/build-17lands-ratings.py` (`MIN_GAMES`) and `analysis/draft_eval/config.py`, and the manifest repeats them.

### Common Tasks

```bash
npm run deps -- check                                   # which 17Lands files changed, which sets are new
npm run deps -- update 17lands                          # rebuild exactly those
npm run deps -- update 17lands --set FRA --set HOB      # named sets (even if unchanged)
npm run deps -- update 17lands --set FRA --steps ratings   # only the card ratings (no uv needed)
```

**Full local refresh** (every set, hours; the weekly workflow only refreshes featured and newly published sets):

```bash
nohup npm run deps -- update 17lands --all --force --summary tmp/deps/full.md > tmp/deps/full.log 2>&1 &
tail -f tmp/deps/full.log
```

The manifest is written after every set. If a run is interrupted, rerun it without `--force`: sets already rebuilt from the current files are skipped. Needs `uv` (the analysis environment in `analysis/`), `data/draft-pools.json` and `data/card-data.json` (from the pinned phase-server; see the README quick start). About 3 to 10 minutes and 100 to 500 MB of downloads per set, all deleted afterwards.

**A new set appears on 17Lands:** `check` lists it under "new"; `update 17lands` builds it and adds it to the manifest. Its human stats then show on `/api/sets` (`human_stats`) and the Set Context + Human Stats knowledge level (`primer+stats`) becomes available. The featured list in `sets/rotation.json` doesn't change.

**A code doesn't match:** add it to `deps/set-codes.json` → `17lands.codes` (`{"XYZ": {"17lands": "ABC"}}`, or `null` with a reason to leave it out), then `update 17lands --set XYZ`.

## phase-rs Upgrades

### Policy

1. **Run upstream, unmodified.** We use the official `ghcr.io/phase-rs/phase-server` image. Anything we need from the engine (settable seeds, server-side replay logs, …) goes upstream as a PR, not into a long-lived fork. If we ever must carry a patch, it lives in `engine/patches/` as a small rebased patch with an upstream PR link, and `upgrade-phase.sh` must apply it. The one exception is **card overrides** (docs/CARD-OVERRIDES.md): a fix to one card's entry in the card data, never to the binary. Each one is pinned to the exact upstream entry it was written against, tested in scripted games, recorded with every event, linked to an upstream issue, and retired once upstream fixes the card.
2. **Pin by digest, in data, not code.** `engine/phase.lock.json` records the image digest, server version, build commit and protocol version. The Director reads the protocol version from it (phase-server demands an exact match).
3. **Never upgrade blind.** Every upgrade runs a full smoke event (eight scripted agents: draft → decks → 3-round Swiss of best-of-3 matches with sideboarding, on FRA) against the candidate build before switching.
4. **Record the build with every result.** Each event logs the pinned build (`event_start.provenance.engine`, read from `engine/phase.lock.json` when the Director starts) and its booster data (`event_start.boosters`), so results from different engine versions are never silently mixed. Engine builds pool in the ratings (METHODOLOGY §3); the record is what lets an analysis split them.
5. **Finished events stay valid.** Games are not re-simulated (replay verification needs a settable seed and a replay log from phase-rs, and isn't built), so a new engine build never invalidates a finished event. What the Hub re-checks is pack regeneration, which needs only the outgoing booster data (archived below) and an accepted engine digest.

### Upgrade

```bash
npm run deps -- check                       # newer image? newest release tag and its protocol version
npm run overrides -- upstream               # which swapped cards the new release (or phase-rs main) fixes; open PRs
npm run deps -- update phase --dry-run      # pull, probe, data report, smoke event; never switches
npm run deps -- update phase                # the same, then switch the pin if the smoke event passes
```

Before upgrading, `npm run overrides -- upstream` (read-only; docs/CARD-OVERRIDES.md "Upstream") lists every card the featured sets swap out of packs, with the phase-rs PRs and issues that name it and whether the newest release's card data or the coverage report already supports it: what the upgrade will fix, and which card overrides it lets you retire. On a machine that already runs the stack, `PHASE_CANDIDATE_NAME`, `PHASE_CANDIDATE_PORT`, `PHASE_CANDIDATE_SMOKE_PORT` and `PHASE_LOCAL_CONTAINER` (empty: don't restart a local phase-server) keep `upgrade-phase.sh` off the ports and containers in use.

`update phase` archives the outgoing `draft-pools.json` and unsupported list as `<sha256>.json` (in `$HUB_BOOSTER_ARCHIVE`, default `data/booster-archive/`), then runs `scripts/upgrade-phase.sh`: pull the image → start it beside the current one on :9375 → read protocol version and build → copy `card-data.json` and `draft-pools.json` → rebuild `data/unsupported-cards.json` → print what changed (new draft sets, card count, protocol bump) → run `scripts/smoke-event.sh` against it → on success install the data, rewrite the lock file and compose defaults, and restart `mtgdt-phase` on the new digest. Afterwards it records the outgoing pin in `phase_rs.history` (the Hub keeps accepting events from it) and the archived file names in `phase_rs.archived`, and prints a summary. Commit `engine/phase.lock.json`, `deploy/` and `deps/manifest.json` in their own pull request.

Finish local events first: the restart of the local `mtgdt-phase` container drops their live games.

**Card overrides after an upgrade.** The upgrade installs upstream card data in `data/` and the new container, so no override is active until you run `install`. Each override is pinned to its card's upstream entry. When the new build changed that entry, the override is skipped as stale (`upgrade-phase.sh` and `npm run deps -- check` say which).
1. Run `npm run overrides -- test` against the new data:
   - every case now `fixed` on upstream data: upstream fixed the card. Retire the override, and mark the known issue `fixed` with `fixed_in`.
   - still `bug`: re-pin `applies_to` to the new entry, adjust the patch if needed, and re-test.
2. Then run `npm run overrides -- install`.

### When the Smoke Test Fails

Usually a wire-protocol change (`check` warns when the newest release changes the protocol version). Where to look:
- `packages/director/src/phase.ts`: handshake, lobby messages, action and rejection messages.
- `packages/director/src/game.ts`: `waiting_for` variants (`prompt()`), `GameAction` labels (`label_()`), smart-stop phases.
- The smoke summary reports **options without a readable label**: new `GameAction` variants show up there first. Add a label, rerun.
- Upstream reference: `crates/lobby-broker/src/protocol.rs` and `protocol/` in phase-rs.

### New Sets from phase-rs

A new set appears in `draft-pools.json` as soon as phase-rs adds it; the upgrade summary lists it. It is playable at once, hosted or self-hosted (`--set <code>`), and fully scored: every number that ranks agents needs only card data and the logs. Optional extras:
1. Human stats: once 17Lands publishes data, `npm run deps -- check` lists the set as new and `update 17lands` builds it.
2. A Set Context: write it in MTG Deck Tools, then `npm run deps -- update set-context`.
3. The site's featured list (`sets/rotation.json`): an editorial choice.

### Deploying an Engine Upgrade (Hub and Production)

In this order, after the pull request is merged:

1. **Wait until nothing is live: `deploy/deploy.sh --drain-events [minutes]`** (a bare push to the deploy branch skips this guard: OPERATIONS "Deploying"). It stops admitting events and forming lobby tables, lets running events play on to their end (unlike `--drain`, it doesn't hold their games), and deploys once `GET /api/admin/status` shows no live event; queued events start afterwards, on the new build. If events are still live after the wait (240 minutes by default), it gives up, lifts the drain and deploys nothing (`--force` deploys anyway). `deploy.sh` compares the running phase-server's image with the new pin and **refuses an engine change while any event is live** unless `--drain-events` or `--force` is given. Why: an event that resumes on the new build plays its remaining games on it while its `event_start.provenance.engine` names the old one (its `event_resume.provenance` records what runs from then on), and a game in progress can't continue across builds (it is voided and replayed). With `--force`, live events still resume: a resumed event regenerates its packs from the booster data it started on, kept by the Director (below), not from the new build's.
2. **Booster data is archived by itself.** At every start the Director archives the booster data it runs on in `director-cache/booster-archive/<sha256>.json` (`BOOSTER_ARCHIVE`; `BOOSTER_ARCHIVE_DIRS` adds more places to look), so the outgoing build's files are there before any upgrade. An event resumed after an upgrade builds its packs from the files its `event_start.boosters` hashes name (without them it stops as `resume_failed`), and the hosted Hub reads the same archive for pack regeneration (`HUB_BOOSTER_ARCHIVE_DIRS=/director-cache/booster-archive`, besides its own `HUB_BOOSTER_ARCHIVE`), so events from the outgoing build keep verifying with no copy step at deploy. (Self-hosted Hubs: copy the files from `data/booster-archive/` into `HUB_BOOSTER_ARCHIVE`.)
3. **The card data follows the pin.** The hosted stack's `card-data` service (docs/CARD-OVERRIDES.md, "Running It in Production") sees that the volume's upstream files aren't the new pin's, downloads the new build's `card-data.json` and `draft-pools.json` from its release data manifest, checks them against `deps/manifest.json`, and applies the card overrides again; phase-server then starts on them with `--no-data-download`. Overrides pinned to entries the new build changed are skipped (its log says `SKIPPED`): re-test them, then retire or re-pin (CARD-OVERRIDES "Lifecycle").
4. **The Director's unsupported-card list follows the engine.** The list the hosted Director builds in its cache (`director-cache/unsupported-cards.json`) records the upstream card data it was built for (`card_data_sha256`; with card overrides applied, the upstream file's hash); when the card data changes, the Director archives the old list and builds a new one at start. Nothing to delete by hand any more (a curated list with `sources`, from `scripts/refresh-phase-data.py`, is never replaced). Card overrides that make a card supported then take it off that list, and a retired or stale override puts it back (CARD-OVERRIDES "Supported Cards and Packs"); the previous list is archived first, and events record the list they ran on.
5. **Protocol pin.** The deploy builds the Director from the merged commit, so it reads the new protocol version from `engine/phase.lock.json`, and the compose default `PHASE_IMAGE` is the new digest: Director and engine switch together.
6. **Accepted builds.** The Hub accepts the pinned digest plus every earlier pin in `deps/manifest.json` → `phase_rs.history` (and `HUB_ALLOWED_ENGINE_DIGESTS` for anything else), and their card data (`card_data_sha256` in the history, for the `provenance.card_data` check). Nothing to configure.
7. **Verify.** `curl https://<director>/health`, run a scripted event against the hosted Director, and check its hand-off: the `hub_handoff` record (or `GET /api/submissions/:id` on the Hub, with the Hub admin token) should show `pack_regeneration` `verified` and no holds.
8. **Changelog.** Add a line under **Unreleased** with the server version, protocol version and digest.

**Rollback.** Redeploy the previous commit: its lock file and compose default bring back the old digest and protocol. Events started on the new build keep their provenance, but the rolled-back Hub no longer knows the newer digest (it isn't in the old lock file or history): add it to `HUB_ALLOWED_ENGINE_DIGESTS`, or events played on it are held for review. The Director archived the newer build's booster data when it started on it, as on any start. An event that spans the rollback has the same problem as one that spans the upgrade (step 1).

## Set Context

```bash
npm run deps -- check                          # compares the Set Contexts (the published copies, or our site checkout) with sets/<SET>/primer.md
npm run deps -- update set-context --from-site # use https://www.mtgdecktools.com/agent-bench/set-contexts/<SET>.md
npm run deps -- update set-context             # export from a checkout of the closed-source site; records the source commit
```

Without a site checkout, use `--from-site` (the weekly workflow does). The checkout defaults to `../Magic-Deck-Builder` (or `$MTGDT_REPO`, or `--repo`). Only featured sets are exported (`sets/rotation.json`); `check` also lists set contexts that exist for non-featured sets. The Director itself prefers the published copy at run time and logs its sha256 in `event_start.knowledge.primer`. A set without a published copy shows as "not published" in `check`, and the weekly workflow leaves it alone.

## Reproducibility

What every event records about its inputs:

| Input | Recorded in `event_start` | Notes |
| --- | --- | --- |
| Engine build | `provenance.engine` (digest, version, build, protocol) | |
| Card data | `provenance.card_data` (`sha256` of the file phase-server ran; with card overrides, `upstream_sha256`, `overrides_sha256` and the override slugs) | docs/CARD-OVERRIDES.md; new in 2026-10-22 logs |
| Booster data | `boosters.draft_pools_sha256`, `unsupported_sha256` | The Hub looks archived files up by hash |
| 17Lands data behind fallback picks and reference builds | `ratings` (policy) and **`ratings_snapshot`** (`id`, `sha256` of the `17lands.json` bytes, date range) | New in 2026-10-22 logs |
| Set Context | `knowledge.primer` (source, sha256) | |
| Model registry | the export records `registry_version` | |

**Policy.**
- **Rated outcomes never depend on 17Lands.** Match results, the rating and every core metric come from the logs and card data. A refresh can't move them.
- **What ran is fixed by the log.** Fallback picks (watchdog forfeits) and reference builds are logged as they happened. The Director also pins each event's ratings file (`runs/<id>/ratings-17lands.json`, written at event start): a resumed event reads its own copy, never the refreshed `sets/<SET>/17lands.json`.
- **The human reference uses the latest data.** "Compared with human drafters" (pick regret against 17Lands ratings, archetype values, the expert pick model, build quality against human norms) is recomputed at export time from the current snapshot. It is descriptive, more data makes it better, and it never feeds the rating. Each event export says which snapshot it used (`config.inputs.ratings_snapshot`, with the date range) next to the snapshot the event ran with (`config.ratings_snapshot`), so a reader can see when they differ. If a future rating ever uses a 17Lands-derived covariate (METHODOLOGY §5.3, the open pilot-rating item), it must read the event's own snapshot instead.

**Mid-draft resume and a 17Lands refresh.** On restart the Director replays the draft through the same code: agent picks come from the log, and bot picks (dev events with bot fill) are recomputed and must match the log, or the event aborts with `resume_failed`. Before per-event pinning, deploying a refresh while an event was mid-draft could change the bot policy's values, so replayed bot picks could diverge (abort) and later fallback picks in a resumed product event would use different numbers than earlier ones. With pinning:
- events that started on a build with pinning keep their snapshot across any number of restarts;
- events that started before pinning existed have no pinned copy and pick up the new file on resume: deploy a 17Lands refresh only when `GET /api/events` shows no event in its draft (or with `deploy.sh --drain`), as for engine upgrades;
- a set that had no 17Lands data when the event started stays on the card-quality heuristic for the whole event, even if data arrives mid-event.

## Automation

`.github/workflows/deps.yml` runs every Monday at 07:23 UTC, and on demand (Actions → Dependencies → Run workflow, with `what`: all / data / phase and `max_sets`).

1. **check** runs `npm run deps -- check --json` and uploads the report.
2. **data** (if a 17Lands file or a published Set Context changed): copies card data from the pinned engine, rebuilds the **changed featured sets and newly published sets** (at most `max_sets`, default 6, per run), refreshes the Set Context from the published copies, verifies the manifest, and force-pushes one rolling branch `deps/data-refresh` with one pull request (title "chore(deps): 17Lands data and Set Context refresh"). The body has the summary (sets added or updated, snapshots, the biggest card rating moves) and the manifest diff. Changed sets that aren't featured are listed for a local refresh.
3. **phase** (if a newer engine image exists): starts the pinned engine, runs `npm run deps -- update phase` (the smoke event runs there against the candidate), and opens its own pull request on `deps/phase-<version>`. A blocked upgrade fails the job and changes nothing.

Both jobs run with a read-only token and hand their change on as a patch artifact. A small follow-up job (**data-pr**, **phase-pr**) applies it, refuses anything outside the refreshed paths, pushes the branch and opens the pull request; it is the only job that can write, and it runs `git` and `gh` only. It also starts `ci.yml` on the branch (pull requests opened with `GITHUB_TOKEN` don't trigger workflows by themselves), so the integration and image jobs run against the new pin in CI too. CI's image job also checks that phase-server's `env -i` list in `deploy/compose.yaml` still has the new image's own defaults; if it fails, copy the new values there.

**Limits.** Standard runners have about 14 GB of free disk (the job frees more), 16 GB of RAM and a 6-hour job limit; one set's raw files are at most about 0.5 GB and are deleted before the next set. That's why CI refreshes featured and new sets only, a few per run: a full refresh of every set is the local command above.

**Setup (once):** Settings → Actions → General → Workflow permissions → allow GitHub Actions to create and approve pull requests. No secrets are needed: 17Lands, GHCR and the published set contexts are public, and `GITHUB_TOKEN` only pushes branches and opens pull requests.

## What to Check in a Pull Request

**17Lands refresh**
- The summary: new sets, snapshot dates, games and drafts. A set whose games went *down*, or whose snapshot date went backwards, means 17Lands replaced the file: look before merging.
- The biggest rating moves. A few points for a card with thousands of games is unusual; check the date range didn't shrink.
- `skipped` entries: an output skipped for a featured set (for example "fewer than 1,000 expert drafts") means that set loses a human-reference metric.
- `npm run deps -- verify` is green in CI.
- Don't merge in the middle of a hosted event's draft if the Director build predates per-event pinning (see [Reproducibility](#reproducibility)).

**Engine upgrade**
- The protocol version: a bump means the Director's wire handling was exercised by the smoke event, but read `phase.ts`/`game.ts` changes upstream if anything looks off.
- New sets and the card count.
- CI's "Smoke event and Hub e2e" is green on the branch, and "options without a readable label=0".
- Plan the deploy: [Deploying an Engine Upgrade](#deploying-an-engine-upgrade-hub-and-production).
- Card overrides: `npm run overrides -- test` against the new data. Each override is retired or re-pinned in the same pull request (above).

**Set Context**
- Read the diff: it's the MTG Deck Tools author's text, shown to agents at the Set Context levels (`primer`, `primer+stats`).

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `verify` fails in CI: "differs from deps/manifest.json" | A derived file was edited without the manifest. If deliberate (for example a key rename), run `npm run deps -- manifest` and commit it. |
| `update 17lands` says "no public file" for a set you expected | 17Lands may use another code. Probe it (`npm run deps -- check --set XYZ`), then map it in `deps/set-codes.json`. |
| A set is "thin" or a step is "skipped" | Too little data for that output. It'll be built on a later refresh once 17Lands has more games. |
| A set's pick model or archetypes are "skipped" with "older file" | The 2021 sets' files (re-exported January 2024) are gzipped tars in an older format: match-based skill buckets (no expert model) and, for some, no `main_colors` (no archetype ratings). Expected; see sets/README.md. |
| `uv` not found | Install it (`pipx install uv`), or run `--steps ratings` for the card ratings alone. |
| `check` can't reach GHCR or GitHub | The phase section reports the error; the other checks still run. Rate-limited locally? Set `GITHUB_TOKEN`. |
| A 17Lands download keeps failing | It's retried 5 times with backoff; rerun later. Partial downloads are never used (size is checked). |
| `update phase` says "UPGRADE BLOCKED" | See [When the Smoke Test Fails](#when-the-smoke-test-fails). Nothing changed. |
| An old event shows `unverifiable` in the Hub after an engine upgrade | Its booster data isn't in the Hub archive: copy the old `draft-pools.json` (from `data/booster-archive/` or a backup) into `HUB_BOOSTER_ARCHIVE` as `<sha256>.json`. |
