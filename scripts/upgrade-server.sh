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
say "1/9  What is about to change"
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
say "2/9  Environment variables this build requires"
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
say "3/9  Database backup"
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
say "4/9  Fetching the new code"
# ---------------------------------------------------------------------------
git merge --ff-only "@{u}" || die "The checkout has local changes or has diverged. Resolve by hand; a deploy is the wrong time to guess."
echo "    now at $(git rev-parse --short HEAD)"

# The images are stamped with the commit they were built from. Nothing else can
# answer "what is actually running on this host?" — the checkout says what was
# *fetched*, which is a different question and is the one that misleads: a build
# that failed, or a container that was never recreated, leaves the two apart and
# the checkout still looks right.
#
# `docker-compose.prod.yml` defaults this to `unknown`, so forgetting it is not
# an error, just an image that cannot say what it is. This script forgot it from
# the day it was written: every deploy run through it produced `build: unknown`,
# and `verify:production`'s check that the running build is the deployed one
# could only ever pass after a compose command typed by hand. Exported here,
# after the merge, so it is the SHA of the code about to be built.
export BUILD_SHA
BUILD_SHA=$(git rev-parse HEAD)
echo "    images will be stamped $BUILD_SHA"

# ---------------------------------------------------------------------------
say "5/9  Building images, one at a time"
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
say "6/9  Migrating — the downtime starts here"
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
say "7/9  The role row-level security applies to"
# ---------------------------------------------------------------------------
#
# PostgreSQL exempts a table's owner from that table's policies, and
# DATABASE_URL is the owner — migrations need it to be. So the policies installed
# by the tenancy migrations constrain a reporting user and an analyst's psql
# session, and not the application, until a second role exists that owns nothing.
# See docs/multi-tenancy.md.
#
# Everything here is idempotent and everything here is a warning rather than a
# stop. The platform runs correctly without it — with the second isolation layer
# disarmed for the application, which is the state every deployment was in before
# this step existed. An upgrade is the wrong moment to refuse over it.
#
# The order matters and is the whole reason this is a script rather than a
# paragraph in a runbook:
#
#   * after the migration, so `GRANT ON ALL TABLES` covers the tables it created;
#   * verified *before* DATABASE_URL_TENANT is written, because the API refuses
#     to boot when that variable is set and the role turns out not to be
#     constrained — correct behaviour, and an outage if this script wrote the
#     line first and checked afterwards;
#   * before the new containers start, so they come up already using it.
#
# The password is generated on this host and written straight into the two places
# that need it. It is never printed: a secret that appears in a terminal is a
# secret in somebody's scrollback and in their shell history.
TENANT_ROLE=trading_app
psql_owner() {
  "${COMPOSE[@]}" exec -T postgres psql -U "${POSTGRES_USER:-trading}" \
    -d "${POSTGRES_DB:-trading_platform}" -tAc "$1" 2>/dev/null | tr -d '[:space:]'
}

if grep -qE '^DATABASE_URL_TENANT=' "$ENV_FILE"; then
  echo "    DATABASE_URL_TENANT already set"
elif [ "$(psql_owner "SELECT 1 FROM pg_roles WHERE rolname = '$TENANT_ROLE'")" = "1" ]; then
  # The role exists but nothing points at it. Left alone deliberately: its
  # password is not recoverable from here, and resetting somebody else's
  # database role during an upgrade is not this script's business.
  warn "The $TENANT_ROLE role exists but DATABASE_URL_TENANT is not set. Set it by hand; see docs/multi-tenancy.md."
else
  TENANT_PASSWORD=$(openssl rand -base64 24 | tr -d '\n/+=' | head -c 32)
  if [ -z "$TENANT_PASSWORD" ]; then
    warn "Could not generate a password for $TENANT_ROLE; skipping."
  else
    say_ok=true
    "${COMPOSE[@]}" exec -T postgres psql -U "${POSTGRES_USER:-trading}" \
      -d "${POSTGRES_DB:-trading_platform}" >/dev/null 2>&1 <<SQL || say_ok=false
