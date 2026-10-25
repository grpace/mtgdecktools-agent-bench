#!/usr/bin/env bash
# Hosted play, end to end: "bring your agent, we host the table".
#
# Starts its own phase-server (podman, own volume), a throwaway Postgres (tmpfs) + the Hub, and a server-mode
# Director that checks contributor tokens with the Hub, with room for ONE game at a time. Then:
#   1. API rules: 401/400/413 answers (a submit-only token is a 401: the Hub reports it inactive for play), per-contributor quota (429), FIFO queue (202 + position), owner-only
#      seat URLs and logs, canceling a queued event, drain (503), the per-IP rate limit (429).
#   2. Event A (contributor alice) runs with scripted agents (scripts/mcp-random-agent.mjs); event B (alice) waits
#      in the queue. The Director is stopped with SIGTERM mid-draft, killed with SIGKILL mid-game, and (E2E_VOID=1)
#      stopped for longer than phase-server's 120 s reconnect grace mid-game, so that game is voided and replayed.
#      With E2E_PHASE_RESTART=1 phase-server itself is restarted mid-game too (live socket recovery).
#   3. Both events finish; the agents kept their seat URLs; no game was scored from a void; B started on its own
#      when A freed the table; both were handed to the Hub (pack regeneration verified).
#
#   bash packages/director/test/hosted-e2e.sh           KEEP=1 keeps tmp/hosted-e2e-<pid>/
# Ports: E2E_PG_PORT (5450), E2E_HUB_PORT (8881), E2E_DIRECTOR_PORT (8880), E2E_PHASE_PORT (9391).
# Processes are stopped by PID, containers by name. Body is wrapped in main() so bash parses it all first.
main() {
set -euo pipefail
here="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$here"
pg_port="${E2E_PG_PORT:-5450}"; hub_port="${E2E_HUB_PORT:-8881}"; dir_port="${E2E_DIRECTOR_PORT:-8880}"; phase_port="${E2E_PHASE_PORT:-9391}"
void_test="${E2E_VOID:-1}"; phase_restart="${E2E_PHASE_RESTART:-1}"
work="$here/tmp/hosted-e2e-$$"; mkdir -p "$work/runs" "$work/agents"
pg="mtgdt-e2e-pg-$$"; phase="mtgdt-e2e-phase-$$"; vol="mtgdt-e2e-phase-$$"
hub_pid=""; dir_pid=""; agent_pids=()
D="http://127.0.0.1:$dir_port"; H="http://127.0.0.1:$hub_port"
admin="$(openssl rand -hex 24)"; svc="$(openssl rand -hex 24)"
export DATABASE_URL="postgres://hub:hub@127.0.0.1:$pg_port/hub" HUB_DATA_DIR="$work/hub-data"
cleanup() {
  for p in "${agent_pids[@]}" $dir_pid $hub_pid; do kill "$p" 2>/dev/null || true; done
  podman rm -f "$pg" "$phase" >/dev/null 2>&1 || true
  podman volume rm -f "$vol" >/dev/null 2>&1 || true
  if [ -z "${KEEP:-}" ]; then rm -rf "$work"; else echo "kept $work"; fi
}
trap cleanup EXIT
fail() { echo "E2E FAIL: $*"; [ -n "$dir_pid" ] && tail -20 "$work/director.log"; exit 1; }
expect() { # expect <code> <description> <curl args...>
  local want="$1" what="$2"; shift 2
  local got; got="$(curl -s -o "$work/last.json" -w '%{http_code}' "$@")"
  [ "$got" = "$want" ] || fail "$what: HTTP $got, expected $want ($(head -c 300 "$work/last.json"))"
  echo "  ok $what ($got)"
}
jq_() { python3 -I -c "import json,sys; d=json.load(open(sys.argv[1])); print(eval(sys.argv[2], {'d': d}))" "$@"; }
log_of() { echo "$work/runs/$1/events.jsonl"; }
count() { grep -c "\"type\":\"$2\"" "$(log_of "$1")" 2>/dev/null || true; }
# Games of an event in progress now: started, minus finished, minus voided attempts.
live_games() { echo $(( $(count "$1" game_start) - $(count "$1" game_over) - $(grep -c '"void":true' "$(log_of "$1")" || true) )); }

start_director() {
  ADMIN_TOKEN="$admin" HUB_URL="$H" HUB_SERVICE_TOKEN="$svc" RUNS_DIR="$work/runs" PORT="$dir_port" PUBLIC_URL="$D" \
    PHASE_SERVER_URL="ws://127.0.0.1:$phase_port/ws" MAX_CONCURRENT_GAMES=4 CONTRIB_CONCURRENT=1 CONTRIB_DAILY=2 CREATE_RATE_PER_MIN=600 \
    node --import tsx packages/director/src/main.ts --serve >> "$work/director.log" 2>&1 &
  dir_pid=$!
  for _ in $(seq 1 90); do curl -sf "$D/health" >/dev/null && return 0; kill -0 "$dir_pid" 2>/dev/null || break; sleep 1; done
  fail "director did not start"
}
stop_director() { # stop_director TERM|KILL
  kill "-$1" "$dir_pid"; for _ in $(seq 1 50); do kill -0 "$dir_pid" 2>/dev/null || break; sleep 0.2; done; dir_pid=""
}
wait_for() { # wait_for <seconds> <description> <shell condition>
  local secs="$1" what="$2"; shift 2
  for _ in $(seq 1 "$secs"); do if eval "$*"; then return 0; fi; sleep 1; done
  fail "timed out waiting for: $what"
}
seat_agents() { # seat_agents <response.json> <tag>
  for url in $(python3 -I -c "import json,sys; print(' '.join(json.load(open(sys.argv[1]))['seats'].values()))" "$1"); do
    AGENT_DELAY_MS="${AGENT_DELAY_MS:-120}" AGENT_RETRY_S=400 node scripts/mcp-random-agent.mjs "$url" > "$work/agents/$2-${url: -6}.log" 2>&1 &
    agent_pids+=($!)
  done
}

echo "== phase-server ($phase on 127.0.0.1:$phase_port, volume $vol)"
podman volume create "$vol" >/dev/null
podman run --rm -v "$here/data:/src:ro,z" -v "$vol:/dst" docker.io/library/ubuntu:24.04 \
  sh -c 'cp /src/card-data.json /src/draft-pools.json /dst/ && chown -R 999:999 /dst' >/dev/null
image="$(python3 -I -c "import json; l=json.load(open('engine/phase.lock.json')); print(l['image'] + '@' + l['digest'])")"
podman run -d --name "$phase" -p "127.0.0.1:$phase_port:9374" -v "$vol:/var/lib/phase-server" "$image" >/dev/null
for _ in $(seq 1 60); do podman logs "$phase" 2>&1 | grep -q 'phase-server listening' && break; sleep 1; done

echo "== postgres ($pg on 127.0.0.1:$pg_port, tmpfs) and the hub on :$hub_port"
podman run -d --name "$pg" -e POSTGRES_USER=hub -e POSTGRES_PASSWORD=hub -e POSTGRES_DB=hub \
  -p "127.0.0.1:$pg_port:5432" --tmpfs /var/lib/postgresql/data:rw docker.io/library/postgres:17-alpine >/dev/null
for _ in $(seq 1 60); do podman exec "$pg" pg_isready -q -U hub -d hub 2>/dev/null && break; sleep 1; done
sleep 1
HUB_PORT="$hub_port" HUB_PUBLIC_URL="$H" HUB_BOOTSTRAP=100 HUB_SERVICE_TOKENS="worker-1:$svc" \
  node --import tsx packages/hub/src/main.ts > "$work/hub.log" 2>&1 &
hub_pid=$!
for _ in $(seq 1 90); do curl -sf "$H/health" >/dev/null && break; kill -0 "$hub_pid" 2>/dev/null || break; sleep 1; done
curl -sf "$H/health" >/dev/null || { tail -20 "$work/hub.log"; fail "hub did not start"; }

echo "== contributors and tokens (hub CLI)"
npm run -s hub -- contributor add e2e-alice --trusted >/dev/null
npm run -s hub -- contributor add e2e-bob >/dev/null
npm run -s hub -- contributor quota e2e-alice --concurrent 2 --daily 3 >/dev/null
alice="$(npm run -s hub -- token issue e2e-alice --scope play 2>/dev/null | tail -1)"
bob="$(npm run -s hub -- token issue e2e-bob --scope play 2>/dev/null | tail -1)"
bob_submit="$(npm run -s hub -- token issue e2e-bob --scope submit 2>/dev/null | tail -1)"
[ -n "$alice" ] && [ -n "$bob" ] && [ -n "$bob_submit" ] || fail "could not issue tokens"
# Hosted play and uploads need the current terms accepted (packages/hub/src/terms.ts), as `bench login` records them.
terms_version="$(curl -sf "$H/api/terms" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).version))')"
for t in "$alice" "$bob"; do
  curl -sf -X POST "$H/api/account/terms" -H "Authorization: Bearer $t" -H 'Content-Type: application/json' -d "{\"version\":\"$terms_version\"}" >/dev/null || fail "could not accept the terms"
done

echo "== director on :$dir_port (one game slot)"
start_director

echo "== API rules"
J=(-H 'Content-Type: application/json')
# Every event seats 8 agents (scripted here).
ok_body='{"set":"fra","knowledge":"none","agents":[{"name":"a1","harness":"scripted","model":"random-agent","effort":"default"},{"name":"a2","harness":"scripted","model":"random-agent"},{"name":"a3","harness":"scripted","model":"random-agent"},{"name":"a4","harness":"scripted","model":"random-agent"},{"name":"a5","harness":"scripted","model":"random-agent"},{"name":"a6","harness":"scripted","model":"random-agent"},{"name":"a7","harness":"scripted","model":"random-agent"},{"name":"a8","harness":"scripted","model":"random-agent"}]}'
expect 401 "create without a token" -X POST "$D/api/events" "${J[@]}" -d "$ok_body"
expect 401 "create with an unknown token" -X POST "$D/api/events" "${J[@]}" -H "Authorization: Bearer mtgdt_ply_$(openssl rand -hex 20)" -d "$ok_body"
# 401, not 403: the Hub reports a token without the play scope as inactive (HUB-17), so it isn't a play credential at all.
expect 401 "create with a submit-only token" -X POST "$D/api/events" "${J[@]}" -H "Authorization: Bearer $bob_submit" -d "$ok_body"
grep -q 'without the `play` scope' "$work/last.json" || fail "the 401 should say a token may lack the play scope: $(cat "$work/last.json")"
expect 400 "contributor may not choose a seed" -X POST "$D/api/events" "${J[@]}" -H "Authorization: Bearer $alice" -d '{"set":"fra","seed":"x","agents":[{"name":"a","harness":"h","model":"m"},{"name":"b","harness":"h","model":"m"}]}'
expect 400 "contributor must declare harness and model" -X POST "$D/api/events" "${J[@]}" -H "Authorization: Bearer $alice" -d '{"set":"fra","agents":["a","b"]}'
expect 400 "unknown set" -X POST "$D/api/events" "${J[@]}" -H "Authorization: Bearer $alice" -d '{"set":"zzz","agents":[{"name":"a","harness":"h","model":"m"},{"name":"b","harness":"h","model":"m"}]}'
expect 400 "primer+stats needs human stats for the set" -X POST "$D/api/events" "${J[@]}" -H "Authorization: Bearer $alice" -d '{"set":"10e","knowledge":"primer+stats","agents":[{"name":"a","harness":"h","model":"m"},{"name":"b","harness":"h","model":"m"}]}'
head -c 100000 /dev/zero | tr '\0' 'x' > "$work/big.txt"
expect 413 "oversized body" -X POST "$D/api/events" "${J[@]}" -H "Authorization: Bearer $alice" --data-binary "@$work/big.txt"

expect 201 "event A (alice) starts" -X POST "$D/api/events" "${J[@]}" -H "Authorization: Bearer $alice" -d "$ok_body"
cp "$work/last.json" "$work/A.json"; A="$(jq_ "$work/A.json" "d['id']")"
[ "$(jq_ "$work/A.json" "'seed' in d")" = False ] || fail "a contributor event must not reveal its seed"
expect 202 "event B (alice) is queued" -X POST "$D/api/events" "${J[@]}" -H "Authorization: Bearer $alice" -d "$ok_body"
cp "$work/last.json" "$work/B.json"; B="$(jq_ "$work/B.json" "d['id']")"
[ "$(jq_ "$work/B.json" "d['queue_position']")" = 1 ] || fail "B should be first in the queue"
expect 429 "alice's third event: concurrent quota (2, from the hub)" -X POST "$D/api/events" "${J[@]}" -H "Authorization: Bearer $alice" -d "$ok_body"
expect 202 "event D (bob) is queued second" -X POST "$D/api/events" "${J[@]}" -H "Authorization: Bearer $bob" -d "$ok_body"
Dv="$(jq_ "$work/last.json" "d['id']")"
[ "$(jq_ "$work/last.json" "d['queue_position']")" = 2 ] || fail "D should be second in the queue"
expect 404 "alice cannot see bob's seats" "$D/api/events/$Dv/seats" -H "Authorization: Bearer $alice"
expect 401 "seat URLs need a token" "$D/api/events/$A/seats"
expect 200 "alice sees her seats" "$D/api/events/$A/seats" -H "Authorization: Bearer $alice"
expect 200 "the admin sees every event's seats" "$D/api/events/$Dv/seats" -H "Authorization: Bearer $admin"
expect 404 "alice cannot cancel bob's event" -X DELETE "$D/api/events/$Dv" -H "Authorization: Bearer $alice"
expect 200 "bob cancels his queued event" -X DELETE "$D/api/events/$Dv" -H "Authorization: Bearer $bob"
expect 200 "capacity is public" "$D/api/capacity"
[ "$(jq_ "$work/last.json" "(d['load'], d['queued'])")" = "(4, 1)" ] || fail "capacity should show 4 slots used (an 8-seat event) and 1 queued: $(cat "$work/last.json")"
expect 200 "admin drains" -X POST "$D/api/admin/drain" "${J[@]}" -H "Authorization: Bearer $admin" -d '{"drain":true}'
expect 503 "no new events while draining" -X POST "$D/api/events" "${J[@]}" -H "Authorization: Bearer $bob" -d "$ok_body"
expect 200 "admin ends the drain" -X POST "$D/api/admin/drain" "${J[@]}" -H "Authorization: Bearer $admin" -d '{"drain":false}'
codes="$(for _ in $(seq 1 70); do curl -s -o /dev/null -w '%{http_code} ' "$D/api/sets"; done)"
case "$codes" in *429*) echo "  ok per-IP API rate limit ($(echo "$codes" | tr ' ' '\n' | grep -c 429) of 70 rapid requests got 429)";; *) fail "no 429 from 70 rapid requests";; esac
sleep 25 # let the API bucket refill for the polling below

