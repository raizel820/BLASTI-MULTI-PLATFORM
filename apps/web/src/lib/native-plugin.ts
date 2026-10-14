/**
 * BLASTI native plugin accessor — THE single Capacitor-bridge probe.
 *
 * WHY THIS EXISTS (the "settings always shows 1.0.0" + "phones never report
 * telemetry" bug): the Capacitor ANDROID bridge does NOT expose a
 * `Capacitor.getPlugins(name)` function — that method exists nowhere in the
 * injected surface. What the native side ACTUALLY injects (verified against
 * @capacitor/android 8 `JSExport.getPluginJS`):
 *
 *     window.Capacitor = { DEBUG, isLoggingEnabled, Plugins: {} };
 *     // …then, for EVERY registered native plugin (App, Device, Camera, …):
 *     window.Capacitor.Plugins['Device'] = {
 *       addListener: (evt, cb) => w.Capacitor.addListener('Device', evt, cb),
 *       getInfo: (opts) => w.Capacitor.nativePromise('Device', 'getInfo', opts),
 *       // …one exported method per @CapacitorMethod — Promise-returning.
 *     };
 *
 * So the only reliable probe path is `Capacitor.Plugins[name]`; `getPlugin`
 * (singular) and `getPlugins` (the old broken guess) are kept as defensive
 * fallbacks for exotic shells.
 *
 * Zero @capacitor imports — @capacitor/* is not a dependency of apps/web.
 */

interface CapacitorGlobalShape {
  /** Canonical Capacitor 3–8 surface: one entry per registered native plugin. */
  Plugins?: Record<string, unknown>;
  /** Rare/defensive: some shells expose a singular accessor. */
  getPlugin?: (name: string) => unknown;
  /** The broken guess older code made — kept ONLY as a last-resort fallback. */
  getPlugins?: (name: string) => unknown;
}

export type NativePlugin = Record<string, ((...args: unknown[]) => unknown) | undefined>;

/**
 * Resolve a native plugin object from the injected Capacitor bridge.
 * Returns null outside the browser / outside a native shell / when the
 * plugin is not registered. NEVER throws.
 */
export function getNativePlugin(name: string): NativePlugin | null {
  if (typeof window === 'undefined') return null;
  try {
    const cap = (window as unknown as { Capacitor?: CapacitorGlobalShape }).Capacitor;
    if (!cap) return null;
    // 1. The real Capacitor 3–8 surface (Android JSExport.getPluginJS).
    const direct = cap.Plugins?.[name];
    if (direct && typeof direct === 'object') return direct as NativePlugin;
    // 2. Defensive singular accessor.
    if (typeof cap.getPlugin === 'function') {
      const viaGetPlugin = cap.getPlugin(name);
      if (viaGetPlugin && typeof viaGetPlugin === 'object') return viaGetPlugin as NativePlugin;
    }
    // 3. Last-resort legacy shape (was never real — harmless to try).
    if (typeof cap.getPlugins === 'function') {
      const viaGetPlugins = cap.getPlugins(name);
      if (viaGetPlugins && typeof viaGetPlugins === 'object') return viaGetPlugins as NativePlugin;
    }
  } catch {
    // Bridge missing or hostile — callers keep their fallbacks.
  }
  return null;
}
