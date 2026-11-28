import { cn } from '@tp/ui';
import { priceParts } from '@/lib/price-parts';

/**
 * A dealing price, printed so the digits that move are the ones the eye finds.
 *
 * The lead (`1.08`) is small, the two pips (`75`) large, and a fractional pip
 * (`3`) small and raised — the way desktop dealing screens print a quote. The
 * text is the formatted price unchanged, so a screen reader and a test read
 * the same `1.08753` they always did.
 */
export function PriceFigure({
  value,
  precision,
  size = 'md',
  className,
}: {
  /** The price as already formatted for display, or a placeholder. */
  value: string;
  precision: number;
  /** `md` for a quick-trade button, `lg` for the order ticket's side buttons. */
  size?: 'md' | 'lg';
  className?: string;
}) {
  const { lead, big, pipette } = priceParts(value, precision);
  return (
    <span className={cn('numeric inline-block whitespace-nowrap leading-none', className)}>
      <span className="text-xs">{lead}</span>
      {big === '' ? null : (
        <span className={cn('font-semibold', size === 'lg' ? 'text-lg' : 'text-base')}>{big}</span>
      )}
      {pipette === '' ? null : <span className="align-super text-label">{pipette}</span>}
    </span>
  );
}
