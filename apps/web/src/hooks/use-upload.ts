'use client';

import { useState, useCallback, useRef } from 'react';
import { apiFetch } from '@/lib/api-fetch';

// ─── Types ───────────────────────────────────────────────────────────────────

export type UploadType = 'general' | 'receipt' | 'logo' | 'avatar';

export interface UploadState {
  /** Whether an upload is currently in progress */
  uploading: boolean;
  /** Progress percentage (0-100) */
  progress: number;
  /** The URL of the successfully uploaded file */
  url: string | null;
  /** The filename of the uploaded file */
  filename: string | null;
  /** Storage provider used — 'local-device' = stored on the desktop's own
   * file store and mirrored to the cloud by the file-sync worker (Round 15). */
  provider: 'local' | 'local-device' | null;
  /** Error message if upload failed */
  error: string | null;
}

export interface UseUploadOptions {
  /** Upload type/category (general, receipt, logo, avatar) */
  type?: UploadType;
  /** Max file size in bytes (default: 5MB) */
  maxSize?: number;
  /** Accepted MIME types */
  accept?: string[];
  /** Whether to auto-clear error on new upload (default: true) */
  autoClearError?: boolean;
  /** Callback on successful upload */
  onSuccess?: (result: { url: string; filename: string; provider: 'local' | 'local-device'; size: number }) => void;
  /** Callback on upload error */
  onError?: (error: string) => void;
}

export interface UseUploadReturn extends UploadState {
  /** Upload a file */
  upload: (file: File, metadata?: Record<string, string>) => Promise<UploadState>;
  /** Reset the upload state */
  reset: () => void;
  /** Check if a file is valid before uploading */
  validate: (file: File) => string | null;
  /** Delete an uploaded file by URL */
  remove: (url: string) => Promise<boolean>;
}

// ─── Default Config ──────────────────────────────────────────────────────────

const DEFAULT_MAX_SIZE = 5 * 1024 * 1024; // 5 MB
const ALLOWED_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'pdf']);
const ALLOWED_MIME_PREFIXES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/svg+xml',
  'application/pdf',
];

const INITIAL_STATE: UploadState = {
  uploading: false,
  progress: 0,
  url: null,
  filename: null,
  provider: null,
  error: null,
};

// ─── Hook ────────────────────────────────────────────────────────────────────

