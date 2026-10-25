#!/usr/bin/env bash
# Deploy or update the Agent Bench stack (phase-server + Director + Hub + Hub Postgres) on Coolify
# (gr3g-server): the Director at https://agent-bench.dev.greg.tech, the Hub (results service) at
# https://agent-bench-hub.dev.greg.tech. Idempotent: the first run creates the Coolify project and
# service, later runs rebuild the image on the host and redeploy.
#
# Works over SSH (Host gr3g-server in ~/.ssh/config, see ~/Coding Projects/Server Config): it
# drives Coolify through `php artisan tinker` like the server-ops tooling does, so no Coolify API
# token is needed. Secrets live in ~/.config/mtgdt/ (mode 600, never printed): admin-token (Director admin API),
# hub-admin-token (Hub admin API), hub-db-password (Hub Postgres), hub-service-token (Director → Hub hand-off),
# hub-session-secret, contributor-salt. They are generated only when the service is created for the first time: when
# one is missing and the service already exists, the deploy refuses (a new contributor-salt re-keys every contributor
# in the exports; a new hub-db-password locks the Hub out of its database). --recover-secrets copies the missing ones
# back from the running containers' environment instead (written straight to the files, never printed). Community submission tokens for the Director's
# interim endpoint: one name:token per line in ~/.config/mtgdt/submit-tokens (optional); Hub contributor
# tokens are issued with the hub CLI instead (packages/hub/README.md). hub-session-secret (Hub sign-in cookies)
# is generated too. The GitHub OAuth App's id and secret are best set in Coolify's environment UI: this script
# passes them only when ~/.config/mtgdt/github-oauth-client-id / -secret exist, and never blanks Coolify's values.
#
# What ships is the commit: the image inputs (the .dockerignore allow-list, the Dockerfile, deploy/) are taken from
# HEAD with `git archive`, and the build is tagged with its short sha, so every event's provenance names a commit.
# Uncommitted changes are left out (and listed); --allow-dirty ships the working tree instead, tagged <sha>-dirty.
#
# Live events survive the redeploy: the Director checkpoints them on SIGTERM and resumes them at start
# (drafts at the current pick, games re-attached on phase-server; docs/ARCHITECTURE.md §5).
#   INSTANCE=prod DOMAIN=… HUB_DOMAIN=… deploy/deploy.sh
#                                         the production stack: its own service, database and ~/.config/mtgdt-prod
#                                         secrets (docs/LAUNCH-DAY.md); default INSTANCE=dev is the unlisted dev stack
#   deploy/deploy.sh                      redeploy HEAD now; live events resume
#   deploy/deploy.sh --drain [MINUTES]    first stop admitting events and starting new games, and wait (default 30
#                                         min) until no game is in progress; then redeploy (queued events start after)
#   deploy/deploy.sh --drain-events [MINUTES]
#                                         stop admitting events and wait (default 240 min) until no event is live at all
#                                         (drafts, decks, games, between rounds); if some still are at the limit, give up
#                                         and lift the drain (--force deploys anyway). For engine upgrades.
#   deploy/deploy.sh --force              deploy even though the engine pin changes while events are live, or after
#                                         --drain-events ran out of time (those events resume on the new engine build)
#   deploy/deploy.sh --recover-secrets    copy missing ~/.config/mtgdt secrets back from the running service
#   deploy/deploy.sh --allow-dirty        build from the working tree, uncommitted changes included (tag <sha>-dirty)
#   deploy/deploy.sh --skip-ci-check      deploy without a passing `scripts/ci-local.sh --full` stamp for HEAD
# A change of the engine pin (engine/phase.lock.json), or of the active card overrides (engine/overrides/), while any event is live or queued is refused unless --drain-events
# waits it out or --force says so (docs/UPGRADING.md). Every deploy archives the running booster data in the Hub first and
# stops if that fails. It also installs scripts/ops-check.sh on the server and its 5-minute cron (alerts by e-mail).
# Body is wrapped in main() so bash parses the whole file before running.
main() {
set -euo pipefail
drain=""; drain_min=30; drain_events=""; events_min=240; force=""; recover=""; allow_dirty=""; skip_ci=""
while [ $# -gt 0 ]; do
  case "$1" in
    --drain) drain=1; if [[ "${2:-}" =~ ^[0-9]+$ ]]; then drain_min="$2"; shift; fi ;;
    --drain-events) drain_events=1; if [[ "${2:-}" =~ ^[0-9]+$ ]]; then events_min="$2"; shift; fi ;;
    --force) force=1 ;;
    --recover-secrets) recover=1 ;;
    --allow-dirty) allow_dirty=1 ;;
    --skip-ci-check) skip_ci=1 ;;
    -h|--help) sed -n '2,40p' "$0"; return 0 ;;
    *) echo "unknown option: $1 (see --help)"; return 2 ;;
  esac
  shift
