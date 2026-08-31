'use client'
import { apiFetch } from '@/lib/api-fetch';;

import { useEffect, useState } from 'react';
import { useAppStore, type ViewName } from '@/store/use-app-store';
import { useLanguage } from '@/hooks/use-language';
import { isRTL, type TranslationKeys } from '@/i18n';
import { getProxiedUrl } from '@/lib/utils';
import { usePlatform } from '@/hooks/use-platform';
import { nativeBridge } from '@/lib/native-bridge';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
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
} from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';

// ─── Shared Types ─────────────────────────────────────────────────────────────

interface NavItem {
  view: 'customer-home' | 'customer-queue' | 'customer-history' | 'customer-profile';
  icon: typeof HomeIcon;
  label: string;
}

// ─── Haptic Helper ────────────────────────────────────────────────────────────

function triggerHaptic() {
  try {
    nativeBridge.vibrate(10);
  } catch {
    // silent fallback
  }
}

// ─── Electron Top Tab Bar ─────────────────────────────────────────────────────

function CustomerTopTabBar({ mainItems, currentView, setView, moreOpen, setMoreOpen, unreadCount, user, logout, t }: {
  mainItems: NavItem[];
  currentView: ViewName;
  setView: (view: ViewName) => void;
  moreOpen: boolean;
  setMoreOpen: (open: boolean | ((prev: boolean) => boolean)) => void;
  unreadCount: number;
  user: { avatarUrl?: string; fullName?: string; username?: string } | null;
  logout: () => void;
  t: (key: TranslationKeys, params?: Record<string, string>) => string;
}) {
  const { capabilities } = usePlatform();

  const handleMoreNav = (view: 'customer-favorites' | 'customer-notifications' | 'customer-settings') => {
    setMoreOpen(false);
    setView(view);
  };

  return (
    <>
      <nav className="h-12 bg-white/90 dark:bg-gray-950/90 backdrop-blur-xl border-b border-border flex items-center px-4 gap-1">
        {mainItems.map((item) => {
          const active = currentView === item.view;
          const Icon = item.icon;
          return (
            <motion.button
              key={item.view}
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
              onClick={() => {
                setView(item.view);
                if (capabilities.canUseVibration) triggerHaptic();
              }}
              className={`relative flex items-center gap-2 px-4 py-1.5 rounded-lg text-sm font-medium transition-all duration-200 ${
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

        {/* More button */}
        <Sheet open={moreOpen} onOpenChange={setMoreOpen}>
          <SheetTrigger asChild>
            <motion.button
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
              className="relative flex items-center gap-2 px-4 py-1.5 rounded-lg text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
            >
              <div className="relative">
                <MoreHorizontal className="h-4 w-4" />
                {unreadCount > 0 && (
                  <span className="absolute -top-1.5 -end-2 h-3.5 min-w-3.5 px-0.5 flex items-center justify-center rounded-full bg-red-500 text-white text-[8px] font-bold">
                    {unreadCount > 99 ? '99+' : unreadCount}
                  </span>
                )}
              </div>
              {t('more')}
            </motion.button>
          </SheetTrigger>
          <SheetContent side="right" className="w-80">
            <SheetHeader>
              <SheetTitle className="sr-only">{t('more')}</SheetTitle>
            </SheetHeader>
            {/* User header */}
            <div className="flex items-center gap-3 px-2 pb-4 pt-2">
              <div className="h-12 w-12 rounded-full bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center shadow-lg flex-shrink-0 overflow-hidden">
                {user?.avatarUrl ? (
                  <img src={getProxiedUrl(user.avatarUrl)} alt={user.fullName} width={36} height={36} className="h-full w-full object-cover" />
                ) : (
                  <span className="text-lg font-bold text-white">
                    {user?.fullName?.charAt(0)?.toUpperCase() || 'U'}
                  </span>
                )}
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-semibold text-foreground truncate">{user?.fullName}</p>
                <p className="text-xs text-muted-foreground truncate">@{user?.username}</p>
              </div>
            </div>
            <div className="h-px bg-border mx-2" />
            <div className="px-1 py-3 space-y-1">
              <button
                onClick={() => handleMoreNav('customer-favorites')}
                className="w-full flex items-center gap-3 px-3 py-3 rounded-xl hover:bg-muted dark:hover:bg-gray-800 transition-colors"
              >
                <Heart className="h-5 w-5 text-rose-500" />
                <span className="text-sm font-medium text-foreground">{t('favorites')}</span>
              </button>
              <button
                onClick={() => handleMoreNav('customer-notifications')}
                className="w-full flex items-center gap-3 px-3 py-3 rounded-xl hover:bg-muted dark:hover:bg-gray-800 transition-colors"
              >
                <Bell className="h-5 w-5 text-amber-500" />
                <span className="text-sm font-medium text-foreground">{t('notifications')}</span>
                {unreadCount > 0 && (
                  <span className="ms-auto h-5 min-w-5 px-1.5 flex items-center justify-center rounded-full bg-red-500 text-white text-[10px] font-bold">
                    {unreadCount > 99 ? '99+' : unreadCount}
                  </span>
                )}
              </button>
              <button
                onClick={() => handleMoreNav('customer-settings')}
                className="w-full flex items-center gap-3 px-3 py-3 rounded-xl hover:bg-muted dark:hover:bg-gray-800 transition-colors"
              >
                <Settings2 className="h-5 w-5 text-gray-500 dark:text-gray-400" />
                <span className="text-sm font-medium text-foreground">{t('settings')}</span>
              </button>
              <div className="h-px bg-border mx-3 my-1" />
              <button
                onClick={() => { logout(); setMoreOpen(false); }}
                className="w-full flex items-center gap-3 px-3 py-3 rounded-xl hover:bg-red-50 dark:hover:bg-red-900/10 transition-colors"
              >
                <LogOut className="h-5 w-5 text-red-500" />
                <span className="text-sm font-medium text-red-600 dark:text-red-400">{t('logout')}</span>
              </button>
            </div>
          </SheetContent>
        </Sheet>
      </nav>
    </>
  );
}

// ─── Mobile Bottom Navigation ─────────────────────────────────────────────────

function CustomerMobileBottomNav({ mainItems, currentView, setView, moreOpen, setMoreOpen, unreadCount, user, logout, t }: {
  mainItems: NavItem[];
  currentView: ViewName;
  setView: (view: ViewName) => void;
  moreOpen: boolean;
  setMoreOpen: (open: boolean | ((prev: boolean) => boolean)) => void;
  unreadCount: number;
  user: { avatarUrl?: string; fullName?: string; username?: string } | null;
  logout: () => void;
  t: (key: TranslationKeys, params?: Record<string, string>) => string;
}) {
  const { capabilities } = usePlatform();

  const handleMoreNav = (view: 'customer-favorites' | 'customer-notifications' | 'customer-settings') => {
    setMoreOpen(false);
    setView(view);
  };

  return (
    <>
      <nav className="fixed bottom-0 inset-x-0 z-50 bg-white/90 dark:bg-gray-950/90 backdrop-blur-xl safe-area-bottom">
        <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-border to-transparent" />
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
                  if (capabilities.canUseVibration) triggerHaptic();
                }}
                aria-current={active ? 'page' : undefined}
                className="relative flex flex-col items-center justify-center gap-0.5 flex-1 h-full"
              >
                {active && (
                  <motion.div
                    layoutId="customer-nav-dot"
                    className="absolute -top-0 h-1 w-1.5 rounded-full bg-emerald-600 dark:bg-emerald-400"
                    transition={{ type: 'spring', stiffness: 350, damping: 30 }}
                  />
                )}
                <Icon className={`h-5 w-5 transition-all duration-200 ${active ? 'scale-110 text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground'}`} />
                <span className={`text-[10px] font-medium transition-colors ${active ? 'text-emerald-600 dark:text-emerald-400 font-semibold' : 'text-muted-foreground'}`}>
                  {item.label}
                </span>
              </motion.button>
            );
          })}

          {/* More button with Sheet */}
          <Sheet open={moreOpen} onOpenChange={setMoreOpen}>
            <SheetTrigger asChild>
              <motion.button
                whileTap={{ scale: 0.9 }}
                transition={{ type: 'spring', stiffness: 400, damping: 17 }}
                onClick={() => { if (capabilities.canUseVibration) triggerHaptic(); }}
                className="relative flex flex-col items-center justify-center gap-0.5 flex-1 h-full"
              >
                <div className="relative">
                  <MoreHorizontal className="h-5 w-5 text-muted-foreground" />
                  {unreadCount > 0 && (
                    <motion.span
                      initial={{ scale: 0 }}
                      animate={{ scale: 1 }}
                      className="absolute -top-1.5 -end-2 h-4 min-w-4 px-1 flex items-center justify-center rounded-full bg-red-500 text-white text-[9px] font-bold"
                    >
                      {unreadCount > 99 ? '99+' : unreadCount}
                    </motion.span>
                  )}
                </div>
                <span className="text-[10px] font-medium text-muted-foreground">{t('more')}</span>
              </motion.button>
            </SheetTrigger>
            <SheetContent side="bottom" className="rounded-t-3xl max-h-[65vh] overflow-y-auto">
              <div className="flex justify-center pt-2 pb-1">
                <div className="h-1.5 w-10 rounded-full bg-gray-300 dark:bg-gray-600" />
              </div>
              <SheetHeader>
                <SheetTitle className="sr-only">{t('more')}</SheetTitle>
              </SheetHeader>
              <div className="flex items-center gap-3 px-5 pb-4">
                <div className="h-12 w-12 rounded-full bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center shadow-lg flex-shrink-0 overflow-hidden">
                  {user?.avatarUrl ? (
                    <img src={getProxiedUrl(user.avatarUrl)} alt={user.fullName} width={36} height={36} className="h-full w-full object-cover" />
                  ) : (
                    <span className="text-lg font-bold text-white">
                      {user?.fullName?.charAt(0)?.toUpperCase() || 'U'}
                    </span>
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-semibold text-foreground truncate">{user?.fullName}</p>
                  <p className="text-xs text-muted-foreground truncate">@{user?.username}</p>
                </div>
              </div>
              <div className="h-px bg-border mx-5" />
              <div className="px-3 py-3 space-y-1">
                <button
                  onClick={() => handleMoreNav('customer-favorites')}
                  className="w-full flex items-center gap-3 px-3 py-3 rounded-xl hover:bg-muted dark:hover:bg-gray-800 transition-colors"
                >
                  <Heart className="h-5 w-5 text-rose-500" />
                  <span className="text-sm font-medium text-foreground">{t('favorites')}</span>
                </button>
                <button
                  onClick={() => handleMoreNav('customer-notifications')}
                  className="w-full flex items-center gap-3 px-3 py-3 rounded-xl hover:bg-muted dark:hover:bg-gray-800 transition-colors"
                >
                  <Bell className="h-5 w-5 text-amber-500" />
                  <span className="text-sm font-medium text-foreground">{t('notifications')}</span>
                  {unreadCount > 0 && (
                    <span className="ms-auto h-5 min-w-5 px-1.5 flex items-center justify-center rounded-full bg-red-500 text-white text-[10px] font-bold">
                      {unreadCount > 99 ? '99+' : unreadCount}
                    </span>
                  )}
                </button>
                <button
                  onClick={() => handleMoreNav('customer-settings')}
                  className="w-full flex items-center gap-3 px-3 py-3 rounded-xl hover:bg-muted dark:hover:bg-gray-800 transition-colors"
                >
                  <Settings2 className="h-5 w-5 text-gray-500 dark:text-gray-400" />
                  <span className="text-sm font-medium text-foreground">{t('settings')}</span>
                </button>
                <div className="h-px bg-border mx-3 my-1" />
                <button
                  onClick={() => { logout(); setMoreOpen(false); }}
                  className="w-full flex items-center gap-3 px-3 py-3 rounded-xl hover:bg-red-50 dark:hover:bg-red-900/10 transition-colors"
                >
                  <LogOut className="h-5 w-5 text-red-500" />
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
  const [moreOpen, setMoreOpen] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);

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

  const mainItems: NavItem[] = [
    { view: 'customer-home', icon: HomeIcon, label: t('home') },
    { view: 'customer-queue', icon: TicketCheck, label: t('myQueue') },
    { view: 'customer-history', icon: CalendarDays, label: t('history') },
    { view: 'customer-profile', icon: User, label: t('profile') },
  ];

  const sharedProps = {
    mainItems,
    currentView,
    setView,
    moreOpen,
    setMoreOpen,
    unreadCount,
    user: user ? { avatarUrl: user.avatarUrl, fullName: user.fullName, username: user.username } : null,
    logout,
    t,
  };

  // Electron: Top tab bar (desktop-appropriate)
  if (platform.isElectron) {
    return <CustomerTopTabBar {...sharedProps} />;
  }

  // Mobile (Capacitor) & Web: Bottom navigation
  return <CustomerMobileBottomNav {...sharedProps} />;
}

// Also export a hook that tells the layout whether customer nav is at the top or bottom
export function useCustomerNavPosition() {
  const { platform } = usePlatform();
  return platform.isElectron ? 'top' as const : 'bottom' as const;
}
