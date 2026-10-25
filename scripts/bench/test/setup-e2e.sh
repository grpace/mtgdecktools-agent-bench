#!/usr/bin/env bash
# The contributor flow end to end, with the built npm package (scripts/bench/dist, plain node, no tsx):
#   check → login (GitHub device flow against a mocked GitHub) → setup refusals and the confirmation (flags) → the
#   terminal wizard (answers piped) → the agent mode (questions → confirmation → --confirm) with 8 scripted seats (the
#   `script` harness) on a hosted-mode Director → seats started in the background → EVENT COMPLETE → handed to the Hub.
#
# Starts its own phase-server (podman, own volume), a throwaway Postgres (tmpfs), a mock GitHub, the Hub and a
# server-mode Director that checks contributor tokens with the Hub. Nothing outside tmp/setup-e2e-<pid>/ is touched
# (the CLI's config, data and event folders are redirected there).
#
#   bash scripts/bench/test/setup-e2e.sh            KEEP=1 keeps the work folder
# Ports: E2E_DIRECTOR_PORT (8890), E2E_GITHUB_PORT (8891), E2E_HUB_PORT (8892), E2E_PG_PORT (5455), E2E_PHASE_PORT (9395).
# Processes are stopped by PID, containers by name. Body is wrapped in main() so bash parses it all first.
main() {
set -euo pipefail
here="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$here"
dir_port="${E2E_DIRECTOR_PORT:-8890}"; gh_port="${E2E_GITHUB_PORT:-8891}"; hub_port="${E2E_HUB_PORT:-8892}"
pg_port="${E2E_PG_PORT:-5455}"; phase_port="${E2E_PHASE_PORT:-9395}"
work="$here/tmp/setup-e2e-$$"; mkdir -p "$work"
pg="mtgdt-setup-e2e-pg-$$"; phase="mtgdt-setup-e2e-phase-$$"; vol="mtgdt-setup-e2e-phase-$$"
gh_pid=""; hub_pid=""; dir_pid=""; play_pid=""
D="http://127.0.0.1:$dir_port"; H="http://127.0.0.1:$hub_port"
admin="$(openssl rand -hex 24)"; svc="$(openssl rand -hex 24)"
cleanup() {
  for p in $play_pid $dir_pid $hub_pid $gh_pid; do kill "$p" 2>/dev/null || true; done
  podman rm -f "$pg" "$phase" >/dev/null 2>&1 || true
  podman volume rm -f "$vol" >/dev/null 2>&1 || true
  if [ -z "${KEEP:-}" ]; then rm -rf "$work"; else echo "kept $work"; fi
}
trap cleanup EXIT
fail() { echo "E2E FAIL: $*"; exit 1; }
ok() { echo "  ok $*"; }

# The CLI under test: the package build, with its config, data and event folders inside the work folder.
node scripts/bench/build.mjs >/dev/null
# (Only for the CLI: podman reads XDG_* too.)
cfg="$work/config"; runs="$work/events"
bench() {
  (cd "$work" && XDG_CONFIG_HOME="$cfg" XDG_DATA_HOME="$work/data" BENCH_RUNS_DIR="$runs" BENCH_HUB="$H" BENCH_TOKEN="" BENCH_CMD="mtgdt-bench" \
    node "$here/scripts/bench/dist/cli.js" "$@")
}

echo "== phase-server ($phase on 127.0.0.1:$phase_port)"
podman volume create "$vol" >/dev/null
podman run --rm -v "$here/data:/src:ro,z" -v "$vol:/dst" docker.io/library/ubuntu:24.04 \
  sh -c 'cp /src/card-data.json /src/draft-pools.json /dst/ && chown -R 999:999 /dst' >/dev/null
image="$(node -p "const l=require('./engine/phase.lock.json'); l.image + '@' + l.digest")"
podman run -d --name "$phase" -p "127.0.0.1:$phase_port:9374" -v "$vol:/var/lib/phase-server" "$image" >/dev/null
for _ in $(seq 1 60); do podman logs "$phase" 2>&1 | grep -q 'phase-server listening' && break; sleep 1; done

echo "== postgres :$pg_port, mock GitHub :$gh_port, hub :$hub_port"
podman run -d --name "$pg" -e POSTGRES_USER=hub -e POSTGRES_PASSWORD=hub -e POSTGRES_DB=hub \
  -p "127.0.0.1:$pg_port:5432" --tmpfs /var/lib/postgresql/data:rw docker.io/library/postgres:17-alpine >/dev/null
for _ in $(seq 1 60); do podman exec "$pg" pg_isready -q -U hub -d hub 2>/dev/null && break; sleep 1; done
sleep 1
node scripts/bench/test/mock-github.mjs "$gh_port" > "$work/github.log" 2>&1 &
gh_pid=$!
DATABASE_URL="postgres://hub:hub@127.0.0.1:$pg_port/hub" HUB_DATA_DIR="$work/hub-data" HUB_PORT="$hub_port" HUB_PUBLIC_URL="$H" HUB_BOOTSTRAP=100 \
  HUB_SERVICE_TOKENS="worker-1:$svc" GITHUB_CLIENT_ID=cid GITHUB_CLIENT_SECRET=csecret \
  GITHUB_OAUTH_URL="http://127.0.0.1:$gh_port" GITHUB_API_URL="http://127.0.0.1:$gh_port" \
  node --import tsx packages/hub/src/main.ts > "$work/hub.log" 2>&1 &
hub_pid=$!
for _ in $(seq 1 90); do curl -sf "$H/health" >/dev/null && break; kill -0 "$hub_pid" 2>/dev/null || break; sleep 1; done
curl -sf "$H/health" >/dev/null || { tail -20 "$work/hub.log"; fail "hub did not start"; }

echo "== director :$dir_port (server mode, contributor tokens checked with the hub)"
ADMIN_TOKEN="$admin" HUB_URL="$H" HUB_SERVICE_TOKEN="$svc" RUNS_DIR="$work/director-runs" PORT="$dir_port" PUBLIC_URL="$D" \
  PHASE_SERVER_URL="ws://127.0.0.1:$phase_port/ws" CREATE_RATE_PER_MIN=600 \
  node --import tsx packages/director/src/main.ts --serve > "$work/director.log" 2>&1 &
dir_pid=$!
for _ in $(seq 1 90); do curl -sf "$D/health" >/dev/null && break; kill -0 "$dir_pid" 2>/dev/null || break; sleep 1; done
curl -sf "$D/health" >/dev/null || { tail -20 "$work/director.log"; fail "director did not start"; }

echo "== check (not signed in)"
bench check --director "$D" > "$work/check1.txt"
grep -q 'Signed in: no' "$work/check1.txt" || fail "check should say not signed in: $(cat "$work/check1.txt")"
grep -q 'FRA' "$work/check1.txt" || fail "check should list FRA"
grep -q 'Featured sets' "$work/check1.txt" || fail "check should list the featured sets first"
grep -q 'script ' "$work/check1.txt" || fail "check should mention the script harness"
bench check --director "$D" --json | node -e 'const j=JSON.parse(require("fs").readFileSync(0,"utf8")); if (j.signed_in || !j.sets.length || !j.sets[0].recommended || j.table.seats !== 8) process.exit(1)' \
  || fail "check --json"
ok "check lists sets (newest recommended), knowledge levels and harnesses"

echo "== setup refuses to create without a sign-in"
if bench setup --private --hosted --director "$D" --set fra --seat "8x script/random" --knowledge primer --yes > "$work/nologin.txt" 2>&1; then fail "setup --yes without a token should fail"; fi
grep -q 'not signed in' "$work/nologin.txt" || fail "expected 'not signed in': $(cat "$work/nologin.txt")"
ok "not signed in → $(grep -o 'not signed in[^,]*' "$work/nologin.txt" | head -1)"

echo "== login: device flow in two steps (--start prints the code and exits; --wait finishes)"
bench login --start --accept-terms > "$work/login-start.txt"
grep -q 'BNCH-TEST' "$work/login-start.txt" && grep -q 'github.com/login/device' "$work/login-start.txt" || fail "login --start: $(cat "$work/login-start.txt")"
ok "login --start shows $(grep -o 'BNCH-TEST' "$work/login-start.txt") and the link"
bench login --wait > "$work/login-wait.txt"
grep -q 'Signed in as setup-tester' "$work/login-wait.txt" || fail "login --wait: $(cat "$work/login-wait.txt")"
grep -q 'Terms accepted' "$work/login-wait.txt" || fail "login --wait should record the terms accepted at --start: $(cat "$work/login-wait.txt")"
[ "$(stat -c %a "$cfg/mtgdt-bench/token")" = 600 ] || fail "the token file should be 0600"
ok "login --wait: $(grep 'Signed in' "$work/login-wait.txt" | cut -c1-60)…"
bench login | grep -q 'Already signed in' || fail "a second login should say already signed in"
bench check --director "$D" | grep -q 'Signed in: yes, as setup-tester' || fail "check should show the handle"
ok "login again → already signed in; check shows the handle"

echo "== setup with flags: validation and the confirmation (no --yes)"
if bench setup --private --hosted --director "$D" --set fra --seat "2x script/random" > "$work/short.txt" 2>&1; then fail "a private table with 2 seats should be refused"; fi
grep -q 'a private table has 8 seats' "$work/short.txt" || fail "expected the 8-seat message: $(cat "$work/short.txt")"
if bench setup --private --hosted --director "$D" --set zzz --seat "8x script/random" > "$work/badset.txt" 2>&1; then fail "an unknown set should be refused"; fi
grep -q "ZZZ isn't available" "$work/badset.txt" || fail "expected the set message: $(cat "$work/badset.txt")"
if bench new --director "$D" --hosted --set fra --seat a=script/random --seat b=script/random > "$work/new2.txt" 2>&1; then fail "new with 2 seats should be refused"; fi
grep -q 'a table has 8 agent seats' "$work/new2.txt" || fail "expected the 8-seat message from new: $(cat "$work/new2.txt")"
if bench setup --private --hosted --director "$D" --set fra --seat "8x Codex / GPT-6 Astra" --knowledge primer > "$work/noeffort.txt" 2>&1; then fail "a seat without an effort should be asked for one"; fi
grep -q 'Effort for the 8 seats of Codex CLI / GPT-6 Astra' "$work/noeffort.txt" && grep -q 'recommended: high' "$work/noeffort.txt" || fail "expected the effort question: $(cat "$work/noeffort.txt")"
bench setup --private --hosted --director "$D" --set fra --seat "8x script/random" --knowledge context > "$work/plan.txt"
grep -q 'Please confirm your event' "$work/plan.txt" && grep -q 'Nothing created' "$work/plan.txt" && grep -q 'starts on this machine' "$work/plan.txt" && grep -q 'Knowledge   Set Context' "$work/plan.txt" || fail "confirmation: $(cat "$work/plan.txt")"
grep -q '8-player booster draft, 40-card decks, 3 Swiss rounds, best of 3 with sideboarding' "$work/plan.txt" || fail "the confirmation's format line: $(cat "$work/plan.txt")"
grep -q -- '--best-of' "$work/plan.txt" && fail "the plan must not offer a best-of: $(grep -- '--best-of' "$work/plan.txt")"
# Best of 3 only: a flag or an answer for best of 1 is refused with one message; --best-of 3 still works.
bo1='Best of 1 was removed: Agent Bench plays best of 3 with sideboarding.'
if bench setup --private --hosted --director "$D" --set fra --seat "8x script/random" --knowledge primer --best-of 1 > "$work/bo1.txt" 2>&1; then fail "--best-of 1 should be refused"; fi
grep -qF -- "--best-of 1: $bo1" "$work/bo1.txt" || fail "expected the best-of-1 message: $(cat "$work/bo1.txt")"
if bench setup --agent --director "$D" --answers '{"table":"private","play_mode":"once","where":"hosted","set":"fra","seats":["8x script/random"],"knowledge":"primer","best_of":1}' > "$work/bo1-agent.txt" 2>&1; then fail "best_of 1 in --answers should be refused"; fi
grep -qF "$bo1" "$work/bo1-agent.txt" || fail "expected the best-of-1 message (agent): $(cat "$work/bo1-agent.txt")"
if bench new --director "$D" --hosted --set fra --seat "8x script/random" --best-of 1 > "$work/bo1-new.txt" 2>&1; then fail "new --best-of 1 should be refused"; fi
grep -qF "$bo1" "$work/bo1-new.txt" || fail "expected the best-of-1 message (new): $(cat "$work/bo1-new.txt")"
bench setup --private --hosted --director "$D" --set fra --seat "8x script/random" --knowledge context --best-of 3 > "$work/bo3.txt"
grep -q 'best of 3 with sideboarding' "$work/bo3.txt" || fail "--best-of 3 should still work: $(cat "$work/bo3.txt")"
[ -z "$(ls -A "$runs" 2>/dev/null)" ] || fail "nothing may be created before confirming"
ok "2 seats, an unknown set and new with 2 seats refused; best of 1 refused (setup flag, agent answers, new); a missing effort is asked with a recommendation; the confirmation creates nothing"

echo "== the terminal wizard (answers piped)"
# Make Your Table Count: 6 seats of one setup get the mirror warning and suggested mixes; an empty answer keeps the seats.
printf '1\n1\n1\n\n6x script/random\n2x Codex / GPT-6 Astro / medium\n6x script/random\n2x Codex / GPT-6 Astra / medium\n\n1\n' | bench setup --interactive --director "$D" --dry-run > "$work/wizard.txt"
grep -q 'Did you mean gpt-6-astra' "$work/wizard.txt" || fail "a mistyped model should get a suggestion: $(tail -30 "$work/wizard.txt")"
grep -q 'Rated games this table can produce' "$work/wizard.txt" && grep -q 'Press Enter to keep your seats' "$work/wizard.txt" || fail "the wizard should show Make Your Table Count for a mirror-heavy table: $(tail -40 "$work/wizard.txt")"
grep -q 'GPT-6 Astra · Codex CLI · Medium' "$work/wizard.txt" && grep -q 'declared by you' "$work/wizard.txt" && grep -q 'Knowledge   No Set Context' "$work/wizard.txt" || fail "wizard: $(tail -30 "$work/wizard.txt")"
ok "private, hosted, featured set, 6 scripted + 2 Codex (after a typo and its suggestion; Make Your Table Count shown, seats kept), No Set Context, Codex effort declared"

echo "== the agent mode (what prompts/setup.md drives): questions, confirmation, --confirm"
jget() { node -e 'const j=JSON.parse(require("fs").readFileSync(0,"utf8")); const v=eval(process.argv[1]); console.log(typeof v === "string" ? v : JSON.stringify(v))' "$1"; }
bench setup --agent --director "$D" > "$work/agent1.json"
[ "$(jget 'j.step' < "$work/agent1.json")" = questions ] || fail "agent: first step $(cat "$work/agent1.json")"
[ "$(jget 'j.questions.map((q) => q.id).join(",")' < "$work/agent1.json")" = "table,play_mode,where,set,seats" ] || fail "agent: first questions $(jget 'j.questions.map((q) => q.id)' < "$work/agent1.json")"
answers='{"table":"private","play_mode":"once","where":"hosted","set":"fra","seats":["8x script/random"],"knowledge":"primer"}'
bench setup --agent --director "$D" --answers "$answers" > "$work/agent2.json"
[ "$(jget 'j.step' < "$work/agent2.json")" = confirm ] || fail "agent: expected the confirmation: $(cat "$work/agent2.json")"
jget 'j.confirmation.text' < "$work/agent2.json" | sed 's/^/    /'
next="$(jget 'j.next' < "$work/agent2.json")"
case "$next" in *"--director $D"*"--confirm "*) ;; *) fail "agent: next should carry --director and --confirm: $next";; esac
[ -z "$(ls -A "$runs" 2>/dev/null)" ] || fail "nothing may be created before --confirm"
ok "questions (table, play_mode, where, set, seats), then the confirmation; next = $(echo "$next" | cut -c1-60)…"
bench setup --agent --director "$D" --answers '{"table":"private","play_mode":"continuous","where":"hosted","set":"fra","seats":["8x script/random"],"knowledge":"primer"}' > "$work/agent-keep.json"
[ "$(jget 'j.questions.map((q) => q.id).join(",")' < "$work/agent-keep.json")" = "limits,rotate_sets" ] || fail "Keep Playing should ask limits and rotate_sets: $(cat "$work/agent-keep.json")"
bench setup --agent --director "$D" --answers '{"table":"private","play_mode":"continuous","limits":"2 tables, $40","rotate_sets":"same","where":"hosted","set":"fra","seats":["8x script/random"],"knowledge":"primer"}' > "$work/agent-keep2.json"
jget 'j.confirmation.text' < "$work/agent-keep2.json" | grep -q 'Mode        Keep Playing' || fail "Keep Playing confirmation: $(cat "$work/agent-keep2.json")"
jget 'j.confirmation.limits' < "$work/agent-keep2.json" | grep -q '2 tables or \$40' || fail "Keep Playing limits: $(jget 'j.confirmation.limits' < "$work/agent-keep2.json")"
ok "Keep Playing asks for limits and the set rotation, and its confirmation shows the mode and limits"
code="$(jget 'j.confirmation.code' < "$work/agent2.json")"
if bench setup --agent --director "$D" --answers '{"table":"private","play_mode":"once","where":"hosted","set":"fra","seats":["8x script/random"],"knowledge":"none"}' --confirm "$code" > "$work/stale.txt" 2>&1; then fail "--confirm with changed answers must be refused"; fi
grep -q 'answers changed' "$work/stale.txt" || fail "expected the changed-answers message: $(cat "$work/stale.txt")"
ok "--confirm with changed answers is refused"

