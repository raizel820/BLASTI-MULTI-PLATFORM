'use client';

/**
 * Queue empty state — SIMPLIFIED (customer UX simplification round).
 * Plain icon + text + one CTA. The old orbiting-circles animation stage
 * is gone.
 */

import { useLanguage } from '@/hooks/use-language';
import { useAppStore } from '@/store/use-app-store';
import { Button } from '@/components/ui/button';
import { TicketCheck, Search } from 'lucide-react';

export function QueueEmptyState() {
  const { t } = useLanguage();
  const { setView } = useAppStore();

  return (
    <div className="px-4 py-4 pb-24">
      <h1 className="text-lg font-bold mb-6">{t('myQueue')}</h1>
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <div className="h-16 w-16 rounded-full bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center mb-5">
          <TicketCheck className="h-8 w-8 text-emerald-600 dark:text-emerald-400" />
        </div>
        <h2 className="text-lg font-semibold text-foreground mb-1">
          {t('noActiveReservations')}
        </h2>
        <p className="text-sm text-muted-foreground mb-2 max-w-xs">
          {t('welcomeSubtitle')}
        </p>
        <p className="text-xs text-muted-foreground/70 mb-6 max-w-xs">
          {t('joinQueueHint') || 'Find an agency nearby and join their queue to save time'}
        </p>
        <Button
          className="bg-emerald-600 hover:bg-emerald-700 text-white font-semibold px-6 rounded-xl h-11"
          onClick={() => setView('customer-home')}
        >
          <Search className="h-4 w-4 me-2" />
          {t('joinQueue')}
        </Button>
      </div>
    </div>
  );
}
