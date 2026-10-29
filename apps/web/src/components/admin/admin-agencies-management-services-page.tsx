'use client';

/**
 * Agencies Management → Services Management subsection page (Task 5-a).
 *
 * Thin wrapper: shared section shell (back button to the
 * admin-agencies-management hub) + the existing AdminServicesManagement
 * panel, untouched. The view name (`admin-services-management`) and its
 * hash (#/admin/services-management) are unchanged — only the render path
 * gained the back button.
 *
 * `hideHeader` is set because AdminServicesManagement renders its own page
 * header; showing the shell banner too would duplicate the title.
 */

import { Tags } from 'lucide-react';
import { AdminAgenciesManagementSectionPage } from '@/components/admin/admin-agencies-management-section-page';
import { AdminServicesManagement } from '@/components/admin/admin-services-management';

export function AdminAgenciesManagementServicesPage() {
  return (
    <AdminAgenciesManagementSectionPage icon={Tags} hideHeader>
      <AdminServicesManagement />
    </AdminAgenciesManagementSectionPage>
  );
}