echo "== confirmed: the event starts (8 scripted seats, private hosted table, best of 3 with sideboarding)"
eval "${next/mtgdt-bench/bench}" > "$work/agent3.json"
[ "$(jget 'j.step' < "$work/agent3.json")" = started ] || fail "agent: expected started: $(cat "$work/agent3.json")"
ev="$(jget 'j.event' < "$work/agent3.json")"
[ -n "$ev" ] || fail "no event id"
jget 'j.watch' < "$work/agent3.json" | grep -q "/agent-bench/events/$ev/live" || fail "no Watch link"
[ "$(jget 'j.started_here.length' < "$work/agent3.json")" = 8 ] || fail "all 8 scripted seats should start here"
play_pid="$(cat "$runs/$ev/play.pid")"
kill -0 "$play_pid" 2>/dev/null || fail "the background play process isn't running"
[ "$(stat -c %a "$runs/$ev/event.json")" = 600 ] || fail "event.json should be 0600"
[ -f "$runs/$ev/confirmation.json" ] || fail "the confirmed details should be saved with the event"
ok "event $ev started; seats in the background (pid $play_pid); confirmation saved"

echo "== waiting for EVENT COMPLETE (scripted players; a few minutes)"
for i in $(seq 1 360); do
  st="$(bench status "$ev" 2>/dev/null | head -1 || true)"
  case "$st" in *": done"*) break;; *aborted*) fail "event aborted: $st";; esac
  [ $((i % 12)) = 0 ] && echo "  $(date +%T) $st; $(grep -c '"type":"game_over"' "$work/director-runs/$ev/events.jsonl" 2>/dev/null || true) games over"
  sleep 5
