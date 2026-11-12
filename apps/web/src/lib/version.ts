/**
 * BLASTI web bundle version — SINGLE SOURCE OF TRUTH for UI version labels.
 *
 * WHY THIS EXISTS (the "Version 1.0" bug): the i18n `version` key and several
 * fallbacks used to hardcode "1.0" while the real release train was 0.6.x,
 * so the landing page, login/register footers, the settings About row and the
 * admin dashboard all lied about the running version.
 *
 * This constant is REWRITTEN by `bun run version:set X.Y.Z`
 * (scripts/version-set.js) together with the five package.json files and the
 * Android gradle versionName — one command keeps every surface in sync.
 *
 * Consumers:
 *  - auth footers (landing / login / register)   → t('version').replace('{v}', …)
 *  - customer settings About row                 → fallback when the native
 *    probe returns null (plain browser / Electron)
 *  - admin dashboard "platform version" row
 *  - kiosk / TV-board device registration payloads (appVersion field)
 *
 * The REAL native version on a phone still comes from the Capacitor shell
 * (lib/app-version.ts → Device.getInfo().appVersion) — this constant is the
 * bundle-side fallback, always equal to the built release.
 */
export const APP_VERSION = '0.6.70';
