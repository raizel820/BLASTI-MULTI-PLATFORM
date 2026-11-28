'use client';

/**
 * AggressiveTurnAlert — 0.6.126 PHONE-CALL LAYOUT redesign.
 *
 * Audit requirement: "the notification layout should be similar to phone call
 * layout with both full screen layout and minimal notification with stop
 * button". The full-screen half is THIS component: when the call fires (or
 * the full-screen intent launches the app over the keyguard), the customer
 * sees a real incoming-call screen:
 *
 *   ┌──────────────────────────────┐
 *   │  BLASTI • It's your turn     │
 *   │  Agency name                 │
 *   │  Go to counter X             │
 *   │                              │
 *   │        ╭──────────╮          │
 *   │        │  (ring)  │   ← pulsing call avatar
 *   │        │ Ticket # │   ← massive ticket number
 *   │        ╰──────────╯          │
 *   │                              │
 *   │    ⬤ green        ⬤ red     │
 *   │   "I'm Here"     "Stop"      │  ← answer / decline call buttons
 *   └──────────────────────────────┘
 *
 * Behavior kept from the previous version: sound loop + vibration loop +
 * mute toggle; both buttons acknowledge (sleep-mode) and dismiss. The
 * MINIMAL half of the requirement lives in the native notification
 * (BlastiFirebaseMessagingService: CallStyle shade entry + Stop action).
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useLanguage } from '@/hooks/use-language';
import { BellRing, UserCheck, Volume2, VolumeX, X } from 'lucide-react';
import { startNotificationSound, stopNotificationSound } from '@/lib/sounds';
import { closeTurnNotifications } from '@/lib/turn-alert-sleep';

interface AggressiveTurnAlertProps {
  visible: boolean;
  ticketNumber: string;
  agencyName: string;
  /** r21-8 — counter pointer from the queue:called payload (optional). */
  counterName?: string;
  onDismiss: () => void;
}

