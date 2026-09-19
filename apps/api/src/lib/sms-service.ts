/**
 * @blasti/api — SMS service (Task 22 rewrite)
 *
 * The previous 8 hardcoded providers (WinSMS, NotifSend, AlgeriaSMS,
 * GreenSMS, M-Target, Twilio, Vonage, generic) are REMOVED. All SMS now goes
 * through the admin-configured eSMS Africa provider (messaging/sms-sender.ts
 * → ProviderConfig channel SMS).
 *
 * Kept for backward compatibility with existing callers (cron.ts,
 * notification-router.ts, notification-worker.ts):
 *   - sendSms(phone, message, userId?)  — credits/daily-limit/SmsLog handling unchanged
 *   - normalizeDzPhone / isValidDzPhone
 *   - getSmsTemplate(type, lang, vars)  — now backed by NotificationTemplate rows
 *   - getSmsSettings / getSmsUsageStats / getRecentSmsLogs / maskApiKey
 */

import { db } from '@blasti/db';
import { sendSmsViaProvider } from './messaging/sms-sender';
import { ensureDefaultTemplates, renderTemplate } from './messaging/template-service';

export interface SendSmsResult {
  success: boolean;
  error?: string;
  logId?: string;
  responseRaw?: string;
}

export interface SmsUsageStats {
  sentToday: number;
  sentThisWeek: number;
  sentThisMonth: number;
  totalSent: number;
  failedToday: number;
}

/** Algerian phone number regex: +213XXXXXXXXX or 0XXXXXXXXX */
const DZ_PHONE_REGEX = /^(\+213|00213)?(0?[5-7]\d{8})$/;

/**
 * Normalize an Algerian phone number to international format +213XXXXXXXXX
 * Handles: +213 5XX XXX XXX, 00213 5XX XXX XXX, 05XX XXX XXX, 5XX XXX XXX
 */
export function normalizeDzPhone(phone: string): string | null {
  if (!phone) return null;
  const cleaned = phone.replace(/[\s\-\.]/g, '');
  const match = cleaned.match(DZ_PHONE_REGEX);
  if (!match) return null;
  const local = match[2].replace(/^0/, ''); // strip leading 0
  return `+213${local}`;
}

/**
 * Validate an Algerian phone number
 */
export function isValidDzPhone(phone: string): boolean {
  if (!phone) return false;
  return DZ_PHONE_REGEX.test(phone.replace(/[\s\-\.]/g, ''));
}

// ─── Settings (legacy row retained for SmsLog FK + limits; provider config moved to ProviderConfig) ──

/**
 * Get current legacy SMS settings row (creates default if none exists).
 * The PROVIDER credentials now live in ProviderConfig (channel SMS) — this
 * row only carries delivery-policy fields (limits, test phone).
 */
export async function getSmsSettings() {
  let settings = await db.smsSettings.findFirst();
  if (!settings) {
    settings = await db.smsSettings.create({
      data: {
        provider: 'esmsafrica',
        apiUrl: 'https://api.esmsafrica.io/v1',
        apiKey: '',
        senderName: 'BLASTI',
        enabled: false,
        smsPerReminder: 1,
        maxSmsPerDay: 5,
        testPhoneNumber: '',
      },
    });
  }
  return settings;
}

/**
 * Mask an API key for display (show first 4 and last 4 chars)
 */
export function maskApiKey(key: string): string {
  if (!key || key.length <= 8) {
    return key ? '••••' : '';
  }
  return key.slice(0, 4) + '••••••••' + key.slice(-4);
}

// ─── Templates (now backed by NotificationTemplate rows) ────────────────────

interface SmsTemplateVars {
  customerName: string;
  ticketNumber: string;
  agencyName: string;
  position: number;
  estimatedMinutes: number;
}

type LegacyTemplateType = 'turnApproaching' | 'yourTurn' | 'noShowWarning';

