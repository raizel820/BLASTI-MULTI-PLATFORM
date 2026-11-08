'use client';

/**
 * ProfileInvoices — customer "My invoices" card (v0.6.53).
 *
 * GET /api/billing/invoices auto-scopes to the signed-in customer's own
 * purchases, so the shared InvoicesPanel needs no props beyond chrome text.
 * The QR scanner trigger sits in the section header row above the panel:
 * pointing the camera at any BLASTI invoice/receipt verifies it server-side
 * and marks the document as checked (same flow as the agency scanner).
 */

import { useState } from 'react';
import { motion } from 'framer-motion';
import { ScanLine } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useLanguage } from '@/hooks/use-language';
import { InvoicesPanel } from '@/components/shared/billing/invoices-panel';
import { InvoiceQrScannerDialog } from '@/components/shared/billing/invoice-qr-scanner-dialog';

export function ProfileInvoices() {
  const { t } = useLanguage();
  // Invoice QR scanner dialog visibility.
  const [scannerOpen, setScannerOpen] = useState(false);

  return (
    <motion.section
      initial={{ opacity: 0, y: 15 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.24 }}
      aria-label={t('customerInvoicesTitle')}
    >
      {/* Header row of the invoices card area — scanner trigger, end-aligned
          (flexbox respects the document direction, so this is RTL-safe). */}
      <div className="flex justify-end mb-2">
        <Button
          variant="outline"
          className="min-h-[44px]"
          onClick={() => setScannerOpen(true)}
        >
          <ScanLine className="h-4 w-4 me-2" aria-hidden="true" />
          {t('billingScanQr')}
        </Button>
      </div>

      <InvoicesPanel
        title={t('customerInvoicesTitle')}
        subtitle={t('billingInvoicesSubtitle')}
      />

      <InvoiceQrScannerDialog open={scannerOpen} onOpenChange={setScannerOpen} />
    </motion.section>
  );
}
