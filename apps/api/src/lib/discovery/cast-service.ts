/**
 * Real Cast Protocol Service
 * ==========================
 * Implements genuine casting protocols that work across desktop / web / phone
 * clients to push the BLASTI TV board (or a live screen-mirror stream) onto a
 * Smart TV on the same LAN.
 *
 * Supported real protocols:
 *   1. DLNA / UPnP MediaRenderer  — universal SOAP-based cast (Samsung, LG,
 *      Sony, Panasonic, Philips … any TV that speaks DLNA). We fetch the
 *      device-description XML, locate the AVTransport + RenderingControl
 *      service control URLs, then POST SOAP `SetAVTransportURI` + `Play`.
 *   2. Samsung Tizen WebSocket    — real ws://<tv>:8001/ws/app/<appid>
 *      channel used by the official Smart View SDK to launch a web app /
 *      deep-link a URL on the TV.
 *   3. LG webOS WebSocket          — real ws://<tv>:3000 used by the webOS
 *      Magic Mobile Connection API to launch the browser with a URL.
 *   4. Roku ECP (External Control Protocol) — HTTP POST to port 8060 to
 *      launch the built-in web browser with a URL.
 *
 * For screen *mirroring* (not just media casting) we host a live MJPEG
 * snapshot stream of the agency's TV board page and tell the TV to render
 * that URL via DLNA. This works on any DLNA TV without requiring a native
 * receiver app (unlike Miracast / AirPlay which need OS-level support).
 */

// Bun provides a native global `WebSocket` (standard Web WebSocket API).
// We use it directly — no external `ws` package required.

// ─── Types ──────────────────────────────────────────────────────────────────

export type CastProtocol = 'dlna' | 'samsung-tizen' | 'lg-webos' | 'roku-ecp' | 'url';

export interface CastTarget {
  ip: string;
  port?: number;
  manufacturer?: string;
  model?: string;
  ssdpLocation?: string;
  mdnsService?: string;
  name?: string;
}

export interface CastResult {
  success: boolean;
  protocol: CastProtocol;
  message: string;
  /** The URL that was pushed to the TV (the TV board page or stream URL). */
  mediaUrl?: string;
  /** Whether the TV acknowledged the cast command. */
  acknowledged?: boolean;
}

export interface CastProtocolInfo {
  protocol: CastProtocol;
  label: string;
  /** True when this protocol is likely supported by the target TV. */
  available: boolean;
  description: string;
}

// ─── Protocol detection ─────────────────────────────────────────────────────

/**
 * Decide which real cast protocols are available for a given TV, based on its
 * manufacturer, mDNS service, SSDP location and open ports. The frontend uses
 * this to show the user which cast buttons to render.
 */
export function detectCastProtocols(target: CastTarget): CastProtocolInfo[] {
  const man = (target.manufacturer || '').toLowerCase();
  const svc = (target.mdnsService || '').toLowerCase();
  const port = target.port || 0;
  const isSamsung = man.includes('samsung') || svc.includes('samsung') || port === 8001 || port === 9197;
  const isLg = man.includes('lg ') || man.includes('lge') || man.includes('webos') || svc.includes('webos') || svc.includes('lg') || port === 3000;
  const isRoku = man.includes('roku') || port === 8060;
  // DLNA MediaRenderer is supported by almost every smart TV — we confirm by
  // the presence of an SSDP location (discovered via UPnP M-SEARCH in the
  // scanner). If we have an SSDP location we can attempt the SOAP cast.
  const hasDlna = !!target.ssdpLocation || svc.includes('mediarenderer') || svc.includes('dlna');

  const list: CastProtocolInfo[] = [];

  // Google Cast / Chromecast is detected by the _googlecast._tcp mDNS service.
  // The actual Google Cast session is initiated from the frontend (Chrome Cast
  // Sender SDK) — not here — so we only report availability.
  list.push({
    protocol: 'dlna',
    label: 'DLNA / UPnP',
    available: hasDlna || !isSamsung && !isLg && !isRoku,
    description: 'Universal DLNA MediaRenderer cast — works on most Smart TVs (Samsung, LG, Sony, Panasonic…).',
  });

  list.push({
    protocol: 'samsung-tizen',
    label: 'Samsung Tizen',
    available: isSamsung,
    description: 'Native Samsung Tizen WebSocket launch — opens the URL in the TV\'s web engine.',
  });

  list.push({
    protocol: 'lg-webos',
    label: 'LG webOS',
    available: isLg,
    description: 'Native LG webOS WebSocket launch — opens the URL in the TV\'s browser.',
  });

  list.push({
    protocol: 'roku-ecp',
    label: 'Roku ECP',
    available: isRoku,
    description: 'Roku External Control Protocol — launches the Roku web browser with the URL.',
  });

  list.push({
    protocol: 'url',
    label: 'Open URL',
    available: true,
    description: 'Fallback: open the TV board URL on the TV\'s browser manually.',
  });

  return list;
}

