#!/bin/sh
# Decide which certificate Nginx will actually serve, before it starts.
#
# `ssl_certificate` is not conditional. Nginx refuses to start when the file is
# missing — so a first bring-up on a host that has not obtained a certificate
# yet brings up Postgres, Redis, the API, the worker and the web app, and then
# fails on the one container that lets anybody reach any of them. The error is
# in a log nobody is watching yet, and the stack looks like it started.
#
# Three sources, in order of how much they should be trusted:
#
#   1. A certificate the operator mounted. Explicit, so it wins.
#   2. One Let's Encrypt issued into the shared volume.
#   3. A self-signed one generated here, with a warning on every boot.
#
# The first two are linked, not copied. A renewal replaces the file behind the
# link, and `nginx -s reload` then serves the new certificate without this
# script running again — which is the whole point, since it runs only at start
# and a certificate outlives a container restart by ninety days at most.
set -eu

MOUNTED=${TP_CERT_MOUNT:-/etc/nginx/certs}
ACTIVE=${TP_CERT_ACTIVE:-/etc/nginx/active-certs}
LETSENCRYPT=${TP_LETSENCRYPT_DIR:-/etc/letsencrypt}
DOMAIN=${TLS_DOMAIN:-localhost}

mkdir -p "$ACTIVE"

use() {
  ln -sfn "$1/fullchain.pem" "$ACTIVE/fullchain.pem"
  ln -sfn "$1/privkey.pem" "$ACTIVE/privkey.pem"
}

if [ -r "$MOUNTED/fullchain.pem" ] && [ -r "$MOUNTED/privkey.pem" ]; then
  use "$MOUNTED"
  echo "nginx: serving the certificate mounted at $MOUNTED"
  exit 0
fi

LIVE="$LETSENCRYPT/live/$DOMAIN"
if [ -r "$LIVE/fullchain.pem" ] && [ -r "$LIVE/privkey.pem" ]; then
  use "$LIVE"
  echo "nginx: serving the Let's Encrypt certificate for $DOMAIN"
  exit 0
fi

# Nothing real. Generate a stand-in so the stack is reachable, and make the
# state impossible to miss.
openssl req -x509 -nodes -newkey rsa:2048 -days 365 \
  -keyout "$ACTIVE/privkey.pem" \
  -out "$ACTIVE/fullchain.pem" \
  -subj "/CN=$DOMAIN" \
  -addext "subjectAltName=DNS:$DOMAIN,DNS:localhost,IP:127.0.0.1" \
  >/dev/null 2>&1

cat >&2 <<WARNING
================================================================================
nginx: NO CERTIFICATE FOR $DOMAIN. Serving a self-signed one.

Every browser will warn, and a CDN configured to validate its origin will refuse
this deployment outright. Nothing about traffic to this host is private to
anyone who can sit between a trader and it, and HSTS is being sent, which means
a browser that accepts this once will refuse plain HTTP afterwards.

Fix it before anyone signs in, either:
  - run the certbot service in docker-compose.prod.yml to issue one, or
  - put fullchain.pem and privkey.pem in the directory named by TLS_CERT_DIR

then: docker compose -f docker-compose.prod.yml restart nginx

See docs/deployment.md.
================================================================================
WARNING
