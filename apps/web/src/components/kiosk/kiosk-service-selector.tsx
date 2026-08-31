'use client';

import { useState } from 'react';
import { useLanguage } from '@/hooks/use-language';
import { isRTL, type Language } from '@/i18n';
import { motion } from 'framer-motion';
import { ArrowLeft, Clock, Ticket, Loader2 } from 'lucide-react';

interface Service {
  id: string;
  name: string;
  nameAr?: string | null;
  nameFr?: string | null;
  prefix: string;
  avgTime: number;
}

interface KioskServiceSelectorProps {
  agency: {
    id: string;
    name: string;
    nameAr?: string | null;
    nameFr?: string | null;
    logoUrl?: string | null;
    isQueueOpen: boolean;
    isPaused: boolean;
  };
  services: Service[];
  onBack: () => void;
  onGetTicket: (serviceId: string, customerName?: string) => void;
  currentLang: Language;
}

export function KioskServiceSelector({
  agency,
  services,
  onBack,
  onGetTicket,
  currentLang,
}: KioskServiceSelectorProps) {
  const { t } = useLanguage();
  const rtl = isRTL(currentLang);
  const [selectedService, setSelectedService] = useState<string | null>(null);
  const [customerName, setCustomerName] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const getServiceName = (service: Service) => {
    if (currentLang === 'ar' && service.nameAr) return service.nameAr;
    if (currentLang === 'fr' && service.nameFr) return service.nameFr;
    return service.name;
  };

  const getAgencyName = () => {
    if (currentLang === 'ar' && agency.nameAr) return agency.nameAr;
    if (currentLang === 'fr' && agency.nameFr) return agency.nameFr;
    return agency.name;
  };

  const handleGetTicket = async () => {
    if (!selectedService) return;
    setIsSubmitting(true);
    try {
      await onGetTicket(selectedService, customerName.trim() || undefined);
    } finally {
      setIsSubmitting(false);
    }
  };

  if (services.length === 0) {
    return (
      <div
        className="min-h-screen bg-gradient-to-br from-emerald-50 via-white to-teal-50 flex flex-col items-center justify-center p-6"
        dir={rtl ? 'rtl' : 'ltr'}
      >
        <p className="text-xl text-gray-500">{t('kioskNoServices')}</p>
        <button
          onClick={onBack}
          className="mt-6 min-h-[60px] px-8 rounded-2xl bg-emerald-600 text-white font-semibold text-lg"
        >
          {t('kioskBack')}
        </button>
      </div>
    );
  }

  return (
    <div
      className="min-h-screen bg-gradient-to-br from-emerald-50 via-white to-teal-50 flex flex-col p-6 select-none"
      dir={rtl ? 'rtl' : 'ltr'}
    >
      {/* Header */}
      <div className="flex items-center gap-4 mb-6">
        <button
          onClick={onBack}
          className="min-h-[60px] min-w-[60px] rounded-xl bg-white border border-gray-200 flex items-center justify-center shadow-sm hover:bg-gray-50 transition-colors"
        >
          <ArrowLeft className={`h-6 w-6 text-gray-600 ${rtl ? 'rotate-180' : ''}`} />
        </button>
        <div>
          <h1 className="text-2xl font-bold text-gray-900">
            {t('kioskSelectService')}
          </h1>
          <p className="text-gray-500">{getAgencyName()}</p>
        </div>
      </div>

      {/* Service Cards */}
      <div className="flex-1 overflow-y-auto">
        <div className="grid gap-4 sm:grid-cols-2">
          {services.map((service) => {
            const isSelected = selectedService === service.id;
            return (
              <motion.button
                key={service.id}
                whileHover={{ scale: 1.01 }}
                whileTap={{ scale: 0.99 }}
                onClick={() => setSelectedService(service.id)}
                className={`min-h-[100px] rounded-2xl p-6 text-start transition-all border-2 ${
                  isSelected
                    ? 'border-emerald-500 bg-emerald-50 shadow-lg shadow-emerald-100'
                    : 'border-gray-100 bg-white hover:border-emerald-200 hover:shadow-md'
                }`}
              >
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-2">
                      <span className="text-xs font-bold px-2 py-1 rounded-lg bg-emerald-100 text-emerald-700">
                        {service.prefix}
                      </span>
                      <h3 className="text-xl font-semibold text-gray-900">
                        {getServiceName(service)}
                      </h3>
                    </div>
                    <div className="flex items-center gap-1 text-gray-500">
                      <Clock className="h-4 w-4" />
                      <span className="text-sm">
                        ~{service.avgTime} {t('kioskMinutes')}
                      </span>
                    </div>
                  </div>
                  {isSelected && (
                    <motion.div
                      initial={{ scale: 0 }}
                      animate={{ scale: 1 }}
                      className="w-8 h-8 rounded-full bg-emerald-600 flex items-center justify-center"
                    >
                      <svg
                        className="w-5 h-5 text-white"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={3}
                          d="M5 13l4 4L19 7"
                        />
                      </svg>
                    </motion.div>
                  )}
                </div>
              </motion.button>
            );
          })}
        </div>
      </div>

      {/* Bottom: Name input + Get Ticket */}
      <div className="mt-6 pt-4 border-t border-gray-100">
        {/* Optional name */}
        <div className="mb-4">
          <input
            type="text"
            value={customerName}
            onChange={(e) => setCustomerName(e.target.value)}
            placeholder={t('kioskEnterName')}
            className="w-full min-h-[60px] rounded-2xl border-2 border-gray-200 px-5 text-lg focus:border-emerald-500 focus:outline-none transition-colors bg-white"
          />
        </div>

        <motion.button
          whileHover={{ scale: selectedService ? 1.01 : 1 }}
          whileTap={{ scale: selectedService ? 0.99 : 1 }}
          onClick={handleGetTicket}
          disabled={!selectedService || isSubmitting}
          className={`w-full min-h-[72px] rounded-2xl text-xl font-bold shadow-lg transition-all flex items-center justify-center gap-3 ${
            !selectedService || isSubmitting
              ? 'bg-gray-300 text-gray-500 cursor-not-allowed shadow-none'
              : 'bg-gradient-to-r from-emerald-600 to-teal-600 text-white hover:shadow-xl'
          }`}
        >
          {isSubmitting ? (
            <Loader2 className="h-7 w-7 animate-spin" />
          ) : (
            <Ticket className="h-7 w-7" />
          )}
          {t('kioskGetTicket')}
        </motion.button>
      </div>
    </div>
  );
}
