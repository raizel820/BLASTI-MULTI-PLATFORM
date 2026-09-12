import { useState } from 'react';
import { toast } from 'sonner';
import { useLanguage } from '@/hooks/use-language';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  History,
  Download,
  Loader2,
  CalendarDays,
} from 'lucide-react';
import { AgencyHistoryContent } from '@/components/agency/agency-history-sheet';
import { apiFetch } from '@/lib/api-fetch';

// ─── CSV Export Dialog ────────────────────────────────────────────────────────

function ExportCSVDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useLanguage();
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [exporting, setExporting] = useState(false);

  const handleExport = async () => {
    setExporting(true);
    try {
      const params = new URLSearchParams();
      if (dateFrom) params.set('from', dateFrom);
      if (dateTo) params.set('to', dateTo);

      const query = params.toString() ? `?${params.toString()}` : '';
      const res = await apiFetch(`/api/agency/history/export${query}`);

      if (!res.ok) {
        toast.error(t('error'));
        return;
      }

      // The response could be CSV string directly or wrapped in { data: "..." }
      const contentType = res.headers.get('content-type') || '';
      let csvContent: string;

      if (contentType.includes('text/csv') || contentType.includes('text/plain')) {
        csvContent = await res.text();
      } else {
        const data = await res.json().catch(() => undefined);
        csvContent = typeof data === 'string' ? data : (data?.data || data?.csv || '');
      }

      if (!csvContent) {
        toast.error(t('error'));
        return;
      }

      // Download as file
      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `blasti-export-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
      onOpenChange(false);
      toast.success(t('exportData') || 'Export successful');
    } catch (err) {
      console.error('Export failed:', err);
      toast.error(t('error'));
    } finally {
      setExporting(false);
    }
  };

  const inputClass =
    'w-full px-3 py-2 rounded-lg border border-border bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring text-sm';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Download className="h-5 w-5 text-emerald-500" />
            {t('exportCsv')}
          </DialogTitle>
          <DialogDescription>
            {t('dateRange') || 'Select date range for export'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 pt-2">
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1.5">
              <CalendarDays className="h-3 w-3 inline me-1" />
              {t('fromDate') || 'From Date'}
            </label>
            <Input
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              className={inputClass}
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1.5">
              <CalendarDays className="h-3 w-3 inline me-1" />
              {t('toDate') || 'To Date'}
            </label>
            <Input
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              className={inputClass}
            />
          </div>
        </div>

        <div className="flex gap-3 mt-6">
          <Button
            variant="outline"
            className="flex-1"
            onClick={() => onOpenChange(false)}
          >
            {t('cancel')}
          </Button>
          <Button
            className="flex-1 bg-emerald-600 hover:bg-emerald-700 text-white"
            onClick={handleExport}
            disabled={exporting}
          >
            {exporting ? (
              <Loader2 className="h-4 w-4 animate-spin me-2" />
            ) : (
              <Download className="h-4 w-4 me-2" />
            )}
            {t('exportCsv')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─── History Page ─────────────────────────────────────────────────────────────
// Full-page rendering of the history functionality using the shared
// AgencyHistoryContent component (the same content used in the sheet/drawer
// on the Web version). Desktop shows history as a dedicated page rather than
// a sheet, which is the accepted Desktop adaptation.

export default function HistoryPage() {
  const { t } = useLanguage();
  const [showExport, setShowExport] = useState(false);

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Header */}
      <div className="shrink-0 px-6 py-4 border-b border-border">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="h-9 w-9 rounded-lg bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center">
              <History className="h-4.5 w-4.5 text-emerald-600 dark:text-emerald-400" />
            </div>
            <div>
              <h1 className="text-lg font-semibold text-foreground">
                {t('reservationHistory')}
              </h1>
              <p className="text-xs text-muted-foreground mt-0.5">
                {t('noReservationHistoryDesc')}
              </p>
            </div>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowExport(true)}
            className="gap-2"
          >
            <Download className="h-4 w-4" />
            {t('exportCsv')}
          </Button>
        </div>
      </div>

      {/* Content — uses the shared component */}
      <AgencyHistoryContent active={true} />

      {/* Export CSV Dialog */}
      <ExportCSVDialog open={showExport} onOpenChange={setShowExport} />
    </div>
  );
}
