/**
 * Upload utility module — BACKWARD-COMPATIBLE WRAPPER
 *
 * This module now delegates to the storage abstraction layer in @/lib/storage.
 * All direct Vercel Blob calls have been replaced with provider-agnostic calls.
 *
 * The existing function signatures are preserved so that no calling code
 * needs to change. New code should import from @/lib/storage directly.
 *
 * @deprecated Use `uploadFile`, `deleteFile`, `getFileUrl` from @/lib/storage instead.
 */

import {
  uploadFile as storageUploadFile,
  deleteFile as storageDeleteFile,
  getFileMetadata as storageGetFileMetadata,
  isValidExtension,
  isValidMimeType,
  isValidUploadType as isValidType,
  MAX_FILE_SIZE,
  ALLOWED_EXTENSIONS,
  ALLOWED_MIME_PREFIXES,
  VALID_UPLOAD_TYPES,
  isVercelBlobUrl as isBlobUrl,
  detectProviderFromUrl,
} from '@/lib/storage';
// getStorageProviderByType is lazy-loaded to avoid @aws-sdk compilation issues

// Re-export constants for backward compatibility
export { MAX_FILE_SIZE, ALLOWED_EXTENSIONS, ALLOWED_MIME_PREFIXES, VALID_UPLOAD_TYPES, isValidType };
export { isValidMimeType, isValidExtension, isBlobUrl };

export const VALID_TYPES = VALID_UPLOAD_TYPES;
export const DEFAULT_TYPE = 'general';

// ─── Environment Detection (backward compatible) ──────────────────────────────

export function isVercelBlobConfigured(): boolean {
  return !!process.env.BLOB_READ_WRITE_TOKEN;
}

export function isVercelDeployment(): boolean {
  return !!process.env.VERCEL;
}

export function shouldUseVercelBlob(): boolean {
  return isVercelBlobConfigured();
}

export function isLocalStorageAvailable(): boolean {
  return !isVercelDeployment();
}

// ─── Helpers (backward compatible) ───────────────────────────────────────────

export function getExtension(filename: string): string {
  return filename.split('.').pop()?.toLowerCase() || '';
}

// ─── Upload Result (backward compatible) ──────────────────────────────────────

export interface UploadResult {
  url: string;
  filename: string;
  provider: 'vercel-blob' | 'local' | 'r2';
  size: number;
  access?: 'public' | 'private';
}

// ─── Upload (POST) — Delegates to storage abstraction ─────────────────────────

/**
 * Upload a file to the configured storage provider.
 *
 * @deprecated Use `uploadFile` from @/lib/storage instead.
 */
export async function uploadFile(
  file: File,
  type: string = DEFAULT_TYPE,
  options?: { addRandomSuffix?: boolean; metadata?: Record<string, string> },
): Promise<UploadResult> {
  const result = await storageUploadFile(file, type, {
    addRandomSuffix: options?.addRandomSuffix,
    metadata: options?.metadata,
    originalName: file.name,
  });

  // Map provider name for backward compatibility
  const providerMap: Record<string, 'vercel-blob' | 'local' | 'r2'> = {
    'blob': 'vercel-blob',
    'local': 'local',
    'r2': 'r2',
  };

  return {
    url: result.url,
    filename: result.filename,
    provider: providerMap[result.provider] || 'local',
    size: result.size,
    access: result.access,
  };
}

// ─── Delete — Delegates to storage abstraction ────────────────────────────────

/**
 * Delete an uploaded file.
 *
 * @deprecated Use `deleteFile` from @/lib/storage instead.
 */
export async function deleteFile(url: string): Promise<{ success: boolean; provider: 'vercel-blob' | 'local' | 'r2' }> {
  if (!url || typeof url !== 'string') {
    throw new Error('Provide a valid URL');
  }

  try {
    const providerType = detectProviderFromUrl(url);
    await storageDeleteFile(url, providerType);

    const providerMap: Record<string, 'vercel-blob' | 'local' | 'r2'> = {
      'blob': 'vercel-blob',
      'local': 'local',
      'r2': 'r2',
    };

    return { success: true, provider: providerMap[providerType] || 'local' };
  } catch (err) {
    console.error('[UPLOAD DELETE] Failed:', err);
    throw new Error('Failed to delete file');
  }
}

// ─── File Metadata (backward compatible) ──────────────────────────────────────

export interface FileMetadata {
  url: string;
  size?: number;
  uploadedAt?: Date;
  contentType?: string;
  provider: 'vercel-blob' | 'local' | 'r2';
}

/**
 * Get metadata for an uploaded file.
 *
 * @deprecated Use `getFileMetadata` from @/lib/storage instead.
 */
export async function getFileMetadata(url: string): Promise<FileMetadata | null> {
  try {
    const providerType = detectProviderFromUrl(url);
    // Lazy-load to avoid @aws-sdk compilation issues
    const { getStorageProviderByTypeAsync } = await import('@/lib/storage/storage-factory');
    const provider = await getStorageProviderByTypeAsync(providerType);

    // For full URLs, use the provider directly
    if (url.startsWith('https://') || url.startsWith('http://')) {
      const metadata = await provider.getMetadata(url);
      if (!metadata) return null;

      const providerMap: Record<string, 'vercel-blob' | 'local' | 'r2'> = {
        'blob': 'vercel-blob',
        'local': 'local',
        'r2': 'r2',
      };

      return {
        url: metadata.url,
        size: metadata.size,
        uploadedAt: metadata.uploadedAt,
        contentType: metadata.contentType,
        provider: providerMap[metadata.provider] || 'local',
      };
    }

    // For local paths
    if (url.startsWith('/uploads/')) {
      const metadata = await provider.getMetadata(url);
      if (!metadata) return null;

      return {
        url: metadata.url,
        size: metadata.size,
        uploadedAt: metadata.uploadedAt,
        contentType: metadata.contentType,
        provider: 'local',
      };
    }

    return null;
  } catch {
    return null;
  }
}

// ─── List Files (simplified — delegates to provider) ──────────────────────────

export interface ListResult {
  files: Array<{
    url: string;
    name: string;
    size?: number;
    uploadedAt?: Date;
  }>;
  hasMore: boolean;
  cursor?: string;
  provider: 'vercel-blob' | 'local' | 'r2';
}

/**
 * List uploaded files.
 * Note: This is a simplified version. For full listing, use the provider directly.
 *
 * @deprecated Use the storage provider's methods directly for listing.
 */
export async function listFiles(_options?: {
  prefix?: string;
  limit?: number;
  cursor?: string;
}): Promise<ListResult> {
  // Listing is provider-specific and not part of the core abstraction.
  // Return empty list for now — can be implemented per provider if needed.
  return {
    files: [],
    hasMore: false,
    provider: 'local',
  };
}

// ─── Migration Helper (backward compatible) ───────────────────────────────────

/**
 * Migrate a locally stored file to the configured storage provider.
 * For full Blob-to-R2 migration, use scripts/migrate-blob-to-r2.ts.
 *
 * @deprecated Use the migration script at scripts/migrate-blob-to-r2.ts instead.
 */
export async function migrateToBlob(localUrl: string): Promise<UploadResult | null> {
  // This function is kept for backward compatibility but is now limited.
  // For proper migration, use the dedicated migration script.
  console.warn('[UPLOAD] migrateToBlob is deprecated. Use scripts/migrate-blob-to-r2.ts for migration.');
  return null;
}
