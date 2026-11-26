'use client';

/**
 * PhonePairingAgent — the phone-side half of the BLASTI pairing protocol
 * (0.6.102 — DISCOVERY AUDIT fix).
 *
 * THE RULES THIS COMPONENT IMPLEMENTS (user audit directive):
 *  1. "only devices with active blasti app that sending discovery signals" —
 *     a phone with an AGENCY ACCOUNT OPENED announces itself on the branch
 *     LAN (native UDP beacon, mode 'phone') so the desktop Device Manager's
 *     strict result filter "PHONE WITH BLASTI APP" can surface it.
 *  2. "sending pairing request to discovered device / the discovered device
 *     may accept the request or reject it" — pending PAIRING_REQUESTs arrive
 *     through the pairing-wait socket room (instant) + the 5s device-status
 *     poll (fallback) and the phone operator MUST accept or reject. There is
 *     no auto-accept.
 *  3. "if pairing request is accepted then register the device for auto
 *     connection onward and search for each other on launch to connect and
 *     establish realtime connection" — on acceptance the device row binds to
 *     the agency; this agent resumes the heartbeat + joins the device socket
 *     room, and keeps the beacon announcing (status 'paired') so every
 *     future manager scan auto-connects by fingerprint.
 *  4. Connection purpose: "PHONE WITH BLASTI APP (with agency account
 *     opened) → manage shared queue under control master device" — the
 *     success toast states the purpose, and the paired row (type PHONE)
 *     renders in the manager's device tree under the branch.
 *
 * Runs ONLY inside a native shell (Capacitor) with an agency session — a
 * desktop browser running the agency dashboard IS the manager, not a
 * pairing target. Everything is a no-op otherwise.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useAppStore } from '@/store/use-app-store';
import { usePlatform } from '@/hooks/use-platform';
import { useRealtime } from '@/hooks/use-realtime';
import { useLanguage } from '@/hooks/use-language';
import { apiFetch } from '@/lib/api-fetch';
import { getCloudApiBaseUrl } from '@/lib/api-client';
import { startPairingBeacon, stopPairingBeacon, onLanPairingOffer, type LanPairingOffer } from '@/lib/pairing-beacon';
import { getNativeDeviceName } from '@/lib/device-display-name';
import { getStableDeviceFingerprint } from '@/components/devices/kiosk/kiosk-types';
import { getLocalizedString } from '@/components/agency/devices/types';
import { Button } from '@/components/ui/button';
import { Smartphone, Check, X, Loader2 } from 'lucide-react';
import { toast } from 'sonner';

// ─── Persisted device identity (the paired-device registry row) ─────────────
const DEVICE_ID_KEY = 'blasti_phone_device_id';
const DEVICE_TOKEN_KEY = 'blasti_phone_device_token';

function loadStoredDevice(): { id: string; token: string } | null {
  try {
    const id = localStorage.getItem(DEVICE_ID_KEY) || '';
    const token = localStorage.getItem(DEVICE_TOKEN_KEY) || '';
    return id && token ? { id, token } : null;
  } catch { return null; }
}

function saveStoredDevice(id: string, token: string): void {
  try {
    localStorage.setItem(DEVICE_ID_KEY, id);
    localStorage.setItem(DEVICE_TOKEN_KEY, token);
  } catch { /* private mode — pairing still works in-session */ }
}

function clearStoredDevice(): void {
  try {
    localStorage.removeItem(DEVICE_ID_KEY);
    localStorage.removeItem(DEVICE_TOKEN_KEY);
  } catch { /* ignore */ }
}

/** Same shape the kiosk PairingRequest carries (payload of PAIRING_REQUEST). */
interface PhonePairingRequest {
  id: string;
  agencyId: string;
  agencyName: string;
  agencyNameAr?: string;
  agencyNameFr?: string;
  sentByName?: string;
  deviceToken?: string;
  sentAt?: string;
  // ── 0.6.106 — device-to-device LAN delivery: set when the request arrived
  // as a unicast UDP offer from the manager's desktop. The accept then posts
  // DIRECTLY to that desktop (no cloud hop, no store-split wait).
  managerIp?: string;
  managerPort?: number;
}

