'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Server,
  Monitor,
  ArrowRight,
  ArrowLeft,
  CheckCircle2,
  AlertTriangle,
  Layers,
} from 'lucide-react';
import { useLanguage } from '@/hooks/use-language';
import { isRTL } from '@/i18n';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ConflictItem {
  id: string;
  model: string;
  recordId: string;
  serverData: Record<string, unknown>;
  localData: Record<string, unknown>;
  timestamp: string;
  resolved?: boolean;
  resolution?: 'server' | 'local';
}

interface ConflictResolutionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  conflicts: ConflictItem[];
  onResolve: (id: string, resolution: 'server' | 'local') => void;
  onResolveAll?: (resolution: 'server' | 'local') => void;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Format a JSON diff-like view of the differing fields */
function getDiffFields(
  server: Record<string, unknown>,
  local: Record<string, unknown>,
): { key: string; server: unknown; local: unknown }[] {
  const diffs: { key: string; server: unknown; local: unknown }[] = [];
  const allKeys = new Set([...Object.keys(server), ...Object.keys(local)]);

  // Skip internal/system fields
  const skipKeys = new Set([
    'id', 'createdAt', 'updatedAt', 'syncedAt', 'offlineCreatedAt',
    'syncDeviceId', 'syncConflict', 'importToken',
  ]);

  for (const key of allKeys) {
    if (skipKeys.has(key)) continue;
    const serverVal = server[key];
    const localVal = local[key];
    if (JSON.stringify(serverVal) !== JSON.stringify(localVal)) {
      diffs.push({ key, server: serverVal, local: localVal });
    }
  }

  return diffs;
}

/** Truncate long strings for display */
function truncate(val: unknown, maxLen = 60): string {
  const str = val === null || val === undefined ? '—' : String(val);
  return str.length > maxLen ? str.slice(0, maxLen) + '…' : str;
}

// ─── Component ──────────────────────────────────────────────────────────────

