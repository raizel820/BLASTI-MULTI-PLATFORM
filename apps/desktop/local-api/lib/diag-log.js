/**
 * diag-log — shared diagnostic file logger (BLASTI desktop).
 *
 * WHY: console output of a packaged Electron app is not persisted anywhere,
 * so intermittent login / "data loading failed" / sync issues could never be
 * diagnosed after the fact. This logger appends every auth/sync/data-relevant
 * event to a rolling file under the Electron userData directory:
 *
 *   <userData>/logs/local-api-diag.log   (rotated to .old at ~2 MB)
 *
 * Used by BOTH the local API (apps/desktop/local-api/index.js) and the main
 * process (apps/desktop/main.js) so the server-side and initial-sync views
 * land in one timeline that pairs with the renderer's persistent diagnostic
 * buffer (apps/web/src/lib/diag-log.ts).
 *
 * Best-effort by design: any failure here is swallowed — diagnostics must
 * never take the API down.
 */

let diagFilePath = null
try {
  const { app } = require('electron')
  if (app && typeof app.getPath === 'function') {
    const pathMod = require('path')
    const fs = require('fs')
    const logsDir = pathMod.join(app.getPath('userData'), 'logs')
    fs.mkdirSync(logsDir, { recursive: true })
    diagFilePath = pathMod.join(logsDir, 'local-api-diag.log')
    // Rotate at ~2 MB: current → .old
    try {
      const st = fs.statSync(diagFilePath)
      if (st.size > 2 * 1024 * 1024) {
        fs.renameSync(diagFilePath, diagFilePath + '.old')
      }
    } catch { /* first run — nothing to rotate */ }
  }
} catch { /* electron unavailable (tests/tools) — console only */ }

function diagLog(message) {
  const line = `[${new Date().toISOString()}] ${message}`
  console.log(line)
  if (diagFilePath) {
    try { require('fs').appendFileSync(diagFilePath, line + '\n') } catch { /* best effort */ }
  }
}

module.exports = { diagLog, diagFilePath }