done
if [ -n "$drain" ] && [ -n "$drain_events" ]; then echo "--drain and --drain-events: pick one (--drain-events also waits for games)"; return 2; fi
here="$(cd "$(dirname "$0")/.." && pwd)"
cd "$here"
# INSTANCE=dev (default): the unlisted dev stack. INSTANCE=prod: the public launch stack, a separate Coolify service with
# its own database, volumes and secrets (~/.config/mtgdt-prod), so production starts on fresh data (LAUNCH-CHECKLIST
# B-11; docs/LAUNCH-DAY.md). Production needs its domains spelled out: DOMAIN=… HUB_DOMAIN=… INSTANCE=prod deploy/deploy.sh
instance="${INSTANCE:-dev}"
case "$instance" in
  dev)
    name="agent-bench"
    domain="${DOMAIN:-agent-bench.dev.greg.tech}"
    hub_domain="${HUB_DOMAIN:-agent-bench-hub.dev.greg.tech}"
    secrets="$HOME/.config/mtgdt" ;;
  prod)
    name="agent-bench-prod"
    domain="${DOMAIN:-}"; hub_domain="${HUB_DOMAIN:-}"
    if [ -z "$domain" ] || [ -z "$hub_domain" ]; then echo "INSTANCE=prod needs DOMAIN and HUB_DOMAIN (the production Director and Hub hosts)"; return 2; fi
    case "$domain $hub_domain" in *dev.greg.tech*) echo "INSTANCE=prod with a dev host ($domain, $hub_domain): refusing"; return 2 ;; esac
    secrets="$HOME/.config/mtgdt-prod" ;;
  *) echo "INSTANCE must be dev or prod"; return 2 ;;
esac
echo "== instance $instance: service $name, Director $domain, Hub $hub_domain, secrets $secrets"
# Secrets: generated on the service's first creation only. secret_env maps each file to the container and variable it
# is deployed as, for --recover-secrets.
secret_files=(admin-token hub-admin-token hub-db-password hub-service-token hub-session-secret contributor-salt)
secret_env() { case "$1" in
  admin-token) echo "director ADMIN_TOKEN" ;; hub-admin-token) echo "hub HUB_ADMIN_TOKEN" ;; hub-db-password) echo "hub-db POSTGRES_PASSWORD" ;;
  hub-service-token) echo "director HUB_SERVICE_TOKEN" ;; hub-session-secret) echo "hub HUB_SESSION_SECRET" ;; contributor-salt) echo "hub MTGDT_CONTRIBUTOR_SALT" ;;
