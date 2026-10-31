/**
 * Chargily checkout client helpers — shared by every payment surface
 * (subscriptions, SMS packs, hardware/device orders).
 *
 * Flow (all platforms: web browser, Capacitor mobile, Electron desktop):
 *   1. startChargilyCheckout() → POST /api/payment/create-checkout
 *   2. the pending checkout is persisted in localStorage so the
 *      payment-result view can pick it up when the customer returns
 *      (same tab, another tab, or after re-focusing the app shell)
 *   3. the customer is sent to the hosted Chargily page (EDAHABIA / CIB)
 *   4. on return, /#/payment/result polls GET /api/payment/checkout/:id —
 *      the API settles the payment even without a webhook (poll fallback),
 *      so the ONLY setup needed from the super admin is entering the keys.
 */

import { apiFetch } from '@/lib/api-fetch';
import { getCloudApiBaseUrl } from '@/lib/api-client';

export const PENDING_CHECKOUT_KEY = 'blasti-pending-checkout';

/** Custom-scheme deep link the Capacitor Android shell registers (see
 *  AndroidManifest.xml BROWSABLE intent-filter + payment-deep-link.ts) AND
 *  the Electron desktop shell registers via app.setAsDefaultProtocolClient
 *  (main.js) — the same `blasti://payment/result` target for both apps. */
const MOBILE_DEEP_LINK = 'blasti://payment/result';

export interface PendingCheckout {
  checkoutId: string;
  /** 'subscription' | 'sms' | 'hardware' */
  type: string;
  amount: number;
  createdAt: number;
  /** Where to send the user when they leave the result page. */
  returnView?: string;
}

export interface CreateCheckoutResponse {
  checkoutUrl: string;
  checkoutId: string;
  amount: number;
  currency: string;
  type: string;
  transactionId?: string;
  smsPurchaseId?: string;
  orderId?: string;
  quantity?: number;
  hardwareOrderIds?: string[];
}

// ─── localStorage persistence ───────────────────────────────────────────────

export function setPendingCheckout(p: PendingCheckout): void {
  try {
    localStorage.setItem(PENDING_CHECKOUT_KEY, JSON.stringify(p));
  } catch {
    /* private mode — payment-result falls back to GET /api/payment/pending */
  }
}

