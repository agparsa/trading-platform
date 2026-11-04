'use client';

import { cn } from '@tp/ui';
import { LOCALES, type Locale } from '@/lib/locale';
import { useLocale, useT } from '@/lib/use-locale';

/** Each language named in itself, so a reader finds theirs whatever is showing. */
const NAME: Readonly<Record<Locale, string>> = { en: 'English', fa: 'فارسی' };

/**
 * English or Persian, for this browser.
 *
 * Says what is translated: a choice that turned only part of the interface
 * Persian without saying so would read as a broken page.
 */
export function LanguageSettings({ showNote = true }: { showNote?: boolean }) {
  const { locale, setLocale } = useLocale();
  const t = useT();
  return (
    <fieldset className="space-y-2">
      <legend className="mb-1 text-label uppercase tracking-wider text-terminal-muted">
        {t('settings.language')}
      </legend>
      <div role="radiogroup" aria-label={t('settings.language')} className="flex flex-wrap gap-1">
        {LOCALES.map((value) => (
          <button
            key={value}
            type="button"
            role="radio"
            lang={value}
            aria-checked={locale === value}
            onClick={() => setLocale(value)}
            className={cn(
              'rounded border px-3 py-1.5 text-xs transition-colors',
              locale === value
                ? 'border-terminal-accent text-terminal-text'
                : 'border-terminal-border text-terminal-muted hover:text-terminal-text',
            )}
          >
            {NAME[value]}
          </button>
        ))}
      </div>
      {showNote ? (
        <p className="text-caption text-terminal-muted">{t('settings.language.note')}</p>
      ) : null}
    </fieldset>
  );
}
