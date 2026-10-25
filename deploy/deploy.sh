#!/usr/bin/env bash
# Deploy a commit of the Agent Bench stack (phase-server + Director + Hub + Hub Postgres) on Coolify (gr3g-server) by
# promoting it: the commit is pushed to the instance's deploy branch (deploy/dev, deploy/prod; deploy/instance.sh), and
# Coolify, which deploys that branch from GitHub (deploy/coolify-setup.sh created the application), builds the image
# from the commit and restarts the stack. A push from anywhere, or Coolify's Deploy button, takes the same path: this
# script adds the checks around it and waits until the new build answers. docs/OPERATIONS.md "Deploying".
# An instance's first deploy also creates its Coolify application and secrets (deploy/coolify-setup.sh).
#
#   deploy/deploy.sh                      deploy HEAD on dev now; live events checkpoint on SIGTERM and resume
#   INSTANCE=prod deploy/deploy.sh        the production stack (only commits on origin/main)
#   deploy/deploy.sh --ref <commit>       another commit (a tag, a sha) instead of HEAD
#   deploy/deploy.sh --rollback --ref <commit>
#                                         move the deploy branch back to an older commit (force-with-lease)
#   deploy/deploy.sh --redeploy           the branch is already at the commit: have Coolify build and deploy it again
#   deploy/deploy.sh --drain [MINUTES]    first stop admitting events and starting new games, and wait (default 30
#                                         min) until no game is in progress; then deploy (queued events start after)
#   deploy/deploy.sh --drain-events [MINUTES]
#                                         stop admitting events and wait (default 240 min) until no event is live at all;
#                                         if some still are at the limit, give up and lift the drain (--force deploys
#                                         anyway). For engine upgrades.
#   deploy/deploy.sh --force              deploy even though the engine pin or card overrides change while events are
#                                         live, or after --drain-events ran out of time (those events resume on the new build)
#   deploy/deploy.sh --skip-ci-check      deploy without a passing `scripts/ci-local.sh --full` stamp for the commit
#
# What ships is the commit, never the working tree: Coolify clones it from GitHub, so it must be pushed (this pushes
# it to the deploy branch). The CI gate: the commit needs a passing full local CI run (.ci-local/<sha>.json) while
# the repository is private. A change of the engine pin (engine/phase.lock.json) or of the active card overrides
# (engine/overrides/) while any event is live or queued is refused unless --drain-events waits it out or --force says
# so (docs/UPGRADING.md). It also installs scripts/ops-check.sh from the commit on the server, with its 5-minute cron.
# Needs: git push access to origin, and SSH to gr3g-server (Host gr3g-server) for the engine check, --redeploy, the
# deployment's status and the ops check; nothing secret except the admin token for --drain.
# Body is wrapped in main() so bash parses the whole file before running.
main() {
set -euo pipefail
drain=""; drain_min=30; drain_events=""; events_min=240; force=""; skip_ci=""; ref="HEAD"; rollback=""; redeploy=""
while [ $# -gt 0 ]; do
  case "$1" in
    --drain) drain=1; if [[ "${2:-}" =~ ^[0-9]+$ ]]; then drain_min="$2"; shift; fi ;;
    --drain-events) drain_events=1; if [[ "${2:-}" =~ ^[0-9]+$ ]]; then events_min="$2"; shift; fi ;;
    --force) force=1 ;;
    --skip-ci-check) skip_ci=1 ;;
    --ref) ref="${2:?--ref needs a commit}"; shift ;;
    --rollback) rollback=1 ;;
    --redeploy) redeploy=1 ;;
    -h|--help) sed -n '2,31p' "$0"; return 0 ;;
    *) echo "unknown option: $1 (see --help)"; return 2 ;;
  esac
  shift
done
if [ -n "$drain" ] && [ -n "$drain_events" ]; then echo "--drain and --drain-events: pick one (--drain-events also waits for games)"; return 2; fi
here="$(cd "$(dirname "$0")/.." && pwd)"
cd "$here"
# shellcheck source=deploy/instance.sh
. deploy/instance.sh
instance="${INSTANCE:-dev}"
instance_config "$instance" || return 2
sha="$(git rev-parse --verify "$ref^{commit}")"
short="${sha:0:7}"
echo "== instance $instance: $short -> branch $branch (Coolify application $name), Director $domain, Hub $hub_domain"

