#!/usr/bin/env bash
# Lobby end to end (docs/LOBBY.md): three fake GitHub-signed contributors (a stub Hub) queue 8 scripted random
# seats (3 + 3 + 2) with `bench lobby join`; the table forms, every CLI confirms the ready check, the table fires
# as an 8-seat Swiss event, each CLI starts its own seats with `bench play`, the event completes, the Director
# hands the bundle to the (stub) Hub, and the bundle passes the Hub's integrity checks. Costs nothing (no LLM).
# Context policies (launch=play): alice joins with --fresh-session per-game, carol with per-match, bob with the
# default (scripted seats: none). event_start records each seat's policy, and `bench play` rotates alice's and
# carol's sessions at the boundaries its seats' progress endpoint reports (seat_session events).
# Usage: packages/director/test/lobby-e2e.sh [phase-ws-url] [data-dir] [port]
# Every table plays best of 3 with sideboarding: best of 1 is refused (the join API, a -bo1 queue key, the create-event
# API), and a legacy -bo3 queue key resolves to the new key (fra-none-manual).
# Env: LOBBY_E2E_DIR (default tmp/lobby-e2e), LOBBY_E2E_LAUNCH: play (each
#      CLI starts its seats with `bench play`, the default when the CLI has the scripted `script` harness) or direct
#      (the CLIs run with --no-launch and this script starts the scripted players from the seat URLs they saved).
main() {
set -euo pipefail
phase="${1:-ws://127.0.0.1:9374/ws}"; data="${2:-data}"; port="${3:-8970}"; stub_port=$((port + 1))
here="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$here"
dir="${LOBBY_E2E_DIR:-tmp/lobby-e2e}"; rm -rf "$dir"; mkdir -p "$dir/runs" "$dir/hub"
queue="fra-none-manual"; base="http://127.0.0.1:$port"
launch="${LOBBY_E2E_LAUNCH:-}"
if [ -z "$launch" ]; then if grep -q "randomAgent" scripts/bench/harnesses.ts 2>/dev/null; then launch=play; else launch=direct; fi; fi
no_launch=(); [ "$launch" = direct ] && no_launch=(--no-launch)
echo "seats launched by: $launch"
pids=()
cleanup() { for p in "${pids[@]:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT

npx tsx packages/director/test/lobby-e2e-stub.ts "$stub_port" "$dir/hub" > "$dir/stub.log" 2>&1 & pids+=($!)
# Every seat here is the same scripted setup: lift the diversity cap (LOBBY.md §10), or no table would ever form.
ADMIN_TOKEN=lobby-e2e-admin-token-0123456789abcdef HUB_URL="http://127.0.0.1:$stub_port" HUB_SERVICE_TOKEN=lobby-e2e-service-token-0123456789 \
  LOBBY_READY_S=30 LOBBY_ALLOW_SCRIPT=1 LOBBY_MAX_SAME_SETUP=8 PUBLIC_URL="$base" \
  npx tsx packages/director/src/main.ts --serve --phase "$phase" --data "$data" --runs "$dir/runs" --port "$port" > "$dir/director.log" 2>&1 & pids+=($!)
for _ in $(seq 1 90); do curl -sf "$base/health" > /dev/null 2>&1 && break; sleep 1; done
curl -sf "$base/api/lobby" > /dev/null || { echo "LOBBY E2E FAIL: Director did not start"; tail -20 "$dir/director.log"; exit 1; }

# Refusals: a token without GitHub sign-in, an unlisted model, 4 seats of one contributor, a non-featured set.
code() { curl -s -o "$dir/last.json" -w '%{http_code}' -X POST "$base/api/lobby/join" -H "Authorization: Bearer $1" -H 'Content-Type: application/json' -d "$2"; }
[ "$(code tok-nogithub-0123456789abcdef0 "{\"queue\":\"$queue\",\"seats\":[{\"harness\":\"script\"}]}")" = 403 ] || { echo "LOBBY E2E FAIL: a token without GitHub was not refused"; cat "$dir/last.json"; exit 1; }
[ "$(code tok-alice-0123456789abcdef0123 "{\"queue\":\"$queue\",\"seats\":[{\"harness\":\"claude-code\",\"model\":\"gpt-99-imaginary\"}]}")" = 400 ] || { echo "LOBBY E2E FAIL: an unlisted model was not refused"; cat "$dir/last.json"; exit 1; }
[ "$(code tok-alice-0123456789abcdef0123 "{\"queue\":\"$queue\",\"seats\":[{\"harness\":\"script\"},{\"harness\":\"script\"},{\"harness\":\"script\"},{\"harness\":\"script\"}]}")" = 400 ] || { echo "LOBBY E2E FAIL: 4 seats in one join were not refused"; cat "$dir/last.json"; exit 1; }
[ "$(code tok-alice-0123456789abcdef0123 "{\"queue\":\"$queue\",\"seats\":[{\"harness\":\"script\",\"context_policy\":\"fresh-per-turn\"}]}")" = 400 ] || { echo "LOBBY E2E FAIL: an unknown context policy was not refused"; cat "$dir/last.json"; exit 1; }
# Best of 3 only: best_of 1 and a best-of-1 queue key are refused with one message; so is a best-of-1 event.
bo1="Best of 1 was removed: Agent Bench plays best of 3 with sideboarding."
has_bo1() { python3 -I -c 'import json,sys; sys.exit(0 if json.load(open(sys.argv[1])).get("error") == sys.argv[2] else 1)' "$dir/last.json" "$bo1"; }
[ "$(code tok-alice-0123456789abcdef0123 '{"set":"fra","knowledge":"none","best_of":1,"seats":[{"harness":"script"}]}')" = 400 ] && has_bo1 || { echo "LOBBY E2E FAIL: best_of 1 was not refused"; cat "$dir/last.json"; exit 1; }
[ "$(code tok-alice-0123456789abcdef0123 '{"queue":"fra-none-manual-bo1","seats":[{"harness":"script"}]}')" = 400 ] && has_bo1 || { echo "LOBBY E2E FAIL: a best-of-1 queue key was not refused"; cat "$dir/last.json"; exit 1; }
agents='["a1","a2","a3","a4","a5","a6","a7","a8"]'
[ "$(curl -s -o "$dir/last.json" -w '%{http_code}' -X POST "$base/api/events" -H 'Authorization: Bearer lobby-e2e-admin-token-0123456789abcdef' -H 'Content-Type: application/json' -d "{\"set\":\"fra\",\"agents\":$agents,\"bestOf\":1}")" = 400 ] && has_bo1 || { echo "LOBBY E2E FAIL: the create-event API did not refuse bestOf 1"; cat "$dir/last.json"; exit 1; }
[ "$(curl -s -o "$dir/last.json" -w '%{http_code}' -X POST "$base/api/events" -H 'Authorization: Bearer tok-alice-0123456789abcdef0123' -H 'Content-Type: application/json' -d "{\"set\":\"fra\",\"agents\":$agents,\"bestOf\":1}")" = 400 ] && has_bo1 || { echo "LOBBY E2E FAIL: the create-event API did not refuse a contributor's bestOf 1"; cat "$dir/last.json"; exit 1; }
[ "$(curl -s -o "$dir/last.json" -w '%{http_code}' "$base/api/lobby/queues/fra-none-manual-bo1")" = 404 ] && has_bo1 || { echo "LOBBY E2E FAIL: a best-of-1 invite link did not say why"; cat "$dir/last.json"; exit 1; }
echo "refusals OK (no GitHub: 403; unlisted model: 400; 4 seats: 400; unknown context policy: 400; best of 1: 400 from join, queue key and create-event)"

join() { # handle token seats [fresh-session mode] [queue key]
  local seats=(); for _ in $(seq 1 "$3"); do seats+=(--seat script); done
  local fresh=(); [ -n "${4:-}" ] && [ "$launch" = play ] && fresh=(--fresh-session "$4")
  XDG_CONFIG_HOME="$here/$dir/xdg-$1" BENCH_RUNS_DIR="$here/$dir/cli-$1" BENCH_TOKEN="$2" \
    npx tsx scripts/bench/cli.ts lobby join --director "$base" --queue "${5:-$queue}" "${seats[@]}" "${fresh[@]}" "${no_launch[@]}" > "$dir/cli-$1.log" 2>&1 &
  pids+=($!)
}
join alice tok-alice-0123456789abcdef0123 3 per-game
# bob uses an old invite link's key (-bo3): the same queue as everyone else.
join bob tok-bob-0123456789abcdef012345 3 "" fra-none-manual-bo3
sleep 3
curl -s "$base/api/lobby/queues/$queue-bo3" | python3 -I -c '
import json,sys
q=json.load(sys.stdin)
assert q["key"] == "fra-none-manual", "a legacy -bo3 key resolves to the new key: %s" % q["key"]
assert q["best_of"] == 3 and "bo=" not in q["group"], q["group"]
print("queue %s (asked as %s-bo3): Table %s/8, waiting for %s more" % (q["key"], q["key"], q["seats_filled"], q["seats_needed"]))' || { echo "LOBBY E2E FAIL: the queue view"; exit 1; }
# The public queue never shows a context policy (it is a launch condition, not identity).
if curl -s "$base/api/lobby/queues/$queue" | grep -q 'context_policy\|fresh-per'; then echo "LOBBY E2E FAIL: the public queue shows context policies"; exit 1; fi
join carol tok-carol-0123456789abcdef0123 2 per-match

if [ "$launch" = direct ]; then
  # Each CLI saved its own seats' URLs (event.json in its runs folder); start a scripted player per seat.
  for who in alice bob carol; do
    for _ in $(seq 1 180); do ls "$dir/cli-$who"/*/event.json > /dev/null 2>&1 && break; sleep 1; done
    f="$(ls "$dir/cli-$who"/*/event.json 2>/dev/null | head -1)"
    [ -n "$f" ] || { echo "LOBBY E2E FAIL: $who never got seat URLs"; tail -20 "$dir/cli-$who.log"; exit 1; }
    while read -r url; do
      AGENT_RETRY_S=400 node scripts/mcp-random-agent.mjs "$url" > "$dir/agent-$who-${url: -6}.log" 2>&1 & pids+=($!)
    done < <(python3 -I -c 'import json,sys; [print(u) for u in json.load(open(sys.argv[1]))["seats"].values()]' "$f")
  done
fi
for _ in $(seq 1 1200); do ls "$dir"/hub/handoff-*.tar.gz > /dev/null 2>&1 && break; sleep 1; done
bundle="$(ls "$dir"/hub/handoff-*.tar.gz 2>/dev/null | head -1)"
if [ -z "$bundle" ]; then echo "LOBBY E2E FAIL: no hand-off within 20 minutes"; tail -30 "$dir/director.log"; tail -5 "$dir"/cli-*.log; exit 1; fi
npx tsx packages/director/test/lobby-e2e-check.ts "$bundle" "$base" "$launch"
for f in "$dir"/cli-alice.log "$dir"/cli-bob.log "$dir"/cli-carol.log; do
  grep -q "Confirmed." "$f" || { echo "LOBBY E2E FAIL: $f never confirmed a ready check"; tail -20 "$f"; exit 1; }
  if [ "$launch" = play ]; then grep -q "Starting " "$f" || { echo "LOBBY E2E FAIL: $f never started its seats"; tail -20 "$f"; exit 1; }
  else grep -q "Seat URLs for" "$f" || { echo "LOBBY E2E FAIL: $f never saved its seat URLs"; tail -20 "$f"; exit 1; }; fi
done
if [ "$launch" = play ]; then
  grep -q "ending this session for a fresh one (--fresh-session per-game" "$dir/cli-alice.log" || { echo "LOBBY E2E FAIL: alice's seats never rotated"; tail -20 "$dir/cli-alice.log"; exit 1; }
  grep -q "ending this session for a fresh one (--fresh-session per-match" "$dir/cli-carol.log" || { echo "LOBBY E2E FAIL: carol's seats never rotated"; tail -20 "$dir/cli-carol.log"; exit 1; }
  if grep -q "ending this session for a fresh one" "$dir/cli-bob.log"; then echo "LOBBY E2E FAIL: bob's seats (no policy) rotated"; exit 1; fi
  echo "context policies OK: alice per game ($(grep -c 'ending this session for a fresh one' "$dir/cli-alice.log") rotations), carol per match ($(grep -c 'ending this session for a fresh one' "$dir/cli-carol.log")), bob one session"
fi
echo "every CLI confirmed its ready check and got its seats ($launch)"
}
main "$@"
exit $?
