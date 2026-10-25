# Operations Runbook

How to deploy and watch the hosted stack, and what to do when part of it fails. Each instance is one Coolify application on `gr3g-server`, built from this repository ("Deploying" below), with five containers: `card-data` (stages the engine's card data with the card overrides, then idles), `phase-server` (the rules engine), `director` (https://agent-bench.dev.greg.tech), `hub` (https://agent-bench-hub.dev.greg.tech) and `hub-db` (Postgres 17). Architecture: [ARCHITECTURE.md](ARCHITECTURE.md). Deploys and releases: [RELEASING.md](RELEASING.md). Security reports and threat model: [SECURITY.md](SECURITY.md).

Conventions below:
- `ssh gr3g-server` reaches the host (see `~/Coding Projects/Server Config`). Coolify names containers `<service>-<uuid>`: find them with `ssh gr3g-server "docker ps --format '{{.Names}}' | grep -E '^(card-data|director|hub|hub-db|phase-server)-'"`. Below, `<card-data>`, `<hub>`, `<hub-db>`, `<director>` and `<phase>` mean those names.
- Admin calls read the token from a file, never from the command line: `curl -H @<(printf 'Authorization: Bearer %s\n' "$(cat ~/.config/mtgdt/admin-token)") …`. Below that is `admin_curl`.
- Hub admin commands run inside the container: `ssh gr3g-server docker exec <hub> npm run hub -- <command>` (the list is in [packages/hub/README.md](../packages/hub/README.md)).
- Never print a secret, and stop processes by PID, never by pattern.

## Deploying

Each instance is a Coolify **application** (Docker Compose build pack) built from GitHub, so a deploy works from anywhere and needs nothing from a workstation:

| Instance | Coolify project and application | Branch Coolify deploys | Director, Hub | Workstation copy of its secrets |
|---|---|---|---|---|
| dev | `agent-bench` | `deploy/dev` | agent-bench.dev.greg.tech, agent-bench-hub.dev.greg.tech | `~/.config/mtgdt/` |
| prod | `agent-bench-prod` | `deploy/prod` | bench.mtgdecktools.com, bench-data.mtgdecktools.com | `~/.config/mtgdt-prod/` |
| test (throwaway) | `agent-bench-git-test` | a work branch | agent-bench-git-test(-hub).dev.greg.tech | `~/.config/mtgdt-test/` |

How it works: the repository is `grpace/mtgdecktools-agent-bench`, read through Coolify's `grpace-github` GitHub App (installed on all of the owner's repositories, so it already sees this one). The application's base directory is `/deploy` and its compose file `compose.yaml`. A push to the instance's branch reaches Coolify through the App's webhook (auto-deploy is on). Coolify then:
1. Clones that commit.
2. Builds the Director image from the repository's `Dockerfile`, with the `.dockerignore` allow-list deciding what goes in, and tags it `mtgdt-director:<commit>`.
3. Stops the old containers. The Director checkpoints live events on SIGTERM.
4. Starts the new stack. phase-server runs the digest the commit pins in `engine/phase.lock.json`.

The build comes before the stop, so the stack is down only for the restart. `/health` on the Director and the Hub reports the commit's short sha (`SOURCE_COMMIT`). **A deploy is moving a deploy branch.** Branches rather than tags, because Coolify follows a branch and its webhook fires on pushes to it. One branch per instance means dev and prod move independently. The branch history shows what ran when, and rollback is moving it back.

**From the workstation** (the usual way): `INSTANCE=dev|prod deploy/deploy.sh [--drain | --drain-events] [--ref <commit>]`. It:
1. Refuses a commit without a passing `scripts/ci-local.sh --full` stamp. For prod, it also refuses a commit that isn't on `origin/main`.
2. Refuses an engine-pin or card-override change while events are live, unless `--drain-events` waits them out or `--force` says so. It drains first when asked.
3. Pushes the commit to the deploy branch, and follows Coolify's deployment until `/health` on both hosts reports the commit.
4. Installs that commit's `scripts/ops-check.sh` on the host.

An instance's first deploy also creates its Coolify application (`deploy/coolify-setup.sh`, below). `--redeploy` rebuilds the branch's current commit. A deploy takes about a minute when the dependency layer is cached (a fresh build is a few minutes). The public `/health` is down about 20 seconds of it: 19 s of 503s, measured 2026-10-25.

**Remotely, without the workstation:**
- **A new commit:** from any checkout with push access, `git push origin <sha>:refs/heads/deploy/prod`. Coolify starts the deployment within seconds. Only push a commit that passed CI (below), and for an engine or card-override change only when `https://<director>/api/capacity` shows `live.events` at 0.
- **The same commit again** (a restart with a fresh build, or after changing a variable): Coolify UI (coolify.greg.tech, behind Cloudflare Access) → the project → the application → **Redeploy**.
- **A failed deploy** leaves the previous containers running only if the build failed. Coolify > the application > **Deployments** shows each deployment's log.

