#!/usr/bin/env bash
# Create or update an instance's Coolify application: a Docker Compose application built from
# github.com/grpace/mtgdecktools-agent-bench (deploy/compose.yaml), deployed from the instance's branch
# (deploy/instance.sh: dev -> deploy/dev, prod -> deploy/prod), domains, secrets and settings as Coolify variables.
# Run it once to create an instance, and again after changing what it sets (a secret, a domain, the branch). Deploying
# a commit is deploy/deploy.sh (or a push to the branch, or Coolify's Deploy button): no secrets needed for that.
#
#   INSTANCE=prod deploy/coolify-setup.sh [--deploy]   create or update; --deploy also deploys the branch's head now
#                                                      (SETUP_COMMIT=<sha>: that commit; deploy.sh's first deploy)
#   INSTANCE=test TEST_BRANCH=<branch> deploy/coolify-setup.sh --deploy
#                                                      a throwaway instance from a work branch (auto-deploy on)
#   INSTANCE=test deploy/coolify-setup.sh --delete     remove it: application, containers, volumes, network, project
#   INSTANCE=dev deploy/coolify-setup.sh --recover-secrets
#                                                      copy missing secret files back from the running containers
#
# Secrets: the workstation keeps a copy in the instance's folder (~/.config/mtgdt, ~/.config/mtgdt-prod; mode 600,
# never printed): admin-token, hub-admin-token, hub-db-password, hub-service-token, hub-session-secret, contributor-salt;
# optional github-oauth-client-id / -secret and submit-tokens (one name:token per line). They are generated only when
# the instance doesn't exist yet. When one is missing and it does exist, this refuses: a new contributor-salt re-keys
# every contributor in the public exports, a new hub-db-password locks the Hub out of its database.
# The GitHub OAuth variables are set only from those files; values set in Coolify's UI are kept otherwise.
#
# Over SSH (SSH_HOST), through `php artisan tinker`, so no Coolify API token is needed. Before it changes
# anything it takes a verified dump of Coolify's database. Body is wrapped in main() so bash parses the whole file before running.
main() {
set -euo pipefail
deploy=""; recover=""; delete=""
while [ $# -gt 0 ]; do
  case "$1" in
    --deploy) deploy=1 ;;
    --recover-secrets) recover=1 ;;
    --delete) delete=1 ;;
    -h|--help) sed -n '2,24p' "$0"; return 0 ;;
    *) echo "unknown option: $1 (see --help)"; return 2 ;;
  esac
  shift
done
here="$(cd "$(dirname "$0")/.." && pwd)"
cd "$here"
# shellcheck source=deploy/instance.sh
. deploy/instance.sh
instance="${INSTANCE:-dev}"
instance_config "$instance" || return 2
if [ -n "$delete" ] && [ "$instance" != test ]; then echo "--delete removes only the test instance"; return 2; fi
repository="grpace/mtgdecktools-agent-bench"
echo "== instance $instance: Coolify application $name from $repository@$branch, Director $domain, Hub $hub_domain"

if [ -z "${SSH_HOST:-}" ]; then echo "set SSH_HOST to the SSH alias of the Coolify host"; return 2; fi
ssh_q() { ssh -o BatchMode=yes -o ConnectTimeout=15 "$SSH_HOST" "$@"; }
exists="$(ssh_q "docker exec coolify-db psql -U coolify -d coolify -Atc \"select a.uuid from applications a join environments e on e.id = a.environment_id join projects p on p.id = e.project_id where p.name = '$name' and a.name = '$name' and a.deleted_at is null\"")"
running="$(ssh_q "docker ps -aq --filter label=coolify.projectName=$name | head -1")"

secret_files=(admin-token hub-admin-token hub-db-password hub-service-token hub-session-secret contributor-salt)
# Where each secret runs, for --recover-secrets: the container and its variable.
secret_env() { case "$1" in
  admin-token) echo "director ADMIN_TOKEN" ;; hub-admin-token) echo "hub HUB_ADMIN_TOKEN" ;; hub-db-password) echo "hub-db POSTGRES_PASSWORD" ;;
  hub-service-token) echo "director HUB_SERVICE_TOKEN" ;; hub-session-secret) echo "hub HUB_SESSION_SECRET" ;; contributor-salt) echo "hub MTGDT_CONTRIBUTOR_SALT" ;;