export function getPendingCheckout(): PendingCheckout | null {
  try {
    const raw = localStorage.getItem(PENDING_CHECKOUT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PendingCheckout;
    // Ignore stale entries older than 24h.
    if (!parsed?.checkoutId || Date.now() - (parsed.createdAt || 0) > 24 * 60 * 60 * 1000) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function clearPendingCheckout(): void {
  try {
    localStorage.removeItem(PENDING_CHECKOUT_KEY);
  } catch {
    /* ignore */
  }
}

// ─── Checkout creation + redirect ───────────────────────────────────────────

/**
 * Device-local / non-routable hosts can NEVER be public redirect targets —
 * the hosted Chargily page lives on the gateway's servers, so redirecting it
 * to `localhost` / a LAN IP / the device's WebView origin lands the payer on
 * a dead "site can't be reached" page (the exact "redirect back to the app
 * is broken" report). Used to reject such origins when resolving the
 * success/failure return URL.
 */
function isNonPublicHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return (
    h === 'localhost' || h.endsWith('.localhost') ||
    h === '127.0.0.1' || h === '0.0.0.0' || h === '[::1]' || h === '::1' ||
    h.startsWith('10.') || h.startsWith('192.168.') || h.startsWith('169.254.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
    h.endsWith('.local')
  );
}

/** True inside the Capacitor native shell (Android/iOS WebView). */
function isCapacitorShell(): boolean {
  try {
    const cap = (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
    return !!(cap?.isNativePlatform?.());
  } catch {
    return false;
  }
}

/**
 * True inside the Electron desktop shell. The desktop registers the
 * `blasti://` protocol handler (main.js setAsDefaultProtocolClient) and
 * forwards deep links to the SPA through preload's onDeepLink — so, exactly
 * like the phone, a payment started in the desktop app can bounce the
 * payer's browser straight back into the desktop app.
 */
function isElectronShell(): boolean {
  try {
    return typeof window !== 'undefined' && !!(window as unknown as { electronAPI?: unknown }).electronAPI;
  } catch {
    return false;
  }
}

/**
 * Resolve the return hints sent with create-checkout:
 *   - `returnUrl` — the PUBLIC web origin the hosted gateway should send the
 *     payer back to. On a regular browser this is simply the SPA origin.
 *     Inside a native shell (Capacitor WebView = `https://localhost`,
 *     Electron loading the bundled SPA = `http://127.0.0.1:3080`) the page
 *     origin is device-local, so the CLOUD origin this shell already talks
 *     to (the same domain serves the SPA) is used instead.
 *   - `deepLink` — Capacitor AND Electron: the `blasti://payment/result`
 *     scheme both apps register. The API appends it (encoded) to the success
 *     and failure URLs; when the payer's browser lands on the result page it
 *     immediately bounces back into the app that started the payment
 *     (payment-deep-link.ts routes it on the phone; the desktop routes the
 *     same URL through its deep-link IPC). Regular-browser callers just
 *     render the result page where they are.
 *
 * An explicit returnUrl from the caller always wins (payload spread below).
 */
function computeReturnHints(): { returnUrl?: string; deepLink?: string } {
  if (typeof window === 'undefined') return {};

  let returnUrl: string | undefined;
  const origin = window.location.origin;
  if (/^https?:\/\//i.test(origin)) {
    try {
      const u = new URL(origin);
      if (!isNonPublicHost(u.hostname)) returnUrl = u.origin;
    } catch { /* ignore */ }
  }

  if (!returnUrl) {
    // Device-local page origin — fall back to the cloud origin the shell
    // resolves for API traffic (locked baked URL on release mobile builds,
    // BLASTI_CLOUD_URL on desktop).
    const cloud = getCloudApiBaseUrl();
    if (cloud && /^https?:\/\//i.test(cloud)) {
      try {
        const u = new URL(cloud);
        if (!isNonPublicHost(u.hostname)) returnUrl = u.origin;
      } catch { /* ignore */ }
    }
  }

  // R-36 fix — "the Chargily redirect goes to the webapp only": the deep-link
  // bounce used to be Capacitor-only, so desktop payments never returned the
  // user to the desktop app. Both native shells handle blasti:// — issue the
  // bounce for each; plain browsers still get none (no handler registered).
  const deepLink = (isCapacitorShell() || isElectronShell()) && returnUrl ? MOBILE_DEEP_LINK : undefined;
  return { returnUrl, deepLink };
}

/**
 * Create a Chargily checkout and send the customer to the hosted payment
 * page. Throws with a human-readable message on failure.
 *
 * @param payload - The POST /api/payment/create-checkout body
 *   (type + paymentMethod + per-type fields; see the API route).
 * @param opts.returnView - Optional view name to return to afterwards.
 */
export async function startChargilyCheckout(
  payload: Record<string, unknown>,
  opts?: { returnView?: string },
): Promise<CreateCheckoutResponse> {
  // Return-target hints — computed here (NOT by the callers) so every
  // payment surface gets the fix; explicit payload fields still win.
  const hints = computeReturnHints();
  const res = await apiFetch('/api/payment/create-checkout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...hints, ...payload }),
  });

  const body = await res.json().catch(() => ({}));
  // apiFetch routes through apiClient, whose parseResponse UNWRAPS the
  // {success, data} envelope — so `body` is either the inner data object
  // (has checkoutUrl) or the full envelope. Accept both shapes.
  const checkout = (
    body && typeof body === 'object' && 'checkoutUrl' in body
      ? body
      : (body as { data?: CreateCheckoutResponse })?.data
  ) as CreateCheckoutResponse | undefined;

  if (!res.ok || !checkout?.checkoutUrl) {
    const errBody = body as { error?: string; details?: string };
    const base = errBody?.error || 'Failed to create the payment session';
    // Surface the gateway's raw answer (details) so the REAL rejection
    // reason is visible in the toast, not just the generic headline.
    const details = errBody?.details ? ` — ${errBody.details.slice(0, 240)}` : '';
    throw new Error(`${base}${details}`);
  }

  // Persist BEFORE navigating away — the result page depends on it.
  setPendingCheckout({
    checkoutId: checkout.checkoutId,
    type: checkout.type,
    amount: checkout.amount,
    createdAt: Date.now(),
    returnView: opts?.returnView,
  });

  openCheckoutUrl(checkout.checkoutUrl);
  return checkout;
}

/**
 * Open the hosted Chargily checkout page.
 *
 * Regular web: a new tab (keeps the SPA alive so returning is instant).
 * Popup-blocked / embedded shells: full navigation fallback.
 */
export function openCheckoutUrl(url: string): void {
  if (!url || !/^https?:\/\//i.test(url)) return;
  const win = window.open(url, '_blank', 'noopener,noreferrer');
  if (!win) {
    // Popup blocked — navigate this tab instead (the SPA reloads on return).
    window.location.href = url;
  }
}

// ─── Public payment settings ( Chargily availability ) ────────────────────

export interface PublicPaymentSettings {
  ccpEnabled: boolean;
  bankEnabled: boolean;
  electronicEnabled: boolean;
  ccpAccount?: string;
  ccpKey?: string;
  bankAccount?: string;
  bankRib?: string;
  bankName?: string;
  ewalletNumber?: string;
  // r21-6 — display-safe transfer details (null until the super admin fills
  // them in; callers fall back to the i18n placeholder instructions).
  ccpHolderName?: string | null;
  ccpAddress?: string | null;
  bankHolderName?: string | null;
  bankAddress?: string | null;
  baridiMobEnabled?: boolean;
  baridiMobNumber?: string | null;
  /** true when the gateway is enabled AND a usable SECRET key is stored */
  chargilyEnabled?: boolean;
  chargilyMode?: 'sandbox' | 'live';
  chargilyMethods?: string[];
}

/** Fetch the public payment settings (manual accounts + Chargily availability). */
export async function fetchPaymentSettings(): Promise<PublicPaymentSettings | null> {
  try {
    const res = await apiFetch('/api/payment-settings');
    if (!res.ok) return null;
    return (await res.json()) as PublicPaymentSettings;
  } catch {
    return null;
  }
}
