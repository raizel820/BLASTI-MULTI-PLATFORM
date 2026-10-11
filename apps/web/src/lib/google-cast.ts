/**
 * Google Cast SDK Loader & Wrapper (REAL Chromecast protocol)
 * ===========================================================
 * Loads the official Google Cast Sender SDK (chrome.cast) from Google's CDN
 * and wraps it so React components can request a real Chromecast session and
 * cast a URL (the BLASTI TV board) to a Chromecast-enabled Smart TV.
 *
 * This is the genuine Google Cast protocol — NOT the Presentation API. It
 * requires Chrome/Edge browser with the Cast extension available, and a
 * Chromecast-built-in TV on the same network.
 *
 * Usage:
 *   const cast = await getCastApi();
 *   if (!cast.available) { /* browser not supported *\/ }
 *   await cast.requestSession();          // shows native device picker
 *   await cast.loadMedia(tvBoardUrl);     // pushes the URL to the TV
 *   await cast.stop();                    // ends the session
 */

// Minimal typings for the Google Cast Sender SDK. The full types live in
// Google's @types/chrome.cast package; we declare the subset we use so the
// project compiles without an extra dependency.

type CastAvailability = 'available' | 'unavailable' | 'loading';

interface CastApi {
  available: boolean;
  reason?: string;
  /** Open the native Chromecast device picker and start a session. */
  requestSession: (mediaUrl: string, title?: string) => Promise<void>;
  /** Load a new media URL into the current session. */
  loadMedia: (mediaUrl: string, title?: string) => Promise<void>;
  /** Pause playback on the current session. */
  pause: () => Promise<void>;
  /** Resume playback on the current session. */
  play: () => Promise<void>;
  /** Stop the current cast session. */
  stop: () => Promise<void>;
  /** Whether a session is currently active. */
  isAlive: () => boolean;
}

declare global {
  interface Window {
    chrome?: any;
    __onGCastApiAvailable?: (available: boolean) => void;
  }
}

let availability: CastAvailability = 'loading';
let resolveAvailability: ((a: CastAvailability) => void) | null = null;
const availabilityPromise = new Promise<CastAvailability>((resolve) => {
  resolveAvailability = resolve;
});

let currentSession: any = null;
let currentMedia: any = null;

/**
 * Inject the Google Cast Sender SDK <script> tag into the document head.
 * The SDK calls `window.__onGCastApiAvailable(true)` once loaded.
 */
function loadCastSdk(): void {
  if (typeof window === 'undefined') return;
  if (document.getElementById('google-cast-sdk')) return;

  // Set up the availability callback BEFORE injecting the script so we don't
  // miss the ready event.
  window.__onGCastApiAvailable = (available: boolean) => {
    availability = available ? 'available' : 'unavailable';
    resolveAvailability?.(availability);
  };

  const script = document.createElement('script');
  script.id = 'google-cast-sdk';
  script.src = 'https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1';
  script.async = true;
  document.head.appendChild(script);

  // If the SDK doesn't signal within 8 seconds, treat as unavailable.
  setTimeout(() => {
    if (availability === 'loading') {
      availability = 'unavailable';
      resolveAvailability?.(availability);
    }
  }, 8000);
}

/**
 * Get the Cast Sender API. On first call, loads the SDK. Returns an object
 * describing whether real Chromecast casting is available and the methods to
 * drive it.
 */
export async function getCastApi(): Promise<CastApi> {
  if (typeof window === 'undefined') {
    return { available: false, reason: 'Server-side rendering', requestSession: async () => {}, loadMedia: async () => {}, pause: async () => {}, play: async () => {}, stop: async () => {}, isAlive: () => false };
  }

  // Only Chrome/Edge expose the Cast SDK. Other browsers report unavailable.
  const isChromium = !!(window.chrome && window.chrome.runtime);
  if (!isChromium) {
    availability = 'unavailable';
    resolveAvailability?.(availability);
    return {
      available: false,
      reason: 'Google Cast requires Chrome or Edge browser.',
      requestSession: async () => {},
      loadMedia: async () => {},
      pause: async () => {},
      play: async () => {},
      stop: async () => {},
      isAlive: () => false,
    };
  }

  if (availability === 'loading') {
    loadCastSdk();
  }
  await availabilityPromise;

  if (availability !== 'available' || !window.chrome?.cast) {
    return {
      available: false,
      reason: 'Google Cast Sender SDK did not load. Install the Google Cast extension in Chrome/Edge.',
      requestSession: async () => {},
      loadMedia: async () => {},
      pause: async () => {},
      play: async () => {},
      stop: async () => {},
      isAlive: () => false,
    };
  }

  return {
    available: true,
    requestSession: castRequestSession,
    loadMedia: castLoadMedia,
    pause: castPause,
    play: castPlay,
    stop: castStop,
    isAlive: () => !!currentSession && currentSession.status === 'connected',
  };
}

