'use client';
/**
 * Admin Support Desk — triage and reply to support tickets coming from
 * customers AND agencies (complaints / notes / suggestions / questions).
 * Backed by GET /api/support-tickets/admin/all + PATCH /api/support-tickets/
 * admin/:id (SUPER_ADMIN only, cloud). The admin dashboard card links here.
 */
import { apiFetch } from '@/lib/api-fetch';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useLanguage } from '@/hooks/use-language';
import { useRealtime } from '@/hooks/use-realtime';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { EmptyState } from '@/components/shared/empty-state';
import {
  LifeBuoy,
  Search,
  ChevronDown,
  Loader2,
  Send,
  MessageCircle,
  Building2,
  User as UserIcon,
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { toast } from 'sonner';
import type { TranslationKeys } from '@/i18n';
import { statusKey, statusBadgeClass } from '@/components/customer/customer-support';
import { useDebounce } from '@/hooks/use-debounce';

interface Ticket {
  id: string;
  userId: string;
  agencyId: string | null;
  subject: string;
  category: string;
  status: string;
  priority: string;
  message: string;
  reply: string | null;
  repliedAt: string | null;
  createdAt: string;
  updatedAt: string;
  user?: { id: string; username: string; fullName: string; role: string };
  agency?: { id: string; name: string; customCode: string } | null;
}

interface AdminTicketsPayload {
  tickets: Ticket[];
  total: number;
  page: number;
  pageSize: number;
  counts: { open: number; inProgress: number; resolved: number; closed: number };
}

const CATEGORIES = ['COMPLAINT', 'SUGGESTION', 'QUESTION', 'NOTE'] as const;
const CATEGORY_KEY: Record<string, TranslationKeys> = {
  COMPLAINT: 'ticketCatComplaint',
  SUGGESTION: 'ticketCatSuggestion',
  QUESTION: 'ticketCatQuestion',
  NOTE: 'ticketCatNote',
};
const STATUSES = ['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'] as const;
const PAGE_SIZE = 25;

export function AdminTickets() {
  const { t } = useLanguage();
  const realtime = useRealtime();
  const [data, setData] = useState<AdminTicketsPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounce(search, 400);
  const [page, setPage] = useState(1);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const [replyFor, setReplyFor] = useState<Ticket | null>(null);
  const [replyText, setReplyText] = useState('');
  const [replyStatus, setReplyStatus] = useState<string>('IN_PROGRESS');
  const [sending, setSending] = useState(false);

  const searchRef = useRef(debouncedSearch);
  useEffect(() => { searchRef.current = debouncedSearch; }, [debouncedSearch]);

  const fetchTickets = useCallback(async (opts?: { append?: boolean; page?: number }) => {
    const p = opts?.page ?? page;
    const params = new URLSearchParams({ page: String(p), pageSize: String(PAGE_SIZE) });
    if (statusFilter !== 'all') params.set('status', statusFilter);
    if (categoryFilter !== 'all') params.set('category', categoryFilter);
    if (searchRef.current.trim()) params.set('search', searchRef.current.trim());
    try {
      const res = await apiFetch(`/api/support-tickets/admin/all?${params.toString()}`);
      if (res.ok) {
        const payload = await res.json();
        setData((prev) => {
          if (opts?.append && prev) {
            const seen = new Set(prev.tickets.map(x => x.id));
            return { ...payload, tickets: [...prev.tickets, ...payload.tickets.filter((x: Ticket) => !seen.has(x.id))] };
          }
          return payload;
        });
      }
    } catch { /* offline — keep last list */ }
    finally { setLoading(false); }
  }, [statusFilter, categoryFilter, page]);

  // Refetch on filter change (reset pagination)
  useEffect(() => {
    setLoading(true);
    setPage(1);
    fetchTickets({ page: 1 });
  }, [statusFilter, categoryFilter, debouncedSearch, fetchTickets]);

  // Realtime: new/updated tickets arrive while the admin is on this page
  useEffect(() => {
    const off1 = realtime.on('admin:ticket-created', () => fetchTickets());
    const off2 = realtime.on('admin:ticket-updated', () => fetchTickets());
    return () => { off1?.(); off2?.(); };
  }, [realtime, fetchTickets]);

  const handleSendReply = async () => {
    if (!replyFor || replyText.trim().length === 0) return;
    setSending(true);
    try {
      const body: Record<string, unknown> = { reply: replyText.trim() };
      if (replyStatus && replyStatus !== 'unchanged') body.status = replyStatus;
      const res = await apiFetch(`/api/support-tickets/admin/${replyFor.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        toast.success(t('ticketReplySent'));
        setReplyFor(null);
        setReplyText('');
        await fetchTickets();
      } else {
        const err = await res.json().catch(() => ({}));
        toast.error(err.error || t('error'));
      }
    } catch {
      toast.error(t('error'));
    } finally {
      setSending(false);
    }
  };

  const fmtDate = (iso: string) => {
    try { return new Date(iso).toLocaleString(); } catch { return iso; }
  };

  const counts = data?.counts;

  return (
    <div className="min-h-dvh bg-background">
      <div className="max-w-5xl mx-auto px-4 py-6 lg:p-6 space-y-5">
        {/* Header */}
        <div className="flex items-center gap-3">
          <div className="h-12 w-12 rounded-2xl bg-gradient-to-br from-teal-500 to-emerald-600 flex items-center justify-center shadow-lg shadow-teal-500/20 flex-shrink-0">
            <LifeBuoy className="h-6 w-6 text-white" />
          </div>
          <div className="min-w-0">
            <h1 className="text-xl font-bold text-foreground">{t('supportTickets')}</h1>
            <p className="text-sm text-muted-foreground">{t('supportSubtitle')}</p>
          </div>
        </div>

        {/* Status count chips */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {STATUSES.map((s) => (
            <button
              key={s}
              onClick={() => setStatusFilter(statusFilter === s ? 'all' : s)}
              className={`rounded-2xl border p-3 text-start transition-colors ${statusFilter === s ? 'border-teal-500 bg-teal-50 dark:bg-teal-950/30' : 'border-border hover:bg-muted/50'}`}
            >
              <p className="text-2xl font-bold text-foreground">{counts ? counts[{
                OPEN: 'open', IN_PROGRESS: 'inProgress', RESOLVED: 'resolved', CLOSED: 'closed',
              }[s as keyof typeof counts] as keyof typeof counts] : '–'}</p>
              <p className="text-xs text-muted-foreground">{t(statusKey(s))}</p>
            </button>
          ))}
        </div>

        {/* Filters */}
        <Card>
          <CardContent className="p-4 flex flex-col sm:flex-row gap-3">
            <div className="relative flex-1">
              <Search className="absolute start-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t('ticketSearchPlaceholder')}
                className="ps-9"
              />
            </div>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="w-full sm:w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t('ticketAllStatuses')}</SelectItem>
                {STATUSES.map((s) => <SelectItem key={s} value={s}>{t(statusKey(s))}</SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={categoryFilter} onValueChange={setCategoryFilter}>
              <SelectTrigger className="w-full sm:w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t('ticketAllCategories')}</SelectItem>
                {CATEGORIES.map((cat) => <SelectItem key={cat} value={cat}>{t(CATEGORY_KEY[cat])}</SelectItem>)}
              </SelectContent>
            </Select>
          </CardContent>
        </Card>

        {/* Ticket list */}
        {loading ? (
          <div className="space-y-3">
            {[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-24 w-full rounded-2xl" />)}
          </div>
        ) : !data || data.tickets.length === 0 ? (
          <EmptyState
            iconComponent={LifeBuoy}
            title={t('ticketNoTickets')}
            description={t('ticketNoTicketsAdminDesc')}
          />
        ) : (
          <div className="space-y-3">
            {data.tickets.map((ticket) => {
              const expanded = expandedId === ticket.id;
              return (
                <Card key={ticket.id} className="overflow-hidden">
                  <button
                    className="w-full text-start p-4 flex items-start gap-3 hover:bg-muted/50 transition-colors"
                    onClick={() => setExpandedId(expanded ? null : ticket.id)}
                    aria-expanded={expanded}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <Badge variant="outline" className="text-[11px]">{t(CATEGORY_KEY[ticket.category] ?? 'ticketCatQuestion')}</Badge>
                        <Badge className={`text-[11px] ${statusBadgeClass(ticket.status)}`}>{t(statusKey(ticket.status))}</Badge>
                        {ticket.priority === 'HIGH' && (
                          <Badge className="text-[11px] bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400">{t('ticketPriorityHigh')}</Badge>
                        )}
                        {ticket.agency ? (
                          <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                            <Building2 className="h-3 w-3" />{ticket.agency.name}
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                            <UserIcon className="h-3 w-3" />{ticket.user?.username}
                          </span>
                        )}
                      </div>
                      <p className="mt-1.5 font-medium text-foreground truncate">{ticket.subject}</p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {t('ticketFrom')} {ticket.user?.fullName || ticket.user?.username || '—'} · {t('ticketSentAt')} {fmtDate(ticket.createdAt)}
                      </p>
                    </div>
                    <ChevronDown className={`h-4 w-4 text-muted-foreground transition-transform flex-shrink-0 mt-1 ${expanded ? 'rotate-180' : ''}`} />
                  </button>
                  <AnimatePresence>
                    {expanded && (
                      <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.2 }}
                        className="overflow-hidden"
                      >
                        <div className="px-4 pb-4 pt-0 space-y-3 border-t border-border/60">
                          <p className="text-sm text-foreground whitespace-pre-wrap pt-3">{ticket.message}</p>
                          {ticket.reply && (
                            <div className="rounded-xl bg-teal-50 dark:bg-teal-950/30 p-3 border border-teal-200/60 dark:border-teal-800/40">
                              <div className="flex items-center gap-2 mb-1">
                                <MessageCircle className="h-3.5 w-3.5 text-teal-600 dark:text-teal-400" />
                                <span className="text-xs font-semibold text-teal-700 dark:text-teal-400">{t('ticketRepliedBy')} · {ticket.repliedAt ? fmtDate(ticket.repliedAt) : ''}</span>
                              </div>
                              <p className="text-sm text-foreground whitespace-pre-wrap">{ticket.reply}</p>
                            </div>
                          )}
                          <div className="flex flex-wrap items-center gap-2">
                            <Button
                              size="sm"
                              className="bg-teal-600 hover:bg-teal-700 text-white"
                              onClick={() => {
                                setReplyFor(ticket);
                                setReplyText('');
                                setReplyStatus(ticket.status === 'OPEN' ? 'IN_PROGRESS' : ticket.status);
                              }}
                            >
                              <Send className="h-3.5 w-3.5 me-1" />
                              {t('ticketReply')}
                            </Button>
                            {STATUSES.filter(s => s !== ticket.status).map((s) => (
                              <Button
                                key={s}
                                size="sm"
                                variant="outline"
                                onClick={async () => {
                                  try {
                                    const res = await apiFetch(`/api/support-tickets/admin/${ticket.id}`, {
                                      method: 'PATCH',
                                      headers: { 'Content-Type': 'application/json' },
                                      body: JSON.stringify({ status: s }),
                                    });
                                    if (res.ok) {
                                      toast.success(t('ticketUpdated'));
                                      await fetchTickets();
                                    }
                                  } catch { toast.error(t('error')); }
                                }}
                              >
                                {t(statusKey(s))}
                              </Button>
                            ))}
                          </div>
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </Card>
              );
            })}

            {/* Load more */}
            {data && data.tickets.length < data.total && (
              <div className="flex justify-center pt-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    const next = page + 1;
                    setPage(next);
                    fetchTickets({ append: true, page: next });
                  }}
                >
                  {t('ticketLoadMore')} ({data.total - data.tickets.length})
                </Button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Reply dialog */}
      <Dialog open={!!replyFor} onOpenChange={(open) => { if (!open) setReplyFor(null); }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="text-start">{replyFor?.subject}</DialogTitle>
            <DialogDescription className="text-start">
              {t('ticketFrom')} {replyFor?.user?.fullName || replyFor?.user?.username || '—'}
              {replyFor?.agency ? ` · ${replyFor.agency.name}` : ''}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="max-h-40 overflow-y-auto rounded-xl bg-muted/60 p-3 text-sm text-foreground whitespace-pre-wrap">
              {replyFor?.message}
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground">{t('ticketReply')}</label>
              <Textarea
                value={replyText}
                onChange={(e) => setReplyText(e.target.value)}
                placeholder={t('ticketReplyPlaceholder')}
                rows={4}
                maxLength={5000}
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground">{t('ticketStatus')}</label>
              <Select value={replyStatus} onValueChange={setReplyStatus}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="unchanged">—</SelectItem>
                  {STATUSES.map((s) => <SelectItem key={s} value={s}>{t(statusKey(s))}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setReplyFor(null)}>{t('cancel')}</Button>
            <Button
              onClick={handleSendReply}
              disabled={sending || replyText.trim().length === 0}
              className="bg-teal-600 hover:bg-teal-700 text-white"
            >
              {sending ? <Loader2 className="h-4 w-4 animate-spin me-1" /> : <Send className="h-4 w-4 me-1" />}
              {t('ticketSendReply')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
