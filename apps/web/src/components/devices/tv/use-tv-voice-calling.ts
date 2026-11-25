'use client';

/**
 * use-tv-voice-calling — announces newly called tickets on the TV board.
 * ─────────────────────────────────────────────────────────────────────────────
 * Client half of the voice-calling feature (0.6.121). Watches the board's
 * `currentlyServing` snapshot, diffs it against the previously seen entries
 * and, for every NEWLY CALLED ticket, plays the offline announcement cycle
 * (chime → Arabic → French → English) through the dedicated voice service
 * (apps/desktop/local-api/lib/voice-service.js, port :3084, espeak-ng WASM).
 *
 * Safety rails:
 *   • Announces only on the DEVICE SURFACE (?mode=device&type=TV) — manager
 *     previews and embeds stay silent.
 *   • The FIRST snapshot after boot is recorded silently (no announcing of
 *     tickets that were called before the TV was turned on).
 *   • Dedupes by ticket id + calledAt (a RECALL re-announces, a re-render
 *     never does), bounded memory.
 *   • Announcements are serialized (max 3 queued) — two simultaneous calls
 *     speak one after the other, never overlapping.
 *   • ?vc_test=1 plays a sample announcement ~3.5s after boot (field diag).
 */

import { useEffect, useMemo, useRef } from 'react';
import {
  buildAnnouncementLines, parseVoiceCalling, playAnnouncement, stopAnnouncement,
  warmUpVoiceAudio, playTestAnnouncement, type VoiceCallingConfig,
} from '@/lib/tv-voice';

interface ServingEntry {
  id: string;
  ticketNumber: string;
  counterName?: string | null;
  calledAt?: string | null;
}

export interface UseTvVoiceCallingOptions {
  /** The board's currentlyServing array (raw queue-status payload). */
  serving: ReadonlyArray<ServingEntry> | null | undefined;
  /**
   * Voice-calling config — either an already-parsed config or the raw
   * displaySettings blob (voiceCalling is read out of it).
   */
  config?: VoiceCallingConfig | unknown;
}

const MAX_PENDING = 3;
const MAX_SEEN = 300;

// ?vc_test=1 fires ONCE per page load — a module flag survives React
// StrictMode's dev double-mount so the sample never announces twice.
let vcTestPlayed = false;

export function useTvVoiceCalling({ serving, config }: UseTvVoiceCallingOptions): void {
  // Parse once per displaySettings blob identity.
  const voiceConfig = useMemo(() => parseVoiceCalling(config), [config]);

  // Device-surface gate — computed once (the URL never changes on a TV board).
  const isDeviceSurface = useMemo(() => {
    if (typeof window === 'undefined') return false;
    try {
      const params = new URLSearchParams(window.location.search);
      return params.get('mode') === 'device' && params.get('type') === 'TV';
    } catch {
      return false;
    }
  }, []);

  const seenRef = useRef<Map<string, boolean>>(new Map());
  const pendingRef = useRef<ServingEntry[]>([]);
  const drainingRef = useRef(false);
  const configRef = useRef(voiceConfig);
  useEffect(() => {
    configRef.current = voiceConfig;
  }, [voiceConfig]);

  // Warm the audio unlock on boot (first remote key / touch unblocks audio).
  useEffect(() => {
    warmUpVoiceAudio();
    return () => { stopAnnouncement(); };
  }, []);

  const drain = useMemo(() => {
    // Serialized announcement pump — one chain at a time, config re-read
    // fresh each drain so settings changes apply to the NEXT announcement.
    const pump = async () => {
      if (drainingRef.current) return;
      drainingRef.current = true;
      try {
        while (pendingRef.current.length > 0) {
          const entry = pendingRef.current.shift();
          if (!entry) break;
          const lines = buildAnnouncementLines(entry, configRef.current.languages);
          console.info(`[TVVoice] announcing ticket ${entry.ticketNumber} (${lines.length} langs, service pending probe)`);
          try {
            await playAnnouncement(lines, configRef.current);
          } catch (err) {
            console.warn('[TVVoice] announcement failed:', err);
          }
        }
      } finally {
        drainingRef.current = false;
      }
    };
    return () => { void pump(); };
  }, []);

  // ── Serving diff → announcements ──────────────────────────────────────────
  useEffect(() => {
    if (!serving || serving.length === 0) return;
    const seen = seenRef.current;
    const firstSnapshot = seen.size === 0;
    let enqueued = false;
    for (const item of serving) {
      if (!item || !item.id || !item.ticketNumber) continue;
      // id + calledAt: a recall (same ticket, new call time) re-announces.
      const key = `${item.id}|${item.calledAt || ''}`;
      if (seen.has(key)) continue;
      seen.set(key, true);
      if (firstSnapshot) continue; // boot snapshot — record only
      if (!isDeviceSurface || !configRef.current.enabled) continue;
      if (pendingRef.current.length >= MAX_PENDING) continue;
      pendingRef.current.push(item);
      enqueued = true;
    }
    // Bound the seen map (a day of traffic stays tiny, but be defensive).
    while (seen.size > MAX_SEEN) {
      const oldest = seen.keys().next().value;
      if (oldest === undefined) break;
      seen.delete(oldest);
    }
    if (enqueued) drain();
  }, [serving, isDeviceSurface, drain]);

  // ── ?vc_test=1 field diagnostic — one sample announcement after boot ──────
  // NOTE: vcTestPlayed is set INSIDE the timer callback (fire time), never in
  // the effect body — React StrictMode runs mount→cleanup→mount in dev, so a
  // flag set at schedule time would cancel the first timer and permanently
  // suppress the second schedule (the sample would never announce).
  useEffect(() => {
    if (!isDeviceSurface || vcTestPlayed) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      const params = new URLSearchParams(window.location.search);
      if (params.get('vc_test') !== '1') return;
      timer = setTimeout(() => {
        vcTestPlayed = true;
        if (!configRef.current.enabled) {
          console.info('[TVVoice] vc_test ignored — voice calling is disabled');
          return;
        }
        console.info('[TVVoice] vc_test sample announcement');
        void playTestAnnouncement(configRef.current);
      }, 3500);
    } catch { /* no URL — skip */ }
    return () => { if (timer) clearTimeout(timer); };
  }, [isDeviceSurface]);
}
