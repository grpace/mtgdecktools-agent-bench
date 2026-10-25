#!/usr/bin/env bash
# Keep Playing (continuous play) end to end, with scripted random seats (no LLM, costs nothing):
#   1. alice: `bench setup --private --hosted --keep-playing --max-tables 3` runs three Private Tables back to back
#      (new event each time, `continuous: true`, event_start.table.continuous); the summary says 3 tables, max_tables.
#   2. at the same time alice, bob and carol each Keep Playing in the Lobby (3 + 3 + 2 seats, --max-tables 2): the
#      table fires, everyone's seats rejoin the queue, and a second table fires.
#   3. bob: a Keep Playing Private Table without limits, stopped with `bench stop <loop>` during table 1: the table
#      finishes and nothing new starts (stop_requested).
#   4. carol: the same, stopped with `bench stop <loop> --now`: the event is canceled on the Director at once.
# Needs the phase-server container on 127.0.0.1:9374 (podman start mtgdt-phase) and data/ (draft pools, card data).
# Usage: packages/director/test/continuous-e2e.sh [phase-ws-url] [data-dir] [port]
# Env: CONT_E2E_DIR (default tmp/continuous-e2e), CONT_E2E_LOBBY=0 skips step 2, CONT_E2E_TABLES (default 3) tables
#      in step 1. Every table plays best of 3 with sideboarding; this runs for well over 25 minutes on a busy machine
#      (about 25 when tables were best of 1).
main() {
set -euo pipefail
phase="${1:-ws://127.0.0.1:9374/ws}"; data="${2:-data}"; port="${3:-8980}"; stub_port=$((port + 1))
here="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$here"
dir="${CONT_E2E_DIR:-tmp/continuous-e2e}"; rm -rf "$dir"; mkdir -p "$dir/runs" "$dir/hub"
base="http://127.0.0.1:$port"
pids=()
cleanup() {
  # Stop every loop still running (by the pid in its loop.json), then the servers we started (by pid).
  for f in "$dir"/cli-*/loops/*/loop.json; do
    [ -f "$f" ] || continue
    p="$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1])).get("pid") or "")' "$f")"
    [ -n "$p" ] && kill "$p" 2>/dev/null || true
  done
  for p in "${pids[@]:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null || true; done
}
trap cleanup EXIT
fail() { echo "CONTINUOUS E2E FAIL: $*"; exit 1; }
t0=$(date +%s)

npx tsx packages/director/test/lobby-e2e-stub.ts "$stub_port" "$dir/hub" > "$dir/stub.log" 2>&1 & pids+=($!)
ADMIN_TOKEN=cont-e2e-admin-token-0123456789abcdef HUB_URL="http://127.0.0.1:$stub_port" HUB_SERVICE_TOKEN=lobby-e2e-service-token-0123456789 \
  LOBBY_READY_S=30 LOBBY_ALLOW_SCRIPT=1 PUBLIC_URL="$base" \
  npx tsx packages/director/src/main.ts --serve --phase "$phase" --data "$data" --runs "$dir/runs" --port "$port" > "$dir/director.log" 2>&1 & pids+=($!)
for _ in $(seq 1 90); do curl -sf "$base/health" > /dev/null 2>&1 && break; sleep 1; done
curl -sf "$base/api/capacity" > "$dir/capacity.json" || { tail -20 "$dir/director.log"; fail "the Director did not start"; }
grep -q '"continuous"' "$dir/capacity.json" || fail "GET /api/capacity has no continuous block: $(cat "$dir/capacity.json")"

declare -A tok=([alice]=tok-alice-0123456789abcdef0123 [bob]=tok-bob-0123456789abcdef012345 [carol]=tok-carol-0123456789abcdef0123)
bench() { # who args…
  local who="$1"; shift
  XDG_CONFIG_HOME="$here/$dir/xdg-$who" BENCH_RUNS_DIR="$here/$dir/cli-$who" BENCH_TOKEN="${tok[$who]}" BENCH_CMD="bench" \
    npx tsx scripts/bench/cli.ts "$@"
}
loop_id() { grep -o 'loop-[0-9]\{8\}-[0-9]\{6\}-[0-9a-f]\{4\}' "$1" | head -1; }
summary() { echo "$dir/cli-$1/loops/$2/summary.json"; }
field() { python3 -I -c 'import json,sys; s=json.load(open(sys.argv[1])); print(eval(sys.argv[2], {}, {"s": s}))' "$1" "$2"; }
wait_state() { # file python-expr seconds
  for _ in $(seq 1 "$3"); do
    [ -f "$1" ] && [ "$(field "$1" "$2" 2>/dev/null)" = True ] && return 0
    sleep 2
  done
  return 1
}
common=(--hosted --director "$base" --set fra --knowledge none --yes)

tables="${CONT_E2E_TABLES:-3}"
echo "== 1. a Private Table, Keep Playing, $tables tables (alice)"
bench alice setup --private "${common[@]}" --seat "8x script/random" --keep-playing --max-tables "$tables" > "$dir/alice-private.txt" 2>&1 || { cat "$dir/alice-private.txt"; fail "setup --keep-playing"; }
grep -q "Mode        Keep Playing" "$dir/alice-private.txt" || fail "the confirmation has no Keep Playing mode: $(cat "$dir/alice-private.txt")"
grep -q "Limits      $tables tables" "$dir/alice-private.txt" || fail "the confirmation has no limits line"
grep -q "In all " "$dir/alice-private.txt" || fail "the confirmation has no In all line"
la="$(loop_id "$dir/alice-private.txt")"; [ -n "$la" ] || fail "no loop id in: $(cat "$dir/alice-private.txt")"
echo "loop $la"

lobby_loops=()
if [ "${CONT_E2E_LOBBY:-1}" != 0 ]; then
  echo "== 2. the Lobby, Keep Playing, 2 tables (alice 3, bob 3, carol 2 seats)"
  for pair in alice:3 bob:3 carol:2; do
    who="${pair%%:*}"; n="${pair##*:}"
    bench "$who" setup --lobby "${common[@]}" --seat "${n}x script/random" --keep-playing --max-tables 2 > "$dir/$who-lobby.txt" 2>&1 || { cat "$dir/$who-lobby.txt"; fail "$who: setup --lobby --keep-playing"; }
    grep -q "Wait        " "$dir/$who-lobby.txt" || fail "$who: the lobby confirmation has no Wait line"
    l="$(loop_id "$dir/$who-lobby.txt")"; [ -n "$l" ] || fail "$who: no loop id"
    lobby_loops+=("$who:$l")
  done
fi

wait_state "$(summary alice "$la")" 's["state"] == "stopped"' 900 || { bench alice status "$la"; tail -30 "$dir/cli-alice/loops/$la/loop.log"; fail "alice's private loop did not stop within 30 minutes"; }
bench alice status "$la" | tee "$dir/alice-status.txt"
f="$(summary alice "$la")"
[ "$(field "$f" 's["stop_reason"]')" = max_tables ] || fail "stop_reason: $(field "$f" 's["stop_reason"]')"
[ "$(field "$f" 's["progress"]["tables"]')" = "$tables" ] || fail "tables played: $(field "$f" 's["progress"]["tables"]')"
[ "$(field "$f" 'all(t["status"] == "done" for t in s["tables"])')" = True ] || fail "not every table finished: $(cat "$f")"
[ "$(field "$f" 'len({t["event_id"] for t in s["tables"]})')" = "$tables" ] || fail "$tables tables should be $tables events"
for ev in $(field "$f" '" ".join(t["event_id"] for t in s["tables"])'); do
  head -1 "$dir/runs/$ev/events.jsonl" | grep -q '"continuous":true' || fail "$ev: event_start.table.continuous missing"
  grep -q '"type":"event_end"' "$dir/runs/$ev/events.jsonl" || fail "$ev did not end"
done
echo "OK: $tables Private Tables back to back, stop_reason max_tables ($(( $(date +%s) - t0 )) s)"

for pair in "${lobby_loops[@]:-}"; do
  [ -n "$pair" ] || continue
  who="${pair%%:*}"; l="${pair##*:}"
  wait_state "$(summary "$who" "$l")" 's["state"] == "stopped"' 900 || { bench "$who" status "$l"; tail -40 "$dir/cli-$who/loops/$l/loop.log"; fail "$who's lobby loop did not stop"; }
  f="$(summary "$who" "$l")"
  [ "$(field "$f" 's["stop_reason"]')" = max_tables ] || fail "$who lobby stop_reason: $(field "$f" 's["stop_reason"]') $(cat "$f")"
  [ "$(field "$f" 'sum(1 for t in s["tables"] if t["status"] == "done")')" = 2 ] || fail "$who: 2 lobby tables expected: $(cat "$f")"
  # One queue per set, knowledge and mana: the key has no best-of.
  grep -q "joining the fra-none-manual queue" "$dir/cli-$who/loops/$l/loop.log" || fail "$who: the loop did not join fra-none-manual"
done
[ ${#lobby_loops[@]} -gt 0 ] && echo "OK: the Lobby, every contributor's seats rejoined and played 2 tables ($(( $(date +%s) - t0 )) s)"

echo "== 3. bench stop <loop> (graceful) during table 1 (bob)"
bench bob setup --private "${common[@]}" --seat "8x script/random" --keep-playing > "$dir/bob.txt" 2>&1 || { cat "$dir/bob.txt"; fail "bob setup"; }
grep -q "Limits      None: it keeps going until you stop it" "$dir/bob.txt" || fail "no-limit text missing: $(cat "$dir/bob.txt")"
lb="$(loop_id "$dir/bob.txt")"
wait_state "$(summary bob "$lb")" 's["current"] is not None and s["current"]["event_id"] is not None' 120 || fail "bob's first table did not start"
bench bob status --director "$base" | grep -q "$lb" || fail "bench status does not list the loop"
bench bob stop "$lb" | tee "$dir/bob-stop.txt"
grep -q "stopping after the current table" "$dir/bob-stop.txt" || fail "graceful stop message"
wait_state "$(summary bob "$lb")" 's["state"] == "stopped"' 600 || fail "bob's loop did not stop after its table"
f="$(summary bob "$lb")"
[ "$(field "$f" 's["stop_reason"]')" = stop_requested ] || fail "bob stop_reason: $(field "$f" 's["stop_reason"]')"
[ "$(field "$f" '[t["status"] for t in s["tables"]]')" = "['done']" ] || fail "bob: one finished table expected: $(cat "$f")"
echo "OK: graceful stop finished the current table and started no other"

echo "== 4. bench stop <loop> --now (carol)"
bench carol setup --private "${common[@]}" --seat "8x script/random" --keep-playing > "$dir/carol.txt" 2>&1 || { cat "$dir/carol.txt"; fail "carol setup"; }
lc="$(loop_id "$dir/carol.txt")"
wait_state "$(summary carol "$lc")" 's["current"] is not None and s["current"]["event_id"] is not None' 120 || fail "carol's first table did not start"
ev="$(field "$(summary carol "$lc")" 's["current"]["event_id"]')"
sleep 5
bench carol stop "$lc" --now | tee "$dir/carol-stop.txt"
f="$(summary carol "$lc")"
[ "$(field "$f" 's["stop_reason"]')" = stop_requested_now ] || fail "carol stop_reason: $(cat "$f")"
for _ in $(seq 1 30); do grep -q '"type":"event_abort"' "$dir/runs/$ev/events.jsonl" && break; sleep 1; done
grep -q '"type":"event_abort"' "$dir/runs/$ev/events.jsonl" || fail "$ev was not canceled on the Director"
echo "OK: stop --now canceled event $ev"
echo "CONTINUOUS E2E OK ($(( $(date +%s) - t0 )) s)"
}
main "$@"
exit $?
