#!/usr/bin/env bash
# End-to-end test of the Hub: a throwaway Postgres container (tmpfs, no volume) on 127.0.0.1:5441, the hub
# on 127.0.0.1:8841, a scripted smoke event (scripts/smoke-event.sh, needs phase-server on :9374) bundled
# with `npm run bench -- bundle`, then test/e2e.ts drives submissions, review, export, tampering, takedown.
#
#   bash packages/hub/test/e2e.sh                      # runs a fresh smoke event (about a minute)
#   HUB_E2E_RUN=tmp/smoke-runs/<id> bash packages/hub/test/e2e.sh   # reuse a finished run
#   KEEP=1 …                                           # keep tmp/hub-e2e-<pid>/ (hub log, data dir)
#   HUB_E2E_DATABASE_URL=postgres://… …                # use an existing, empty Postgres (CI service) instead
#
# Ports: HUB_E2E_PG_PORT (5441), HUB_E2E_PORT (8841), HUB_E2E_SMOKE_PORT (8793). Processes and the
# container are stopped by PID/name on exit. Body is wrapped in main() so bash parses it all first.
main() {
set -euo pipefail
here="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$here"
pg_port="${HUB_E2E_PG_PORT:-5441}"; hub_port="${HUB_E2E_PORT:-8841}"; smoke_port="${HUB_E2E_SMOKE_PORT:-8793}"
work="$here/tmp/hub-e2e-$$"; mkdir -p "$work"
pg="mtgdt-hub-e2e-pg-$$"
hub_pid=""
cleanup() {
  if [ -n "$hub_pid" ]; then kill "$hub_pid" 2>/dev/null || true; fi
  if [ -z "${HUB_E2E_DATABASE_URL:-}" ]; then podman rm -f "$pg" >/dev/null 2>&1 || true; fi
  if [ -z "${KEEP:-}" ]; then rm -rf "$work"; else echo "kept $work"; fi
}
trap cleanup EXIT

db_url="${HUB_E2E_DATABASE_URL:-postgres://hub:hub@127.0.0.1:$pg_port/hub}"
if [ -n "${HUB_E2E_DATABASE_URL:-}" ]; then
  echo "== postgres (external: HUB_E2E_DATABASE_URL)"
else
  echo "== postgres ($pg on 127.0.0.1:$pg_port, tmpfs)"
  podman run -d --name "$pg" -e POSTGRES_USER=hub -e POSTGRES_PASSWORD=hub -e POSTGRES_DB=hub \
    -p "127.0.0.1:$pg_port:5432" --tmpfs /var/lib/postgresql/data:rw docker.io/library/postgres:17-alpine >/dev/null
  for _ in $(seq 1 60); do podman exec "$pg" pg_isready -q -U hub -d hub 2>/dev/null && break; sleep 1; done
fi

echo "== smoke event"
run_dir="${HUB_E2E_RUN:-}"
if [ -z "$run_dir" ]; then
  out="$(scripts/smoke-event.sh ws://127.0.0.1:9374/ws data fra "$smoke_port" none)"
  printf '%s\n' "$out"
  run_dir="$(printf '%s\n' "$out" | sed -n 's/^SMOKE OK: //p')"
fi
[ -d "$run_dir" ] || { echo "E2E FAIL: no run folder"; exit 1; }
npm run -s bench -- bundle "$run_dir" --submitter e2e-alice --out "$work/bundle.tar.gz" | tail -3
# A second, different finished run (if there is one the current generator reproduces) for the Director path.
second="$(npx tsx packages/hub/test/find-run.ts "$run_dir" 2>/dev/null || true)"
if [ -n "$second" ]; then
  npm run -s bench -- bundle "$second" --out "$work/bundle2.tar.gz" >/dev/null && export HUB_E2E_BUNDLE2="$work/bundle2.tar.gz"
fi

echo "== hub on 127.0.0.1:$hub_port"
export DATABASE_URL="$db_url" HUB_DATA_DIR="$work/data" HUB_PORT="$hub_port" \
  HUB_PUBLIC_URL="http://127.0.0.1:$hub_port" HUB_BOOTSTRAP=100
HUB_ADMIN_TOKEN="$(openssl rand -hex 24)"; HUB_E2E_SERVICE_TOKEN="$(openssl rand -hex 24)"
export HUB_ADMIN_TOKEN HUB_E2E_SERVICE_TOKEN
# node --import tsx: one process, so the PID we kill is the server itself.
HUB_SERVICE_TOKENS="worker-1:$HUB_E2E_SERVICE_TOKEN" node --import tsx packages/hub/src/main.ts > "$work/hub.log" 2>&1 &
hub_pid=$!
for _ in $(seq 1 60); do curl -sf "http://127.0.0.1:$hub_port/health" >/dev/null && break; kill -0 "$hub_pid" 2>/dev/null || break; sleep 1; done
curl -sf "http://127.0.0.1:$hub_port/health" >/dev/null || { echo "E2E FAIL: hub did not start"; tail -30 "$work/hub.log"; exit 1; }

echo "== assertions"
if HUB_URL="http://127.0.0.1:$hub_port" HUB_E2E_BUNDLE="$work/bundle.tar.gz" npx tsx packages/hub/test/e2e.ts; then
  echo "--- hub log (last lines)"; tail -12 "$work/hub.log"
else
  echo "--- hub log"; tail -40 "$work/hub.log"; exit 1
fi
}
main "$@"
exit $?