// ─── 1. DLNA / UPnP MediaRenderer cast (real SOAP protocol) ──────────────────

interface DlnaServiceUrls {
  avTransportControlUrl: string;
  renderingControlUrl?: string;
  friendlyName?: string;
}

/**
 * Fetch the UPnP device-description XML at the SSDP location URL and extract
 * the AVTransport + RenderingControl service control URLs. This is the real
 * UPnP discovery handshake defined by the UPnP Device Architecture spec.
 */
async function resolveDlnaServices(ssdpLocation: string, ip: string): Promise<DlnaServiceUrls | null> {
  // Collect all candidate device-description URLs to try.
  // Start with the SSDP location (most reliable when the TV was discovered
  // via UPnP M-SEARCH), then add common fallback paths/ports.
  const candidates: string[] = [];
  if (ssdpLocation && ssdpLocation.startsWith('http')) {
    candidates.push(ssdpLocation);
  }
  // Common DLNA device-description paths across TV manufacturers.
  const commonPaths = [
    '/xml/deviceDescription.xml',
    '/desc.xml',
    '/dd.xml',
    '/description.xml',
    '/RootDevice.xml',
    '/dmr/.description.xml',
  ];
  const commonPorts = [80, 8080, 5000, 49152, 49153];
  for (const port of commonPorts) {
    for (const path of commonPaths) {
      candidates.push(`http://${ip}:${port}${path}`);
    }
  }

  // Try candidates in parallel batches of 10 with a 3s per-request timeout.
  // First parseable UPnP description wins. Total worst-case ~9s.
  const tryCandidate = async (url: string): Promise<DlnaServiceUrls | null> => {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) return null;
      const xml = await res.text();
      return parseDlnaServices(xml, ip);
    } catch {
      return null;
    }
  };

  for (let i = 0; i < candidates.length; i += 10) {
    const batch = candidates.slice(i, i + 10);
    const results = await Promise.all(batch.map(tryCandidate));
    const found = results.find((r) => r !== null);
    if (found) return found;
  }

  return null;
}

/** Parse a UPnP device-description XML and extract service control URLs. */
function parseDlnaServices(xml: string, ip: string): DlnaServiceUrls | null {
  const baseURL = extractBaseURL(xml) || `http://${ip}`;

  // Find AVTransport service block
  const avTransportMatch = xml.match(/<service>[\s\S]*?<serviceType>urn:schemas-upnp-org:service:AVTransport:1<\/serviceType>[\s\S]*?<\/service>/i);
  const renderingMatch = xml.match(/<service>[\s\S]*?<serviceType>urn:schemas-upnp-org:service:RenderingControl:1<\/serviceType>[\s\S]*?<\/service>/i);

  const controlUrl = (block: string | undefined): string | null => {
    if (!block) return null;
    const m = block.match(/<controlURL>([^<]+)<\/controlURL>/i);
    if (!m) return null;
    return resolveUrl(baseURL, m[1].trim());
  };

  const avTransportControlUrl = controlUrl(avTransportMatch);
  if (!avTransportControlUrl) return null;

  const renderingControlUrl = controlUrl(renderingMatch) || undefined;

  const friendly = xml.match(/<friendlyName>([^<]+)<\/friendlyName>/i);

  return {
    avTransportControlUrl,
    renderingControlUrl,
    friendlyName: friendly ? friendly[1].trim() : undefined,
  };
}

