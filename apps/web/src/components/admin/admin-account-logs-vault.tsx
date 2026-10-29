'use client';

/**
 * AdminAccountLogsVault — the Storage Manager's Account Logs section (0.6.16).
 *
 * The per-UID log vault (logs-1) writes NDJSON files on the VPS disk, grouped
 * in ONE folder per account UID, with admin browse routes already served by
 * the API:
 *
 *   GET /api/logs            → { root, folders: [{ uid, files, bytes, lastAt }] }
 *   GET /api/logs/:uid       → { files: [{ file, bytes, modified }] }
 *   GET /api/logs/:uid/:file → raw NDJSON text
 *
 * This component surfaces them: folder list with search (grep-style UID
 * lookup), inline file listing per account, and a viewer for the raw NDJSON
 * (mono, wrapped, scrollable, capped — a day-file can be large) + download.
 *
 * Field report this answers: "the logs are not … showing in storage manager"
 * — the vault existed on disk/API but had NO UI anywhere.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Download,
  Fingerprint,
  Loader2,
  RefreshCw,
  ScrollText,
  Search,
} from 'lucide-react';
import { apiFetch } from '@/lib/api-fetch';
import { useLanguage } from '@/hooks/use-language';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

interface LogFolderRow {
  uid: string;
  files: number;
  bytes: number;
  lastAt: string | null;
  /** 0.6.19 — platform-separated streams present in this account folder. */
  platforms: string[];
}

interface LogFileRow {
  file: string;
  bytes: number;
  modified: string;
}

/** One platform stream (web/mobile/desktop) or the legacy flat layout. */
interface LogStreamRow {
  platform: string;
  files: LogFileRow[];
}

function humanSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/** Viewer body is capped so a huge day-file can't freeze the dialog (the
 * download button carries the full content). 50K chars ≈ hundreds of log
 * lines — plenty for support triage, and light enough for phone WebViews. */
const VIEWER_MAX_CHARS = 50_000;

