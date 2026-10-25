#!/usr/bin/env bash
# Seat headless Claude Code sessions for an event created with scripts/new-event.sh.
# Usage: scripts/new-event.sh fra sonnet-1,haiku-2 primer | scripts/play-seats.sh - <out-dir>
#        scripts/play-seats.sh event.json <out-dir>
# The model for each seat is the seat name's prefix before "-<n>" (sonnet-1 → sonnet).
# A seat whose session exits before its EVENT COMPLETE is relaunched (SEAT_RELAUNCHES, default 3), checked
# against the Director's GET /api/events/<id>; transcripts are appended to.
# Body is wrapped in main() so bash parses the whole file before running.
main() {
set -euo pipefail
src="${1:--}"; out="${2:-tmp/seats-$(date +%s)}"
here="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$out"
json="$(cat "$src")"
echo "$json" > "$out/event.json"
event_id="$(python3 -I -c "import json,sys; print(json.loads(sys.argv[1]).get('id', ''))" "$json")"
pids=()
while IFS=$'\t' read -r name url; do
  model="${name%-*}"
  status_url=""
  if [ -n "$event_id" ]; then status_url="${url%%/mcp/*}/api/events/$event_id"; fi
  SEAT_STATUS_URL="$status_url" SEAT_NAME="$name" "$here/scripts/play-claude-seat.sh" "$url" "$model" "$out/transcript-$name.jsonl" &
  pids+=($!)
  echo "seat $name ($model) → pid $!"
done < <(python3 -I -c "import json,sys; [print(f'{k}\t{v}') for k,v in json.loads(sys.argv[1])['seats'].items()]" "$json")
wait "${pids[@]}" || true
echo "seats finished: $out"
}
main "$@"
exit $?
