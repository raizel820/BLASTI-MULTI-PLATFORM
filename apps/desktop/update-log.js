/**
 * update-log — dedicated update-pipeline diagnostic logger (BLASTI desktop, 0.6.52).
 *
 * WHY: the installer / delta-update failures ("app closes and nothing happens",
 * "only full installers, never deltas") could not be diagnosed from the field
 * because the decision points lived in TWO processes (renderer store + main
 * process) and NONE of them recorded WHY a delta was refused or which installer
 * launcher leg failed. console.* lines reach main.log only while the app is
 * alive, and the waiter/self-heal runs happen OUTSIDE the app lifecycle.
 *
 * This logger appends every update-relevant event to a rolling file under the
 * Electron userData directory, mirroring the diag-log pattern:
 *
 *   <userData>/logs/update-diag.log   (rotated to .old at ~2 MB)
 *
 * Line format — structured, greppable, one event per line:
 *
 *   [ISO] [STAGE] message | key=value key=value
 *
 * Stages: CHECK · DECISION · DOWNLOAD · VERIFY · INSTALL · INSTALL-LEG ·
 *         DELTA · SELF-HEAL · LEGACY · MANUAL
 *
 * Used by apps/desktop/main.js for every `updates:*` IPC handler and both
 * boot-time self-heals; surfaced to the renderer through the
 * 'get-recent-diag-logs' IPC (update tail) so the remote-logger flush carries
 * it into the SAME cloud vault as the renderer's own update decisions.
 *
 * Best-effort by design: any failure here is swallowed — diagnostics must
 * never take the updater (or the app) down.
 */

let diagFilePath = null;
try {
  const { app } = require('electron');
  if (app && typeof app.getPath === 'function') {
    const pathMod = require('path');
    const fs = require('fs');
    const logsDir = pathMod.join(app.getPath('userData'), 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    diagFilePath = pathMod.join(logsDir, 'update-diag.log');
    // Rotate at ~2 MB: current → .old
    try {
      const st = fs.statSync(diagFilePath);
      if (st.size > 2 * 1024 * 1024) {
        fs.renameSync(diagFilePath, diagFilePath + '.old');
      }
    } catch { /* first run — nothing to rotate */ }
  }
} catch { /* electron unavailable (tests/tools) — console only */ }

/**
 * Append one structured update event.
 *
 * @param {string} stage  pipeline stage (CHECK / DECISION / DOWNLOAD / VERIFY /
 *                        INSTALL / INSTALL-LEG / DELTA / SELF-HEAL / MANUAL…)
 * @param {string} message  human-readable event line
 * @param {Record<string, unknown>} [extra]  structured key=value pairs (JSON-
 *                        safe scalars; objects are inlined compactly)
 */
function updateLog(stage, message, extra) {
  let line = `[${new Date().toISOString()}] [${stage}] ${message}`;
  if (extra && typeof extra === 'object') {
    try {
      const parts = Object.entries(extra)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => {
          if (typeof v === 'object' && v !== null) {
            return `${k}=${JSON.stringify(v)}`;
          }
          return `${k}=${String(v)}`;
        });
      if (parts.length) line += ` | ${parts.join(' ')}`;
    } catch { /* extra serialization must never break the log */ }
  }
  console.log(`[BLASTI UpdateLog] ${line}`);
  if (diagFilePath) {
    try { require('fs').appendFileSync(diagFilePath, line + '\n'); } catch { /* best effort */ }
  }
}

module.exports = { updateLog, updateLogFilePath: diagFilePath };
