#!/usr/bin/env bash
#
# BLASTI Local API & Sync Engine — Test Runner
#
# Usage:
#   ./run-tests.sh            # Run all tests
#   ./run-tests.sh --db-only  # Run only database tests
#   ./run-tests.sh --sync-only # Run only sync tests
#   ./run-tests.sh --api-only # Run only API tests
#   ./run-tests.sh --skip-api # Skip API tests (no server startup)
#
# Environment:
#   BLASTI_TEST_API_PORT  — port for the local API (default: 3081)
#   BLASTI_TEST_USERNAME  — login username
#   BLASTI_TEST_PASSWORD  — login password
#   BLASTI_LOCAL_DB_DIR   — directory for the test SQLite file
#   NODE                  — Node.js binary (default: node)

set -euo pipefail

# ─── Configuration ────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
API_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DESKTOP_DIR="$(cd "$API_DIR/.." && pwd)"

NODE="${NODE:-node}"
TEST_PORT="${BLASTI_TEST_API_PORT:-3081}"
DB_ONLY=false
SYNC_ONLY=false
API_ONLY=false
SKIP_API=false

# Parse arguments
for arg in "$@"; do
  case "$arg" in
    --db-only)    DB_ONLY=true ;;
    --sync-only)  SYNC_ONLY=true ;;
    --api-only)   API_ONLY=true ;;
    --skip-api)   SKIP_API=true ;;
    --help|-h)
      echo "Usage: $0 [--db-only] [--sync-only] [--api-only] [--skip-api] [--help]"
      exit 0
      ;;
  esac
done

# ─── Colors ───────────────────────────────────────────────────────────────────

RED='\033[31m'
GREEN='\033[32m'
YELLOW='\033[33m'
CYAN='\033[36m'
BOLD='\033[1m'
RESET='\033[0m'

# ─── Results Tracking ─────────────────────────────────────────────────────────

TOTAL_RUN=0
TOTAL_PASS=0
TOTAL_FAIL=0
TEST_RESULTS=()

# ─── Setup ────────────────────────────────────────────────────────────────────

echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo -e "${BOLD}${CYAN}  BLASTI Local API & Sync Engine — Test Runner${RESET}"
echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo ""

# Set test environment
export NODE_ENV=test

# Set a test-specific DB directory to avoid polluting production data
export BLASTI_LOCAL_DB_DIR="${BLASTI_LOCAL_DB_DIR:-$HOME/.blasti/test-local-api}"

echo -e "${CYAN}Environment:${RESET}"
echo "  NODE_ENV          = $NODE_ENV"
echo "  BLASTI_LOCAL_DB_DIR = $BLASTI_LOCAL_DB_DIR"
echo "  Test port         = $TEST_PORT"
echo "  Node binary       = $NODE"
echo ""

# ─── Helper Functions ─────────────────────────────────────────────────────────

API_PID=""

start_local_api() {
  if [ "$SKIP_API" = true ]; then
    echo -e "${YELLOW}Skipping local API startup (--skip-api)${RESET}"
    return
  fi

  echo -e "${CYAN}Starting local API on port $TEST_PORT...${RESET}"

  # Start the local API as a background process
  # We use a small launcher script that imports and starts the API
  LAUNCHER=$(mktemp /tmp/blasti-test-api-XXXXXX.js)
  cat > "$LAUNCHER" << 'LAUNCHER_EOF'
const path = require('path');
// The launcher lives in /tmp, so a bare require('./index') would resolve
// against /tmp — use the absolute entry injected via BLASTI_API_ENTRY.
const entry = process.env.BLASTI_API_ENTRY || path.join(process.cwd(), 'index.js');
const localApi = require(entry);
const port = parseInt(process.env.BLASTI_TEST_API_PORT || '3081', 10);
localApi.startLocalApi(null, port).then((result) => {
  console.log('[TestLauncher] Local API started on port', result.port);
  // Keep process alive
  setInterval(() => {}, 60000);
}).catch((err) => {
  console.error('[TestLauncher] Failed to start local API:', err.message);
  process.exit(1);
});
LAUNCHER_EOF

  # Start the launcher in the background
  (cd "$API_DIR" && BLASTI_API_ENTRY="$API_DIR/index.js" BLASTI_TEST_API_PORT=$TEST_PORT $NODE "$LAUNCHER" &>/tmp/blasti-test-api.log) &
  API_PID=$!

  # Wait for the API to be ready
  echo -n "  Waiting for API to be ready"
  MAX_WAIT=30
  WAITED=0
  while [ $WAITED -lt $MAX_WAIT ]; do
    if curl -s "http://127.0.0.1:$TEST_PORT/health" &>/dev/null; then
      echo ""
      echo -e "  ${GREEN}Local API is ready (PID: $API_PID)${RESET}"
      return
    fi
    echo -n "."
    sleep 1
    WAITED=$((WAITED + 1))
  done
  echo ""
  echo -e "  ${RED}Local API failed to start after ${MAX_WAIT}s${RESET}"
  echo -e "  ${RED}Check log: /tmp/blasti-test-api.log${RESET}"
  if [ -f /tmp/blasti-test-api.log ]; then
    tail -20 /tmp/blasti-test-api.log
  fi
  exit 1
}

