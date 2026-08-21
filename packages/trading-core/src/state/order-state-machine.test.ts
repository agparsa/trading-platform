import { describe, expect, it } from 'vitest';
import { DomainError, OrderStatus, TradingErrorCode } from '@tp/shared-types';
import {
  allowedOrderTransitions,
  canTransitionOrder,
  isTerminalOrderStatus,
  transitionOrder,
} from './order-state-machine';

describe('order state machine', () => {
  it('walks the happy path of a market order', () => {
    let status: OrderStatus = OrderStatus.NEW;
    status = transitionOrder(status, OrderStatus.ACCEPTED);
    status = transitionOrder(status, OrderStatus.FILLED);
    expect(status).toBe(OrderStatus.FILLED);
  });

  it('walks the happy path of a pending order', () => {
    let status: OrderStatus = OrderStatus.NEW;
    status = transitionOrder(status, OrderStatus.PENDING);
    status = transitionOrder(status, OrderStatus.TRIGGERED);
    status = transitionOrder(status, OrderStatus.FILLED);
    expect(status).toBe(OrderStatus.FILLED);
  });

  it('treats every terminal status as a dead end', () => {
    for (const terminal of [
      OrderStatus.FILLED,
      OrderStatus.CANCELLED,
      OrderStatus.REJECTED,
      OrderStatus.EXPIRED,
    ]) {
      expect(isTerminalOrderStatus(terminal)).toBe(true);
      expect(allowedOrderTransitions(terminal)).toHaveLength(0);
    }
  });

  it('refuses to revive a cancelled order', () => {
    expect(() => transitionOrder(OrderStatus.CANCELLED, OrderStatus.FILLED)).toThrow(DomainError);
    try {
      transitionOrder(OrderStatus.CANCELLED, OrderStatus.FILLED);
    } catch (e) {
      expect((e as DomainError).code).toBe(TradingErrorCode.INVALID_STATE_TRANSITION);
    }
  });

  it('lets a fill win a race against a cancel request', () => {
    expect(canTransitionOrder(OrderStatus.CANCEL_REQUESTED, OrderStatus.FILLED)).toBe(true);
    expect(canTransitionOrder(OrderStatus.CANCEL_REQUESTED, OrderStatus.CANCELLED)).toBe(true);
  });

  it('allows a failed modify to fall back to the prior status', () => {
    expect(canTransitionOrder(OrderStatus.MODIFY_REQUESTED, OrderStatus.ACCEPTED)).toBe(true);
    expect(canTransitionOrder(OrderStatus.MODIFY_REQUESTED, OrderStatus.PENDING)).toBe(true);
  });

  it('allows repeated partial fills', () => {
    expect(canTransitionOrder(OrderStatus.PARTIALLY_FILLED, OrderStatus.PARTIALLY_FILLED)).toBe(
      true,
    );
  });

  it('declares every status in the table, so no status is unreachable by omission', () => {
    for (const status of Object.values(OrderStatus)) {
      expect(allowedOrderTransitions(status)).toBeDefined();
    }
  });
});
