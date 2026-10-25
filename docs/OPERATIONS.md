# Operations Runbook

How to watch the hosted stack, and what to do when part of it fails. The stack is one Coolify service, `agent-bench`, on `gr3g-server` with five containers: `card-data` (stages the engine's card data with the card overrides, then idles), `phase-server` (the rules engine), `director` (https://agent-bench.dev.greg.tech), `hub` (https://agent-bench-hub.dev.greg.tech) and `hub-db` (Postgres 17). Architecture: [ARCHITECTURE.md](ARCHITECTURE.md). Deploys and releases: [RELEASING.md](RELEASING.md). Security reports and threat model: [SECURITY.md](SECURITY.md).

Conventions below:
- `ssh gr3g-server` reaches the host (see `~/Coding Projects/Server Config`). Coolify names containers `<service>-<uuid>`: find them with `ssh gr3g-server "docker ps --format '{{.Names}}' | grep -E '^(card-data|director|hub|hub-db|phase-server)-'"`. Below, `<card-data>`, `<hub>`, `<hub-db>`, `<director>` and `<phase>` mean those names.
- Admin calls read the token from a file, never from the command line: `curl -H @<(printf 'Authorization: Bearer %s\n' "$(cat ~/.config/mtgdt/admin-token)") …`. Below that is `admin_curl`.
- Hub admin commands run inside the container: `ssh gr3g-server docker exec <hub> npm run hub -- <command>` (the list is in [packages/hub/README.md](../packages/hub/README.md)).
- Never print a secret, and stop processes by PID, never by pattern.

## Monitoring

`scripts/ops-check.sh` checks, read-only and without a token: the Director's and the Hub's `/health`, the Hub's intake queue, the age and exit code of the last open-data build, capacity and drain, and TLS expiry on both hosts. With `--server` it also checks, on the host: disk use (80%), the stack's volume sizes against their limits (phase-data 5 GB, director-runs 40 GB, hub-data 40 GB, hub-pgdata 10 GB, the rest 5 GB; `VOLUME_MAX_GB_<NAME>` overrides), that every container's log is capped, the age of the newest Hub database dump (30 h), and the server's last nightly volume backup (30 h, and that it holds `director-runs`, `hub-data` and `hub-pgdump`). It prints one line per check and exits 1 when any fails.

**Alerts (installed).** It runs on gr3g-server every 5 minutes from the grpace crontab, the same place as the server's other checks:

```
*/5 * * * * SSH_HOST=local $HOME/documents/agent-bench-ops/ops-check.sh --server --alert >/dev/null 2>&1
```

`deploy/deploy.sh` installs the script from the commit it deploys and adds that line if it's missing (never touching other cron lines). With `--alert` it e-mails the address in `~/.config/agent-bench-ops/alert-to` on the host (or `ALERT_TO`; the address is kept out of the repository) through Postal on the host (127.0.0.1:25, with Coolify's saved SMTP login; credentials are piped, never printed), the path the server's nightly PHP check uses, because Coolify's own e-mail can't reach `postal.greg.tech:25` behind Cloudflare. It alerts after two failing runs in a row (so a deploy's restart doesn't), again every 6 hours while checks keep failing or when another check fails, and once when everything passes again. The e-mail lists the failing checks, the whole output and a prompt to paste into an agent. Log: `journalctl -t agent-bench-ops`; the last run: `~/.local/state/agent-bench-ops/last-run.txt` on the host. Test the path: `~/documents/agent-bench-ops/ops-check.sh --test-email` (sent 2026-10-22, with a simulated failure and recovery). From a workstation, `scripts/ops-check.sh --server` runs the same checks over SSH.

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
- **What happens:** plain `deploy/deploy.sh` (no drain) builds, backs up Coolify's database and has Coolify recreate every container, phase-server included. The Director checkpoints on SIGTERM; phase-server keeps its games (on disk) and each seat's place for 120 s; the new Director starts once phase-server's healthcheck passes, resumes every live event (drafts at the current pick, decks from the log) and re-attaches each game in progress (`game_reconnect`, `after: "restart"`; retried with backoff if phase-server isn't answering yet). Seats see calls fail with 502/503 for about 10 seconds and carry on; `bench play` and the scripted agent wait out up to 10 minutes. The watchdog forfeits nobody while the Director stops, and gives every seat 15 minutes after the resume.
- **Tested 2026-10-22 on the dev stack** (build `24a3470`, an 8-seat FRA Private Table of scripted seats at 2 s per decision, `2026-10-22-22-34-06-fra-905e`): a baseline deploy with nothing live took 35 s end to end (`--drain-events`, nothing to wait for). Redeployed mid-draft (pick 122 of 336): the deploy took 32 s; the public `/health` was down about 10 s (no answer, then 503, then 200); `event_resume.downtime_ms` 7.6 s; the draft carried on at the same pick, five seats saw one 502 and retried. Redeployed mid-game (4 games of round 1 in progress, each on turn 9): 32 s; `/health` down about 10 s; `downtime_ms` 7.9 s; all 4 games re-attached on the first try within 80 ms of the resume. The event then played to its end (45 minutes in all, 26 games, 12 matches): **no forfeits, no voids, no failed games, no reconnect retries**; the Hub took it in with pack regeneration verified (the resumed draft's packs match) and no holds; its 44 MB log is kept as a 5.0 MB `events.jsonl.gz`. The ops check (every 5 minutes) didn't alert: each outage was shorter than one run.
- **For an engine upgrade** use `--drain-events` (UPGRADING.md); `deploy.sh` refuses an engine change while events are live otherwise.

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

## Coolify variables

Coolify saves each `${VAR:-default}` in `deploy/compose.yaml` as the service's value the first time it parses the service, and keeps that value: changing a default in compose.yaml later doesn't change the running service. (So `HUB_PLAY_DAILY` stayed 4 after the default became 6, until 2026-10-23.) Every deploy now prints `warning: env X is … in Coolify, but compose.yaml's default is …` for each such variable (names only for secrets). When the default should apply, set it in Coolify's environment UI (or through `artisan tinker`) and redeploy; when the stored value is intended, leave it. The values `deploy.sh` passes itself (image tags, URLs, secrets) and the GitHub OAuth variables are not compared.

## Networks

Coolify puts every container of the service, and `coolify-proxy` (Traefik), on the service's project network (named after the service uuid, `hmzjhfic5gfbytn2wt5iao5h` on the dev host) besides the networks `deploy/compose.yaml` defines, and the service names resolve on it. So the separation is enforced by where each service listens, not only by which networks it's on (LAUNCH-CHECKLIST H-8):

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

- **What is backed up:** the Hub database (`pg_dump` nightly at 02:20 server time, America/Chicago, to `/dumps/hub-<Day>.dump` in `hub-db`, a rolling 7 days; a Coolify scheduled task), and every Docker volume, `director-runs`, `hub-data`, `hub-pgdump` and `phase-data` included (checked 2026-10-22): `/opt/backup/backup.sh` at 03:00 server time tars each volume, encrypts and uploads them to Google Drive (14 dailies, Sundays for 90 days, the 1st of each month kept), after the dump and before the 03:30 open-data build. `ops-check.sh --server` alerts when that backup is over 30 hours old or misses those volumes. Secrets live in `~/.config/mtgdt/` on the owner's workstation and in Coolify's environment: back that folder up separately, encrypted. `deploy.sh` generates secrets only when it creates the service; when one is missing and the service exists it refuses, and `deploy/deploy.sh --recover-secrets` copies the missing files back from the running containers (never printed). A new `contributor-salt` or `hub-db-password` would break the deployment.
- **Before a deploy that runs a migration:** `docker exec <hub-db> pg_dump -U hub -Fc -f /dumps/pre-<sha>.dump hub`.
- **Restore the Hub database:** stop `hub`; `docker exec <hub-db> pg_restore -U hub -d hub --clean --if-exists /dumps/<file>.dump`; start `hub`; `npm run hub -- reingest` if the bundles in `hub-data` are newer than the dump; check `/health` and the export.
- **Drill:** `scripts/restore-drill.sh` copies the newest nightly dump, restores it into a throwaway Postgres container on this machine (never the live database), migrates it forward with this checkout's Hub code, compares the row counts of events, seats, games, picks and contributors from before the dump with production, prints the timings, and removes the container and the dump copy. Run it before launch, monthly, and after any change to the backup path.
  - **2026-10-22:** `hub-Thu.dump` (159 KB, taken 07:20 UTC): copied in 0.4–1.2 s, Postgres up in 3.6 s, `pg_restore` 0.3–0.4 s, migrated forward from 003 to the current schema in 0.5–0.7 s; events 9, seats 72, games 26, picks 3,024, contributors 2, the same as production's rows from before the dump. **About 6 seconds end to end.** A full recovery adds `npm run hub -- reingest` for events the Hub took in after the dump (its bundles are in `hub-data`, from the volume backup).

## Rotating Secrets

| Secret | Where | How to rotate | What breaks |
|---|---|---|---|
| `admin-token` (Director admin API) | `~/.config/mtgdt/` | Write a new value, `deploy/deploy.sh` | Admin scripts until they read the new file |
| `hub-admin-token` | `~/.config/mtgdt/` | Same | `bench play` for admin tables needs the new one |
| `hub-service-token` (Director → Hub hand-off) | `~/.config/mtgdt/` | Same; both sides change in one deploy | Hand-offs in flight retry at the next start |
| `hub-session-secret` | `~/.config/mtgdt/` | Same | Everyone signed in to the Hub signs in again; contributor tokens keep working |
| GitHub OAuth client secret | Coolify environment | New secret in the GitHub OAuth app, then Coolify, then restart `hub` | Sign-in until the Hub restarts |
| Contributor tokens | Hub database | The contributor at `/account`, or `npm run hub -- token revoke <id>` | That token, within 60 s |
| `hub-db-password` | `~/.config/mtgdt/` | `ALTER USER hub PASSWORD …` in `hub-db` first, then the file, then deploy | The Hub, if the file changes without the `ALTER USER` |
| `contributor-salt` | `~/.config/mtgdt/` | **Never rotate** | Every contributor's key in the public exports |

## Rollback

- **Director and Hub:** check out the previous good commit in a clean worktree, run `scripts/ci-local.sh --full` there (the stamp is per checkout), and `deploy/deploy.sh --drain` from it. Don't retag old images on the host: Coolify's nightly cleanup deletes unused tags.
- **Database:** migrations only go forward (005 renames columns, 007 rewrites comparability groups), so going back past one means restoring the `pre-<sha>` dump.
- **Open data:** the Hub keeps the current build and the one before it under `open-data/builds/`; until a rollback command exists, point the `site/open` symlink in `hub-data` back at the previous build by hand.
- **The site:** Vercel's Instant Rollback. Turning `VITE_AGENT_BENCH_ENABLED` off needs a rebuild (it's fixed at build time).
- **Engine:** see [UPGRADING.md](UPGRADING.md); a rolled-back Hub accepts the newer engine build only if it's listed in `HUB_ALLOWED_ENGINE_DIGESTS`.
- **Card overrides:** a rollback restages the card data the old build ships (the `card-data` service applies that build's `engine/overrides/`); deploy it with `--drain-events` like any card-data change.
