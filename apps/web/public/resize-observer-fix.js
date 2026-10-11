/**
 * BLASTI ResizeObserver loop fix — loaded as early as possible via
 * <Script strategy="beforeInteractive" src="/resize-observer-fix.js" />
 * in src/app/layout.tsx, i.e. BEFORE any Next.js code, hydration, or chart
 * component is mounted.
 *
 * Problem (user-reported at #/admin/analytics):
 *   "[RendererError] uncaught: ResizeObserver loop completed with undelivered
 *   notifications." — recharts <ResponsiveContainer> observes its own wrapper
 *   and, during the ResizeObserver delivery pass, re-renders the chart at the
 *   measured size. That synchronous layout change makes the browser observe
 *   more resizes in the same delivery pass; when the iteration budget runs
 *   out, Chrome reports the (benign but noisy) "ResizeObserver loop" error.
 *   The admin analytics screen mounts ~6 ResponsiveContainers simultaneously
 *   (skeleton → ready swap), which makes the cascade practically guaranteed.
 *
 * Fix — two independent layers:
 *
 * 1. SOURCE FIX: wrap window.ResizeObserver so observer callbacks are
 *    deferred to the next animation frame. During the browser's ResizeObserver
 *    delivery pass our callbacks no longer mutate layout, so no same-pass
 *    cascade can occur → the error is never generated. Timing difference is
 *    one frame (~16 ms), imperceptible for chart resizing. Applies to every
 *    library observer created after this script runs (recharts, shadcn, ...).
 *
 * 2. SUPPRESSION BACKSTOP: a window "error" listener that swallows ONLY the
 *    two known benign ResizeObserver loop messages before they reach the
 *    Next.js dev overlay / preview error reporter. Real errors are untouched.
 */
(function () {
  'use strict';
  if (typeof window === 'undefined') return;

  var LOOP_MESSAGES = [
    'ResizeObserver loop completed with undelivered notifications.',
    'ResizeObserver loop limit exceeded',
  ];

  function isLoopError(message) {
    if (!message || typeof message !== 'string') return false;
    for (var i = 0; i < LOOP_MESSAGES.length; i++) {
      if (message.indexOf(LOOP_MESSAGES[i]) !== -1) return true;
    }
    return false;
  }

  // ── Layer 2: suppress the benign notification ────────────────────────────
  window.addEventListener('error', function (event) {
    if (event && isLoopError(event.message)) {
      // Block later-registered listeners (Next dev overlay, preview reporter)
      // and the browser's native "Uncaught ..." console logging.
      try {
        event.stopImmediatePropagation();
        if (typeof event.preventDefault === 'function') event.preventDefault();
      } catch (e) { /* never break the page from an error handler */ }
    }
  });

  // ── Layer 1: break the feedback loop at the source ───────────────────────
  var NativeResizeObserver = window.ResizeObserver;
  if (!NativeResizeObserver || NativeResizeObserver.__blastiRafDebounced) return;

  function scheduleFlush(fn) {
    // rAF keeps the flush tight on visible tabs; when the tab is hidden rAF
    // never fires, so fall back to a timeout so charts still settle.
    if (typeof requestAnimationFrame === 'function' && !document.hidden) {
      return { id: requestAnimationFrame(fn), raf: true };
    }
    return { id: setTimeout(fn, 16), raf: false };
  }

  function cancelScheduled(scheduled) {
    if (!scheduled) return;
    try {
      if (scheduled.raf && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(scheduled.id);
      } else {
        clearTimeout(scheduled.id);
      }
    } catch (e) { /* ignore */ }
  }

  function BlastiResizeObserver(callback, options) {
    if (typeof callback !== 'function') {
      // Let the native constructor produce its own TypeError semantics.
      return new NativeResizeObserver(callback, options);
    }

    var pendingEntries = null;
    var pendingObserver = null;
    var scheduled = null;

    var flush = function () {
      scheduled = null;
      var entries = pendingEntries;
      var observer = pendingObserver;
      pendingEntries = null;
      pendingObserver = null;
      if (entries && entries.length > 0) {
        callback(entries, observer);
      }
    };

    var native = new NativeResizeObserver(function (entries, observer) {
      // Coalesce: keep only the freshest batch; one flush per frame.
      pendingEntries = entries;
      pendingObserver = observer;
      if (!scheduled) scheduled = scheduleFlush(flush);
    }, options);

    this.observe = function (target, opts) {
      native.observe(target, opts);
    };
    this.unobserve = function (target) {
      native.unobserve(target);
    };
    this.disconnect = function () {
      cancelScheduled(scheduled);
      scheduled = null;
      pendingEntries = null;
      pendingObserver = null;
      native.disconnect();
    };
  }

  try {
    Object.defineProperty(BlastiResizeObserver, 'name', { value: 'ResizeObserver' });
  } catch (e) { /* non-critical cosmetics */ }
  BlastiResizeObserver.prototype.toString = function () {
    return 'function ResizeObserver() { [native code] }';
  };
  BlastiResizeObserver.__blastiRafDebounced = true;
  if (Object.setPrototypeOf) {
    Object.setPrototypeOf(BlastiResizeObserver, NativeResizeObserver);
  }
  window.ResizeObserver = BlastiResizeObserver;
})();