**The CI gate.** While the repository is private, the gate is `deploy.sh`'s check of the local CI stamp; a hand push skips it, so the rule is: a deploy branch only ever moves to a commit that passed `scripts/ci-local.sh --full`. Coolify itself can't run the check (it only builds and starts). Recommended once the repository is public and GitHub CI runs on `main`: a ruleset on `deploy/*` that requires the CI checks ("Typecheck and unit tests", "Smoke event and Hub e2e", "Image builds and boots") and blocks force pushes for everyone but the owner. GitHub then refuses a push of an unchecked commit from anywhere, and `deploy.sh` can accept a green GitHub run in place of the stamp.

### Setting Up or Changing an Instance

`INSTANCE=<instance> deploy/coolify-setup.sh [--deploy]` creates or updates the Coolify application (over SSH, through `php artisan tinker`, like `server-ops`). Each run first takes a verified dump of Coolify's database to `~/documents/backup/pre-clone/` on the host (Server Config rule; the last 10 per instance are kept). It sets:
- the repository, branch, base directory and compose file;
- the domains (`https://<host>:8787` for `director` and `hub`);
- auto-deploy on, "Include Source Commit in Build" on, Dockerfile ARG injection off;
- the variables below;
- the nightly `pg_dump` scheduled task on `hub-db`.

Run it to create an instance (or let its first `deploy.sh` do it), and again after changing a secret, a domain or the branch, then redeploy. It generates secrets only for an instance that doesn't exist yet. If one is missing for an instance that does, it refuses; `--recover-secrets` copies the missing ones back from the running containers.

**Coolify variables** (Coolify > the application > Environment Variables; all runtime only, none reaches the image build):

| Variable | Set by | Notes |
|---|---|---|
| `ADMIN_TOKEN`, `HUB_ADMIN_TOKEN`, `HUB_DB_PASSWORD`, `HUB_SERVICE_TOKEN`, `HUB_SESSION_SECRET`, `MTGDT_CONTRIBUTOR_SALT` | `coolify-setup.sh`, from the instance's secret folder | Never regenerate `contributor-salt`; change `hub-db-password` only with `ALTER USER` first ("Rotating Secrets") |
| `PUBLIC_URL`, `HUB_PUBLIC_URL` | `coolify-setup.sh` | `https://` + the instance's hosts |
| `SUBMIT_TOKENS` | `coolify-setup.sh`, from `submit-tokens` (one `name:token` per line) | Empty: the Director's interim submission endpoint is off |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | `coolify-setup.sh` when `github-oauth-client-{id,secret}` exist, else the Coolify UI | The setup never blanks a value set in the UI |
| `MAX_CONCURRENT_GAMES`, `MAX_QUEUE`, `EVENT_MAX_HOURS`, `QUEUE_MAX_WAIT_HOURS`, `SPECTATE_DELAY_S`, `MTGDT_CONTACT_URL`, `HUB_PLAY_CONCURRENT`, `HUB_PLAY_DAILY`, `HUB_LOBBY_CONCURRENT`, `HUB_LOBBY_DAILY`, `HUB_GITHUB_MIN_ACCOUNT_DAYS` | Empty: `compose.yaml`'s default applies | A value set in Coolify overrides it (see "Coolify Variables") |
| `PHASE_RUST_LOG`, `*_MEM_LIMIT`, `*_PIDS_LIMIT` | Not listed: `compose.yaml`'s default | Add the variable in Coolify to override |
| `MTGDT_TERMS_URL`, `MTGDT_PRIVACY_URL`, `MTGDT_CONTENT_POLICY_URL`, `HUB_TRUST_PROXY_HOPS` | By hand in Coolify (production, LAUNCH-DAY step 3) | Every variable reaches every container through Coolify's `.env` |
| `PHASE_IMAGE`, `DIRECTOR_TAG`, `SOURCE_COMMIT` | Never | The commit decides the engine and the image; `coolify-setup.sh` deletes them if present |
| `SOURCE_COMMIT`, `COOLIFY_*`, `SERVICE_URL_*`, `SERVICE_FQDN_*` | Coolify, at each deploy | `SOURCE_COMMIT` tags the image and gives `/health` its version |

### What Every Deploy Does Inside the Stack

