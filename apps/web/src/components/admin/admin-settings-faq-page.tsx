'use client';

/**
 * Platform Settings → FAQ Management subsection page (Task 5).
 * Thin wrapper: section shell + the existing AdminFaqManager.
 */

import { HelpCircle } from 'lucide-react';
import { AdminSettingsSectionPage } from '@/components/admin/admin-settings-section-page';
import { AdminFaqManager } from '@/components/admin/admin-faq-manager';

export function AdminSettingsFaqPage() {
  return (
    <AdminSettingsSectionPage icon={HelpCircle} titleKey="settingsFaqSub" descKey="settingsFaqSubDesc">
      <AdminFaqManager />
    </AdminSettingsSectionPage>
  );
}
