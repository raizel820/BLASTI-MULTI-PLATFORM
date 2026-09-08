import { useCallback } from 'react';
import { Clock, UserX, Wrench, Timer, BarChart3, Loader2 } from 'lucide-react';
import api from '@/api/client';
import { useApi } from '@/hooks/use-api';
import StatsCard from '@/components/shared/stats-card';
import { formatWaitTime } from '@/lib/utils';

interface PeakHour { hour: number; count: number; }
interface NoShowData { rate: number; total: number; noShows: number; byService?: { name: string; rate: number }[]; }
interface ServiceItem { name: string; count: number; percentage: number; }
interface WaitTimeData { avgMinutes: number; medianMinutes: number; p90Minutes: number; }
interface DailyItem { date: string; count: number; }

function BarChart({ data, labelKey, valueKey, maxBars }: {
  data: Record<string, unknown>[];
  labelKey: string;
  valueKey: string;
  maxBars?: number;
}) {
  if (!data || data.length === 0) return <p className="text-sm text-muted-foreground text-center py-6">No data available</p>;
  const items = maxBars ? data.slice(0, maxBars) : data;
  const maxVal = Math.max(...items.map((d) => (d[valueKey] as number) || 0), 1);

  return (
    <div className="space-y-2">
      {items.map((item, i) => {
        const val = (item[valueKey] as number) || 0;
        const pct = (val / maxVal) * 100;
        return (
          <div key={i} className="flex items-center gap-3">
            <span className="text-xs text-muted-foreground w-20 text-right truncate">{String(item[labelKey])}</span>
            <div className="flex-1 h-5 rounded bg-muted/50 overflow-hidden">
              <div className="h-full bg-emerald-500/70 rounded transition-all" style={{ width: `${pct}%` }} />
            </div>
            <span className="text-xs text-muted-foreground w-10 text-right">{val}</span>
          </div>
        );
      })}
    </div>
  );
}

