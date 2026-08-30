#!/bin/sh
# Reload Nginx when the certificate underneath it changes.
#
# A renewed certificate that nothing reloads keeps being served as the old one
# until the container happens to restart — so the failure arrives up to ninety
# days after the event that caused it, which is the worst shape a failure can
# have.
#
# This watches the file rather than being told about it, and it runs inside the
# Nginx container. The alternative — a sidecar that calls `docker kill -s HUP` —
# needs the Docker socket, and a container with the Docker socket can start any
# container it likes as root on the host. Mounting it `:ro` does not change that:
# the flag protects the socket *file*, not the API reachable through it. No part
# of reloading a web server is worth that.
#
# Backgrounded, because the stock entrypoint runs these scripts in sequence
# before exec'ing nginx, and one that did not return would mean nginx never
# starts.
set -eu

ACTIVE=${TP_CERT_ACTIVE:-/etc/nginx/active-certs}
INTERVAL=${TP_CERT_WATCH_SECONDS:-60}

watch() {
  # Follows the symlink, so this is the modification time of whatever
  # certificate is actually being served.
  seen=$(stat -Lc %Y "$ACTIVE/fullchain.pem" 2>/dev/null || echo 0)
  while :; do
    sleep "$INTERVAL"
    now=$(stat -Lc %Y "$ACTIVE/fullchain.pem" 2>/dev/null || echo 0)
    if [ "$now" != "$seen" ] && [ "$now" != "0" ]; then
      seen=$now
      if nginx -t >/dev/null 2>&1; then
        nginx -s reload
        echo "nginx: certificate changed, reloaded"
      else
        # A reload on a bad configuration takes the site down. Refusing to
        # reload leaves the old certificate serving, which is wrong but working.
        echo "nginx: certificate changed but the configuration is invalid; not reloading" >&2
      fi
    fi
  done
}

watch &
