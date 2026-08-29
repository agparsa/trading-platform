# syntax=docker/dockerfile:1.7
#
# Nginx, plus the one thing the stock image is missing and this deployment needs.
#
# `nginx:alpine` links against libssl but does not ship the `openssl` command,
# and the entrypoint below needs it to generate a stand-in certificate when no
# real one has been mounted yet. Installing it at container start would mean a
# network call on every boot, in the one container whose job is to be reachable.
# It goes in the image instead.
FROM nginx:1.27-alpine

RUN apk add --no-cache openssl

# Runs before Nginx starts: the stock entrypoint executes every .sh under
# /docker-entrypoint.d in sorted order.
COPY docker/nginx/entrypoint/ /docker-entrypoint.d/
RUN chmod +x /docker-entrypoint.d/*.sh

# Nginx's master process binds 80 and 443 and therefore starts as root; its
# workers drop to the unprivileged `nginx` user, which is what the stock image
# configures and what actually handles a request. This is the one service here
# that does not run wholly as a non-root user, and the reason is the ports.