stop_local_api() {
  if [ -n "$API_PID" ] && [ "$API_PID" != "" ]; then
    echo -e "${CYAN}Stopping local API (PID: $API_PID)...${RESET}"
    kill "$API_PID" 2>/dev/null || true
    wait "$API_PID" 2>/dev/null || true
    API_PID=""
  fi
  # Also kill any process on the test port
  if command -v lsof &>/dev/null; then
    PID_ON_PORT=$(lsof -ti tcp:"$TEST_PORT" 2>/dev/null || true)
    if [ -n "$PID_ON_PORT" ]; then
      echo -e "${YELLOW}Killing leftover process on port $TEST_PORT: $PID_ON_PORT${RESET}"
      kill $PID_ON_PORT 2>/dev/null || true
    fi
  fi
  # Clean up temp launcher
  rm -f /tmp/blasti-test-api-*.js 2>/dev/null || true
}

run_test_file() {
  local name="$1"
  local file="$2"
  local start_time
  start_time=$(date +%s%N 2>/dev/null || date +%s)

  echo -e "\n${BOLD}${CYAN}▶ Running: $name${RESET}"
  echo -e "  File: $file"
  echo ""

  TOTAL_RUN=$((TOTAL_RUN + 1))

  if [ ! -f "$file" ]; then
    echo -e "  ${RED}ERROR: Test file not found: $file${RESET}"
    TEST_RESULTS+=("FAIL:$name:file not found")
    TOTAL_FAIL=$((TOTAL_FAIL + 1))
    return 1
  fi

  # Run the test
  set +e
  (cd "$SCRIPT_DIR" && $NODE "$file")
  EXIT_CODE=$?
  set -e

  local end_time
  end_time=$(date +%s%N 2>/dev/null || date +%s)
  # Calculate duration (seconds, with millisecond precision if nanoseconds available)
  local duration_ms=0
  if [[ "$start_time" =~ ^[0-9]+$ ]] && [[ "$end_time" =~ ^[0-9]+$ ]] && [ ${#start_time} -gt 10 ]; then
    duration_ms=$(( (end_time - start_time) / 1000000 ))
  fi

  if [ $EXIT_CODE -eq 0 ]; then
    echo -e "\n  ${GREEN}✓ $name passed${RESET} (${duration_ms}ms)"
    TEST_RESULTS+=("PASS:$name")
    TOTAL_PASS=$((TOTAL_PASS + 1))
  else
    echo -e "\n  ${RED}✗ $name failed (exit code: $EXIT_CODE)${RESET} (${duration_ms}ms)"
    TEST_RESULTS+=("FAIL:$name:exit=$EXIT_CODE")
    TOTAL_FAIL=$((TOTAL_FAIL + 1))
  fi

  return $EXIT_CODE
}

# ─── Cleanup ──────────────────────────────────────────────────────────────────

cleanup() {
  echo ""
  echo -e "${CYAN}Cleaning up...${RESET}"
  stop_local_api
  echo -e "${CYAN}Cleanup complete.${RESET}"
}

trap cleanup EXIT

# ─── Run Tests ────────────────────────────────────────────────────────────────

# Determine which tests to run
RUN_DB=true
RUN_SYNC=true
RUN_API=true

if [ "$DB_ONLY" = true ]; then
  RUN_SYNC=false
  RUN_API=false
fi
if [ "$SYNC_ONLY" = true ]; then
  RUN_DB=false
  RUN_API=false
fi
if [ "$API_ONLY" = true ]; then
  RUN_DB=false
  RUN_SYNC=false
fi

# ── Database Layer Tests ──
if [ "$RUN_DB" = true ]; then
  run_test_file "Database Layer" "$SCRIPT_DIR/test-db.js" || true
fi

# ── Schema Lifecycle Tests (controlled non-destructive migrations) ──
if [ "$RUN_DB" = true ]; then
  run_test_file "Schema Lifecycle" "$SCRIPT_DIR/test-schema-migrations.js" || true
fi

# ── Sync Engine Tests ──
if [ "$RUN_SYNC" = true ]; then
  run_test_file "Sync Engine" "$SCRIPT_DIR/test-sync.js" || true
fi

# ── Local API Integration Tests ──
if [ "$RUN_API" = true ]; then
  start_local_api
  export BLASTI_TEST_API_PORT=$TEST_PORT
  run_test_file "Local API Integration" "$SCRIPT_DIR/test-local-api.js" || true
fi

# ─── Final Report ─────────────────────────────────────────────────────────────

echo ""
echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo -e "${BOLD}${CYAN}  Final Report${RESET}"
echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo ""

for result in "${TEST_RESULTS[@]}"; do
  STATUS="${result%%:*}"
  REST="${result#*:}"
  if [ "$STATUS" = "PASS" ]; then
    echo -e "  ${GREEN}✓ PASS${RESET}  $REST"
  else
    echo -e "  ${RED}✗ FAIL${RESET}  $REST"
  fi
done

echo ""
echo -e "  ${BOLD}Total:${RESET}  $TOTAL_RUN test suites"
echo -e "  ${GREEN}${BOLD}Passed:${RESET} $TOTAL_PASS"
echo -e "  ${RED}${BOLD}Failed:${RESET} $TOTAL_FAIL"
echo ""

if [ $TOTAL_FAIL -gt 0 ]; then
  echo -e "${RED}${BOLD}Some tests failed!${RESET}"
  exit 1
else
  echo -e "${GREEN}${BOLD}All tests passed!${RESET}"
  exit 0
fi
