/**
 * Google Maps provider (Task 51-b, spec §5).
 *
 * Loads the Google Maps JS API dynamically via script injection — there is
 * intentionally NO npm dependency for Google: the JS API only ships runtime
 * key handling and BLASTI must not pay its bundle cost unless the Super Admin
 * actually selects the GOOGLE provider (spec §9-11).
 *
 * Uses the CLASSIC `google.maps.Marker` (draggable) instead of
 * AdvancedMarkerElement: the classic marker works on every Google API key
 * without requiring the Map IDs / `marker` library that Advanced markers
 * need, and keeps the "graceful onError" path simple.
 *
 * Everything is SSR-safe: the loader refuses to run without `window`.
 */
import type { LatLng, MapInitOptions, MapProviderId, MapProviderInstance } from './types';

/** Window shape while the Google Maps JS API is loading. */
interface GoogleMapsWindow {
  google?: {
    maps?: {
      Map: new (el: HTMLElement, opts: unknown) => GoogleMapLike;
      Marker: new (opts: unknown) => GoogleMarkerLike;
      InfoWindow: new (opts: unknown) => GoogleInfoWindowLike;
      event: GoogleMapsEventNamespace;
    };
  };
}

interface GoogleMapsEventNamespace {
  addListener(target: unknown, event: string, cb: (...args: unknown[]) => void): unknown;
  addListenerOnce(target: unknown, event: string, cb: (...args: unknown[]) => void): void;
  removeListener(listener: unknown): void;
  clearInstanceListeners(target: unknown): void;
}

interface GoogleMapLike {
  setCenter(ll: { lat: number; lng: number }): void;
  setZoom(z: number): void;
  addListener(event: string, cb: (...args: unknown[]) => void): unknown;
}

interface GoogleMarkerLike {
  setPosition(ll: { lat: number; lng: number }): void;
  getPosition(): { lat(): number; lng(): number } | null;
  setMap(map: GoogleMapLike | null): void;
  addListener(event: string, cb: (...args: unknown[]) => void): unknown;
}

interface GoogleInfoWindowLike {
  open(opts: { anchor?: GoogleMarkerLike; map?: GoogleMapLike }): void;
  close(): void;
  setContent(content: string): void;
}

/** Module-level loader state: one script tag per API key per page. */
let googleLoaderPromise: Promise<NonNullable<GoogleMapsWindow['google']>> | null = null;
let googleLoaderKey: string | null = null;

/**
 * Google calls `window.gm_authFailure()` when the key is rejected (invalid,
 * billing disabled, referrer/http-restriction mismatch). Without capturing
 * this the map renders a grey/white canvas forever while the script itself
 * "loads fine" — the exact field report. Module-level because the callback
 * is global and provider instances come and go.
 */
let googleAuthFailed = false;

/** How long the first `tilesloaded` gets to arrive before init declares the map dead. */
const GOOGLE_TILES_TIMEOUT_MS = 10_000;

/**
 * Inject (or reuse) the Google Maps JS API script.
 * Rejects when the script fails to load (offline, blocked, invalid referrer).
 */
