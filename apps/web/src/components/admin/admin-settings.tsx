'use client';

/**
 * Platform Settings — General/Overview hub (Task 5).
 *
 * This view used to be a ~300-line long-scroll page mounting all 8 admin
 * sections back-to-back. It is now the entry card of the sidebar
 * "__platform_settings_group__": a navigation grid where every card routes to
 * its own dedicated view (admin-settings-vps, admin-settings-providers, …),
 * mirroring the "Managing Sales & Operations" group pattern.
 *
 * Backward compatible: the view name (`admin-settings`) and its hash
 * (#/admin/settings) are unchanged.
 */

import { motion } from 'framer-motion';
import {
  Settings,
  Shield,
  ArrowRight,
  Server,
  BellRing,
  MapPin,
  CreditCard,
  Banknote,
  ShieldCheck,
  HelpCircle,
  SlidersHorizontal,
  type LucideIcon,
} from 'lucide-react';
import { useLanguage } from '@/hooks/use-language';
import { useAppStore } from '@/store/use-app-store';
import type { ViewName } from '@/store/use-app-store';
import { Badge } from '@/components/ui/badge';
import type { TranslationKeys } from '@/i18n';

// ─── Animation variants ───────────────────────────────────────────
const fadeUp = {
  initial: { opacity: 0, y: 15 },
  animate: { opacity: 1, y: 0 },
};

// ─── Subsection registry (order = sidebar group order) ────────────
interface SettingsSection {
  view: ViewName;
  icon: LucideIcon;
  titleKey: TranslationKeys;
  descKey: TranslationKeys;
}

const SETTINGS_SECTIONS: SettingsSection[] = [
  { view: 'admin-settings-vps', icon: Server, titleKey: 'settingsVps', descKey: 'settingsVpsDesc' },
  { view: 'admin-settings-providers', icon: BellRing, titleKey: 'settingsProviders', descKey: 'settingsProvidersDesc' },
  { view: 'admin-settings-maps', icon: MapPin, titleKey: 'settingsMapsSub', descKey: 'settingsMapsSubDesc' },
  { view: 'admin-settings-payments', icon: CreditCard, titleKey: 'settingsPaymentsGateway', descKey: 'settingsPaymentsGatewayDesc' },
  { view: 'admin-settings-financial', icon: Banknote, titleKey: 'settingsFinancialEngine', descKey: 'settingsFinancialEngineDesc' },
  { view: 'admin-settings-security', icon: ShieldCheck, titleKey: 'settingsSecuritySub', descKey: 'settingsSecuritySubDesc' },
  { view: 'admin-settings-faq', icon: HelpCircle, titleKey: 'settingsFaqSub', descKey: 'settingsFaqSubDesc' },
  { view: 'admin-settings-config', icon: SlidersHorizontal, titleKey: 'settingsSystemConfig', descKey: 'settingsSystemConfigDesc' },
];

// ─── Component ─────────────────────────────────────────────────────
export function AdminSettings() {
  const { t } = useLanguage();
  const setView = useAppStore((s) => s.setView);

  return (
    <div className="p-4 lg:p-6 space-y-5">
      {/* ─── Header Banner ─── */}
      <motion.div
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
        className="relative rounded-2xl overflow-hidden mb-2"
      >
        <div className="premium-header-gradient p-5 md:p-6 text-white">
          <div className="absolute inset-0 overflow-hidden">
            <div className="absolute -top-10 -end-10 w-40 h-40 rounded-full bg-white/10" />
            <div className="absolute -bottom-8 -start-8 w-32 h-32 rounded-full bg-white/5" />
          </div>
          <div className="relative flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-bold text-white flex items-center gap-3">
                <span className="h-10 w-10 rounded-xl bg-white/20 backdrop-blur-sm flex items-center justify-center">
                  <Settings className="h-5 w-5 text-white" />
                </span>
                {t('settings')}
              </h1>
              <p className="text-sm text-emerald-100 mt-1 ms-[52px]">
                {t('platformSettings')}
              </p>
            </div>
            <div className="hidden sm:flex items-center gap-2">
              <Badge className="bg-white/20 text-white border-white/30 backdrop-blur-sm text-xs px-3 py-1">
                <Shield className="h-3 w-3 me-1" />
                {t('superAdmin')}
              </Badge>
            </div>
          </div>
        </div>
      </motion.div>

      {/* ─── Subsection navigation grid ───
           One card per dedicated view — tap to navigate; the sidebar
           "__platform_settings_group__" mirrors the same entries. ─── */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4 lg:gap-6">
        {SETTINGS_SECTIONS.map((section, index) => {
          const Icon = section.icon;
          return (
            <motion.button
              key={section.view}
              type="button"
              {...fadeUp}
              transition={{ delay: 0.05 + index * 0.04 }}
              onClick={() => setView(section.view)}
              aria-label={t(section.titleKey)}
              whileHover={{ y: -3 }}
              whileTap={{ scale: 0.98 }}
              className="group text-start rounded-2xl border border-border/60 bg-white dark:bg-gray-900/80 dark:border-gray-800/50 shadow-sm hover:shadow-md hover:border-emerald-300/60 dark:hover:border-emerald-700/50 transition-colors p-5 flex flex-col gap-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60"
            >
              <div className="flex items-start justify-between gap-3">
                <span className="h-10 w-10 shrink-0 rounded-xl bg-emerald-50 dark:bg-emerald-900/30 flex items-center justify-center transition-colors group-hover:bg-emerald-100 dark:group-hover:bg-emerald-900/50">
                  <Icon className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
                </span>
                <ArrowRight className="h-4 w-4 text-muted-foreground/60 transition-all group-hover:text-emerald-600 dark:group-hover:text-emerald-400 rtl:rotate-180 group-hover:-translate-y-0.5" />
              </div>
              <div className="space-y-1">
                <h3 className="text-sm font-semibold text-foreground">{t(section.titleKey)}</h3>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  {t(section.descKey)}
                </p>
              </div>
            </motion.button>
          );
        })}
      </div>
    </div>
  );
}
