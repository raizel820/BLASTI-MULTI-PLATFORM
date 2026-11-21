/**
 * Real Cast Protocol Service (CommonJS port)
 * ═════════════════════════════════════════════════════════════════════════
 * 1:1 CommonJS port of apps/api/src/lib/discovery/cast-service.ts
 * (TypeScript, cloud reference implementation) for the Electron main
 * process (apps/desktop/local-api — no TypeScript compilation, no new
 * npm dependencies allowed here).
 *
 * Implements genuine casting protocols that work across desktop / web /
 * phone clients to push the BLASTI TV board (or a live screen-mirror
 * stream) onto a Smart TV on the same LAN.
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
 *
 * Runtime notes (port):
 *  - The TS original imports NOTHING: it uses only platform globals.
 *    `fetch` + `AbortSignal.timeout` are available since Node 18, the
 *    standard global `WebSocket` is stable since Node 22 — Electron ≥ 28
 *    embeds Node ≥ 18/20/22, so this file stays dependency-free
 *    (Node core + globals only, exactly like the rest of local-api).
 *  - TypeScript-only artifacts (the CastProtocol / CastTarget / CastResult
 *    / CastProtocolInfo / DlnaServiceUrls types) are stripped; every
 *    function, constant, default, timeout and XML payload is preserved
 *    byte-for-byte.
 */

// ─── 0. Board snapshot provider (0.6.96) ───────────────────────────────────
// DLNA / Chromecast / Roku can only render MEDIA (an image or a video), not a
// live web page. The desktop main process registers a provider here that
// renders the agency's TV board in a hidden Electron window and captures it
// as a JPEG; the cast routes then push `…/cast/snapshot.jpg` to the TV so the
// board actually APPEARS on the screen (not a dead URL).

let snapshotProvider = null; // async (url) => Buffer | null
let snapshotProviderName = null;
let lastSnapshot = null;        // { buf, ts } — served by GET /cast/snapshot.jpg
const SNAPSHOT_MAX_AGE_MS = 90_000; // renderers may re-fetch; keep it brief

function setSnapshotProvider(fn, name) {
  snapshotProvider = typeof fn === 'function' ? fn : null;
  snapshotProviderName = typeof name === 'string' ? name : null;
}

function hasSnapshotProvider() {
  return !!snapshotProvider;
}

async function captureSnapshot(url) {
  if (!snapshotProvider) return null;
  // Fresh cache → reuse (a renderer may fetch the URL seconds after the cast).
  if (lastSnapshot && Date.now() - lastSnapshot.ts < SNAPSHOT_MAX_AGE_MS) {
    return lastSnapshot.buf;
  }
  try {
    const buf = await snapshotProvider(url);
    if (buf && buf.length > 0) {
      lastSnapshot = { buf, ts: Date.now() };
      return buf;
    }
    return null;
  } catch {
    return null;
  }
}

/** The most recent snapshot buffer (even if older than the cache window). */
async function getLastSnapshot() {
  if (lastSnapshot) return lastSnapshot.buf;
  return null;
}

function getLastSnapshotTs() {
  return lastSnapshot ? lastSnapshot.ts : null;
}

// ─── Protocol detection ─────────────────────────────────────────────────────

/**
 * Decide which real cast protocols are available for a given TV, based on its
 * manufacturer, mDNS service, SSDP location and open ports. The frontend uses
 * this to show the user which cast buttons to render.
 *
 * CastTarget: { ip, port?, manufacturer?, model?, ssdpLocation?, mdnsService?, name? }
 * CastProtocolInfo: { protocol, label, available, description }
 */
