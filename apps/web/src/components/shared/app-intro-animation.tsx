'use client';

/**
 * BLASTI app intro animation — plays inside the Capacitor mobile shell on
 * app launch (once per app session). Web/desktop boots skip it entirely so
 * the browser preview is unaffected; append `?intro=1` to preview it.
 *
 * Story (matches the brand): the ORIGINAL BLASTI logo — the teal waiting
 * bench + orange "your turn" dot on its white tile, exactly as designed,
 * no redrawn geometry — springs in, the dot pings a "ticket called" ripple,
 * the wordmark lands, and the curtain lifts into the app. The artwork is the
 * very same file the launcher icon and native splash show, so the launch
 * flow reads as one continuous identity.
 */

import { useEffect, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';

const INTRO_KEY = 'blasti-intro-played';
/** The original artwork, tile-fill framing (matches the launcher icon file). */
const LOGO_SRC = '/blasti-app-icon.png';
/** Orange dot centroid inside LOGO_SRC (measured from the artwork itself). */
const DOT_X = '50.56%';
const DOT_Y = '78.24%';

/** Main scene length before the fade-out begins (ms). */
const SCENE_MS = 2750;
/** Reduced-motion scene length (static card, quick fade). */
const REDUCED_MS = 900;

export function AppIntroAnimation() {
  const [visible, setVisible] = useState(false);
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    if (typeof window === 'undefined') return;

    // Native shell only — unless explicitly previewed via ?intro=1
    const params = new URLSearchParams(window.location.search);
    const forced = params.get('intro') === '1';
    const isCapacitor = !!(window as unknown as Record<string, unknown>).Capacitor;
    if (!isCapacitor && !forced) return;

    // Once per app launch (sessionStorage survives route reloads, not app kills)
    if (!forced) {
      try {
        if (window.sessionStorage.getItem(INTRO_KEY)) return;
        window.sessionStorage.setItem(INTRO_KEY, '1');
      } catch {
        // storage unavailable — still play, it is a launch-only overlay
      }
    }

    setVisible(true);
    const total = reduceMotion ? REDUCED_MS : SCENE_MS;
    const timer = window.setTimeout(() => setVisible(false), total);
    return () => window.clearTimeout(timer);
  }, [reduceMotion]);

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          key="blasti-intro"
          aria-hidden="true"
          className="fixed inset-0 z-[9999] flex select-none flex-col items-center justify-center overflow-hidden"
          style={{
            background:
              'radial-gradient(120% 90% at 50% 42%, #ffffff 0%, #f0fdf4 55%, #d1fae5 100%)',
          }}
          initial={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: reduceMotion ? 0.35 : 0.55, ease: 'easeInOut' }}
        >
          <OriginalLogoScene reduceMotion={!!reduceMotion} />

          {/* Wordmark */}
          <motion.div
            className="mt-8 flex flex-col items-center"
            initial="hidden"
            animate="shown"
            variants={reduceMotion ? undefined : {
              hidden: {},
              shown: { transition: { staggerChildren: 0.055, delayChildren: 1.55 } },
            }}
          >
            <div className="flex" dir="ltr">
              {'BLASTI'.split('').map((ch, i) => (
                <motion.span
                  key={`${ch}-${i}`}
                  className="text-4xl font-extrabold tracking-[0.18em] text-emerald-900 sm:text-5xl"
                  variants={
                    reduceMotion
                      ? undefined
                      : { hidden: { opacity: 0, y: 22 }, shown: { opacity: 1, y: 0 } }
                  }
                  transition={reduceMotion ? undefined : { type: 'spring', stiffness: 320, damping: 22 }}
                >
                  {ch}
                </motion.span>
              ))}
            </div>
            <motion.p
              className="mt-2 text-lg font-medium text-emerald-700/90"
              initial={reduceMotion ? undefined : { opacity: 0, y: 10 }}
              animate={reduceMotion ? undefined : { opacity: 1, y: 0 }}
              transition={reduceMotion ? undefined : { delay: 2.0, duration: 0.4 }}
            >
              بلاصتي
            </motion.p>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/**
 * The original logo, animated as one piece — no re-drawn geometry. It
 * springs in, the painted-in orange dot pings ripples, a soft ground
 * shadow grounds it. Ripples are anchored to the dot's measured centroid
 * so they read as part of the artwork.
 */
function OriginalLogoScene({ reduceMotion }: { reduceMotion: boolean }) {
  const spring = { type: 'spring' as const, stiffness: 240, damping: 19 };

  const logo = (
    <div className="relative h-56 w-56 sm:h-64 sm:w-64">
      {/* soft ground shadow under the tile */}
      {!reduceMotion && (
        <motion.div
          className="absolute -bottom-5 left-1/2 h-4 w-44 -translate-x-1/2 rounded-[100%] bg-emerald-900/20 blur-md"
          initial={{ opacity: 0, scaleX: 0.4 }}
          animate={{ opacity: 1, scaleX: 1 }}
          transition={{ delay: 0.55, duration: 0.45, ease: 'easeOut' }}
        />
      )}

      {/* the original artwork itself */}
      <motion.img
        src={LOGO_SRC}
        alt=""
        draggable={false}
        className="h-full w-full object-contain drop-shadow-xl"
        initial={reduceMotion ? undefined : { opacity: 0, scale: 0.55, y: -44, rotate: -5 }}
        animate={reduceMotion ? undefined : { opacity: 1, scale: 1, y: 0, rotate: 0 }}
        transition={reduceMotion ? undefined : spring}
      />

      {/* ripples from the painted orange dot — "ticket called" ping */}
      {!reduceMotion && (
        <div
          className="pointer-events-none absolute"
          style={{ left: DOT_X, top: DOT_Y, width: 0, height: 0 }}
        >
          {[0, 0.35].map((lag) => (
            <motion.span
              key={`ripple-${lag}`}
              className="absolute block rounded-full border-[3px] border-orange-500"
              style={{ width: 40, height: 40, left: -20, top: -20 }}
              initial={{ scale: 0.9, opacity: 0.7 }}
              animate={{ scale: 2.4, opacity: 0 }}
              transition={{ delay: 1.5 + lag, duration: 0.9, ease: 'easeOut', repeat: 1, repeatDelay: 0.15 }}
            />
          ))}
        </div>
      )}
    </div>
  );

  return logo;
}
