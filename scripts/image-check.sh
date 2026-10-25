#!/usr/bin/env bash
# Build the Director/Hub image from the real build context and boot it as the hosted stack runs (CI-1).
#   1. `docker build .`: the .dockerignore allow-list applies, exactly as Coolify builds it (deploy/compose.yaml `build:`).
#   2. Every repository file the code reads at run time is in the image (scripts/image-files.mjs derives the list).
#   3. phase-server's environment allow-list in deploy/compose.yaml still carries the pinned image's own defaults.
#   4. deploy/compose.yaml + deploy/compose.ci.yaml up (fresh volumes, users, capabilities as on Coolify): the Director
#      answers /health with this build's version and has exported the report data; the Hub has migrated its
#      Postgres, answers /health with the version and its first export wrote files; both run as uid 999;
#      phase-server's process got none of the secrets in its container environment. On a network shared by every
#      container (Coolify's project network, H-8) phase-server and Postgres don't listen; pg_hba admits only the db subnet.
#   5. Card overrides on the hosted stack (docs/CARD-OVERRIDES.md): the card-data stage put the pinned upstream data and
#      the overrides into the fresh phase-data volume; phase-server runs that exact file with --no-data-download; the
#      Director's provenance record (cardDataProvenance, as event_start writes it) names it and its overrides; and every
#      override's scripted games (scripts/card-scenario.mjs) come out fixed on the stack's own phase-server.
#   6. The lobby's featured queues are the committed deploy/lobby.json (LOBBY_CONFIG_APPLY=always).
# Usage: scripts/image-check.sh [tag]   (default ci-<short sha>). CONTAINER_ENGINE=podman works too (needs a
# compose provider). Logs land in tmp/image-check/; the stack and its volumes are removed at the end.
# Body is wrapped in main() so bash parses the whole file before running.
main() {
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
cd "$here"
engine="${CONTAINER_ENGINE:-docker}"
tag="${1:-ci-$(git rev-parse --short HEAD)}"
image="mtgdt-director:$tag"
out=tmp/image-check
mkdir -p "$out"
fail() { echo "IMAGE CHECK FAIL: $*" >&2; exit 1; }

echo "== build $image from the repository's build context"
start=$(date +%s)
build=("$engine" build --build-arg "DIRECTOR_TAG=$tag" -t "$image")
if [ "$engine" = podman ]; then build+=(--format docker); fi
"${build[@]}" . > "$out/build.log" 2>&1 || { tail -40 "$out/build.log"; fail "docker build"; }
echo "   built in $(( $(date +%s) - start )) s"

echo "== the image holds every repository file the code reads at run time"
node scripts/image-files.mjs > "$out/files.txt"
"$engine" run --rm -i --network none --user 999:999 --entrypoint sh "$image" -c '
  n=0; bad=0
  while read -r f; do
    n=$((n + 1))
    if [ -d "$f" ]; then [ -n "$(ls -A "$f")" ] || { echo "   empty in the image: $f"; bad=1; }
    elif [ ! -s "$f" ]; then echo "   missing from the image: $f"; bad=1; fi
  done
  echo "   $n paths present"; exit $bad' < "$out/files.txt" || fail "files missing from the image: add them to the .dockerignore allow-list"

echo "== phase-server's env allow-list (deploy/compose.yaml) keeps the pinned image's own defaults"
phase_image="$(node -p "const l=require('./engine/phase.lock.json'); l.image + '@' + l.digest")"
"$engine" pull -q "$phase_image" > /dev/null
while IFS= read -r kv; do
  [ -n "$kv" ] || continue
  # RUST_LOG may be set to another level (deploy/compose.yaml lowers it to warn); every other default as the image has it.
  case "$kv" in RUST_LOG=*) want="\"RUST_LOG=" ;; *) want="\"$kv\"" ;; esac
  grep -qF "$want" deploy/compose.yaml || fail "the pinned phase-server sets $kv; add it to phase-server's \`env -i\` entrypoint in deploy/compose.yaml"
