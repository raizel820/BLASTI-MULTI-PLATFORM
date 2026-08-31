'use client';

import { motion } from 'framer-motion';
import { Users, Ticket, Clock, XCircle, Pause, WifiOff } from 'lucide-react';
import type { AgencyInfo, ServiceInfo, QueueStats } from './kiosk-types';
import { getLocalizedName } from './kiosk-types';

interface KioskServiceSelectorProps {
  agency: AgencyInfo;
  services: ServiceInfo[];
  queueStats: QueueStats | null;
  selectedService: string | null;
  isOfflineMode: boolean;
  rtl: boolean;
  lang: 'ar' | 'fr' | 'en';
  error: string | null;
  t: (key: string) => string;
  pageVariants: {
    enter: { opacity: number; x: number };
    center: { opacity: number; x: number };
    exit: { opacity: number; x: number };
  };
  onSelectService: (serviceId: string) => void;
  onBack: () => void;
  onNext: () => void;
}

export function KioskServiceSelector({
  agency,
  services,
  queueStats,
  selectedService,
  isOfflineMode,
  rtl,
  lang,
  error,
  t,
  pageVariants,
  onSelectService,
  onBack,
  onNext,
}: KioskServiceSelectorProps) {
  return (
    <motion.div
      key="services"
      variants={pageVariants}
      initial="enter"
      animate="center"
      exit="exit"
      transition={{ duration: 0.3, ease: 'easeInOut' }}
      className="w-full max-w-lg"
    >
      <div className="bg-white rounded-3xl shadow-2xl p-4 sm:p-5">
        {/* Agency header with logo */}
        <div className="flex items-center gap-3 mb-3">
          <button
            onClick={onBack}
            className="min-h-[40px] min-w-[40px] rounded-xl bg-gray-100 flex items-center justify-center hover:bg-gray-200 transition-colors flex-shrink-0"
          >
            <svg className={`h-4 w-4 text-gray-600 ${rtl ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
          </button>
          {agency.logoUrl && (
            <div className="h-10 w-10 rounded-lg overflow-hidden bg-gray-100 flex-shrink-0 p-0.5">
              <img src={agency.logoUrl} alt={getLocalizedName(agency, lang)} className="h-full w-full object-contain" />
            </div>
          )}
          <div className="min-w-0">
            <h2 className="text-lg font-bold text-gray-900 truncate">
              {getLocalizedName(agency, lang)}
            </h2>
            <p className="text-xs text-gray-500">
              {agency.workingHoursStart} — {agency.workingHoursEnd}
            </p>
          </div>
        </div>

        {/* Queue status badges */}
        {queueStats && !isOfflineMode && (
          <div className="flex gap-2 mb-3">
            <div className="flex-1 bg-emerald-50 rounded-lg p-2 text-center">
              <Users className="h-4 w-4 text-emerald-600 mx-auto mb-0.5" />
              <p className="text-base font-bold text-emerald-700 leading-tight">{queueStats.waiting}</p>
              <p className="text-[9px] text-emerald-600">{t('kioskWaiting')}</p>
            </div>
            <div className="flex-1 bg-teal-50 rounded-lg p-2 text-center">
              <Ticket className="h-4 w-4 text-teal-600 mx-auto mb-0.5" />
              <p className="text-base font-bold text-teal-700 leading-tight">{queueStats.currentServing || '—'}</p>
              <p className="text-[9px] text-teal-600">{t('currentlyServingKiosk')}</p>
            </div>
            <div className="flex-1 bg-amber-50 rounded-lg p-2 text-center">
              <Clock className="h-4 w-4 text-amber-600 mx-auto mb-0.5" />
              <p className="text-base font-bold text-amber-700 leading-tight">{queueStats.estimatedWait}</p>
              <p className="text-[9px] text-amber-600">{t('minutesKiosk')}</p>
            </div>
          </div>
        )}

        {/* Queue status warnings */}
        {!agency.isQueueOpen && (
          <div className="mb-2 p-2.5 rounded-xl bg-red-50 border border-red-200 flex items-center gap-2">
            <XCircle className="h-5 w-5 text-red-500 flex-shrink-0" />
            <p className="text-red-700 font-semibold text-sm">{t('queueClosedKiosk')}</p>
          </div>
        )}
        {agency.isPaused && agency.isQueueOpen && (
          <div className="mb-2 p-2.5 rounded-xl bg-amber-50 border border-amber-200 flex items-center gap-2">
            <Pause className="h-5 w-5 text-amber-500 flex-shrink-0" />
            <p className="text-amber-700 font-semibold text-sm">{t('queuePausedKiosk')}</p>
          </div>
        )}

        {/* Service selection */}
        <h3 className="text-sm font-semibold text-gray-800 mb-2">
          {t('selectServiceKiosk')}
        </h3>

        {services.length === 0 ? (
          <p className="text-gray-400 text-center py-6">{t('kioskNoServices')}</p>
        ) : (
          <div className="space-y-2 max-h-[32vh] overflow-y-auto pe-1">
            {services.map((service) => {
              const isSelected = selectedService === service.id;
              return (
                <motion.button
                  key={service.id}
                  whileTap={{ scale: 0.98 }}
                  onClick={() => onSelectService(service.id)}
                  className={`w-full min-h-[60px] rounded-xl p-3 text-start transition-all border-2 flex items-center justify-between ${
                    isSelected
                      ? 'border-emerald-500 bg-emerald-50 shadow-lg shadow-emerald-100'
                      : 'border-gray-100 bg-white hover:border-emerald-200 hover:shadow-md'
                  }`}
                >
                  <div className="flex items-center gap-2.5">
                    <span className="text-xs font-bold px-2.5 py-1 rounded-lg bg-emerald-100 text-emerald-700">
                      {service.prefix}
                    </span>
                    <div>
                      <p className="text-base font-semibold text-gray-900">
                        {getLocalizedName(service, lang)}
                      </p>
                      <p className="text-xs text-gray-500 flex items-center gap-1">
                        <Clock className="h-3 w-3" />
                        ~{service.avgTime} {t('minutesKiosk')}
                      </p>
                    </div>
                  </div>
                  {isSelected && (
                    <motion.div
                      initial={{ scale: 0 }}
                      animate={{ scale: 1 }}
                      className="w-7 h-7 rounded-full bg-emerald-600 flex items-center justify-center flex-shrink-0"
                    >
                      <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                      </svg>
                    </motion.div>
                  )}
                </motion.button>
              );
            })}
          </div>
        )}

        {error && (
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            className="mt-3 p-2.5 rounded-xl bg-red-50 border border-red-200 text-red-700 text-sm font-medium"
          >
            {error}
          </motion.div>
        )}

        {/* Next button */}
        <motion.button
          whileHover={{ scale: selectedService ? 1.02 : 1 }}
          whileTap={{ scale: selectedService ? 0.98 : 1 }}
          onClick={onNext}
          disabled={!selectedService || (!isOfflineMode && (!agency.isQueueOpen || agency.isPaused))}
          className={`w-full min-h-[52px] rounded-2xl text-lg font-bold shadow-lg mt-3 flex items-center justify-center gap-2 transition-all ${
            !selectedService || (!isOfflineMode && (!agency.isQueueOpen || agency.isPaused))
              ? 'bg-gray-200 text-gray-400 cursor-not-allowed shadow-none'
              : isOfflineMode
                ? 'bg-gradient-to-r from-amber-500 to-orange-500 text-white hover:shadow-xl'
                : 'bg-gradient-to-r from-emerald-600 to-teal-600 text-white hover:shadow-xl'
          }`}
        >
          {isOfflineMode && <WifiOff className="h-5 w-5" />}
          {t('next')}
        </motion.button>
      </div>
    </motion.div>
  );
}