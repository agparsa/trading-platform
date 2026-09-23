import { describe, expect, it } from 'vitest';
import { decideHaptic, silentHaptics, type HapticPreferences } from './haptics';

const on: HapticPreferences = { hapticsEnabled: true, perCategory: {} };

describe('haptic decisions', () => {
  it('vibrates for an event the trader wants', () => {
    expect(
      decideHaptic({ category: 'ORDER_FILLED', appActive: true, serverSaysNotify: true }, on),
    ).toEqual({ haptic: 'success', reason: 'vibrate' });
  });

  /**
   * The OS already vibrated when the push arrived. Vibrating again on waking is
   * the double-feedback bug, and it is harder to spot than its audio twin
   * because a double buzz just feels like a long one.
   */
  it('stays still when the app is in the background', () => {
    expect(
      decideHaptic({ category: 'ORDER_FILLED', appActive: false, serverSaysNotify: true }, on)
        .reason,
    ).toBe('app-in-background');
  });

  it('respects the master switch', () => {
    expect(
      decideHaptic(
        { category: 'ORDER_FILLED', appActive: true, serverSaysNotify: true },
        {
          ...on,
          hapticsEnabled: false,
        },
      ).haptic,
    ).toBeNull();
  });

  /**
   * One switch per category, shared with sound. A trader who said "don't tell
   * me about modifications" said it once.
   */
  it('respects a category the trader muted', () => {
    expect(
      decideHaptic(
        { category: 'TRADE_MODIFIED', appActive: true, serverSaysNotify: true },
        {
          ...on,
          perCategory: { TRADE_MODIFIED: false },
        },
      ),
    ).toEqual({ haptic: null, reason: 'category-muted' });
  });

  it('respects the server’s decision about this notification', () => {
    expect(
      decideHaptic({ category: 'ORDER_FILLED', appActive: true, serverSaysNotify: false }, on)
        .haptic,
    ).toBeNull();
  });

  /**
   * Not every notice deserves a buzz. A phone that vibrates at everything is a
   * phone whose owner turns haptics off, which costs them the two that were
   * worth feeling.
   */
  it('stays still for categories with no pattern', () => {
    expect(
      decideHaptic({ category: 'SYSTEM', appActive: true, serverSaysNotify: true }, on),
    ).toEqual({ haptic: null, reason: 'no-haptic-for-category' });
  });

  it('gives a protective level the warning pattern, not the routine one', () => {
    const stop = decideHaptic(
      { category: 'STOP_LOSS', appActive: true, serverSaysNotify: true },
      on,
    );
    const opened = decideHaptic(
      { category: 'TRADE_OPENED', appActive: true, serverSaysNotify: true },
      on,
    );
    expect(stop.haptic).toBe('warning');
    expect(opened.haptic).toBe('light');
    expect(stop.haptic).not.toBe(opened.haptic);
  });

  it('has a port that does nothing until a device is wired in', () => {
    expect(() => silentHaptics.vibrate('success')).not.toThrow();
  });
});