const LEGACY_TYPE_TO_KEY: Record<LegacyTemplateType, string> = {
  turnApproaching: 'turn_approaching',
  yourTurn: 'your_turn',
  noShowWarning: 'no_show',
};

/** Fallbacks identical to the pre-Task-22 hardcoded strings (used only if the template row is missing/disabled) */
const FALLBACK_TEMPLATES: Record<LegacyTemplateType, Record<'ar' | 'fr' | 'en', (v: SmsTemplateVars) => string>> = {
  turnApproaching: {
    ar: (v) => `🔄 BLASTI: ${v.customerName}، اقترب دورك! تذكرتك ${v.ticketNumber} في ${v.agencyName}. المركز: ${v.position}. الانتظار المتوقع: ${v.estimatedMinutes} دقيقة.`,
    fr: (v) => `🔄 BLASTI: ${v.customerName}, votre tour approche! Billet ${v.ticketNumber} a ${v.agencyName}. Position: ${v.position}. Attente estimee: ${v.estimatedMinutes} min.`,
    en: (v) => `🔄 BLASTI: Dear ${v.customerName}, your turn is approaching! Ticket ${v.ticketNumber} at ${v.agencyName}. Position: ${v.position}. Est. wait: ${v.estimatedMinutes} min.`,
  },
  yourTurn: {
    ar: (v) => `🎫 BLASTI: ${v.customerName}، دورك الآن! تذكرتك ${v.ticketNumber} في ${v.agencyName}. يرجى التوجه فوراً.`,
    fr: (v) => `🎫 BLASTI: ${v.customerName}, c'est votre tour! Billet ${v.ticketNumber} a ${v.agencyName}. Veuillez vous presenter.`,
    en: (v) => `🎫 BLASTI: Dear ${v.customerName}, it's your turn! Ticket ${v.ticketNumber} at ${v.agencyName}. Please proceed now.`,
  },
  noShowWarning: {
    ar: (v) => `⚠️ BLASTI: ${v.customerName}، تم تخطي تذكرتك ${v.ticketNumber} في ${v.agencyName} بسبب عدم الحضور. يمكنك استعادة مركزك من التطبيق.`,
    fr: (v) => `⚠️ BLASTI: ${v.customerName}, votre billet ${v.ticketNumber} a ${v.agencyName} a ete saute (absence). Vous pouvez recuperer votre position.`,
    en: (v) => `⚠️ BLASTI: Dear ${v.customerName}, your ticket ${v.ticketNumber} at ${v.agencyName} was skipped (no-show). You can reclaim your position.`,
  },
};

/**
 * Get SMS template — backed by editable NotificationTemplate rows
 * (Templates tab in the admin providers page). Falls back to the original
 * built-in multilingual strings if the row is missing or disabled.
 */
export async function getSmsTemplate(
  type: LegacyTemplateType,
  lang: string,
  vars: SmsTemplateVars
): Promise<string> {
  try {
    await ensureDefaultTemplates();
    const rendered = await renderTemplate(LEGACY_TYPE_TO_KEY[type], 'SMS', lang, vars as unknown as Record<string, string | number>);
    if (rendered?.text) return rendered.text;
  } catch {
    // Fall through to built-in templates
  }
  const langKey = lang === 'ar' ? 'ar' : lang === 'fr' ? 'fr' : 'en';
  return FALLBACK_TEMPLATES[type][langKey as 'ar' | 'fr' | 'en'](vars);
}

// ─── Credits / limits / logs ────────────────────────────────────────────────

/**
 * Check if a user has SMS credits available
 */