export function loadGoogleMaps(apiKey: string): Promise<NonNullable<GoogleMapsWindow['google']>> {
  if (typeof window === 'undefined') {
    return Promise.reject(new Error('GOOGLE_MAPS_REQUIRES_BROWSER'));
  }

  // An API key change must re-inject (different quota/referrer restrictions).
  if (googleLoaderPromise && googleLoaderKey === apiKey) return googleLoaderPromise;
  googleLoaderKey = apiKey;
  googleAuthFailed = false; // fresh attempt with this key
  googleLoaderPromise = new Promise((resolve, reject) => {
    const w = window as unknown as GoogleMapsWindow;

    // Capture Google's global auth-failure signal (called asynchronously when
    // a Map is constructed with an unusable key).
    (w as unknown as { gm_authFailure?: () => void }).gm_authFailure = () => {
      googleAuthFailed = true;
    };

    // Already loaded (e.g. another BLASTI surface loaded it first).
    if (w.google?.maps) {
      resolve(w.google as NonNullable<GoogleMapsWindow['google']>);
      return;
    }

    const script = document.createElement('script');
    // Classic Marker + InfoWindow need no extra libraries → smallest payload.
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey)}&v=weekly&language=en`;
    script.async = true;
    script.defer = true;
    script.onerror = () => {
      // Allow a later retry with a fresh tag (transient network failure).
      if (googleLoaderKey === apiKey) {
        googleLoaderPromise = null;
        googleLoaderKey = null;
      }
      script.remove();
      reject(new Error('GOOGLE_MAPS_SCRIPT_FAILED'));
    };
    script.onload = () => {
      if (w.google?.maps) {
        resolve(w.google as NonNullable<GoogleMapsWindow['google']>);
      } else {
        script.remove();
        reject(new Error('GOOGLE_MAPS_SCRIPT_LOADED_WITHOUT_MAPS'));
      }
    };
    document.head.appendChild(script);
  });
  return googleLoaderPromise;
}

/** Create a Google Maps-backed `MapProviderInstance`. */
export function createGoogleMapsProvider(opts: { apiKey: string | null }): MapProviderInstance {
  let map: GoogleMapLike | null = null;
  let marker: GoogleMarkerLike | null = null;
  let infoWindow: GoogleInfoWindowLike | null = null;
  const listeners: unknown[] = [];
  let clickCb: ((ll: LatLng) => void) | null = null;
  let markerMoveCb: ((ll: LatLng) => void) | null = null;
  let destroyed = false;

  const getMaps = (): NonNullable<GoogleMapsWindow['google']>['maps'] | null => {
    if (typeof window === 'undefined') return null;
    return (window as unknown as GoogleMapsWindow).google?.maps ?? null;
  };

  const ensureMarker = (ll: LatLng): GoogleMarkerLike | null => {
    const maps = getMaps();
    if (marker || !maps) return marker;
    marker = new maps.Marker({
      position: { lat: ll.lat, lng: ll.lng },
      map,
      draggable: true,
      title: 'BLASTI',
    });
    listeners.push(
      marker.addListener('dragend', () => {
        const pos = marker?.getPosition();
        if (pos && markerMoveCb) markerMoveCb({ lat: pos.lat(), lng: pos.lng() });
      }),
    );
    return marker;
  };

  return {
    provider: 'GOOGLE' as MapProviderId,

    async init(container: HTMLElement, initOpts?: MapInitOptions): Promise<void> {
      if (destroyed) throw new Error('GOOGLE_PROVIDER_DESTROYED');
      if (typeof window === 'undefined') throw new Error('GOOGLE_MAPS_REQUIRES_BROWSER');
      if (!opts.apiKey) throw new Error('GOOGLE_MAPS_API_KEY_MISSING');
      const w = await loadGoogleMaps(opts.apiKey);
      if (destroyed) return; // unmounted while the script was downloading
      const maps = w.maps;
      if (!maps?.Map || !maps?.event) throw new Error('GOOGLE_MAPS_INCOMPLETE');

      map = new maps.Map(container, {
        center: {
          lat: initOpts?.center?.lat ?? 28.0339,
          lng: initOpts?.center?.lng ?? 1.6596,
        },
        zoom: initOpts?.zoom ?? 5,
        // Keep the surface clean — BLASTI renders its own controls.
        mapTypeControl: false,
        streetViewControl: false,
        fullscreenControl: false,
        clickableIcons: false,
      });

      // Verify the map actually RENDERS tiles before reporting success.
      // A rejected key (invalid / billing disabled / referrer restriction)
      // constructs the Map fine and then paints a dead grey canvas — the
      // script itself loads OK, so without this watchdog the UI showed a
      // pin over an empty map forever. Rejecting routes init into the
      // provider fallback chain (lib/map index.ts) → OpenFreeMap renders.
      await new Promise<void>((resolve, reject) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          clearInterval(poll);
          resolve();
        };
        const fail = (reason: string) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          clearInterval(poll);
          reject(new Error(reason));
        };
        const timer = setTimeout(
          () => fail(googleAuthFailed ? 'GOOGLE_MAPS_AUTH_FAILED' : 'GOOGLE_MAPS_TILES_TIMEOUT'),
          GOOGLE_TILES_TIMEOUT_MS,
        );
        // gm_authFailure may fire well before tiles — poll for a fast fail.
        const poll = setInterval(() => {
          if (googleAuthFailed) fail('GOOGLE_MAPS_AUTH_FAILED');
        }, 250);
        maps.event.addListenerOnce(map, 'tilesloaded', () => finish());
      });

      listeners.push(
        maps.event.addListener(map, 'click', (e: unknown) => {
          const mouseEvent = e as { latLng?: { lat(): number; lng(): number } };
          const ll = mouseEvent.latLng;
          if (ll && clickCb) clickCb({ lat: ll.lat(), lng: ll.lng() });
        }),
      );
    },

    setCenter(ll: LatLng): void {
      map?.setCenter({ lat: ll.lat, lng: ll.lng });
    },

    setZoom(zoom: number): void {
      map?.setZoom(zoom);
    },

    placeMarker(ll: LatLng): void {
      ensureMarker(ll);
    },

    moveMarker(ll: LatLng): void {
      const m = ensureMarker(ll);
      m?.setPosition({ lat: ll.lat, lng: ll.lng });
    },

    onMapClick(cb: (ll: LatLng) => void): void {
      clickCb = cb;
    },

    onMarkerMove(cb: (ll: LatLng) => void): void {
      markerMoveCb = cb;
    },

    getCoordinates(): LatLng | null {
      const pos = marker?.getPosition();
      return pos ? { lat: pos.lat(), lng: pos.lng() } : null;
    },

    showMarkerInfo(title: string, description?: string): void {
      const maps = getMaps();
      if (!map || !marker || destroyed || !maps) return;
      if (!infoWindow) infoWindow = new maps.InfoWindow({});
      const safe = (s: string) =>
        s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] ?? c));
      infoWindow.setContent(
        `<div style="max-width:220px;font-family:inherit"><div style="font-weight:600">${safe(title)}</div>${description ? `<div style="font-size:12px;color:#4b5563">${safe(description)}</div>` : ''}</div>`,
      );
      infoWindow.open({ map, anchor: marker });
    },

    destroy(): void {
      destroyed = true;
      const maps = getMaps();
      for (const l of listeners) maps?.event?.removeListener(l);
      listeners.length = 0;
      infoWindow?.close();
      infoWindow = null;
      marker?.setMap(null);
      marker = null;
      map = null;
      clickCb = null;
      markerMoveCb = null;
    },
  };
}