esac; }
if [ -z "$delete" ]; then
  missing=()
  for f in "${secret_files[@]}"; do [ -s "$secrets/$f" ] || missing+=("$f"); done
  if [ "${#missing[@]}" -gt 0 ]; then
    if [ -z "$exists" ] && [ -z "$running" ]; then
      echo "== new instance: generating ${missing[*]} in $secrets (mode 600)"
      mkdir -p "$secrets" && chmod 700 "$secrets"
      for f in "${missing[@]}"; do (umask 077 && openssl rand -hex 24 > "$secrets/$f"); done
      [ "$instance" = test ] || echo "   Back up $secrets now (encrypted): it is the only copy outside Coolify."
    elif [ -n "$recover" ]; then
      echo "== recovering ${missing[*]} from the running containers (not printed)"
      mkdir -p "$secrets" && chmod 700 "$secrets"
      for f in "${missing[@]}"; do
        read -r svc var <<< "$(secret_env "$f")"
        # From the container's environment straight into the file: stdout of ssh, never a terminal or argv.
        (umask 077 && ssh_q "c=\$(docker ps --filter label=coolify.projectName=$name --filter label=com.docker.compose.service=$svc --format '{{.Names}}' | head -1); [ -n \"\$c\" ] && docker exec \"\$c\" printenv $var" > "$secrets/$f.tmp") || true
        if [ -s "$secrets/$f.tmp" ]; then mv "$secrets/$f.tmp" "$secrets/$f"; echo "  recovered $f"; else rm -f "$secrets/$f.tmp"; echo "  could not recover $f (is $svc running?)"; return 1; fi
      done
    else
      echo "refusing: $name exists on $SSH_HOST, but $secrets is missing: ${missing[*]}."
      echo "  A new value would break it (contributor-salt re-keys every contributor; hub-db-password no longer matches the"
      echo "  database). Restore the files from your backup, or: INSTANCE=$instance deploy/coolify-setup.sh --recover-secrets"
      return 1
    fi
  fi
  [ -z "$recover" ] || { echo "secrets complete in $secrets; run again without --recover-secrets to update the application"; return 0; }
fi

# The application's configuration (secrets go to python through the environment, not argv: argv shows up in `ps`).
cfg="$(ADMIN_TOKEN="$(cat "$secrets/admin-token" 2>/dev/null || true)" HUB_ADMIN_TOKEN="$(cat "$secrets/hub-admin-token" 2>/dev/null || true)" \
  HUB_DB_PASSWORD="$(cat "$secrets/hub-db-password" 2>/dev/null || true)" HUB_SERVICE_TOKEN="$(cat "$secrets/hub-service-token" 2>/dev/null || true)" \
  HUB_SESSION_SECRET="$(cat "$secrets/hub-session-secret" 2>/dev/null || true)" MTGDT_CONTRIBUTOR_SALT="$(cat "$secrets/contributor-salt" 2>/dev/null || true)" \
  GITHUB_CLIENT_ID="$(cat "$secrets/github-oauth-client-id" 2>/dev/null || true)" \
  GITHUB_CLIENT_SECRET="$(cat "$secrets/github-oauth-client-secret" 2>/dev/null || true)" \
  SUBMIT_TOKENS="$(if [ -s "$secrets/submit-tokens" ]; then grep -v '^ *$' "$secrets/submit-tokens" | paste -sd, -; fi)" \
  python3 -I - "$name" "$repository" "$branch" "$domain" "$hub_domain" "${deploy:-}" "${delete:-}" "$instance" "${SETUP_COMMIT:-}" <<'PY'
import json, os, sys
name, repository, branch, domain, hub_domain, deploy, delete, instance, commit = sys.argv[1:]
e = os.environ
env = {}
if not delete:
    env = {k: e[k] for k in ('ADMIN_TOKEN', 'HUB_ADMIN_TOKEN', 'HUB_DB_PASSWORD', 'HUB_SERVICE_TOKEN', 'HUB_SESSION_SECRET', 'MTGDT_CONTRIBUTOR_SALT')}
    env.update({'PUBLIC_URL': 'https://' + domain, 'HUB_PUBLIC_URL': 'https://' + hub_domain, 'SUBMIT_TOKENS': e['SUBMIT_TOKENS']})
    # GitHub OAuth App credentials: only from local files; otherwise Coolify keeps the values set in its UI.
    for k in ('GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET'):
        if e.get(k, '').strip():
            env[k] = e[k].strip()
