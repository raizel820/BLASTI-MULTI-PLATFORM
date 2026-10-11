'use client';

/**
 * Platform Settings → Notifications & Providers subsection page (Task 5).
 * Thin wrapper: section shell + the existing AdminProvidersSettings hub
 * (SMS · Email · WhatsApp · Templates · Logs). NOTE: internals of
 * admin-providers-settings.tsx are owned by another task — do not touch them.
 */

import { BellRing } from 'lucide-react';
import { AdminSettingsSectionPage } from '@/components/admin/admin-settings-section-page';
import { AdminProvidersSettings } from '@/components/admin/admin-providers-settings';

export function AdminSettingsProvidersPage() {
  return (
    <AdminSettingsSectionPage icon={BellRing} titleKey="settingsProviders" descKey="settingsProvidersDesc">
      <AdminProvidersSettings />
    </AdminSettingsSectionPage>
  );
}
