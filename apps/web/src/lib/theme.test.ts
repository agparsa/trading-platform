import { describe, expect, it } from 'vitest';
import {
  THEME_BOOT_SCRIPT,
  THEME_STORAGE_KEY,
  loadThemeChoice,
  resolveTheme,
  saveThemeChoice,
  type ThemeChoice,
} from './theme';

const store = (value: string | null) => ({ getItem: () => value });

describe('the theme choice', () => {
  it('is dark when nothing was chosen, or when what is stored is not a choice', () => {
    expect(loadThemeChoice(undefined)).toBe('dark');
    expect(loadThemeChoice(store(null))).toBe('dark');
    expect(loadThemeChoice(store('purple'))).toBe('dark');
    expect(
      loadThemeChoice({
        getItem: () => {
          throw new Error('blocked');
        },
      }),
    ).toBe('dark');
  });

  it('round-trips each of the three', () => {
    for (const choice of ['dark', 'light', 'system'] as const) {
      const backing = new Map<string, string>();
      saveThemeChoice({ setItem: (k, v) => void backing.set(k, v) }, choice);
      expect(loadThemeChoice({ getItem: (k) => backing.get(k) ?? null })).toBe(choice);
    }
  });

  it('follows the system only when asked to', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
  });
});

/**
 * The boot script is the same rule written as a string, because it has to run
 * before the bundle does. Two copies of a rule drift; running this one against
 * every case `resolveTheme` answers keeps them the same rule.
 */
describe('the boot script', () => {
  const run = (stored: string | null, systemDark: boolean, throws = false): string | undefined => {
    const dataset: Record<string, string> = {};
    const window = {
      matchMedia: () => ({ matches: systemDark }),
    };
    const localStorage = {
      getItem: (key: string) => {
        if (throws) throw new Error('blocked');
        return key === THEME_STORAGE_KEY ? stored : null;
      },
    };
    const document = { documentElement: { dataset } };
    new Function('window', 'localStorage', 'document', THEME_BOOT_SCRIPT)(
      window,
      localStorage,
      document,
    );
    return dataset['theme'];
  };

  it('agrees with resolveTheme on every choice and system setting', () => {
    for (const choice of ['dark', 'light', 'system'] as ThemeChoice[]) {
      for (const systemDark of [true, false]) {
        expect(run(choice, systemDark)).toBe(resolveTheme(choice, systemDark));
      }
    }
  });

  it('is dark when nothing is stored, something else is, or storage is refused', () => {
    expect(run(null, false)).toBe('dark');
    expect(run('purple', false)).toBe('dark');
    expect(run('light', false, true)).toBe('dark');
  });
});
