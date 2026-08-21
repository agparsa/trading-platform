export const PositionStatus = {
  OPEN: 'OPEN',
  CLOSING: 'CLOSING',
  CLOSED: 'CLOSED',
} as const;
export type PositionStatus = (typeof PositionStatus)[keyof typeof PositionStatus];

/** Why a position stopped existing. Always recorded — never inferred later. */
export const CloseReason = {
  MANUAL: 'MANUAL',
  STOP_LOSS: 'STOP_LOSS',
  TAKE_PROFIT: 'TAKE_PROFIT',
  TRAILING_STOP: 'TRAILING_STOP',
  LIQUIDATION: 'LIQUIDATION',
  REVERSE: 'REVERSE',
  SYSTEM: 'SYSTEM',
} as const;
export type CloseReason = (typeof CloseReason)[keyof typeof CloseReason];
