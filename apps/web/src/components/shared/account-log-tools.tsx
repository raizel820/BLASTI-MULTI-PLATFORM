'use client';

/**
 * Account identity + log tools (logs-1 / uid-0.6.14 follow-up).
 *
 * Two adjacent account-surface features every app shares (web console,
 * Capacitor mobile, Electron desktop — same web bundle):
 *
 * 1. AccountUidChip — the immutable account UID with a one-tap copy button.
 *    Mounted on the profile and settings pages. Copy uses the async
 *    Clipboard API with a textarea fallback (old Android WebViews).
 *
 * 2. ManualLogUpload — "upload logs now" button. The remote logger
 *    (lib/remote-logger.ts) auto-uploads every 30s while signed in, but the
 *    user asked for an explicit push path "just in case the log is not
 *    updating to the VPS in realtime": the button forces a flush with
 *    manual=true, which ALSO writes a standalone manual-<ts>.ndjson snapshot
 *    on the server. Shows pending-entry count + last successful upload.
 */

import { useEffect, useState } from 'react';
import { Check, Copy, Fingerprint, UploadCloud, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { useLanguage } from '@/hooks/use-language';
import {
  flushLogsNow,
  lastLogFlushAt,
  pendingLogCount,
} from '@/lib/remote-logger';

// ─── Copy helper (Clipboard API + legacy fallback) ───────────────────────────

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through to the legacy path */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', ''); // avoid the iOS keyboard jumping in
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus(); // old Android WebViews only honor execCommand on a focused node
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

// ─── UID chip ────────────────────────────────────────────────────────────────

export function AccountUidChip({
  uid,
  className = '',
  compact = false,
}: {
  uid?: string | null;
  className?: string;
  compact?: boolean;
}) {
  const { t } = useLanguage();
  const [copied, setCopied] = useState(false);

  if (!uid) return null;

  const handleCopy = async () => {
    const ok = await copyText(uid);
    if (ok) {
      setCopied(true);
      toast.success(t('uidCopied'), { description: uid });
      setTimeout(() => setCopied(false), 2000);
    } else {
      toast.error(t('copyFailed'));
    }
  };

  return (
    <div
      className={`inline-flex items-center gap-2 rounded-xl border border-border bg-muted/50 px-3 ${compact ? 'h-9' : 'h-11'} ${className}`}
      dir="ltr"
    >
      <Fingerprint className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400 flex-shrink-0" />
      <span className="font-mono text-sm font-semibold text-foreground tracking-wide select-all">
        {uid}
      </span>
      <button
        type="button"
        onClick={handleCopy}
        aria-label={t('copyUid')}
        title={t('copyUid')}
        className="ml-auto h-7 w-7 rounded-lg flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-background transition-colors"
      >
        {copied ? (
          <Check className="h-3.5 w-3.5 text-emerald-600" />
        ) : (
          <Copy className="h-3.5 w-3.5" />
        )}
      </button>
    </div>
  );
}

// ─── Manual log upload ───────────────────────────────────────────────────────

export function ManualLogUpload({ className = '' }: { className?: string }) {
  const { t } = useLanguage();
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState(0);
  const [lastAt, setLastAt] = useState<string | null>(null);

  useEffect(() => {
    const tick = () => {
      setPending(pendingLogCount());
      setLastAt(lastLogFlushAt());
    };
    tick();
    const id = setInterval(tick, 5_000);
    return () => clearInterval(id);
  }, []);

  const handleUpload = async () => {
    setBusy(true);
    try {
      const res = await flushLogsNow({ manual: true });
      if (res.ok) {
        toast.success(t('logsUploaded'), {
          description:
            res.accepted && res.accepted > 0
              ? `${res.accepted} ${t('logEntries')}`
              : t('logsAlreadySynced'),
        });
      } else if (res.error === 'too-soon') {
        toast.info(t('logsUploadSoon'));
      } else if (res.error === 'server-missing-logs-route') {
        // 0.6.17 — name the REAL cause instead of a bare "failed": the
        // deployed server predates the log vault. Field phones kept reading
        // "failed to upload logs: server missing logs route" with no idea
        // what to do; the hint now says the server needs the 0.6.16+ deploy
        // and that nothing is lost (entries stay buffered on-device).
        toast.error(t('logsServerMissingRoute'), {
          description: t('logsServerMissingRouteHint'),
          duration: 8000,
        });
      } else {
        toast.error(t('logsUploadFailed'), { description: res.error });
      }
    } finally {
      setPending(pendingLogCount());
      setLastAt(lastLogFlushAt());
      setBusy(false);
    }
  };

  const lastLabel = lastAt
    ? `${t('logsLastUpload')}: ${new Date(lastAt).toLocaleTimeString()}`
    : t('logsNeverUploaded');

  return (
    <div className={`space-y-1.5 ${className}`}>
      <Button
        type="button"
        variant="outline"
        onClick={handleUpload}
        disabled={busy}
        className="w-full h-11 justify-start gap-2.5"
      >
        {busy ? (
          <RefreshCw className="h-4 w-4 animate-spin text-emerald-600" />
        ) : (
          <UploadCloud className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
        )}
        <span className="font-medium">{t('uploadLogsNow')}</span>
        {pending > 0 && (
          <span className="ms-auto text-xs text-muted-foreground">
            {pending} {t('logEntriesPending')}
          </span>
        )}
      </Button>
      <p className="text-[11px] text-muted-foreground px-1">{lastLabel}</p>
    </div>
  );
}
