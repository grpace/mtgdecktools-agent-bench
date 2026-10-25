#!/usr/bin/env bash
# Restore drill for the Hub database (docs/OPERATIONS.md, "Backups and Restore"): copy the newest nightly pg_dump from the
# hosted hub-db, restore it into a throwaway Postgres container on this machine (never the live database), migrate it
# forward with this checkout's Hub code, and compare its row counts with the live database's rows from before the dump.
# Prints the timings. Removes the container and the dump copy at the end (the dump holds account data).
#   scripts/restore-drill.sh            the newest /dumps/hub-<Day>.dump
#   scripts/restore-drill.sh <file>     another dump in /dumps (e.g. pre-<sha>.dump)
# Env: SSH_HOST (gr3g-server), CONTAINER_ENGINE (podman, else docker), DRILL_PG_PORT (15499).
# Body is wrapped in main() so bash parses the whole file before running.
main() {
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
ssh_host="${SSH_HOST:-gr3g-server}"
engine="${CONTAINER_ENGINE:-$(command -v podman >/dev/null && echo podman || echo docker)}"
port="${DRILL_PG_PORT:-15499}"
pg_image="$(sed -n 's/^ *image: \(docker.io\/library\/postgres:[^ ]*\)$/\1/p' "$repo/deploy/compose.yaml" | head -1)"
[ -n "$pg_image" ] || { echo "restore-drill: no Postgres image in deploy/compose.yaml"; return 1; }
work="$(mktemp -d)"; chmod 700 "$work"
name="mtgdt-restore-drill-$$"
cleanup() { "$engine" rm -f "$name" > /dev/null 2>&1 || true; rm -rf "$work"; }
trap cleanup EXIT
now() { date +%s.%N; }
secs() { python3 -I -c "import sys; print(f'{float(sys.argv[2]) - float(sys.argv[1]):.1f}')" "$1" "$2"; }

t0=$(now)
db="$(ssh -o BatchMode=yes "$ssh_host" 'docker ps --format "{{.Names}}" | grep "^hub-db-" | head -1')"
[ -n "$db" ] || { echo "restore-drill: no hub-db container on $ssh_host"; return 1; }
file="${1:-$(ssh -o BatchMode=yes "$ssh_host" "docker exec $db sh -c 'ls -t /dumps/hub-*.dump | head -1'")}"
case "$file" in /dumps/*) ;; *) file="/dumps/$file" ;; esac
[[ "$file" =~ ^/dumps/[A-Za-z0-9._-]+\.dump$ ]] || { echo "restore-drill: not a dump name: $file"; return 1; }
dumped_at="$(ssh -o BatchMode=yes "$ssh_host" "docker exec $db stat -c %Y $file")"
ssh -o BatchMode=yes "$ssh_host" "docker exec $db cat $file" > "$work/hub.dump"
t1=$(now)
echo "dump: $file ($(stat -c %s "$work/hub.dump") bytes, taken $(date -u -d "@$dumped_at" +%Y-%m-%dT%H:%MZ)), copied in $(secs "$t0" "$t1") s"

pw="$(openssl rand -hex 16)"
"$engine" run -d --name "$name" -p "127.0.0.1:$port:5432" -e POSTGRES_USER=hub -e POSTGRES_DB=hub -e POSTGRES_PASSWORD="$pw" "$pg_image" > /dev/null
for _ in $(seq 1 60); do "$engine" exec "$name" pg_isready -U hub -d hub -h 127.0.0.1 > /dev/null 2>&1 && break; sleep 1; done
t2=$(now)
"$engine" cp "$work/hub.dump" "$name:/tmp/hub.dump"
"$engine" exec "$name" pg_restore -U hub -d hub --no-owner --exit-on-error /tmp/hub.dump
t3=$(now)
echo "throwaway Postgres up in $(secs "$t1" "$t2") s; pg_restore in $(secs "$t2" "$t3") s"
migrations() { "$engine" exec "$name" psql -U hub -d hub -Atc "select string_agg(version, ',' order by version) from schema_migrations"; }
echo "migrations in the dump: $(migrations)"
(cd "$repo" && DATABASE_URL="postgres://hub:$pw@127.0.0.1:$port/hub" HUB_DATA_DIR="$work/hub-data" npm run -s hub -- migrate > /dev/null)
t4=$(now)
echo "migrated forward with this checkout in $(secs "$t3" "$t4") s: $(migrations)"

# Rows of events ingested before the dump: the restored copy must have exactly the live database's.
at="$(date -u -d "@$dumped_at" '+%Y-%m-%d %H:%M:%S+00')"
q="select 'events', count(*) from events where ingested_at <= '$at'
union all select 'seats', count(*) from seats s join events e on e.id = s.event_id where e.ingested_at <= '$at'
union all select 'games', count(*) from games g join events e on e.id = g.event_id where e.ingested_at <= '$at'
union all select 'picks', count(*) from picks p join events e on e.id = p.event_id where e.ingested_at <= '$at'
union all select 'contributors', count(*) from contributors where created_at <= '$at'"
restored="$("$engine" exec "$name" psql -U hub -d hub -AtF= -c "$q" | paste -sd' ' -)"
live="$(ssh -o BatchMode=yes "$ssh_host" "docker exec $db psql -U hub -d hub -AtF= -c \"$q\"" | paste -sd' ' -)"
t5=$(now)
echo "restored: $restored"
echo "live:     $live (rows from before the dump)"
echo "total: $(secs "$t0" "$t5") s"
if [ "$restored" = "$live" ]; then echo "RESTORE DRILL OK"; else echo "RESTORE DRILL MISMATCH"; return 1; fi
}
main "$@"
