'use client'
import { apiFetch } from '@/lib/api-fetch';;

import { useState, useEffect } from 'react';
import { useLanguage } from '@/hooks/use-language';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Plus,
  Pencil,
  Trash2,
  HelpCircle,
  ChevronUp,
  ChevronDown,
  Loader2,
  Languages,
  GripVertical,
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { toast } from 'sonner';

interface FaqItem {
  id: string;
  question: string;
  questionFr: string | null;
  questionAr: string | null;
  answer: string;
  answerFr: string | null;
  answerAr: string | null;
  category: string;
  order: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

const CATEGORIES = [
  { id: 'SUBSCRIPTION', label: 'faqCategorySubscription' },
  { id: 'GENERAL', label: 'faqCategoryGeneral' },
  { id: 'PAYMENT', label: 'faqCategoryPayment' },
  { id: 'ACCOUNT', label: 'faqCategoryAccount' },
];

const emptyFaq: Omit<FaqItem, 'id' | 'createdAt' | 'updatedAt'> = {
  question: '',
  questionFr: '',
  questionAr: '',
  answer: '',
  answerFr: '',
  answerAr: '',
  category: 'SUBSCRIPTION',
  order: 0,
  isActive: true,
};

export function AdminFaqManager() {
  const { t, lang } = useLanguage();
  const [faqs, setFaqs] = useState<FaqItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState(emptyFaq);
  const [translationTab, setTranslationTab] = useState<'en' | 'ar' | 'fr'>('en');

  useEffect(() => {
    fetchFaqs();
  }, []);

  const fetchFaqs = async () => {
    setLoading(true);
    try {
      const res = await apiFetch('/api/admin/faqs');
      if (res.ok) {
        const data = await res.json();
        setFaqs(data.faqs);
      }
    } catch {
      toast.error(t('error'));
    } finally {
      setLoading(false);
    }
  };

  const handleOpenAdd = () => {
    setEditingId(null);
    setForm({ ...emptyFaq, order: faqs.length });
    setTranslationTab('en');
    setDialogOpen(true);
  };

  const handleOpenEdit = (faq: FaqItem) => {
    setEditingId(faq.id);
    setForm({
      question: faq.question,
      questionFr: faq.questionFr || '',
      questionAr: faq.questionAr || '',
      answer: faq.answer,
      answerFr: faq.answerFr || '',
      answerAr: faq.answerAr || '',
      category: faq.category,
      order: faq.order,
      isActive: faq.isActive,
    });
    setTranslationTab('en');
    setDialogOpen(true);
  };

  const handleSave = async () => {
    if (!form.question.trim() || !form.answer.trim()) {
      toast.error(lang === 'ar' ? 'السؤال والجواب مطلوبان' : lang === 'fr' ? 'La question et la réponse sont requises' : 'Question and answer are required');
      return;
    }
    setSaving(true);
    try {
      const url = editingId ? '/api/admin/faqs' : '/api/admin/faqs';
      const method = editingId ? 'PUT' : 'POST';
      const body = editingId
        ? { id: editingId, ...form }
        : form;

      const res = await apiFetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (res.ok) {
        toast.success(t('faqSaved'));
        setDialogOpen(false);
        fetchFaqs();
      } else {
        const data = await res.json();
        toast.error(data.error || t('error'));
      }
    } catch {
      toast.error(t('error'));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!deletingId) return;
    setSaving(true);
    try {
      const res = await apiFetch('/api/admin/faqs', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: deletingId }),
      });
      if (res.ok) {
        toast.success(t('faqDeleted'));
        setDeleteDialogOpen(false);
        setDeletingId(null);
        fetchFaqs();
      } else {
        toast.error(t('error'));
      }
    } catch {
      toast.error(t('error'));
    } finally {
      setSaving(false);
    }
  };

  const handleToggleActive = async (faq: FaqItem) => {
    try {
      const res = await apiFetch('/api/admin/faqs', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: faq.id, isActive: !faq.isActive }),
      });
      if (res.ok) {
        fetchFaqs();
      } else {
        toast.error(t('error'));
      }
    } catch {
      toast.error(t('error'));
    }
  };

  const handleReorder = async (faq: FaqItem, direction: 'up' | 'down') => {
    const idx = faqs.findIndex((f) => f.id === faq.id);
    if (direction === 'up' && idx === 0) return;
    if (direction === 'down' && idx === faqs.length - 1) return;

    const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
    const swapFaq = faqs[swapIdx];

    try {
      await Promise.all([
        apiFetch('/api/admin/faqs', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: faq.id, order: swapFaq.order }),
        }),
        apiFetch('/api/admin/faqs', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: swapFaq.id, order: faq.order }),
        }),
      ]);
      fetchFaqs();
    } catch {
      toast.error(t('error'));
    }
  };

  const getCategoryBadge = (category: string) => {
    const colors: Record<string, string> = {
      SUBSCRIPTION: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
      GENERAL: 'bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-400',
      PAYMENT: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
      ACCOUNT: 'bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-400',
    };
    const labels: Record<string, string> = {
      SUBSCRIPTION: t('faqCategorySubscription'),
      GENERAL: t('faqCategoryGeneral'),
      PAYMENT: t('faqCategoryPayment'),
      ACCOUNT: t('faqCategoryAccount'),
    };
    return (
      <Badge className={`text-[10px] font-medium px-1.5 py-0 ${colors[category] || 'bg-gray-100 text-gray-700'}`}>
        {labels[category] || category}
      </Badge>
    );
  };

  if (loading) {
    return (
      <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80">
        <CardContent className="p-6">
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-emerald-600" />
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <>
      <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80 dark:border-gray-800/50 dark:backdrop-blur-sm dark:shadow-gray-900/50">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base flex items-center gap-2">
              <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-emerald-200 to-emerald-300 dark:from-emerald-900/40 dark:to-emerald-800/40 flex items-center justify-center shadow-sm">
                <HelpCircle className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
              </div>
              {t('faqManagement')}
            </CardTitle>
            <Button
              onClick={handleOpenAdd}
              className="bg-emerald-600 hover:bg-emerald-700 text-white font-semibold rounded-xl h-9 gap-1.5 text-xs"
            >
              <Plus className="h-3.5 w-3.5" />
              {t('addFaq')}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">{t('faqManagementDesc')}</p>
        </CardHeader>
        <CardContent className="pt-0">
          {faqs.length === 0 ? (
            <div className="text-center py-8">
              <div className="h-12 w-12 rounded-xl bg-gray-100 dark:bg-gray-800 flex items-center justify-center mx-auto mb-3">
                <HelpCircle className="h-6 w-6 text-muted-foreground" />
              </div>
              <p className="text-sm text-muted-foreground">{t('faqNoItems')}</p>
            </div>
          ) : (
            <div className="space-y-2 max-h-[500px] overflow-y-auto">
              <AnimatePresence>
                {faqs.map((faq, idx) => (
                  <motion.div
                    key={faq.id}
                    initial={{ opacity: 0, y: 5 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, x: -20 }}
                    transition={{ delay: idx * 0.03 }}
                    className={`flex items-center gap-3 p-3 rounded-xl transition-colors ${
                      faq.isActive
                        ? 'bg-gray-50 dark:bg-gray-900/50 hover:bg-gray-100 dark:hover:bg-gray-900/80'
                        : 'bg-gray-50/50 dark:bg-gray-900/30 opacity-60'
                    }`}
                  >
                    {/* Grip + Reorder */}
                    <div className="flex flex-col items-center gap-0.5 flex-shrink-0">
                      <button
                        onClick={() => handleReorder(faq, 'up')}
                        disabled={idx === 0}
                        className="h-5 w-5 rounded flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-gray-200 dark:hover:bg-gray-700 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                      >
                        <ChevronUp className="h-3 w-3" />
                      </button>
                      <GripVertical className="h-3 w-3 text-muted-foreground" />
                      <button
                        onClick={() => handleReorder(faq, 'down')}
                        disabled={idx === faqs.length - 1}
                        className="h-5 w-5 rounded flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-gray-200 dark:hover:bg-gray-700 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                      >
                        <ChevronDown className="h-3 w-3" />
                      </button>
                    </div>

                    {/* FAQ Content */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="text-sm font-medium text-foreground truncate max-w-[300px]">
                          {faq.question}
                        </p>
                        {getCategoryBadge(faq.category)}
                        {!faq.isActive && (
                          <Badge variant="outline" className="text-[10px] text-muted-foreground">
                            {t('faqInactive')}
                          </Badge>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground mt-0.5 truncate max-w-[400px]">
                        {faq.answer}
                      </p>
                    </div>

                    {/* Active toggle */}
                    <div className="flex items-center gap-2 flex-shrink-0">
                      <Switch
                        checked={faq.isActive}
                        onCheckedChange={() => handleToggleActive(faq)}
                        aria-label={t('faqActive')}
                      />
                    </div>

                    {/* Actions */}
                    <div className="flex items-center gap-1 flex-shrink-0">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 rounded-lg hover:bg-emerald-50 dark:hover:bg-emerald-900/20"
                        onClick={() => handleOpenEdit(faq)}
                      >
                        <Pencil className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 rounded-lg hover:bg-red-50 dark:hover:bg-red-900/20"
                        onClick={() => {
                          setDeletingId(faq.id);
                          setDeleteDialogOpen(true);
                        }}
                      >
                        <Trash2 className="h-3.5 w-3.5 text-red-500 dark:text-red-400" />
                      </Button>
                    </div>
                  </motion.div>
                ))}
              </AnimatePresence>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Add/Edit Dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-lg max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <HelpCircle className="h-5 w-5 text-emerald-600" />
              {editingId ? t('editFaq') : t('addFaq')}
            </DialogTitle>
            <DialogDescription>
              {editingId
                ? lang === 'ar'
                  ? 'تعديل السؤال والترجمات'
                  : lang === 'fr'
                  ? 'Modifier la question et les traductions'
                  : 'Edit the question and translations'
                : lang === 'ar'
                ? 'إضافة سؤال شائع جديد'
                : lang === 'fr'
                ? 'Ajouter une nouvelle FAQ'
                : 'Add a new frequently asked question'}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            {/* Category + Order */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs font-medium text-muted-foreground">{t('faqCategory')}</Label>
                <Select value={form.category} onValueChange={(v) => setForm({ ...form, category: v })}>
                  <SelectTrigger className="h-9 text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CATEGORIES.map((cat) => (
                      <SelectItem key={cat.id} value={cat.id}>
                        {t(cat.label as any)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs font-medium text-muted-foreground">{t('faqOrder')}</Label>
                <Input
                  type="number"
                  min={0}
                  value={form.order}
                  onChange={(e) => setForm({ ...form, order: parseInt(e.target.value) || 0 })}
                  className="h-9 text-sm"
                />
              </div>
            </div>

            {/* Active toggle */}
            <div className="flex items-center justify-between p-3 rounded-xl bg-gray-50 dark:bg-gray-900/50">
              <Label className="text-sm font-medium">{t('faqActive')}</Label>
              <Switch
                checked={form.isActive}
                onCheckedChange={(checked) => setForm({ ...form, isActive: checked })}
              />
            </div>

            {/* Translation Tabs */}
            <div className="space-y-3">
              <Label className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
                <Languages className="h-3 w-3" />
                {t('faqTranslations')}
              </Label>
              <div className="flex gap-1.5">
                {[
                  { id: 'en' as const, label: t('faqEnglish') },
                  { id: 'ar' as const, label: t('faqArabic') },
                  { id: 'fr' as const, label: t('faqFrench') },
                ].map((tab) => (
                  <button
                    key={tab.id}
                    onClick={() => setTranslationTab(tab.id)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                      translationTab === tab.id
                        ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400'
                        : 'bg-gray-100 dark:bg-gray-800 text-muted-foreground hover:bg-gray-200 dark:hover:bg-gray-700'
                    }`}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>

              {/* English */}
              {translationTab === 'en' && (
                <div className="space-y-3">
                  <div className="space-y-1.5">
                    <Label className="text-xs font-medium">{t('faqQuestion')} {t('inEnglish')}</Label>
                    <Input
                      value={form.question}
                      onChange={(e) => setForm({ ...form, question: e.target.value })}
                      placeholder={t('faqQuestionEnPlaceholder')}
                      className="text-sm"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs font-medium">{t('faqAnswer')} {t('inEnglish')}</Label>
                    <Textarea
                      value={form.answer}
                      onChange={(e) => setForm({ ...form, answer: e.target.value })}
                      placeholder={t('faqAnswerEnPlaceholder')}
                      className="text-sm min-h-[80px]"
                    />
                  </div>
                </div>
              )}

              {/* Arabic */}
              {translationTab === 'ar' && (
                <div className="space-y-3" dir="rtl">
                  <div className="space-y-1.5">
                    <Label className="text-xs font-medium">{t('faqQuestion')} (العربية)</Label>
                    <Input
                      value={form.questionAr || ''}
                      onChange={(e) => setForm({ ...form, questionAr: e.target.value })}
                      placeholder="أدخل السؤال بالعربية"
                      className="text-sm"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs font-medium">{t('faqAnswer')} (العربية)</Label>
                    <Textarea
                      value={form.answerAr || ''}
                      onChange={(e) => setForm({ ...form, answerAr: e.target.value })}
                      placeholder="أدخل الجواب بالعربية"
                      className="text-sm min-h-[80px]"
                    />
                  </div>
                </div>
              )}

              {/* French */}
              {translationTab === 'fr' && (
                <div className="space-y-3">
                  <div className="space-y-1.5">
                    <Label className="text-xs font-medium">{t('faqQuestion')} (Français)</Label>
                    <Input
                      value={form.questionFr || ''}
                      onChange={(e) => setForm({ ...form, questionFr: e.target.value })}
                      placeholder="Entrez la question en français"
                      className="text-sm"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs font-medium">{t('faqAnswer')} (Français)</Label>
                    <Textarea
                      value={form.answerFr || ''}
                      onChange={(e) => setForm({ ...form, answerFr: e.target.value })}
                      placeholder="Entrez la réponse en français"
                      className="text-sm min-h-[80px]"
                    />
                  </div>
                </div>
              )}
            </div>
          </div>

          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" onClick={() => setDialogOpen(false)} disabled={saving} className="rounded-xl">
              {lang === 'ar' ? 'إلغاء' : lang === 'fr' ? 'Annuler' : 'Cancel'}
            </Button>
            <Button
              onClick={handleSave}
              disabled={saving || !form.question.trim() || !form.answer.trim()}
              className="bg-emerald-600 hover:bg-emerald-700 text-white font-semibold rounded-xl gap-1.5"
            >
              {saving ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Plus className="h-4 w-4" />
              )}
              {editingId
                ? lang === 'ar' ? 'حفظ التعديلات' : lang === 'fr' ? 'Enregistrer' : 'Save Changes'
                : t('addFaq')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('deleteFaq')}</AlertDialogTitle>
            <AlertDialogDescription>{t('faqDeleteConfirm')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={saving}>
              {lang === 'ar' ? 'إلغاء' : lang === 'fr' ? 'Annuler' : 'Cancel'}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={saving}
              className="bg-red-600 hover:bg-red-700 text-white"
            >
              {saving && <Loader2 className="h-4 w-4 animate-spin me-2" />}
              {t('deleteFaq')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
