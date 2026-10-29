/**
 * BLASTI embedded PostgreSQL boot (sandbox recipe, rebuilt per worklog R-6).
 *
 * REPO COPY — durable across sandbox resets. Runtime location is
 * /home/z/pg-embedded/boot-pg.mjs (outside the repo). To recreate the runtime
 * after a wipe:
 *   mkdir -p /home/z/pg-embedded && cd /home/z/pg-embedded
 *   echo '{"name":"pg-embedded","private":true}' > package.json
 *   bun add embedded-postgres@18.4.0-beta.17
 *   cd node_modules/@embedded-postgres/linux-x64 && node scripts/hydrate-symlinks.js
 *   cp /home/z/my-project/scripts/ops-embedded-pg-boot.mjs ../../../boot-pg.mjs
 *   cd /home/z/pg-embedded && bun boot-pg.mjs
 * (bun blocks the package postinstall → hydrate-symlinks.js must be run by hand;
 *  the package ships ONLY initdb/pg_ctl/postgres — no psql — hence Bun.SQL below.)
 *
 * Idempotent:
 *  - already-running probe (2s race) → exit 0
 *  - stale postmaster.pid cleanup (only when no live process holds it)
 *  - initdb -U blasti, scram-sha-256, UTF8 / C locale (first boot only)
 *  - managed conf block: listen 127.0.0.1:5432, unix socket dir /tmp, jit=off
 *  - DETACHED spawn (survives this script exiting)
 *  - ensureDatabase('blasti') on BOTH paths (fresh init + already-running)
 *
 * Used by /home/z/my-project/daemon-start.sh.
 */
import { existsSync, readFileSync, writeFileSync, appendFileSync, unlinkSync, openSync } from "fs";
import { execFileSync, spawn } from "child_process";
import net from "net";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NATIVE = path.join(__dirname, "node_modules", "@embedded-postgres", "linux-x64", "native");
const DATA_DIR = process.env.PG_DATA_DIR || path.join(__dirname, "data");
const PORT = Number(process.env.PG_PORT || 5432);
const USER = "blasti";
const PASSWORD = "blasti";
const DB_NAME = "blasti";

function log(...args) {
  console.log(`[boot-pg ${new Date().toISOString()}]`, ...args);
}

function probePort(port, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const done = (ok) => {
      try { socket.destroy(); } catch {}
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.on("connect", () => done(true));
    socket.on("timeout", () => done(false));
    socket.on("error", () => done(false));
  });
}

async function isRunning() {
  // Two probes to lose the race against a server that is still starting.
  if (await probePort(PORT, 2000)) return true;
  await new Promise((r) => setTimeout(r, 300));
  return probePort(PORT, 2000);
}

function clearStalePid() {
  const pidFile = path.join(DATA_DIR, "postmaster.pid");
  if (!existsSync(pidFile)) return;
  try {
    const pid = Number.parseInt(readFileSync(pidFile, "utf8").split("\n")[0].trim(), 10);
    if (Number.isFinite(pid) && pid > 0) {
      try {
        process.kill(pid, 0); // existence probe — alive → leave everything alone
        log(`postmaster pid ${pid} is alive — leaving pid file alone`);
        return;
      } catch {
        log(`stale postmaster.pid (pid ${pid} dead) — removing`);
      }
    }
  } catch (e) {
    log(`could not parse postmaster.pid (${e.message}) — removing`);
  }
  try { unlinkSync(pidFile); } catch {}
}

function initDbIfNeeded() {
  if (existsSync(path.join(DATA_DIR, "PG_VERSION"))) return false;
  const pwFile = path.join(__dirname, ".pg-pwfile");
  writeFileSync(pwFile, PASSWORD + "\n");
  try {
    log(`initializing cluster at ${DATA_DIR}`);
    execFileSync(
      path.join(NATIVE, "bin", "initdb"),
      [
        "-D", DATA_DIR,
        "-U", USER,
        `--pwfile=${pwFile}`,
        "-E", "UTF8",
        "--locale=C",
        "--auth-local=scram-sha-256",
        "--auth-host=scram-sha-256",
      ],
      { stdio: "inherit", env: { ...process.env, LC_ALL: "C" } },
    );
    return true;
  } finally {
    try { unlinkSync(pwFile); } catch {}
  }
}

function writeConf() {
  const conf = path.join(DATA_DIR, "postgresql.conf");
  let text = existsSync(conf) ? readFileSync(conf, "utf8") : "";
  const begin = "# --- BLASTI MANAGED BLOCK BEGIN ---";
  const end = "# --- BLASTI MANAGED BLOCK END ---";
  const b = text.indexOf(begin);
  const e = text.indexOf(end);
  if (b !== -1 && e !== -1) text = text.slice(0, b) + text.slice(e + end.length);
  const block = `${begin}
listen_addresses = '127.0.0.1'
port = ${PORT}
unix_socket_directories = '/tmp'
jit = off
${end}
`;
  writeFileSync(conf, text.trimEnd() + "\n\n" + block + "\n");
}

function startDetached() {
  const out = openSync(path.join(__dirname, "postgres.log"), "a");
  const child = spawn(
    path.join(NATIVE, "bin", "pg_ctl"),
    ["-D", DATA_DIR, "-l", path.join(__dirname, "postgres.log"), "-o", "-k /tmp", "start"],
    { detached: true, stdio: ["ignore", out, out], env: { ...process.env, LC_ALL: "C" } },
  );
  child.unref();
}

async function waitReady(timeoutSec = 30) {
  for (let i = 0; i < timeoutSec; i++) {
    if (await probePort(PORT, 1500)) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

// NOTE: the embedded-postgres package ships ONLY initdb/pg_ctl/postgres (no
// psql), so DB creation uses Bun's SQL client (daemon-start.sh runs this file
// with bun). Bun 1.3.x requires a FULL postgres:// URL — an options-object
// opens its SQLITE adapter instead.
async function ensureDatabase() {
  const SQL = globalThis.Bun?.SQL;
  if (!SQL) {
    throw new Error("this script must be run with BUN (bun boot-pg.mjs) — no SQL client under node");
  }
  const sql = new SQL(`postgres://${USER}:${PASSWORD}@127.0.0.1:${PORT}/postgres`);
  try {
    const exists = await sql`SELECT 1 FROM pg_database WHERE datname = ${DB_NAME}`;
    if (exists.length > 0) {
      log(`database ${DB_NAME} already exists`);
    } else {
      await sql.unsafe(`CREATE DATABASE "${DB_NAME}" OWNER "${USER}"`);
      log(`database ${DB_NAME} created`);
    }
  } finally {
    try { await sql.end(); } catch {}
  }
}

async function main() {
  if (await isRunning()) {
    log(`PostgreSQL already accepting connections on :${PORT} — nothing to do`);
    await ensureDatabase();
    return;
  }
  clearStalePid();
  initDbIfNeeded();
  writeConf();
  startDetached();

  if (!(await waitReady(30))) {
    console.error("[boot-pg] PostgreSQL did NOT become ready within 30s — see postgres.log");
    process.exit(1);
  }
  log("PostgreSQL ready");
  await ensureDatabase();
}

main().catch((e) => {
  console.error("[boot-pg] FAILED:", e);
  process.exit(1);
});
