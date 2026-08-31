#!/usr/bin/env bash
# Upgrade a host that is already running the platform.
#
#   ./scripts/upgrade-server.sh [--skip-backup] [--no-build]
#
# `first-deploy.sh` brings a bare host up. This brings a running one forward:
# fetch, back up, migrate, rebuild, restart, verify.
#
# It is ordered around three things that have actually gone wrong on this host,
# and each one costs more than the check that prevents it.
#
#   1. A missing environment variable that makes the API refuse to boot. The
#      API is *supposed* to refuse to start with REGISTRATION_MODE=open under
#      NODE_ENV=production. An .env.production written before that variable
#      existed has no value for it, the default is `open`, and the refusal
#      lands after the old container is already gone. So the file is checked
#      and completed before anything is stopped.
#
#   2. Building every image at once. `docker compose build` builds in parallel;
#      on two cores serving live sites that saturated the machine and the host
#      rebooted. One at a time costs a few minutes and nothing else.
#
#   3. Migrating with no way back. A schema change against live data without a
#      dump is a decision that cannot be revisited.
#
# There is unavoidable downtime between the migration and the new API starting.
# The tenancy migration makes tenant_id NOT NULL, and the previous build does
# not set it — so the old code cannot run against the new schema, and running
# them side by side would fail every write rather than degrade gracefully. The
# window is stated rather than hidden: it is the length of the migration plus
# the container start.
set -euo pipefail
cd "$(dirname "$0")/.."

SKIP_BACKUP=false
BUILD=true
while [ $# -gt 0 ]; do
  case "$1" in
    --skip-backup) SKIP_BACKUP=true; shift ;;
    --no-build) BUILD=false; shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

COMPOSE=(docker compose -f docker-compose.prod.yml -f docker-compose.cpanel.yml --env-file .env.production)
ENV_FILE=.env.production

