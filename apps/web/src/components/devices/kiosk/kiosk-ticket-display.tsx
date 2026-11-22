'use client';

import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  CheckCircle,
  Hash,
  Clock,
  Printer,
  QrCode,
  WifiOff,
  Monitor,
  Timer,
  AlertTriangle,
  X,
} from 'lucide-react';
import type { TicketInfo, QueueStats, KioskViewportSize } from './kiosk-types';
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
      className="bg-white/10 backdrop-blur-sm rounded-2xl p-3 print:hidden"
    >
      <div className="flex items-center gap-2 mb-2">
        <Monitor className="h-4 w-4 text-emerald-200" />
        <p className="text-sm font-semibold text-emerald-100">{t('currentlyServingKiosk')}</p>
      </div>
      {servingList && servingList.length > 0 ? (
        <div className="grid grid-cols-2 gap-2">
          {servingList.slice(0, 4).map((item, i) => (
            <div key={i} className="bg-white/10 rounded-xl p-2 text-center">
              <p className="text-xl font-bold text-white">{item.ticketNumber}</p>
              {item.counterName && (
                <p className="text-[10px] text-emerald-200/80 mt-0.5">{item.counterName}</p>
              )}
            </div>
          ))}
        </div>
      ) : currentServing ? (
        <div className="bg-white/10 rounded-xl p-2.5 text-center">
          <motion.p
            animate={{ scale: [1, 1.05, 1] }}
            transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}
            className="text-2xl font-bold text-white"
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
      className="bg-white/10 backdrop-blur-sm rounded-2xl p-3 text-center print:hidden"
    >
      <div className="flex items-center justify-center gap-2 mb-1.5">
        <Timer className="h-4 w-4 text-emerald-200" />
        <p className="text-sm font-semibold text-emerald-100">{t('yourEstimatedWait') || 'Your Estimated Wait'}</p>
      </div>
      <div className="flex items-baseline justify-center gap-1">
        {waitMinutes >= 60 ? (
          <>
            <motion.p
              animate={{ scale: [1, 1.02, 1] }}
              transition={{ duration: 3, repeat: Infinity, ease: 'easeInOut' }}
              className="text-2xl font-bold text-white"
            >
              {Math.floor(waitMinutes / 60)}
            </motion.p>
            <span className="text-sm text-emerald-200">{lang === 'ar' ? 'ساعة' : lang === 'fr' ? 'h' : 'hr'}</span>
            {waitMinutes % 60 > 0 && (
              <>
                <motion.p
                  animate={{ scale: [1, 1.02, 1] }}
                  transition={{ duration: 3, repeat: Infinity, ease: 'easeInOut', delay: 0.1 }}
                  className="text-2xl font-bold text-white"
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
              className="text-2xl font-bold text-white"
            >
              {waitMinutes}
            </motion.p>
            <span className="text-sm text-emerald-200">{t('minutesKiosk')}</span>
          </>
        )}
      </div>
      {/* Auto-refresh indicator */}
      <p className="text-[10px] text-emerald-200/50 mt-1.5 flex items-center justify-center gap-1">
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
  /** 0.6.104 — viewport classification from device-kiosk (multi-layout flow). */
  size: KioskViewportSize;
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
  size,
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

  // ─── 0.6.104 — multi-layout responsive variants ─────────────────────────
  // The whole ticket screen must fit from ~320x560 phones to large tablets
  // with the action buttons ALWAYS on screen. Layout contract:
  //   root = full-height flex column
  //     content  (flex-1 min-h-0 overflow-y-auto) — shrinks/scrolls
  //     error    (shrink-0)
  //     actions  (shrink-0)  — pinned at the bottom, never pushed off-screen
  const isXs = size === 'xs';
  const isSm = size === 'sm';
  const isMd = size === 'md';
  const compact = isXs || isSm;

  // What each size shows/hides:
  //   xs : no in-card QR, no currently-serving, no estimated-wait display,
  //        compact grid (text-lg), 44px ticket number, 32px success icon.
  //   sm : same hides as xs (56px number, 40px icon).
  //   md : small in-card QR (w-20), normal grid with tight padding (p-3),
  //        64px number; currently-serving + estimated-wait stay hidden.
  //   lg : full design — QR in card, currently-serving + estimated-wait shown
  //        side-by-side to protect vertical space.
  const showQrInCard = !isOfflineMode && !!ticketQrUrl && (isMd || !compact);
  const showSideInfo = size === 'lg' && !isOfflineMode;

  const numSize = isXs ? 'text-[44px]' : isSm ? 'text-[56px]' : isMd ? 'text-[64px]' : 'text-[80px] xl:text-[96px]';
  const successIconCls = isXs ? 'h-8 w-8' : isSm ? 'h-10 w-10' : 'h-12 w-12 xl:h-16 xl:w-16';
  const thankYouCls = isXs ? 'text-sm' : isSm ? 'text-base' : 'text-xl';
  const cardPad = isXs ? 'p-3' : isSm ? 'p-4' : 'p-5 xl:p-8';
  const gridCls = compact ? 'grid grid-cols-2 gap-2 mb-2' : 'grid grid-cols-2 gap-4 mb-3';
  const gridCellCls = compact ? 'bg-white/15 backdrop-blur-sm rounded-2xl p-2 text-center' : isMd ? 'bg-white/15 backdrop-blur-sm rounded-2xl p-3 text-center' : 'bg-white/15 backdrop-blur-sm rounded-2xl p-3 xl:p-5 text-center';
  const gridIconCls = compact ? 'h-4 w-4 text-emerald-200 mx-auto mb-1' : 'h-5 w-5 xl:h-6 xl:w-6 text-emerald-200 mx-auto mb-2';
  const gridValueCls = isXs ? 'text-lg font-bold text-white' : isSm ? 'text-2xl font-bold text-white' : 'text-3xl xl:text-4xl font-bold text-white';
  const gridLabelCls = compact ? 'text-[10px] text-emerald-200' : 'text-sm text-emerald-200';
  const qrImgCls = isMd ? 'w-20 h-20' : 'w-24 h-24 xl:w-28 xl:h-28';

  // 0.6.104 — entrance delays collapse on small screens (base 0.1) so the
  // ticket content is readable immediately (kiosk turnaround is fast).
  const entrance = (delay: number) => (compact ? Math.min(delay, 0.15) : delay);

  // Action row: single row of [Print receipt] [QR icon (xs/sm)] [Done] —
  // stacking the two primary buttons vertically is forbidden (it costs height).
  const actionBtnBase = `rounded-2xl font-semibold flex items-center justify-center gap-2 transition-colors ${
    isXs ? 'min-h-[48px] text-sm gap-1.5' : 'min-h-[52px] text-base lg:text-lg'
  }`;
  const qrToggleBtnCls = compact
    ? `${actionBtnBase} shrink-0 w-[52px] bg-white/20 backdrop-blur-sm text-white hover:bg-white/30`
    : `${actionBtnBase} flex-1 bg-white/20 backdrop-blur-sm text-white hover:bg-white/30`;

  return (
    <motion.div
      key="ticket"
      variants={pageVariants}
      initial="enter"
      animate="center"
      exit="exit"
      transition={{ duration: 0.3, ease: 'easeInOut' }}
      className="w-full max-w-md relative flex flex-col h-full max-h-full"
    >
      {/* Confetti animation */}
      <KioskConfetti active={showConfetti} />

      {/* Shrinkable content area — the fixed-height pieces (error + actions)
          below always stay on screen; this area absorbs the viewport budget. */}
      <div className="print-area flex-1 min-h-0 overflow-y-auto flex flex-col">
        <div className="my-auto w-full">
          {/* Success icon */}
          <motion.div
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            transition={{ type: 'spring', stiffness: 200, damping: 15, delay: entrance(0.1) }}
            className={`text-center ${isXs ? 'mb-2' : 'mb-3 xl:mb-4'}`}
          >
            <CheckCircle className={`${successIconCls} text-emerald-300 mx-auto`} />
          </motion.div>

          {/* Thank you */}
          <motion.p
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: entrance(0.3) }}
            className={`${thankYouCls} font-medium text-emerald-100 ${isXs ? 'mb-2' : 'mb-3 xl:mb-4'} text-center`}
          >
            {t('kioskThankYou')}
          </motion.p>

          {/* Ticket card - enhanced with QR, customer name, service */}
          <motion.div
            initial={{ scale: 0.3, opacity: 0, rotateY: -15 }}
            animate={{ scale: 1, opacity: 1, rotateY: 0 }}
            transition={{ type: 'spring', stiffness: 120, damping: 10, delay: entrance(0.2) }}
            className={`bg-white dark:bg-gray-900 rounded-3xl ${cardPad} shadow-2xl ${isXs ? 'mb-2' : 'mb-3 xl:mb-6'} ticket-card relative overflow-hidden`}
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
              transition={{ type: 'spring', stiffness: 200, damping: 12, delay: entrance(0.5) }}
              className={`${numSize} leading-none font-black text-gray-900 dark:text-gray-100 text-center tracking-tight`}
            >
              {ticket.ticketNumber}
            </motion.p>

            {/* Animated underline */}
            <motion.div
              initial={{ width: 0 }}
              animate={{ width: '60%' }}
              transition={{ delay: entrance(0.8), duration: 0.5, ease: 'easeOut' }}
              className={`h-1 bg-gradient-to-r from-emerald-400 via-teal-400 to-emerald-400 rounded-full mx-auto ${isXs ? 'mt-2 mb-2' : 'mt-3 mb-3'}`}
            />

            {/* Customer name & service */}
            <div className="space-y-1 text-center">
              {ticket.customerName && (
                <p className={`${isXs ? 'text-xs' : 'text-sm'} font-bold text-gray-800 dark:text-gray-200`}>{ticket.customerName}</p>
              )}
              <p className={`text-gray-500 dark:text-gray-400 ${isXs ? 'text-[11px]' : 'text-xs'}`}>{serviceDisplayName}</p>
              <p className="text-[10px] text-gray-400">
                {ticket.joinedAt ? new Date(ticket.joinedAt).toLocaleString() : ''}
              </p>
            </div>

            {/* QR Code (hidden on xs/sm to protect vertical space) */}
            {showQrInCard && (
              <motion.div
                initial={{ opacity: 0, scale: 0.8 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ delay: entrance(1.0), type: 'spring', stiffness: 200 }}
                className="mt-3 flex flex-col items-center"
              >
                <div className="rounded-xl bg-gray-50 dark:bg-gray-900/50 border border-gray-200 dark:border-gray-700 p-2">
                  <img src={ticketQrUrl!} alt="QR Code" className={qrImgCls} />
                </div>
                <p className="text-[10px] text-gray-400 mt-1.5">
                  {t('scanToTrackQueue') || 'Scan QR to track your queue'}
                </p>
              </motion.div>
            )}
          </motion.div>

          {/* Position & Wait - big numbers */}
          <div className={`${gridCls} print:hidden`}>
            {!isOfflineMode && (
            <motion.div
              initial={{ opacity: 0, x: rtl ? 20 : -20 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: entrance(0.6) }}
              className={gridCellCls}
            >
              <Hash className={gridIconCls} />
              <p className={gridValueCls}>{ticket.position}</p>
              <p className={gridLabelCls}>{t('positionInQueue')}</p>
            </motion.div>
            )}
            <motion.div
              initial={{ opacity: 0, x: rtl ? -20 : 20 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: entrance(0.7) }}
              className={`${gridCellCls} ${isOfflineMode ? 'col-span-2' : ''}`}
            >
              <Clock className={gridIconCls} />
              <p className={gridValueCls}>{ticket.estimatedWaitMinutes}</p>
              <p className={gridLabelCls}>{t('minutesKiosk')}</p>
            </motion.div>
          </div>

          {/* Currently Serving + Estimated Wait — lg only, side-by-side to
              protect vertical space (they duplicate info available above). */}
          {showSideInfo && (
            <div className="grid grid-cols-2 gap-3 items-start print:hidden">
              <CurrentlyServingDisplay queueStats={queueStats} t={t} />
              <EstimatedWaitDisplay ticket={ticket} queueStats={queueStats} lang={lang} t={t} />
            </div>
          )}
        </div>
      </div>

      {/* Print error display — compact banner above the action row (shrink-0,
          2-line clamp, never pushes the buttons off-screen). */}
      {printError && (
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          className="shrink-0 mt-2 p-2.5 rounded-xl bg-red-500/20 text-red-200 text-xs items-center gap-2 flex print:hidden"
        >
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <p className="flex-1 text-start line-clamp-2">{printError}</p>
          <button
            onClick={onClearPrintError}
            aria-label={t('close') || 'Close'}
            className="shrink-0 p-1 rounded-lg hover:bg-red-500/30 transition-colors"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </motion.div>
      )}

      {/* Action buttons — fixed at the bottom (shrink-0), hidden in print.
          Two primary choices per the 0.6.104 flow: print the receipt, or
          finish for the next customer. The QR toggle is a small secondary
          control so it does not compete with them. */}
      <div className={`shrink-0 flex ${isXs ? 'gap-2 mt-2' : 'gap-3 mt-3'} print:hidden`}>
        {!isOfflineMode && (
          <motion.button
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: entrance(0.9) }}
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
            onClick={onPrint}
            className={`${actionBtnBase} flex-1 bg-white/20 backdrop-blur-sm text-white hover:bg-white/30`}
          >
            <Printer className={isXs ? 'h-4 w-4' : 'h-5 w-5'} />
            {t('kioskPrintReceipt')}
          </motion.button>
        )}
        {ticketQrUrl && !isOfflineMode && (
          <motion.button
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: entrance(1.0) }}
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
            onClick={onToggleQrDetail}
            aria-label={showQrDetail ? (t('hideQR') || 'Hide QR') : (t('showQR') || 'Show QR')}
            className={qrToggleBtnCls}
          >
            <QrCode className={isXs ? 'h-4 w-4' : 'h-5 w-5'} />
            {!compact && (showQrDetail ? (t('hideQR') || 'Hide QR') : (t('showQR') || 'Show QR'))}
          </motion.button>
        )}
        <motion.button
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: entrance(1.1) }}
          whileHover={{ scale: 1.02 }}
          whileTap={{ scale: 0.98 }}
          onClick={onReset}
          className={`${actionBtnBase} ${
            isOfflineMode ? 'flex-1 bg-amber-500/80 hover:bg-amber-500 text-white' : 'flex-1 bg-amber-500/90 backdrop-blur-sm text-white hover:bg-amber-600/90'
          }`}
        >
          {isOfflineMode ? <WifiOff className={isXs ? 'h-4 w-4' : 'h-5 w-5'} /> : <CheckCircle className={isXs ? 'h-4 w-4' : 'h-5 w-5'} />}
          {t('kioskNextCustomer')}
        </motion.button>
      </div>

      {/* Inactivity countdown — tiny, inside the fixed footer block */}
      {inactivitySeconds > 30 && (
        <motion.p
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="shrink-0 text-center text-emerald-200/60 text-[10px] mt-1 print:hidden"
        >
          {60 - inactivitySeconds}s
        </motion.p>
      )}

      {/* Large QR Detail View — 0.6.104: rendered as a centered overlay so it
          never pushes content or the action row; the card itself may scroll on
          very small screens (max-h-full overflow-y-auto). */}
      <AnimatePresence>
        {showQrDetail && ticketQrUrl && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-3 print:hidden"
            onClick={onToggleQrDetail}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.9, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 20 }}
              className="bg-white dark:bg-gray-900 rounded-3xl p-4 sm:p-6 shadow-2xl w-full max-w-sm max-h-full overflow-y-auto print:hidden"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="text-center mb-3">
                {ticket.customerName && (
                  <p className="text-lg font-bold text-gray-800 dark:text-gray-200">{ticket.customerName}</p>
                )}
                <p className="text-3xl font-black text-emerald-600">{ticket.ticketNumber}</p>
                <p className="text-xs text-gray-500 dark:text-gray-400">{serviceDisplayName}</p>
              </div>
              <div className="flex justify-center mb-3">
                <div className="rounded-2xl bg-white dark:bg-gray-900 border-2 border-emerald-200 p-3 sm:p-4 shadow-lg">
                  <img src={ticketQrUrl} alt="QR Code" className="w-48 h-48 sm:w-56 sm:h-56" />
                </div>
              </div>
              <p className="text-[11px] text-gray-500 dark:text-gray-400 text-center">
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
                  className="flex-1 min-h-[48px] rounded-xl bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 font-semibold flex items-center justify-center gap-2 hover:bg-gray-200 transition-colors"
                >
                  {t('close') || 'Close'}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
