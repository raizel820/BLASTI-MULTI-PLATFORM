'use client';

import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Radar,
  CheckCircle,
  Loader2,
  ShieldCheck,
  ShieldX,
  Building2,
  Wifi,
  ArrowLeft,
  Clock,
  Fingerprint,
  KeyRound,
  Search,
  ScanLine,
  Monitor,
  Copy,
  Check,
} from 'lucide-react';
import type { PairingRequest } from './kiosk-types';

export type DiscoveryStatus = 'idle' | 'registering' | 'waiting' | 'discovered' | 'connecting';

interface KioskDiscoveryLoginProps {
  status: DiscoveryStatus;
  pairingRequests: PairingRequest[];
  t: (key: string) => string;
  lang: string;
  kioskIp: string | null;
  pageVariants: {
    enter: { opacity: number; x: number };
    center: { opacity: number; x: number };
    exit: { opacity: number; x: number };
  };
  onBack: () => void;
  onAcceptPairing: (request: PairingRequest) => void;
  onRejectPairing: (request: PairingRequest) => void;
}

function getAgencyName(req: PairingRequest, lang: string) {
  if (lang === 'ar' && req.agencyNameAr) return req.agencyNameAr;
  if (lang === 'fr' && req.agencyNameFr) return req.agencyNameFr;
  return req.agencyName;
}

function getBranchLabel(req: PairingRequest) {
  if (!req.branchName) return null;
  return req.branchName;
}

function ElapsedTimer({ startTime }: { startTime: number }) {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setSeconds(Math.floor((Date.now() - startTime) / 1000)), 1000);
    return () => clearInterval(id);
  }, [startTime]);
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return (
    <span className="flex items-center gap-1.5 text-xs text-teal-500">
      <Clock className="h-3 w-3" />
      {mins > 0 ? `${mins}m ` : ''}{secs}s
    </span>
  );
}

function KioskIpAddress({ ip }: { ip: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(ip);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback for older browsers
      const textarea = document.createElement('textarea');
      textarea.value = ip;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay: 0.2 }}
      className="mt-4"
    >
      <p className="text-xs text-gray-400 mb-2 flex items-center justify-center gap-1.5">
        <Monitor className="h-3 w-3" />
        {copied ? 'Copied!' : 'Kiosk IP Address'}
      </p>
      <button
        type="button"
        onClick={handleCopy}
        className="inline-flex items-center gap-2.5 px-5 py-2.5 rounded-xl bg-gray-900 text-white font-mono text-lg tracking-wide hover:bg-gray-800 active:bg-gray-700 transition-colors select-all cursor-pointer"
        dir="ltr"
      >
        {ip}
        {copied ? (
          <Check className="h-4 w-4 text-emerald-400 flex-shrink-0" />
        ) : (
          <Copy className="h-4 w-4 text-gray-400 flex-shrink-0" />
        )}
      </button>
    </motion.div>
  );
}

