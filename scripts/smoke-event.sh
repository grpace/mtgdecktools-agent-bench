#!/usr/bin/env bash
# Conformance smoke test: a full event (8-seat draft → build → 3-round Swiss of best-of-3 matches with sideboarding)
# with eight scripted random agents, one per seat (every event seats 8 agents). Exits 0 only if the event completes.
# Costs nothing (no LLM).
# Usage: scripts/smoke-event.sh [phase-ws-url] [data-dir] [set] [port] [knowledge]
# Env: SMOKE_AGENTS=<n> scripted agents (default 8; fewer adds --dev-bot-fill: bot drafters fill the other seats,
#        a dev-only engine test; 3 = a pod with a bye each round);
#      AGENT_SIDEBOARD_RATE (default 0.5): how often a scripted seat changes its deck between games;
#      SMOKE_QUIT=<seat>:<n> that agent stops after n decisions, like a crashed harness: the Director must forfeit
#      its decisions (SEAT_TIMEOUT_MS, 15 s here unless set) and the event must still complete;
#      SMOKE_SEED (default smoke-<set>); SMOKE_RUNS (default tmp/smoke-runs).
#      HUB_URL + HUB_SERVICE_TOKEN: the Director hands the event to that Hub; the smoke waits for the final
#      hub_handoff record and prints it.
# Body is wrapped in main() so bash parses the whole file before running: editing a script
# while it runs can otherwise make bash execute garbage (this once truncated seat transcripts).
main() {
set -euo pipefail
phase="${1:-ws://127.0.0.1:9374/ws}"; data="${2:-data}"; set_code="${3:-fra}"; port="${4:-8790}"; knowledge="${5:-none}"
here="$(cd "$(dirname "$0")/.." && pwd)"
cd "$here"
runs="${SMOKE_RUNS:-tmp/smoke-runs}"; mkdir -p "$runs"
log="tmp/smoke-director-$port.log"

n_agents="${SMOKE_AGENTS:-8}"; quit="${SMOKE_QUIT:-}"
names=(); for i in $(seq 1 "$n_agents"); do names+=("rand-$i"); done
agent_list="$(IFS=,; echo "${names[*]}")"
if [ -n "$quit" ]; then export SEAT_TIMEOUT_MS="${SEAT_TIMEOUT_MS:-15000}"; fi
dev=(); if [ "$n_agents" -lt 8 ]; then dev=(--dev-bot-fill); fi
npx tsx packages/director/src/main.ts --phase "$phase" --data "$data" --runs "$runs" --set "$set_code" \
  --agents "$agent_list" --seed "${SMOKE_SEED:-smoke-$set_code}" --port "$port" --knowledge "$knowledge" \
  "${dev[@]}" > "$log" 2>&1 &
director=$!
watcher=""
trap 'kill $director 2>/dev/null || true; kill ${agents[@]:-} ${watcher:-} 2>/dev/null || true' EXIT

for _ in $(seq 1 90); do grep -q "^seats written" "$log" 2>/dev/null && break; kill -0 $director 2>/dev/null || break; sleep 1; done
run_dir=$(sed -n 's/^seats written to \(.*\)\/seats.json$/\1/p' "$log")
if [ -z "$run_dir" ]; then echo "SMOKE FAIL: director did not start"; tail -20 "$log"; exit 1; fi

# Watch the event through the spectator stream while it runs (checked below).
live_url=$(sed -n 's/^spectate: //p' "$log")
sse="tmp/smoke-sse-$port.txt"
if [ -n "$live_url" ]; then
  # Streams are recycled after 8 minutes (SPECTATE limits): reconnect where the last one left off, as EventSource does.
  : > "$sse"
  ( while kill -0 "$director" 2>/dev/null; do
      last=$(grep -a '^id: ' "$sse" 2>/dev/null | tail -1 | cut -c5- || true)
      curl -sN -H 'Accept: text/event-stream' "$live_url?since=${last:-0}" >> "$sse" 2>/dev/null || true
      grep -aq '"type":"event_end"' "$sse" 2>/dev/null && break
      sleep 1
    done ) & watcher=$!
fi

agents=()
for name in "${names[@]}"; do
  url=$(python3 -I -c "import json,sys; print(json.load(open(sys.argv[1]))[sys.argv[2]])" "$run_dir/seats.json" "$name")
  quit_after=0
  if [ "${quit%%:*}" = "$name" ]; then quit_after="${quit##*:}"; fi
  AGENT_QUIT_AFTER="$quit_after" node scripts/mcp-random-agent.mjs "$url" > "tmp/smoke-$name-$port.log" 2>&1 &
  agents+=($!)
done

for _ in $(seq 1 $((n_agents > 2 ? 2400 : 600))); do [ -f "$run_dir/summary.json" ] && break; kill -0 $director 2>/dev/null || break; sleep 1; done
if [ ! -f "$run_dir/summary.json" ]; then echo "SMOKE FAIL: event did not finish (see $run_dir/events.jsonl, $log)"; exit 1; fi

sleep 2
if [ -n "${HUB_URL:-}" ]; then
  # The one-shot Director hands the event off before it exits (a few quick retries).
  for _ in $(seq 1 150); do grep -q '"type":"hub_handoff".*"final":true' "$run_dir/events.jsonl" && break; kill -0 $director 2>/dev/null || break; sleep 1; done
  echo "hub hand-off: $(grep '"type":"hub_handoff"' "$run_dir/events.jsonl" | tail -1)"
fi
python3 -I - "$run_dir" "$sse" "$quit" "tmp/smoke-%s-$port.log" <<'EOF'
import json, sys, collections, os
run = sys.argv[1]
quit_seat = sys.argv[3].split(':')[0] if sys.argv[3] else ''
agent_log = sys.argv[4]
events = [json.loads(l) for l in open(f"{run}/events.jsonl")]
counts = collections.Counter(e["type"] for e in events)
rejected = sum(1 for e in events if e["type"] == "agent_decision" and not e.get("accepted"))
unlabeled = sum(1 for e in events if e["type"] == "decision_offered" and "{\"" in e.get("text", "").split("DECISION")[-1])
print(f"SMOKE OK: {run}")
print(f"  picks={counts['draft_pick']} decks={counts['deck_built']} games={counts['game_over']} decisions={counts['agent_decision']} auto_passes={counts['auto_pass']}")
print(f"  rejected answers={rejected}  options without a readable label={unlabeled}")
played = counts['card_played']
print(f"  cards played={played} unimplemented effects={counts['unimplemented_effect']} rules reports={counts['rules_issue']}")

# Inactivity forfeits: only the seat that quit, and the event still finished.
forfeits = [e for e in events if e["type"] == "forfeit"]
by_stage = collections.Counter(e["stage"] for e in forfeits)
start = events[0]
agents = [s["name"] for s in start["seats"] if s["kind"] == "agent"]
print(f"  forfeits={len(forfeits)} {dict(by_stage)}  boosters={start.get('boosters', {}).get('generator')} director={start['provenance']['director']} prompt={start.get('prompt_version')}")
if quit_seat:
    if not forfeits: print(f"SMOKE FAIL: {quit_seat} quit but nothing was forfeited"); sys.exit(1)
    others = {e["seat"] for e in forfeits} - {quit_seat}
    if others: print(f"SMOKE FAIL: forfeits for seats that kept playing: {others}"); sys.exit(1)
    conceded = [e for e in events if e["type"] == "game_over" and e.get("end_reason") == "concede"]
    if len(conceded) != by_stage.get("game", 0): print(f"SMOKE FAIL: {by_stage.get('game', 0)} game forfeits but {len(conceded)} games ended by concession"); sys.exit(1)
    if any(e.get("winner") == quit_seat for e in conceded): print("SMOKE FAIL: a conceded game was won by the seat that conceded"); sys.exit(1)
    print(f"  games conceded={len(conceded)} (all lost by {quit_seat}); event completed")
elif forfeits:
    print(f"SMOKE FAIL: unexpected forfeits {dict(by_stage)}"); sys.exit(1)

# Best of 3 between games: one play/draw per game (the loser of the previous game chose), the engine started with that
# player, and both seats sideboarded before every game after the first (decks from their pools, at least 40 cards).
if not start.get("sideboarding"): print("SMOKE FAIL: event_start does not declare sideboarding"); sys.exit(1)
pd = {(e["match"], e["game_number"]): e for e in events if e["type"] == "play_draw"}
sb = collections.defaultdict(list)
for e in events:
    if e["type"] == "sideboarded": sb[(e["match"], e["game_number"])].append(e)
overs = [e for e in events if e["type"] == "game_over"]
starts = {e["game"]: e for e in events if e["type"] == "game_start"}
prev_game = {}
for o in overs:
    key = (o["match"], o["game_number"])
    if key not in pd: print(f"SMOKE FAIL: no play_draw for {key}"); sys.exit(1)
    if o.get("on_play") != pd[key]["on_play"]: print(f"SMOKE FAIL: {key}: engine put {o.get('on_play')} on the play, the choice was {pd[key]['on_play']}"); sys.exit(1)
    if o["game_number"] > 1:
        before = prev_game.get((o["match"], o["game_number"] - 1))
        if before and before.get("winner") and pd[key].get("chooser") == before["winner"]: print(f"SMOKE FAIL: {key}: the winner of the previous game chose play/draw"); sys.exit(1)
        if len(sb[key]) != 2: print(f"SMOKE FAIL: {key}: {len(sb[key])} sideboarded records (want 2)"); sys.exit(1)
        sizes = starts.get(o["game"], {}).get("deck_sizes", {})
        for r in sb[key]:
            if len(r["main"]) < 40: print(f"SMOKE FAIL: {key}: {r['seat']} sideboarded to {len(r['main'])} cards"); sys.exit(1)
            if sizes.get(r["seat"]) != len(r["main"]): print(f"SMOKE FAIL: {key}: {r['seat']} played {sizes.get(r['seat'])} cards, sideboarded to {len(r['main'])}"); sys.exit(1)
    elif sb[key]: print(f"SMOKE FAIL: sideboarding before game 1 of {o['match']}"); sys.exit(1)
    prev_game[key] = o
changed = sum(1 for rs in sb.values() for r in rs if not r["kept"])
tries = [s.get("starter", {}).get("games_created", 1) for s in starts.values()]
print(f"  play/draw={len(pd)} (chosen {sum(1 for e in pd.values() if e['by'] == 'agent')}) sideboarding={sum(len(v) for v in sb.values())} (changed {changed}) games created per game={sum(tries)/max(1,len(tries)):.2f}")
if sum(len(v) for v in sb.values()) and not changed and not quit_seat: print("SMOKE FAIL: no scripted seat ever changed its deck"); sys.exit(1)
# What idle seats were told while waiting, and the final message (every seat that played to the end).
told = 0
for name in agents:
    p = agent_log % name
    if name == quit_seat or not os.path.exists(p): continue
    text = open(p).read()
    if "final message:" not in text: print(f"SMOKE FAIL: {name} never saw EVENT COMPLETE"); sys.exit(1)
    # A status only comes back after ~40 s without a decision, so whether a seat sees one depends on timing.
    told += any(k in text for k in ("Still to come", "more match", "no match in round", "played all your matches"))
if len(agents) > 2 and not told: print("SMOKE FAIL: no waiting seat was told what is left for it"); sys.exit(1)
print(open(agent_log % [a for a in agents if a != quit_seat][0]).read().split("waiting statuses seen", 1)[-1].rstrip()[-2000:])

# The spectator stream, watched live: fairness invariants (docs/SPECTATING.md).
import os
sse = sys.argv[2]
if not os.path.exists(sse) or not os.path.getsize(sse):
    print("SMOKE FAIL: no spectator stream captured"); sys.exit(1)
msgs = [m for m in (json.loads(l[5:]) for l in open(sse) if l.startswith('data: ')) if 'type' in m and 'seq' in m]
types = collections.Counter(m['type'] for m in msgs)
done_rounds, done_seats, over, problems, turn = set(), set(), set(), [], {}
for m in msgs:
    t = m['type']
    if t == 'release' and m.get('what') == 'draft_round': done_rounds.add(m['round'])
    if t == 'release' and m.get('what') == 'seat': done_seats.add(m['seat'])
    if t == 'game_over': over.add(m['game'])
    if t == 'draft_pick' and m['pack'] not in done_rounds: problems.append(f"pick released before its round ended: {m['seat']} P{m['pack']}p{m['pick']}")
    if t == 'deck' and m['seat'] not in done_seats: problems.append(f"decklist of {m['seat']} released while it still plays")
    if t == 'sideboarded' and m.get('full') and m['seat'] not in done_seats: problems.append(f"sideboarding of {m['seat']} released while it still plays")
    if t == 'sideboarded' and not m.get('full') and any(k in m for k in ('in', 'out', 'note')): problems.append(f"sideboarding contents of {m['seat']} in the public message")
    # Each turn's first board also emits a `life` message keyed by turn. A reconnecting stream catches up without
    # superseded boards (latest wins), so `life` is what still shows every turn the board reached.
    if t in ('board', 'life'): turn[m['game']] = max(turn.get(m['game'], 0), m['turn'])
    # Notes wait two turns (the board lags the decision log by up to a turn), or the end of the game.
    if t == 'decision' and not m.get('full') and m['game'] not in over and m['turn'] + 2 > turn.get(m['game'], 0) + 1:
        problems.append(f"decision of turn {m['turn']} released at turn {turn.get(m['game'])}")
if not types['event_end']: problems.append('stream never reported the end of the event')
if problems:
    print("SMOKE FAIL: spectator stream:", *problems[:5], sep="\n  "); sys.exit(1)
print(f"  spectator stream: {len(msgs)} messages ({types['board']} boards, {types['draft_pick']} picks, {types['decision']} decisions), fairness checks passed")
EOF
}
main "$@"
exit $?