export function AggressiveTurnAlert({ visible, ticketNumber, agencyName, counterName, onDismiss }: AggressiveTurnAlertProps) {
  const { t } = useLanguage();
  const [soundMuted, setSoundMuted] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Vibrate phone — call-like repeating pattern until dismissed
  useEffect(() => {
    if (!visible) return;
    if ('vibrate' in navigator) {
      const pattern = [500, 250, 500, 250, 500, 250, 800];
      navigator.vibrate(pattern);
      const interval = setInterval(() => {
        navigator.vibrate(pattern);
      }, 3000);
      return () => {
        clearInterval(interval);
        navigator.vibrate(0); // Stop vibration
      };
    }
  }, [visible]);

  // Play alarm sound using the existing sounds utility + attempt audio file
  useEffect(() => {
    if (!visible) return;

    // Start the existing notification chime sound from sounds.ts
    startNotificationSound();

    // Also try to play the alarm WAV file
    if (!soundMuted) {
      const audio = new Audio('/blasti_alarm.wav');
      audio.loop = true;
      audio.volume = 1.0;
      audio.play().catch(() => {
        // Audio might be blocked by browser autoplay policy — the sounds.ts chime still plays
      });
      audioRef.current = audio;
    }

    return () => {
      stopNotificationSound();
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.currentTime = 0;
        audioRef.current = null;
      }
    };
  }, [visible]);

  // Handle sound mute/unmute
  useEffect(() => {
    if (!visible) return;
    if (soundMuted) {
      stopNotificationSound();
      if (audioRef.current) {
        audioRef.current.pause();
      }
    } else {
      startNotificationSound();
      if (audioRef.current) {
        audioRef.current.play().catch(() => {});
      }
    }
  }, [soundMuted, visible]);

  const handleDismiss = useCallback(() => {
    stopNotificationSound();
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    if ('vibrate' in navigator) {
      navigator.vibrate(0);
    }
    closeTurnNotifications();
    onDismiss();
  }, [onDismiss]);

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.3 }}
          className="fixed inset-0 z-[9999] flex flex-col items-center overflow-hidden"
          role="alertdialog"
          aria-label={t('itIsYourTurn')}
          style={{
            background: 'linear-gradient(180deg, #0f172a 0%, #134e4a 55%, #0f172a 100%)',
          }}
        >
          {/* Soft call-screen glow behind the avatar */}
          <div
            className="absolute inset-x-0 top-1/4 h-1/2 -translate-y-1/2 pointer-events-none"
            style={{ background: 'radial-gradient(ellipse at center, rgba(16,185,129,0.28) 0%, transparent 65%)' }}
          />

          {/* Mute toggle */}
          <button
            onClick={() => setSoundMuted(!soundMuted)}
            className="absolute top-6 end-6 h-12 w-12 rounded-full bg-white/10 flex items-center justify-center z-10"
            aria-label={soundMuted ? 'Unmute sound' : 'Mute sound'}
          >
            {soundMuted ? <VolumeX className="h-6 w-6 text-white/80" /> : <Volume2 className="h-6 w-6 text-white/80" />}
          </button>

          {/* ── Header: caller identity ── */}
          <div className="flex flex-col items-center pt-[max(3.5rem,env(safe-area-inset-top))] px-6 text-center z-10">
            <span className="text-[0.65rem] font-bold tracking-[0.3em] text-emerald-400/80 uppercase mb-3">
              BLASTI
            </span>
            <motion.h1
              animate={{ scale: [1, 1.04, 1] }}
              transition={{ duration: 1.6, repeat: Infinity, ease: 'easeInOut' }}
              className="text-3xl sm:text-4xl font-black text-white"
            >
              {t('itIsYourTurn')}
            </motion.h1>
            <p className="text-base text-white/60 mt-2">{t('turnAlertSubtitle')}</p>

            {/* Caller: the agency */}
            <p className="text-xl font-bold text-white mt-6">{agencyName || 'BLASTI'}</p>
            {counterName ? (
              <motion.span
                animate={{ opacity: [0.85, 1, 0.85] }}
                transition={{ duration: 1.4, repeat: Infinity }}
                className="mt-3 inline-block rounded-full bg-emerald-500/20 border border-emerald-400/40 px-4 py-1.5 text-sm font-bold text-emerald-200"
              >
                {t('goCounterName', { name: counterName })}
              </motion.span>
            ) : null}
          </div>

          {/* ── Center: pulsing call avatar with the ticket number ── */}
          <div className="relative flex flex-col items-center justify-center grow z-10 px-6">
            {/* Expanding rings — incoming-call ripple */}
            <motion.div
              animate={{ scale: [1, 1.9], opacity: [0.5, 0] }}
              transition={{ duration: 2, repeat: Infinity, ease: 'easeOut' }}
              className="absolute h-44 w-44 rounded-full border-2 border-emerald-400/60"
            />
            <motion.div
              animate={{ scale: [1, 1.9], opacity: [0.5, 0] }}
              transition={{ duration: 2, repeat: Infinity, ease: 'easeOut', delay: 1 }}
              className="absolute h-44 w-44 rounded-full border-2 border-emerald-400/60"
            />
            <motion.div
              animate={{ scale: [1, 1.08, 1] }}
              transition={{ duration: 1.2, repeat: Infinity, ease: 'easeInOut' }}
              className="relative flex h-44 w-44 items-center justify-center rounded-full"
              style={{ background: 'radial-gradient(circle, rgba(16,185,129,0.35) 0%, rgba(16,185,129,0.12) 70%)', border: '2px solid rgba(16,185,129,0.5)' }}
            >
              <BellRing className="h-14 w-14 text-emerald-200" />
            </motion.div>

            {/* Ticket number — MASSIVE, the information that matters */}
            <motion.div
              animate={{ scale: [1, 1.05, 1] }}
              transition={{ duration: 0.8, repeat: Infinity, ease: 'easeInOut' }}
              className="mt-8 rounded-3xl bg-white/10 backdrop-blur-sm border border-white/15 px-10 py-5"
            >
              <span className="text-6xl sm:text-7xl font-black text-white tracking-wider">
                {ticketNumber}
              </span>
            </motion.div>
          </div>

          {/* ── Bottom: call-action buttons (answer / decline) ── */}
          <div className="w-full px-8 pb-[max(2rem,env(safe-area-inset-bottom))] z-10">
            <div className="mx-auto flex max-w-md items-end justify-center gap-16 sm:gap-24">
              {/* Decline — Stop the call/alert */}
              <div className="flex flex-col items-center gap-3">
                <motion.button
                  whileTap={{ scale: 0.9 }}
                  onClick={handleDismiss}
                  className="flex h-20 w-20 items-center justify-center rounded-full shadow-2xl"
                  style={{ background: '#dc2626' }}
                  aria-label={t('turnAlertStop')}
                >
                  <X className="h-9 w-9 text-white" />
                </motion.button>
                <span className="text-sm font-bold text-white/80">{t('turnAlertStop')}</span>
              </div>

              {/* Answer — I'm Here */}
              <div className="flex flex-col items-center gap-3">
                <motion.button
                  whileTap={{ scale: 0.9 }}
                  onClick={handleDismiss}
                  className="flex h-20 w-20 items-center justify-center rounded-full shadow-2xl"
                  style={{ background: '#10b981' }}
                  aria-label={t('imHere')}
                >
                  <UserCheck className="h-9 w-9 text-white" />
                </motion.button>
                <span className="text-sm font-bold text-white/80">{t('imHere')}</span>
              </div>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
