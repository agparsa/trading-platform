import { I18nManager } from 'react-native';

/**
 * Whether the interface is laid out right-to-left.
 *
 * §43 asks for RTL where a Persian UI is used. Read from the platform rather
 * than from a setting: the person has already told their phone which way they
 * read, and asking again in a settings screen is asking them to repeat
 * themselves.
 *
 * Kept apart from `theme.ts` because importing `react-native` makes a module
 * untestable outside a device — the package ships Flow syntax that no plain
 * TypeScript runner will parse. Everything that can be decided without the
 * platform stays where it can be checked.
 */
export const isRtl = (): boolean => I18nManager.isRTL;

/**
 * Numbers stay left-to-right whichever way the interface runs.
 *
 * A price is a number in every locale, and mirroring `-1,204.50` produces
 * something that is not one.
 */
export const NUMERIC_DIRECTION = 'ltr' as const;
