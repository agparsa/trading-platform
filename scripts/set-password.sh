#!/usr/bin/env bash
# A new, generated password for an existing user, shown once. See
# apps/api/src/cli/set-password.ts.
#
#   scripts/set-password.sh --email you@firm.example --reason "owner locked out"
set -euo pipefail
cd "$(dirname "$0")/.."

ENV_FILE=.env.production
[ -f "$ENV_FILE" ] || { echo "$ENV_FILE is missing; this runs on a host that is already deployed." >&2; exit 1; }

COMPOSE=(docker compose -f docker-compose.prod.yml -f docker-compose.cpanel.yml --env-file "$ENV_FILE")

exec "${COMPOSE[@]}" run --rm --no-deps migrate \
  node apps/api/dist/cli/set-password.js "$@"
