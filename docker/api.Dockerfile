# syntax=docker/dockerfile:1.7
FROM node:22-alpine AS base
# Where apk fetches from.
#
# Empty by default, which means Alpine's own CDN — correct nearly everywhere. It
# exists because on the network this was first deployed to, dl-cdn.alpinelinux.org
# answers on the host but fails intermittently from inside a container, and a
# build that dies on `apk add openssl` gives no hint that the package is fine and
# the route is not. Set ALPINE_MIRROR to a mirror that works from there.
ARG ALPINE_MIRROR=""
RUN if [ -n "$ALPINE_MIRROR" ]; then \
      sed -i "s|https://dl-cdn.alpinelinux.org|$ALPINE_MIRROR|g" /etc/apk/repositories 2>/dev/null || \
      sed -i "s|https://dl-cdn.alpinelinux.org|$ALPINE_MIRROR|g" /etc/apk/repositories.d/*.repo 2>/dev/null || true; \
    fi
RUN corepack enable && apk add --no-cache libc6-compat openssl
WORKDIR /app
COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml .npmrc ./
COPY tsconfig.base.json ./
COPY prisma ./prisma
COPY packages ./packages
COPY apps/api ./apps/api
# No fallback. `|| pnpm install` was here, and it meant a drifted lockfile
# silently installed different versions than the ones the test suite ran
# against — in the production image, with nothing to show for it. A stale
# lockfile is a build failure, not something to work around.
RUN pnpm install --frozen-lockfile
RUN pnpm exec prisma generate

FROM base AS development
ENV NODE_ENV=development
EXPOSE 4000
CMD ["sh", "-c", "pnpm --filter @tp/api dev"]

FROM base AS build
ENV NODE_ENV=production
RUN pnpm build:packages && pnpm --filter @tp/api build

FROM node:22-alpine AS production
# Where apk fetches from.
#
# Empty by default, which means Alpine's own CDN — correct nearly everywhere. It
# exists because on the network this was first deployed to, dl-cdn.alpinelinux.org
# answers on the host but fails intermittently from inside a container, and a
# build that dies on `apk add openssl` gives no hint that the package is fine and
# the route is not. Set ALPINE_MIRROR to a mirror that works from there.
ARG ALPINE_MIRROR=""
RUN if [ -n "$ALPINE_MIRROR" ]; then \
      sed -i "s|https://dl-cdn.alpinelinux.org|$ALPINE_MIRROR|g" /etc/apk/repositories 2>/dev/null || \
      sed -i "s|https://dl-cdn.alpinelinux.org|$ALPINE_MIRROR|g" /etc/apk/repositories.d/*.repo 2>/dev/null || true; \
    fi
RUN corepack enable && apk add --no-cache libc6-compat openssl
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/packages ./packages
COPY --from=build --chown=node:node /app/prisma ./prisma
COPY --from=build --chown=node:node /app/apps/api/dist ./apps/api/dist
COPY --from=build --chown=node:node /app/apps/api/package.json ./apps/api/package.json

# Runs as `node`, not root. A process that never needs to write outside its own
# working directory has no business being able to.
USER node

EXPOSE 4000

# Liveness only — it must not touch the database. A brief database blip would
# otherwise make the orchestrator kill every healthy replica at once, which is
# the last thing anybody wants during a database incident.
HEALTHCHECK --interval=15s --timeout=3s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.API_PORT||4000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/api/dist/main.js"]
