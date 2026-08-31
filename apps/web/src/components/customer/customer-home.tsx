'use client';
import { apiFetch } from '@/lib/api-fetch';
import { isApiUnreachable, isBothUnreachable } from '@/lib/api-client';

import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useAppStore } from '@/store/use-app-store';
import { useLanguage } from '@/hooks/use-language';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/shared/error-state';
import {
  Search,
  MapPin,
  QrCode,
  Star,
  ChevronRight,
  ChevronLeft,
  Users,
  Stethoscope,
  Globe,
  Scale,
  FlaskConical,
  Landmark,
  Building2,
  Briefcase,
  Loader2,
  TicketCheck,
  Clock,
  Heart,
  CalendarDays,
  ArrowLeft,
  Navigation,
  X,
  ScanLine,
  History,
  UserRound,
  Zap,
  Sparkles,
  Circle,
  MessageCircle,
  RefreshCw,
  Bell,
  Share2,
  ClipboardList,
  TrendingUp,
  Activity,
  CheckCircle2,
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { toast } from 'sonner';
import type { TranslationKeys } from '@/i18n';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Calendar } from '@/components/ui/calendar';
import { CustomerQrScanner } from '@/components/customer/customer-qr-scanner';
import { AgencyRatingDisplay } from '@/components/shared/agency-rating-display';
import { EnhancedRatingCard } from '@/components/shared/EnhancedRatingCard';
import { RecentActivityFeed } from '@/components/customer/home/RecentActivityFeed';
import { RecentlyVisited } from '@/components/customer/home/RecentlyVisited';

interface AgencyListItem {
  id: string;
  name: string;
  nameAr?: string;
  nameFr?: string;
  category: string;
  address: string;
  isSponsored: boolean;
  customCode: string;
  isQueueOpen: boolean;
  isPaused: boolean;
  serviceCount: number;
  waitingCount: number;
  workingHoursStart?: string;
  workingHoursEnd?: string;
  avgServiceTime?: number;
  averageRating?: number;
  reviewCount?: number;
  subscriptionStatus?: string;
}

interface AgencyDetail {
  id: string;
  name: string;
  nameAr?: string;
  nameFr?: string;
  category: string;
  address: string;
  isSponsored: boolean;
  customCode: string;
  isQueueOpen: boolean;
  isPaused: boolean;
  currentServingNumber: number;
  lastIssuedNumber: number;
  workingHoursStart?: string;
  workingHoursEnd?: string;
  avgServiceTime?: number;
  services: { id: string; name: string; nameAr?: string; nameFr?: string; waitingCount: number }[];
  averageRating?: number;
  reviewCount?: number;
  subscriptionStatus?: string;
}

const categoryKeys: { key: TranslationKeys; value: string; icon: React.ElementType }[] = [
  { key: 'catAll', value: 'ALL', icon: Navigation },
  { key: 'catClinic', value: 'CLINIC', icon: Stethoscope },
  { key: 'catAgency', value: 'AGENCY', icon: Globe },
  { key: 'catLawFirm', value: 'LAW_FIRM', icon: Scale },
  { key: 'catLaboratory', value: 'LABORATORY', icon: FlaskConical },
  { key: 'catGovernment', value: 'GOVERNMENT', icon: Landmark },
  { key: 'catOther', value: 'OTHER', icon: Building2 },
];

