'use client'
import { apiFetch } from '@/lib/api-fetch';;

import { useState, useEffect, useCallback } from 'react';
import { useAppStore } from '@/store/use-app-store';
import { useLanguage } from '@/hooks/use-language';
import { translateStatus } from '@/lib/enum-i18n';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { Separator } from '@/components/ui/separator';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import {
  ArrowLeft,
  RefreshCw,
  Loader2,
  Eye,
  XCircle,
  Building2,
  Mail,
  Phone,
  Hash,
  Calendar,
  Package,
  CheckCircle2,
  Truck,
  Clock,
  Cpu,
  Filter,
  CreditCard,
  Coins,
  Receipt,
  MapPin,
} from 'lucide-react';
import { toast } from 'sonner';
import { motion, AnimatePresence } from 'framer-motion';
import { translateCategory } from '@/lib/enum-i18n';

// ─── Types ──────────────────────────────────────────────────────────────────

type OrderStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'FULFILLED';
type PaymentModel = 'UPFRONT' | 'MONTHLY';
type StatusFilter = 'ALL' | OrderStatus;

interface OrderItem {
  id: string;
  orderId: string;
  productId: string;
  quantity: number;
  unitPrice: number;
  product: {
    id: string;
    name: string;
    nameAr?: string | null;
    category?: string | null;
  };
}

interface OrderAgency {
  id: string;
  name: string;
  nameAr?: string | null;
  customCode?: string | null;
  city?: string | null;
  phone?: string | null;
  email?: string | null;
}

interface HardwareOrder {
  id: string;
  agencyId: string;
  paymentModel: PaymentModel;
  commitmentMonths: number | null;
  totalBasePrice: number;
  extraPercentage: number;
  monthlyExtra: number;
  upfrontTotal: number;
  status: OrderStatus;
  createdAt: string;
  updatedAt: string;
  agency: OrderAgency;
  items: OrderItem[];
}

