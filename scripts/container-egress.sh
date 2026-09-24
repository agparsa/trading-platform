#!/bin/sh
# Can a container on this host reach the internet?
#
#   container-egress.sh <compose command…>
#
# Exit 0: yes. Exit 3: no — the request from inside the running API container
# failed. Any other status: this could not be asked (no API container running,
# no Docker), which is not an answer and must not be read as one.
#
# Why this exists. On 24 September at 02:40 an automatic CSF upgrade (v16.31 ->
# v16.32) restarted the firewall. A CSF restart rewrites iptables and removes
# Docker's own rules — the NAT that lets a container out. The site kept
# serving (inbound goes through the host), and every build after that failed at
# step 5 with `apk add … DNS: transient error` and "no such package", naming
# the package when what failed was the network. This asks the question
# directly, before anything is backed up, merged or built, and names the cause.
#
# EGRESS_TARGET is where to ask: the Alpine mirror the build will use.
set -u

TARGET=${EGRESS_TARGET:-https://dl-cdn.alpinelinux.org/alpine/}

"$@" exec -T api node -e '
  fetch(process.argv[1], { method: "HEAD", signal: AbortSignal.timeout(8000) })
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(String((error.cause && (error.cause.code || error.cause.message)) || error.message));
      process.exit(3);
    });
' "$TARGET"
