'use client'
import { apiFetch } from '@/lib/api-fetch';

import { useState, useEffect, useCallback } from 'react'
import { useLanguage } from '@/hooks/use-language'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import {
  Settings,
  RefreshCw,
  Loader2,
  Save,
  Plus,
  Pencil,
  Trash2,
  Search,
  Shield,
  Eye,
  EyeOff,
  Key,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Server,
  CreditCard,
  MessageSquare,
  Lock,
  Globe,
} from 'lucide-react'
import { toast } from 'sonner'
import { motion } from 'framer-motion'

// ─── Types ──────────────────────────────────────────────────────────────────

interface SystemSettingData {
  id: string
  key: string
  value: string
  encrypted: boolean
  category: string
  description: string
  valueType: string
  updatedAt: string
  createdAt: string
}

// ─── Category Icons ─────────────────────────────────────────────────────────

const CATEGORY_ICONS: Record<string, React.ReactNode> = {
  general: <Settings className="h-3.5 w-3.5" />,
  payment: <CreditCard className="h-3.5 w-3.5" />,
  sms: <MessageSquare className="h-3.5 w-3.5" />,
  security: <Lock className="h-3.5 w-3.5" />,
  api: <Globe className="h-3.5 w-3.5" />,
  server: <Server className="h-3.5 w-3.5" />,
}

const CATEGORY_LABELS: Record<string, Record<string, string>> = {
  general: { ar: 'عام', fr: 'Général', en: 'General' },
  payment: { ar: 'الدفع', fr: 'Paiement', en: 'Payment' },
  sms: { ar: 'الرسائل', fr: 'SMS', en: 'SMS' },
  security: { ar: 'الأمان', fr: 'Sécurité', en: 'Security' },
  api: { ar: 'واجهة البرمجة', fr: 'API', en: 'API' },
  server: { ar: 'الخادم', fr: 'Serveur', en: 'Server' },
}

const VALUE_TYPE_LABELS: Record<string, Record<string, string>> = {
  string: { ar: 'نص', fr: 'Texte', en: 'String' },
  number: { ar: 'رقم', fr: 'Nombre', en: 'Number' },
  boolean: { ar: 'منطقي', fr: 'Booléen', en: 'Boolean' },
  json: { ar: 'JSON', fr: 'JSON', en: 'JSON' },
}

// ─── Animation ──────────────────────────────────────────────────────────────

const fadeUp = {
  initial: { opacity: 0, y: 15 },
  animate: { opacity: 1, y: 0 },
}

// ─── Component ──────────────────────────────────────────────────────────────

