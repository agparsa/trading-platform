// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

/**
 * The web's notification settings, rendered against stand-ins for the two
 * hooks. What is tested is what the trader can do: risk alerts cannot be
 * hidden (and say so), email is a switch of its own, and a change goes to the
 * server as exactly the fields that changed.
 */
const calls: Array<{ category: string; patch: Record<string, boolean> }> = [];
const state: { data: unknown } = { data: undefined };

vi.mock('@/lib/queries', () => ({
  useNotificationPreferences: () => ({ isError: false, data: state.data }),
  useUpdateNotificationCategory: () => ({
    isPending: false,
    mutate: (input: { category: string; patch: Record<string, boolean> }) => calls.push(input),
  }),
}));

const { NotificationSettings } = await import('./notification-settings');

const category = (name: string, over: Record<string, unknown> = {}) => ({
  category: name,
  inApp: true,
  push: true,
  sound: true,
  email: false,
  unmutable: false,
  ...over,
});

afterEach(() => {
  cleanup();
  calls.length = 0;
});

describe('notification settings on the web', () => {
  it('cannot hide a risk alert, and can stop or start emailing one', () => {
    state.data = {
      categories: [
        category('RISK_ALERT', { unmutable: true, email: true }),
        category('ORDER_FILLED'),
        category('SYSTEM'),
      ],
    };
    render(<NotificationSettings />);

    const shown = screen.getByLabelText('Show Risk alerts') as HTMLInputElement;
    expect(shown.checked).toBe(true);
    expect(shown.disabled).toBe(true);
    expect(screen.getByText(/always shown/)).toBeTruthy();

    const email = screen.getByLabelText('Email Risk alerts') as HTMLInputElement;
    expect(email.checked).toBe(true);
    fireEvent.click(email);
    expect(calls).toEqual([{ category: 'RISK_ALERT', patch: { email: false } }]);

    // SYSTEM is not a thing a trader chooses about.
    expect(screen.queryByLabelText('Show System')).toBeNull();
  });

  it('hides a category from the bell and the phone together, and leaves email alone', () => {
    state.data = { categories: [category('ORDER_FILLED')] };
    render(<NotificationSettings />);
    fireEvent.click(screen.getByLabelText('Show Order filled'));
    expect(calls).toEqual([{ category: 'ORDER_FILLED', patch: { inApp: false, push: false } }]);
  });

  it('says so while loading rather than showing switches it does not know', () => {
    state.data = undefined;
    render(<NotificationSettings />);
    expect(screen.getByText(/Loading your notification settings/)).toBeTruthy();
    expect(screen.queryByRole('checkbox')).toBeNull();
  });
});
