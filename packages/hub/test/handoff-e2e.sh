#!/usr/bin/env bash
# Director → Hub hand-off, end to end: a throwaway Postgres (tmpfs) on 127.0.0.1:5445, the hub on :8845, and two
# scripted smoke events (scripts/smoke-event.sh, needs phase-server on :9374) in a fresh runs folder:
#   1. HUB_URL points at a closed port (hub port + 1): the hand-off fails after its retries (final hub_handoff error record);
#   2. HUB_URL points at the hub: at start the Director resends event 1, and hands off event 2 when it ends.
# Then: both land (ingested or held) with pack regeneration "verified", event 1's resend is byte-identical to
# its failed attempts, and posting event 2's bundle again answers 409.
#   bash packages/hub/test/handoff-e2e.sh        KEEP=1 keeps tmp/hub-handoff-<pid>/
# Ports: HANDOFF_PG_PORT (5445), HANDOFF_HUB_PORT (8845), HANDOFF_SMOKE_PORT (8874). Stopped by PID/name on exit.
# Body is wrapped in main() so bash parses it all first.
main() {
set -euo pipefail
here="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$here"
pg_port="${HANDOFF_PG_PORT:-5445}"; hub_port="${HANDOFF_HUB_PORT:-8845}"; smoke_port="${HANDOFF_SMOKE_PORT:-8874}"
work="$here/tmp/hub-handoff-$$"; mkdir -p "$work/runs"
pg="mtgdt-hub-handoff-pg-$$"
hub_pid=""
cleanup() {
  if [ -n "$hub_pid" ]; then kill "$hub_pid" 2>/dev/null || true; fi
  podman rm -f "$pg" >/dev/null 2>&1 || true
  if [ -z "${KEEP:-}" ]; then rm -rf "$work"; else echo "kept $work"; fi
}
trap cleanup EXIT

echo "== postgres ($pg on 127.0.0.1:$pg_port, tmpfs)"
podman run -d --name "$pg" -e POSTGRES_USER=hub -e POSTGRES_PASSWORD=hub -e POSTGRES_DB=hub \
  -p "127.0.0.1:$pg_port:5432" --tmpfs /var/lib/postgresql/data:rw docker.io/library/postgres:17-alpine >/dev/null
for _ in $(seq 1 60); do podman exec "$pg" pg_isready -q -U hub -d hub 2>/dev/null && break; sleep 1; done

echo "== hub on 127.0.0.1:$hub_port"
token="$(openssl rand -hex 24)"
DATABASE_URL="postgres://hub:hub@127.0.0.1:$pg_port/hub" HUB_DATA_DIR="$work/hub-data" HUB_PORT="$hub_port" \
  HUB_PUBLIC_URL="http://127.0.0.1:$hub_port" HUB_BOOTSTRAP=100 HUB_SERVICE_TOKENS="worker-1:$token" \
  node --import tsx packages/hub/src/main.ts > "$work/hub.log" 2>&1 &
hub_pid=$!
for _ in $(seq 1 60); do curl -sf "http://127.0.0.1:$hub_port/health" >/dev/null && break; kill -0 "$hub_pid" 2>/dev/null || break; sleep 1; done
curl -sf "http://127.0.0.1:$hub_port/health" >/dev/null || { echo "HANDOFF FAIL: hub did not start"; tail -30 "$work/hub.log"; exit 1; }

echo "== event 1: hub unreachable"
out1="$(SMOKE_RUNS="$work/runs" HUB_URL="http://127.0.0.1:$((hub_port + 1))" HUB_SERVICE_TOKEN="$token" \
  scripts/smoke-event.sh ws://127.0.0.1:9374/ws data fra "$smoke_port" none)"
printf '%s\n' "$out1" | grep -E '^(SMOKE|hub hand-off)'
run1="$(printf '%s\n' "$out1" | sed -n 's/^SMOKE OK: //p')"

echo "== event 2: hub up (event 1 is resent at start)"
out2="$(SMOKE_RUNS="$work/runs" SMOKE_SEED=smoke-handoff-2 HUB_URL="http://127.0.0.1:$hub_port" HUB_SERVICE_TOKEN="$token" \
  scripts/smoke-event.sh ws://127.0.0.1:9374/ws data hob "$smoke_port" none)"
printf '%s\n' "$out2" | grep -E '^(SMOKE|hub hand-off)'
run2="$(printf '%s\n' "$out2" | sed -n 's/^SMOKE OK: //p')"
[ -d "$run1" ] && [ -d "$run2" ] || { echo "HANDOFF FAIL: a smoke event did not finish"; exit 1; }
# Event 1's resend runs in the background of event 2's Director: give it a moment if needed.
for _ in $(seq 1 60); do grep -q '"type":"hub_handoff".*"ok":true' "$run1/events.jsonl" && break; sleep 1; done

echo "== assertions"
python3 -I - "$run1" "$run2" <<'PY'
import json, sys
def handoffs(run):
    return [json.loads(l) for l in open(f"{run}/events.jsonl") if '"type":"hub_handoff"' in l]
r1, r2 = handoffs(sys.argv[1]), handoffs(sys.argv[2])
fail = []
failed1 = [h for h in r1 if not h["ok"]]
ok1 = [h for h in r1 if h["ok"]]
if not failed1 or not failed1[-1]["final"] or failed1[-1]["status"] != "error": fail.append(f"event 1 should have failed attempts ending in a final error: {failed1}")
if not ok1: fail.append("event 1 was not resent at start")
for name, recs in (("event 1", ok1), ("event 2", [h for h in r2 if h["ok"]])):
    if not recs: fail.append(f"{name}: no successful hand-off"); continue
    h = recs[-1]
    if h["status"] not in ("ingested", "held"): fail.append(f"{name}: status {h['status']}")
    if h.get("pack_regeneration") != "verified": fail.append(f"{name}: pack regeneration {h.get('pack_regeneration')}")
    print(f"  {name}: {h['status']} (http {h['http']}, label {h.get('label')}, packs {h.get('pack_regeneration')}, submission {h.get('submission_id')}){' holds: ' + '; '.join(h['holds']) if h.get('holds') else ''}")
shas = {h.get("bundle_sha256") for h in r1 if h.get("bundle_sha256")}
if len(shas) != 1: fail.append(f"event 1 bundles differ between attempts: {shas}")
print(f"  event 1: {len(failed1)} failed attempt(s), then resent at start; one bundle sha256 across attempts: {len(shas) == 1}")
if fail:
    print("HANDOFF FAIL:", *fail, sep="\n  "); sys.exit(1)
PY
# Sending event 2's bundle again (same bytes) is a no-op: 409.
cat > "$work/resend.ts" <<TS
import { readFileSync } from 'node:fs';
import { buildBundle } from '$here/packages/director/src/bundle.ts';
const [dir, url, token] = process.argv.slice(2);
const log = readFileSync(dir + '/events.jsonl', 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const end = log.filter((r) => r.type === 'event_end').pop().t;
const b = buildBundle(dir, { createdBy: 'mtgdt-director ' + log[0].provenance.director, createdAt: end });
const res = await fetch(url + '/api/internal/events', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/gzip' }, body: new Uint8Array(b.gz) });
console.log(res.status);
TS
code="$(npx tsx "$work/resend.ts" "$run2" "http://127.0.0.1:$hub_port" "$token")"
[ "$code" = 409 ] || { echo "HANDOFF FAIL: resending event 2's bundle answered $code, not 409"; exit 1; }
echo "  event 2 resent by hand: 409 (duplicate, no-op)"
curl -sf "http://127.0.0.1:$hub_port/api/events" | python3 -I -c "import json,sys; ev=json.load(sys.stdin); print(f'  hub /api/events: {len(ev)} event(s)')"
echo "HANDOFF OK"
}
main "$@"
exit $?