esac; }
missing=()
for f in "${secret_files[@]}"; do [ -s "$secrets/$f" ] || missing+=("$f"); done
if [ "${#missing[@]}" -gt 0 ]; then
  if ! existing="$(ssh -o BatchMode=yes -o ConnectTimeout=15 gr3g-server "docker ps -aq --filter label=coolify.projectName=$name | head -1")"; then
    echo "refusing: ~/.config/mtgdt is missing ${missing[*]}, and gr3g-server can't be reached to tell whether the service exists"; return 1
  fi
  if [ -z "$existing" ]; then
    echo "== first deploy: generating ${missing[*]} in $secrets (mode 600)"
    mkdir -p "$secrets" && chmod 700 "$secrets"
    for f in "${missing[@]}"; do (umask 077 && openssl rand -hex 24 > "$secrets/$f"); done
  elif [ -n "$recover" ]; then
    echo "== recovering ${missing[*]} from the running service's environment (not printed)"
    mkdir -p "$secrets" && chmod 700 "$secrets"
    for f in "${missing[@]}"; do
      read -r svc var <<< "$(secret_env "$f")"
      # The value goes from the container's environment straight into the file (stdout of ssh, never a terminal or argv).
      (umask 077 && ssh -o BatchMode=yes gr3g-server "c=\$(docker ps --filter label=coolify.projectName=$name --filter label=com.docker.compose.service=$svc --format '{{.Names}}' | head -1); [ -n \"\$c\" ] && docker exec \"\$c\" printenv $var" > "$secrets/$f.tmp") || true
      if [ -s "$secrets/$f.tmp" ]; then mv "$secrets/$f.tmp" "$secrets/$f"; echo "  recovered $f"; else rm -f "$secrets/$f.tmp"; echo "  could not recover $f (is the $svc container running?)"; return 1; fi
    done
  else
    echo "refusing: the $name service exists on gr3g-server, but $secrets is missing: ${missing[*]}."
    echo "  A new value would break the deployment: contributor-salt re-keys every contributor in the public exports, and"
    echo "  hub-db-password no longer matches the database. Restore the files from your backup of ~/.config/mtgdt, or copy"
    echo "  them back from the running containers with: deploy/deploy.sh --recover-secrets (values are never printed)."
    return 1
  fi
fi

# Everything that goes into the image or decides how it runs: the .dockerignore allow-list (the `!` lines), plus the
# Dockerfile, .dockerignore and deploy/ (compose.yaml, the Coolify script).
mapfile -t inputs < <(printf '%s\n' Dockerfile .dockerignore deploy; sed -n 's/^!\(.*[^/]\)\/*$/\1/p' .dockerignore)
sha="$(git rev-parse --short HEAD)"
dirty="$(git status --porcelain -- "${inputs[@]}")"
# Local CI gate (GitHub Actions is off while the repo is private): HEAD needs a passing `scripts/ci-local.sh --full`.
if [ -z "$skip_ci" ]; then
  stamp=".ci-local/$(git rev-parse HEAD).json"
  if ! python3 -I -c "import json,sys; s=json.load(open(sys.argv[1])); sys.exit(0 if s.get('result') == 'pass' and s.get('mode') == 'full' else 1)" "$stamp" 2>/dev/null; then
    echo "refusing to deploy $sha: no passing full local CI run for it (scripts/ci-local.sh --full; --skip-ci-check overrides)"; return 1
  fi
  if [ -n "$allow_dirty" ] && [ -n "$dirty" ]; then echo "refusing: --allow-dirty ships changes local CI never ran (--skip-ci-check overrides)"; return 1; fi
fi
ctx="$(mktemp -d)"
on_exit() {
  local code=$?
  rm -rf "$ctx"
  # set -e stops on the first failing command without a word; say where, so a failed deploy is never silent.
  if [ "$code" -ne 0 ] && [ -z "${deployed:-}" ]; then echo "deploy stopped (exit $code) near line ${failed_line:-?} of deploy/deploy.sh"; fi
  # A failed deploy leaves no secrets staged on the server, and lifts the drain so the running Director carries on.
  if [ -n "${staged:-}" ] && [ -z "${deployed:-}" ]; then ssh gr3g-server 'rm -rf ~/.agent-bench-deploy' 2>/dev/null || true; fi
  if [ -n "${drained:-}" ] && [ -z "${deployed:-}" ]; then
    admin_api -X POST -H "Content-Type: application/json" -d '{"drain":false}' "https://$domain/api/admin/drain" >/dev/null 2>&1 || true
    echo "deploy failed: drain lifted on the running Director"
  fi
}
trap 'failed_line=$LINENO' ERR
trap on_exit EXIT
if [ -n "$allow_dirty" ]; then
  # The working tree as it is (never local secrets: .bench/ holds a self-host admin token; .env* files).
  rsync -aR --exclude node_modules --exclude data --exclude runs --exclude tmp --exclude .git --exclude .bench --exclude '.env*' \
    --exclude 'packages/site/dist*' --exclude 'scripts/bench/dist' -- "${inputs[@]}" "$ctx/"
  if [ -n "$dirty" ]; then sha="$sha-dirty"; echo "note: deploying uncommitted changes as $sha"; fi