done < <("$engine" image inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$phase_image")

echo "== boot the hosted stack (deploy/compose.yaml) from $image"
export DIRECTOR_TAG="$tag" PHASE_IMAGE="$phase_image" GITHUB_CLIENT_ID='' GITHUB_CLIENT_SECRET=''
export ADMIN_TOKEN HUB_ADMIN_TOKEN HUB_DB_PASSWORD HUB_SERVICE_TOKEN HUB_SESSION_SECRET
ADMIN_TOKEN="$(openssl rand -hex 24)"; HUB_ADMIN_TOKEN="$(openssl rand -hex 24)"; HUB_DB_PASSWORD="$(openssl rand -hex 16)"
HUB_SERVICE_TOKEN="$(openssl rand -hex 24)"; HUB_SESSION_SECRET="$(openssl rand -hex 24)"
dport="${IMAGE_CHECK_DIRECTOR_PORT:-18787}"; hport="${IMAGE_CHECK_HUB_PORT:-18788}"
compose=("$engine" compose -p "mtgdt-image-check-$$" -f deploy/compose.yaml -f deploy/compose.ci.yaml)
cleanup() {
  local code=$?
  if [ "$code" != 0 ]; then
    for s in card-data phase-server director hub hub-db; do "${compose[@]}" logs --no-color --tail 80 "$s" > "$out/$s.log" 2>&1 || true; done
    echo "logs: $out/{card-data,director,hub,phase-server,hub-db}.log"; tail -30 "$out/director.log" "$out/hub.log" 2>/dev/null || true
  fi
  "${compose[@]}" down -v --timeout 10 > /dev/null 2>&1 || true
}
trap cleanup EXIT
start=$(date +%s)
"${compose[@]}" up -d --quiet-pull 2>&1 | tail -5

health() { curl -sf -m 5 "$1/health" 2>/dev/null || true; }
field() { python3 -I -c "import json,sys
try: d=json.load(sys.stdin)
except Exception: sys.exit(0)
for k in sys.argv[1].split('.'): d = d.get(k) if isinstance(d, dict) else None
print('' if d is None else d)" "$1"; }

d="http://127.0.0.1:$dport"
for _ in $(seq 1 120); do [ "$(health "$d" | field version)" = "$tag" ] && break; sleep 2; done
[ "$(health "$d" | field version)" = "$tag" ] || fail "the Director did not answer /health with version $tag: $(health "$d")"
echo "   Director healthy as $tag after $(( $(date +%s) - start )) s"

h="http://127.0.0.1:$hport"
for _ in $(seq 1 90); do [ -n "$(health "$h" | field last_export.files)" ] && break; sleep 2; done
st="$(health "$h")"
[ "$(printf '%s' "$st" | field version)" = "$tag" ] || fail "the Hub did not answer /health with version $tag: $st"
files="$(printf '%s' "$st" | field last_export.files)"
[ -n "$files" ] && [ "$files" -gt 0 ] || fail "the Hub's first export wrote no files: $st"
echo "   Hub healthy as $tag; first export wrote $files files"
curl -sf -m 10 "$h/data/index.json" -o /dev/null || fail "the Hub does not serve /data/index.json"

# The Director's report export (packages/site build-data, spawned at start) reads highlights/ and docs/METHODOLOGY.md.
for f in index.json highlights.json methodology.md; do
  for _ in $(seq 1 60); do curl -sf -m 5 "$d/data/$f" -o /dev/null && break; sleep 2; done
  curl -sf -m 5 "$d/data/$f" -o /dev/null || fail "the Director's export did not produce /data/$f"
done
echo "   Director export served (index.json, highlights.json, methodology.md)"

for s in director hub; do
  u="$("${compose[@]}" exec -T "$s" id -u)"
  [ "$u" = 999 ] || fail "$s runs as uid $u, not 999"
done
penv="$("${compose[@]}" exec -T --user 999 phase-server sh -c 'tr "\0" "\n" < /proc/1/environ')"
if printf '%s\n' "$penv" | grep -q '^ADMIN_TOKEN='; then fail "phase-server's process sees ADMIN_TOKEN (env -i missing?)"; fi
printf '%s\n' "$penv" | grep -q '^PHASE_DATA_DIR=' || fail "phase-server's process environment looks wrong"
echo "   Director and Hub run as uid 999; phase-server's process environment holds no secrets"

# Containment (SEC-11): read-only root file systems, and the networks keep the Hub away from the engine and the Director
# away from the database. H-8: compose.ci.yaml puts every container on a shared `coolify` network as well, as Coolify
# does; phase-server and Postgres listen only on their private networks, so they stay out of reach on it.
for s in director hub; do
  if "${compose[@]}" exec -T "$s" sh -c 'echo x > /app/.write-test' 2>/dev/null; then fail "$s can write its root file system (read_only missing?)"; fi
done
reach() { # reach <service> <host> <port>: REACHABLE or UNREACHABLE <reason>
  "${compose[@]}" exec -T "$1" node -e "const s=require('net').connect($3,'$2');s.setTimeout(3000);
s.on('connect',()=>{console.log('REACHABLE');process.exit(0)});s.on('error',(e)=>{console.log('UNREACHABLE',e.code);process.exit(0)});
s.on('timeout',()=>{console.log('UNREACHABLE timeout');process.exit(0)})" 2>&1 | tail -1
}
# (A compose provider may prefix the output with terminal codes: match, don't compare.)
reachable() { case "$(reach "$@")" in *UNREACHABLE*) return 1;; *REACHABLE*) return 0;; *) return 1;; esac; }
ok=""; for _ in $(seq 1 30); do if reachable director phase-server-engine 9374; then ok=1; break; fi; sleep 2; done
[ -n "$ok" ] || fail "the Director can't reach phase-server"
if reachable hub phase-server 9374; then fail "the Hub can reach phase-server (networks)"; fi
if reachable card-data phase-server 9374; then fail "card-data can reach phase-server over the shared network (H-8: --bind)"; fi
if reachable director hub-db 5432; then fail "the Director can reach the Hub's Postgres (networks)"; fi
if reachable card-data hub-db 5432; then fail "card-data can reach Postgres over the shared network (H-8: listen_addresses)"; fi
hba="$("${compose[@]}" exec -T hub-db psql -U hub -d hub -Atc "SELECT current_setting('hba_file') || ' ' || string_agg(type || ':' || coalesce(address, '-') || ':' || auth_method, ' ' ORDER BY line_number) FROM pg_hba_file_rules" | tr -d '\r')"
case "$hba" in *"/tmp/pg_hba.conf local:-:trust host:"*":scram-sha-256 host:0.0.0.0:reject host::::reject") ;; *) fail "hub-db's pg_hba.conf is not the H-8 one: $hba" ;; esac
echo "   root file systems read-only; the Hub can't reach phase-server, the Director can't reach Postgres; on the shared"
echo "   network neither listens; pg_hba admits the hub from the db subnet only ($hba)"

