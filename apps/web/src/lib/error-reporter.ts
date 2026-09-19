/**
 * BLASTI Global Renderer Error Reporter
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY (field round 7): the user reported "Cannot read properties of null
 * (reading 'split')" appearing when the cloud API is shut down — but with no
 * stack trace it is undiscoverable among hundreds of `.split` call sites in
 * the renderer. Standing directive: "add details to console log to help with
 * isolating the errors" and "never hide a failure".
 *
 * This module installs:
 *   1. window 'error' + 'unhandledrejection' listeners that log the FULL
 *      stack to the console with a searchable [RendererError] prefix.
 *   2. An optional IPC forward to the Electron main process
 *      (electronAPI.reportRendererError) so uncaught renderer crashes appear
 *      in the SAME terminal that runs `bun run electron:dev` — no DevTools
 *      required.
 *
 * It never swallows errors: handlers run passively alongside default logging.
 */

let _installed = false

export interface RendererErrorPayload {
  message: string
  stack?: string
  source?: string
  line?: number
  column?: number
  kind: 'error' | 'unhandledrejection'
  at: string
  userAgent?: string
  href?: string
}

function forwardToMain(payload: RendererErrorPayload): void {
  try {
    const w = window as any
    if (w.electronAPI?.reportRendererError) {
      w.electronAPI.reportRendererError(payload)
    }
  } catch { /* IPC bridge unavailable — console logging already covered it */ }
}

function logPayload(prefix: string, payload: RendererErrorPayload): void {
  // One greppable line + the full stack underneath.
  console.error(
    `[RendererError] ${prefix}: ${payload.message}` +
      (payload.source ? ` (${payload.source}:${payload.line ?? '?'}:${payload.column ?? '?'})` : ''),
  )
  if (payload.stack) console.error(`[RendererError] stack:\n${payload.stack}`)
  forwardToMain(payload)
}

export function installGlobalErrorReporter(): void {
  if (_installed || typeof window === 'undefined') return
  _installed = true

  window.addEventListener('error', (event) => {
    // Resource-load errors (script/img) have no error object worth a stack.
    const err = event.error
    logPayload('uncaught', {
      kind: 'error',
      message: (err && err.message) || event.message || String(event.error ?? 'unknown error'),
      stack: err && err.stack ? String(err.stack) : undefined,
      source: event.filename || undefined,
      line: event.lineno || undefined,
      column: event.colno || undefined,
      at: new Date().toISOString(),
      userAgent: navigator.userAgent,
      href: window.location.href,
    })
    // Do NOT preventDefault — default console behavior remains.
  })

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason
    const isObj = reason && typeof reason === 'object'
    logPayload('unhandled-rejection', {
      kind: 'unhandledrejection',
      message: (isObj && (reason as Error).message) || String(reason),
      stack: isObj && (reason as Error).stack ? String((reason as Error).stack) : undefined,
      at: new Date().toISOString(),
      userAgent: navigator.userAgent,
      href: window.location.href,
    })
  })

  console.log('[RendererError] Global error reporter installed (uncaught errors will surface in the Electron terminal)')
}

/**
 * Report a CAUGHT error (React error boundaries, try/catch in critical
 * flows) through the same pipeline — full stack into the console + the
 * Electron main terminal.
 */
export function reportCaughtError(error: unknown, context?: string): void {
  const err = error instanceof Error ? error : null
  logPayload(context ? `caught (${context})` : 'caught', {
    kind: 'error',
    message: (err && err.message) || String(error),
    stack: err && err.stack ? String(err.stack) : undefined,
    at: new Date().toISOString(),
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
    href: typeof window !== 'undefined' ? window.location.href : undefined,
  })
}

// Self-install on first import in a browser context (client components).
if (typeof window !== 'undefined') {
  try { installGlobalErrorReporter() } catch { /* never break startup on the reporter */ }
}
