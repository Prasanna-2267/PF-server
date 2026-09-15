# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS base

RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*

FROM base AS build

WORKDIR /app

COPY package.json package-lock.json ./
COPY prisma.config.ts ./
COPY prisma ./prisma

# Prisma CLI is build/migration tooling. It is intentionally available only in
# this stage and is never copied into the production runtime image.
RUN DIRECT_URL=postgresql://build:build@127.0.0.1:5432/build npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY scripts ./scripts

RUN DIRECT_URL=postgresql://build:build@127.0.0.1:5432/build npm run build

FROM base AS runtime

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4000

WORKDIR /app

COPY package.json package-lock.json ./

# Generated Prisma client code is copied from the build stage. Excluding dev
# and optional peer dependencies keeps the Prisma CLI/config toolchain and its
# deepmerge-ts advisory out of the application runtime.
RUN npm ci --omit=dev --omit=optional --ignore-scripts \
    && npm cache clean --force

COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/assets ./assets

USER node

EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4000/health/ready').then((response) => { if (!response.ok) process.exit(1); }).catch(() => process.exit(1));"

CMD ["node", "dist/src/index.js"]