CREATE ROLE $TENANT_ROLE LOGIN PASSWORD '$TENANT_PASSWORD' NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE;
GRANT USAGE ON SCHEMA public TO $TENANT_ROLE;
REVOKE CREATE ON SCHEMA public FROM $TENANT_ROLE;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO $TENANT_ROLE;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO $TENANT_ROLE;
ALTER DEFAULT PRIVILEGES FOR ROLE ${POSTGRES_USER:-trading} IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO $TENANT_ROLE;
ALTER DEFAULT PRIVILEGES FOR ROLE ${POSTGRES_USER:-trading} IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO $TENANT_ROLE;
SQL

    if [ "$say_ok" != true ]; then
      warn "Creating $TENANT_ROLE failed. Row-level security still does not constrain the application."
    else
      # The check that decides. With no tenant bound, `current_tenant_id()` is
      # NULL and NULL matches no row, so the correct answer is zero. Any other
      # answer means the role is exempt after all — and an empty users table
      # would make zero prove nothing, so the owner's count is checked too.
      VISIBLE=$("${COMPOSE[@]}" exec -T -e PGPASSWORD="$TENANT_PASSWORD" postgres \
        psql -U "$TENANT_ROLE" -d "${POSTGRES_DB:-trading_platform}" \
        -tAc "SELECT count(*) FROM users" 2>/dev/null | tr -d '[:space:]')
      TOTAL=$(psql_owner "SELECT count(*) FROM users")

      if [ -z "$VISIBLE" ]; then
        warn "$TENANT_ROLE could not read the database at all. Grants are wrong; DATABASE_URL_TENANT not set."
      elif [ "${TOTAL:-0}" -lt 1 ]; then
        warn "The users table is empty, so reading $VISIBLE rows proves nothing. DATABASE_URL_TENANT not set."
      elif [ "$VISIBLE" != "0" ]; then
        warn "$TENANT_ROLE reads $VISIBLE of $TOTAL users with no tenant set, so the policies do not apply to it. DATABASE_URL_TENANT not set."
      else
        printf '\n# The connection tenant traffic uses. Row-level security exempts a table owner\n# from its own policies, so this second role is what makes them enforcement.\n# See docs/multi-tenancy.md.\nDATABASE_URL_TENANT=postgresql://%s:%s@postgres:5432/%s?schema=public\n' \
          "$TENANT_ROLE" "$TENANT_PASSWORD" "${POSTGRES_DB:-trading_platform}" >> "$ENV_FILE"
        echo "    $TENANT_ROLE reads 0 of $TOTAL users with no tenant set; DATABASE_URL_TENANT written"
      fi
    fi
    unset TENANT_PASSWORD
  fi
fi

# ---------------------------------------------------------------------------
say "8/9  Starting the new version"
# ---------------------------------------------------------------------------
"${COMPOSE[@]}" up -d

# Nginx reads its configuration from a bind-mounted *file*, and a file bind
# mount is a mount of an inode. `git merge` writes a new file rather than
# editing the old one in place, so after a pull the running container is still
# reading the configuration it started with — every line of it — until it is
# recreated. `up -d` does not recreate it: nothing about the container changed
# from Compose's point of view.
#
# Found the hard way: a body-size limit raised for the document upload route
# was committed, deployed, and not in effect, because the container that was
# "Up 34 hours" had never seen the new file. A 3 MB upload was refused at the
# edge with every test green.
#
# So: if any file the nginx container mounts differs from what it started with,
# recreate it. The cost is the connections open at that instant, which is why
# it is done only when something actually changed.
if [ "$BEFORE" != "$AFTER" ] && \
   git diff --quiet "$BEFORE" "$AFTER" -- docker/nginx/ docker-compose.prod.yml docker-compose.cpanel.yml; then
  echo "    nginx configuration unchanged; the running container keeps its connections"
else
  if [ "$BEFORE" != "$AFTER" ]; then
    echo "    nginx configuration changed in $BEFORE..$AFTER; recreating the container so it reads the new file"
  else
    echo "    recreating nginx so a bind-mounted configuration edited by hand is picked up"
  fi
  "${COMPOSE[@]}" up -d --force-recreate nginx
fi
"${COMPOSE[@]}" ps

# ---------------------------------------------------------------------------
say "9/9  Verifying"
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
