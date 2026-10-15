/**
 * Light or dark, chosen per device.
 *
 * The terminal is dark by default — it is looked at for hours — and a trader
 * in a bright room, or one who reads better on a light page, can switch. The
 * choice changes the page's colours and nothing else, so it lives beside the
 * other per-device preferences rather than on the server: a theme is not an
 * account setting any more than window size is.
 *
 * `system` follows the operating system's own setting and keeps following it.
 *
 * The stored value is untrusted on the way back in: anything that is not one
 * of the three names is "no choice", which is dark.
 */

export type ThemeChoice = 'dark' | 'light' | 'system';
export type Theme = 'dark' | 'light';

export const THEME_STORAGE_KEY = 'tp:theme';

export const THEME_CHOICES: readonly ThemeChoice[] = ['dark', 'light', 'system'];

export function isThemeChoice(value: unknown): value is ThemeChoice {
  return value === 'dark' || value === 'light' || value === 'system';
}

export function loadThemeChoice(storage: Pick<Storage, 'getItem'> | undefined): ThemeChoice {
  if (storage === undefined) return 'dark';
  try {
    const raw = storage.getItem(THEME_STORAGE_KEY);
    return isThemeChoice(raw) ? raw : 'dark';
  } catch {
    return 'dark';
  }
}

export function saveThemeChoice(
  storage: Pick<Storage, 'setItem'> | undefined,
  choice: ThemeChoice,
): void {
  if (storage === undefined) return;
  try {
    storage.setItem(THEME_STORAGE_KEY, choice);
  } catch {
    // Private mode, a full quota: this session keeps the choice; the next does not.
  }
}

/** What the page shows for a choice, given whether the system prefers dark. */
export function resolveTheme(choice: ThemeChoice, systemPrefersDark: boolean): Theme {
  if (choice === 'system') return systemPrefersDark ? 'dark' : 'light';
  return choice;
}

/**
 * The script that sets the theme before the first paint.
 *
 * Without it a light-theme trader sees a dark page flash on every load, for as
 * long as React takes to hydrate. It is the same rule as `resolveTheme`, in
 * the only form that can run before the bundle: a string in the document head.
 * `theme.test.ts` runs it against both answers to keep the two in step.
 */
export const THEME_BOOT_SCRIPT = `(function(){try{var c=localStorage.getItem('${THEME_STORAGE_KEY}');var d=window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches;var t=c==='light'?'light':c==='system'?(d?'dark':'light'):'dark';document.documentElement.dataset.theme=t;}catch(e){document.documentElement.dataset.theme='dark';}})();`;

/** Puts a theme on the page: the attribute the stylesheet and the chart both read. */
export function applyTheme(root: HTMLElement, theme: Theme): void {
  root.dataset['theme'] = theme;
}