else
  git archive --format=tar HEAD -- "${inputs[@]}" | tar -x -C "$ctx"
  if [ -n "$dirty" ]; then
    echo "note: deploying HEAD ($sha); these uncommitted changes to image inputs are NOT included (commit them, or --allow-dirty):"
    printf '%s\n' "$dirty" | sed 's/^/  /'
  fi
fi
# The engine pin that ships (the working tree's only with --allow-dirty).
phase_image="$(python3 -I -c "import json,sys; l=json.load(open(sys.argv[1])); print(l['image'] + '@' + l['digest'])" "$ctx/engine/phase.lock.json")"

# An engine upgrade while events are live (LAUNCH-CHECKLIST E-2): they would resume and play on the new build. Refused
# unless --drain-events waits until nothing is live, or --force. Live counts come from the public /api/capacity.
admin_api() { curl -sS -m 20 -H @<(printf 'Authorization: Bearer %s\n' "$(cat "$secrets/admin-token")") "$@"; }
live_events() { curl -sS -m 10 "https://$domain/api/capacity" 2>/dev/null | python3 -I -c "import json,sys; print(json.load(sys.stdin)['live']['events'])" 2>/dev/null || echo '?'; }
running_engine="$(ssh -o BatchMode=yes gr3g-server 'c=$(docker ps --filter label=coolify.projectName='"$name"' --filter label=com.docker.compose.service=phase-server --format "{{.Names}}" | head -1); [ -z "$c" ] || docker inspect -f "{{.Config.Image}}" "$c"' 2>/dev/null || echo '?')"
engine_change=""
# refuse_if_live <what changes>: refused while events are live, unless --drain-events waits them out or --force.
refuse_if_live() {
  [ -z "$drain_events" ] || return 0
  local n; n="$(live_events)"
  if [ "$n" != 0 ] && [ -z "$force" ]; then
    echo "refusing: $n event(s) live on the Director; after the restart they would play on $1. Use"
    echo "  --drain-events [MINUTES] to wait until nothing is live (docs/UPGRADING.md), or --force to deploy anyway."
    return 1
  fi
  [ "$n" = 0 ] || echo "  --force: $n live event(s) will resume on $1"
}
if [ -n "$running_engine" ] && [ "$running_engine" != "$phase_image" ]; then
  engine_change=1
  echo "== the engine pin changes: ${running_engine##*@} -> ${phase_image##*@}"
  refuse_if_live "the new engine build" || return 1
fi
# Card overrides (docs/CARD-OVERRIDES.md): phase-server loads card data only at start and the Director records it at
# event start, so adding, changing or retiring an override is an engine change for live events. Compared: the
# fingerprint of the active override files that ship, and the one in the running volume's sidecar (none yet: no overrides).
shipped_overrides="$(python3 -I - "$ctx/engine/overrides" <<'PY'
import hashlib, json, pathlib, sys
h = hashlib.sha256()
for p in sorted(pathlib.Path(sys.argv[1]).glob('*.json')):
    b = p.read_bytes()
    if json.loads(b).get('status') in ('active', 'submitted-upstream'):
        h.update(p.stem.encode() + b'\0' + hashlib.sha256(b).digest() + b'\0')
print(h.hexdigest())
PY
)"
running_overrides="$(ssh -o BatchMode=yes gr3g-server 'c=$(docker ps --filter label=coolify.projectName='"$name"' --filter label=com.docker.compose.service=phase-server --format "{{.Names}}" | head -1); [ -z "$c" ] || docker exec "$c" cat /var/lib/phase-server/card-overrides.json 2>/dev/null || true' 2>/dev/null \
  | python3 -I -c "import json,sys
try: print(json.load(sys.stdin)['overrides_sha256'])
except Exception: print('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')")"
if [ "$running_overrides" != "$shipped_overrides" ]; then
  engine_change=1
  echo "== the card overrides change: ${running_overrides:0:12} -> ${shipped_overrides:0:12} (phase-server restarts on the new card data)"
  refuse_if_live "the new card data" || return 1
fi

