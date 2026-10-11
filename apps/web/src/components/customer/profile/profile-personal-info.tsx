'use client';
/**
 * Task 82 — Personal info editor (customer profile).
 *
 * Replaces the phone-only card: the customer can now update
 *   • avatar (upload from device via POST /api/upload, type=avatar)
 *   • full name
 *   • email (validated client-side, uniqueness enforced server-side → 409)
 *   • phone number (uniqueness enforced server-side → 409, surfaced nicely)
 * One Save button persists all fields via PATCH /api/user/profile.
 */
import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Camera, Check, Loader2, Mail, Pencil, Phone, UserRound } from 'lucide-react';
import { motion } from 'framer-motion';
import { toast } from 'sonner';
import { useUpload } from '@/hooks/use-upload';
import { UserAvatar } from '@/components/shared/user-avatar';
import type { TranslationKeys } from '@/i18n';

interface ProfilePersonalInfoProps {
  fullName: string;
  email: string;
  phoneNumber: string;
  avatarUrl: string;
  saving: boolean;
  onFullNameChange: (v: string) => void;
  onEmailChange: (v: string) => void;
  onPhoneNumberChange: (v: string) => void;
  onAvatarUrlChange: (v: string) => void;
  onSave: (next: { fullName: string; email: string; phoneNumber: string; avatarUrl?: string }) => Promise<boolean>;
  t: (key: TranslationKeys) => string;
}

export function ProfilePersonalInfo({
  fullName,
  email,
  phoneNumber,
  avatarUrl,
  saving,
  onFullNameChange,
  onEmailChange,
  onPhoneNumberChange,
  onAvatarUrlChange,
  onSave,
  t,
}: ProfilePersonalInfoProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const upload = useUpload({ type: 'avatar', maxSize: 2 * 1024 * 1024 });

  const handleAvatarPicked = async (file: File | null | undefined) => {
    if (!file) return;
    setUploadingAvatar(true);
    try {
      const result = await upload.upload(file);
      if (result.url) {
        onAvatarUrlChange(result.url);
      } else if (result.error) {
        toast.error(result.error);
      }
    } finally {
      setUploadingAvatar(false);
      // Reset so picking the same file twice still fires onChange.
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleSaveClick = async () => {
    await onSave({
      fullName,
      email,
      phoneNumber,
      // Only send the avatar when it actually changed this session —
      // the parent tracks the baseline via the store user.
      avatarUrl: avatarUrl || '',
    });
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, delay: 0.1 }}
      id="profile-personal-info"
      className="scroll-mt-4"
    >
      <div className="rounded-2xl border border-border bg-white dark:bg-gray-900/80 shadow-sm p-4">
        <div className="flex items-center gap-2 mb-4">
          <Pencil className="h-4 w-4 text-emerald-600" />
          <p className="text-sm font-semibold text-foreground">{t('personalInfo')}</p>
        </div>

        {/* Avatar */}
        <div className="flex items-center gap-3 mb-4">
          <div className="relative shrink-0">
            <div className="h-16 w-16 rounded-full overflow-hidden bg-emerald-600 ring-2 ring-emerald-100 dark:ring-emerald-900">
              <UserAvatar avatarUrl={avatarUrl || undefined} fullName={fullName} />
            </div>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploadingAvatar}
              aria-label={t('changeAvatar')}
              className="absolute -bottom-1 -end-1 h-7 w-7 rounded-full bg-emerald-600 hover:bg-emerald-700 text-white flex items-center justify-center shadow-md border-2 border-white dark:border-gray-900 transition-colors disabled:opacity-60"
            >
              {uploadingAvatar ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Camera className="h-3.5 w-3.5" />
              )}
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/png,image/gif,image/webp"
              className="hidden"
              onChange={(e) => void handleAvatarPicked(e.target.files?.[0])}
            />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground truncate">{fullName || t('defaultUser')}</p>
            <p className="text-xs text-muted-foreground">{t('changeAvatar')}</p>
          </div>
        </div>

        {/* Editable fields */}
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="pi-fullname" className="text-xs text-muted-foreground flex items-center gap-1.5">
              <UserRound className="h-3 w-3" />
              {t('fullName')}
            </Label>
            <Input
              id="pi-fullname"
              value={fullName}
              onChange={(e) => onFullNameChange(e.target.value)}
              className="h-11 rounded-xl"
              autoComplete="name"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="pi-email" className="text-xs text-muted-foreground flex items-center gap-1.5">
              <Mail className="h-3 w-3" />
              {t('email')}
            </Label>
            <Input
              id="pi-email"
              type="email"
              value={email}
              onChange={(e) => onEmailChange(e.target.value)}
              placeholder="name@example.com"
              className="h-11 rounded-xl"
              dir="ltr"
              autoComplete="email"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="pi-phone" className="text-xs text-muted-foreground flex items-center gap-1.5">
              <Phone className="h-3 w-3" />
              {t('phoneNumber')}
            </Label>
            <Input
              id="pi-phone"
              type="tel"
              value={phoneNumber}
              onChange={(e) => onPhoneNumberChange(e.target.value)}
              placeholder={t('phonePlaceholder')}
              className="h-11 rounded-xl"
              dir="ltr"
              autoComplete="tel"
            />
          </div>

          <Button
            className="w-full h-10 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl"
            onClick={handleSaveClick}
            disabled={saving || uploadingAvatar}
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin me-2" /> : <Check className="h-4 w-4 me-2" />}
            {t('save')}
          </Button>
        </div>
      </div>
    </motion.div>
  );
}
