'use client';

/**
 * Account verification card (SHARED — customer + agency settings pages).
 *
 * Self-service contact verification (strict-rule companion): shows the
 * account's email and phone with live verified chips and lets the user
 * verify either one with an OTP — no matter the platform verification mode
 * — so password-reset and auth-critical delivery always has an eligible
 * (verified) channel.
 *
 * Endpoints (session-authenticated):
 *   POST /api/auth/account/verification/issue   { channel: 'email'|'phone' }
 *   POST /api/auth/account/verification/confirm { channel, code }
 *   GET  /api/user/profile → { email, phoneNumber, emailVerified, phoneVerified }
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/lib/api-fetch';
import { useLanguage } from '@/hooks/use-language';
import { useAppStore } from '@/store/use-app-store';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import {
  ShieldCheck, Mail, Smartphone, CheckCircle2, AlertCircle,
  Loader2, RefreshCw, BadgeCheck, Clock,
} from 'lucide-react';
import { toast } from 'sonner';
import { motion } from 'framer-motion';

type Channel = 'email' | 'phone';

interface ProfileFlags {
  email: string | null;
  phoneNumber: string | null;
  emailVerified: boolean;
  phoneVerified: boolean;
}

/** 8-digit codes for email, 6-digit for SMS/WhatsApp (matches the backend). */
const codeLength = (channel: Channel) => (channel === 'email' ? 8 : 6);