# The CI gate (GitHub Actions is off while the repository is private): a passing `scripts/ci-local.sh --full` for this
# commit, in this checkout or the main one (worktrees share the commits, not the stamps).
if [ -z "$skip_ci" ]; then
  main_tree="$(git worktree list --porcelain | sed -n '1s/^worktree //p')"
  ok=""
  for d in "$here" "$main_tree"; do
    if python3 -I -c "import json,sys; s=json.load(open(sys.argv[1])); sys.exit(0 if s.get('result') == 'pass' and s.get('mode') == 'full' else 1)" "$d/.ci-local/$sha.json" 2>/dev/null; then ok=1; fi
  done
  [ -n "$ok" ] || { echo "refusing to deploy $short: no passing full local CI run for it (scripts/ci-local.sh --full; --skip-ci-check overrides)"; return 1; }
fi
git fetch -q origin
# Production runs what main says: only commits on origin/main.
if [ "$instance" = prod ] && ! git merge-base --is-ancestor "$sha" origin/main; then
  echo "refusing: $short is not on origin/main (production deploys only merged commits)"; return 1
fi
current="$(git ls-remote origin "refs/heads/$branch" | cut -f1)"
# The instance's Coolify application (empty: none yet, or gr3g-server can't be reached).
on_host() { ssh -o BatchMode=yes -o ConnectTimeout=15 gr3g-server "$@"; }
app_id() { on_host "docker exec coolify-db psql -U coolify -d coolify -Atc \"select a.id from applications a join environments e on e.id = a.environment_id join projects p on p.id = e.project_id where p.name = '$name' and a.name = '$name' and a.deleted_at is null\""; }
id="$(app_id 2>/dev/null || true)"
if [ "$current" = "$sha" ] && [ -z "$redeploy" ] && [ -n "$id" ]; then
  echo "$branch is already at $short: nothing to deploy. To build and deploy it again: deploy/deploy.sh --redeploy"; return 0
fi
if [ "$current" != "$sha" ] && [ -n "$redeploy" ]; then echo "--redeploy: $branch is at ${current:0:7}, not $short (drop --redeploy to deploy $short)"; return 2; fi
if [ -n "$current" ] && [ "$current" != "$sha" ] && ! git merge-base --is-ancestor "$current" "$sha" 2>/dev/null && [ -z "$rollback" ]; then
  echo "refusing: $branch is at ${current:0:7}, which $short doesn't contain. To go back to an older commit: --rollback"; return 1
fi

on_exit() {
  local code=$?
  if [ "$code" -ne 0 ] && [ -z "${deployed:-}" ]; then echo "deploy stopped (exit $code) near line ${failed_line:-?} of deploy/deploy.sh"; fi
  # A failed deploy lifts the drain, so the running Director carries on.
  if [ -n "${drained:-}" ] && [ -z "${deployed:-}" ]; then
    admin_api -X POST -H "Content-Type: application/json" -d '{"drain":false}' "https://$domain/api/admin/drain" >/dev/null 2>&1 || true
    echo "deploy failed: drain lifted on the running Director"
  fi
}
trap 'failed_line=$LINENO' ERR
trap on_exit EXIT

# The admin token goes to curl through a file descriptor, never argv.
admin_api() { curl -sS -m 20 -H @<(printf 'Authorization: Bearer %s\n' "$(cat "$secrets/admin-token")") "$@"; }
live_events() { curl -sS -m 10 "https://$domain/api/capacity" 2>/dev/null | python3 -I -c "import json,sys; print(json.load(sys.stdin)['live']['events'])" 2>/dev/null || echo '?'; }
container_of() { echo "c=\$(docker ps --filter label=coolify.projectName=$name --filter label=com.docker.compose.service=$1 --format '{{.Names}}' | head -1)"; }

# An engine upgrade while events are live (docs/UPGRADING.md): they would resume and play on the new build. Refused
# unless --drain-events waits until nothing is live, or --force. Live counts come from the public /api/capacity.
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
phase_image="$(git show "$sha:engine/phase.lock.json" | python3 -I -c "import json,sys; l=json.load(sys.stdin); print(l['image'] + '@' + l['digest'])")"
running_engine="$(on_host "$(container_of phase-server); [ -z \"\$c\" ] || docker inspect -f '{{.Config.Image}}' \"\$c\"" 2>/dev/null || echo '?')"
if [ -n "$running_engine" ] && [ "$running_engine" != "$phase_image" ]; then
  echo "== the engine pin changes: ${running_engine##*@} -> ${phase_image##*@}"
  refuse_if_live "the new engine build" || return 1
