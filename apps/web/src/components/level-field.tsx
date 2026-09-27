'use client';

import { useMemo } from 'react';
import { cn } from '@tp/ui';
import { price as formatPrice, signedMoney, toneClass, toneOf } from '@/lib/format';
import {
  LEVEL_MODES,
  describeLevel,
  priceFromEntry,
  type LevelContext,
  type LevelMode,
} from '@/lib/level-entry';
import { inputClass } from './primitives';

/** What the trader typed, and the unit they typed it in. */
export interface LevelEntry {
  readonly mode: LevelMode;
  readonly text: string;
}

export function levelEntryFromPrice(price: string | null): LevelEntry {
  return { mode: 'price', text: price ?? '' };
}

/**
 * A protective level, entered as a price, a distance, points, money, or a
 * share of equity — and read back in all five at once.
 *
 * The unit is the trader's; the price is the order's. Whatever is typed, the
 * line underneath shows the price it resolves to and what that price means in
 * the other units, from the one calculator in `@tp/trading-core`, so that
 * "$200 of risk" and "3,991.67" are visibly the same stop before it is sent.
 *
 * Without an instrument specification (a symbol the catalogue no longer
 * lists) only the price unit is offered: the others need a contract size and
 * decimals to mean anything.
 */
export function LevelField({
  label,
  context,
  entry,
  onChange,
}: {
  label: string;
  context: LevelContext | null;
  entry: LevelEntry;
  onChange: (entry: LevelEntry) => void;
}) {
  const resolved = useMemo(
    () =>
      context === null
        ? entry.mode === 'price' && entry.text.trim() !== ''
          ? entry.text.trim()
          : null
        : priceFromEntry(entry.mode, entry.text, context),
    [context, entry],
  );
  const view = useMemo(
    () => (context === null ? null : describeLevel(resolved, context)),
    [context, resolved],
  );
  const incomplete = entry.text.trim() !== '' && resolved === null;
  const currency = context?.accountCurrency ?? 'USD';
  const decimals = context?.spec.pricePrecision ?? 2;

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-end gap-1">
        <label className="block">
          <span className="mb-1 block text-[10px] uppercase tracking-wider text-terminal-muted">
            {label}
          </span>
          <input
            className={cn(inputClass, 'w-32', incomplete ? 'border-terminal-short' : '')}
            placeholder="—"
            inputMode="decimal"
            value={entry.text}
            aria-invalid={incomplete || undefined}
            onChange={(event) => onChange({ mode: entry.mode, text: event.target.value })}
          />
        </label>
        <select
          className={cn(inputClass, 'w-auto')}
          value={entry.mode}
          aria-label={`${label} unit`}
          disabled={context === null}
          onChange={(event) =>
            // A change of unit is a change of what the text means. The text
            // is cleared rather than reinterpreted: "12" as a distance and
            // "12" as a percent of equity are different stops, and keeping
            // the digits would silently move the level.
            onChange({ mode: event.target.value as LevelMode, text: '' })
          }
        >
          {LEVEL_MODES.map((option) => (
            <option key={option.mode} value={option.mode}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
      <p
        className="numeric min-h-[14px] text-[10px] text-terminal-muted"
        aria-live="polite"
        data-testid={`${label.toLowerCase().replace(/\s+/g, '-')}-readout`}
      >
        {incomplete ? (
          <span className="text-terminal-short">
            {context === null || entry.mode === 'price'
              ? 'Not a price yet.'
              : entry.mode === 'percent' && context.equity === null
                ? 'No equity to take a percent of yet.'
                : context.spec.quoteCurrency !== context.accountCurrency &&
                    (entry.mode === 'money' || entry.mode === 'percent')
                  ? `Cannot price ${context.spec.quoteCurrency} in ${context.accountCurrency} here — enter a price, distance or points.`
                  : 'Not a number yet.'}
          </span>
        ) : view === null ? (
          ' '
        ) : (
          <>
            {entry.mode === 'price' ? null : `→ ${formatPrice(view.price, decimals)} · `}
            {view.distance === null
              ? null
              : `${formatPrice(view.distance.price, decimals)} away · ${view.distance.points} pts`}
            {view.outcome === null ? null : (
              <>
                {' · '}
                <span className={toneClass[toneOf(view.outcome)]}>
                  {signedMoney(view.outcome, currency)}
                </span>
              </>
            )}
            {view.percentOfEquity === null ? null : ` · ${view.percentOfEquity}% of equity`}
          </>
        )}
      </p>
    </div>
  );
}
