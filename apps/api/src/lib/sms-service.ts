import { db } from '@blasti/db';

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

// ─── Algerian SMS Provider Configurations ────────────────────────────────────

export const ALGERIAN_PROVIDERS = {
  winsms: {
    id: 'winsms',
    name: 'WinSMS (www.winsms.dz)',
    description: 'Popular Algerian SMS gateway',
    defaultApiUrl: 'https://www.winsms.dz/api/send',
    authMethod: 'bearer' as const,
    senderIdSupport: true,
    maxMessageLength: 160,
    encoding: 'GSM',
    docsUrl: 'https://www.winsms.dz/documentation',
  },
  notifsend: {
    id: 'notifsend',
    name: 'NotifSend (notifsend.com)',
    description: 'Algerian notification service',
    defaultApiUrl: 'https://notifsend.com/api/sms/send',
    authMethod: 'bearer' as const,
    senderIdSupport: true,
    maxMessageLength: 160,
    encoding: 'GSM',
    docsUrl: 'https://notifsend.com/docs',
  },
  algeria_sms: {
    id: 'algeria_sms',
    name: 'Algeria SMS (algeria-sms.com)',
    description: 'Algeria SMS platform',
    defaultApiUrl: 'https://api.algeria-sms.com/v1/sms/send',
    authMethod: 'api_key' as const,
    senderIdSupport: true,
    maxMessageLength: 160,
    encoding: 'GSM',
    docsUrl: 'https://algeria-sms.com/api-docs',
  },
  green_send: {
    id: 'green_send',
    name: 'GreenSMS (greensms.ma)',
    description: 'Maghreb SMS provider (works in DZ)',
    defaultApiUrl: 'https://api.greensms.ma/v1/sms/send',
    authMethod: 'bearer' as const,
    senderIdSupport: true,
    maxMessageLength: 160,
    encoding: 'GSM',
    docsUrl: 'https://greensms.ma/api',
  },
  mtarget: {
    id: 'mtarget',
    name: 'M-Target (mtarget.dz)',
    description: 'Algerian marketing & notification SMS',
    defaultApiUrl: 'https://mtarget.dz/api/sms',
    authMethod: 'api_key' as const,
    senderIdSupport: true,
    maxMessageLength: 160,
    encoding: 'GSM',
    docsUrl: 'https://mtarget.dz/documentation',
  },
  twilio: {
    id: 'twilio',
    name: 'Twilio (twilio.com)',
    description: 'International provider — supports DZ numbers',
    defaultApiUrl: 'https://api.twilio.com/2010-04-01/Accounts',
    authMethod: 'basic' as const,
    senderIdSupport: false, // Twilio uses FROM number, not alphanumeric
    maxMessageLength: 160,
    encoding: 'UTF-8',
    docsUrl: 'https://www.twilio.com/docs/sms/api',
  },
  vonage: {
    id: 'vonage',
    name: 'Vonage / Nexmo (vonage.com)',
    description: 'International provider — supports DZ numbers',
    defaultApiUrl: 'https://rest.nexmo.com/sms/json',
    authMethod: 'basic' as const,
    senderIdSupport: true,
    maxMessageLength: 160,
    encoding: 'UTF-8',
    docsUrl: 'https://developer.vonage.com/api/sms',
  },
  generic: {
    id: 'generic',
    name: 'Generic HTTP API',
    description: 'Custom provider with configurable endpoint',
    defaultApiUrl: '',
    authMethod: 'bearer' as const,
    senderIdSupport: true,
    maxMessageLength: 160,
    encoding: 'UTF-8',
    docsUrl: '',
  },
} as const;

export type AlgerianProviderId = keyof typeof ALGERIAN_PROVIDERS;

// ─── SMS Message Templates (multilingual) ────────────────────────────────────

interface SmsTemplateVars {
  customerName: string;
  ticketNumber: string;
  agencyName: string;
  position: number;
  estimatedMinutes: number;
}

