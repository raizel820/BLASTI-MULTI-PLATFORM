'use client';

/**
 * Platform Settings → Locations & Maps subsection page (Task 5).
 * Thin wrapper: section shell + the existing AdminMapsSettings panel —
 * the SAME component that the standalone admin-maps view (#/admin/maps)
 * and the old embedded section use. No component changes; a new alias view
 * so the whole Platform Settings group lives under one URL namespace.
 */

import { MapPin } from 'lucide-react';
import { AdminSettingsSectionPage } from '@/components/admin/admin-settings-section-page';
import { AdminMapsSettings } from '@/components/admin/admin-maps-settings';

export function AdminSettingsMapsPage() {
  return (
    <AdminSettingsSectionPage icon={MapPin} titleKey="settingsMapsSub" descKey="settingsMapsSubDesc">
      <AdminMapsSettings />
    </AdminSettingsSectionPage>
  );
}
