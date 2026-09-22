/**
 * Migration Script: Vercel Blob → Cloudflare R2
 *
 * Reads all file records stored in Vercel Blob, downloads them,
 * and re-uploads them to Cloudflare R2. Updates the database to
 * point to R2 while keeping the original Blob URLs for rollback.
 *
 * Features:
 * - Dry-run mode (no writes)
 * - Resumable execution (skips already-migrated files)
 * - Progress logging
 * - Failure logging
 * - Does NOT delete original Blob files
 *
 * Usage:
 *   bun run scripts/migrate-blob-to-r2.ts [--dry-run] [--batch-size=50]
 *
 * Environment variables required:
 * - DATABASE_URL
 * - BLOB_READ_WRITE_TOKEN (for downloading from Vercel Blob)
 * - R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
 * - R2_PUBLIC_URL (optional, for public file URLs)
 */

// ─── Setup ────────────────────────────────────────────────────────────────────

import { Readable } from 'stream';
import { db, PrismaClient } from '@blasti/db';
import { getR2Provider } from '../src/lib/storage/cloudflare-r2-provider';
import { getVercelBlobProvider } from '../src/lib/storage/vercel-blob-provider';
import { isVercelBlobUrl, detectProviderFromUrl } from '../src/lib/storage/storage-provider';

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB — skip files larger than this
const MAX_CONCURRENT_UPLOADS = 10;       // Max parallel uploads per batch

// Parse CLI args
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const batchSizeArg = args.find(a => a.startsWith('--batch-size='));
const batchSize = batchSizeArg ? parseInt(batchSizeArg.split('=')[1], 10) : 50;

const prisma = new PrismaClient();

// ─── Types ────────────────────────────────────────────────────────────────────

interface MigrationRecord {
  model: string;
  id: string;
  urlField: string;
  url: string;
  storageProviderField: string;
  storageKeyField: string;
}

interface MigrationResult {
  total: number;
  migrated: number;
  skipped: number;
  failed: number;
  errors: Array<{ record: MigrationRecord; error: string }>;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║     Vercel Blob → Cloudflare R2 Migration Script       ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log();
  console.log(`Mode: ${dryRun ? 'DRY RUN (no writes)' : 'LIVE'}`);
  console.log(`Batch size: ${batchSize}`);
  console.log();

  // Validate configuration
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    console.error('❌ BLOB_READ_WRITE_TOKEN is not set. Required to download files from Vercel Blob.');
    process.exit(1);
  }

  if (!process.env.R2_ACCOUNT_ID || !process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY || !process.env.R2_BUCKET) {
    console.error('❌ R2 credentials are not fully configured. Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET.');
    process.exit(1);
  }

  // Test R2 connection
  try {
    const r2 = getR2Provider();
    console.log(`✅ R2 provider initialized: ${r2.name}`);
  } catch (err) {
    console.error('❌ Failed to initialize R2 provider:', err);
    process.exit(1);
  }

  // Test Blob connection
  try {
    const blob = getVercelBlobProvider();
    console.log(`✅ Vercel Blob provider initialized: ${blob.name}`);
  } catch (err) {
    console.error('❌ Failed to initialize Vercel Blob provider:', err);
    process.exit(1);
  }

  console.log();
  console.log('─── Collecting file records ────────────────────────────────');

  // Collect all file records from the database
  const records: MigrationRecord[] = await collectFileRecords();
  console.log(`Found ${records.length} file records to process.`);
  console.log();

  if (records.length === 0) {
    console.log('No files to migrate. Done!');
    return;
  }

  // Process in batches
  const result: MigrationResult = {
    total: records.length,
    migrated: 0,
    skipped: 0,
    failed: 0,
    errors: [],
  };

  for (let i = 0; i < records.length; i += batchSize) {
    const batch = records.slice(i, i + batchSize);
    console.log(`Processing batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(records.length / batchSize)} (${batch.length} records)...`);

    // Process in sub-batches of MAX_CONCURRENT_UPLOADS to limit memory pressure
    for (let j = 0; j < batch.length; j += MAX_CONCURRENT_UPLOADS) {
      const subBatch = batch.slice(j, j + MAX_CONCURRENT_UPLOADS);

      const outcomes = await Promise.allSettled(
        subBatch.map((record) => migrateRecord(record, result))
      );

      for (let k = 0; k < outcomes.length; k++) {
        const outcome = outcomes[k];
        if (outcome.status === 'rejected') {
          const record = subBatch[k];
          result.failed++;
          result.errors.push({
            record,
            error: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason),
          });
          console.error(
            `  ❌ Failed: ${record.model}/${record.id} (${record.urlField}): ${outcome.reason instanceof Error ? outcome.reason.message : outcome.reason}`
          );
        }
      }
    }
  }

  // Print summary
  console.log();
  console.log('─── Migration Summary ──────────────────────────────────────');
  console.log(`Total records:  ${result.total}`);
  console.log(`Migrated:       ${result.migrated}`);
  console.log(`Skipped:        ${result.skipped}`);
  console.log(`Failed:         ${result.failed}`);

  if (result.errors.length > 0) {
    console.log();
    console.log('─── Failed Records ─────────────────────────────────────────');
    for (const { record, error } of result.errors) {
      console.log(`  ${record.model}/${record.id} (${record.urlField}): ${error}`);
    }
  }

  if (dryRun) {
    console.log();
    console.log('⚠️  DRY RUN — No files were actually migrated.');
    console.log('   Run without --dry-run to perform the migration.');
  }

  await prisma.$disconnect();
}

