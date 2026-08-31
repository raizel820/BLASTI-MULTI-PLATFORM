'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { motion, AnimatePresence } from 'framer-motion';
import {
  runE2EQueueTest,
  type TestStep,
  type E2ETestResult,
  type TestStatus,
} from '@/lib/e2e-queue-test';
import {
  FlaskConical,
  X,
  Play,
  CheckCircle2,
  XCircle,
  Clock,
  Loader2,
  ChevronDown,
  AlertTriangle,
  RotateCcw,
  UserCheck,
  Users,
  Shield,
  Zap,
} from 'lucide-react';

// ─── Category Config ─────────────────────────────────────────────────────────

const CATEGORY_CONFIG = {
  auth: {
    label: 'المصادقة',
    labelEn: 'Authentication',
    icon: Shield,
    gradient: 'from-emerald-500 to-teal-500',
    bg: 'bg-emerald-500/10',
    text: 'text-emerald-600 dark:text-emerald-400',
  },
  queue: {
    label: 'الطابور',
    labelEn: 'Queue',
    icon: Users,
    gradient: 'from-teal-500 to-cyan-500',
    bg: 'bg-teal-500/10',
    text: 'text-teal-600 dark:text-teal-400',
  },
  error: {
    label: 'حالات الخطأ',
    labelEn: 'Error Cases',
    icon: AlertTriangle,
    gradient: 'from-amber-500 to-orange-500',
    bg: 'bg-amber-500/10',
    text: 'text-amber-600 dark:text-amber-400',
  },
  edge: {
    label: 'حالات خاصة',
    labelEn: 'Edge Cases',
    icon: Zap,
    gradient: 'from-rose-500 to-pink-500',
    bg: 'bg-rose-500/10',
    text: 'text-rose-600 dark:text-rose-400',
  },
} as const;

// ─── Status Icon ──────────────────────────────────────────────────────────────

function StatusIcon({ status }: { status: TestStatus }) {
  switch (status) {
    case 'pass':
      return <CheckCircle2 className="h-4 w-4 text-emerald-500" />;
    case 'fail':
      return <XCircle className="h-4 w-4 text-rose-500" />;
    case 'running':
      return <Loader2 className="h-4 w-4 text-teal-500 animate-spin" />;
    case 'skipped':
      return <ChevronDown className="h-4 w-4 text-gray-400" />;
    default:
      return <Clock className="h-4 w-4 text-gray-300 dark:text-gray-600" />;
  }
}

// ─── Duration Formatting ──────────────────────────────────────────────────────

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

// ─── Main Component ───────────────────────────────────────────────────────────

