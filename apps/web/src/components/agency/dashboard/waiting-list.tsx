'use client';

import { Users, UserCheck, UserX, XCircle, CheckSquare, Square } from 'lucide-react';
import { motion } from 'framer-motion';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import type { TranslationKeys } from '@/i18n';
import type { QueueEntry } from './types';
import { getServiceName, formatTime } from './helpers';

interface WaitingListProps {
  waitingOnly: QueueEntry[];
  batchMode: boolean;
  selectedIds: Set<string>;
  actionLoading: string | null;
  onAction: (entryId: string, action: 'complete' | 'no_show' | 'cancel') => void;
  onToggleBatchSelection: (id: string) => void;
  onExitBatchMode: () => void;
  onSetBatchMode: (mode: boolean) => void;
  lang: string;
  t: (key: TranslationKeys) => string;
}

export function WaitingList({
  waitingOnly,
  batchMode,
  selectedIds,
  actionLoading,
  onAction,
  onToggleBatchSelection,
  onExitBatchMode,
  onSetBatchMode,
  lang,
  t,
}: WaitingListProps) {
  return (
    <motion.div initial={{ opacity: 0, y: 15 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.22 }}>
      <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80 dark:border-gray-800/50 dark:backdrop-blur-sm dark:shadow-gray-900/50 h-full">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base flex items-center gap-2">
              <Users className="h-4 w-4 text-emerald-600" />
              {t('waitingQueue' as any)}
              <Badge variant="secondary" className="text-xs">{waitingOnly.length}</Badge>
            </CardTitle>
            <Button variant={batchMode ? 'default' : 'outline'} size="sm" className={batchMode ? 'h-7 px-2.5 rounded-lg gap-1 bg-emerald-600 hover:bg-emerald-700 text-white text-xs' : 'h-7 px-2.5 rounded-lg gap-1 text-xs'} onClick={() => batchMode ? onExitBatchMode() : onSetBatchMode(true)}>
              {batchMode ? <CheckSquare className="h-3 w-3" /> : <Square className="h-3 w-3" />}{batchMode ? t('exitBatchMode') : t('batchMode')}
            </Button>
          </div>
          {batchMode && selectedIds.size > 0 && <p className="text-xs text-muted-foreground mt-1">{t('selectTickets')} · {selectedIds.size} {t('selected')}</p>}
        </CardHeader>
        <CardContent className="pt-0">
          {waitingOnly.length === 0 ? (
            <div className="text-center py-8">
              <motion.div animate={{ y: [0, -5, 0] }} transition={{ duration: 2, repeat: Infinity }}>
                <div className="relative inline-block mb-3">
                  <motion.div animate={{ scale: [1, 1.2, 1], opacity: [0.1, 0.05, 0.1] }} transition={{ duration: 3, repeat: Infinity, ease: 'easeInOut' }} className="absolute top-1/2 start-1/2 -translate-x-1/2 -translate-y-1/2 h-20 w-20 rounded-full bg-emerald-200 dark:bg-emerald-800" />
                  <Users className="h-10 w-10 text-muted-foreground mx-auto relative" />
                </div>
              </motion.div>
              <p className="text-sm font-medium text-foreground mb-1">{t('noQueue')}</p>
              <p className="text-xs text-muted-foreground">{t('noQueueHint') || 'All customers have been served. Great job!'}</p>
            </div>
          ) : (
            <div className="space-y-1.5 max-h-96 overflow-y-auto custom-scrollbar">
              {waitingOnly.map((entry, idx) => (
                <motion.div key={entry.id} initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: idx * 0.03 }}
                  className={`flex items-center justify-between p-2.5 rounded-xl transition-all duration-200 group ${idx % 2 === 0 ? 'bg-gray-50/80 dark:bg-gray-900/50' : 'bg-white dark:bg-gray-900/30'} hover:bg-emerald-50 dark:hover:bg-emerald-900/10`}
                >
                  <div className="flex items-center gap-2.5">
                    {batchMode && entry.status === 'WAITING' && (
                      <Checkbox checked={selectedIds.has(entry.id)} onCheckedChange={() => onToggleBatchSelection(entry.id)} className="h-7 w-7 rounded-lg border-emerald-300 dark:border-emerald-700 data-[state=checked]:bg-emerald-600 data-[state=checked]:border-emerald-600" aria-label={t('selectTickets')} />
                    )}
                    <div className="min-h-9 min-w-9 px-2 py-1 rounded-xl flex items-center justify-center bg-emerald-100 dark:bg-emerald-900/30">
                      <span className="text-xs font-bold text-emerald-700 dark:text-emerald-400 whitespace-nowrap">{entry.queueNumber}</span>
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <p className="text-sm font-medium text-foreground truncate">{entry.customerName}</p>
                        {entry.isWalkIn && <Badge className="bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400 text-[8px] px-1 py-0 h-4">{t('walkInBadge')}</Badge>}
                      </div>
                      <p className="text-xs text-muted-foreground">{getServiceName(entry, lang)}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="text-[10px] text-muted-foreground hidden md:block">{formatTime(entry.joinedAt, lang)}</span>
                    <div className={`flex items-center gap-1 transition-opacity ${batchMode ? 'opacity-100' : 'opacity-50 group-hover:opacity-100'}`}>
                      <Button size="sm" variant="outline" className="h-7 w-7 p-0 text-emerald-600 border-emerald-200 dark:border-emerald-800 hover:bg-emerald-50 dark:hover:bg-emerald-900/20" onClick={() => onAction(entry.id, 'complete')} title={t('markCompleted')} aria-label={t('markCompleted')} disabled={!!actionLoading}><UserCheck className="h-3 w-3" /></Button>
                      <Button size="sm" variant="outline" className="h-7 w-7 p-0 text-amber-600 border-amber-200 dark:border-amber-800 hover:bg-amber-50 dark:hover:bg-amber-900/20" onClick={() => onAction(entry.id, 'no_show')} title={t('markNoShow')} aria-label={t('markNoShow')} disabled={!!actionLoading}><UserX className="h-3 w-3" /></Button>
                      <Button size="sm" variant="outline" className="h-7 w-7 p-0 text-red-600 border-red-200 dark:border-red-800 hover:bg-red-50 dark:hover:bg-red-900/20" onClick={() => onAction(entry.id, 'cancel')} title={t('cancelRes')} aria-label={t('markCancelled')} disabled={!!actionLoading}><XCircle className="h-3 w-3" /></Button>
                    </div>
                  </div>
                </motion.div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </motion.div>
  );
}
