import { describe, expect, it } from 'vitest';
import { CloseReason, DomainEvent, categoryForKind, NotificationCategory } from '@tp/shared-types';
import type { DomainEventEnvelope } from '../realtime/events.service';
import { describe as describeEvent } from './trading-notifications.service';

const envelope = (
  event: DomainEventEnvelope['event'],
  data: Record<string, unknown>,
): DomainEventEnvelope => ({
  event,
  eventId: 'evt-1',
  origin: 'instance-1',
  accountId: 'account-1',
  tenantId: '00000000-0000-4000-8000-0000000000ff',
  data,
  timestamp: Date.now(),
});

/**
 * What a trader is told, and which sound it will make.
 *
 * Wording is testable here because `describe` is pure. The assertions that
 * matter are not about phrasing — they are about which *category* an event
 * lands in, because the category decides the sound, the preference switch and
 * whether the notice can be muted at all.
 */
describe('turning a trading event into a notice', () => {
  it('announces an opened position', () => {
    const notice = describeEvent(
      envelope(DomainEvent.POSITION_OPENED, {
        symbol: 'BTCUSDT',
        side: 'BUY',
        volume: '0.10',
        entryPrice: '64120.50',
      }),
    );
    expect(notice?.kind).toBe('position.opened');
    expect(categoryForKind(notice!.kind)).toBe(NotificationCategory.TRADE_OPENED);
    expect(notice?.body).toContain('0.10');
    expect(notice?.body).toContain('64120.50');
  });

  it('gives a stop loss its own category, not "closed"', () => {
    const notice = describeEvent(
      envelope(DomainEvent.POSITION_CLOSED, {
        symbol: 'BTCUSDT',
        reason: CloseReason.STOP_LOSS,
        netPnl: '-125.40',
        exitPrice: '63000',
        fullyClosed: true,
      }),
    );
    // §18 and §24 treat it separately, and a trader who muted routine closes
    // has almost certainly not muted the one that took them out of a loser.
    expect(categoryForKind(notice!.kind)).toBe(NotificationCategory.STOP_LOSS);
    expect(notice?.title('42')).toContain('stopped out');
  });

  it('treats a trailing stop as a stop loss', () => {
    const notice = describeEvent(
      envelope(DomainEvent.POSITION_CLOSED, {
        symbol: 'XAUUSD',
        reason: CloseReason.TRAILING_STOP,
        netPnl: '80',
        fullyClosed: true,
      }),
    );
    expect(categoryForKind(notice!.kind)).toBe(NotificationCategory.STOP_LOSS);
  });

  it('gives a take profit its own category', () => {
    const notice = describeEvent(
      envelope(DomainEvent.POSITION_CLOSED, {
        symbol: 'BTCUSDT',
        reason: CloseReason.TAKE_PROFIT,
        netPnl: '340.00',
        fullyClosed: true,
      }),
    );
    expect(categoryForKind(notice!.kind)).toBe(NotificationCategory.TAKE_PROFIT);
    expect(notice?.body).toContain('+340.00');
  });

  it('marks a partial close as such', () => {
    const notice = describeEvent(
      envelope(DomainEvent.POSITION_CLOSED, {
        symbol: 'BTCUSDT',
        reason: CloseReason.MANUAL,
        netPnl: '10',
        fullyClosed: false,
      }),
    );
    expect(notice?.kind).toBe('position.partial_close');
    expect(notice?.title('42')).toContain('partially closed');
  });

  it('treats a liquidation as critical', () => {
    const notice = describeEvent(
      envelope(DomainEvent.POSITION_CLOSED, {
        symbol: 'BTCUSDT',
        reason: CloseReason.LIQUIDATION,
        netPnl: '-2000',
        fullyClosed: true,
      }),
    );
    expect(notice?.severity).toBe('CRITICAL');
  });

  it('shows a loss with its sign and a profit with a plus', () => {
    const loss = describeEvent(
      envelope(DomainEvent.POSITION_CLOSED, { symbol: 'X', netPnl: '-12.5', fullyClosed: true }),
    );
    const profit = describeEvent(
      envelope(DomainEvent.POSITION_CLOSED, { symbol: 'X', netPnl: '12.5', fullyClosed: true }),
    );
    // On a lock screen the sign is the entire message.
    expect(loss?.body).toContain('-12.5');
    expect(profit?.body).toContain('+12.5');
  });

  it('sounds different when a trade is modified', () => {
    const opened = describeEvent(envelope(DomainEvent.POSITION_OPENED, { symbol: 'X' }));
    const modified = describeEvent(
      envelope(DomainEvent.POSITION_MODIFIED, { symbol: 'X', stopLoss: '100', takeProfit: null }),
    );
    expect(categoryForKind(modified!.kind)).toBe(NotificationCategory.TRADE_MODIFIED);
    expect(categoryForKind(modified!.kind)).not.toBe(categoryForKind(opened!.kind));
  });

  it('says when a stop was removed rather than showing nothing', () => {
    const notice = describeEvent(
      envelope(DomainEvent.POSITION_MODIFIED, { symbol: 'X', stopLoss: null, takeProfit: '200' }),
    );
    expect(notice?.body).toContain('stop loss removed');
    expect(notice?.body).toContain('take profit 200');
  });

  it('says nothing about a fill, because the position event already did', () => {
    // Both are published for one action. Notifying on both would buzz the phone
    // twice for one trade — the duplicate §26 is about, arriving by design.
    expect(describeEvent(envelope(DomainEvent.ORDER_FILLED, { symbol: 'X' }))).toBeNull();
  });

  it('says nothing about a balance change', () => {
    expect(describeEvent(envelope(DomainEvent.BALANCE_CHANGED, { balance: '1' }))).toBeNull();
  });

  it('leaves margin calls to the risk path, which knows the numbers', () => {
    expect(describeEvent(envelope(DomainEvent.MARGIN_CALL, {}))).toBeNull();
    expect(describeEvent(envelope(DomainEvent.LIQUIDATION, {}))).toBeNull();
  });

  it('survives an event with nothing useful in it', () => {
    const notice = describeEvent(envelope(DomainEvent.POSITION_OPENED, {}));
    // A missing symbol must not produce "undefined opened" on somebody's lock
    // screen, and must not throw inside an event handler either.
    expect(notice?.title('42')).not.toContain('undefined');
    expect(notice?.body).not.toContain('undefined');
  });

  it('maps every kind it produces to a real category', () => {
    const kinds = [
      'position.opened',
      'position.closed',
      'position.partial_close',
      'position.modified',
      'position.stop_loss',
      'position.take_profit',
      'order.cancelled',
    ];
    for (const kind of kinds) {
      // An unmapped kind falls back to SYSTEM, which has no sound — so a typo
      // here would silently produce a mute notification.
      expect(categoryForKind(kind), kind).not.toBe(NotificationCategory.SYSTEM);
    }
  });
});
