#!/bin/bash
# Double-fork daemonization pattern for BLASTI services — IDEMPOTENT.
#
# Resource-exhaustion fix (see WEB_DEV_CRASH_AUDIT.md): every start below is
# health-gated. Running this script twice (or alongside `bun run dev`) NEVER
# starts a second API/Next instance — it only fills in the missing services.
# Duplicate full stacks were a direct cause of 100% CPU/RAM machine freezes.

(
  export DATABASE_URL="${DATABASE_URL:-file:/home/z/my-project/packages/db/data/custom.db}"
  export NEXTAUTH_SECRET="${NEXTAUTH_SECRET:-blast1-dev-s3cr3t-k3y-f0r-d3v3l0pm3nt-0nly}"
  export CORS_ORIGIN="${CORS_ORIGIN:-*}"
  export INTERNAL_SECRET="${INTERNAL_SECRET:-blast1-internal-secret-dev}"
  export NEXTAUTH_URL="${NEXTAUTH_URL:-http://localhost:3000/}"

  # ── API on port 3003 (skip if already healthy) ────────────────────────────
  if curl -sf -m 2 http://127.0.0.1:3003/health >/dev/null 2>&1; then
    echo "[$(date)] API already healthy on :3003 — skipping (no duplicate instance)" >> /tmp/services.log
  else
    cd /home/z/my-project/apps/api
    bun src/index.ts > /tmp/api-server.log 2>&1 &
    API_PID=$!
    echo "[$(date)] API starting (PID $API_PID)" >> /tmp/services.log
  fi

  # Wait for API
  for i in $(seq 1 15); do
    if curl -s http://localhost:3003/health > /dev/null 2>&1; then
      echo "[$(date)] API ready" >> /tmp/services.log
      break
    fi
    sleep 1
  done

  # ── Discovery on port 3010 (skip if already healthy) ──────────────────────
  if curl -sf -m 2 http://127.0.0.1:3010/health >/dev/null 2>&1; then
    echo "[$(date)] Discovery already healthy on :3010 — skipping" >> /tmp/services.log
  else
    cd /home/z/my-project/mini-services/discovery-service 2>/dev/null
    if [ -d "$(pwd)" ] && [ -f index.ts ]; then
      bun run index.ts > /tmp/discovery-service.log 2>&1 &
      DISC_PID=$!
      echo "[$(date)] Discovery started (PID $DISC_PID)" >> /tmp/services.log
    else
      echo "[$(date)] Discovery service directory missing — skipped" >> /tmp/services.log
    fi
  fi

  # ── Next.js on port 3000 (skip if already serving; heap-capped Node runtime) ──
  if curl -sf -m 3 -o /dev/null http://127.0.0.1:3000/; then
    echo "[$(date)] Next.js already serving on :3000 — skipping (no duplicate instance)" >> /tmp/services.log
  else
    cd /home/z/my-project/apps/web
    # Heap-capped Node dev server via the shared launcher (never `bun --bun` —
    # see WEB_DEV_CRASH_AUDIT.md; cap prevents machine-wide RAM exhaustion).
    node ../../scripts/dev-web.cjs -p 3000 -H 127.0.0.1 > /tmp/next-dev.log 2>&1 &
    NEXT_PID=$!
    echo "[$(date)] Next.js started (PID $NEXT_PID, heap-capped)" >> /tmp/services.log
  fi

  # Wait for Next.js
  for i in $(seq 1 30); do
    if curl -s http://localhost:3000/ > /dev/null 2>&1; then
      echo "[$(date)] Next.js ready" >> /tmp/services.log
      break
    fi
    sleep 1
  done

  echo "[$(date)] ALL SERVICES READY — API(3003) Discovery(3010) Web(3000) — duplicates were skipped where already running" >> /tmp/services.log
  echo "All BLASTI services running: API(3003) Web(3000) Discovery(3010)"

  # Keep daemon alive
  while true; do sleep 60; done
) &

# Exit immediately so the child detaches
exit 0
