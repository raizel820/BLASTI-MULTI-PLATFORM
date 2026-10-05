'use client'

/**
 * Task 79-a — CustomerNavigation v2 (Design System v2 rebuild).
 *
 * THE single notification bell for the customer platform lives here.
 * (Bug the rebuild fixes: bells used to exist in the top chrome strip in
 * page.tsx, in the home header and in the More trigger badge — 3-4 at once.)
 *
 * Platform-adaptive structure preserved:
 *  - Electron/desktop-web → CustomerTopTabBar: brand mark + nav tabs, right
 *    side = ONE bell (unread badge) + ConnectionDot + LanguageSwitcher +
 *    ThemeToggle, then a compact "More" menu (favorites/analytics/support/
 *    settings + platform switcher + logout).
 *  - Mobile (Capacitor + phone browsers) → slim top strip (avatar/initials +
 *    greeting + bell + theme) and a 5-item bottom nav whose More sheet keeps
 *    the full grouped list (favorites, notifications, analytics, support,
 *    settings, language, platform, logout).
 *
 * Unread-count polling logic is byte-identical to the pre-rebuild version:
 * GET /api/notifications?userId=…&unreadOnly=true every 30s + refetch on the
 * `blasti:notifications-read` window event.
 */

import { apiFetch } from '@/lib/api-fetch';

import { useEffect, useState } from 'react';
import { useAppStore, type ViewName } from '@/store/use-app-store';
import { useLanguage } from '@/hooks/use-language';
import { type TranslationKeys } from '@/i18n';
import { getProxiedUrl } from '@/lib/utils';
import { usePlatform } from '@/hooks/use-platform';
import { nativeBridge } from '@/lib/native-bridge';
import { ConnectionDot } from '@/components/shared/connection-status';
import { LanguageSwitcher } from '@/components/shared/language-switcher';
import { ThemeToggle } from '@/components/shared/theme-toggle';
import { PlatformSwitcher } from '@/components/shared/platform-switcher';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Home as HomeIcon,
  TicketCheck,
  CalendarDays,
  User,
  MoreHorizontal,
  Bell,
  Heart,
  Settings2,
  LogOut,
  BarChart3,
  LifeBuoy,
} from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';

// ─── Shared Types ─────────────────────────────────────────────────────────────

interface NavItem {
  view: 'customer-home' | 'customer-queue' | 'customer-history' | 'customer-profile';
  icon: typeof HomeIcon;
  label: string;
}

interface MoreView {
  view: 'customer-favorites' | 'customer-notifications' | 'customer-settings' | 'customer-analytics' | 'customer-support';
  icon: typeof Heart;
  label: string;
}

interface NavUser {
  avatarUrl?: string;
  fullName?: string;
  username?: string;
}

// ─── Haptic Helper ────────────────────────────────────────────────────────────

function triggerHaptic() {
  try {
    nativeBridge.vibrate(10);
  } catch {
    // silent fallback
  }
}

// ─── Brand mark ───────────────────────────────────────────────────────────────

function BrandMark() {
  return (
    <div className="flex items-center gap-2 flex-shrink-0">
      <span className="h-7 w-7 rounded-xl bg-gradient-to-br from-emerald-600 to-teal-600 flex items-center justify-center shadow-sm">
        <TicketCheck className="h-4 w-4 text-white" />
      </span>
      <span className="hidden sm:block text-sm font-extrabold tracking-tight text-foreground">
        BLASTI
      </span>
    </div>
  );
}

// ─── THE bell (single instance platform-wide for customers) ──────────────────

function CustomerBell({ unreadCount, onClick, label }: {
  unreadCount: number;
  onClick: () => void;
  label: string;
}) {
  return (
    <motion.button
      whileTap={{ scale: 0.94 }}
      onClick={onClick}
      className="relative h-9 w-9 rounded-xl flex items-center justify-center text-muted-foreground hover:bg-emerald-50 hover:text-emerald-700 dark:hover:bg-emerald-900/30 dark:hover:text-emerald-400 transition-colors"
      aria-label={label}
    >
      <Bell className="h-[18px] w-[18px]" />
      <AnimatePresence>
        {unreadCount > 0 && (
          <motion.span
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            exit={{ scale: 0 }}
            className="absolute -top-0.5 -end-0.5"
          >
            <Badge className="h-4 min-w-4 px-1 flex items-center justify-center rounded-full bg-red-500 hover:bg-red-500 text-white text-[9px] font-bold border-0">
              {unreadCount > 99 ? '99+' : unreadCount}
            </Badge>
          </motion.span>
        )}
      </AnimatePresence>
    </motion.button>
  );
}

// ─── Shared nav handlers ──────────────────────────────────────────────────────

