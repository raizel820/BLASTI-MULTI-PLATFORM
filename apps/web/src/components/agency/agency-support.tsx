'use client';
/**
 * Agency Support Desk — file complaints / notes / suggestions / questions on
 * behalf of the agency to the super admin, and track the agency's tickets
 * (all staff share the agency ticket list). Backed by /api/support-tickets
 * (cloud). Offline desktop: the local API mirrors the list via the sync
 * engine and queues creates through the outbox.
 */
import { apiFetch } from '@/lib/api-fetch';
import { usePlatform } from '@/hooks/use-platform';

import { useState, useEffect, useCallback } from 'react';
import { useLanguage } from '@/hooks/use-language';
import { useAppStore } from '@/store/use-app-store';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { EmptyState } from '@/components/shared/empty-state';
import {
  LifeBuoy,
  Plus,
  ChevronDown,
  Loader2,
  Send,
  MessageCircle,
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { toast } from 'sonner';
import type { TranslationKeys } from '@/i18n';
import { statusKey, statusBadgeClass } from '@/components/customer/customer-support';

interface Ticket {
  id: string;
  userId: string;
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
}

const CATEGORIES = ['COMPLAINT', 'SUGGESTION', 'QUESTION', 'NOTE'] as const;
const CATEGORY_KEY: Record<string, TranslationKeys> = {
  COMPLAINT: 'ticketCatComplaint',
  SUGGESTION: 'ticketCatSuggestion',
  QUESTION: 'ticketCatQuestion',
  NOTE: 'ticketCatNote',
};

export function AgencySupport() {
  const { t } = useLanguage();
  const { platform } = usePlatform();
  const user = useAppStore((s) => s.user);
  const [tickets, setTickets] = useState<Ticket[] | null>(null);
  const [openCount, setOpenCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const [subject, setSubject] = useState('');
  const [category, setCategory] = useState<string>('QUESTION');
  const [message, setMessage] = useState('');

  const fetchTickets = useCallback(async () => {
    try {
      const res = await apiFetch('/api/support-tickets/agency');
      if (res.ok) {
        const data = await res.json();
        setTickets(data.tickets ?? []);
        setOpenCount(data.openCount ?? 0);
      }
    } catch { /* offline — local API or keep last list */ }
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

  const fmtDate = (iso: string) => {
    try { return new Date(iso).toLocaleString(); } catch { return iso; }
  };

  return (
    <div className="min-h-dvh bg-background">
      <div className="max-w-3xl mx-auto px-4 py-6 lg:p-6 space-y-5">
        {/* Header */}
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div className="h-12 w-12 rounded-2xl bg-gradient-to-br from-teal-500 to-emerald-600 flex items-center justify-center shadow-lg shadow-teal-500/20 flex-shrink-0">
              <LifeBuoy className="h-6 w-6 text-white" />
            </div>
            <div className="min-w-0">
              <h1 className="text-xl font-bold text-foreground truncate">{t('supportDesk')}</h1>
              <p className="text-sm text-muted-foreground line-clamp-2">{t('supportSubtitle')}</p>
            </div>
          </div>
          <Button
            onClick={() => setShowForm(v => !v)}
            className="bg-teal-600 hover:bg-teal-700 text-white flex-shrink-0"
            size="sm"
          >
            <Plus className="h-4 w-4 me-1" />
            {t('newTicket')}
          </Button>
        </div>

        {/* New ticket form */}
        <AnimatePresence>
          {showForm && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.2 }}
              className="overflow-hidden"
            >
              <Card className="border-teal-200/60 dark:border-teal-800/40">
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">{t('newTicket')}</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="agency-ticket-subject">{t('ticketSubject')}</Label>
                    <Input
                      id="agency-ticket-subject"
                      value={subject}
                      onChange={(e) => setSubject(e.target.value)}
                      placeholder={t('ticketSubjectPlaceholder')}
                      maxLength={150}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>{t('ticketCategory')}</Label>
                    <Select value={category} onValueChange={setCategory}>
                      <SelectTrigger>
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
                    <Label htmlFor="agency-ticket-message">{t('ticketMessage')}</Label>
                    <Textarea
                      id="agency-ticket-message"
                      value={message}
                      onChange={(e) => setMessage(e.target.value)}
                      placeholder={t('ticketMessagePlaceholder')}
                      rows={5}
                      maxLength={5000}
                    />
                  </div>
                  <div className="flex items-center gap-2 justify-end">
                    <Button variant="outline" size="sm" onClick={() => { setShowForm(false); resetForm(); }}>
                      {t('cancel')}
                    </Button>
                    <Button
                      onClick={handleCreate}
                      disabled={creating || subject.trim().length < 3 || message.trim().length === 0}
                      className="bg-teal-600 hover:bg-teal-700 text-white"
                      size="sm"
                    >
                      {creating ? <Loader2 className="h-4 w-4 animate-spin me-1" /> : <Send className="h-4 w-4 me-1" />}
                      {t('submit')}
                    </Button>
                  </div>
                </CardContent>
              </Card>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Agency tickets */}
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-foreground">{t('supportTickets')}</h2>
          {openCount > 0 && (
            <Badge className="bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">
              {openCount} {t('openTickets')}
            </Badge>
          )}
        </div>

        {loading ? (
          <div className="space-y-3">
            {[1, 2, 3].map((i) => <Skeleton key={i} className="h-20 w-full rounded-2xl" />)}
          </div>
        ) : !tickets || tickets.length === 0 ? (
          <EmptyState
            iconComponent={LifeBuoy}
            title={t('ticketNoTickets')}
            description={t('ticketNoTicketsDesc')}
          />
        ) : (
          <div className="space-y-3">
            {tickets.map((ticket) => {
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
                        {ticket.user && (
                          <span className="text-[11px] text-muted-foreground truncate">
                            {t('ticketFrom')}: {ticket.user.fullName || ticket.user.username}
                          </span>
                        )}
                      </div>
                      <p className="mt-1.5 font-medium text-foreground truncate">{ticket.subject}</p>
                      <p className="text-xs text-muted-foreground mt-0.5">{t('ticketSentAt')} {fmtDate(ticket.createdAt)}</p>
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
                                <span className="text-xs font-semibold text-teal-700 dark:text-teal-400">{t('ticketRepliedBy')}</span>
                              </div>
                              <p className="text-sm text-foreground whitespace-pre-wrap">{ticket.reply}</p>
                            </div>
                          )}
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </Card>
              );
            })}
          </div>
        )}
        {!platform.isNative && (
          <p className="text-[11px] text-muted-foreground text-center">{user?.fullName || user?.username || ''}</p>
        )}
      </div>
    </div>
  );
}
