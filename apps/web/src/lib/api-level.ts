/**
 * APP API LEVEL — the API protocol version this app build speaks.
 * ─────────────────────────────────────────────────────────────────────────────
 * Sent with every update check (`/api/app-versions/check?...&apiLevel=N`) so
 * the server's COMPATIBILITY MAP (0.6.31) can answer:
 *   • can this app run against the current server API at all?
 *   • which functions need a newer app?
 *   • is the newest release server-only (no app update needed)?
 *
 * Bump in lockstep with CURRENT_SERVER_API_LEVEL in
 * apps/api/src/lib/api-compat.ts — each side records what it understands,
 * the server's compat evaluation does the rest.
 */
export const APP_API_LEVEL = 1
