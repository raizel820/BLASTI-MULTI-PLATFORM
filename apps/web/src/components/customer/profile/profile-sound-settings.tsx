'use client';
/**
 * Task 82 — Notification sound settings (customer, mobile-first).
 *
 * Lets the customer control the queue-call alert:
 *   • Volume slider (0–100%) with instant preview.
 *   • Sound source: BLASTI default chime OR a song/audio picked from the
 *     phone (file picker `accept="audio/*"` — opens the native picker on
 *     Android/iOS in the Capacitor app, the OS picker on desktop web).
 *   • Shows the picked file name + a button to remove it.
 *
 * Settings persist to localStorage, the audio blob to IndexedDB
 * (lib/notification-sound-settings.ts) and apply to every future alert.
 */
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import { Volume2, Music, Check, Loader2, Trash2, Play, Square } from 'lucide-react';
import { toast } from 'sonner';
import { motion } from 'framer-motion';
import type { TranslationKeys } from '@/i18n';
import {
  clearCustomNotificationSound,
  getNotificationSoundEngineState,
  getNotificationSoundSettings,
  saveCustomNotificationSound,
  saveNotificationSoundSettings,
  subscribeNotificationSound,
} from '@/lib/notification-sound-settings';
import { previewDefaultChime } from '@/lib/sounds';
import { cn } from '@/lib/utils';

interface ProfileSoundSettingsProps {
  /** Extra classes for the outer card. */
  className?: string;
  t: (key: TranslationKeys) => string;
}

/** One-shot preview player (stopped on unmount / re-choose). */
function usePreviewPlayer() {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);

  const stop = () => {
    if (audioRef.current) {
      try {
        audioRef.current.pause();
        audioRef.current.currentTime = 0;
      } catch {
        /* already stopped */
      }
      audioRef.current = null;
    }
    setPlaying(false);
  };

  const play = (url: string | null, volume: number) => {
    stop();
    try {
      const audio = new Audio(url ?? '');
      audio.volume = volume;
      audio.onended = () => setPlaying(false);
      audio.onerror = () => setPlaying(false);
      audioRef.current = audio;
      void audio.play().then(() => setPlaying(true)).catch(() => setPlaying(false));
    } catch {
      setPlaying(false);
    }
  };

  useEffect(() => stop, []);

  return { playing, play, stop };
}