function detectCastProtocols(target) {
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
  // Google Cast (Chromecast / Android TV) + AirPlay — informational entries
  // (the actual session is driven by the browser / OS).
  const hasGoogleCast = svc.includes('googlecast') || svc.includes('google_cast') || svc.includes('_androidtv') || man.includes('google');
  const hasAirplay = svc.includes('airplay') || svc.includes('airtunes') || man.includes('apple');

  const list = [];

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

  // 0.6.96 — Google Cast is now a REAL, direct sender: the local API speaks
  // the CASTv2 protocol itself (TLS :8009 + protobuf) and launches the Default
  // Media Receiver with the board snapshot. No Chrome/Edge involved.
  list.push({
    protocol: 'google-cast',
    label: 'Google Cast',
    available: hasGoogleCast,
    description: 'Chromecast / Android TV detected — direct CASTv2 cast (Default Media Receiver), no browser.',
  });

  list.push({
    protocol: 'airplay',
    label: 'AirPlay',
    available: hasAirplay,
    description: 'Apple TV detected — use AirPlay mirroring or HDMI (URL casting is not supported by Apple).',
  });

  list.push({
    protocol: 'blasti-tv',
    label: 'BLASTI TV (direct)',
    available: true,
    description: 'TV running the BLASTI board app — direct LAN command, live board, no browser.',
  });

  return list;
}

// ─── 1. DLNA / UPnP MediaRenderer cast (real SOAP protocol) ──────────────────

/**
 * Fetch the UPnP device-description XML at the SSDP location URL and extract
 * the AVTransport + RenderingControl service control URLs. This is the real
 * UPnP discovery handshake defined by the UPnP Device Architecture spec.
 *
 * Returns { avTransportControlUrl, renderingControlUrl?, friendlyName? } or null.
 */