/** device-status / accept-pairing calls must try BOTH stores: the request
 * may live in the LAN store (manager = branch master PC) or the cloud store
 * (manager = cloud session). The deviceToken only exists in one of them. */
async function deviceApiAcrossStores(
  path: string,
  init: { method?: string; token?: string; body?: Record<string, unknown> },
): Promise<{ ok: boolean; status: number; data: Record<string, unknown> | null }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (init.token) headers['Authorization'] = `Bearer ${init.token}`;
  const options = { method: init.method || 'GET', headers, body: init.body ? JSON.stringify(init.body) : undefined };

  // Attempt 1 — whatever base the apiClient failover resolves (LAN first when
  // a LAN server was discovered, else cloud).
  try {
    const res = await apiFetch(path, options);
    if (res.ok) {
      const data = await res.json().catch(() => null);
      return { ok: true, status: res.status, data };
    }
    if (res.status !== 401 && res.status !== 404) {
      const data = await res.json().catch(() => null);
      return { ok: false, status: res.status, data };
    }
  } catch { /* fall through to the explicit cloud attempt */ }

  // Attempt 2 — the explicit CLOUD store (manager relayed the request there
  // via the by-identity cloud relay). Relative path == attempt 1 in plain
  // browsers, so only retry when the cloud base is an absolute URL.
  const cloud = getCloudApiBaseUrl();
  if (!cloud || !/^https?:\/\//.test(cloud)) {
    return { ok: false, status: 401, data: null };
  }
  try {
    const res = await fetch(`${cloud.replace(/\/+$/, '')}${path}`, options);
    const data = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, data };
  } catch {
    return { ok: false, status: 0, data: null };
  }
}

