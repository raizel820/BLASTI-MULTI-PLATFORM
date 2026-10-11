'use client';

/**
 * Platform Settings → VPS & Server Status subsection page (Task 5).
 * Thin wrapper: section shell + the existing AdminVpsStatus card.
 */

import { Server } from 'lucide-react';
import { AdminSettingsSectionPage } from '@/components/admin/admin-settings-section-page';
import { AdminVpsStatus } from '@/components/admin/admin-vps-status';

export function AdminSettingsVpsPage() {
  return (
    <AdminSettingsSectionPage icon={Server} titleKey="settingsVps" descKey="settingsVpsDesc">
      <AdminVpsStatus />
    </AdminSettingsSectionPage>
  );
}
