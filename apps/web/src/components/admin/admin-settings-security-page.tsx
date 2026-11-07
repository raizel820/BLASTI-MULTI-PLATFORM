'use client';

/**
 * Platform Settings → Security subsection page (Task 5).
 * Thin wrapper: section shell + the admin account self-service card
 * (0.6.50 — login username + password) + the biometric login settings card
 * (shared/biometric-settings.tsx, device-local — Task 80).
 */

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ShieldCheck } from 'lucide-react';
import { AdminSettingsSectionPage } from '@/components/admin/admin-settings-section-page';
import { BiometricSettingsCard } from '@/components/shared/biometric-settings';
import { AdminAccountCard } from '@/components/admin/admin-account-card';
import { useLanguage } from '@/hooks/use-language';

export function AdminSettingsSecurityPage() {
  const { t } = useLanguage();

  return (
    <AdminSettingsSectionPage icon={ShieldCheck} titleKey="settingsSecuritySub" descKey="settingsSecuritySubDesc">
      {/* 0.6.50 — admin account self-service (login username + password) */}
      <AdminAccountCard />
      <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80 dark:border-gray-800/50">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-emerald-600" />
            {t('security')}
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <BiometricSettingsCard />
        </CardContent>
      </Card>
    </AdminSettingsSectionPage>
  );
}
