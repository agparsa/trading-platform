import { toDecimal } from '@tp/financial-core';
import { TradingErrorCode } from '@tp/shared-types';
import type { RiskRule, RiskViolation } from '../types';

export const maxPositionVolumeRule: RiskRule = {
  name: 'max-position-volume',
  evaluate(order, context): RiskViolation | null {
    const limit = context.limits.maxPositionVolume;
    if (limit === undefined) return null;
    if (toDecimal(order.volume).lte(toDecimal(limit))) return null;
    return {
      rule: 'max-position-volume',
      code: TradingErrorCode.MAX_POSITION_SIZE_EXCEEDED,
      message: `Order volume ${order.volume} exceeds the per-position limit of ${limit} lots`,
      details: { requested: order.volume, limit },
    };
  },
};

export const maxOpenPositionsRule: RiskRule = {
  name: 'max-open-positions',
  evaluate(_order, context): RiskViolation | null {
    const limit = context.limits.maxOpenPositions;
    if (limit === undefined) return null;
    if (context.openPositionCount < limit) return null;
    return {
      rule: 'max-open-positions',
      code: TradingErrorCode.MAX_OPEN_POSITIONS_EXCEEDED,
      message: `Account already holds the maximum of ${limit} open positions`,
      details: { open: context.openPositionCount, limit },
    };
  },
};

/**
 * Total gross notional across every symbol, including the proposed order.
 * Gross rather than net: two offsetting positions still carry execution and
 * gap risk, so they are not free.
 */
export const maxGrossNotionalRule: RiskRule = {
  name: 'max-gross-notional',
  evaluate(order, context): RiskViolation | null {
    const limit = context.limits.maxGrossNotional;
    if (limit === undefined) return null;
    let total = toDecimal(order.notional.amount);
    for (const exposure of context.exposureBySymbol.values()) {
      total = total.plus(exposure.grossNotional.amount);
    }
    if (total.lte(toDecimal(limit))) return null;
    return {
      rule: 'max-gross-notional',
      code: TradingErrorCode.MAX_EXPOSURE_EXCEEDED,
      message: 'Order would breach the account gross exposure limit',
      details: { projected: total.toString(), limit, currency: context.accountCurrency },
    };
  },
};

/** Net directional exposure in a single symbol, in lots. */
export const maxSymbolNetVolumeRule: RiskRule = {
  name: 'max-symbol-net-volume',
  evaluate(order, context): RiskViolation | null {
    const limit = context.limits.maxSymbolNetVolume;
    if (limit === undefined) return null;
    const existing = context.exposureBySymbol.get(order.symbol);
    const current = existing === undefined ? toDecimal(0) : toDecimal(existing.netVolume);
    const delta = toDecimal(order.volume).mul(order.side === 'BUY' ? 1 : -1);
    const projected = current.plus(delta).abs();
    if (projected.lte(toDecimal(limit))) return null;
    return {
      rule: 'max-symbol-net-volume',
      code: TradingErrorCode.MAX_EXPOSURE_EXCEEDED,
      message: `Order would take net ${order.symbol} exposure to ${projected.toString()} lots, above the ${limit} lot limit`,
      details: { symbol: order.symbol, projected: projected.toString(), limit },
    };
  },
};

export const symbolTradeableRule: RiskRule = {
  name: 'symbol-tradeable',
  evaluate(order): RiskViolation | null {
    if (order.spec.enabled) return null;
    return {
      rule: 'symbol-tradeable',
      code: TradingErrorCode.SYMBOL_NOT_TRADEABLE,
      message: `${order.symbol} is not currently tradeable`,
      details: { symbol: order.symbol },
    };
  },
};
