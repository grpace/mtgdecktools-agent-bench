#!/usr/bin/env bash
# Capacity test: N concurrent events (8 scripted agents each: draft, build, 3-round Swiss of best-of-3)
# against a dedicated phase-server + server-mode Director. Scripted agents answer instantly, so
# this is a worst case: LLM seats spend seconds thinking per decision and load the server far less.
# Samples CPU/RSS of the Director and phase-server every 5 s.
# Usage: scripts/load-test.sh <N> [set] [director-port] [phase-port]
# Body is wrapped in main() so bash parses the whole file before running.
main() {
set -euo pipefail
n="${1:?number of concurrent events}"; set_code="${2:-fra}"; dport="${3:-8830}"; pport="${4:-9380}"
here="$(cd "$(dirname "$0")/.." && pwd)"
cd "$here"
out="tmp/load/n$n-$(date +%H%M%S)"; mkdir -p "$out/runs"
image="$(python3 -I -c "import json; l=json.load(open('engine/phase.lock.json')); print(l['image'] + '@' + l['digest'])")"
pname="mtgdt-phase-load"
podman rm -f "$pname" >/dev/null 2>&1 || true
podman run -d --name "$pname" -p "127.0.0.1:$pport:9374" -v mtgdt-phase-load-data:/var/lib/phase-server "$image" >/dev/null
for _ in $(seq 1 60); do curl -sf -m 2 "http://127.0.0.1:$pport/health" >/dev/null && break; sleep 2; done

# Its own Director, so the per-address limit on creating events (10 a minute) is lifted: N tables start at once.
ADMIN_TOKEN=load CREATE_RATE_PER_MIN=1000 npx tsx packages/director/src/main.ts --serve --port "$dport" --phase "ws://127.0.0.1:$pport/ws" --runs "$out/runs" > "$out/director.log" 2>&1 &
director=$!
pids=()
cleanup() { kill "${pids[@]}" "$director" 2>/dev/null || true; podman rm -f "$pname" >/dev/null 2>&1 || true; }
trap cleanup EXIT
for _ in $(seq 1 60); do grep -q "director serving" "$out/director.log" 2>/dev/null && break; sleep 1; done
# npx/tsx wrap the real node process; sample the descendant with the most memory.
sleep 2
dnode=$(for p in $(pgrep -f -- "--serve --port $dport"); do echo "$(ps -o rss= -p "$p" 2>/dev/null | tr -d ' ') $p"; done | sort -n | tail -1 | awk '{print $2}')
dnode="${dnode:-$director}"

start=$(date +%s)
for i in $(seq 1 "$n"); do
  resp=$(curl -s -X POST "http://127.0.0.1:$dport/api/events" -H "Authorization: Bearer load" -d "{\"set\":\"$set_code\",\"agents\":[\"rand-a\",\"rand-b\",\"rand-c\",\"rand-d\",\"rand-e\",\"rand-f\",\"rand-g\",\"rand-h\"],\"seed\":\"load-$i\",\"force\":true}")
  if ! echo "$resp" | python3 -I -c "import json,sys; sys.exit(0 if 'seats' in json.load(sys.stdin) else 1)" 2>/dev/null; then
    echo "event $i was not created: $resp" >&2
    exit 1
  fi
  for seat in rand-a rand-b rand-c rand-d rand-e rand-f rand-g rand-h; do
    url=$(echo "$resp" | python3 -I -c "import json,sys; print(json.load(sys.stdin)['seats'][sys.argv[1]])" "$seat")
    node scripts/mcp-random-agent.mjs "$url" > "$out/agent-$i-$seat.log" 2>&1 &
    pids+=($!)
  done
done

echo "t_s director_cpu director_rss_mb phase_cpu phase_mem live_events" > "$out/samples.txt"
while :; do
  live=$(curl -s "http://127.0.0.1:$dport/api/events" | python3 -I -c "import json,sys; print(sum(1 for e in json.load(sys.stdin) if e['stage']!='done'))" 2>/dev/null || echo "?")
  d=$(ps -o %cpu=,rss= -p "$dnode" 2>/dev/null | awk '{printf "%s %d", $1, $2/1024}')
  p=$(podman stats --no-stream --format "{{.CPUPerc}} {{.MemUsage}}" "$pname" 2>/dev/null | awk '{print $1, $2}')
  echo "$(( $(date +%s) - start )) $d $p $live" >> "$out/samples.txt"
  [ "$live" = "0" ] && break
  [ $(( $(date +%s) - start )) -gt 1800 ] && { echo "timeout" >> "$out/samples.txt"; break; }
  sleep 5
done
total=$(( $(date +%s) - start ))
python3 -I - "$out" "$n" "$total" <<'EOF'
import json, sys, glob, statistics
out, n, total = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
rows = [l.split() for l in open(f"{out}/samples.txt").read().splitlines()[1:] if l and l[0].isdigit()]
dcpu = [float(r[1]) for r in rows if len(r) > 2]
drss = [int(r[2]) for r in rows if len(r) > 2]
pcpu = [float(r[3].rstrip('%')) for r in rows if len(r) > 4 and r[3].endswith('%')]
games = decisions = 0
for f in glob.glob(f"{out}/runs/*/events.jsonl"):
    for line in open(f):
        t = json.loads(line)["type"]
        games += t == "game_over"
        decisions += t == "agent_decision"
print(f"N={n} events: {total}s total, {games} games, {decisions} agent decisions ({decisions/max(total,1):.1f}/s)")
print(f"  director CPU% mean {statistics.mean(dcpu):.0f} max {max(dcpu):.0f}; RSS max {max(drss)} MB")
if pcpu: print(f"  phase-server CPU% mean {statistics.mean(pcpu):.0f} max {max(pcpu):.0f}")
EOF
}
main "$@"
exit $?
