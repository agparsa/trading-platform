import { describe, expect, it } from 'vitest';
import { Feature } from '@tp/shared-types';
import { mobileTradingDecision } from './mobile-trading';

describe('mobile trading flag', () => {
  it('allows opening when the firm has it on', () => {
    const decision = mobileTradingDecision({ [Feature.MOBILE_TRADING]: true });
    expect(decision.mayOpen).toBe(true);
    expect(decision.reason).toBeNull();
  });

  it('refuses opening when the firm has it off, and says why', () => {
    const decision = mobileTradingDecision({ [Feature.MOBILE_TRADING]: false });
    expect(decision.mayOpen).toBe(false);
    expect(decision.reason).toContain('switched off');
    // Told, not hidden: an order that quietly stops being possible is worse
    // than one that is refused out loud.
    expect(decision.reason?.length ?? 0).toBeGreaterThan(40);
  });

  /**
   * A firm turning a product off may remove a way in. It may not remove the way
   * out — the same reasoning that lets a trader clear a trailing stop the firm
   * will not let them set.
   */
  it('never stops a trader closing what they already hold', () => {
    for (const features of [
      { [Feature.MOBILE_TRADING]: false },
      { [Feature.MOBILE_TRADING]: true },
      {},
      undefined,
    ]) {
      expect(mobileTradingDecision(features).mayClose).toBe(true);
    }
  });

  /**
   * Unknown means yes. This is a product preference the server enforces
   * nowhere, so failing closed would strand a trader over a lost signal to
   * uphold a setting nobody is relying on for safety.
   */
  it('allows opening when the flags have not loaded or do not mention it', () => {
    expect(mobileTradingDecision(undefined).mayOpen).toBe(true);
    expect(mobileTradingDecision({}).mayOpen).toBe(true);
    expect(mobileTradingDecision({ quick_trading: false }).mayOpen).toBe(true);
  });

  it('treats only an explicit false as off', () => {
    expect(mobileTradingDecision({ [Feature.MOBILE_TRADING]: true }).mayOpen).toBe(true);
    expect(
      mobileTradingDecision({ [Feature.MOBILE_TRADING]: undefined as unknown as boolean }).mayOpen,
    ).toBe(true);
  });
});
