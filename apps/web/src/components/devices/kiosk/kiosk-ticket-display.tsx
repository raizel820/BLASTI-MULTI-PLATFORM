'use client';

import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  CheckCircle,
  Hash,
  Clock,
  Printer,
  RotateCcw,
  QrCode,
  WifiOff,
  Monitor,
  Timer,
  AlertTriangle,
} from 'lucide-react';
import type { TicketInfo, QueueStats } from './kiosk-types';
import { getLocalizedTicketAgencyName, getLocalizedTicketServiceName } from './kiosk-types';
import type { Language } from '@/i18n';

// ─── Kiosk Confetti Particles ─────────────────────
function KioskConfetti({ active }: { active: boolean }) {
  const [particles] = useState(() =>
    Array.from({ length: 30 }, (_, i) => ({
      id: i,
      x: 20 + Math.random() * 60,
      delay: Math.random() * 0.6,
      duration: 1.5 + Math.random() * 1.5,
      size: 6 + Math.random() * 10,
      color: ['#10b981', '#14b8a6', '#f59e0b', '#f43f5e', '#06b6d4', '#a78bfa', '#ffffff'][Math.floor(Math.random() * 7)],
      rotation: Math.random() * 360,
      xDrift: Math.random() * 40 - 20,
      shape: Math.random() > 0.5 ? 'circle' : 'rect',
    }))
  );

  if (!active) return null;

  return (
    <div className="absolute inset-0 pointer-events-none overflow-hidden z-30">
      {particles.map((p) => (
        <motion.div
          key={p.id}
          initial={{ y: '30%', x: `${p.x}%`, opacity: 1, scale: 0, rotate: 0 }}
          animate={{
            y: '-30%',
            x: `${p.x + p.xDrift}%`,
            opacity: [0, 1, 1, 0],
            scale: [0, 1.5, 1, 0.3],
            rotate: [0, p.rotation * 2, p.rotation * 4],
          }}
          transition={{ duration: p.duration, delay: p.delay, ease: 'easeOut' }}
          className="absolute"
          style={{
            width: p.size,
            height: p.shape === 'rect' ? p.size * 0.6 : p.size,
            backgroundColor: p.color,
            borderRadius: p.shape === 'circle' ? '50%' : '2px',
          }}
        />
      ))}
    </div>
  );
}

// ─── Currently Serving Display ────────────────────
function CurrentlyServingDisplay({ queueStats, t }: { queueStats: QueueStats | null; t: (key: string) => string }) {
  const servingList = queueStats?.currentlyServingList;
  const currentServing = queueStats?.currentServing;

  if (!currentServing && (!servingList || servingList.length === 0)) return null;

  return (
    <motion.div
      initial={{ opacity: 0, y: -5 }}
      animate={{ opacity: 1, y: 0 }}
      className="bg-white/10 backdrop-blur-sm rounded-2xl p-4 print:hidden"
    >
      <div className="flex items-center gap-2 mb-2">
        <Monitor className="h-4 w-4 text-emerald-200" />
        <p className="text-sm font-semibold text-emerald-100">{t('currentlyServingKiosk')}</p>
      </div>
      {servingList && servingList.length > 0 ? (
        <div className="grid grid-cols-2 gap-2">
          {servingList.slice(0, 4).map((item, i) => (
            <div key={i} className="bg-white/10 rounded-xl p-2.5 text-center">
              <p className="text-2xl font-bold text-white">{item.ticketNumber}</p>
              {item.counterName && (
                <p className="text-[10px] text-emerald-200/80 mt-0.5">{item.counterName}</p>
              )}
            </div>
          ))}
        </div>
      ) : currentServing ? (
        <div className="bg-white/10 rounded-xl p-3 text-center">
          <motion.p
            animate={{ scale: [1, 1.05, 1] }}
            transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}
            className="text-3xl font-bold text-white"
          >
            {currentServing}
          </motion.p>
        </div>
      ) : null}
    </motion.div>
  );
}