interface OrderStats {
  pending: number;
  approved: number;
  rejected: number;
  fulfilled: number;
  total: number;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function statusBadgeClass(status: OrderStatus): string {
  switch (status) {
    case 'PENDING':
      return 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400';
    case 'APPROVED':
      return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400';
    case 'REJECTED':
      return 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400';
    case 'FULFILLED':
      return 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400';
    default:
      return 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300';
  }
}

function statusDotClass(status: OrderStatus): string {
  switch (status) {
    case 'PENDING':
      return 'bg-amber-500';
    case 'APPROVED':
      return 'bg-emerald-500';
    case 'REJECTED':
      return 'bg-red-500';
    case 'FULFILLED':
      return 'bg-blue-500';
    default:
      return 'bg-gray-500';
  }
}

function statusIcon(status: OrderStatus) {
  switch (status) {
    case 'PENDING':
      return Clock;
    case 'APPROVED':
      return CheckCircle2;
    case 'REJECTED':
      return XCircle;
    case 'FULFILLED':
      return Truck;
    default:
      return Clock;
  }
}

function formatDate(iso: string, lang: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString(lang === 'ar' ? 'ar-DZ' : lang === 'fr' ? 'fr-FR' : 'en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

function formatPrice(amount: number): string {
  return `${Number(amount || 0).toLocaleString('en-US')} DZD`;
}

// ─── Component ──────────────────────────────────────────────────────────────

export function AdminHardwareRequests() {
  const { setView } = useAppStore();
  const { t, lang } = useLanguage();
  const isRTL = lang === 'ar';

  const [orders, setOrders] = useState<HardwareOrder[]>([]);
  const [stats, setStats] = useState<OrderStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('ALL');

  // Action loading (per order id)
  const [actionLoadingId, setActionLoadingId] = useState<string | null>(null);

  // Details dialog state
  const [detailsTarget, setDetailsTarget] = useState<HardwareOrder | null>(null);
  const [detailsLoading, setDetailsLoading] = useState(false);

  // Reject dialog state
  const [rejectTarget, setRejectTarget] = useState<HardwareOrder | null>(null);
  const [rejectNotes, setRejectNotes] = useState('');
  const [rejecting, setRejecting] = useState(false);

  // ─── Data fetching ────────────────────────────────────────────────────────

  const fetchOrders = useCallback(async () => {
    setLoading(true);
    try {
      const url =
        statusFilter === 'ALL'
          ? '/api/admin/hardware/orders'
          : `/api/admin/hardware/orders?status=${statusFilter}`;
      const res = await apiFetch(url);
      if (res.ok) {
        const data = await res.json();
        setOrders(data.orders ?? []);
      } else {
        toast.error(t('error'));
      }
    } catch {
      toast.error(t('error'));
    } finally {
      setLoading(false);
    }
  }, [statusFilter, t]);

  const fetchStats = useCallback(async () => {
    try {
      const res = await apiFetch('/api/admin/hardware/orders/stats');
      if (res.ok) {
        const data = await res.json();
        setStats({
          pending: data.pending ?? 0,
          approved: data.approved ?? 0,
          rejected: data.rejected ?? 0,
          fulfilled: data.fulfilled ?? 0,
          total: data.total ?? 0,
        });
      }
    } catch {
      // Silent — stats are non-critical
    }
  }, []);

  useEffect(() => {
    fetchOrders();
  }, [fetchOrders]);

  useEffect(() => {
    fetchStats();
  }, [fetchStats]);

  // ─── Handlers ─────────────────────────────────────────────────────────────

  const handleApprove = async (order: HardwareOrder) => {
    setActionLoadingId(order.id);
    try {
      const res = await apiFetch(`/api/admin/hardware/orders/${order.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'APPROVED' }),
      });
      if (res.ok) {
        const data = await res.json();
        toast.success(t('orderApproved'));
        // Optimistic local update
        setOrders((list) =>
          list.map((o) =>
            o.id === order.id
              ? { ...o, status: 'APPROVED', updatedAt: data.order?.updatedAt ?? o.updatedAt }
              : o,
          ),
        );
        fetchStats();
        // Apply active filter so the approved order disappears from the Pending tab
        if (statusFilter !== 'ALL' && statusFilter !== 'APPROVED') {
          setOrders((list) => list.filter((o) => o.id !== order.id));
        }
      } else {
        const data = await res.json().catch(() => ({}));
        toast.error(data.error || t('error'));
      }
    } catch {
      toast.error(t('error'));
    } finally {
      setActionLoadingId(null);
    }
  };

  const openRejectDialog = (order: HardwareOrder) => {
    setRejectTarget(order);
    setRejectNotes('');
  };

  const handleReject = async () => {
    if (!rejectTarget) return;
    setRejecting(true);
    try {
      const res = await apiFetch(`/api/admin/hardware/orders/${rejectTarget.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: 'REJECTED',
          adminNotes: rejectNotes.trim() || undefined,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        toast.success(t('orderRejected'));
        const rejectedId = rejectTarget.id;
        const updatedAt = data.order?.updatedAt;
        setOrders((list) =>
          list.map((o) =>
            o.id === rejectedId
              ? { ...o, status: 'REJECTED', updatedAt: updatedAt ?? o.updatedAt }
              : o,
          ),
        );
        fetchStats();
        if (statusFilter !== 'ALL' && statusFilter !== 'REJECTED') {
          setOrders((list) => list.filter((o) => o.id !== rejectedId));
        }
        setRejectTarget(null);
        setRejectNotes('');
      } else {
        const data = await res.json().catch(() => ({}));
        toast.error(data.error || t('error'));
      }
    } catch {
      toast.error(t('error'));
    } finally {
      setRejecting(false);
    }
  };

  const handleFulfill = async (order: HardwareOrder) => {
    setActionLoadingId(order.id);
    try {
      const res = await apiFetch(`/api/admin/hardware/orders/${order.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'FULFILLED' }),
      });
      if (res.ok) {
        const data = await res.json();
        toast.success(t('orderFulfilled'));
        setOrders((list) =>
          list.map((o) =>
            o.id === order.id
              ? { ...o, status: 'FULFILLED', updatedAt: data.order?.updatedAt ?? o.updatedAt }
              : o,
          ),
        );
        fetchStats();
        if (statusFilter !== 'ALL' && statusFilter !== 'FULFILLED') {
          setOrders((list) => list.filter((o) => o.id !== order.id));
        }
      } else {
        const data = await res.json().catch(() => ({}));
        toast.error(data.error || t('error'));
      }
    } catch {
      toast.error(t('error'));
    } finally {
      setActionLoadingId(null);
    }
  };

  const openDetails = async (order: HardwareOrder) => {
    setDetailsTarget(order);
    setDetailsLoading(true);
    try {
      const res = await apiFetch(`/api/admin/hardware/orders/${order.id}`);
      if (res.ok) {
        const data = await res.json();
        if (data.order) {
          setDetailsTarget(data.order as HardwareOrder);
        }
      }
    } catch {
      // Keep the cached order from the list as fallback
    } finally {
      setDetailsLoading(false);
    }
  };

  // ─── Derived data ─────────────────────────────────────────────────────────

  const filterButtons: { value: StatusFilter; label: string; count: number }[] = [
    { value: 'ALL', label: t('filterAll'), count: stats?.total ?? orders.length },
    { value: 'PENDING', label: t('pendingOrders'), count: stats?.pending ?? 0 },
    { value: 'APPROVED', label: t('approvedOrders'), count: stats?.approved ?? 0 },
    { value: 'REJECTED', label: t('rejectedOrders'), count: stats?.rejected ?? 0 },
    { value: 'FULFILLED', label: t('fulfilledOrders'), count: stats?.fulfilled ?? 0 },
  ];

  const statCards: {
    label: string;
    value: number;
    status: OrderStatus;
    icon: typeof Clock;
    accent: string;
  }[] = [
    {
      label: t('pendingOrders'),
      value: stats?.pending ?? 0,
      status: 'PENDING',
      icon: Clock,
      accent: 'from-amber-100 to-orange-100 dark:from-amber-900/40 dark:to-orange-900/30',
    },
    {
      label: t('approvedOrders'),
      value: stats?.approved ?? 0,
      status: 'APPROVED',
      icon: CheckCircle2,
      accent:
        'from-emerald-100 to-teal-100 dark:from-emerald-900/40 dark:to-teal-900/30',
    },
    {
      label: t('rejectedOrders'),
      value: stats?.rejected ?? 0,
      status: 'REJECTED',
      icon: XCircle,
      accent: 'from-red-100 to-rose-100 dark:from-red-900/40 dark:to-rose-900/30',
    },
    {
      label: t('fulfilledOrders'),
      value: stats?.fulfilled ?? 0,
      status: 'FULFILLED',
      icon: Truck,
      accent: 'from-blue-100 to-sky-100 dark:from-blue-900/40 dark:to-sky-900/30',
    },
  ];

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="p-4 lg:p-6 space-y-5">
      {/* Header */}
      <motion.div
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
        className="relative rounded-2xl overflow-hidden"
      >
        <div className="premium-header-gradient p-5 md:p-6 text-white">
          <div className="absolute inset-0 overflow-hidden">
            <div className="absolute -top-10 -end-10 w-40 h-40 rounded-full bg-white/10" />
            <div className="absolute -bottom-8 -start-8 w-32 h-32 rounded-full bg-white/5" />
          </div>
          <div className="relative flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Button
                variant="ghost"
                size="icon"
                className="h-10 w-10 rounded-xl bg-white/20 hover:bg-white/30 text-white"
                onClick={() => setView('admin-dashboard')}
              >
                <ArrowLeft className="h-5 w-5 rtl:rotate-180" />
              </Button>
              <div>
                <h1 className="text-2xl font-bold text-white flex items-center gap-2">
                  <Cpu className="h-6 w-6" />
                  {t('hardwareOrderRequests')}
                </h1>
                <p className="text-sm text-emerald-100 mt-0.5">{t('dashboard')}</p>
              </div>
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="h-9 w-9 rounded-xl bg-white/20 hover:bg-white/30 text-white"
              onClick={() => {
                fetchOrders();
                fetchStats();
              }}
              disabled={loading}
            >
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            </Button>
          </div>
        </div>
      </motion.div>

      {/* Stat cards */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, delay: 0.05 }}
        className="grid grid-cols-2 lg:grid-cols-4 gap-3"
      >
        {statCards.map((stat) => {
          const Icon = stat.icon;
          return (
            <Card
              key={stat.status}
              className="border shadow-sm overflow-hidden bg-white dark:bg-gray-900/80"
            >
              <CardContent className="p-4">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-[10px] uppercase tracking-wide text-muted-foreground truncate">
                      {stat.label}
                    </p>
                    <p className="text-2xl font-bold text-foreground mt-1">{stat.value}</p>
                  </div>
                  <div
                    className={`h-10 w-10 rounded-xl bg-gradient-to-br ${stat.accent} flex items-center justify-center flex-shrink-0`}
                  >
                    <Icon className="h-5 w-5 text-foreground/80" />
                  </div>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </motion.div>

      {/* Filter buttons */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, delay: 0.1 }}
        className="flex flex-wrap gap-2"
      >
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground me-1">
          <Filter className="h-3.5 w-3.5" />
        </div>
        {filterButtons.map((btn) => {
          const active = statusFilter === btn.value;
          return (
            <Button
              key={btn.value}
              variant={active ? 'default' : 'outline'}
              size="sm"
              className={`rounded-xl gap-2 h-8 ${active ? '' : 'text-muted-foreground'}`}
              onClick={() => setStatusFilter(btn.value)}
            >
              {btn.label}
              <Badge
                variant="outline"
                className={`text-[9px] px-1.5 py-0 ${
                  active
                    ? 'bg-white/20 text-white border-white/30'
                    : 'bg-muted/50 text-muted-foreground'
                }`}
              >
                {btn.count}
              </Badge>
            </Button>
          );
        })}
      </motion.div>

      {/* Orders list */}
      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {[...Array(4)].map((_, i) => (
            <Skeleton key={i} className="h-64 rounded-2xl" />
          ))}
        </div>
      ) : orders.length === 0 ? (
        <motion.div initial={{ opacity: 0, y: 15 }} animate={{ opacity: 1, y: 0 }}>
          <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80">
            <CardContent className="flex flex-col items-center justify-center py-16">
              <div className="h-16 w-16 rounded-2xl bg-gray-100 dark:bg-gray-800 flex items-center justify-center mb-4">
                <Package className="h-8 w-8 text-gray-400" />
              </div>
              <p className="text-sm font-medium text-foreground">
                {statusFilter === 'PENDING'
                  ? t('noHardwareOrdersPending')
                  : t('noHardwareOrders')}
              </p>
              <p className="text-xs text-muted-foreground mt-1">{t('noDataYet')}</p>
            </CardContent>
          </Card>
        </motion.div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <AnimatePresence mode="popLayout">
            {orders.map((order, idx) => {
              const StatusIcon = statusIcon(order.status);
              const isPending = order.status === 'PENDING';
              const isApproved = order.status === 'APPROVED';
              const agencyLabel =
                (isRTL && order.agency?.nameAr) || order.agency?.name || '—';
              const itemsCount = order.items?.reduce(
                (sum, it) => sum + (it.quantity || 0),
                0,
              );
              const isActing = actionLoadingId === order.id;
              return (
                <motion.div
                  key={order.id}
                  layout
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.95 }}
                  transition={{ delay: idx * 0.05, duration: 0.35 }}
                >
                  <Card className="border shadow-sm overflow-hidden hover:shadow-md transition-shadow bg-white dark:bg-gray-900/80 h-full">
                    <CardHeader className="pb-3">
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex items-center gap-3 min-w-0">
                          <div className="h-11 w-11 rounded-xl bg-gradient-to-br from-amber-100 to-orange-100 dark:from-amber-900/40 dark:to-orange-900/30 flex items-center justify-center flex-shrink-0">
                            <Building2 className="h-5 w-5 text-amber-600 dark:text-amber-400" />
                          </div>
                          <div className="min-w-0">
                            <CardTitle className="text-base font-bold truncate">
                              {agencyLabel}
                            </CardTitle>
                            <div className="flex flex-wrap items-center gap-2 mt-1">
                              <span
                                className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[10px] font-medium ${statusBadgeClass(
                                  order.status,
                                )}`}
                              >
                                <span
                                  className={`h-1.5 w-1.5 rounded-full ${statusDotClass(
                                    order.status,
                                  )}`}
                                />
                                {translateStatus(order.status, t)}
                              </span>
                              <span className="text-[10px] text-muted-foreground inline-flex items-center gap-1">
                                <Calendar className="h-3 w-3" />
                                {formatDate(order.createdAt, lang)}
                              </span>
                            </div>
                          </div>
                        </div>
                        <StatusIcon className="h-5 w-5 text-muted-foreground flex-shrink-0" />
                      </div>
                    </CardHeader>

                    <CardContent className="space-y-3">
                      {/* Agency quick info */}
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        {order.agency?.customCode && (
                          <div className="flex items-center gap-2 p-2 rounded-lg bg-muted/30">
                            <Hash className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
                            <span className="text-xs text-foreground truncate" dir="ltr">
                              {order.agency.customCode}
                            </span>
                          </div>
                        )}
                        {order.agency?.city && (
                          <div className="flex items-center gap-2 p-2 rounded-lg bg-muted/30">
                            <MapPin className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
                            <span className="text-xs text-foreground truncate">
                              {order.agency.city}
                            </span>
                          </div>
                        )}
                      </div>

                      {/* Order meta */}
                      <div className="grid grid-cols-3 gap-2">
                        <div className="flex flex-col gap-1 p-2 rounded-lg bg-muted/30">
                          <p className="text-[9px] uppercase text-muted-foreground inline-flex items-center gap-1">
                            <CreditCard className="h-3 w-3" />
                            {t('orderStatus')}
                          </p>
                          <p className="text-xs font-semibold text-foreground">
                            {order.paymentModel === 'UPFRONT'
                              ? t('paymentModelUpfront')
                              : t('paymentModelMonthly')}
                          </p>
                        </div>
                        <div className="flex flex-col gap-1 p-2 rounded-lg bg-muted/30">
                          <p className="text-[9px] uppercase text-muted-foreground inline-flex items-center gap-1">
                            <Package className="h-3 w-3" />
                            {t('orderItems')}
                          </p>
                          <p className="text-xs font-semibold text-foreground">
                            {order.items?.length ?? 0} · {itemsCount} {t('quantity').toLowerCase()}
                          </p>
                        </div>
                        <div className="flex flex-col gap-1 p-2 rounded-lg bg-muted/30">
                          <p className="text-[9px] uppercase text-muted-foreground inline-flex items-center gap-1">
                            <Coins className="h-3 w-3" />
                            {order.paymentModel === 'UPFRONT'
                              ? t('upfrontTotal')
                              : t('totalBasePrice')}
                          </p>
                          <p className="text-xs font-semibold text-foreground" dir="ltr">
                            {formatPrice(
                              order.paymentModel === 'UPFRONT'
                                ? order.upfrontTotal
                                : order.totalBasePrice,
                            )}
                          </p>
                        </div>
                      </div>

                      {/* Action buttons */}
                      <div className="flex flex-wrap items-center gap-2 pt-1">
                        {isPending && (
                          <>
                            <Button
                              size="sm"
                              className="h-8 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white gap-1.5"
                              onClick={() => handleApprove(order)}
                              disabled={isActing}
                            >
                              {isActing ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <CheckCircle2 className="h-3.5 w-3.5" />
                              )}
                              {t('approveOrder')}
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-8 rounded-xl border-red-300 text-red-600 hover:bg-red-50 hover:text-red-700 dark:border-red-900/60 dark:text-red-400 dark:hover:bg-red-900/20 gap-1.5"
                              onClick={() => openRejectDialog(order)}
                              disabled={isActing}
                            >
                              <XCircle className="h-3.5 w-3.5" />
                              {t('rejectOrder')}
                            </Button>
                          </>
                        )}
                        {isApproved && (
                          <Button
                            size="sm"
                            className="h-8 rounded-xl bg-blue-600 hover:bg-blue-700 text-white gap-1.5"
                            onClick={() => handleFulfill(order)}
                            disabled={isActing}
                          >
                            {isActing ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <Truck className="h-3.5 w-3.5" />
                            )}
                            {t('fulfillOrder')}
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-8 rounded-xl ms-auto gap-1.5 text-muted-foreground"
                          onClick={() => openDetails(order)}
                        >
                          <Eye className="h-3.5 w-3.5" />
                          {t('viewOrderDetails')}
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                </motion.div>
              );
            })}
          </AnimatePresence>
        </div>
      )}

