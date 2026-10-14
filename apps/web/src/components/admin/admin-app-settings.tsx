'use client';

/**
 * AdminAppSettings — rebuilt from scratch (Task 4-a).
 *
 * The old 2400-line monolith is gone. This file is now a thin shell: header
 * banner + AdminDeployStatus + a 4-tab body, one file per tab under
 * components/admin/public-app/:
 *
 *   1. Installers  — live disk tracker (storage-files, activate-file, upload)
 *   2. Versions    — AppVersion records CRUD (create/edit/activate/delete)
 *   3. Update Pusher — version pushes with real delivery stats
 *   4. Devices     — install telemetry (stats, by-version, timeline, devices)
 *
 * CONTRACT: lazily imported by app/page.tsx as
 *   import('@/components/admin/admin-app-settings'), 'AdminAppSettings'
 * and rendered with NO props — the NAMED export below must keep this name.
 */

import { useLanguage } from '@/hooks/use-language';
import { AdminDeployStatus } from '@/components/admin/admin-deploy-status';
import { motion } from 'framer-motion';
import { Package, Shield } from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { InstallersTab } from './public-app/installers-tab';
import { VersionsTab } from './public-app/versions-tab';
import { PusherTab } from './public-app/pusher-tab';
import { DevicesTab } from './public-app/devices-tab';

export function AdminAppSettings() {
  const { t } = useLanguage();

  return (
    <div className="p-4 lg:p-6 space-y-5">
      {/* ─── Header banner ─── */}
      <motion.div
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
        className="relative rounded-2xl overflow-hidden"
      >
        <div
          className="p-5 md:p-6 text-white"
          style={{
            background: 'linear-gradient(135deg, #d97706 0%, #ea580c 40%, #f59e0b 70%, #d97706 100%)',
            backgroundSize: '200% 200%',
            animation: 'gradient-flow-bar 6s ease-in-out infinite',
          }}
        >
          <div className="absolute inset-0 overflow-hidden">
            <div className="absolute -top-10 -end-10 w-40 h-40 rounded-full bg-white/10" />
            <div className="absolute -bottom-8 -start-8 w-32 h-32 rounded-full bg-white/5" />
          </div>
          <div className="relative flex items-center justify-between gap-3">
            <div className="min-w-0">
              <h1 className="text-xl md:text-2xl font-bold text-white flex items-center gap-3">
                <span className="h-10 w-10 rounded-xl bg-white/20 backdrop-blur-sm flex items-center justify-center shrink-0">
                  <Package className="h-5 w-5 text-white" />
                </span>
                {t('publicAppsSettings')}
              </h1>
              <p className="text-xs md:text-sm text-amber-100 mt-1 ms-[52px]">
                {t('publicAppHeaderDesc')}
              </p>
            </div>
            <span className="shrink-0">
              <span className="inline-flex items-center gap-1 rounded-full bg-white/20 border border-white/30 backdrop-blur-sm text-xs px-3 py-1 max-sm:hidden">
                <Shield className="h-3 w-3 me-1" />
                {t('superAdmin')}
              </span>
            </span>
          </div>
        </div>
      </motion.div>

      {/* ─── Auto-deploy & watcher status ─── */}
      <AdminDeployStatus />

      {/* ─── Tabs ─── */}
      <Tabs defaultValue="installers" className="w-full">
        <TabsList className="w-full sm:w-auto sm:flex-wrap h-auto flex-wrap p-1">
          <TabsTrigger value="installers" className="text-xs sm:text-sm min-h-[36px] px-3">
            {t('publicAppTabInstallers')}
          </TabsTrigger>
          <TabsTrigger value="versions" className="text-xs sm:text-sm min-h-[36px] px-3">
            {t('publicAppTabVersions')}
          </TabsTrigger>
          <TabsTrigger value="pusher" className="text-xs sm:text-sm min-h-[36px] px-3">
            {t('publicAppTabPusher')}
          </TabsTrigger>
          <TabsTrigger value="devices" className="text-xs sm:text-sm min-h-[36px] px-3">
            {t('publicAppTabDevices')}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="installers" className="mt-3">
          <InstallersTab />
        </TabsContent>
        <TabsContent value="versions" className="mt-3">
          <VersionsTab />
        </TabsContent>
        <TabsContent value="pusher" className="mt-3">
          <PusherTab />
        </TabsContent>
        <TabsContent value="devices" className="mt-3">
          <DevicesTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
