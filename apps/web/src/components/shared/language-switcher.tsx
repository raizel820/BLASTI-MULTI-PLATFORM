'use client';

import { useAppStore, updateDocumentDirection } from '@/store/use-app-store';
import { languageNames, type Language } from '@/i18n';
import { setLanguage as setLangExternal, useLanguage } from '@/hooks/use-language';
import { markLocalLanguageMutation } from '@/lib/user-store-refresh';
import { apiFetch } from '@/lib/api-fetch';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import { Globe } from 'lucide-react';

export function LanguageSwitcher() {
  const user = useAppStore((s) => s.user);
  const { t } = useLanguage();
  const currentLang = user?.language ?? 'ar';

  const handleLanguageChange = (lang: Language) => {
    updateDocumentDirection(lang);
    // Notify the external language store (for pre-login state) — now also
    // persists to localStorage (language revert fix).
    setLangExternal(lang);
    if (user) {
      // Language revert fix, part 1: stamp the local mutation so the 1.5 s
      // profile refresher cannot merge the DB's stale 'ar' back over it.
      markLocalLanguageMutation();
      // Part 2: merge the user in place — the old setUser(...) call reset
      // currentView to the role default and rewrote the hash, silently
      // navigating the user back to their dashboard on every switch.
      useAppStore.setState({ user: { ...user, language: lang } });
      // Part 3: persist server-side so every future refresh agrees.
      apiFetch('/api/user/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: user.id, language: lang }),
      }).catch(() => { /* silent — the guard keeps the local choice until retry */ });
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
