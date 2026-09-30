'use client';

/**
 * BLASTI app intro animation — plays inside the Capacitor mobile shell on
 * app launch (once per app session). Web/desktop boots skip it entirely so
 * the browser preview is unaffected; append `?intro=1` to preview it.
 *
 * Story (matches the brand): the waiting bench assembles itself, the orange
 * "your turn" dot drops in and pings — then the wordmark appears and the
 * curtain lifts into the app.
 */

import { useEffect, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';

const INTRO_KEY = 'blasti-intro-played';

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
          className="fixed inset-0 z-[9999] flex flex-col items-center justify-center overflow-hidden"
          style={{
            background:
              'radial-gradient(120% 90% at 50% 42%, #14b8a6 0%, #10b981 55%, #065f46 100%)',
          }}
          initial={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: reduceMotion ? 0.35 : 0.55, ease: 'easeInOut' }}
        >
          <BenchScene reduceMotion={!!reduceMotion} />

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
                  className="text-4xl font-extrabold tracking-[0.18em] text-white sm:text-5xl"
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
              className="mt-2 text-lg font-medium text-white/90"
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

/** The bench glyph, assembled piece by piece. Same geometry as the app icons. */
function BenchScene({ reduceMotion }: { reduceMotion: boolean }) {
  const spring = { type: 'spring' as const, stiffness: 260, damping: 20 };

  if (reduceMotion) {
    return (
      <svg width="240" height="240" viewBox="0 0 512 512" className="drop-shadow-lg">
        <ellipse cx="256" cy="398" rx="180" ry="20" fill="#022c22" opacity="0.35" />
        <rect x="78" y="64" width="106" height="148" rx="20" fill="#fff" />
        <rect x="203" y="64" width="106" height="148" rx="20" fill="#fff" />
        <rect x="328" y="64" width="106" height="148" rx="20" fill="#fff" />
        <path d="M 56 128 V 190 a 28 28 0 0 0 28 28 H 428 a 28 28 0 0 0 28 -28 V 128" fill="none" stroke="#fff" strokeWidth="26" strokeLinecap="round" />
        <rect x="78" y="236" width="106" height="28" rx="14" fill="#fff" />
        <rect x="203" y="236" width="106" height="28" rx="14" fill="#fff" />
        <rect x="328" y="236" width="106" height="28" rx="14" fill="#fff" />
        <rect x="72" y="282" width="368" height="16" rx="8" fill="#fff" />
        <path d="M 122 298 L 106 356" stroke="#fff" strokeWidth="24" strokeLinecap="round" />
        <path d="M 106 356 L 86 370" stroke="#fff" strokeWidth="24" strokeLinecap="round" />
        <path d="M 390 298 L 406 356" stroke="#fff" strokeWidth="24" strokeLinecap="round" />
        <path d="M 406 356 L 426 370" stroke="#fff" strokeWidth="24" strokeLinecap="round" />
        <circle cx="256" cy="372" r="30" fill="#F97316" />
      </svg>
    );
  }

  return (
    <svg width="280" height="280" viewBox="0 0 512 512" className="drop-shadow-lg">
      {/* ground shadow */}
      <motion.ellipse
        cx="256" cy="398" rx="180" ry="20" fill="#022c22"
        initial={{ opacity: 0, scaleX: 0.4 }}
        animate={{ opacity: 0.35, scaleX: 1 }}
        style={{ transformBox: 'fill-box', transformOrigin: 'center' }}
        transition={{ delay: 0.85, duration: 0.5, ease: 'easeOut' }}
      />
      {/* backrests */}
      {[78, 203, 328].map((x, i) => (
        <motion.rect
          key={`back-${x}`}
          x={x} y="64" width="106" height="148" rx="20" fill="#fff"
          initial={{ opacity: 0, y: -26, scale: 0.9 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          style={{ transformBox: 'fill-box', transformOrigin: 'center' }}
          transition={{ ...spring, delay: 0.15 + i * 0.1 }}
        />
      ))}
      {/* armrest bar draws itself */}
      <motion.path
        d="M 56 128 V 190 a 28 28 0 0 0 28 28 H 428 a 28 28 0 0 0 28 -28 V 128"
        fill="none" stroke="#fff" strokeWidth="26" strokeLinecap="round"
        initial={{ pathLength: 0, opacity: 0 }}
        animate={{ pathLength: 1, opacity: 1 }}
        transition={{ delay: 0.35, duration: 0.6, ease: 'easeInOut' }}
      />
      {/* seats */}
      {[78, 203, 328].map((x, i) => (
        <motion.rect
          key={`seat-${x}`}
          x={x} y="236" width="106" height="28" rx="14" fill="#fff"
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ ...spring, delay: 0.55 + i * 0.08 }}
        />
      ))}
      {/* base beam */}
      <motion.rect
        x="72" y="282" width="368" height="16" rx="8" fill="#fff"
        initial={{ scaleX: 0 }}
        animate={{ scaleX: 1 }}
        style={{ transformBox: 'fill-box', transformOrigin: 'center' }}
        transition={{ delay: 0.72, duration: 0.45, ease: 'easeOut' }}
      />
      {/* legs */}
      {[
        'M 122 298 L 106 356',
        'M 106 356 L 86 370',
        'M 390 298 L 406 356',
        'M 406 356 L 426 370',
      ].map((d, i) => (
        <motion.path
          key={`leg-${i}`}
          d={d} stroke="#fff" strokeWidth="24" strokeLinecap="round" fill="none"
          initial={{ opacity: 0, pathLength: 0 }}
          animate={{ opacity: 1, pathLength: 1 }}
          transition={{ delay: 0.8 + i * 0.06, duration: 0.25, ease: 'easeOut' }}
        />
      ))}
      {/* the orange "your turn" dot drops in and pings */}
      <motion.g
        initial={{ y: -170, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ delay: 1.1, type: 'spring', stiffness: 380, damping: 15 }}
      >
        <circle cx="256" cy="372" r="30" fill="#F97316" />
      </motion.g>
      {/* ripples — "ticket called" ping */}
      {[0, 0.35].map((lag) => (
        <motion.circle
          key={`ripple-${lag}`}
          cx="256" cy="372" r="30" fill="none" stroke="#F97316" strokeWidth="5"
          initial={{ scale: 1, opacity: 0 }}
          animate={{ scale: [1, 2.6], opacity: [0.7, 0] }}
          style={{ transformBox: 'fill-box', transformOrigin: 'center' }}
          transition={{ delay: 1.5 + lag, duration: 0.9, ease: 'easeOut', repeat: 1, repeatDelay: 0.15 }}
        />
      ))}
    </svg>
  );
}
