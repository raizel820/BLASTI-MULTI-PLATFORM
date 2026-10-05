// Notification sound utilities

import {
  getNotificationSoundEngineState,
  initNotificationSoundEngine,
} from '@/lib/notification-sound-settings';

// Task 82 — load persisted volume + custom notification song into the engine
// (fire-and-forget; alerts fall back to the built-in chime until it lands).
if (typeof window !== 'undefined') {
  void initNotificationSoundEngine();
}

let audioContext: AudioContext | null = null;
let isPlaying = false;
let loopInterval: ReturnType<typeof setInterval> | null = null;
let currentReservationId: string | null = null;
let autoStopTimeout: ReturnType<typeof setTimeout> | null = null;

/** Task 82 — transient volume override used only by previewDefaultChime(). */
let overrideVolume: number | null = null;

// Track which reservations have already triggered the sound
// so we don't re-trigger when the component remounts
const confirmedReservations = new Set<string>();

function getAudioContext(): AudioContext {
  if (!audioContext) {
    audioContext = new AudioContext();
  }
  return audioContext;
}

/**
 * Play the customer-selected custom notification audio (Task 82), if one is
 * active. Returns true when playback was started.
 */
function playCustomNotificationSound(): boolean {
  const state = getNotificationSoundEngineState();
  if (state.source !== 'custom' || !state.customSoundUrl) return false;
  try {
    const audio = new Audio(state.customSoundUrl);
    audio.volume = state.volume;
    const p = audio.play();
    if (p && typeof p.catch === 'function') {
      p.catch(() => {
        /* autoplay guard / decode error — silent fallback */
      });
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Play an urgent notification chime - ascending two-tone alert
 */
function playChime() {
  try {
    const ctx = getAudioContext();
    if (ctx.state === 'suspended') {
      ctx.resume();
    }

    const now = ctx.currentTime;
    // Task 82 — customer volume setting scales every tone.
    const vol = overrideVolume ?? getNotificationSoundEngineState().volume;

    // First tone (lower)
    const osc1 = ctx.createOscillator();
    const gain1 = ctx.createGain();
    osc1.type = 'sine';
    osc1.frequency.setValueAtTime(523.25, now); // C5
    osc1.frequency.setValueAtTime(659.25, now + 0.12); // E5
    gain1.gain.setValueAtTime(0.3 * vol, now);
    gain1.gain.exponentialRampToValueAtTime(0.01, now + 0.35);
    osc1.connect(gain1);
    gain1.connect(ctx.destination);
    osc1.start(now);
    osc1.stop(now + 0.35);

    // Second tone (higher, slightly delayed)
    const osc2 = ctx.createOscillator();
    const gain2 = ctx.createGain();
    osc2.type = 'sine';
    osc2.frequency.setValueAtTime(659.25, now + 0.15); // E5
    osc2.frequency.setValueAtTime(783.99, now + 0.27); // G5
    gain2.gain.setValueAtTime(0.3 * vol, now + 0.15);
    gain2.gain.exponentialRampToValueAtTime(0.01, now + 0.5);
    osc2.connect(gain2);
    gain2.connect(ctx.destination);
    osc2.start(now + 0.15);
    osc2.stop(now + 0.5);

    // Third tone (highest)
    const osc3 = ctx.createOscillator();
    const gain3 = ctx.createGain();
    osc3.type = 'sine';
    osc3.frequency.setValueAtTime(783.99, now + 0.3); // G5
    osc3.frequency.setValueAtTime(1046.5, now + 0.42); // C6
    gain3.gain.setValueAtTime(0.35 * vol, now + 0.3);
    gain3.gain.exponentialRampToValueAtTime(0.01, now + 0.65);
    osc3.connect(gain3);
    gain3.connect(ctx.destination);
    osc3.start(now + 0.3);
    osc3.stop(now + 0.65);
  } catch (e) {
    // AudioContext may not be available or may fail silently
    console.warn('[sounds] playChime error:', e);
  }
}

/**
 * Task 82 — preview the built-in chime at a given volume (settings UI).
 * Bypasses the alert loop entirely (no reservation bookkeeping).
 */
export function previewDefaultChime(volume: number) {
  try {
    overrideVolume = volume;
    playChime();
  } catch {
    /* ignore */
  } finally {
    overrideVolume = null;
  }
}

/**
 * Start playing looping notification sound for a specific reservation
 * Includes robust error handling and guaranteed auto-stop
 */
export function startNotificationSound(reservationId?: string) {
  // Don't start sound for already-confirmed reservations
  if (reservationId && confirmedReservations.has(reservationId)) return;
  
  // If already playing for a different reservation, stop first
  if (isPlaying) {
    stopNotificationSound();
  }
  
  isPlaying = true;
  currentReservationId = reservationId || null;

  // Play immediately — the custom song (if set) wins over the built-in chime
  try {
    if (!playCustomNotificationSound()) {
      playChime();
    }
  } catch (e) {
    console.warn('[sounds] Initial chime failed:', e);
    // Continue even if first chime fails
  }

  // Loop every 4 seconds, but auto-stop after 30 seconds max (reduced from 60)
  let elapsed = 0;
  loopInterval = setInterval(() => {
    elapsed += 4000;
    if (isPlaying && elapsed < 30000) {
      try {
        if (!playCustomNotificationSound()) {
          playChime();
        }
      } catch (e) {
        console.warn('[sounds] Loop chime failed, stopping:', e);
        stopNotificationSound();
      }
    } else {
      // Auto-stop after 30 seconds to prevent endless ringing
      stopNotificationSound();
    }
  }, 4000);

  // Safety: guaranteed auto-stop after 35 seconds no matter what
  autoStopTimeout = setTimeout(() => {
    if (isPlaying) {
      console.warn('[sounds] Force-stopping notification sound after safety timeout');
      stopNotificationSound();
    }
  }, 35000);
}

/**
 * Stop playing notification sound and clean up all resources
 */
export function stopNotificationSound() {
  isPlaying = false;
  currentReservationId = null;
  if (loopInterval) {
    clearInterval(loopInterval);
    loopInterval = null;
  }
  if (autoStopTimeout) {
    clearTimeout(autoStopTimeout);
    autoStopTimeout = null;
  }
}

/**
 * Mark a reservation as confirmed (user acknowledged the call)
 * This prevents the sound from re-triggering when the component remounts
 */
export function markReservationConfirmed(reservationId: string) {
  confirmedReservations.add(reservationId);
  stopNotificationSound();
}

/**
 * Check if a reservation has already been confirmed
 */
export function isReservationConfirmed(reservationId: string): boolean {
  return confirmedReservations.has(reservationId);
}

/**
 * Play a one-time confirmation sound
 */
export function playConfirmSound() {
  try {
    const ctx = getAudioContext();
    if (ctx.state === 'suspended') {
      ctx.resume();
    }

    const now = ctx.currentTime;
    const vol = overrideVolume ?? getNotificationSoundEngineState().volume;

    // Quick ascending confirmation beep
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(600, now);
    osc.frequency.linearRampToValueAtTime(900, now + 0.1);
    gain.gain.setValueAtTime(0.2 * vol, now);
    gain.gain.exponentialRampToValueAtTime(0.01, now + 0.2);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.2);
  } catch (e) {
    console.warn('[sounds] playConfirmSound error:', e);
  }
}
