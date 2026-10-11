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

export const PENDING_CHECKOUT_KEY = 'blasti-pending-checkout';

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
  const res = await apiFetch('/api/payment/create-checkout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
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
  /** true when the super admin has entered both Chargily keys */
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
