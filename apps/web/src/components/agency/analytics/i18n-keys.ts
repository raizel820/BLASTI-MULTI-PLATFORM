'use client';

// ─── Task 42-e: analytics i18n key bridge ───────────────────────────────────
//
// The analyticsSection.* keys are being added to apps/web/src/i18n/* by the
// main agent AFTER this section lands (sub-agent constraint: never edit i18n).
// `ak()` casts a not-yet-registered key into TranslationKeys so the section
// compiles today; t() already falls back to the key itself for missing
// entries, and once the translations land the same code resolves them.
//
// NOTE: keys that already exist in i18n (statusWaiting, avgWaitTime,
// completionRate, noShowRate, totalReservations, …) are used DIRECTLY via
// t('key') — reuse is preferred over new keys.

import type { TranslationKeys } from '@/i18n';

export function ak(key: string): TranslationKeys {
  return key as TranslationKeys;
}
