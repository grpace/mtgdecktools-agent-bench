#!/usr/bin/env bash
# Context-aware draft evaluation (analysis/draft_eval). Examples:
#   scripts/draft-eval.sh score runs/<event-id>        -> runs/<event-id>/draft-eval.json
#   scripts/draft-eval.sh batch                         -> every run in runs/ + analysis/results/agent-draft-scores.json
#   scripts/draft-eval.sh archetypes FRA                -> sets/FRA/17lands-archetypes.json
#   scripts/draft-eval.sh train FRA                     -> analysis/models/FRA.json + analysis/results/validation-FRA.json
# Needs uv (https://docs.astral.sh/uv/). See analysis/README.md.
# Body is wrapped in main() so bash parses the whole file before running.
main() {
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
args=()
for a in "$@"; do
  # make relative paths work from the repo root
  if [ -e "$a" ]; then args+=("$(cd "$(dirname "$a")" && pwd)/$(basename "$a")"); else args+=("$a"); fi
done
cd "$here/analysis"
exec uv run python -m draft_eval "${args[@]}"
}
main "$@"
exit $?
