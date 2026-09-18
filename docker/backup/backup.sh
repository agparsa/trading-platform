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
# How long to wait for the database at startup, before the first dump only.
STARTUP_WAIT_SECONDS="${BACKUP_STARTUP_WAIT_SECONDS:-120}"

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

# Waits for the database to answer, at startup and only at startup.
#
# `docker-compose.prod.yml` already has `depends_on: postgres: condition:
# service_healthy`, and that is not enough — which is the whole reason this
# exists. `depends_on` orders containers within one `compose up`. It says
# nothing about an unsupervised restart, and this container is
# `restart: unless-stopped`: when the daemon restarts, or postgres is recreated
# under a running backup container, this one can come back first and dump
# immediately into nothing.
#
# It happened twice on production before anyone looked:
#
#   2026-09-16T02:37  connection to server at "postgres" ... Connection refused
#   2026-09-18T10:45  could not translate host name "postgres" to address
#
# The second is the telling one — the name did not resolve at all, so the
# postgres container did not yet exist. Each failure wrote FAILED to `status`
# and then slept six hours, so a one-second race became a six-hour-old
# "the backups are broken" signal. Worse, `record` needs the same database, so
# no row reached `scheduled_job_runs` either: the platform could not even see
# the failure it was reporting on disk.
#
# **Bounded, and startup only.** A dump six hours in that cannot reach the
# database is a real outage and must still fail loudly — waiting there would
# turn an incident into silence. If the wait expires, the dump proceeds and
# fails honestly, exactly as it did before.
wait_for_database() {
  waited=0
  while [ "$waited" -lt "$STARTUP_WAIT_SECONDS" ]; do
    if pg_isready -q 2>/dev/null; then
      [ "$waited" -gt 0 ] && echo "[$(date -u +%FT%TZ)] database answered after ${waited}s; starting"
      return 0
    fi
    sleep 2
    waited=$((waited + 2))
  done
  echo "[$(date -u +%FT%TZ)] database did not answer in ${STARTUP_WAIT_SECONDS}s; dumping anyway so the failure is recorded" >&2
  return 1
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
  # On demand, and deliberately without the startup wait: somebody running this
  # by hand wants an answer now, not a two-minute pause.
  dump_once
  exit $?
fi

if [ "${1:-}" = "wait" ]; then
  # The startup wait on its own. Useful to an operator asking "can this
  # container reach the database?", and it is how the wait is tested without
  # running a loop that never ends.
  wait_for_database
  exit $?
fi

echo "backups every ${INTERVAL_HOURS}h to ${DIR}, kept ${RETENTION_DAYS} days"
trap 'exit 0' TERM INT
# Before the first dump only. See wait_for_database.
wait_for_database || true
while :; do
  dump_once || true
  sleep "$((INTERVAL_HOURS * 3600))" &
  wait $!
done
