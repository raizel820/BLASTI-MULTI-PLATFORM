'use client';

import { useState, useCallback, useRef } from 'react';
import { apiFetch } from '@/lib/api-fetch';

// ─── Types ───────────────────────────────────────────────────────────────────

export type UploadType = 'general' | 'receipt' | 'logo' | 'avatar';

export interface UploadState {
  /** Whether an upload is currently in progress */
  uploading: boolean;
  /** Progress percentage (0-100), only available with XMLHttpRequest */
  progress: number;
  /** The URL of the successfully uploaded file */
  url: string | null;
  /** The filename of the uploaded file */
  filename: string | null;
  /** Storage provider used */
  provider: 'vercel-blob' | 'local' | 'r2' | null;
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
  onSuccess?: (result: { url: string; filename: string; provider: 'vercel-blob' | 'local' | 'r2'; size: number }) => void;
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
  const xhrRef = useRef<XMLHttpRequest | null>(null);

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

  /** Upload a file */
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

      try {
        const formData = new FormData();
        formData.append('file', file);

        // Add metadata if provided
        if (metadata) {
          for (const [key, value] of Object.entries(metadata)) {
            formData.append(key, value);
          }
        }

        // Use fetch with progress tracking via XMLHttpRequest
        const result = await new Promise<{
          url: string;
          filename: string;
          provider: 'vercel-blob' | 'local' | 'r2';
          size: number;
        }>((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhrRef.current = xhr;

          xhr.upload.addEventListener('progress', (e) => {
            if (e.lengthComputable) {
              const progress = Math.round((e.loaded / e.total) * 100);
              setState((prev) => ({ ...prev, progress }));
            }
          });

          xhr.addEventListener('load', () => {
            xhrRef.current = null;
            try {
              const response = JSON.parse(xhr.responseText);
              if (xhr.status >= 200 && xhr.status < 300 && response.url) {
                resolve(response);
              } else {
                reject(new Error(response.error || `Upload failed with status ${xhr.status}`));
              }
            } catch {
              reject(new Error('Invalid response from server'));
            }
          });

          xhr.addEventListener('error', () => {
            xhrRef.current = null;
            reject(new Error('Network error during upload'));
          });

          xhr.addEventListener('abort', () => {
            xhrRef.current = null;
            reject(new Error('Upload cancelled'));
          });

          xhr.open('POST', `/api/upload?type=${type}`);
          xhr.send(formData);
        });

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
        const message = err instanceof Error ? err.message : 'Upload failed';
        const errorState: UploadState = {
          ...INITIAL_STATE,
          error: message,
        };
        setState(errorState);
        onError?.(message);
        return errorState;
      }
    },
    [type, validate, autoClearError, onSuccess, onError],
  );

  /** Reset the upload state */
  const reset = useCallback(() => {
    // Abort any in-flight upload
    if (xhrRef.current) {
      xhrRef.current.abort();
      xhrRef.current = null;
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
