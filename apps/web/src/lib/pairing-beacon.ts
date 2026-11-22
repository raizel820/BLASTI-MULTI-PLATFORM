/**
 * pairing-beacon — the phone ANNOUNCES itself over the LAN (0.6.92).
 *
 * USER REQUEST (0.6.91 report): the desktop Device Manager scan must see the
 * active BLASTI app on phones linked to the same network — "تحقق من أن تطبيق
 * بلاستي في الوضع الجاهز في انتظار الاقتران يرسل إشارة لإعلان وجوده" (make
 * sure the BLASTI app in ready mode, waiting for pairing, sends a signal
 * announcing its presence).
 *
 * ROOT CAUSE: through 0.6.91 the phone announced NOTHING at the LAN layer —
 * no HTTP server, no UDP beacon, no mDNS. The desktop scan listened on UDP
 * :3081 for BLASTI beacons (the desktop shell announces itself there), but
 * the phone-side counterpart announcer did not exist, so a phone sitting in
 * the pairing-ready state was invisible to the scan.
 *
 * THE FIX, two halves:
 *   - NATIVE (apps/mobile BlastiNativeStatus.startPairingBeacon): a UDP
 *     broadcast loop on port 3081 — the WebView cannot send UDP, so the
 *     announcer lives in the Android plugin.
 *   - HERE (web layer): the thin bridge the pairing-ready screens call.
 *
 * The beacon payload carries NO secrets: a display name, a short fingerprint
 * and the app version — never the deviceToken. The desktop scanner accepts
 * `service:'blasti-phone'` since 0.6.92 and surfaces the phone as a BLASTI
 * APP card (type PHONE) with the announcing device's IP.
 *
 * Every call is a no-op outside the native shell (plain browser/desktop):
 * the desktop already announces itself via main.js startLanBeacon, and a
 * browser tab has no business broadcasting.
 */

import { getNativePlugin } from './native-plugin';
import { APP_VERSION } from './version';

/** Identity fields broadcast with the beacon (all optional, all public). */
export interface PairingBeaconIdentity {
  /** Display name shown on the manager's scan card. */
  name?: string;
  /** Short device fingerprint (NOT the deviceToken) for dedupe/pairing UX. */
  uid?: string;
  /** Why the phone is announcing — e.g. 'ready-for-pairing'. */
  status?: string;
  /**
   * 0.6.102 — WHICH BLASTI surface is announcing. The manager's result
   * filters are strict (audit requirement): 'phone' → PHONE WITH BLASTI APP,
   * 'kiosk' → PHONE/TABLET WITH BLASTI APP IN KIOSK MODE. Without this field
   * the scanner classified every phone beacon as a generic PHONE card, so a
   * kiosk-mode tablet was indistinguishable from a staff phone.
   */
  mode?: 'kiosk' | 'phone' | 'desktop';
}

function beaconPlugin():
  | { startPairingBeacon?: (opts: Record<string, unknown>) => Promise<unknown> |
      unknown; stopPairingBeacon?: () => Promise<unknown> | unknown }
  | null {
  const p = getNativePlugin('BlastiNativeStatus');
  if (!p) return null;
  return p as unknown as {
    startPairingBeacon?: (opts: Record<string, unknown>) => Promise<unknown> | unknown;
    stopPairingBeacon?: () => Promise<unknown> | unknown;
  };
}

/** True only inside a native shell with the beacon plugin method present. */
export function isPairingBeaconSupported(): boolean {
  const p = beaconPlugin();
  return !!(p && typeof p.startPairingBeacon === 'function');
}

/**
 * Start (or restart) the native UDP pairing beacon. Safe to call repeatedly:
 * the native side runs exactly one beacon loop. Resolves false when the
 * platform cannot broadcast (browser, plugin missing) — callers ignore it.
 */
export async function startPairingBeacon(identity: PairingBeaconIdentity = {}): Promise<boolean> {
  const p = beaconPlugin();
  if (!p || typeof p.startPairingBeacon !== 'function') return false;
  try {
    await p.startPairingBeacon({
      name: identity.name || 'BLASTI App',
      uid: identity.uid || '',
      status: identity.status || 'ready-for-pairing',
      // 0.6.102 — the announcing surface travels with the signal so the
      // manager renders the STRICT result-filter category.
      mode: identity.mode || 'phone',
      appVersion: APP_VERSION || '',
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Stop the beacon. Fire-and-forget safe: no-op outside the native shell.
 */
export async function stopPairingBeacon(): Promise<void> {
  const p = beaconPlugin();
  if (!p || typeof p.stopPairingBeacon !== 'function') return;
  try {
    await p.stopPairingBeacon();
  } catch {
    /* the loop dies with the app process anyway */
  }
}
