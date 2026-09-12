/**
 * Desktop stub for @/lib/e2e-queue-test.
 *
 * The Web app has a full E2E queue lifecycle test runner. The Desktop
 * doesn't replicate that test infrastructure, so this stub provides the
 * types and a no-op runner so the QueueE2ETestPanel component compiles
 * without errors.
 */

export type TestStatus = 'pending' | 'running' | 'pass' | 'fail' | 'skipped';

export interface TestStep {
  id: string;
  name: string;
  nameAr: string;
  category: 'auth' | 'queue' | 'error' | 'edge';
  status: TestStatus;
  duration: number;
  error?: string;
  responseStatus?: number;
}

export interface E2ETestResult {
  steps: TestStep[];
  passed: number;
  failed: number;
  skipped: number;
  totalDuration: number;
  overallStatus: 'pass' | 'fail' | 'partial';
}

/**
 * No-op E2E test runner for Desktop.
 * Returns a single "skipped" step indicating the test runner is not available.
 */
export async function runE2EQueueTest(
  _onStepUpdate: (steps: TestStep[]) => void,
): Promise<E2ETestResult> {
  const steps: TestStep[] = [
    {
      id: 'desktop-skip',
      name: 'E2E tests not available on Desktop',
      nameAr: 'اختبارات E2E غير متاحة على الحاسوب',
      category: 'auth',
      status: 'skipped',
      duration: 0,
    },
  ];

  return {
    steps,
    passed: 0,
    failed: 0,
    skipped: 1,
    totalDuration: 0,
    overallStatus: 'partial',
  };
}
