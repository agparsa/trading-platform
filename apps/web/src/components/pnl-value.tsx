'use client';

import { useEffect, useRef, useState } from 'react';
import { cn } from '@tp/ui';
import { signedMoney, toneClass, toneOf } from '@/lib/format';
import { flashDirection } from '@/lib/pnl-flash';

/**
 * A live profit-or-loss figure: blue while it is up, red while it is down,
 * and a short wash of the direction it just moved each time the server sends
 * a new one.
 *
 * The figure is always the one given — this component animates a value, it
 * never invents or interpolates one. Counting up through numbers the account
 * never showed would be a display of money that was not there. The motion is
 * the flash alone, and it is switched off for anyone who asked for less
 * motion (`globals.css`); the colour carries the meaning without it.
 */
export function PnlValue({
  value,
  currency,
  className,
  testId,
}: {
  value: string | null | undefined;
  currency: string;
  className?: string;
  testId?: string;
}) {
  const previous = useRef(value);
  const [flash, setFlash] = useState<{ tone: 'profit' | 'loss'; n: number } | null>(null);

  useEffect(() => {
    const before = previous.current;
    previous.current = value;
    const tone = flashDirection(before, value);
    if (tone !== null) setFlash((now) => ({ tone, n: (now?.n ?? 0) + 1 }));
  }, [value]);

  return (
    <span
      // A new key restarts the animation: the same class on the same node
      // would play once and then never again.
      key={flash?.n ?? 0}
      className={cn(
        'numeric rounded-sm',
        toneClass[toneOf(value)],
        flash === null ? null : `tp-flash-${flash.tone}`,
        className,
      )}
      data-testid={testId}
      data-flash={flash?.tone}
    >
      {signedMoney(value, currency)}
    </span>
  );
}
