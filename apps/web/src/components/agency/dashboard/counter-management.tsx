'use client';

import { useState, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Monitor,
  PhoneCall,
  User,
  Clock,
  Loader2,
  ChevronRight,
  Hash,
} from 'lucide-react';
import type { TranslationKeys } from '@/i18n';

interface CounterInfo {
  id: string;
  number: number;
  staffName: string;
  currentTicket: string | null;
  currentCustomer: string | null;
  currentService: string | null;
  servedToday: number;
  isActive: boolean;
}

interface CounterManagementProps {
  waitingList: Array<{
    id: string;
    queueNumber: string;
    customerName: string;
    serviceName: string;
    serviceNameAr?: string;
    serviceNameFr?: string;
    joinedAt: string;
    status: string;
    position: number;
    isWalkIn?: boolean;
  }>;
  calledEntry: Array<{
    id: string;
    queueNumber: string;
    customerName: string;
    serviceName: string;
    serviceNameAr?: string;
    serviceNameFr?: string;
    joinedAt: string;
    status: string;
    position: number;
    isWalkIn?: boolean;
  }>;
  servedToday: number;
  avgWaitTime: number;
  actionLoading: string | null;
  onCallNext: () => void;
  onCallNextForCounter: (counterId: string) => void;
  lang: string;
  t: (key: TranslationKeys) => string;
}

const COUNTER_COLORS = [
  'from-emerald-500 to-emerald-700',
  'from-teal-500 to-teal-700',
  'from-amber-500 to-amber-700',
  'from-rose-500 to-rose-700',
  'from-sky-500 to-sky-700',
  'from-violet-500 to-violet-700',
];

const COUNTER_BG_COLORS = [
  'bg-emerald-50 dark:bg-emerald-900/20 border-emerald-200 dark:border-emerald-800',
  'bg-teal-50 dark:bg-teal-900/20 border-teal-200 dark:border-teal-800',
  'bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-800',
  'bg-rose-50 dark:bg-rose-900/20 border-rose-200 dark:border-rose-800',
  'bg-sky-50 dark:bg-sky-900/20 border-sky-200 dark:border-sky-800',
  'bg-violet-50 dark:bg-violet-900/20 border-violet-200 dark:border-violet-800',
];

const STAFF_NAMES = ['Ahmed', 'Sara', 'Youcef', 'Amina', 'Karim', 'Leila'];