const SMS_TEMPLATES = {
  turnApproaching: {
    ar: (v: SmsTemplateVars) =>
      `🔄 BLASTI: ${v.customerName}، اقترب دورك! تذكرتك ${v.ticketNumber} في ${v.agencyName}. المركز: ${v.position}. الانتظار المتوقع: ${v.estimatedMinutes} دقيقة.`,
    fr: (v: SmsTemplateVars) =>
      `🔄 BLASTI: ${v.customerName}, votre tour approche! Billet ${v.ticketNumber} a ${v.agencyName}. Position: ${v.position}. Attente estimee: ${v.estimatedMinutes} min.`,
    en: (v: SmsTemplateVars) =>
      `🔄 BLASTI: Dear ${v.customerName}, your turn is approaching! Ticket ${v.ticketNumber} at ${v.agencyName}. Position: ${v.position}. Est. wait: ${v.estimatedMinutes} min.`,
  },
  yourTurn: {
    ar: (v: SmsTemplateVars) =>
      `🎫 BLASTI: ${v.customerName}، دورك الآن! تذكرتك ${v.ticketNumber} في ${v.agencyName}. يرجى التوجه فوراً.`,
    fr: (v: SmsTemplateVars) =>
      `🎫 BLASTI: ${v.customerName}, c'est votre tour! Billet ${v.ticketNumber} a ${v.agencyName}. Veuillez vous presenter.`,
    en: (v: SmsTemplateVars) =>
      `🎫 BLASTI: Dear ${v.customerName}, it's your turn! Ticket ${v.ticketNumber} at ${v.agencyName}. Please proceed now.`,
  },
  noShowWarning: {
    ar: (v: SmsTemplateVars) =>
      `⚠️ BLASTI: ${v.customerName}، تم تخطي تذكرتك ${v.ticketNumber} في ${v.agencyName} بسبب عدم الحضور. يمكنك استعادة مركزك من التطبيق.`,
    fr: (v: SmsTemplateVars) =>
      `⚠️ BLASTI: ${v.customerName}, votre billet ${v.ticketNumber} a ${v.agencyName} a ete saute (absence). Vous pouvez recuperer votre position.`,
    en: (v: SmsTemplateVars) =>
      `⚠️ BLASTI: Dear ${v.customerName}, your ticket ${v.ticketNumber} at ${v.agencyName} was skipped (no-show). You can reclaim your position.`,
  },
};

/**
 * Apply template variable substitution
 * Replaces {varName} placeholders with actual values
 */
function applyTemplateVars(template: string, vars: Record<string, string | number>): string {
  let result = template;
  Object.entries(vars).forEach(([key, value]) => {
    result = result.replace(new RegExp(`\\{${key}\\}`, 'g'), String(value));
  });
  return result;
}

/**
 * Get SMS template - uses custom template from DB settings if available,
 * otherwise falls back to built-in multilingual templates
 */
export async function getSmsTemplate(
  type: 'turnApproaching' | 'yourTurn' | 'noShowWarning',
  lang: string,
  vars: SmsTemplateVars
): Promise<string> {
  // Try to get custom template from settings
  try {
    const settings = await getSmsSettings();
    const customTemplateField = type === 'turnApproaching'
      ? settings.templateTurnApproaching
      : type === 'yourTurn'
      ? settings.templateYourTurn
      : settings.templateNoShow;

    // If custom template is set, use it with variable substitution
    if (customTemplateField && customTemplateField.trim()) {
      return applyTemplateVars(customTemplateField, vars as unknown as Record<string, string | number>);
    }
  } catch {
    // Fall through to default templates
  }

  // Fallback to built-in multilingual templates
  const template = SMS_TEMPLATES[type];
  const langKey = lang === 'ar' ? 'ar' : lang === 'fr' ? 'fr' : 'en';
  return template[langKey as 'ar' | 'fr' | 'en'](vars);
}

// ─── Core SMS Service Functions ──────────────────────────────────────────────

/**
 * Get current SMS settings (creates default if none exists)
 */
