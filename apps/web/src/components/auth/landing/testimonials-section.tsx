'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useLanguage } from '@/hooks/use-language';
import { motion, AnimatePresence, PanInfo } from 'framer-motion';
import {
  Star,
  Quote,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';

/* ─── Testimonials Data ──────────── */
interface TestimonialItem {
  textKey: 'testimonial1' | 'testimonial2' | 'testimonial3';
  nameKey: 'testimonial1Name' | 'testimonial2Name' | 'testimonial3Name';
  roleKey: 'testimonial1Role' | 'testimonial2Role' | 'testimonial3Role';
  rating: number;
}

const testimonials: TestimonialItem[] = [
  { textKey: 'testimonial1', nameKey: 'testimonial1Name', roleKey: 'testimonial1Role', rating: 5 },
  { textKey: 'testimonial2', nameKey: 'testimonial2Name', roleKey: 'testimonial2Role', rating: 5 },
  { textKey: 'testimonial3', nameKey: 'testimonial3Name', roleKey: 'testimonial3Role', rating: 5 },
];

/* ─── Star Rating Display ──────────── */
function StarRating({ rating, delay = 0 }: { rating: number; delay?: number }) {
  return (
    <div className="flex gap-0.5">
      {[...Array(5)].map((_, i) => (
        <motion.div
          key={i}
          initial={{ opacity: 0, scale: 0, rotate: -20 }}
          whileInView={{ opacity: 1, scale: 1, rotate: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.3, delay: delay + i * 0.05, type: 'spring', stiffness: 300 }}
        >
          <Star className={`h-4 w-4 ${i < rating ? 'text-amber-400 fill-amber-400' : 'text-gray-200 dark:text-gray-700'}`} />
        </motion.div>
      ))}
    </div>
  );
}

/* ─── Avatar with Gradient Border ──────────── */
function GradientAvatar({ name, size = 'md' }: { name: string; size?: 'sm' | 'md' }) {
  const sizeClasses = size === 'sm' ? 'h-10 w-10 text-sm' : 'h-11 w-11 text-sm';
  const ringSize = size === 'sm' ? 'p-[2px]' : 'p-[2.5px]';
  
  return (
    <div className={`${ringSize} rounded-full bg-gradient-to-br from-emerald-400 via-teal-400 to-emerald-500 flex-shrink-0 shadow-lg group-hover:shadow-xl group-hover:shadow-emerald-500/20 transition-shadow duration-300`}>
      <div className={`${sizeClasses} rounded-full bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center text-white font-bold ring-2 ring-white/30 dark:ring-gray-900/30`}>
        {name.charAt(0)}
      </div>
    </div>
  );
}

/* ─── Progress Dot Indicator ──────────── */
function ProgressDots({
  total,
  active,
  onSelect,
  autoPlayInterval,
}: {
  total: number;
  active: number;
  onSelect: (i: number) => void;
  autoPlayInterval: number;
}) {
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    const startTime = Date.now();
    let rafId: number;
    const tick = () => {
      const elapsed = Date.now() - startTime;
      const p = Math.min(elapsed / autoPlayInterval, 1);
      setProgress(p);
      if (p < 1) rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [active, autoPlayInterval]);

  return (
    <div className="flex justify-center gap-2.5 mt-6" role="tablist">
      {Array.from({ length: total }, (_, i) => (
        <button
          key={`dot-${i}`}
          onClick={() => onSelect(i)}
          className="relative h-2.5 rounded-full transition-all duration-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
          style={{
            width: i === active ? '2rem' : '0.625rem',
          }}
          role="tab"
          aria-selected={i === active}
          aria-label={`Testimonial ${i + 1}`}
        >
          {/* Background track */}
          <span className="absolute inset-0 rounded-full bg-emerald-200/50 dark:bg-emerald-800/50" />
          {/* Active fill with progress */}
          {i === active && (
            <motion.span
              className="absolute inset-0 rounded-full bg-gradient-to-r from-emerald-500 to-teal-500"
              initial={{ scaleX: 0 }}
              animate={{ scaleX: progress }}
              style={{ transformOrigin: 'right' }}
              transition={{ duration: 0.1, ease: 'linear' }}
            />
          )}
          {/* Inactive dot fill */}
          {i !== active && (
            <span className="absolute inset-0 rounded-full bg-emerald-400/30 dark:bg-emerald-600/30" />
          )}
        </button>
      ))}
    </div>
  );
}

export function TestimonialsSection() {
  const { t } = useLanguage();
  const [activeTestimonial, setActiveTestimonial] = useState(0);
  const [direction, setDirection] = useState(1);
  const autoPlayRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const AUTO_PLAY_INTERVAL = 5000;

  // Testimonial auto-rotate
  const startAutoPlay = useCallback(() => {
    if (autoPlayRef.current) clearInterval(autoPlayRef.current);
    autoPlayRef.current = setInterval(() => {
      setDirection(1);
      setActiveTestimonial((prev) => (prev + 1) % testimonials.length);
    }, AUTO_PLAY_INTERVAL);
  }, []);

  useEffect(() => {
    startAutoPlay();
    return () => {
      if (autoPlayRef.current) clearInterval(autoPlayRef.current);
    };
  }, [startAutoPlay]);

  const goTo = useCallback((index: number) => {
    setDirection(index > activeTestimonial ? 1 : -1);
    setActiveTestimonial(index);
    startAutoPlay();
  }, [activeTestimonial, startAutoPlay]);

  const goNext = useCallback(() => {
    setDirection(1);
    setActiveTestimonial((prev) => (prev + 1) % testimonials.length);
    startAutoPlay();
  }, [startAutoPlay]);

  const goPrev = useCallback(() => {
    setDirection(-1);
    setActiveTestimonial((prev) => (prev - 1 + testimonials.length) % testimonials.length);
    startAutoPlay();
  }, [startAutoPlay]);

  // Swipe handlers
  const handleDragEnd = useCallback((_e: MouseEvent | TouchEvent | PointerEvent, info: PanInfo) => {
    const threshold = 50;
    if (info.offset.x > threshold) {
      goPrev();
    } else if (info.offset.x < -threshold) {
      goNext();
    }
  }, [goNext, goPrev]);

  const slideVariants = {
    enter: (dir: number) => ({
      x: dir > 0 ? 80 : -80,
      opacity: 0,
      scale: 0.95,
    }),
    center: {
      x: 0,
      opacity: 1,
      scale: 1,
    },
    exit: (dir: number) => ({
      x: dir > 0 ? -80 : 80,
      opacity: 0,
      scale: 0.95,
    }),
  };

  return (
    <>
      {/* ─── Testimonials Grid / Carousel ──────────── */}
      <section className="w-full px-4 py-20 md:py-24 relative z-10">
        {/* Subtle gradient overlay */}
        <div className="absolute inset-0 -z-10 bg-gradient-to-b from-transparent via-emerald-50/30 to-emerald-50/50 dark:from-transparent dark:via-emerald-950/10 dark:to-emerald-950/20" />
        <div className="max-w-4xl mx-auto">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: '-50px' }}
            transition={{ duration: 0.5 }}
            className="text-center"
          >
            {/* Decorative floating quote */}
            <motion.div
              animate={{ y: [0, -8, 0], rotate: [-6, -3, -6] }}
              transition={{ duration: 4, repeat: Infinity, ease: 'easeInOut' }}
              className="inline-block mb-4"
            >
              <Quote className="h-12 w-12 text-emerald-300 dark:text-emerald-700 rotate-180" />
            </motion.div>
            <h2 className="text-2xl md:text-3xl font-bold mb-10 shimmer-text">
              {t('testimonialsTitle')}
            </h2>
          </motion.div>

          {/* Desktop: Grid of testimonial cards */}
          <div className="hidden md:grid grid-cols-3 gap-5">
            {testimonials.map((testimonial, idx) => (
              <motion.div
                key={idx}
                initial={{ opacity: 0, y: 25 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: '-30px' }}
                transition={{ duration: 0.5, delay: idx * 0.15 }}
                whileHover={{ y: -8, scale: 1.02 }}
                className="cursor-default group"
              >
                <div className="glass-feature-card rounded-2xl p-6 h-full flex flex-col relative overflow-hidden">
                  {/* Decorative quote mark */}
                  <div className="absolute top-3 end-3 opacity-10 dark:opacity-5 group-hover:opacity-20 transition-opacity">
                    <Quote className="h-16 w-16 text-emerald-500" />
                  </div>
                  {/* Star rating */}
                  <div className="mb-3">
                    <StarRating rating={testimonial.rating} delay={0.3 + idx * 0.1} />
                  </div>
                  <p className="text-sm text-muted-foreground leading-relaxed mb-5 flex-1 relative z-10">
                    &ldquo;{t(testimonial.textKey)}&rdquo;
                  </p>
                  <div className="flex items-center gap-3 pt-4 border-t border-gray-100/50 dark:border-gray-800/50">
                    {/* Avatar with gradient border */}
                    <GradientAvatar name={t(testimonial.nameKey)} />
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-foreground truncate">
                        {t(testimonial.nameKey)}
                      </p>
                      <p className="text-xs text-muted-foreground truncate">
                        {t(testimonial.roleKey)}
                      </p>
                    </div>
                  </div>
                </div>
              </motion.div>
            ))}
          </div>

          {/* Mobile: Single testimonial with auto-rotate, swipe, and progress dots */}
          <div className="md:hidden">
            <div className="relative">
              <AnimatePresence mode="wait" custom={direction}>
                <motion.div
                  key={activeTestimonial}
                  custom={direction}
                  variants={slideVariants}
                  initial="enter"
                  animate="center"
                  exit="exit"
                  transition={{ duration: 0.4, ease: [0.25, 0.46, 0.45, 0.94] }}
                  drag="x"
                  dragConstraints={{ left: 0, right: 0 }}
                  dragElastic={0.2}
                  onDragEnd={handleDragEnd}
                  className="glass-feature-card rounded-2xl p-6 relative overflow-hidden cursor-grab active:cursor-grabbing"
                >
                  {/* Decorative quote mark */}
                  <div className="absolute top-3 end-3 opacity-10 dark:opacity-5">
                    <Quote className="h-16 w-16 text-emerald-500" />
                  </div>
                  {/* Star rating */}
                  <div className="mb-3">
                    <StarRating rating={testimonials[activeTestimonial].rating} />
                  </div>
                  <p className="text-sm text-muted-foreground leading-relaxed mb-5 relative z-10">
                    &ldquo;{t(testimonials[activeTestimonial].textKey)}&rdquo;
                  </p>
                  <div className="flex items-center gap-3 pt-4 border-t border-gray-100/50 dark:border-gray-800/50">
                    <GradientAvatar name={t(testimonials[activeTestimonial].nameKey)} />
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-foreground truncate">
                        {t(testimonials[activeTestimonial].nameKey)}
                      </p>
                      <p className="text-xs text-muted-foreground truncate">
                        {t(testimonials[activeTestimonial].roleKey)}
                      </p>
                    </div>
                  </div>
                </motion.div>
              </AnimatePresence>

              {/* Navigation arrows */}
              <div className="flex justify-between mt-3">
                <motion.button
                  whileTap={{ scale: 0.9 }}
                  onClick={goPrev}
                  className="h-9 w-9 rounded-full bg-emerald-50 dark:bg-emerald-950/50 border border-emerald-200/50 dark:border-emerald-800/50 flex items-center justify-center text-emerald-600 dark:text-emerald-400 hover:bg-emerald-100 dark:hover:bg-emerald-900/50 transition-colors"
                  aria-label="Previous"
                >
                  <ChevronRight className="h-4 w-4 rtl:rotate-180" />
                </motion.button>
                <motion.button
                  whileTap={{ scale: 0.9 }}
                  onClick={goNext}
                  className="h-9 w-9 rounded-full bg-emerald-50 dark:bg-emerald-950/50 border border-emerald-200/50 dark:border-emerald-800/50 flex items-center justify-center text-emerald-600 dark:text-emerald-400 hover:bg-emerald-100 dark:hover:bg-emerald-900/50 transition-colors"
                  aria-label="Next"
                >
                  <ChevronLeft className="h-4 w-4 rtl:rotate-180" />
                </motion.button>
              </div>
            </div>

            {/* Progress dot indicators */}
            <ProgressDots
              total={testimonials.length}
              active={activeTestimonial}
              onSelect={goTo}
              autoPlayInterval={AUTO_PLAY_INTERVAL}
            />
          </div>
        </div>
      </section>

      {/* ─── Floating Testimonials Carousel ──────────── */}
      <section className="w-full py-16 relative z-10">
        <div className="max-w-4xl mx-auto px-4">
          <motion.h3
            initial={{ opacity: 0, y: 15 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            className="text-lg md:text-xl font-semibold text-center mb-8 text-foreground"
          >
            {t('landingCarouselTitle')}
          </motion.h3>
          <div className="relative">
            {/* Gradient fade overlays */}
            <div className="absolute start-0 top-0 bottom-8 w-16 bg-gradient-to-e from-[var(--color-bg)] to-transparent z-10 pointer-events-none rtl:bg-gradient-to-l" />
            <div className="absolute end-0 top-0 bottom-8 w-16 bg-gradient-to-s from-[var(--color-bg)] to-transparent z-10 pointer-events-none rtl:bg-gradient-to-r" />
            {/* Carousel track */}
            <div className="overflow-hidden">
              <div
                className="flex gap-4 w-max"
                style={{
                  animationName: 'carousel-scroll',
                  animationDuration: '25s',
                  animationTimingFunction: 'linear',
                  animationIterationCount: 'infinite',
                }}
              >
                {[...testimonials, ...testimonials, ...testimonials, ...testimonials].map((testimonial, idx) => (
                  <div
                    key={`carousel-${idx}`}
                    className="w-80 flex-shrink-0"
                  >
                    <div className="rounded-2xl p-5 glass-feature-card">
                      <div className="flex items-center gap-3 mb-3">
                        <GradientAvatar name={t(testimonial.nameKey)} size="sm" />
                        <div>
                          <p className="text-sm font-semibold text-foreground">{t(testimonial.nameKey)}</p>
                          <p className="text-xs text-muted-foreground">{t(testimonial.roleKey)}</p>
                        </div>
                        <div className="ms-auto flex gap-0.5">
                          {[...Array(5)].map((_, i) => (
                            <Star key={i} className="h-3 w-3 text-amber-400 fill-amber-400" />
                          ))}
                        </div>
                      </div>
                      <Quote className="h-5 w-5 text-emerald-300 dark:text-emerald-700 mb-1.5" />
                      <p className="text-sm text-muted-foreground leading-relaxed">
                        &ldquo;{t(testimonial.textKey)}&rdquo;
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
            {/* Dots indicator */}
            <div className="flex justify-center gap-2 mt-6" role="tablist" aria-label={t('carouselDot')}>
              {testimonials.map((_, i) => (
                <div
                  key={`dot-${i}`}
                  className="h-2 w-2 rounded-full bg-emerald-400 dark:bg-emerald-600"
                  style={{
                    animation: `carousel-dot-pulse 3s ease-in-out ${i * 0.8}s infinite`,
                  }}
                  role="tab"
                  aria-label={t('carouselDot')}
                />
              ))}
            </div>
          </div>
          {/* CSS animations for carousel - RTL aware */}
          <style>{`
            @keyframes carousel-scroll {
              0% { transform: translateX(0); }
              100% { transform: translateX(-33.333%); }
            }
            @keyframes carousel-scroll-rtl {
              0% { transform: translateX(0); }
              100% { transform: translateX(33.333%); }
            }
            @keyframes carousel-dot-pulse {
              0%, 100% { opacity: 0.3; transform: scale(1); }
              50% { opacity: 1; transform: scale(1.3); }
            }
          `}</style>
        </div>
      </section>
    </>
  );
}
