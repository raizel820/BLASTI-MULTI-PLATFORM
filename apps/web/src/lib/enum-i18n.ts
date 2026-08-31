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