export function CounterManagement({
  waitingList,
  calledEntry,
  servedToday,
  avgWaitTime,
  actionLoading,
  onCallNext,
  onCallNextForCounter,
  lang,
  t,
}: CounterManagementProps) {
  // Generate counter data based on current queue state
  const counters: CounterInfo[] = useMemo(() => {
    const numCounters = Math.max(2, Math.min(4, Math.ceil((waitingList.length + calledEntry.length) / 3)));
    const result: CounterInfo[] = [];

    for (let i = 0; i < numCounters; i++) {
      const calledForCounter = calledEntry[i] || null;
      const staffIdx = i % STAFF_NAMES.length;
      result.push({
        id: `counter-${i + 1}`,
        number: i + 1,
        staffName: STAFF_NAMES[staffIdx],
        currentTicket: calledForCounter?.queueNumber || null,
        currentCustomer: calledForCounter?.customerName || null,
        currentService: calledForCounter?.serviceName || null,
        servedToday: Math.floor(servedToday / numCounters) + (i === 0 ? servedToday % numCounters : 0),
        isActive: true,
      });
    }
    return result;
  }, [waitingList, calledEntry, servedToday]);

  const getServiceName = (name?: string | null, nameAr?: string, nameFr?: string) => {
    if (!name) return '';
    if (lang === 'ar' && nameAr) return nameAr;
    if (lang === 'fr' && nameFr) return nameFr;
    return name;
  };

  const totalServing = counters.filter(c => c.currentTicket).length;
  const totalIdle = counters.filter(c => !c.currentTicket).length;

  return (
    <motion.div
      initial={{ opacity: 0, y: 15 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.22 }}
    >
      <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80 dark:border-gray-800/50 dark:backdrop-blur-sm dark:shadow-gray-900/50 h-full">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base flex items-center gap-2">
              <Monitor className="h-4 w-4 text-emerald-600" />
              {t('counterManagement' as any) || 'Service Counters'}
              <Badge variant="secondary" className="text-xs">{counters.length}</Badge>
            </CardTitle>
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-1">
                <span className="h-2 w-2 rounded-full bg-emerald-500" />
                <span className="text-[10px] text-muted-foreground">{totalServing} {t('active' as any) || 'active'}</span>
              </div>
              <div className="flex items-center gap-1">
                <span className="h-2 w-2 rounded-full bg-gray-300 dark:bg-gray-600" />
                <span className="text-[10px] text-muted-foreground">{totalIdle} {t('idle' as any) || 'idle'}</span>
              </div>
            </div>
          </div>
        </CardHeader>
        <CardContent className="pt-0">
          <div className="space-y-2.5">
            {counters.map((counter, idx) => (
              <motion.div
                key={counter.id}
                initial={{ opacity: 0, x: -10 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: idx * 0.06 }}
                className={`relative rounded-xl border p-3 transition-all duration-200 ${COUNTER_BG_COLORS[idx % COUNTER_BG_COLORS.length]} ${
                  counter.currentTicket ? 'ring-1 ring-emerald-300/50 dark:ring-emerald-700/50' : ''
                }`}
              >
                <div className="flex items-center gap-3">
                  {/* Counter Number Badge */}
                  <div className={`h-10 w-10 rounded-xl bg-gradient-to-br ${COUNTER_COLORS[idx % COUNTER_COLORS.length]} flex items-center justify-center flex-shrink-0 shadow-md`}>
                    <span className="text-sm font-black text-white">{counter.number}</span>
                  </div>

                  {/* Counter Info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <div className="flex items-center gap-1.5">
                        <User className="h-3 w-3 text-muted-foreground" />
                        <span className="text-xs font-medium text-foreground truncate">{counter.staffName}</span>
                      </div>
                      {counter.currentTicket && (
                        <Badge className="bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400 text-[9px] px-1.5 py-0 h-4 border-0">
                          {t('serving' as any) || 'Serving'}
                        </Badge>
                      )}
                      {!counter.currentTicket && (
                        <Badge className="bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400 text-[9px] px-1.5 py-0 h-4 border-0">
                          {t('idle' as any) || 'Idle'}
                        </Badge>
                      )}
                    </div>

                    {/* Current Ticket Info */}
                    {counter.currentTicket ? (
                      <div className="flex items-center gap-2 mt-1">
                        <div className="flex items-center gap-1">
                          <Hash className="h-3 w-3 text-emerald-600 dark:text-emerald-400" />
                          <span className="text-sm font-bold text-emerald-700 dark:text-emerald-400">{counter.currentTicket}</span>
                        </div>
                        <span className="text-[10px] text-muted-foreground truncate">· {counter.currentCustomer}</span>
                        {counter.currentService && (
                          <span className="text-[10px] text-muted-foreground truncate hidden lg:inline">· {counter.currentService}</span>
                        )}
                      </div>
                    ) : (
                      <p className="text-[10px] text-muted-foreground mt-1">{t('noTicketBeingServed' as any)}</p>
                    )}
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    <div className="text-center px-1">
                      <p className="text-xs font-bold text-foreground">{counter.servedToday}</p>
                      <p className="text-[8px] text-muted-foreground">{t('served' as any) || 'served'}</p>
                    </div>
                    {!counter.currentTicket && waitingList.length > 0 && (
                      <motion.div whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }}>
                        <Button
                          size="sm"
                          onClick={() => onCallNextForCounter(counter.id)}
                          disabled={!!actionLoading}
                          className="h-8 px-3 rounded-lg bg-gradient-to-r from-emerald-500 to-emerald-700 hover:from-emerald-600 hover:to-emerald-800 text-white text-xs font-semibold gap-1 shadow-sm"
                        >
                          {actionLoading === `call-${counter.id}` ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <PhoneCall className="h-3 w-3" />
                          )}
                          <span className="hidden sm:inline">{t('callNext')}</span>
                        </Button>
                      </motion.div>
                    )}
                  </div>
                </div>

                {/* Pulse indicator for active counter */}
                {counter.currentTicket && (
                  <motion.div
                    className="absolute top-2 end-2 h-2 w-2 rounded-full bg-emerald-500"
                    animate={{ opacity: [1, 0.3, 1] }}
                    transition={{ duration: 2, repeat: Infinity , ease: 'easeInOut' }}
                  />
                )}
              </motion.div>
            ))}
          </div>

          {/* Summary */}
          <div className="mt-3 pt-3 border-t border-gray-100 dark:border-gray-800">
            <div className="grid grid-cols-3 gap-2 text-center">
              <div>
                <p className="text-sm font-bold text-foreground">{counters.length}</p>
                <p className="text-[9px] text-muted-foreground">{t('totalCounters' as any)}</p>
              </div>
              <div>
                <p className="text-sm font-bold text-emerald-600 dark:text-emerald-400">{totalServing}</p>
                <p className="text-[9px] text-muted-foreground">{t('activeCounters' as any) || 'Active'}</p>
              </div>
              <div>
                <p className="text-sm font-bold text-foreground">~{avgWaitTime}{t('min')}</p>
                <p className="text-[9px] text-muted-foreground">{t('avgServiceTimeLabel') || 'Avg. Service'}</p>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </motion.div>
  );
}
