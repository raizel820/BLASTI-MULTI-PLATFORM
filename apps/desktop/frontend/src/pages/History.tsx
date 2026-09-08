import { useCallback, useState } from 'react';
import { Search, Download, Loader2 } from 'lucide-react';
import api from '@/api/client';
import { useApi } from '@/hooks/use-api';
import { formatTime, formatDate, getStatusBgColor } from '@/lib/utils';

interface Reservation {
  id: string;
  ticketNumber: string;
  customerName?: string;
  serviceName?: string;
  status: string;
  createdAt?: string;
  completedAt?: string;
  calledAt?: string;
  cancelledAt?: string;
  noShowAt?: string;
}

const statusFilters = ['ALL', 'COMPLETED', 'CANCELLED', 'NO_SHOW', 'WAITING'];

export default function HistoryPage() {
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [search, setSearch] = useState('');
  const [skip, setSkip] = useState(0);
  const [exporting, setExporting] = useState(false);
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [showExport, setShowExport] = useState(false);

  const fetchHistory = useCallback(() =>
    api.getHistory({ skip, take: 50, status: statusFilter !== 'ALL' ? statusFilter : undefined }),
    [skip, statusFilter]
  );
  const { data, isLoading } = useApi(fetchHistory);

  const reservations = ((data?.reservations || data?.data || data?.entries || []) as Reservation[]) || [];

  const filtered = search
    ? reservations.filter((r) =>
        (r.customerName || '').toLowerCase().includes(search.toLowerCase()) ||
        (r.ticketNumber || '').toLowerCase().includes(search.toLowerCase())
      )
    : reservations;

  const handleExportCSV = async () => {
    setExporting(true);
    try {
      const params: Record<string, string> = {};
      if (dateFrom) params.from = dateFrom;
      if (dateTo) params.to = dateTo;

      const res = await api.exportCSV(params);

      // The response could be the CSV string directly or wrapped in { data: "..." }
      const csvContent = typeof res === 'string' ? res : (res?.data || res?.csv || '');
      if (!csvContent) {
        throw new Error('No CSV data returned');
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
      setShowExport(false);
    } catch (err) {
      console.error('Export failed:', err);
    } finally {
      setExporting(false);
    }
  };

  const inputClass = "w-full px-3 py-2 rounded-lg border border-border bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring text-sm";

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">History</h1>
          <p className="text-sm text-muted-foreground mt-0.5">Past reservations and queue activity</p>
        </div>
        <button
          onClick={() => setShowExport(true)}
          className="px-4 py-2 rounded-lg border border-border text-sm font-medium text-foreground hover:bg-accent transition-colors flex items-center gap-2"
        >
          <Download className="w-4 h-4" />
          Export CSV
        </button>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-xs">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <input
            value={search} onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name or ticket..."
            className="w-full pl-9 pr-3 py-2 rounded-lg border border-border bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring text-sm"
          />
        </div>
        <div className="flex items-center gap-1">
          {statusFilters.map((s) => (
            <button
              key={s} onClick={() => { setStatusFilter(s); setSkip(0); }}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                statusFilter === s ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent'
              }`}
            >
              {s.replace('_', ' ')}
            </button>
          ))}
        </div>
      </div>

      {/* Table */}
      <div className="rounded-xl border border-border bg-card overflow-hidden">
        {isLoading ? (
          <div className="flex items-center justify-center py-12 text-muted-foreground">
            <Loader2 className="w-5 h-5 animate-spin" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="py-12 text-center">
            <p className="text-sm text-muted-foreground">No reservations found</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border bg-muted/30">
                  <th className="text-left text-xs font-medium text-muted-foreground px-5 py-3">Ticket</th>
                  <th className="text-left text-xs font-medium text-muted-foreground px-5 py-3">Customer</th>
                  <th className="text-left text-xs font-medium text-muted-foreground px-5 py-3">Service</th>
                  <th className="text-left text-xs font-medium text-muted-foreground px-5 py-3">Status</th>
                  <th className="text-left text-xs font-medium text-muted-foreground px-5 py-3">Created</th>
                  <th className="text-left text-xs font-medium text-muted-foreground px-5 py-3">Completed</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {filtered.map((r) => (
                  <tr key={r.id} className="hover:bg-muted/20 transition-colors">
                    <td className="px-5 py-3 text-sm font-medium text-foreground">{r.ticketNumber || '—'}</td>
                    <td className="px-5 py-3 text-sm text-foreground">{r.customerName || 'Walk-in'}</td>
                    <td className="px-5 py-3 text-sm text-muted-foreground">{r.serviceName || 'General'}</td>
                    <td className="px-5 py-3">
                      <span className={`text-xs px-2 py-0.5 rounded-full ${getStatusBgColor(r.status)}`}>
                        {r.status.replace('_', ' ')}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-xs text-muted-foreground">{formatTime(r.createdAt)}</td>
                    <td className="px-5 py-3 text-xs text-muted-foreground">
                      {r.completedAt ? formatTime(r.completedAt) : r.cancelledAt ? formatTime(r.cancelledAt) : r.noShowAt ? formatTime(r.noShowAt) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Export Dialog */}
      {showExport && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setShowExport(false)}>
          <div className="bg-card rounded-xl border border-border p-6 w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-semibold text-foreground mb-4">Export CSV</h2>
            <div className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1">From Date</label>
                <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className={inputClass} />
              </div>
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1">To Date</label>
                <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className={inputClass} />
              </div>
            </div>
            <div className="flex gap-3 mt-5">
              <button onClick={() => setShowExport(false)} className="flex-1 py-2 rounded-lg border border-border text-sm font-medium text-foreground hover:bg-accent transition-colors">Cancel</button>
              <button onClick={handleExportCSV} disabled={exporting} className="flex-1 py-2 rounded-lg bg-emerald-500 text-white text-sm font-medium hover:bg-emerald-600 disabled:opacity-50 transition-colors flex items-center justify-center gap-2">
                {exporting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
                Export
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
