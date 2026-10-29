'use client';

/**
 * R-6d — Localized in-app notification titles.
 *
 * The API composes Notification rows server-side with hardcoded (mostly
 * English/Arabic-mixed) title strings at CREATION time, and SMS templates stay
 * as-is. Rather than rewriting server composition, the render layer maps the
 * KNOWN Notification.type values to localized titles (i18n keys prefixed
 * `notif*`) and falls back to the stored title untouched for unknown types so
 * nothing ever renders blank. The stored message BODY is always shown as-is.
 *
 * RTL-friendly: Arabic strings are plain — the app shell already applies dir.
 */

import type { TranslationKeys } from '@/i18n';

/** Notification.type → i18n key for the localized TITLE (title only). */
const NOTIFICATION_TITLE_KEYS: Record<string, TranslationKeys> = {
  QUEUE_CALLED: 'notifQueueCalled',
  TURN_CALL: 'notifQueueCalled', // legacy router type — same "your turn now" meaning
  QUEUE_JOINED: 'notifQueueJoined',
  QUEUE_COMPLETED: 'notifQueueCompleted',
  TURN_COMPLETED: 'notifQueueCompleted', // legacy router type
  QUEUE_CANCELLED: 'notifQueueCancelled',
  RESERVATION_CANCELLED: 'notifQueueCancelled',
  CANCELLED: 'notifQueueCancelled',
  QUEUE_POSTPONED: 'notifQueuePostponed',
  TURN_APPROACHING: 'notifTurnApproaching',
  ADVANCE_WARNING: 'notifTurnApproaching', // legacy router type
  NO_SHOW_WARNING: 'notifNoShowWarning',
  SMS_PURCHASED: 'notifSmsPurchased',
  RATING_SUBMITTED: 'notifRatingSubmitted',
  RECLAIM_SUCCESS: 'notifReclaimSuccess',
  QUEUE_UPDATE: 'notifQueueUpdate',
};

/**
 * Localized title for a notification row.
 * Known type → translated title; unknown/missing type → the stored title.
 */
export function localizedNotificationTitle(
  type: string | null | undefined,
  storedTitle: string,
  t: (key: TranslationKeys, params?: Record<string, string>) => string,
): string {
  const key = type ? NOTIFICATION_TITLE_KEYS[type] : undefined;
  return key ? t(key) : storedTitle;
}
