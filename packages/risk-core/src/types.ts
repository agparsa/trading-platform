import type { Money, SymbolSpec } from '@tp/financial-core';
import type { OrderSide, TradingErrorCode } from '@tp/shared-types';

/** Everything a risk rule may look at. Rules receive this and nothing else. */
export interface RiskContext {
  readonly accountId: string;
  readonly accountCurrency: string;
  readonly accountLeverage: string;
  readonly equity: Money;
  readonly freeMargin: Money;
  readonly usedMargin: Money;
  /** Open positions, aggregated by symbol. */
  readonly exposureBySymbol: ReadonlyMap<string, SymbolExposure>;
  readonly openPositionCount: number;
  readonly limits: AccountRiskLimits;
  /** UTC ms — injected, never read from the wall clock inside a rule. */
  readonly now: number;
}

export interface SymbolExposure {
  readonly symbol: string;
  /** Net signed volume in lots: longs positive, shorts negative. */
  readonly netVolume: string;
  /** Sum of absolute notional across positions, in account currency. */
  readonly grossNotional: Money;
}

/**
 * Per-account risk limits. Every field is optional: an unset limit is not
 * enforced, and no rule invents a default. Limits are configuration, never
 * constants in code.
 */
export interface AccountRiskLimits {
  readonly maxPositionVolume?: string;
  readonly maxOpenPositions?: number;
  readonly maxGrossNotional?: string;
  readonly maxSymbolNetVolume?: string;
  readonly marginCallLevelPercent?: string;
  readonly stopOutLevelPercent?: string;
}

/** The order being risk-checked, already normalised and priced. */
export interface ProposedOrder {
  readonly symbol: string;
  readonly spec: SymbolSpec;
  readonly side: OrderSide;
  readonly volume: string;
  /** Price the check is evaluated at — the executable entry price. */
  readonly price: string;
  readonly requiredMargin: Money;
  readonly notional: Money;
}

export interface RiskViolation {
  readonly rule: string;
  readonly code: TradingErrorCode;
  readonly message: string;
  readonly details?: Record<string, string | number | boolean | null>;
}

export interface RiskDecision {
  readonly allowed: boolean;
  readonly violations: readonly RiskViolation[];
}

/**
 * A single, independently testable risk rule.
 *
 * Rules are pure functions of (order, context). They never read a database,
 * never call a clock, and never throw for a business reason — they return a
 * violation so the engine can report every problem at once rather than only the
 * first one a trader happens to hit.
 */
export interface RiskRule {
  readonly name: string;
  evaluate(order: ProposedOrder, context: RiskContext): RiskViolation | null;
}
