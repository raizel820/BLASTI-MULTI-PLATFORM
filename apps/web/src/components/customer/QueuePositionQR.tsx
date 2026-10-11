'use client';

import { useState, useCallback, useMemo } from 'react';
import { motion } from 'framer-motion';
import { QRCodeSVG } from 'qrcode.react';
import { Share2, Copy, Check, Clock, TicketCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';

interface QueuePositionQRProps {
  ticketNumber: string;
  position: number;
  estimatedWaitMinutes?: number;
  agencyName?: string;
  agencyCode?: string;
}

// ─── Main Component ───

export function QueuePositionQR({
  ticketNumber,
  position,
  estimatedWaitMinutes,
  agencyName,
  agencyCode,
}: QueuePositionQRProps) {
  const [copied, setCopied] = useState(false);

  const shareUrl = typeof window !== 'undefined'
    ? `${window.location.origin}#/join/${agencyCode || 'unknown'}`
    : '';

  const qrData = useMemo(() => {
    return JSON.stringify({
      type: 'blasti-queue',
      ticket: ticketNumber,
      position,
      agency: agencyCode || 'unknown',
      agencyName: agencyName || '',
      url: shareUrl,
    });
  }, [ticketNumber, position, agencyCode, agencyName, shareUrl]);

  const shareTitle = `موقعي في الطابور - ${ticketNumber}`;
  const shareText = `أنا في الطابور رقم ${ticketNumber} (المركز ${position})${agencyName ? ` في ${agencyName}` : ''}${estimatedWaitMinutes ? ` - وقت الانتظار المتوقع: ${estimatedWaitMinutes} دقيقة` : ''}`;

  const handleCopyLink = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      toast.success('تم نسخ الرابط');
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback
      const textArea = document.createElement('textarea');
      textArea.value = shareUrl;
      textArea.style.position = 'fixed';
      textArea.style.opacity = '0';
      document.body.appendChild(textArea);
      textArea.select();
      try {
        document.execCommand('copy');
        setCopied(true);
        toast.success('تم نسخ الرابط');
        setTimeout(() => setCopied(false), 2000);
      } catch {
        toast.error('فشل نسخ الرابط');
      }
      document.body.removeChild(textArea);
    }
  }, [shareUrl]);

  const handleShare = useCallback(async () => {
    if (navigator.share) {
      try {
        await navigator.share({
          title: shareTitle,
          text: shareText,
          url: shareUrl,
        });
      } catch (err) {
        // User cancelled or error
        if ((err as DOMException).name !== 'AbortError') {
          toast.error('فشل المشاركة');
        }
      }
    } else {
      // Fallback to copy
      await handleCopyLink();
    }
  }, [shareTitle, shareText, shareUrl, handleCopyLink]);

  return (
    <motion.div
      initial={{ opacity: 0, y: 20, scale: 0.95 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ duration: 0.5, ease: 'easeOut' }}
      className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-emerald-600 via-teal-600 to-emerald-700 shadow-xl shadow-emerald-500/20"
    >
      {/* Decorative background elements */}
      <div className="absolute inset-0 opacity-[0.06]" style={{
        backgroundImage: `radial-gradient(circle at 1px 1px, white 1px, transparent 0)`,
        backgroundSize: '24px 24px',
      }} />
      <motion.div
        className="absolute -top-20 -end-20 h-40 w-40 rounded-full bg-emerald-400/20"
        animate={{ scale: [1, 1.15, 1], opacity: [0.2, 0.3, 0.2] }}
        transition={{ duration: 5, repeat: Infinity, ease: 'easeInOut' }}
      />
      <motion.div
        className="absolute -bottom-16 -start-16 h-32 w-32 rounded-full bg-teal-400/20"
        animate={{ scale: [1, 1.2, 1], opacity: [0.15, 0.25, 0.15] }}
        transition={{ duration: 6, repeat: Infinity, ease: 'easeInOut', delay: 1 }}
      />

      <div className="relative p-6">
        {/* Header */}
        <div className="flex items-center gap-2 mb-4">
          <div className="h-8 w-8 rounded-xl bg-white/20 flex items-center justify-center">
            <TicketCheck className="h-4 w-4 text-white" />
          </div>
          <div>
            <h3 className="text-sm font-bold text-white">موقعك في الطابور</h3>
            <p className="text-[10px] text-emerald-200">شارك موقعك مع الآخرين</p>
          </div>
        </div>

        {/* Ticket Number */}
        <motion.div
          initial={{ opacity: 0, scale: 0.8 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ delay: 0.2, duration: 0.4, type: 'spring' }}
          className="text-center mb-4"
        >
          <p className="text-[10px] text-emerald-200 font-medium mb-1">رقم التذكرة</p>
          <p className="text-5xl font-black bg-gradient-to-r from-white via-emerald-100 to-teal-100 bg-clip-text text-transparent leading-tight">
            {ticketNumber}
          </p>
          <p className="text-xs text-emerald-200 mt-1">
            المركز <span className="font-bold text-white">{position}</span> في الطابور
          </p>
        </motion.div>

        {/* Real QR Code */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.3, duration: 0.4 }}
          className="flex justify-center mb-4"
        >
          <div className="bg-white p-3 rounded-2xl shadow-lg relative">
            <QRCodeSVG
              value={qrData}
              size={180}
              level="H"
              bgColor="#ffffff"
              fgColor="#059669"
              includeMargin={false}
            />
            {/* Center overlay logo */}
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div className="bg-white rounded-lg w-10 h-10 flex items-center justify-center shadow-md border border-emerald-100">
                <span className="text-emerald-600 font-black text-sm">B</span>
              </div>
            </div>
          </div>
        </motion.div>

        {/* QR Label */}
        <p className="text-center text-[10px] text-emerald-200/70 mb-3">
          امسح رمز الاستجابة السريعة لمتابعة حالة الطابور
        </p>

        {/* Wait time */}
        {estimatedWaitMinutes && (
          <motion.div
            initial={{ opacity: 0, y: 5 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.4 }}
            className="flex items-center justify-center gap-2 mb-4 bg-white/10 backdrop-blur-sm rounded-xl px-4 py-2.5"
          >
            <Clock className="h-4 w-4 text-emerald-200" />
            <span className="text-sm text-white font-medium">
              وقت الانتظار المتوقع
            </span>
            <span className="text-sm font-bold text-emerald-100 bg-white/15 px-2 py-0.5 rounded-lg">
              ~{estimatedWaitMinutes} دقيقة
            </span>
          </motion.div>
        )}

        {/* Action buttons */}
        <div className="flex gap-3">
          <Button
            onClick={handleShare}
            className="flex-1 h-11 rounded-xl bg-white/15 backdrop-blur-sm text-white border border-white/20 hover:bg-white/25 transition-all font-semibold text-sm"
          >
            <Share2 className="h-4 w-4 me-2" />
            مشاركة
          </Button>
          <Button
            onClick={handleCopyLink}
            className="flex-1 h-11 rounded-xl bg-white text-emerald-700 hover:bg-emerald-50 transition-all font-semibold text-sm"
          >
            {copied ? (
              <>
                <Check className="h-4 w-4 me-2" />
                تم النسخ
              </>
            ) : (
              <>
                <Copy className="h-4 w-4 me-2" />
                نسخ الرابط
              </>
            )}
          </Button>
        </div>
      </div>
    </motion.div>
  );
}
