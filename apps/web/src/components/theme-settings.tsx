'use client';

import { cn } from '@tp/ui';
import { THEME_CHOICES, type ThemeChoice } from '@/lib/theme';
import { useThemeChoice } from '@/lib/use-theme';
import { useT } from '@/lib/use-locale';
import type { MessageKey } from '@/lib/messages';

const LABEL: Readonly<Record<ThemeChoice, MessageKey>> = {
  dark: 'settings.appearance.dark',
  light: 'settings.appearance.light',
  system: 'settings.appearance.system',
};

/**
 * Light, dark, or whatever the operating system is set to — for this browser.
 *
 * Kept per device, like the trading preferences beside it: a phone in the sun
 * and a desk monitor at night want different answers from the same trader.
 */
export function ThemeSettings() {
  const { choice, setChoice } = useThemeChoice();
  const t = useT();
  return (
    <fieldset className="space-y-2">
      <legend className="mb-1 text-label uppercase tracking-wider text-terminal-muted">
        {t('settings.appearance')}
      </legend>
      <div role="radiogroup" aria-label={t('settings.appearance')} className="flex flex-wrap gap-1">
        {THEME_CHOICES.map((value) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={choice === value}
            onClick={() => setChoice(value)}
            className={cn(
              'rounded border px-3 py-1.5 text-xs transition-colors',
              choice === value
                ? 'border-terminal-accent text-terminal-text'
                : 'border-terminal-border text-terminal-muted hover:text-terminal-text',
            )}
          >
            {t(LABEL[value])}
          </button>
        ))}
      </div>
      <p className="text-caption text-terminal-muted">{t('settings.appearance.note')}</p>
    </fieldset>
  );
}