echo "== event A runs; B waits in the queue (their agents connect now)"
seat_agents "$work/A.json" A
seat_agents "$work/B.json" B

echo "== 1. SIGTERM mid-draft"
wait_for 120 "A to be mid-draft" '[ "$(count "$A" draft_pick)" -ge 90 ]'
[ "$(count "$A" draft_end)" = 0 ] || fail "the draft ended before the restart; raise AGENT_DELAY_MS"
stop_director TERM
picks_before="$(count "$A" draft_pick)"
[ "$(jq_ "$work/runs/$A/state.json" "d['status']")" = running ] || fail "A's checkpoint should say running"
[ "$(jq_ "$work/runs/$B/state.json" "d['status']")" = queued ] || fail "B's checkpoint should say queued"
grep -q 'SIGTERM: checkpointed 1 live event' "$work/director.log" || fail "no graceful-shutdown line"
echo "  stopped at $picks_before picks"
sleep 3
start_director
wait_for 30 "A to resume" '[ "$(count "$A" event_resume)" -ge 1 ]'
expect 200 "B is still queued after the restart" "$D/api/events/$B"
[ "$(jq_ "$work/last.json" "d['stage']")" = queued ] || fail "B should still be queued"
echo "  resumed: $(grep '"type":"event_resume"' "$(log_of "$A")" | tail -1 | cut -c1-160)"

