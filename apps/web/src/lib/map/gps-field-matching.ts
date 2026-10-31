/**
 * gps-field-matching — r26: shared geocode-name → Algerian administrative
 * dataset matching, used by the GPS auto-fill button in the agency
 * create/profile/settings and branch forms.
 *
 * Extracted verbatim (behavior-identical) from the r21-5 matcher in
 * create-agency-form.tsx so the profile/settings forms can apply the SAME
 * honest matching without a 3rd/4th copy drifting apart:
 *   1. Digit input ("19", " 19 ", "١٩", "Wilaya 19") → canonical two-digit
 *      code, accepted only when it is a real 01-58 code (never invented);
 *   2. Latin match after stripping geocoder prefixes/suffixes and folding
 *      diacritics/case/punctuation ("Wilaya de Sétif" ≍ "Sétif" ≍ "Setif");
 *   3. Arabic match, whitespace-insensitive with "ولاية" stripped from BOTH
 *      the geocoded name and the dataset's nameAr.
 * No match → null: never invent a wilaya/commune.
 */
import { ALGERIA_WILAYAS, findWilayaByCode } from '@/lib/algeria-locations';

export const WILAYA_CODE_REGEX = /^(0[1-9]|[1-4][0-9]|5[0-8])$/;

/** Fold a Latin name: lowercase, strip diacritics + punctuation. */
export function foldLatinName(name: string): string {
  return (name || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[^a-z0-9]/g, '');
}

/** Strip common geocoder decorations ("Wilaya de …", "Province of …"). */
export function stripWilayaAffixes(name: string): string {
  return (name || '')
    .replace(/^wilaya\s+(de|du|d')\s*/i, '')
    .replace(/\s+wilaya$/i, '')
    .replace(/^province\s+of\s+/i, '')
    .replace(/\s+(province|district|governorate)$/i, '')
    .trim();
}

/** Arabic-Indic digits (٠١٢ / ۰۱۲) → ASCII digits, letters untouched. */
export function foldArabicDigits(v: string): string {
  return (v || '')
    .replace(/[\u0660-\u0669]/g, (ch) => String(ch.charCodeAt(0) - 0x0660))
    .replace(/[\u06F0-\u06F9]/g, (ch) => String(ch.charCodeAt(0) - 0x06F0));
}

/** Canonicalize a wilaya input: digit-fold then keep digits only. */
export function normalizeWilayaInput(v: string): string {
  return foldArabicDigits(v || '').replace(/\D/g, '');
}

/** Match a geocoded wilaya name (Latin OR Arabic — the geocoder answers in
 * the UI language) to the official dataset. Digit input maps to the
 * canonical two-digit code. No match → null. */
export function findWilayaCodeByGeocodeName(name: string | null): string | null {
  if (!name) return null;
  const raw = name.trim();
  if (!raw) return null;

  const mapped = foldArabicDigits(raw);
  const digits = mapped.replace(/\D/g, '');
  if (digits.length >= 1 && digits.length <= 2) {
    const code = digits.padStart(2, '0');
    return WILAYA_CODE_REGEX.test(code) ? code : null;
  }

  const qLatin = foldLatinName(stripWilayaAffixes(mapped));
  const qArabic = mapped.replace(/ولاية/g, '').replace(/\s/g, '');
  if (!qLatin && !qArabic) return null;
  const hit = ALGERIA_WILAYAS.find((w) => {
    const latin = foldLatinName(w.name);
    const arabic = w.nameAr.replace(/ولاية/g, '').replace(/\s/g, '');
    return (qLatin !== '' && latin === qLatin) || (qArabic !== '' && arabic === qArabic);
  });
  return hit ? hit.code : null;
}

/** Match a geocoded city/commune name against the communes of a wilaya
 * (folded Latin + raw Arabic, whitespace-insensitive). Returns the dataset
 * commune name, or null when nothing matches / the wilaya is unknown. */
export function matchCommuneInWilaya(wilayaCode: string, city: string | null): string | null {
  if (!city || !WILAYA_CODE_REGEX.test(wilayaCode || '')) return null;
  const wilaya = findWilayaByCode(wilayaCode);
  if (!wilaya) return null;
  const qLatin = foldLatinName(city);
  const qArabic = city.replace(/\s/g, '');
  const match = wilaya.communes.find(
    (c) =>
      (qLatin !== '' && foldLatinName(c.name) === qLatin) ||
      (qArabic !== '' && c.nameAr.replace(/\s/g, '') === qArabic),
  );
  return match ? match.name : null;
}
