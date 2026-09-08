import { useState, useEffect, useCallback } from 'react';

interface UseApiOptions<T> {
  initialData?: T;
  immediate?: boolean;
}

interface UseApiResult<T> {
  data: T | undefined;
  isLoading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
}

/**
 * Simple data fetching hook for the local API.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function useApi<T = any>(
  fetcher: () => Promise<T>,
  options: UseApiOptions<T> = {}
): UseApiResult<T> {
  const { initialData, immediate = true } = options;
  const [data, setData] = useState<T | undefined>(initialData);
  const [isLoading, setIsLoading] = useState(immediate);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const result = await fetcher();
      setData(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch');
    } finally {
      setIsLoading(false);
    }
  }, [fetcher]);

  useEffect(() => {
    if (immediate) {
      refetch();
    }
  }, [immediate, refetch]);

  return { data, isLoading, error, refetch };
}

/**
 * Hook for polling data at a regular interval.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function usePolling<T = any>(
  fetcher: () => Promise<T>,
  intervalMs: number = 5000,
  options: UseApiOptions<T> = {}
): UseApiResult<T> {
  const result = useApi(fetcher, options);

  useEffect(() => {
    const id = setInterval(() => {
      result.refetch();
    }, intervalMs);
    return () => clearInterval(id);
  }, [intervalMs, result.refetch]);

  return result;
}
