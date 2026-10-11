'use client';

import { useState, useEffect, useCallback } from 'react';

/**
 * A hook that syncs state with localStorage.
 * Works like useState but persists the value to localStorage.
 *
 * @param key - The localStorage key
 * @param initialValue - The initial value if nothing is stored
 * @returns A tuple of [value, setValue] like useState
 *
 * @example
 * const [name, setName] = useLocalStorage('user-name', 'Guest');
 */
export function useLocalStorage<T>(
  key: string,
  initialValue: T
): [T, (value: T | ((prev: T) => T)) => void] {
  // Lazy initializer: read from localStorage on mount, fall back to initial value
  const [storedValue, setStoredValue] = useState<T>(() => {
    if (typeof window === 'undefined') {
      return initialValue;
    }
    try {
      const item = window.localStorage.getItem(key);
      return item ? (JSON.parse(item) as T) : initialValue;
    } catch {
      return initialValue;
    }
  });

  // Persist to localStorage whenever the value changes
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(key, JSON.stringify(storedValue));
    } catch {
      // Silently fail if localStorage is full or unavailable
    }
  }, [key, storedValue]);

  const setValue = useCallback(
    (value: T | ((prev: T) => T)) => {
      setStoredValue((prev) => {
        const nextValue = value instanceof Function ? value(prev) : value;
        return nextValue;
      });
    },
    []
  );

  return [storedValue, setValue];
}
