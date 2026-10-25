#!/usr/bin/env bash
# Move to the newest phase-rs build (new sets, card fixes, engine updates) safely.
#
#  1. Pull ghcr.io/phase-rs/phase-server:<tag> (default: latest) and start it beside the current one.
#  2. Read its protocol version and build commit; copy out its card and booster data.
#  3. Rebuild the unsupported-card list for that build.
#  4. Run the smoke event (scripted agents, full draft → build → games) against it.
#  5. Only if that passes: install the new data, rewrite engine/phase.lock.json, and restart the
#     main container (mtgdt-phase) on the new digest. Prints what changed (new sets, protocol bump).
#
# If the smoke test fails, nothing changes; the report says why (usually a protocol change the
# Director needs to learn: see packages/director/src/phase.ts and game.ts).
# Usage: scripts/upgrade-phase.sh [tag] [--dry-run]   (--dry-run always runs the full check, never installs)
# Env (for a second worktree on a machine that is already running the stack): PHASE_CANDIDATE_NAME and
# PHASE_CANDIDATE_PORT (default mtgdt-phase-candidate on :9375), PHASE_CANDIDATE_SMOKE_PORT (the smoke Director,
# default 8791), PHASE_LOCAL_CONTAINER (the container restarted on the new digest, default mtgdt-phase; empty: none).
# Body is wrapped in main() so bash parses the whole file before running: editing a script
# while it runs can otherwise make bash execute garbage (this once truncated seat transcripts).
main() {
set -euo pipefail
tag="${1:-latest}"; dry="${2:-}"
here="$(cd "$(dirname "$0")/.." && pwd)"
cd "$here"
image="ghcr.io/phase-rs/phase-server"
cand_name="${PHASE_CANDIDATE_NAME:-mtgdt-phase-candidate}"; cand_port="${PHASE_CANDIDATE_PORT:-9375}"; cand_vol="$cand_name-data"
smoke_port="${PHASE_CANDIDATE_SMOKE_PORT:-8791}"; local_container="${PHASE_LOCAL_CONTAINER-mtgdt-phase}"
cand_data="tmp/phase-candidate"

cleanup() { podman rm -f "$cand_name" >/dev/null 2>&1 || true; podman volume rm -f "$cand_vol" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "== pulling $image:$tag"
podman pull -q "$image:$tag" >/dev/null
digest=$(podman image inspect "$image:$tag" --format '{{.Digest}}')
current=$(python3 -I -c "import json; print(json.load(open('engine/phase.lock.json'))['digest'])")
if [ "$digest" = "$current" ] && [ "$dry" != "--dry-run" ]; then echo "Already on $digest. Nothing to do."; exit 0; fi

echo "== starting candidate $digest on :$cand_port"
cleanup
podman run -d --name "$cand_name" -p "127.0.0.1:$cand_port:9374" -v "$cand_vol:/var/lib/phase-server" "$image@$digest" >/dev/null
for _ in $(seq 1 120); do curl -sf -m 2 "http://127.0.0.1:$cand_port/health" >/dev/null && break; sleep 2; done
hello=$(node -e '
  const WebSocket = require("ws");
  const ws = new WebSocket(process.argv[1]);
  ws.on("message", (d) => { console.log(String(d)); process.exit(0); });
  setTimeout(() => process.exit(1), 10000);
' "ws://127.0.0.1:$cand_port/ws")
protocol=$(echo "$hello" | python3 -I -c "import json,sys; print(json.load(sys.stdin)['data']['protocol_version'])")
version=$(echo "$hello" | python3 -I -c "import json,sys; print(json.load(sys.stdin)['data']['server_version'])")
commit=$(echo "$hello" | python3 -I -c "import json,sys; print(json.load(sys.stdin)['data']['build_commit'])")
echo "   server $version, build $commit, protocol $protocol"

echo "== copying card + booster data"
rm -rf "$cand_data"; mkdir -p "$cand_data"
for _ in $(seq 1 60); do podman exec "$cand_name" test -f /var/lib/phase-server/draft-pools.json && break; sleep 2; done
podman cp "$cand_name:/var/lib/phase-server/card-data.json" "$cand_data/card-data.json"
podman cp "$cand_name:/var/lib/phase-server/draft-pools.json" "$cand_data/draft-pools.json"
python3 -I scripts/refresh-phase-data.py "$cand_data"

echo "== what changed"
python3 -I - "$cand_data" <<'EOF'
import json, sys
new = json.load(open(f"{sys.argv[1]}/draft-pools.json"))
old = json.load(open("data/draft-pools.json"))
lock = json.load(open("engine/phase.lock.json"))
added = sorted(set(new) - set(old), key=lambda c: new[c].get("release_date") or "")
names = ", ".join("%s (%s)" % (c.upper(), new[c]["name"]) for c in added)
print("   draft sets: %d -> %d%s" % (len(old), len(new), "; new: " + names if added else ""))
cards_new = len(json.load(open(f"{sys.argv[1]}/card-data.json")))
print(f"   cards: {lock.get('cards')} -> {cards_new}")
EOF
old_protocol=$(python3 -I -c "import json; print(json.load(open('engine/phase.lock.json'))['protocol_version'])")
[ "$protocol" != "$old_protocol" ] && echo "   protocol: $old_protocol -> $protocol (the smoke test checks the Director still understands it)"

echo "== smoke event against the candidate"
if ! PHASE_PROTOCOL_VERSION="$protocol" scripts/smoke-event.sh "ws://127.0.0.1:$cand_port/ws" "$cand_data" fra "$smoke_port"; then
  echo "UPGRADE BLOCKED: smoke test failed against $digest. Current pin unchanged."
  exit 1
fi

if [ "$dry" = "--dry-run" ]; then echo "Dry run: smoke passed; not switching."; exit 0; fi

echo "== installing"
cp "$cand_data"/card-data.json "$cand_data"/draft-pools.json "$cand_data"/unsupported-cards.json data/
rm -f data/card-data.slim.json   # the Director rebuilds its slim card index on next start
python3 -I - "$digest" "$version" "$commit" "$protocol" "$cand_data" <<'EOF'
import json, sys
from datetime import date
digest, version, commit, protocol, cand = sys.argv[1:6]
lock = json.load(open("engine/phase.lock.json"))
lock.update({
    "digest": digest, "server_version": version, "build_commit": commit, "protocol_version": int(protocol),
    "cards": len(json.load(open(f"{cand}/card-data.json"))), "draft_sets": len(json.load(open(f"{cand}/draft-pools.json"))),
    "verified_at": date.today().isoformat(), "verified_by": "scripts/upgrade-phase.sh smoke event",
})
json.dump(lock, open("engine/phase.lock.json", "w"), indent=2)
open("engine/phase.lock.json", "a").write("\n")
EOF
# Keep the compose files' default phase-server image on the pinned build.
for f in deploy/compose.yaml deploy/compose.local.yaml; do
  [ -f "$f" ] && sed -i.bak "s|$current|$digest|g" "$f" && rm -f "$f.bak"
done
if [ -n "$local_container" ]; then
  if podman container exists "$local_container"; then
    podman rm -f "$local_container" >/dev/null
  fi
  podman run -d --name "$local_container" -p 127.0.0.1:9374:9374 -v "$local_container-data:/var/lib/phase-server" "$image@$digest" >/dev/null
else
  echo "   PHASE_LOCAL_CONTAINER is empty: no local phase-server restarted (start one on $image@$digest yourself)"
fi
echo "UPGRADED to $version ($commit, protocol $protocol). Commit engine/phase.lock.json and deploy/."
# Card overrides are pinned to the card entries they were written against: a new build can make them stale.
python3 -I scripts/card_overrides.py check --no-network || true
echo "Card overrides: data/ now holds upstream card data. Run 'npm run overrides -- test', retire or re-pin what it"
echo "flags (docs/CARD-OVERRIDES.md), then 'npm run overrides -- install' to run phase-server with the active ones."
echo "Note: running events must be finished before upgrading; the restart drops live games."
}
main "$@"
exit $?
