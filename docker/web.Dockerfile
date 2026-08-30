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
RUN corepack enable && apk add --no-cache libc6-compat
WORKDIR /app
COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml .npmrc ./
COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps/web ./apps/web
# No fallback. `|| pnpm install` was here, and it meant a drifted lockfile
# silently installed different versions than the ones the test suite ran
# against — in the production image, with nothing to show for it. A stale
# lockfile is a build failure, not something to work around.
RUN pnpm install --frozen-lockfile

FROM base AS development
ENV NODE_ENV=development
EXPOSE 3000
CMD ["sh", "-c", "pnpm --filter @tp/web dev"]

FROM base AS build
ENV NODE_ENV=production

# Baked in at build time, because Next.js inlines NEXT_PUBLIC_* into the client
# bundle. Setting them at runtime changes nothing the browser ever sees, which
# is a mistake that produces a terminal talking to localhost in production and
# no error anywhere to say why.
ARG NEXT_PUBLIC_API_URL=http://localhost:4000/api/v1
ARG NEXT_PUBLIC_WS_URL=http://localhost:4000
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_WS_URL=$NEXT_PUBLIC_WS_URL

RUN pnpm build:packages && pnpm --filter @tp/web build

FROM node:22-alpine AS production
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=node:node /app/apps/web/public ./apps/web/public

USER node

EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/web/server.js"]
