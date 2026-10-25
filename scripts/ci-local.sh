#!/usr/bin/env bash
# Local CI. While the repository is private, GitHub Actions is off (Actions minutes) and this script is CI: it runs the
# jobs of .github/workflows/ci.yml on this machine, with podman (default when installed) or docker.
#   checks       typecheck, unit tests, the CLI package, `deps -- verify`, shell syntax, npm audit (the "checks" job)
#   image        scripts/image-check.sh: build the Director/Hub image, check its files, boot the hosted stack from it
#   integration  the scripted smoke event (8 agents, 3-round Swiss, best of 3 with sideboarding), the lobby
#                end-to-end test, the contributor setup end to end (scripts/bench/test/setup-e2e.sh: login, the
#                wizard, the agent mode, a hosted table, the hand-off; podman only), the card overrides (JavaScript and
#                Python apply write the same bytes; scripted games), the Hub unit tests against Postgres with the smoke
#                run, and the Hub end-to-end test. Not here (too long for every run; a release check in
#                docs/RELEASING.md): packages/director/test/hosted-e2e.sh
# Usage: scripts/ci-local.sh [--quick | --full] [--here] [--keep]
#   --full (default)  all three jobs; deploy/deploy.sh requires a passing --full stamp for the commit it ships
#   --quick           checks and image only (before pushing code)
#   --here            run in this working tree instead of a fresh worktree of HEAD (a stamp is written only when the
#                     tree is clean, so it describes exactly that commit)
#   --keep            keep the temporary worktree (tmp/ci-local/<sha>) for debugging
# Env: CONTAINER_ENGINE=podman|docker; CI_LOCAL_PHASE_PORT (19374), CI_LOCAL_PG_PORT (15474).
# Fails fast. Writes .ci-local/<full sha>.json (gitignored): result, mode, jobs, duration. Logs: tmp/ci-local/logs/<sha>/.
# One run at a time: a second run waits for the first (they would share ports and containers).
# Containers it starts are named mtgdt-ci-local-*; they are removed at the end (the engine's card-data volume
# mtgdt-ci-local-phase-data is kept, so later runs skip the download). Processes are stopped by PID.
# Body is wrapped in main() so bash parses the whole file before running.
main() {
set -euo pipefail
mode=full; here_mode=""; keep=""
while [ $# -gt 0 ]; do
  case "$1" in
    --full) mode=full ;;
    --quick) mode=quick ;;
    --here) here_mode=1 ;;
    --keep) keep=1 ;;
    -h|--help) sed -n '2,20p' "$0"; return 0 ;;
    *) echo "unknown option: $1 (see --help)"; return 2 ;;
  esac
  shift
done

repo="$(cd "$(dirname "$0")/.." && pwd)"
sha="$(git -C "$repo" rev-parse HEAD)"; short="${sha:0:7}"
engine="${CONTAINER_ENGINE:-}"
if [ -z "$engine" ]; then if command -v podman >/dev/null; then engine=podman; elif command -v docker >/dev/null; then engine=docker; fi; fi
[ -n "$engine" ] || { echo "ci-local: needs podman or docker"; return 1; }
# One run at a time on this machine: runs share ports, container names and the podman socket.
mkdir -p "$repo/tmp/ci-local"
if command -v flock >/dev/null; then
  exec 9>"$repo/tmp/ci-local/lock"
  if ! flock -n 9; then echo "ci-local: another run is in progress; waiting for it"; flock 9; fi
fi
logs="$repo/tmp/ci-local/logs/$short"; rm -rf "$logs"; mkdir -p "$logs"
started="$(date -u +%Y-%m-%dT%H:%M:%SZ)"; t0=$(date +%s)
jobs_done=(); pids=(); containers=(); service_pid=""; wt=""; current=""; stamped=""

cleanup() {
  local code=$?
  if [ "$code" != 0 ] && [ -n "$current" ] && [ -z "$stamped" ]; then echo "CI-LOCAL FAIL ($current): logs in $logs"; stamp fail || true; fi
  for p in "${pids[@]:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null || true; done
  for c in "${containers[@]:-}"; do [ -n "$c" ] && "$engine" rm -f "$c" >/dev/null 2>&1 || true; done
  [ -n "$service_pid" ] && kill "$service_pid" 2>/dev/null || true
  if [ -n "$wt" ] && [ -z "$keep" ]; then git -C "$repo" worktree remove --force "$wt" >/dev/null 2>&1 || true; fi
  return $code
}
trap cleanup EXIT

# The tree under test: a fresh worktree of HEAD (clean by construction), or this one with --here.
if [ -n "$here_mode" ]; then
  wd="$repo"
  clean=""; [ -z "$(git -C "$repo" status --porcelain --untracked-files=no)" ] && clean=1
  [ -n "$clean" ] || echo "note: the working tree has uncommitted changes; no stamp will be written"