export async function checkUserSmsCredit(userId: string): Promise<{ hasCredit: boolean; freeCount: number; purchasedTotal: number; purchasedUsed: number }> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { freeSmsCount: true },
  });

  if (!user) {
    return { hasCredit: false, freeCount: 0, purchasedTotal: 0, purchasedUsed: 0 };
  }

  // If user has free SMS credits, they're good
  if (user.freeSmsCount > 0) {
    return { hasCredit: true, freeCount: user.freeSmsCount, purchasedTotal: 0, purchasedUsed: 0 };
  }

  // Check purchased SMS packages
  const purchasedTotal = await db.smsPurchase.aggregate({
    where: { userId },
    _sum: { quantity: true },
  });

  const totalPurchased = purchasedTotal._sum.quantity ?? 0;

  // Count used SMS (SENT status logs)
  const usedCount = await db.smsLog.count({
    where: { userId, status: 'SENT' },
  });

  const hasPurchasedCredit = (totalPurchased - usedCount) > 0;

  return {
    hasCredit: hasPurchasedCredit,
    freeCount: user.freeSmsCount,
    purchasedTotal: totalPurchased,
    purchasedUsed: usedCount,
  };
}

/**
 * Check daily SMS limit per user
 */
export async function checkDailyLimit(userId: string, maxPerDay: number): Promise<boolean> {
  if (maxPerDay <= 0) return true; // unlimited
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const sentToday = await db.smsLog.count({
    where: {
      userId,
      status: 'SENT',
      createdAt: { gte: todayStart },
    },
  });
  return sentToday < maxPerDay;
}

/**
 * Get SMS usage statistics
 */
export async function getSmsUsageStats(): Promise<SmsUsageStats> {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const weekStart = new Date(todayStart);
  weekStart.setDate(weekStart.getDate() - weekStart.getDay() + (weekStart.getDay() === 0 ? -6 : 1)); // Monday
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  const [sentToday, sentThisWeek, sentThisMonth, totalSent, failedToday] = await Promise.all([
    db.smsLog.count({ where: { status: 'SENT', createdAt: { gte: todayStart } } }),
    db.smsLog.count({ where: { status: 'SENT', createdAt: { gte: weekStart } } }),
    db.smsLog.count({ where: { status: 'SENT', createdAt: { gte: monthStart } } }),
    db.smsLog.count({ where: { status: 'SENT' } }),
    db.smsLog.count({ where: { status: 'FAILED', createdAt: { gte: todayStart } } }),
  ]);

  return { sentToday, sentThisWeek, sentThisMonth, totalSent, failedToday };
}

/**
 * Get recent SMS logs (last N)
 */