export function ProfileSoundSettings({ className, t }: ProfileSoundSettingsProps) {
  const [volume, setVolume] = useState(100);
  const [source, setSource] = useState<'default' | 'custom'>('default');
  const [customName, setCustomName] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [clearing, setClearing] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const preview = usePreviewPlayer();

  // Mirror the engine state (also updates when another surface changes it).
  useEffect(() => {
    const sync = () => {
      const s = getNotificationSoundSettings();
      setVolume(s.volume);
      setSource(s.source);
      setCustomName(getNotificationSoundEngineState()?.customSoundName ?? null);
    };
    sync();
    return subscribeNotificationSound(sync);
  }, []);

  const handleVolumeChange = (value: number[]) => {
    const v = value[0] ?? 100;
    setVolume(v);
    saveNotificationSoundSettings({ volume: v });
  };

  const handleSourceChange = (next: 'default' | 'custom') => {
    if (next === 'custom' && !customName) {
      fileInputRef.current?.click();
      return;
    }
    saveNotificationSoundSettings({ source: next });
    setSource(next);
  };

  const handlePick = async (file: File | null | undefined) => {
    if (!file) return;
    setPicking(true);
    try {
      const result = await saveCustomNotificationSound(file);
      if (result.ok) {
        setSource('custom');
        toast.success(t('soundCustomSaved'));
      } else if (result.error === 'too-large') {
        toast.error(t('soundTooLarge'));
      } else if (result.error === 'not-audio') {
        toast.error(t('soundNotAudio'));
      } else {
        toast.error(t('error'));
      }
    } finally {
      setPicking(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleClearCustom = async () => {
    setClearing(true);
    try {
      preview.stop();
      await clearCustomNotificationSound();
      setSource('default');
      toast.success(t('soundCustomCleared'));
    } finally {
      setClearing(false);
    }
  };

  const handlePreview = () => {
    if (preview.playing) {
      preview.stop();
      return;
    }
    if (source === 'custom' && getNotificationSoundEngineState()?.customSoundUrl) {
      preview.play(getNotificationSoundEngineState()!.customSoundUrl!, volume / 100);
    } else {
      // Default chime preview — WebAudio, no shared player needed.
      previewDefaultChime(volume / 100);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25 }}
      className={cn('rounded-2xl border border-border bg-white dark:bg-gray-900/80 shadow-sm p-4', className)}
      data-testid="notification-sound-settings"
    >
      <div className="flex items-center gap-2 mb-4">
        <Volume2 className="h-4 w-4 text-emerald-600" />
        <p className="text-sm font-semibold text-foreground">{t('notificationSound')}</p>
      </div>

      {/* Volume */}
      <div className="mb-5">
        <div className="flex items-center justify-between mb-2">
          <Label className="text-xs text-muted-foreground">{t('soundVolume')}</Label>
          <span className="text-xs font-semibold text-emerald-700 dark:text-emerald-400" dir="ltr">
            {volume}%
          </span>
        </div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={handlePreview}
            aria-label={preview.playing ? t('stopPreview') : t('previewSound')}
            className="h-9 w-9 shrink-0 rounded-xl border border-border flex items-center justify-center text-muted-foreground hover:text-emerald-600 dark:hover:text-emerald-400 hover:border-emerald-200 dark:hover:border-emerald-800 transition-colors"
          >
            {preview.playing ? <Square className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
          </button>
          <Slider
            value={[volume]}
            min={0}
            max={100}
            step={5}
            onValueChange={handleVolumeChange}
            aria-label={t('soundVolume')}
            className="flex-1"
          />
        </div>
      </div>

      {/* Sound source */}
      <Label className="text-xs text-muted-foreground mb-2 block">{t('soundSource')}</Label>
      <div className="space-y-2" role="radiogroup" aria-label={t('soundSource')}>
        {/* Default chime — div[role=radio] (NOT a <button>: the custom row
            below contains an inner remove <button>, and buttons can never nest) */}
        <div
          role="radio"
          aria-checked={source === 'default'}
          tabIndex={0}
          onClick={() => handleSourceChange('default')}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleSourceChange('default'); } }}
          className={cn(
            'w-full flex items-center gap-3 rounded-xl border p-3 text-start transition-colors cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-emerald-500',
            source === 'default'
              ? 'border-emerald-300 dark:border-emerald-700 bg-emerald-50/60 dark:bg-emerald-900/20'
              : 'border-border hover:border-emerald-200 dark:hover:border-emerald-800',
          )}
        >
          <div
            className={cn(
              'h-9 w-9 rounded-lg flex items-center justify-center shrink-0',
              source === 'default' ? 'bg-emerald-100 dark:bg-emerald-900/40' : 'bg-muted',
            )}
          >
            <Volume2 className={cn('h-4 w-4', source === 'default' ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground')} />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-foreground">{t('soundDefault')}</p>
            <p className="text-xs text-muted-foreground">{t('soundDefaultDesc')}</p>
          </div>
          {source === 'default' && <Check className="h-4 w-4 text-emerald-600 shrink-0" />}
        </div>

        {/* Custom audio from device */}
        <div
          role="radio"
          aria-checked={source === 'custom'}
          tabIndex={0}
          onClick={() => handleSourceChange('custom')}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleSourceChange('custom'); } }}
          className={cn(
            'w-full flex items-center gap-3 rounded-xl border p-3 text-start transition-colors cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-emerald-500',
            source === 'custom'
              ? 'border-emerald-300 dark:border-emerald-700 bg-emerald-50/60 dark:bg-emerald-900/20'
              : 'border-border hover:border-emerald-200 dark:hover:border-emerald-800',
          )}
        >
          <div
            className={cn(
              'h-9 w-9 rounded-lg flex items-center justify-center shrink-0',
              source === 'custom' ? 'bg-emerald-100 dark:bg-emerald-900/40' : 'bg-muted',
            )}
          >
            <Music className={cn('h-4 w-4', source === 'custom' ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground')} />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-foreground">{t('soundCustom')}</p>
            <p className="text-xs text-muted-foreground truncate">
              {customName ? customName : t('soundCustomNone')}
            </p>
          </div>
          {picking ? (
            <Loader2 className="h-4 w-4 animate-spin text-emerald-600 shrink-0" />
          ) : customName ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                void handleClearCustom();
              }}
              aria-label={t('soundCustomRemove')}
              disabled={clearing}
              className="h-8 w-8 rounded-lg flex items-center justify-center text-muted-foreground hover:text-red-600 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors shrink-0"
            >
              {clearing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
            </button>
          ) : null}
        </div>
      </div>

      <Button
        type="button"
        variant="outline"
        size="sm"
        className="w-full mt-3 h-10 rounded-xl"
        onClick={() => fileInputRef.current?.click()}
        disabled={picking}
      >
        <Music className="h-4 w-4 me-2" />
        {t('soundChooseFromDevice')}
      </Button>
      <input
        ref={fileInputRef}
        type="file"
        accept="audio/*"
        className="hidden"
        onChange={(e) => void handlePick(e.target.files?.[0])}
      />
    </motion.div>
  );
}