export function PhonePairingAgent() {
  const { platform } = usePlatform();
  const user = useAppStore((s) => s.user);
  const realtime = useRealtime();
  const { lang } = useLanguage();

  const agencyOpen = !!(user && (user as { agencyId?: string }).agencyId);
  const isPhone = platform.isCapacitor;
  const active = isPhone && agencyOpen;

  const fingerprintRef = useRef<string>('');
  // 0.6.126 — the REAL device name (resolved once per mount via the native
  // plugin) that the beacon + discover-register announce to the manager.
  const deviceNameRef = useRef<string>('');
  const [deviceDisplayName, setDeviceDisplayName] = useState<string>('');
  const [paired, setPaired] = useState(false);
  const [pairBusy, setPairBusy] = useState<'accept' | 'reject' | null>(null);
  const [requests, setRequests] = useState<PhonePairingRequest[]>([]);
  const storedTokenRef = useRef<string>('');
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ─── Heartbeat + realtime device room (auto-connection onward) ────────────
  const startHeartbeat = useCallback((token: string) => {
    if (heartbeatRef.current) clearInterval(heartbeatRef.current);
    const beat = async () => {
      try {
        await deviceApiAcrossStores('/api/agency-devices/device/heartbeat', {
          method: 'POST', token, body: { status: 'ONLINE' },
        });
      } catch { /* transient — the next beat retries */ }
    };
    void beat();
    heartbeatRef.current = setInterval(beat, 30_000);
    realtime.joinDevice(token);
  }, [realtime]);

  const stopHeartbeat = useCallback(() => {
    if (heartbeatRef.current) { clearInterval(heartbeatRef.current); heartbeatRef.current = null; }
  }, []);

  // ─── Mount: resume a previously paired device, else register as orphan ────
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    fingerprintRef.current = getStableDeviceFingerprint();

    // 0.6.126 — resolve the REAL device name (owner-renamed → Bluetooth name
    // → brand default) BEFORE the beacon/register effects run. The resolved
    // name is what discovery shows — never the generic 'BLASTI App' again.
    getNativeDeviceName('BLASTI App').then((resolved) => {
      if (cancelled) return;
      deviceNameRef.current = resolved;
      setDeviceDisplayName(resolved);
    }).catch(() => { /* fallback name stays */ });

    async function boot() {
      const stored = loadStoredDevice();
      if (stored) {
        storedTokenRef.current = stored.token;
        const res = await deviceApiAcrossStores('/api/agency-devices/public/device-status', { token: stored.token });
        if (cancelled) return;
        if (res.ok && res.data && (res.data as { status?: string }).status === 'ONLINE') {
          // Paired on a previous launch — resume auto-connection onward.
          setPaired(true);
          startHeartbeat(stored.token);
          return;
        }
        if (res.status === 401) clearStoredDevice(); // token no longer valid
        storedTokenRef.current = '';
      }

      // Unpaired → register as a PHONE orphan so the manager's "waiting for
      // approval" strip + pairing channels can find this fingerprint even
      // without a scan (cloud-store parity with the UDP beacon).
      // 0.6.126 — the orphan row carries the REAL device name so the strip
      // and the scan cards all show "<Brand> <Model>" / the owner's name.
      try {
        const res = await apiFetch('/api/agency-devices/public/discover-register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            deviceName: deviceNameRef.current || 'BLASTI App (Phone)',
            deviceType: 'PHONE',
            connectionType: 'WIFI',
            deviceFingerprint: fingerprintRef.current,
          }),
        });
        const data = await res.json().catch(() => null);
        if (!cancelled && res.ok && data?.success && data?.deviceToken) {
          saveStoredDevice(data.device.id, data.deviceToken);
          storedTokenRef.current = data.deviceToken as string;
        }
      } catch { /* offline — the beacon still announces; register retries on next mount */ }
    }

    void boot();
    return () => { cancelled = true; };
  }, [active, startHeartbeat]);

  // ─── The discovery signal (rule 1): announce while the agency is open ─────
  // 0.6.126 — the beacon carries the REAL device name (deviceNameRef), so
  // the manager's scan card shows which phone is announcing.
  useEffect(() => {
    if (!active) return;
    void startPairingBeacon({
      name: deviceNameRef.current || 'BLASTI App',
      uid: fingerprintRef.current || getStableDeviceFingerprint(),
      status: paired ? 'paired' : 'ready-for-pairing',
      mode: 'phone',
    });
    return () => { void stopPairingBeacon(); };
  }, [active, paired, deviceDisplayName]);

  // ─── Pairing-request delivery: instant socket + 3s poll fallback ────────
  // 0.6.106 — THREE channels now: (1) the LAN UDP offer — the manager's
  // desktop unicasts the offer straight to THIS phone while the beacon
  // announces (device-to-device, no cloud, no poll wait); (2) the
  // pairing-wait socket rooms; (3) the device-status poll (3s, was 5s).
  useEffect(() => {
    if (!active || paired) return;
    const fingerprint = fingerprintRef.current || getStableDeviceFingerprint();
    const stored = loadStoredDevice();

    // Join the public pre-pairing rooms keyed by device id + fingerprint.
    realtime.emit('join:pairing-wait', { deviceId: stored?.id, fingerprint });

    const offRequest = realtime.on('pairing-request', (...args: unknown[]) => {
      const payload = args[0] as Partial<PhonePairingRequest> | undefined;
      if (!payload || typeof payload.id !== 'string' || !payload.agencyId) return;
      setRequests((prev) => (prev.some((r) => r.id === payload.id) ? prev : [...prev, payload as PhonePairingRequest]));
    });

    // 0.6.106 — the device-to-device offer (UDP :3082 → native event).
    const offLanOffer = onLanPairingOffer((offer: LanPairingOffer) => {
      const commandId = typeof offer.commandId === 'string' ? offer.commandId : (typeof offer.id === 'string' ? offer.id : '');
      const agencyId = typeof offer.agencyId === 'string' ? offer.agencyId : '';
      if (!commandId || !agencyId) return;
      const request: PhonePairingRequest = {
        id: commandId,
        agencyId,
        agencyName: typeof offer.agencyName === 'string' ? offer.agencyName : '',
        agencyNameAr: typeof offer.agencyNameAr === 'string' ? offer.agencyNameAr : undefined,
        agencyNameFr: typeof offer.agencyNameFr === 'string' ? offer.agencyNameFr : undefined,
        sentByName: typeof offer.sentByName === 'string' ? offer.sentByName : undefined,
        deviceToken: typeof offer.deviceToken === 'string' ? offer.deviceToken : undefined,
        sentAt: typeof offer.sentAt === 'string' ? offer.sentAt : new Date().toISOString(),
        managerIp: typeof offer.managerIp === 'string' ? offer.managerIp : undefined,
        managerPort: typeof offer.managerPort === 'number' ? offer.managerPort : undefined,
      };
      setRequests((prev) => (prev.some((r) => r.id === request.id) ? prev : [...prev, request]));
    });

    // 3s poll fallback (0.6.106 — was 5s; same contract the kiosk uses).
    const poll = async () => {
      const token = storedTokenRef.current || stored?.token;
      if (!token) return;
      try {
        const res = await deviceApiAcrossStores('/api/agency-devices/public/device-status', { token });
        if (res.ok && res.data) {
          const data = res.data as { pairingRequests?: PhonePairingRequest[]; status?: string };
          if (Array.isArray(data.pairingRequests) && data.pairingRequests.length > 0) {
            setRequests((prev) => {
              const seen = new Set(prev.map((r) => r.id));
              return [...prev, ...data.pairingRequests!.filter((r) => !seen.has(r.id))];
            });
          }
          // Paired by another surface (desktop accepted for this device row)?
          if (data.status === 'ONLINE') {
            setPaired(true);
            setRequests([]);
            startHeartbeat(token);
          }
        }
      } catch { /* polling continues */ }
    };
    void poll();
    pollRef.current = setInterval(poll, 3000);

    return () => {
      offRequest?.();
      offLanOffer();
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
      realtime.emit('leave:pairing-wait', { deviceId: stored?.id, fingerprint });
    };
  }, [active, paired, realtime, startHeartbeat]);

  // ─── Cleanup on logout / unmount ──────────────────────────────────────────
  useEffect(() => {
    if (active) return;
    void stopPairingBeacon();
    stopHeartbeat();
    setRequests([]);
    setPaired(false);
    storedTokenRef.current = '';
  }, [active, stopHeartbeat]);

  useEffect(() => () => {
    void stopPairingBeacon();
    stopHeartbeat();
    if (pollRef.current) clearInterval(pollRef.current);
  }, [stopHeartbeat]);

  // ─── Accept / Reject (rule 2: the DEVICE decides) ─────────────────────────
  // 0.6.106 — when the request arrived as a LAN UDP offer it carries the
  // MANAGER DESKTOP's address: the accept posts DIRECTLY to that desktop
  // over the Wi-Fi/LAN first (one round-trip, settles the store the manager
  // watches) and falls back to the across-stores accept on any failure.
  const handleAccept = useCallback(async (request: PhonePairingRequest) => {
    setPairBusy('accept');
    const stored = loadStoredDevice();
    const token = request.deviceToken || stored?.token || storedTokenRef.current;
    try {
      let settled = false;
      if (request.managerIp && typeof request.managerIp === 'string') {
        try {
          const base = `http://${request.managerIp}:${request.managerPort || 3080}`;
          const ctl = new AbortController();
          const timer = setTimeout(() => ctl.abort(), 6000);
          const directRes = await fetch(`${base}/api/agency-devices/device/accept-pairing`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            // 0.6.126 — fingerprint rides the accept (bootstrap auth path).
            body: JSON.stringify({ commandId: request.id, agencyId: request.agencyId, fingerprint: fingerprintRef.current || getStableDeviceFingerprint() }),
            signal: ctl.signal,
          });
          clearTimeout(timer);
          const directData = await directRes.json().catch(() => null);
          if (directRes.ok && directData && directData.success) settled = true;
        } catch { /* LAN unreachable — across-stores accept still runs */ }
      }
      if (!settled) {
        const res = await deviceApiAcrossStores('/api/agency-devices/device/accept-pairing', {
          method: 'POST',
          token,
          body: { commandId: request.id, agencyId: request.agencyId },
        });
        const data = res.data as { success?: boolean; error?: string } | null;
        settled = !!(res.ok && data?.success);
        if (!settled && data?.error) {
          toast.error(data.error || getLocalizedString('فشل قبول الربط', "Échec de l'acceptation", 'Pairing acceptance failed', lang));
          setPairBusy(null);
          return;
        }
      }
      if (settled) {
        if (request.deviceToken) saveStoredDevice(stored?.id || '', request.deviceToken);
        storedTokenRef.current = request.deviceToken || stored?.token || '';
        setPaired(true);
        setRequests([]);
        if (storedTokenRef.current) startHeartbeat(storedTokenRef.current);
        // Rule 4 — the connection purpose, stated to the operator.
        toast.success(getLocalizedString(
          `تم الربط بنجاح — إدارة الطابور المشترك تحت سيطرة الجهاز الرئيسي`,
          `Appairage réussi — gestion de la file partagée sous l'appareil maître`,
          `Paired — managing the shared queue under the master device`,
          lang,
        ));
      } else {
        toast.error(getLocalizedString('فشل قبول الربط', "Échec de l'acceptation", 'Pairing acceptance failed', lang));
      }
    } catch {
      toast.error(getLocalizedString('حدث خطأ', 'Une erreur est survenue', 'An error occurred', lang));
    } finally {
      setPairBusy(null);
    }
  }, [lang, startHeartbeat]);

  const handleReject = useCallback(async (request: PhonePairingRequest) => {
    setPairBusy('reject');
    const stored = loadStoredDevice();
    const token = request.deviceToken || stored?.token || storedTokenRef.current;
    try {
      await deviceApiAcrossStores('/api/agency-devices/device/reject-pairing', {
        method: 'POST', token, body: { commandId: request.id },
      });
    } catch { /* the request TTL expires server-side anyway */ }
    setRequests((prev) => prev.filter((r) => r.id !== request.id));
    setPairBusy(null);
  }, []);

  // ─── Render: the mandatory accept/reject prompt ───────────────────────────
  if (!active || paired || requests.length === 0) return null;
  const latest = requests[requests.length - 1];
  const agencyDisplay = lang === 'ar'
    ? (latest.agencyNameAr || latest.agencyName)
    : lang === 'fr'
      ? (latest.agencyNameFr || latest.agencyName)
      : latest.agencyName;

  return (
    <div
      role="alertdialog"
      aria-label={getLocalizedString('طلب ربط جهاز', 'Demande d\u2019appairage', 'Device pairing request', lang)}
      className="fixed inset-x-3 bottom-3 z-[90] mx-auto max-w-md rounded-2xl border border-emerald-300/60 bg-background/95 p-4 shadow-xl backdrop-blur dark:border-emerald-900/50"
    >
      <div className="flex items-start gap-3">
        <div className="rounded-xl bg-emerald-100 p-2.5 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400">
          <Smartphone className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">
            {getLocalizedString('طلب ربط من', 'Demande d\u2019appairage de', 'Pairing request from', lang)}
            {' '}
            <span className="text-emerald-700 dark:text-emerald-400">{agencyDisplay}</span>
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {latest.sentByName
              ? getLocalizedString(`أرسله ${latest.sentByName}`, `Envoyé par ${latest.sentByName}`, `Sent by ${latest.sentByName}`, lang)
              : getLocalizedString('طلب إدارة الأجهزة', 'Gestionnaire d\u2019appareils', 'Device manager', lang)}
            {' · '}
            {getLocalizedString('هل تقبل الربط بوكالتك؟', 'Accepter l\u2019appairage avec votre agence ?', 'Accept pairing with this agency?', lang)}
          </p>
        </div>
      </div>
      <div className="mt-3 flex gap-2">
        <Button
          className="h-10 flex-1 gap-1.5 bg-emerald-600 text-white hover:bg-emerald-700"
          disabled={!!pairBusy}
          onClick={() => void handleAccept(latest)}
        >
          {pairBusy === 'accept' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
          {getLocalizedString('قبول', 'Accepter', 'Accept', lang)}
        </Button>
        <Button
          variant="outline"
          className="h-10 flex-1 gap-1.5"
          disabled={!!pairBusy}
          onClick={() => void handleReject(latest)}
        >
          {pairBusy === 'reject' ? <Loader2 className="h-4 w-4 animate-spin" /> : <X className="h-4 w-4" />}
          {getLocalizedString('رفض', 'Refuser', 'Reject', lang)}
        </Button>
      </div>
    </div>
  );
}