export default function AnalyticsPage() {
  const fetchPeak = useCallback(() => api.getPeakHours(), []);
  const fetchNoShow = useCallback(() => api.getNoShowAnalytics(), []);
  const fetchService = useCallback(() => api.getServiceBreakdown(), []);
  const fetchWait = useCallback(() => api.getWaitTimes(), []);
  const fetchDaily = useCallback(() => api.getDailyChart(), []);

  const { data: peakData, isLoading: peakLoading } = useApi(fetchPeak);
  const { data: noShowData, isLoading: noShowLoading } = useApi(fetchNoShow);
  const { data: serviceData, isLoading: serviceLoading } = useApi(fetchService);
  const { data: waitData, isLoading: waitLoading } = useApi(fetchWait);
  const { data: dailyData, isLoading: dailyLoading } = useApi(fetchDaily);

  const peakHours = ((peakData?.peakHours || peakData?.data || peakData?.hours || []) as PeakHour[]) || [];
  const noShow = (noShowData?.noShow || noShowData?.data || noShowData || {}) as NoShowData;
  const services = ((serviceData?.services || serviceData?.breakdown || serviceData?.data || []) as ServiceItem[]) || [];
  const waitTimes = (waitData?.waitTimes || waitData?.data || waitData || {}) as WaitTimeData;
  const daily = ((dailyData?.daily || dailyData?.data || dailyData?.chart || []) as DailyItem[]) || [];

  const peakChartData = peakHours.map((h) => ({
    label: `${h.hour}:00`,
    count: h.count,
  }));

  const dailyChartData = daily.map((d) => ({
    label: d.date,
    count: d.count,
  }));

  const serviceChartData = services.map((s) => ({
    label: s.name,
    count: s.count,
    percentage: s.percentage,
  }));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Analytics</h1>
        <p className="text-sm text-muted-foreground mt-0.5">Performance insights and queue analytics</p>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatsCard
          label="No-Show Rate"
          value={`${(noShow.rate ?? 0).toFixed(1)}%`}
          icon={UserX}
          className="border-orange-500/20"
        />
        <StatsCard
          label="Avg Wait"
          value={formatWaitTime(waitTimes.avgMinutes ?? null)}
          icon={Timer}
          className="border-blue-500/20"
        />
        <StatsCard
          label="Median Wait"
          value={formatWaitTime(waitTimes.medianMinutes ?? null)}
          icon={Clock}
          className="border-purple-500/20"
        />
        <StatsCard
          label="P90 Wait"
          value={formatWaitTime(waitTimes.p90Minutes ?? null)}
          icon={Wrench}
          className="border-amber-500/20"
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Peak Hours */}
        <div className="rounded-xl border border-border bg-card">
          <div className="px-4 py-3 border-b border-border flex items-center gap-2">
            <Clock className="w-4 h-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold text-foreground">Peak Hours</h2>
          </div>
          <div className="p-4">
            {peakLoading ? (
              <div className="flex items-center justify-center py-8 text-muted-foreground"><Loader2 className="w-5 h-5 animate-spin" /></div>
            ) : (
              <BarChart data={peakChartData} labelKey="label" valueKey="count" />
            )}
          </div>
        </div>

        {/* Daily Chart */}
        <div className="rounded-xl border border-border bg-card">
          <div className="px-4 py-3 border-b border-border flex items-center gap-2">
            <BarChart3 className="w-4 h-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold text-foreground">Daily Visitors</h2>
          </div>
          <div className="p-4">
            {dailyLoading ? (
              <div className="flex items-center justify-center py-8 text-muted-foreground"><Loader2 className="w-5 h-5 animate-spin" /></div>
            ) : (
              <BarChart data={dailyChartData} labelKey="label" valueKey="count" maxBars={14} />
            )}
          </div>
        </div>

        {/* Service Breakdown */}
        <div className="rounded-xl border border-border bg-card">
          <div className="px-4 py-3 border-b border-border flex items-center gap-2">
            <Wrench className="w-4 h-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold text-foreground">Service Breakdown</h2>
          </div>
          <div className="p-4">
            {serviceLoading ? (
              <div className="flex items-center justify-center py-8 text-muted-foreground"><Loader2 className="w-5 h-5 animate-spin" /></div>
            ) : (
              <BarChart data={serviceChartData} labelKey="label" valueKey="count" />
            )}
          </div>
        </div>

        {/* No-Show Analytics */}
        <div className="rounded-xl border border-border bg-card">
          <div className="px-4 py-3 border-b border-border flex items-center gap-2">
            <UserX className="w-4 h-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold text-foreground">No-Show Details</h2>
          </div>
          <div className="p-4 space-y-3">
            {noShowLoading ? (
              <div className="flex items-center justify-center py-8 text-muted-foreground"><Loader2 className="w-5 h-5 animate-spin" /></div>
            ) : (
              <>
                <div className="grid grid-cols-3 gap-4 text-center">
                  <div>
                    <p className="text-2xl font-bold text-foreground">{noShow.total ?? 0}</p>
                    <p className="text-xs text-muted-foreground">Total</p>
                  </div>
                  <div>
                    <p className="text-2xl font-bold text-orange-400">{noShow.noShows ?? 0}</p>
                    <p className="text-xs text-muted-foreground">No-Shows</p>
                  </div>
                  <div>
                    <p className="text-2xl font-bold text-foreground">{(noShow.rate ?? 0).toFixed(1)}%</p>
                    <p className="text-xs text-muted-foreground">Rate</p>
                  </div>
                </div>
                {noShow.byService && noShow.byService.length > 0 && (
                  <div className="pt-3 border-t border-border">
                    <p className="text-xs font-medium text-muted-foreground mb-2">By Service</p>
                    {noShow.byService.map((s, i) => (
                      <div key={i} className="flex items-center justify-between py-1">
                        <span className="text-sm text-foreground">{s.name}</span>
                        <span className="text-sm text-orange-400 font-medium">{s.rate.toFixed(1)}%</span>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
