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
  /** Confirm whatever is being asked about. */
  CONFIRM: 'CONFIRM',
  /** Back out of it. */
  CANCEL: 'CANCEL',
  /** Show what the keys do. */
  HELP: 'HELP',
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
  if (press.ctrlKey === true || press.metaKey === true || press.altKey === true) return null;

  /**
   * Escape works whether or not keyboard trading is armed, and even from inside
   * a field.
   *
   * It is the one key that only ever *stops* something. A trader who has an
   * order confirmation in front of them and cannot dismiss it because their
   * cursor happens to sit in the volume box is a trader who will click
   * something to get rid of it — which is precisely the outcome the
   * confirmation existed to prevent.
   */
  if (press.key === 'Escape') return ShortcutAction.CANCEL;

  if (!enabled) return null;
  if (isTextEntry(press.target)) return null;

  /**
   * Enter confirms, and only ever confirms something already on screen.
   *
   * It sends no order of its own. Enter is the most reflexively pressed key
   * there is, and a binding that could originate a trade from an idle terminal
   * would be the worst shortcut in the platform. The caller is responsible for
   * ignoring it when nothing is pending — see `Terminal`.
   */
  if (press.key === 'Enter') return ShortcutAction.CONFIRM;
  if (press.key === '?') return ShortcutAction.HELP;

  if (press.key === keys.closeAll) return ShortcutAction.CLOSE_ALL;
  if (press.key === keys.close) return ShortcutAction.CLOSE;
  if (press.key === keys.buy) return ShortcutAction.BUY;
  if (press.key === keys.sell) return ShortcutAction.SELL;
  return null;
}

/**
 * Does this action place or close a trade?
 *
 * The three navigation keys do not, and the distinction matters at every call
 * site that arms, confirms or logs a shortcut: `Escape` is not an order and
 * must not be treated as one — not by the confirmation logic, not by the
 * one-click warning, not by anything that counts trades.
 */
export function isTradingAction(action: ShortcutAction): boolean {
  return (
    action === ShortcutAction.BUY ||
    action === ShortcutAction.SELL ||
    action === ShortcutAction.CLOSE ||
    action === ShortcutAction.CLOSE_ALL
  );
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
  // A key that opens a help panel or dismisses a prompt is not a trade and has
  // nothing to confirm.
  if (!isTradingAction(action)) return false;
  return confirmPreference;
}
