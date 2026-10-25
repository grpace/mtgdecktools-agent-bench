#!/usr/bin/env bash
# Create an event on a running Director (server mode) and print the seat URLs.
# Usage: scripts/new-event.sh <set> <name[=harness/model[/effort]],...> [knowledge] [seed]
#   The harness is the part before the first '/'; the last part is the effort only when it is an effort word
#   (minimal|low|medium|high|xhigh|max|default), so model ids with slashes work: a=opencode/anthropic/claude-sonnet-5-5/high
#   DIRECTOR=https://agent-bench.dev.greg.tech (default) or http://127.0.0.1:8787
# Admin token: $ADMIN_TOKEN or ~/.config/mtgdt/admin-token.
# Seat names are neutral at every table: a name that isn't seat-<6 hex> is replaced (the answer's `renamed` and
# `seats` say how), so names never reveal a model.
# Body is wrapped in main() so bash parses the whole file before running.
main() {
set -euo pipefail
set_code="${1:?set code}"; agents="${2:?agents}"; knowledge="${3:-none}"; seed="${4:-}"
director="${DIRECTOR:-https://agent-bench.dev.greg.tech}"
token="${ADMIN_TOKEN:-$(cat "$HOME/.config/mtgdt/admin-token")}"
body="$(python3 -I -c "
import json, sys
agents = []
for spec in sys.argv[1].split(','):
    name, _, meta = spec.partition('=')
    harness, _, rest = meta.partition('/')
    parts = rest.split('/') if rest else []
    effort = parts.pop().lower() if len(parts) >= 2 and parts[-1].lower() in ('minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'default') else ''
    model = '/'.join(parts)
    agents.append({k: v for k, v in {'name': name, 'harness': harness, 'model': model, 'effort': effort}.items() if v})
body = {'set': sys.argv[2], 'agents': agents, 'knowledge': sys.argv[3]}
if sys.argv[4]: body['seed'] = sys.argv[4]
print(json.dumps(body))
" "$agents" "$set_code" "$knowledge" "$seed")"
# The token goes to curl on stdin (a header file), not argv, so it doesn't show up in `ps`.
printf 'Authorization: Bearer %s\n' "$token" | curl -sS --fail-with-body -X POST "$director/api/events" -H @- -H 'Content-Type: application/json' -d "$body"
echo
}
main "$@"
exit $?
