import { isDecimalString } from './ticket';

/**
 * How this trader wants the terminal to behave.
 *
 * These are **input preferences**, not account state, and that distinction is
 * why they live in the browser rather than behind an API. Nothing here changes
 * what the server will accept: an order sent with one click is validated
 * identically to one sent with three, by the same engine, against the same
 * limits. What they change is how many gestures stand between a decision and a
 * request.
 *
 * Keeping them per-device is also the safer default for the one setting that
 * matters. "Skip the confirmation" syncing silently onto a machine the trader
 * did not arm is a worse failure than having to arm it twice.
 */

export interface TradingPreferences {
  /** Send on a single click, with no confirmation step in the ticket. */
  oneClick: boolean;
  /** Ask before sending, even with one-click armed. Destructive actions ignore this being off. */
  confirm: boolean;
  /** Prefilled volume for a one-click order. */
  defaultVolume: string;
  /** Prefilled protective levels, empty for none. */
  defaultStopLoss: string;
  defaultTakeProfit: string;
  /** Keyboard trading, and the keys it listens for. */
  keyboard: boolean;
  keys: KeyMap;
}

export interface KeyMap {
  buy: string;
  sell: string;
  close: string;
  closeAll: string;
}

export const DEFAULT_KEYS: KeyMap = { buy: 'b', sell: 's', close: 'c', closeAll: 'C' };

/**
 * One-click is **off** by default, and confirmation **on**.
 *
 * A terminal that arrives already able to send an order on a single keystroke
 * has made a decision about somebody's money that they did not make. Arming it
 * is the trader's act.
 */
export const DEFAULT_PREFERENCES: TradingPreferences = {
  oneClick: false,
  confirm: true,
  defaultVolume: '0.10',
  defaultStopLoss: '',
  defaultTakeProfit: '',
  keyboard: false,
  keys: DEFAULT_KEYS,
};

const STORAGE_KEY = 'tp:trading-preferences';

/**
 * Reads stored preferences, falling back to the defaults for anything missing
 * or malformed.
 *
 * Deliberately forgiving in one direction only: an unreadable value becomes the
 * *safe* default rather than being trusted. A corrupted store must not be able
 * to arm one-click trading or disarm a confirmation.
 */
export function loadPreferences(storage: Pick<Storage, 'getItem'> | undefined): TradingPreferences {
  if (storage === undefined) return DEFAULT_PREFERENCES;
  let raw: string | null = null;
  try {
    raw = storage.getItem(STORAGE_KEY);
  } catch {
    // A browser with storage disabled is a browser that trades with defaults.
    return DEFAULT_PREFERENCES;
  }
  if (raw === null) return DEFAULT_PREFERENCES;

  try {
    return sanitise(JSON.parse(raw) as unknown);
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

export function savePreferences(
  storage: Pick<Storage, 'setItem'> | undefined,
  preferences: TradingPreferences,
): void {
  if (storage === undefined) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(sanitise(preferences)));
  } catch {
    // Quota, private mode, a disabled store: the session keeps the preference in
    // memory and simply does not remember it next time. Not worth an error.
  }
}

/**
 * Forces a stored blob into a shape the terminal can trust.
 *
 * Every field is checked against its own rule rather than the object being
 * spread over the defaults: a spread would let `{"oneClick": "yes"}` through as
 * truthy, and `"yes"` is not a decision anybody made.
 */
export function sanitise(value: unknown): TradingPreferences {
  if (value === null || typeof value !== 'object') return DEFAULT_PREFERENCES;
  const input = value as Record<string, unknown>;
  const keys = input['keys'] as Record<string, unknown> | undefined;

  return {
    oneClick: input['oneClick'] === true,
    // Note the asymmetry: confirmation is on unless it is *explicitly* false.
    // Anything unreadable leaves the safer behaviour in place.
    confirm: input['confirm'] !== false,
    defaultVolume: decimalOr(input['defaultVolume'], DEFAULT_PREFERENCES.defaultVolume),
    defaultStopLoss: decimalOr(input['defaultStopLoss'], ''),
    defaultTakeProfit: decimalOr(input['defaultTakeProfit'], ''),
    keyboard: input['keyboard'] === true,
    keys: {
      buy: keyOr(keys?.['buy'], DEFAULT_KEYS.buy),
      sell: keyOr(keys?.['sell'], DEFAULT_KEYS.sell),
      close: keyOr(keys?.['close'], DEFAULT_KEYS.close),
      closeAll: keyOr(keys?.['closeAll'], DEFAULT_KEYS.closeAll),
    },
  };
}

/** An empty string means "no default level", which is different from a bad one. */
function decimalOr(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  if (trimmed === '') return '';
  return isDecimalString(trimmed) ? trimmed : fallback;
}

function keyOr(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length === 1 ? value : fallback;
}