export function AccountVerificationCard() {
  const { lang } = useLanguage();
  const user = useAppStore((s) => s.user);
  const [flags, setFlags] = useState<ProfileFlags | null>(null);
  const [loading, setLoading] = useState(true);

  // Per-channel verification session state
  const [active, setActive] = useState<Channel | null>(null);
  const [code, setCode] = useState('');
  const [issuing, setIssuing] = useState<Channel | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [cooldown, setCooldown] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);
  const [devCode, setDevCode] = useState<string | null>(null);
  const cooldownRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const L = {
    title: lang === 'ar' ? 'التحقق من جهات الاتصال' : 'Contact verification',
    subtitle: lang === 'ar'
      ? 'جهات الاتصال المُتحقق منها فقط تُستخدم لاستعادة كلمة المرور والإشعارات المهمة.'
      : 'Only VERIFIED contacts receive password-reset codes and critical notifications.',
    email: lang === 'ar' ? 'البريد الإلكتروني' : 'Email',
    phone: lang === 'ar' ? 'رقم الهاتف' : 'Phone number',
    verified: lang === 'ar' ? 'مُتحقق' : 'Verified',
    notVerified: lang === 'ar' ? 'غير مُتحقق' : 'Not verified',
    noContact: lang === 'ar' ? 'غير مُضاف' : 'Not set',
    verify: lang === 'ar' ? 'تحقق الآن' : 'Verify now',
    sending: lang === 'ar' ? 'جارٍ الإرسال…' : 'Sending…',
    codeSentTo: lang === 'ar' ? 'أُرسل رمز التحقق إلى' : 'Code sent to',
    codePlaceholder: lang === 'ar' ? 'أدخل الرمز' : 'Enter the code',
    confirm: lang === 'ar' ? 'تأكيد' : 'Confirm',
    verifying: lang === 'ar' ? 'جارٍ التحقق…' : 'Verifying…',
    resend: lang === 'ar' ? 'إعادة الإرسال' : 'Resend',
    resendIn: (s: number) => (lang === 'ar' ? `إعادة الإرسال بعد ${s}ث` : `Resend in ${s}s`),
    cancel: lang === 'ar' ? 'إلغاء' : 'Cancel',
    sentOk: lang === 'ar' ? 'تم إرسال رمز التحقق' : 'Verification code sent',
    verifiedOk: (what: string) => (lang === 'ar' ? `تم تأكيد ${what} بنجاح` : `${what} verified successfully`),
    failed: lang === 'ar' ? 'تعذر إكمال العملية' : 'Operation failed',
  };

  const loadProfile = useCallback(async () => {
    try {
      const res = await apiFetch(`/api/user/profile${user?.id ? `?userId=${user.id}` : ''}`);
      const json = await res.json().catch(() => ({}));
      if (res.ok && json?.success) {
        setFlags({
          email: json.email ?? null,
          phoneNumber: json.phoneNumber ?? null,
          emailVerified: Boolean(json.emailVerified),
          phoneVerified: Boolean(json.phoneVerified),
        });
      }
    } catch { /* keep previous */ }
    finally { setLoading(false); }
  }, [user?.id]);

  useEffect(() => { loadProfile(); }, [loadProfile]);

  useEffect(() => () => { if (cooldownRef.current) clearInterval(cooldownRef.current); }, []);

  const startCooldown = (seconds: number) => {
    if (cooldownRef.current) clearInterval(cooldownRef.current);
    setCooldown(seconds);
    cooldownRef.current = setInterval(() => {
      setCooldown((s) => {
        if (s <= 1 && cooldownRef.current) clearInterval(cooldownRef.current);
        return Math.max(0, s - 1);
      });
    }, 1000);
  };

  const issue = async (channel: Channel) => {
    setIssuing(channel);
    setError(null);
    setDevCode(null);
    try {
      const res = await apiFetch('/api/auth/account/verification/issue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel }),
      });
      const json = await res.json().catch(() => ({}));
      if (res.ok && json?.success) {
        setActive(channel);
        setCode('');
        toast.success(L.sentOk);
        if (json.retryAfterSeconds) startCooldown(json.retryAfterSeconds);
        if (json.devCode) setDevCode(json.devCode);
      } else if (json?.error === 'RESEND_COOLDOWN') {
        startCooldown(json.retryAfterSeconds || 60);
        setError(lang === 'ar' ? 'انتظر قليلاً قبل إعادة الإرسال' : 'Please wait before resending');
      } else if (json?.error === 'TOO_MANY_ATTEMPTS') {
        setError(lang === 'ar' ? 'محاولات كثيرة — حاول لاحقاً' : 'Too many attempts — try later');
      } else {
        setError(json?.error || L.failed);
      }
    } catch {
      setError(L.failed);
    } finally {
      setIssuing(null);
    }
  };

  const confirm = async () => {
    if (!active || code.trim().length < codeLength(active)) return;
    setConfirming(true);
    setError(null);
    try {
      const res = await apiFetch('/api/auth/account/verification/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel: active, code: code.trim() }),
      });
      const json = await res.json().catch(() => ({}));
      if (res.ok && json?.success) {
        toast.success(L.verifiedOk(active === 'email' ? L.email : L.phone));
        setActive(null);
        setCode('');
        await loadProfile();
      } else if (json?.error === 'INVALID_CODE') {
        setError(lang === 'ar' ? 'رمز غير صحيح' : 'Invalid code');
      } else if (json?.error === 'CODE_EXPIRED') {
        setError(lang === 'ar' ? 'انتهت صلاحية الرمز — أعد الإرسال' : 'Code expired — resend it');
      } else {
        setError(json?.error || L.failed);
      }
    } catch {
      setError(L.failed);
    } finally {
      setConfirming(false);
    }
  };

  const row = (channel: Channel, value: string | null, verified: boolean, Icon: typeof Mail) => (
    <div className="flex items-center gap-3 rounded-xl border border-border bg-muted/30 p-3">
      <div className="h-9 w-9 rounded-lg bg-gradient-to-br from-emerald-200 to-teal-300 dark:from-emerald-900/40 dark:to-teal-800/40 flex items-center justify-center shrink-0">
        <Icon className="h-4 w-4 text-emerald-700 dark:text-emerald-400" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-[11px] font-medium text-muted-foreground">{channel === 'email' ? L.email : L.phone}</p>
        <p className="text-sm font-semibold text-foreground truncate" dir="ltr">
          {value || <span className="text-muted-foreground font-normal">{L.noContact}</span>}
        </p>
      </div>
      {verified ? (
        <Badge className="bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400 gap-1 text-[10px] shrink-0">
          <BadgeCheck className="h-3 w-3" /> {L.verified}
        </Badge>
      ) : value ? (
        <Button
          size="sm"
          variant="outline"
          disabled={issuing !== null || confirming || cooldown > 0}
          onClick={() => issue(channel)}
          className="h-8 rounded-lg text-xs gap-1.5 border-emerald-200 dark:border-emerald-800 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-900/20 shrink-0"
        >
          {issuing === channel ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />}
          {issuing === channel ? L.sending : L.verify}
        </Button>
      ) : null}
    </div>
  );

  return (
    <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80 dark:border-gray-800/50">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-emerald-200 to-teal-300 dark:from-emerald-900/40 dark:to-teal-800/40 flex items-center justify-center shadow-sm">
            <ShieldCheck className="h-4 w-4 text-emerald-700 dark:text-emerald-400" />
          </div>
          {L.title}
        </CardTitle>
        <p className="text-xs text-muted-foreground mt-1">{L.subtitle}</p>
      </CardHeader>
      <CardContent className="pt-0 space-y-2.5">
        {loading && !flags ? (
          <>
            <Skeleton className="h-16 rounded-xl skeleton-shimmer" />
            <Skeleton className="h-16 rounded-xl skeleton-shimmer" />
          </>
        ) : (
          <>
            {row('email', flags?.email ?? null, Boolean(flags?.emailVerified), Mail)}
            {row('phone', flags?.phoneNumber ?? null, Boolean(flags?.phoneVerified), Smartphone)}

            {/* ── Inline OTP confirm flow ── */}
            {active && (
              <motion.div
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                className="rounded-xl border border-emerald-200 dark:border-emerald-900/40 bg-emerald-50/60 dark:bg-emerald-950/20 p-3 space-y-2.5"
              >
                <p className="text-xs font-semibold text-emerald-800 dark:text-emerald-300 flex items-center gap-1.5">
                  {active === 'email' ? <Mail className="h-3.5 w-3.5" /> : <Smartphone className="h-3.5 w-3.5" />}
                  {L.codeSentTo} <span dir="ltr" className="font-mono">{active === 'email' ? flags?.email : flags?.phoneNumber}</span>
                </p>
                <div className="flex items-center gap-2">
                  <Input
                    value={code}
                    onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, codeLength(active)))}
                    placeholder={L.codePlaceholder}
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    dir="ltr"
                    maxLength={codeLength(active)}
                    className="h-10 font-mono tracking-[0.3em] text-center"
                    onKeyDown={(e) => { if (e.key === 'Enter') confirm(); }}
                  />
                  <Button
                    size="sm"
                    onClick={confirm}
                    disabled={confirming || code.trim().length < codeLength(active)}
                    className="h-10 rounded-lg text-xs gap-1.5 shrink-0"
                  >
                    {confirming ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
                    {confirming ? L.verifying : L.confirm}
                  </Button>
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={cooldown > 0 || issuing !== null}
                    onClick={() => issue(active)}
                    className="h-7 px-2 text-[11px] text-muted-foreground gap-1"
                  >
                    {cooldown > 0 ? <><Clock className="h-3 w-3 opacity-60" /> {L.resendIn(cooldown)}</> : <><RefreshCw className="h-3 w-3" /> {L.resend}</>}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => { setActive(null); setCode(''); setError(null); }}
                    className="h-7 px-2 text-[11px] text-muted-foreground"
                  >
                    {L.cancel}
                  </Button>
                  {devCode && (
                    <Badge variant="outline" className="text-[10px] gap-1 border-violet-300 dark:border-violet-800 text-violet-700 dark:text-violet-300">
                      dev: <code className="font-mono font-bold" dir="ltr">{devCode}</code>
                    </Badge>
                  )}
                </div>
              </motion.div>
            )}

            {error && (
              <p className="text-xs text-red-600 dark:text-red-400 flex items-center gap-1.5">
                <AlertCircle className="h-3.5 w-3.5" /> {error}
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
