#!/bin/sh
# Periodic PostgreSQL dumps, verified before anything older is pruned.
#
# One loop, three steps, in an order that matters:
#
#   1. pg_dump -Fc into a temporary name. The custom format is compressed and
#      restorable table-by-table; a plain SQL dump of a ledger is a file nobody
#      can open in an editor and nobody can partially restore.
#   2. pg_restore --list on the result. That parses the whole archive's table of
#      contents; a truncated or corrupt file fails here, and a dump that fails
#      here is deleted and never renamed into place. The `latest` link only
#      ever points at a file that passed.
#   3. Prune dumps older than the retention — only after step 2 succeeded. A
#      night when the dump fails must not be the night the last good one is
#      deleted.
#
# The interval is the recovery point objective: a dump every N hours means up
# to N hours of trades exist only in the primary. Point-in-time recovery is a
# different mechanism and is not configured here; docs/disaster-recovery.md
# says what that would take.
#
# Where the files go is the operator's business. This writes to /backups; the
# compose file binds that to a host directory, and copying it offsite —
# a backup on the same disk as the database is a copy, not a backup — is the
# deployment's job, described in the same document.
set -eu

: "${PGHOST:?PGHOST}"
: "${PGUSER:?PGUSER}"
: "${PGDATABASE:?PGDATABASE}"
: "${PGPASSWORD:?PGPASSWORD}"
INTERVAL_HOURS="${BACKUP_INTERVAL_HOURS:-6}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
DIR="${BACKUP_DIR:-/backups}"

mkdir -p "$DIR"

dump_once() {
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  target="$DIR/${PGDATABASE}-${stamp}.dump"
  tmp="${target}.partial"

  if ! pg_dump -Fc --no-owner --no-acl -f "$tmp" "$PGDATABASE"; then
    echo "[$(date -u +%FT%TZ)] backup FAILED: pg_dump exited non-zero; nothing pruned" >&2
    rm -f "$tmp"
    printf '%s FAILED pg_dump\n' "$stamp" > "$DIR/status"
    return 1
  fi
  if ! pg_restore --list "$tmp" > /dev/null; then
    echo "[$(date -u +%FT%TZ)] backup FAILED: the dump does not parse; discarded, nothing pruned" >&2
    rm -f "$tmp"
    printf '%s FAILED verify\n' "$stamp" > "$DIR/status"
    return 1
  fi
  mv "$tmp" "$target"
  ln -sfn "$(basename "$target")" "$DIR/latest.dump"
  size="$(wc -c < "$target")"
  printf '%s OK %s %s\n' "$stamp" "$(basename "$target")" "$size" > "$DIR/status"
  echo "[$(date -u +%FT%TZ)] backup OK: $(basename "$target") ($size bytes)"

  # Only now. A failed dump returned above and left every older file alone.
  find "$DIR" -name "${PGDATABASE}-*.dump" -type f -mtime "+${RETENTION_DAYS}" -print -delete \
    | sed 's/^/pruned: /'
}

if [ "${1:-}" = "once" ]; then
  dump_once
  exit $?
fi

echo "backups every ${INTERVAL_HOURS}h to ${DIR}, kept ${RETENTION_DAYS} days"
trap 'exit 0' TERM INT
while :; do
  dump_once || true
  sleep "$((INTERVAL_HOURS * 3600))" &
  wait $!
done