      {/* Details dialog */}
      <Dialog
        open={!!detailsTarget}
        onOpenChange={(open) => {
          if (!open) {
            setDetailsTarget(null);
          }
        }}
      >
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-hidden p-0">
          <DialogHeader className="p-6 pb-4 border-b">
            <DialogTitle className="flex items-center gap-2 text-lg">
              <Package className="h-5 w-5 text-amber-600 dark:text-amber-400" />
              {t('orderDetails')}
            </DialogTitle>
            <DialogDescription className="sr-only">
              {t('orderDetails')}
            </DialogDescription>
          </DialogHeader>

          {detailsTarget && (
            <ScrollArea className="max-h-[65vh]">
              <div className="p-6 pt-4 space-y-5">
                {detailsLoading ? (
                  <div className="space-y-3">
                    <Skeleton className="h-20 rounded-xl" />
                    <Skeleton className="h-32 rounded-xl" />
                    <Skeleton className="h-24 rounded-xl" />
                  </div>
                ) : (
                  <>
                    {/* Agency info */}
                    <section className="space-y-2">
                      <h3 className="text-xs uppercase tracking-wide text-muted-foreground font-semibold inline-flex items-center gap-1.5">
                        <Building2 className="h-3.5 w-3.5" />
                        {t('agencyInfo')}
                      </h3>
                      <Card className="bg-muted/30 border-0">
                        <CardContent className="p-3 grid grid-cols-1 sm:grid-cols-2 gap-2">
                          <div className="flex items-center gap-2 min-w-0">
                            <Building2 className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
                            <span className="text-xs text-foreground truncate">
                              {(isRTL && detailsTarget.agency?.nameAr) ||
                                detailsTarget.agency?.name ||
                                '—'}
                            </span>
                          </div>
                          {detailsTarget.agency?.customCode && (
                            <div className="flex items-center gap-2 min-w-0">
                              <Hash className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
                              <span className="text-xs text-foreground truncate" dir="ltr">
                                {detailsTarget.agency.customCode}
                              </span>
                            </div>
                          )}
                          {detailsTarget.agency?.email && (
                            <div className="flex items-center gap-2 min-w-0">
                              <Mail className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
                              <span className="text-xs text-foreground truncate" dir="ltr">
                                {detailsTarget.agency.email}
                              </span>
                            </div>
                          )}
                          {detailsTarget.agency?.phone && (
                            <div className="flex items-center gap-2 min-w-0">
                              <Phone className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
                              <span className="text-xs text-foreground truncate" dir="ltr">
                                {detailsTarget.agency.phone}
                              </span>
                            </div>
                          )}
                          {detailsTarget.agency?.city && (
                            <div className="flex items-center gap-2 min-w-0">
                              <MapPin className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
                              <span className="text-xs text-foreground truncate">
                                {detailsTarget.agency.city}
                              </span>
                            </div>
                          )}
                        </CardContent>
                      </Card>
                    </section>

                    {/* Order items */}
                    <section className="space-y-2">
                      <h3 className="text-xs uppercase tracking-wide text-muted-foreground font-semibold inline-flex items-center gap-1.5">
                        <Package className="h-3.5 w-3.5" />
                        {t('orderItems')}
                      </h3>
                      <Card className="border-0 bg-muted/30">
                        <CardContent className="p-0">
                          <div className="divide-y divide-border/60">
                            {detailsTarget.items?.map((item) => {
                              const productLabel =
                                (isRTL && item.product?.nameAr) ||
                                item.product?.name ||
                                '—';
                              const subtotal = (item.quantity || 0) * (item.unitPrice || 0);
                              return (
                                <div
                                  key={item.id}
                                  className="flex items-center justify-between gap-2 p-3"
                                >
                                  <div className="min-w-0 flex-1">
                                    <p className="text-xs font-semibold text-foreground truncate">
                                      {productLabel}
                                    </p>
                                    {item.product?.category && (
                                      <p className="text-[10px] text-muted-foreground">
                                        {translateCategory(item.product.category, t)}
                                      </p>
                                    )}
                                    <p className="text-[10px] text-muted-foreground mt-0.5 inline-flex gap-2">
                                      <span>
                                        {t('quantity')}: <b className="text-foreground">{item.quantity}</b>
                                      </span>
                                      <span>
                                        {t('unitPrice')}:{' '}
                                        <b className="text-foreground" dir="ltr">
                                          {formatPrice(item.unitPrice)}
                                        </b>
                                      </span>
                                    </p>
                                  </div>
                                  <div className="text-end">
                                    <p className="text-xs font-bold text-foreground" dir="ltr">
                                      {formatPrice(subtotal)}
                                    </p>
                                  </div>
                                </div>
                              );
                            })}
                            {(!detailsTarget.items || detailsTarget.items.length === 0) && (
                              <div className="p-4 text-center text-xs text-muted-foreground">
                                {t('noDataYet')}
                              </div>
                            )}
                          </div>
                        </CardContent>
                      </Card>
                    </section>

                    {/* Pricing & payment */}
                    <section className="space-y-2">
                      <h3 className="text-xs uppercase tracking-wide text-muted-foreground font-semibold inline-flex items-center gap-1.5">
                        <Receipt className="h-3.5 w-3.5" />
                        {t('orderStatus')}
                      </h3>
                      <Card className="border-0 bg-muted/30">
                        <CardContent className="p-3 space-y-2">
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-xs text-muted-foreground">
                              {t('orderStatus')}
                            </span>
                            <span
                              className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[10px] font-medium ${statusBadgeClass(
                                detailsTarget.status,
                              )}`}
                            >
                              <span
                                className={`h-1.5 w-1.5 rounded-full ${statusDotClass(
                                  detailsTarget.status,
                                )}`}
                              />
                              {translateStatus(detailsTarget.status, t)}
                            </span>
                          </div>
                          <Separator />
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-xs text-muted-foreground">
                              {t('paymentModelUpfront')}/{t('paymentModelMonthly')}
                            </span>
                            <span className="text-xs font-semibold text-foreground">
                              {detailsTarget.paymentModel === 'UPFRONT'
                                ? t('paymentModelUpfront')
                                : t('paymentModelMonthly')}
                            </span>
                          </div>
                          {detailsTarget.paymentModel === 'MONTHLY' &&
                            detailsTarget.commitmentMonths != null && (
                              <div className="flex items-center justify-between gap-2">
                                <span className="text-xs text-muted-foreground">
                                  {t('commitmentPeriod')}
                                </span>
                                <span className="text-xs font-semibold text-foreground">
                                  {detailsTarget.commitmentMonths} {t('months')}
                                </span>
                              </div>
                            )}
                          <Separator />
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-xs text-muted-foreground">
                              {t('totalBasePrice')}
                            </span>
                            <span className="text-xs font-semibold text-foreground" dir="ltr">
                              {formatPrice(detailsTarget.totalBasePrice)}
                            </span>
                          </div>
                          {detailsTarget.paymentModel === 'MONTHLY' && (
                            <div className="flex items-center justify-between gap-2">
                              <span className="text-xs text-muted-foreground">
                                {t('monthlyExtraCost')}
                              </span>
                              <span className="text-xs font-semibold text-foreground" dir="ltr">
                                {formatPrice(detailsTarget.monthlyExtra)}
                              </span>
                            </div>
                          )}
                          {detailsTarget.paymentModel === 'UPFRONT' && (
                            <div className="flex items-center justify-between gap-2">
                              <span className="text-xs text-muted-foreground">
                                {t('upfrontTotal')}
                              </span>
                              <span
                                className="text-sm font-bold text-amber-700 dark:text-amber-400"
                                dir="ltr"
                              >
                                {formatPrice(detailsTarget.upfrontTotal)}
                              </span>
                            </div>
                          )}
                        </CardContent>
                      </Card>
                    </section>

                    {/* Dates */}
                    <section className="grid grid-cols-2 gap-2">
                      <div className="flex items-center gap-2 p-2 rounded-lg bg-muted/30">
                        <Calendar className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
                        <div className="min-w-0">
                          <p className="text-[9px] uppercase text-muted-foreground">
                            {t('orderDate')}
                          </p>
                          <p className="text-xs text-foreground truncate">
                            {formatDate(detailsTarget.createdAt, lang)}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 p-2 rounded-lg bg-muted/30">
                        <RefreshCw className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
                        <div className="min-w-0">
                          <p className="text-[9px] uppercase text-muted-foreground">
                            {t('lastRefreshed')}
                          </p>
                          <p className="text-xs text-foreground truncate">
                            {formatDate(detailsTarget.updatedAt, lang)}
                          </p>
                        </div>
                      </div>
                    </section>
                  </>
                )}
              </div>
            </ScrollArea>
          )}

          <DialogFooter className="p-4 border-t bg-muted/20">
            <Button
              variant="outline"
              size="sm"
              className="rounded-xl"
              onClick={() => setDetailsTarget(null)}
            >
              {t('close')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reject dialog */}
      <Dialog
        open={!!rejectTarget}
        onOpenChange={(open) => {
          if (!open) {
            setRejectTarget(null);
            setRejectNotes('');
          }
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <XCircle className="h-5 w-5 text-red-500" />
              {t('rejectOrder')}
            </DialogTitle>
            <DialogDescription>
              {(isRTL && rejectTarget?.agency?.nameAr) || rejectTarget?.agency?.name || '—'}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <label className="text-xs text-muted-foreground">
              {t('rejectOrder')}
            </label>
            <Textarea
              value={rejectNotes}
              onChange={(e) => setRejectNotes(e.target.value)}
              placeholder={t('rejectOrder')}
              rows={4}
              className="rounded-xl"
              dir={isRTL ? 'rtl' : 'ltr'}
            />
          </div>
          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              size="sm"
              className="rounded-xl"
              onClick={() => {
                setRejectTarget(null);
                setRejectNotes('');
              }}
              disabled={rejecting}
            >
              {t('cancel')}
            </Button>
            <Button
              size="sm"
              className="rounded-xl bg-red-600 hover:bg-red-700 text-white gap-1.5"
              onClick={handleReject}
              disabled={rejecting}
            >
              {rejecting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <XCircle className="h-3.5 w-3.5" />
              )}
              {t('rejectOrder')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
