import type { MessageKey } from './messages';
import type { Toast } from './toasts';

type Translate = (
  key: MessageKey,
  vars?: Readonly<Record<string, string | number>>,
  isolateValues?: boolean,
) => string;

export type TradingToast = Omit<Toast, 'at'>;

/**
 * What a trading frame from the server says to a trader, as a toast — or
 * nothing, for a frame that is not news.
 *
 * Only ever from the server's own events: a toast that says "opened" is the
 * server saying a position exists, never this client guessing that the button
 * it pressed must have worked. Ids are the event's subject, so the same news
 * arriving twice (the order's answer and its frame, or a reconnect replay)
 * replaces one toast rather than stacking two.
 */
export function tradingToast(event: string, data: unknown, t: Translate): TradingToast | null {
  if (typeof data !== 'object' || data === null) return null;
  const d = data as Record<string, unknown>;
  const text = (key: string): string | null => (typeof d[key] === 'string' ? d[key] : null);

  switch (event) {
    case 'position.created': {
      const id = text('positionId');
      if (id === null) return null;
      return {
        id: `pos-open:${id}`,
        tone: 'success',
        sticky: false,
        title: t('toast.opened', {
          side: text('side') ?? '',
          volume: text('volume') ?? '',
          symbol: text('symbol') ?? '',
        }),
        ...(text('entryPrice') === null
          ? {}
          : { body: t('toast.at', { price: text('entryPrice') ?? '' }) }),
      };
    }
    case 'position.closed': {
      const id = text('positionId');
      if (id === null) return null;
      const reason = text('reason') ?? 'MANUAL';
      const partial = d['fullyClosed'] === false;
      const net = text('netPnl');
      const body = t('toast.closedBody', {
        symbol: text('symbol') ?? '',
        price: text('exitPrice') ?? '—',
        pnl: net === null ? '—' : signed(net),
      });
      const titleKey: MessageKey = partial
        ? 'toast.partial'
        : reason === 'STOP_LOSS'
          ? 'toast.stopHit'
          : reason === 'TAKE_PROFIT'
            ? 'toast.targetHit'
            : reason === 'TRAILING_STOP'
              ? 'toast.trailHit'
              : reason === 'LIQUIDATION'
                ? 'toast.liquidated'
                : 'toast.closed';
      return {
        // A partial close and the later full close are two pieces of news.
        id: `pos-close:${id}:${text('remainingVolume') ?? ''}`,
        tone:
          reason === 'LIQUIDATION'
            ? 'danger'
            : net !== null && net.startsWith('-')
              ? 'warning'
              : 'success',
        // The platform closing somebody's position is not to fade unread.
        sticky: reason === 'LIQUIDATION',
        title: t(titleKey, {
          closed: text('closedVolume') ?? '',
          remaining: text('remainingVolume') ?? '',
        }),
        body,
      };
    }
    case 'position.updated': {
      const id = text('positionId');
      if (id === null) return null;
      return {
        id: `pos-mod:${id}`,
        tone: 'info',
        sticky: false,
        title: t('toast.levelsUpdated'),
        body: t('toast.levels', {
          sl: text('stopLoss') ?? '—',
          tp: text('takeProfit') ?? '—',
        }),
      };
    }
    case 'order.rejected': {
      const id = text('orderId');
      if (id === null) return null;
      return {
        id: `order-rejected:${id}`,
        tone: 'danger',
        sticky: false,
        title: t('toast.rejected', { symbol: text('symbol') ?? '' }),
        ...(text('reason') === null ? {} : { body: text('reason') ?? '' }),
      };
    }
    default:
      return null;
  }
}

/** A server decimal with its sign shown both ways. */
function signed(value: string): string {
  return value.startsWith('-') || value === '0' || /^0(\.0+)?$/.test(value) ? value : `+${value}`;
}