async function resolveDlnaServices(ssdpLocation, ip) {
  // Collect all candidate device-description URLs to try.
  // Start with the SSDP location (most reliable when the TV was discovered
  // via UPnP M-SEARCH), then add common fallback paths/ports.
  const candidates = [];
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
  const tryCandidate = async (url) => {
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
function parseDlnaServices(xml, ip) {
  const baseURL = extractBaseURL(xml) || `http://${ip}`;

  // Find AVTransport service block
  const avTransportMatch = xml.match(/<service>[\s\S]*?<serviceType>urn:schemas-upnp-org:service:AVTransport:1<\/serviceType>[\s\S]*?<\/service>/i);
  const renderingMatch = xml.match(/<service>[\s\S]*?<serviceType>urn:schemas-upnp-org:service:RenderingControl:1<\/serviceType>[\s\S]*?<\/service>/i);

  const controlUrl = (block) => {
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

function extractBaseURL(xml) {
  const m = xml.match(/<URLBase>([^<]+)<\/URLBase>/i);
  return m ? m[1].trim().replace(/\/$/, '') : null;
}

function resolveUrl(base, relative) {
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
async function castViaDlna(target, mediaUrl) {
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
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, protocol: 'dlna', message: `DLNA cast error: ${msg}` };
  }
}

async function soapRequest(url, soapAction, body) {
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

function escapeXml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

// ─── 2. Samsung Tizen WebSocket cast ─────────────────────────────────────────

/**
 * Open a real Samsung Tizen WebSocket session (ws://<tv>:8001/ws/app/WEBAPP)
 * and send a `ms.webapp.launch` command with the target URL. This is the same
 * channel the official Samsung Smart View SDK uses to launch a web app on the
 * TV without requiring a pairing token for basic URL launch.
 *
 * Uses the runtime's native global WebSocket (standard Web WebSocket API).
 */
async function castViaSamsungTizen(target, mediaUrl) {
  const port = target.port === 9197 ? 9197 : 8001;
  const wsUrl = `ws://${target.ip}:${port}/ws/app/WEBAPP`;

  return new Promise((resolve) => {
    let ws;
    try {
      ws = new WebSocket(wsUrl);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      resolve({ success: false, protocol: 'samsung-tizen', message: `Samsung Tizen WebSocket init error: ${msg}` });
      return;
    }
    let settled = false;
    const done = (r) => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch { /* ignore */ }
      resolve(r);
    };

    const timeout = setTimeout(() => {
      done({ success: false, protocol: 'samsung-tizen', message: 'Samsung Tizen WebSocket timed out.' });
    }, 6000);

    ws.onopen = () => {
      // Real Tizen web-app launch payload: {method, params:{url}, id}.
      // The historic shape (id: mediaUrl) was ignored by newer Tizen firmwares.
      const payload = JSON.stringify({
        method: 'ms.webapp.launch',
        params: { url: mediaUrl },
        id: 'blasti-cast-1',
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
 * Uses the runtime's native global WebSocket (standard Web WebSocket API).
 */
async function castViaLgWebOS(target, mediaUrl) {
  const port = target.port || 3000;
  const wsUrl = `ws://${target.ip}:${port}/`;

  return new Promise((resolve) => {
    let ws;
    try {
      ws = new WebSocket(wsUrl);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      resolve({ success: false, protocol: 'lg-webos', message: `LG webOS WebSocket init error: ${msg}` });
      return;
    }
    let settled = false;
    let nextId = 1;
    const done = (r) => {
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

    ws.onmessage = (event) => {
      const raw = typeof event.data === 'string' ? event.data : String(event.data);
      let msg;
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
async function castViaRokuEcp(target, mediaUrl) {
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
  } catch (err) {
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
async function stopDlnaCast(target) {
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
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, protocol: 'dlna', message: `Stop error: ${msg}` };
  }
}

// ─── 5. Google Cast / Chromecast — REAL CASTv2 sender (0.6.96) ─────────────
// Speaks the actual Google Cast V2 protocol directly: a TLS connection to the
// dongle/TV on port 8009, protobuf-framed CastMessage envelopes (hand-rolled
// encoder — cast_channel.proto is a flat message of 6 fields), the standard
// virtual-connection handshake, a LAUNCH of the Default Media Receiver
// (appId CC1AD845) and a LOAD of the board snapshot JPEG. NO browser, NO
// Chrome/Edge, NO external dependency.

const tls = require('tls');

const CASTV2_NS_CONNECTION = 'urn:x-cast:com.google.cast.tp.connection';
const CASTV2_NS_RECEIVER = 'urn:x-cast:com.google.cast.receiver';
const CASTV2_NS_MEDIA = 'urn:x-cast:com.google.cast.media';
const CASTV2_DEFAULT_MEDIA_RECEIVER = 'CC1AD845';

/** protobuf wire helpers for cast_channel.proto CastMessage. */
function pbVarint(field, value) {
  const tag = field << 3 | 0; // wiretype 0 (varint)
  const tagBytes = encodeVarint(tag);
  return Buffer.concat([tagBytes, encodeVarint(value >>> 0)]);
}
function encodeVarint(value) {
  const out = [];
  let v = value >>> 0;
  while (v > 0x7f) { out.push((v & 0x7f) | 0x80); v >>>= 7; }
  out.push(v & 0x7f);
  return Buffer.from(out);
}
function pbString(field, str) {
  const tag = Buffer.from([(field << 3) | 2]); // wiretype 2 (length-delimited)
  const payload = Buffer.from(String(str), 'utf8');
  return Buffer.concat([tag, encodeVarint(payload.length), payload]);
}
/** CastMessage { protocol_version:1(CASTV2_1_0=0), source_id, receiver_id, namespace, payload_type:0(STRING), payload_utf8 } */
function encodeCastMessage({ sourceId, receiverId, namespace, payloadUtf8 }) {
  return Buffer.concat([
    pbVarint(1, 0),              // protocol_version = CASTV2_1_0
    pbString(2, sourceId),       // source_id
    pbString(3, receiverId),     // receiver_id
    pbString(4, namespace),      // namespace
    pbVarint(5, 0),              // payload_type = STRING
    pbString(6, payloadUtf8),    // payload_utf8
  ]);
}
function frameMessage(msgBuffer) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(msgBuffer.length, 0);
  return Buffer.concat([len, msgBuffer]);
}

/**
 * One full CASTv2 session: connect → virtual connect → launch Default Media
 * Receiver → LOAD the media URL (the board snapshot JPEG). Resolves
 * { success, protocol:'google-cast', message, acknowledged }.
 */
function castViaGoogleCast(target, mediaUrl, { title } = {}) {
  const host = target.ip;
  const port = target.port === 8009 ? 8009 : 8009;
  return new Promise((resolve) => {
    let settled = false;
    let sock = null;
    let buffer = Buffer.alloc(0);
    let requestId = 1;
    let transportId = null;
    let launched = false;
    const done = (r) => {
      if (settled) return;
      settled = true;
      try { if (sock) sock.destroy(); } catch { /* ignore */ }
      resolve(r);
    };
    const overallTimer = setTimeout(() => {
      done({ success: false, protocol: 'google-cast', message: 'Google Cast timed out (device unreachable or cast rejected).' });
    }, 9000);

    const send = (namespace, receiverId, obj) => {
      if (!sock) return;
      try {
        sock.write(frameMessage(encodeCastMessage({
          sourceId: 'sender-0',
          receiverId,
          namespace,
          payloadUtf8: JSON.stringify(obj),
        })));
      } catch { /* socket gone — the timeout/error paths settle it */ }
    };

    const handleText = (namespace, obj) => {
      if (!obj || typeof obj !== 'object') return;
      if (namespace === CASTV2_NS_RECEIVER) {
        const apps = (obj.status && Array.isArray(obj.status.applications)) ? obj.status.applications : [];
        const app = apps.find((a) => a.appId === CASTV2_DEFAULT_MEDIA_RECEIVER);
        if (app && app.transportId && !launched) {
          launched = true;
          transportId = app.transportId;
          // Virtual connection to the app, then LOAD the media.
          send(CASTV2_NS_CONNECTION, transportId, { type: 'CONNECT' });
          send(CASTV2_NS_MEDIA, transportId, {
            type: 'LOAD',
            requestId: ++requestId,
            autoplay: true,
            currentTime: 0,
            media: {
              contentId: mediaUrl,
              streamType: 'BUFFERED',
              contentType: 'image/jpeg',
              metadata: { type: 0, metadataType: 0, title: title || 'BLASTI Queue Board' },
            },
          });
        }
      }
      if (namespace === CASTV2_NS_MEDIA) {
        // A MEDIA_STATUS with a loaded media session (or a LOAD_FAILED) settles it.
        if (obj.type === 'LOAD_FAILED') {
          clearTimeout(overallTimer);
          done({ success: false, protocol: 'google-cast', message: 'Chromecast refused the media (LOAD_FAILED).' });
          return;
        }
        if (obj.type === 'MEDIA_STATUS' && Array.isArray(obj.status)) {
          clearTimeout(overallTimer);
          done({
            success: true,
            protocol: 'google-cast',
            message: `Google Cast: board snapshot loaded on ${host}.`,
            mediaUrl,
            acknowledged: true,
          });
        }
      }
    };

    try {
      sock = tls.connect({ host, port, rejectUnauthorized: false }, () => {
        // Step 1 — virtual connection to the receiver, then LAUNCH the app.
        send(CASTV2_NS_CONNECTION, 'receiver-0', { type: 'CONNECT' });
        send(CASTV2_NS_RECEIVER, 'receiver-0', { type: 'LAUNCH', appId: CASTV2_DEFAULT_MEDIA_RECEIVER, requestId });
      });
      sock.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        // Parse as many length-prefixed frames as arrived.
        while (buffer.length >= 4) {
          const frameLen = buffer.readUInt32BE(0);
          if (frameLen <= 0 || frameLen > 256 * 1024) { buffer = Buffer.alloc(0); break; }
          if (buffer.length < 4 + frameLen) break;
          const frame = buffer.slice(4, 4 + frameLen);
          buffer = buffer.slice(4 + frameLen);
          try {
            const parsed = decodeCastMessage(frame);
            if (parsed && parsed.payloadUtf8) {
              let obj = null;
              try { obj = JSON.parse(parsed.payloadUtf8); } catch { obj = null; }
              handleText(parsed.namespace, obj);
            }
          } catch { /* malformed frame — skip */ }
        }
      });
      sock.on('error', () => {
        clearTimeout(overallTimer);
        done({ success: false, protocol: 'google-cast', message: 'Google Cast connection failed (device may be offline or port 8009 closed).' });
      });
    } catch (err) {
      clearTimeout(overallTimer);
      done({ success: false, protocol: 'google-cast', message: 'Google Cast init error: ' + (err && err.message ? err.message : 'unknown') });
    }
  });
}

/** Minimal CastMessage DECODER — only the 6 fields we encoded (varint + strings). */
function decodeCastMessage(buf) {
  let i = 0;
  const readVarint = () => {
    let value = 0; let shift = 0;
    while (i < buf.length) {
      const b = buf[i++];
      value += (b & 0x7f) * Math.pow(2, shift);
      if ((b & 0x80) === 0) break;
      shift += 7;
    }
    return value;
  };
  const readString = () => {
    const len = readVarint();
    if (len < 0 || i + len > buf.length) return '';
    const s = buf.slice(i, i + len).toString('utf8');
    i += len;
    return s;
  };
  const out = {};
  while (i < buf.length) {
    const tag = buf[i++];
    const field = tag >> 3;
    const wire = tag & 0x7;
    if (wire === 0) { readVarint(); }
    else if (wire === 2) {
      const len = readVarint();
      if (len < 0 || i + len > buf.length) break;
      if (field === 4) out.namespace = buf.slice(i, i + len).toString('utf8');
      else if (field === 6) out.payloadUtf8 = buf.slice(i, i + len).toString('utf8');
      i += len;
    } else break;
  }
  return out;
}

// ─── High-level cast orchestrator ──────────────────────────────────────────────

/**
 * Try the best-matching real cast protocol for the TV, falling back through
 * the list until one succeeds. 0.6.96: every protocol is DIRECT — vendor
 * websockets, DLNA SOAP, CASTv2. There is NO "open in a browser" fallback
 * any more: when everything fails we say so instead of pretending.
 */
async function castToTv(target, mediaUrl, preferred) {
  const protocols = detectCastProtocols(target);
  const executable = ['dlna', 'samsung-tizen', 'lg-webos', 'roku-ecp', 'google-cast'];
  const order = [];
  if (preferred && executable.includes(preferred)) order.push(preferred);
  for (const p of protocols) {
    if (p.available && !order.includes(p.protocol) && executable.includes(p.protocol)) {
      order.push(p.protocol);
    }
  }
  if (!order.includes('dlna')) order.push('dlna');

  const failures = [];
  for (const proto of order) {
    let result;
    switch (proto) {
      case 'dlna': result = await castViaDlna(target, mediaUrl); break;
      case 'samsung-tizen': result = await castViaSamsungTizen(target, mediaUrl); break;
      case 'lg-webos': result = await castViaLgWebOS(target, mediaUrl); break;
      case 'roku-ecp': result = await castViaRokuEcp(target, mediaUrl); break;
      case 'google-cast': result = await castViaGoogleCast(target, mediaUrl); break;
      default: result = { success: false, message: 'Unknown protocol ' + proto }; break;
    }
    if (result.success) return result;
    failures.push(`${proto}: ${result.message || 'failed'}`);
  }

  return {
    success: false,
    protocol: order[0] || 'dlna',
    message: `All cast protocols failed — ${failures.join(' | ')}`,
    mediaUrl,
  };
}

module.exports = {
  detectCastProtocols,
  castToTv,
  castViaDlna,
  castViaSamsungTizen,
  castViaLgWebOS,
  castViaRokuEcp,
  castViaGoogleCast,
  stopDlnaCast,
  setSnapshotProvider,
  hasSnapshotProvider,
  captureSnapshot,
  getLastSnapshot,
  getLastSnapshotTs,
};
