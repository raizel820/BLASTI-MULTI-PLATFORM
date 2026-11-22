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

/** 0.6.106 — the plugin listener handle shape Capacitor's addListener returns. */
interface BlastiListenerHandle {
  remove?: (...args: unknown[]) => unknown;
}

function beaconPlugin():
  | {
      startPairingBeacon?: (opts: Record<string, unknown>) => Promise<unknown> |
          unknown; stopPairingBeacon?: () => Promise<unknown> | unknown;
      /** 0.6.106 — the device-to-device pairing-offer receiver event. */
      addListener?: (evt: string, cb: (...args: unknown[]) => void) =>
          BlastiListenerHandle | ((...args: unknown[]) => void) | unknown;
    }
  | null {
  const p = getNativePlugin('BlastiNativeStatus');
  if (!p) return null;
  return p as unknown as {
    startPairingBeacon?: (opts: Record<string, unknown>) => Promise<unknown> | unknown;
    stopPairingBeacon?: () => Promise<unknown> | unknown;
    addListener?: (evt: string, cb: (...args: unknown[]) => void) =>
        BlastiListenerHandle | ((...args: unknown[]) => void) | unknown;
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

// ─── 0.6.106 — DEVICE-TO-DEVICE PAIRING OFFER RECEIVER (the LAN half) ────────
//
// Through 0.6.105 a phone/tablet kiosk had NO receiver a desktop could push
// a pairing request to (the beacon is send-only UDP), so every request for a
// discovered kiosk rode the CLOUD relay + a 5s /device-status poll — on a
// slow internet link the whole handshake felt "extremely slow" (user report:
// "does pairing go device to device through wifi/lan or cloud api server?").
//
// 0.6.106 — the Android plugin now binds UDP :3082 while the beacon runs and
// notifies 'blastiPairingOffer' here when the desktop unicasts an offer
// directly. This bridge exposes that event to the pairing surfaces
// (device-kiosk, phone-pairing-agent) with a Capacitor-style unsubscribe.
// No-op outside a native shell (the offer card then relies on the cloud
// socket push + poll as before).

export type UnsubscribeFn = () => void;

/** Subset of the desktop's pairing-offer payload the UI acts on. */
export interface LanPairingOffer {
  commandId?: string;
  id?: string;
  fingerprint?: string;
  deviceId?: string;
  deviceToken?: string;
  agencyId?: string;
  agencyName?: string;
  agencyNameAr?: string;
  agencyNameFr?: string;
  customCode?: string;
  sentByName?: string;
  /** The sending desktop's LAN address — the LAN-direct accept target. */
  managerIp?: string;
  managerPort?: number;
  [key: string]: unknown;
}

/** True when this build can receive LAN pairing offers (Android + new plugin). */
export function isLanPairingOfferSupported(): boolean {
  const p = beaconPlugin();
  return !!(p && typeof p.addListener === 'function');
}

export function onLanPairingOffer(handler: (offer: LanPairingOffer) => void): UnsubscribeFn {
  const noop: UnsubscribeFn = () => { /* not native — nothing to detach */ };
  const p = beaconPlugin();
  if (!p || typeof p.addListener !== 'function') return noop;
  try {
    const remove = p.addListener('blastiPairingOffer', (...args: unknown[]) => {
      try {
        const evt = args[0] as { json?: string } | undefined;
        const raw = typeof evt?.json === 'string' ? evt.json : '';
        if (!raw) return;
        const offer = JSON.parse(raw) as LanPairingOffer;
        if (!offer || typeof offer !== 'object') return;
        if (offer.type !== undefined && offer.type !== 'blasti-pairing-offer') return;
        handler(offer);
      } catch { /* a malformed datagram must never crash the WebView */ }
    }) as unknown;
    // Capacitor's addListener returns a PluginListenerHandle { remove() } —
    // accept both that shape and a bare function.
    if (remove && typeof remove === 'object' && typeof (remove as { remove?: unknown }).remove === 'function') {
      return () => { try { (remove as { remove: () => void }).remove(); } catch { /* already detached */ } };
    }
    if (typeof remove === 'function') return remove as UnsubscribeFn;
    return noop;
  } catch {
    return noop;
  }
}
