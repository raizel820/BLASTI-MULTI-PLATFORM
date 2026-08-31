'use client'

import { useSyncExternalStore } from 'react'

function subscribe(callback: () => void) {
  window.addEventListener('online', callback)
  window.addEventListener('offline', callback)
  return () => {
    window.removeEventListener('online', callback)
    window.removeEventListener('offline', callback)
  }
}

function getSnapshot() {
  return navigator.onLine
}

function getServerSnapshot() {
  // On the server, always return true to prevent hydration mismatch
  return true
}

/**
 * Phase 6c: SSR-safe online status hook using useSyncExternalStore.
 * Returns true on server (prevents hydration mismatch) and
 * the actual navigator.onLine value on client.
 */
export function useOnlineStatus(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}
