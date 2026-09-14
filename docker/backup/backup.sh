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
# Every attempt is also recorded in `scheduled_job_runs`, the same table the
# worker's schedules write to. That is not tidiness. The `status` file beside
# the dumps is only readable by somebody who has already logged in to the host
# and gone looking — which is to say, during an incident, after the backup has
# already been silently absent for a week. A row in the database is read by
# `GET /health/jobs`, by `tp_scheduled_job_late`, and by `verify:production`,
# so a backup that stops looks exactly like any other schedule that stops.
#
# Its schedule is written as `every:<seconds>` rather than as a cron, because
# that is what it is: a sleep loop, where a restart shifts every subsequent run.
# A cron pattern in that column would be a lie a reader would later act on.
#
# The recording never fails the backup. A dump that refused to run because its
# bookkeeping row was locked would be a watchdog that eats what it watches.
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

# The schedule as this loop actually behaves, for whoever judges its lateness.
SPEC="every:$((INTERVAL_HOURS * 3600))"

# Records an attempt where the platform can see it. Failure here is logged and
# ignored: the backup is the point, and this is the note about the backup.
record() {
  outcome="$1"
  reason="${2:-}"
  psql -v ON_ERROR_STOP=1 -q -d "$PGDATABASE" >/dev/null 2>&1 <<SQL || \
    echo "[$(date -u +%FT%TZ)] could not record the backup run; the dump itself is unaffected" >&2
INSERT INTO scheduled_job_runs
  (name, cron, started_at, finished_at, duration_ms, outcome, error, runs, failures, last_succeeded_at, updated_at)
VALUES
  ('backup', '$SPEC', to_timestamp($STARTED_EPOCH), now(),
   GREATEST(0, (EXTRACT(EPOCH FROM now()) - $STARTED_EPOCH)::int * 1000),
   '$outcome',
   $( [ "$outcome" = FAILED ] && printf "'%s'" "$reason" || printf NULL ),
   1, $( [ "$outcome" = FAILED ] && echo 1 || echo 0 ),
   $( [ "$outcome" = OK ] && echo "now()" || echo NULL ),
   now())
ON CONFLICT (name) DO UPDATE SET
  cron = EXCLUDED.cron,
  started_at = EXCLUDED.started_at,
  finished_at = EXCLUDED.finished_at,
  duration_ms = EXCLUDED.duration_ms,
  outcome = EXCLUDED.outcome,
  error = EXCLUDED.error,
  runs = scheduled_job_runs.runs + 1,
  failures = scheduled_job_runs.failures + EXCLUDED.failures,
  -- Kept, not overwritten, when this attempt failed: the distance between the
  -- last finish and the last success is how long the backups have been broken.
  last_succeeded_at = COALESCE(EXCLUDED.last_succeeded_at, scheduled_job_runs.last_succeeded_at),
  updated_at = now();
SQL
}

dump_once() {
  STARTED_EPOCH="$(date -u +%s)"
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  target="$DIR/${PGDATABASE}-${stamp}.dump"
  tmp="${target}.partial"

  if ! pg_dump -Fc --no-owner --no-acl -f "$tmp" "$PGDATABASE"; then
    echo "[$(date -u +%FT%TZ)] backup FAILED: pg_dump exited non-zero; nothing pruned" >&2
    rm -f "$tmp"
    printf '%s FAILED pg_dump\n' "$stamp" > "$DIR/status"
    record FAILED 'pg_dump exited non-zero'
    return 1
  fi
  if ! pg_restore --list "$tmp" > /dev/null; then
    echo "[$(date -u +%FT%TZ)] backup FAILED: the dump does not parse; discarded, nothing pruned" >&2
    rm -f "$tmp"
    printf '%s FAILED verify\n' "$stamp" > "$DIR/status"
    record FAILED 'the dump does not parse'
    return 1
  fi
  mv "$tmp" "$target"
  ln -sfn "$(basename "$target")" "$DIR/latest.dump"
  size="$(wc -c < "$target")"
  printf '%s OK %s %s\n' "$stamp" "$(basename "$target")" "$size" > "$DIR/status"
  echo "[$(date -u +%FT%TZ)] backup OK: $(basename "$target") ($size bytes)"
  record OK

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
