'use client';

/**
 * AUD-1 roadmap — Services Management page shell.
 *
 * Platform Settings subsection (sidebar group "__platform_settings_group__")
 * wrapping AdminServicePolicies: the SUPER_ADMIN console that decides, per
 * agency type (clinic, bank, barber, …), which Service fields are OPTIONAL
 * vs MANDATORY — and enforces it on every service write path in the API.
 */

import { Wrench } from 'lucide-react';
import { AdminSettingsSectionPage } from '@/components/admin/admin-settings-section-page';
import { AdminServicePolicies } from '@/components/admin/admin-service-policies';

export function AdminSettingsServicesPage() {
  return (
    <AdminSettingsSectionPage icon={Wrench} titleKey="settingsServicesMgmt" descKey="settingsServicesMgmtDesc">
      <AdminServicePolicies />
    </AdminSettingsSectionPage>
  );
}
