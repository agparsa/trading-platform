'use client';

import { useEffect, useState } from 'react';
import { cn } from '@tp/ui';
import { useNotificationPreferences, useUpdateNotificationSettings } from '@/lib/queries';
import { playScore } from '@/lib/trade-sounds';
import type { TradeSoundId } from '@/lib/trading-toasts';
import type { MessageKey } from '@/lib/messages';
import { useT } from '@/lib/use-locale';

const SAMPLES: ReadonlyArray<{ id: TradeSoundId; key: MessageKey }> = [
  { id: 'trade_opened', key: 'sound.opened' },
  { id: 'trade_closed', key: 'sound.closed' },
  { id: 'take_profit', key: 'sound.takeProfit' },
  { id: 'stop_loss', key: 'sound.stopLoss' },
  { id: 'trade_modified', key: 'sound.modified' },
  { id: 'order_rejected', key: 'sound.rejected' },
];

/**
 * Trading sounds: on or off, how loud, and what each one sounds like.
 *
 * The server's settings (`soundEnabled`, `soundVolume`) — the ones the phone
 * app plays by too — not this browser's, so a trader sets them once. The
 * volume is sent when the slider is let go, not on every step of the drag.
 */
export function SoundSettings() {
  const t = useT();
  const settings = useNotificationPreferences();
  const update = useUpdateNotificationSettings();
  const enabled = settings.data?.soundEnabled ?? false;
  const stored = settings.data?.soundVolume ?? 70;
  const [volume, setVolume] = useState(stored);
  useEffect(() => setVolume(stored), [stored]);

  if (settings.isError) {
    return <p className="text-caption text-terminal-short">{t('sound.unavailable')}</p>;
  }

  const commit = () => {
    if (volume !== stored) update.mutate({ soundVolume: volume });
  };

  return (
    <fieldset className="space-y-3" disabled={settings.data === undefined}>
      <legend className="mb-1 text-label uppercase tracking-wider text-terminal-muted">
        {t('sound.title')}
      </legend>
      <label className="flex min-h-8 items-center justify-between gap-3 text-sm text-terminal-text">
        {t('sound.enabled')}
        <input
          type="checkbox"
          role="switch"
          className="h-5 w-9"
          checked={enabled}
          onChange={(event) => update.mutate({ soundEnabled: event.target.checked })}
          data-testid="sound-enabled"
        />
      </label>
      <label className="block text-sm text-terminal-text">
        <span className="flex justify-between">
          {t('sound.volume')}
          <span className="numeric text-terminal-muted">{volume}%</span>
        </span>
        <input
          type="range"
          min={0}
          max={100}
          step={5}
          value={volume}
          disabled={!enabled}
          className="mt-1 w-full accent-terminal-accent"
          onChange={(event) => setVolume(Number(event.target.value))}
          onPointerUp={commit}
          onKeyUp={commit}
          onBlur={commit}
          data-testid="sound-volume"
        />
      </label>
      <div className="flex flex-wrap gap-1">
        {SAMPLES.map((sample) => (
          <button
            key={sample.id}
            type="button"
            className={cn(
              'min-h-8 rounded border border-terminal-border px-2 text-caption text-terminal-text',
              !enabled && 'opacity-50',
            )}
            onClick={() => playScore(sample.id, volume)}
          >
            ▶ {t(sample.key)}
          </button>
        ))}
      </div>
      {update.isError ? (
        <p className="text-caption text-terminal-short" role="alert">
          {update.error instanceof Error ? update.error.message : t('sound.unavailable')}
        </p>
      ) : null}
    </fieldset>
  );
}
