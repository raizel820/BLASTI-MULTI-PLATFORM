'use client';
/**
 * Customer Support Desk — Task 79-b rebuild (Design System v2).
 * File complaints / notes / suggestions / questions to the super admin and
 * track replies. Backed by /api/support-tickets (cloud). Personal tickets only
 * (agencyId = null for customers).
 *
 * Flows preserved 1:1:
 *  - GET  /api/support-tickets/mine        → { tickets, openCount }
 *  - POST /api/support-tickets             → create (subject ≥ 3 chars, message required)
 *  - PATCH /api/support-tickets/:id        → close ticket (status CLOSED)
 *  - Exports statusKey / statusBadgeClass / categoryKey are consumed by
 *    admin-tickets.tsx and agency-support.tsx — kept for compatibility.
 */
import { apiFetch } from '@/lib/api-fetch';

import { useState, useEffect, useCallback } from 'react';
import { useLanguage } from '@/hooks/use-language';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { EmptyState } from '@/components/shared/empty-state';
import {
  LifeBuoy,
  Plus,
  ChevronDown,
  Loader2,
  Send,
  MessageCircle,
  XCircle,
} from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';
import { toast } from 'sonner';
import type { TranslationKeys } from '@/i18n';

interface Ticket {
  id: string;
  subject: string;
  category: string;
  status: string;
  priority: string;
  message: string;
  reply: string | null;
  repliedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

const CATEGORIES = ['COMPLAINT', 'SUGGESTION', 'QUESTION', 'NOTE'] as const;
const CATEGORY_KEY: Record<string, TranslationKeys> = {
  COMPLAINT: 'ticketCatComplaint',
  SUGGESTION: 'ticketCatSuggestion',
  QUESTION: 'ticketCatQuestion',
  NOTE: 'ticketCatNote',
};

export const statusKey = (s: string): TranslationKeys =>
  s === 'OPEN' ? 'ticketStatusOpen'
  : s === 'IN_PROGRESS' ? 'ticketStatusInProgress'
  : s === 'RESOLVED' ? 'ticketStatusResolved'
  : 'ticketStatusClosed';

export const statusBadgeClass = (s: string) =>
  s === 'OPEN' ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400'
  : s === 'IN_PROGRESS' ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'
  : s === 'RESOLVED' ? 'bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-400'
  : 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400';

export const categoryKey = CATEGORY_KEY;

export function CustomerSupport() {
  const { t } = useLanguage();
  const [tickets, setTickets] = useState<Ticket[] | null>(null);
  const [openCount, setOpenCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // new-ticket form state
  const [subject, setSubject] = useState('');
  const [category, setCategory] = useState<string>('QUESTION');
  const [message, setMessage] = useState('');

  const fetchTickets = useCallback(async () => {
    try {
      const res = await apiFetch('/api/support-tickets/mine');
      if (res.ok) {
        const data = await res.json();
        setTickets(data.tickets ?? []);
        setOpenCount(data.openCount ?? 0);
      }
    } catch { /* offline — keep last list */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { fetchTickets(); }, [fetchTickets]);

  const resetForm = () => { setSubject(''); setCategory('QUESTION'); setMessage(''); };

  const handleCreate = async () => {
    if (subject.trim().length < 3 || message.trim().length === 0) {
      toast.error(t('ticketCreateFailed'));
      return;
    }
    setCreating(true);
    try {
      const res = await apiFetch('/api/support-tickets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subject: subject.trim(), category, message: message.trim() }),
      });
      if (res.ok || res.status === 201) {
        toast.success(t('ticketCreated'));
        resetForm();
        setShowForm(false);
        await fetchTickets();
      } else {
        toast.error(t('ticketCreateFailed'));
      }
    } catch {
      toast.error(t('ticketCreateFailed'));
    } finally {
      setCreating(false);
    }
  };

  const handleClose = async (id: string) => {
    try {
      const res = await apiFetch(`/api/support-tickets/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'CLOSED' }),
      });
      if (res.ok) {
        toast.success(t('ticketUpdated'));
        await fetchTickets();
      }
    } catch { /* network error surfaced by toast-less state refetch */ }
  };

  const fmtDate = (iso: string) => {
    try { return new Date(iso).toLocaleString(); } catch { return iso; }
  };

  return (
    <div className="px-4 py-3 pb-24 lg:pb-8">
      <div className="max-w-5xl mx-auto space-y-4">
        {/* Compact header */}
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.25 }}
          className="flex items-center justify-between gap-2"
        >
          <div className="flex items-center gap-2 min-w-0">
            <div className="h-9 w-9 rounded-xl bg-teal-600 flex items-center justify-center shrink-0">
              <LifeBuoy className="h-4 w-4 text-white" />
            </div>
            <div className="min-w-0">
              <h1 className="text-lg font-bold text-foreground leading-tight">{t('supportDesk')}</h1>
              <p className="text-xs text-muted-foreground truncate">{t('supportSubtitle')}</p>
            </div>
          </div>
          <Button
            onClick={() => setShowForm(true)}
            className="bg-teal-600 hover:bg-teal-700 text-white h-10 rounded-xl shrink-0"
            size="sm"
          >
            <Plus className="h-4 w-4 me-1" />
            {t('newTicket')}
          </Button>
        </motion.div>

        {/* Ticket list header */}
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-foreground">{t('mySupportTickets')}</h2>
          {openCount > 0 && (
            <Badge className="bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">
              {openCount} {t('openTickets')}
            </Badge>
          )}
        </div>

        {loading ? (
          <div className="space-y-2">
            {[1, 2, 3].map((i) => <Skeleton key={i} className="h-16 w-full rounded-2xl" />)}
          </div>
        ) : !tickets || tickets.length === 0 ? (
          <EmptyState
            iconComponent={LifeBuoy}
            title={t('ticketNoTickets')}
            description={t('ticketNoTicketsDesc')}
          />
        ) : (
          <div className="space-y-2">
            {tickets.map((ticket) => {
              const expanded = expandedId === ticket.id;
              return (
                <motion.div
                  key={ticket.id}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.25 }}
                  className="rounded-2xl border border-border bg-white dark:bg-gray-900/80 shadow-sm overflow-hidden"
                >
                  <button
                    className="w-full text-start p-3.5 flex items-start gap-3 hover:bg-muted/40 transition-colors"
                    onClick={() => setExpandedId(expanded ? null : ticket.id)}
                    aria-expanded={expanded}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <Badge variant="outline" className="text-[11px]">{t(CATEGORY_KEY[ticket.category] ?? 'ticketCatQuestion')}</Badge>
                        <Badge className={`text-[11px] ${statusBadgeClass(ticket.status)}`}>{t(statusKey(ticket.status))}</Badge>
                      </div>
                      <p className="mt-1.5 text-sm font-medium text-foreground truncate">{ticket.subject}</p>
                      <p className="text-[11px] text-muted-foreground mt-0.5">{t('ticketSentAt')} {fmtDate(ticket.createdAt)}</p>
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
                        <div className="px-3.5 pb-3.5 pt-0 space-y-3 border-t border-border/60">
                          <p className="text-sm text-foreground whitespace-pre-wrap pt-3">{ticket.message}</p>
                          {ticket.reply && (
                            <div className="rounded-xl bg-teal-50 dark:bg-teal-950/30 p-3 border border-teal-200/60 dark:border-teal-800/40">
                              <div className="flex items-center gap-2 mb-1">
                                <MessageCircle className="h-3.5 w-3.5 text-teal-600 dark:text-teal-400" />
                                <span className="text-xs font-semibold text-teal-700 dark:text-teal-400">{t('ticketRepliedBy')}</span>
                              </div>
                              <p className="text-sm text-foreground whitespace-pre-wrap">{ticket.reply}</p>
                            </div>
                          )}
                          <div className="flex items-center gap-2">
                            {!['CLOSED', 'RESOLVED'].includes(ticket.status) && (
                              <Button variant="outline" size="sm" className="h-8 rounded-xl" onClick={() => handleClose(ticket.id)}>
                                <XCircle className="h-3.5 w-3.5 me-1 text-muted-foreground" />
                                {t('ticketCloseTicket')}
                              </Button>
                            )}
                          </div>
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </motion.div>
              );
            })}
          </div>
        )}

        {/* New ticket dialog (same create flow) */}
        <Dialog open={showForm} onOpenChange={(open) => { setShowForm(open); if (!open) resetForm(); }}>
          <DialogContent className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>{t('newTicket')}</DialogTitle>
              <DialogDescription className="sr-only">{t('supportSubtitle')}</DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="ticket-subject">{t('ticketSubject')}</Label>
                <Input
                  id="ticket-subject"
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  placeholder={t('ticketSubjectPlaceholder')}
                  maxLength={150}
                  className="h-11 rounded-xl"
                />
              </div>
              <div className="space-y-2">
                <Label>{t('ticketCategory')}</Label>
                <Select value={category} onValueChange={setCategory}>
                  <SelectTrigger className="h-11 rounded-xl">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CATEGORIES.map((cat) => (
                      <SelectItem key={cat} value={cat}>{t(CATEGORY_KEY[cat])}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="ticket-message">{t('ticketMessage')}</Label>
                <Textarea
                  id="ticket-message"
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  placeholder={t('ticketMessagePlaceholder')}
                  rows={5}
                  maxLength={5000}
                  className="rounded-xl"
                />
              </div>
              <div className="flex items-center gap-2 justify-end">
                <Button variant="outline" size="sm" className="h-10 rounded-xl" onClick={() => { setShowForm(false); resetForm(); }}>
                  {t('cancel')}
                </Button>
                <Button
                  onClick={handleCreate}
                  disabled={creating || subject.trim().length < 3 || message.trim().length === 0}
                  className="bg-teal-600 hover:bg-teal-700 text-white h-10 rounded-xl"
                  size="sm"
                >
                  {creating ? <Loader2 className="h-4 w-4 animate-spin me-1" /> : <Send className="h-4 w-4 me-1" />}
                  {t('submit')}
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}
