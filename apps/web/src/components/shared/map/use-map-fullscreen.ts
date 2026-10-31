'use client';

/**
 * useMapFullscreen — r27: map fullscreen that actually covers the viewport.
 *
 * r26 promoted the SAME map node to `position:fixed; inset:0` — browser-
 * verified broken on real pages: the `.blasti-view-enter` page wrapper keeps
 * a computed `transform` after its 0.2s entrance animation, and ANY
 * transformed ancestor becomes the CONTAINING BLOCK for fixed descendants —
 * the "fullscreen" map opened pinned to that ancestor (measured top
 * -1244px, far above the viewport) instead of covering the screen.
 *
 * Primary path: the native Fullscreen API (`requestFullscreen`) — the element
 * is promoted to the browser TOP LAYER, escaping every containing block,
 * RTL-irrelevant, with Escape/F11 handled natively (synced via
 * `fullscreenchange`).
 *
 * Fallback path (iOS iPhone Safari has no Element.requestFullscreen, or the
 * call is rejected): the r26 CSS promotion, paired with the `blasti-fs-open`
 * root class that neutralizes ancestor transforms while open (globals.css).
 */
import { useCallback, useEffect, useRef, useState } from 'react';

export function useMapFullscreen() {
  const [fullscreen, setFullscreen] = useState(false);
  const fallbackRef = useRef(false);

  const clearFallbackClass = useCallback(() => {
    if (typeof document !== 'undefined') {
      document.documentElement.classList.remove('blasti-fs-open');
    }
  }, []);

  // Native path state sync — covers Escape, browser UI exits and programmatic
  // exits. The CSS fallback path manages its own state and is ignored here.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const onChange = () => {
      if (fallbackRef.current) return;
      if (document.fullscreenElement) {
        setFullscreen(true);
      } else {
        setFullscreen(false);
        clearFallbackClass();
      }
    };
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, [clearFallbackClass]);

  // Escape closes BOTH paths (native browsers also fire fullscreenchange;
  // the sync above keeps the state honest — this listener just guarantees
  // the fallback path behaves the same way).
  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') void exitRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fullscreen]);

  const exitRef = useRef<() => Promise<void>>(async () => {});

  const enter = useCallback(async (node: HTMLElement | null) => {
    if (!node) return;
    if (typeof node.requestFullscreen === 'function') {
      try {
        await node.requestFullscreen();
        fallbackRef.current = false;
        setFullscreen(true);
        return;
      } catch {
        // Rejected (permissions policy / iframe) → CSS fallback below.
      }
    }
    fallbackRef.current = true;
    document.documentElement.classList.add('blasti-fs-open');
    setFullscreen(true);
  }, []);

  const exit = useCallback(async () => {
    if (typeof document !== 'undefined' && document.fullscreenElement) {
      try {
        await document.exitFullscreen();
      } catch {
        // Ignore — the state sync below still runs.
      }
    }
    fallbackRef.current = false;
    clearFallbackClass();
    setFullscreen(false);
  }, [clearFallbackClass]);

  useEffect(() => {
    exitRef.current = exit;
  }, [exit]);

  const toggle = useCallback(
    (node: HTMLElement | null) => {
      if (fullscreen) void exit();
      else void enter(node);
    },
    [fullscreen, enter, exit],
  );

  return { fullscreen, enter, exit, toggle };
}
