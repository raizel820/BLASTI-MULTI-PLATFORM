'use client';

// ─── Task 4: super-admin analytics i18n key bridge ──────────────────────────
//
// Mirrors src/components/agency/analytics/i18n-keys.ts. The `adminAnalytics.*`
// keys are added to apps/web/src/i18n/* by the main agent AFTER this section
// lands (sub-agent constraint: never edit i18n). `ak()` casts a not-yet-
// registered key into TranslationKeys so the section compiles today; t()
// falls back to the key itself for missing entries, and once the translations
// land the same code resolves them.
//
// Keys that already exist in i18n (totalAgencies, activeAgencies,
// totalCustomers, newCustomers, topAgencies, onlineReservations, walkIn,
// analyticsSection.*, …) are used DIRECTLY via t('key') — reuse is preferred.

import type { TranslationKeys } from '@/i18n';

export function ak(key: string): TranslationKeys {
  return key as TranslationKeys;
}
