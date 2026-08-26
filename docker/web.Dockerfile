# syntax=docker/dockerfile:1.7
FROM node:22-alpine AS base
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
RUN pnpm build:packages && pnpm --filter @tp/web build

FROM node:22-alpine AS production
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /app/apps/web/public ./apps/web/public
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