echo "== 2. SIGKILL mid-game"
wait_for 300 "A's first game to be under way" '[ "$(count "$A" game_start)" -ge 1 ] && [ "$(grep -c "\"type\":\"agent_decision\",\"game\"" "$(log_of "$A")")" -ge 6 ]'
stop_director KILL
sleep 2
start_director
wait_for 60 "the game to be re-attached" '[ "$(grep -c "\"after\":\"restart\"" "$(log_of "$A")")" -ge 1 ]'
echo "  reconnected: $(grep '"after":"restart"' "$(log_of "$A")" | tail -1 | cut -c1-160)"

if [ "$phase_restart" = 1 ]; then
  echo "== 3. phase-server restart mid-game (live reconnect)"
  wait_for 300 "a game in progress" '[ "$(live_games "$A")" -ge 1 ]'
  sleep 4
  podman restart "$phase" >/dev/null
  wait_for 150 "the sockets to be re-attached or the game voided" 'grep -q "\"after\":\"socket_closed\"" "$(log_of "$A")" || grep -q "\"void\":true" "$(log_of "$A")"'
  echo "  $(grep -E '"after":"socket_closed"|"void":true' "$(log_of "$A")" | head -1 | cut -c1-170)"
fi

if [ "$void_test" = 1 ]; then
  echo "== 4. Director down longer than phase-server's reconnect grace: void and replay"
  if [ "$(count "$A" event_end)" = 0 ]; then
    wait_for 300 "a game in progress" '[ "$(live_games "$A")" -ge 1 ] || [ "$(count "$A" event_end)" -ge 1 ]'
  fi
  if [ "$(count "$A" event_end)" = 0 ]; then
    stop_director TERM
    echo "  down for 130 s"
    sleep 130
    start_director
    wait_for 60 "the void" 'grep -q "\"void\":true" "$(log_of "$A")"'
    echo "  $(grep '"void":true' "$(log_of "$A")" | tail -1 | cut -c1-200)"
  else
    echo "  (A already finished; skipped)"
  fi
