// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('@/lib/use-locale', () => ({ useT: () => (key: string) => key }));

import { Toasts } from './toasts';
import { TOAST_FADE_MS, TOAST_TTL_MS, useToasts } from '@/lib/toasts';

afterEach(() => {
  cleanup();
  useToasts.getState().clear();
  vi.useRealTimers();
});

describe('the toast strip', () => {
  it('fades a routine notice after exactly ten seconds', () => {
    vi.useFakeTimers();
    render(<Toasts />);
    act(() =>
      useToasts.getState().push({ id: 'a', tone: 'success', sticky: false, title: 'Opened BUY' }),
    );
    act(() => void vi.advanceTimersByTime(TOAST_TTL_MS - 1));
    expect(screen.queryByText('Opened BUY')).not.toBeNull();
    act(() => void vi.advanceTimersByTime(1 + TOAST_FADE_MS));
    expect(screen.queryByText('Opened BUY')).toBeNull();
    expect(TOAST_TTL_MS).toBe(10_000);
  });

  it('keeps an error until it is dismissed by hand', () => {
    vi.useFakeTimers();
    render(<Toasts />);
    act(() =>
      useToasts
        .getState()
        .push({ id: 'e', tone: 'danger', sticky: false, title: 'Order rejected' }),
    );
    act(() => void vi.advanceTimersByTime(TOAST_TTL_MS * 3));
    expect(screen.queryByText('Order rejected')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'toast.dismiss' }));
    act(() => void vi.advanceTimersByTime(TOAST_FADE_MS));
    expect(screen.queryByText('Order rejected')).toBeNull();
  });

  it('restarts the ten seconds when the same news arrives again', () => {
    vi.useFakeTimers();
    render(<Toasts />);
    const push = () =>
      useToasts.getState().push({ id: 'p', tone: 'info', sticky: false, title: 'Updated' });
    act(push);
    act(() => void vi.advanceTimersByTime(TOAST_TTL_MS - 1_000));
    act(push);
    act(() => void vi.advanceTimersByTime(TOAST_TTL_MS - 1_000));
    expect(screen.queryByText('Updated')).not.toBeNull();
  });
});
