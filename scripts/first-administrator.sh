#!/usr/bin/env bash
# Appoint the first administrator on a running host.
#
#   ./scripts/first-administrator.sh --email you@firm.example --reason "first administrator after deployment"
#   ./scripts/first-administrator.sh --email ... --reason "..." --tenant other-firm
#   ./scripts/first-administrator.sh --email ... --reason "..." --even-if-one-exists
#
# A fresh deployment has traders and no administrator, and the only way to put
# somebody into a role — POST /admin/users/:id/role — needs an administrator.
# This is the way in: it runs apps/api/dist/cli/first-administrator.js inside
# the migrate image, which already holds the built code, the Prisma client and
# the owner database connection, and nothing else does.
#
# The person must already be registered and verified. The platform does not
# create accounts from a shell; see the CLI's own header for why. The act ends
# their sessions and is written to the audit log with this host's name.
set -euo pipefail
cd "$(dirname "$0")/.."

ENV_FILE=.env.production
[ -f "$ENV_FILE" ] || { echo "$ENV_FILE is missing; this runs on a host that is already deployed." >&2; exit 1; }

COMPOSE=(docker compose -f docker-compose.prod.yml -f docker-compose.cpanel.yml --env-file "$ENV_FILE")

# `run` rather than `exec`: the migrate service is a job, not a running
# container, and its image is the one with the code. --no-deps because postgres
# is already up on a host this is meant for, and starting "dependencies" of a
# job would otherwise mean restarting nothing and waiting for it.
exec "${COMPOSE[@]}" run --rm --no-deps migrate \
  node apps/api/dist/cli/first-administrator.js "$@"
