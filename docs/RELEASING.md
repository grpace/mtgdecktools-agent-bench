# Releasing

This is how a version of the benchmark is cut, tagged, built and deployed, and how the phase-rs engine is upgraded between releases. It is for whoever cuts a release and operates the hosted stack.

## Versioning

The repository has one version, shared by the root `package.json` and every package under `packages/`. CI fails if they differ. It follows [Semantic Versioning](https://semver.org/). We're below 1.0, so a breaking change bumps the **minor** version and everything else bumps the **patch** version.

**Breaking (minor before 1.0, major after):**
- Anything that makes a self-hosted Director or a submitted bundle stop working with the Hub:
  - the bundle format (`bundle_version`)
  - the submission API
  - required configuration
- Removing or renaming a `bench` CLI command or flag.
- Removing or renaming a documented environment variable.
- An incompatible change to the export schema (`docs/SITE-DATA.md`). mtgdecktools.com reads it.

**Not breaking, but always called out in the changelog:**
- A new protocol version (`docs/PROTOCOL.md`).
- A change to the current prompts (`prompts/`; the set it replaces is archived in `prompts/archive/vN/`).
- A `BOOSTER_GENERATOR` bump.
- A new pinned engine build.

These don't break the code, but they change what results are comparable to. Results record each of these versions; the release version is not a comparability key.

## Release checklist

1. **Main is green.** While the repository is private, CI is local: `scripts/ci-local.sh --full` passed on the commit you release (it writes `.ci-local/<sha>.json`; `deploy/deploy.sh` refuses a commit without one). Once public, the latest GitHub CI run on `main` passed, including the integration job: `gh run list --workflow ci.yml --branch main --limit 1`.
2. **Nothing half-done.**
   - docs/LAUNCH-CHECKLIST.md lists no open blocker for this release.
   - Every change since the last tag is committed.
   - A build from a modified tree is tagged `-dirty`, and the Hub holds every event from a `-dirty` Director, so a release build must come from a clean checkout of the tag.
3. **Security.**
   - `npm audit` is clean. CI checks production dependencies at `high` and above.
   - No finding in `docs/SECURITY-FINDINGS.md` is open at High or Critical without a written decision.
4. **Version bump.** All workspaces at once, without a git tag yet:
   ```bash
   npm version 0.2.0 --workspaces --include-workspace-root --no-git-tag-version
   (cd scripts/bench && npm version 0.2.0 --no-git-tag-version)   # the mtgdt-bench CLI package
   ```
5. **Changelog.**
   - Rename `## [Unreleased]` in `CHANGELOG.md` to `## [0.2.0] - YYYY-MM-DD`.
   - Add a fresh empty `## [Unreleased]` above it.
   - Update the compare links at the bottom.
   - Put protocol, prompt, bundle, schema, booster-generator and engine changes under their own bullets, so readers know which results stay comparable.
6. **Commit and tag.** The tag is annotated, signed if you have a signing key, and named `v<version>`:
   ```bash
   git add package.json package-lock.json packages/*/package.json scripts/bench/package.json CHANGELOG.md
   git commit -m "chore(release): v0.2.0"
   git tag -a v0.2.0 -m "v0.2.0"          # or: git tag -s
   git push origin main v0.2.0
   ```
   **Tags are immutable.** Never move or re-push a tag. If a release is broken, fix it in a new patch release.
7. **GitHub release.** Create it from the tag with the changelog section as the notes:
   ```bash
   gh release create v0.2.0 --title v0.2.0 --notes-file <(awk '/^## \[0.2.0\]/{f=1;next} /^## \[/{f=0} f' CHANGELOG.md)
   ```
8. **Images.** Build from a clean checkout of the tag (see "Images" below).
9. **Deploy with drain.** See "Deploying" below.
10. **After deploy.**
    - `curl -sf https://agent-bench.dev.greg.tech/health` reports the release commit as `version`.
    - Run one scripted event against production: `scripts/new-event.sh fra a,b,c,d,e,f,g,h` (every event seats 8 agents), then `node scripts/mcp-random-agent.mjs <seat-url>` for each of the 8 seats.
    - Check that the Hub received the event (`/api/events`), and that the live stream redacts what docs/SPECTATING.md says it should.

## Images

Images are tagged immutably. We never re-push or overwrite an image tag (`CLAUDE.md`).

- **Director and Hub image** (`mtgdt-director`, one image, three services): Coolify builds it on the host from the commit it deploys (a clone from GitHub; the `.dockerignore` allow-list decides what goes in), so only pushed commits ship and the working tree never does.
  - It is tagged `mtgdt-director:<commit>` (Coolify's `SOURCE_COMMIT`), and the compose file runs exactly that tag. `/health` and every event's `provenance.director` report the commit's short sha.
  - For a release, deploy the tag's commit, so every event records the release commit.
- **Self-hosters** build the same image locally (`npm run up`). The image is tagged `mtgdt-director:local`, and their events record the git sha of their checkout.
- **If we ever publish images** (e.g. `ghcr.io/…/mtgdt-director`):
  - Publish from CI, on tag pushes only.
  - Tag them `v<version>` and `sha-<commit>`.
  - Deploy by digest, never by tag. A registry tag can be overwritten; a digest can't.
- **Engine image:** always referenced by digest (`engine/phase.lock.json`, and the compose defaults). CI checks that the compose defaults match the lock file.

## Deploying

The hosted stack (phase-server, Director, Hub and the Hub's Postgres) runs on Coolify, which builds and deploys it from the instance's deploy branch (`deploy/dev`, `deploy/prod`; OPERATIONS.md "Deploying"). `deploy/deploy.sh` promotes a commit to that branch: it refuses a commit without a passing `scripts/ci-local.sh --full` stamp while the repository is private, and production only takes commits on `main`. Monitoring, failures, backups, secrets and rollback: [OPERATIONS.md](OPERATIONS.md).

Live events survive a redeploy: on SIGTERM the Director checkpoints them and resumes them at start (drafts at the current pick, games re-attached on phase-server; docs/ARCHITECTURE.md §5). A game whose seats can't be re-attached within phase-server's 120-second grace is voided and replayed, never scored. Draining keeps that to a minimum:

1. **Drain.** `deploy/deploy.sh --drain [minutes]` stops admitting events, forming lobby tables and starting games, waits (30 minutes by default) until no game is in progress, then deploys; queued events start afterwards. If the wait times out it deploys anyway and the games resume. Plain `deploy/deploy.sh` skips the wait and relies on resume (tested mid-draft and mid-game on the dev stack: OPERATIONS.md, "A deploy while events are live"). For an engine upgrade, `deploy/deploy.sh --drain-events [minutes]` waits until nothing is live at all (UPGRADING.md, "Deploying an Engine Upgrade"); `deploy.sh` refuses an engine change while events are live without it.
2. **Tell anyone seating agents** if you expect a long drain.
3. **Commit and push,** then run `deploy/deploy.sh --drain` (`INSTANCE=prod` for production).
   - It pushes the commit to the deploy branch. Coolify, through the GitHub App's webhook, builds the image from that commit and restarts the stack; secrets stay in Coolify's variables (`deploy/coolify-setup.sh` sets them).
   - Then it follows Coolify's deployment and waits until `/health` on the Director and the Hub reports the new sha. A failed build leaves the running stack as it was.
4. **Check the Hub hand-off.** Unsent events are resent at Director start. Look for `hub_handoff` records in the Director log.
5. **After a Hub migration** that says so (for example `007_best_of_three.sql`), run `npm run hub -- reingest` in the Hub container.

**Export schema changes reach the site in this order** (LAUNCH-CHECKLIST G-8). mtgdecktools.com renders only the `schema_version`s it lists (`SUPPORTED_SCHEMA_VERSIONS` in `src/agent-bench/types.ts`) and ignores keys it doesn't know:
- **Additive (`schema_minor`):** the Hub can deploy first; the site picks up the new keys when its own change ships. A key that changes meaning (marked **(meaning)** in docs/SITE-DATA.md) is safe only once the site reads both forms, as `feature/agent-bench` does for 2.19 and 2.20 identity keys.
- **Breaking (`schema_version`):** ship the site first, accepting the new version next to the old one; deploy the Hub after that; drop the old version from the site one release later.
- After a Hub deploy that changes the export, run `npm run hub -- reingest` so every stored event is served in the new form.

**Hub database migrations** (`packages/hub/migrations/NNN_*.sql`) run automatically at Hub start under an advisory lock.
- Make them additive: new columns nullable or defaulted.
- A destructive migration needs a manual `pg_dump` first. The nightly dump in `hub-pgdump` may be up to a day old.

**Rollback:** `deploy/deploy.sh --rollback --ref <previous release commit>` moves the deploy branch back and Coolify rebuilds that commit. Migrations don't roll back, so a release with a migration must keep working with the previous code until it's verified. Rolling back across an engine upgrade has its own steps (UPGRADING.md, "Rollback").

## Upgrading the engine (phase-rs)

phase-rs ships almost daily. We run the unmodified upstream image, pinned by digest. A new engine build is not a release by itself, but it changes `provenance.engine` for every new event. The full procedure is in [UPGRADING.md](UPGRADING.md) ("phase-rs Upgrades" and "Deploying an Engine Upgrade"); in short:

1. **Upgrade in its own pull request.** `npm run deps -- update phase --dry-run`, then without `--dry-run` (or merge the pull request the weekly Dependencies workflow opens). It wraps `scripts/upgrade-phase.sh`: pull, protocol and data report, smoke event against the candidate, and only then the new pin in `engine/phase.lock.json`, the compose defaults and `deps/manifest.json`. CI runs the smoke event again on the branch.
2. **Old events stay verifiable without manual steps.** The Director archives the booster data it runs on at every start (`director-cache/booster-archive/<sha256>.json`), and the Hub reads that archive (`HUB_BOOSTER_ARCHIVE_DIRS`) besides its own. The Hub accepts every earlier pin recorded in `deps/manifest.json` → `phase_rs.history` (plus `HUB_ALLOWED_ENGINE_DIGESTS`).
3. **Deploy with `deploy/deploy.sh --drain-events`, until nothing is live** (UPGRADING.md, step 1). `deploy.sh` refuses an engine change while events are live unless it waits them out this way or `--force` says so. phase-server restarts on the new digest: a running game can't continue across builds, and an event that resumes on the new build keeps the old build in its `event_start.provenance.engine` (its `event_resume.provenance` records the new one) while its packs still come from its own archived booster data. The Director rebuilds its unsupported-card list for the new card data by itself.
4. **Changelog:** add a line under **Unreleased** with the server version, protocol version and digest.

## The CLI package (`scripts/bench`, git-checkout distribution; not on npm)

**The CLI is distributed via git checkout (`~/mtgdt-bench`), not npm, so no instruction may run the CLI through npm's package runner.** Because the npm name `mtgdt-bench` is not used, anyone could publish a package under that name on npm; `prompts/setup.md` explicitly instructs coding agents never to install or run an npm package. No Director response, doc, prompt or CLI output points at npm. Every instruction uses the git checkout form (`npm --prefix ~/mtgdt-bench run -s bench -- …`), from one constant: `BENCH_COMMAND` in `packages/director/src/bench-command.ts` (the lobby's `join_command`, and the CLI's hints when it can't tell how it was started).

Contributors run the `bench` CLI from a checkout: `npm run bench --` (tsx). The package that will be published is built from `scripts/bench/`:

- `scripts/bench/package.json`: name `mtgdt-bench`, `bin: mtgdt-bench → dist/cli.js`, `files: dist/, README.md`, Node 22 or later, no runtime dependencies. It carries `"private": true` until launch, so nothing can be published by accident.
- `node scripts/bench/build.mjs` (also the `prepack` script) bundles the CLI and the scripted random player with esbuild into `scripts/bench/dist/` as plain ES modules, and copies what they read: `prompts/join.md`, `prompts/setup.md`, `engine/phase.lock.json`, `LICENSE`, `NOTICE`. The bundle inlines the shared code from `packages/director/src` (bundle building, validation, usage).
- The built CLI keeps its state outside any checkout: the token in `~/.config/mtgdt-bench/`, event folders in `~/.local/share/mtgdt-bench/runs/` (`BENCH_RUNS_DIR` overrides). `bench up` (your own table) still needs a checkout, and says so.
- Check a build: `cd scripts/bench && npm pack --dry-run` (the file list) and `node scripts/bench/dist/cli.js check`. CI builds it and runs it on plain Node. `scripts/bench/test/setup-e2e.sh` runs the whole contributor flow on the built package.

**When the npm name is claimed (the owner's call; at launch, then every release after):**
1. Bump `scripts/bench/package.json` with the rest (Release checklist, step 4). If a release changes the join prompt, the CLI must ship in the same release.
2. From a clean checkout of the tag: `npm ci`, then `cd scripts/bench && npm publish --access public` (at launch, first remove `"private": true` in a commit). Use an npm account with 2FA, and add the package's provenance (`npm publish --provenance` from CI) once publishing moves to CI.
3. Only after the package is live: switch `BENCH_COMMAND` to the published package, pinned to the release version (the exact form is in the comment in `bench-command.ts`), and point the setup prompt at it: in `prompts/setup.md`, replace the kit step (the `git clone` / `npm ci` lines and the `BENCH` definition) with the pinned package command, and update docs/COMMUNITY.md ("Or set it up yourself"), docs/LOBBY.md (`join_command`) and `scripts/bench/README.md` the same way.
4. Smoke test the published package, pinned to the version, from a scratch directory: its `check` command must run.

## CI while the repository is private

GitHub Actions minutes count against the owner's quota while the repository is private, so the workflows are switched off and CI runs on our machines:
- `scripts/ci-local.sh --quick` (typecheck, unit tests, the CLI package, `deps -- verify`, the image build and boot) before pushing code.
- `scripts/ci-local.sh --full` (adds the smoke event, the lobby end-to-end test, the contributor setup end-to-end test (`scripts/bench/test/setup-e2e.sh`, podman), the card overrides on the real card data, the Hub tests against Postgres and the Hub end-to-end test) before deploying. About 15 minutes. It writes a stamp `.ci-local/<sha>.json`; `deploy/deploy.sh` refuses a commit without a passing `--full` stamp (`--skip-ci-check` overrides, for emergencies only).
- `npm run deps -- check` once a week, by hand (docs/UPGRADING.md), in place of the Monday workflow.

`ci-local.sh` runs in a fresh worktree of `HEAD` (so uncommitted work never leaks into a stamp), with podman or docker, and stops at the first failure. It mirrors the jobs of `.github/workflows/ci.yml`: change both together.

**Release checks** (too long for every CI run; before a release, and after changes to hosted play, durability or quotas): `bash packages/director/test/hosted-e2e.sh` (podman; about 20 minutes: 1,187 s on 2026-10-22). Hosted play end to end with the Hub: the API's answers (a token without the `play` scope is a `401`), per-contributor quotas, the FIFO queue, drain, the per-IP limit, then two events through a SIGTERM mid-draft, a SIGKILL mid-game, a Director down past phase-server's 120 s grace (the game is voided and replayed) and a phase-server restart mid-game, both handed to the Hub with pack regeneration verified. Record the run in the CHANGELOG.

## Before going public: the history

Decided 2026-10-25 (owner): the public repository starts from **one commit** with the launch tree, authored with the
owner's GitHub no-reply address; the pre-release history (about 380 commits) stays private. A scan of every file
version in that history found no real secrets (fixtures only), but the owner's personal e-mail as every commit's
author.

How it was done: the old repository was renamed `grpace/mtgdecktools-agent-bench-history` (private; a mirror is also
at `~/backups/mtgdecktools-agent-bench-history-2026-10-25.git`), and a new `grpace/mtgdecktools-agent-bench` got the
single commit. Renaming rather than force-pushing matters: pull-request refs and old commits stay reachable by hash in
a repository, and would be public with it. Every checkout commits as `10174859+grpace@users.noreply.github.com`
(`git config user.email`); turn on GitHub's "Keep my email addresses private" and "Block command line pushes that
expose my email".

## Going public: GitHub Actions and repository settings

Standard GitHub-hosted runners are free and unlimited for public repositories (job concurrency limits still apply). At launch:
1. **Re-enable the workflows:**
   - `.github/workflows/ci.yml`: uncomment `push` and `pull_request`.
   - `.github/workflows/deps.yml`: uncomment the Monday `schedule` (its 300-minute data job is fine once public).
   - `.github/dependabot.yml`: set `open-pull-requests-limit` back (npm 2, the others 5).
2. **Outside contributors:** Settings → Actions → General → "Fork pull request workflows from outside collaborators" → **Require approval for all outside collaborators**. Fork pull requests run with a read-only `GITHUB_TOKEN` and no secrets (GitHub's default for `pull_request`; never add a `pull_request_target` workflow that checks out fork code). Third-party actions stay pinned by commit SHA.
3. **Protect `main` and release tags** (below).
4. **Gate the deploy branches:** a ruleset on `deploy/*` that requires the CI checks above and blocks force pushes for everyone but the owner (rollbacks), so a push of an unchecked commit is refused wherever it comes from (OPERATIONS.md "Deploying"). The deploy gate in `deploy.sh` can then also accept a green GitHub run; until someone changes it, keep using the local stamp.

## Launch-day extras (first public release)

- **Make the repository public.** Settings → General → Danger zone. Do it only on the owner's go.
- **CLI distribution (decided 2026-10-25):** we distribute the CLI via git checkout (`~/mtgdt-bench`) rather than npm. Keep `"private": true` in `scripts/bench/package.json` and keep `BENCH_COMMAND` and `prompts/setup.md` on the git-checkout instructions.
- **Turn on GitHub security features:**
  - Private vulnerability reporting (Settings → Code security). docs/SECURITY.md and CODE_OF_CONDUCT.md point reporters to it.
  - Dependabot alerts.
  - Secret scanning with push protection.
- **Protect `main`:**
  - Require the CI checks "Typecheck and unit tests", "Smoke event and Hub e2e" and "Image builds and boots".
  - No force pushes.
- **Protect release tags:** add a tag protection rule (ruleset) for `v*`.
- **Let the Dependencies workflow open pull requests:** Settings → Actions → General → Workflow permissions → allow GitHub Actions to create and approve pull requests (UPGRADING.md, "Automation"). Done Oct 22, 2026; the default token stays read-only.
- **Optional:** add a dedicated contact address for security and conduct reports to docs/SECURITY.md and CODE_OF_CONDUCT.md.
