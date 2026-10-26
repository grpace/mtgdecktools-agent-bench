#!/usr/bin/env bash
# Health check of the hosted stack, and its alerts (docs/OPERATIONS.md, "Monitoring"). Read-only; never needs a token.
# Prints one line per check; exits 1 when any check fails, 0 otherwise.
#   scripts/ops-check.sh                 Director and Hub /health, intake, open-data build, capacity, TLS expiry
#   scripts/ops-check.sh --server        also the host (SSH_HOST, or SSH_HOST=local when already on it): disk
#                                        use, the stack's volume sizes, container log caps, the newest Hub database dump,
#                                        and the nightly volume backup
#   scripts/ops-check.sh --alert         e-mail when checks fail twice in a row (a deploy's restart doesn't
#                                        alert), again every ALERT_REPEAT_HOURS while they keep failing or when a different
#                                        check fails, and once when everything is back. On the host, mail goes through
#                                        its local mail server with Coolify's saved SMTP login. State in OPS_STATE_DIR.
#   scripts/ops-check.sh --test-email    send a test alert and stop
# Installed on the host by deploy/deploy.sh, with a 5-minute crontab line (SSH_HOST=local).
# Log: journalctl -t agent-bench-ops; the last run's output: $OPS_STATE_DIR/last-run.txt.
# Env: DIRECTOR_URL (https://bench.mtgdecktools.com), HUB_URL (https://bench-data.mtgdecktools.com),
#      OPEN_DATA_MAX_HOURS (30), TLS_MIN_DAYS (14), DISK_MAX_PCT (80), DUMP_MAX_HOURS (30), BACKUP_MAX_HOURS (30),
#      VOLUME_MAX_GB (phase-data 5, director-runs 40, hub-data 40, hub-pgdata 10, others 5; e.g. VOLUME_MAX_GB_HUB_DATA=60),
#      SSH_HOST (required with --server unless already on the host: SSH_HOST=local), ALERT_TO (else the address in ~/.config/agent-bench-ops/alert-to on the host), ALERT_AFTER (2 runs),
#      ALERT_REPEAT_HOURS (6), OPS_STATE_DIR (~/.local/state/agent-bench-ops), PROJECT (the Coolify project name).
# Body is wrapped in main() so bash parses the whole file before running.
main() {
set -uo pipefail
server=""; alert=""; test_email=""
for a in "$@"; do case "$a" in
  --server) server=1 ;; --alert) alert=1 ;; --test-email) test_email=1 ;;
  -h|--help) sed -n '2,20p' "$0"; return 0 ;;
  *) echo "unknown option: $a"; return 2 ;;
esac; done
director="${DIRECTOR_URL:-https://bench.mtgdecktools.com}"
hub="${HUB_URL:-https://bench-data.mtgdecktools.com}"
ssh_host="${SSH_HOST:-}"
if [ -n "$server" ] && [ -z "$ssh_host" ]; then echo "set SSH_HOST to the Coolify host, or SSH_HOST=local on the host itself"; return 2; fi
project="${PROJECT:-agent-bench}"
state="${OPS_STATE_DIR:-$HOME/.local/state/agent-bench-ops}"
to="${ALERT_TO:-$(cat "$HOME/.config/agent-bench-ops/alert-to" 2>/dev/null)}"
if [ -z "$ssh_host" ] || [ "$ssh_host" = local ]; then host_name="$(hostname)"; else host_name="$ssh_host"; fi

if [ -n "$test_email" ]; then
  send_mail "agent-bench: test of the ops check e-mail" "A test from the Agent Bench ops check on $(hostname) (scripts/ops-check.sh, docs/OPERATIONS.md \"Monitoring\"). When a check of the hosted stack fails twice in a row, an e-mail like this arrives with the failing checks and a prompt to paste into an agent. Nothing to do."
  return $?
fi

