'use client';

/**
 * Shared shell for the Platform Settings subsection pages (Task 5).
 *
 * The old monolithic admin-settings long-scroll page was split into one view
 * per section (admin-settings-vps, admin-settings-providers, …), grouped in
 * the sidebar under "__platform_settings_group__". Every subsection page is a
 * thin wrapper: this compact premium header (same visual family as the
 * admin-settings overview banner) + the existing section component.
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

interface AdminSettingsSectionPageProps {
  icon: LucideIcon;
  titleKey: TranslationKeys;
  descKey?: TranslationKeys;
  children: ReactNode;
}

export function AdminSettingsSectionPage({ icon: Icon, titleKey, descKey, children }: AdminSettingsSectionPageProps) {
  const { t } = useLanguage();
  const setView = useAppStore((s) => s.setView);

  return (
    <div className="p-4 lg:p-6 space-y-4">
      {/* Back to the General/Overview hub — visible on every breakpoint */}
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setView('admin-settings')}
        className="h-8 -ms-2 px-2 text-xs text-muted-foreground hover:text-foreground"
      >
        <ArrowRight className="h-3.5 w-3.5 me-1 rtl:rotate-180" />
        {t('settingsBackToOverview')}
      </Button>

      {/* Compact premium header — same family as the admin-settings banner */}
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

      {children}
    </div>
  );
}
