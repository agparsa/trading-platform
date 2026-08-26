# syntax=docker/dockerfile:1.7
FROM node:22-alpine AS base
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
RUN corepack enable && apk add --no-cache libc6-compat openssl
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/api/package.json ./apps/api/package.json
EXPOSE 4000
CMD ["node", "apps/api/dist/main.js"]