print(json.dumps({
    'name': name, 'description': f'MTG Deck Tools Agent Bench ({instance}): phase-server, card-data, director, hub, hub-db',
    'github_app': 'grpace-github', 'repository': repository, 'branch': branch,
    'domains': {'director': f'https://{domain}:8787', 'hub': f'https://{hub_domain}:8787'},
    'env': env, 'auto_deploy': True, 'deploy': bool(deploy), 'delete': bool(delete), 'commit': commit or None,
}))
PY
)"
staged=""
on_exit() {
  local code=$?
  if [ -n "$staged" ]; then ssh_q 'docker exec -u root coolify rm -rf /tmp/agent-bench-setup; rm -rf ~/.agent-bench-setup' 2>/dev/null || true; fi
  [ "$code" = 0 ] || echo "coolify-setup stopped (exit $code); Coolify's database dump from before it is in the host backup directory (COOLIFY_BACKUP_DIR, or ~/coolify-db-backups)"
}
trap on_exit EXIT
staged=1
ssh_q 'umask 077; rm -rf ~/.agent-bench-setup; mkdir -p ~/.agent-bench-setup'
scp -q deploy/coolify-app.php "$SSH_HOST":.agent-bench-setup/
printf '%s' "$cfg" | ssh_q 'umask 077; cat > ~/.agent-bench-setup/config.json'

echo "== Coolify DB backup (verified), then $([ -n "$delete" ] && echo delete || echo 'create or update') the application"
ssh_q bash -s -- "$name" "${COOLIFY_BACKUP_DIR:-}" <<'REMOTE'
set -euo pipefail
umask 077 # the dump holds every Coolify secret
name="$1"
dir="${2:-$HOME/coolify-db-backups}"
mkdir -p "$dir"
final="$dir/coolify-$(date +%Y%m%d-%H%M%S)-pre-$name.sql.gz"
partial="$final.partial"
trap 'rm -f "$partial"' EXIT
# pipefail catches a failed pg_dump; then the archive must be intact, of a plausible size, and end with pg_dump's marker.
docker exec coolify-db pg_dump -U coolify coolify | gzip > "$partial"
gzip -t "$partial"
size="$(stat -c %s "$partial")"
[ "$size" -ge 1000000 ] || { echo "  Coolify DB backup is only $size bytes: stopping" >&2; exit 1; }
gzip -dc "$partial" | tail -c 2000 | grep -q 'PostgreSQL database dump complete' || { echo "  Coolify DB backup is incomplete: stopping" >&2; exit 1; }
mv "$partial" "$final"
echo "  backup $(basename "$final") ($((size / 1048576)) MB, verified)"
# Keep this instance's last 10.
find "$dir" -maxdepth 1 -type f -regextype posix-extended -regex ".*/coolify-[0-9]{8}-[0-9]{6}-pre-$name\\.sql\\.gz" -printf '%f\n' \
  | sort -r | tail -n +11 | while read -r old; do rm -f -- "$dir/$old"; echo "  pruned old backup $old"; done
docker exec -u root coolify rm -rf /tmp/agent-bench-setup
docker cp ~/.agent-bench-setup coolify:/tmp/agent-bench-setup
docker exec -u root coolify chown -R www-data:www-data /tmp/agent-bench-setup
docker exec coolify php artisan tinker --execute='require "/tmp/agent-bench-setup/coolify-app.php";'
REMOTE
if [ -n "$delete" ]; then
  # Coolify removes its own network; the ones compose.yaml declares (<uuid>_default, _engine, _db) go here, once empty.
  if [ -n "$exists" ]; then
    ssh_q "for n in \$(docker network ls -q --filter name=^${exists}_); do [ \"\$(docker network inspect -f '{{len .Containers}}' \$n)\" = 0 ] && docker network rm \$n >/dev/null; done; true"
  fi
  left="$(ssh_q "docker ps -aq --filter label=coolify.projectName=$name; docker volume ls -q | grep -F '${exists:-no-such-uuid}_'; docker network ls --format '{{.Name}}' | grep -F '${exists:-no-such-uuid}'; true")"
  [ -z "$left" ] || { echo "warning: left behind on $SSH_HOST: $left"; return 1; }
  [ -z "$exists" ] || echo "   no containers, volumes or networks of $exists left"
  return 0
fi
echo "Coolify: application $name, branch $branch. Deploy a commit: INSTANCE=$instance deploy/deploy.sh"
}
main "$@"
exit $?
