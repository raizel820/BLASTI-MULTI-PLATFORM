#!/bin/bash
# Double-fork daemonization pattern for BLASTI services

(
  export DATABASE_URL="file:/home/z/my-project/packages/db/data/custom.db"
  export NEXTAUTH_SECRET="blast1-dev-s3cr3t-k3y-f0r-d3v3l0pm3nt-0nly"
  export CORS_ORIGIN="*"
  export INTERNAL_SECRET="blast1-internal-secret-dev"
  export NEXTAUTH_URL="http://localhost:3000/"

  # Start API on port 3003
  cd /home/z/my-project/apps/api
  bun src/index.ts > /tmp/api-server.log 2>&1 &
  API_PID=$!

  # Wait for API
  for i in $(seq 1 15); do
    if curl -s http://localhost:3003/health > /dev/null 2>&1; then
      echo "[$(date)] API ready (PID $API_PID)" >> /tmp/services.log
      break
    fi
    sleep 1
  done

  # Start Discovery on port 3010
  cd /home/z/my/z/my-project/mini-services/discovery-service 2>/dev/null || cd /home/z/my-project/mini-services/discovery-service
  bun run index.ts > /tmp/discovery-service.log 2>&1 &
  DISC_PID=$!
  echo "[$(date)] Discovery started (PID $DISC_PID)" >> /tmp/services.log

  # Start Next.js on port 3000
  cd /home/z/my-project/apps/web
  bun run dev > /tmp/next-dev.log 2>&1 &
  NEXT_PID=$!
  echo "[$(date)] Next.js started (PID $NEXT_PID)" >> /tmp/services.log

  # Wait for Next.js
  for i in $(seq 1 30); do
    if curl -s http://localhost:3000/ > /dev/null 2>&1; then
      echo "[$(date)] Next.js ready (PID $NEXT_PID)" >> /tmp/services.log
      break
    fi
    sleep 1
  done

  echo "[$(date)] ALL SERVICES READY - API:$API_PID Discovery:$DISC_PID Next:$NEXT_PID" >> /tmp/services.log
  echo "All BLASTI services running: API(3003) Web(3000) Discovery(3010)"

  # Keep daemon alive
  while true; do sleep 60; done
) &

# Exit immediately so the child detaches
exit 0