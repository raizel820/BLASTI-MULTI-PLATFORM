import { useCallback, useState } from 'react';
import { QrCode as QrIcon, Printer, Copy, Check, Loader2, ExternalLink } from 'lucide-react';
import api from '@/api/client';
import { useApi } from '@/hooks/use-api';

export default function QrCodePage() {
  const [copied, setCopied] = useState(false);

  const fetchQr = useCallback(() => api.getQrCode(), []);
  const { data, isLoading } = useApi(fetchQr);

  const qr = (data?.qrCode || data?.data || data || {}) as Record<string, unknown>;
  const queueUrl = (qr.url || qr.queueUrl || '') as string;
  const customCode = (qr.customCode || qr.code || '') as string;
  const qrSvg = (qr.svg || qr.qrSvg || '') as string;

  const handlePrint = () => {
    window.print();
  };

  const handleCopyLink = async () => {
    if (!queueUrl) return;
    try {
      await navigator.clipboard.writeText(queueUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback for older browsers
      const textArea = document.createElement('textarea');
      textArea.value = queueUrl;
      document.body.appendChild(textArea);
      textArea.select();
      document.execCommand('copy');
      document.body.removeChild(textArea);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleOpenLink = () => {
    if (queueUrl) window.open(queueUrl, '_blank');
  };

  return (
    <div className="space-y-6 max-w-xl">
      <div>
        <h1 className="text-2xl font-bold text-foreground">QR Code</h1>
        <p className="text-sm text-muted-foreground mt-0.5">Share your queue link with customers</p>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-12 text-muted-foreground">
          <Loader2 className="w-5 h-5 animate-spin" />
        </div>
      ) : (
        <div className="rounded-xl border border-border bg-card p-6 text-center space-y-6">
          {/* QR Code Display */}
          <div className="flex justify-center">
            {qrSvg ? (
              <div
                className="w-64 h-64 flex items-center justify-center bg-white rounded-xl p-4"
                dangerouslySetInnerHTML={{ __html: qrSvg }}
              />
            ) : (
              <div className="w-64 h-64 bg-muted/30 rounded-xl flex items-center justify-center">
                <QrIcon className="w-24 h-24 text-muted-foreground/30" />
              </div>
            )}
          </div>

          {/* Custom Code */}
          {customCode && (
            <div>
              <p className="text-xs text-muted-foreground mb-1">Custom Code</p>
              <p className="text-lg font-mono font-bold text-foreground tracking-wider">{customCode}</p>
            </div>
          )}

          {/* Queue URL */}
          {queueUrl && (
            <div className="bg-muted/30 rounded-lg px-4 py-3">
              <p className="text-xs text-muted-foreground mb-1">Queue URL</p>
              <p className="text-sm font-mono text-foreground break-all">{queueUrl}</p>
            </div>
          )}

          {/* Action Buttons */}
          <div className="flex items-center justify-center gap-3">
            <button
              onClick={handlePrint}
              className="px-4 py-2 rounded-lg border border-border text-sm font-medium text-foreground hover:bg-accent transition-colors flex items-center gap-2"
            >
              <Printer className="w-4 h-4" />
              Print
            </button>
            <button
              onClick={handleCopyLink}
              disabled={!queueUrl}
              className="px-4 py-2 rounded-lg bg-emerald-500 text-white text-sm font-medium hover:bg-emerald-600 disabled:opacity-50 transition-all flex items-center gap-2"
            >
              {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
              {copied ? 'Copied!' : 'Copy Link'}
            </button>
            {queueUrl && (
              <button
                onClick={handleOpenLink}
                className="px-4 py-2 rounded-lg border border-border text-sm font-medium text-foreground hover:bg-accent transition-colors flex items-center gap-2"
              >
                <ExternalLink className="w-4 h-4" />
                Open
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
