/**
 * 0.6.60 — Algerian phone-number normalization + validation (CLIENT side).
 *
 * FIELD INCIDENT (0.6.58 desktop): account creation "hung" and then died with
 * "Too many requests". Root cause chain:
 *   1. The register form had NO client-side phone validation — any garbage
 *      went to the cloud, which answered 400 "Enter a valid Algerian phone
 *      number" on a TINY inline label the user never noticed.
 *   2. Every 400 still consumed the register rate-limit buckets (3/min), so
 *      three quick retries locked the window → 429 "Too many requests".
 * This module gives the forms the SAME normalization the server now applies
 * (see apps/api/src/lib/validations.ts — keep the two in sync!):
 *   • Arabic-Indic (٠-٩) + Extended Arabic-Indic (۰-۹) digits → ASCII
 *   • fullwidth digits (０-９) → ASCII
 *   • strip spaces, dashes, dots, parentheses, NBSP/thin/NB-hyphen
 *   • prefixes '+213' / '00 213' / '213' / leading '0' all accepted
 *   • canonical stored form: 0XXXXXXXXX (10 digits, mobile 05/06/07)
 */

const ARABIC_INDIC = /[\u0660-\u0669]/g; // ٠-٩
const EXT_ARABIC_INDIC = /[\u06F0-\u06F9]/g; // ۰-۹
const FULLWIDTH = /[\uFF10-\uFF19]/g; // ０-９

/** Replace Arabic/fullwidth digit glyphs with their ASCII counterparts. */
export function asciiDigits(v: string): string {
  return v
    .replace(ARABIC_INDIC, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(EXT_ARABIC_INDIC, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(FULLWIDTH, (d) => String(d.charCodeAt(0) - 0xff10));
}

/** Everything users (or their contact apps) sprinkle into a phone number. */
const JUNK = /[\s\u00A0\u202F.\-–—−()]+/g;

/**
 * Normalize a user-typed Algerian mobile number to its digits-with-prefix
 * form (no junk, ASCII digits). Does NOT validate — see isValidDZPhone.
 * Returns the cleaned string ('' when nothing usable remains).
 */
export function normalizeDZPhoneInput(v: string): string {
  let s = asciiDigits(String(v || '')).replace(JUNK, '').trim();
  // Unify country-code notations: 00213 / +213 / 213 → drop, keep the rest.
  if (s.startsWith('00213')) s = s.slice(5);
  else if (s.startsWith('+213')) s = s.slice(4);
  else if (/^213\d{9}$/.test(s)) s = s.slice(3);
  return s;
}

/** 10-digit local mobile form (05/06/07 + 8 digits). */
const DZ_MOBILE_LOCAL = /^0[5-7]\d{8}$/;

/** Valid AFTER normalization: local (0[5-7]…) or short 9-digit (5…/6…/7…). */
export function isValidDZPhone(v: string): boolean {
  const s = normalizeDZPhoneInput(v);
  return DZ_MOBILE_LOCAL.test(s) || /^[5-7]\d{8}$/.test(s);
}

/**
 * Canonical storage/transport form: 0XXXXXXXXX (or null when invalid).
 * The server (0.6.60) normalizes with the same rules, so the register form
 * submits the canonical value and the uniqueness checks compare like-for-like
 * (previously +213555123456 and 0555123456 stored as two different phones).
 */
export function canonicalDZPhone(v: string): string | null {
  const s = normalizeDZPhoneInput(v);
  if (/^[5-7]\d{8}$/.test(s)) return `0${s}`;
  if (DZ_MOBILE_LOCAL.test(s)) return s;
  return null;
}