export function useUpload(options: UseUploadOptions = {}): UseUploadReturn {
  const {
    type = 'general',
    maxSize = DEFAULT_MAX_SIZE,
    accept,
    autoClearError = true,
    onSuccess,
    onError,
  } = options;

  const [state, setState] = useState<UploadState>(INITIAL_STATE);
  const abortRef = useRef<AbortController | null>(null);

  /** Validate a file before uploading */
  const validate = useCallback(
    (file: File): string | null => {
      // Size check
      if (file.size > maxSize) {
        return `File too large. Max ${Math.round(maxSize / 1024 / 1024)}MB`;
      }

      // Extension check
      const ext = file.name.split('.').pop()?.toLowerCase() || '';
      if (!ALLOWED_EXTENSIONS.has(ext)) {
        return `Invalid file type .${ext}`;
      }

      // MIME type check
      const validMime = ALLOWED_MIME_PREFIXES.some((prefix) =>
        file.type.startsWith(prefix),
      );
      if (!validMime) {
        return `Invalid MIME type "${file.type}"`;
      }

      // Custom accept check
      if (accept && accept.length > 0) {
        if (!accept.includes(file.type)) {
          return `File type ${file.type} not accepted`;
        }
      }

      return null;
    },
    [maxSize, accept],
  );

  /**
   * Upload a file.
   *
   * Task 23 FIX — this hook previously used a RAW XMLHttpRequest against the
   * RELATIVE url `/api/upload?type=…`. That could never work:
   *   • Web: the Next.js app has no /api/upload route (uploads live on the
   *     cloud API) → Next.js returned an HTML 404 page → JSON.parse threw
   *     the literal "Invalid response from server".
   *   • Desktop (Electron static export from file://): a relative XHR has no
   *     server to reach at all.
   *   • Even when it reached the old cloud placeholder, no file was stored
   *     and no url returned.
   *
   * It now routes through apiFetch → apiClient, which resolves the correct
   * ABSOLUTE base url on every platform (web → cloud API url, Electron →
   * local API 127.0.0.1:3080 whose /api/upload proxy forwards to the cloud,
   * Capacitor → cloud API url) and keeps the built-in retry/failover chain.
   */
  const upload = useCallback(
    async (file: File, metadata?: Record<string, string>): Promise<UploadState> => {
      // Validate first
      const validationError = validate(file);
      if (validationError) {
        const errorState: UploadState = {
          ...INITIAL_STATE,
          error: validationError,
        };
        setState(errorState);
        onError?.(validationError);
        return errorState;
      }

      // Clear previous state
      setState((prev) => ({
        ...INITIAL_STATE,
        uploading: true,
        progress: 0,
        ...(autoClearError ? {} : { error: prev.error }),
      }));

      // Abort controller so reset() can cancel an in-flight upload
      if (abortRef.current) abortRef.current.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const formData = new FormData();
        formData.append('file', file);
        // Task 24 FIX: also declare the type as a FORM FIELD. The cloud route
        // reads `formData.get('type')` first; older cloud builds read ONLY the
        // form field, so sending both keeps every deployment working.
        formData.append('type', type);

        // Add metadata if provided
        if (metadata) {
          for (const [key, value] of Object.entries(metadata)) {
            formData.append(key, value);
          }
        }

        const res = await apiFetch(`/api/upload?type=${encodeURIComponent(type)}`, {
          method: 'POST',
          body: formData,
          signal: controller.signal,
        });

        if (controller.signal.aborted) {
          const abortedState: UploadState = { ...INITIAL_STATE, error: 'Upload cancelled' };
          return abortedState;
        }

        // The cloud route always answers JSON; guard anyway so a non-JSON
        // body surfaces as a clear upload error instead of a parse crash.
        let data: { url?: string; filename?: string; provider?: string; error?: string } | null = null;
        try {
          data = await res.json();
        } catch {
          data = null;
        }

        if (!res.ok || !data || !data.url) {
          throw new Error(data?.error || `Upload failed with status ${res.status}`);
        }

        const result: { url: string; filename: string; provider: 'local' | 'local-device'; size: number } = {
          url: data.url,
          filename: data.filename || file.name,
          // The desktop local API answers provider 'local-device' (local-first
          // storage + background cloud sync); the cloud answers 'local'.
          provider: data.provider === 'local-device' ? 'local-device' : 'local',
          size: file.size,
        };

        const successState: UploadState = {
          uploading: false,
          progress: 100,
          url: result.url,
          filename: result.filename,
          provider: result.provider,
          error: null,
        };

        setState(successState);
        onSuccess?.(result);
        return successState;
      } catch (err) {
        if (controller.signal.aborted) {
          const abortedState: UploadState = { ...INITIAL_STATE, error: 'Upload cancelled' };
          return abortedState;
        }
        const message = err instanceof Error ? err.message : 'Upload failed';
        const errorState: UploadState = {
          ...INITIAL_STATE,
          error: message,
        };
        setState(errorState);
        onError?.(message);
        return errorState;
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
      }
    },
    [type, validate, autoClearError, onSuccess, onError],
  );

  /** Reset the upload state */
  const reset = useCallback(() => {
    // Abort any in-flight upload
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    setState(INITIAL_STATE);
  }, []);

  /** Delete an uploaded file by URL */
  const remove = useCallback(async (url: string): Promise<boolean> => {
    try {
      const res = await apiFetch('/api/upload', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });
      return res.ok;
    } catch {
      return false;
    }
  }, []);

  return {
    ...state,
    upload,
    reset,
    validate,
    remove,
  };
}
