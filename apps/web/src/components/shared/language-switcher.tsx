'use client';

import { useAppStore, updateDocumentDirection } from '@/store/use-app-store';
import { languageNames, type Language } from '@/i18n';
import { setLanguage as setLangExternal, useLanguage } from '@/hooks/use-language';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import { Globe } from 'lucide-react';

export function LanguageSwitcher() {
  const { user, setUser } = useAppStore();
  const { t } = useLanguage();
  const currentLang = user?.language ?? 'ar';

  const handleLanguageChange = (lang: Language) => {
    updateDocumentDirection(lang);
    // Notify the external language store (for pre-login state)
    setLangExternal(lang);
    if (user) {
      setUser({ ...user, language: lang });
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="h-10 w-10">
          <Globe className="h-5 w-5" />
          <span className="sr-only">{t('changeLanguage')}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {(Object.entries(languageNames) as [Language, string][]).map(
          ([code, name]) => (
            <DropdownMenuItem
              key={code}
              onClick={() => handleLanguageChange(code)}
              className={currentLang === code ? 'bg-accent font-medium' : ''}
            >
              {name}
            </DropdownMenuItem>
          )
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
