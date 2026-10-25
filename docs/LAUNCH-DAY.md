# Launch Day

The go-live runbook, in order. Each step says who does it (**Owner** or **Us**), the command or setting, and the check
that proves it worked. The checklist behind it is [LAUNCH-CHECKLIST.md](LAUNCH-CHECKLIST.md); GitHub settings are in
[RELEASING.md](RELEASING.md) "Going public" and "Launch-day extras". Audited 2026-10-24 against `feeff3a` (dev); seed tables and contact updated later that day; git deploys 2026-10-25.

Production is a **new stack** (`INSTANCE=prod`): its own Coolify application (`agent-bench-prod`, deployed from the
`deploy/prod` branch of the repository; OPERATIONS "Deploying"), database, volumes and secrets (`~/.config/mtgdt-prod`).
Nothing from dev is copied (LAUNCH-CHECKLIST B-11). Dev stays up for testing.

## Before the Day

1. **Hosts (decided 2026-10-24):** `bench.mtgdecktools.com` (the Director: seats, lobby, live play) and
   `bench-data.mtgdecktools.com` (the Hub: results, data, sign-in), on gr3g-server. DNS: both CNAME `dns.greg.tech`
   in Cloudflare (SSL mode Full (strict)); the Hub proxied once its first deploy has a certificate (C-1, then
   `HUB_TRUST_PROXY_HOPS=2`), the Director DNS only (MCP seats hold long
   requests that Cloudflare's 100-second proxy timeout would cut). **Owner: the date.**
2. ~~Contact and legal~~ Done 2026-10-24: magic@greg.tech (the Hub and the site default to it), legal texts version
   2026-10-24, no lawyer's review (owner's call).
3. **Owner: a GitHub OAuth App for production** (github.com/settings/applications/new): name "MTG Deck Tools Agent Bench",
   homepage `https://mtgdecktools.com/agent-bench`, callback `https://bench-data.mtgdecktools.com/auth/github/callback`,
   **Enable Device Flow** checked (`bench login` signs in with a device code). Save its
   id and secret as `~/.config/mtgdt-prod/github-oauth-client-id` and `github-oauth-client-secret` (mode 600).
4. **Owner: an uptime monitor** (any external service) on both `/health` URLs, alerting by e-mail (H-1).
5. **Us: a dry run on dev** with scripted seats (`bench setup` → Private Table, 8 `random` seats, FRA): the pipeline
   end to end without spending tokens. The real tables are the seed tables on production (The Day, step 6).
5b. ~~History~~ Done 2026-10-25: the public repository starts from one commit (RELEASING "Before going public: the
   history"); the old history is a private archive.
5c. **Git deploys** (OPERATIONS "Deploying"): the `coolify-git` branch merged into `main`. Production starts on them:
   Coolify builds the stack from the `deploy/prod` branch. Nothing for the owner to click: the `grpace-github` GitHub
   App is installed on all of the owner's repositories and already sees this one, and its webhook already deploys
   other apps on push (checked 2026-10-25). Dev moves over separately (OPERATIONS "Moving Dev to Git Deploys").
6. **Us: freeze and check.** `main` has a passing `scripts/ci-local.sh --full` stamp; `npm run deps -- check` and
   `npm run overrides -- upstream` show nothing urgent (phase-rs ships often); the outside critics' findings are
   resolved or accepted (audits folder, round 3).
7. **Us: archive dev privately** (for our own analysis; never published):
   ```bash
   ssh gr3g-server 'c=$(docker ps --filter label=coolify.projectName=agent-bench --filter label=com.docker.compose.service=hub-db --format "{{.Names}}"); docker exec "$c" pg_dump -U hub -Fc hub' > ~/backups/agent-bench-dev-$(date +%F).dump
   ```
   plus the Hub's bundle volume and the latest open-data snapshot (`/data/open/latest.json` → snapshot file).

## The Day, in Order

1. ~~Production URLs in code and docs~~ Done 2026-10-25: in the repository's first commit (the CLI's
   `HOSTED_DIRECTOR_URL` and `DEFAULT_HUB_URL` and the contributor docs name bench.mtgdecktools.com and
   bench-data.mtgdecktools.com; the README says live). The workflows stay off until step 7. In the site repo,
   `node scripts/sync-agent-bench-data.mjs --methodology-only` brings the prompts, legal pages and methodology across.
2. **Us: deploy production.** From the `main` checkout, at the commit with the passing full CI stamp:
   ```bash
   INSTANCE=prod deploy/deploy.sh
   ```
   It pushes the commit to `deploy/prod` (only commits on `origin/main`). As this is production's first deploy, it then
   creates the Coolify application `agent-bench-prod`, with a verified Coolify database dump first; the GitHub OAuth
   files already in `~/.config/mtgdt-prod` are passed. It generates the other secrets in `~/.config/mtgdt-prod`,
   deploys, and waits for both hosts. **Owner: back that folder up (encrypted) right away** (H-2): Coolify holds the
   live copy, but a lost `contributor-salt` re-keys every contributor, and a lost `hub-db-password` locks the Hub out
   of its database. Check: the script ends with `LIVE:` and `HUB:` lines naming the commit, and no
   `note: env …` lines.
3. **Us: the Hub's launch settings** in Coolify (project and application `agent-bench-prod` → Environment Variables),
   then Coolify's **Redeploy** (or `INSTANCE=prod deploy/deploy.sh --redeploy`):
   - `MTGDT_TERMS_URL`, `MTGDT_PRIVACY_URL`, `MTGDT_CONTENT_POLICY_URL` (the site's
     legal pages), `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` if not passed from the files.
   - With Cloudflare proxied in front of the Hub (C-1): `HUB_TRUST_PROXY_HOPS=2`.
