#!/usr/bin/env bash
# Run a full event (draft → build → matches) with headless Claude Code seats on your own login.
# Usage: scripts/run-claude-event.sh <set> <model,model,...> [seed] [knowledge: none|primer|primer+stats]
#   e.g. scripts/run-claude-event.sh fra sonnet,haiku
# Seat names are neutral (seat-<hex>), never the model: they reach logs, the live stream and the status. Needs
# phase-server on :9374.
# Every event seats 8 agents: with fewer models this runs a dev event (--dev-bot-fill: bot drafters fill the other
# seats), which is labeled Smoke and never rated. List 8 models (repeats are fine) for a rateable event.
# Body is wrapped in main() so bash parses the whole file before running: editing a script
# while it runs can otherwise make bash execute garbage (this once truncated seat transcripts).
main() {
set -euo pipefail
set_code="${1:-fra}"; models="${2:-sonnet,haiku}"; seed="${3:-$set_code-$(date +%s)}"; knowledge="${4:-none}"
here="$(cd "$(dirname "$0")/.." && pwd)"
cd "$here"
mkdir -p tmp

IFS=',' read -ra M <<< "$models"
names=(); specs=()
for i in "${!M[@]}"; do
  name="seat-$(od -An -N3 -tx1 /dev/urandom | tr -d ' \n')"
  names+=("$name"); specs+=("$name=claude-code/${M[$i]}")
done
agents=$(IFS=','; echo "${specs[*]}")

log="tmp/director-$seed.log"
dev=(); if [ "${#M[@]}" -lt 8 ]; then dev=(--dev-bot-fill); echo "note: ${#M[@]} seat(s) of 8: dev event with bot drafters (Smoke, never rated)"; fi
npm run --silent director -- --set "$set_code" --agents "$agents" --seed "$seed" --knowledge "$knowledge" "${dev[@]}" > "$log" 2>&1 &
director=$!
for _ in $(seq 1 60); do grep -q "^seats written" "$log" 2>/dev/null && break; sleep 1; done
run_dir=$(sed -n 's/^seats written to \(.*\)\/seats.json$/\1/p' "$log")
echo "event dir: $run_dir"

pids=()
for i in "${!M[@]}"; do
  name="${names[$i]}"
  url=$(python3 -I -c "import json,sys; print(json.load(open(sys.argv[1]))[sys.argv[2]])" "$run_dir/seats.json" "$name")
  # Relaunched if the session exits before the seat's EVENT COMPLETE (status from the Director's /api/events/<id>).
  SEAT_STATUS_URL="${url%%/mcp/*}/api/events/$(basename "$run_dir")" SEAT_NAME="$name" \
    scripts/play-claude-seat.sh "$url" "${M[$i]}" "$run_dir/transcript-$name.jsonl" &
  pids+=($!)
  echo "seat $name ($url) → pid $!"
done
wait "${pids[@]}" || true
wait "$director" || true
echo "done: $run_dir/summary.json"
}
main "$@"
exit $?
