'use client';

/**
 * Platform Settings → System Configuration subsection page (Task 5).
 * Thin wrapper: section shell + the existing SystemSettingsConfig
 * (dynamic key/value settings store with encryption flags).
 */

import { SlidersHorizontal } from 'lucide-react';
import { AdminSettingsSectionPage } from '@/components/admin/admin-settings-section-page';
import { SystemSettingsConfig } from '@/components/admin/admin-settings-config';

export function AdminSettingsConfigPage() {
  return (
    <AdminSettingsSectionPage icon={SlidersHorizontal} titleKey="settingsSystemConfig" descKey="settingsSystemConfigDesc">
      <SystemSettingsConfig />
    </AdminSettingsSectionPage>
  );
}