echo "== card overrides on the hosted stack"
staged="$("${compose[@]}" exec -T card-data cat /tmp/card-data-staged | tr -d '\r\n')"
loaded="$("${compose[@]}" exec -T phase-server sha256sum /var/lib/phase-server/card-data.json | cut -d' ' -f1)"
[ -n "$staged" ] && [ "$staged" = "$loaded" ] || fail "phase-server's card-data.json ($loaded) is not the staged file ($staged)"
pcmd="$("${compose[@]}" exec -T phase-server sh -c 'tr "\0" " " < /proc/1/cmdline')"
case "$pcmd" in *--no-data-download*) ;; *) fail "phase-server runs without --no-data-download: $pcmd" ;; esac
prov="$("${compose[@]}" exec -T director node --import tsx -e "import { cardDataProvenance } from './packages/director/src/cards.ts'; console.log(JSON.stringify(cardDataProvenance('/phase-data/card-data.json')))" | tail -1)"
want_overrides="$(node -e 'const fs=require("fs");console.log(fs.readdirSync("engine/overrides").filter((f)=>f.endsWith(".json")).filter((f)=>["active","submitted-upstream"].includes(JSON.parse(fs.readFileSync("engine/overrides/"+f,"utf8")).status)).map((f)=>f.slice(0,-5)).sort().join(","))')"
printf '%s' "$prov" | node -e '
  const p = JSON.parse(require("fs").readFileSync(0, "utf8"));
  const [loaded, upstream, want] = process.argv.slice(1);
  const bad = [p.sha256 !== loaded && `sha256 ${p.sha256}`, p.upstream_sha256 !== upstream && `upstream ${p.upstream_sha256}`, p.sidecar && "stale sidecar",
    (p.overrides ?? []).slice().sort().join(",") !== want && `overrides ${JSON.stringify(p.overrides)}`].filter(Boolean);
  if (bad.length) { console.error(bad.join("; ")); process.exit(1); }' "$loaded" "$(node -p "require('./deps/manifest.json').phase_rs.data.card_data.sha256")" "$want_overrides" \
  || fail "the Director's card-data record is wrong: $prov"