export function AdminAccountLogsVault() {
  const { t } = useLanguage();

  const [folders, setFolders] = useState<LogFolderRow[] | null>(null);
  const [root, setRoot] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');

  // Expanded account → its file list (0.6.19: per-platform streams + legacy)
  const [openUid, setOpenUid] = useState<string | null>(null);
  const [streams, setStreams] = useState<LogStreamRow[] | null>(null);
  const [legacyFiles, setLegacyFiles] = useState<LogFileRow[] | null>(null);
  const [filesLoading, setFilesLoading] = useState(false);

  // Raw NDJSON viewer
  const [viewer, setViewer] = useState<{ uid: string; platform: string; file: string; content: string; truncated: boolean } | null>(null);
  const [viewerLoading, setViewerLoading] = useState(false);

  const fetchFolders = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch('/api/logs');
      const body = await res.json().catch(() => null);
      if (res.ok && body && Array.isArray(body.folders)) {
        setFolders(body.folders as LogFolderRow[]);
        setRoot(typeof body.root === 'string' ? body.root : null);
      } else {
        setFolders([]);
        setRoot(null);
      }
    } catch {
      setFolders([]);
      setRoot(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchFolders();
  }, [fetchFolders]);

  const toggleFolder = async (uid: string) => {
    if (openUid === uid) {
      setOpenUid(null);
      setStreams(null);
      setLegacyFiles(null);
      return;
    }
    setOpenUid(uid);
    setStreams(null);
    setLegacyFiles(null);
    setFilesLoading(true);
    try {
      const res = await apiFetch(`/api/logs/${encodeURIComponent(uid)}`);
      const body = await res.json().catch(() => null);
      if (res.ok && body) {
        // 0.6.19 shape: { streams: [{ platform, files }], legacyFiles: [...] }
        setStreams(Array.isArray(body.streams) ? (body.streams as LogStreamRow[]) : []);
        setLegacyFiles(Array.isArray(body.legacyFiles) ? (body.legacyFiles as LogFileRow[]) : []);
      } else {
        setStreams([]);
        setLegacyFiles([]);
      }
    } catch {
      setStreams([]);
      setLegacyFiles([]);
    } finally {
      setFilesLoading(false);
    }
  };

  const openFile = async (uid: string, platform: string, file: string) => {
    setViewerLoading(true);
    setViewer(null);
    try {
      // 0.6.19 platform streams use the 3-segment route; legacy files the 2-segment one.
      const url = platform && platform !== 'legacy'
        ? `/api/logs/${encodeURIComponent(uid)}/${encodeURIComponent(platform)}/${encodeURIComponent(file)}`
        : `/api/logs/${encodeURIComponent(uid)}/${encodeURIComponent(file)}`;
      const res = await apiFetch(url);
      const text = await res.text();
      if (!res.ok) return;
      const truncated = text.length > VIEWER_MAX_CHARS;
      setViewer({ uid, platform, file, content: truncated ? text.slice(0, VIEWER_MAX_CHARS) : text, truncated });
    } catch {
      /* the dialog simply stays closed */
    } finally {
      setViewerLoading(false);
    }
  };

  const downloadFile = (uid: string, file: string, content: string) => {
    try {
      const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${uid}-${file}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch {
      /* non-fatal */
    }
  };

  const filtered = (folders ?? []).filter(
    (f) => !search.trim() || f.uid.toLowerCase().includes(search.trim().toLowerCase()),
  );

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2 flex-wrap">
          <div className="h-9 w-9 rounded-lg bg-gradient-to-br from-violet-100 to-fuchsia-100 dark:from-violet-900/40 dark:to-fuchsia-900/30 flex items-center justify-center shrink-0">
            <ScrollText className="h-5 w-5 text-violet-600 dark:text-violet-400" />
          </div>
          <div className="flex-1 min-w-0">
            <CardTitle className="text-base">{t('logsVaultTitle')}</CardTitle>
            <CardDescription className="truncate">{t('logsVaultDesc')}</CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={fetchFolders} disabled={loading} className="shrink-0">
            {loading ? <Loader2 className="h-4 w-4 animate-spin me-1" /> : <RefreshCw className="h-4 w-4 me-1" />}
            {t('storageRefresh')}
          </Button>
        </div>
        {root && (
          <CardDescription className="font-mono text-[11px] truncate" dir="ltr" title={root}>
            {t('logsVaultRoot')}: {root}
          </CardDescription>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        {(folders?.length ?? 0) > 0 && (
          <div className="relative">
            <Search className="absolute start-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('logsVaultSearch')}
              className="ps-9 h-9"
              dir="ltr"
            />
          </div>
        )}

        {loading ? (
          <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin me-2" />
            {t('loading')}
          </div>
        ) : filtered.length === 0 ? (
          <p className="text-sm text-muted-foreground py-6 text-center">{t('logsVaultEmpty')}</p>
        ) : (
          <div className="rounded-xl border overflow-hidden">
            <div className="max-h-96 overflow-y-auto divide-y">
              {filtered.map((f) => (
                <div key={f.uid}>
                  <button
                    type="button"
                    onClick={() => void toggleFolder(f.uid)}
                    className="w-full text-start flex items-center gap-3 p-3 hover:bg-muted/50 transition-colors"
                  >
                    {openUid === f.uid ? (
                      <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
                    ) : (
                      <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                    )}
                    <Fingerprint className="h-4 w-4 text-violet-500 shrink-0" />
                    <span className="font-mono text-sm font-medium truncate" dir="ltr">{f.uid}</span>
                    {f.platforms?.length > 0 && (
                      <span className="hidden md:flex items-center gap-1">
                        {f.platforms.map((p) => (
                          <Badge key={p} variant="outline" className="text-[9px] px-1.5 py-0 shrink-0" dir="ltr">{p}</Badge>
                        ))}
                      </span>
                    )}
                    <span className="flex-1" />
                    <Badge variant="secondary" className="text-[10px] shrink-0">
                      {t('logsVaultFiles')}: {f.files} · {humanSize(f.bytes)}
                    </Badge>
                    {f.lastAt && (
                      <span className="hidden sm:inline text-[10px] text-muted-foreground shrink-0" dir="ltr">
                        {t('logsVaultLastSeen')}: {new Date(f.lastAt).toLocaleString()}
                      </span>
                    )}
                  </button>
                  {openUid === f.uid && (
                    <div className="bg-muted/30 px-3 pb-3 pt-1 space-y-2">
                      {filesLoading ? (
                        <div className="flex items-center gap-2 py-3 text-xs text-muted-foreground">
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          {t('loading')}
                        </div>
                      ) : (!streams || (streams.length === 0 && (legacyFiles?.length ?? 0) === 0)) ? (
                        <p className="text-xs text-muted-foreground py-2">{t('logsVaultNoFiles')}</p>
                      ) : (
                        <>
                          {(streams ?? []).map((stream) => (
                            <div key={stream.platform} className="space-y-1">
                              <div className="flex items-center gap-1.5 pt-1">
                                <Badge variant="secondary" className="text-[9px] uppercase" dir="ltr">{stream.platform}</Badge>
                                <span className="text-[10px] text-muted-foreground">{stream.files.length}</span>
                              </div>
                              {stream.files.map((file) => (
                                <div key={file.file} className="flex items-center gap-2 rounded-lg bg-background border p-2">
                                  <ScrollText className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                                  <span className="font-mono text-xs truncate flex-1 min-w-0" dir="ltr">{file.file}</span>
                                  <span className="text-[10px] text-muted-foreground shrink-0">{humanSize(file.bytes)}</span>
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    className="h-7 text-[11px] shrink-0"
                                    onClick={() => void openFile(f.uid, stream.platform, file.file)}
                                  >
                                    {t('logsVaultView')}
                                  </Button>
                                </div>
                              ))}
                            </div>
                          ))}
                          {(legacyFiles?.length ?? 0) > 0 && (
                            <div className="space-y-1">
                              <div className="flex items-center gap-1.5 pt-1">
                                <Badge variant="outline" className="text-[9px] uppercase" dir="ltr">legacy</Badge>
                                <span className="text-[10px] text-muted-foreground">{legacyFiles!.length}</span>
                              </div>
                              {legacyFiles!.map((file) => (
                                <div key={file.file} className="flex items-center gap-2 rounded-lg bg-background border p-2">
                                  <ScrollText className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                                  <span className="font-mono text-xs truncate flex-1 min-w-0" dir="ltr">{file.file}</span>
                                  <span className="text-[10px] text-muted-foreground shrink-0">{humanSize(file.bytes)}</span>
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    className="h-7 text-[11px] shrink-0"
                                    onClick={() => void openFile(f.uid, 'legacy', file.file)}
                                  >
                                    {t('logsVaultView')}
                                  </Button>
                                </div>
                              ))}
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>

      {/* Raw NDJSON viewer */}
      <Dialog open={viewerLoading || viewer !== null} onOpenChange={(open) => { if (!open) { setViewer(null); } }}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle className="font-mono text-sm truncate" dir="ltr">
              {viewer ? `${viewer.uid} / ${viewer.platform !== 'legacy' ? viewer.platform + ' / ' : ''}${viewer.file}` : t('logsVaultLoadingFile')}
            </DialogTitle>
            <DialogDescription className="text-[11px]">
              NDJSON — one JSON entry per line
            </DialogDescription>
          </DialogHeader>
          {viewerLoading ? (
            <div className="flex items-center justify-center py-10 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin me-2" />
              {t('logsVaultLoadingFile')}
            </div>
          ) : viewer ? (
            <div className="space-y-2">
              <pre
                className="text-[11px] leading-4 font-mono whitespace-pre-wrap break-all bg-muted/50 rounded-lg p-3 max-h-[55vh] overflow-y-auto border"
                dir="ltr"
              >
                {viewer.content}
              </pre>
              {viewer.truncated && (
                <p className="text-[11px] text-muted-foreground">{t('logsVaultTruncated')}</p>
              )}
              <div className="flex justify-end">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => downloadFile(viewer.uid, viewer.file, viewer.content)}
                >
                  <Download className="h-3.5 w-3.5 me-1" />
                  {t('logsVaultView')}
                </Button>
              </div>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </Card>
  );
}
