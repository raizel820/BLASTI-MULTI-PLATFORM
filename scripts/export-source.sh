#!/usr/bin/env bash
# =====================================================================
# BLASTI — clean source exporter
# =====================================================================
# Produces a small, share-ready ZIP of the app source — WITHOUT:
#   • .git/                 (the history blob — this is what made the
#                            sandbox download exceed 120 MB)
#   • node_modules/         (rebuilt with: bun install)
#   • .next/ + build output (rebuilt with: bun run build / next build)
#   • logs, caches, dev junk
#
# Usage:
#   bash scripts/export-source.sh                 # -> ../blasti-source-v<version>.zip
#   bash scripts/export-source.sh /tmp/out.zip    # explicit output path
#
# When run inside the git repo it uses `git archive` (only files git
# tracks — nothing ignored leaks in). Outside a repo it falls back to
# `zip -r` with explicit excludes.
# =====================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

version="$(grep -m1 '"version"' package.json | sed 's/[^0-9.]//g')"
out="${1:-$ROOT/../blasti-source-v${version:-x}.zip}"

# never write the zip INSIDE the repo — the next export would zip the zip
case "$(cd "$(dirname "$out")" && pwd)" in
  "$ROOT") die="output inside the repo would be zipped next time — give a path outside: $0 /path/out.zip" ;;
esac
[ -z "${die:-}" ] || { printf '[export] FAIL  %s\n' "$die" >&2; exit 1; }

if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  printf '[export] git archive -> %s\n' "$out"
  git archive --format=zip -o "$out" HEAD
else
  printf '[export] no git repo — zip with excludes -> %s\n' "$out"
  zip -rq "$out" . \
    -x '*/.git/*' '.git/*' \
    -x '*/node_modules/*' 'node_modules/*' \
    -x '*/.next/*' '.next/*' \
    -x '*.log' 'dev.log' \
    -x '*/dist/*' '*/build/*' '*/out/*' \
    -x '*/.turbo/*' '*/.cache/*' '*/.gradle/*'
fi

size="$(du -h "$out" | cut -f1)"
printf '[export]  ok   %s (%s)\n' "$out" "$size"