// ─── Estimated Wait Display ───────────────────────
function EstimatedWaitDisplay({
  ticket,
  queueStats,
  lang,
  t,
}: {
  ticket: TicketInfo;
  queueStats: QueueStats | null;
  lang: Language;
  t: (key: string) => string;
}) {
  if (!queueStats) return null;
  const waitMinutes = ticket.estimatedWaitMinutes || queueStats.estimatedWait || 0;

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.9 }}
      className="bg-white/10 backdrop-blur-sm rounded-2xl p-4 text-center print:hidden"
    >
      <div className="flex items-center justify-center gap-2 mb-2">
        <Timer className="h-4 w-4 text-emerald-200" />
        <p className="text-sm font-semibold text-emerald-100">{t('yourEstimatedWait') || 'Your Estimated Wait'}</p>
      </div>
      <div className="flex items-baseline justify-center gap-1">
        {waitMinutes >= 60 ? (
          <>
            <motion.p
              animate={{ scale: [1, 1.02, 1] }}
              transition={{ duration: 3, repeat: Infinity, ease: 'easeInOut' }}
              className="text-3xl font-bold text-white"
            >
              {Math.floor(waitMinutes / 60)}
            </motion.p>
            <span className="text-sm text-emerald-200">{lang === 'ar' ? 'ساعة' : lang === 'fr' ? 'h' : 'hr'}</span>
            {waitMinutes % 60 > 0 && (
              <>
                <motion.p
                  animate={{ scale: [1, 1.02, 1] }}
                  transition={{ duration: 3, repeat: Infinity, ease: 'easeInOut', delay: 0.1 }}
                  className="text-3xl font-bold text-white"
                >
                  {waitMinutes % 60}
                </motion.p>
                <span className="text-sm text-emerald-200">{t('minutesKiosk')}</span>
              </>
            )}
          </>
        ) : (
          <>
            <motion.p
              animate={{ scale: [1, 1.05, 1] }}
              transition={{ duration: 3, repeat: Infinity, ease: 'easeInOut' }}
              className="text-4xl font-bold text-white"
            >
              {waitMinutes}
            </motion.p>
            <span className="text-sm text-emerald-200">{t('minutesKiosk')}</span>
          </>
        )}
      </div>
      {/* Auto-refresh indicator */}
      <p className="text-[10px] text-emerald-200/50 mt-2 flex items-center justify-center gap-1">
        <motion.span
          animate={{ opacity: [0.3, 1, 0.3] }}
          transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}
        >
          ●
        </motion.span>
        {t('autoRefreshKiosk') || 'Auto-updates every 30s'}
      </p>
    </motion.div>
  );
}

// ─── Main Ticket Display ──────────────────────────

interface KioskTicketDisplayProps {
  ticket: TicketInfo;
  queueStats: QueueStats | null;
  isOfflineMode: boolean;
  rtl: boolean;
  lang: Language;
  t: (key: string) => string;
  pageVariants: {
    enter: { opacity: number; x: number };
    center: { opacity: number; x: number };
    exit: { opacity: number; x: number };
  };
  showConfetti: boolean;
  ticketQrUrl: string | null;
  showQrDetail: boolean;
  printError: string | null;
  inactivitySeconds: number;
  onPrint: () => void;
  onReset: () => void;
  onToggleQrDetail: () => void;
  onClearPrintError: () => void;
}

