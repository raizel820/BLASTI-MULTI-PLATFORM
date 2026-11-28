/**
 * BLASTI — tiny trailing debounce helper.
 *
 * 0.6.127 realtime round: one queue event used to trigger an immediate full
 * refetch on every mounted surface; a staff action emits 2-3 events (and a
 * bulk operation N), so a room full of screens × 3 requests per event
 * hammered the API into the shared-IP rate limit exactly at peak. A trailing
 * debounce collapses each burst into ONE fetch while keeping instant feel
 * (300ms is well below the old 10s poll cadence).
 */

export interface DebouncedFunction<T extends (...args: never[]) => void> {
  (...args: Parameters<T>): void
  /** Run the pending call immediately (if any) and return. */
  flush(): void
  /** Drop the pending call (if any). */
  cancel(): void
}

export function debounceTrailing<T extends (...args: never[]) => void>(
  fn: T,
  waitMs: number,
): DebouncedFunction<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  let pendingArgs: Parameters<T> | null = null

  const wrapped = (...args: Parameters<T>) => {
    pendingArgs = args
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      const callArgs = pendingArgs
      pendingArgs = null
      if (callArgs) fn(...callArgs)
    }, waitMs)
  }

  wrapped.flush = () => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    const callArgs = pendingArgs
    pendingArgs = null
    if (callArgs) fn(...callArgs)
  }

  wrapped.cancel = () => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    pendingArgs = null
  }

  return wrapped as DebouncedFunction<T>
}
