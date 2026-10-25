#!/usr/bin/env bash
# Copy event logs from the hosted Director (gr3g-server) into runs/ so they can be analyzed and
# exported locally alongside local runs. Existing local copies are refreshed.
# Usage: scripts/pull-hosted-runs.sh [event-id-substring]
# Body is wrapped in main() so bash parses the whole file before running.
main() {
set -euo pipefail
filter="${1:-}"
here="$(cd "$(dirname "$0")/.." && pwd)"
container="$(ssh gr3g-server "docker ps --format '{{.Names}}' | grep '^director-' | head -1")"
[ -n "$container" ] || { echo "No director container running on gr3g-server."; exit 1; }
ssh gr3g-server "rm -rf ~/.agent-bench-runs && docker cp $container:/app/runs ~/.agent-bench-runs"
rsync -az ${filter:+--include="*$filter*/***" --exclude='*'} gr3g-server:.agent-bench-runs/ "$here/runs/"
ssh gr3g-server 'rm -rf ~/.agent-bench-runs'
echo "pulled into $here/runs:"; ls -1t "$here/runs" | head -10
}
main "$@"
exit $?