export function QueueE2ETestPanel() {
  const [isOpen, setIsOpen] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [steps, setSteps] = useState<TestStep[]>([]);
  const [result, setResult] = useState<E2ETestResult | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to running step
  useEffect(() => {
    if (scrollRef.current && isRunning) {
      const runningStep = scrollRef.current.querySelector('[data-status="running"]');
      if (runningStep) {
        runningStep.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    }
  }, [steps, isRunning]);

  const handleRunTests = useCallback(async () => {
    setIsRunning(true);
    setResult(null);
    try {
      const testResult = await runE2EQueueTest((updatedSteps) => {
        setSteps([...updatedSteps]);
      });
      setResult(testResult);
      setSteps([...testResult.steps]);
    } catch (error) {
      console.error('[E2E Test] Fatal error:', error);
    } finally {
      setIsRunning(false);
    }
  }, []);

  const handleReset = useCallback(() => {
    setSteps([]);
    setResult(null);
  }, []);

  const passed = steps.filter(s => s.status === 'pass').length;
  const failed = steps.filter(s => s.status === 'fail').length;
  const total = steps.length;

  // ─── Floating Button (dev-only, hidden in production) ────────────────────

  if (process.env.NODE_ENV === 'production') {
    return null;
  }

  return (
    <>
      {/* ── Floating Test Button ──────────────────────────────────────────── */}
      <AnimatePresence>
        {!isOpen && (
          <motion.button
            initial={{ scale: 0, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0, opacity: 0 }}
            whileHover={{ scale: 1.1 }}
            whileTap={{ scale: 0.9 }}
            onClick={() => setIsOpen(true)}
            className="fixed bottom-6 left-6 z-[9998] flex h-12 w-12 items-center justify-center rounded-full bg-gradient-to-br from-emerald-500 to-teal-600 text-white shadow-lg shadow-emerald-500/30 transition-shadow hover:shadow-xl hover:shadow-emerald-500/40"
            title="E2E Queue Test"
            aria-label="فتح اختبار الطابور الشامل"
          >
            <FlaskConical className="h-5 w-5" />
            {result && (
              <span
                className={`absolute -top-1 -right-1 flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold text-white ${
                  result.overallStatus === 'pass'
                    ? 'bg-emerald-500'
                    : result.overallStatus === 'fail'
                      ? 'bg-rose-500'
                      : 'bg-amber-500'
                }`}
              >
                {result.failed > 0 ? result.failed : '✓'}
              </span>
            )}
          </motion.button>
        )}
      </AnimatePresence>

      {/* ── Slide-out Panel ───────────────────────────────────────────────── */}
      <AnimatePresence>
        {isOpen && (
          <>
            {/* Backdrop */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => !isRunning && setIsOpen(false)}
              className="fixed inset-0 z-[9998] bg-black/30 backdrop-blur-sm"
            />

            {/* Panel */}
            <motion.div
              initial={{ x: -420, opacity: 0 }}
              animate={{ x: 0, opacity: 1 }}
              exit={{ x: -420, opacity: 0 }}
              transition={{ type: 'spring', damping: 25, stiffness: 300 }}
              className="fixed top-0 left-0 z-[9999] flex h-full w-full max-w-[400px] flex-col bg-white dark:bg-gray-950 shadow-2xl"
              dir="rtl"
            >
              {/* ── Header ──────────────────────────────────────────────── */}
              <div className="flex items-center justify-between border-b border-gray-200 dark:border-gray-800 bg-gradient-to-l from-emerald-500/10 via-teal-500/5 to-transparent px-4 py-3">
                <div className="flex items-center gap-3">
                  <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-gradient-to-br from-emerald-500 to-teal-600 text-white shadow-sm">
                    <FlaskConical className="h-4 w-4" />
                  </div>
                  <div>
                    <h2 className="text-sm font-bold text-gray-900 dark:text-gray-100">
                      اختبار الطابور الشامل
                    </h2>
                    <p className="text-[11px] text-gray-500 dark:text-gray-400">
                      E2E Queue Lifecycle Test
                    </p>
                  </div>
                </div>
                <button
                  onClick={() => !isRunning && setIsOpen(false)}
                  disabled={isRunning}
                  className="flex h-8 w-8 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-800 dark:hover:text-gray-300 disabled:opacity-50"
                  aria-label="إغلاق"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              {/* ── Summary Bar ──────────────────────────────────────────── */}
              {result && (
                <div className="flex items-center gap-2 border-b border-gray-100 dark:border-gray-800 px-4 py-2.5">
                  <div
                    className={`flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold ${
                      result.overallStatus === 'pass'
                        ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                        : result.overallStatus === 'fail'
                          ? 'bg-rose-500/10 text-rose-600 dark:text-rose-400'
                          : 'bg-amber-500/10 text-amber-600 dark:text-amber-400'
                    }`}
                  >
                    {result.overallStatus === 'pass' ? (
                      <CheckCircle2 className="h-3 w-3" />
                    ) : result.overallStatus === 'fail' ? (
                      <XCircle className="h-3 w-3" />
                    ) : (
                      <AlertTriangle className="h-3 w-3" />
                    )}
                    {result.overallStatus === 'pass'
                      ? 'نجاح'
                      : result.overallStatus === 'fail'
                        ? 'فشل'
                        : 'جزئي'}
                  </div>
                  <Badge variant="outline" className="text-[10px] gap-1">
                    <CheckCircle2 className="h-2.5 w-2.5 text-emerald-500" />
                    {result.passed} نجح
                  </Badge>
                  {result.failed > 0 && (
                    <Badge variant="outline" className="text-[10px] gap-1 border-rose-200 text-rose-600">
                      <XCircle className="h-2.5 w-2.5" />
                      {result.failed} فشل
                    </Badge>
                  )}
                  <span className="mr-auto text-[10px] text-gray-400">
                    {formatDuration(result.totalDuration)}
                  </span>
                </div>
              )}

              {/* ── Progress Bar ─────────────────────────────────────────── */}
              {isRunning && total > 0 && (
                <div className="h-1 w-full bg-gray-100 dark:bg-gray-800">
                  <div
                    className="h-full bg-gradient-to-l from-emerald-500 to-teal-500 transition-all duration-300"
                    style={{ width: `${((passed + failed) / total) * 100}%` }}
                  />
                </div>
              )}

              {/* ── Test Steps List ──────────────────────────────────────── */}
              <ScrollArea className="flex-1" ref={scrollRef}>
                <div className="p-3 space-y-1.5">
                  {steps.length === 0 && !isRunning && (
                    <div className="flex flex-col items-center justify-center py-16 text-center">
                      <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-emerald-500/10 to-teal-500/10 mb-4">
                        <FlaskConical className="h-8 w-8 text-emerald-500/40" />
                      </div>
                      <p className="text-sm font-medium text-gray-500 dark:text-gray-400">
                        لا توجد نتائج اختبار بعد
                      </p>
                      <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">
                        اضغط &quot;تشغيل الاختبار&quot; لبدء الفحص الشامل
                      </p>
                    </div>
                  )}

                  {steps.map((step, index) => {
                    const category = CATEGORY_CONFIG[step.category];
                    const CategoryIcon = category.icon;

                    return (
                      <motion.div
                        key={step.id}
                        data-status={step.status}
                        initial={{ opacity: 0, y: 8 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: index * 0.03, duration: 0.2 }}
                        className={`flex items-start gap-2.5 rounded-lg border p-2.5 transition-colors ${
                          step.status === 'running'
                            ? 'border-teal-300 bg-teal-50/50 dark:border-teal-700 dark:bg-teal-950/30'
                            : step.status === 'pass'
                              ? 'border-emerald-200/50 bg-emerald-50/30 dark:border-emerald-800/30 dark:bg-emerald-950/10'
                              : step.status === 'fail'
                                ? 'border-rose-200/50 bg-rose-50/30 dark:border-rose-800/30 dark:bg-rose-950/10'
                                : 'border-gray-100 dark:border-gray-800/50'
                        }`}
                      >
                        {/* Category icon */}
                        <div
                          className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md ${category.bg}`}
                        >
                          <CategoryIcon className={`h-3 w-3 ${category.text}`} />
                        </div>

                        {/* Step info */}
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-medium text-gray-800 dark:text-gray-200 truncate">
                              {step.nameAr}
                            </span>
                            <StatusIcon status={step.status} />
                          </div>
                          <div className="flex items-center gap-2 mt-0.5">
                            <span className="text-[10px] text-gray-400 dark:text-gray-500 truncate">
                              {step.name}
                            </span>
                            {step.duration > 0 && (
                              <span className="text-[10px] text-gray-400 dark:text-gray-500 shrink-0">
                                {formatDuration(step.duration)}
                              </span>
                            )}
                            {step.responseStatus && (
                              <span
                                className={`text-[10px] font-mono shrink-0 ${
                                  step.responseStatus >= 200 && step.responseStatus < 300
                                    ? 'text-emerald-500'
                                    : step.responseStatus >= 400
                                      ? 'text-rose-500'
                                      : 'text-gray-400'
                                }`}
                              >
                                {step.responseStatus}
                              </span>
                            )}
                          </div>
                          {/* Error message */}
                          {step.error && (
                            <p className="text-[10px] text-rose-500 dark:text-rose-400 mt-1 leading-relaxed">
                              {step.error}
                            </p>
                          )}
                        </div>
                      </motion.div>
                    );
                  })}
                </div>
              </ScrollArea>

              {/* ── Footer / Actions ─────────────────────────────────────── */}
              <div className="border-t border-gray-200 dark:border-gray-800 p-3 space-y-2">
                {/* Category legend */}
                <div className="flex items-center gap-3 text-[10px] text-gray-400">
                  {(Object.entries(CATEGORY_CONFIG) as [keyof typeof CATEGORY_CONFIG, typeof CATEGORY_CONFIG[keyof typeof CATEGORY_CONFIG]][]).map(
                    ([key, cfg]) => (
                      <span key={key} className="flex items-center gap-1">
                        <span
                          className={`inline-block h-2 w-2 rounded-full bg-gradient-to-r ${cfg.gradient}`}
                        />
                        {cfg.label}
                      </span>
                    )
                  )}
                </div>

                <div className="flex items-center gap-2">
                  <Button
                    onClick={handleRunTests}
                    disabled={isRunning}
                    className="flex-1 gap-2 bg-gradient-to-l from-emerald-500 to-teal-600 text-white hover:from-emerald-600 hover:to-teal-700 shadow-md shadow-emerald-500/20"
                    size="sm"
                  >
                    {isRunning ? (
                      <>
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        جاري الاختبار...
                      </>
                    ) : (
                      <>
                        <Play className="h-3.5 w-3.5" />
                        تشغيل الاختبار
                      </>
                    )}
                  </Button>
                  {!isRunning && steps.length > 0 && (
                    <Button
                      onClick={handleReset}
                      variant="outline"
                      size="sm"
                      className="gap-1.5"
                    >
                      <RotateCcw className="h-3 w-3" />
                      إعادة
                    </Button>
                  )}
                </div>

                {/* Console hint */}
                <p className="text-[9px] text-gray-400 text-center">
                  أو استخدم <code className="font-mono text-gray-500 bg-gray-100 dark:bg-gray-800 px-1 rounded">window.__blastiE2E.run()</code> في وحدة التحكم
                </p>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </>
  );
}

export default QueueE2ETestPanel;
