import { describe, expect, it } from 'vitest';
import { describePatch, pendingOrderPatch, protectivePatch, sameLevel } from './protective-levels';

const original = { stopLoss: '4500.00', takeProfit: '4700.00' };

/**
 * Three states, two of which a text box cannot express on its own.
 *
 * `null` clears, omitted leaves unchanged, a value sets. Getting it wrong
 * leaves a trader either protected when they think they are not, or unprotected
 * when they think they are — and neither is visible on the screen afterwards.
 */
describe('building a protective-levels patch', () => {
  it('sends nothing when nothing changed', () => {
    expect(protectivePatch({ stopLoss: '4500.00', takeProfit: '4700.00' }, original)).toBeNull();
  });

  it('sends null when the trader clears the stop loss', () => {
    const patch = protectivePatch({ stopLoss: '', takeProfit: '4700.00' }, original);
    // Explicitly null, not omitted. Omitting it leaves the stop in place on a
    // position the trader believes is now unprotected.
    expect(patch).toEqual({ stopLoss: null });
    expect('stopLoss' in patch!).toBe(true);
  });

  it('sends the new level when the trader moves it', () => {
    expect(protectivePatch({ stopLoss: '4550.00', takeProfit: '4700.00' }, original)).toEqual({
      stopLoss: '4550.00',
    });
  });

  it('sets a level that was not there before', () => {
    const patch = protectivePatch(
      { stopLoss: '4400.00', takeProfit: '' },
      { stopLoss: null, takeProfit: null },
    );
    expect(patch).toEqual({ stopLoss: '4400.00' });
  });

  it('changes both when both moved', () => {
    expect(protectivePatch({ stopLoss: '4400', takeProfit: '4800' }, original)).toEqual({
      stopLoss: '4400',
      takeProfit: '4800',
    });
  });

  it('ignores a reformatted but identical level', () => {
    // "4500.0000" is the same stop as "4500.00". Sending a patch for it is a
    // needless write on an audited table and a needless audit row.
    expect(protectivePatch({ stopLoss: '4500.0000', takeProfit: '4700' }, original)).toBeNull();
  });

  it('ignores surrounding whitespace', () => {
    expect(
      protectivePatch({ stopLoss: '  4500.00  ', takeProfit: '4700.00' }, original),
    ).toBeNull();
  });

  it('treats a whitespace-only box as cleared', () => {
    expect(protectivePatch({ stopLoss: '   ', takeProfit: '4700.00' }, original)).toEqual({
      stopLoss: null,
    });
  });

  it('does not confuse clearing with setting zero', () => {
    // "0" is a value the server will reject as a price; "" is a deliberate
    // removal. They must not collapse into each other here.
    const cleared = protectivePatch({ stopLoss: '', takeProfit: '4700.00' }, original);
    const zero = protectivePatch({ stopLoss: '0', takeProfit: '4700.00' }, original);
    expect(cleared).toEqual({ stopLoss: null });
    expect(zero).toEqual({ stopLoss: '0' });
  });
});

describe('comparing two levels', () => {
  it('treats null as different from a value', () => {
    expect(sameLevel(null, '1')).toBe(false);
    expect(sameLevel('1', null)).toBe(false);
    expect(sameLevel(null, null)).toBe(true);
  });

  it('compares numerically', () => {
    expect(sameLevel('1.50', '1.5000')).toBe(true);
    expect(sameLevel('1.50', '1.51')).toBe(false);
  });

  it('does not treat two unparseable values as equal by accident', () => {
    // NaN === NaN is false, which would make every patch look like a change.
    expect(sameLevel('abc', 'abc')).toBe(true);
    expect(sameLevel('abc', 'def')).toBe(false);
  });
});

describe('describing the change', () => {
  it('says plainly that a stop is being removed', () => {
    // "Are you sure?" confirms nothing. This is the sentence a trader needs to
    // read before agreeing to trade without a stop.
    expect(describePatch({ stopLoss: null })).toContain('unprotected');
  });

  it('names the new level', () => {
    expect(describePatch({ stopLoss: '4400' })).toContain('4400');
  });

  it('describes both changes', () => {
    const text = describePatch({ stopLoss: '4400', takeProfit: null });
    expect(text).toContain('stop loss');
    expect(text).toContain('take profit');
  });
});

describe('building a resting-order patch', () => {
  const original = {
    price: '4500.00',
    volume: '0.10',
    stopLoss: '4400.00',
    takeProfit: '4700.00',
  };
  const unchanged = {
    price: '4500.00',
    volume: '0.10',
    stopLoss: '4400.00',
    takeProfit: '4700.00',
  };

  it('sends nothing when nothing changed', () => {
    expect(pendingOrderPatch(unchanged, original)).toBeNull();
  });

  it('sends a moved price', () => {
    expect(pendingOrderPatch({ ...unchanged, price: '4450.00' }, original)).toEqual({
      price: '4450.00',
    });
  });

  it('sends a resized volume', () => {
    expect(pendingOrderPatch({ ...unchanged, volume: '0.20' }, original)).toEqual({
      volume: '0.20',
    });
  });

  it('clears a stop loss with null, as the levels rule requires', () => {
    expect(pendingOrderPatch({ ...unchanged, stopLoss: '' }, original)).toEqual({
      stopLoss: null,
    });
  });

  it('treats an empty price as "leave it alone", not "clear it"', () => {
    /**
     * The rule that differs between the two halves of this form.
     *
     * An order without a price is not an order, so the API does not accept null
     * there. An empty box is a half-finished edit; sending nothing for it means
     * the trader's other changes still land instead of the whole patch being
     * rejected over one blank field.
     */
    expect(pendingOrderPatch({ ...unchanged, price: '', volume: '0.20' }, original)).toEqual({
      volume: '0.20',
    });
  });

  it('changes several fields at once', () => {
    expect(
      pendingOrderPatch(
        { price: '4450.00', volume: '0.20', stopLoss: '', takeProfit: '4800.00' },
        original,
      ),
    ).toEqual({ price: '4450.00', volume: '0.20', stopLoss: null, takeProfit: '4800.00' });
  });

  it('ignores a reformatted but identical price', () => {
    expect(pendingOrderPatch({ ...unchanged, price: '4500.0000' }, original)).toBeNull();
  });
});
