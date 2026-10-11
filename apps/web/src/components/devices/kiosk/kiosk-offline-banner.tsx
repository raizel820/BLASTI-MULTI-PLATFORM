'use client';

import { motion } from 'framer-motion';
import { WifiOff, CheckCircle, AlertTriangle, Loader2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import type { OfflineTicket } from './kiosk-types';

type SyncStatus = 'idle' | 'syncing' | 'success' | 'error';

interface KioskOfflineBannerProps {
  t: (key: string) => string;
  offlineTickets: OfflineTicket[];
  syncStatus: SyncStatus;
  syncCount: number;
}

export function KioskOfflineBanner({ t, offlineTickets, syncStatus, syncCount }: KioskOfflineBannerProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: -10 }}
      animate={{ opacity: 1, y: 0 }}
      className="mx-4 mb-2 p-3 rounded-2xl bg-amber-500/90 backdrop-blur-sm flex items-center justify-between print:hidden"
    >
      <div className="flex items-center gap-2 text-white">
        <WifiOff className="h-4 w-4" />
        <span className="text-sm font-semibold">{t('kioskOfflineMode')}</span>
        {offlineTickets.length > 0 && (
          <Badge variant="outline" className="bg-white/20 text-white border-white/30 text-xs">
            {offlineTickets.length} {t('kioskOfflineTicketsPending')}
          </Badge>
        )}
      </div>
      {syncStatus === 'syncing' && (
        <div className="flex items-center gap-2 text-white">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span className="text-xs font-medium">{t('kioskSyncing')}</span>
        </div>
      )}
      {syncStatus === 'success' && (
        <div className="flex items-center gap-2 text-white">
          <CheckCircle className="h-4 w-4" />
          <span className="text-xs font-medium">{syncCount} {t('kioskSyncComplete')}</span>
        </div>
      )}
      {syncStatus === 'error' && (
        <div className="flex items-center gap-2 text-white">
          <AlertTriangle className="h-4 w-4" />
          <span className="text-xs font-medium">{t('kioskSyncFailed')}</span>
        </div>
      )}
    </motion.div>
  );
}