failed=0
keys=()
out=""
say() { out+="$*"$'\n'; echo "$*"; }
ok() { say "ok    $*"; }
bad() { local key="$1"; shift; say "FAIL  $*"; failed=1; keys+=("$key"); }
json() { python3 -I -c "import json,sys
try: d=json.load(sys.stdin)
except Exception: sys.exit(1)
for k in sys.argv[1].split('.'):
    d = d.get(k) if isinstance(d, dict) else None
print('' if d is None else (json.dumps(d) if isinstance(d, (dict, list)) else d))" "$1"; }
on_host() { # a command on the host: over SSH, or here when SSH_HOST=local
  if [ "$ssh_host" = local ]; then bash -c "$1"; else ssh -o BatchMode=yes -o ConnectTimeout=10 "$ssh_host" "$1"; fi
}

d="$(curl -sf -m 15 "$director/health")" && [ "$(json ok <<<"$d")" = True ] && ok "director /health (version $(json version <<<"$d"))" || bad director-health "director /health: ${d:-no answer}"
h="$(curl -sf -m 15 "$hub/health")" && [ "$(json ok <<<"$h")" = True ] && ok "hub /health (version $(json version <<<"$h"), $(json events <<<"$h") events)" || bad hub-health "hub /health: ${h:-no answer}"
if [ -n "${h:-}" ]; then
  w="$(json intake_waiting <<<"$h")"; [ "${w:-0}" -le 5 ] 2>/dev/null && ok "hub intake waiting: ${w:-0}" || bad intake "hub intake waiting: $w"
  built="$(json open_data.last_build.at <<<"$h")"; code="$(json open_data.last_build.code <<<"$h")"
  if [ -n "$built" ] && [ -n "$code" ] && [ "$code" != 0 ]; then bad open-data "open data: the last build ($built) exited $code"
  elif [ -n "$built" ]; then
    age=$(( ( $(date +%s) - $(date -d "$built" +%s) ) / 3600 ))
    [ "$age" -le "${OPEN_DATA_MAX_HOURS:-30}" ] && ok "open data built ${age} h ago" || bad open-data "open data last built ${age} h ago ($built)"
  else ok "open data: no build since the Hub started (or not deployed)"; fi
fi
c="$(curl -sf -m 15 "$director/api/capacity")" && ok "capacity: load $(json load <<<"$c") of $(json capacity <<<"$c"), queued $(json queued <<<"$c"), draining $(json draining <<<"$c")" || bad capacity "director /api/capacity: no answer"

for url in "$director" "$hub"; do
  host="${url#https://}"; host="${host%%/*}"
  end="$(echo | openssl s_client -servername "$host" -connect "$host:443" 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)"
  if [ -z "$end" ]; then bad "tls-$host" "TLS $host: no certificate"; continue; fi
  days=$(( ( $(date -d "$end" +%s) - $(date +%s) ) / 86400 ))
  [ "$days" -ge "${TLS_MIN_DAYS:-14}" ] && ok "TLS $host: $days days left" || bad "tls-$host" "TLS $host: expires in $days days ($end)"
done

if [ -n "$server" ]; then
  pct="$(on_host "df -P /var/lib/docker 2>/dev/null || df -P /" 2>/dev/null | awk 'NR==2 {gsub("%","",$5); print $5}')"
  if [ -z "$pct" ]; then bad disk "disk on $host_name: no answer"
  elif [ "$pct" -le "${DISK_MAX_PCT:-80}" ]; then ok "disk on $host_name: ${pct}% used"; else bad disk "disk on $host_name: ${pct}% used"; fi

  # The stack's volumes (docker system df: the daemon's own sizes, no root needed), each against its limit.
  cproj="$(on_host "docker ps --filter label=coolify.projectName=$project --format '{{.Label \"com.docker.compose.project\"}}' | head -1" 2>/dev/null)"
  vols="$(on_host "docker system df -v --format '{{json .Volumes}}'" 2>/dev/null)"
  if [ -z "$cproj" ] || [ -z "$vols" ]; then bad volumes "volume sizes on $host_name: no answer"
  else
    while IFS=$'\t' read -r st name size limit; do
      [ -n "$name" ] || continue
      if [ "$st" = ok ]; then ok "volume $name: $size (limit $limit GB)"; else bad "volume-$name" "volume $name: $size, over its $limit GB limit"; fi
    done < <(python3 -I -c "
import json, os, re, sys
units = {'B': 1, 'kB': 1e3, 'KB': 1e3, 'MB': 1e6, 'GB': 1e9, 'TB': 1e12}
limits = {'phase-data': 5, 'director-runs': 40, 'hub-data': 40, 'hub-pgdata': 10}
for v in json.loads(sys.argv[1]) or []:
    name = v.get('Name', '')
    if not name.startswith(sys.argv[2] + '_'): continue
    short = name[len(sys.argv[2]) + 1:]
    s = re.match(r'^([0-9.]+)\s*([A-Za-z]+)$', str(v.get('Size', '0B')).strip())
    size = float(s.group(1)) * units.get(s.group(2), 1) if s else 0
    limit = float(os.environ.get('VOLUME_MAX_GB_' + short.upper().replace('-', '_'), os.environ.get('VOLUME_MAX_GB', limits.get(short, 5))))
    print('ok' if size <= limit * 1e9 else 'over', short, v.get('Size'), f'{limit:g}', sep='\t')
" "$vols" "$cproj")
  fi

  # Container logs are capped (compose logging: max-size); an uncapped one can fill the disk.
  caps="$(on_host "for c in \$(docker ps -q --filter label=coolify.projectName=$project); do docker inspect -f '{{index .Config.Labels \"com.docker.compose.service\"}} {{index .HostConfig.LogConfig.Config \"max-size\"}}' \$c; done" 2>/dev/null)"
  if [ -z "$caps" ]; then bad logs "container logs: no containers found for project $project"
  else
    uncapped="$(awk '$2 == "" || $2 == "<no value>" {print $1}' <<<"$caps" | paste -sd, -)"
    [ -z "$uncapped" ] && ok "container logs capped ($(awk '{print $1 "=" $2}' <<<"$caps" | paste -sd' ' -))" || bad logs "container logs not capped: $uncapped"
  fi

  # The newest /dumps/hub-<Day>.dump in the hub-db container (Coolify names containers <service>-<uuid>).
  dump="$(on_host 'c=$(docker ps --format "{{.Names}}" | grep "^hub-db-" | head -1); [ -n "$c" ] && docker exec "$c" sh -c "ls -t /dumps/hub-*.dump 2>/dev/null | head -1 | xargs -r stat -c %Y"' 2>/dev/null)"
  if [ -z "$dump" ]; then bad dump "hub database dump: none found"
  else
    age=$(( ( $(date +%s) - dump ) / 3600 ))
    [ "$age" -le "${DUMP_MAX_HOURS:-30}" ] && ok "hub database dump ${age} h old" || bad dump "hub database dump ${age} h old"
  fi

  # The server's nightly volume backup (/opt/backup/backup.sh, 03:00, encrypted to Google Drive) keeps its last run in
  # /tmp/gr3g-backup/<timestamp>/volumes: it must hold this stack's runs and Hub data. /tmp is emptied by a reboot.
  b="$(on_host "d=\$(ls -d /tmp/gr3g-backup/*/ 2>/dev/null | sort | tail -1); up=\$(cut -d. -f1 /proc/uptime); echo \"\${d:-none} \$up \$( [ -n \"\$d\" ] && stat -c %Y \"\$d\" ) \$( [ -n \"\$d\" ] && ls \"\$d/volumes\" 2>/dev/null | grep -cE '_(director-runs|hub-data|hub-pgdump)\\.tar\\.gz\$')\"" 2>/dev/null)"
  read -r bdir uptime_s bt bcount <<<"${b:-none 0}"
  if [ "${bdir:-none}" = none ]; then
    if [ "${uptime_s:-0}" -lt $(( ${BACKUP_MAX_HOURS:-30} * 3600 )) ]; then ok "volume backup: none in /tmp since the reboot (the next runs at 03:00)"
    else bad backup "volume backup: none found in /tmp/gr3g-backup"; fi
  else
    age=$(( ( $(date +%s) - ${bt:-0} ) / 3600 ))
    if [ "$age" -gt "${BACKUP_MAX_HOURS:-30}" ]; then bad backup "volume backup ${age} h old ($bdir)"
    elif [ "${bcount:-0}" -lt 3 ]; then bad backup "volume backup $bdir lacks director-runs, hub-data or hub-pgdump"
    else ok "volume backup ${age} h old (director-runs, hub-data, hub-pgdump included)"; fi
  fi
fi

[ -n "$alert" ] && alert_on "$failed"
return $failed
}

# E-mail through the host's local mail server with Coolify's saved SMTP login (the credentials go from Coolify straight into python
# on a pipe, never printed or on a command line). Only where Coolify is installed.
send_mail() { # send_mail <subject> <body>   (to $to: ALERT_TO, or ~/.config/agent-bench-ops/alert-to on the host)
  if [ -z "$to" ]; then logger -t agent-bench-ops "no alert address (ALERT_TO or ~/.config/agent-bench-ops/alert-to): $1" 2>/dev/null; echo "send_mail: no alert address set"; return 1; fi
  if ! docker inspect coolify > /dev/null 2>&1; then echo "send_mail: no Coolify here; alerts are sent from the host"; return 2; fi
  docker exec coolify php artisan tinker --execute='$s = instanceSettings(); echo json_encode(["user" => $s->smtp_username, "pass" => $s->smtp_password, "from" => $s->smtp_from_address, "name" => $s->smtp_from_name]);' \
    | MAIL_TO="$to" MAIL_SUBJECT="$1" MAIL_BODY="$2" python3 -I -c '
import json, os, smtplib, sys
from email.message import EmailMessage
from email.utils import formataddr
c = json.loads(sys.stdin.read().strip().splitlines()[-1])
m = EmailMessage()
m["From"] = formataddr((c["name"] or "agent-bench", c["from"]))
m["To"] = os.environ["MAIL_TO"]
m["Subject"] = os.environ["MAIL_SUBJECT"]
m.set_content(os.environ["MAIL_BODY"])
with smtplib.SMTP("127.0.0.1", 25, timeout=30) as s:
    s.login(c["user"], c["pass"])
    s.send_message(m)
' || { logger -t agent-bench-ops "e-mail FAILED: $1" 2>/dev/null; echo "send_mail: could not send"; return 1; }
  logger -t agent-bench-ops "e-mailed $to: $1" 2>/dev/null || true
}

# Alert state machine: failing twice in a row → alert; then again when the failing set changes or every
# ALERT_REPEAT_HOURS; back to all ok after an alert → one "recovered" e-mail.
alert_on() { # alert_on <failed 0|1>   (reads $keys, $out, $state from main)
  mkdir -p "$state"
  printf '%s' "$out" > "$state/last-run.txt"
  local now count last_alert last_keys cur
  now=$(date +%s)
  count=$(cat "$state/fail-count" 2>/dev/null || echo 0)
  last_alert=$(cat "$state/last-alert" 2>/dev/null || echo 0)
  last_keys=$(cat "$state/alerted-keys" 2>/dev/null || true)
  cur="$(printf '%s\n' "${keys[@]:-}" | sort -u | paste -sd' ' -)"
  if [ "$1" = 0 ]; then
    echo 0 > "$state/fail-count"
    if [ -n "$last_keys" ]; then
      send_mail "agent-bench: all checks pass again on $host_name" "Every check of the Agent Bench stack passes again (it had failed: $last_keys).

$out" && rm -f "$state/alerted-keys"
    fi
    logger -t agent-bench-ops "ok" 2>/dev/null || true
    return 0
  fi
  count=$((count + 1)); echo "$count" > "$state/fail-count"
  logger -t agent-bench-ops "FAIL ($count in a row): $cur" 2>/dev/null || true
  [ "$count" -ge "${ALERT_AFTER:-2}" ] || return 0
  if [ "$cur" != "$last_keys" ] || [ $((now - last_alert)) -ge $(( ${ALERT_REPEAT_HOURS:-6} * 3600 )) ]; then
    send_mail "agent-bench: $(wc -w <<<"$cur") check(s) failing on $host_name: $cur" "The Agent Bench ops check (scripts/ops-check.sh) has failed $count times in a row.

$out
Runbook: docs/OPERATIONS.md (\"Failures\") in the mtgdecktools-agent-bench repository. The last output is in the ops state directory on the host (last-run.txt)." \
      && { echo "$now" > "$state/last-alert"; echo "$cur" > "$state/alerted-keys"; }
  fi
}
main "$@"
