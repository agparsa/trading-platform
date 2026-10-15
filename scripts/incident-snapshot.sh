#!/bin/sh
# What happened to this host, read-only, in one command.
#
#   ssh tp-server 'sh /opt/trading-platform/scripts/incident-snapshot.sh'
#   ssh tp-server 'sh /opt/trading-platform/scripts/incident-snapshot.sh 72'   # hours back
#
# Why this exists. On 13 October the host stopped answering — TCP accepted on
# every port, no service sent a byte — for about a day, and on 15 October the
# platform restarted again at 02:51 UTC. Both times the questions afterwards
# were the same seven, asked by hand from memory while the evidence aged: did
# the machine reboot or only the containers, did the kernel kill something for
# memory, is the disk full, which container restarted and with what exit code,
# what else on this host is using the memory. This asks all of them.
#
# It changes nothing. Every command reads. It prints no secret: no
# environment, no `docker inspect` beyond the state fields named below, no
# file contents but the kernel's own messages.
set -u

HOURS=${1:-48}
PROJECT=${PROJECT:-trading-platform-prod}

section() {
  printf '\n== %s ==\n' "$1"
}

section "host"
date -u '+now: %Y-%m-%d %H:%M:%S UTC'
uptime
printf 'booted: '
uptime -s 2>/dev/null || who -b

section "reboots and shutdowns (newest first)"
last -x reboot shutdown 2>/dev/null | head -8 || echo "last: not available"

section "kernel: memory kills in the last ${HOURS}h"
# The previous boot's kernel log survives only if journald keeps it on disk;
# say which, because "no OOM lines" from a log that did not survive is not
# an answer.
if [ -d /var/log/journal ]; then
  echo "journald: persistent (/var/log/journal exists)"
else
  echo "journald: VOLATILE — the previous boot's kernel log is gone; only this boot is shown"
fi
if command -v journalctl >/dev/null 2>&1; then
  journalctl -k --since "-${HOURS}h" --no-pager 2>/dev/null |
    grep -iE 'out of memory|oom-kill|killed process|oom_reaper|hung_task|blocked for more than' |
    tail -30
fi
dmesg -T 2>/dev/null | grep -iE 'out of memory|oom-kill|killed process|hung_task' | tail -10

section "kernel: the end of the previous boot"
if command -v journalctl >/dev/null 2>&1; then
  journalctl -k -b -1 -n 40 --no-pager 2>/dev/null || echo "no previous boot in the journal"
fi

section "memory"
free -m
[ -r /proc/pressure/memory ] && { echo "pressure:"; cat /proc/pressure/memory; }
[ -r /proc/pressure/io ] && { echo "io pressure:"; cat /proc/pressure/io; }
cat /proc/loadavg

section "disk"
df -h / /var/lib/docker 2>/dev/null | awk '!seen[$0]++'
df -i / 2>/dev/null | tail -1

section "containers of ${PROJECT}: start, restarts, exit, OOM"
for name in $(docker ps -a --filter "name=${PROJECT}" --format '{{.Names}}' | sort); do
  docker inspect --format \
    '{{.Name}} started={{.State.StartedAt}} restarts={{.RestartCount}} exit={{.State.ExitCode}} oomkilled={{.State.OOMKilled}} status={{.State.Status}} health={{if .State.Health}}{{.State.Health.Status}}{{else}}-{{end}}' \
    "$name"
done

section "container deaths in the last ${HOURS}h (every project on this host)"
docker events --since "${HOURS}h" --until "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --filter event=die --filter event=oom --filter event=kill \
  --format '{{.Time}} {{.Action}} {{.Actor.Attributes.name}} exit={{.Actor.Attributes.exitCode}}' 2>/dev/null |
  while read -r t rest; do
    printf '%s %s\n' "$(date -u -d "@$t" '+%m-%d %H:%M:%S' 2>/dev/null || echo "$t")" "$rest"
  done | tail -40

section "memory by container, now (every project on this host)"
docker stats --no-stream --format '{{.Name}} {{.MemUsage}} {{.MemPerc}} cpu={{.CPUPerc}}' 2>/dev/null | sort -k4 -t' ' -r

section "largest processes by resident memory"
ps -eo rss,comm --sort=-rss 2>/dev/null | head -12 |
  awk 'NR==1 {print; next} {printf "%8.0f MB  %s\n", $1/1024, $2}'

echo
echo "Read-only: nothing on this host was changed."
