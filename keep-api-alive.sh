#!/bin/bash
export DATABASE_URL="file:/home/z/my-project/packages/db/data/custom.db"
export NEXTAUTH_SECRET="blast1-dev-s3cr3t-k3y-f0r-d3v3l0pm3nt-0nly"
export CORS_ORIGIN="*"
export INTERNAL_SECRET="blast1-internal-secret-dev"

while true; do
  echo "[$(date)] Starting API server..."
  cd /home/z/my-project/apps/api && bun run src/index.ts 2>&1
  EXIT_CODE=$?
  echo "[$(date)] API exited with code $EXIT_CODE, restarting in 3s..."
  sleep 3
done
