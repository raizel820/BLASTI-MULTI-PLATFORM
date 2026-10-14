'use client';

/**
 * NotesInput — release-notes Textarea with EN/AR/FR sub-tabs.
 * Shared by the installer upload dialog and the version create/edit dialogs.
 * Language names are hardcoded (like the rest of the app) — they never change.
 */

import { useState } from 'react';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';

export interface NotesValue {
  en: string;
  ar: string;
  fr: string;
}

export function NotesInput({
  value,
  onChange,
  label,
  disabled,
}: {
  value: NotesValue;
  onChange: (next: NotesValue) => void;
  label: string;
  disabled?: boolean;
}) {
  const [tab, setTab] = useState<'en' | 'ar' | 'fr'>('ar');

  const rows: { key: 'en' | 'ar' | 'fr'; name: string; placeholder: string; dir: 'ltr' | 'rtl' }[] = [
    { key: 'ar', name: 'العربية', placeholder: 'ملاحظات الإصدار بالعربية...', dir: 'rtl' },
    { key: 'en', name: 'English', placeholder: 'Release notes in English...', dir: 'ltr' },
    { key: 'fr', name: 'Français', placeholder: 'Notes de version en français...', dir: 'ltr' },
  ];

  return (
    <div className="space-y-1.5">
      <Label className="text-xs font-medium">{label}</Label>
      <Tabs value={tab} onValueChange={(v) => setTab(v as 'en' | 'ar' | 'fr')}>
        <TabsList className="h-7 mb-1">
          {rows.map((r) => (
            <TabsTrigger key={r.key} value={r.key} className="text-[10px] h-5 px-2">
              {r.name}
            </TabsTrigger>
          ))}
        </TabsList>
        {rows.map((r) =>
          tab === r.key ? (
            <Textarea
              key={r.key}
              placeholder={r.placeholder}
              value={value[r.key]}
              onChange={(e) => onChange({ ...value, [r.key]: e.target.value })}
              rows={3}
              className="text-sm resize-none"
              dir={r.dir}
              disabled={disabled}
            />
          ) : null,
        )}
      </Tabs>
    </div>
  );
}