echo "== build director image mtgdt-director:$sha on gr3g-server"
ssh gr3g-server 'mkdir -p ~/apps/mtgdt-agent-bench'
rsync -az --delete --exclude node_modules --exclude data --exclude runs --exclude tmp "$ctx/" gr3g-server:apps/mtgdt-agent-bench/
ssh gr3g-server "cd ~/apps/mtgdt-agent-bench && docker build -q --build-arg DIRECTOR_TAG=$sha -t mtgdt-director:$sha -t mtgdt-director:latest . >/dev/null"

# Live events: drain first (--drain, --drain-events), or rely on resume. The admin token goes to curl through a file
# descriptor, not argv (admin_api above).
status_line() { python3 -I -c "import json,sys
d=json.load(sys.stdin)['live']
print(d['events'], d['games'], d['queued'])" 2>/dev/null || echo '? ? ?'; }
if [ -n "$drain_events" ]; then
  echo "== drain events: stop admitting events (running ones play on); wait up to $events_min min until none is live"
  if admin_api -X POST -H 'Content-Type: application/json' -d '{"drain":true,"games":false}' "https://$domain/api/admin/drain" -o /dev/null -w '%{http_code}' | grep -q '^200$'; then
    drained=1
    t_drain=$(date +%s)
    deadline=$(( t_drain + events_min * 60 ))
    while :; do
      read -r ev games queued <<< "$(admin_api "https://$domain/api/admin/status" | status_line)"
      [ "$ev" = 0 ] && { echo "  no live event after $(( ($(date +%s) - t_drain) / 60 )) min ($queued queued: they start after the restart); deploying"; break; }
      if [ "$(date +%s)" -ge "$deadline" ]; then
        if [ -n "$force" ]; then echo "  $ev event(s) still live after $events_min min: --force, deploying anyway (they resume)"; break; fi
        echo "  giving up: $ev event(s) still live after $events_min min ($games game(s) in progress). The drain is lifted; nothing was deployed."
        return 1
      fi
      echo "  $ev event(s) live, $games game(s) in progress, $queued queued; waiting"
      sleep 60
    done
  else
    echo "refusing: the running Director has no drain endpoint (older build); deploy when GET /api/events shows nothing live" >&2
    return 1
  fi
elif [ -n "$drain" ]; then
  echo "== drain: stop admitting events and starting games; wait up to $drain_min min for games in progress to end"
  if admin_api -X POST -H 'Content-Type: application/json' -d '{"drain":true}' "https://$domain/api/admin/drain" -o /dev/null -w '%{http_code}' | grep -q '^200$'; then
    drained=1
    deadline=$(( $(date +%s) + drain_min * 60 ))
    while :; do
      st="$(admin_api "https://$domain/api/admin/status" || true)"
      games="$(printf '%s' "$st" | python3 -I -c "import json,sys; d=json.load(sys.stdin); print(d['live']['games'])" 2>/dev/null || echo '?')"
      events="$(printf '%s' "$st" | python3 -I -c "import json,sys; d=json.load(sys.stdin); print(d['live']['events'], 'live,', d['live']['queued'], 'queued')" 2>/dev/null || echo '?')"
      [ "$games" = 0 ] && { echo "  no game in progress ($events); deploying"; break; }
      [ "$(date +%s)" -ge "$deadline" ] && { echo "  drain timeout with $games game(s) in progress ($events): deploying anyway, they resume after the restart"; break; }
      echo "  $games game(s) in progress ($events); waiting"
      sleep 30
    done
  else
    echo "  the running Director has no drain endpoint (older build): deploy only when GET /api/events shows nothing live" >&2
  fi
else
  live="$(curl -sS -m 10 "https://$domain/api/capacity" 2>/dev/null | python3 -I -c "import json,sys; d=json.load(sys.stdin)['live']; print(d['events'], 'live event(s),', d['games'], 'game(s) in progress,', d['queued'], 'queued')" 2>/dev/null || echo 'unknown')"
  echo "== live now: $live (they are checkpointed on SIGTERM and resume after the restart)"
fi

# Before anything restarts: copy the running engine's booster data and unsupported-card list into the Hub's
# archive as <sha256>.json, so events that ran on them keep passing pack regeneration after an engine upgrade
# (phase-server rewrites its data volume on start). Idempotent; harmless when nothing changed.
echo "== archive the running booster data in the Hub (HUB_BOOSTER_ARCHIVE)"
ssh gr3g-server 'hub=$(docker ps --filter label=coolify.projectName='"$name"' --filter label=com.docker.compose.service=hub --format "{{.Names}}" | head -1)
  if [ -z "$hub" ]; then echo "  no running hub container (first deploy?): nothing to archive"; exit 0; fi
  docker exec "$hub" sh -c '"'"'set -e; dir="${HUB_BOOSTER_ARCHIVE:-$HUB_DATA_DIR/booster-data}"; mkdir -p "$dir"
    for f in "$HUB_ENGINE_DATA_DIR/draft-pools.json" "$HUB_UNSUPPORTED_CARDS"; do
      [ -f "$f" ] || { echo "  missing $f"; continue; }
      h=$(sha256sum "$f" | cut -d" " -f1)
      if [ -f "$dir/$h.json" ]; then echo "  have $h.json ($(basename "$f"))"; else cp "$f" "$dir/$h.json"; echo "  archived $(basename "$f") as $h.json"; fi
    done'"'"'' || { echo "refusing: could not archive the running booster data in the Hub; events played on it would fail pack regeneration (docs/UPGRADING.md: archive it by hand, then deploy again)"; return 1; }

echo "== stage compose + config (private) on the server"
# Staged only now (not before the drain wait), and removed by on_exit if the deploy fails before Coolify takes it.
# Secrets go to python through the environment, not argv (argv shows up in `ps`).
cfg="$(ADMIN_TOKEN="$(cat "$secrets/admin-token")" HUB_ADMIN_TOKEN="$(cat "$secrets/hub-admin-token")" \
  HUB_DB_PASSWORD="$(cat "$secrets/hub-db-password")" HUB_SERVICE_TOKEN="$(cat "$secrets/hub-service-token")" \
  HUB_SESSION_SECRET="$(cat "$secrets/hub-session-secret")" MTGDT_CONTRIBUTOR_SALT="$(cat "$secrets/contributor-salt")" \
  GITHUB_CLIENT_ID="$(cat "$secrets/github-oauth-client-id" 2>/dev/null || true)" \
  GITHUB_CLIENT_SECRET="$(cat "$secrets/github-oauth-client-secret" 2>/dev/null || true)" \
  SUBMIT_TOKENS="$(if [ -s "$secrets/submit-tokens" ]; then grep -v '^ *$' "$secrets/submit-tokens" | paste -sd, -; fi)" \
  python3 -I -c "
import json, os, sys
e = os.environ
env = {
  'PHASE_IMAGE': sys.argv[3], 'DIRECTOR_TAG': sys.argv[4], 'PUBLIC_URL': 'https://' + sys.argv[2], 'ADMIN_TOKEN': e['ADMIN_TOKEN'],
  'SUBMIT_TOKENS': e['SUBMIT_TOKENS'], 'HUB_PUBLIC_URL': 'https://' + sys.argv[5], 'HUB_ADMIN_TOKEN': e['HUB_ADMIN_TOKEN'],
  'HUB_DB_PASSWORD': e['HUB_DB_PASSWORD'], 'HUB_SERVICE_TOKEN': e['HUB_SERVICE_TOKEN'], 'HUB_SESSION_SECRET': e['HUB_SESSION_SECRET'],
  'MTGDT_CONTRIBUTOR_SALT': e['MTGDT_CONTRIBUTOR_SALT'],
}
# GitHub OAuth App credentials: only from local files; otherwise Coolify keeps the values set in its UI.
for k in ('GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET'):
  if e.get(k, '').strip(): env[k] = e[k].strip()
print(json.dumps({'name': sys.argv[1], 'domains': {'director': 'https://' + sys.argv[2] + ':8787', 'hub': 'https://' + sys.argv[5] + ':8787'}, 'env': env}))
" "$name" "$domain" "$phase_image" "$sha" "$hub_domain")"
staged=1
ssh gr3g-server 'umask 077; rm -rf ~/.agent-bench-deploy; mkdir -p ~/.agent-bench-deploy'
scp -q "$ctx/deploy/compose.yaml" "$ctx/deploy/coolify-service.php" gr3g-server:.agent-bench-deploy/
printf '%s' "$cfg" | ssh gr3g-server 'umask 077; cat > ~/.agent-bench-deploy/config.json'

echo "== Coolify DB backup (server rule), volume ownership, then create/update the service"
ssh gr3g-server bash -s -- "$sha" "$name" <<'REMOTE'
set -euo pipefail
umask 077 # the Coolify DB dump below holds every service secret
sha="$1"
name="${2:-agent-bench}"
image="mtgdt-director:$sha"
stopped=""; started=""
cleanup() {
  docker exec -u root coolify rm -rf /tmp/agent-bench || true
  rm -rf ~/.agent-bench-deploy
  rm -f "${partial:-/nonexistent}"
  # Stopped for the ownership hand-over but Coolify never restarted them: bring the old containers back.
  if [ -n "$stopped" ] && [ -z "$started" ]; then echo "  restarting the previous containers"; docker start $stopped > /dev/null || true; fi
}
trap cleanup EXIT

# 1. Backup of the Coolify database, verified before anything changes: pipefail catches a failed pg_dump, then the
# archive must be intact, of a plausible size, and end with pg_dump's completion marker. Keeps this script's last 10.
dir=~/documents/backup/pre-clone
mkdir -p "$dir"
final="$dir/coolify-$(date +%Y%m%d-%H%M%S)-pre-$name.sql.gz"
partial="$final.partial"
docker exec coolify-db pg_dump -U coolify coolify | gzip > "$partial"
gzip -t "$partial"
size="$(stat -c %s "$partial")"
[ "$size" -ge 1000000 ] || { echo "  Coolify DB backup is only $size bytes: aborting the deploy" >&2; exit 1; }
tail_text="$(gzip -dc "$partial" | tail -c 2000)"
grep -q 'PostgreSQL database dump complete' <<< "$tail_text" || { echo "  Coolify DB backup is incomplete: aborting the deploy" >&2; exit 1; }
mv "$partial" "$final"; partial=""
echo "  backup $(basename "$final") ($((size / 1048576)) MB, verified)"
find "$dir" -maxdepth 1 -type f -regextype posix-extended -regex ".*/coolify-[0-9]{8}-[0-9]{6}-pre-$name\\.sql\\.gz" -printf '%f\n' \
  | sort -r | tail -n +11 | while read -r old; do rm -f -- "$dir/$old"; echo "  pruned old backup $old"; done

# 2. One-time ownership hand-over (OPS-1): the Director and Hub now run as uid 999. Their volumes were written by root;
# hand every file that isn't 999's to 999. Skipped once nothing is left to hand over. The containers stop first (the
# Director checkpoints live events on SIGTERM, as at every redeploy), so nothing writes as root after the hand-over.
sel=(--filter label=coolify.projectName="$name")
first="$(docker ps -aq "${sel[@]}" --filter label=com.docker.compose.service=director | head -1)"
if [ -n "$first" ]; then
  project="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$first")"
  mounts=()
  for v in director-runs director-cache hub-data; do
    if docker volume inspect "${project}_$v" > /dev/null 2>&1; then mounts+=(-v "${project}_$v:/volumes/$v"); fi
  done
  as_root=(docker run --rm --network none --user 0:0 --entrypoint find "${mounts[@]}" "$image" /volumes -mindepth 1)
  if [ "${#mounts[@]}" -gt 0 ] && [ -n "$("${as_root[@]}" \( ! -uid 999 -o ! -gid 999 \) -print -quit)" ]; then
    echo "  one-time: handing director-runs, director-cache and hub-data to uid 999 (the Director and Hub no longer run as root)"
    stopped="$(docker ps -q "${sel[@]}" --filter label=com.docker.compose.service=director; docker ps -q "${sel[@]}" --filter label=com.docker.compose.service=hub)"
    stopped="$(echo $stopped)"
    if [ -n "$stopped" ]; then docker stop -t 30 $stopped > /dev/null; fi
    "${as_root[@]}" \( ! -uid 999 -o ! -gid 999 \) -exec chown -h 999:999 {} +
    left="$("${as_root[@]}" \( ! -uid 999 -o ! -gid 999 \) -print -quit)"
    [ -z "$left" ] || { echo "  ownership hand-over incomplete ($left): aborting the deploy" >&2; exit 1; }
    echo "  done"
  fi
