'use client';

import { useState } from 'react';
import { cn } from '@tp/ui';
import type { TradingPreferences } from '@/lib/trading-preferences';
import { Button, inputClass } from './primitives';
import { useT } from '@/lib/use-locale';

/**
 * One-click and keyboard trading settings, and the badge that says they are on.
 *
 * The badge is not decoration. A terminal that will send an order on a single
 * click, with no confirmation, must say so on screen at all times — otherwise
 * the trader's model of what a click does is a memory of a checkbox they
 * ticked, and the first time it is wrong they are already filled.
 */
export function TradingSettings({
  preferences,
  onChange,
  presentation = 'popover',
  oneClickAllowed = true,
}: {
  preferences: TradingPreferences;
  onChange: (patch: Partial<TradingPreferences>) => void;
  /** `page` drops the trigger button and renders the panel inline. */
  presentation?: 'popover' | 'page';
  /** Whether the firm allows one-click at all (§95). Defaults to yes for callers that do not know. */
  oneClickAllowed?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const t = useT();
  const armed = preferences.oneClick && !preferences.confirm;

  /**
   * The panel without the popover around it, so `/settings` can render it as a
   * page while the terminal keeps the armed badge in its header.
   *
   * The badge is why the popover form stays. A terminal that will send an order
   * on a single click must say so on screen at all times, and a setting that
   * lives only on another page is a setting the trader last saw yesterday.
   */
  const body = (
    <>
      <p className="mb-2 text-label uppercase tracking-wider text-terminal-muted">
        {t('trade.oneClick')}
      </p>

      {oneClickAllowed ? null : (
        <p className="mb-2 text-caption text-terminal-warning" data-testid="one-click-off">
          {t('trade.oneClickOff')}
        </p>
      )}
      <Toggle
        label={t('trade.sendOnClick')}
        checked={preferences.oneClick}
        onChange={(value) => onChange({ oneClick: value })}
        disabled={!oneClickAllowed}
      />
      <Toggle
        label={t('trade.askBefore')}
        checked={preferences.confirm}
        onChange={(value) => onChange({ confirm: value })}
        hint={t('trade.askBeforeHint')}
      />

      <div className="mt-2 grid grid-cols-3 gap-2">
        <Field label={t('col.volume')}>
          <input
            className={inputClass}
            value={preferences.defaultVolume}
            onChange={(event) => onChange({ defaultVolume: event.target.value })}
            inputMode="decimal"
          />
        </Field>
        <Field label={t('trade.defaultSl')}>
          <input
            className={inputClass}
            value={preferences.defaultStopLoss}
            onChange={(event) => onChange({ defaultStopLoss: event.target.value })}
            inputMode="decimal"
            placeholder="—"
          />
        </Field>
        <Field label={t('trade.defaultTp')}>
          <input
            className={inputClass}
            value={preferences.defaultTakeProfit}
            onChange={(event) => onChange({ defaultTakeProfit: event.target.value })}
            inputMode="decimal"
            placeholder="—"
          />
        </Field>
      </div>

      <p className="mb-2 mt-4 text-label uppercase tracking-wider text-terminal-muted">
        {t('trade.keyboard')}
      </p>
      <Toggle
        label={t('trade.enableShortcuts')}
        checked={preferences.keyboard}
        onChange={(value) => onChange({ keyboard: value })}
        hint={t('trade.shortcutsHint')}
      />

      <div className="mt-2 grid grid-cols-4 gap-2">
        {(
          [
            ['buy', 'wl.buy'],
            ['sell', 'wl.sell'],
            ['close', 'pos.close'],
            ['closeAll', 'trade.closeAll'],
          ] as const
        ).map(([key, label]) => (
          <Field key={key} label={t(label)}>
            <input
              className={cn(inputClass, 'text-center')}
              value={preferences.keys[key]}
              maxLength={1}
              onChange={(event) =>
                onChange({ keys: { ...preferences.keys, [key]: event.target.value } })
              }
            />
          </Field>
        ))}
      </div>

      <div className="mt-3 flex justify-end">
        <Button variant="ghost" onClick={() => setOpen(false)}>
          {t('trade.done')}
        </Button>
      </div>
    </>
  );

  if (presentation === 'page') return body;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className={cn(
          'rounded border px-2 py-1 text-label uppercase tracking-wider transition-colors',
          armed
            ? 'border-terminal-warning bg-terminal-warning/15 text-terminal-warning'
            : 'border-terminal-border text-terminal-muted hover:text-terminal-text',
        )}
        title={armed ? t('trade.armedTitle') : t('trade.inputTitle')}
      >
        {armed ? `⚡ ${t('trade.armed')}` : t('trade.input')}
      </button>

      {!open ? null : (
        <div className="absolute end-0 top-8 z-30 w-72 rounded border border-terminal-border bg-terminal-surface p-3 shadow-xl">
          {body}
        </div>
      )}
    </div>
  );
}

function Toggle({
  label,
  checked,
  onChange,
  hint,
  disabled = false,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <label
      className={`mb-1 flex items-start gap-2 text-xs text-terminal-text ${disabled ? 'opacity-60' : 'cursor-pointer'}`}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5 accent-terminal-long"
      />
      <span>
        {label}
        {hint === undefined ? null : (
          <span className="block text-label text-terminal-muted">{hint}</span>
        )}
      </span>
    </label>
  );
}

/**
 * A labelled control.
 *
 * The label wraps the control rather than sitting beside it. As a `<p>` above a
 * `<div>` it was a caption — visually a label, programmatically nothing — and
 * five inputs on this screen had no accessible name at all: a screen reader
 * announced "edit text, 0.10" for the default volume, and the same for the
 * stop-loss and take-profit beside it. The accessibility audit in
 * `scripts/smoke-web.ts` found it; wrapping is the fix that needs no ids to go
 * stale.
 */
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-0.5 block text-label uppercase tracking-wider text-terminal-muted">
        {label}
      </span>
      {children}
    </label>
  );
}
