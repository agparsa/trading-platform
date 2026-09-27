#!/usr/bin/env bash
# Reverse ledger entries on a running host, with compensating entries.
#
#   ./scripts/compensate-ledger-entries.sh --entry <id> [--entry <id> …] --reason "<why>"          # plan only
#   ./scripts/compensate-ledger-entries.sh --entry <id> [--entry <id> …] --reason "<why>" --apply  # post
#
# The panel's adjustments endpoint is the way to correct a ledger entry —
# behind accounts.adjust, a live two-factor code and a reason. This is the same
# act from the host, for when the panel cannot be used: it runs
# apps/api/dist/cli/compensate-ledger-entries.js inside the migrate image,
# which holds the built code, the Prisma client and the owner connection.
#
# Nothing is edited or deleted. One compensating ADJUSTMENT per entry, all on
# one account, in one transaction, refused if any entry was already answered,
# with an audit row that names this host. Without --apply it only prints what
# it would post. See the CLI's own header for the rest.
set -euo pipefail
cd "$(dirname "$0")/.."

ENV_FILE=.env.production
[ -f "$ENV_FILE" ] || { echo "$ENV_FILE is missing; this runs on a host that is already deployed." >&2; exit 1; }

COMPOSE=(docker compose -f docker-compose.prod.yml -f docker-compose.cpanel.yml --env-file "$ENV_FILE")

exec "${COMPOSE[@]}" run --rm --no-deps migrate \
  node apps/api/dist/cli/compensate-ledger-entries.js "$@"
