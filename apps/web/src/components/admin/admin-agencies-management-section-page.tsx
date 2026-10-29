'use client';

/**
 * Shared shell for the Agencies Management subsection pages (Task 5-a).
 *
 * Structural copy of AdminSettingsSectionPage (Platform Settings split):
 * back button to the group hub + compact premium header + the section panel.
 * Every subsection page is a thin wrapper around this shell.
 *
 * Differences from the Platform Settings shell:
 *   - back button routes to `admin-agencies-management` with the
 *     `agenciesMgmtBack` label;
 *   - `hideHeader?: boolean` — the two legacy panels (AdminAgencies,
 *     AdminServicesManagement) own their own page header, so those wrappers
 *     pass hideHeader to avoid a duplicated title banner (back button only).
 *
 * RTL-safe by construction: logical spacing utilities (ms/me/ps/pe) only, and
 * the directional arrow flips with `rtl:rotate-180`.
 */

import type { ReactNode } from 'react';
import { motion } from 'framer-motion';
import { ArrowRight, type LucideIcon } from 'lucide-react';
import { useLanguage } from '@/hooks/use-language';
import { useAppStore } from '@/store/use-app-store';
import { Button } from '@/components/ui/button';
import type { TranslationKeys } from '@/i18n';

interface AdminAgenciesManagementSectionPageProps {
  icon: LucideIcon;
  titleKey?: TranslationKeys;
  descKey?: TranslationKeys;
  /** Legacy panels render their own header — show the back button only. */
  hideHeader?: boolean;
  children: ReactNode;
}

export function AdminAgenciesManagementSectionPage({ icon: Icon, titleKey, descKey, hideHeader = false, children }: AdminAgenciesManagementSectionPageProps) {
  const { t } = useLanguage();
  const setView = useAppStore((s) => s.setView);

  return (
    <div className="p-4 lg:p-6 space-y-4">
      {/* Back to the Agencies Management hub — visible on every breakpoint */}
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setView('admin-agencies-management')}
        className="h-8 -ms-2 px-2 text-xs text-muted-foreground hover:text-foreground"
      >
        <ArrowRight className="h-3.5 w-3.5 me-1 rtl:rotate-180" />
        {t('agenciesMgmtBack' as TranslationKeys)}
      </Button>

      {/* Compact premium header — same family as the settings-section banner */}
      {!hideHeader && titleKey && (
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4 }}
          className="relative rounded-2xl overflow-hidden"
        >
          <div className="premium-header-gradient p-4 md:p-5 text-white">
            <div className="absolute inset-0 overflow-hidden">
              <div className="absolute -top-10 -end-10 w-40 h-40 rounded-full bg-white/10" />
              <div className="absolute -bottom-8 -start-8 w-32 h-32 rounded-full bg-white/5" />
            </div>
            <div className="relative">
              <h1 className="text-xl md:text-2xl font-bold text-white flex items-center gap-3">
                <span className="h-9 w-9 shrink-0 rounded-xl bg-white/20 backdrop-blur-sm flex items-center justify-center">
                  <Icon className="h-5 w-5 text-white" />
                </span>
                {t(titleKey)}
              </h1>
              {descKey && (
                <p className="text-xs md:text-sm text-emerald-100 mt-1 ms-[48px]">
                  {t(descKey)}
                </p>
              )}
            </div>
          </div>
        </motion.div>
      )}

      {children}
    </div>
  );
}
