# ──────────────────────────────────────────────────────────────
# BLASTI web app image (@blasti/web — Next.js, SSR mode)
# Build from the REPOSITORY ROOT (context = whole monorepo):
#   docker build -f apps/web/Dockerfile -t blasti-web .
# ──────────────────────────────────────────────────────────────

# ── 1. dependencies ──────────────────────────────────────────
FROM oven/bun:1.2-slim AS deps
WORKDIR /app
COPY package.json bun.lock ./
COPY packages/db/package.json packages/db/
COPY packages/core/package.json packages/core/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/desktop/package.json apps/desktop/
COPY apps/mobile/package.json apps/mobile/
RUN bun install --frozen-lockfile

# ── 2. build ─────────────────────────────────────────────────
FROM deps AS build
COPY . .

# NEXT_PUBLIC_* values are BAKED INTO the JS bundle at build time.
#   • Empty (default) → the browser calls the API same-origin via relative
#     URLs — the standard single-domain setup behind Caddy on the OVH VPS.
#   • To serve the web app from a DIFFERENT domain than the API, build with:
#     docker build --build-arg NEXT_PUBLIC_API_URL=https://api.your-domain.tld …
ARG NEXT_PUBLIC_API_URL=""
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}
ENV NEXT_TELEMETRY_DISABLED=1
# The web app never touches the database directly; a placeholder satisfies
# any tooling that reads DATABASE_URL while building.
ENV DATABASE_URL="postgresql://placeholder@localhost:5432/placeholder"

RUN cd apps/web && bun run build

# ── 3. runtime ───────────────────────────────────────────────
FROM oven/bun:1.2-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

COPY package.json bun.lock ./
COPY packages/db/package.json packages/db/
COPY packages/core/package.json packages/core/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/desktop/package.json apps/desktop/
COPY apps/mobile/package.json apps/mobile/
RUN bun install --frozen-lockfile --production

COPY --from=build /app/apps/web/.next apps/web/.next
COPY --from=build /app/apps/web/public apps/web/public
COPY apps/web/next.config.ts apps/web/next.config.ts

EXPOSE 3000
CMD ["sh", "-c", "cd apps/web && bun run start"]