export function ConflictResolutionDialog({
  open,
  onOpenChange,
  conflicts,
  onResolve,
  onResolveAll,
}: ConflictResolutionDialogProps) {
  const { lang, t } = useLanguage();
  const rtl = isRTL(lang);
  const [resolvedIds, setResolvedIds] = useState<Set<string>>(new Set());

  // Reset resolved state when dialog opens
  useEffect(() => {
    if (open) setResolvedIds(new Set());
  }, [open]);

  const unresolvedConflicts = conflicts.filter((c) => !c.resolved && !resolvedIds.has(c.id));
  const resolvedCount = conflicts.length - unresolvedConflicts.length;

  const handleResolve = useCallback(
    (id: string, resolution: 'server' | 'local') => {
      setResolvedIds((prev) => new Set([...prev, id]));
      onResolve(id, resolution);
    },
    [onResolve],
  );

  const handleResolveAll = useCallback(
    (resolution: 'server' | 'local') => {
      for (const conflict of unresolvedConflicts) {
        setResolvedIds((prev) => new Set([...prev, conflict.id]));
        onResolve(conflict.id, resolution);
      }
      onResolveAll?.(resolution);
    },
    [unresolvedConflicts, onResolve, onResolveAll],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh] flex flex-col" dir={rtl ? 'rtl' : 'ltr'}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-amber-500" />
            {t('syncConflictsTitle') || 'Sync Conflicts'}
            {unresolvedConflicts.length > 0 && (
              <Badge variant="destructive" className="ml-2">
                {unresolvedConflicts.length}
              </Badge>
            )}
          </DialogTitle>
          <DialogDescription>
            {t('syncConflictsDesc') || 'Some changes conflict with the server version. Choose which version to keep.'}
          </DialogDescription>
        </DialogHeader>

        {unresolvedConflicts.length > 0 && (
          <div className="flex items-center gap-2 mb-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => handleResolveAll('server')}
              className="gap-1"
            >
              <Server className="h-3.5 w-3.5" />
              {t('resolveAllServer') || 'Keep Server for All'}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => handleResolveAll('local')}
              className="gap-1"
            >
              <Monitor className="h-3.5 w-3.5" />
              {t('resolveAllLocal') || 'Keep Local for All'}
            </Button>
          </div>
        )}

        <ScrollArea className="flex-1 max-h-[50vh]">
          <AnimatePresence mode="popLayout">
            {conflicts.map((conflict) => {
              const isResolved = conflict.resolved || resolvedIds.has(conflict.id);
              const diffs = getDiffFields(conflict.serverData, conflict.localData);

              if (diffs.length === 0) return null;

              return (
                <motion.div
                  key={conflict.id}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: isResolved ? 0.5 : 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                  transition={{ duration: 0.2 }}
                  className="mb-3 rounded-lg border bg-card"
                >
                  <div className="flex items-center justify-between px-4 py-2 bg-muted/50 rounded-t-lg">
                    <div className="flex items-center gap-2 text-sm font-medium">
                      <Layers className="h-4 w-4 text-muted-foreground" />
                      <span>{conflict.model}</span>
                      <span className="text-muted-foreground font-mono text-xs">
                        {conflict.recordId.slice(0, 8)}…
                      </span>
                    </div>
                    {isResolved && (
                      <Badge variant="secondary" className="gap-1 text-xs">
                        <CheckCircle2 className="h-3 w-3" />
                        {conflict.resolution === 'server'
                          ? (t('serverVersion') || 'Server')
                          : (t('localVersion') || 'Local')}
                      </Badge>
                    )}
                  </div>

                  <div className="p-4 space-y-2">
                    {diffs.map((diff) => (
                      <div key={diff.key} className="grid grid-cols-[1fr,auto,1fr] gap-2 items-center text-sm">
                        <div
                          className={`rounded px-2 py-1.5 ${isResolved ? (conflict.resolution === 'server' ? 'bg-primary/10 border border-primary/20' : 'bg-muted/50') : 'bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-800'}`}
                        >
                          <div className="text-xs text-muted-foreground mb-0.5 flex items-center gap-1">
                            {isResolved && conflict.resolution === 'server' && <CheckCircle2 className="h-3 w-3 text-primary" />}
                            <Server className="h-3 w-3" />
                            {t('server') || 'Server'}
                          </div>
                          <div className="font-mono text-xs break-all">
                            <span className="text-muted-foreground">{diff.key}: </span>
                            {truncate(diff.server)}
                          </div>
                        </div>

                        <div className="flex items-center justify-center">
                          {isRTL ? (
                            <ArrowRight className="h-4 w-4 text-muted-foreground" />
                          ) : (
                            <ArrowLeft className="h-4 w-4 text-muted-foreground" />
                          )}
                        </div>

                        <div
                          className={`rounded px-2 py-1.5 ${isResolved ? (conflict.resolution === 'local' ? 'bg-primary/10 border border-primary/20' : 'bg-muted/50') : 'bg-emerald-50 dark:bg-emerald-950/20 border border-emerald-200 dark:border-emerald-800'}`}
                        >
                          <div className="text-xs text-muted-foreground mb-0.5 flex items-center gap-1">
                            {isResolved && conflict.resolution === 'local' && <CheckCircle2 className="h-3 w-3 text-primary" />}
                            <Monitor className="h-3 w-3" />
                            {t('local') || 'Local'}
                          </div>
                          <div className="font-mono text-xs break-all">
                            <span className="text-muted-foreground">{diff.key}: </span>
                            {truncate(diff.local)}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>

                  {!isResolved && (
                    <div className="flex items-center justify-end gap-2 px-4 py-2 border-t bg-muted/30 rounded-b-lg">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleResolve(conflict.id, 'server')}
                        className="gap-1"
                      >
                        <Server className="h-3.5 w-3.5" />
                        {t('keepServer') || 'Keep Server'}
                      </Button>
                      <Button
                        size="sm"
                        onClick={() => handleResolve(conflict.id, 'local')}
                        className="gap-1"
                      >
                        <Monitor className="h-3.5 w-3.5" />
                        {t('keepLocal') || 'Keep Local'}
                      </Button>
                    </div>
                  )}
                </motion.div>
              );
            })}
          </AnimatePresence>

          {conflicts.length === 0 && (
            <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
              <CheckCircle2 className="h-12 w-12 mb-3 text-emerald-500" />
              <p className="text-sm font-medium">{t('noConflicts') || 'No conflicts to resolve'}</p>
            </div>
          )}
        </ScrollArea>

        {resolvedCount > 0 && (
          <>
            <Separator />
            <DialogFooter>
              <p className="text-xs text-muted-foreground">
                {resolvedCount} {resolvedCount === 1 ? 'conflict' : 'conflicts'} {t('resolved') || 'resolved'}
              </p>
              <Button variant="default" onClick={() => onOpenChange(false)}>
                {t('done') || 'Done'}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
