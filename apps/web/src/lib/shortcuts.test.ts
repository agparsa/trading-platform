import { describe, expect, it } from 'vitest';
import {
  ShortcutAction,
  actionFor,
  isTextEntry,
  isTradingAction,
  needsConfirmation,
} from './shortcuts';
import { DEFAULT_KEYS } from './trading-preferences';

const on = true;

describe('actionFor', () => {
  it('maps the four trading keys', () => {
    expect(actionFor({ key: 'b' }, DEFAULT_KEYS, on)).toBe(ShortcutAction.BUY);
    expect(actionFor({ key: 's' }, DEFAULT_KEYS, on)).toBe(ShortcutAction.SELL);
    expect(actionFor({ key: 'c' }, DEFAULT_KEYS, on)).toBe(ShortcutAction.CLOSE);
    expect(actionFor({ key: 'C', shiftKey: true }, DEFAULT_KEYS, on)).toBe(
      ShortcutAction.CLOSE_ALL,
    );
  });

  /**
   * The one this module exists for. `s` belongs in a volume box as readily as it
   * belongs on a sell button, and a trader typing "0.5" into a field must not
   * discover they have sold.
   */
  it('does nothing while the trader is typing', () => {
    for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT', 'input', 'textarea']) {
      expect(actionFor({ key: 's', target: { tagName } }, DEFAULT_KEYS, on)).toBeNull();
    }
    expect(
      actionFor(
        { key: 'b', target: { tagName: 'DIV', isContentEditable: true } },
        DEFAULT_KEYS,
        on,
      ),
    ).toBeNull();
  });

  it('still fires outside a field', () => {
    expect(actionFor({ key: 's', target: { tagName: 'DIV' } }, DEFAULT_KEYS, on)).toBe(
      ShortcutAction.SELL,
    );
    expect(actionFor({ key: 's', target: { tagName: 'BODY' } }, DEFAULT_KEYS, on)).toBe(
      ShortcutAction.SELL,
    );
  });

  /**
   * `Ctrl+S` is "save this page" in every browser ever made. A shortcut that
   * also read it as "sell" would fire on a reflex nobody aimed at the market.
   */
  it('ignores a keystroke carrying a modifier the map did not ask for', () => {
    expect(actionFor({ key: 's', ctrlKey: true }, DEFAULT_KEYS, on)).toBeNull();
    expect(actionFor({ key: 's', metaKey: true }, DEFAULT_KEYS, on)).toBeNull();
    expect(actionFor({ key: 'b', altKey: true }, DEFAULT_KEYS, on)).toBeNull();
  });

  /**
   * Case is what separates closing one position from closing all of them, so it
   * is matched exactly rather than folded and re-derived from `shiftKey` — which
   * a layout can produce without the case, or the case without it.
   */
  it('distinguishes close from close-all by case, not by luck', () => {
    expect(actionFor({ key: 'c' }, DEFAULT_KEYS, on)).toBe(ShortcutAction.CLOSE);
    expect(actionFor({ key: 'C' }, DEFAULT_KEYS, on)).toBe(ShortcutAction.CLOSE_ALL);
    // Shift reported without the case must not promote a single close.
    expect(actionFor({ key: 'c', shiftKey: true }, DEFAULT_KEYS, on)).toBe(ShortcutAction.CLOSE);
  });

  it('does nothing at all when keyboard trading is off', () => {
    for (const key of ['b', 's', 'c', 'C']) {
      expect(actionFor({ key }, DEFAULT_KEYS, false)).toBeNull();
    }
  });

  it('honours a remapped key and forgets the one it replaced', () => {
    const keys = { ...DEFAULT_KEYS, buy: 'q' };
    expect(actionFor({ key: 'q' }, keys, on)).toBe(ShortcutAction.BUY);
    expect(actionFor({ key: 'b' }, keys, on)).toBeNull();
  });

  it('means nothing by a key the map does not mention', () => {
    expect(actionFor({ key: 'z' }, DEFAULT_KEYS, on)).toBeNull();
    expect(actionFor({ key: ' ' }, DEFAULT_KEYS, on)).toBeNull();
    expect(actionFor({ key: 'F5' }, DEFAULT_KEYS, on)).toBeNull();
  });
});