export async function getSmsSettings() {
  let settings = await db.smsSettings.findFirst();
  if (!settings) {
    settings = await db.smsSettings.create({
      data: {
        provider: 'winsms',
        apiUrl: ALGERIAN_PROVIDERS.winsms.defaultApiUrl,
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
 * Deduct SMS credit from user after successful send
 * Uses atomic updateMany with gte guard to prevent race conditions
 * that could drive freeSmsCount below zero under concurrent requests.
 */
async function deductSmsCredit(userId: string, count = 1): Promise<void> {
  const result = await db.user.updateMany({
    where: { id: userId, freeSmsCount: { gte: count } },
    data: { freeSmsCount: { decrement: count } },
  });

  if (result.count === 0) {
    throw new Error('Insufficient SMS credits');
  }
  // Otherwise, credit is tracked via SmsLog count
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
    include: {
      smsSettings: { select: { id: true, provider: true } },
    },
  });
}

// ─── Provider-Specific Send Functions ────────────────────────────────────────

/**
 * Send via WinSMS (winsms.dz)
 * API: POST with Bearer token, JSON body { recipient, sender_id, message }
 */
async function sendViaWinSMS(apiUrl: string, apiKey: string, senderName: string, phone: string, message: string): Promise<{ ok: boolean; raw: string }> {
  const res = await fetch(apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      recipient: phone,
      sender_id: senderName,
      message,
      type: 'standard', // standard, unicode
    }),
  });
  const raw = await res.text();
  return { ok: res.ok, raw };
}

/**
 * Send via NotifSend (notifsend.com)
 * API: POST with Bearer token, JSON body { to, from, message }
 */
async function sendViaNotifSend(apiUrl: string, apiKey: string, senderName: string, phone: string, message: string): Promise<{ ok: boolean; raw: string }> {
  const res = await fetch(apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      to: phone,
      from: senderName,
      message,
    }),
  });
  const raw = await res.text();
  return { ok: res.ok, raw };
}

/**
 * Send via Algeria SMS (algeria-sms.com)
 * API: POST with api_key in body, JSON body { api_key, sender, recipient, message }
 */
async function sendViaAlgeriaSms(apiUrl: string, apiKey: string, senderName: string, phone: string, message: string): Promise<{ ok: boolean; raw: string }> {
  const res = await fetch(apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: apiKey,
      sender: senderName,
      recipient: phone,
      message,
    }),
  });
  const raw = await res.text();
  return { ok: res.ok, raw };
}

/**
 * Send via GreenSMS (greensms.ma)
 * API: POST with Bearer token, JSON body { to, from, text }
 */
async function sendViaGreenSMS(apiUrl: string, apiKey: string, senderName: string, phone: string, message: string): Promise<{ ok: boolean; raw: string }> {
  const res = await fetch(apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      to: phone,
      from: senderName,
      text: message,
    }),
  });
  const raw = await res.text();
  return { ok: res.ok, raw };
}

/**
 * Send via M-Target (mtarget.dz)
 * API: POST with api_key, JSON body { api_key, sender, phone, message }
 */
async function sendViaMTarget(apiUrl: string, apiKey: string, senderName: string, phone: string, message: string): Promise<{ ok: boolean; raw: string }> {
  const res = await fetch(apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: apiKey,
      sender: senderName,
      phone,
      message,
    }),
  });
  const raw = await res.text();
  return { ok: res.ok, raw };
}

/**
 * Send via Twilio (twilio.com)
 * API format: POST https://api.twilio.com/2010-04-01/Accounts/{ACCOUNT_SID}/Messages.json
 * Auth: Basic (ACCOUNT_SID:AUTH_TOKEN)
 * Body: x-www-form-urlencoded { To, From, Body }
 * Note: apiUrl should be the base URL (https://api.twilio.com/2010-04-01/Accounts)
 * apiKey should be ACCOUNT_SID:AUTH_TOKEN format
 */
async function sendViaTwilio(apiUrl: string, apiKey: string, senderName: string, phone: string, message: string): Promise<{ ok: boolean; raw: string }> {
  const [accountSid, authToken] = apiKey.split(':');
  if (!accountSid || !authToken) {
    return { ok: false, raw: 'Twilio API key must be in format ACCOUNT_SID:AUTH_TOKEN' };
  }
  const encoded = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
  const res = await fetch(`${apiUrl}/${accountSid}/Messages.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${encoded}`,
    },
    body: new URLSearchParams({
      To: phone,
      From: senderName, // Must be a Twilio verified number (not alphanumeric for DZ)
      Body: message,
    }),
  });
  const raw = await res.text();
  return { ok: res.ok, raw };
}

