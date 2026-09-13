import { describe, expect, it } from 'vitest';
import { isTighter } from './risk-limits.service';

/**
 * Which of two ceilings is tighter, decided without floating point.
 *
 * ## What this exists to stop
 *
 * `isTighter` decides two things that matter. `RiskLimitsService` uses it to
 * pick the ceiling that actually governs an account, and
 * `RiskHierarchyService.refuseLooser` uses it to refuse a layer that tries to
 * loosen what the layer above allows — the attack the pentest names as "raise a
 * ceiling set above you".
 *
 * It compared with `Number()`. Two limits that agree in their first sixteen or
 * so significant digits collapse to the same double, so `<` is false for a pair
 * that is genuinely ordered:
 *
 *   Number('100000000000000000001') === Number('100000000000000000002')  // true
 *   Number('12345678.9012345678')   === Number('12345678.9012345679')    // true
 *
 * In `refuseLooser` that false `false` means the refusal does not fire and the
 * looser value is accepted past the ceiling above it. In the tightest-of
 * selection it means a genuinely tighter ceiling is not chosen.
 *
 * ## How reachable is it, honestly
 *
 * Not very. `maxGrossNotional` is `Decimal(28,10)`, so reaching the collapse
 * needs ceilings above roughly 1e16 — ten quadrillion — or volumes carried to
 * eighteen significant digits. Nobody sets those by hand.
 *
 * It is fixed anyway, for three reasons. The fix is one line and free. Two
 * audit documents state the rule with no qualification — "no floating-point
 * arithmetic touches money anywhere", "without exception" — and a rule with a
 * quiet exception in it is worse than a rule with a stated one. And the line
 * directly above the other instance of this, in the risk console, does the
 * arithmetic correctly with `toDecimal().minus()` before throwing the result
 * into `Number()` to sort — which is what this class of defect looks like from
 * the inside: right instinct, wrong tool, one line apart.
 */
describe('isTighter', () => {
  it('orders ordinary ceilings the obvious way', () => {
    expect(isTighter('maxGrossNotional', '100', '200')).toBe(true);
    expect(isTighter('maxGrossNotional', '200', '100')).toBe(false);
    expect(isTighter('maxOpenPositions', 2, 5)).toBe(true);
    expect(isTighter('maxOpenPositions', 5, 2)).toBe(false);
  });

  it('does not compare decimal strings lexically', () => {
    // '9' > '10' as text. The original comment on this function names this bug
    // as the one it was written to avoid, and it does avoid it.
    // 9 is the tighter ceiling, even though '9' sorts after '10' as text.
    expect(isTighter('maxPositionVolume', '9', '10')).toBe(true);
    expect(isTighter('maxPositionVolume', '10', '9')).toBe(false);
  });

  it('treats equal ceilings as not tighter, so restating a layer is allowed', () => {
    // `refuseLooser` relies on this: repeating the value from the layer above
    // must not be read as loosening it.
    expect(isTighter('maxGrossNotional', '1000', '1000')).toBe(false);
    expect(isTighter('maxGrossNotional', '1000.0000000000', '1000')).toBe(false);
  });

  /**
   * The pair that `Number()` cannot tell apart. Both directions are asserted,
   * because getting one right by accident proves nothing.
   */
  it('separates ceilings that collapse to the same double', () => {
    const smaller = '100000000000000000001';
    const larger = '100000000000000000002';
    expect(Number(smaller), 'the premise: these are one double').toBe(Number(larger));

    expect(isTighter('maxGrossNotional', smaller, larger)).toBe(true);
    expect(isTighter('maxGrossNotional', larger, smaller)).toBe(false);
  });

  it('separates volumes that collapse at the far end of Decimal(28,10)', () => {
    const smaller = '12345678.9012345678';
    const larger = '12345678.9012345679';
    expect(Number(smaller)).toBe(Number(larger));

    expect(isTighter('maxPositionVolume', smaller, larger)).toBe(true);
    expect(isTighter('maxSymbolNetVolume', larger, smaller)).toBe(false);
  });

  /**
   * The direction that costs something.
   *
   * `refuseLooser` throws when the ceiling above is tighter than the requested
   * value. A false `false` here is a loosening that is not refused, which is
   * why this is spelled out as its own case rather than left implied by the
   * pair above.
   */
  it('still reports a ceiling above as tighter when the difference is tiny', () => {
    const ceilingAbove = '100000000000000000001';
    const requested = '100000000000000000002';
    expect(
      isTighter('maxGrossNotional', ceilingAbove, requested),
      'if this is false, refuseLooser lets the looser value through',
    ).toBe(true);
  });
});
