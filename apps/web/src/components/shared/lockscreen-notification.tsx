'use client';

/**
 * Lock-screen notification UI (mobile shell — Public App Settings rebuild).
 *
 * The native Android plugin posts REAL lock-screen notifications (full-screen
 * intent over the keyguard, PUBLIC lock-screen visibility). This file is the
 * IN-APP half the mobile app was missing:
 *
 *   • LockscreenNotificationCard — an Android-12-style lock-screen notification
 *     card (dark glass surface, app icon, app-name header, title + body,
 *     emerald accent, RTL-safe).
 *   • LockscreenNotificationGate — mount once at the app root. It listens on
 *     the lib/lockscreen-events bus:
 *       - app in foreground → the card slides in as a heads-up (auto-dismiss);
 *       - app was backgrounded when the alert fired → the card is shown
 *         full-screen the moment the user returns to the app (mirroring the
 *         lock screen they just saw) with an explicit "open" action.
 *
 * Web/desktop shells never render anything (the bus only fires from the
 * Capacitor notification paths), so mounting the gate globally is free.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { BellRing, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useLanguage } from '@/hooks/use-language';
import { onLockscreenEvent, takePendingLockscreenEvent, type LockscreenNotificationEvent } from '@/lib/lockscreen-events';
import { wasTurnAlertDismissedNatively } from '@/lib/notification-channel';

// ─── The card ─────────────────────────────────────────────────────────────────

export function LockscreenNotificationCard({
  event,
  onOpen,
  compact = false,
}: {
  event: LockscreenNotificationEvent;
  onOpen?: () => void;
  compact?: boolean;
}) {
  const { t, lang } = useLanguage();
  const time = new Date(event.at).toLocaleTimeString(lang === 'ar' ? 'ar-DZ' : lang === 'fr' ? 'fr-FR' : 'en-GB', {
    hour: '2-digit',
    minute: '2-digit',
  });

  return (
    <button
      type="button"
      onClick={onOpen}
      dir={lang === 'ar' ? 'rtl' : 'ltr'}
      className={cnCard(compact)}
      aria-label={`${event.title} — ${t('lockscreenOpenApp')}`}
    >
      <div className="flex items-start gap-3">
        <div className="h-9 w-9 rounded-xl bg-emerald-500/20 border border-emerald-400/30 flex items-center justify-center shrink-0">
          <BellRing className="h-[18px] w-[18px] text-emerald-300" />
        </div>
        <div className="flex-1 min-w-0 text-start">
          <div className="flex items-center gap-2 text-[11px] text-zinc-400">
            <span className="font-semibold tracking-wide text-zinc-300">BLASTI</span>
            <span aria-hidden="true">•</span>
            <span dir="ltr">{time}</span>
          </div>
          <p className="mt-0.5 text-sm font-semibold text-white leading-snug">{event.title}</p>
          {event.body ? (
            <p className="mt-0.5 text-[13px] text-zinc-300 leading-snug line-clamp-3">{event.body}</p>
          ) : null}
          {event.ticketNumber ? (
            <span className="mt-2 inline-flex items-center rounded-full bg-emerald-500/15 border border-emerald-400/30 px-2.5 py-0.5 text-[11px] font-bold text-emerald-300" dir="ltr">
              {event.ticketNumber}
            </span>
          ) : null}
        </div>
      </div>
    </button>
  );
}

function cnCard(compact: boolean): string {
  return [
    'block w-full rounded-3xl border border-white/10 bg-zinc-900/95 shadow-2xl',
    'backdrop-blur-md p-4 text-start outline-none transition',
    'hover:border-white/20 focus-visible:ring-2 focus-visible:ring-emerald-400/60',
    compact ? 'max-w-sm' : 'max-w-md',
  ].join(' ');
}

// ─── The gate ─────────────────────────────────────────────────────────────────

type Mode = 'hidden' | 'heads-up' | 'resume';

export function LockscreenNotificationGate() {
  const { t } = useLanguage();
  const [event, setEvent] = useState<LockscreenNotificationEvent | null>(null);
  const [mode, setMode] = useState<Mode>('hidden');
  const headsUpTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const show = useCallback((next: LockscreenNotificationEvent, nextMode: Mode) => {
    setEvent(next);
    setMode(nextMode);
    if (headsUpTimer.current) clearTimeout(headsUpTimer.current);
    if (nextMode === 'heads-up') {
      headsUpTimer.current = setTimeout(() => {
        setMode((m) => (m === 'heads-up' ? 'hidden' : m));
      }, 6500);
    }
  }, []);

  const dismiss = useCallback(() => {
    if (headsUpTimer.current) clearTimeout(headsUpTimer.current);
    setMode('hidden');
  }, []);

  const openApp = useCallback(() => {
    dismiss();
    // Focus/scroll back into the app — the notification itself was already
    // posted natively; nothing else to do beyond closing the overlay.
    if (typeof window !== 'undefined') window.focus();
  }, [dismiss]);

  // Live events while the app is open (heads-up card).
  useEffect(() => {
    const off = onLockscreenEvent((e) => show(e, 'heads-up'));
    return off;
  }, [show]);

  // App resume: surface whatever fired while the user was away (the OS
  // already showed it on the actual lock screen — this mirrors it in-app)
  // — UNLESS the user already STOPPED it from the lock screen (native
  // notification swipe or the "Stop" action button): replaying an alert the
  // user explicitly dismissed would break the swipe-to-stop parity, so the
  // pending event is dropped instead.
  useEffect(() => {
    let cancelled = false;
    const reveal = () => {
      if (document.visibilityState !== 'visible') return;
      const pending = takePendingLockscreenEvent();
      if (!pending) return;
      void wasTurnAlertDismissedNatively(pending.at).then((dismissed) => {
        if (cancelled) return;
        if (dismissed) return; // user already stopped it on the lock screen
        show(pending, 'resume');
      });
    };
    document.addEventListener('visibilitychange', reveal);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', reveal);
      if (headsUpTimer.current) clearTimeout(headsUpTimer.current);
    };
  }, [show]);

  if (!event) return null;

  return (
    <AnimatePresence>
      {mode === 'heads-up' && (
        <motion.div
          key="lockscreen-heads-up"
          initial={{ y: -80, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: -80, opacity: 0 }}
          transition={{ type: 'spring', stiffness: 380, damping: 32 }}
          className="fixed inset-x-0 top-0 z-[180] flex justify-center px-3 pt-3 pointer-events-none"
          role="status"
        >
          <div className="pointer-events-auto relative w-full flex justify-center">
            <LockscreenNotificationCard event={event} onOpen={openApp} compact />
            <button
              type="button"
              onClick={dismiss}
              aria-label={t('lockscreenDismiss')}
              className="absolute top-1 end-1 h-7 w-7 rounded-full bg-white/5 border border-white/10 flex items-center justify-center text-zinc-300 hover:bg-white/10 transition-colors"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </motion.div>
      )}
      {mode === 'resume' && (
        <motion.div
          key="lockscreen-resume"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
          className="fixed inset-0 z-[180] bg-black/70 backdrop-blur-sm flex items-end sm:items-center justify-center p-4"
          role="alertdialog"
          aria-modal="true"
          aria-label={event.title}
        >
          <motion.div
            initial={{ y: 40, scale: 0.97 }}
            animate={{ y: 0, scale: 1 }}
            exit={{ y: 40, scale: 0.97 }}
            transition={{ type: 'spring', stiffness: 320, damping: 30 }}
            className="w-full max-w-md"
          >
            <LockscreenNotificationCard event={event} onOpen={openApp} />
            <div className="mt-3 flex gap-2">
              <Button onClick={openApp} className="flex-1 h-11 gap-2 bg-emerald-600 hover:bg-emerald-500 text-white">
                <BellRing className="h-4 w-4" />
                {t('lockscreenOpenApp')}
              </Button>
              <Button onClick={dismiss} variant="outline" className="h-11 bg-white/10 border-white/20 text-white hover:bg-white/20">
                {t('lockscreenDismiss')}
              </Button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
