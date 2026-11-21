/**
 * device-signal — client mirror of the server's signal-backed whitelist.
 * ─────────────────────────────────────────────────────────────────────────────
 * 0.6.97 — USER REQUIREMENT: "device manager discovery should discover ONLY
 * devices with the BLASTI app running on them (by responding to the app
 * signal) or TVs, printers and kiosk mode on the BLASTI app (responding to
 * the signal)".
 *
 * Defense in depth: the server shapers (apps/api/src/lib/discovery/scanner.ts
 * + apps/desktop/local-api/lib/discovery-scanner.js) already filter, and this
 * exact predicate is mirrored here so a stale API build or `include=all`
 * diagnostics data can never render PCs/routers/IoT/generic-phone noise in
 * the manager.
 *
 * 1:1 with isSignalBackedDevice() in the scanner sources.
 */

export interface SignalDeviceInput {
  type?: string;
  category?: string;
  source?: string;
  capabilities?: string[];
  tcpServices?: string[];
  mdnsService?: string;
  ssdpSt?: string;
  ssdpLocation?: string;
  httpTitle?: string;
  httpServer?: string;
  httpUrl?: string;
  wsdType?: string;
  blastiMode?: string;
  blastiInfo?: unknown;
  cupsName?: string;
  cupsUri?: string;
  usbVendorId?: string;
  usbProductId?: string;
  manufacturer?: string;
}

export function isSignalBackedDevice(d: SignalDeviceInput | null | undefined): boolean {
  if (!d) return false;
  const type = String(d.type || '').toUpperCase();
  const cat = String(d.category || '').toUpperCase();
  const src = String(d.source || '');
  const caps = (Array.isArray(d.capabilities) ? d.capabilities : []).map((c) => String(c).toUpperCase());
  const tcp = (Array.isArray(d.tcpServices) ? d.tcpServices : []).map((s) => String(s).toLowerCase());
  const mdns = String(d.mdnsService || '').toLowerCase();
  const ssdpSt = String(d.ssdpSt || '').toLowerCase();

  // ── 1. The BLASTI app answered a BLASTI signal ──
  const blastiSignal =
    cat === 'BLASTI' ||
    src === 'udp-beacon' || src === 'live-beacon' || src === 'database' ||
    caps.includes('UDP_BEACON') ||
    (typeof d.blastiMode === 'string' && d.blastiMode.length > 0) ||
    /blasti/i.test(mdns) ||
    /blasti/i.test(String(d.httpServer || ''));
  if (blastiSignal) return true;

  // ── 2. TVs / displays must have ANSWERED a TV discovery signal ──
  if (type === 'TV' || type === 'DISPLAY') {
    const mdnsHit = !!mdns && /googlecast|airplay|roku|_rimedia|_samsung|_tcl|_viera|_bravia|_webos|_androidtv|_firetv|_firestick|_dial|_tv\./.test(mdns);
    const ssdpHit = !!ssdpSt && /(media|avtransport|dial|screen|tv|display)/.test(ssdpSt);
    const tcpHit = tcp.some((s) => /googlecast|airplay|roku|samsung-tv/.test(s));
    const httpHit = !!(d.httpTitle || d.httpServer || d.httpUrl || d.ssdpLocation);
    const wsdHit = !!d.wsdType && /display|tv|media/i.test(String(d.wsdType));
    return Boolean(mdnsHit || ssdpHit || tcpHit || httpHit || wsdHit);
  }

  // ── 3. Printers must have ANSWERED a printer discovery signal ──
  if (type === 'PRINTER') {
    // 0.6.100 — CASCADE PERIPHERALS: a printer reported by a BLASTI host
    // (the host itself answered the BLASTI signal) inherits that trust —
    // the USB printer plugged into ANOTHER branch PC is discoverable from
    // any scan and can be registered + used by every branch device.
    if (src === 'peripheral-report') return true;
    const mdnsHit = !!mdns && /ipp|ipps|_printer|_pdl|_uscan|jetdirect|_printing/.test(mdns);
    const ssdpHit = !!ssdpSt && /print/.test(ssdpSt);
    const wsdHit = !!d.wsdType && /print/i.test(String(d.wsdType));
    const tcpHit = tcp.some((s) => /jetdirect|ipp|printer|pdl/.test(s));
    const usbHit =
      src === 'usb' || src === 'local' ||
      !!(d.cupsName || d.cupsUri || d.usbVendorId || d.usbProductId);
    const httpHit = /print|laserjet|deskjet|inkjet|thermal|epson|canon|brother|xerox|ricoh|lexmark|zebra|star\s*(tsp|sp)/i
      .test(String(d.httpTitle || '') + ' ' + String(d.manufacturer || ''));
    return Boolean(mdnsHit || ssdpHit || wsdHit || tcpHit || usbHit || httpHit);
  }

  // ── 4. Everything else is noise ──
  return false;
}
