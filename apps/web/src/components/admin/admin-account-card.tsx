'use client';

/**
 * 0.6.50 — Admin account self-service card (Platform Settings → Security).
 * 0.6.51 — ROUTES SECURED: both changes moved to the ADMIN-SCOPED endpoints
 * (PATCH /api/admin/account/username + /api/admin/account/password):
 *   • requireAdmin — SUPER_ADMIN sessions only + the admin-API platform gate.
 *   • Strict 5-per-15-min rate limit in a dedicated bucket.
 *   • Current password re-proved on every change (server-side too).
 *   • Every success is audit-logged (ADMIN_USERNAME_CHANGED records old→new;
 *     passwords never land in the audit trail).
 *   • Admin password policy: 8+ chars with letter + digit (enforced here AND
 *     on the server) — stronger than the customer 6-char minimum.
 *
 * Change password show/hide toggles, error mapping (401 → wrongCurrentPassword,
 * 409 → username taken, 429 → rate limit) and ar/en/fr strings unchanged.
 */

import { useState } from 'react';
import { useAppStore } from '@/store/use-app-store';
import { useLanguage } from '@/hooks/use-language';
import { apiFetch } from '@/lib/api-fetch';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Badge } from '@/components/ui/badge';
import { Eye, EyeOff, KeyRound, Loader2, UserCog } from 'lucide-react';

type ApiResult = { success?: boolean; error?: string; username?: string };

