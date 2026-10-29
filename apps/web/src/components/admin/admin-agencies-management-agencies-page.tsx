'use client';

/**
 * Agencies Management → Agencies subsection page (Task 5-a).
 *
 * Thin wrapper: shared section shell (back button to the
 * admin-agencies-management hub) + the existing AdminAgencies panel,
 * untouched. The view name (`admin-agencies`) and its hash
 * (#/admin/agencies) are unchanged — only the render path gained the
 * back button.
 *
 * `hideHeader` is set because AdminAgencies renders its own page header;
 * showing the shell banner too would duplicate the title.
 */

import { Building2 } from 'lucide-react';
import { AdminAgenciesManagementSectionPage } from '@/components/admin/admin-agencies-management-section-page';
import { AdminAgencies } from '@/components/admin/admin-agencies';

export function AdminAgenciesManagementAgenciesPage() {
  return (
    <AdminAgenciesManagementSectionPage icon={Building2} hideHeader>
      <AdminAgencies />
    </AdminAgenciesManagementSectionPage>
  );
}
