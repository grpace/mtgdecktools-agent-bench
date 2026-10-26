#!/usr/bin/env bash
# Copy event logs from a hosted Director into runs/ so they can be analyzed and
# exported locally alongside local runs. Existing local copies are refreshed.
# Usage: SSH_HOST=<coolify-host> scripts/pull-hosted-runs.sh [event-id-substring]
# Body is wrapped in main() so bash parses the whole file before running.
main() {
set -euo pipefail
filter="${1:-}"
here="$(cd "$(dirname "$0")/.." && pwd)"
host="${SSH_HOST:?Set SSH_HOST to the SSH alias of the Coolify host}"
container="$(ssh "$host" "docker ps --format '{{.Names}}' | grep '^director-' | head -1")"
[ -n "$container" ] || { echo "No director container running on $host."; exit 1; }
ssh "$host" "rm -rf ~/.agent-bench-runs && docker cp $container:/app/runs ~/.agent-bench-runs"
rsync -az ${filter:+--include="*$filter*/***" --exclude='*'} "$host":.agent-bench-runs/ "$here/runs/"
ssh "$host" 'rm -rf ~/.agent-bench-runs'
echo "pulled into $here/runs:"; ls -1t "$here/runs" | head -10
}
main "$@"
exit $?