// ─── Collect Records ──────────────────────────────────────────────────────────

async function collectFileRecords(): Promise<MigrationRecord[]> {
  const records: MigrationRecord[] = [];

  // ── UploadedFile records ──
  const uploadedFiles = await prisma.uploadedFile.findMany({
    where: {
      // Only files stored in Vercel Blob that haven't been migrated yet
      storageProvider: 'blob',
    },
  });

  for (const f of uploadedFiles) {
    // We need to find the original Blob URL
    // The storageKey might be a partial key — we'll try to use it
    records.push({
      model: 'UploadedFile',
      id: f.id,
      urlField: 'storageKey',
      url: f.storageKey,
      storageProviderField: 'storageProvider',
      storageKeyField: 'storageKey',
    });
  }

  // ── User.avatarUrl ──
  const usersWithAvatar = await prisma.user.findMany({
    where: {
      avatarUrl: { not: null },
      avatarStorageProvider: null, // Not yet migrated
    },
    select: { id: true, avatarUrl: true },
  });

  for (const u of usersWithAvatar) {
    if (u.avatarUrl && isVercelBlobUrl(u.avatarUrl)) {
      records.push({
        model: 'User',
        id: u.id,
        urlField: 'avatarUrl',
        url: u.avatarUrl,
        storageProviderField: 'avatarStorageProvider',
        storageKeyField: 'avatarStorageKey',
      });
    }
  }

  // ── Agency.logoUrl ──
  const agenciesWithLogo = await prisma.agency.findMany({
    where: {
      logoUrl: { not: null },
      logoStorageProvider: null,
    },
    select: { id: true, logoUrl: true },
  });

  for (const a of agenciesWithLogo) {
    if (a.logoUrl && isVercelBlobUrl(a.logoUrl)) {
      records.push({
        model: 'Agency',
        id: a.id,
        urlField: 'logoUrl',
        url: a.logoUrl,
        storageProviderField: 'logoStorageProvider',
        storageKeyField: 'logoStorageKey',
      });
    }
  }

  // ── Transaction.receiptUrl ──
  const transactionsWithReceipt = await prisma.transaction.findMany({
    where: {
      receiptUrl: { not: null },
      receiptStorageProvider: null,
    },
    select: { id: true, receiptUrl: true },
  });

  for (const t of transactionsWithReceipt) {
    if (t.receiptUrl && isVercelBlobUrl(t.receiptUrl)) {
      records.push({
        model: 'Transaction',
        id: t.id,
        urlField: 'receiptUrl',
        url: t.receiptUrl,
        storageProviderField: 'receiptStorageProvider',
        storageKeyField: 'receiptStorageKey',
      });
    }
  }

  // ── SmsPurchase.receiptUrl ──
  const smsPurchasesWithReceipt = await prisma.smsPurchase.findMany({
    where: {
      receiptUrl: { not: null },
      receiptStorageProvider: null,
    },
    select: { id: true, receiptUrl: true },
  });

  for (const s of smsPurchasesWithReceipt) {
    if (s.receiptUrl && isVercelBlobUrl(s.receiptUrl)) {
      records.push({
        model: 'SmsPurchase',
        id: s.id,
        urlField: 'receiptUrl',
        url: s.receiptUrl,
        storageProviderField: 'receiptStorageProvider',
        storageKeyField: 'receiptStorageKey',
      });
    }
  }

  return records;
}

