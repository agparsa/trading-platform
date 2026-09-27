import { DomainError, PositionStatus, TradingErrorCode } from '@tp/shared-types';

/**
 * Position lifecycle.
 *
 * CLOSING is a real state, not a UI flourish: it is what stops a second close
 * request, a stop-loss trigger and a liquidation from all closing the same
 * position three times. Whoever transitions OPEN -> CLOSING first owns the close.
 */
const POSITION_TRANSITIONS: Readonly<Record<PositionStatus, readonly PositionStatus[]>> = {
  /**
   * Only through CLOSING. The table allowed OPEN → CLOSED directly for as long
   * as it existed, and nothing ever took it: every close claims first, so the
   * claim is what a second close, a stop-loss and a liquidation contend for.
   * A direct move would be a close nothing could contend with — and no writer
   * of `position.status` asked this table anyway until `position-transitions`
   * in `order-transitions.test.ts` held them to it.
   */
  [PositionStatus.OPEN]: [PositionStatus.CLOSING],
  // Back to OPEN when a close attempt fails (e.g. no quote) and the position
  // survives, or when a partial close leaves volume open.
  [PositionStatus.CLOSING]: [PositionStatus.CLOSED, PositionStatus.OPEN],
  [PositionStatus.CLOSED]: [],
};

export function allowedPositionTransitions(from: PositionStatus): readonly PositionStatus[] {
  return POSITION_TRANSITIONS[from];
}

export function canTransitionPosition(from: PositionStatus, to: PositionStatus): boolean {
  return POSITION_TRANSITIONS[from].includes(to);
}

export function transitionPosition(from: PositionStatus, to: PositionStatus): PositionStatus {
  if (!canTransitionPosition(from, to)) {
    throw new DomainError(
      TradingErrorCode.INVALID_STATE_TRANSITION,
      `Position cannot move from ${from} to ${to}`,
      { from, to, allowed: POSITION_TRANSITIONS[from].join(',') },
    );
  }
  return to;
}

export function isPositionTradeable(status: PositionStatus): boolean {
  return status === PositionStatus.OPEN;
}