function useNavItems(t: (key: TranslationKeys, params?: Record<string, string>) => string) {
  const mainItems: NavItem[] = [
    { view: 'customer-home', icon: HomeIcon, label: t('home') },
    { view: 'customer-queue', icon: TicketCheck, label: t('myQueue') },
    { view: 'customer-history', icon: CalendarDays, label: t('history') },
    { view: 'customer-profile', icon: User, label: t('profile') },
  ];
  const moreItems: MoreView[] = [
    { view: 'customer-favorites', icon: Heart, label: t('favorites') },
    { view: 'customer-notifications', icon: Bell, label: t('notifications') },
    { view: 'customer-analytics', icon: BarChart3, label: t('myAnalytics.nav.title') },
    { view: 'customer-support', icon: LifeBuoy, label: t('supportDesk' as TranslationKeys) },
    { view: 'customer-settings', icon: Settings2, label: t('settings') },
  ];
  return { mainItems, moreItems };
}

// ─── Electron / desktop-web top tab bar ──────────────────────────────────────

function CustomerTopTabBar({ currentView, setView, unreadCount, user, logout, t }: {
  currentView: ViewName;
  setView: (view: ViewName) => void;
  unreadCount: number;
  user: NavUser | null;
  logout: () => void;
  t: (key: TranslationKeys, params?: Record<string, string>) => string;
}) {
  const { mainItems, moreItems } = useNavItems(t);

  return (
    <nav
      className="sticky top-0 z-30 h-12 bg-white/90 dark:bg-gray-950/90 backdrop-blur-xl border-b border-border flex items-center gap-1 px-3 lg:px-4"
      aria-label="Customer navigation"
    >
      <BrandMark />

      <div className="flex items-center gap-0.5 ms-2 min-w-0 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {mainItems.map((item) => {
          const active = currentView === item.view;
          const Icon = item.icon;
          return (
            <motion.button
              key={item.view}
              whileTap={{ scale: 0.96 }}
              onClick={() => {
                setView(item.view);
                triggerHaptic();
              }}
              aria-current={active ? 'page' : undefined}
              className={`relative flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-[13px] font-medium whitespace-nowrap transition-colors ${
                active
                  ? 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground'
              }`}
            >
              <Icon className="h-4 w-4" />
              {item.label}
            </motion.button>
          );
        })}
      </div>

      {/* Right cluster: ONE bell + connection + language + theme + more */}
      <div className="ms-auto flex items-center gap-1 flex-shrink-0">
        <span className="hidden sm:flex items-center gap-1.5 text-xs text-muted-foreground">
          <ConnectionDot />
        </span>
        <CustomerBell
          unreadCount={unreadCount}
          label={t('notifications')}
          onClick={() => {
            triggerHaptic();
            setView('customer-notifications');
          }}
        />
        <div className="hidden md:block">
          <LanguageSwitcher />
        </div>
        <ThemeToggle />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="h-9 w-9 rounded-xl text-muted-foreground" aria-label={t('more')}>
              <MoreHorizontal className="h-[18px] w-[18px]" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56 rounded-2xl">
            <DropdownMenuLabel className="flex items-center gap-2.5">
              <span className="h-8 w-8 rounded-full bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center overflow-hidden flex-shrink-0">
                {user?.avatarUrl ? (
                  <img src={getProxiedUrl(user.avatarUrl)} alt={user.fullName ?? ''} width={32} height={32} className="h-full w-full object-cover" />
                ) : (
                  <span className="text-xs font-bold text-white">{user?.fullName?.charAt(0)?.toUpperCase() || 'U'}</span>
                )}
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-semibold text-foreground truncate">{user?.fullName}</span>
                <span className="block text-[11px] text-muted-foreground truncate">@{user?.username}</span>
              </span>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            {moreItems.map((item) => {
              const Icon = item.icon;
              return (
                <DropdownMenuItem
                  key={item.view}
                  onClick={() => setView(item.view)}
                  className="gap-2.5 rounded-xl cursor-pointer"
                >
                  <Icon className="h-4 w-4 text-muted-foreground" />
                  {item.label}
                  {item.view === 'customer-notifications' && unreadCount > 0 && (
                    <span className="ms-auto h-4 min-w-4 px-1 flex items-center justify-center rounded-full bg-red-500 text-white text-[9px] font-bold">
                      {unreadCount > 99 ? '99+' : unreadCount}
                    </span>
                  )}
                </DropdownMenuItem>
              );
            })}
            <DropdownMenuSeparator />
            <DropdownMenuItem className="rounded-xl cursor-pointer">
              <PlatformSwitcher />
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={logout}
              className="gap-2.5 rounded-xl cursor-pointer text-red-600 dark:text-red-400 focus:text-red-600 dark:focus:text-red-400"
            >
              <LogOut className="h-4 w-4" />
              {t('logout')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </nav>
  );
}