fi

echo "== both events finish"
wait_for 900 "A to finish" '[ -f "$work/runs/$A/summary.json" ]'
wait_for 900 "B to finish" '[ -f "$work/runs/$B/summary.json" ]'
for ev in "$A" "$B"; do wait_for 120 "the hand-off of $ev" 'grep -q "\"type\":\"hub_handoff\".*\"final\":true" "$(log_of "$ev")"'; done
sleep 1

echo "== held hand-offs (a -dirty checkout, scripted agents' latencies) are approved like a maintainer would"
for ev in "$A" "$B"; do
  sub="$(grep '"type":"hub_handoff"' "$(log_of "$ev")" | tail -1 | python3 -I -c "import json,sys; h=json.loads(sys.stdin.read()); print(h.get('submission_id') if h.get('status') == 'held' else '')")"
  if [ -n "$sub" ]; then npm run -s hub -- approve "$sub" --note "hosted e2e" >/dev/null && echo "  approved submission $sub ($ev)"; fi
done

echo "== assertions"
python3 -I - "$work/runs" "$A" "$B" "$work/agents" "$H" <<'PY'
import json, sys, os, glob, urllib.request
runs, A, B, agents, hub = sys.argv[1:]
fail = []
def log(e): return [json.loads(l) for l in open(f"{runs}/{e}/events.jsonl") if l.strip()]
for e in (A, B):
    L = log(e)
    types = [r["type"] for r in L]
    if types.count("event_start") != 1: fail.append(f"{e}: {types.count('event_start')} event_start records")
    if "event_abort" in types or "event_error" in types: fail.append(f"{e}: aborted or errored")
    if "event_end" not in types: fail.append(f"{e}: no event_end")
    # every pick exactly once
    keys = [(r["seat"], r["pack_number"], r["pick_number"]) for r in L if r["type"] == "draft_pick"]
    opened = [r for r in L if r["type"] == "packs_opened"]
    want = sum(len(o["packs"]) * len(o["packs"][0]) for o in opened)
    if len(opened) != 3 or len(keys) != len(set(keys)) or len(keys) != want: fail.append(f"{e}: {len(keys)} picks ({len(set(keys))} distinct), expected {want}")
    # games: a voided attempt never counts; the replay has a result
    voids = [r for r in L if r["type"] == "game_failed" and r.get("void")]
    overs = [r for r in L if r["type"] == "game_over"]
    for v in voids:
        after = [o for o in overs if o["game"] == v["game"] and o["t"] > v["t"]]
        before = [o for o in overs if o["game"] == v["game"] and o["t"] < v["t"]]
        if before: fail.append(f"{e}: {v['game']} had a result before its void")
        if v.get("replay", True) and not after: fail.append(f"{e}: voided {v['game']} was never replayed to a result")
    labels = [o["game"] for o in overs]
    if len(labels) != len(set(labels)): fail.append(f"{e}: a game has two results")
    summ = json.load(open(f"{runs}/{e}/summary.json"))
    gw = {s["name"]: s["gameWins"] for s in summ["standings"]}
    wins = {}
    for o in overs:
        if o.get("winner"): wins[o["winner"]] = wins.get(o["winner"], 0) + 1
    if any(gw.get(k, 0) != v for k, v in wins.items()) or sum(gw.values()) != sum(wins.values()): fail.append(f"{e}: standings {gw} vs game results {wins}")
    h = [r for r in L if r["type"] == "hub_handoff"]
    last = h[-1] if h else {}
    if not last.get("ok") or last.get("status") not in ("ingested", "held"): fail.append(f"{e}: hand-off {last}")
    if last.get("pack_regeneration") != "verified": fail.append(f"{e}: pack regeneration {last.get('pack_regeneration')}")
    st = json.load(open(f"{runs}/{e}/state.json"))
    if st["status"] != "done": fail.append(f"{e}: checkpoint status {st['status']}")
    if st.get("games"): fail.append(f"{e}: checkpoint still lists games {list(st['games'])}")
    start = L[0]
    if start.get("organizer", {}).get("handle") != "e2e-alice" or start.get("seat_meta") != "self-reported": fail.append(f"{e}: event_start organizer {start.get('organizer')} seat_meta {start.get('seat_meta')}")
    print(f"  {e}: {types.count('event_resume')} resume(s), {sum(1 for r in L if r['type']=='game_reconnect')} reconnect(s), {len(voids)} void(s), {len(overs)} game(s) scored, hand-off {last.get('status')} (packs {last.get('pack_regeneration')}, holds {last.get('holds') or []})")
    try:
        with urllib.request.urlopen(f"{hub}/api/events/{e}") as r:
            hv = json.load(r)
        scored = [g for g in hv["games"] if g.get("winner")]
        if len(scored) != len(overs): fail.append(f"{e}: hub has {len(scored)} decided games, the log {len(overs)}")
    except Exception as ex:
        fail.append(f"{e}: hub /api/events: {ex}")
LA, LB = log(A), log(B)
if not [r for r in LA if r["type"] == "event_resume"]: fail.append("A never resumed")
if not [r for r in LA if r["type"] == "game_reconnect" and r.get("after") == "restart"]: fail.append("A: no game re-attached after a restart")
if LB[0]["t"] < max(r["t"] for r in LA if r["type"] == "event_end") - 5000: fail.append("B started before A finished (capacity 4: one 8-seat event)")
# Agents kept their seat URL through every restart and saw EVENT COMPLETE.
for f in glob.glob(f"{agents}/*.log"):
    t = open(f).read()
    if "finished after" not in t: fail.append(f"agent {os.path.basename(f)} did not finish")
if fail:
    print("E2E FAIL:", *fail, sep="\n  "); sys.exit(1)
print(f"  agents: {len(glob.glob(agents + '/*.log'))} finished on their original seat URLs")
PY
echo "E2E OK"
}
main "$@"
exit $?
