'use client';

import type { TFunction } from 'i18next';

/**
 * Translates raw status enum values to human-readable translated strings.
 */
export function translateStatus(status: string, t: TFunction): string {
  const key = `status${status.charAt(0).toUpperCase() + status.slice(1).toLowerCase()}`;
  const translated = t(key);
  return translated !== key ? translated : humanizeEnum(status);
}

/**
 * Translates raw category enum values (TV, KIOSK, PRINTER, etc.)
 */
export function translateCategory(category: string, t: TFunction): string {
  const key = `cat${category.charAt(0).toUpperCase() + category.slice(1).toLowerCase()}`;
  const translated = t(key);
  return translated !== key ? translated : humanizeEnum(category);
}

/**
 * Translates audit action values (LOGIN, LOGOUT, QUEUE_CALL_NEXT, etc.)
 */
export function translateAuditAction(action: string, t: TFunction): string {
  const key = `audit${action
    .split(/[-_]/)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join('')}`;
  const translated = t(key);
  return translated !== key ? translated : humanizeEnum(action);
}

/**
 * Translates entity type values (USER, AGENCY, SERVICE, etc.)
 */
export function translateEntityType(entityType: string, t: TFunction): string {
  const key = `entity${entityType.charAt(0).toUpperCase() + entityType.slice(1).toLowerCase()}`;
  const translated = t(key);
  return translated !== key ? translated : humanizeEnum(entityType);
}

/**
 * Translates payment method values (CARD, CASH, BANK_TRANSFER, etc.)
 */
export function translatePaymentMethod(method: string, t: TFunction): string {
  const key = `pay${method
    .split('_')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join('')}`;
  const translated = t(key);
  return translated !== key ? translated : humanizeEnum(method);
}

/**
 * Translates payment model values (UPFRONT, MONTHLY)
 */
export function translatePaymentModel(model: string, t: TFunction): string {
  const key = `payModel${model.charAt(0).toUpperCase() + model.slice(1).toLowerCase()}`;
  const translated = t(key);
  return translated !== key ? translated : humanizeEnum(model);
}

/**
 * Translates connection type values (LAN, WIFI, CABLE, MANUAL)
 */
export function translateConnectionType(type: string, t: TFunction): string {
  const key = `conn${type.charAt(0).toUpperCase() + type.slice(1).toLowerCase()}`;
  const translated = t(key);
  return translated !== key ? translated : humanizeEnum(type);
}

/**
 * Converts UPPER_SNAKE_CASE, kebab-case, snake_case, or camelCase to Title Case
 */
export function humanizeEnum(value: string): string {
  return value
    .replace(/[-_]/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\b\w/g, w => w.toUpperCase())
    .trim();
}

/**
 * Formats the agency working-days CSV (0=Sunday … 6=Saturday) as a localized,
 * comma-separated weekday list using the app language — NOT navigator.language
 * (Task 31-A: on English-locale machines the profile row always showed English
 * day names regardless of the selected app language).
 *
 * Uses the same proven base-date approach as create-agency-form.tsx: Oct 6 2024
 * is a Sunday, so base + N lands on weekday N.
 *
 * opts.short — 'short' weekday names (default, matches the compact profile row)
 *              or full names when explicitly false.
 * Returns '' for null/empty/unparsable input so the caller can fall back.
 */
export function formatWorkingDaysList(
  csv: string | null | undefined,
  lang: 'en' | 'ar' | 'fr',
  opts?: { short?: boolean },
): string {
  if (!csv) return '';
  const days = csv
    .split(',')
    .map((d) => d.trim())
    .filter((d) => /^[0-6]$/.test(d))
    .sort((a, b) => Number(a) - Number(b));
  if (days.length === 0) return '';
  const locale = lang === 'ar' ? 'ar' : lang === 'fr' ? 'fr' : 'en';
  // Arabic uses the Arabic comma (،); Latin scripts use the regular comma.
  const separator = lang === 'ar' ? '\u060c ' : ', ';
  try {
    const formatter = new Intl.DateTimeFormat(locale, {
      weekday: opts?.short === false ? 'long' : 'short',
    });
    return days
      .map((d) => formatter.format(new Date(2024, 9, 6 + Number(d))))
      .join(separator);
  } catch {
    return '';
  }
}