export function AdminAccountCard() {
  const { t } = useLanguage();
  const user = useAppStore((s) => s.user);
  const setUser = useAppStore((s) => s.setUser);

  // ── Username form ──
  const [newUsername, setNewUsername] = useState('');
  const [usernamePassword, setUsernamePassword] = useState('');
  const [showUsernamePassword, setShowUsernamePassword] = useState(false);
  const [savingUsername, setSavingUsername] = useState(false);

  // ── Password form ──
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showCurrent, setShowCurrent] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [savingPassword, setSavingPassword] = useState(false);

  /** Maps a failed response to a localized toast message. */
  const errorToast = (status: number, data: ApiResult | null, fallback: Parameters<typeof toast.error>[0]) => {
    if (status === 401) {
      toast.error(t('wrongCurrentPassword'));
    } else if (status === 409) {
      toast.error(t('adminAccountUsernameTaken'));
    } else if (status === 429) {
      toast.error(t('adminAccountRateLimited'), { description: data?.error });
    } else {
      toast.error(fallback, { description: data?.error });
    }
  };

  const submitUsername = async (e: React.FormEvent) => {
    e.preventDefault();
    const next = newUsername.trim();
    if (!user) return;
    if (next.length < 3) {
      toast.error(t('adminAccountUsernameTooShort'));
      return;
    }
    if (next === user.username) {
      toast.error(t('adminAccountNoChange'));
      return;
    }
    if (!usernamePassword) {
      toast.error(t('wrongCurrentPassword'));
      return;
    }

    setSavingUsername(true);
    try {
      const res = await apiFetch('/api/admin/account/username', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword: usernamePassword, newUsername: next }),
      });
      const data = (await res.json().catch(() => null)) as ApiResult | null;
      if (res.ok && data?.success) {
        // Patch the in-memory session user — sidebar/profile reflect the new
        // username immediately; the persisted session is updated by setUser.
        setUser({ ...user, username: next });
        toast.success(t('adminAccountUsernameUpdated'));
        setNewUsername('');
        setUsernamePassword('');
      } else {
        errorToast(res.status, data, t('adminAccountFailed'));
      }
    } catch {
      toast.error(t('adminAccountFailed'));
    } finally {
      setSavingUsername(false);
    }
  };

  const submitPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    // 0.6.51 — admin policy (mirrors the server schema): 8+ chars, letter + digit.
    if (newPassword.length < 8 || !/[A-Za-z]/.test(newPassword) || !/\d/.test(newPassword)) {
      toast.error(t('adminAccountPasswordWeak'));
      return;
    }
    if (newPassword !== confirmPassword) {
      toast.error(t('passwordMismatch'));
      return;
    }

    setSavingPassword(true);
    try {
      const res = await apiFetch('/api/admin/account/password', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const data = (await res.json().catch(() => null)) as ApiResult | null;
      if (res.ok && data?.success) {
        toast.success(t('adminAccountPasswordUpdated'));
        setCurrentPassword('');
        setNewPassword('');
        setConfirmPassword('');
      } else {
        errorToast(res.status, data, t('adminAccountFailed'));
      }
    } catch {
      toast.error(t('adminAccountFailed'));
    } finally {
      setSavingPassword(false);
    }
  };

  if (!user) return null;

  return (
    <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80 dark:border-gray-800/50">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <UserCog className="h-4 w-4 text-emerald-600" />
          {t('adminAccountTitle')}
        </CardTitle>
        <CardDescription className="text-xs">{t('adminAccountDesc')}</CardDescription>
      </CardHeader>
      <CardContent className="pt-0 space-y-4">
        {/* ── Change username ── */}
        <form onSubmit={submitUsername} className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <Label className="text-xs text-muted-foreground">{t('adminAccountCurrentUsername')}</Label>
            <Badge variant="secondary" className="font-mono text-[11px] max-w-[60%] truncate" dir="ltr" title={user.username}>
              {user.username}
            </Badge>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="admin-new-username" className="text-xs">{t('adminAccountNewUsername')}</Label>
              <Input
                id="admin-new-username"
                value={newUsername}
                onChange={(e) => setNewUsername(e.target.value)}
                placeholder={t('adminAccountUsernameHint')}
                autoComplete="username"
                dir="ltr"
                className="h-9 text-sm"
                disabled={savingUsername}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="admin-username-password" className="text-xs">{t('adminAccountCurrentPassword')}</Label>
              <div className="relative">
                <Input
                  id="admin-username-password"
                  type={showUsernamePassword ? 'text' : 'password'}
                  value={usernamePassword}
                  onChange={(e) => setUsernamePassword(e.target.value)}
                  autoComplete="current-password"
                  dir="ltr"
                  className="h-9 text-sm pe-9"
                  disabled={savingUsername}
                />
                <button
                  type="button"
                  onClick={() => setShowUsernamePassword((v) => !v)}
                  className="absolute end-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  aria-label={showUsernamePassword ? t('hidePassword') : t('showPassword')}
                  tabIndex={-1}
                >
                  {showUsernamePassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>
          </div>
          <Button type="submit" size="sm" className="h-9" disabled={savingUsername}>
            {savingUsername ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserCog className="h-4 w-4" />}
            {savingUsername ? t('adminAccountSaving') : t('adminAccountChangeUsername')}
          </Button>
        </form>

        <Separator />

        {/* ── Change password ── */}
        <form onSubmit={submitPassword} className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="admin-current-password" className="text-xs">{t('adminAccountCurrentPassword')}</Label>
              <div className="relative">
                <Input
                  id="admin-current-password"
                  type={showCurrent ? 'text' : 'password'}
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                  autoComplete="current-password"
                  dir="ltr"
                  className="h-9 text-sm pe-9"
                  disabled={savingPassword}
                />
                <button
                  type="button"
                  onClick={() => setShowCurrent((v) => !v)}
                  className="absolute end-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  aria-label={showCurrent ? t('hidePassword') : t('showPassword')}
                  tabIndex={-1}
                >
                  {showCurrent ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="admin-new-password" className="text-xs">{t('adminAccountNewPassword')}</Label>
              <div className="relative">
                <Input
                  id="admin-new-password"
                  type={showNew ? 'text' : 'password'}
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  autoComplete="new-password"
                  dir="ltr"
                  className="h-9 text-sm pe-9"
                  disabled={savingPassword}
                />
                <button
                  type="button"
                  onClick={() => setShowNew((v) => !v)}
                  className="absolute end-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  aria-label={showNew ? t('hidePassword') : t('showPassword')}
                  tabIndex={-1}
                >
                  {showNew ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="admin-confirm-password" className="text-xs">{t('adminAccountConfirmPassword')}</Label>
              <Input
                id="admin-confirm-password"
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                autoComplete="new-password"
                dir="ltr"
                className="h-9 text-sm"
                disabled={savingPassword}
              />
            </div>
          </div>
          <Button type="submit" size="sm" className="h-9" disabled={savingPassword}>
            {savingPassword ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
            {savingPassword ? t('adminAccountSaving') : t('adminAccountChangePassword')}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