fi

# 3. Create or update the Coolify service; Coolify recreates the containers.
docker exec -u root coolify rm -rf /tmp/agent-bench
docker cp ~/.agent-bench-deploy coolify:/tmp/agent-bench
docker exec -u root coolify chown -R www-data:www-data /tmp/agent-bench
docker exec coolify php artisan tinker --execute="require \"/tmp/agent-bench/coolify-service.php\";"
started=1
REMOTE
deployed=1

# Monitoring (LAUNCH-CHECKLIST H-1): the shipped scripts/ops-check.sh on the host, and the owner's crontab line that runs it
# every 5 minutes and e-mails on failure (docs/OPERATIONS.md, "Monitoring"). Idempotent; never touches other cron lines.
echo "== ops check: install ~/documents/agent-bench-ops/ops-check.sh and its 5-minute cron on gr3g-server"
if [ -n "$allow_dirty" ]; then ops_src="$(cat scripts/ops-check.sh)"; else ops_src="$(git show HEAD:scripts/ops-check.sh)"; fi
# One cron line per instance (its own URLs, Coolify project and alert state); dev keeps its original line.
if printf '%s\n' "$ops_src" | ssh gr3g-server 'set -e; d=~/documents/agent-bench-ops; mkdir -p "$d"; cat > "$d/ops-check.sh.new"; chmod 755 "$d/ops-check.sh.new"; mv "$d/ops-check.sh.new" "$d/ops-check.sh"' \
  && ssh gr3g-server bash -s -- "$instance" "$name" "$domain" "$hub_domain" <<'CRON'