echo "   card data ${loaded:0:12} staged from upstream with overrides [$want_overrides]; phase-server runs it with --no-data-download; the Director records it"
# Cards the active overrides make supported are off the Director's unsupported-card list (CARD-OVERRIDES "Supported Cards
# and Packs"). The list is a file in its cache when it could fetch phase-rs's coverage report; offline it is in memory.
want_supported="$(node -e 'const fs=require("fs");console.log(JSON.stringify(fs.readdirSync("engine/overrides").filter((f)=>f.endsWith(".json")).map((f)=>JSON.parse(fs.readFileSync("engine/overrides/"+f,"utf8"))).filter((o)=>["active","submitted-upstream"].includes(o.status)&&o.marks_supported).map((o)=>o.card)))')"
listed="$("${compose[@]}" exec -T director sh -c 'cat /app/cache/unsupported-cards.json 2>/dev/null' || true)"
if [ -n "$listed" ]; then
  printf '%s' "$listed" | node -e '
    const l = JSON.parse(require("fs").readFileSync(0, "utf8")); const want = JSON.parse(process.argv[1]);
    const still = want.filter((n) => (l.unsupported ?? []).some((x) => x.toLowerCase() === n.toLowerCase()));
    if (still.length) { console.error(`still unsupported: ${still.join(", ")}`); process.exit(1); }
    console.log(`   unsupported-card list: ${(l.unsupported ?? []).length} cards; taken off by overrides: ${(l.removed_by_overrides ?? []).length}`);' "$want_supported" \
    || fail "the Director's unsupported-card list still holds cards the overrides make supported"
else
  echo "   (the Director's unsupported-card list is in memory: no coverage report download here; not checked)"
fi
for f in engine/overrides/*.json; do
  slug="$(basename "$f" .json)"
  case ",$want_overrides," in *",$slug,"*) ;; *) continue ;; esac
  res="$("${compose[@]}" exec -T director node scripts/card-scenario.mjs "$f" --phase ws://phase-server-engine:9374/ws --data patched --json | tail -1)" \
    || fail "$slug: scripted games failed on the stack's phase-server: $res"
  printf '%s' "$res" | node -e 'const r=JSON.parse(require("fs").readFileSync(0,"utf8")); if (!r.ok) process.exit(1); console.log("   " + process.argv[1] + ": " + r.results.map((x) => x.name + " -> " + x.verdict).join("; "))' "$slug" \
    || fail "$slug: not fixed on the stack's phase-server: $res"
done

echo "== the lobby's featured queues are deploy/lobby.json"
want_queues="$(node -p "require('./deploy/lobby.json').featured.slice().sort().join(',')")"
got_queues="$(curl -sf -m 10 "$d/api/lobby" | node -e 'const l=JSON.parse(require("fs").readFileSync(0,"utf8")); console.log(l.queues.filter((q)=>q.featured).map((q)=>q.key).sort().join(","))')"
[ "$got_queues" = "$want_queues" ] || fail "featured queues: $got_queues, expected $want_queues"
echo "   $(node -p "require('./deploy/lobby.json').featured.length") featured queues: $want_queues"
echo "IMAGE CHECK OK: $image in $(( $(date +%s) - start )) s after the build"
}
main "$@"
exit $?
