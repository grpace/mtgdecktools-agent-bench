#!/usr/bin/env bash
# Run one seat with a headless Claude Code session on your own Claude login (no API key).
# Usage: scripts/play-claude-seat.sh <seat-url> <model> <transcript.jsonl>
# SEAT_PROMPT=<file> overrides the join prompt (default prompts/join.md).
#
# If the session exits before the seat's EVENT COMPLETE, a fresh session is launched (seats resume fine:
# the Director keeps the seat's state), up to SEAT_RELAUNCHES times (default 3). The transcript is always
# appended to, never truncated, so every session of the seat ends up in one file.
#   SEAT_STATUS_URL=<director>/api/events/<id> SEAT_NAME=<seat>: ask the Director whether the seat is done
#   (scripts/play-seats.sh and scripts/run-claude-event.sh set these). Without them, the transcript is
#   searched for the final EVENT COMPLETE message. A seat is done as soon as its own last match ends (the Director
#   answers "EVENT COMPLETE. You're done…" and its status says done), not when the whole event ends.
# The seat runs like `bench play` starts it (scripts/bench/harnesses.ts): an empty working folder, only the mtg
# MCP server (from a config file, so the seat URL isn't in `ps`), no built-in tools, your settings and CLAUDE.md
# files left out. Claude Code's session file is kept: it is the only place it logs the effort level, so after each
# session it is appended to session-<seat>.jsonl next to the transcript (as `bench play` does) and removed.
# Body is wrapped in main() so bash parses the whole file before running: editing a script
# while it runs can otherwise make bash execute garbage (this once truncated seat transcripts).
main() {
set -euo pipefail
url="$1"; model="${2:-sonnet}"; out="${3:-/dev/stdout}"
relaunches="${SEAT_RELAUNCHES:-3}"
here="$(cd "$(dirname "$0")/.." && pwd)"
prompt="$(cat "${SEAT_PROMPT:-$here/prompts/join.md}")"
case "$out" in /*) ;; *) out="$PWD/$out" ;; esac
case "$url" in http://*|https://*) ;; *) echo "not a seat URL: $url" >&2; return 2 ;; esac
case "$url" in *[!A-Za-z0-9./:_@%~[\]-]*) echo "the seat URL has unexpected characters" >&2; return 2 ;; esac
if [ -z "${SEAT_STATUS_URL:-}" ] && [ "$out" = /dev/stdout ]; then relaunches=0; fi # nothing to check completion with
# Private folders (0700): work/ is the seat's empty working directory, config/ holds the MCP config.
seat_root="$(mktemp -d -t mtgdt-seat-XXXXXX)"
trap 'rm -rf "$seat_root"' EXIT
mkdir -m 700 "$seat_root/work" "$seat_root/config"
cfg="$seat_root/config/mcp.json"
(umask 077; printf '{"mcpServers":{"mtg":{"type":"http","url":"%s"}}}\n' "$url" > "$cfg")
restricted=()
if claude --help 2>/dev/null | grep -q -- '--restricted'; then restricted=(--restricted); fi
cd "$seat_root/work"
for attempt in $(seq 0 "$relaunches"); do
  env -u ANTHROPIC_API_KEY CLAUDE_CODE_DISABLE_CLAUDE_MDS=1 CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 \
    claude -p "$prompt" --tools '' ${restricted[@]+"${restricted[@]}"} \
    --model "$model" \
    --mcp-config "$cfg" --strict-mcp-config \
    --allowedTools "mcp__mtg__wait_for_decision mcp__mtg__decide mcp__mtg__get_view mcp__mtg__get_card mcp__mtg__get_game_log mcp__mtg__get_set_primer mcp__mtg__get_set_context mcp__mtg__report_rules_issue" \
    --disallowedTools "Bash Read Write Edit Glob Grep WebFetch WebSearch Task Agent" \
    --output-format stream-json --verbose \
    >> "$out" || true
  save_session
  state="$(seat_state)"
  case "$state" in
    done) break ;;
    gone) echo "seat ${SEAT_NAME:-$url}: the Director doesn't know the event any more; not relaunching" >&2; break ;;
  esac
  if [ "$attempt" -ge "$relaunches" ]; then
    echo "seat ${SEAT_NAME:-$url}: session exited before EVENT COMPLETE; no relaunches left ($relaunches)" >&2
    break
  fi
  echo "seat ${SEAT_NAME:-$url}: session exited before EVENT COMPLETE; relaunching ($((attempt + 1))/$relaunches)" >&2
  sleep 5
done
}

# Append this session's Claude Code session file to session-<seat>.jsonl next to the transcript (effort detection
# reads it: packages/director/src/effort-detect.ts), then remove it with its project folder, which belonged only to
# this seat's temporary working folder. Like scripts/bench/preflight.ts saveEffortRecord.
save_session() {
  [ -f "$out" ] || return 0
  local id seat file dir
  id="$(python3 -I -c '
import json, sys
sid = ""
for line in open(sys.argv[1], encoding="utf-8", errors="replace"):
    try:
        o = json.loads(line)
    except Exception:
        continue
    if isinstance(o, dict) and o.get("type") == "system" and o.get("subtype") == "init" and o.get("session_id"):
        sid = o["session_id"]
print(sid)
' "$out" 2>/dev/null)" || return 0
  case "$id" in ""|*[!A-Za-z0-9-]*) return 0 ;; esac
  seat="${SEAT_NAME:-$(basename "$out" .jsonl)}"
  seat="${seat#transcript-}"
  case "$seat" in ""|*[!A-Za-z0-9._-]*) return 0 ;; esac
  file="$(find "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects" -maxdepth 2 -name "$id.jsonl" -print -quit 2>/dev/null)"
  [ -n "$file" ] || return 0
  (umask 077; cat "$file" >> "$(dirname "$out")/session-$seat.jsonl")
  dir="$(dirname "$file")"
  case "$(basename "$dir")" in *mtgdt-seat-*) rm -rf "$dir" ;; *) rm -f "$file" ;; esac
}

# done | running | gone
seat_state() {
  if [ -n "${SEAT_STATUS_URL:-}" ] && [ -n "${SEAT_NAME:-}" ]; then
    local body
    body="$(curl -sf --max-time 20 "$SEAT_STATUS_URL" 2>/dev/null)" || { echo gone; return; }
    printf '%s' "$body" | python3 -I -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    print("gone"); sys.exit()
mine = [a for a in d.get("agents", []) if a.get("name") == sys.argv[1]]
stage = str(d.get("stage", ""))
if stage == "done" or (mine and mine[0].get("status") == "done"): print("done")
elif stage.startswith("not running") or not mine: print("gone")
else: print("running")
' "$SEAT_NAME"
    return
  fi
  # The final message is a tool result that starts with "EVENT COMPLETE." (status lines only mention it mid-sentence).
  if grep -qE '("|\\n)EVENT COMPLETE\.' "$out" 2>/dev/null; then echo done; else echo running; fi
}

main "$@"
exit $?
