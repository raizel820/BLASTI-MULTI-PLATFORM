/**
 * BLASTI Desktop — .env loader (zero dependencies)
 *
 * WHY THIS EXISTS
 * Electron does NOT read .env files, and OS environment variables set on the
 * BUILD machine do not travel into the packaged installer. Until now the only
 * way to configure the cloud URL was to export BLASTI_CLOUD_URL in the shell
 * at RUNTIME — yet .env.example documented a ".env" workflow that silently
 * did nothing ("copy to .env and build" → the app still pointed at
 * localhost:3003). This loader makes that documented workflow real.
 *
 * WHAT IT LOADS (in order — first file that sets a var wins)
 *   1. <resources>\.env   packaged app only. Lives OUTSIDE app.asar, so it can
 *                         be edited AFTER installation (e.g.
 *                         %LOCALAPPDATA%\Programs\BLASTI\resources\.env on
 *                         Windows) to repoint the app without rebuilding.
 *   2. <app dir>\.env     development: apps/desktop/.env. Packaged: the copy
 *                         baked into app.asar at build time (same file the
 *                         developer had when running electron-builder).
 *
 * PRECEDENCE RULES
 *   - OS environment variables ALWAYS win: fill-only-unset, dotenv-style.
 *   - Therefore: OS env  >  resources\.env  >  bundled .env  >  built-in defaults.
 *
 * PARSER NOTES (kept deliberately simple and predictable)
 *   - UTF-8 BOM stripped; both LF and CRLF line endings accepted (Windows).
 *   - Full-line  #  comments and blank lines ignored.
 *   - Optional  export  prefix accepted.
 *   - One pair of surrounding quotes stripped ("…" or '…'); backslashes are
 *     NEVER processed so Windows paths like "C:\Users\me" stay literal.
 *   - Inline comments are NOT stripped (a # inside a value stays part of it).
 *   - Values are never logged — this file may hold secrets (NEXTAUTH_SECRET).
 *
 * Usage (main.js, before ANY code reads BLASTI_* variables):
 *   const { loadDesktopEnv } = require('./load-env');
 *   loadDesktopEnv({ isPackaged: app.isPackaged });
 */

'use strict';

const fs = require('fs');
const path = require('path');

/** Parse .env text into a plain object. Pure function — exported for tests. */
function parseEnvFile(text) {
  const vars = {};
  if (!text) return vars;
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // strip UTF-8 BOM
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    let body = line;
    if (body.startsWith('export ') || body.startsWith('export\t')) {
      body = body.slice(6).trim();
    }
    const eq = body.indexOf('=');
    if (eq <= 0) continue; // no '=' or empty key → skip silently
    const key = body.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = body.slice(eq + 1).trim();
    if (value.length >= 2) {
      const first = value[0];
      const last = value[value.length - 1];
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
        value = value.slice(1, -1);
      }
    }
    vars[key] = value;
  }
  return vars;
}

/** Read + parse an env file; null when missing/unreadable/not a regular file. */
function readEnvVars(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const st = fs.statSync(filePath);
    if (!st.isFile() || st.size > 1024 * 1024) return null; // sanity cap: 1 MB
    return parseEnvFile(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null; // unreadable .env must never crash startup
  }
}

/**
 * Fill process.env from the .env candidates. Existing (non-empty) OS
 * environment variables are never overwritten.
 * @param {{ isPackaged?: boolean, verbose?: boolean }} [opts]
 */
function loadDesktopEnv(opts) {
  const isPackaged = !!(opts && opts.isPackaged);
  const verbose = opts ? opts.verbose !== false : true;

  const candidates = [];
  if (isPackaged && process.resourcesPath) {
    candidates.push({
      file: path.join(process.resourcesPath, '.env'),
      why: 'installed resources (editable after install)',
    });
  }
  candidates.push({ file: path.join(__dirname, '.env'), why: 'app directory' });

  const loaded = [];
  let applied = 0;

  for (const { file, why } of candidates) {
    const vars = readEnvVars(file);
    if (!vars) continue;
    const keys = Object.keys(vars);
    const filled = [];
    for (const k of keys) {
      if (process.env[k] === undefined || process.env[k] === '') {
        process.env[k] = vars[k];
        filled.push(k);
        applied++;
      }
    }
    loaded.push({ file, why, total: keys.length, filled });
    if (verbose) {
      console.log(
        `[BLASTI Desktop] .env (${why}): ${file} — ${keys.length} var(s) in file, ${filled.length} applied [${filled.join(', ') || '-'}]`
      );
    }
  }

  if (verbose && loaded.length === 0) {
    console.log('[BLASTI Desktop] no .env found — using OS environment + built-in defaults');
  }

  return { loaded, applied };
}

module.exports = { parseEnvFile, readEnvVars, loadDesktopEnv };