What `deploy.sh` used to do on the workstation now happens in the containers, so a deploy from Coolify or a bare push is complete:
- **The image** is built by Coolify from the commit (no image built elsewhere). Coolify's nightly cleanup removes images no container uses.
- **Booster data for old events:** the Director archives the booster data it runs on at every start (`director-cache/booster-archive/<sha256>.json`). The Hub reads that archive (`HUB_BOOSTER_ARCHIVE_DIRS`) as well as its own `HUB_BOOSTER_ARCHIVE`, so events from before an engine upgrade keep passing pack regeneration with no copy step.
- **Card data:** the `card-data` service stages the pinned data and the card overrides at every start (as before).
- **Volume ownership:** new volumes start owned by uid 999 (the Dockerfile creates the mount points so). The one-time hand-over of root-owned volumes (OPS-1) was done on dev on 2026-10-22. A volume restored from an older backup may need it again: stop the stack, then `docker run --rm --user 0 -v <volume>:/v --entrypoint chown mtgdt-director:<commit> -R 999:999 /v`.
- **The nightly Hub dump** is a Coolify scheduled task of the application (`coolify-setup.sh` creates it).
- **Not in the stack:** the ops check runs from the host's crontab. `deploy.sh` installs the deployed commit's copy; a deploy without it leaves the installed copy, which keeps working (it reads only URLs, labels and volume names). Coolify's database is dumped before every configuration change (`coolify-setup.sh`); a deploy changes no configuration, and Coolify's own nightly backup (7 kept) covers the rest.

### Rollback

`deploy/deploy.sh --rollback --ref <older commit>` moves the deploy branch back (with `--force-with-lease`), and Coolify builds and deploys that commit. Remotely: `git push --force-with-lease origin <older sha>:refs/heads/deploy/prod`. Migrations don't roll back (below, "Rollback").

### Moving Dev to Git Deploys

Dev still runs as the Coolify **service** `agent-bench` (uuid `hmzjhfic5gfbytn2wt5iao5h`) that the old `deploy.sh` created. Its data is in the volumes `hmzjhfic5gfbytn2wt5iao5h_<name>` for `phase-data`, `director-runs`, `director-cache`, `director-export`, `hub-pgdata`, `hub-pgdump` and `hub-data`. The new application gets new volumes, `<application uuid>_<name>`, so the data is copied once while both stacks are stopped. The old volumes stay as the fallback. About 15 minutes, most of it the copy.

1. **Merge** this change to `main` with a passing full CI, and create the branch without deploying anything: `git push origin <sha>:refs/heads/deploy/dev` (no application follows it yet).
2. **Drain dev until nothing is live:** `curl -X POST -H @<(printf 'Authorization: Bearer %s\n' "$(cat ~/.config/mtgdt/admin-token)") -H 'Content-Type: application/json' -d '{"drain":true,"games":false}' https://agent-bench.dev.greg.tech/api/admin/drain`, then wait until `https://agent-bench.dev.greg.tech/api/capacity` shows `live.events` 0.
3. **Back up:** the Hub database (LAUNCH-DAY "Before the Day" step 7: `pg_dump -Fc` to `~/backups/agent-bench-dev-<date>.dump`) and the secrets folder.
4. **Stop the old service** in Coolify (Stop, not Delete).
5. **Create the application without deploying:** `INSTANCE=dev deploy/coolify-setup.sh` (it reuses the `agent-bench` project and `~/.config/mtgdt`). Note the application uuid it prints.
6. **Copy the volumes** on the host, as root in a throwaway container so ownership is kept:
   ```bash
   old=hmzjhfic5gfbytn2wt5iao5h; new=<application uuid>
   for v in phase-data director-runs director-cache director-export hub-pgdata hub-pgdump hub-data; do
     docker volume create "${new}_$v" >/dev/null
     docker run --rm --network none -v "${old}_$v:/from:ro" -v "${new}_$v:/to" docker.io/library/postgres:17-alpine sh -c 'cp -a /from/. /to/ && du -s /from /to'
   done
   ```
   Both `du` sizes should match for each volume.
7. **Deploy:** `INSTANCE=dev deploy/deploy.sh --redeploy`. It waits for `/health` to report the commit.
8. **Check:**
   - The Hub's `/data/index.json` lists the same events as before.
   - `npm run hub -- open-data status` is fine.
   - `scripts/ops-check.sh --server` passes.
   - The "Networks" checks below pass.
   - The nightly dump appears the next morning.
9. **After a week:** delete the old service in Coolify **without** its volumes, and its scheduled task with it. Once a nightly volume backup has the new volumes, remove the old ones (`docker volume rm hmzjhfic5gfbytn2wt5iao5h_<name>`).

**If it goes wrong:** stop the application and start the old service again. Its volumes are untouched; anything written to the new stack in between is lost.

## Monitoring

`scripts/ops-check.sh` checks, read-only and without a token: the Director's and the Hub's `/health`, the Hub's intake queue, the age and exit code of the last open-data build, capacity and drain, and TLS expiry on both hosts. With `--server` it also checks, on the host: disk use (80%), the stack's volume sizes against their limits (phase-data 5 GB, director-runs 40 GB, hub-data 40 GB, hub-pgdata 10 GB, the rest 5 GB; `VOLUME_MAX_GB_<NAME>` overrides), that every container's log is capped, the age of the newest Hub database dump (30 h), and the server's last nightly volume backup (30 h, and that it holds `director-runs`, `hub-data` and `hub-pgdump`). It prints one line per check and exits 1 when any fails.

