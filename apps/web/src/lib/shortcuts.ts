import type { KeyMap } from './trading-preferences';

/**
 * Keyboard trading: which keystroke means what, and when it means nothing.
 *
 * Pure, and separate from the listener that calls it, because the interesting
 * part is not "does a keydown handler fire" but "does typing `s` into the volume
 * field sell a lot of gold". That question deserves a test it cannot pass by
 * accident.
 */

export const ShortcutAction = {
  BUY: 'BUY',
  SELL: 'SELL',
  CLOSE: 'CLOSE',
  CLOSE_ALL: 'CLOSE_ALL',
} as const;
export type ShortcutAction = (typeof ShortcutAction)[keyof typeof ShortcutAction];

/** Only what the decision needs, so a test does not have to build a DOM event. */
export interface KeyPress {
  key: string;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  /** The element the keystroke was aimed at. */
  target?: { tagName?: string; isContentEditable?: boolean } | null;
}

const TEXT_ENTRY = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

/**
 * Is the trader typing rather than trading?
 *
 * The single most dangerous thing a trading shortcut can do is fire while
 * somebody fills in a form. `s` belongs in a volume box as readily as it belongs
 * on a sell button, and the two must never be confused.
 */
export function isTextEntry(target: KeyPress['target']): boolean {
  if (target === null || target === undefined) return false;
  if (target.isContentEditable === true) return true;
  return TEXT_ENTRY.has((target.tagName ?? '').toUpperCase());
}

/**
 * The action a keystroke means, or `null`.
 *
 * Matching is case-sensitive on purpose: it is what separates `c` from `C`, and
 * therefore closing one position from closing every one of them. Comparing
 * case-insensitively and reading `shiftKey` separately would work too, until a
 * keyboard layout produced the shift without the case.
 *
 * A modifier the map did not ask for cancels the match. `Ctrl+S` is "save this
 * page" in every browser ever made, and it must not also be "sell".
 */
export function actionFor(press: KeyPress, keys: KeyMap, enabled: boolean): ShortcutAction | null {
  if (!enabled) return null;
  if (isTextEntry(press.target)) return null;
  if (press.ctrlKey === true || press.metaKey === true || press.altKey === true) return null;

  if (press.key === keys.closeAll) return ShortcutAction.CLOSE_ALL;
  if (press.key === keys.close) return ShortcutAction.CLOSE;
  if (press.key === keys.buy) return ShortcutAction.BUY;
  if (press.key === keys.sell) return ShortcutAction.SELL;
  return null;
}

/**
 * Does this action need asking about before it happens?
 *
 * Closing every position at once always does, whatever the trader has
 * configured. One-click exists to remove a step from an action they take all
 * day; "close everything" is not that action, and the setting that speeds up
 * routine trading must not silently also arm the panic button.
 */
export function needsConfirmation(action: ShortcutAction, confirmPreference: boolean): boolean {
  if (action === ShortcutAction.CLOSE_ALL) return true;
  return confirmPreference;
}
