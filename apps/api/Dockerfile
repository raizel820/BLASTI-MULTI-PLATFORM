# ──────────────────────────────────────────────────────────────
# BLASTI API server image (@blasti/api)
# Build from the REPOSITORY ROOT (context = whole monorepo):
#   docker build -f apps/api/Dockerfile -t blasti-api .
# The ops/docker-compose.yml files do this automatically.
# ──────────────────────────────────────────────────────────────
FROM oven/bun:1.2-slim

WORKDIR /app

# 1) Workspace manifests only → dependency layer is cached between builds
COPY package.json bun.lock ./
COPY packages/db/package.json packages/db/
COPY packages/core/package.json packages/core/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/desktop/package.json apps/desktop/
COPY apps/mobile/package.json apps/mobile/
RUN bun install --frozen-lockfile

# 2) Sources needed by the API
COPY packages/db packages/db
COPY packages/core packages/core
COPY apps/api apps/api

# 3) Prisma client for the PostgreSQL schema
RUN cd packages/db && bunx prisma generate

ENV NODE_ENV=production
EXPOSE 3003

CMD ["sh", "-c", "cd apps/api && bun src/index.ts"]