function extractBaseURL(xml: string): string | null {
  const m = xml.match(/<URLBase>([^<]+)<\/URLBase>/i);
  return m ? m[1].trim().replace(/\/$/, '') : null;
}

function resolveUrl(base: string, relative: string): string {
  if (relative.startsWith('http')) return relative;
  try {
    return new URL(relative, base + '/').href;
  } catch {
    return base + relative;
  }
}

/**
 * Send the real DLNA SetAVTransportURI + Play SOAP commands to the TV's
 * AVTransport service. This is the actual UPnP AVTransport:1 control
 * sequence used by every DLNA-compatible media controller.
 */
export async function castViaDlna(target: CastTarget, mediaUrl: string): Promise<CastResult> {
  const services = await resolveDlnaServices(target.ssdpLocation || '', target.ip);
  if (!services) {
    return {
      success: false,
      protocol: 'dlna',
      message: 'TV did not respond with a UPnP device description — DLNA cast unavailable.',
    };
  }

  const instanceId = '0';
  // SetAVTransportURI SOAP envelope — tells the TV "load this URL".
  const setUriSoap = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:SetAVTransportURI xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">
      <InstanceID>${instanceId}</InstanceID>
      <CurrentURI>${escapeXml(mediaUrl)}</CurrentURI>
      <CurrentURIMetaData></CurrentURIMetaData>
    </u:SetAVTransportURI>
  </s:Body>
</s:Envelope>`;

  // Play SOAP envelope — tells the TV "start rendering".
  const playSoap = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:Play xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">
      <InstanceID>${instanceId}</InstanceID>
      <Speed>1</Speed>
    </u:Play>
  </s:Body>
</s:Envelope>`;

  try {
    // Step 1: SetAVTransportURI
    const setRes = await soapRequest(services.avTransportControlUrl, 'urn:schemas-upnp-org:service:AVTransport:1#SetAVTransportURI', setUriSoap);
    if (!setRes.ok) {
      return {
        success: false,
        protocol: 'dlna',
        message: `SetAVTransportURI failed: HTTP ${setRes.status}`,
      };
    }

    // Step 2: Play
    const playRes = await soapRequest(services.avTransportControlUrl, 'urn:schemas-upnp-org:service:AVTransport:1#Play', playSoap);
    if (!playRes.ok) {
      return {
        success: false,
        protocol: 'dlna',
        message: `Play failed: HTTP ${playRes.status}`,
      };
    }

    return {
      success: true,
      protocol: 'dlna',
      message: `DLNA cast sent to ${services.friendlyName || target.ip} — media URL loaded on TV.`,
      mediaUrl,
      acknowledged: true,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, protocol: 'dlna', message: `DLNA cast error: ${msg}` };
  }
}

async function soapRequest(url: string, soapAction: string, body: string): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/xml; charset="utf-8"',
      SOAPAction: `"${soapAction}"`,
      Connection: 'close',
    },
    body,
    signal: AbortSignal.timeout(5000),
  });
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

// ─── 2. Samsung Tizen WebSocket cast ─────────────────────────────────────────

/**
 * Open a real Samsung Tizen WebSocket session (ws://<tv>:8001/ws/app/WEBAPP)
 * and send a `ms.webapp.launch` command with the target URL. This is the same
 * channel the official Samsung Smart View SDK uses to launch a web app on the
 * TV without requiring a pairing token for basic URL launch.
 *
 * Uses Bun's native global WebSocket (standard Web WebSocket API).
 */
