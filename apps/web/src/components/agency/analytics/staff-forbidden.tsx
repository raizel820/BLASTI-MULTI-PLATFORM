'use client';

// ─── Task 54-d: friendly "no permission" panel for the staff analytics ───────
//
// The backend live-checks `canViewAnalytics` on EVERY /api/staff/analytics
// request (contract §3 — 403 PERMISSION_DENIED:canViewAnalytics, protects
// against stale JWTs). When the hook maps that 403 to state 'forbidden', every
// staff section renders this panel instead of the generic error state.
// Doc-2 §29: staff analytics are permission-scoped — no permission, no module.

import { useLanguage } from '@/hooks/use-language';
import { ShieldAlert } from 'lucide-react';
import { SectionMessagePanel } from '@/components/admin/analytics/section-ui';
import { ak } from './i18n-keys';

export function StaffForbiddenPanel() {
  const { t } = useLanguage();
  return (
    <SectionMessagePanel
      icon={ShieldAlert}
      iconClass="bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400"
      title={t(ak('staffAnalytics.forbidden.title'))}
      body={t(ak('staffAnalytics.forbidden.body'))}
    />
  );
}