export function CustomerHome() {
  const setView = useAppStore((s) => s.setView);
  const user = useAppStore((s) => s.user);
  const pendingAgencyCode = useAppStore((s) => s.pendingAgencyCode);
  const setPendingAgencyCode = useAppStore((s) => s.setPendingAgencyCode);
  const { t, lang } = useLanguage();
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('ALL');
  const [agencies, setAgencies] = useState<AgencyListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState(false);
  const [agencyCode, setAgencyCode] = useState('');
  const [selectedAgency, setSelectedAgency] = useState<AgencyDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [favoriteIds, setFavoriteIds] = useState<Set<string>>(new Set());
  const [togglingFav, setTogglingFav] = useState<string | null>(null);
  const [searchFocused, setSearchFocused] = useState(false);
  const [recentSearches, setRecentSearches] = useState<string[]>([]);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchSectionRef = useRef<HTMLDivElement>(null);
  const [showSuggestions, setShowSuggestions] = useState(false);

  // Date picker state
  const [dateDialogOpen, setDateDialogOpen] = useState(false);
  const [selectedDate, setSelectedDate] = useState<Date | undefined>(undefined);
  const [pendingJoin, setPendingJoin] = useState<{ agencyId: string; serviceId?: string } | null>(null);
  const [joining, setJoining] = useState(false);
  const [preferredTime, setPreferredTime] = useState('');
  const [fixedTimeEnabled, setFixedTimeEnabled] = useState(false);
  const [qrScannerOpen, setQrScannerOpen] = useState(false);
  const [activeReservations, setActiveReservations] = useState<{ agencyName: string; position: number; agencyId: string }[]>([]);
  const featuredScrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetchAgencies();
    // Load recent searches from localStorage
    try {
      const stored = localStorage.getItem('blasti-recent-searches');
      if (stored) setRecentSearches(JSON.parse(stored));
    } catch { /* silent */ }
  }, []);

  // Handle pending agency code from QR deep link
  useEffect(() => {
    if (pendingAgencyCode) {
      fetchAgencyDetail(pendingAgencyCode);
      setPendingAgencyCode(null);
    }
  }, [pendingAgencyCode, setPendingAgencyCode]);

  const fetchFavorites = async () => {
    if (!user?.id) return;
    try {
      const res = await apiFetch(`/api/favorites?userId=${user.id}`);
      if (res.ok) {
        const data = await res.json();
        setFavoriteIds(new Set((data.favorites ?? []).map((f: { agencyId: string }) => f.agencyId)));
      }
    } catch {
      toast.error(t('error'));
    }
  };

  useEffect(() => {
    fetchFavorites();
  }, [user?.id]);

  const fetchAgencies = async () => {
    setLoading(true);
    setFetchError(false);
    try {
      const { fetchWithRetry } = await import('@/lib/fetch-with-retry');
      const res = await fetchWithRetry('/api/agencies');
      if (res.ok) {
        const data = await res.json();
        setAgencies(data.agencies ?? []);
      } else {
        setFetchError(true);
        toast.error(t('error'));
      }
    } catch {
      setFetchError(true);
      toast.error(t('error'));
    } finally {
      setLoading(false);
    }
  };

  const filteredAgencies = useMemo(() => {
    return agencies.filter((a) => {
      const matchCategory = selectedCategory === 'ALL' || a.category.toUpperCase() === selectedCategory;
      const query = searchQuery.toLowerCase().trim();
      const matchSearch =
        !query ||
        a.name.toLowerCase().includes(query) ||
        a.nameAr?.includes(query) ||
        a.nameFr?.toLowerCase().includes(query) ||
        a.address.toLowerCase().includes(query) ||
        a.customCode.toLowerCase().includes(query);
      return matchCategory && matchSearch;
    });
  }, [agencies, selectedCategory, searchQuery]);

  // Autocomplete suggestions
  const searchSuggestions = useMemo(() => {
    const query = searchQuery.toLowerCase().trim();
    if (!query) return [];
    const seen = new Set<string>();
 return agencies
      .filter((a) => {
        const name = getAgencyName(a).toLowerCase();
        if (seen.has(name)) return false;
        if (name.includes(query) || a.name.toLowerCase().includes(query) || a.nameFr?.toLowerCase().includes(query) || a.nameAr?.includes(query)) {
          seen.add(name);
          return true;
        }
        return false;
      })
      .slice(0, 5);
  }, [searchQuery, agencies, lang]);

  const addRecentSearch = (term: string) => {
    if (!term.trim()) return;
    const updated = [term, ...recentSearches.filter((s) => s.toLowerCase() !== term.toLowerCase())].slice(0, 5);
    setRecentSearches(updated);
    try { localStorage.setItem('blasti-recent-searches', JSON.stringify(updated)); } catch { /* silent */ }
  };

  const removeRecentSearch = (term: string) => {
    const updated = recentSearches.filter((s) => s !== term);
    setRecentSearches(updated);
    try { localStorage.setItem('blasti-recent-searches', JSON.stringify(updated)); } catch { /* silent */ }
  };

  const clearAllRecentSearches = () => {
    setRecentSearches([]);
    try { localStorage.removeItem('blasti-recent-searches'); } catch { /* silent */ }
  };

  const handleSearchSelect = (term: string) => {
    setSearchQuery(term);
    addRecentSearch(term);
    setShowSuggestions(false);
    setSearchFocused(false);
    searchInputRef.current?.blur();
  };

  const handleSearchKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && searchQuery.trim()) {
      addRecentSearch(searchQuery.trim());
      setShowSuggestions(false);
      setSearchFocused(false);
    }
  };

  const handleSearchBlur = () => {
    // Delay to allow click on suggestion
    setTimeout(() => {
      setSearchFocused(false);
      setShowSuggestions(false);
    }, 200);
  };

  const fetchAgencyDetail = async (code: string) => {
    setLoadingDetail(true);
    try {
      const { fetchWithRetry } = await import('@/lib/fetch-with-retry');
      const res = await fetchWithRetry(`/api/agencies/code/${encodeURIComponent(code)}`);
      if (res.ok) {
        const data = await res.json();
        if (data.success && data.agency) {
          setSelectedAgency(data.agency as AgencyDetail);
        } else {
          toast.error(data.error || t('noData'));
        }
      } else {
        toast.error(t('error'));
      }
    } catch {
      toast.error(t('error'));
    } finally {
      setLoadingDetail(false);
    }
  };

  const handleJoinByCode = async () => {
    if (!agencyCode.trim()) return;
    const code = agencyCode.trim();
    setAgencyCode('');
    // Directly fetch agency detail from API (works even if agency not in loaded list)
    await fetchAgencyDetail(code);
  };

  const handleSelectAgency = async (agency: AgencyListItem) => {
    await fetchAgencyDetail(agency.customCode);
  };

  // Quick join: go straight to date picker without showing agency detail
  const handleQuickJoin = (agencyId: string, serviceId?: string) => {
    if (!user?.id) {
      toast.error(t('error'));
      return;
    }
    setPendingJoin({ agencyId, serviceId });
    setSelectedDate(undefined);
    setDateDialogOpen(true);
  };

  const getTotalWaiting = () => {
    if (!selectedAgency) return 0;
    return selectedAgency.services.reduce((sum, s) => sum + (s.waitingCount || 0), 0);
  };

  const handleJoinQueue = (agencyId: string, serviceId?: string) => {
    // Auth guard — must be logged in as a customer
    if (!user?.id) {
      toast.error(t('error'));
      return;
    }
    // Open date picker dialog instead of joining directly
    setPendingJoin({ agencyId, serviceId });
    setSelectedDate(undefined); // Reset to default (today)
    setDateDialogOpen(true);
  };

  const confirmJoinQueue = async () => {
    if (!user?.id) {
      toast.error(t('error'));
      setDateDialogOpen(false);
      setPendingJoin(null);
      return;
    }
    if (!pendingJoin) return;
    setJoining(true);
    try {
      const body: Record<string, string | boolean> = { userId: user.id, agencyId: pendingJoin.agencyId };
      if (pendingJoin.serviceId) body.serviceId = pendingJoin.serviceId;
      // Add reserved date if selected (not today)
      if (selectedDate) {
        const today = new Date();
        const isToday = selectedDate.getFullYear() === today.getFullYear()
          && selectedDate.getMonth() === today.getMonth()
          && selectedDate.getDate() === today.getDate();
        if (!isToday) {
          body.reservedDate = selectedDate.toISOString().split('T')[0];
        }
      }
      // Add preferred time if set
      if (preferredTime) {
        body.preferredTime = preferredTime;
        body.fixedTimeEnabled = fixedTimeEnabled;
      }

      const res = await apiFetch('/api/reservations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      const data = await res.json();
      if (res.ok) {
        toast.success(t('joinSuccess'));
        setSelectedAgency(null);
        setDateDialogOpen(false);
        setPendingJoin(null);
        setSelectedDate(undefined);
        setPreferredTime('');
        setFixedTimeEnabled(false);
        setView('customer-queue');
      } else {
        toast.error(data.error || t('error'));
      }
    } catch {
      toast.error(t('error'));
    } finally {
      setJoining(false);
    }
  };

  const getAgencyName = (a: AgencyListItem | AgencyDetail) => {
    if (lang === 'ar' && a.nameAr) return a.nameAr;
    if (lang === 'fr' && a.nameFr) return a.nameFr;
    return a.name;
  };

  const getCategoryLabel = (cat: string) => {
    const found = categoryKeys.find((c) => c.value === cat.toUpperCase());
    return found ? t(found.key) : cat;
  };

  const getCategoryValue = (cat: string) => cat.toUpperCase();

  const toggleFavorite = async (e: React.MouseEvent, agencyId: string) => {
    e.stopPropagation();
    if (!user?.id) return;
    setTogglingFav(agencyId);
    try {
      const res = await apiFetch('/api/favorites', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: user.id, agencyId }),
      });
      if (res.ok) {
        const data = await res.json();
        setFavoriteIds((prev) => {
          const next = new Set(prev);
          if (data.favorited) next.add(agencyId);
          else next.delete(agencyId);
          return next;
        });
        toast.success(data.favorited ? t('favoriteAgency') : t('unfavoriteAgency'));
      }
    } catch {
      toast.error(t('error'));
    } finally {
      setTogglingFav(null);
    }
  };

  const isOpenNow = (start: string, end: string) => {
    if (!start || !end) return null;
    const now = new Date();
    const [sh, sm] = start.split(':').map(Number);
    const [eh, em] = end.split(':').map(Number);
    const cur = now.getHours() * 60 + now.getMinutes();
    const startMin = sh * 60 + sm;
    const endMin = eh * 60 + em;
    // Handle overnight hours (e.g. 22:00 - 06:00)
    if (startMin > endMin) {
      return cur >= startMin || cur < endMin;
    }
    return cur >= startMin && cur < endMin;
  };

  // Welcome banner helpers
  const firstName = user?.fullName?.split(' ')[0] || '';
  const getTimeGreeting = () => {
    const hour = new Date().getHours();
    if (hour >= 5 && hour < 12) return t('goodMorning');
    if (hour >= 12 && hour < 17) return t('goodAfternoon');
    if (hour >= 17 && hour < 21) return t('goodEvening');
    return t('goodNight');
  };
  const getGreetingMessage = () => {
    const hour = new Date().getHours();
    const messages: Record<string, Record<string, string>> = {
      morning: { ar: 'ابحث عن أقرب وكالة وانضم إلى الطابور', fr: 'Trouvez votre agence la plus proche et rejoignez la file', en: 'Find your nearest agency and join the queue' },
      afternoon: { ar: 'انضم إلى الطابور دون الانتظار في الصف', fr: 'Rejoignez une file sans attendre en ligne', en: 'Join a queue without waiting in line' },
      evening: { ar: 'وصول سريع إلى الطابور بين يديك', fr: 'Accès rapide à la file à portée de main', en: 'Quick queue access at your fingertips' },
      night: { ar: 'خطط لزيارتك القادمة غداً', fr: 'Planifiez votre prochaine visite demain', en: 'Plan your next visit tomorrow' },
    };
    let timeOfDay: string;
    if (hour >= 5 && hour < 12) timeOfDay = 'morning';
    else if (hour >= 12 && hour < 17) timeOfDay = 'afternoon';
    else if (hour >= 17 && hour < 21) timeOfDay = 'evening';
    else timeOfDay = 'night';
    return messages[timeOfDay][lang] || messages[timeOfDay].en;
  };

  // FIX #19: Fetch active reservations with offline backoff
  useEffect(() => {
    if (!user?.id) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let failures = 0;
    const NORMAL = 30_000;

    const fetchActiveReservations = async () => {
      try {
        const res = await apiFetch(`/api/reservations/active?userId=${user.id}`);
        if (res.ok) {
          const data = await res.json();
          const reservations = data.reservations ?? [];
          setActiveReservations(reservations.map((r: { agency?: { name: string; id: string }; position?: number; agencyId?: string; queueNumber?: number }) => ({
            agencyName: r.agency?.name || '',
            position: r.position || r.queueNumber || 0,
            agencyId: r.agency?.id || r.agencyId || '',
          })));
          failures = 0;
        }
      } catch { /* silent */ }
    };

    const getInterval = () => {
      if (failures >= 3) return 120_000;
      if (failures >= 1) return 60_000;
      return NORMAL;
    };

    const tick = async () => {
      if (stopped) return;
      if (isBothUnreachable()) {
        timer = setTimeout(tick, getInterval());
        return;
      }
      await fetchActiveReservations();
      if (isApiUnreachable()) failures = Math.min(failures + 1, 10);
      else failures = 0;
      timer = setTimeout(tick, getInterval());
    };

    fetchActiveReservations();
    timer = setTimeout(tick, NORMAL);
    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }, [user?.id]);

  // Compute quick stats
  const openAgencyCount = useMemo(() => agencies.filter(a => a.isQueueOpen && !a.isPaused).length, [agencies]);
  // Get waiting count for a specific agency by its ID
  const getAgencyWaitingCount = useCallback((agencyId: string): number => {
    const agency = agencies.find(a => a.id === agencyId);
    return agency?.waitingCount || 0;
  }, [agencies]);

  // Compute category counts for filter badges
  const categoryCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    agencies.forEach(a => {
      const cat = a.category.toUpperCase();
      counts[cat] = (counts[cat] || 0) + 1;
    });
    return counts;
  }, [agencies]);

  const dateDialogContent = (
    <Dialog open={dateDialogOpen} onOpenChange={(open) => { setDateDialogOpen(open); if (!open) { setPendingJoin(null); setSelectedDate(undefined); } }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CalendarDays className="h-5 w-5 text-emerald-600" />
            {t('reserveForDate')}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {t('selectDate')}
          </DialogDescription>
        </DialogHeader>
        <div className="py-2">
          <p className="text-sm text-muted-foreground mb-4">{t('selectDate')}</p>
          <div className="flex justify-center">
            <Calendar
              mode="single"
              selected={selectedDate}
              onSelect={setSelectedDate}
              disabled={(date) => date < new Date(new Date().setHours(0, 0, 0, 0))}
              className="rounded-xl border w-full max-w-[300px] sm:max-w-none"
            />
          </div>
          {/* Quick date buttons */}
          <div className="flex gap-2 mt-4 justify-center">
            <Button
              variant="outline"
              size="sm"
              className="rounded-lg h-9"
              onClick={() => setSelectedDate(undefined)}
            >
              {t('today')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="rounded-lg h-9"
              onClick={() => {
                const tomorrow = new Date();
                tomorrow.setDate(tomorrow.getDate() + 1);
                setSelectedDate(tomorrow);
              }}
            >
              {t('tomorrow')}
            </Button>
          </div>
          {selectedDate && (
            <div className="mt-3 text-center">
              <p className="text-sm text-emerald-600 dark:text-emerald-400 font-medium">
                📅 {t('reservedFor')} {selectedDate.toLocaleDateString(lang === 'ar' ? 'ar-DZ' : lang === 'fr' ? 'fr-DZ' : 'en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
              </p>
            </div>
          )}

          {/* Preferred Time Section */}
          <div className="mt-4 pt-4 border-t border-border">
            <div className="flex items-center justify-between mb-3">
              <div>
                <p className="text-sm font-medium text-foreground">{t('preferredTime')}</p>
                <p className="text-xs text-muted-foreground">{t('preferredTimeDesc')}</p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <input
                type="time"
                value={preferredTime}
                onChange={(e) => {
                  setPreferredTime(e.target.value);
                  if (e.target.value && !fixedTimeEnabled) setFixedTimeEnabled(true);
                }}
                className="h-10 px-3 rounded-lg border border-border bg-background text-sm focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 outline-none transition-colors"
                dir="ltr"
              />
              {preferredTime && (
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={fixedTimeEnabled}
                    onChange={(e) => setFixedTimeEnabled(e.target.checked)}
                    className="h-4 w-4 rounded border-gray-300 text-emerald-600 focus:ring-emerald-500"
                  />
                  <span className="text-xs text-muted-foreground">{t('enableFixedTime')}</span>
                </label>
              )}
              {preferredTime && (
                <button
                  onClick={() => { setPreferredTime(''); setFixedTimeEnabled(false); }}
                  className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  ✕
                </button>
              )}
            </div>
          </div>
        </div>
        <DialogFooter className="flex-col gap-2 sm:flex-row">
          <Button variant="outline" onClick={() => { setDateDialogOpen(false); setPendingJoin(null); setSelectedDate(undefined); }} className="rounded-xl h-10">
            {t('cancel')}
          </Button>
          <Button
            onClick={confirmJoinQueue}
            disabled={joining}
            className="bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl h-10"
          >
            {joining ? <Loader2 className="h-4 w-4 animate-spin me-2" /> : <TicketCheck className="h-4 w-4 me-2" />}
            {t('joinQueue')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  // Agency Detail View
  if (loadingDetail) {
    return (
      <>
        <div className="px-4 py-4 pb-24 flex items-center justify-center min-h-[60vh]">
          <Loader2 className="h-8 w-8 text-emerald-600 animate-spin" />
        </div>
        {dateDialogContent}
      </>
    );
  }

  if (selectedAgency) {
    const totalWaiting = getTotalWaiting();
    const estWait = totalWaiting * (selectedAgency.avgServiceTime || 10);
    const estWaitMin = Math.max(1, Math.round(estWait * 0.75));
    const estWaitMax = Math.round(estWait * 1.3);
    return (
      <>
      <motion.div
        initial={{ opacity: 0, x: 20 }}
        animate={{ opacity: 1, x: 0 }}
        className="px-4 py-4 pb-24"
      >
        <button
          onClick={() => setSelectedAgency(null)}
          className="text-sm text-emerald-600 dark:text-emerald-400 font-medium mb-4 flex items-center gap-1 hover:underline"
        >
          <ArrowLeft className="h-4 w-4 rtl:rotate-180" /> {t('back')}
        </button>

        <Card className="shadow-lg border-0 mb-4 overflow-hidden bg-white dark:bg-gray-900/80 dark:border-gray-800/50 dark:backdrop-blur-sm dark:shadow-gray-900/50">
          <div className="h-32 bg-gradient-to-r from-emerald-500 to-teal-600" />
          <CardContent className="p-4 -mt-10">
            <div className="h-16 w-16 rounded-2xl bg-white dark:bg-gray-800 shadow-lg flex items-center justify-center mb-3 border-4 border-white dark:border-gray-800">
              <TicketCheck className="h-7 w-7 text-emerald-600" />
            </div>
            <h2 className="text-xl font-bold text-foreground mb-1">
              {getAgencyName(selectedAgency)}
            </h2>
            <div className="flex items-center gap-2 text-sm text-muted-foreground mb-3">
              <MapPin className="h-4 w-4" />
              <span>{selectedAgency.address}</span>
            </div>
            <div className="flex items-center gap-2 mb-4">
              <Badge variant="outline" className="text-xs">
                {getCategoryLabel(selectedAgency.category)}
              </Badge>
              {selectedAgency.subscriptionStatus !== 'ACTIVE' && (
                <Badge variant="outline" className="text-xs bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400 border-amber-200">
                  {t('inactiveAgency')}
                </Badge>
              )}
              <Badge
                variant="outline"
                className={
                  selectedAgency.isQueueOpen && !selectedAgency.isPaused
                    ? 'text-xs bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400 border-emerald-200'
                    : 'text-xs bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-400 border-red-200'
                }
              >
                {selectedAgency.isPaused ? t('paused') : selectedAgency.isQueueOpen ? t('openNow') : t('closed')}
              </Badge>
              {selectedAgency.workingHoursStart && selectedAgency.workingHoursEnd && (() => {
                const open = isOpenNow(selectedAgency.workingHoursStart, selectedAgency.workingHoursEnd);
                return (
                  <Badge
                    variant="outline"
                    className={
                      open
                        ? 'text-[10px] bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400 border-emerald-200'
                        : 'text-[10px] bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-400 border-red-200'
                    }
                  >
                    <Clock className="h-2.5 w-2.5 me-1" />
                    {open
                      ? `${t('openUntil')} ${selectedAgency.workingHoursEnd}`
                      : selectedAgency.isPaused
                        ? t('paused')
                        : `${t('closedNow')} · ${t('openFrom')} ${selectedAgency.workingHoursStart}`
                    }
                  </Badge>
                );
              })()}
            </div>

            {/* Queue Info */}
            <div className="grid grid-cols-2 gap-3 mb-4">
              <div className="bg-emerald-50 dark:bg-emerald-900/20 rounded-xl p-3 text-center">
                <div className="flex items-center justify-center gap-1 mb-1">
                  <Users className="h-4 w-4 text-emerald-600" />
                  <span className="text-xs text-muted-foreground">{t('currentlyWaiting')}</span>
                </div>
                <p className="text-2xl font-bold text-emerald-700 dark:text-emerald-400">
                  {totalWaiting}
                </p>
              </div>
              <div className="bg-teal-50 dark:bg-teal-900/20 rounded-xl p-3 text-center">
                <div className="flex items-center justify-center gap-1 mb-1">
                  <Clock className="h-4 w-4 text-teal-600" />
                  <span className="text-xs text-muted-foreground">{t('avgWaitTime')}</span>
                </div>
                <p className="text-2xl font-bold text-teal-700 dark:text-teal-400">
                  {estWaitMin < estWaitMax ? `${estWaitMin}–${estWaitMax}` : `~${estWait}`} {t('min')}
                </p>
              </div>
            </div>

            {/* Queue Unavailable Message for Inactive Subscriptions */}
            {selectedAgency.subscriptionStatus !== 'ACTIVE' && (
              <div className="mb-4 p-3 rounded-xl bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800">
                <p className="text-sm text-amber-700 dark:text-amber-300 font-medium">{t('queueUnavailable')}</p>
              </div>
            )}

            {/* Services */}
            {selectedAgency.services.length > 0 && (
              <div className="mb-4">
                <h3 className="font-semibold text-sm text-foreground mb-3">{t('selectService')}</h3>
                <div className="space-y-2">
                  {selectedAgency.services.map((svc) => (
                    <motion.button
                      key={svc.id}
                      whileHover={{ x: 4 }}
                      whileTap={{ scale: 0.98 }}
                      onClick={() => handleJoinQueue(selectedAgency.id, svc.id)}
                      disabled={selectedAgency.isPaused || !selectedAgency.isQueueOpen || selectedAgency.subscriptionStatus !== 'ACTIVE'}
                      className="w-full flex items-center justify-between p-3 rounded-xl border border-border hover:border-emerald-300 hover:bg-emerald-50/50 dark:hover:bg-emerald-900/10 transition-colors disabled:opacity-50"
                    >
                      <div className="flex items-center gap-3">
                        <span className="text-sm font-medium">
                          {lang === 'ar' && svc.nameAr ? svc.nameAr : lang === 'fr' && svc.nameFr ? svc.nameFr : svc.name}
                        </span>
                        {svc.waitingCount > 0 && (
                          <Badge variant="secondary" className="text-[10px]">
                            {svc.waitingCount} {t('waiting')}
                          </Badge>
                        )}
                      </div>
                      <ChevronRight className="h-4 w-4 text-muted-foreground rtl:rotate-180" />
                    </motion.button>
                  ))}
                </div>
              </div>
            )}

            {/* Join Queue (no services) */}
            {selectedAgency.services.length === 0 && (
              <Button
                className="w-full h-12 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white font-semibold rounded-xl"
                onClick={() => handleJoinQueue(selectedAgency.id)}
                disabled={selectedAgency.isPaused || !selectedAgency.isQueueOpen || selectedAgency.subscriptionStatus !== 'ACTIVE'}
              >
                {selectedAgency.subscriptionStatus !== 'ACTIVE' ? t('queueUnavailable') : selectedAgency.isQueueOpen ? t('joinQueue') : t('closed')}
              </Button>
            )}

            {/* Reviews Section */}
            <AgencyReviewsPreview agencyId={selectedAgency.id} averageRating={selectedAgency.averageRating} reviewCount={selectedAgency.reviewCount} />
          </CardContent>
        </Card>
      </motion.div>
      {dateDialogContent}
      </>
    );
  }

  return (
    <div className="px-4 py-4 pb-24 relative">
      {/* Animated gradient accent bar at top */}
      <div className="absolute top-0 start-0 end-0 h-[3px] gradient-flow-bar rounded-full" />

      {/* Header */}
      <motion.div
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
        className="mb-5 relative"
      >
        <div className="flex items-center justify-between mb-1">
          <div className="flex items-center gap-3">
            <div className="h-1.5 w-8 rounded-full bg-gradient-to-r from-emerald-500 to-teal-500" />
            <h1 className="text-2xl font-bold bg-gradient-to-r from-emerald-600 via-teal-600 to-emerald-700 bg-clip-text text-transparent">{t('home')}</h1>
          </div>
          <button
            type="button"
            onClick={() => setView('customer-notifications')}
            className="h-10 w-10 rounded-xl flex items-center justify-center hover:bg-emerald-50 dark:hover:bg-emerald-900/20 transition-colors relative"
            aria-label={t('notifications') || 'Notifications'}
          >
            <Bell className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
          </button>
        </div>
        <p className="text-sm text-muted-foreground ms-[44px]">{t('welcomeSubtitle')}</p>
      </motion.div>

      {/* Welcome Banner with animated gradient background */}
      {firstName && (
        <motion.div
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: 'easeOut' }}
          className="mb-4"
        >
          <button
            type="button"
            onClick={() => searchSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })}
            className="w-full text-start rounded-2xl bg-gradient-to-r from-emerald-600 via-teal-500 to-emerald-600 px-5 py-4 shadow-lg shadow-emerald-500/20 active:scale-[0.98] transition-transform cursor-pointer relative overflow-hidden"
          >
            {/* Animated gradient overlay */}
            <motion.div
              className="absolute inset-0 bg-gradient-to-r from-emerald-600/80 via-teal-400/80 to-emerald-600/80"
              animate={{ backgroundPosition: ['0% 50%', '100% 50%', '0% 50%'] }}
              transition={{ duration: 6, repeat: Infinity, ease: 'easeInOut' }}
              style={{ backgroundSize: '200% 100%' }}
            />
            {/* Subtle parallax background pattern */}
            <div className="absolute inset-0 opacity-[0.05]" style={{
              backgroundImage: `radial-gradient(circle at 1px 1px, white 1px, transparent 0)`,
              backgroundSize: '20px 20px',
            }} />
            <div className="relative">
              <div className="flex items-center justify-between mb-1">
                <p className="text-lg font-bold text-white">
                  {getTimeGreeting()}, {firstName}! 👋
                </p>
                <div className="flex items-center gap-2">
                  {openAgencyCount > 0 && (
                    <span className="text-[10px] bg-white/20 text-white px-2 py-0.5 rounded-full">
                      {openAgencyCount} {t('agenciesNearbyStat')}
                    </span>
                  )}
                </div>
              </div>
              <p className="text-sm text-emerald-100">{getGreetingMessage()}</p>
              {/* Quick Stats Row */}
              <div className="flex items-center gap-3 mt-3">
                <div className="flex items-center gap-1.5 bg-white/15 backdrop-blur-sm rounded-lg px-2.5 py-1.5">
                  <TicketCheck className="h-3.5 w-3.5 text-white" />
                  <span className="text-xs font-semibold text-white">{activeReservations.length}</span>
                  <span className="text-[9px] text-emerald-100">{t('activeTickets')}</span>
                </div>
                <div className="flex items-center gap-1.5 bg-white/15 backdrop-blur-sm rounded-lg px-2.5 py-1.5">
                  <Heart className="h-3.5 w-3.5 text-white" />
                  <span className="text-xs font-semibold text-white">{favoriteIds.size}</span>
                  <span className="text-[9px] text-emerald-100">{t('favoriteAgencies')}</span>
                </div>
                <div className="flex items-center gap-1.5 bg-white/15 backdrop-blur-sm rounded-lg px-2.5 py-1.5">
                  <MapPin className="h-3.5 w-3.5 text-white" />
                  <span className="text-xs font-semibold text-white">{openAgencyCount}</span>
                  <span className="text-[9px] text-emerald-100">{t('openNow')}</span>
                </div>
              </div>
              {/* Mini queue status — show ALL active reservations */}
              {activeReservations.length > 0 && (
                <div className="mt-3 space-y-1.5">
                  {activeReservations.map((res, idx) => (
                    <div key={res.agencyId || idx} className="bg-white/15 backdrop-blur-sm rounded-xl p-2.5 flex items-center gap-2">
                      <div className="h-8 w-8 rounded-lg bg-white/20 flex items-center justify-center flex-shrink-0">
                        <TicketCheck className="h-4 w-4 text-white" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-medium text-white truncate">
                          {res.agencyName}
                        </p>
                        <p className="text-[10px] text-emerald-100">
                          #{res.position} · {getAgencyWaitingCount(res.agencyId)} {t('waitingInQueueStat')}
                        </p>
                      </div>
                      <motion.div
                        animate={{ scale: [1, 1.15, 1] }}
                        transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut', delay: idx * 0.3 }}
                        className="h-2 w-2 rounded-full bg-emerald-300 pulse-ring"
                      />
                    </div>
                  ))}
                </div>
              )}
            </div>
          </button>
        </motion.div>
      )}

      {/* ─── Quick Actions Section ─── */}
      <motion.div
        initial={{ opacity: 0, y: 15 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, delay: 0.1 }}
        className="mb-5 relative"
      >
        {/* Subtle pattern background for quick actions */}
        <div className="absolute inset-0 -m-1 rounded-3xl overflow-hidden">
          <div className="absolute inset-0 bg-gradient-to-br from-emerald-50/60 via-teal-50/30 to-cyan-50/40 dark:from-emerald-950/20 dark:via-teal-950/10 dark:to-cyan-950/15" />
          <div
            className="absolute inset-0 opacity-[0.04] dark:opacity-[0.06]"
            style={{
              backgroundImage: `radial-gradient(circle at 1px 1px, rgba(16,185,129,0.5) 1px, transparent 0)`,
              backgroundSize: '16px 16px',
            }}
          />
        </div>
        <div className="relative grid grid-cols-4 gap-2.5 sm:gap-3 p-1">
          {/* Join Queue */}
          <motion.button
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.12 }}
            whileHover={{ y: -3, scale: 1.03 }}
            whileTap={{ scale: 0.97 }}
            onClick={() => searchSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })}
            className="flex flex-col items-center gap-2 rounded-2xl bg-gradient-to-br from-emerald-500 to-emerald-600 p-3 sm:p-4 shadow-sm active:scale-95 transition-transform"
          >
            <div className="h-9 w-9 sm:h-10 sm:w-10 rounded-xl bg-white/20 flex items-center justify-center">
              <Users className="h-4.5 w-4.5 sm:h-5 sm:w-5 text-white" />
            </div>
            <span className="text-[10px] sm:text-xs font-semibold text-white leading-tight">انضم للطابور</span>
          </motion.button>

          {/* Scan QR */}
          <motion.button
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.18 }}
            whileHover={{ y: -3, scale: 1.03 }}
            whileTap={{ scale: 0.97 }}
            onClick={() => setQrScannerOpen(true)}
            className="flex flex-col items-center gap-2 rounded-2xl bg-gradient-to-br from-teal-500 to-teal-600 p-3 sm:p-4 shadow-sm active:scale-95 transition-transform"
          >
            <div className="h-9 w-9 sm:h-10 sm:w-10 rounded-xl bg-white/20 flex items-center justify-center">
              <QrCode className="h-4.5 w-4.5 sm:h-5 sm:w-5 text-white" />
            </div>
            <span className="text-[10px] sm:text-xs font-semibold text-white leading-tight">امسح الرمز</span>
          </motion.button>

          {/* Favorites */}
          <motion.button
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.24 }}
            whileHover={{ y: -3, scale: 1.03 }}
            whileTap={{ scale: 0.97 }}
            onClick={() => setView('customer-favorites')}
            className="flex flex-col items-center gap-2 rounded-2xl bg-gradient-to-br from-emerald-400 to-teal-500 p-3 sm:p-4 shadow-sm active:scale-95 transition-transform"
          >
            <div className="h-9 w-9 sm:h-10 sm:w-10 rounded-xl bg-white/20 flex items-center justify-center">
              <Heart className="h-4.5 w-4.5 sm:h-5 sm:w-5 text-white" />
            </div>
            <span className="text-[10px] sm:text-xs font-semibold text-white leading-tight">المفضلات</span>
          </motion.button>

          {/* History */}
          <motion.button
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.30 }}
            whileHover={{ y: -3, scale: 1.03 }}
            whileTap={{ scale: 0.97 }}
            onClick={() => setView('customer-history')}
            className="flex flex-col items-center gap-2 rounded-2xl bg-gradient-to-br from-teal-400 to-emerald-500 p-3 sm:p-4 shadow-sm active:scale-95 transition-transform"
          >
            <div className="h-9 w-9 sm:h-10 sm:w-10 rounded-xl bg-white/20 flex items-center justify-center">
              <Clock className="h-4.5 w-4.5 sm:h-5 sm:w-5 text-white" />
            </div>
            <span className="text-[10px] sm:text-xs font-semibold text-white leading-tight">التاريخ</span>
          </motion.button>
        </div>
      </motion.div>

      {/* ─── Recent Activity Section ─── */}
      <motion.div
        initial={{ opacity: 0, y: 15 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, delay: 0.15 }}
        className="mb-5"
      >
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-foreground flex items-center gap-2">
            <Activity className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
            النشاط الأخير
          </h2>
          <button
            onClick={() => setView('customer-history')}
            className="text-xs text-emerald-600 dark:text-emerald-400 font-medium flex items-center gap-0.5 hover:underline"
          >
            عرض الكل
            <ChevronRight className="h-3 w-3 rtl:rotate-180" />
          </button>
        </div>

        {/* Timeline layout with dots */}
        <div className="relative">
          {/* Vertical timeline line */}
          <div className="absolute start-[19px] top-2 bottom-2 w-px bg-gradient-to-b from-emerald-300 via-teal-200 to-transparent dark:from-emerald-700 dark:via-teal-800" />

          <div className="space-y-2">
            {/* Activity item 1: Joined clinic queue */}
            <motion.div
              initial={{ opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 0.2 }}
              className="relative flex items-start gap-3"
            >
              {/* Timeline dot */}
              <div className="relative z-10 mt-1 h-5 w-5 rounded-full flex items-center justify-center ring-2 ring-background bg-emerald-500">
                <Users className="h-2.5 w-2.5 text-white" />
              </div>
              <div className="flex-1 flex items-center gap-3 p-3 rounded-xl bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-100 dark:border-emerald-800/50">
                <div className="h-8 w-8 rounded-lg bg-emerald-100 dark:bg-emerald-800/50 flex items-center justify-center flex-shrink-0">
                  <Users className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium text-foreground">انضممت إلى طابور العيادة</p>
                  <p className="text-[10px] text-muted-foreground">منذ 5 دقائق</p>
                </div>
                <div className="flex-shrink-0">
                  <div className="h-2 w-2 rounded-full bg-emerald-500" />
                </div>
              </div>
            </motion.div>

            {/* Activity item 2: Ticket A-015 served */}
            <motion.div
              initial={{ opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 0.26 }}
              className="relative flex items-start gap-3"
            >
              {/* Timeline dot */}
              <div className="relative z-10 mt-1 h-5 w-5 rounded-full flex items-center justify-center ring-2 ring-background bg-teal-500">
                <TicketCheck className="h-2.5 w-2.5 text-white" />
              </div>
              <div className="flex-1 flex items-center gap-3 p-3 rounded-xl bg-teal-50 dark:bg-teal-900/20 border border-teal-100 dark:border-teal-800/50">
                <div className="h-8 w-8 rounded-lg bg-teal-100 dark:bg-teal-800/50 flex items-center justify-center flex-shrink-0">
                  <TicketCheck className="h-4 w-4 text-teal-600 dark:text-teal-400" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium text-foreground">تم تقديم التذكرة A-015</p>
                  <p className="text-[10px] text-muted-foreground">منذ ساعة</p>
                </div>
                <div className="flex-shrink-0">
                  <div className="h-2 w-2 rounded-full bg-teal-500" />
                </div>
              </div>
            </motion.div>

            {/* Activity item 3: Completed lab visit */}
            <motion.div
              initial={{ opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 0.32 }}
              className="relative flex items-start gap-3"
            >
              {/* Timeline dot */}
              <div className="relative z-10 mt-1 h-5 w-5 rounded-full flex items-center justify-center ring-2 ring-background bg-emerald-400">
                <CheckCircle2 className="h-2.5 w-2.5 text-white" />
              </div>
              <div className="flex-1 flex items-center gap-3 p-3 rounded-xl bg-emerald-50/80 dark:bg-emerald-900/10 border border-emerald-100/60 dark:border-emerald-800/30">
                <div className="h-8 w-8 rounded-lg bg-emerald-100 dark:bg-emerald-800/50 flex items-center justify-center flex-shrink-0">
                  <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium text-foreground">أكملت زيارة المختبر</p>
                  <p className="text-[10px] text-muted-foreground">منذ ساعتين</p>
                </div>
                <div className="flex-shrink-0">
                  <div className="h-2 w-2 rounded-full bg-emerald-400" />
                </div>
              </div>
            </motion.div>
          </div>
        </div>
      </motion.div>

      {/* Search Bar — Glassmorphic */}
      <div ref={searchSectionRef} className="relative mb-4">
        <motion.div
          className="absolute start-4 top-1/2 -translate-y-1/2 z-10"
          animate={searchQuery === '' && !searchFocused ? { scale: [1, 1.15, 1], opacity: [0.6, 1, 0.6] } : { scale: 1, opacity: 1 }}
          transition={searchQuery === '' && !searchFocused ? { duration: 2, repeat: Infinity, ease: 'easeInOut' } : { duration: 0.2 }}
        >
          <Search className="h-5 w-5 text-muted-foreground" />
        </motion.div>
        <Input
          ref={searchInputRef}
          placeholder={t('searchGlassmorphic')}
          value={searchQuery}
          onChange={(e) => {
            setSearchQuery(e.target.value);
            setShowSuggestions(true);
          }}
          onFocus={() => {
            setSearchFocused(true);
            setShowSuggestions(true);
          }}
          onBlur={handleSearchBlur}
          onKeyDown={handleSearchKeyDown}
          className={`ps-11 pe-20 h-12 text-base rounded-2xl border-0 shadow-lg transition-all duration-300 ${
            searchFocused
              ? 'bg-white/80 dark:bg-gray-900/90 shadow-emerald-500/10 ring-2 ring-emerald-500/20 backdrop-blur-xl'
              : 'bg-white/60 dark:bg-gray-900/70 shadow-gray-200/50 dark:shadow-gray-900/50 backdrop-blur-md'
          }`}
        />
        {/* Search result count & clear button */}
        <div className="absolute end-3 top-1/2 -translate-y-1/2 flex items-center gap-1.5">
          {searchQuery.trim() && !showSuggestions && (
            <span className="text-[10px] text-muted-foreground font-medium">
              {filteredAgencies.length} {t('searchResultsCount')}
            </span>
          )}
          {searchQuery && (
            <button
              onClick={() => { setSearchQuery(''); setSearchFocused(false); setShowSuggestions(false); }}
              className="h-6 w-6 rounded-full flex items-center justify-center hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
              aria-label={t('clearSearch')}
            >
              <X className="h-3.5 w-3.5 text-muted-foreground" />
            </button>
          )}
        </div>
        {/* Search Suggestions Dropdown */}
        {(searchFocused || showSuggestions) && (searchSuggestions.length > 0 || (searchQuery === '' && recentSearches.length > 0)) && (
          <div className="absolute top-full mt-1 start-0 end-0 z-[60] bg-white dark:bg-gray-900 border border-border rounded-xl shadow-lg overflow-hidden">
            {searchQuery === '' && recentSearches.length > 0 ? (
              <>
                <div className="flex items-center justify-between px-3 py-2 border-b border-border">
                  <div className="flex items-center gap-1.5">
                    <History className="h-3.5 w-3.5 text-muted-foreground" />
                    <span className="text-xs font-semibold text-muted-foreground">{t('recentSearches')}</span>
                  </div>
                  <button
                    onClick={clearAllRecentSearches}
                    className="text-[10px] text-teal-600 dark:text-teal-400 hover:underline font-medium"
                  >
                    {t('clearAll')}
                  </button>
                </div>
                {recentSearches.map((term) => (
                  <button
                    key={term}
                    onClick={() => handleSearchSelect(term)}
                    className="w-full flex items-center justify-between px-3 py-2.5 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors text-start"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <Search className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
                      <span className="text-sm text-foreground truncate">{term}</span>
                    </div>
                    <button
                      onClick={(e) => { e.stopPropagation(); removeRecentSearch(term); }}
                      className="h-5 w-5 rounded-full flex items-center justify-center hover:bg-gray-200 dark:hover:bg-gray-700 flex-shrink-0"
                    >
                      <X className="h-3 w-3 text-muted-foreground" />
                    </button>
                  </button>
                ))}
              </>
            ) : searchSuggestions.length > 0 ? (
              <>
                <div className="px-3 py-2 border-b border-border">
                  <span className="text-xs font-semibold text-muted-foreground">{t('suggestions')}</span>
                </div>
                {searchSuggestions.map((agency) => (
                  <button
                    key={agency.id}
                    onClick={() => handleSearchSelect(getAgencyName(agency))}
                    className="w-full flex items-center gap-2 px-3 py-2.5 hover:bg-emerald-50 dark:hover:bg-emerald-900/10 transition-colors text-start"
                  >
                    <div className="h-8 w-8 rounded-lg bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center flex-shrink-0">
                      <TicketCheck className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-foreground truncate">{getAgencyName(agency)}</p>
                      <p className="text-[10px] text-muted-foreground truncate">{agency.address}</p>
                    </div>
                  </button>
                ))}
              </>
            ) : null}
          </div>
        )}
      </div>

      {/* Agency Code Input + Scan QR + Walk-in */}
      <div className="flex gap-2 mb-5">
        <Input
          placeholder={t('enterAgencyCode')}
          value={agencyCode}
          onChange={(e) => setAgencyCode(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleJoinByCode()}
          className="h-11 text-sm rounded-xl input-emerald-glow"
          dir="ltr"
        />
        <Button
          variant="outline"
          className="h-11 px-3 rounded-xl border-emerald-300 text-emerald-700 dark:border-emerald-700 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-900/20"
          onClick={() => setQrScannerOpen(true)}
          aria-label={t('scanQrCode')}
        >
          <ScanLine className="h-4 w-4" />
        </Button>
        <Button
          variant="outline"
          className="h-11 px-4 rounded-xl border-amber-300 text-amber-700 dark:border-amber-700 dark:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-900/20"
          onClick={() => {
            // Walk-in: open QR scanner which allows direct joining
            setQrScannerOpen(true);
          }}
        >
          <Zap className="h-4 w-4 me-1.5" />
          {t('walkInQuickAction')}
        </Button>
        <Button
          variant="outline"
          className="h-11 px-4 rounded-xl border-emerald-300 text-emerald-700 dark:border-emerald-700 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-900/20"
          onClick={handleJoinByCode}
        >
          <QrCode className="h-4 w-4 me-1.5" />
          {t('joinQueue')}
        </Button>
      </div>

      {/* Featured Agencies (Sponsored) Horizontal Scroll */}
      {!loading && agencies.filter(a => a.isSponsored).length > 0 && (
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.15 }}
          className="mb-5"
        >
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-foreground flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-amber-500" />
              {t('featuredAgencies')}
            </h2>
            <div className="flex items-center gap-1">
              <button
                onClick={() => featuredScrollRef.current?.scrollBy({ left: -240, behavior: 'smooth' })}
                className="h-6 w-6 rounded-full border border-border flex items-center justify-center hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
              >
                <ChevronLeft className="h-3.5 w-3.5 rtl:rotate-180" />
              </button>
              <button
                onClick={() => featuredScrollRef.current?.scrollBy({ left: 240, behavior: 'smooth' })}
                className="h-6 w-6 rounded-full border border-border flex items-center justify-center hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
              >
                <ChevronRight className="h-3.5 w-3.5 rtl:rotate-180" />
              </button>
            </div>
          </div>
          <div
            ref={featuredScrollRef}
            className="flex gap-3 overflow-x-auto pb-2 no-scrollbar scroll-smooth"
          >
            {agencies
              .filter(a => a.isSponsored)
              .map((agency, idx) => {
                const estWaitMin = Math.max(1, Math.round(agency.waitingCount * (agency.avgServiceTime || 10) * 0.75));
                const estWaitMax = Math.round(agency.waitingCount * (agency.avgServiceTime || 10) * 1.3);
                return (
                  <motion.button
                    key={agency.id}
                    initial={{ opacity: 0, x: 20 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: idx * 0.1 }}
                    whileHover={{ y: -3 }}
                    whileTap={{ scale: 0.97 }}
                    onClick={() => handleSelectAgency(agency)}
                    className="flex-shrink-0 min-w-[220px] rounded-2xl border border-amber-200 dark:border-amber-800/50 bg-gradient-to-b from-amber-50 to-white dark:from-amber-900/20 dark:to-gray-900/80 shadow-sm hover:shadow-md transition-all duration-200 p-4 text-start relative overflow-hidden"
                  >
                    {/* Shimmer gradient top border */}
                    <div className="absolute top-0 start-0 end-0 h-1 bg-gradient-to-r from-amber-400 via-yellow-300 to-amber-400 animate-pulse" />
                    {/* Sponsored badge */}
                    <div className="flex items-center gap-1.5 mb-2.5">
                      <Badge className="bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-400 border-amber-200 dark:border-amber-700 text-[10px] px-1.5 shimmer-badge">
                        <Star className="h-2.5 w-2.5 me-0.5 fill-amber-500 text-amber-500" />
                        {t('sponsored')}
                      </Badge>
                      <span className="flex items-center gap-1 text-[10px] font-medium">
                        <span className={`h-1.5 w-1.5 rounded-full ${agency.isQueueOpen && !agency.isPaused ? 'bg-emerald-500' : agency.isPaused ? 'bg-yellow-500' : 'bg-red-500'}`} />
                        <span className={agency.isQueueOpen && !agency.isPaused ? 'text-emerald-600 dark:text-emerald-400' : agency.isPaused ? 'text-yellow-600 dark:text-yellow-400' : 'text-red-600 dark:text-red-400'}>
                          {agency.isPaused ? t('paused') : agency.isQueueOpen ? t('openNow') : t('closed')}
                        </span>
                      </span>
                    </div>
                    <h3 className="font-semibold text-sm text-foreground mb-1 truncate">{getAgencyName(agency)}</h3>
                    <Badge variant="secondary" className="text-[10px] mb-1.5">{getCategoryLabel(agency.category)}</Badge>
                    {((agency.reviewCount ?? 0) > 0) && ((agency.averageRating ?? 0) > 0) && (
                      <div className="mb-1.5">
                        <AgencyRatingDisplay averageRating={agency.averageRating ?? 0} totalCount={agency.reviewCount ?? 0} compact size="sm" />
                      </div>
                    )}
                    <div className="flex items-center justify-between mt-2">
                      <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
                        <Clock className="h-3 w-3" />
                        {estWaitMin < estWaitMax ? t('estWaitRange').replace('{min}', String(estWaitMin)).replace('{max}', String(estWaitMax)) : `~${estWaitMin} ${t('min')}`}
                      </span>
                      <span
                        onClick={(e) => { e.stopPropagation(); if (agency.subscriptionStatus === 'ACTIVE') handleQuickJoin(agency.id); }}
                        className={`px-2.5 py-1 rounded-full text-[10px] font-medium transition-colors ${agency.subscriptionStatus !== 'ACTIVE' ? 'bg-gray-300 dark:bg-gray-600 text-gray-500 dark:text-gray-400 cursor-not-allowed' : 'bg-emerald-500 text-white hover:bg-emerald-600'}`}
                      >
                        {agency.subscriptionStatus !== 'ACTIVE' ? t('inactiveAgency') : t('joinQueue')}
                      </span>
                    </div>
                  </motion.button>
                );
              })}
          </div>
        </motion.div>
      )}

      {/* Nearby Agencies Section — Enhanced Rating Cards with live status dots */}
      {!loading && agencies.length > 0 && (
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2 }}
          className="mb-5"
        >
          <h2 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-2">
            <Navigation className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
            {t('nearbyAgencies')}
          </h2>
          <div className="flex gap-3 overflow-x-auto pb-2 no-scrollbar scroll-smooth">
            {(() => {
              const sorted = [...agencies]
                .filter((a) => a.isQueueOpen && !a.isPaused)
                .sort((a, b) => ((a.averageRating ?? 0) > (b.averageRating ?? 0) ? -1 : 1))
                .slice(0, 5);
              return sorted.map((agency, idx) => (
                <motion.div
                  key={agency.id}
                  initial={{ opacity: 0, x: 10 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: idx * 0.08 }}
                  className="flex-shrink-0 min-w-[280px] sm:min-w-[320px]"
                >
                  <EnhancedRatingCard
                    agency={{
                      id: agency.id,
                      name: agency.name,
                      nameAr: agency.nameAr,
                      category: agency.category,
                      averageRating: agency.averageRating ?? 0,
                      reviewCount: agency.reviewCount ?? 0,
                      isQueueOpen: agency.isQueueOpen && !agency.isPaused,
                      avgServiceTime: agency.avgServiceTime,
                      waitingCount: agency.waitingCount,
                      customCode: agency.customCode,
                    }}
                    onJoinQueue={(agencyId) => {
                      if (agency.subscriptionStatus === 'ACTIVE') {
                        handleQuickJoin(agencyId);
                      }
                    }}
                    compact
                  />
                </motion.div>
              ));
            })()}
          </div>
        </motion.div>
      )}

      {/* Category Filter Pills */}
      <CategoryFiltersWithCounts
        selectedCategory={selectedCategory}
        onCategoryChange={setSelectedCategory}
        categoryCounts={categoryCounts}
        t={t}
      />

      {/* Pull to Refresh Hint */}
      {!loading && agencies.length > 0 && (
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex justify-center mb-3"
        >
          <motion.div
            animate={{ y: [0, 4, 0], opacity: [0.4, 0.7, 0.4] }}
            transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}
            className="flex items-center gap-1.5 text-[10px] text-muted-foreground"
          >
            <div className="h-4 w-4 rounded-full border border-muted-foreground/30 flex items-center justify-center">
              <div className="h-1.5 w-1.5 rounded-full bg-muted-foreground/40" />
            </div>
            {t('pullToRefresh') || 'Pull down to refresh'}
          </motion.div>
        </motion.div>
      )}

      {/* Agency Cards Grid */}
      {loading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {[...Array(6)].map((_, i) => (
            <motion.div
              key={i}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4, delay: i * 0.08 }}
              className="relative overflow-hidden rounded-2xl"
            >
              {/* Shimmer loading background */}
              <div className="p-4 space-y-3 bg-white dark:bg-gray-900/80 rounded-2xl border border-border/30">
                <div className="flex items-start justify-between">
                  <div className="h-10 w-10 rounded-xl bg-emerald-100/80 dark:bg-emerald-900/30 animate-pulse" />
                  <div className="h-5 w-16 rounded-full bg-emerald-50 dark:bg-emerald-900/20 animate-pulse" />
                </div>
                <div className="space-y-2">
                  <div className="h-4 w-3/4 rounded-full bg-gray-100 dark:bg-gray-800 animate-pulse" />
                  <div className="h-3 w-1/2 rounded-full bg-gray-50 dark:bg-gray-800/50 animate-pulse" />
                </div>
                <div className="h-5 w-20 rounded-full bg-teal-50 dark:bg-teal-900/20 animate-pulse" />
                <div className="flex items-center justify-between pt-3 border-t border-gray-100 dark:border-gray-800">
                  <div className="h-5 w-14 rounded-full bg-gray-50 dark:bg-gray-800/50 animate-pulse" />
                  <div className="h-5 w-5 rounded-full bg-gray-50 dark:bg-gray-800/50 animate-pulse" />
                </div>
              </div>
            </motion.div>
          ))}
        </div>
      ) : fetchError ? (
        <ErrorState onRetry={fetchAgencies} />
      ) : filteredAgencies.length === 0 ? (
        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          className="flex flex-col items-center justify-center py-12 text-center"
        >
          <div className="relative mb-6">
            {/* Pulsing background ring */}
            <motion.div
              animate={{ scale: [1, 1.2, 1], opacity: [0.15, 0.05, 0.15] }}
              transition={{ duration: 4, repeat: Infinity, ease: 'easeInOut' }}
              className="absolute top-1/2 start-1/2 -translate-x-1/2 -translate-y-1/2 h-28 w-28 rounded-full bg-emerald-200 dark:bg-emerald-800"
            />
            {/* Decorative dashed circle */}
            <motion.div
              animate={{ rotate: 360 }}
              transition={{ duration: 30, repeat: Infinity, ease: 'linear' }}
              className="absolute top-1/2 start-1/2 -translate-x-1/2 -translate-y-1/2 h-24 w-24 rounded-full border-2 border-dashed border-emerald-200/60 dark:border-emerald-700/40"
            />
            <div className="relative flex h-20 w-20 items-center justify-center rounded-3xl bg-gradient-to-br from-emerald-100 to-teal-50 dark:from-emerald-900/30 dark:to-teal-900/20 ring-1 ring-emerald-200/60 dark:ring-emerald-800/60 shadow-inner">
              {searchQuery.trim() ? (
                <span className="text-3xl">🔍</span>
              ) : (
                <span className="text-3xl">🏢</span>
              )}
            </div>
          </div>
          {searchQuery.trim() ? (
            <>
              <h3 className="text-lg font-bold text-foreground mb-2">{t('noSearchResultsTitle') || 'No Results'}</h3>
              <p className="text-sm text-muted-foreground leading-relaxed max-w-[300px] mb-4">
                {t('noSearchResultsDesc') || `No agencies match "${searchQuery}". Try a different search term.`}
              </p>
              <div className="flex flex-col sm:flex-row gap-3">
                <Button
                  variant="outline"
                  className="gap-2 min-h-[44px] rounded-2xl border-emerald-200 dark:border-emerald-800 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-900/30"
                  onClick={() => { setSearchQuery(''); setSelectedCategory('ALL'); }}
                >
                  <X className="h-4 w-4" />
                  {t('clearSearch')}
                </Button>
                <Button
                  className="gap-2 min-h-[44px] px-6 rounded-2xl bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white font-semibold shadow-lg"
                  onClick={() => { setSearchQuery(''); setSelectedCategory('ALL'); searchSectionRef.current?.scrollIntoView({ behavior: 'smooth' }); }}
                >
                  <Search className="h-4 w-4" />
                  {t('emptyNoAgenciesAction') || 'Explore Agencies'}
                </Button>
              </div>
            </>
          ) : selectedCategory !== 'ALL' ? (
            <>
              <h3 className="text-lg font-bold text-foreground mb-2">{t('emptyNoAgenciesTitle')}</h3>
              <p className="text-sm text-muted-foreground leading-relaxed max-w-[300px] mb-4">{t('emptyNoAgenciesDesc')}</p>
              <div className="flex flex-col sm:flex-row gap-3">
                <Button
                  variant="outline"
                  className="gap-2 min-h-[44px] rounded-2xl border-emerald-200 dark:border-emerald-800 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-900/30"
                  onClick={() => setSelectedCategory('ALL')}
                >
                  <X className="h-4 w-4" />
                  {t('clearSearch')}
                </Button>
              </div>
            </>
          ) : (
            <>
              <h3 className="text-lg font-bold text-foreground mb-2">{t('emptyNoAgenciesTitle')}</h3>
              <p className="text-sm text-muted-foreground leading-relaxed max-w-[300px] mb-4">{t('emptyNoAgenciesDesc')}</p>
              <Button
                className="gap-2 min-h-[44px] px-6 rounded-2xl bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white font-semibold shadow-lg"
                onClick={fetchAgencies}
              >
                <RefreshCw className="h-4 w-4" />
                {t('emptyNoAgenciesRetry') || 'Retry'}
              </Button>
            </>
          )}
        </motion.div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {filteredAgencies.map((agency, idx) => {
            const estWait = agency.waitingCount * (agency.avgServiceTime || 10);
            const estWaitMin = Math.max(1, Math.round(estWait * 0.75));
            const estWaitMax = Math.round(estWait * 1.3);
            const queueStatus = agency.isQueueOpen && !agency.isPaused ? 'open' : agency.isPaused ? 'paused' : 'closed';
            const distKm = ((idx + 1) * 0.5 + (idx * 0.3)).toFixed(1);
            return (
            <motion.div
              key={agency.id}
              initial={{ opacity: 0, y: 20, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              transition={{ duration: 0.4, delay: Math.min(idx * 0.06, 0.6), type: 'spring', stiffness: 200, damping: 20 }}
              whileHover={{ y: -6, scale: 1.02 }}
              className="group card-hover-scale"
            >
              <Card
                className={`h-full cursor-pointer border-0 shadow-sm hover:shadow-lg hover:shadow-emerald-500/5 transition-all duration-200 hover:-translate-y-0.5 group-hover:border-emerald-200 dark:group-hover:border-emerald-800 bg-white dark:bg-gray-900/80 dark:border-gray-800/50 dark:backdrop-blur-sm dark:shadow-gray-900/50 relative overflow-hidden ${agency.isSponsored ? 'ring-1 ring-amber-200 dark:ring-amber-800/50' : ''}`}
                onClick={() => handleSelectAgency(agency)}
              >
                {/* Gradient top border for sponsored agencies */}
                {agency.isSponsored && (
                  <div className="absolute top-0 start-0 end-0 h-1 bg-gradient-to-r from-amber-400 via-emerald-400 to-amber-400 shimmer-gradient" />
                )}
                <CardContent className="p-4">
                  <div className="flex items-start justify-between mb-2">
                    <div className="h-10 w-10 rounded-xl bg-emerald-100 dark:bg-emerald-900/40 flex items-center justify-center flex-shrink-0 group-hover:bg-emerald-200 dark:group-hover:bg-emerald-800/50 transition-colors duration-300">
                      <TicketCheck className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
                    </div>
                    <div className="flex items-center gap-1.5 flex-wrap justify-end">
                      {agency.isSponsored && (
                        <Badge className="bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400 border-amber-200 text-[10px] px-1.5 shimmer-badge">
                          <Star className="h-2.5 w-2.5 me-0.5 fill-amber-500 text-amber-500" />
                          {t('sponsored')}
                        </Badge>
                      )}
                      {/* Inactive subscription badge */}
                      {agency.subscriptionStatus !== 'ACTIVE' && (
                        <Badge variant="outline" className="text-[10px] bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400 border-amber-200">
                          {t('inactiveAgency')}
                        </Badge>
                      )}
                      {/* Queue status indicator with dot */}
                      <span className="flex items-center gap-1">
                        <span className={`h-2 w-2 rounded-full ${queueStatus === 'open' ? 'bg-emerald-500' : queueStatus === 'paused' ? 'bg-yellow-500' : 'bg-red-500'}`} />
                        <Badge
                          variant="outline"
                          className={
                            queueStatus === 'open'
                              ? 'text-[10px] bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400 border-emerald-200'
                              : queueStatus === 'paused'
                                ? 'text-[10px] bg-yellow-50 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400 border-yellow-200'
                                : 'text-[10px] bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-400 border-red-200'
                          }
                        >
                          {agency.isPaused ? t('paused') : agency.isQueueOpen ? t('openNow') : t('closed')}
                        </Badge>
                      </span>
                    </div>
                  </div>

                  <h3 className="font-semibold text-sm text-foreground mb-1 group-hover:text-emerald-700 dark:group-hover:text-emerald-400 transition-colors">
                    {getAgencyName(agency)}
                  </h3>

                  <p className="text-xs text-muted-foreground mb-2 line-clamp-1 flex items-center gap-1">
                    <MapPin className="h-3 w-3 flex-shrink-0" />
                    {agency.address}
                    <span className="ms-auto text-emerald-600 dark:text-emerald-400 font-medium">{distKm} km</span>
                  </p>

                  {/* Estimated wait time badge with range */}
                  {agency.isQueueOpen && !agency.isPaused && (
                    <div className="flex items-center gap-1.5 mb-2">
                      <Badge variant="outline" className="text-[10px] bg-teal-50 text-teal-700 dark:bg-teal-900/20 dark:text-teal-400 border-teal-200">
                        <Clock className="h-2.5 w-2.5 me-1" />
                        {estWaitMin < estWaitMax ? t('estWaitRange').replace('{min}', String(estWaitMin)).replace('{max}', String(estWaitMax)) : `~${estWaitMin} ${t('min')}`}
                      </Badge>
                      {agency.serviceCount > 1 && (
                        <Badge variant="outline" className="text-[10px] bg-gray-50 text-gray-600 dark:bg-gray-800 dark:text-gray-400 border-gray-200">
                          <Briefcase className="h-2.5 w-2.5 me-1" />
                          {agency.serviceCount} {t('services')}
                        </Badge>
                      )}
                    </div>
                  )}

                  {/* Rating display */}
                  {((agency.reviewCount ?? 0) > 0) && ((agency.averageRating ?? 0) > 0) && (
                    <div className="mb-2">
                      <AgencyRatingDisplay
                        averageRating={agency.averageRating ?? 0}
                        totalCount={agency.reviewCount ?? 0}
                        compact
                        size="sm"
                      />
                    </div>
                  )}

                  <div className="flex items-center justify-between mt-3 pt-3 border-t border-border">
                    <div className="flex items-center gap-2">
                      <Badge variant="secondary" className="text-[10px]">
                        {getCategoryLabel(agency.category)}
                      </Badge>
                      <span className="flex items-center gap-1 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
                        <UserRound className="h-3 w-3" />
                        {agency.waitingCount} {t('waiting')}
                      </span>
                    </div>
                    <div className="flex items-center gap-1">
                      {/* Heart favorite button */}
                      <button
                        onClick={(e) => toggleFavorite(e, agency.id)}
                        disabled={togglingFav === agency.id}
                        className="h-7 w-7 rounded-full flex items-center justify-center hover:bg-red-50 dark:hover:bg-red-900/10 transition-colors"
                      >
                        {togglingFav === agency.id ? (
                          <Loader2 className="h-3.5 w-3.5 text-red-500 animate-spin" />
                        ) : favoriteIds.has(agency.id) ? (
                          <Heart className="h-3.5 w-3.5 text-red-500 fill-red-500" />
                        ) : (
                          <Heart className="h-3.5 w-3.5 text-gray-300 dark:text-gray-600" />
                        )}
                      </button>
                      {/* Quick Join button for single-service agencies */}
                      {agency.isQueueOpen && !agency.isPaused && agency.serviceCount === 1 && (
                        <button
                          onClick={(e) => { e.stopPropagation(); if (agency.subscriptionStatus === 'ACTIVE') handleQuickJoin(agency.id); }}
                          disabled={agency.subscriptionStatus !== 'ACTIVE'}
                          className={`h-7 px-2.5 rounded-full flex items-center gap-1 text-[10px] font-medium transition-colors ${agency.subscriptionStatus !== 'ACTIVE' ? 'bg-gray-300 dark:bg-gray-600 text-gray-500 dark:text-gray-400 cursor-not-allowed' : 'bg-emerald-500 text-white hover:bg-emerald-600'}`}
                        >
                          <Zap className="h-3 w-3" />
                          {agency.subscriptionStatus !== 'ACTIVE' ? t('inactiveAgency') : t('joinQueue')}
                        </button>
                      )}
                      {/* Mini waiting count badge */}
                      {agency.isQueueOpen && agency.serviceCount > 1 && (
                        <motion.div
                          initial={{ scale: 0 }}
                          animate={{ scale: 1 }}
                          transition={{ delay: idx * 0.05 + 0.3 }}
                          className="flex items-center gap-1 text-[10px] text-emerald-600 dark:text-emerald-400"
                        >
                          <motion.div
                            animate={{ scale: [1, 1.3, 1] }}
                            transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}
                            className="h-1.5 w-1.5 rounded-full bg-emerald-500"
                          />
                          {agency.serviceCount} {t('services')}
                        </motion.div>
                      )}
                      <ChevronRight className="h-4 w-4 text-muted-foreground rtl:rotate-180 group-hover:text-emerald-500 transition-colors" />
                    </div>
                  </div>
                </CardContent>
              </Card>
            </motion.div>
          );})}
        </div>
      )}

      {/* Date Picker Dialog */}
      {dateDialogContent}

      {/* QR Code Scanner Dialog */}
      <CustomerQrScanner
        open={qrScannerOpen}
        onOpenChange={setQrScannerOpen}
        onAgencyFound={(code) => fetchAgencyDetail(code)}
      />

      {/* Recently Visited Section */}
      <RecentlyVisited
        t={t}
        lang={lang}
        onSelectAgency={handleSelectAgency}
      />

      {/* Recent Activity Feed */}
      <RecentActivityFeed
        t={t}
        lang={lang}
        onViewHistory={() => setView('customer-history')}
      />
    </div>
  );
}

