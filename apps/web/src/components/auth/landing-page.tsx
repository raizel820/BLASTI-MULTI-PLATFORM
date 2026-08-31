'use client'
import { apiFetch } from '@/lib/api-fetch';;

import { useRef, useState, useEffect, useCallback } from 'react';
import { useAppStore } from '@/store/use-app-store';
import { useLanguage } from '@/hooks/use-language';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { LanguageSwitcher } from '@/components/shared/language-switcher';
import { ThemeToggle } from '@/components/shared/theme-toggle';
import { DownloadSection } from '@/components/platform/download-section';
import { motion, useInView, AnimatePresence } from 'framer-motion';
import {
  Clock,
  Wifi,
  Bell,
  Smartphone,
  ArrowRight,
  Search,
  TicketCheck,
  BellRing,
  Building2,
  Users,
  Zap,
  Briefcase,
  FlaskConical,
  Scale,
  Landmark,
  Star,
  Quote,
  ArrowUp,
  ChevronUp,
  Heart,
  Share2,
  Shield,
  Globe,
  Menu,
  X,
  Activity,
  Server,
} from 'lucide-react';

/* ─── Animated Counter with smooth eased bounce ──────────── */
function AnimatedCounter({ target, suffix = '', decimals = 0 }: { target: number; suffix?: string; decimals?: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  const isInView = useInView(ref, { once: true });
  const [display, setDisplay] = useState(0);

  useEffect(() => {
    if (!isInView) return;
    let start = 0;
    const duration = 2400;
    const startTime = performance.now();

    // Smoother easing: ease-out-expo with slight overshoot for punch
    const ease = (t: number) => {
      if (t === 0 || t === 1) return t;
      // Ease-out with slight bounce at end
      const p = 1 - Math.pow(2, -10 * t);
      // Add subtle overshoot for visual punch
      const bounce = t < 0.85 ? 0 : Math.sin((t - 0.85) / 0.15 * Math.PI) * 0.015;
      return p + bounce;
    };

    const step = (now: number) => {
      const elapsed = now - startTime;
      const progress = Math.min(elapsed / duration, 1);
      const eased = ease(progress);
      const current = eased * target;
      if (decimals > 0) {
        setDisplay(parseFloat(current.toFixed(decimals)));
      } else {
        setDisplay(Math.round(current));
      }
      if (progress < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }, [isInView, target, decimals]);

  return (
    <motion.span
      ref={ref}
      className="tabular-nums"
      initial={{ scale: 0.5, opacity: 0 }}
      animate={isInView ? { scale: [0.5, 1.1, 0.97, 1], opacity: 1 } : { scale: 0.5, opacity: 0 }}
      transition={{ duration: 0.8, ease: [0.22, 1, 0.36, 1] }}
    >
      {decimals > 0 ? display.toFixed(decimals) : display.toLocaleString()}{suffix}
    </motion.span>
  );
}

/* ─── Phone Mockup SVG Illustration ──────────── */
function PhoneMockup() {
  const { t } = useLanguage();
  
  return (
    <motion.div
      className="hidden lg:flex items-center justify-center relative"
      initial={{ opacity: 0, x: 60 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.8, delay: 0.4 }}
    >
      <motion.div
        animate={{ y: [0, -12, -6, -16, 0] }}
        transition={{ duration: 6, repeat: Infinity, ease: 'easeInOut' }}
        className="relative"
        style={{ perspective: '800px' }}
      >
        {/* Glow behind phone */}
        <div className="absolute -inset-8 bg-gradient-to-br from-emerald-400/20 to-teal-400/10 dark:from-emerald-500/10 dark:to-teal-500/5 rounded-[3rem] blur-2xl" />
        
        {/* Phone body */}
        <div className="relative w-56 h-[420px] rounded-[2.5rem] bg-gradient-to-b from-gray-800 to-gray-900 dark:from-gray-700 dark:to-gray-800 p-2 shadow-2xl shadow-emerald-500/10">
          {/* Screen */}
          <div className="w-full h-full rounded-[2rem] bg-gradient-to-b from-emerald-50 to-white dark:from-gray-900 dark:to-gray-950 overflow-hidden relative">
            {/* Notch */}
            <div className="absolute top-0 start-1/2 -translate-x-1/2 w-20 h-5 bg-gray-800 dark:bg-gray-700 rounded-b-2xl z-10" />
            
            {/* Status bar */}
            <div className="h-10 flex items-end justify-center pb-1">
              <span className="text-[8px] text-gray-400 font-medium">9:41</span>
            </div>

            {/* App UI inside phone */}
            <div className="px-3 pt-1">
              {/* Header */}
              <div className="flex items-center gap-1.5 mb-3">
                <div className="h-12 w-12 rounded-xl overflow-hidden">
                  <img src="/logo.png" alt="BLASTI" width={48} height={48} className="h-full w-full object-contain" />
                </div>
                <span className="text-[8px] font-bold text-emerald-700 dark:text-emerald-400">BLASTI</span>
              </div>

              {/* Queue ticket card */}
              <div className="rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600 p-2.5 mb-2.5 shadow-lg relative overflow-hidden">
                <div className="absolute top-0 end-0 w-16 h-16 bg-white/10 rounded-full -translate-y-1/2 translate-x-1/2" />
                <p className="text-[7px] text-emerald-100 mb-0.5">{t('yourQueueNumber') as string}</p>
                <p className="text-2xl font-black text-white">A-042</p>
                <div className="flex items-center gap-2 mt-1.5">
                  <div className="flex items-center gap-0.5">
                    <Users className="w-2.5 h-2.5 text-emerald-200" />
                    <span className="text-[7px] text-emerald-100">3 {t('peopleAhead') as string}</span>
                  </div>
                  <div className="flex items-center gap-0.5">
                    <Clock className="w-2.5 h-2.5 text-emerald-200" />
                    <span className="text-[7px] text-emerald-100">~15 {t('minutes') as string}</span>
                  </div>
                </div>
                {/* Progress bar */}
                <div className="mt-2 h-1 bg-white/20 rounded-full overflow-hidden">
                  <motion.div
                    className="h-full bg-white/80 rounded-full"
                    initial={{ width: '0%' }}
                    animate={{ width: '70%' }}
                    transition={{ duration: 2, delay: 1.5 }}
                  />
                </div>
              </div>

              {/* Mini list items */}
              <div className="space-y-1.5">
                {[
                  { label: t('demoClinic') as string, num: 'A-039', status: t('serving') as string },
                  { label: t('demoClinic') as string, num: 'A-040', status: t('nextUp') as string },
                  { label: t('demoClinic') as string, num: 'A-041', status: t('waiting') as string },
                ].map((item, i) => (
                  <motion.div
                    key={i}
                    className="flex items-center justify-between rounded-lg bg-white/80 dark:bg-gray-800/80 p-1.5 border border-gray-100 dark:border-gray-700/50"
                    initial={{ opacity: 0, x: 20 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ duration: 0.3, delay: 2 + i * 0.2 }}
                  >
                    <div className="flex items-center gap-1.5">
                      <div className={`w-4 h-4 rounded-full flex items-center justify-center text-[6px] font-bold text-white ${i === 0 ? 'bg-emerald-500' : i === 1 ? 'bg-teal-500' : 'bg-gray-300 dark:bg-gray-600'}`}>
                        {item.num}
                      </div>
                      <span className="text-[7px] text-gray-600 dark:text-gray-400">{item.status}</span>
                    </div>
                    <div className={`w-1.5 h-1.5 rounded-full ${i === 0 ? 'bg-emerald-400 animate-pulse' : i === 1 ? 'bg-teal-400' : 'bg-gray-300 dark:bg-gray-600'}`} />
                  </motion.div>
                ))}
              </div>
            </div>

            {/* Bottom nav bar */}
            <div className="absolute bottom-0 left-0 right-0 h-10 bg-white/90 dark:bg-gray-900/90 backdrop-blur-sm border-t border-gray-100 dark:border-gray-800 flex items-center justify-around px-4">
              {[
                { icon: <Building2 className="w-3 h-3" />, active: false },
                { icon: <TicketCheck className="w-3 h-3" />, active: true },
                { icon: <Bell className="w-3 h-3" />, active: false },
                { icon: <Users className="w-3 h-3" />, active: false },
              ].map((nav, i) => (
                <div key={i} className={`flex items-center justify-center w-6 h-6 rounded-lg ${nav.active ? 'bg-emerald-100 dark:bg-emerald-900/50 text-emerald-600 dark:text-emerald-400' : 'text-gray-400'}`}>
                  {nav.icon}
                </div>
              ))}
            </div>
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}

/* ─── Hero Particles ──────────── */
// Deterministic pseudo-random based on seed to avoid hydration mismatch
function seededRandom(seed: number): number {
  const x = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

function HeroParticles() {
  // Use deterministic values derived from index to prevent SSR/client hydration mismatch
  // Enhanced with larger decorative bubbles, more varied sizes, and extra depth layers
  const particles = Array.from({ length: 50 }, (_, i) => ({
    id: i,
    x: seededRandom(i * 2) * 100,
    y: seededRandom(i * 2 + 1) * 100,
    // Three tiers: large orbs (0-7), medium (8-20), small dots (21-49)
    size: i < 7
      ? seededRandom(i * 3 + 5) * 14 + 8 // 8-22px large orbs
      : i < 20
        ? seededRandom(i * 3 + 5) * 6 + 3 // 3-9px medium
        : seededRandom(i * 3 + 5) * 4 + 1, // 1-5px small dots
    duration: seededRandom(i * 3 + 10) * 10 + 6,
    delay: seededRandom(i * 3 + 15) * 5,
    opacity: i < 7 ? 0.35 : i < 20 ? 0.2 : 0.12,
  }));

  return (
    <div className="absolute inset-0 overflow-hidden pointer-events-none">
      {particles.map((p) => (
        <motion.div
          key={p.id}
          className="absolute rounded-full"
          style={{
            left: `${p.x}%`,
            top: `${p.y}%`,
            width: p.size,
            height: p.size,
            background: p.id < 7
              ? 'radial-gradient(circle, rgba(16,185,129,0.5) 0%, rgba(20,184,166,0.15) 70%, transparent 100%)'
              : p.id < 20
                ? 'radial-gradient(circle, rgba(6,182,212,0.35) 0%, rgba(20,184,166,0.1) 70%, transparent 100%)'
                : 'radial-gradient(circle, rgba(6,182,212,0.25) 0%, rgba(20,184,166,0.06) 70%, transparent 100%)',
          }}
          animate={{
            y: [0, -40, -10, -35, 0],
            x: [0, 15, -10, 12, 0],
            opacity: [p.opacity, p.opacity * 2.5, p.opacity * 1.5, p.opacity * 3, p.opacity],
            scale: [1, 1.25, 1.1, 1.35, 1],
          }}
          transition={{
            duration: p.duration,
            repeat: Infinity,
            ease: 'easeInOut',
            delay: p.delay,
          }}
        />
      ))}

      {/* Large decorative blurred orbs */}
      <motion.div
        className="absolute top-1/4 start-10 w-36 h-36 rounded-full bg-emerald-400/15 dark:bg-emerald-500/8 blur-3xl"
        animate={{ x: [0, 25, -12, 18, 0], y: [0, -18, 12, -22, 0] }}
        transition={{ duration: 15, repeat: Infinity, ease: 'easeInOut' }}
      />
      <motion.div
        className="absolute bottom-1/4 end-10 w-44 h-44 rounded-full bg-teal-400/12 dark:bg-teal-500/6 blur-3xl"
        animate={{ x: [0, -18, 12, -22, 0], y: [0, 22, -12, 18, 0] }}
        transition={{ duration: 18, repeat: Infinity, ease: 'easeInOut', delay: 3 }}
      />
      <motion.div
        className="absolute top-1/2 start-1/2 -translate-x-1/2 -translate-y-1/2 w-72 h-72 rounded-full bg-cyan-300/8 dark:bg-emerald-600/4 blur-3xl"
        animate={{ scale: [1, 1.25, 0.9, 1.15, 1], opacity: [0.06, 0.12, 0.06, 0.1, 0.06] }}
        transition={{ duration: 12, repeat: Infinity, ease: 'easeInOut', delay: 2 }}
      />
      {/* Extra cyan orb for depth */}
      <motion.div
        className="absolute top-[15%] end-[20%] w-28 h-28 rounded-full bg-cyan-400/10 dark:bg-cyan-500/5 blur-3xl"
        animate={{ x: [0, -14, 8, -10, 0], y: [0, -20, 15, -12, 0] }}
        transition={{ duration: 14, repeat: Infinity, ease: 'easeInOut', delay: 5 }}
      />
      {/* Extra large slow-moving emerald orb for subtle depth */}
      <motion.div
        className="absolute bottom-[10%] start-[30%] w-56 h-56 rounded-full bg-emerald-300/6 dark:bg-emerald-600/3 blur-3xl"
        animate={{ x: [0, 20, -15, 10, 0], y: [0, -15, 20, -10, 0], scale: [1, 1.1, 0.95, 1.05, 1] }}
        transition={{ duration: 22, repeat: Infinity, ease: 'easeInOut', delay: 4 }}
      />
    </div>
  );
}

export function LandingPage() {
  const { setView } = useAppStore();
  const { t } = useLanguage();
  const statsRef = useRef<HTMLDivElement>(null);
  const testimonialsRef = useRef<HTMLDivElement>(null);
  const trustedRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [showBackToTop, setShowBackToTop] = useState(false);
  const [activeTestimonial, setActiveTestimonial] = useState(0);
  const [scrolled, setScrolled] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const scrollToSection = useCallback((id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' });
    setMobileMenuOpen(false);
  }, []);

  const features = [
    { icon: Clock, titleKey: 'feature1Title' as const, descKey: 'feature1Desc' as const },
    { icon: Wifi, titleKey: 'feature2Title' as const, descKey: 'feature2Desc' as const },
    { icon: Bell, titleKey: 'feature3Title' as const, descKey: 'feature3Desc' as const },
    { icon: Smartphone, titleKey: 'feature4Title' as const, descKey: 'feature4Desc' as const },
  ];

  const steps = [
    { icon: Search, titleKey: 'step1' as const, descKey: 'step1Desc' as const },
    { icon: TicketCheck, titleKey: 'step2' as const, descKey: 'step2Desc' as const },
    { icon: BellRing, titleKey: 'step3' as const, descKey: 'step3Desc' as const },
  ];

  const [landingStats, setLandingStats] = useState<{ totalAgencies: number; totalCustomers: number; totalReservations: number; activeQueues: number } | null>(null);

  useEffect(() => {
    const fetchStats = async () => {
      try {
        const res = await apiFetch('/api/stats');
        if (res.ok) {
          const data = await res.json();
          setLandingStats({
            totalAgencies: data.totalAgencies ?? 0,
            totalCustomers: data.totalCustomers ?? 0,
            totalReservations: data.totalReservations ?? 0,
            activeQueues: data.activeQueues ?? 0,
          });
        }
      } catch {
        // keep fallback values
      }
    };
    fetchStats();
  }, []);

  const stats = [
    { icon: Users, value: 10000, suffix: '+', labelKey: 'landingStatActiveCustomers' as const },
    { icon: Building2, value: 500, suffix: '+', labelKey: 'landingStatInstitutions' as const },
    { icon: TicketCheck, value: 1, suffix: 'M+', labelKey: 'landingStatTickets' as const },
    { icon: Activity, value: 99.9, suffix: '%', labelKey: 'landingStatUptime' as const, decimals: 1 },
  ];

  const testimonials = [
    { textKey: 'testimonial1' as const, nameKey: 'testimonial1Name' as const, roleKey: 'testimonial1Role' as const },
    { textKey: 'testimonial2' as const, nameKey: 'testimonial2Name' as const, roleKey: 'testimonial2Role' as const },
    { textKey: 'testimonial3' as const, nameKey: 'testimonial3Name' as const, roleKey: 'testimonial3Role' as const },
  ];

  const trustedCategories = [
    { icon: Briefcase, labelKey: 'trustedClinic' as const },
    { icon: FlaskConical, labelKey: 'trustedLab' as const },
    { icon: Scale, labelKey: 'trustedLaw' as const },
    { icon: Landmark, labelKey: 'trustedGov' as const },
  ];

  // Back to top button visibility + sticky header scroll tracking
  useEffect(() => {
    const handleScroll = () => {
      setShowBackToTop(window.scrollY > 400);
      setScrolled(window.scrollY > 50);
    };
    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  // Testimonial auto-rotate
  useEffect(() => {
    const interval = setInterval(() => {
      setActiveTestimonial((prev) => (prev + 1) % testimonials.length);
    }, 5000);
    return () => clearInterval(interval);
  }, [testimonials.length]);

  const scrollToTop = useCallback(() => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  return (
    <div ref={containerRef} className="min-h-screen flex flex-col relative overflow-hidden">
      {/* Animated gradient mesh background */}
      <div className="absolute inset-0 -z-10">
        <motion.div
          animate={{ backgroundPosition: ['0% 0%', '100% 100%', '50% 50%', '0% 0%'] }}
          transition={{ duration: 25, repeat: Infinity, ease: 'linear' }}
          className="absolute inset-0 bg-[length:400%_400%] bg-gradient-to-br from-emerald-50 via-teal-50 to-emerald-100 dark:from-gray-950 dark:via-gray-900 dark:to-emerald-950/30"
        />
        <div
          className="absolute inset-0 opacity-[0.03] dark:opacity-[0.05]"
          style={{
            backgroundImage: `radial-gradient(circle at 1px 1px, currentColor 1px, transparent 0)`,
            backgroundSize: '32px 32px',
          }}
        />
        {/* Mesh gradient blobs - enhanced with more layers */}
        <motion.div
          animate={{ x: [0, 30, 0], y: [0, -20, 0], scale: [1, 1.1, 1] }}
          transition={{ duration: 15, repeat: Infinity, ease: 'easeInOut' }}
          className="absolute top-0 start-1/4 w-96 h-96 bg-emerald-200/40 dark:bg-emerald-800/15 rounded-full blur-3xl"
        />
        <motion.div
          animate={{ x: [0, -20, 0], y: [0, 30, 0] }}
          transition={{ duration: 18, repeat: Infinity, ease: 'easeInOut', delay: 2 }}
          className="absolute bottom-1/4 end-1/4 w-80 h-80 bg-teal-200/40 dark:bg-teal-800/15 rounded-full blur-3xl"
        />
        <motion.div
          animate={{ scale: [1, 1.2, 1] }}
          transition={{ duration: 12, repeat: Infinity, ease: 'easeInOut' }}
          className="absolute top-1/2 start-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] bg-emerald-300/10 dark:bg-emerald-700/5 rounded-full blur-3xl"
        />
        {/* Additional mesh layer: cyan blob */}
        <motion.div
          animate={{ x: [0, 25, -10, 15, 0], y: [0, -15, 25, -10, 0], scale: [1, 1.15, 0.95, 1.1, 1] }}
          transition={{ duration: 20, repeat: Infinity, ease: 'easeInOut', delay: 4 }}
          className="absolute top-[10%] end-[15%] w-72 h-72 bg-cyan-200/25 dark:bg-cyan-800/10 rounded-full blur-3xl"
        />
        {/* Additional mesh layer: teal mid-section blob */}
        <motion.div
          animate={{ x: [0, -15, 20, -8, 0], y: [0, 20, -10, 15, 0] }}
          transition={{ duration: 16, repeat: Infinity, ease: 'easeInOut', delay: 6 }}
          className="absolute top-[60%] start-[10%] w-64 h-64 bg-teal-200/20 dark:bg-teal-800/8 rounded-full blur-3xl"
        />
      </div>

      {/* Floating glass orbs with glass-morphism */}
      <div className="absolute inset-0 pointer-events-none overflow-hidden">
        <motion.div
          animate={{ y: [0, -25, 0], x: [0, 15, 0] }}
          transition={{ duration: 8, repeat: Infinity, ease: 'easeInOut' }}
          className="absolute top-[12%] start-[5%] w-20 h-20 rounded-full glass-orb shadow-lg"
        />
        <motion.div
          animate={{ y: [0, 20, 0], x: [0, -12, 0] }}
          transition={{ duration: 10, repeat: Infinity, ease: 'easeInOut', delay: 1 }}
          className="absolute top-[22%] end-[10%] w-16 h-16 rounded-full glass-orb shadow-lg"
        />
        <motion.div
          animate={{ y: [0, -15, 0], x: [0, 8, 0] }}
          transition={{ duration: 7, repeat: Infinity, ease: 'easeInOut', delay: 3 }}
          className="absolute top-[55%] end-[6%] w-14 h-14 rounded-full glass-orb shadow-lg"
        />
        <motion.div
          animate={{ y: [0, 18, 0], x: [0, -10, 0] }}
          transition={{ duration: 9, repeat: Infinity, ease: 'easeInOut', delay: 2 }}
          className="absolute top-[70%] start-[12%] w-12 h-12 rounded-full glass-orb shadow-lg"
        />
        {/* Small decorative dots */}
        <motion.div
          animate={{ y: [0, -12, 0] }}
          transition={{ duration: 5, repeat: Infinity, ease: 'easeInOut', delay: 2 }}
          className="absolute top-[40%] start-[15%] w-2 h-2 rounded-full bg-emerald-400/30 dark:bg-emerald-500/20"
        />
        <motion.div
          animate={{ y: [0, 10, 0], x: [0, -6, 0] }}
          transition={{ duration: 9, repeat: Infinity, ease: 'easeInOut', delay: 4 }}
          className="absolute top-[35%] start-[30%] w-1.5 h-1.5 rounded-full bg-teal-400/25 dark:bg-teal-500/10"
        />
        {/* Floating diamonds */}
        <motion.div
          animate={{ y: [0, -10, 0], rotate: [0, 180, 360] }}
          transition={{ duration: 12, repeat: Infinity, ease: 'linear', delay: 3 }}
          className="absolute top-[20%] end-[25%] w-6 h-6 rounded-md border border-emerald-300/30 dark:border-emerald-700/20 rotate-45"
        />
        <motion.div
          animate={{ y: [0, 14, 0], rotate: [0, -180, -360] }}
          transition={{ duration: 10, repeat: Infinity, ease: 'linear', delay: 1.5 }}
          className="absolute top-[50%] start-[5%] w-4 h-4 rounded-md border border-teal-300/25 dark:border-teal-700/15 rotate-12"
        />
      </div>

      {/* ─── Top Bar (Sticky with scroll-based background) ─────── */}
      <header
        className={`w-full px-4 py-3 flex items-center justify-between sticky top-0 z-50 transition-all duration-300 ${
          scrolled
            ? 'bg-white/80 dark:bg-gray-950/80 backdrop-blur-xl shadow-sm'
            : 'bg-transparent'
        }`}
      >
        <div className="flex items-center gap-2">
          <motion.div
            initial={{ scale: 0 }}
            animate={{ scale: 1, rotate: [0, 10, -10, 0] }}
            transition={{ duration: 0.6, delay: 0.1 , ease: 'easeInOut' }}
            className="h-10 w-10 rounded-2xl overflow-hidden shadow-lg shadow-emerald-500/25"
          >
            <img src="/logo.png" alt="BLASTI" width={48} height={48} className="h-full w-full object-contain" />
          </motion.div>
          <span className="font-bold text-lg bg-gradient-to-r from-emerald-700 to-teal-600 dark:from-emerald-400 dark:to-teal-300 bg-clip-text text-transparent">
            BLASTI
          </span>
        </div>

        {/* Desktop Navigation Links */}
        <nav className="hidden md:flex items-center gap-6">
          <button
            onClick={() => scrollToSection('features')}
            className="text-sm text-muted-foreground hover:text-emerald-600 transition-colors"
          >
            {t('learnMore')}
          </button>
          <button
            onClick={() => scrollToSection('how-it-works')}
            className="text-sm text-muted-foreground hover:text-emerald-600 transition-colors"
          >
            {t('howItWorks')}
          </button>
          <button
            onClick={() => scrollToSection('testimonials')}
            className="text-sm text-muted-foreground hover:text-emerald-600 transition-colors"
          >
            {t('testimonialsTitle')}
          </button>
        </nav>

        <div className="flex items-center gap-1">
          <LanguageSwitcher />
          <ThemeToggle />
          {/* Mobile hamburger menu button */}
          <button
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
            className="md:hidden ms-1 p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
            aria-label={mobileMenuOpen ? 'Close menu' : 'Open menu'}
          >
            {mobileMenuOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
        </div>
      </header>

      {/* Mobile Navigation Dropdown */}
      <AnimatePresence>
        {mobileMenuOpen && (
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.2 }}
            className="fixed top-[56px] start-0 end-0 z-40 bg-white/95 dark:bg-gray-950/95 backdrop-blur-xl shadow-md md:hidden"
          >
            <nav className="flex flex-col p-4 gap-3">
              <button
                onClick={() => scrollToSection('features')}
                className="text-sm text-muted-foreground hover:text-emerald-600 transition-colors text-start py-2"
              >
                {t('learnMore')}
              </button>
              <button
                onClick={() => scrollToSection('how-it-works')}
                className="text-sm text-muted-foreground hover:text-emerald-600 transition-colors text-start py-2"
              >
                {t('howItWorks')}
              </button>
              <button
                onClick={() => scrollToSection('testimonials')}
                className="text-sm text-muted-foreground hover:text-emerald-600 transition-colors text-start py-2"
              >
                {t('testimonialsTitle')}
              </button>
            </nav>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ─── Hero Section ──────────────────────────── */}
      <section id="hero" className="flex-1 flex flex-col items-center justify-center px-4 py-20 md:py-24 relative z-10 overflow-hidden">
        {/* Animated gradient background with emerald/teal/cyan palette */}
        <div className="absolute inset-0 -z-20 hero-animated-gradient" />
        {/* Additional animated gradient layer */}
        <motion.div
          className="absolute inset-0 -z-10"
          animate={{
            background: [
              'radial-gradient(ellipse at 20% 50%, rgba(6,182,212,0.08) 0%, transparent 50%)',
              'radial-gradient(ellipse at 80% 50%, rgba(16,185,129,0.08) 0%, transparent 50%)',
              'radial-gradient(ellipse at 50% 20%, rgba(20,184,166,0.08) 0%, transparent 50%)',
              'radial-gradient(ellipse at 20% 50%, rgba(6,182,212,0.08) 0%, transparent 50%)',
            ],
          }}
          transition={{ duration: 10, repeat: Infinity, ease: 'easeInOut' }}
        />
        {/* CSS-only floating bubbles */}
        <div className="absolute inset-0 -z-5 pointer-events-none">
          <div className="landing-bubble absolute top-[10%] start-[8%] w-4 h-4 bg-emerald-400/20 dark:bg-emerald-500/10" style={{ animationDelay: '0s' }} />
          <div className="landing-bubble absolute top-[25%] end-[12%] w-3 h-3 bg-teal-400/15 dark:bg-teal-500/8" style={{ animationDelay: '1.5s' }} />
          <div className="landing-bubble-slow absolute top-[60%] start-[15%] w-5 h-5 bg-cyan-400/15 dark:bg-cyan-500/8" style={{ animationDelay: '3s' }} />
          <div className="landing-bubble absolute top-[40%] end-[8%] w-3.5 h-3.5 bg-emerald-300/20 dark:bg-emerald-600/8" style={{ animationDelay: '2s' }} />
          <div className="landing-bubble-slow absolute top-[75%] start-[25%] w-2.5 h-2.5 bg-teal-300/15 dark:bg-teal-600/6" style={{ animationDelay: '4s' }} />
          <div className="landing-bubble absolute top-[15%] end-[30%] w-2 h-2 bg-cyan-300/20 dark:bg-cyan-600/8" style={{ animationDelay: '0.5s' }} />
        </div>
        <HeroParticles />

        <div className="text-center max-w-2xl mx-auto lg:flex lg:items-center lg:gap-12 lg:max-w-5xl lg:text-start">
          <motion.div
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6 }}
            className="flex-1"
          >
            {/* Floating Hero Icon */}
            <motion.div
              animate={{ y: [0, -14, 0], rotate: [0, 3, -3, 0] }}
              transition={{ duration: 4, repeat: Infinity, ease: 'easeInOut' }}
              className="inline-flex mb-4 lg:mb-6"
            >
              <div className="relative">
                <motion.div
                  animate={{ scale: [1, 1.15, 1], opacity: [0.3, 0.6, 0.3] }}
                  transition={{ duration: 3, repeat: Infinity, ease: 'easeInOut' }}
                  className="absolute inset-0 rounded-3xl bg-gradient-to-br from-emerald-400 to-teal-500 blur-xl"
                />
                {/* Rotating ring around icon */}
                <motion.div
                  animate={{ rotate: 360 }}
                  transition={{ duration: 20, repeat: Infinity, ease: 'linear' }}
                  className="absolute -inset-3 rounded-[1.75rem] border border-dashed border-emerald-300/30 dark:border-emerald-600/20"
                />
                <div className="relative h-18 w-18 md:h-24 md:w-24 rounded-3xl bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center shadow-2xl shadow-emerald-500/40">
                  <Zap className="h-9 w-9 md:h-12 md:w-12 text-white" />
                </div>
              </div>
            </motion.div>

            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, delay: 0.15 }}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-emerald-50 dark:bg-emerald-950/50 text-emerald-700 dark:text-emerald-300 text-sm font-medium mb-6 border border-emerald-200/50 dark:border-emerald-800/50"
            >
              <motion.div
                animate={{ rotate: [0, 15, -15, 0] }}
                transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut', repeatDelay: 3 }}
              >
                <TicketCheck className="h-4 w-4" />
              </motion.div>
              {t('appTagline')}
            </motion.div>

            {/* Enhanced gradient title with pulse animation */}
            <motion.h1
              className="text-3xl md:text-5xl lg:text-7xl font-black tracking-tight mb-4 md:mb-6 leading-[1.1] relative hero-heading-pulse"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.7, delay: 0.2 }}
            >
              {/* Main gradient text with built-in depth shadow */}
              <span className="hero-gradient-title">
                {t('heroTitle')}
              </span>
            </motion.h1>

            <motion.p
              className="text-base md:text-lg lg:text-xl text-muted-foreground mb-6 md:mb-10 max-w-2xl mx-auto lg:mx-0 leading-relaxed"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, delay: 0.35 }}
            >
              {t('heroSubtitle')}
            </motion.p>

            <motion.div
              className="flex flex-col sm:flex-row gap-3 md:gap-4 justify-center lg:justify-start"
              initial={{ opacity: 0, y: 15 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, delay: 0.5 }}
            >
              {/* Primary CTA with enhanced sweep and glow */}
              <motion.div whileHover={{ scale: 1.08, y: -4 }} whileTap={{ scale: 0.97 }}>
                <div className="relative rounded-2xl p-[2px] bg-gradient-to-r from-emerald-400 via-teal-400 to-emerald-500 cta-pulse-glow-enhanced">
                  <Button
                    size="lg"
                    className="relative bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white font-bold px-8 md:px-10 py-6 md:py-7 text-base md:text-lg rounded-2xl shadow-xl shadow-emerald-500/30 min-h-12 md:min-h-14 hover:shadow-2xl hover:shadow-emerald-500/50 transition-all duration-300 w-full sm:w-auto overflow-hidden group"
                    onClick={() => setView('register')}
                  >
                    {/* Sweep shine effect */}
                    <span className="absolute inset-0 -translate-x-full group-hover:translate-x-full transition-transform duration-700 bg-gradient-to-r from-transparent via-white/25 to-transparent" />
                    <span className="relative flex items-center">
                      {t('getStarted')}
                      <motion.span
                        animate={{ x: [0, 4, 0] }}
                        transition={{ duration: 1.5, repeat: Infinity, ease: 'easeInOut' }}
                        className="inline-flex ms-2"
                      >
                        <ArrowRight className="h-5 w-5 rtl:rotate-180" />
                      </motion.span>
                    </span>
                  </Button>
                </div>
              </motion.div>
              {/* Secondary CTA with glow border effect */}
              <motion.div whileHover={{ scale: 1.08, y: -4 }} whileTap={{ scale: 0.97 }}>
                <Button
                  size="lg"
                  variant="outline"
                  className="relative font-bold px-8 md:px-10 py-6 md:py-7 text-base md:text-lg rounded-2xl min-h-12 md:min-h-14 hover:bg-emerald-50 dark:hover:bg-emerald-950/30 transition-all duration-300 border-2 hover:border-emerald-300 dark:hover:border-emerald-700 hover:shadow-lg hover:shadow-emerald-500/10 w-full sm:w-auto overflow-hidden group cta-pulse-glow-secondary"
                  onClick={() => setView('login')}
                >
                  {/* Subtle sweep effect */}
                  <span className="absolute inset-0 -translate-x-full group-hover:translate-x-full transition-transform duration-700 bg-gradient-to-r from-transparent via-emerald-500/5 to-transparent" />
                  <span className="relative">{t('login')}</span>
                </Button>
              </motion.div>
            </motion.div>

          </motion.div>

          {/* Phone Mockup - visible on desktop */}
          <PhoneMockup />
        </div>

        {/* Scroll indicator */}
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 2, duration: 0.8 }}
          className="absolute bottom-8 left-1/2 -translate-x-1/2 flex flex-col items-center gap-2 z-20"
        >
          <span className="text-[10px] text-muted-foreground/60 font-medium tracking-wider uppercase">{'اكتشف المزيد'}</span>
          <motion.div
            animate={{ y: [0, 8, 0] }}
            transition={{ duration: 1.8, repeat: Infinity, ease: 'easeInOut' }}
            className="flex flex-col items-center"
          >
            <div className="h-10 w-6 rounded-full border-2 border-emerald-300/50 dark:border-emerald-700/40 flex items-start justify-center p-1.5">
              <motion.div
                animate={{ y: [0, 12, 0], opacity: [1, 0.3, 1] }}
                transition={{ duration: 1.8, repeat: Infinity, ease: 'easeInOut' }}
                className="h-2 w-1.5 rounded-full bg-emerald-400 dark:bg-emerald-500"
              />
            </div>
          </motion.div>
        </motion.div>
      </section>

      {/* ─── Features Grid ─────────────────────────── */}
      <section id="features" className="w-full px-4 py-20 md:py-24 relative z-10">
        <motion.div
          initial={{ opacity: 0, y: 40 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-80px' }}
          transition={{ duration: 0.6 }}
          className="max-w-3xl mx-auto"
        >
          <motion.h2
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            className="text-2xl md:text-3xl font-bold text-center mb-3 shimmer-text"
          >
            {t('learnMore')}
          </motion.h2>
          <div className="h-1 w-16 mx-auto rounded-full gradient-flow-bar mb-12" />

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
            {features.map((feature, idx) => {
              const Icon = feature.icon;
              return (
                <motion.div
                  key={idx}
                  initial={{ opacity: 0, y: 30, scale: 0.95 }}
                  whileInView={{ opacity: 1, y: 0, scale: 1 }}
                  viewport={{ once: true, margin: '-30px' }}
                  transition={{ duration: 0.5, delay: idx * 0.15 }}
                  whileHover={{ y: -12, scale: 1.05 }}
                  className="cursor-default group relative"
                >
                  {/* Gradient border wrapper - visible on hover */}
                  <div className="absolute -inset-[1px] rounded-2xl bg-gradient-to-br from-emerald-400/0 via-teal-400/0 to-emerald-400/0 group-hover:from-emerald-400/60 group-hover:via-teal-400/40 group-hover:to-emerald-400/60 transition-all duration-500 blur-[1px]" />
                  
                  <div className="glass-feature-card rounded-2xl p-5 h-full relative overflow-hidden">
                    {/* Glow effect on hover */}
                    <div className="absolute inset-0 bg-gradient-to-br from-emerald-500/0 via-teal-500/0 to-emerald-500/0 group-hover:from-emerald-500/5 group-hover:via-teal-500/5 group-hover:to-emerald-500/5 transition-all duration-500 rounded-2xl" />
                    {/* Top accent line */}
                    <div className="absolute top-0 start-0 w-full h-[2px] bg-gradient-to-r from-transparent via-emerald-400/0 to-transparent group-hover:via-emerald-400/60 transition-all duration-500" />
                    {/* Bottom accent line */}
                    <div className="absolute bottom-0 start-0 w-full h-[2px] bg-gradient-to-r from-transparent via-teal-400/0 to-transparent group-hover:via-teal-400/40 transition-all duration-500 delay-100" />
                    
                    <div className="flex items-start gap-4 relative z-10">
                      <motion.div
                        className="flex-shrink-0 h-14 w-14 rounded-full feature-icon-circle flex items-center justify-center group-hover:shadow-lg group-hover:shadow-emerald-500/15 transition-all duration-300 relative"
                        whileInView={{ scale: [0.8, 1.1, 1] }}
                        viewport={{ once: true }}
                        transition={{ duration: 0.4, delay: 0.2 + idx * 0.1 }}
                      >
                        {/* Continuous floating animation */}
                        <motion.div
                          animate={{ y: [0, -3, 0] }}
                          transition={{ duration: 2.5 + idx * 0.3, repeat: Infinity, ease: 'easeInOut', delay: idx * 0.5 }}
                          className="flex items-center justify-center"
                        >
                          <Icon className="h-6 w-6 text-emerald-600 dark:text-emerald-400" />
                        </motion.div>
                        {/* Pulse ring around icon */}
                        <motion.div
                          className="absolute inset-0 rounded-full border-2 border-emerald-400/0 group-hover:border-emerald-400/40"
                          animate={{
                            scale: [1, 1.3, 1],
                            opacity: [0, 0.5, 0],
                          }}
                          transition={{
                            duration: 2,
                            repeat: Infinity,
                            ease: 'easeInOut',
                            delay: idx * 0.4,
                          }}
                        />
                      </motion.div>
                      <div>
                        <h3 className="font-semibold text-sm text-foreground mb-1 group-hover:text-emerald-600 dark:group-hover:text-emerald-400 transition-colors">
                          {t(feature.titleKey)}
                        </h3>
                        <p className="text-xs text-muted-foreground leading-relaxed">
                          {t(feature.descKey)}
                        </p>
                      </div>
                    </div>
                  </div>
                </motion.div>
              );
            })}
          </div>
        </motion.div>
      </section>

      {/* ─── Statistics Banner ──────────────────────── */}
      <motion.section
        id="stats"
        ref={statsRef}
        initial={{ opacity: 0, y: 20 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: '-50px' }}
        transition={{ duration: 0.5 }}
        className="w-full px-4 py-10 relative z-10"
      >
        <div className="max-w-3xl mx-auto">
          <div className="relative rounded-3xl overflow-hidden landing-stats-bg p-1">
            {/* Animated shine overlay */}
            <motion.div
              animate={{ backgroundPosition: ['0% 0%', '200% 0%'] }}
              transition={{ duration: 4, repeat: Infinity, ease: 'linear' }}
              className="absolute inset-0 bg-[length:200%_100%] bg-gradient-to-r from-emerald-300 via-teal-300 to-amber-300 opacity-20 rounded-3xl"
            />
            {/* Decorative mesh blobs inside stats card */}
            <motion.div
              animate={{ x: [0, 20, 0], y: [0, -10, 0] }}
              transition={{ duration: 10, repeat: Infinity, ease: 'easeInOut' }}
              className="absolute top-0 start-0 w-40 h-40 bg-white/5 rounded-full blur-2xl"
            />
            <motion.div
              animate={{ x: [0, -15, 0], y: [0, 15, 0] }}
              transition={{ duration: 12, repeat: Infinity, ease: 'easeInOut', delay: 2 }}
              className="absolute bottom-0 end-0 w-52 h-52 bg-teal-400/10 rounded-full blur-2xl"
            />
            <div className="relative rounded-[22px] bg-gradient-to-r from-emerald-600/90 to-teal-600/90 backdrop-blur-sm p-8 md:p-10 overflow-hidden">
              {/* Grid pattern overlay */}
              <div
                className="absolute inset-0 opacity-[0.03]"
                style={{
                  backgroundImage: `radial-gradient(circle at 1px 1px, white 1px, transparent 0)`,
                  backgroundSize: '24px 24px',
                }}
              />
              <div className="grid grid-cols-2 md:grid-cols-4 gap-6 text-center relative z-10">
                {stats.map((stat, idx) => {
                  const Icon = stat.icon;
                  const statDecimals = 'decimals' in stat ? (stat as { decimals?: number }).decimals : 0;
                  return (
                    <motion.div
                      key={idx}
                      initial={{ opacity: 0, scale: 0.5, y: 20 }}
                      whileInView={{ opacity: 1, scale: 1, y: 0 }}
                      viewport={{ once: true }}
                      transition={{ duration: 0.6, delay: idx * 0.15, type: 'spring', stiffness: 200 }}
                      className="flex flex-col items-center gap-3 group"
                    >
                      <motion.div
                        className="h-14 w-14 rounded-2xl bg-white/15 backdrop-blur-sm flex items-center justify-center border border-white/10 relative"
                        whileHover={{ scale: 1.1, rotate: [0, -5, 5, 0] }}
                        transition={{ duration: 0.3 }}
                      >
                        {/* Pulse ring behind icon */}
                        <motion.div
                          className="absolute inset-0 rounded-2xl bg-white/10"
                          animate={{ scale: [1, 1.4, 1], opacity: [0.3, 0, 0.3] }}
                          transition={{ duration: 3, repeat: Infinity, ease: 'easeInOut', delay: idx * 0.7 }}
                        />
                        <Icon className="h-6 w-6 text-white relative z-10" />
                      </motion.div>
                      <p className="text-3xl md:text-4xl font-black text-white">
                        <AnimatedCounter target={stat.value} suffix={stat.suffix} decimals={statDecimals} />
                      </p>
                      <p className="text-xs text-emerald-100 font-medium uppercase tracking-wider">{t(stat.labelKey)}</p>
                    </motion.div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      </motion.section>

      {/* ─── How It Works ──────────────────────────── */}
      <section id="how-it-works" className="w-full px-4 py-20 md:py-24 relative z-10">
        <motion.div
          initial={{ opacity: 0, y: 30 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-50px' }}
          transition={{ duration: 0.6 }}
          className="max-w-3xl mx-auto"
        >
          <h2 className="text-2xl md:text-3xl font-bold text-center mb-3 shimmer-text">
            {t('howItWorks')}
          </h2>
          <p className="text-sm text-muted-foreground text-center mb-14 max-w-md mx-auto">{t('howItWorksDesc') || ''}</p>

          <div className="flex flex-col md:flex-row items-center md:items-start gap-10 md:gap-0">
            {steps.map((step, idx) => {
              const Icon = step.icon;
              return (
                <motion.div
                  key={idx}
                  initial={{ opacity: 0, y: 30 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true, margin: '-30px' }}
                  transition={{ duration: 0.6, delay: idx * 0.25 }}
                  className="flex-1 flex flex-col items-center text-center relative group cursor-default"
                >
                  {/* SVG animated dashed connector with flowing dots (desktop) */}
                  {idx < steps.length - 1 && (
                    <div className="hidden md:block absolute top-10 start-[calc(50%+3rem)] end-[calc(-50%+3rem)] z-0">
                      <svg className="w-full h-4 overflow-visible" preserveAspectRatio="none">
                        <motion.line
                          x1="0" y1="8" x2="100%" y2="8"
                          stroke="url(#stepGradient)"
                          strokeWidth="2"
                          strokeDasharray="6 4"
                          initial={{ pathLength: 0, opacity: 0.3 }}
                          whileInView={{ pathLength: 1, opacity: 1 }}
                          viewport={{ once: true }}
                          transition={{ duration: 1.5, delay: 0.5 + idx * 0.3 }}
                        />
                        <defs>
                          <linearGradient id="stepGradient" x1="0%" y1="0%" x2="100%" y2="0%">
                            <stop offset="0%" stopColor="#10b981" stopOpacity="0.8" />
                            <stop offset="50%" stopColor="#14b8a6" stopOpacity="0.4" />
                            <stop offset="100%" stopColor="#10b981" stopOpacity="0.8" />
                          </linearGradient>
                        </defs>
                      </svg>
                      {/* Animated flowing dot along the line */}
                      <motion.div
                        className="absolute top-1/2 -translate-y-1/2"
                        initial={{ left: '0%' }}
                        animate={{ left: ['0%', '100%'] }}
                        transition={{ duration: 2, repeat: Infinity, ease: 'linear', delay: 1 + idx * 0.3 }}
                      >
                        <div className="h-2 w-2 rounded-full bg-emerald-400 shadow-sm shadow-emerald-400/60" />
                      </motion.div>
                      {/* Arrow dot at end */}
                      <motion.div
                        className="absolute end-0 top-1/2 -translate-y-1/2"
                        initial={{ scale: 0 }}
                        whileInView={{ scale: 1 }}
                        viewport={{ once: true }}
                        transition={{ duration: 0.3, delay: 1.5 + idx * 0.3 }}
                      >
                        <div className="h-2.5 w-2.5 rounded-full bg-teal-400 dark:bg-teal-500 shadow-sm shadow-teal-400/50 rtl:rotate-180" />
                      </motion.div>
                    </div>
                  )}
                  {/* Vertical connector with flowing dot (mobile) */}
                  {idx < steps.length - 1 && (
                    <div className="md:hidden flex flex-col items-center mt-4 mb-2 relative">
                      <svg width="2" height="32" className="overflow-visible">
                        <motion.line
                          x1="1" y1="0" x2="1" y2="32"
                          stroke="#10b981"
                          strokeWidth="2"
                          strokeDasharray="4 3"
                          initial={{ pathLength: 0 }}
                          whileInView={{ pathLength: 1 }}
                          viewport={{ once: true }}
                          transition={{ duration: 0.8, delay: 0.5 + idx * 0.2 }}
                        />
                      </svg>
                      {/* Flowing dot */}
                      <motion.div
                        className="absolute"
                        animate={{ top: ['0%', '100%'] }}
                        transition={{ duration: 1.5, repeat: Infinity, ease: 'linear', delay: 1 + idx * 0.2 }}
                      >
                        <div className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                      </motion.div>
                      <motion.div
                        className="h-2 w-2 rounded-full bg-teal-400 dark:bg-teal-500 -mt-1 shadow-sm shadow-teal-400/50"
                        initial={{ scale: 0 }}
                        whileInView={{ scale: 1 }}
                        viewport={{ once: true }}
                        transition={{ delay: 1 + idx * 0.2 }}
                      />
                    </div>
                  )}

                  {/* Step icon with gradient circle + enhanced bounce */}
                  <motion.div
                    className="relative group-hover:scale-110 transition-all duration-300"
                    whileInView={{ scale: [0.5, 1.2, 0.9, 1] }}
                    viewport={{ once: true }}
                    transition={{ duration: 0.6, delay: 0.3 + idx * 0.25 }}
                  >
                    {/* Outer pulse ring */}
                    <motion.div
                      className="absolute inset-0 rounded-2xl bg-emerald-400/20 dark:bg-emerald-500/10"
                      animate={{ scale: [1, 1.3, 1], opacity: [0.3, 0, 0.3] }}
                      transition={{ duration: 2.5, repeat: Infinity, ease: 'easeInOut', delay: idx * 0.5 }}
                    />
                    {/* Second pulse ring (staggered) */}
                    <motion.div
                      className="absolute inset-0 rounded-2xl bg-teal-400/15 dark:bg-teal-500/8"
                      animate={{ scale: [1, 1.4, 1], opacity: [0.2, 0, 0.2] }}
                      transition={{ duration: 3, repeat: Infinity, ease: 'easeInOut', delay: idx * 0.5 + 1.25 }}
                    />
                    <div className="relative h-16 w-16 rounded-2xl bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center shadow-lg shadow-emerald-500/25 group-hover:shadow-xl group-hover:shadow-emerald-500/35 transition-shadow duration-300">
                      <Icon className="h-7 w-7 text-white" />
                    </div>
                    {/* Step number with enhanced gradient badge */}
                    <motion.div
                      className="absolute -top-2.5 -end-2.5 h-8 w-8 rounded-full flex items-center justify-center text-xs font-bold shadow-lg step-number-badge"
                      initial={{ scale: 0, rotate: -180 }}
                      whileInView={{ scale: [0, 1.3, 1], rotate: 0 }}
                      viewport={{ once: true }}
                      transition={{ duration: 0.5, delay: 0.5 + idx * 0.25 }}
                    >
                      {idx + 1}
                    </motion.div>
                  </motion.div>

                  {/* Step text card with enhanced glassmorphism and gradient border */}
                  <motion.div
                    className="mt-5 p-4 rounded-2xl glass-feature-card max-w-[220px] group-hover:shadow-lg group-hover:shadow-emerald-500/5 transition-shadow duration-300 step-card-gradient-border"
                    initial={{ opacity: 0, y: 10 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={{ once: true }}
                    transition={{ duration: 0.4, delay: 0.6 + idx * 0.25 }}
                  >
                    <h3 className="font-semibold text-sm text-foreground group-hover:text-emerald-600 dark:group-hover:text-emerald-400 transition-colors duration-300">
                      {t(step.titleKey)}
                    </h3>
                    <p className="mt-1 text-xs text-muted-foreground leading-relaxed">
                      {t(step.descKey)}
                    </p>
                  </motion.div>
                </motion.div>
              );
            })}
          </div>
        </motion.div>
      </section>

      {/* ─── Testimonials Section ──────────────────── */}
      <section id="testimonials" className="w-full px-4 py-20 md:py-24 relative z-10">
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
                transition={{ duration: 0.5, delay: idx * 0.12 }}
                whileHover={{ y: -8, scale: 1.02 }}
                className="cursor-default"
              >
                <div className="glass-feature-card rounded-2xl p-6 h-full flex flex-col relative overflow-hidden group">
                  {/* Decorative quote mark */}
                  <div className="absolute top-3 end-3 opacity-10 dark:opacity-5 group-hover:opacity-20 transition-opacity">
                    <Quote className="h-16 w-16 text-emerald-500" />
                  </div>
                  {/* Star rating with animated stars */}
                  <div className="flex gap-0.5 mb-3">
                    {[...Array(5)].map((_, i) => (
                      <motion.div
                        key={i}
                        initial={{ opacity: 0, scale: 0, rotate: -20 }}
                        whileInView={{ opacity: 1, scale: 1, rotate: 0 }}
                        viewport={{ once: true }}
                        transition={{ duration: 0.3, delay: 0.3 + idx * 0.1 + i * 0.05, type: 'spring', stiffness: 300 }}
                      >
                        <Star className="h-4 w-4 text-amber-400 fill-amber-400" />
                      </motion.div>
                    ))}
                  </div>
                  <p className="text-sm text-muted-foreground leading-relaxed mb-5 flex-1 relative z-10">
                    &ldquo;{t(testimonial.textKey)}&rdquo;
                  </p>
                  <div className="flex items-center gap-3 pt-4 border-t border-gray-100/50 dark:border-gray-800/50">
                    {/* Avatar with gradient border */}
                    <div className="p-[2.5px] rounded-full bg-gradient-to-br from-emerald-400 via-teal-400 to-emerald-500 flex-shrink-0 shadow-lg group-hover:shadow-xl group-hover:shadow-emerald-500/20 transition-shadow duration-300">
                      <div className="h-11 w-11 rounded-full bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center text-white text-sm font-bold ring-2 ring-white/30 dark:ring-gray-900/30">
                        {t(testimonial.nameKey).charAt(0)}
                      </div>
                    </div>
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

          {/* Mobile: Single testimonial with auto-rotate */}
          <div className="md:hidden">
            <AnimatePresence mode="wait">
              <motion.div
                key={activeTestimonial}
                initial={{ opacity: 0, x: 50, scale: 0.95 }}
                animate={{ opacity: 1, x: 0, scale: 1 }}
                exit={{ opacity: 0, x: -50, scale: 0.95 }}
                transition={{ duration: 0.4 }}
                className="glass-feature-card rounded-2xl p-6 relative overflow-hidden"
              >
                {/* Decorative quote mark */}
                <div className="absolute top-3 end-3 opacity-10 dark:opacity-5">
                  <Quote className="h-16 w-16 text-emerald-500" />
                </div>
                {/* Star rating */}
                <div className="flex gap-0.5 mb-3">
                  {[...Array(5)].map((_, i) => (
                    <Star key={i} className="h-4 w-4 text-amber-400 fill-amber-400" />
                  ))}
                </div>
                <p className="text-sm text-muted-foreground leading-relaxed mb-5 relative z-10">
                  &ldquo;{t(testimonials[activeTestimonial].textKey)}&rdquo;
                </p>
                <div className="flex items-center gap-3 pt-4 border-t border-gray-100/50 dark:border-gray-800/50">
                  <div className="p-[2.5px] rounded-full bg-gradient-to-br from-emerald-400 via-teal-400 to-emerald-500 flex-shrink-0 shadow-lg ring-2 ring-white/20">
                    <div className="h-11 w-11 rounded-full bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center text-white text-sm font-bold">
                      {t(testimonials[activeTestimonial].nameKey).charAt(0)}
                    </div>
                  </div>
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
            {/* Dots indicator */}
            <div className="flex justify-center gap-2 mt-5">
              {testimonials.map((_, i) => (
                <button
                  key={`dot-${i}`}
                  onClick={() => setActiveTestimonial(i)}
                  className={`h-2 rounded-full transition-all duration-300 ${i === activeTestimonial ? 'w-8 bg-emerald-500' : 'w-2 bg-emerald-300/40 dark:bg-emerald-700/40'}`}
                  aria-label={`Testimonial ${i + 1}`}
                />
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ─── Floating Testimonials Carousel ─────────── */}
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
                        <div className="p-[2px] rounded-full bg-gradient-to-br from-emerald-400 via-teal-400 to-emerald-500 flex-shrink-0">
                          <div className="h-10 w-10 rounded-full bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center text-white text-sm font-bold ring-2 ring-white/30 dark:ring-gray-900/30">
                            {t(testimonial.nameKey).charAt(0)}
                          </div>
                        </div>
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

      {/* ─── Trusted By Section ──────────────────────── */}
      <section id="trusted" ref={trustedRef} className="w-full px-4 py-16 relative z-10">
        <div className="max-w-3xl mx-auto">
          <motion.div
            initial={{ opacity: 0, y: 15 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.5 }}
            className="text-center"
          >
            <p className="text-sm font-medium text-muted-foreground mb-6 uppercase tracking-wider">
              {t('trustedBy')}
            </p>
            <div className="flex items-center justify-center gap-6 md:gap-10 flex-wrap">
              {trustedCategories.map((cat, idx) => {
                const Icon = cat.icon;
                return (
                  <motion.div
                    key={idx}
                    initial={{ opacity: 0, scale: 0.8 }}
                    whileInView={{ opacity: 1, scale: 1 }}
                    viewport={{ once: true }}
                    transition={{ duration: 0.3, delay: idx * 0.08 }}
                    whileHover={{ scale: 1.1, y: -4 }}
                    className="flex flex-col items-center gap-2 cursor-default"
                  >
                    <div className="h-14 w-14 rounded-2xl glass-feature-card flex items-center justify-center">
                      <Icon className="h-6 w-6 text-emerald-600 dark:text-emerald-400" />
                    </div>
                    <span className="text-xs font-medium text-muted-foreground">
                      {t(cat.labelKey)}
                    </span>
                  </motion.div>
                );
              })}
            </div>
          </motion.div>
        </div>
      </section>

      {/* ─── Platform Download Section ──────────────── */}
      <DownloadSection />

      {/* ─── Enhanced CTA Section ──────────────────── */}
      <motion.section
        initial={{ opacity: 0, y: 40 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: '-80px' }}
        transition={{ duration: 0.7 }}
        className="w-full px-4 py-20 md:py-28 relative z-10"
      >
        <div className="max-w-4xl mx-auto">
          <div className="cta-section-gradient rounded-3xl p-8 md:p-14 relative overflow-hidden">
            {/* Grid pattern overlay */}
            <div
              className="absolute inset-0 opacity-[0.04]"
              style={{
                backgroundImage: `radial-gradient(circle at 1px 1px, white 1px, transparent 0)`,
                backgroundSize: '28px 28px',
              }}
            />
            {/* Floating decorative elements */}
            <div className="absolute inset-0 pointer-events-none">
              <div className="cta-float-element absolute top-[15%] start-[8%] w-16 h-16 rounded-full border border-white/10 bg-white/5 blur-sm" />
              <div className="cta-float-element-reverse absolute bottom-[20%] end-[10%] w-20 h-20 rounded-full border border-white/10 bg-white/5 blur-sm" />
              <div className="cta-float-element absolute top-[60%] start-[20%] w-10 h-10 rounded-full border border-white/8 bg-white/3" />
              <div className="cta-float-element-reverse absolute top-[10%] end-[25%] w-8 h-8 rounded-md border border-white/10 bg-white/5 rotate-45" />
              <div className="cta-float-element absolute bottom-[10%] start-[40%] w-6 h-6 rounded-full border border-teal-300/20 bg-teal-400/10" />
              {/* Large blurred orbs */}
              <motion.div
                animate={{ x: [0, 15, 0], y: [0, -10, 0], scale: [1, 1.1, 1] }}
                transition={{ duration: 10, repeat: Infinity, ease: 'easeInOut' }}
                className="absolute top-0 start-0 w-40 h-40 bg-teal-300/10 rounded-full blur-3xl"
              />
              <motion.div
                animate={{ x: [0, -10, 0], y: [0, 15, 0] }}
                transition={{ duration: 12, repeat: Infinity, ease: 'easeInOut', delay: 2 }}
                className="absolute bottom-0 end-0 w-52 h-52 bg-cyan-300/8 rounded-full blur-3xl"
              />
            </div>

            <div className="relative z-10 text-center">
              {/* Decorative icon */}
              <motion.div
                initial={{ scale: 0, rotate: -180 }}
                whileInView={{ scale: 1, rotate: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.6, type: 'spring', stiffness: 200 }}
                className="inline-flex mb-6"
              >
                <div className="h-16 w-16 rounded-2xl bg-white/15 backdrop-blur-sm flex items-center justify-center border border-white/20 shadow-lg">
                  <Zap className="h-8 w-8 text-white" />
                </div>
              </motion.div>

              <motion.h2
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.5, delay: 0.1 }}
                className="text-2xl md:text-4xl font-black text-white mb-4 leading-tight"
              >
                {t('ctaSectionTitle')}
              </motion.h2>
              <motion.p
                initial={{ opacity: 0, y: 15 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.5, delay: 0.2 }}
                className="text-base md:text-lg text-emerald-100/90 mb-8 max-w-xl mx-auto leading-relaxed"
              >
                {t('ctaSectionSubtitle')}
              </motion.p>
              <motion.div
                initial={{ opacity: 0, y: 15 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.5, delay: 0.35 }}
                className="flex flex-col sm:flex-row gap-3 justify-center"
              >
                <motion.div whileHover={{ scale: 1.06, y: -3 }} whileTap={{ scale: 0.97 }}>
                  <Button
                    size="lg"
                    className="bg-white text-emerald-700 hover:bg-emerald-50 font-bold px-8 md:px-10 py-6 md:py-7 text-base md:text-lg rounded-2xl shadow-xl shadow-black/10 min-h-12 md:min-h-14 hover:shadow-2xl hover:shadow-black/15 transition-all duration-300 w-full sm:w-auto"
                    onClick={() => setView('register')}
                  >
                    <span className="flex items-center">
                      {t('getStarted')}
                      <motion.span
                        animate={{ x: [0, 4, 0] }}
                        transition={{ duration: 1.5, repeat: Infinity, ease: 'easeInOut' }}
                        className="inline-flex ms-2"
                      >
                        <ArrowRight className="h-5 w-5 rtl:rotate-180" />
                      </motion.span>
                    </span>
                  </Button>
                </motion.div>
                <motion.div whileHover={{ scale: 1.06, y: -3 }} whileTap={{ scale: 0.97 }}>
                  <Button
                    size="lg"
                    variant="outline"
                    className="bg-white/10 backdrop-blur-sm text-white border-white/25 hover:bg-white/20 hover:border-white/40 font-bold px-8 md:px-10 py-6 md:py-7 text-base md:text-lg rounded-2xl min-h-12 md:min-h-14 transition-all duration-300 w-full sm:w-auto"
                    onClick={() => setView('login')}
                  >
                    {t('login')}
                  </Button>
                </motion.div>
              </motion.div>
            </div>
          </div>
        </div>
      </motion.section>

      {/* ─── Wave decoration + Footer ──────────────── */}
      <div className="relative z-10 mt-auto">
        <div className="w-full overflow-hidden">
          <div className="h-16 md:h-24 bg-gradient-to-b from-transparent to-emerald-50 dark:to-emerald-950/20 relative">
            <svg
              viewBox="0 0 1440 80"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
              className="absolute bottom-0 w-full"
              preserveAspectRatio="none"
            >
              <path
                d="M0 40C240 80 480 0 720 40C960 80 1200 0 1440 40V80H0V40Z"
                className="fill-emerald-100/60 dark:fill-emerald-900/20"
              />
              <path
                d="M0 55C360 25 720 75 1080 45C1260 30 1380 50 1440 55V80H0V55Z"
                className="fill-emerald-50 dark:fill-emerald-950/30"
              />
            </svg>
          </div>
        </div>
        <footer className="w-full px-4 pt-8 pb-6 bg-emerald-50 dark:bg-emerald-950/30">
          <div className="max-w-4xl mx-auto">
            {/* Footer top: Logo + social */}
            <div className="flex flex-col items-center gap-6 mb-8">
              <div className="flex items-center gap-2">
                <div className="h-16 w-16 rounded-xl overflow-hidden shadow-md">
                  <img src="/logo.png" alt="BLASTI" width={48} height={48} className="h-full w-full object-contain" />
                </div>
                <span className="font-bold text-lg bg-gradient-to-r from-emerald-700 to-teal-600 dark:from-emerald-400 dark:to-teal-300 bg-clip-text text-transparent">
                  BLASTI
                </span>
              </div>
              <p className="text-sm text-muted-foreground text-center max-w-md">
                {t('appTagline')}
              </p>
              {/* Social icons */}
              <div className="flex items-center gap-3">
                {[
                  { icon: Globe, label: 'Website' },
                  { icon: Share2, label: 'Share' },
                  { icon: Heart, label: 'Community' },
                  { icon: Shield, label: 'Security' },
                ].map((social, i) => (
                  <motion.button
                    key={i}
                    whileHover={{ scale: 1.15, y: -2 }}
                    whileTap={{ scale: 0.95 }}
                    className="h-9 w-9 rounded-xl bg-emerald-100 dark:bg-emerald-900/40 flex items-center justify-center text-emerald-600 dark:text-emerald-400 hover:bg-emerald-200 dark:hover:bg-emerald-800/50 transition-colors"
                    aria-label={social.label}
                  >
                    <social.icon className="h-4 w-4" />
                  </motion.button>
                ))}
              </div>
            </div>

            {/* Footer middle: Links */}
            <div className="grid grid-cols-2 md:grid-cols-3 gap-6 mb-8 text-center">
              <div>
                <h4 className="text-xs font-semibold text-foreground mb-3 uppercase tracking-wider">{t('home')}</h4>
                <div className="space-y-2">
                  <p onClick={() => scrollToSection('hero')} className="text-xs text-muted-foreground hover:text-emerald-600 dark:hover:text-emerald-400 cursor-pointer transition-colors">{t('getStarted')}</p>
                  <p onClick={() => scrollToSection('how-it-works')} className="text-xs text-muted-foreground hover:text-emerald-600 dark:hover:text-emerald-400 cursor-pointer transition-colors">{t('howItWorks')}</p>
                </div>
              </div>
              <div>
                <h4 className="text-xs font-semibold text-foreground mb-3 uppercase tracking-wider">{t('agencies')}</h4>
                <div className="space-y-2">
                  <p className="text-xs text-muted-foreground hover:text-emerald-600 dark:hover:text-emerald-400 cursor-pointer transition-colors">{t('trustedClinic')}</p>
                  <p className="text-xs text-muted-foreground hover:text-emerald-600 dark:hover:text-emerald-400 cursor-pointer transition-colors">{t('trustedLab')}</p>
                </div>
              </div>
              <div className="col-span-2 md:col-span-1">
                <h4 className="text-xs font-semibold text-foreground mb-3 uppercase tracking-wider">{t('settings')}</h4>
                <div className="space-y-2">
                  <p className="text-xs text-muted-foreground hover:text-emerald-600 dark:hover:text-emerald-400 cursor-pointer transition-colors">{t('appearance')}</p>
                  <p className="text-xs text-muted-foreground hover:text-emerald-600 dark:hover:text-emerald-400 cursor-pointer transition-colors">{t('language')}</p>
                </div>
              </div>
            </div>

            {/* Divider */}
            <div className="gradient-divider mb-5" />

            {/* Footer bottom */}
            <div className="flex flex-col items-center gap-2">
              <p className="text-sm text-muted-foreground">
                {t('poweredBy')} Z.ai Technology
              </p>
              <p className="text-xs text-muted-foreground/60">
                BLASTI © {new Date().getFullYear()} · {t('rightsReserved')}
              </p>
              <p className="text-[10px] text-muted-foreground/40 mt-1">{t('version')}</p>
            </div>
          </div>
        </footer>
      </div>

      {/* ─── Floating Back-to-Top Button ─────────── */}
      <AnimatePresence>
        {showBackToTop && (
          <motion.button
            initial={{ opacity: 0, scale: 0.8, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.8, y: 20 }}
            transition={{ duration: 0.25 }}
            onClick={scrollToTop}
            className="fixed bottom-6 end-6 z-50 h-11 w-11 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600 text-white shadow-lg shadow-emerald-500/30 flex items-center justify-center hover:shadow-xl hover:shadow-emerald-500/40 hover:scale-110 active:scale-95 transition-all duration-200"
            aria-label="Back to top"
          >
            <ChevronUp className="h-5 w-5" />
          </motion.button>
        )}
      </AnimatePresence>

    </div>
  );
}
