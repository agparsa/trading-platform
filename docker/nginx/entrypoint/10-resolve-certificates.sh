#!/bin/sh
# Decide which certificate Nginx will actually serve, before it starts.
#
# `ssl_certificate` is not conditional. Nginx refuses to start when the file is
# missing — so a first bring-up on a host that has not obtained a certificate
# yet brings up Postgres, Redis, the API, the worker and the web app, and then
# fails on the one container that lets anybody reach any of them. The error is
# in a log nobody is watching yet, and the stack looks like it started.
#
# So: if a real certificate is mounted, use it. If not, generate a self-signed
# one and say so, loudly, every single boot. The deployment comes up reachable
# and obviously provisional, which is the honest state of a host that has no
# certificate — rather than unreachable for a reason that takes an hour to find.
#
# This never writes into the mounted directory, which stays read-only, and never
# replaces a certificate that is already there.
set -eu

# Overridable so the logic can be exercised outside a container — see
# scripts/deployment.test.ts. The defaults are what actually runs.
MOUNTED=${TP_CERT_MOUNT:-/etc/nginx/certs}
ACTIVE=${TP_CERT_ACTIVE:-/etc/nginx/active-certs}

mkdir -p "$ACTIVE"

if [ -r "$MOUNTED/fullchain.pem" ] && [ -r "$MOUNTED/privkey.pem" ]; then
  cp "$MOUNTED/fullchain.pem" "$ACTIVE/fullchain.pem"
  cp "$MOUNTED/privkey.pem" "$ACTIVE/privkey.pem"
  echo "nginx: serving the certificate mounted at $MOUNTED"
  exit 0
fi

if [ -r "$ACTIVE/fullchain.pem" ]; then
  # Already generated earlier in this container's life.
  exit 0
fi

openssl req -x509 -nodes -newkey rsa:2048 -days 365 \
  -keyout "$ACTIVE/privkey.pem" \
  -out "$ACTIVE/fullchain.pem" \
  -subj "/CN=${TLS_SELF_SIGNED_CN:-localhost}" \
  -addext "subjectAltName=DNS:${TLS_SELF_SIGNED_CN:-localhost},DNS:localhost,IP:127.0.0.1" \
  >/dev/null 2>&1

cat >&2 <<'WARNING'
================================================================================
nginx: NO CERTIFICATE WAS MOUNTED. Serving a self-signed one.

Every browser will warn. Nothing about this deployment is private in transit to
anyone who can sit between a trader and this host, and HSTS is being sent, which
means a browser that accepts this once will refuse plain HTTP afterwards.

Fix it before anyone signs in:
  - obtain a certificate for this hostname
  - put fullchain.pem and privkey.pem in the directory named by TLS_CERT_DIR
  - docker compose -f docker-compose.prod.yml restart nginx

See docs/deployment.md.
================================================================================
WARNING
