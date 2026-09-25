#!/bin/sh
# Copies the newest verified database dump off the server.
#
#   pull-backup.sh <ssh-host> <remote-backup-dir> <local-dir> [days]
#
# Exit 0: copied (or already held), checksum matched, and the backup is fresh.
# Exit 3: the server's last backup FAILED, or its status is not one this reads.
# Exit 4: copied, but the newest backup is older than 12 hours — the backup
#         job has stopped, which a copy of an old file must not hide.
# Exit 5: the copy did not match the server's checksum.
# Anything else: the server could not be asked, which is not an answer.
#
# Why this exists. The backup container writes a verified dump every six hours
# — to the server's own disk. A dump on the database's disk is a copy, not a
# backup (docs/disaster-recovery.md). On 25 September the owner chose to keep
# the off-server copy on their Mac, pulled by the six-hourly health check.
#
# Nothing is ever deleted. The folder holds 4 × <days> slots, named for the
# day of the year modulo <days> and the six-hour block, and each run writes
# over one of them — so retention is <days> days without a delete, which the
# folder this runs against does not permit. Each slot has a .txt beside it
# naming the dump it holds and its checksum.
set -eu

HOST=$1
REMOTE=$2
LOCAL=$3
DAYS=${4:-14}
SSH=${PULL_BACKUP_SSH:-ssh -o BatchMode=yes -o ConnectTimeout=10}

status=$($SSH "$HOST" "cat '$REMOTE/status'") || {
  echo "pull-backup: could not read $REMOTE/status on $HOST" >&2
  exit 2
}
# shellcheck disable=SC2086
set -- $status
stamp=${1:-}
result=${2:-}
file=${3:-}
bytes=${4:-}
if [ "$result" != OK ]; then
  echo "pull-backup: the last backup ($stamp) is ${result:-unreadable}: $status" >&2
  exit 3
fi
case "$file" in
  trading_platform-*.dump) ;;
  *)
    echo "pull-backup: the status names '$file', not a dump this copies" >&2
    exit 3
    ;;
esac

mkdir -p "$LOCAL"
day=$(date -u +%j | sed 's/^0*//')
block=$(($(date -u +%H | sed 's/^0//') / 6))
slot=$(printf 'slot-%02d-%d' $((day % DAYS)) "$block")

remote_sum=$($SSH "$HOST" "sha256sum '$REMOTE/$file'" | cut -d' ' -f1)
if [ -f "$LOCAL/$slot.txt" ] && grep -qx "$file $remote_sum" "$LOCAL/$slot.txt"; then
  echo "pull-backup: $slot already holds $file"
else
  # Written in place: truncating a file is allowed where deleting one is not.
  $SSH "$HOST" "cat '$REMOTE/$file'" > "$LOCAL/$slot.dump"
  local_sum=$(sha256sum "$LOCAL/$slot.dump" | cut -d' ' -f1)
  if [ "$local_sum" != "$remote_sum" ]; then
    echo "MISMATCH $file" > "$LOCAL/$slot.txt"
    echo "pull-backup: $slot does not match $file on the server" >&2
    exit 5
  fi
  echo "$file $remote_sum" > "$LOCAL/$slot.txt"
  echo "pull-backup: copied $file ($bytes bytes, sha256 $remote_sum) to $slot"
fi

taken=$(date -u -d "$(echo "$stamp" | sed -E 's/^(....)(..)(..)T(..)(..)(..)Z$/\1-\2-\3 \4:\5:\6/')" +%s)
age=$(($(date -u +%s) - taken))
if [ "$age" -gt 43200 ]; then
  echo "pull-backup: the newest backup is $((age / 3600)) hours old; the backup job has stopped" >&2
  exit 4
fi