set -e
instance="$1"; name="$2"; domain="$3"; hub="$4"; d=~/documents/agent-bench-ops
if [ "$instance" = prod ]; then
  mark="# ops:$name"
  line="*/5 * * * * SSH_HOST=local DIRECTOR_URL=https://$domain HUB_URL=https://$hub PROJECT=$name OPS_STATE_DIR=\$HOME/.local/state/$name-ops $d/ops-check.sh --server --alert >/dev/null 2>&1 $mark"
  present=$(crontab -l 2>/dev/null | grep -cF -- "$mark" || true)
else
  line="*/5 * * * * SSH_HOST=local $d/ops-check.sh --server --alert >/dev/null 2>&1"
  present=$(crontab -l 2>/dev/null | grep -F "agent-bench-ops/ops-check.sh" | grep -cvF "# ops:" || true)
fi
if [ "$present" = 0 ]; then (crontab -l 2>/dev/null; echo "$line") | crontab -; echo "  cron line added"; else echo "  cron line present"; fi
CRON
then :
else echo "  warning: could not install the ops check (docs/OPERATIONS.md, \"Monitoring\")"; fi

# /health reports the build's version: wait until the new build answers, not just any (the old one may still be up).
version_at() { curl -sf -m 5 "https://$1/health" 2>/dev/null | python3 -I -c "import json,sys; print(json.load(sys.stdin).get('version', ''))" 2>/dev/null || true; }
echo "== waiting for https://$domain/health to answer as $sha"
for _ in $(seq 1 120); do [ "$(version_at "$domain")" = "$sha" ] && break; sleep 5; done
if [ "$(version_at "$domain")" = "$sha" ]; then
  echo "LIVE: https://$domain  (director $sha, $phase_image)"
  echo "Create an event: scripts/new-event.sh <set> <name=harness/model,...> [knowledge] [seed]"
  for _ in $(seq 1 60); do [ "$(version_at "$hub_domain")" = "$sha" ] && break; sleep 5; done
  if [ "$(version_at "$hub_domain")" = "$sha" ]; then
    echo "HUB: https://$hub_domain  (hub $sha; data at /data/index.json; admin: ssh gr3g-server docker exec <hub container> npm run hub -- …)"
  else
    echo "Hub not answering as $sha yet (answers: '$(version_at "$hub_domain")'). Check: ssh gr3g-server 'docker ps | grep hub-; docker logs --tail 50 <hub container>'"
    return 1
  fi
else
  echo "The Director is not answering as $sha (answers: '$(version_at "$domain")'). Check: ssh gr3g-server 'docker ps | grep director; docker logs --tail 50 <director container>'"
  return 1
fi
}
main "$@"
exit $?