// ─── Mobile: slim top strip ──────────────────────────────────────────────────

function CustomerMobileTopStrip({ unreadCount, setView, t }: {
  unreadCount: number;
  setView: (view: ViewName) => void;
  t: (key: TranslationKeys, params?: Record<string, string>) => string;
}) {
  const user = useAppStore((s) => s.user);

  return (
    <header className="sticky top-0 z-30 h-11 bg-white/90 dark:bg-gray-950/90 backdrop-blur-xl border-b border-border flex items-center gap-2 px-3">
      {/* Brand wordmark — the personal greeting lives in the page content
          (customer-home header), not duplicated here (Task 79-a polish). */}
      <button
        onClick={() => setView('customer-home')}
        className="flex items-center gap-2 min-w-0 flex-1"
        aria-label={t('home')}
      >
        <span className="h-7 w-7 rounded-lg bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center flex-shrink-0 shadow-sm">
          <TicketCheck className="h-4 w-4 text-white" />
        </span>
        <span className="text-[13px] font-bold tracking-tight text-foreground">BLASTI</span>
      </button>
      {/* Compact controls: bell + theme (language lives in the More sheet) */}
      <CustomerBell
        unreadCount={unreadCount}
        label={t('notifications')}
        onClick={() => {
          triggerHaptic();
          setView('customer-notifications');
        }}
      />
      <ThemeToggle />
    </header>
  );
}

// ─── Mobile: bottom navigation + More sheet ──────────────────────────────────