describe('isTextEntry', () => {
  it('is false for nothing in particular', () => {
    expect(isTextEntry(null)).toBe(false);
    expect(isTextEntry(undefined)).toBe(false);
    expect(isTextEntry({})).toBe(false);
  });
});

describe('needsConfirmation', () => {
  /**
   * One-click exists to remove a step from an action a trader takes all day.
   * "Close everything" is not that action, and the setting that speeds up
   * routine trading must not quietly also arm the panic button.
   */
  it('always asks before closing everything, however the terminal is configured', () => {
    expect(needsConfirmation(ShortcutAction.CLOSE_ALL, true)).toBe(true);
    expect(needsConfirmation(ShortcutAction.CLOSE_ALL, false)).toBe(true);
  });

  it('follows the preference for everything else', () => {
    for (const action of [ShortcutAction.BUY, ShortcutAction.SELL, ShortcutAction.CLOSE]) {
      expect(needsConfirmation(action, true)).toBe(true);
      expect(needsConfirmation(action, false)).toBe(false);
    }
  });
});

// ─── Navigation keys ───────────────────────────────────────────────────────

describe('Escape, Enter and help', () => {
  /**
   * The one key that must always work. A trader who cannot dismiss a
   * confirmation because their cursor is in the volume box will click something
   * to get rid of it — which is what the confirmation existed to prevent.
   */
  it('cancels from anywhere, armed or not, field or no field', () => {
    expect(actionFor({ key: 'Escape' }, DEFAULT_KEYS, true)).toBe(ShortcutAction.CANCEL);
    expect(actionFor({ key: 'Escape' }, DEFAULT_KEYS, false)).toBe(ShortcutAction.CANCEL);
    expect(actionFor({ key: 'Escape', target: { tagName: 'INPUT' } }, DEFAULT_KEYS, true)).toBe(
      ShortcutAction.CANCEL,
    );
  });

  it('still refuses Escape with a modifier, which belongs to the browser', () => {
    expect(actionFor({ key: 'Escape', ctrlKey: true }, DEFAULT_KEYS, true)).toBeNull();
  });

  /**
   * Enter is the most reflexively pressed key there is. It confirms what is
   * already on screen and originates nothing.
   */
  it('confirms only when trading is armed, and never from a field', () => {
    expect(actionFor({ key: 'Enter' }, DEFAULT_KEYS, true)).toBe(ShortcutAction.CONFIRM);
    expect(actionFor({ key: 'Enter' }, DEFAULT_KEYS, false)).toBeNull();
    expect(
      actionFor({ key: 'Enter', target: { tagName: 'INPUT' } }, DEFAULT_KEYS, true),
    ).toBeNull();
  });

  it('offers help on ?', () => {
    expect(actionFor({ key: '?' }, DEFAULT_KEYS, true)).toBe(ShortcutAction.HELP);
    expect(actionFor({ key: '?' }, DEFAULT_KEYS, false)).toBeNull();
  });

  it('knows which actions are trades and which are not', () => {
    expect(isTradingAction(ShortcutAction.BUY)).toBe(true);
    expect(isTradingAction(ShortcutAction.CLOSE_ALL)).toBe(true);
    expect(isTradingAction(ShortcutAction.CANCEL)).toBe(false);
    expect(isTradingAction(ShortcutAction.CONFIRM)).toBe(false);
    expect(isTradingAction(ShortcutAction.HELP)).toBe(false);
  });

  it('never asks for confirmation of a key that is not a trade', () => {
    expect(needsConfirmation(ShortcutAction.CANCEL, true)).toBe(false);
    expect(needsConfirmation(ShortcutAction.HELP, true)).toBe(false);
    // And the trading keys are unchanged.
    expect(needsConfirmation(ShortcutAction.BUY, true)).toBe(true);
    expect(needsConfirmation(ShortcutAction.CLOSE_ALL, false)).toBe(true);
  });
});
