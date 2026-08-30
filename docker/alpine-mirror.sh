#!/bin/sh
# Point apk at a different mirror, if one was asked for.
#
# This is four lines of shell that took two failed builds on a live host, which
# is why it is a file with a test rather than a fragment repeated inside four
# Dockerfiles.
#
#   1. Alpine's CDN answered from the host and failed intermittently from inside
#      a container on the same machine. `apk add openssl` then reports "no such
#      package" — naming the package, when what failed was fetching the index.
#   2. The first fix replaced only the hostname. `/etc/apk/repositories` holds
#      `https://dl-cdn.alpinelinux.org/alpine/v3.21/main`, so that produced
#      `.../alpine/alpine/v3.21/main` and the identical misleading error.
#   3. The second was `for f in …; do [ -f "$f" ] && sed …; done`. When
#      `/etc/apk/repositories.d/` does not exist the glob stays literal, the
#      test is false, and the false test is the loop's exit status — so the
#      whole RUN step failed while having done its job correctly.
#
# ALPINE_MIRROR replaces the whole prefix including `/alpine`:
# `https://mirror.example.org/alpine`, not `https://mirror.example.org`.
set -eu

MIRROR=${ALPINE_MIRROR:-}
[ -n "$MIRROR" ] || exit 0

# Overridable so this can be exercised outside a container — see
# scripts/deployment.test.ts. The default is where apk actually reads from.
ROOT=${APK_ROOT:-/etc/apk}

found=0
for f in "$ROOT/repositories" "$ROOT"/repositories.d/*; do
  if [ -f "$f" ]; then
    sed -i "s|https://dl-cdn.alpinelinux.org/alpine|$MIRROR|g" "$f"
    found=1
  fi
done

# Loudly, rather than leaving the build to fail later with the same misleading
# message this whole script exists to prevent. If Alpine moves the file again,
# this is the line that says so.
if [ "$found" -ne 1 ]; then
  echo "alpine-mirror: no repository file under $ROOT; cannot apply ALPINE_MIRROR" >&2
  exit 1
fi
