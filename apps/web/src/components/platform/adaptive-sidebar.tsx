'use client'
import { apiFetch } from '@/lib/api-fetch';;

import { useState } from 'react';
import { useAppStore } from '@/store/use-app-store';
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
} from '@/components/ui/sheet';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import {
  LayoutDashboard,
  Settings,
  CreditCard,
  Building2,
  LogOut,
  Menu,
  X,
  Star,
  KeyRound,
  Loader2,
  UserCog,
  GitBranch,
  ClipboardList,
  Users,
  BarChart3,
  ShieldCheck,
  Crown,
  Monitor,
  Smartphone,
  Cpu,
  MailCheck,
  Briefcase,
  Package,
  ChevronDown,
  ChevronRight,
  ChevronLeft,
  History,
} from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';
import { toast } from 'sonner';
import { Toaster } from 'sonner';
import { AgencyHistorySheet } from '@/components/agency/agency-history-sheet';

// ─── Haptic Helper ────────────────────────────────────────────────────────────

function triggerHaptic() {
  try {
    nativeBridge.vibrate(10);
  } catch {
    // silent
  }
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface SidebarNavItem {
  view: string;
  icon: typeof LayoutDashboard;
  label: string;
  children?: SidebarNavItem[];
}

// ─── Mobile Bottom Action Bar ─────────────────────────────────────────────────

function MobileBottomActionBar({ onMenuOpen, onLogout, t }: { onMenuOpen: () => void; onLogout: () => void; t: (key: TranslationKeys, params?: Record<string, string>) => string }) {
  const { capabilities } = usePlatform();

  return (
    <nav className="fixed bottom-0 inset-x-0 z-50 bg-white/90 dark:bg-gray-950/90 backdrop-blur-xl border-t border-border safe-area-bottom">
      <div className="flex items-center justify-around h-14 max-w-lg mx-auto px-2">
        <button
          onClick={() => {
            onMenuOpen();
            if (capabilities.canUseVibration) triggerHaptic();
          }}
          className="flex flex-col items-center justify-center gap-0.5 flex-1 h-full"
        >
          <Menu className="h-5 w-5 text-muted-foreground" />
          <span className="text-[10px] font-medium text-muted-foreground">{t('more')}</span>
        </button>
        <button
          onClick={() => {
            onLogout();
            if (capabilities.canUseVibration) triggerHaptic();
          }}
          className="flex flex-col items-center justify-center gap-0.5 flex-1 h-full"
        >
          <LogOut className="h-5 w-5 text-red-500" />
          <span className="text-[10px] font-medium text-red-500">{t('logout')}</span>
        </button>
      </div>
    </nav>
  );
}

// ─── Agency Sidebar ───────────────────────────────────────────────────────────

export function AdaptiveAgencySidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { currentView, setView, logout, user } = useAppStore();
  const { t } = useLanguage();
  const { platform, capabilities } = usePlatform();
  const [changePasswordOpen, setChangePasswordOpen] = useState(false);
  const [cpCurrentPwd, setCpCurrentPwd] = useState('');
  const [cpNewPwd, setCpNewPwd] = useState('');
  const [cpConfirmPwd, setCpConfirmPwd] = useState('');
  const [cpLoading, setCpLoading] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);

  const handleChangePassword = async () => {
    if (!cpCurrentPwd || !cpNewPwd || !cpConfirmPwd) {
      toast.error(t('requiredField'));
      return;
    }
    if (cpNewPwd.length < 6) {
      toast.error(t('passwordMinLength'));
      return;
    }
    if (cpNewPwd !== cpConfirmPwd) {
      toast.error(t('passwordMismatch'));
      return;
    }
    setCpLoading(true);
    try {
      const res = await apiFetch('/api/user/change-password', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: user?.id, currentPassword: cpCurrentPwd, newPassword: cpNewPwd }),
      });
      const data = await res.json();
      if (res.ok) {
        toast.success(t('passwordChanged'));
        setChangePasswordOpen(false);
        setCpCurrentPwd('');
        setCpNewPwd('');
        setCpConfirmPwd('');
      } else {
        toast.error(data.error === 'Current password is incorrect' ? t('wrongCurrentPassword') : (data.error || t('error')));
      }
    } catch {
      toast.error(t('error'));
    } finally {
      setCpLoading(false);
    }
  };

  const navItems: SidebarNavItem[] = [
    { view: 'agency-dashboard', icon: LayoutDashboard, label: t('dashboard') },
    { view: 'agency-history', icon: History, label: t('history') },
    { view: 'agency-employees', icon: UserCog, label: t('employeeManagement') },
    { view: 'agency-branches', icon: GitBranch, label: t('branchesCounters') },
    { view: 'agency-devices', icon: Monitor, label: t('devicesConnection') },
    { view: 'agency-reviews', icon: Star, label: t('reviewsPage') },
    { view: 'agency-settings', icon: Settings, label: t('settings') },
    { view: 'agency-profile', icon: Building2, label: t('agencyProfile') },
    { view: 'agency-subscription', icon: CreditCard, label: t('subscription') },
  ];

  const sidebar = (
    <div className="flex flex-col h-full">
      {/* Gradient Header */}
      <div className="relative px-4 py-4 border-b border-border overflow-hidden">
        {/* Decorative gradient background */}
        <div className="absolute inset-0 bg-gradient-to-br from-emerald-50 via-teal-50 to-cyan-50 dark:from-emerald-950/40 dark:via-teal-950/30 dark:to-cyan-950/20" />
        <div className="absolute top-0 end-0 h-20 w-20 rounded-full bg-emerald-200/30 dark:bg-emerald-800/20 -translate-y-6 translate-x-6" />
        <div className="absolute bottom-0 start-0 h-16 w-16 rounded-full bg-teal-200/30 dark:bg-teal-800/20 translate-y-4 -translate-x-4" />

        <div className="relative flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="h-11 w-11 rounded-xl overflow-hidden shadow-lg shadow-emerald-500/10 ring-1 ring-emerald-200/50 dark:ring-emerald-800/30">
              <img src="/logo.png" alt="BLASTI" width={44} height={44} className="h-full w-full object-contain" />
            </div>
            <div>
              <span className="font-bold text-gradient text-sm">BLASTI</span>
              {user?.agencyName && (
                <p className="text-[10px] text-emerald-600 dark:text-emerald-400 font-medium truncate max-w-[120px]">{user.agencyName}</p>
              )}
            </div>
          </div>
          <Button variant="ghost" size="icon" className="lg:hidden h-8 w-8 relative" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-3 py-3 space-y-1 overflow-y-auto">
        {navItems.map((item, index) => {
          const active = currentView === item.view;
          const Icon = item.icon;
          // Group divider after dashboard + history
          const showDividerBefore = index === 2;
          return (
            <div key={item.view}>
              {showDividerBefore && <div className="my-2 mx-2 border-t border-border/50" />}
              <motion.button
                onClick={() => {
                  if (item.view === 'agency-history') {
                    setHistoryOpen(true);
                    onClose();
                    if (capabilities.canUseVibration) triggerHaptic();
                    return;
                  }
                  setView(item.view as Parameters<typeof setView>[0]);
                  onClose();
                  if (capabilities.canUseVibration) triggerHaptic();
                }}
                aria-current={active ? 'page' : undefined}
                whileHover={{ x: active ? 0 : 2 }}
                whileTap={{ scale: 0.98 }}
                className={`relative flex items-center gap-3 w-full px-3 py-2.5 rounded-xl text-sm font-medium transition-all duration-200 ${
                  active
                    ? 'bg-gradient-to-r from-emerald-100 to-teal-50 dark:from-emerald-900/30 dark:to-teal-900/20 text-emerald-700 dark:text-emerald-400 shadow-sm shadow-emerald-500/5'
                    : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
                }`}
              >
                {active && (
                  <motion.div
                    layoutId="agency-sidebar-active"
                    className="absolute start-0 top-1/2 -translate-y-1/2 h-6 w-1.5 rounded-r-full bg-gradient-to-b from-emerald-500 to-teal-500 shadow-sm shadow-emerald-500/30"
                    transition={{ type: 'spring', stiffness: 350, damping: 30 }}
                  />
                )}
                <div className={`flex items-center justify-center h-7 w-7 rounded-lg transition-colors ${
                  active
                    ? 'bg-emerald-200/60 dark:bg-emerald-800/30'
                    : 'bg-transparent'
                }`}>
                  <Icon className={`h-4 w-4 ${active ? 'text-emerald-600 dark:text-emerald-400' : ''}`} />
                </div>
                {item.label}
              </motion.button>
            </div>
          );
        })}
      </nav>

      {/* User Section */}
      <div className="mx-3 border-t border-border" />
      <div className="px-3 py-3 space-y-1">
        <div className="flex items-center gap-2.5 px-3 py-2.5 rounded-xl bg-muted/30">
          <div className="relative h-9 w-9 rounded-full bg-gradient-to-br from-emerald-100 to-teal-100 dark:from-emerald-900/40 dark:to-teal-900/30 flex items-center justify-center overflow-hidden ring-2 ring-emerald-200/50 dark:ring-emerald-800/30">
            {user?.avatarUrl ? (
              <img src={getProxiedUrl(user.avatarUrl)} alt={user.fullName} width={36} height={36} className="h-full w-full object-cover" />
            ) : (
              <span className="text-xs font-bold text-emerald-700 dark:text-emerald-400">
                {user?.fullName?.charAt(0)?.toUpperCase() || 'A'}
              </span>
            )}
            <div className="absolute -bottom-0.5 -end-0.5 h-2.5 w-2.5 rounded-full bg-emerald-500 ring-2 ring-white dark:ring-gray-950" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-foreground truncate">{user?.fullName}</p>
            <p className="text-[11px] text-muted-foreground truncate">{user?.role === 'AGENCY_OWNER' ? t('agencyOwner') : t('agencyStaff')}</p>
          </div>
        </div>
        <button
          onClick={() => setChangePasswordOpen(true)}
          className="flex items-center gap-3 w-full px-3 py-2 rounded-xl text-sm text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
        >
          <KeyRound className="h-5 w-5" />
          {t('changePassword')}
        </button>
        <button
          onClick={() => { logout(); onClose(); }}
          className="flex items-center gap-3 w-full px-3 py-2 rounded-xl text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/10 transition-colors"
        >
          <LogOut className="h-5 w-5" />
          {t('logout')}
        </button>
      </div>
      <Dialog open={changePasswordOpen} onOpenChange={(o) => { setChangePasswordOpen(o); if (!o) { setCpCurrentPwd(''); setCpNewPwd(''); setCpConfirmPwd(''); } }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <KeyRound className="h-5 w-5 text-emerald-500" />
              {t('changePassword')}
            </DialogTitle>
            <DialogDescription>{t('changePassword')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label>{t('currentPassword')}</Label>
              <Input type="password" value={cpCurrentPwd} onChange={(e) => setCpCurrentPwd(e.target.value)} placeholder={t('currentPassword')} className="h-11" />
            </div>
            <div className="space-y-2">
              <Label>{t('newPassword')}</Label>
              <Input type="password" value={cpNewPwd} onChange={(e) => setCpNewPwd(e.target.value)} placeholder={t('newPassword')} className="h-11" />
            </div>
            <div className="space-y-2">
              <Label>{t('confirmNewPassword')}</Label>
              <Input type="password" value={cpConfirmPwd} onChange={(e) => setCpConfirmPwd(e.target.value)} placeholder={t('confirmNewPassword')} className="h-11" onKeyDown={(e) => { if (e.key === 'Enter') handleChangePassword(); }} />
            </div>
          </div>
          <div className="flex gap-2 justify-end">
            <Button variant="outline" onClick={() => setChangePasswordOpen(false)}>{t('cancel')}</Button>
            <Button className="bg-emerald-600 hover:bg-emerald-700 text-white" onClick={handleChangePassword} disabled={cpLoading || !cpCurrentPwd || !cpNewPwd || !cpConfirmPwd}>
              {cpLoading ? <Loader2 className="h-4 w-4 animate-spin me-1" /> : <KeyRound className="h-4 w-4 me-1" />}
              {t('changePassword')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );

  // ── Mobile (Capacitor): Hamburger menu with slide-out drawer ──
  if (platform.isMobile) {
    return (
      <>
        {/* Hamburger menu button in top bar */}
        {/* The actual Sheet-based drawer */}
        <Sheet open={open} onOpenChange={(isOpen) => { if (!isOpen) onClose(); }}>
          <SheetContent
            side={isRTL(user?.language ?? 'ar') ? 'right' : 'left'}
            className="w-72 p-0"
          >
            <SheetHeader className="sr-only">
              <SheetTitle>Navigation</SheetTitle>
            </SheetHeader>
            {sidebar}
          </SheetContent>
        </Sheet>

        {/* Bottom action bar for mobile */}
        <MobileBottomActionBar
          onMenuOpen={onClose} // toggleSidebar will handle opening
          onLogout={logout}
          t={t}
        />
        <AgencyHistorySheet open={historyOpen} onOpenChange={setHistoryOpen} />
      </>
    );
  }

  // ── Desktop (Electron) & Web: Full persistent sidebar ──
  return (
    <>
      {/* Mobile overlay */}
      <AnimatePresence>
        {open && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 z-40 bg-black/50 lg:hidden"
              onClick={onClose}
            />
            <motion.aside
              initial={{ x: isRTL(user?.language ?? 'ar') ? '100%' : '-100%' }}
              animate={{ x: 0 }}
              exit={{ x: isRTL(user?.language ?? 'ar') ? '100%' : '-100%' }}
              transition={{ type: 'spring', damping: 25, stiffness: 200 }}
              className="fixed inset-y-0 z-50 w-72 bg-white/90 dark:bg-gray-950/90 backdrop-blur-xl border-e border-border lg:hidden shadow-xl"
            >
              {sidebar}
            </motion.aside>
          </>
        )}
      </AnimatePresence>

      {/* Desktop sidebar */}
      <aside className="hidden lg:flex lg:flex-col lg:w-64 lg:fixed lg:inset-y-0 bg-white/90 dark:bg-gray-950/90 backdrop-blur-xl border-e border-border">
        {sidebar}
      </aside>
      <AgencyHistorySheet open={historyOpen} onOpenChange={setHistoryOpen} />
    </>
  );
}

// ─── Admin Sidebar Nav Group (collapsible) ────────────────────────────────────

function AdminNavGroupItem({
  item,
  currentView,
  onNavigate,
  rtl,
}: {
  item: SidebarNavItem;
  currentView: string;
  onNavigate: (view: string) => void;
  rtl: boolean;
}) {
  const isChildActive = item.children?.some((c) => c.view === currentView) ?? false;
  const [open, setOpen] = useState(isChildActive);
  const Icon = item.icon;
  const ChevronClosed = rtl ? ChevronLeft : ChevronRight;

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <motion.button
          type="button"
          aria-expanded={open}
          whileHover={{ x: 2 }}
          whileTap={{ scale: 0.98 }}
          className={`relative flex items-center gap-3 w-full px-3 py-2.5 rounded-xl text-sm font-semibold transition-all duration-200 ${
            isChildActive
              ? 'bg-amber-50/80 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400'
              : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
          }`}
        >
          <div
            className={`flex items-center justify-center h-7 w-7 rounded-lg transition-colors ${
              isChildActive ? 'bg-amber-200/60 dark:bg-amber-800/30' : 'bg-transparent'
            }`}
          >
            <Icon className={`h-4 w-4 ${isChildActive ? 'text-amber-600 dark:text-amber-400' : ''}`} />
          </div>
          <span className="flex-1 text-start">{item.label}</span>
          <motion.span
            animate={{ rotate: open ? (rtl ? -90 : 90) : 0 }}
            transition={{ duration: 0.2 }}
            className={`flex items-center justify-center h-5 w-5 ${
              isChildActive ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground'
            }`}
          >
            <ChevronClosed className="h-4 w-4" />
          </motion.span>
        </motion.button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-1 space-y-1">
          {item.children?.map((child) => {
            const childActive = currentView === child.view;
            const ChildIcon = child.icon;
            return (
              <motion.button
                key={child.view}
                type="button"
                onClick={() => onNavigate(child.view)}
                aria-current={childActive ? 'page' : undefined}
                whileHover={{ x: childActive ? 0 : 2 }}
                whileTap={{ scale: 0.98 }}
                className={`relative flex items-center gap-3 w-full ps-8 pe-3 py-2 rounded-xl text-[13px] font-medium transition-all duration-200 ${
                  childActive
                    ? 'bg-gradient-to-r from-amber-100 to-orange-50 dark:from-amber-900/30 dark:to-orange-900/20 text-amber-700 dark:text-amber-400 shadow-sm shadow-amber-500/5'
                    : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
                }`}
              >
                {childActive && (
                  <motion.div
                    layoutId="admin-sidebar-active"
                    className="absolute start-0 top-1/2 -translate-y-1/2 h-5 w-1.5 rounded-r-full bg-gradient-to-b from-amber-500 to-orange-500 shadow-sm shadow-amber-500/30"
                    transition={{ type: 'spring', stiffness: 350, damping: 30 }}
                  />
                )}
                <div
                  className={`flex items-center justify-center h-6 w-6 rounded-lg transition-colors ${
                    childActive ? 'bg-amber-200/60 dark:bg-amber-800/30' : 'bg-transparent'
                  }`}
                >
                  <ChildIcon className={`h-3.5 w-3.5 ${childActive ? 'text-amber-600 dark:text-amber-400' : ''}`} />
                </div>
                {child.label}
              </motion.button>
            );
          })}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

// ─── Admin Sidebar ────────────────────────────────────────────────────────────

export function AdaptiveAdminSidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { currentView, setView, logout, user } = useAppStore();
  const { t } = useLanguage();
  const { platform, capabilities } = usePlatform();

  const navItems: SidebarNavItem[] = [
    { view: 'admin-dashboard', icon: LayoutDashboard, label: t('dashboard') },
    { view: 'admin-settings', icon: Settings, label: t('platformSettings') },
    { view: 'admin-app-settings', icon: Smartphone, label: t('publicAppsSettings') },
    { view: 'admin-analytics', icon: BarChart3, label: t('analytics') },
    { view: 'admin-agencies', icon: Building2, label: t('agencies') },
    { view: 'admin-audit', icon: ClipboardList, label: t('auditLogsPage') },
    { view: 'admin-users', icon: Users, label: t('userManagement') },
    {
      view: '__sales_ops_group__',
      icon: Briefcase,
      label: t('managingSalesOps'),
      children: [
        { view: 'admin-transactions', icon: CreditCard, label: t('transactions') },
        { view: 'admin-subscription-plans', icon: Crown, label: t('subscriptionPlans') },
        { view: 'admin-hardware', icon: Cpu, label: t('hardwareManagement') },
        { view: 'admin-hardware-requests', icon: Package, label: t('hardwareRequests') },
        { view: 'admin-enterprise-requests', icon: MailCheck, label: t('enterpriseContracts') },
      ],
    },
  ];

  const sidebar = (
    <div className="flex flex-col h-full">
      {/* Gradient Header */}
      <div className="relative px-4 py-4 border-b border-border overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-br from-amber-50 via-orange-50 to-amber-50 dark:from-amber-950/30 dark:via-orange-950/20 dark:to-amber-950/30" />
        <div className="absolute top-0 end-0 h-20 w-20 rounded-full bg-amber-200/30 dark:bg-amber-800/20 -translate-y-6 translate-x-6" />
        <div className="relative flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="h-11 w-11 rounded-xl overflow-hidden shadow-lg shadow-amber-500/10 ring-1 ring-amber-200/50 dark:ring-amber-800/30">
              <img src="/logo.png" alt="BLASTI" width={44} height={44} className="h-full w-full object-contain" />
            </div>
            <div>
              <span className="font-bold text-gradient text-sm">BLASTI</span>
              <p className="text-[10px] text-amber-600 dark:text-amber-400 font-medium">Admin Panel</p>
            </div>
          </div>
          <Button variant="ghost" size="icon" className="lg:hidden h-8 w-8 relative" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>
      <nav className="flex-1 px-3 py-3 space-y-1 overflow-y-auto">
        {navItems.map((item) => {
          const isGroup = item.view === '__sales_ops_group__';
          if (item.children) {
            return (
              <div key={item.view}>
                {isGroup && <div className="my-2 mx-2 border-t border-border/50" />}
                <AdminNavGroupItem
                  item={item}
                  currentView={currentView}
                  rtl={isRTL(user?.language ?? 'ar')}
                  onNavigate={(v) => {
                    setView(v as Parameters<typeof setView>[0]);
                    onClose();
                    if (capabilities.canUseVibration) triggerHaptic();
                  }}
                />
              </div>
            );
          }
          const active = currentView === item.view;
          const Icon = item.icon;
          return (
            <div key={item.view}>
              <motion.button
                onClick={() => {
                  setView(item.view as Parameters<typeof setView>[0]);
                  onClose();
                  if (capabilities.canUseVibration) triggerHaptic();
                }}
                aria-current={active ? 'page' : undefined}
                whileHover={{ x: active ? 0 : 2 }}
                whileTap={{ scale: 0.98 }}
                className={`relative flex items-center gap-3 w-full px-3 py-2.5 rounded-xl text-sm font-medium transition-all duration-200 ${
                  active
                    ? 'bg-gradient-to-r from-amber-100 to-orange-50 dark:from-amber-900/30 dark:to-orange-900/20 text-amber-700 dark:text-amber-400 shadow-sm shadow-amber-500/5'
                    : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
                }`}
              >
                {active && (
                  <motion.div
                    layoutId="admin-sidebar-active"
                    className="absolute start-0 top-1/2 -translate-y-1/2 h-6 w-1.5 rounded-r-full bg-gradient-to-b from-amber-500 to-orange-500 shadow-sm shadow-amber-500/30"
                    transition={{ type: 'spring', stiffness: 350, damping: 30 }}
                  />
                )}
                <div className={`flex items-center justify-center h-7 w-7 rounded-lg transition-colors ${
                  active
                    ? 'bg-amber-200/60 dark:bg-amber-800/30'
                    : 'bg-transparent'
                }`}>
                  <Icon className={`h-4 w-4 ${active ? 'text-amber-600 dark:text-amber-400' : ''}`} />
                </div>
                {item.label}
              </motion.button>
            </div>
          );
        })}
      </nav>
      <div className="mx-3 border-t border-border" />
      <div className="px-3 py-3 space-y-1">
        <div className="flex items-center gap-2.5 px-3 py-2.5 rounded-xl bg-muted/30">
          <div className="relative h-9 w-9 rounded-full bg-gradient-to-br from-amber-100 to-orange-100 dark:from-amber-900/40 dark:to-orange-900/30 flex items-center justify-center overflow-hidden ring-2 ring-amber-200/50 dark:ring-amber-800/30">
            {user?.avatarUrl ? (
              <img src={getProxiedUrl(user.avatarUrl)} alt={user.fullName} width={36} height={36} className="h-full w-full object-cover" />
            ) : (
              <ShieldCheck className="h-4 w-4 text-amber-700 dark:text-amber-400" />
            )}
            <div className="absolute -bottom-0.5 -end-0.5 h-2.5 w-2.5 rounded-full bg-emerald-500 ring-2 ring-white dark:ring-gray-950" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-foreground truncate">{user?.fullName}</p>
            <p className="text-[11px] text-muted-foreground truncate">{t('superAdmin')}</p>
          </div>
        </div>
        <button
          onClick={() => { logout(); onClose(); }}
          className="flex items-center gap-3 w-full px-3 py-2 rounded-xl text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/10 transition-colors"
        >
          <LogOut className="h-5 w-5" />
          {t('logout')}
        </button>
      </div>
    </div>
  );

  // ── Mobile (Capacitor): Hamburger menu with slide-out drawer ──
  if (platform.isMobile) {
    return (
      <>
        <Sheet open={open} onOpenChange={(isOpen) => { if (!isOpen) onClose(); }}>
          <SheetContent
            side={isRTL(user?.language ?? 'ar') ? 'right' : 'left'}
            className="w-72 p-0"
          >
            <SheetHeader className="sr-only">
              <SheetTitle>Navigation</SheetTitle>
            </SheetHeader>
            {sidebar}
          </SheetContent>
        </Sheet>
        <MobileBottomActionBar
          onMenuOpen={onClose}
          onLogout={logout}
          t={t}
        />
      </>
    );
  }

  // ── Desktop (Electron) & Web: Full persistent sidebar ──
  return (
    <>
      <AnimatePresence>
        {open && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 z-40 bg-black/50 lg:hidden"
              onClick={onClose}
            />
            <motion.aside
              initial={{ x: isRTL(user?.language ?? 'ar') ? '100%' : '-100%' }}
              animate={{ x: 0 }}
              exit={{ x: isRTL(user?.language ?? 'ar') ? '100%' : '-100%' }}
              transition={{ type: 'spring', damping: 25, stiffness: 200 }}
              className="fixed inset-y-0 z-50 w-72 bg-white/90 dark:bg-gray-950/90 backdrop-blur-xl border-e border-border lg:hidden shadow-xl"
            >
              {sidebar}
            </motion.aside>
          </>
        )}
      </AnimatePresence>
      <aside className="hidden lg:flex lg:flex-col lg:w-64 lg:fixed lg:inset-y-0 bg-white/90 dark:bg-gray-950/90 backdrop-blur-xl border-e border-border">
        {sidebar}
      </aside>
    </>
  );
}
