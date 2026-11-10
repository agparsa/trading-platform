'use client';

import { useEffect } from 'react';
import { cn } from '@tp/ui';
import type { TradingPreferences } from '@/lib/trading-preferences';
import { useT } from '@/lib/use-locale';

/**
 * What the keys do, according to this trader's own map.
 *
 * Read from their preferences rather than printed from the defaults. A trader
 * who has remapped buy to `q` and is shown a card saying `b` has been handed
 * documentation for somebody else's terminal — and the one moment they open
 * this card is the moment they were unsure.
 */
export function ShortcutHelp({
  preferences,
  onClose,
}: {
  preferences: TradingPreferences;
  onClose: () => void;
}) {
  const t = useT();
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const rows: Array<[string, string, boolean]> = [
    [preferences.keys.buy, t('keys.buy'), true],
    [preferences.keys.sell, t('keys.sell'), true],
    [preferences.keys.close, t('keys.close'), true],
    [preferences.keys.closeAll, t('keys.closeAll'), true],
    ['Enter', t('keys.enter'), false],
    ['Esc', t('keys.esc'), false],
    ['?', t('keys.help'), false],
  ];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={t('terminal.shortcuts')}
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-lg border border-terminal-border bg-terminal-surface shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-terminal-border px-4 py-2">
          <h2 className="text-xs font-medium uppercase tracking-wider text-terminal-muted">
            {t('keys.title')}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('pos.close')}
            className="text-body leading-none text-terminal-muted transition-colors hover:text-terminal-text"
          >
            ×
          </button>
        </header>

        <div className="px-4 py-3">
          {!preferences.keyboard ? (
            /*
              Said plainly rather than by greying the list out. A trader looking
              at a table of keys that do nothing, with no explanation, concludes
              the platform is broken.
            */
            <p className="mb-3 rounded border border-terminal-warning/50 bg-terminal-warning/10 px-2 py-1.5 text-caption text-terminal-warning">
              {t('keys.off')}
            </p>
          ) : null}

          <table className="w-full text-xs">
            <tbody>
              {rows.map(([key, description, trading]) => (
                <tr key={`${key}-${description}`} className="border-t border-terminal-border/60">
                  <td className="w-20 py-1.5">
                    <kbd className="numeric rounded border border-terminal-border bg-terminal-raised px-1.5 py-0.5 text-caption text-terminal-text">
                      {key}
                    </kbd>
                  </td>
                  <td
                    className={cn(
                      'py-1.5',
                      trading && !preferences.keyboard
                        ? 'text-terminal-muted line-through'
                        : 'text-terminal-text',
                    )}
                  >
                    {description}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <p className="mt-3 text-label leading-relaxed text-terminal-muted">
            {t('keys.typing')}
            {preferences.oneClick && !preferences.confirm ? (
              <span className="mt-1 block text-terminal-warning">{t('keys.armed')}</span>
            ) : null}
          </p>
        </div>
      </div>
    </div>
  );
}
