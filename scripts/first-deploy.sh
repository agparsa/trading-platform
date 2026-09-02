#!/usr/bin/env bash
# Bring the platform up on a host for the first time.
#
#   ./scripts/first-deploy.sh trade.example.com you@example.com [--cdn arvancloud]
#
# Run it on the server, from a checkout of this repository. It is ordered the way
# it is because each step can fail in a way that makes the next one meaningless,
# and finding that out four steps later is how a deploy turns into an evening.
#
# It is safe to re-run: the env file is written once and kept, and a certificate
# that already exists is not re-issued.
set -euo pipefail
cd "$(dirname "$0")/.."

usage() {
  echo "usage: $0 <domain> <email-for-letsencrypt> [--cdn <name>]" >&2
  exit 2
}

# Both positionals are required, so check before shifting past them — `shift 2`
# with one argument shifts nothing and silently leaves it to be read as an
# option, which reports a missing email as "unknown option".
[ $# -ge 2 ] || usage
DOMAIN=$1
EMAIL=$2
shift 2

CDN_ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --cdn) [ $# -ge 2 ] || usage; CDN_ARGS=(--cdn "$2"); shift 2 ;;
    *) echo "unknown option: $1" >&2; usage ;;
  esac
done

[ -n "$DOMAIN" ] && [ -n "$EMAIL" ] || usage

COMPOSE=(docker compose -f docker-compose.prod.yml --env-file .env.production)
say() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
die() { printf '\n\033[31m%s\033[0m\n' "$1" >&2; exit 1; }

# ── 1. Prerequisites ────────────────────────────────────────────────────────
say "Checking prerequisites"
command -v docker >/dev/null || die "Docker is not installed. https://docs.docker.com/engine/install/"
docker compose version >/dev/null 2>&1 || die "The Docker Compose plugin is not installed."
docker info >/dev/null 2>&1 || die "Cannot talk to the Docker daemon. Is it running, and are you in the docker group?"
echo "    docker $(docker version --format '{{.Server.Version}}'), compose $(docker compose version --short)"

# ── 2. Ports ────────────────────────────────────────────────────────────────
# Nginx binds 80 and 443. A web server already sitting there does not produce a
# clear error from compose — it produces a container that restarts forever.
say "Checking that 80 and 443 are free"
for port in 80 443; do
  holder=""
  if command -v ss >/dev/null; then
    holder=$(ss -lntp "sport = :$port" 2>/dev/null | awk 'NR>1' | head -1)
  elif command -v lsof >/dev/null; then
    holder=$(lsof -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | awk 'NR>1' | head -1)
  fi
  if [ -n "$holder" ]; then
    echo "    port $port is in use:" >&2
    echo "    $holder" >&2
    die "Stop whatever is holding it first (often Apache or Nginx: systemctl disable --now apache2 nginx)."
  fi
  echo "    $port free"
done

# ── 3. Configuration ────────────────────────────────────────────────────────
say "Configuration"
if [ -e .env.production ]; then
  echo "    .env.production exists — keeping it. Secrets are not regenerated."
else
  ./scripts/bootstrap-production-env.sh "$DOMAIN" "${CDN_ARGS[@]}"
fi
grep -q "^TLS_DOMAIN=$DOMAIN$" .env.production \
  || die ".env.production is for a different domain than '$DOMAIN'. Check it before continuing."

# ── 4. Build and start ──────────────────────────────────────────────────────
# Nginx comes up on a self-signed certificate here; it has to be running and
# serving port 80 before Let's Encrypt can reach the challenge.
say "Building images (this takes a while the first time)"
"${COMPOSE[@]}" build

say "Starting the stack"
"${COMPOSE[@]}" up -d

say "Waiting for the API to report ready"
ready=""
for _ in $(seq 1 60); do
  if "${COMPOSE[@]}" exec -T api node -e \
      "fetch('http://127.0.0.1:4000/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" \
      >/dev/null 2>&1; then
    ready=yes; break
  fi
  sleep 5
done
[ -n "$ready" ] || {
  "${COMPOSE[@]}" ps
  "${COMPOSE[@]}" logs --tail 60 migrate api
  die "The API never became ready. Its logs and the migration job's are above."
}
echo "    ready"

# ── 5. The certificate ──────────────────────────────────────────────────────
# Dry run first. Let's Encrypt rate-limits failed issuance per domain per week,
# and a rehearsal costs nothing.
say "Certificate for $DOMAIN"
if "${COMPOSE[@]}" run --rm --entrypoint sh certbot -c \
     "test -r /etc/letsencrypt/live/$DOMAIN/fullchain.pem" >/dev/null 2>&1; then
  echo "    one already exists — leaving it alone"
else
  echo "    rehearsing issuance"
  "${COMPOSE[@]}" run --rm --entrypoint certbot certbot certonly \
    --webroot -w /var/www/certbot -d "$DOMAIN" \
    --email "$EMAIL" --agree-tos --no-eff-email --dry-run \
    || die "The dry run failed. Port 80 must reach this host from the internet, and a CDN in front must not cache or redirect /.well-known/acme-challenge/."

  echo "    issuing"
  "${COMPOSE[@]}" run --rm --entrypoint certbot certbot certonly \
    --webroot -w /var/www/certbot -d "$DOMAIN" \
    --email "$EMAIL" --agree-tos --no-eff-email

  "${COMPOSE[@]}" restart nginx
fi

# ── 6. What it actually is now ──────────────────────────────────────────────
say "Result"
"${COMPOSE[@]}" ps
echo
echo "  Serving:      https://$DOMAIN"
echo "  Admin:        https://$DOMAIN/admin"
echo
cat <<'NEXT'
  Not done yet. Run these against the real deployment before anyone signs in:

    pnpm smoke                 the API answers, and refuses what it should
    pnpm smoke:ws              the realtime path survives whatever is in front
    pnpm pentest               25 attacks, all expected to fail
    pnpm restore:rehearse      a backup you have restored is a backup

  And check the certificate is the issued one, not the stand-in:

    docker compose -f docker-compose.prod.yml --env-file .env.production \
      logs nginx | grep -i certificate

  There is no administrator yet. Nothing creates one: register through the
  site, verify the address, then appoint that account from this host —

    ./scripts/first-administrator.sh --email you@firm.example \
      --reason "first administrator after deployment"

  Every later role change is that administrator's, from the People screen.
  Withdrawals need a second person in FINANCE; see docs/withdrawals.md.
NEXT
