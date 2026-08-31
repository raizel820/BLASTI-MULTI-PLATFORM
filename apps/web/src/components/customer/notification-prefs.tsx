'use client'

import { useState, useEffect } from 'react'
import { useAppStore } from '@/store/use-app-store'
import { useLanguage } from '@/hooks/use-language'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { toast } from 'sonner'
import { MessageSquare, Smartphone, Phone, Bell, Loader2, Check, AlertTriangle } from 'lucide-react'
import { motion } from 'framer-motion'

type NotificationPrefValue = 'APP_ONLY' | 'SMS' | 'WHATSAPP' | 'BOTH'

interface NotificationPrefOption {
  value: NotificationPrefValue
  labelAr: string
  labelEn: string
  descriptionAr: string
  descriptionEn: string
  icon: typeof Bell
  color: string
  badge?: string
}

const NOTIF_PREF_OPTIONS: NotificationPrefOption[] = [
  {
    value: 'APP_ONLY',
    labelAr: 'تطبيق فقط',
    labelEn: 'App Only',
    descriptionAr: 'إشعارات داخل التطبيق فقط — مجاني',
    descriptionEn: 'In-app notifications only — Free',
    icon: Smartphone,
    color: 'emerald',
    badge: 'مجاني',
  },
  {
    value: 'SMS',
    labelAr: 'رسائل SMS',
    labelEn: 'SMS',
    descriptionAr: 'تنبيهات عبر رسائل نصية',
    descriptionEn: 'Text message alerts',
    icon: MessageSquare,
    color: 'teal',
  },
  {
    value: 'WHATSAPP',
    labelAr: 'واتساب',
    labelEn: 'WhatsApp',
    descriptionAr: 'تنبيهات عبر واتساب',
    descriptionEn: 'WhatsApp message alerts',
    icon: Phone,
    color: 'teal',
  },
  {
    value: 'BOTH',
    labelAr: 'SMS + واتساب',
    labelEn: 'Both',
    descriptionAr: 'رسائل نصية وواتساب معاً',
    descriptionEn: 'SMS and WhatsApp combined',
    icon: Bell,
    color: 'cyan',
  },
]