fi
# Card overrides (docs/CARD-OVERRIDES.md): phase-server loads card data only at start, so adding, changing or retiring an
# override is an engine change for live events. Compared: the fingerprint of the commit's active override files, and the
# one in the running phase-data volume's sidecar (none: no overrides).
ovr="$(mktemp -d)"
git archive "$sha" engine/overrides | tar -x -C "$ovr"
shipped_overrides="$(python3 -I - "$ovr/engine/overrides" <<'PY'
import hashlib, json, pathlib, sys
h = hashlib.sha256()
for p in sorted(pathlib.Path(sys.argv[1]).glob('*.json')):
    b = p.read_bytes()
    if json.loads(b).get('status') in ('active', 'submitted-upstream'):
        h.update(p.stem.encode() + b'\0' + hashlib.sha256(b).digest() + b'\0')
print(h.hexdigest())
PY
)"
rm -rf "$ovr"
if [ -n "$running_engine" ]; then
  running_overrides="$(on_host "$(container_of phase-server); [ -z \"\$c\" ] || docker exec \"\$c\" cat /var/lib/phase-server/card-overrides.json 2>/dev/null || true" 2>/dev/null \
    | python3 -I -c "import json,sys
try: print(json.load(sys.stdin)['overrides_sha256'])
except Exception: print('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')")"
  if [ "$running_overrides" != "$shipped_overrides" ]; then
    echo "== the card overrides change: ${running_overrides:0:12} -> ${shipped_overrides:0:12} (phase-server restarts on the new card data)"
    refuse_if_live "the new card data" || return 1
  fi
fi

# Live events: drain first (--drain, --drain-events), or rely on resume.
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
    echo "refusing: the running Director has no drain endpoint, or it isn't up; deploy when GET /api/events shows nothing live" >&2
    return 1
  fi
elif [ -n "$drain" ]; then
  echo "== drain: stop admitting events and starting games; wait up to $drain_min min for games in progress to end"
  if admin_api -X POST -H 'Content-Type: application/json' -d '{"drain":true}' "https://$domain/api/admin/drain" -o /dev/null -w '%{http_code}' | grep -q '^200$'; then
    drained=1
    deadline=$(( $(date +%s) + drain_min * 60 ))
    while :; do
      read -r ev games queued <<< "$(admin_api "https://$domain/api/admin/status" | status_line)"
      [ "$games" = 0 ] && { echo "  no game in progress ($ev live, $queued queued); deploying"; break; }
      [ "$(date +%s)" -ge "$deadline" ] && { echo "  drain timeout with $games game(s) in progress: deploying anyway, they resume after the restart"; break; }
      echo "  $games game(s) in progress ($ev live, $queued queued); waiting"
      sleep 30
    done
  else
    echo "  the running Director has no drain endpoint, or it isn't up: deploying without a drain" >&2
  fi
else
  live="$(curl -sS -m 10 "https://$domain/api/capacity" 2>/dev/null | python3 -I -c "import json,sys; d=json.load(sys.stdin)['live']; print(d['events'], 'live event(s),', d['games'], 'game(s) in progress,', d['queued'], 'queued')" 2>/dev/null || echo 'unknown')"
  echo "== live now: $live (they are checkpointed on SIGTERM and resume after the restart)"
fi

# Promote: the deploy branch is what Coolify deploys. The GitHub App's webhook starts the deployment within seconds.
t_push=$(date +%s)
if [ "$current" != "$sha" ]; then
  echo "== push $short to $branch"
  if [ -n "$rollback" ] && [ -n "$current" ]; then git push -q --force-with-lease="refs/heads/$branch:$current" origin "$sha:refs/heads/$branch"
  else git push -q origin "$sha:refs/heads/$branch"; fi
fi
# The deployment Coolify queued for the commit: <status> (queued, in_progress, finished, failed, cancelled-by-user).
# A first deploy: the instance has no Coolify application yet. Create it now (deploy/coolify-setup.sh: Coolify DB backup,
# secrets, the application) and deploy this commit. Never next to containers that aren't the application's (dev's
# Coolify service from before git deploys: docs/OPERATIONS.md "Moving Dev to Git Deploys").
if [ -z "$id" ]; then
  if [ -n "$(on_host "docker ps -aq --filter label=coolify.projectName=$name" 2>/dev/null)" ]; then
    echo "refusing: containers of $name run on gr3g-server, but there is no Coolify application $name (the old service?)."
    echo "  Move it over first: docs/OPERATIONS.md \"Moving Dev to Git Deploys\". The branch $branch is at $short; nothing else changed."
    return 1
  fi
  echo "== no Coolify application $name yet: creating it (deploy/coolify-setup.sh), then deploying $short"
  SETUP_COMMIT="$sha" INSTANCE="$instance" deploy/coolify-setup.sh --deploy
  id="$(app_id)"
fi
deployment() { [ -n "$id" ] && on_host "docker exec coolify-db psql -U coolify -d coolify -Atc \"select status || ' ' || deployment_uuid from application_deployment_queues where application_id = '$id' and commit = '$sha' and created_at >= to_timestamp($1) at time zone 'UTC' order by id desc limit 1\"" 2>/dev/null || true; }
if [ -n "$redeploy" ]; then
  [ -n "$id" ] || { echo "refusing: no Coolify application $name on gr3g-server (deploy/coolify-setup.sh creates it)"; return 1; }
  echo "== ask Coolify to deploy $branch again"
  on_host "docker exec coolify php artisan tinker --execute='\$a = App\\Models\\Application::find($id); \$r = queue_application_deployment(application: \$a, deployment_uuid: new_public_id(), commit: \"$sha\", no_questions_asked: true, is_api: true); echo \$r[\"status\"], PHP_EOL;'"
fi

# /health reports the build's version: wait until the new build answers, not just any (the old one may still be up).
# Coolify builds the image first (a few minutes), then restarts the stack (about 30 s down).
version_at() { curl -sf -m 5 "https://$1/health" 2>/dev/null | python3 -I -c "import json,sys; print(json.load(sys.stdin).get('version', ''))" 2>/dev/null || true; }
echo "== waiting for Coolify to build and https://$domain/health to answer as $short"
# Done when the Director answers as the commit and Coolify's deployment of it has finished (a redeploy of the same commit
# answers as it all along). Without SSH, or when Coolify's record of it can't be found, the version alone decides.
last=""; st=""
for i in $(seq 1 240); do
  if [ -n "$id" ] && [ $((i % 2)) = 1 ]; then
    st="$(deployment "$(( t_push - 120 ))")"
    if [ -n "$st" ] && [ "$st" != "$last" ]; then echo "  Coolify deployment: $st"; last="$st"; fi
    case "$st" in
      failed*|cancelled*)
        echo "Coolify's deployment of $short ${st%% *} (if the build failed, the stack before it keeps running). Its log: Coolify > $name > Deployments, or"
        echo "  ssh gr3g-server \"docker exec coolify-db psql -U coolify -d coolify -Atc \\\"select logs from application_deployment_queues where deployment_uuid = '${st#* }'\\\"\" | tail -c 4000"
        return 1 ;;
    esac
    if [ -z "$st" ] && [ "$i" = 37 ]; then
      echo "  no deployment of $short queued after 3 min: is auto-deploy on, and did GitHub deliver the webhook? (deploy/deploy.sh --redeploy starts it by hand)"
    fi
  fi
  if [ "$(version_at "$domain")" = "$short" ]; then
    case "$st" in finished*) break ;; esac
    if [ -z "$id" ] || { [ -z "$st" ] && [ "$i" -ge 37 ]; }; then break; fi
  fi
  sleep 5