/**
 * Send via Vonage / Nexmo (vonage.com)
 * API: POST https://rest.nexmo.com/sms/json
 * Auth: Basic (API_KEY:API_SECRET)
 * Body: JSON { from, to, text }
 */
async function sendViaVonage(apiUrl: string, apiKey: string, senderName: string, phone: string, message: string): Promise<{ ok: boolean; raw: string }> {
  const [apiSecret] = [apiKey]; // apiKey format: API_KEY:API_SECRET
  const [key, secret] = apiKey.split(':');
  if (!key || !secret) {
    return { ok: false, raw: 'Vonage API key must be in format API_KEY:API_SECRET' };
  }
  const encoded = Buffer.from(`${key}:${secret}`).toString('base64');
  const res = await fetch(apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Basic ${encoded}`,
    },
    body: JSON.stringify({
      from: senderName,
      to: phone,
      text: message,
    }),
  });
  const raw = await res.text();
  return { ok: res.ok, raw };
}

/**
 * Send via Generic HTTP API
 * Configurable POST with Bearer token
 */
async function sendViaGeneric(apiUrl: string, apiKey: string, senderName: string, phone: string, message: string): Promise<{ ok: boolean; raw: string }> {
  const res = await fetch(apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      to: phone,
      from: senderName,
      message,
    }),
  });
  const raw = await res.text();
  return { ok: res.ok, raw };
}

// ─── Main Send Function ─────────────────────────────────────────────────────

/**
 * Dispatch SMS to the correct provider
 */
const PROVIDER_DISPATCH: Record<string, typeof sendViaGeneric> = {
  winsms: sendViaWinSMS,
  notifsend: sendViaNotifSend,
  algeria_sms: sendViaAlgeriaSms,
  green_send: sendViaGreenSMS,
  mtarget: sendViaMTarget,
  twilio: sendViaTwilio,
  vonage: sendViaVonage,
  generic: sendViaGeneric,
};

/**
 * Send SMS via configured provider
 */
export async function sendSms(phoneNumber: string, message: string, userId?: string): Promise<SendSmsResult> {
  const settings = await getSmsSettings();

  // Check if SMS is enabled
  if (!settings.enabled) {
    return { success: false, error: 'SMS_DISABLED' };
  }

  // Atomic optimistic deduction: decrement free credit first (only if > 0),
  // then send, then refund on failure. This prevents race conditions where
  // two concurrent requests both pass the credit check and both deduct.
  let creditDeducted = false;
  let hasPurchasedCredit = false;
  if (userId) {
    // 1. Atomically decrement free credits (only if > 0)
    const decrementResult = await db.user.updateMany({
      where: { id: userId, freeSmsCount: { gt: 0 } },
      data: { freeSmsCount: { decrement: 1 } },
    });

    if (decrementResult.count > 0) {
      // Free credit was successfully deducted
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
      hasPurchasedCredit = (totalPurchased - usedCount) > 0;

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
          provider: settings.provider,
          errorMessage: `Daily SMS limit reached (${settings.maxSmsPerDay}/day)`,
          smsSettingsId: settings.id,
        },
      });
      return { success: false, error: 'DAILY_LIMIT_REACHED', logId: log.id };
    }
  }

  // Normalize phone number for Algerian providers
  const normalizedPhone = normalizeDzPhone(phoneNumber);
  if (!normalizedPhone) {
    // If not a valid DZ number, try the raw number (for international providers like Twilio)
    if (settings.provider !== 'twilio' && settings.provider !== 'vonage') {
      const log = await db.smsLog.create({
        data: {
          userId,
          phoneNumber,
          message,
          status: 'FAILED',
          provider: settings.provider,
          errorMessage: `Invalid Algerian phone number: ${phoneNumber}. Expected format: +213XXXXXXXXX or 0XXXXXXXXX`,
          smsSettingsId: settings.id,
        },
      });
      return { success: false, error: 'INVALID_PHONE', logId: log.id };
    }
  }

  const finalPhone = normalizedPhone || phoneNumber;

  // Validate API configuration
  const apiUrl = settings.apiUrl || process.env.SMS_API_URL;
  const apiKey = settings.apiKey || process.env.SMS_API_KEY;
  const senderName = settings.senderName || 'BLASTI';

  if (!apiUrl || !apiKey) {
    const log = await db.smsLog.create({
      data: {
        userId,
        phoneNumber: finalPhone,
        message,
        status: 'FAILED',
        provider: settings.provider,
        errorMessage: 'SMS not configured: API URL and API Key are required',
        smsSettingsId: settings.id,
      },
    });
    return { success: false, error: 'NOT_CONFIGURED', logId: log.id };
  }

  // Get provider info for validation
  const providerInfo = ALGERIAN_PROVIDERS[settings.provider as AlgerianProviderId];
  const senderNotSupported = providerInfo && !providerInfo.senderIdSupport && senderName && !senderName.match(/^\+?\d{10,15}$/);

  if (senderNotSupported) {
    const log = await db.smsLog.create({
      data: {
        userId,
        phoneNumber: finalPhone,
        message,
        status: 'FAILED',
        provider: settings.provider,
        errorMessage: `${providerInfo.name} does not support alphanumeric sender IDs. Please use a valid phone number as the sender.`,
        smsSettingsId: settings.id,
      },
    });
    return { success: false, error: 'INVALID_SENDER', logId: log.id };
  }

  try {
    const dispatchFn = PROVIDER_DISPATCH[settings.provider] || sendViaGeneric;
    const result = await dispatchFn(apiUrl, apiKey, senderName, finalPhone, message);

    const status = result.ok ? 'SENT' : 'FAILED';
    const errorMessage = result.ok ? null : `Provider error: ${result.raw?.slice(0, 300) ?? 'Unknown error'}`;

    const log = await db.smsLog.create({
      data: {
        userId,
        phoneNumber: finalPhone,
        message,
        status,
        provider: settings.provider,
        errorMessage,
        smsSettingsId: settings.id,
      },
    });

    // Credit was already atomically deducted before sending.
    // If the send failed (non-ok result), refund the deducted free credit.
    if (!result.ok && userId && creditDeducted) {
      await db.user.update({
        where: { id: userId },
        data: { freeSmsCount: { increment: 1 } },
      });
    }

    return {
      success: result.ok,
      error: result.ok ? undefined : 'SEND_FAILED',
      logId: log.id,
      responseRaw: result.raw?.slice(0, 200),
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
        provider: settings.provider,
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
 * Validate SMS gateway connectivity (lightweight check)
 */
export async function validateGatewayConnection(): Promise<{ valid: boolean; error?: string; provider: string }> {
  const settings = await getSmsSettings();
  const apiUrl = settings.apiUrl;
  const apiKey = settings.apiKey;

  if (!apiUrl || !apiKey) {
    return { valid: false, error: 'API URL and API Key are required', provider: settings.provider };
  }

  try {
    // Try a lightweight request — just check if the endpoint is reachable
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const providerInfo = ALGERIAN_PROVIDERS[settings.provider as AlgerianProviderId];

    if (settings.provider === 'twilio') {
      // Twilio uses a different URL structure
      const [accountSid] = apiKey.split(':');
      const res = await fetch(`${apiUrl}/${accountSid}?PageSize=1`, {
        signal: controller.signal,
        headers: { 'Authorization': `Basic ${Buffer.from(apiKey).toString('base64')}` },
      });
      clearTimeout(timeout);
      if (res.ok || res.status === 200) {
        return { valid: true, provider: settings.provider };
      }
      return { valid: false, error: `HTTP ${res.status}: ${await res.text().catch(() => 'No response')}`, provider: settings.provider };
    }

    // For other providers, just check if the URL is reachable with a HEAD request
    const res = await fetch(apiUrl, {
      method: 'HEAD',
      signal: controller.signal,
      headers: apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {},
    }).catch(() => null);
    clearTimeout(timeout);

    if (res !== null) {
      return { valid: true, provider: settings.provider };
    }
    return { valid: false, error: 'Could not reach gateway endpoint', provider: settings.provider };
  } catch (err) {
    return {
      valid: false,
      error: err instanceof Error ? err.message : 'Connection failed',
      provider: settings.provider,
    };
  }
}