export function NotificationPrefs() {
  const { user } = useAppStore()
  const { t, lang } = useLanguage()
  const isArabic = lang === 'ar'

  const [pref, setPref] = useState<NotificationPrefValue>('APP_ONLY')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!user?.id) return
    fetchCurrentPref()
  }, [user?.id])

  const fetchCurrentPref = async () => {
    if (!user?.id) return
    setLoading(true)
    try {
      const res = await apiFetch(`/api/user/profile?userId=${user.id}`)
      if (res.ok) {
        const data = await res.json()
        if (data.notificationPref) {
          setPref(data.notificationPref as NotificationPrefValue)
        }
      }
    } catch {
      // silent
    } finally {
      setLoading(false)
    }
  }

  const handleSave = async () => {
    if (!user?.id) return
    setSaving(true)
    try {
      const res = await apiFetch('/api/user/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: user.id, notificationPref: pref }),
      })
      if (res.ok) {
        toast.success(isArabic ? 'تم حفظ تفضيل الإشعارات' : 'Notification preference saved')
      } else {
        const data = await res.json()
        toast.error(data.error || (isArabic ? 'حدث خطأ' : 'Error saving preference'))
      }
    } catch {
      toast.error(isArabic ? 'حدث خطأ' : 'Error saving preference')
    } finally {
      setSaving(false)
    }
  }

  const colorMap: Record<string, { border: string; bg: string; iconBg: string; iconText: string }> = {
    emerald: {
      border: 'border-emerald-300 dark:border-emerald-700',
      bg: 'bg-emerald-50/80 dark:bg-emerald-900/20',
      iconBg: 'bg-emerald-100 dark:bg-emerald-800/40',
      iconText: 'text-emerald-600 dark:text-emerald-400',
    },
    teal: {
      border: 'border-teal-300 dark:border-teal-700',
      bg: 'bg-teal-50/80 dark:bg-teal-900/20',
      iconBg: 'bg-teal-100 dark:bg-teal-800/40',
      iconText: 'text-teal-600 dark:text-teal-400',
    },
    cyan: {
      border: 'border-cyan-300 dark:border-cyan-700',
      bg: 'bg-cyan-50/80 dark:bg-cyan-900/20',
      iconBg: 'bg-cyan-100 dark:bg-cyan-800/40',
      iconText: 'text-cyan-600 dark:text-cyan-400',
    },
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 15 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.22 }}
    >
      <Card className="border-0 shadow-sm">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Bell className="h-4 w-4 text-emerald-600" />
            {isArabic ? 'طريقة الإشعار' : 'Notification Channel'}
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <p className="text-xs text-muted-foreground mb-3">
            {isArabic ? 'اختر كيف تريد تلقي إشعارات دورك' : 'Choose how you want to receive turn notifications'}
          </p>

          <RadioGroup
            value={pref}
            onValueChange={(val) => setPref(val as NotificationPrefValue)}
            className="space-y-2"
          >
            {NOTIF_PREF_OPTIONS.map((option) => {
              const Icon = option.icon
              const isSelected = pref === option.value
              const colors = colorMap[option.color]

              return (
                <Label
                  key={option.value}
                  htmlFor={`notif-pref-${option.value}`}
                  className={`flex items-center gap-3 p-3.5 rounded-xl border-2 transition-all duration-200 cursor-pointer ${
                    isSelected
                      ? `${colors.border} ${colors.bg}`
                      : 'border-transparent bg-gray-50 dark:bg-gray-800/30 hover:border-gray-200 dark:hover:border-gray-700'
                  }`}
                >
                  <RadioGroupItem
                    value={option.value}
                    id={`notif-pref-${option.value}`}
                    className="flex-shrink-0"
                  />
                  <div className={`h-9 w-9 rounded-lg ${isSelected ? colors.iconBg : 'bg-gray-100 dark:bg-gray-800/50'} flex items-center justify-center flex-shrink-0 transition-colors`}>
                    <Icon className={`h-4 w-4 ${isSelected ? colors.iconText : 'text-muted-foreground'}`} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className={`text-sm font-semibold ${isSelected ? 'text-foreground' : 'text-muted-foreground'}`}>
                        {isArabic ? option.labelAr : option.labelEn}
                      </p>
                      {option.badge && (
                        <span className="text-[9px] font-bold text-emerald-700 dark:text-emerald-400 bg-emerald-100 dark:bg-emerald-900/30 px-1.5 py-0.5 rounded-full">
                          {isArabic ? option.badge : 'Free'}
                        </span>
                      )}
                    </div>
                    <p className="text-[11px] text-muted-foreground mt-0.5">
                      {isArabic ? option.descriptionAr : option.descriptionEn}
                    </p>
                  </div>
                </Label>
              )
            })}
          </RadioGroup>

          {/* Cost warning note */}
          <div className="mt-4 p-3 rounded-xl bg-amber-50 dark:bg-amber-900/10 border border-amber-200/50 dark:border-amber-800/30">
            <div className="flex items-start gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-500 flex-shrink-0 mt-0.5" />
              <p className="text-[11px] text-amber-700 dark:text-amber-400">
                {isArabic
                  ? 'تنبيه: الرسائل النصية وواتساب قد تتطلب رصيد'
                  : 'Note: SMS and WhatsApp may require credit balance'}
              </p>
            </div>
          </div>

          <Button
            size="sm"
            className="mt-4 w-full bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg h-10"
            onClick={handleSave}
            disabled={saving || loading}
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin me-2" /> : <Check className="h-4 w-4 me-2" />}
            {t('save')}
          </Button>
        </CardContent>
      </Card>
    </motion.div>
  )
}