**Alerts (installed).** It runs on gr3g-server every 5 minutes from the grpace crontab, the same place as the server's other checks:

```
*/5 * * * * SSH_HOST=local $HOME/documents/agent-bench-ops/ops-check.sh --server --alert >/dev/null 2>&1
```

`deploy/deploy.sh` installs the script from the commit it deploys and adds that line if it's missing (never touching other cron lines); a deploy that doesn't go through it leaves the installed copy as it was. With `--alert` it e-mails the address in `~/.config/agent-bench-ops/alert-to` on the host (or `ALERT_TO`; the address is kept out of the repository) through Postal on the host (127.0.0.1:25, with Coolify's saved SMTP login; credentials are piped, never printed), the path the server's nightly PHP check uses, because Coolify's own e-mail can't reach `postal.greg.tech:25` behind Cloudflare. It alerts after two failing runs in a row (so a deploy's restart doesn't), again every 6 hours while checks keep failing or when another check fails, and once when everything passes again. The e-mail lists the failing checks, the whole output and a prompt to paste into an agent. Log: `journalctl -t agent-bench-ops`; the last run: `~/.local/state/agent-bench-ops/last-run.txt` on the host. Test the path: `~/documents/agent-bench-ops/ops-check.sh --test-email` (sent 2026-10-22, with a simulated failure and recovery). From a workstation, `scripts/ops-check.sh --server` runs the same checks over SSH.

Still worth adding: an external uptime monitor on `https://agent-bench.dev.greg.tech/health`, `https://agent-bench-hub.dev.greg.tech/health` and the site's `/agent-bench`, so a dead host is noticed even when its own cron can't run (Owner: pick a service).

Other read-only views: `GET /api/capacity` (load, queue, drain), `GET /api/lobby` (queues and recent tables), `admin_curl https://agent-bench.dev.greg.tech/api/admin/status` (live events and games), `npm run hub -- submissions --status held` (the review queue), `npm run hub -- open-data status`.

## Failures

Each entry: the symptom, how to confirm it, the fix, and who to tell.

### The Director is down or not answering
- **Symptom:** `/health` fails; `bench play` and lobby clients retry (for up to 10 minutes, `MTGDT_DIRECTOR_WAIT_MIN`, then they stop and say how to start the seat again); the site's live pages and lobby show errors.
- **Confirm:** `ssh gr3g-server docker ps -a | grep director-`, then `docker logs --tail 100 <director>`.
- **Fix:** restart the container (`docker restart <director>`); events resume from their checkpoints (drafts at the current pick, games re-attached within phase-server's 120 s grace with retries for about 105 s, otherwise voided and replayed; a game voided four times ends its match with no result, METHODOLOGY §3.2). If it crash-loops after a deploy, roll back (below). An event that logs `resume_failed` couldn't regenerate its packs: its booster data is missing from the archive (`director-cache/booster-archive`, UPGRADING.md).
- **Tell:** contributors with live tables, if games were voided.

### phase-server is wedged or crashed
- **Symptom:** games stop advancing; the Director logs reconnect attempts and `game_failed`.
- **Confirm:** `docker logs --tail 100 <phase>`; `docker stats --no-stream <phase>` (memory).
- **Fix:** `docker restart <phase>`. Games re-attach within 120 s; after that they are voided and replayed (never scored). Never start a second phase-server on the same `phase-data` volume.

### Card data: phase-server won't start, or a card override didn't apply
- **How it works:** `card-data` stages the pinned upstream card data and booster data in `phase-data` and applies the card overrides (docs/CARD-OVERRIDES.md, "Running It in Production"); phase-server starts only once it is healthy, with `--no-data-download`.
- **Symptom:** phase-server stays "created" or restarts (its log: it can't load `card-data.json`), the Director waits ("waiting for phase-server card data…"), or an event records `card_data` without an override you expected.
- **Confirm:** `docker logs --tail 50 <card-data>`: one line `card-data: upstream a81ec87f3b46 -> card-data.json <sha>; overrides: heated-argument` per start, `SKIPPED override …` for a stale one, `FAILED: …` when it couldn't stage (it then restarts and retries; phase-server keeps waiting). What phase-server runs: `docker exec <phase> sha256sum /var/lib/phase-server/card-data.json` against `docker exec <phase> cat /var/lib/phase-server/card-overrides.json` (`sha256`, `overrides`).
- **Fix:** a download failure (a fresh volume or an engine upgrade, data.phase-rs.dev unreachable): wait or restart `<card-data>`. A stale override: retire or re-pin it (CARD-OVERRIDES "Lifecycle", step 7) and deploy; meanwhile games with that card are flagged `known_issue_card`. A card-data.json phase-server can't load: never delete it to let phase-server fetch upstream silently; roll back to the previous build (below), whose stage rewrites the file it shipped with. Changing the overrides is an engine change: `deploy/deploy.sh --drain-events` (the deploy refuses while events are live otherwise).
- **Tell:** no one, unless games were voided.

### The Hub or Postgres is down
- **Symptom:** Hub `/health` fails; contributors can't create events or join the lobby (503, the token check fails closed); finished events wait in the Director's hand-off queue.
- **Confirm:** `docker logs --tail 100 <hub>`, `docker exec <hub-db> pg_isready -U hub -d hub`.
- **Fix:** restart `hub-db`, then `hub`. The Director retries hand-offs for about 40 minutes and then only at its next start: after a longer outage, restart the Director (`docker restart <director>`) so unsent events go out. Contributors whose usage upload failed run `npm run bench -- attach-logs <event>`.

### The disk is filling up
- **Symptom:** `ops-check.sh --server` reports disk use over 80%, or a volume over its limit.
- **Confirm:** `ssh gr3g-server "df -h; docker system df -v"` (volume sizes without root).
- **What already keeps it down:** every container's log is capped at 5 × 20 MB (`logging:` in `deploy/compose.yaml`); phase-server logs at `warn` (`PHASE_RUST_LOG`; at `info` it writes a line per game action, about 300 MB a day under load) and never to files (its `PHASE_LOG_DIR`, which keeps a log per game, about 1.2 GB a day under test, stays unset on the hosted stack); the Director gzips an event's `events.jsonl` once the Hub has accepted it (`COMPRESS_HANDED_OFF`; 72 MB → about 6 MB for a best-of-3 table), and every reader takes the `.gz`.
- **Fix, in this order:** remove unused Director images (`docker image prune` removes dangling ones; old `mtgdt-director:<sha>` tags can go once a newer build is healthy; Coolify's nightly cleanup also removes unused tags); if someone set `PHASE_LOG_DIR`, delete its files older than 7 days inside `phase-data`; check that accepted events' logs are gzipped (`ls director-runs/*/events.jsonl` lists only events not yet handed off). Never delete `hub-pgdata`, `hub-data` or `director-runs` wholesale.

### A deploy while events are live
- **What happens:** a deploy without a drain (plain `deploy/deploy.sh`, a push to the deploy branch, Coolify's Redeploy) has Coolify build the image, then stop and recreate every container, phase-server included. The Director checkpoints on SIGTERM; phase-server keeps its games (on disk) and each seat's place for 120 s; the new Director starts once phase-server's healthcheck passes, resumes every live event (drafts at the current pick, decks from the log) and re-attaches each game in progress (`game_reconnect`, `after: "restart"`; retried with backoff if phase-server isn't answering yet). Seats see calls fail with 502/503 for about 10 seconds and carry on; `bench play` and the scripted agent wait out up to 10 minutes. The watchdog forfeits nobody while the Director stops, and gives every seat 15 minutes after the resume.
- **Tested 2026-10-22 on the dev stack** (build `24a3470`, an 8-seat FRA Private Table of scripted seats at 2 s per decision, `2026-10-22-22-34-06-fra-905e`): a baseline deploy with nothing live took 35 s end to end (`--drain-events`, nothing to wait for). Redeployed mid-draft (pick 122 of 336): the deploy took 32 s; the public `/health` was down about 10 s (no answer, then 503, then 200); `event_resume.downtime_ms` 7.6 s; the draft carried on at the same pick, five seats saw one 502 and retried. Redeployed mid-game (4 games of round 1 in progress, each on turn 9): 32 s; `/health` down about 10 s; `downtime_ms` 7.9 s; all 4 games re-attached on the first try within 80 ms of the resume. The event then played to its end (45 minutes in all, 26 games, 12 matches): **no forfeits, no voids, no failed games, no reconnect retries**; the Hub took it in with pack regeneration verified (the resumed draft's packs match) and no holds; its 44 MB log is kept as a 5.0 MB `events.jsonl.gz`. The ops check (every 5 minutes) didn't alert: each outage was shorter than one run.
- **Tested again 2026-10-25 with the git deploy** (throwaway application `agent-bench-git-test`, build `d03decc` → `60f931b`, an 8-seat FRA table of scripted seats in round 1 with 4 games in progress): the push reached Coolify through the webhook, the deployment took 55 s (cached build) and `deploy.sh` 70 s end to end; the Director logged `resumed 1 live event(s)`, 3 games re-attached (`game_reconnect`, `after: "restart"`), and the event played to its end (12 matches, 28 games, no forfeits, voids or failed games) and was handed to the Hub with pack regeneration verified and no holds. `/health` was down 19 s once `card-data` stopped promptly (it had held each deploy for Coolify's 30 s stop grace). A first deploy of a fresh instance (`deploy.sh` with no application yet: it pushed, created the application and deployed) took 47 s, and `coolify-setup.sh --delete` left no container, volume, network or project behind.
- **For an engine upgrade** use `--drain-events` (UPGRADING.md); `deploy.sh` refuses an engine change while events are live otherwise. A bare push to the deploy branch has no such guard: check `/api/capacity` first.

### A bad deploy
- **Symptom:** a container crash-loops, `/health` reports the wrong version, or errors start right after a deploy.
- **Fix:** roll back (below). If the deploy ran a Hub migration, code from before it may not run on the migrated database: restore the dump taken before the deploy.

### Suspected fake or manipulated results

Uploaded results are trusted (owner decision, 2026-10-24) and can be invalidated later. For one event: `npm run hub -- exclude <event-id> --reason …`. For a contributor: `npm run hub -- contributor ban <handle> --reason …` suspends the account (all its tokens stop at once and sign-in is refused), excludes every event they uploaded or ran as a Private Table, unrates their seats' games at lobby tables (the other contributors' games stand), recomputes points and logs the action. It's reversible: `contributor activate`, then `include <event>` and `include-seats <event>`.

### A leaked token or secret
- **Symptom:** a token appears somewhere public, or unknown events or uploads appear.
- **Fix:** rotate it (below). A contributor token: `npm run hub -- token revoke <token-id>` (or the contributor rotates it at `/account`); takes effect within the 60 s introspection cache. Suspend an abusive account: `npm run hub -- contributor suspend <handle>`. Then review what the token did (`npm run hub -- submissions`, the Director's event list) and take down anything forged (`npm run hub -- takedown <event-id> --reason …`).

### TLS fails on a host
- **Symptom:** certificate errors; `ops-check.sh` reports a missing or expiring certificate.
- **Fix:** restart the affected container so Traefik retries ACME (this fixed a transient Let's Encrypt failure on the Hub). Restarting `coolify-proxy` interrupts every site on the host: only with the owner's OK.

### Spam, abuse or a takedown request
- **Event:** `npm run hub -- takedown <event-id> --reason … [--purge]` removes it from the Hub's index and `/data` at once and starts an early open-data rebuild (about 15 minutes) that deletes every snapshot containing it. Hosted Directors read the takedown from the Hub within a minute and delete their own run folder and exported files (their `/data`, `/api/events` and replays stop serving it); to make it immediate: `curl -X POST -H "Authorization: Bearer $ADMIN" <director>/api/admin/moderation/sync`. Copies already downloaded can't be recalled. Database dumps age out after 7 days, the server's volume backups on their own schedule.
- **A note, a deck name or a handle** (docs/legal/CONTENT-POLICY.md): `npm run hub -- moderation queue` lists what the filter flagged; `moderation keep|hide <flag-id> --reason …` decides one. Anything else: `moderation notes <event-id> [--seat s] [--grep text]` shows the note keys, then `moderation hide-note <event-id> <seat> <key> --reason …`, `moderation hide-deck-name <event-id> <seat> --reason …` or `moderation hide-handle <handle> --reason …`. Every public output is rebuilt (Hub at once, Directors within a minute, open data in about 15 minutes); `moderation hides`, `unhide <id>` and `moderation log` review and undo. The same actions are on the admin API (`/api/admin/moderation/*`; pass `"actor"` to name who acted).
- **Erasure request:** confirm the request comes from the account's owner (for example a reply from the GitHub account's public e-mail, or a gist the account posts), then `npm run hub -- contributor erase <handle> --reason … [--remove-events]`. What it removes and what remains: docs/legal/PRIVACY.md "Erasure". Reply with that list.
- **Account:** `npm run hub -- contributor suspend <handle>` hides the handle everywhere and stops its tokens. A contributor can also hide their own handle (`/account`).
- **Exclude without removing:** `npm run hub -- exclude <event-id> --reason …` takes an event out of the ratings and keeps it visible.

## Monthly harness check

Harness CLIs update often, and a new version can change the log format the bench reads (LAUNCH-CHECKLIST E-8). Once a month, and after any harness update you notice, on a machine with the harnesses signed in:

```bash
npm run bench -- check
npm run bench -- setup --private --hosted --set sos --once --dry-run \
  --seat "Claude Code / Claude Haiku 5.5 / low" --seat "Cursor CLI / GPT-5.6 Luna / medium" --seat "OpenCode / opencode/deepseek-v4.1-flash-free / high" \
  --seat "script/random" --seat "script/random" --seat "script/random" --seat "script/random" --seat "script/random"
```

The dry run starts each harness once with a one-word task (cents, not a table) and creates nothing. Every seat should read "model verified". "answered, but the harness log isn't in a format this version reads", "no token counts" or "$0 with tokens" means the harness changed: fix `packages/director/src/usage.ts` (or the effort detection) before anyone runs a table with it.

## Coolify Variables

On the application (git deploys), Coolify creates an empty variable for each `${VAR:-default}` in `deploy/compose.yaml`'s `environment:` entries. Empty, the compose default applies, so a changed default ships with its commit. A value typed into Coolify overrides the default until it is cleared, and `coolify-setup.sh` prints `note: env X is … in Coolify, overriding compose.yaml's default …` for each one (names only for secrets). The full list is in "Deploying" above. (The old Coolify service stored each default as a value at its first parse and kept it, so `HUB_PLAY_DAILY` stayed 4 after the default became 6, until 2026-10-23.)

## Networks

Coolify puts every container of the application, and `coolify-proxy` (Traefik), on its project network (named after the application's uuid; `hmzjhfic5gfbytn2wt5iao5h` for dev's old service) besides the networks `deploy/compose.yaml` defines, and the service names resolve on it. The git-deployed application keeps the same layout (checked 2026-10-25 on the throwaway application: the director on default and engine, the hub on default and db, phase-server only on engine, hub-db only on db, card-data only on default, each also on the project network; `db` internal; every reachability check below as expected). So the separation is enforced by where each service listens, not only by which networks it's on (LAUNCH-CHECKLIST H-8):

| From | To | How | Allowed |
|---|---|---|---|
| Traefik | `director:8787`, `hub:8787` | project network | Yes (the public routes) |
| `director` | `phase-server:9374` | `engine`, as `phase-server-engine` | Yes; phase-server binds only its `engine` address (`--bind`) |
| `hub` | `hub-db:5432` | `db` (internal), as `hub-db-internal` | Yes; Postgres listens only on its `db` address, and pg_hba admits role `hub` on database `hub` from the `db` subnet with `scram-sha-256` |
| `docker exec` in `hub-db` | Postgres, local socket | `local all all trust` | Yes: the healthcheck, the nightly `pg_dump`, `pg_restore`, `psql -U hub` |
| anything else | `phase-server`, `hub-db` | project network, loopback | Connection refused (nothing listens there); pg_hba also rejects every other host (`0.0.0.0/0`, `::/0`) |
| `card-data`, `director`, `hub` | the internet | `default` | Yes (card data downloads, GitHub sign-in) |

- **How it starts:** each of the two looks up its alias on its private network (`phase-server-engine`, `hub-db-internal`; network-scoped, so they never resolve on the project network) and binds that address; `hub-db` also writes `/tmp/pg_hba.conf` with that network's subnet and starts Postgres with `-c hba_file=/tmp/pg_hba.conf -c listen_addresses=<address> -c password_encryption=scram-sha-256`, which applies to the existing data volume (its own `pg_hba.conf` is no longer read). If the alias doesn't resolve, the container refuses to start (it logs "does not resolve … refusing to start"): the Hub or the Director then waits on it, which the ops check reports. The subnets are not pinned: they are whatever Docker gave the networks.
- **Check after a deploy:** `docker logs <hub-db> 2>&1 | grep 'hub-db: listening'` (the address and subnet); `docker exec <hub-db> psql -U hub -d hub -Atc "select line_number, type, address, auth_method from pg_hba_file_rules"`; from the Director, `docker exec <director> node -e "require('net').connect(5432,'hub-db').on('connect',()=>console.log('REACHABLE')).on('error',(e)=>console.log(e.code))"` prints `ECONNREFUSED`, and the same from `<hub>` to `phase-server` port 9374. `scripts/image-check.sh` checks this on every `ci-local --full`, with a shared network standing in for Coolify's (`deploy/compose.ci.yaml`).
- **Passwords are SCRAM:** the `hub` role's stored password is a SCRAM verifier (checked 2026-10-23: `docker exec <hub-db> psql -U hub -d hub -Atc "select rolpassword like 'SCRAM-SHA-256\$%' from pg_authid where rolname = 'hub'"` prints `t`, without showing it). If a restored or older volume ever prints `f` (an md5 hash), the Hub can't sign in under `scram-sha-256`: set the same secret again, which stores it as SCRAM, without putting it on a command line: `printf "ALTER USER hub PASSWORD '%s';\n" "$(cat ~/.config/mtgdt/hub-db-password)" | ssh gr3g-server docker exec -i <hub-db> psql -q -U hub -d hub`.
- **What's left (accepted):** phase-server has no authentication: whoever can reach it can create and join games and use CPU. Only the Director is on `engine`, and the container holds no secrets (`env -i`), runs read-only without capabilities beyond its entrypoint's, under memory and process limits (`PHASE_MEM_LIMIT`, `PHASE_PIDS_LIMIT`), with its own `--max-connections` and `--max-games` defaults. On the project network, every container (and Traefik) can still reach the Director's and the Hub's HTTP ports, the same endpoints Traefik publishes, token-checked the same way; a container calling them directly could set its own `X-Forwarded-For` (rate limits key on it), but the only other containers are our own (`card-data`) and Coolify's proxy. Coolify's `.env` (every secret, `HUB_DB_PASSWORD` included) also reaches the Director's and the Hub's environment; the Director can no longer use it, because it can't reach Postgres.

## Backups and Restore

- **What is backed up:** the Hub database (`pg_dump` nightly at 02:20 server time, America/Chicago, to `/dumps/hub-<Day>.dump` in `hub-db`, a rolling 7 days; a Coolify scheduled task), and every Docker volume, `director-runs`, `hub-data`, `hub-pgdump` and `phase-data` included (checked 2026-10-22): `/opt/backup/backup.sh` at 03:00 server time tars each volume, encrypts and uploads them to Google Drive (14 dailies, Sundays for 90 days, the 1st of each month kept), after the dump and before the 03:30 open-data build. `ops-check.sh --server` alerts when that backup is over 30 hours old or misses those volumes. Secrets live in Coolify's variables, with a copy in `~/.config/mtgdt/` (`~/.config/mtgdt-prod/`) on the owner's workstation: back that folder up separately, encrypted. `deploy/coolify-setup.sh` generates secrets only when it creates the instance; when one is missing and the instance exists it refuses, and `deploy/coolify-setup.sh --recover-secrets` copies the missing files back from the running containers (never printed). A new `contributor-salt` or `hub-db-password` would break the deployment.
- **Before a deploy that runs a migration:** `docker exec <hub-db> pg_dump -U hub -Fc -f /dumps/pre-<sha>.dump hub`.
- **Restore the Hub database:** stop `hub`; `docker exec <hub-db> pg_restore -U hub -d hub --clean --if-exists /dumps/<file>.dump`; start `hub`; `npm run hub -- reingest` if the bundles in `hub-data` are newer than the dump; check `/health` and the export.
- **Drill:** `scripts/restore-drill.sh` copies the newest nightly dump, restores it into a throwaway Postgres container on this machine (never the live database), migrates it forward with this checkout's Hub code, compares the row counts of events, seats, games, picks and contributors from before the dump with production, prints the timings, and removes the container and the dump copy. Run it before launch, monthly, and after any change to the backup path.
  - **2026-10-22:** `hub-Thu.dump` (159 KB, taken 07:20 UTC): copied in 0.4–1.2 s, Postgres up in 3.6 s, `pg_restore` 0.3–0.4 s, migrated forward from 003 to the current schema in 0.5–0.7 s; events 9, seats 72, games 26, picks 3,024, contributors 2, the same as production's rows from before the dump. **About 6 seconds end to end.** A full recovery adds `npm run hub -- reingest` for events the Hub took in after the dump (its bundles are in `hub-data`, from the volume backup).

## Rotating Secrets

| Secret | Where | How to rotate | What breaks |
|---|---|---|---|
| `admin-token` (Director admin API) | Coolify; copy in `~/.config/mtgdt/` | Write a new value to the file, `deploy/coolify-setup.sh`, then Redeploy | Admin scripts until they read the new file |
| `hub-admin-token` | Same | Same | `bench play` for admin tables needs the new one |
| `hub-service-token` (Director → Hub hand-off) | Same | Same; both sides change in one deploy | Hand-offs in flight retry at the next start |
| `hub-session-secret` | Same | Same | Everyone signed in to the Hub signs in again; contributor tokens keep working |
| GitHub OAuth client secret | Coolify (or `github-oauth-client-secret`) | New secret in the GitHub OAuth app, then Coolify, then Redeploy | Sign-in until the Hub restarts |
| Contributor tokens | Hub database | The contributor at `/account`, or `npm run hub -- token revoke <id>` | That token, within 60 s |
| `hub-db-password` | Coolify; copy in `~/.config/mtgdt/` | `ALTER USER hub PASSWORD …` in `hub-db` first, then the file, `coolify-setup.sh`, Redeploy | The Hub, if the variable changes without the `ALTER USER` |
| `contributor-salt` | Same | **Never rotate** | Every contributor's key in the public exports |

## Rollback

- **Director and Hub:** `deploy/deploy.sh --rollback --ref <previous good commit> --drain` (it passed CI when it was deployed, so its stamp is there), or remotely `git push --force-with-lease origin <sha>:refs/heads/deploy/<instance>`. Coolify rebuilds that commit; don't retag old images on the host.
- **Database:** migrations only go forward (005 renames columns, 007 rewrites comparability groups), so going back past one means restoring the `pre-<sha>` dump.
- **Open data:** the Hub keeps the current build and the one before it under `open-data/builds/`; until a rollback command exists, point the `site/open` symlink in `hub-data` back at the previous build by hand.
- **The site:** Vercel's Instant Rollback. Turning `VITE_AGENT_BENCH_ENABLED` off needs a rebuild (it's fixed at build time).
- **Engine:** see [UPGRADING.md](UPGRADING.md); a rolled-back Hub accepts the newer engine build only if it's listed in `HUB_ALLOWED_ENGINE_DIGESTS`.
- **Card overrides:** a rollback restages the card data the old build ships (the `card-data` service applies that build's `engine/overrides/`); deploy it with `--drain-events` like any card-data change.
