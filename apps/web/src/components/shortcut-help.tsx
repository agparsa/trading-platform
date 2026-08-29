'use client';

import { useEffect } from 'react';
import { cn } from '@tp/ui';
import type { TradingPreferences } from '@/lib/trading-preferences';

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
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const rows: Array<[string, string, boolean]> = [
    [preferences.keys.buy, 'Buy the selected instrument', true],
    [preferences.keys.sell, 'Sell the selected instrument', true],
    [preferences.keys.close, 'Close the expanded position, or the only one', true],
    [preferences.keys.closeAll, 'Close every open position — always confirmed', true],
    ['Enter', 'Confirm what is being asked about', false],
    ['Esc', 'Dismiss it, and close this card', false],
    ['?', 'Show this card', false],
  ];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Keyboard shortcuts"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-lg border border-terminal-border bg-terminal-surface shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-terminal-border px-4 py-2">
          <h2 className="text-xs font-medium uppercase tracking-wider text-terminal-muted">
            Keyboard
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-[13px] leading-none text-terminal-muted transition-colors hover:text-terminal-text"
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
            <p className="mb-3 rounded border border-terminal-warning/50 bg-terminal-warning/10 px-2 py-1.5 text-[11px] text-terminal-warning">
              Keyboard trading is off. These keys do nothing until you turn it on in Trading
              settings — Escape still works.
            </p>
          ) : null}

          <table className="w-full text-xs">
            <tbody>
              {rows.map(([key, description, trading]) => (
                <tr key={`${key}-${description}`} className="border-t border-terminal-border/60">
                  <td className="w-20 py-1.5">
                    <kbd className="numeric rounded border border-terminal-border bg-terminal-raised px-1.5 py-0.5 text-[11px] text-terminal-text">
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

          <p className="mt-3 text-[10px] leading-relaxed text-terminal-muted">
            Keys never fire while you are typing in a field — except Escape, which only ever stops
            something.
            {preferences.oneClick && !preferences.confirm ? (
              <span className="mt-1 block text-terminal-warning">
                One-click is armed: buy and sell send immediately, with no confirmation.
              </span>
            ) : null}
          </p>
        </div>
      </div>
    </div>
  );
}