// ─── Cast Sender wrappers ───────────────────────────────────────────────────

function ensureContext(): any {
  const cast = window.chrome?.cast;
  if (!cast) throw new Error('Cast SDK not loaded');
  const framework = cast.framework;
  if (!framework) throw new Error('Cast framework not loaded');
  const context = framework.CastContext.getInstance();
  context.setOptions({
    receiverApplicationId: cast.media.DEFAULT_MEDIA_RECEIVER_ID || chrome.cast.media.DEFAULT_MEDIA_RECEIVER_ID,
    autoJoinPolicy: cast.AutoJoinPolicy.ORIGIN_SCOPED,
  });
  // Track the current session so loadMedia/stop/pause/play work without a
  // re-prompt.
  context.addEventListener(framework.CastContextEventType.SESSION_STATE_CHANGED, (event: any) => {
    currentSession = event.session;
  });
  return { context, cast, framework };
}

async function castRequestSession(mediaUrl: string, title?: string): Promise<void> {
  const { context, cast } = ensureContext();
  await context.requestSession();
  currentSession = context.getCurrentSession();
  if (!currentSession) throw new Error('No cast session');
  // Immediately load the media URL into the freshly-created session.
  await castLoadMedia(mediaUrl, title);
}

async function castLoadMedia(mediaUrl: string, title?: string): Promise<void> {
  const { cast } = ensureContext();
  if (!currentSession) throw new Error('No active cast session — call requestSession first');
  const mediaInfo = new cast.media.MediaInfo(mediaUrl, 'text/html');
  if (title) mediaInfo.metadata = new cast.media.GenericMediaMetadata();
  if (title && mediaInfo.metadata) mediaInfo.metadata.title = title;
  const request = new cast.media.LoadRequest(mediaInfo);
  await currentSession.loadMedia(request);
  currentMedia = currentSession.getMediaSession?.() || null;
}

async function castPause(): Promise<void> {
  if (!currentMedia) throw new Error('No active media');
  const { cast } = ensureContext();
  await new Promise<void>((resolve, reject) => {
    currentMedia.pause(null, resolve, reject);
  });
}

async function castPlay(): Promise<void> {
  if (!currentMedia) throw new Error('No active media');
  const { cast } = ensureContext();
  await new Promise<void>((resolve, reject) => {
    currentMedia.play(null, resolve, reject);
  });
}

async function castStop(): Promise<void> {
  if (!currentSession) return;
  await new Promise<void>((resolve) => {
    try {
      currentSession.stop(resolve, () => resolve());
    } catch {
      resolve();
    }
  });
  currentSession = null;
  currentMedia = null;
}

// ─── Screen mirroring via WebRTC getDisplayMedia + Cast ─────────────────────

/**
 * Capture the user's screen (or a window/tab) using the WebRTC
 * `getDisplayMedia()` API and return a MediaStream. The caller can then
 * render this stream into a <video> element and cast that element via the
 * Google Cast SDK (`castSession.loadMedia` with a MediaStreamSource).
 *
 * For DLNA-based mirroring (non-Chromecast TVs), the stream is uploaded to
 * the backend screen-mirror endpoint which hosts an MJPEG stream that the TV
 * renders via DLNA.
 */
export async function captureScreen(): Promise<MediaStream | null> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getDisplayMedia) {
    return null;
  }
  try {
    return await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 10 } as MediaTrackConstraints,
      audio: false,
    });
  } catch {
    return null;
  }
}

export {};