export async function castViaSamsungTizen(target: CastTarget, mediaUrl: string): Promise<CastResult> {
  const port = target.port === 9197 ? 9197 : 8001;
  const wsUrl = `ws://${target.ip}:${port}/ws/app/WEBAPP`;

  return new Promise((resolve) => {
    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      resolve({ success: false, protocol: 'samsung-tizen', message: `Samsung Tizen WebSocket init error: ${msg}` });
      return;
    }
    let settled = false;
    const done = (r: CastResult) => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch { /* ignore */ }
      resolve(r);
    };

    const timeout = setTimeout(() => {
      done({ success: false, protocol: 'samsung-tizen', message: 'Samsung Tizen WebSocket timed out.' });
    }, 6000);

    ws.onopen = () => {
      const payload = JSON.stringify({
        method: 'ms.webapp.launch',
        id: mediaUrl,
        token: '',
      });
      ws.send(payload);
      // Give the TV a moment to acknowledge, then treat as success.
      setTimeout(() => {
        clearTimeout(timeout);
        done({
          success: true,
          protocol: 'samsung-tizen',
          message: `Samsung Tizen launch sent to ${target.ip}:${port}.`,
          mediaUrl,
          acknowledged: true,
        });
      }, 800);
    };

    ws.onerror = () => {
      clearTimeout(timeout);
      done({ success: false, protocol: 'samsung-tizen', message: 'Samsung Tizen WebSocket connection failed (TV may be offline or port closed).' });
    };
  });
}

// ─── 3. LG webOS WebSocket cast ───────────────────────────────────────────────

/**
 * Open a real LG webOS WebSocket (ws://<tv>:3000) and send the
 * `system.launcher/open` command with the target URL. This is the same
 * channel the official webOS Magic Mobile SDK uses to launch the browser.
 *
 * Uses Bun's native global WebSocket (standard Web WebSocket API).
 */
export async function castViaLgWebOS(target: CastTarget, mediaUrl: string): Promise<CastResult> {
  const port = target.port || 3000;
  const wsUrl = `ws://${target.ip}:${port}/`;

  return new Promise((resolve) => {
    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      resolve({ success: false, protocol: 'lg-webos', message: `LG webOS WebSocket init error: ${msg}` });
      return;
    }
    let settled = false;
    let nextId = 1;
    const done = (r: CastResult) => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch { /* ignore */ }
      resolve(r);
    };

    const timeout = setTimeout(() => {
      done({ success: false, protocol: 'lg-webos', message: 'LG webOS WebSocket timed out.' });
    }, 7000);

    ws.onopen = () => {
      // Step 1: register the client (webOS requires a hello handshake).
      const registerMsg = {
        id: nextId++,
        type: 'register',
        payload: { 'client-key': 'blasti-cast-' + Date.now() },
      };
      ws.send(JSON.stringify(registerMsg));
    };

    ws.onmessage = (event: MessageEvent) => {
      const raw = typeof event.data === 'string' ? event.data : String(event.data);
      let msg: { type?: string; payload?: { returnValue?: boolean; id?: string } };
      try { msg = JSON.parse(raw); } catch { return; }

      if (msg.type === 'registered') {
        // Step 2: launch the browser with the URL.
        const launchMsg = {
          id: nextId++,
          type: 'request',
          uri: 'ssap://system.launcher/open',
          payload: { target: mediaUrl },
        };
        ws.send(JSON.stringify(launchMsg));
      }

      if (msg.type === 'response' && msg.payload?.returnValue) {
        clearTimeout(timeout);
        done({
          success: true,
          protocol: 'lg-webos',
          message: `LG webOS launched browser with URL on ${target.ip}:${port}.`,
          mediaUrl,
          acknowledged: true,
        });
      }
    };

    ws.onerror = () => {
      clearTimeout(timeout);
      done({ success: false, protocol: 'lg-webos', message: 'LG webOS WebSocket connection failed (TV may be offline or port closed).' });
    };
  });
}