done
if [ "$(version_at "$domain")" != "$short" ]; then
  echo "The Director is not answering as $short after 20 min (answers: '$(version_at "$domain")'). Check Coolify > $name > Deployments, and"
  echo "  ssh gr3g-server 'docker ps | grep director-; docker logs --tail 50 <director container>'"
  return 1
fi
deployed=1
echo "LIVE: https://$domain  (director $short, $phase_image)"
for _ in $(seq 1 60); do [ "$(version_at "$hub_domain")" = "$short" ] && break; sleep 5; done
if [ "$(version_at "$hub_domain")" = "$short" ]; then
  echo "HUB: https://$hub_domain  (hub $short; data at /data/index.json; admin: ssh gr3g-server docker exec <hub container> npm run hub -- …)"
else
  echo "Hub not answering as $short yet (answers: '$(version_at "$hub_domain")'). Check: ssh gr3g-server 'docker ps | grep hub-; docker logs --tail 50 <hub container>'"
  return 1
fi

# Monitoring: the commit's scripts/ops-check.sh on the host, and the crontab line that runs it every
# 5 minutes and e-mails on failure (docs/OPERATIONS.md "Monitoring"). Idempotent; never touches other cron lines. Not for
# the test instance. A deploy that doesn't go through this script leaves the installed check as it was.
[ "$instance" != test ] || return 0
echo "== ops check: install ~/documents/agent-bench-ops/ops-check.sh and its 5-minute cron on gr3g-server"
if git show "$sha:scripts/ops-check.sh" | on_host 'set -e; d=~/documents/agent-bench-ops; mkdir -p "$d"; cat > "$d/ops-check.sh.new"; chmod 755 "$d/ops-check.sh.new"; mv "$d/ops-check.sh.new" "$d/ops-check.sh"' \
  && on_host bash -s -- "$instance" "$name" "$domain" "$hub_domain" <<'CRON'
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
}
main "$@"
exit $?