// ─── Category Filters wrapper with counts ────
function CategoryFiltersWithCounts({
  selectedCategory,
  onCategoryChange,
  categoryCounts,
  t,
}: {
  selectedCategory: string;
  onCategoryChange: (cat: string) => void;
  categoryCounts: Record<string, number>;
  t: (key: import("@/i18n").TranslationKeys) => string;
}) {
  return (
    <div className="flex gap-2 overflow-x-auto pb-3 mb-5 no-scrollbar snap-x snap-mandatory scroll-smooth" style={{ WebkitOverflowScrolling: 'touch' }}>
      {categoryKeys.map((cat) => {
        const Icon = cat.icon;
        const isActive = selectedCategory === cat.value;
        const count = cat.value === 'ALL'
          ? Object.values(categoryCounts).reduce((s, c) => s + c, 0)
          : categoryCounts[cat.value] || 0;
        return (
          <motion.button
            key={cat.value}
            onClick={() => onCategoryChange(cat.value)}
            layout
            className={`snap-start flex items-center gap-1.5 px-3.5 py-2 rounded-full text-xs font-medium whitespace-nowrap transition-all min-h-9 active:scale-95 relative ${
              isActive
                ? 'bg-gradient-to-r from-emerald-600 to-teal-600 text-white shadow-lg shadow-emerald-500/30'
                : 'bg-white/60 dark:bg-gray-800/60 text-muted-foreground hover:bg-gray-200 dark:hover:bg-gray-700 backdrop-blur-sm border border-gray-200/50 dark:border-gray-700/50'
            }`}
          >
            <motion.span
              initial={false}
              animate={{ scale: isActive ? 1.1 : 1, rotate: isActive ? 10 : 0 }}
              transition={{ type: 'spring', stiffness: 300, damping: 20 }}
            >
              <Icon className="h-3.5 w-3.5" />
            </motion.span>
            {t(cat.key)}
            {/* Count badge */}
            {count > 0 && (
              <span className={`text-[9px] font-bold min-w-[16px] h-4 px-1 rounded-full flex items-center justify-center ${
                isActive
                  ? 'bg-white/25 text-white'
                  : 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400'
              }`}>
                {count > 99 ? '99+' : count}
              </span>
            )}
            {/* Animated selection indicator */}
            {isActive && (
              <motion.div
                layoutId="categoryIndicator"
                className="absolute inset-0 rounded-full bg-gradient-to-r from-emerald-600 to-teal-600 -z-10"
                transition={{ type: 'spring', stiffness: 400, damping: 30 }}
              />
            )}
          </motion.button>
        );
      })}
    </div>
  );
}

