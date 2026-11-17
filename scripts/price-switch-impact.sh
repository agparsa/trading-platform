#!/usr/bin/env bash
# Read-only: what switching instruments to a real price would do to the
# positions open in them. See apps/api/src/cli/price-switch-impact.ts.
#
#   scripts/price-switch-impact.sh --price XAUUSD=3884.01 --price XAGUSD=48.737
set -euo pipefail
cd "$(dirname "$0")/.."

ENV_FILE=.env.production
[ -f "$ENV_FILE" ] || { echo "$ENV_FILE is missing; this runs on a host that is already deployed." >&2; exit 1; }

COMPOSE=(docker compose -f docker-compose.prod.yml -f docker-compose.cpanel.yml --env-file "$ENV_FILE")

exec "${COMPOSE[@]}" run --rm --no-deps migrate \
  node apps/api/dist/cli/price-switch-impact.js "$@"