export function SystemSettingsConfig() {
  const { t, lang } = useLanguage()

  // ── State ──
  const [settings, setSettings] = useState<SystemSettingData[]>([])
  const [categories, setCategories] = useState<string[]>([])
  const [activeCategory, setActiveCategory] = useState<string>('all')
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')

  // Edit/Create dialog
  const [editDialogOpen, setEditDialogOpen] = useState(false)
  const [editingSetting, setEditingSetting] = useState<SystemSettingData | null>(null)
  const [formData, setFormData] = useState({
    key: '',
    value: '',
    encrypted: false,
    category: 'general',
    description: '',
    valueType: 'string',
  })
  const [saving, setSaving] = useState(false)

  // Delete dialog
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [deletingKey, setDeletingKey] = useState<string>('')
  const [deleting, setDeleting] = useState(false)

  // Bulk edit
  const [bulkDialogOpen, setBulkDialogOpen] = useState(false)
  const [bulkEntries, setBulkEntries] = useState<Array<{ key: string; value: string; encrypted: boolean }>>([])
  const [bulkSaving, setBulkSaving] = useState(false)

  // Show encrypted toggle
  const [showEncryptedValues, setShowEncryptedValues] = useState<Record<string, boolean>>({})

  // ── Fetch ──

  const fetchSettings = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true)
    else setLoading(true)
    try {
      const res = await apiFetch('/api/settings')
      if (!res.ok) throw new Error('Failed to fetch settings')
      const data = await res.json()
      if (data.success) {
        setSettings(data.data || [])
        // Extract unique categories from data
        const cats = [...new Set((data.data || []).map((s: SystemSettingData) => s.category))]
        setCategories(cats.sort())
      }
    } catch (err) {
      console.error('Failed to fetch settings:', err)
      toast.error(lang === 'ar' ? 'فشل تحميل الإعدادات' : lang === 'fr' ? 'Échec du chargement des paramètres' : 'Failed to load settings')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [lang])

  useEffect(() => {
    fetchSettings()
  }, [fetchSettings])

  // ── Filtered settings ──

  const filteredSettings = settings.filter(s => {
    const matchesCategory = activeCategory === 'all' || s.category === activeCategory
    const matchesSearch = !searchQuery || 
      s.key.toLowerCase().includes(searchQuery.toLowerCase()) ||
      s.description.toLowerCase().includes(searchQuery.toLowerCase()) ||
      s.category.toLowerCase().includes(searchQuery.toLowerCase())
    return matchesCategory && matchesSearch
  })

  // ── Handlers ──

  const handleCreateNew = () => {
    setEditingSetting(null)
    setFormData({ key: '', value: '', encrypted: false, category: 'general', description: '', valueType: 'string' })
    setEditDialogOpen(true)
  }

  const handleEdit = (setting: SystemSettingData) => {
    setEditingSetting(setting)
    setFormData({
      key: setting.key,
      value: '', // Don't pre-fill encrypted values; admin must re-enter
      encrypted: setting.encrypted,
      category: setting.category,
      description: setting.description,
      valueType: setting.valueType,
    })
    setEditDialogOpen(true)
  }

  const handleSave = async () => {
    if (!formData.key.trim()) {
      toast.error(lang === 'ar' ? 'مطلوب مفتاح' : lang === 'fr' ? 'Clé requise' : 'Key is required')
      return
    }
    if (editingSetting && editingSetting.encrypted && !formData.value.trim()) {
      toast.error(lang === 'ar' ? 'أدخل قيمة جديدة للحقل المشفر' : lang === 'fr' ? 'Entrez une nouvelle valeur pour le champ chiffré' : 'Enter a new value for the encrypted field')
      return
    }
    if (!editingSetting && !formData.value.trim()) {
      toast.error(lang === 'ar' ? 'القيمة مطلوبة' : lang === 'fr' ? 'Valeur requise' : 'Value is required')
      return
    }

    setSaving(true)
    try {
      const res = await apiFetch(`/api/settings/${encodeURIComponent(formData.key)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData),
      })
      const data = await res.json()
      if (data.success) {
        toast.success(editingSetting 
          ? (lang === 'ar' ? 'تم تحديث الإعداد' : lang === 'fr' ? 'Paramètre mis à jour' : 'Setting updated')
          : (lang === 'ar' ? 'تم إنشاء الإعداد' : lang === 'fr' ? 'Paramètre créé' : 'Setting created'))
        setEditDialogOpen(false)
        fetchSettings(true)
      } else {
        toast.error(data.error || 'Failed to save setting')
      }
    } catch (err) {
      toast.error(lang === 'ar' ? 'فشل حفظ الإعداد' : lang === 'fr' ? 'Échec de la sauvegarde' : 'Failed to save setting')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!deletingKey) return
    setDeleting(true)
    try {
      const res = await apiFetch(`/api/settings/${encodeURIComponent(deletingKey)}`, { method: 'DELETE' })
      const data = await res.json()
      if (data.success) {
        toast.success(lang === 'ar' ? 'تم حذف الإعداد' : lang === 'fr' ? 'Paramètre supprimé' : 'Setting deleted')
        setDeleteDialogOpen(false)
        setDeletingKey('')
        fetchSettings(true)
      } else {
        toast.error(data.error || 'Failed to delete setting')
      }
    } catch {
      toast.error(lang === 'ar' ? 'فشل حذف الإعداد' : lang === 'fr' ? 'Échec de la suppression' : 'Failed to delete setting')
    } finally {
      setDeleting(false)
    }
  }

  const handleBulkSave = async () => {
    if (bulkEntries.length === 0) return
    setBulkSaving(true)
    try {
      const res = await apiFetch('/api/settings/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings: bulkEntries }),
      })
      const data = await res.json()
      if (data.success) {
        toast.success(lang === 'ar' ? `تم تحديث ${bulkEntries.length} إعدادات` : lang === 'fr' ? `${bulkEntries.length} paramètres mis à jour` : `${bulkEntries.length} settings updated`)
        setBulkDialogOpen(false)
        setBulkEntries([])
        fetchSettings(true)
      } else {
        toast.error(data.error || 'Failed to bulk update')
      }
    } catch {
      toast.error(lang === 'ar' ? 'فشل التحديث المجمع' : lang === 'fr' ? 'Échec de la mise à jour en masse' : 'Failed to bulk update')
    } finally {
      setBulkSaving(false)
    }
  }

  const getCategoryLabel = (cat: string) => {
    return CATEGORY_LABELS[cat]?.[lang] || cat.charAt(0).toUpperCase() + cat.slice(1)
  }

  const getValueTypeLabel = (vt: string) => {
    return VALUE_TYPE_LABELS[vt]?.[lang] || vt
  }

  const getCategoryIcon = (cat: string) => {
    return CATEGORY_ICONS[cat] || <Settings className="h-3.5 w-3.5" />
  }

  // ── Render ──

  return (
    <motion.div {...fadeUp}>
      <Card>
        <CardHeader className="pb-4">
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2 text-lg">
                <Shield className="h-5 w-5 text-emerald-600" />
                {lang === 'ar' ? 'إعدادات النظام' : lang === 'fr' ? 'Paramètres système' : 'System Settings'}
              </CardTitle>
              <CardDescription className="mt-1 text-xs">
                {lang === 'ar' ? 'إدارة التكوين الديناميكي للتطبيق' : lang === 'fr' ? 'Gérer la configuration dynamique de l\'application' : 'Manage dynamic application configuration'}
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => fetchSettings(true)}
                disabled={refreshing}
                className="h-8 text-xs"
              >
                {refreshing ? <Loader2 className="h-3.5 w-3.5 animate-spin me-1" /> : <RefreshCw className="h-3.5 w-3.5 me-1" />}
                {lang === 'ar' ? 'تحديث' : lang === 'fr' ? 'Rafraîchir' : 'Refresh'}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setBulkEntries([{ key: '', value: '', encrypted: false }])
                  setBulkDialogOpen(true)
                }}
                className="h-8 text-xs"
              >
                {lang === 'ar' ? 'تحرير مجمع' : lang === 'fr' ? 'Édition en masse' : 'Bulk Edit'}
              </Button>
              <Button
                size="sm"
                onClick={handleCreateNew}
                className="h-8 text-xs bg-emerald-600 hover:bg-emerald-700"
              >
                <Plus className="h-3.5 w-3.5 me-1" />
                {lang === 'ar' ? 'إعداد جديد' : lang === 'fr' ? 'Nouveau paramètre' : 'New Setting'}
              </Button>
            </div>
          </div>

          {/* Search */}
          <div className="relative mt-3">
            <Search className="absolute start-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={lang === 'ar' ? 'ابحث عن الإعدادات...' : lang === 'fr' ? 'Rechercher des paramètres...' : 'Search settings...'}
              className="ps-9 h-8 text-xs"
            />
          </div>
        </CardHeader>

        <CardContent className="pt-0">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-emerald-600" />
            </div>
          ) : settings.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              <Settings className="h-10 w-10 mx-auto mb-3 opacity-40" />
              <p className="text-sm">
                {lang === 'ar' ? 'لا توجد إعدادات بعد' : lang === 'fr' ? 'Aucun paramètre pour l\'instant' : 'No settings yet'}
              </p>
              <p className="text-xs mt-1">
                {lang === 'ar' ? 'انقر فوق "إعداد جديد" لإضافة أول إعداد' : lang === 'fr' ? 'Cliquez sur "Nouveau paramètre" pour ajouter le premier' : 'Click "New Setting" to add the first one'}
              </p>
            </div>
          ) : (
            <Tabs value={activeCategory} onValueChange={setActiveCategory}>
              <TabsList className="mb-4 flex flex-wrap h-auto gap-1 bg-muted/50 p-1">
                <TabsTrigger value="all" className="text-xs h-7 px-3">
                  {lang === 'ar' ? 'الكل' : lang === 'fr' ? 'Tout' : 'All'}
                  <Badge variant="secondary" className="ms-1.5 text-[10px] px-1.5 py-0">{settings.length}</Badge>
                </TabsTrigger>
                {categories.map(cat => (
                  <TabsTrigger key={cat} value={cat} className="text-xs h-7 px-3">
                    <span className="me-1">{getCategoryIcon(cat)}</span>
                    {getCategoryLabel(cat)}
                    <Badge variant="secondary" className="ms-1.5 text-[10px] px-1.5 py-0">
                      {settings.filter(s => s.category === cat).length}
                    </Badge>
                  </TabsTrigger>
                ))}
              </TabsList>

              <TabsContent value={activeCategory} className="mt-0">
                <div className="rounded-lg border overflow-hidden">
                  <Table>
                    <TableHeader>
                      <TableRow className="bg-muted/30">
                        <TableHead className="text-xs font-medium">{lang === 'ar' ? 'المفتاح' : lang === 'fr' ? 'Clé' : 'Key'}</TableHead>
                        <TableHead className="text-xs font-medium">{lang === 'ar' ? 'القيمة' : lang === 'fr' ? 'Valeur' : 'Value'}</TableHead>
                        <TableHead className="text-xs font-medium w-24">{lang === 'ar' ? 'النوع' : lang === 'fr' ? 'Type' : 'Type'}</TableHead>
                        <TableHead className="text-xs font-medium w-20">{lang === 'ar' ? 'الحالة' : lang === 'fr' ? 'Statut' : 'Status'}</TableHead>
                        <TableHead className="text-xs font-medium w-28">{lang === 'ar' ? 'الوصف' : lang === 'fr' ? 'Description' : 'Description'}</TableHead>
                        <TableHead className="text-xs font-medium w-20 text-end">{lang === 'ar' ? 'إجراءات' : lang === 'fr' ? 'Actions' : 'Actions'}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filteredSettings.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={6} className="text-center py-8 text-muted-foreground text-xs">
                            {searchQuery
                              ? (lang === 'ar' ? 'لا توجد نتائج' : lang === 'fr' ? 'Aucun résultat' : 'No results found')
                              : (lang === 'ar' ? 'لا توجد إعدادات في هذه الفئة' : lang === 'fr' ? 'Aucun paramètre dans cette catégorie' : 'No settings in this category')
                            }
                          </TableCell>
                        </TableRow>
                      ) : (
                        filteredSettings.map(setting => (
                          <TableRow key={setting.id} className="hover:bg-muted/20">
                            <TableCell className="text-xs font-mono font-medium text-foreground">
                              {setting.key}
                            </TableCell>
                            <TableCell className="text-xs">
                              {setting.encrypted ? (
                                <div className="flex items-center gap-1.5">
                                  <Key className="h-3 w-3 text-amber-500" />
                                  <span className="font-mono">
                                    {showEncryptedValues[setting.key] ? '••••••••' : '••••••••'}
                                  </span>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-5 w-5 p-0"
                                    onClick={() => {
                                      toast.info(lang === 'ar' ? 'لا يمكن عرض القيم المشفرة لأسباب أمنية' : lang === 'fr' ? 'Les valeurs chiffrées ne peuvent pas être affichées pour des raisons de sécurité' : 'Encrypted values cannot be displayed for security reasons')
                                    }}
                                  >
                                    <EyeOff className="h-3 w-3 text-muted-foreground" />
                                  </Button>
                                </div>
                              ) : (
                                <span className="font-mono max-w-[200px] truncate inline-block" title={setting.value}>
                                  {setting.value.length > 50 ? setting.value.slice(0, 50) + '...' : setting.value}
                                </span>
                              )}
                            </TableCell>
                            <TableCell>
                              <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                                {getValueTypeLabel(setting.valueType)}
                              </Badge>
                            </TableCell>
                            <TableCell>
                              {setting.encrypted ? (
                                <Badge className="text-[10px] px-1.5 py-0 bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400 border-0">
                                  <Lock className="h-2.5 w-2.5 me-0.5" />
                                  {lang === 'ar' ? 'مشفر' : lang === 'fr' ? 'Chiffré' : 'Encrypted'}
                                </Badge>
                              ) : (
                                <Badge className="text-[10px] px-1.5 py-0 bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400 border-0">
                                  {lang === 'ar' ? 'عادي' : lang === 'fr' ? 'Plain' : 'Plain'}
                                </Badge>
                              )}
                            </TableCell>
                            <TableCell className="text-xs text-muted-foreground max-w-[120px] truncate" title={setting.description}>
                              {setting.description || '—'}
                            </TableCell>
                            <TableCell className="text-end">
                              <div className="flex items-center justify-end gap-1">
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="h-7 w-7 p-0"
                                  onClick={() => handleEdit(setting)}
                                >
                                  <Pencil className="h-3.5 w-3.5" />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="h-7 w-7 p-0 text-red-500 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20"
                                  onClick={() => {
                                    setDeletingKey(setting.key)
                                    setDeleteDialogOpen(true)
                                  }}
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </Button>
                              </div>
                            </TableCell>
                          </TableRow>
                        ))
                      )}
                    </TableBody>
                  </Table>
                </div>
              </TabsContent>
            </Tabs>
          )}
        </CardContent>
      </Card>

      {/* ─── Edit / Create Dialog ─── */}

      <Dialog open={editDialogOpen} onOpenChange={setEditDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {editingSetting ? (
                <>
                  <Pencil className="h-4 w-4" />
                  {lang === 'ar' ? 'تعديل الإعداد' : lang === 'fr' ? 'Modifier le paramètre' : 'Edit Setting'}
                </>
              ) : (
                <>
                  <Plus className="h-4 w-4" />
                  {lang === 'ar' ? 'إعداد جديد' : lang === 'fr' ? 'Nouveau paramètre' : 'New Setting'}
                </>
              )}
            </DialogTitle>
            <DialogDescription className="text-xs">
              {editingSetting
                ? (lang === 'ar' ? `تعديل الإعداد: ${editingSetting.key}` : lang === 'fr' ? `Modifier le paramètre: ${editingSetting.key}` : `Edit setting: ${editingSetting.key}`)
                : (lang === 'ar' ? 'إضافة إعداد جديد للنظام' : lang === 'fr' ? 'Ajouter un nouveau paramètre système' : 'Add a new system setting')
              }
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label className="text-xs">{lang === 'ar' ? 'المفتاح' : lang === 'fr' ? 'Clé' : 'Key'}</Label>
              <Input
                value={formData.key}
                onChange={(e) => setFormData({ ...formData, key: e.target.value })}
                placeholder="e.g., smtp.host"
                disabled={!!editingSetting}
                className="h-8 text-xs font-mono"
              />
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs">
                {lang === 'ar' ? 'القيمة' : lang === 'fr' ? 'Valeur' : 'Value'}
                {editingSetting?.encrypted && (
                  <span className="text-amber-600 ms-1">
                    ({lang === 'ar' ? 'أدخل قيمة جديدة — القيمة القديمة مشفرة' : lang === 'fr' ? 'Entrez une nouvelle valeur — l\'ancienne est chiffrée' : 'Enter new value — old value is encrypted'})
                  </span>
                )}
              </Label>
              {formData.valueType === 'json' ? (
                <Textarea
                  value={formData.value}
                  onChange={(e) => setFormData({ ...formData, value: e.target.value })}
                  placeholder='{"key": "value"}'
                  className="text-xs font-mono min-h-[80px]"
                />
              ) : formData.valueType === 'boolean' ? (
                <div className="flex items-center gap-2">
                  <Switch
                    checked={formData.value === 'true'}
                    onCheckedChange={(v) => setFormData({ ...formData, value: String(v) })}
                  />
                  <span className="text-xs text-muted-foreground">
                    {formData.value === 'true' ? 'True' : 'False'}
                  </span>
                </div>
              ) : (
                <Input
                  value={formData.value}
                  onChange={(e) => setFormData({ ...formData, value: e.target.value })}
                  placeholder={formData.encrypted ? '••••••••' : 'Value'}
                  type={formData.encrypted ? 'password' : 'text'}
                  className="h-8 text-xs font-mono"
                />
              )}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs">{lang === 'ar' ? 'الفئة' : lang === 'fr' ? 'Catégorie' : 'Category'}</Label>
                <Select
                  value={formData.category}
                  onValueChange={(v) => setFormData({ ...formData, category: v })}
                >
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {['general', 'payment', 'sms', 'security', 'api', 'server'].map(cat => (
                      <SelectItem key={cat} value={cat} className="text-xs">
                        {getCategoryLabel(cat)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs">{lang === 'ar' ? 'نوع القيمة' : lang === 'fr' ? 'Type de valeur' : 'Value Type'}</Label>
                <Select
                  value={formData.valueType}
                  onValueChange={(v) => setFormData({ ...formData, valueType: v })}
                >
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {['string', 'number', 'boolean', 'json'].map(vt => (
                      <SelectItem key={vt} value={vt} className="text-xs">
                        {getValueTypeLabel(vt)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs">{lang === 'ar' ? 'الوصف' : lang === 'fr' ? 'Description' : 'Description'}</Label>
              <Input
                value={formData.description}
                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                placeholder={lang === 'ar' ? 'وصف اختياري' : lang === 'fr' ? 'Description optionnelle' : 'Optional description'}
                className="h-8 text-xs"
              />
            </div>

            <div className="flex items-center justify-between p-3 rounded-lg bg-amber-50 dark:bg-amber-900/10 border border-amber-200 dark:border-amber-800/30">
              <div className="flex items-center gap-2">
                <Lock className="h-4 w-4 text-amber-600" />
                <div>
                  <Label className="text-xs font-medium">
                    {lang === 'ar' ? 'تشفير القيمة' : lang === 'fr' ? 'Chiffrer la valeur' : 'Encrypt Value'}
                  </Label>
                  <p className="text-[10px] text-muted-foreground">
                    {lang === 'ar' ? 'استخدم للمفاتيح والأسرار' : lang === 'fr' ? 'Utiliser pour les clés et secrets' : 'Use for API keys and secrets'}
                  </p>
                </div>
              </div>
              <Switch
                checked={formData.encrypted}
                onCheckedChange={(v) => setFormData({ ...formData, encrypted: v })}
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setEditDialogOpen(false)} className="h-8 text-xs">
              {lang === 'ar' ? 'إلغاء' : lang === 'fr' ? 'Annuler' : 'Cancel'}
            </Button>
            <Button size="sm" onClick={handleSave} disabled={saving} className="h-8 text-xs bg-emerald-600 hover:bg-emerald-700">
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin me-1" /> : <Save className="h-3.5 w-3.5 me-1" />}
              {lang === 'ar' ? 'حفظ' : lang === 'fr' ? 'Sauvegarder' : 'Save'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ─── Delete Confirmation Dialog ─── */}

      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-red-600">
              <AlertTriangle className="h-5 w-5" />
              {lang === 'ar' ? 'تأكيد الحذف' : lang === 'fr' ? 'Confirmer la suppression' : 'Confirm Deletion'}
            </DialogTitle>
            <DialogDescription className="text-xs">
              {lang === 'ar'
                ? `هل أنت متأكد من حذف الإعداد "${deletingKey}"؟ لا يمكن التراجع عن هذا الإجراء.`
                : lang === 'fr'
                ? `Êtes-vous sûr de vouloir supprimer le paramètre "${deletingKey}" ? Cette action est irréversible.`
                : `Are you sure you want to delete setting "${deletingKey}"? This action cannot be undone.`
              }
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setDeleteDialogOpen(false)} className="h-8 text-xs">
              {lang === 'ar' ? 'إلغاء' : lang === 'fr' ? 'Annuler' : 'Cancel'}
            </Button>
            <Button variant="destructive" size="sm" onClick={handleDelete} disabled={deleting} className="h-8 text-xs">
              {deleting ? <Loader2 className="h-3.5 w-3.5 animate-spin me-1" /> : <Trash2 className="h-3.5 w-3.5 me-1" />}
              {lang === 'ar' ? 'حذف' : lang === 'fr' ? 'Supprimer' : 'Delete'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ─── Bulk Edit Dialog ─── */}

      <Dialog open={bulkDialogOpen} onOpenChange={setBulkDialogOpen}>
        <DialogContent className="sm:max-w-lg max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {lang === 'ar' ? 'تحرير مجمع' : lang === 'fr' ? 'Édition en masse' : 'Bulk Edit'}
            </DialogTitle>
            <DialogDescription className="text-xs">
              {lang === 'ar' ? 'أضف أو عدّل إعدادات متعددة في وقت واحد' : lang === 'fr' ? 'Ajoutez ou modifiez plusieurs paramètres à la fois' : 'Add or update multiple settings at once'}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            {bulkEntries.map((entry, index) => (
              <div key={index} className="flex items-end gap-2 p-2 rounded-lg bg-muted/30 border">
                <div className="flex-1 space-y-1">
                  <Label className="text-[10px] text-muted-foreground">{lang === 'ar' ? 'المفتاح' : lang === 'fr' ? 'Clé' : 'Key'}</Label>
                  <Input
                    value={entry.key}
                    onChange={(e) => {
                      const updated = [...bulkEntries]
                      updated[index] = { ...updated[index], key: e.target.value }
                      setBulkEntries(updated)
                    }}
                    placeholder="setting.key"
                    className="h-7 text-xs font-mono"
                  />
                </div>
                <div className="flex-1 space-y-1">
                  <Label className="text-[10px] text-muted-foreground">{lang === 'ar' ? 'القيمة' : lang === 'fr' ? 'Valeur' : 'Value'}</Label>
                  <Input
                    value={entry.value}
                    onChange={(e) => {
                      const updated = [...bulkEntries]
                      updated[index] = { ...updated[index], value: e.target.value }
                      setBulkEntries(updated)
                    }}
                    placeholder="value"
                    type={entry.encrypted ? 'password' : 'text'}
                    className="h-7 text-xs font-mono"
                  />
                </div>
                <div className="flex items-center gap-1 pb-0.5">
                  <Button
                    variant="ghost"
                    size="sm"
                    className={`h-7 w-7 p-0 ${entry.encrypted ? 'text-amber-500' : 'text-muted-foreground'}`}
                    onClick={() => {
                      const updated = [...bulkEntries]
                      updated[index] = { ...updated[index], encrypted: !updated[index].encrypted }
                      setBulkEntries(updated)
                    }}
                    title={entry.encrypted ? 'Encrypted' : 'Not encrypted'}
                  >
                    <Lock className="h-3.5 w-3.5" />
                  </Button>
                  {bulkEntries.length > 1 && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 w-7 p-0 text-red-500"
                      onClick={() => {
                        setBulkEntries(bulkEntries.filter((_, i) => i !== index))
                      }}
                    >
                      <XCircle className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </div>
              </div>
            ))}

            <Button
              variant="outline"
              size="sm"
              className="w-full h-8 text-xs"
              onClick={() => setBulkEntries([...bulkEntries, { key: '', value: '', encrypted: false }])}
            >
              <Plus className="h-3.5 w-3.5 me-1" />
              {lang === 'ar' ? 'إضافة صف' : lang === 'fr' ? 'Ajouter une ligne' : 'Add Row'}
            </Button>
          </div>

          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setBulkDialogOpen(false)} className="h-8 text-xs">
              {lang === 'ar' ? 'إلغاء' : lang === 'fr' ? 'Annuler' : 'Cancel'}
            </Button>
            <Button size="sm" onClick={handleBulkSave} disabled={bulkSaving} className="h-8 text-xs bg-emerald-600 hover:bg-emerald-700">
              {bulkSaving ? <Loader2 className="h-3.5 w-3.5 animate-spin me-1" /> : <Save className="h-3.5 w-3.5 me-1" />}
              {lang === 'ar' ? 'حفظ الكل' : lang === 'fr' ? 'Tout sauvegarder' : 'Save All'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </motion.div>
  )
}