export function KioskDiscoveryLogin({
  status,
  pairingRequests,
  t,
  lang,
  kioskIp,
  pageVariants,
  onBack,
  onAcceptPairing,
  onRejectPairing,
}: KioskDiscoveryLoginProps) {
  const hasPairingRequests = pairingRequests.length > 0;
  const [waitStartTime] = useState(Date.now());
  const isRegistering = status === 'registering';
  const isWaiting = status === 'waiting';
  const isConnecting = status === 'connecting';
  const isDiscovered = status === 'discovered';

  return (
    <motion.div
      key="discovery"
      variants={pageVariants}
      initial="enter"
      animate="center"
      exit="exit"
      transition={{ duration: 0.3, ease: 'easeInOut' }}
      className="w-full max-w-md"
    >
      <div className="bg-white rounded-3xl shadow-2xl overflow-hidden">
        {/* Top gradient bar */}
        <div className="h-1.5 bg-gradient-to-r from-teal-400 via-emerald-400 to-teal-500" />

        <div className="p-8 text-center">
          {/* Radar Animation */}
          <div className="relative h-44 w-44 mx-auto mb-6">
            {/* Background glow */}
            <div className="absolute inset-0 rounded-full bg-gradient-to-br from-teal-50 to-emerald-50" />

            {/* Concentric rings (static) */}
            <div className="absolute inset-0 rounded-full border border-teal-200/60" />
            <div className="absolute inset-6 rounded-full border border-teal-200/40" />
            <div className="absolute inset-12 rounded-full border border-teal-200/30" />

            {/* Scanning sweep */}
            <AnimatePresence mode="wait">
              {!hasPairingRequests && !isDiscovered && !isConnecting && (
                <motion.div
                  key="sweep"
                  className="absolute inset-0"
                  animate={{ rotate: 360 }}
                  transition={{ duration: 3, repeat: Infinity, ease: 'linear' }}
                >
                  {/* Sweep cone */}
                  <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-1/2 h-1 origin-left"
                    style={{
                      background: 'conic-gradient(from 0deg, transparent 0deg, rgba(20, 184, 166, 0.15) 0deg, rgba(20, 184, 166, 0.3) 30deg, transparent 60deg)',
                    }}
                  />
                  {/* Sweep line */}
                  <div className="absolute top-1/2 left-1/2 w-1/2 h-0.5 origin-left bg-gradient-to-r from-teal-400 to-transparent" />
                </motion.div>
              )}
            </AnimatePresence>

            {/* Pulse rings for waiting state */}
            {(isWaiting || isRegistering) && (
              <>
                <motion.div
                  animate={{ scale: [1, 1.6, 1], opacity: [0.3, 0, 0.3] }}
                  transition={{ duration: 3, repeat: Infinity, ease: 'easeOut' }}
                  className="absolute inset-0 rounded-full border-2 border-teal-400/50"
                />
                <motion.div
                  animate={{ scale: [1, 1.4, 1], opacity: [0.4, 0, 0.4] }}
                  transition={{ duration: 2.5, repeat: Infinity, ease: 'easeOut', delay: 1 }}
                  className="absolute inset-4 rounded-full border-2 border-teal-400/40"
                />
              </>
            )}

            {/* Success pulse for discovered/connecting/paired */}
            {(isDiscovered || isConnecting || hasPairingRequests) && (
              <motion.div
                initial={{ scale: 0.8, opacity: 0 }}
                animate={{ scale: [1, 1.8, 1], opacity: [0.6, 0, 0.6] }}
                transition={{ duration: 2, repeat: Infinity, ease: 'easeOut' }}
                className="absolute inset-4 rounded-full border-2 border-emerald-400/50"
              />
            )}

            {/* Center icon */}
            <motion.div
              animate={{
                scale: hasPairingRequests || isDiscovered || isConnecting
                  ? [1, 1.15, 1]
                  : isRegistering
                    ? 1
                    : [1, 1.05, 1],
              }}
              transition={{
                duration: hasPairingRequests ? 0.8 : 1.2,
                repeat: Infinity,
                ease: 'easeInOut',
              }}
              className="absolute inset-0 flex items-center justify-center"
            >
              <div className={`h-20 w-20 rounded-full flex items-center justify-center shadow-lg ring-4 ${
                hasPairingRequests || isDiscovered || isConnecting
                  ? 'bg-emerald-100 ring-emerald-200'
                  : isRegistering
                    ? 'bg-teal-100 ring-teal-200'
                    : 'bg-teal-100 ring-teal-100'
              }`}>
                {isRegistering ? (
                  <Loader2 className="h-9 w-9 text-teal-600 animate-spin" />
                ) : hasPairingRequests || isDiscovered || isConnecting ? (
                  <CheckCircle className="h-10 w-10 text-emerald-600" />
                ) : (
                  <Radar className="h-10 w-10 text-teal-600" />
                )}
              </div>
            </motion.div>
          </div>

          {/* Status text */}
          <h2 className="text-xl font-bold text-gray-900 mb-2">
            {hasPairingRequests && t('kioskPairingRequest')}
            {!hasPairingRequests && isDiscovered && t('kioskDiscovered')}
            {!hasPairingRequests && isConnecting && t('kioskAutoConnecting')}
            {!hasPairingRequests && isRegistering && t('kioskWaitingForManager')}
            {!hasPairingRequests && isWaiting && t('kioskWaitingForManager')}
          </h2>

          <p className="text-gray-500 text-sm mb-1">
            {isRegistering && (
              <span className="flex items-center justify-center gap-2">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Registering device...
              </span>
            )}
            {isWaiting && !hasPairingRequests && (
              <span className="flex items-center justify-center gap-2">
                <motion.span
                  animate={{ opacity: [0.3, 1, 0.3] }}
                  transition={{ duration: 1.5, repeat: Infinity }}
                  className="inline-block w-2 h-2 bg-teal-500 rounded-full"
                />
                Waiting for manager to discover this device...
              </span>
            )}
            {isDiscovered && 'Device manager has found this kiosk!'}
            {isConnecting && 'Loading agency configuration...'}
            {hasPairingRequests && (
              <span className="text-emerald-600 font-medium">
                {pairingRequests.length === 1
                  ? '1 agency is requesting to connect'
                  : `${pairingRequests.length} agencies requesting to connect`}
              </span>
            )}
          </p>

          {/* Elapsed timer */}
          {isWaiting && (
            <div className="flex justify-center mt-2">
              <ElapsedTimer startTime={waitStartTime} />
            </div>
          )}

          {/* Kiosk IP Address — shown during waiting / registering / discovered / connecting */}
          {kioskIp && (isWaiting || isRegistering || isDiscovered || isConnecting || hasPairingRequests) && (
            <KioskIpAddress ip={kioskIp} />
          )}

          {/* Pairing Request Cards */}
          <AnimatePresence mode="popLayout">
            {hasPairingRequests && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                className="mt-5 space-y-3 text-left overflow-hidden"
              >
                {pairingRequests.slice(0, 3).map((req, idx) => (
                  <motion.div
                    key={req.id}
                    initial={{ opacity: 0, y: 15, scale: 0.95 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    transition={{ delay: idx * 0.1, duration: 0.3 }}
                    className="bg-gradient-to-br from-white to-emerald-50/50 rounded-2xl p-4 border-2 border-emerald-200 shadow-sm"
                  >
                    <div className="flex items-start gap-3 mb-3">
                      <div className="h-11 w-11 rounded-xl bg-emerald-100 flex items-center justify-center flex-shrink-0 shadow-sm">
                        <Building2 className="h-5 w-5 text-emerald-600" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="font-bold text-gray-900 truncate text-base">
                          {getAgencyName(req, lang)}
                        </p>
                        {getBranchLabel(req) && (
                          <p className="text-xs text-gray-500 mt-0.5 truncate">
                            {getBranchLabel(req)}
                          </p>
                        )}
                        <p className="text-xs text-gray-400 mt-1 flex items-center gap-1">
                          <Clock className="h-3 w-3" />
                          {new Date(req.sentAt).toLocaleTimeString(lang === 'ar' ? 'ar-SA' : lang === 'fr' ? 'fr-FR' : 'en-US', {
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                        </p>
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <motion.button
                        whileHover={{ scale: 1.02 }}
                        whileTap={{ scale: 0.97 }}
                        onClick={() => onAcceptPairing(req)}
                        className="flex-1 min-h-[48px] flex items-center justify-center gap-2 rounded-xl bg-emerald-600 text-white font-semibold text-sm hover:bg-emerald-700 active:bg-emerald-800 transition-colors shadow-sm shadow-emerald-200"
                      >
                        <ShieldCheck className="h-4 w-4" />
                        {t('kioskAcceptPairing')}
                      </motion.button>
                      <motion.button
                        whileHover={{ scale: 1.02 }}
                        whileTap={{ scale: 0.97 }}
                        onClick={() => onRejectPairing(req)}
                        className="min-h-[48px] px-5 flex items-center justify-center gap-2 rounded-xl bg-white text-gray-500 font-semibold text-sm hover:bg-gray-50 hover:text-gray-700 active:bg-gray-100 transition-colors border border-gray-200"
                      >
                        <ShieldX className="h-4 w-4" />
                        {t('kioskRejectPairing')}
                      </motion.button>
                    </div>
                  </motion.div>
                ))}
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Footer with back button */}
        <div className="px-8 pb-6">
          <motion.button
            whileHover={{ scale: 1.01 }}
            whileTap={{ scale: 0.98 }}
            onClick={onBack}
            className="w-full min-h-[48px] rounded-xl bg-gray-100 text-gray-600 font-medium hover:bg-gray-200 transition-colors flex items-center justify-center gap-2 text-sm"
          >
            <ArrowLeft className="h-4 w-4" />
            {t('kioskBack')}
          </motion.button>
        </div>
      </div>
    </motion.div>
  );
}

// ─── Discovery Start Button (used in code step) ──────────────

interface DiscoveryStartButtonProps {
  status: DiscoveryStatus;
  t: (key: string) => string;
  onClick: () => void;
}

export function DiscoveryStartButton({ status, t, onClick }: DiscoveryStartButtonProps) {
  const isActive = status === 'waiting' || status === 'discovered' || status === 'connecting';
  const isDisabled = status === 'registering' || isActive;

  return (
    <motion.button
      whileHover={isDisabled ? {} : { scale: 1.02 }}
      whileTap={isDisabled ? {} : { scale: 0.98 }}
      onClick={isDisabled ? undefined : onClick}
      disabled={isDisabled}
      className={`w-full min-h-[56px] px-4 rounded-2xl border-2 border-dashed flex items-center justify-center gap-2.5 text-sm font-semibold transition-all mt-4 ${
        isActive
          ? 'border-emerald-400 bg-emerald-50 text-emerald-700'
          : status === 'registering'
            ? 'border-teal-300 bg-teal-50 text-teal-500 cursor-wait'
            : 'border-teal-300 bg-teal-50/70 text-teal-700 hover:bg-teal-100 hover:border-teal-400'
      }`}
    >
      {status === 'registering' ? (
        <Loader2 className="h-5 w-5 animate-spin" />
      ) : isActive ? (
        <CheckCircle className="h-5 w-5 text-emerald-500" />
      ) : (
        <Radar className="h-5 w-5" />
      )}
      <span>{t('kioskWaitDiscovery')}</span>
      {isActive && (
        <motion.span
          animate={{ opacity: [0.4, 1, 0.4] }}
          transition={{ duration: 1.5, repeat: Infinity }}
          className="inline-block w-2 h-2 bg-emerald-500 rounded-full"
        />
      )}
    </motion.button>
  );
}

// ─── Method Selection Page ──────────────────────────────────────

interface MethodSelectProps {
  t: (key: string) => string;
  pageVariants: {
    enter: { opacity: number; x: number };
    center: { opacity: number; x: number };
    exit: { opacity: number; x: number };
  };
  onSelectCode: () => void;
  onSelectCredentials: () => void;
  onSelectDiscovery: () => void;
  onSelectQr: () => void;
  discoveryLoading?: boolean;
  discoveryError?: string | null;
}

export function KioskMethodSelect({
  t,
  pageVariants,
  onSelectCredentials,
  onSelectDiscovery,
  discoveryLoading = false,
  discoveryError = null,
}: MethodSelectProps) {
  return (
    <motion.div
      key="method-select"
      variants={pageVariants}
      initial="enter"
      animate="center"
      exit="exit"
      transition={{ duration: 0.3, ease: 'easeInOut' }}
      className="w-full max-w-md"
    >
      <div className="bg-white rounded-3xl shadow-2xl overflow-hidden">
        {/* Top accent */}
        <div className="h-1.5 bg-gradient-to-r from-violet-400 via-teal-400 to-cyan-400" />

        <div className="p-5 sm:p-6">
          {/* Header */}
          <div className="text-center mb-4">
            <div className="h-12 w-12 mx-auto rounded-xl bg-gradient-to-br from-teal-500 to-emerald-600 flex items-center justify-center mb-2 shadow-lg shadow-emerald-200">
              <Fingerprint className="h-6 w-6 text-white" />
            </div>
            <h1 className="text-xl font-bold text-gray-900 mb-1">{t('kioskMethodSelectTitle')}</h1>
            <p className="text-gray-500 text-sm">{t('kioskMethodSelectDesc')}</p>
          </div>

          {/* Two main choices */}
          <div className="space-y-2.5">
            {/* Option 1: Login Credentials */}
            <motion.button
              initial={{ opacity: 0, x: 30 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 0.05, duration: 0.3 }}
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.98 }}
              onClick={onSelectCredentials}
              className="w-full p-3.5 rounded-2xl border-2 border-violet-200 bg-violet-50 hover:bg-violet-100 text-left transition-colors group"
            >
              <div className="flex items-center gap-3">
                <div className="h-11 w-11 rounded-xl bg-gradient-to-br from-violet-500 to-purple-600 flex items-center justify-center shadow-md shadow-violet-200 flex-shrink-0">
                  <KeyRound className="h-6 w-6 text-white" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="font-bold text-violet-700 text-base">{t('kioskMethodCredTitle')}</p>
                  <p className="text-gray-500 text-xs mt-0.5 line-clamp-1">{t('kioskMethodCredDesc')}</p>
                </div>
                <ArrowLeft className="h-5 w-5 text-violet-300 group-hover:text-violet-500 flex-shrink-0 -rotate-180" />
              </div>
            </motion.button>

            {/* Divider */}
            <div className="flex items-center gap-3 py-0.5">
              <div className="flex-1 h-px bg-gray-200" />
              <span className="text-xs font-medium text-gray-400 uppercase tracking-wider">{t('kioskOr') || 'OR'}</span>
              <div className="flex-1 h-px bg-gray-200" />
            </div>

            {/* Discovery Error Message */}
            {discoveryError && (
              <motion.div
                initial={{ opacity: 0, y: -8 }}
                animate={{ opacity: 1, y: 0 }}
                className="p-2.5 rounded-xl bg-red-50 border border-red-200 text-red-700 text-sm font-medium text-center"
              >
                {discoveryError}
              </motion.div>
            )}

            {/* Option 2: Wait for Discovery (Radar) */}
            <motion.button
              initial={{ opacity: 0, x: 30 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 0.15, duration: 0.3 }}
              whileHover={{ scale: discoveryLoading ? 1 : 1.02 }}
              whileTap={{ scale: discoveryLoading ? 1 : 0.98 }}
              onClick={onSelectDiscovery}
              disabled={discoveryLoading}
              className={`w-full p-3.5 rounded-2xl border-2 text-left transition-colors group ${
                discoveryLoading
                  ? 'border-cyan-300 bg-cyan-50/80 cursor-wait'
                  : 'border-cyan-200 bg-cyan-50 hover:bg-cyan-100'
              }`}
            >
              <div className="flex items-center gap-3">
                <div className="h-11 w-11 rounded-xl bg-gradient-to-br from-cyan-500 to-teal-600 flex items-center justify-center shadow-md shadow-cyan-200 flex-shrink-0">
                  {discoveryLoading ? (
                    <Loader2 className="h-6 w-6 text-white animate-spin" />
                  ) : (
                    <Radar className="h-6 w-6 text-white" />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="font-bold text-cyan-700 text-base">
                    {discoveryLoading
                      ? (t('kioskDiscoveryRegistering') || 'Registering device...')
                      : t('kioskMethodRadarTitle')}
                  </p>
                  <p className="text-gray-500 text-xs mt-0.5 line-clamp-1">
                    {discoveryLoading
                      ? (t('kioskDiscoveryPleaseWait') || 'Please wait...')
                      : t('kioskMethodRadarDesc')}
                  </p>
                </div>
                {discoveryLoading ? (
                  <div className="flex-shrink-0">
                    <div className="h-5 w-5 border-2 border-cyan-400 border-t-transparent rounded-full animate-spin" />
                  </div>
                ) : (
                  <ArrowLeft className="h-5 w-5 text-cyan-300 group-hover:text-cyan-500 flex-shrink-0 -rotate-180" />
                )}
              </div>
            </motion.button>
          </div>
        </div>
      </div>
    </motion.div>
  );
}

// ─── Credentials Login Page ─────────────────────────────────────

interface KioskCredentialsLoginProps {
  t: (key: string) => string;
  pageVariants: {
    enter: { opacity: number; x: number };
    center: { opacity: number; x: number };
    exit: { opacity: number; x: number };
  };
  loading: boolean;
  error: string | null;
  onLogin: (pairingCode: string, deviceToken: string) => void;
  onBack: () => void;
}

export function KioskCredentialsLogin({
  t,
  pageVariants,
  loading,
  error,
  onLogin,
  onBack,
}: KioskCredentialsLoginProps) {
  const [pairingCode, setPairingCode] = useState('');
  const [deviceToken, setDeviceToken] = useState('');
  const [tokenVisible, setTokenVisible] = useState(false);

  const canSubmit = pairingCode.trim().length >= 4 && deviceToken.trim().length >= 8 && !loading;

  const handleSubmit = () => {
    if (canSubmit) onLogin(pairingCode.trim().toUpperCase(), deviceToken.trim());
  };

  return (
    <motion.div
      key="credentials"
      variants={pageVariants}
      initial="enter"
      animate="center"
      exit="exit"
      transition={{ duration: 0.3, ease: 'easeInOut' }}
      className="w-full max-w-md"
    >
      <div className="bg-white rounded-3xl shadow-2xl overflow-hidden">
        {/* Top accent */}
        <div className="h-1.5 bg-gradient-to-r from-violet-400 to-purple-500" />

        <div className="p-5 sm:p-6">
          {/* Header */}
          <div className="text-center mb-4">
            <div className="h-12 w-12 mx-auto rounded-xl bg-violet-100 flex items-center justify-center mb-2">
              <KeyRound className="h-6 w-6 text-violet-600" />
            </div>
            <h1 className="text-xl font-bold text-gray-900 mb-1">{t('kioskCredLoginTitle')}</h1>
            <p className="text-gray-500 text-sm">{t('kioskCredLoginDesc')}</p>
          </div>

          {/* Pairing Code field */}
          <div className="space-y-3">
            <div>
              <label className="flex items-center gap-1.5 text-sm font-semibold text-gray-700 mb-1.5">
                <ShieldCheck className="h-3.5 w-3.5 text-violet-500" />
                {t('kioskPairingCode')}
              </label>
              <input
                type="text"
                value={pairingCode}
                onChange={(e) => setPairingCode(e.target.value.toUpperCase())}
                onKeyDown={(e) => { if (e.key === 'Enter') handleSubmit(); }}
                placeholder={t('kioskPairingCodePlaceholder') || 'e.g. A3B7'}
                className="w-full min-h-[48px] rounded-xl border-2 border-gray-200 px-4 text-lg text-center font-bold font-mono tracking-[0.25em] focus:border-violet-400 focus:outline-none transition-colors uppercase"
                autoFocus
                dir="ltr"
                maxLength={10}
              />
            </div>

            {/* Device Token field */}
            <div>
              <label className="flex items-center gap-1.5 text-sm font-semibold text-gray-700 mb-1.5">
                <Fingerprint className="h-3.5 w-3.5 text-violet-500" />
                {t('kioskDeviceToken')}
              </label>
              <div className="relative">
                <input
                  type={tokenVisible ? 'text' : 'password'}
                  value={deviceToken}
                  onChange={(e) => setDeviceToken(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleSubmit(); }}
                  placeholder={t('kioskDeviceTokenPlaceholder') || 'Enter the device token'}
                  className="w-full min-h-[48px] rounded-xl border-2 border-gray-200 px-4 pr-12 text-sm font-mono focus:border-violet-400 focus:outline-none transition-colors"
                  dir="ltr"
                />
                <button
                  type="button"
                  onClick={() => setTokenVisible(!tokenVisible)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 transition-colors p-1"
                  tabIndex={-1}
                >
                  {tokenVisible ? (
                    <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.878 9.878L3 3m6.878 6.878L21 21" /></svg>
                  ) : (
                    <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /><path strokeLinecap="round" strokeLinejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" /></svg>
                  )}
                </button>
              </div>
            </div>

            {/* Error */}
            {error && (
              <motion.div
                initial={{ opacity: 0, y: -8 }}
                animate={{ opacity: 1, y: 0 }}
                className="p-2.5 rounded-xl bg-red-50 border border-red-200 text-red-700 text-sm font-medium text-center"
              >
                {error}
              </motion.div>
            )}

            {/* Submit */}
            <motion.button
              whileHover={{ scale: canSubmit ? 1.02 : 1 }}
              whileTap={{ scale: canSubmit ? 0.98 : 1 }}
              onClick={handleSubmit}
              disabled={!canSubmit}
              className={`w-full min-h-[52px] rounded-2xl text-lg font-bold shadow-lg flex items-center justify-center gap-2 transition-all ${
                canSubmit
                  ? 'bg-gradient-to-r from-violet-600 to-purple-600 text-white hover:shadow-xl hover:shadow-violet-200'
                  : 'bg-gray-200 text-gray-400 cursor-not-allowed shadow-none'
              }`}
            >
              {loading ? <Loader2 className="h-5 w-5 animate-spin" /> : <KeyRound className="h-5 w-5" />}
              {loading ? (t('kioskCredLoggingIn') || 'Connecting...') : (t('kioskLoginButton') || 'Login')}
            </motion.button>
          </div>

          {/* Back */}
          <motion.button
            whileHover={{ scale: 1.01 }}
            whileTap={{ scale: 0.98 }}
            onClick={onBack}
            className="w-full min-h-[44px] mt-3 rounded-xl bg-gray-100 text-gray-600 font-medium hover:bg-gray-200 transition-colors flex items-center justify-center gap-2 text-sm"
          >
            <ArrowLeft className="h-4 w-4" />
            {t('kioskBack')}
          </motion.button>
        </div>
      </div>
    </motion.div>
  );
}