else
  wt="$repo/tmp/ci-local/$short"; wd="$wt"
  git -C "$repo" worktree remove --force "$wt" >/dev/null 2>&1 || rm -rf "$wt"
  git -C "$repo" worktree prune
  git -C "$repo" worktree add --detach "$wt" "$sha" >/dev/null
  clean=1
fi
cd "$wd"
echo "ci-local: $mode on $short ($engine) in ${wt:+a fresh worktree }$wd"

stamp() { # result
  stamped=1
  [ -n "$clean" ] || return 0
  mkdir -p "$repo/.ci-local"
  python3 -I - "$repo/.ci-local/$sha.json" "$1" "$mode" "$sha" "$started" "$(( $(date +%s) - t0 ))" "$engine" "${jobs_done[@]:-}" <<'EOF'
import json, sys
path, result, mode, sha, started, secs, engine, *jobs = sys.argv[1:]
json.dump({"sha": sha, "result": result, "mode": mode, "jobs": [j for j in jobs if j], "started": started,
           "duration_s": int(secs), "engine": engine}, open(path, "w"), indent=1)
EOF
}
step() { echo "-- $1"; }

job_checks() {
  echo "== checks"
  step "npm ci"; npm ci --no-audit --no-fund > "$logs/npm-ci.log" 2>&1 || { tail -20 "$logs/npm-ci.log"; return 1; }
  step "compose files default to the pinned engine"
  local digest; digest="$(node -p "require('./engine/phase.lock.json').digest")"
  for f in deploy/compose.yaml deploy/compose.local.yaml; do grep -q "$digest" "$f" || { echo "$f: PHASE_IMAGE default is not the pinned digest"; return 1; }; done
  step "package versions match the repository version"
  node -e '
    const root = require("./package.json").version;
    const bad = ["packages/director", "packages/hub", "packages/registry", "packages/site", "scripts/bench"].map((p) => [p, require(`./${p}/package.json`).version]).filter(([, v]) => v !== root);
    if (bad.length) { console.error(`versions differ from ${root}: ${JSON.stringify(bad)}`); process.exit(1); }'
  step "typecheck"; npm run -s typecheck > "$logs/typecheck.log" 2>&1 || { tail -30 "$logs/typecheck.log"; return 1; }
  local w
  for w in @mtgdt/registry @mtgdt/director @mtgdt/site @mtgdt/hub; do
    step "unit tests $w"; npm test -w "$w" > "$logs/test-${w#@mtgdt/}.log" 2>&1 || { tail -40 "$logs/test-${w#@mtgdt/}.log"; return 1; }
  done
  step "unit tests scripts/bench"; npm test --prefix scripts/bench > "$logs/test-bench.log" 2>&1 || { tail -40 "$logs/test-bench.log"; return 1; }
  step "CLI package builds and runs on plain node"
  node scripts/bench/build.mjs > "$logs/cli-build.log" 2>&1 || { tail -20 "$logs/cli-build.log"; return 1; }
  node scripts/bench/dist/cli.js --version > /dev/null
  node scripts/bench/dist/cli.js prompt setup > /dev/null
  (cd scripts/bench && npm pack --dry-run --json --ignore-scripts 2>/dev/null) | node -e 'const f=JSON.parse(require("fs").readFileSync(0,"utf8"))[0].files.map((x)=>x.path); for (const want of ["dist/cli.js","dist/random-agent.mjs","dist/prompts/join.md","dist/prompts/setup.md","dist/engine/phase.lock.json"]) if (!f.includes(want)) { console.error("missing " + want); process.exit(1); }'
  step "derived data matches deps/manifest.json"
  python3 -I -m py_compile scripts/deps.py scripts/build-17lands-ratings.py scripts/card_overrides.py
  npm run -s deps -- verify > "$logs/deps-verify.log" 2>&1 || { tail -20 "$logs/deps-verify.log"; return 1; }
  step "card overrides: unit tests"
  python3 -I scripts/test_card_overrides.py > "$logs/card-overrides-unit.log" 2>&1 || { tail -30 "$logs/card-overrides-unit.log"; return 1; }
  step "shell scripts parse"
  for f in scripts/*.sh scripts/bench/*.sh scripts/bench/test/*.sh deploy/*.sh packages/hub/test/*.sh packages/director/test/*.sh; do
    if [ -f "$f" ]; then bash -n "$f"; fi
  done
  step "npm audit (production dependencies)"
  if npm audit --omit=dev --audit-level=high > "$logs/audit.log" 2>&1; then :; elif grep -qiE 'high|critical' "$logs/audit.log" && ! grep -qiE 'ENOTFOUND|ETIMEDOUT|ECONNRESET|audit endpoint returned an error' "$logs/audit.log"; then
    tail -20 "$logs/audit.log"; return 1
  else echo "   warning: npm audit service unavailable; skipped (not a vulnerability finding)"; fi
  jobs_done+=(checks)
}

podman_socket() { # podman compose hands the stack to a compose provider, which talks to the podman API socket
  [ "$engine" = podman ] || return 0
  local sock="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/podman/podman.sock"
  if curl -sf --unix-socket "$sock" http://d/_ping >/dev/null 2>&1; then export DOCKER_HOST="unix://$sock"; return 0; fi
  sock="$repo/tmp/ci-local/podman.sock"; rm -f "$sock"
  podman system service --time=0 "unix://$sock" > "$logs/podman-service.log" 2>&1 & service_pid=$!
  for _ in $(seq 1 50); do curl -sf --unix-socket "$sock" http://d/_ping >/dev/null 2>&1 && break; sleep 0.2; done
  export DOCKER_HOST="unix://$sock"
}

job_image() {
  echo "== image"
  podman_socket
  CONTAINER_ENGINE="$engine" IMAGE_CHECK_DIRECTOR_PORT="${CI_LOCAL_IMAGE_DPORT:-18887}" IMAGE_CHECK_HUB_PORT="${CI_LOCAL_IMAGE_HPORT:-18888}" \
    scripts/image-check.sh "ci-local-$short" 2>&1 | tee "$logs/image.log" | sed 's/^/   /'
  [ "${PIPESTATUS[0]}" = 0 ] || return 1
  "$engine" rmi "mtgdt-director:ci-local-$short" >/dev/null 2>&1 || true
  jobs_done+=(image)
}

job_integration() {
  echo "== integration"
  local phase_port="${CI_LOCAL_PHASE_PORT:-19374}" pg_port="${CI_LOCAL_PG_PORT:-15474}"
  local phase_image pg_image phase="mtgdt-ci-local-phase" pg="mtgdt-ci-local-pg"
  phase_image="$(node -p "const l=require('./engine/phase.lock.json'); l.image + '@' + l.digest")"
  # The digest deploy/compose.yaml and ci.yml pin for hub-db.
  pg_image="$(sed -n 's/^ *image: *\(postgres:17-alpine@sha256:[0-9a-f]*\).*/\1/p' .github/workflows/ci.yml | head -1)"
  [ -n "$pg_image" ] || pg_image="postgres:17-alpine"
  step "phase-server $phase_image on :$phase_port"
  "$engine" rm -f "$phase" >/dev/null 2>&1 || true
  containers+=("$phase")
  "$engine" run -d --name "$phase" -p "127.0.0.1:$phase_port:9374" -v mtgdt-ci-local-phase-data:/var/lib/phase-server "$phase_image" > /dev/null
  step "postgres on :$pg_port"
  "$engine" rm -f "$pg" >/dev/null 2>&1 || true
  containers+=("$pg")
  "$engine" run -d --name "$pg" -p "127.0.0.1:$pg_port:5432" -e POSTGRES_USER=hub -e POSTGRES_PASSWORD=hub -e POSTGRES_DB=hub "docker.io/library/$pg_image" > /dev/null
  step "engine card data"
  mkdir -p data
  for _ in $(seq 1 180); do
    "$engine" exec "$phase" sh -c 'test -s /var/lib/phase-server/draft-pools.json && test -s /var/lib/phase-server/card-data.json' 2>/dev/null && break
    sleep 2
  done
  "$engine" cp "$phase:/var/lib/phase-server/card-data.json" data/
  "$engine" cp "$phase:/var/lib/phase-server/draft-pools.json" data/
  for _ in $(seq 1 60); do "$engine" exec "$pg" pg_isready -U hub -d hub >/dev/null 2>&1 && break; sleep 1; done
  "$engine" exec "$pg" psql -U hub -d hub -qc 'create database hubtest' >/dev/null
  for _ in $(seq 1 60); do (exec 3<>"/dev/tcp/127.0.0.1/$phase_port") 2>/dev/null && break; sleep 1; done
  local ws="ws://127.0.0.1:$phase_port/ws" db="postgres://hub:hub@127.0.0.1:$pg_port"
  mkdir -p tmp
  step "lobby end to end (background)"
  packages/director/test/lobby-e2e.sh "$ws" data "${CI_LOCAL_LOBBY_PORT:-18970}" > "$logs/lobby-e2e.out" 2>&1 & local lobby=$!; pids+=("$lobby")
  # The contributor flow end to end (its own phase-server, Postgres, mock GitHub, Hub and Director; podman only).
  local setup=""
  if [ "$engine" = podman ]; then
    step "contributor setup end to end (background)"
    E2E_DIRECTOR_PORT="${CI_LOCAL_SETUP_DPORT:-18890}" E2E_GITHUB_PORT="${CI_LOCAL_SETUP_GHPORT:-18891}" E2E_HUB_PORT="${CI_LOCAL_SETUP_HPORT:-18892}" \
      E2E_PG_PORT="${CI_LOCAL_SETUP_PGPORT:-15476}" E2E_PHASE_PORT="${CI_LOCAL_SETUP_PHASE_PORT:-19396}" \
      bash scripts/bench/test/setup-e2e.sh > "$logs/setup-e2e.out" 2>&1 & setup=$!; pids+=("$setup")
  else step "contributor setup end to end: skipped (scripts/bench/test/setup-e2e.sh needs podman)"; fi
  step "card overrides: the JavaScript apply writes the same bytes as scripts/card_overrides.py (real card data)"
  CARD_DATA_FILE=data/card-data.json npx tsx packages/director/src/card-overrides.test.ts > "$logs/card-overrides-js.log" 2>&1 || { tail -30 "$logs/card-overrides-js.log"; return 1; }
  grep -q 'the real card data' "$logs/card-overrides-js.log" || { tail -10 "$logs/card-overrides-js.log"; return 1; }
  step "card overrides: scripted games (the bug on upstream card data, fixed with each override)"
  # One retry: about 1 run in 20 an upstream case ends with the creature not yet in the graveyard (seen 2026-10-22
  # on 0f8c47c, not reproduced in 8 reruns). The first log is kept, with the board and trace of any failing case.
  if ! CONTAINER_ENGINE="$engine" npm run -s overrides -- test > "$logs/card-overrides.log" 2>&1; then
    mv "$logs/card-overrides.log" "$logs/card-overrides-try1.log"; echo "   (retrying once; first run in card-overrides-try1.log)"
    CONTAINER_ENGINE="$engine" npm run -s overrides -- test > "$logs/card-overrides.log" 2>&1 || { tail -30 "$logs/card-overrides.log"; return 1; }
  fi
  step "manual mana from mana creatures, mana rocks and Treasures (a sandbox game)"
  npx tsx packages/director/test/mana-sources-e2e.ts "$ws" data > "$logs/mana-sources-e2e.log" 2>&1 || { tail -30 "$logs/mana-sources-e2e.log"; return 1; }
  step "smoke event (8 scripted agents, best of 3 with sideboarding)"
  local smoke_port="${CI_LOCAL_SMOKE_PORT:-18790}"
  scripts/smoke-event.sh "$ws" data fra "$smoke_port" none > "$logs/smoke.out" 2>&1 || { tail -30 "$logs/smoke.out"; return 1; }
  grep -q 'options without a readable label=0' "$logs/smoke.out" || { tail -10 "$logs/smoke.out"; return 1; }
  local run; run="$(realpath "$(sed -n 's/^SMOKE OK: //p' "$logs/smoke.out")")"
  step "Hub unit tests with a database and the smoke run"
  HUB_TEST_RUN="$run" HUB_TEST_DATABASE_URL="$db/hubtest" npm test -w @mtgdt/hub > "$logs/hub-db-tests.log" 2>&1 || { tail -40 "$logs/hub-db-tests.log"; return 1; }
  step "Hub end to end"
  HUB_E2E_RUN="$run" HUB_E2E_DATABASE_URL="$db/hub" HUB_E2E_PORT="${CI_LOCAL_HUB_PORT:-18841}" HUB_E2E_SMOKE_PORT="${CI_LOCAL_HUB_SMOKE_PORT:-18793}" \
    bash packages/hub/test/e2e.sh > "$logs/hub-e2e.log" 2>&1 || { tail -40 "$logs/hub-e2e.log"; return 1; }
  step "lobby end-to-end result"
  wait "$lobby" || true
  grep -q '^LOBBY E2E OK' "$logs/lobby-e2e.out" && grep -q 'every CLI confirmed its ready check' "$logs/lobby-e2e.out" || { tail -30 "$logs/lobby-e2e.out"; return 1; }
  if [ -n "$setup" ]; then
    step "contributor setup end-to-end result"
    wait "$setup" || true
    grep -q '^E2E OK' "$logs/setup-e2e.out" || { tail -30 "$logs/setup-e2e.out"; return 1; }
  fi
  jobs_done+=(integration)
}

# Jobs run in order and stop at the first failure (set -e; the EXIT trap writes the failed stamp).
current=checks; job_checks
current=image; job_image
if [ "$mode" = full ]; then current=integration; job_integration; fi
current=""; stamp pass
secs=$(( $(date +%s) - t0 ))
echo "CI-LOCAL OK: $mode on $short in $((secs / 60))m$((secs % 60))s (${jobs_done[*]})${clean:+; stamp .ci-local/$sha.json}"
}
main "$@"
