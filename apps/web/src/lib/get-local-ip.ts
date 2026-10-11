/**
 * Detects the local IP address of the device using WebRTC.
 * This is the IP that other devices on the same LAN can use to reach this device.
 *
 * Note: Modern browsers may mangle the local IP (e.g., show 0.0.0.x) in
 * certain privacy modes. In such cases the function returns null.
 */

let cachedIp: string | null = null;
let cacheTimestamp = 0;
const CACHE_TTL = 60_000; // 1 minute

export async function getLocalIp(): Promise<string | null> {
  // Return cached value if fresh
  if (cachedIp && Date.now() - cacheTimestamp < CACHE_TTL) {
    return cachedIp;
  }

  // Not available outside the browser
  if (typeof window === 'undefined' || !window.RTCPeerConnection) {
    return null;
  }

  try {
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    });

    pc.createDataChannel('');

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    return new Promise<string | null>((resolve) => {
      const timeout = setTimeout(() => {
        pc.close();
        resolve(cachedIp); // return previous cache if available
      }, 3000);

      pc.onicecandidate = (event) => {
        if (!event.candidate) {
          // ICE gathering complete, no local candidate found
          clearTimeout(timeout);
          pc.close();
          resolve(cachedIp);
          return;
        }

        const candidate = event.candidate.candidate;
        // Look for a local IPv4 address in the candidate string
        // Format: "candidate:... typ host ... <ip> <port>"
        const match = candidate.match(
          /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/
        );

        if (match) {
          const ip = match[1];
          // Skip loopback and link-local
          if (ip !== '0.0.0.0' && !ip.startsWith('127.') && !ip.startsWith('169.254.')) {
            clearTimeout(timeout);
            pc.close();
            cachedIp = ip;
            cacheTimestamp = Date.now();
            resolve(ip);
          }
        }
      };
    });
  } catch {
    // WebRTC may be blocked
    return cachedIp;
  }
}

/**
 * Synchronously returns the cached IP (if any), without triggering a new detection.
 */
export function getCachedLocalIp(): string | null {
  if (cachedIp && Date.now() - cacheTimestamp < CACHE_TTL) {
    return cachedIp;
  }
  return null;
}