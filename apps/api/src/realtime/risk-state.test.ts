import { describe, expect, it } from 'vitest';
import { RiskState } from '@tp/shared-types';
import { classifyRiskState } from './realtime.service';

/**
 * Which risk state a margin level falls in.
 *
 * The whole value of this being a pure function is that the boundaries can be
 * pinned without a database, a socket or a clock — and the boundaries are where
 * every off-by-one in a threshold check lives.
 */
describe('classifyRiskState', () => {
  const thresholds = { marginCall: '100', stopOut: '50' };

  it('is normal well above the margin call level', () => {
    expect(classifyRiskState('1085.98', thresholds)).toBe(RiskState.NORMAL);
    expect(classifyRiskState('100.01', thresholds)).toBe(RiskState.NORMAL);
  });

  /**
   * At the level, not past it. A margin call configured at 100% means 100% is
   * the call — a trader told "you are at your margin call level" while the
   * platform still considers them normal has been told nothing useful.
   */
  it('calls exactly at the configured level', () => {
    expect(classifyRiskState('100', thresholds)).toBe(RiskState.MARGIN_CALL);
    expect(classifyRiskState('99.99', thresholds)).toBe(RiskState.MARGIN_CALL);
    expect(classifyRiskState('50.01', thresholds)).toBe(RiskState.MARGIN_CALL);
  });

  it('reports stop-out at and below the stop-out level, not margin call', () => {
    expect(classifyRiskState('50', thresholds)).toBe(RiskState.STOP_OUT);
    expect(classifyRiskState('12.5', thresholds)).toBe(RiskState.STOP_OUT);
    expect(classifyRiskState('0', thresholds)).toBe(RiskState.STOP_OUT);
  });

  /**
   * An account with no open positions has no margin level. It is idle, not in
   * trouble — reporting a stop-out because a number is absent would raise an
   * alarm on every account that has never traded.
   */
  it('treats an absent margin level as normal, not as zero', () => {
    expect(classifyRiskState(null, thresholds)).toBe(RiskState.NORMAL);
  });

  it('treats an unconfigured threshold as not enforced', () => {
    expect(classifyRiskState('10', { marginCall: null, stopOut: null })).toBe(RiskState.NORMAL);
    expect(classifyRiskState('10', { marginCall: '100', stopOut: null })).toBe(
      RiskState.MARGIN_CALL,
    );
    expect(classifyRiskState('10', { marginCall: null, stopOut: '50' })).toBe(RiskState.STOP_OUT);
  });

  it('does not classify from a value it cannot read', () => {
    expect(classifyRiskState('not-a-number', thresholds)).toBe(RiskState.NORMAL);
    expect(classifyRiskState('10', { marginCall: 'x', stopOut: 'y' })).toBe(RiskState.NORMAL);
  });

  /**
   * Stop-out is checked before margin call. With the order reversed an account
   * at 12% margin level — deep into liquidation territory — would be reported as
   * a margin call, because 12 is also below 100.
   */
  it('reports the more severe state when both thresholds are crossed', () => {
    expect(classifyRiskState('12', thresholds)).toBe(RiskState.STOP_OUT);
  });
});
