'use client';

import React, { useState } from 'react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Slider } from '@/components/ui/slider';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { toast } from 'sonner';
import { motion } from 'framer-motion';
import { useLanguage } from '@/hooks/use-language';
import {
  Building2,
  Monitor,
  CreditCard,
  CalendarClock,
  Save,
  Loader2,
  Calculator,
  Receipt,
} from 'lucide-react';

export default function EnterprisePlanConfigurator() {
  const { t, lang } = useLanguage();
  const isArabic = lang === 'ar';

  const [branches, setBranches] = useState([5]);
  const [receptions, setReceptions] = useState([10]);
  const [commitment, setCommitment] = useState('COMMIT_3YR');
  const [hardwareUpfront, setHardwareUpfront] = useState(false);
  const [agencyName, setAgencyName] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [saving, setSaving] = useState(false);

  const calculateTotalPlanCosts = () => {
    let basePrice = 28000;
    const extraBranches = Math.max(0, branches[0] - 3);
    const extraReceptions = Math.max(0, receptions[0] - 6);
    basePrice += (extraBranches * 3500) + (extraReceptions * 1500);

    let hardwareMonthlyAddition = 0;
    let upfrontHardwareCost = 0;

    if (!hardwareUpfront) {
      if (commitment === 'COMMIT_1YR') hardwareMonthlyAddition = 10000;
      if (commitment === 'COMMIT_2YR') hardwareMonthlyAddition = 4500;
      if (commitment === 'COMMIT_3YR') hardwareMonthlyAddition = 3000;
      if (commitment === 'COMMIT_4YR') hardwareMonthlyAddition = 2400;
    } else {
      upfrontHardwareCost = 100000 + (Math.max(0, receptions[0] - 1) * 40000);
      if (commitment === 'COMMIT_1YR') hardwareMonthlyAddition = 4000;
      if (commitment === 'COMMIT_2YR') hardwareMonthlyAddition = 2000;
      if (commitment === 'COMMIT_3YR') hardwareMonthlyAddition = 1200;
      if (commitment === 'COMMIT_4YR') hardwareMonthlyAddition = 1000;
    }

    const totalMonthlyHardwareLease = receptions[0] * hardwareMonthlyAddition;
    return {
      monthlySoftware: basePrice,
      monthlyHardware: totalMonthlyHardwareLease,
      upfrontHardware: upfrontHardwareCost,
      totalRecurring: basePrice + totalMonthlyHardwareLease
    };
  };

  const costSummary = calculateTotalPlanCosts();

  const handleSave = () => {
    setSaving(true);
    // In a real implementation, this would POST to an API
    setTimeout(() => {
      toast.success(
        isArabic
          ? 'تم حفظ ملف المؤسسة بنجاح'
          : 'Enterprise profile saved successfully'
      );
      setSaving(false);
    }, 800);
  };

  return (
    <div className="p-4 lg:p-6">
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        className="mb-6"
      >
        <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
          <Building2 className="h-6 w-6 text-emerald-600" />
          {isArabic ? 'مهيئ عقود المؤسسات والحكومة' : 'Enterprise & Government Contract Configurator'}
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          {isArabic
            ? 'أنشئ عقوداً مخصصة للمؤسسات والهيئات الحكومية'
            : 'Create custom contracts for enterprises and government institutions'}
        </p>
      </motion.div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <motion.div
          initial={{ opacity: 0, y: 15 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.05 }}
          className="lg:col-span-2"
        >
          <Card className="shadow-sm border-0">
            <CardHeader>
              <CardTitle className="text-xl font-bold flex items-center gap-2">
                <Calculator className="h-5 w-5 text-emerald-600" />
                {isArabic ? 'تكوين العقد' : 'Contract Configuration'}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-8">
              {/* Branch Allocator */}
              <div className="space-y-3">
                <div className="flex justify-between font-medium">
                  <label className="flex items-center gap-2 text-sm">
                    <Building2 className="h-4 w-4 text-emerald-600" />
                    {isArabic ? 'عدد الفروع' : 'Target Branch Fleet Allocation'}
                  </label>
                  <span className="text-emerald-600 font-bold text-sm bg-emerald-50 dark:bg-emerald-900/20 px-2.5 py-1 rounded-lg">
                    {branches[0]} {isArabic ? 'فروع' : 'Branches'}
                  </span>
                </div>
                <Slider value={branches} onValueChange={setBranches} min={1} max={50} step={1} />
                <div className="flex justify-between text-[10px] text-muted-foreground">
                  <span>1</span>
                  <span>50</span>
                </div>
              </div>

              {/* Counter/Reception Allocator */}
              <div className="space-y-3">
                <div className="flex justify-between font-medium">
                  <label className="flex items-center gap-2 text-sm">
                    <Monitor className="h-4 w-4 text-teal-600" />
                    {isArabic ? 'عدد الشبابيك / أجهزة الاستقبال' : 'Counters / Reception Terminals per Branch'}
                  </label>
                  <span className="text-teal-600 font-bold text-sm bg-teal-50 dark:bg-teal-900/20 px-2.5 py-1 rounded-lg">
                    {receptions[0]} {isArabic ? 'شبابيك' : 'Counters'}
                  </span>
                </div>
                <Slider value={receptions} onValueChange={setReceptions} min={1} max={30} step={1} />
                <div className="flex justify-between text-[10px] text-muted-foreground">
                  <span>1</span>
                  <span>30</span>
                </div>
              </div>

              {/* Agency details */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label className="text-sm font-semibold flex items-center gap-1.5">
                    <Building2 className="h-3.5 w-3.5 text-muted-foreground" />
                    {isArabic ? 'اسم المؤسسة / الهيئة' : 'Agency / Institution Name'}
                  </Label>
                  <Input
                    placeholder={isArabic ? 'أدخل اسم المؤسسة' : 'Enter institution name'}
                    value={agencyName}
                    onChange={e => setAgencyName(e.target.value)}
                    className="h-11"
                  />
                </div>
                <div className="space-y-2">
                  <Label className="text-sm font-semibold flex items-center gap-1.5">
                    <CreditCard className="h-3.5 w-3.5 text-muted-foreground" />
                    {isArabic ? 'البريد الإلكتروني للتواصل' : 'Contact Email'}
                  </Label>
                  <Input
                    type="email"
                    placeholder="contact@institution.dz"
                    value={contactEmail}
                    onChange={e => setContactEmail(e.target.value)}
                    className="h-11"
                    dir="ltr"
                  />
                </div>
              </div>

              {/* Hardware Acquisition Framework */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label className="text-sm font-semibold flex items-center gap-1.5">
                    <Monitor className="h-3.5 w-3.5 text-muted-foreground" />
                    {isArabic ? 'نموذج دفع المعدات' : 'Hardware Payment Model'}
                  </Label>
                  <Select onValueChange={(val) => setHardwareUpfront(val === 'UPFRONT')} defaultValue="LEASE">
                    <SelectTrigger className="h-11">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="LEASE">
                        {isArabic ? 'خيار HaaS (0 د.ج رأس مال مقدم)' : 'Pure HaaS Option (0 DZD Upfront Capital)'}
                      </SelectItem>
                      <SelectItem value="UPFRONT">
                        {isArabic ? 'هجين (مقدم + شهري منخفض)' : 'Hybrid Asset Protection (Upfront + Low Monthly)'}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label className="text-sm font-semibold flex items-center gap-1.5">
                    <CalendarClock className="h-3.5 w-3.5 text-muted-foreground" />
                    {isArabic ? 'مدة الالتزام' : 'Lease Commitment Timeline'}
                  </Label>
                  <Select onValueChange={setCommitment} defaultValue="COMMIT_3YR">
                    <SelectTrigger className="h-11">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="COMMIT_1YR">{isArabic ? 'التزام سنة واحدة' : '1-Year Term Commitment'}</SelectItem>
                      <SelectItem value="COMMIT_2YR">{isArabic ? 'التزام سنتين' : '2-Year Term Commitment'}</SelectItem>
                      <SelectItem value="COMMIT_3YR">{isArabic ? 'التزام 3 سنوات' : '3-Year Term Commitment'}</SelectItem>
                      <SelectItem value="COMMIT_4YR">{isArabic ? 'التزام 4 سنوات' : '4-Year Term Commitment'}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <Button
                onClick={handleSave}
                disabled={saving}
                className="w-full h-12 bg-emerald-600 hover:bg-emerald-700 font-bold text-lg rounded-xl gap-2"
              >
                {saving ? (
                  <Loader2 className="h-5 w-5 animate-spin" />
                ) : (
                  <Save className="h-5 w-5" />
                )}
                {isArabic ? 'حفظ ونشر ملف المؤسسة' : 'Save & Deploy Custom Enterprise Profile'}
              </Button>
            </CardContent>
          </Card>
        </motion.div>

        {/* Real-time Invoice Generation Breakdown Card */}
        <motion.div
          initial={{ opacity: 0, y: 15 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
        >
          <Card className="bg-gray-50 dark:bg-gray-900 border-2 border-gray-100 dark:border-gray-800 shadow-sm h-fit">
            <CardHeader>
              <CardTitle className="text-lg font-bold text-gray-900 dark:text-gray-100 flex items-center gap-2">
                <Receipt className="h-5 w-5 text-emerald-600" />
                {isArabic ? 'ورقة التكاليف' : 'Contract Cost Sheet'}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-5 text-sm">
              <div className="flex justify-between border-b pb-3">
                <span className="text-gray-500">{isArabic ? 'رأس المال المقدم:' : 'Upfront Capital Investment:'}</span>
                <span className="font-bold text-gray-900 dark:text-gray-100">{costSummary.upfrontHardware.toLocaleString()} {isArabic ? 'د.ج' : 'DZD'}</span>
              </div>
              <div className="flex justify-between border-b pb-3">
                <span className="text-gray-500">{isArabic ? 'رخصة البرمجيات الشهرية:' : 'Monthly Core Software License:'}</span>
                <span className="font-semibold text-gray-900 dark:text-gray-100">{costSummary.monthlySoftware.toLocaleString()} {isArabic ? 'د.ج/شهر' : 'DZD/mo'}</span>
              </div>
              <div className="flex justify-between border-b pb-3">
                <span className="text-gray-500">{isArabic ? 'إيجار المعدات الشهري:' : 'Monthly HaaS Equipment Lease:'}</span>
                <span className="font-semibold text-gray-900 dark:text-gray-100">{costSummary.monthlyHardware.toLocaleString()} {isArabic ? 'د.ج/شهر' : 'DZD/mo'}</span>
              </div>

              {/* Summary separator */}
              <div className="pt-2">
                <div className="p-4 rounded-xl bg-gradient-to-br from-emerald-50 to-teal-50 dark:from-emerald-900/20 dark:to-teal-900/20 border border-emerald-200/50 dark:border-emerald-800/30">
                  <div className="flex justify-between items-center">
                    <span className="text-base font-bold text-gray-900 dark:text-gray-100">
                      {isArabic ? 'إجمالي الفاتورة المتكررة:' : 'Total Recurring Invoice:'}
                    </span>
                    <div className="text-end">
                      <span className="text-2xl font-black text-emerald-600">
                        {costSummary.totalRecurring.toLocaleString()}
                      </span>
                      <p className="text-[10px] text-muted-foreground">{isArabic ? 'د.ج/شهر' : 'DZD/mo'}</p>
                    </div>
                  </div>
                </div>
              </div>

              {/* Quick breakdown */}
              <div className="grid grid-cols-2 gap-2 pt-1">
                <div className="text-center p-2.5 rounded-lg bg-white dark:bg-gray-800/50">
                  <p className="text-[10px] text-muted-foreground">{isArabic ? 'الفروع' : 'Branches'}</p>
                  <p className="text-sm font-bold text-emerald-700 dark:text-emerald-400">{branches[0]}</p>
                </div>
                <div className="text-center p-2.5 rounded-lg bg-white dark:bg-gray-800/50">
                  <p className="text-[10px] text-muted-foreground">{isArabic ? 'الشبابيك' : 'Counters'}</p>
                  <p className="text-sm font-bold text-teal-700 dark:text-teal-400">{receptions[0]}</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </motion.div>
      </div>
    </div>
  );
}
