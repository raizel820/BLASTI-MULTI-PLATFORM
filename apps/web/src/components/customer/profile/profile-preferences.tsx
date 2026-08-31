'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { LanguageSwitcher } from '@/components/shared/language-switcher';
import {
  Palette,
  Sun,
  Moon,
  Monitor,
  Check,
} from 'lucide-react';
import { motion } from 'framer-motion';
import type { ProfilePreferencesProps } from './profile-types';

import { useLanguage } from '@/hooks/use-language';
export function ProfilePreferences({ lang, theme, onLanguageChange, onThemeChange, t }: ProfilePreferencesProps) {
  return (
    <>
      {/* Language Preference */}
      <motion.div
        initial={{ opacity: 0, y: 15 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.25 }}
      >
        <Card className="border-0 shadow-sm mb-4 bg-white dark:bg-gray-900/80 dark:border-gray-800/50 dark:backdrop-blur-sm dark:shadow-gray-900/50">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <LanguageSwitcher />
              {t('language')}
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <Select value={lang} onValueChange={onLanguageChange}>
              <SelectTrigger className="h-11">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ar">العربية</SelectItem>
                <SelectItem value="fr">Français</SelectItem>
                <SelectItem value="en">{t('languageEnglish')}</SelectItem>
              </SelectContent>
            </Select>
          </CardContent>
        </Card>
      </motion.div>

      {/* Appearance / Theme Card with visual previews */}
      <motion.div
        initial={{ opacity: 0, y: 15 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.3 }}
      >
        <Card className="border-0 shadow-sm mb-4 bg-white dark:bg-gray-900/80 dark:border-gray-800/50 dark:backdrop-blur-sm dark:shadow-gray-900/50">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Palette className="h-4 w-4 text-emerald-600" />
              {t('appearance')}
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <p className="text-xs text-muted-foreground mb-3">{t('appearanceDesc')}</p>
            <div className="grid grid-cols-3 gap-2">
              {/* Light */}
              <motion.button
                whileHover={{ scale: 1.03 }}
                whileTap={{ scale: 0.97 }}
                onClick={() => onThemeChange('light')}
                className={`group relative overflow-hidden rounded-xl border-2 transition-all text-center p-3 ${
                  theme !== 'dark'
                    ? 'border-emerald-500 shadow-md shadow-emerald-500/10'
                    : 'border-border hover:border-emerald-200 dark:hover:border-emerald-700'
                }`}
              >
                {/* Theme preview card */}
                <div className="h-16 rounded-lg bg-white border border-gray-200 mb-2 p-1.5 overflow-hidden">
                  <div className="h-3 w-8 rounded-sm bg-emerald-500 mb-1" />
                  <div className="space-y-0.5">
                    <div className="h-1.5 w-full rounded-sm bg-gray-200" />
                    <div className="h-1.5 w-3/4 rounded-sm bg-gray-200" />
                  </div>
                </div>
                <Sun className="h-4 w-4 mx-auto mb-1 text-amber-500" />
                <span className="text-[10px] font-medium">{t('lightMode')}</span>
                {theme !== 'dark' && (
                  <motion.div
                    initial={{ scale: 0 }}
                    animate={{ scale: 1 }}
                    className="absolute top-1.5 end-1.5"
                  >
                    <Check className="h-3 w-3 text-emerald-500" />
                  </motion.div>
                )}
              </motion.button>

              {/* Dark */}
              <motion.button
                whileHover={{ scale: 1.03 }}
                whileTap={{ scale: 0.97 }}
                onClick={() => onThemeChange('dark')}
                className={`group relative overflow-hidden rounded-xl border-2 transition-all text-center p-3 ${
                  theme === 'dark'
                    ? 'border-emerald-500 shadow-md shadow-emerald-500/10'
                    : 'border-border hover:border-emerald-200 dark:hover:border-emerald-700'
                }`}
              >
                {/* Theme preview card */}
                <div className="h-16 rounded-lg bg-gray-900 border border-gray-700 mb-2 p-1.5 overflow-hidden">
                  <div className="h-3 w-8 rounded-sm bg-emerald-500 mb-1" />
                  <div className="space-y-0.5">
                    <div className="h-1.5 w-full rounded-sm bg-gray-700" />
                    <div className="h-1.5 w-3/4 rounded-sm bg-gray-700" />
                  </div>
                </div>
                <Moon className="h-4 w-4 mx-auto mb-1 text-slate-400" />
                <span className="text-[10px] font-medium">{t('darkMode')}</span>
                {theme === 'dark' && (
                  <motion.div
                    initial={{ scale: 0 }}
                    animate={{ scale: 1 }}
                    className="absolute top-1.5 end-1.5"
                  >
                    <Check className="h-3 w-3 text-emerald-500" />
                  </motion.div>
                )}
              </motion.button>

              {/* System */}
              <motion.button
                whileHover={{ scale: 1.03 }}
                whileTap={{ scale: 0.97 }}
                onClick={() => onThemeChange('system')}
                className={`group relative overflow-hidden rounded-xl border-2 transition-all text-center p-3 ${
                  theme === 'system'
                    ? 'border-emerald-500 shadow-md shadow-emerald-500/10'
                    : 'border-border hover:border-emerald-200 dark:hover:border-emerald-700'
                }`}
              >
                {/* Theme preview card - split */}
                <div className="h-16 rounded-lg mb-2 overflow-hidden border border-gray-300 dark:border-gray-600 flex">
                  <div className="w-1/2 bg-white p-1">
                    <div className="h-1.5 w-4 rounded-sm bg-emerald-500 mb-0.5" />
                    <div className="h-1 w-full rounded-sm bg-gray-200" />
                  </div>
                  <div className="w-1/2 bg-gray-900 p-1">
                    <div className="h-1.5 w-4 rounded-sm bg-emerald-500 mb-0.5" />
                    <div className="h-1 w-full rounded-sm bg-gray-700" />
                  </div>
                </div>
                <Monitor className="h-4 w-4 mx-auto mb-1 text-gray-500" />
                <span className="text-[10px] font-medium">{t('systemTheme')}</span>
                {theme === 'system' && (
                  <motion.div
                    initial={{ scale: 0 }}
                    animate={{ scale: 1 }}
                    className="absolute top-1.5 end-1.5"
                  >
                    <Check className="h-3 w-3 text-emerald-500" />
                  </motion.div>
                )}
              </motion.button>
            </div>
          </CardContent>
        </Card>
      </motion.div>
    </>
  );
}
