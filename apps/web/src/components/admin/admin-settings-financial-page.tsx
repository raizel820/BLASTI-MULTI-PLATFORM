'use client';

/**
 * Platform Settings → Financial Engine subsection page (Task 5).
 * Thin wrapper: section shell + the existing AdminPaymentEngine
 * (dual financial engine — Chargily EDAHABIA/CIB + ECCP).
 */

import { Banknote } from 'lucide-react';
import { AdminSettingsSectionPage } from '@/components/admin/admin-settings-section-page';
import { AdminPaymentEngine } from '@/components/admin/admin-payment-engine';

export function AdminSettingsFinancialPage() {
  return (
    <AdminSettingsSectionPage icon={Banknote} titleKey="settingsFinancialEngine" descKey="settingsFinancialEngineDesc">
      <AdminPaymentEngine />
    </AdminSettingsSectionPage>
  );
}
