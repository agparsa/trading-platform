import type { RiskRule } from '../types';
import { sufficientMarginRule } from './margin';
import {
  maxGrossNotionalRule,
  maxOpenPositionsRule,
  maxPositionVolumeRule,
  maxSymbolNetVolumeRule,
  symbolTradeableRule,
} from './limits';

export * from './margin';
export * from './limits';

/**
 * The rule set every account is checked against by default.
 * Order matters only for the order violations are reported in.
 */
export const DEFAULT_RISK_RULES: readonly RiskRule[] = [
  symbolTradeableRule,
  sufficientMarginRule,
  maxPositionVolumeRule,
  maxOpenPositionsRule,
  maxSymbolNetVolumeRule,
  maxGrossNotionalRule,
];