say()  { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
warn() { printf '\033[33m    %s\033[0m\n' "$1"; }
die()  { printf '\n\033[31m%s\033[0m\n' "$1" >&2; exit 1; }

[ -f "$ENV_FILE" ] || die "$ENV_FILE is missing. This script upgrades a host that is already running; use first-deploy.sh for a new one."

# ---------------------------------------------------------------------------
say "1/8  What is about to change"
# ---------------------------------------------------------------------------
BEFORE=$(git rev-parse --short HEAD)
git fetch --all --prune
AFTER=$(git rev-parse --short "@{u}" 2>/dev/null || echo "$BEFORE")
if [ "$BEFORE" = "$AFTER" ]; then
  warn "Already at $BEFORE. Nothing to fetch."
else
  echo "    $BEFORE -> $AFTER"
  git --no-pager log --oneline "$BEFORE..$AFTER" | sed 's/^/      /'
fi

# ---------------------------------------------------------------------------
say "2/8  Environment variables this build requires"
# ---------------------------------------------------------------------------
#
# Added only when absent. An operator's existing value is never overwritten:
# this script's job is to stop the process refusing to boot, not to have
# opinions about a setting somebody chose.
add_if_missing() {
  local key=$1 value=$2 why=$3
  if grep -qE "^${key}=" "$ENV_FILE"; then
    echo "    $key already set"
  else
    printf '\n# %s\n%s=%s\n' "$why" "$key" "$value" >> "$ENV_FILE"
    warn "$key was missing; set to '$value'"
  fi
}

add_if_missing REGISTRATION_MODE invite \
  "open | invite | closed. The API refuses to boot on 'open' in production unless REGISTRATION_ALLOW_OPEN_IN_PRODUCTION=true."
add_if_missing REGISTRATION_ALLOW_OPEN_IN_PRODUCTION false \
  "Set true only if a public sign-up is genuinely intended."
add_if_missing INVITE_CODE_TTL_HOURS 168 \
  "How long a minted invitation stays usable."
add_if_missing TENANT_DEFAULT_SLUG default \
  "The tenant a request falls back to when no tenant claims its hostname."
add_if_missing TENANT_HOST_STRICT false \
  "Turn on the moment a second tenant exists; see docs/multi-tenancy.md."

# ---------------------------------------------------------------------------
say "3/8  Database backup"
# ---------------------------------------------------------------------------
if [ "$SKIP_BACKUP" = true ]; then
  warn "Skipped at your request. The migration below is not reversible without one."
else
  STAMP=$(date -u +%Y%m%dT%H%M%SZ)
  mkdir -p backups
  OUT="backups/pre-upgrade-${AFTER}-${STAMP}.sql.gz"
  "${COMPOSE[@]}" exec -T postgres pg_dump -U "${POSTGRES_USER:-trading}" \
    "${POSTGRES_DB:-trading_platform}" | gzip > "$OUT"
  SIZE=$(du -h "$OUT" | cut -f1)
  # A dump that failed still leaves a file, so check it holds something.
  [ "$(gzip -dc "$OUT" | head -c 200 | wc -c)" -gt 100 ] || die "The dump at $OUT looks empty. Stopping before the migration."
  echo "    $OUT ($SIZE)"
fi

# ---------------------------------------------------------------------------
say "4/8  Fetching the new code"
# ---------------------------------------------------------------------------
git merge --ff-only "@{u}" || die "The checkout has local changes or has diverged. Resolve by hand; a deploy is the wrong time to guess."
echo "    now at $(git rev-parse --short HEAD)"

# ---------------------------------------------------------------------------
say "5/8  Building images, one at a time"
# ---------------------------------------------------------------------------
if [ "$BUILD" = true ]; then
  # `migrate` and `api-ingest` are built from the same Dockerfile and target as
  # `api`, so those two are cache hits and cost seconds. They are listed anyway:
  # compose builds per service, and a service left out is one that pulls a stale
  # image at the worst moment.
  for service in api api-ingest migrate worker web nginx; do
    echo "    building $service"
    "${COMPOSE[@]}" build "$service" || die "Building $service failed. Nothing has been stopped; the old version is still serving."
  done
else
  warn "Skipped at your request."
fi

# ---------------------------------------------------------------------------
say "6/8  Migrating — the downtime starts here"
# ---------------------------------------------------------------------------
# `api-ingest` too, and it is the one most easily forgotten: it is a separate
# service running the same code, and leaving it up would have the old build
# writing ticks and firing stops against the new schema.
"${COMPOSE[@]}" stop api api-ingest worker
"${COMPOSE[@]}" run --rm migrate || die "The migration failed. The old images are still built; 'docker compose up -d api worker' restores service on the old schema only if the migration made no changes."
#
# `pnpm db:seed` does not work here, and finding that out the hard way is why
# this is spelled out. The production image carries `node_modules`, `prisma/`
# and the built application — but **not** the root `package.json`, so pnpm has
# no manifest to read a script from and fails inside its own dependency check
# with a stack trace that says nothing about the real cause. `tsx` is in the
# image; calling it directly is what works. It is `sh -c`, not `node`, because
# `node_modules/.bin/tsx` is a shell wrapper rather than a JavaScript file.
#
# And a failure here is a **warning**, not a stop. The first version of this
# script died on it, after the migration and before the containers came back —
# turning a seed that refreshes instrument definitions into an outage. What the
# platform actually cannot start without is a tenant, and the migration creates
# that, so the invariant is checked below instead of the mechanism being trusted.
if ! "${COMPOSE[@]}" run --rm --entrypoint sh api -c './node_modules/.bin/tsx prisma/seed.ts'; then
  warn "The seed did not run. Instrument definitions were not refreshed; the upgrade continues."
fi

TENANTS=$("${COMPOSE[@]}" exec -T postgres psql -U "${POSTGRES_USER:-trading}" \
  -d "${POSTGRES_DB:-trading_platform}" -tAc \
  "SELECT count(*) FROM tenants WHERE status = 'ACTIVE'" 2>/dev/null | tr -d '[:space:]')
if [ "${TENANTS:-0}" -lt 1 ]; then
  die "No active tenant exists. The API resolves every request to one and will refuse every request without it."
fi
echo "    $TENANTS active tenant(s)"

# ---------------------------------------------------------------------------
say "7/8  Starting the new version"
# ---------------------------------------------------------------------------
"${COMPOSE[@]}" up -d
"${COMPOSE[@]}" ps

# ---------------------------------------------------------------------------
say "8/8  Verifying"
# ---------------------------------------------------------------------------
#
# Readiness rather than liveness: liveness answers while the database is
# unreachable, which is exactly the state a bad migration leaves behind.
ready=false
for attempt in $(seq 1 60); do
  if "${COMPOSE[@]}" exec -T api node -e \
      "fetch('http://127.0.0.1:4000/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" \
      >/dev/null 2>&1; then
    echo "    ready after ${attempt}s"
    ready=true
    break
  fi
  sleep 1
done
if [ "$ready" != true ]; then
  echo
  "${COMPOSE[@]}" logs --tail 40 api
  die "The API did not become ready. The log above says why; a refusal to boot names the variable it refused over."
fi

say "Done. $BEFORE -> $(git rev-parse --short HEAD)"
cat <<'NOTE'

    Two things this script does not do, on purpose:

    - It does not run the smoke tests. Run them from a machine that can reach
      the public hostname, so they test the whole chain rather than loopback:

        SMOKE_INVITE_CODE=<code> SMOKE_TARGET=https://<host> pnpm smoke
        SMOKE_TARGET=https://<host> pnpm smoke:ws

      REGISTRATION_MODE is now `invite`, so mint a multi-use invitation first
      from the admin API and pass it. See docs/registration.md.

    - It does not remove the previous images. `docker image prune` when you are
      satisfied the new version is behaving, and not before: they are what a
      rollback uses.
NOTE