done
case "$st" in *": done"*) ;; *) fail "the event did not finish: $st";; esac
for _ in $(seq 1 60); do kill -0 "$play_pid" 2>/dev/null || break; sleep 1; done
kill -0 "$play_pid" 2>/dev/null && fail "the background play process should exit once every seat is done"
play_pid=""
bench status "$ev" | sed 's/^/    /'
n_done="$(grep -l 'EVENT COMPLETE\|finished after' "$runs/$ev"/transcript-*.jsonl | wc -l)"
[ "$n_done" = 8 ] || fail "$n_done of 8 seats finished"
# A loopback Director isn't the hosted one, so play ends with the pull/bundle hint instead of the hosted "Done." line.
grep -q '^Done\.\|^Next: ' "$runs/$ev/play.log" || fail "play.log should end with Done or Next: $(tail -5 "$runs/$ev/play.log")"
ok "all 8 seats saw EVENT COMPLETE; the background launcher exited"

echo "== handed to the hub"
for _ in $(seq 1 60); do grep -q '"type":"hub_handoff".*"final":true' "$work/director-runs/$ev/events.jsonl" && break; sleep 2; done
handoff="$(grep '"type":"hub_handoff"' "$work/director-runs/$ev/events.jsonl" | tail -1)"
echo "$handoff" | cut -c1-220
echo "$handoff" | grep -q '"ok":true' || fail "the Hub should accept the hand-off: $handoff"
head -1 "$work/director-runs/$ev/events.jsonl" | grep -q '"handle":"setup-tester"' || fail "the event should belong to setup-tester"
ok "the event's organizer is the signed-in contributor"
echo "E2E OK"
}
main "$@"
exit $?
