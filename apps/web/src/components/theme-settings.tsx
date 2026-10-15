'use client';

import { cn } from '@tp/ui';
import { THEME_CHOICES, type ThemeChoice } from '@/lib/theme';
import { useThemeChoice } from '@/lib/use-theme';

const LABEL: Readonly<Record<ThemeChoice, string>> = {
  dark: 'Dark',
  light: 'Light',
  system: 'Same as this device',
};

/**
 * Light, dark, or whatever the operating system is set to — for this browser.
 *
 * Kept per device, like the trading preferences beside it: a phone in the sun
 * and a desk monitor at night want different answers from the same trader.
 */
export function ThemeSettings() {
  const { choice, setChoice } = useThemeChoice();
  return (
    <fieldset className="space-y-2">
      <legend className="mb-1 text-[10px] uppercase tracking-wider text-terminal-muted">
        Appearance
      </legend>
      <div role="radiogroup" aria-label="Appearance" className="flex flex-wrap gap-1">
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
            {LABEL[value]}
          </button>
        ))}
      </div>
      <p className="text-[11px] text-terminal-muted">
        For this browser only. The terminal is dark by default: it is looked at for hours.
      </p>
    </fieldset>
  );
}
