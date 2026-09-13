#!/bin/bash
# BLASTI sandbox/session entry — IDEMPOTENT + resource-safe.
# Health-gates every service so running it twice (or alongside `bun run dev`)
# never stacks duplicate stacks (the 100% CPU/RAM machine-freeze cause).
# Web dev server runs on the Node.js runtime with a capped heap
# (never `bun --bun` — see WEB_DEV_CRASH_AUDIT.md).

export DATABASE_URL="${DATABASE_URL:-file:/home/z/my-project/packages/db/data/custom.db}"
export NEXTAUTH_SECRET="${NEXTAUTH_SECRET:-blast1-dev-s3cr3t-k3y-f0r-d3v3l0pm3nt-0nly}"
export CORS_ORIGIN="${CORS_ORIGIN:-*}"
export INTERNAL_SECRET="${INTERNAL_SECRET:-blast1-internal-secret-dev}"
export NEXTAUTH_URL="${NEXTAUTH_URL:-http://localhost:3000/}"

if curl -sf -m 2 http://127.0.0.1:3003/health >/dev/null 2>&1; then
  echo "[start.sh] API already healthy on :3003 — skipping (no duplicate)"
else
  cd /home/z/my-project/apps/api
  bun src/index.ts > /tmp/api.log 2>&1 &
fi

if curl -sf -m 3 -o /dev/null http://127.0.0.1:3000/; then
  echo "[start.sh] Web already serving on :3000 — skipping (no duplicate)"
else
  cd /home/z/my-project/apps/web
  node ../../scripts/dev-web.cjs -p 3000 -H 127.0.0.1 > /tmp/web.log 2>&1 &
fi

# wait forever to keep the script alive
wait
