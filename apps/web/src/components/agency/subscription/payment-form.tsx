'use client'
import { apiFetch } from '@/lib/api-fetch';;

import { useState, useEffect, useRef, useCallback } from 'react';
import { useAppStore } from '@/store/use-app-store';
import { useLanguage } from '@/hooks/use-language';
import { useUpload } from '@/hooks/use-upload';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  Check,
  Star,
  Upload,
  CreditCard,
  Loader2,
  X,
  FileText,
  ImageIcon,
  Info,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Building2,
  Landmark,
  Wallet,
  ClipboardCheck,
  CircleDollarSign,
  Receipt,
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { toast } from 'sonner';

interface PaymentFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedPlan: string;
  onSuccess: () => void;
}

export function PaymentForm({
  open,
  onOpenChange,
  selectedPlan,
  onSuccess,
}: PaymentFormProps) {
  const { user } = useAppStore();
  const { t, lang } = useLanguage();
  const [paymentMethod, setPaymentMethod] = useState('CCP');
  const [receiptFile, setReceiptFile] = useState<File | null>(null);
  const [receiptPreview, setReceiptPreview] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const [expandedInstructions, setExpandedInstructions] = useState<string | null>(null);
  const [paymentStep, setPaymentStep] = useState(1); // 1=method, 2=receipt, 3=review
  const [showSuccessAnimation, setShowSuccessAnimation] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const receiptUpload = useUpload({
    type: 'receipt',
    maxSize: 5 * 1024 * 1024,
    onError: (error) => {
      toast.error(error);
    },
  });

  // Reset state when dialog opens/closes
  useEffect(() => {
    if (open) {
      setPaymentStep(1);
      setPaymentMethod('CCP');
      setReceiptFile(null);
      setReceiptPreview(null);
      setExpandedInstructions(null);
      setShowSuccessAnimation(false);
    }
  }, [open]);

  const getPlanName = (plan: string) => {
    if (plan === 'PREMIUM') return t('premiumPlan');
    return t('basicPlan');
  };

  const getPlanPrice = (plan: string) => {
    if (plan === 'PREMIUM') return t('premiumPrice');
    return t('basicPrice');
  };

  const getPlanAmount = (plan: string) => {
    if (plan === 'PREMIUM') return '3,000';
    return '2,000';
  };

  const getPaymentMethodLabel = (method: string) => {
    if (method === 'CCP') return t('ccpTransfer');
    if (method === 'BANK_TRANSFER') return t('bankTransfer');
    return t('electronicPayment');
  };

  const paymentMethods = [
    {
      id: 'CCP',
      label: t('ccpTransfer'),
      instructions: t('ccpInstructions'),
      icon: Landmark,
      description: lang === 'ar' ? 'تحويل عبر بريد الجزائر' : lang === 'fr' ? 'Virement via Poste Algérienne' : 'Transfer via Algerian Post',
    },
    {
      id: 'BANK_TRANSFER',
      label: t('bankTransfer'),
      instructions: t('bankInstructions'),
      icon: Building2,
      description: lang === 'ar' ? 'تحويل مصرفي مباشر' : lang === 'fr' ? 'Virement bancaire direct' : 'Direct bank transfer',
    },
    {
      id: 'ELECTRONIC',
      label: t('electronicPayment'),
      instructions: t('eWalletInstructions'),
      icon: Wallet,
      description: lang === 'ar' ? 'باريدي موب أو محفظة إلكترونية' : lang === 'fr' ? 'BaridiMob ou e-wallet' : 'BaridiMob or e-wallet',
    },
  ];

  const dialogSteps = [
    { step: 1, label: t('stepPaymentMethod'), icon: CreditCard },
    { step: 2, label: t('stepReceipt'), icon: Upload },
    { step: 3, label: t('stepReview'), icon: CheckCircle2 },
  ];

  const getFileSize = () => {
    if (!receiptFile) return '';
    const size = receiptFile.size;
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      toast.error(t('fileTooLarge'));
      return;
    }
    setReceiptFile(file);
    if (file.type.startsWith('image/')) {
      const reader = new FileReader();
      reader.onloadend = () => setReceiptPreview(reader.result as string);
      reader.readAsDataURL(file);
    } else {
      setReceiptPreview(null);
    }
  };

  const handleDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      toast.error(t('fileTooLarge'));
      return;
    }
    const validTypes = ['image/jpeg', 'image/png', 'application/pdf'];
    if (!validTypes.some((type) => file.type.startsWith(type))) {
      toast.error(t('receiptNote'));
      return;
    }
    setReceiptFile(file);
    if (file.type.startsWith('image/')) {
      const reader = new FileReader();
      reader.onloadend = () => setReceiptPreview(reader.result as string);
      reader.readAsDataURL(file);
    } else {
      setReceiptPreview(null);
    }
  }, [t]);

  const handleDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
  }, []);

  const handleRemoveFile = () => {
    setReceiptFile(null);
    setReceiptPreview(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleSubmitPayment = async () => {
    if (!receiptFile) {
      toast.error(t('uploadReceipt'));
      return;
    }
    setSubmitting(true);
    try {
      const uploadResult = await receiptUpload.upload(receiptFile);
      if (!uploadResult.url) {
        toast.error(uploadResult.error || t('error'));
        return;
      }
      const receiptUrl = uploadResult.url;
      const payForm = new FormData();
      payForm.append('plan', selectedPlan);
      payForm.append('method', paymentMethod);
      payForm.append('receiptUrl', receiptUrl);

      const res = await apiFetch('/api/agency/subscription/pay', {
        method: 'POST',
        body: payForm,
      });

      if (res.ok) {
        setShowSuccessAnimation(true);
        toast.success(t('submitPayment'));
        handleRemoveFile();
        receiptUpload.reset();
        // Auto close after success animation
        setTimeout(() => {
          setShowSuccessAnimation(false);
          onOpenChange(false);
          onSuccess();
        }, 3000);
      } else {
        const d = await res.json();
        toast.error(d.error || t('error'));
      }
    } catch {
      toast.error(t('error'));
    } finally {
      setSubmitting(false);
    }
  };

  const canGoNext = () => {
    if (paymentStep === 1) return !!paymentMethod;
    if (paymentStep === 2) return !!receiptFile;
    return true;
  };

  const handleNext = () => {
    if (paymentStep < 3 && canGoNext()) {
      setPaymentStep(paymentStep + 1);
    } else if (paymentStep === 3) {
      handleSubmitPayment();
    }
  };

  const handleBack = () => {
    if (paymentStep > 1) setPaymentStep(paymentStep - 1);
  };

  // Plan info for header
  const planIcon = selectedPlan === 'PREMIUM' ? Star : Building2;
  const PlanIcon = planIcon;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg p-0 gap-0 overflow-hidden" showCloseButton={!submitting}>
        {/* ─── Dialog Header with Plan Info ─── */}
        <div className="relative overflow-hidden bg-gradient-to-br from-emerald-600 via-emerald-500 to-teal-500 p-5 text-white">
          <div className="absolute -top-6 -right-6 h-24 w-24 rounded-full bg-white/10" />
          <div className="absolute bottom-2 -left-4 h-16 w-16 rounded-full bg-white/5" />

          {!showSuccessAnimation ? (
            <div className="relative z-10">
              <DialogHeader>
                <DialogTitle className="text-white flex items-center gap-2 text-lg">
                  <CreditCard className="h-5 w-5" />
                  {t('paymentDialogTitle')}
                </DialogTitle>
                <DialogDescription className="text-emerald-100 text-sm">
                  {t('paymentDialogDesc')}
                </DialogDescription>
              </DialogHeader>
              {/* Selected plan badge */}
              <div className="mt-3 flex items-center gap-3 bg-white/15 backdrop-blur-sm rounded-xl p-3">
                <div className="h-10 w-10 rounded-xl bg-white/20 flex items-center justify-center flex-shrink-0">
                  <PlanIcon className="h-5 w-5 text-white" />
                </div>
                <div className="flex-1">
                  <p className="text-sm font-semibold text-white">{getPlanName(selectedPlan)}</p>
                  <p className="text-xs text-emerald-100">{getPlanPrice(selectedPlan)}</p>
                </div>
                <div className="text-end">
                  <p className="text-xl font-extrabold text-white">{getPlanAmount(selectedPlan)}</p>
                  <p className="text-[10px] text-emerald-100">{t('currency')}/{t('perMonth')}</p>
                </div>
              </div>
            </div>
          ) : (
            <div className="relative z-10 flex flex-col items-center py-4">
              <motion.div
                initial={{ scale: 0 }}
                animate={{ scale: 1 }}
                transition={{ type: 'spring', bounce: 0.5, duration: 0.8 }}
                className="h-16 w-16 rounded-full bg-white/20 flex items-center justify-center mb-3"
              >
                <motion.div
                  initial={{ scale: 0 }}
                  animate={{ scale: 1 }}
                  transition={{ delay: 0.3, type: 'spring', bounce: 0.5 }}
                >
                  <Check className="h-8 w-8 text-white" strokeWidth={3} />
                </motion.div>
              </motion.div>
              <motion.h3
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.4 }}
                className="text-lg font-bold text-white mb-1"
              >
                {t('success')}!
              </motion.h3>
              <motion.p
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.5 }}
                className="text-sm text-emerald-100 text-center"
              >
                {t('paymentReviewInfo')}
              </motion.p>
            </div>
          )}
        </div>

        {/* ─── Step Indicator ─── */}
        {!showSuccessAnimation && (
          <div className="px-5 pt-4 pb-2">
            <div className="flex items-center gap-2">
              {dialogSteps.map((item, idx) => {
                const StepIcon = item.icon;
                const isActive = paymentStep >= item.step;
                const isCurrent = paymentStep === item.step;
                const isCompleted = paymentStep > item.step;
                return (
                  <div key={item.step} className="flex items-center flex-1">
                    <div className="flex items-center gap-2 flex-1">
                      <motion.div
                        animate={isCurrent ? { scale: [1, 1.05, 1] } : {}}
                        transition={{ duration: 0.3 , ease: 'easeInOut' }}
                        className={`h-8 w-8 rounded-full flex items-center justify-center flex-shrink-0 transition-all duration-300 ${
                          isActive
                            ? 'bg-gradient-to-br from-emerald-500 to-teal-500 text-white shadow-md shadow-emerald-500/20'
                            : 'bg-gray-100 dark:bg-gray-800 text-muted-foreground'
                        }`}
                      >
                        {isCompleted ? (
                          <Check className="h-3.5 w-3.5" />
                        ) : (
                          <StepIcon className="h-3.5 w-3.5" />
                        )}
                      </motion.div>
                      <span className={`text-[11px] font-medium transition-colors duration-300 hidden sm:block ${
                        isActive ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground'
                      }`}>
                        {item.label}
                      </span>
                    </div>
                    {idx < dialogSteps.length - 1 && (
                      <div className="relative h-0.5 flex-1 mx-1 rounded-full overflow-hidden bg-gray-200 dark:bg-gray-700">
                        <motion.div
                          initial={{ width: 0 }}
                          animate={{ width: isCompleted ? '100%' : isCurrent ? '50%' : '0%' }}
                          transition={{ duration: 0.4 }}
                          className="absolute inset-y-0 left-0 bg-gradient-to-r from-emerald-500 to-teal-500 rounded-full"
                        />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ─── Step Content ─── */}
        {!showSuccessAnimation && (
          <div className="px-5 py-4 min-h-[320px]">
            <AnimatePresence mode="wait">
              {/* Step 1: Payment Method */}
              {paymentStep === 1 && (
                <motion.div
                  key="step1"
                  initial={{ opacity: 0, x: 20 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -20 }}
                  transition={{ duration: 0.2 }}
                  className="space-y-4"
                >
                  <div className="space-y-3">
                    <Label className="text-sm font-semibold flex items-center gap-2">
                      <CircleDollarSign className="h-4 w-4 text-emerald-600" />
                      {lang === 'ar' ? 'اختر طريقة الدفع' : lang === 'fr' ? 'Choisir la méthode de paiement' : 'Choose Payment Method'}
                    </Label>
                    <div className="space-y-2.5">
                      {paymentMethods.map((method) => {
                        const MethodIcon = method.icon;
                        const isSelected = paymentMethod === method.id;
                        const isExpanded = expandedInstructions === method.id;

                        return (
                          <div key={method.id} className="space-y-1.5">
                            <motion.div
                              whileHover={{ scale: 1.01 }}
                              whileTap={{ scale: 0.99 }}
                              onClick={() => setPaymentMethod(method.id)}
                              className={`relative cursor-pointer rounded-xl border-2 p-3.5 transition-all duration-300 ${
                                isSelected
                                  ? 'border-emerald-500 bg-emerald-50 dark:bg-emerald-900/20 shadow-md'
                                  : 'border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900/50 hover:border-emerald-300 dark:hover:border-emerald-700'
                              }`}
                            >
                              {isSelected && (
                                <motion.div
                                  initial={{ scale: 0 }}
                                  animate={{ scale: 1 }}
                                  className="absolute top-2 end-2 h-5 w-5 rounded-full bg-emerald-500 flex items-center justify-center"
                                >
                                  <Check className="h-3 w-3 text-white" />
                                </motion.div>
                              )}
                              <div className="flex items-center gap-3">
                                <div className={`h-10 w-10 rounded-xl flex items-center justify-center flex-shrink-0 ${
                                  isSelected
                                    ? 'bg-emerald-500 text-white'
                                    : 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-400'
                                }`}>
                                  <MethodIcon className="h-5 w-5" />
                                </div>
                                <div className="flex-1 min-w-0">
                                  <p className="text-sm font-semibold text-foreground">{method.label}</p>
                                  <p className="text-[11px] text-muted-foreground mt-0.5">{method.description}</p>
                                </div>
                              </div>
                            </motion.div>

                            {/* Expand/Collapse instructions */}
                            <button
                              type="button"
                              onClick={() => setExpandedInstructions(isExpanded ? null : method.id)}
                              className={`w-full text-xs flex items-center justify-center gap-1 py-1 rounded-lg transition-colors ${
                                isSelected
                                  ? 'text-emerald-600 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-900/20'
                                  : 'text-muted-foreground hover:text-foreground hover:bg-gray-50 dark:hover:bg-gray-800/30'
                              }`}
                            >
                              {t('paymentInstructions')}
                              <motion.span animate={{ rotate: isExpanded ? 180 : 0 }} transition={{ duration: 0.2 }}>
                                <ChevronDown className="h-3 w-3" />
                              </motion.span>
                            </button>

                            <AnimatePresence>
                              {isExpanded && (
                                <motion.div
                                  initial={{ opacity: 0, height: 0 }}
                                  animate={{ opacity: 1, height: 'auto' }}
                                  exit={{ opacity: 0, height: 0 }}
                                  className="overflow-hidden"
                                >
                                  <div className="p-3 rounded-xl bg-amber-50 dark:bg-amber-900/10 border border-amber-200/60 dark:border-amber-800/30">
                                    <div className="flex items-start gap-2 mb-2">
                                      <Info className="h-4 w-4 text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" />
                                      <div>
                                        <p className="text-xs font-semibold text-amber-700 dark:text-amber-400">{t('paymentInstructions')}</p>
                                        <p className="text-[11px] text-amber-600 dark:text-amber-300 mt-0.5">{t('paymentInstructionsDesc')}</p>
                                      </div>
                                    </div>
                                    <p className="text-[11px] text-muted-foreground leading-relaxed">{method.instructions}</p>
                                  </div>
                                </motion.div>
                              )}
                            </AnimatePresence>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </motion.div>
              )}

              {/* Step 2: Receipt Upload */}
              {paymentStep === 2 && (
                <motion.div
                  key="step2"
                  initial={{ opacity: 0, x: 20 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -20 }}
                  transition={{ duration: 0.2 }}
                  className="space-y-4"
                >
                  <Label className="text-sm font-semibold flex items-center gap-2">
                    <Receipt className="h-4 w-4 text-emerald-600" />
                    {t('uploadReceipt')}
                  </Label>

                  {receiptFile && receiptPreview ? (
                    <motion.div
                      initial={{ opacity: 0, scale: 0.95 }}
                      animate={{ opacity: 1, scale: 1 }}
                      className="relative rounded-xl border border-border overflow-hidden"
                    >
                      <img
                        src={receiptPreview}
                        alt="Receipt preview"
                        className="max-h-48 w-full object-contain bg-gray-50 dark:bg-gray-900"
                      />
                      <button
                        onClick={handleRemoveFile}
                        className="absolute top-2 end-2 h-7 w-7 rounded-full bg-black/50 hover:bg-black/70 text-white flex items-center justify-center transition-colors"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </motion.div>
                  ) : receiptFile ? (
                    <motion.div
                      initial={{ opacity: 0, scale: 0.95 }}
                      animate={{ opacity: 1, scale: 1 }}
                      className="flex items-center gap-3 p-4 rounded-xl border border-border bg-gray-50 dark:bg-gray-900"
                    >
                      <div className="h-10 w-10 rounded-lg bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center flex-shrink-0">
                        {receiptFile.type === 'application/pdf' ? (
                          <FileText className="h-5 w-5 text-red-500" />
                        ) : (
                          <ImageIcon className="h-5 w-5 text-emerald-600" />
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-foreground truncate">{receiptFile.name}</p>
                        <p className="text-xs text-muted-foreground">{getFileSize()}</p>
                      </div>
                      <button
                        onClick={handleRemoveFile}
                        className="h-7 w-7 rounded-full hover:bg-gray-200 dark:hover:bg-gray-800 flex items-center justify-center transition-colors"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </motion.div>
                  ) : (
                    <div
                      onDrop={handleDrop}
                      onDragOver={handleDragOver}
                      onDragLeave={handleDragLeave}
                      className={`relative rounded-xl border-2 border-dashed transition-all duration-300 ${
                        isDragOver
                          ? 'border-emerald-500 bg-emerald-50 dark:bg-emerald-900/20 scale-[1.01]'
                          : 'border-gray-300 dark:border-gray-700 hover:border-emerald-400 dark:hover:border-emerald-600 hover:bg-emerald-50/30 dark:hover:bg-emerald-900/10'
                      }`}
                    >
                      <label className="flex flex-col items-center justify-center gap-3 p-8 cursor-pointer">
                        <motion.div
                          animate={isDragOver ? { scale: 1.1, rotate: 5 } : { scale: 1, rotate: 0 }}
                          className={`h-14 w-14 rounded-2xl flex items-center justify-center transition-colors ${
                            isDragOver
                              ? 'bg-emerald-200 dark:bg-emerald-800/50'
                              : 'bg-emerald-100 dark:bg-emerald-900/30'
                          }`}
                        >
                          <Upload className={`h-7 w-7 transition-colors ${
                            isDragOver ? 'text-emerald-700 dark:text-emerald-300' : 'text-emerald-600 dark:text-emerald-400'
                          }`} />
                        </motion.div>
                        <div className="text-center">
                          <p className="text-sm font-medium text-foreground">
                            {isDragOver
                              ? (lang === 'ar' ? 'أفلت الملف هنا' : lang === 'fr' ? 'Déposez le fichier ici' : 'Drop file here')
                              : t('uploadReceipt')
                            }
                          </p>
                          <p className="text-xs text-muted-foreground mt-1">{t('receiptNote')}</p>
                          <div className="flex items-center justify-center gap-3 mt-2">
                            <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
                              <ImageIcon className="h-3 w-3" /> JPG, PNG
                            </span>
                            <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
                              <FileText className="h-3 w-3" /> PDF
                            </span>
                          </div>
                        </div>
                        <input
                          ref={fileInputRef}
                          type="file"
                          accept=".jpg,.jpeg,.png,.pdf"
                          onChange={handleFileChange}
                          className="hidden"
                        />
                      </label>
                    </div>
                  )}

                  {/* Upload Progress */}
                  {receiptUpload.uploading && (
                    <motion.div initial={{ opacity: 0, y: 5 }} animate={{ opacity: 1, y: 0 }} className="space-y-1.5">
                      <div className="flex items-center justify-between text-xs">
                        <span className="text-muted-foreground">
                          {lang === 'ar' ? 'جاري الرفع...' : lang === 'fr' ? 'Téléchargement...' : 'Uploading...'}
                        </span>
                        <span className="text-emerald-600 dark:text-emerald-400 font-medium">{receiptUpload.progress}%</span>
                      </div>
                      <div className="h-1.5 rounded-full bg-gray-200 dark:bg-gray-700 overflow-hidden">
                        <motion.div
                          initial={{ width: 0 }}
                          animate={{ width: `${receiptUpload.progress}%` }}
                          className="h-full bg-gradient-to-r from-emerald-500 to-teal-500 rounded-full"
                          transition={{ duration: 0.3 }}
                        />
                      </div>
                    </motion.div>
                  )}

                  {/* Receipt Upload Success Indicator */}
                  {receiptFile && !receiptUpload.uploading && (
                    <motion.div
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="flex items-center gap-3 p-3 rounded-xl bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-800"
                    >
                      <div className="h-8 w-8 rounded-full bg-emerald-100 dark:bg-emerald-800/40 flex items-center justify-center flex-shrink-0">
                        <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-emerald-700 dark:text-emerald-400">{t('receiptUploadedSuccess')}</p>
                        <p className="text-xs text-muted-foreground truncate">{receiptFile.name} &middot; {getFileSize()}</p>
                      </div>
                    </motion.div>
                  )}

                  {/* Info box */}
                  <div className="flex items-start gap-3 p-3 rounded-xl bg-amber-50 dark:bg-amber-900/10 border border-amber-200/60 dark:border-amber-800/30">
                    <Info className="h-4 w-4 text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" />
                    <p className="text-xs text-amber-800 dark:text-amber-300 leading-relaxed">
                      {t('receiptNote')}
                    </p>
                  </div>
                </motion.div>
              )}

              {/* Step 3: Review & Submit */}
              {paymentStep === 3 && (
                <motion.div
                  key="step3"
                  initial={{ opacity: 0, x: 20 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -20 }}
                  transition={{ duration: 0.2 }}
                  className="space-y-4"
                >
                  <div className="space-y-2.5">
                    {/* Order Summary Card */}
                    <div className="rounded-xl border border-emerald-200 dark:border-emerald-800/50 bg-gradient-to-b from-emerald-50/50 to-teal-50/50 dark:from-emerald-900/10 dark:to-teal-900/10 p-4">
                      <h4 className="text-sm font-semibold text-foreground flex items-center gap-2 mb-3">
                        <ClipboardCheck className="h-4 w-4 text-emerald-600" />
                        {lang === 'ar' ? 'ملخص الطلب' : lang === 'fr' ? 'Résumé de la commande' : 'Order Summary'}
                      </h4>
                      <div className="space-y-2.5">
                        <div className="flex items-center justify-between">
                          <span className="text-xs text-muted-foreground">{t('selectPlan')}</span>
                          <span className="text-sm font-medium text-foreground">{getPlanName(selectedPlan)}</span>
                        </div>
                        <div className="flex items-center justify-between">
                          <span className="text-xs text-muted-foreground">
                            {lang === 'ar' ? 'طريقة الدفع' : lang === 'fr' ? 'Mode de paiement' : 'Payment Method'}
                          </span>
                          <span className="text-sm font-medium text-foreground">{getPaymentMethodLabel(paymentMethod)}</span>
                        </div>
                        <div className="flex items-center justify-between">
                          <span className="text-xs text-muted-foreground">{t('uploadReceipt')}</span>
                          <span className="text-sm font-medium text-emerald-600 dark:text-emerald-400 flex items-center gap-1">
                            <CheckCircle2 className="h-3.5 w-3.5" />
                            {t('receiptUploadedSuccess')}
                          </span>
                        </div>
                        <Separator className="bg-emerald-200/50 dark:bg-emerald-800/30" />
                        <div className="flex items-center justify-between">
                          <span className="text-sm font-semibold text-foreground">
                            {lang === 'ar' ? 'المجموع' : 'Total'}
                          </span>
                          <span className="text-lg font-extrabold text-emerald-600 dark:text-emerald-400">
                            {getPlanAmount(selectedPlan)} {t('currency')}
                          </span>
                        </div>
                      </div>
                    </div>

                    {/* Payment review info */}
                    <div className="flex items-start gap-3 p-3 rounded-xl bg-amber-50 dark:bg-amber-900/10 border border-amber-200/60 dark:border-amber-800/30">
                      <Info className="h-4 w-4 text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" />
                      <p className="text-xs text-amber-800 dark:text-amber-300 leading-relaxed">
                        {t('paymentReviewInfo')}
                      </p>
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        )}

        {/* ─── Dialog Footer with Navigation ─── */}
        {!showSuccessAnimation && (
          <DialogFooter className="px-5 pb-5 pt-2 gap-2 sm:gap-0 border-t border-border/50">
            <div className="flex items-center gap-2 w-full">
              {paymentStep > 1 && (
                <Button
                  variant="outline"
                  onClick={handleBack}
                  disabled={submitting}
                  className="flex-1 sm:flex-none"
                >
                  <ChevronLeft className={`h-4 w-4 ${lang === 'ar' ? 'rotate-180' : ''} me-1`} />
                  {t('back')}
                </Button>
              )}
              <Button
                className={`bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white font-semibold ${
                  paymentStep === 1 ? 'w-full' : 'flex-1'
                }`}
                onClick={handleNext}
                disabled={submitting || !canGoNext()}
              >
                {submitting ? (
                  <Loader2 className="h-4 w-4 animate-spin me-2" />
                ) : paymentStep === 3 ? (
                  <Check className="h-4 w-4 me-2" />
                ) : (
                  <ChevronRight className={`h-4 w-4 ${lang === 'ar' ? 'rotate-180' : ''} me-1`} />
                )}
                {paymentStep === 3 ? t('confirm') : t('next')}
              </Button>
            </div>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