export function KioskTicketDisplay({
  ticket,
  queueStats,
  isOfflineMode,
  rtl,
  lang,
  t,
  pageVariants,
  showConfetti,
  ticketQrUrl,
  showQrDetail,
  printError,
  inactivitySeconds,
  onPrint,
  onReset,
  onToggleQrDetail,
  onClearPrintError,
}: KioskTicketDisplayProps) {
  const agencyDisplayName = getLocalizedTicketAgencyName(ticket, lang);
  const serviceDisplayName = getLocalizedTicketServiceName(ticket, lang);

  return (
    <motion.div
      key="ticket"
      variants={pageVariants}
      initial="enter"
      animate="center"
      exit="exit"
      transition={{ duration: 0.3, ease: 'easeInOut' }}
      className="w-full max-w-md relative"
    >
      {/* Confetti animation */}
      <KioskConfetti active={showConfetti} />

      <div className="print-area">
        {/* Success icon */}
        <motion.div
          initial={{ scale: 0 }}
          animate={{ scale: 1 }}
          transition={{ type: 'spring', stiffness: 200, damping: 15, delay: 0.1 }}
          className="text-center mb-4"
        >
          <CheckCircle className="h-16 w-16 text-emerald-300 mx-auto" />
        </motion.div>

        {/* Thank you */}
        <motion.p
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.3 }}
          className="text-xl font-medium text-emerald-100 mb-4 text-center"
        >
          {t('kioskThankYou')}
        </motion.p>

        {/* Ticket card - enhanced with QR, customer name, service */}
        <motion.div
          initial={{ scale: 0.3, opacity: 0, rotateY: -15 }}
          animate={{ scale: 1, opacity: 1, rotateY: 0 }}
          transition={{ type: 'spring', stiffness: 120, damping: 10, delay: 0.2 }}
          className="bg-white rounded-3xl p-6 sm:p-8 shadow-2xl mb-6 ticket-card relative overflow-hidden"
        >
          {/* Decorative corner accents */}
          <div className="absolute top-0 start-0 w-16 h-16">
            <div className="absolute top-2 start-2 w-8 h-0.5 bg-emerald-400 rounded-full" />
            <div className="absolute top-2 start-2 h-8 w-0.5 bg-emerald-400 rounded-full" />
          </div>
          <div className="absolute top-0 end-0 w-16 h-16">
            <div className="absolute top-2 end-2 w-8 h-0.5 bg-emerald-400 rounded-full" />
            <div className="absolute top-2 end-2 h-8 w-0.5 bg-emerald-400 rounded-full" />
          </div>
          <div className="absolute bottom-0 start-0 w-16 h-16">
            <div className="absolute bottom-2 start-2 w-8 h-0.5 bg-emerald-400 rounded-full" />
            <div className="absolute bottom-2 start-2 h-8 w-0.5 bg-emerald-400 rounded-full" />
          </div>
          <div className="absolute bottom-0 end-0 w-16 h-16">
            <div className="absolute bottom-2 end-2 w-8 h-0.5 bg-emerald-400 rounded-full" />
            <div className="absolute bottom-2 end-2 h-8 w-0.5 bg-emerald-400 rounded-full" />
          </div>

          {/* Agency name */}
          <p className="text-xs font-semibold text-emerald-600 uppercase tracking-widest text-center mb-1">
            {agencyDisplayName}
          </p>

          <p className="text-[10px] text-gray-400 mb-2 text-center">
            {t('yourTicketKiosk')}
          </p>

          {/* Ticket number */}
          <motion.p
            initial={{ scale: 0.5, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ type: 'spring', stiffness: 200, damping: 12, delay: 0.5 }}
            className="text-[80px] sm:text-[96px] leading-none font-black text-gray-900 text-center tracking-tight"
          >
            {ticket.ticketNumber}
          </motion.p>

          {/* Animated underline */}
          <motion.div
            initial={{ width: 0 }}
            animate={{ width: '60%' }}
            transition={{ delay: 0.8, duration: 0.5, ease: 'easeOut' }}
            className="h-1 bg-gradient-to-r from-emerald-400 via-teal-400 to-emerald-400 rounded-full mx-auto mt-3 mb-3"
          />

          {/* Customer name & service */}
          <div className="space-y-1 text-center">
            <p className="text-sm font-bold text-gray-800">{ticket.customerName}</p>
            <p className="text-xs text-gray-500">{serviceDisplayName}</p>
            <p className="text-[10px] text-gray-400">
              {ticket.joinedAt ? new Date(ticket.joinedAt).toLocaleString() : ''}
            </p>
          </div>

          {/* QR Code */}
          {ticketQrUrl && !isOfflineMode && (
            <motion.div
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ delay: 1.0, type: 'spring', stiffness: 200 }}
              className="mt-4 flex flex-col items-center"
            >
              <div className="rounded-xl bg-gray-50 border border-gray-200 p-2">
                <img src={ticketQrUrl} alt="QR Code" className="w-28 h-28 sm:w-32 sm:h-32" />
              </div>
              <p className="text-[10px] text-gray-400 mt-1.5">
                {t('scanToTrackQueue') || 'Scan QR to track your queue'}
              </p>
            </motion.div>
          )}
        </motion.div>

        {/* Position & Wait - big numbers */}
        <div className="grid grid-cols-2 gap-4 mb-4 print:hidden">
          {!isOfflineMode && (
          <motion.div
            initial={{ opacity: 0, x: rtl ? 20 : -20 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: 0.6 }}
            className="bg-white/15 backdrop-blur-sm rounded-2xl p-5 text-center"
          >
            <Hash className="h-6 w-6 text-emerald-200 mx-auto mb-2" />
            <p className="text-4xl font-bold text-white">{ticket.position}</p>
            <p className="text-sm text-emerald-200">{t('positionInQueue')}</p>
          </motion.div>
          )}
          <motion.div
            initial={{ opacity: 0, x: rtl ? -20 : 20 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: 0.7 }}
            className={`bg-white/15 backdrop-blur-sm rounded-2xl p-5 text-center ${isOfflineMode ? 'col-span-2' : ''}`}
          >
            <Clock className="h-6 w-6 text-emerald-200 mx-auto mb-2" />
            <p className="text-4xl font-bold text-white">{ticket.estimatedWaitMinutes}</p>
            <p className="text-sm text-emerald-200">{t('minutesKiosk')}</p>
          </motion.div>
        </div>

        {/* Currently Serving at each counter */}
        {!isOfflineMode && <CurrentlyServingDisplay queueStats={queueStats} t={t} />}

        {/* Estimated Wait - dedicated display */}
        {!isOfflineMode && (
        <div className="mt-4">
          <EstimatedWaitDisplay ticket={ticket} queueStats={queueStats} lang={lang} t={t} />
        </div>
        )}
      </div>

      {/* Print error display */}
      {printError && (
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          className="w-full p-3 rounded-xl bg-red-500/20 text-red-200 text-sm text-center mb-2 print:hidden"
        >
          <AlertTriangle className="h-4 w-4 inline mr-1" />
          {printError}
          <button
            onClick={onClearPrintError}
            className="ml-2 text-red-300 hover:text-white"
          >
            ✕
          </button>
        </motion.div>
      )}

      {/* Action buttons - hidden in print */}
      <div className="flex gap-3 print:hidden mt-4">
        {!isOfflineMode && (
        <motion.button
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.9 }}
          whileHover={{ scale: 1.02 }}
          whileTap={{ scale: 0.98 }}
          onClick={onPrint}
          className="flex-1 min-h-[60px] rounded-2xl bg-white/20 backdrop-blur-sm text-white font-semibold text-lg flex items-center justify-center gap-2 hover:bg-white/30 transition-colors"
        >
          <Printer className="h-5 w-5" />
          {t('printTicket')}
        </motion.button>
        )}
        {ticketQrUrl && !isOfflineMode && (
          <motion.button
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 1.0 }}
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
            onClick={onToggleQrDetail}
            className="flex-1 min-h-[60px] rounded-2xl bg-amber-500/90 backdrop-blur-sm text-white font-semibold text-lg flex items-center justify-center gap-2 hover:bg-amber-600/90 transition-colors"
          >
            <QrCode className="h-5 w-5" />
            {showQrDetail ? (t('hideQR') || 'Hide QR') : (t('showQR') || 'Show QR')}
          </motion.button>
        )}
        <motion.button
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 1.1 }}
          whileHover={{ scale: 1.02 }}
          whileTap={{ scale: 0.98 }}
          onClick={onReset}
          className={`min-h-[60px] rounded-2xl text-white font-semibold text-lg flex items-center justify-center gap-2 transition-colors ${
            isOfflineMode
              ? 'flex-1 bg-amber-500/80 hover:bg-amber-500'
              : 'flex-1 bg-white/20 backdrop-blur-sm hover:bg-white/30'
          }`}
        >
          {isOfflineMode ? <WifiOff className="h-5 w-5" /> : <RotateCcw className="h-5 w-5" />}
          {t('newTicket')}
        </motion.button>
      </div>

      {/* Large QR Detail View */}
      <AnimatePresence>
        {showQrDetail && ticketQrUrl && (
          <motion.div
            initial={{ opacity: 0, scale: 0.9, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.9, y: 20 }}
            className="mt-4 bg-white rounded-3xl p-6 shadow-2xl print:hidden"
          >
            <div className="text-center mb-3">
              <p className="text-lg font-bold text-gray-800">{ticket.customerName}</p>
              <p className="text-3xl font-black text-emerald-600">{ticket.ticketNumber}</p>
              <p className="text-xs text-gray-500">{serviceDisplayName}</p>
            </div>
            <div className="flex justify-center mb-3">
              <div className="rounded-2xl bg-white border-2 border-emerald-200 p-4 shadow-lg">
                <img src={ticketQrUrl} alt="QR Code" className="w-56 h-56 sm:w-64 sm:h-64" />
              </div>
            </div>
            <p className="text-[11px] text-gray-500 text-center">
              {t('walkInQRDescription') || 'Customer can scan this QR to link it to their account and track their queue.'}
            </p>
            <div className="flex gap-2 mt-4">
              <button
                onClick={onPrint}
                className="flex-1 min-h-[48px] rounded-xl bg-emerald-500 text-white font-semibold flex items-center justify-center gap-2 hover:bg-emerald-600 transition-colors"
              >
                <Printer className="h-4 w-4" />
                {t('printTicket')}
              </button>
              <button
                onClick={onToggleQrDetail}
                className="flex-1 min-h-[48px] rounded-xl bg-gray-100 text-gray-700 font-semibold flex items-center justify-center gap-2 hover:bg-gray-200 transition-colors"
              >
                {t('close') || 'Close'}
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Inactivity countdown */}
      {inactivitySeconds > 30 && (
        <motion.p
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="text-center text-emerald-200/60 text-xs mt-4 print:hidden"
        >
          {60 - inactivitySeconds}s
        </motion.p>
      )}
    </motion.div>
  );
}