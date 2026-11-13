import { describe, expect, it } from 'vitest';
import { translate } from './messages';
import { tradingToast } from './trading-toasts';

const t = (key: Parameters<typeof translate>[1], vars?: Record<string, string | number>) =>
  translate('en', key, vars);

describe('toasts from trading frames', () => {
  it('says a position opened, keyed on the position', () => {
    const toast = tradingToast(
      'position.created',
      { positionId: 'p1', symbol: 'XAUUSD', side: 'BUY', volume: '0.10', entryPrice: '4000.00' },
      t,
    );
    expect(toast?.id).toBe('pos-open:p1');
    expect(toast?.title).toContain('BUY 0.10 XAUUSD');
    expect(toast?.body).toContain('4000.00');
  });

  it('names the stop when a stop closed it, and shows the loss', () => {
    const toast = tradingToast(
      'position.closed',
      {
        positionId: 'p1',
        symbol: 'XAUUSD',
        closedVolume: '0.10',
        remainingVolume: '0',
        exitPrice: '3990.00',
        netPnl: '-100.00',
        reason: 'STOP_LOSS',
        fullyClosed: true,
      },
      t,
    );
    expect(toast?.title).toBe(translate('en', 'toast.stopHit'));
    expect(toast?.tone).toBe('warning');
    expect(toast?.body).toContain('-100.00');
  });

  it('calls a partial close partial, and keeps it apart from the final close', () => {
    const base = { positionId: 'p1', symbol: 'X', exitPrice: '1', netPnl: '5', reason: 'MANUAL' };
    const part = tradingToast(
      'position.closed',
      { ...base, closedVolume: '0.05', remainingVolume: '0.05', fullyClosed: false },
      t,
    );
    const rest = tradingToast(
      'position.closed',
      { ...base, closedVolume: '0.05', remainingVolume: '0', fullyClosed: true },
      t,
    );
    expect(part?.title).toContain('0.05');
    expect(part?.body).toContain('+5');
    expect(part?.id).not.toBe(rest?.id);
  });

  it('keeps a liquidation on screen until dismissed', () => {
    const toast = tradingToast(
      'position.closed',
      { positionId: 'p1', reason: 'LIQUIDATION', fullyClosed: true, netPnl: '-5' },
      t,
    );
    expect(toast?.sticky).toBe(true);
    expect(toast?.tone).toBe('danger');
  });

  it('carries the server’s reason for a rejected order', () => {
    const toast = tradingToast(
      'order.rejected',
      { orderId: 'o1', symbol: 'EURUSD', reason: 'Insufficient free margin' },
      t,
    );
    expect(toast?.body).toBe('Insufficient free margin');
  });

  it('says nothing for frames that are not news, or that name nothing', () => {
    expect(tradingToast('quotes.updated', [], t)).toBeNull();
    expect(tradingToast('position.created', {}, t)).toBeNull();
    expect(tradingToast('position.closed', null, t)).toBeNull();
  });
});