export async function getRecentSmsLogs(limit = 10) {
  return db.smsLog.findMany({
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
}

// ─── Main Send Function (eSMS Africa via ProviderConfig) ────────────────────

/**
 * Send SMS through the admin-configured provider. Retains the original
 * credit-deduction/daily-limit/SmsLog semantics — only the transport changed
 * (previously an 8-provider dispatch map, now a single eSMS Africa adapter).
 */
export async function sendSms(phoneNumber: string, message: string, userId?: string): Promise<SendSmsResult> {
  const settings = await getSmsSettings();

  // Atomic optimistic deduction: decrement free credit first (only if > 0),
  // then send, then refund on failure. This prevents race conditions where
  // two concurrent requests both pass the credit check and both deduct.
  let creditDeducted = false;
  if (userId) {
    // 1. Atomically decrement free credits (only if > 0)
    const decrementResult = await db.user.updateMany({
      where: { id: userId, freeSmsCount: { gt: 0 } },
      data: { freeSmsCount: { decrement: 1 } },
    });

    if (decrementResult.count > 0) {
      creditDeducted = true;
    } else {
      // No free credits — check purchased SMS packages
      const purchasedTotal = await db.smsPurchase.aggregate({
        where: { userId },
        _sum: { quantity: true },
      });
      const totalPurchased = purchasedTotal._sum.quantity ?? 0;
      const usedCount = await db.smsLog.count({
        where: { userId, status: 'SENT' },
      });
      const hasPurchasedCredit = (totalPurchased - usedCount) > 0;

      if (!hasPurchasedCredit) {
        return { success: false, error: 'No SMS credits available' };
      }
    }

    // Check daily limit
    const withinLimit = await checkDailyLimit(userId, settings.maxSmsPerDay);
    if (!withinLimit) {
      // Refund the deducted free credit since we won't send
      if (creditDeducted) {
        await db.user.update({
          where: { id: userId },
          data: { freeSmsCount: { increment: 1 } },
        });
      }
      const log = await db.smsLog.create({
        data: {
          userId,
          phoneNumber,
          message,
          status: 'FAILED',
          provider: 'esmsafrica',
          errorMessage: `Daily SMS limit reached (${settings.maxSmsPerDay}/day)`,
          smsSettingsId: settings.id,
        },
      });
      return { success: false, error: 'DAILY_LIMIT_REACHED', logId: log.id };
    }
  }

  // Normalize phone number (eSMS Africa routes African networks directly)
  const finalPhone = normalizeDzPhone(phoneNumber) || phoneNumber;

  try {
    const result = await sendSmsViaProvider(finalPhone, message);
    const status = result.success ? 'SENT' : 'FAILED';
    const errorMessage = result.success ? null : `Provider error: ${result.error ?? result.responseRaw?.slice(0, 300) ?? 'Unknown error'}`;

    const log = await db.smsLog.create({
      data: {
        userId,
        phoneNumber: finalPhone,
        message,
        status,
        provider: 'esmsafrica',
        errorMessage,
        smsSettingsId: settings.id,
      },
    });

    // Credit was already atomically deducted before sending.
    // If the send failed, refund the deducted free credit.
    if (!result.success && userId && creditDeducted) {
      await db.user.update({
        where: { id: userId },
        data: { freeSmsCount: { increment: 1 } },
      });
    }

    return {
      success: result.success,
      error: result.success ? undefined : 'SEND_FAILED',
      logId: log.id,
      responseRaw: result.responseRaw?.slice(0, 200) ?? result.error,
    };
  } catch (err) {
    // Refund the credit if SMS threw an exception
    if (userId && creditDeducted) {
      try {
        await db.user.update({
          where: { id: userId },
          data: { freeSmsCount: { increment: 1 } },
        });
      } catch {
        // Best-effort refund — don't mask the original error
      }
    }

    const errorMessage = err instanceof Error ? err.message : 'Unknown error';

    const log = await db.smsLog.create({
      data: {
        userId,
        phoneNumber: finalPhone,
        message,
        status: 'FAILED',
        provider: 'esmsafrica',
        errorMessage,
        smsSettingsId: settings.id,
      },
    });

    return { success: false, error: 'SEND_FAILED', logId: log.id };
  }
}

/**
 * Send a test SMS
 */
export async function testSms(phoneNumber: string): Promise<SendSmsResult> {
  const now = new Date().toLocaleString('ar-DZ', { timeZone: 'Africa/Algiers' });
  const testMessage = `[BLASTI] ${now} - رسالة اختبار. Test SMS. If you receive this, your SMS gateway is working correctly.`;
  return sendSms(phoneNumber, testMessage);
}

/**
 * Validate SMS provider configuration (Task 22: config check — the old
 * HEAD-request reachability probe against 8 hardcoded endpoints is gone).
 */
export async function validateGatewayConnection(): Promise<{ valid: boolean; error?: string; provider: string }> {
  const { getResolvedConfig } = await import('./messaging/provider-config');
  const config = await getResolvedConfig('SMS');
  if (!config.apiKey) {
    return { valid: false, error: 'API Key is required (set it in Admin → Notifications & Providers)', provider: 'esmsafrica' };
  }
  if (!config.enabled) {
    return { valid: false, error: 'SMS provider is disabled — enable it in Admin → Notifications & Providers', provider: 'esmsafrica' };
  }
  return { valid: true, provider: 'esmsafrica' };
}