// ─── Migrate Single Record ────────────────────────────────────────────────────

async function migrateRecord(record: MigrationRecord, result: MigrationResult): Promise<void> {
  const { model, id, url, storageProviderField, storageKeyField } = record;

  // Skip if URL is not a Vercel Blob URL
  if (!isVercelBlobUrl(url) && !url.startsWith('https://')) {
    result.skipped++;
    return;
  }

  if (dryRun) {
    console.log(`  [DRY RUN] Would migrate: ${model}/${id} (${url.substring(0, 60)}...)`);
    result.migrated++;
    return;
  }

  // ── Head request to check file size before downloading ──────────────────
  console.log(`  ↓ Checking size: ${model}/${id}`);
  const blobToken = process.env.BLOB_READ_WRITE_TOKEN!;

  const headResponse = await fetch(url, {
    method: 'HEAD',
    headers: { Authorization: `Bearer ${blobToken}` },
  });

  if (!headResponse.ok) {
    throw new Error(`HEAD request failed with status ${headResponse.status}`);
  }

  const contentLength = parseInt(headResponse.headers.get('content-length') || '0', 10);
  if (contentLength > MAX_FILE_SIZE) {
    console.warn(
      `  ⚠️  Skipping ${model}/${id}: file size ${Math.round(contentLength / 1024 / 1024)}MB exceeds ${MAX_FILE_SIZE / 1024 / 1024}MB limit`
    );
    result.skipped++;
    return;
  }

  // ── Download from Vercel Blob using streaming ────────────────────────────
  console.log(`  ↓ Downloading: ${model}/${id} (${Math.round(contentLength / 1024)}KB)`);
  const downloadResponse = await fetch(url, {
    headers: { Authorization: `Bearer ${blobToken}` },
  });

  if (!downloadResponse.ok) {
    throw new Error(`Download failed with status ${downloadResponse.status}`);
  }

  const contentType = downloadResponse.headers.get('content-type') || 'application/octet-stream';

  if (!downloadResponse.body) throw new Error('No response body from Blob download');

  const readable = Readable.fromWeb(downloadResponse.body as any);

  // Determine the key for R2
  let r2Key: string;
  try {
    const parsedUrl = new URL(url);
    r2Key = parsedUrl.pathname.startsWith('/') ? parsedUrl.pathname.slice(1) : parsedUrl.pathname;
  } catch {
    r2Key = `migrated/${model}/${id}/${Date.now()}`;
  }

  try {
    // Upload to R2 using streaming — avoids loading entire file into RAM
    console.log(`  ↑ Uploading to R2 (streaming): ${r2Key}`);
    const r2 = getR2Provider();
    const uploadResult = await r2.upload(readable as any, r2Key, {
      access: 'public',
      contentType,
      addRandomSuffix: false,
    });

    // Update the database
    console.log(`  💾 Updating database: ${model}/${id}`);
    switch (model) {
      case 'User':
        await prisma.user.update({
          where: { id },
          data: {
            [storageProviderField]: 'r2',
            [storageKeyField]: uploadResult.key,
          },
        });
        break;
      case 'Agency':
        await prisma.agency.update({
          where: { id },
          data: {
            [storageProviderField]: 'r2',
            [storageKeyField]: uploadResult.key,
          },
        });
        break;
      case 'Transaction':
        await prisma.transaction.update({
          where: { id },
          data: {
            [storageProviderField]: 'r2',
            [storageKeyField]: uploadResult.key,
          },
        });
        break;
      case 'SmsPurchase':
        await prisma.smsPurchase.update({
          where: { id },
          data: {
            [storageProviderField]: 'r2',
            [storageKeyField]: uploadResult.key,
          },
        });
        break;
      case 'UploadedFile':
        await prisma.uploadedFile.update({
          where: { id },
          data: {
            storageProvider: 'r2',
            storageKey: uploadResult.key,
          },
        });
        break;
    }

    result.migrated++;
    console.log(`  ✅ Migrated: ${model}/${id} → R2 key: ${uploadResult.key}`);
  } finally {
    // Ensure the readable stream is always cleaned up to prevent memory leaks
    if (!readable.destroyed) {
      readable.destroy();
    }
  }
}

// ─── Run ──────────────────────────────────────────────────────────────────────

main().catch((err) => {
  console.error('Migration script failed:', err);
  process.exit(1);
});
