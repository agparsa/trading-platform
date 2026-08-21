import { TradingErrorCode } from '@tp/shared-types';
import type { ProposedOrder, RiskContext, RiskRule, RiskViolation } from '../types';

/**
 * Free margin must cover the new position's initial margin.
 *
 * Compared with `>=`, not `>`: an order that consumes exactly the remaining
 * free margin is legitimate and must not be rejected by an off-by-one.
 */
export const sufficientMarginRule: RiskRule = {
  name: 'sufficient-margin',
  evaluate(order: ProposedOrder, context: RiskContext): RiskViolation | null {
    if (context.freeMargin.gte(order.requiredMargin)) return null;
    return {
      rule: 'sufficient-margin',
      code: TradingErrorCode.INSUFFICIENT_MARGIN,
      message: 'Insufficient free margin',
      details: {
        required: order.requiredMargin.toString(),
        available: context.freeMargin.toString(),
        currency: context.accountCurrency,
      },
    };
  },
};
