'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useLanguage } from '@/hooks/use-language';
import { BellRing, UserCheck, Volume2, VolumeX } from 'lucide-react';
import { startNotificationSound, stopNotificationSound } from '@/lib/sounds';
import { closeTurnNotifications } from '@/lib/turn-alert-sleep';

interface AggressiveTurnAlertProps {
  visible: boolean;
  ticketNumber: string;
  agencyName: string;
  onDismiss: () => void;
}

export function AggressiveTurnAlert({ visible, ticketNumber, agencyName, onDismiss }: AggressiveTurnAlertProps) {
  const { t } = useLanguage();
  const [flashColor, setFlashColor] = useState<'red' | 'green'>('red');
  const [soundMuted, setSoundMuted] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Flash red/green alternately
  useEffect(() => {
    if (!visible) return;
    const interval = setInterval(() => {
      setFlashColor(prev => prev === 'red' ? 'green' : 'red');
    }, 600);
    return () => clearInterval(interval);
  }, [visible]);

  // Vibrate phone
  useEffect(() => {
    if (!visible) return;
    if ('vibrate' in navigator) {
      const pattern = [200, 100, 200, 100, 200, 100, 400];
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
          className="fixed inset-0 z-[9999] flex flex-col items-center justify-center"
          style={{
            backgroundColor: flashColor === 'red' ? '#dc2626' : '#059669',
          }}
        >
          {/* Animated background pulse */}
          <motion.div
            animate={{ scale: [1, 1.2, 1], opacity: [0.3, 0.5, 0.3] }}
            transition={{ duration: 1.2, repeat: Infinity, ease: 'easeInOut' }}
            className="absolute inset-0 rounded-full"
            style={{
              background: flashColor === 'red'
                ? 'radial-gradient(circle, rgba(255,255,255,0.2) 0%, transparent 70%)'
                : 'radial-gradient(circle, rgba(255,255,255,0.2) 0%, transparent 70%)',
            }}
          />

          {/* Sound toggle */}
          <button
            onClick={() => setSoundMuted(!soundMuted)}
            className="absolute top-6 right-6 h-12 w-12 rounded-full bg-white/20 flex items-center justify-center z-10"
            aria-label={soundMuted ? 'Unmute sound' : 'Mute sound'}
          >
            {soundMuted ? <VolumeX className="h-6 w-6 text-white" /> : <Volume2 className="h-6 w-6 text-white" />}
          </button>

          {/* Bell icon with animation */}
          <motion.div
            animate={{
              rotate: [0, 15, -15, 15, -15, 0],
              scale: [1, 1.2, 1, 1.2, 1, 1]
            }}
            transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}
            className="mb-6"
          >
            <BellRing className="h-20 w-20 text-white" />
          </motion.div>

          {/* "IT IS YOUR TURN" text */}
          <motion.h1
            animate={{ scale: [1, 1.05, 1] }}
            transition={{ duration: 0.8, repeat: Infinity, ease: 'easeInOut' }}
            className="text-4xl sm:text-6xl font-black text-white text-center mb-2 px-4"
          >
            {t('itIsYourTurn')}
          </motion.h1>

          {/* Subtitle */}
          <p className="text-lg text-white/70 mb-6 px-4 text-center">
            {t('turnAlertSubtitle')}
          </p>

          {/* Ticket number - MASSIVE */}
          <motion.div
            animate={{ scale: [1, 1.1, 1] }}
            transition={{ duration: 0.6, repeat: Infinity, ease: 'easeInOut' }}
            className="bg-white/20 backdrop-blur-sm rounded-3xl px-12 py-6 mb-4"
          >
            <span className="text-6xl sm:text-8xl font-black text-white tracking-wider">
              {ticketNumber}
            </span>
          </motion.div>

          {/* Agency name */}
          <p className="text-xl text-white/80 mb-12 px-4 text-center">
            {agencyName}
          </p>

          {/* Giant "I'm Here" dismiss button */}
          <motion.button
            whileTap={{ scale: 0.95 }}
            onClick={handleDismiss}
            className="w-4/5 max-w-sm h-20 rounded-2xl bg-white text-2xl font-bold shadow-2xl flex items-center justify-center gap-3"
            style={{ color: flashColor === 'red' ? '#dc2626' : '#059669' }}
          >
            <UserCheck className="h-8 w-8" />
            {t('imHere')}
          </motion.button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