function CustomerMobileBottomNav({ currentView, setView, unreadCount, user, logout, t }: {
  currentView: ViewName;
  setView: (view: ViewName) => void;
  unreadCount: number;
  user: NavUser | null;
  logout: () => void;
  t: (key: TranslationKeys, params?: Record<string, string>) => string;
}) {
  const { mainItems, moreItems } = useNavItems(t);
  const [moreOpen, setMoreOpen] = useState(false);

  const handleMoreNav = (view: MoreView['view']) => {
    setMoreOpen(false);
    setView(view);
  };

  return (
    <>
      <CustomerMobileTopStrip unreadCount={unreadCount} setView={setView} t={t} />

      <nav className="fixed bottom-0 inset-x-0 z-50 bg-white/95 dark:bg-gray-950/95 backdrop-blur-xl safe-area-bottom border-t border-border">
        <div className="flex items-center justify-around h-16 max-w-lg mx-auto px-2">
          {mainItems.map((item) => {
            const active = currentView === item.view;
            const Icon = item.icon;
            return (
              <motion.button
                key={item.view}
                whileTap={{ scale: 0.9 }}
                transition={{ type: 'spring', stiffness: 400, damping: 17 }}
                onClick={() => {
                  setView(item.view);
                  triggerHaptic();
                }}
                aria-current={active ? 'page' : undefined}
                className="relative flex flex-col items-center justify-center gap-0.5 flex-1 h-full"
              >
                {active && (
                  <motion.span
                    layoutId="customer-nav-dot"
                    className="absolute top-0 h-0.5 w-8 rounded-full bg-emerald-600 dark:bg-emerald-400"
                    transition={{ type: 'spring', stiffness: 350, damping: 30 }}
                  />
                )}
                <Icon className={`h-5 w-5 transition-colors ${active ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground'}`} />
                <span className={`text-[10px] transition-colors ${active ? 'text-emerald-600 dark:text-emerald-400 font-semibold' : 'text-muted-foreground'}`}>
                  {item.label}
                </span>
              </motion.button>
            );
          })}

          {/* More */}
          <Sheet open={moreOpen} onOpenChange={setMoreOpen}>
            <SheetTrigger asChild>
              <motion.button
                whileTap={{ scale: 0.9 }}
                transition={{ type: 'spring', stiffness: 400, damping: 17 }}
                onClick={() => triggerHaptic()}
                className="relative flex flex-col items-center justify-center gap-0.5 flex-1 h-full"
              >
                <MoreHorizontal className={`h-5 w-5 ${moreOpen ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground'}`} />
                <span className="text-[10px] font-medium text-muted-foreground">{t('more')}</span>
              </motion.button>
            </SheetTrigger>
            <SheetContent side="bottom" className="rounded-t-3xl max-h-[75vh] overflow-y-auto">
              <div className="flex justify-center pt-2 pb-1">
                <div className="h-1.5 w-10 rounded-full bg-gray-300 dark:bg-gray-600" />
              </div>
              <SheetHeader>
                <SheetTitle className="sr-only">{t('more')}</SheetTitle>
              </SheetHeader>

              {/* Account header */}
              <div className="flex items-center gap-3 px-5 pb-3">
                <div className="h-11 w-11 rounded-full bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center shadow-sm flex-shrink-0 overflow-hidden">
                  {user?.avatarUrl ? (
                    <img src={getProxiedUrl(user.avatarUrl)} alt={user.fullName ?? ''} width={44} height={44} className="h-full w-full object-cover" />
                  ) : (
                    <span className="text-base font-bold text-white">{user?.fullName?.charAt(0)?.toUpperCase() || 'U'}</span>
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-semibold text-foreground truncate">{user?.fullName}</p>
                  <p className="text-xs text-muted-foreground truncate">@{user?.username}</p>
                </div>
              </div>

              <div className="h-px bg-border mx-5" />

              {/* Grouped nav list */}
              <div className="px-3 py-3 space-y-0.5">
                {moreItems.map((item) => {
                  const Icon = item.icon;
                  return (
                    <button
                      key={item.view}
                      onClick={() => handleMoreNav(item.view)}
                      className="w-full flex items-center gap-3 px-3 h-11 rounded-xl hover:bg-muted dark:hover:bg-gray-800 transition-colors"
                    >
                      <Icon className="h-[18px] w-[18px] text-emerald-600 dark:text-emerald-400" />
                      <span className="text-sm font-medium text-foreground">{item.label}</span>
                      {item.view === 'customer-notifications' && unreadCount > 0 && (
                        <span className="ms-auto h-5 min-w-5 px-1.5 flex items-center justify-center rounded-full bg-red-500 text-white text-[10px] font-bold">
                          {unreadCount > 99 ? '99+' : unreadCount}
                        </span>
                      )}
                    </button>
                  );
                })}

                {/* Language switcher + dev-only platform override kept reachable
                    (they used to live in the deleted chrome strip in page.tsx) */}
                <div className="flex items-center justify-between px-3 h-11 rounded-xl bg-muted/50 dark:bg-gray-800/50">
                  <span className="text-xs font-medium text-muted-foreground">{t('language')}</span>
                  <LanguageSwitcher />
                </div>
                {process.env.NODE_ENV === 'development' && (
                  <div className="flex items-center justify-center px-3 py-2 rounded-xl bg-muted/50 dark:bg-gray-800/50">
                    <PlatformSwitcher />
                  </div>
                )}
              </div>

              <div className="h-px bg-border mx-5" />

              <div className="px-3 py-3 pb-6">
                <button
                  onClick={() => { logout(); setMoreOpen(false); }}
                  className="w-full flex items-center gap-3 px-3 h-11 rounded-xl hover:bg-red-50 dark:hover:bg-red-900/10 transition-colors"
                >
                  <LogOut className="h-[18px] w-[18px] text-red-500" />
                  <span className="text-sm font-medium text-red-600 dark:text-red-400">{t('logout')}</span>
                </button>
              </div>
            </SheetContent>
          </Sheet>
        </div>
      </nav>
    </>
  );
}

// ─── Main Exported Component ──────────────────────────────────────────────────

export function CustomerNavigation() {
  const currentView = useAppStore((s) => s.currentView);
  const setView = useAppStore((s) => s.setView);
  const user = useAppStore((s) => s.user);
  const logout = useAppStore((s) => s.logout);
  const { t } = useLanguage();
  const { platform } = usePlatform();
  const [unreadCount, setUnreadCount] = useState(0);

  // Unread polling — identical logic to the pre-rebuild implementation.
  useEffect(() => {
    if (!user?.id) return;
    const fetchUnread = async () => {
      try {
        const res = await apiFetch(`/api/notifications?userId=${user.id}&unreadOnly=true`);
        if (res.ok) {
          const data = await res.json();
          setUnreadCount(data.notifications?.length ?? 0);
        }
      } catch {
        // silent
      }
    };
    fetchUnread();
    const interval = setInterval(fetchUnread, 30000);
    const handleNotificationsRead = () => { fetchUnread(); };
    window.addEventListener('blasti:notifications-read', handleNotificationsRead);
    return () => {
      clearInterval(interval);
      window.removeEventListener('blasti:notifications-read', handleNotificationsRead);
    };
  }, [user?.id]);

  const sharedProps = {
    currentView,
    setView,
    unreadCount,
    user: user ? { avatarUrl: user.avatarUrl, fullName: user.fullName, username: user.username } : null,
    logout,
    t,
  };

  // Electron: top tab bar (desktop-appropriate)
  if (platform.isElectron) {
    return <CustomerTopTabBar {...sharedProps} />;
  }

  // Mobile (Capacitor) & Web: slim top strip + bottom navigation
  return <CustomerMobileBottomNav {...sharedProps} />;
}

// Also export a hook that tells the layout whether customer nav is at the top or bottom
export function useCustomerNavPosition() {
  const { platform } = usePlatform();
  return platform.isElectron ? 'top' as const : 'bottom' as const;
}