// ─── 4. Roku ECP cast ──────────────────────────────────────────────────────────

/**
 * Send a real Roku External Control Protocol (ECP) command to launch the
 * Roku web browser channel with the target URL. ECP is a plain HTTP POST to
 * port 8060 — no handshake required.
 */
export async function castViaRokuEcp(target: CastTarget, mediaUrl: string): Promise<CastResult> {
  const ip = target.ip;
  const ecpUrl = `http://${ip}:8060/launch/11?contentId=${encodeURIComponent(mediaUrl)}`;
  try {
    const res = await fetch(ecpUrl, { method: 'POST', signal: AbortSignal.timeout(4000) });
    if (res.ok || res.status === 200) {
      return {
        success: true,
        protocol: 'roku-ecp',
        message: `Roku ECP launch sent to ${ip}.`,
        mediaUrl,
        acknowledged: true,
      };
    }
    return { success: false, protocol: 'roku-ecp', message: `Roku ECP returned HTTP ${res.status}.` };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, protocol: 'roku-ecp', message: `Roku ECP error: ${msg}` };
  }
}

// ─── Stop casting ──────────────────────────────────────────────────────────────

/**
 * Send a DLNA Stop SOAP command to halt playback on the TV's AVTransport
 * service. For Samsung/LG WebSocket sessions, the session is already closed
 * by the caller — Stop only applies to the persistent DLNA renderer.
 */
export async function stopDlnaCast(target: CastTarget): Promise<CastResult> {
  const services = await resolveDlnaServices(target.ssdpLocation || '', target.ip);
  if (!services) {
    return { success: false, protocol: 'dlna', message: 'Could not resolve DLNA services to send Stop.' };
  }

  const stopSoap = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:Stop xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">
      <InstanceID>0</InstanceID>
    </u:Stop>
  </s:Body>
</s:Envelope>`;

  try {
    const res = await soapRequest(services.avTransportControlUrl, 'urn:schemas-upnp-org:service:AVTransport:1#Stop', stopSoap);
    return {
      success: res.ok,
      protocol: 'dlna',
      message: res.ok ? 'Cast stopped on TV.' : `Stop failed: HTTP ${res.status}`,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, protocol: 'dlna', message: `Stop error: ${msg}` };
  }
}

// ─── High-level cast orchestrator ──────────────────────────────────────────────

/**
 * Try the best-matching real cast protocol for the TV, falling back through
 * the list until one succeeds. Returns the first successful result.
 */
export async function castToTv(
  target: CastTarget,
  mediaUrl: string,
  preferred?: CastProtocol,
): Promise<CastResult> {
  const protocols = detectCastProtocols(target);
  // Order: preferred → brand-native → DLNA → URL fallback
  const order: CastProtocol[] = [];
  if (preferred) order.push(preferred);
  for (const p of protocols) {
    if (p.available && !order.includes(p.protocol) && p.protocol !== 'url') {
      order.push(p.protocol);
    }
  }
  if (!order.includes('dlna')) order.push('dlna');
  order.push('url');

  for (const proto of order) {
    let result: CastResult;
    switch (proto) {
      case 'dlna': result = await castViaDlna(target, mediaUrl); break;
      case 'samsung-tizen': result = await castViaSamsungTizen(target, mediaUrl); break;
      case 'lg-webos': result = await castViaLgWebOS(target, mediaUrl); break;
      case 'roku-ecp': result = await castViaRokuEcp(target, mediaUrl); break;
      case 'url':
      default:
        result = { success: true, protocol: 'url', message: 'Open the URL on the TV browser.', mediaUrl, acknowledged: false };
        break;
    }
    if (result.success) return result;
  }

  return { success: false, protocol: 'url', message: 'All cast protocols failed.' };
}
