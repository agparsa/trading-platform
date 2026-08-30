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
COPY docker/alpine-mirror.sh /tmp/alpine-mirror.sh
RUN sh /tmp/alpine-mirror.sh && rm /tmp/alpine-mirror.sh
RUN corepack enable && apk add --no-cache libc6-compat openssl
WORKDIR /app
COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml .npmrc ./
COPY tsconfig.base.json ./
COPY prisma ./prisma
COPY packages ./packages
COPY apps/worker ./apps/worker
# No fallback. `|| pnpm install` was here, and it meant a drifted lockfile
# silently installed different versions than the ones the test suite ran
# against — in the production image, with nothing to show for it. A stale
# lockfile is a build failure, not something to work around.
RUN pnpm install --frozen-lockfile
RUN pnpm exec prisma generate

FROM base AS development
ENV NODE_ENV=development

CMD ["sh", "-c", "pnpm --filter @tp/worker dev"]

FROM base AS build
ENV NODE_ENV=production
RUN pnpm build:packages && pnpm --filter @tp/worker build

FROM node:22-alpine AS production
# Where apk fetches from.
#
# Empty by default, which means Alpine's own CDN — correct nearly everywhere. It
# exists because on the network this was first deployed to, dl-cdn.alpinelinux.org
# answers on the host but fails intermittently from inside a container, and a
# build that dies on `apk add openssl` gives no hint that the package is fine and
# the route is not. Set ALPINE_MIRROR to a mirror that works from there.
ARG ALPINE_MIRROR=""
COPY docker/alpine-mirror.sh /tmp/alpine-mirror.sh
RUN sh /tmp/alpine-mirror.sh && rm /tmp/alpine-mirror.sh
RUN corepack enable && apk add --no-cache libc6-compat openssl
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/packages ./packages
COPY --from=build --chown=node:node /app/prisma ./prisma
COPY --from=build --chown=node:node /app/apps/worker/dist ./apps/worker/dist
COPY --from=build --chown=node:node /app/apps/worker/package.json ./apps/worker/package.json

USER node

CMD ["node", "apps/worker/dist/main.js"]