// ─── Agency Reviews Preview (for customer agency detail dialog) ────
function AgencyReviewsPreview({ agencyId, averageRating, reviewCount }: { agencyId: string; averageRating?: number; reviewCount?: number }) {
  const { t, lang } = useLanguage();
  const [reviews, setReviews] = useState<Array<{
    id: string;
    rating: number;
    comment: string | null;
    createdAt: string;
    user: { fullName: string; avatarUrl?: string };
  }>>([]);
  const [loading, setLoading] = useState(true);
  const [showAll, setShowAll] = useState(false);

  const fetchReviews = useCallback(async () => {
    try {
      const res = await apiFetch(`/api/reviews?agencyId=${encodeURIComponent(agencyId)}&limit=5`);
      if (res.ok) {
        const data = await res.json();
        setReviews(data.reviews ?? []);
      }
    } catch { /* silent */ }
    finally { setLoading(false); }
  }, [agencyId]);

  useEffect(() => {
    fetchReviews();
  }, [fetchReviews]);

  if (loading) {
    return (
      <div className="mt-4 pt-4 border-t border-border">
        <div className="flex items-center gap-2 mb-3">
          <div className="h-4 w-4 bg-muted rounded animate-pulse" />
          <div className="h-4 w-24 bg-muted rounded animate-pulse" />
        </div>
        <div className="space-y-2">
          {[1, 2].map((i) => (
            <div key={i} className="h-16 bg-muted/50 rounded-lg animate-pulse" />
          ))}
        </div>
      </div>
    );
  }

  if (reviews.length === 0) {
    return (
      <div className="mt-4 pt-4 border-t border-border">
        <div className="flex items-center gap-2 mb-3">
          <MessageCircle className="h-4 w-4 text-amber-500" />
          <h3 className="font-semibold text-sm text-foreground">{t('customerReviews')}</h3>
        </div>
        <div className="text-center py-6">
          <div className="h-12 w-12 rounded-full bg-amber-50 dark:bg-amber-900/20 flex items-center justify-center mx-auto mb-2">
            <Star className="h-6 w-6 text-amber-300 dark:text-amber-700" />
          </div>
          <p className="text-sm text-muted-foreground">{t('noReviewsYet')}</p>
          <p className="text-xs text-muted-foreground mt-0.5">{t('beFirstToReview')}</p>
        </div>
      </div>
    );
  }

  const displayReviews = showAll ? reviews : reviews.slice(0, 3);

  return (
    <div className="mt-4 pt-4 border-t border-border">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <MessageCircle className="h-4 w-4 text-amber-500" />
          <h3 className="font-semibold text-sm text-foreground">{t('customerReviews')}</h3>
        </div>
        <div className="flex items-center gap-1.5">
          <AgencyRatingDisplay
            averageRating={averageRating ?? 0}
            totalCount={reviewCount ?? reviews.length}
            compact
            size="sm"
          />
        </div>
      </div>

      <div className="space-y-2">
        <AnimatePresence>
          {displayReviews.map((review, idx) => {
            const initials = review.user.fullName
              .split(' ')
              .map((n: string) => n[0])
              .filter(Boolean)
              .slice(0, 2)
              .join('')
              .toUpperCase();
            const colors = ['bg-emerald-500', 'bg-teal-500', 'bg-amber-500', 'bg-rose-500', 'bg-violet-500'];
            const colorClass = colors[review.user.fullName.length % colors.length];

            return (
              <motion.div
                key={review.id}
                initial={{ opacity: 0, y: 5 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: idx * 0.05 }}
                className="flex items-start gap-2.5 p-2.5 rounded-lg bg-gray-50 dark:bg-gray-800/50"
              >
                <div className={`h-8 w-8 rounded-full ${colorClass} flex items-center justify-center flex-shrink-0`}>
                  <span className="text-[10px] font-bold text-white">{initials || '?'}</span>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs font-semibold text-foreground">{review.user.fullName}</span>
                    <div className="flex gap-0.5">
                      {[1, 2, 3, 4, 5].map((star) => (
                        <Star
                          key={star}
                          className={`h-2.5 w-2.5 ${
                            star <= review.rating
                              ? 'fill-amber-400 text-amber-400'
                              : 'fill-gray-200 text-gray-200 dark:fill-gray-600 dark:text-gray-600'
                          }`}
                        />
                      ))}
                    </div>
                  </div>
                  {review.comment && (
                    <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{review.comment}</p>
                  )}
                  <span className="text-[10px] text-muted-foreground/70">
                    {new Date(review.createdAt).toLocaleDateString(
                      lang === 'ar' ? 'ar-DZ' : lang === 'fr' ? 'fr-DZ' : 'en-US',
                      { month: 'short', day: 'numeric' }
                    )}
                  </span>
                </div>
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>

      {reviews.length > 3 && (
        <Button
          variant="ghost"
          size="sm"
          className="w-full mt-2 text-xs text-emerald-600 dark:text-emerald-400 hover:text-emerald-700"
          onClick={() => setShowAll(!showAll)}
        >
          {showAll ? t('showLess' as any) || 'Show less' : `${t('seeAllReviews')} (${reviews.length})`}
        </Button>
      )}
    </div>
  );
}