4. **Us: the nightly database dump** for the production `hub-db`: created with the application (Coolify scheduled task
   "hub-db nightly pg_dump"; OPERATIONS "Backups and Restore"). Check: the next morning's `/dumps/hub-<Day>.dump`
   exists; the ops check reports the backup age.
5. **Us: verify production** (read-only):
   - `curl https://bench.mtgdecktools.com/health` and `https://bench-data.mtgdecktools.com/health`: `ok`, the commit.
   - `https://bench-data.mtgdecktools.com/data/index.json`: no events yet (the seed tables come next).
   - `https://bench-data.mtgdecktools.com/legal/terms`: names magic@greg.tech, no "can't be made yet" sentences.
   - `scripts/ops-check.sh` with `DIRECTOR_URL`/`HUB_URL` set to production: all `ok`.
   - **Owner:** `npm run bench -- login` against production (its token is separate from dev's), then
     `npm run bench -- setup --dry-run …` for one table: accepted, nothing created.
6. **Owner + us: the seed tables, on production, before anyone can see it.** The site is still off, so nothing is
   public yet. One or two FRA Private Tables (Set Context, manual mana), each with **8 different setups** (the FRA
   roster in our launch-season notes, kept privately: Claude, Gemini, Grok, GPT, DeepSeek), started with `bench setup` against
   production. Watch the first one live; start the second when it looks right. Check: each event ends `complete`, the
   Hub's `/data/index.json` lists it, the board has a row per setup (hollow: one contributor, so provisional), and
   the game pages step through with the board. If something is wrong, fix it and void the event
   (`npm run hub -- exclude <event> --reason …`) before going on.
7. **Owner: make the repository public** and turn on the GitHub features (RELEASING "Going public" and "Launch-day
   extras"): re-enable the workflows (**Us:** the `launch/workflows` branch, one commit), approval for outside contributors, protect `main` and `v*` tags, private
   vulnerability reporting, Dependabot alerts, secret scanning with push protection. Before flipping it, **Us:**
   re-read `docs/SECURITY-FINDINGS.md` and the CHANGELOG for anything that shouldn't be public.
8. **Owner: claim the npm name** `mtgdt-bench` (2FA account; RELEASING "The CLI package"). **Us:** then add the
   `npx` command to the docs and the site (`VITE_AGENT_BENCH_NPM_COMMAND`); until then, git-checkout instructions only
   (Decision 3).
9. **Owner: the site.** In the production build settings for mtgdecktools.com set:
   `VITE_AGENT_BENCH_ENABLED=true`, `VITE_AGENT_BENCH_DATA_URL=https://bench-data.mtgdecktools.com/data`,
   `VITE_AGENT_BENCH_CONTRIBUTORS_URL=https://bench-data.mtgdecktools.com/data`, `VITE_AGENT_BENCH_HUB_URL=https://bench-data.mtgdecktools.com`,
   `VITE_AGENT_BENCH_OPEN_DATA_URL=https://bench-data.mtgdecktools.com/data/open`, `VITE_AGENT_BENCH_DIRECTOR_URL=https://bench.mtgdecktools.com`,
   `VITE_AGENT_BENCH_LIVE_URL=https://bench.mtgdecktools.com`, `VITE_AGENT_BENCH_LOBBY_URL=https://bench.mtgdecktools.com/api/lobby`,
   `VITE_AGENT_BENCH_REPO_URL=https://github.com/grpace/mtgdecktools-agent-bench` (the contact defaults to magic@greg.tech).
   Then merge `feature/agent-bench` into `master` (it auto-deploys). Check: `/agent-bench` loads with no amber sample
   labels; the leaderboard shows the seed tables' setups; `/sitemap.xml` lists the Agent Bench pages; a shared link shows
   the Agent Bench card.
10. **Owner: announce.** Point people at Run Your Agent and the lobby.

## The First 48 Hours

- Watch the ops-check e-mails, the uptime monitor, `/health` → `intake_waiting`, and the Hub's moderation queue
  (`npm run hub -- moderation queue`).
- Suspicious results: `npm run hub -- exclude <event> --reason …`, or `contributor ban <handle> --reason …`
  (OPERATIONS "Suspected fake or manipulated results").
- Quota pressure or abuse: `npm run hub -- contributor quota …`; capacity is on `/api/capacity`.
- New phase-rs releases: check before each deploy (`npm run deps -- check`); never deploy an engine change while
  events are live (`deploy.sh` refuses without `--drain-events`; a bare push to `deploy/prod` doesn't check).
- Deploying from anywhere: push a commit that passed CI to `deploy/prod`, or Coolify's Redeploy (OPERATIONS
  "Deploying").

## Rollback

- **Site:** set `VITE_AGENT_BENCH_ENABLED=false` and redeploy (the section disappears; nothing else changes), or
  revert the merge.
- **Services:** `INSTANCE=prod deploy/deploy.sh --rollback --ref <previous release commit>`, or from anywhere
  `git push --force-with-lease origin <sha>:refs/heads/deploy/prod`; Coolify rebuilds and deploys that commit.
  Migrations don't roll back, so a release with a migration must keep working with the old code (RELEASING).
- **Data:** restore the newest nightly dump (OPERATIONS "Restore the Hub database"), then
  `npm run hub -- reingest`.
