#!/usr/bin/env bash
# Write .env.production on the machine that will use it.
#
# Secrets are generated here, on the host, and never travel. That is the whole
# reason this is a shell script and not something run from a laptop and copied
# up: a key that has been through a chat window, a clipboard or a CI log is a
# key somebody else may also have.
#
#   ./scripts/bootstrap-production-env.sh trade.example.com [--cdn arvancloud]
#
# Refuses to overwrite an existing .env.production. Rotating a live secret is a
# deliberate act with a procedure (see docs/encryption-at-rest.md), not something
# a re-run of a bootstrap script should do by accident — regenerating
# SECRET_ENCRYPTION_KEYS alone would lock every enrolled user out of their second
# factor.
set -euo pipefail

cd "$(dirname "$0")/.."

DOMAIN=${1:-}
CDN=""
shift || true
while [ $# -gt 0 ]; do
  case "$1" in
    --cdn) CDN=${2:-}; shift 2 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

if [ -z "$DOMAIN" ]; then
  echo "usage: $0 <domain> [--cdn arvancloud]" >&2
  exit 2
fi

if [ -e .env.production ]; then
  echo ".env.production already exists. Refusing to overwrite it." >&2
  echo "Move it aside first if you really mean to start over." >&2
  exit 1
fi

for tool in openssl node; do
  command -v "$tool" >/dev/null || { echo "$tool is required" >&2; exit 1; }
done

TRUSTED=./docker/nginx/trusted-proxies.conf
if [ -n "$CDN" ]; then
  candidate="./docker/nginx/trusted-proxies.$CDN.conf"
  if [ -f "$candidate" ]; then
    TRUSTED=$candidate
  else
    echo "No trusted-proxy file for '$CDN' ($candidate)." >&2
    echo "Write one from that provider's published ranges, or omit --cdn." >&2
    exit 1
  fi
fi

secret() { openssl rand -base64 48 | tr -d '\n'; }
# The same format the application parses, produced by the application's own
# generator rather than a second implementation of it here.
enc_key() { node --experimental-strip-types --no-warnings scripts/keygen.ts 1 2>/dev/null || npx --yes tsx scripts/keygen.ts 1; }

ENCRYPTION_KEY=$(enc_key | tr -d '\n')
case "$ENCRYPTION_KEY" in
  1:*) : ;;
  *) echo "keygen did not produce a usable key; refusing to write a broken file" >&2; exit 1 ;;
esac

umask 077
cp .env.production.example .env.production

set_var() {
  # Replaces the whole line, so a value containing / + = is safe — which a
  # base64 secret routinely is, and which a naive sed s|…|…| would corrupt.
  node -e '
    const fs = require("fs");
    const [file, key, value] = process.argv.slice(1);
    const lines = fs.readFileSync(file, "utf8").split("\n");
    let found = false;
    const out = lines.map((line) => {
      if (line.startsWith(key + "=")) { found = true; return key + "=" + value; }
      return line;
    });
    if (!found) out.push(key + "=" + value);
    fs.writeFileSync(file, out.join("\n"));
  ' .env.production "$1" "$2"
}

set_var TLS_DOMAIN            "$DOMAIN"
set_var APP_PUBLIC_URL        "https://$DOMAIN"
set_var PUBLIC_API_URL        "https://$DOMAIN/api/v1"
set_var PUBLIC_WS_URL         "https://$DOMAIN"
set_var CORS_ORIGINS          "https://$DOMAIN"
set_var TRUSTED_PROXIES_FILE  "$TRUSTED"
set_var TLS_CERT_DIR          "./docker/nginx/certs"
set_var POSTGRES_PASSWORD     "$(openssl rand -hex 24)"
set_var JWT_ACCESS_SECRET     "$(secret)"
set_var JWT_REFRESH_SECRET    "$(secret)"
set_var SECRET_ENCRYPTION_KEYS "$ENCRYPTION_KEY"

chmod 600 .env.production

cat <<DONE

  .env.production written for $DOMAIN (mode 600).

  Generated here and stored nowhere else: the database password, both JWT
  secrets, and the key that seals two-factor secrets at rest. Back that file up
  somewhere you would trust with a password manager. Losing
  SECRET_ENCRYPTION_KEYS means every enrolled user has to re-enrol; losing the
  Postgres password means restoring from a dump.

  Trusted proxies: $TRUSTED
DONE

if [ "$TRUSTED" = "./docker/nginx/trusted-proxies.conf" ]; then
  cat <<'WARN'
  This trusts nobody, which is correct only if this host faces the internet
  directly. Behind a CDN, every rate limit will count the CDN rather than the
  client — pass --cdn <name> instead.

WARN
fi

echo "  Next: BUILD_SHA=\$(git rev-parse HEAD) docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build"
echo
