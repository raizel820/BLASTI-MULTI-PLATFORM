'use client'

/**
 * MobileBackExitHint — web-side counterpart of the Capacitor backButton
 * handler (apps/mobile/src/setup.ts).
 *
 * When the Android hardware/touch back button is pressed at the app root,
 * the native layer dispatches `blasti:back-press-exit-hint`; this component
 * surfaces the "press back again to exit" toast. A second press within the
 * 2s window calls App.exitApp() natively.
 */
import { useEffect } from 'react'
import { toast } from 'sonner'

const EXIT_HINT_EVENT = 'blasti:back-press-exit-hint'

export function MobileBackExitHint() {
  useEffect(() => {
    if (typeof window === 'undefined') return
    const handler = () => {
      toast('Press back again to exit', {
        description: 'Tap the back button once more to close the app.',
        duration: 2000,
      })
    }
    window.addEventListener(EXIT_HINT_EVENT, handler)
    return () => window.removeEventListener(EXIT_HINT_EVENT, handler)
  }, [])

  return null
}
