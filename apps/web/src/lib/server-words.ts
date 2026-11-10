import type { MessageKey } from './messages';

/**
 * The server's codes, in words.
 *
 * Tables of message keys, one per vocabulary the server sends and a trader
 * reads: an order's status, why a position closed, an account's type and
 * status. `client-vocabularies.test.ts` holds each to its Prisma enum, so a
 * code added there and not here fails the build rather than appearing raw.
 * Exports (CSV) keep the codes: a file is read by programs too.
 */
export const ORDER_STATUS_WORDS: Readonly<Record<string, MessageKey>> = {
  NEW: 'code.order.NEW',
  PENDING: 'code.order.PENDING',
  ACCEPTED: 'code.order.ACCEPTED',
  UNCONFIRMED: 'code.order.UNCONFIRMED',
  TRIGGERED: 'code.order.TRIGGERED',
  PARTIALLY_FILLED: 'code.order.PARTIALLY_FILLED',
  FILLED: 'code.order.FILLED',
  MODIFY_REQUESTED: 'code.order.MODIFY_REQUESTED',
  CANCEL_REQUESTED: 'code.order.CANCEL_REQUESTED',
  CANCELLED: 'code.order.CANCELLED',
  REJECTED: 'code.order.REJECTED',
  EXPIRED: 'code.order.EXPIRED',
};

export const CLOSE_REASON_WORDS: Readonly<Record<string, MessageKey>> = {
  MANUAL: 'code.close.MANUAL',
  STOP_LOSS: 'code.close.STOP_LOSS',
  TAKE_PROFIT: 'code.close.TAKE_PROFIT',
  TRAILING_STOP: 'code.close.TRAILING_STOP',
  LIQUIDATION: 'code.close.LIQUIDATION',
  REVERSE: 'code.close.REVERSE',
  SYSTEM: 'code.close.SYSTEM',
};

export const ACCOUNT_STATUS_WORDS: Readonly<Record<string, MessageKey>> = {
  PENDING: 'code.account.PENDING',
  ACTIVE: 'code.account.ACTIVE',
  RESTRICTED: 'code.account.RESTRICTED',
  CLOSE_ONLY: 'code.account.CLOSE_ONLY',
  LOCKED: 'code.account.LOCKED',
  SUSPENDED: 'code.account.SUSPENDED',
  CLOSED: 'code.account.CLOSED',
};

export const ACCOUNT_TYPE_WORDS: Readonly<Record<string, MessageKey>> = {
  LIVE: 'code.accountType.LIVE',
  DEMO: 'code.accountType.DEMO',
};

export const ORDER_TYPE_WORDS: Readonly<Record<string, MessageKey>> = {
  MARKET: 'ticket.type.MARKET',
  LIMIT: 'ticket.type.LIMIT',
  STOP: 'ticket.type.STOP',
  STOP_LIMIT: 'ticket.type.STOP_LIMIT',
};
