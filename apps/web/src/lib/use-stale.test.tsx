// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { STALE_AFTER_MS, useStale } from './use-stale';

function Probe({ version, active }: { version: unknown; active: boolean }) {
  return <span data-testid="stale">{String(useStale(version, active))}</span>;
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('a price that stops moving', () => {
  it('is called stale after ten seconds without a new quote, and fresh again on the next', () => {
    vi.useFakeTimers();
    const { rerender } = render(<Probe version={1} active />);
    act(() => void vi.advanceTimersByTime(STALE_AFTER_MS - 1));
    expect(screen.getByTestId('stale').textContent).toBe('false');
    act(() => void vi.advanceTimersByTime(1));
    expect(screen.getByTestId('stale').textContent).toBe('true');
    rerender(<Probe version={2} active />);
    expect(screen.getByTestId('stale').textContent).toBe('false');
  });

  it('is never stale while the market is closed', () => {
    vi.useFakeTimers();
    render(<Probe version={1} active={false} />);
    act(() => void vi.advanceTimersByTime(STALE_AFTER_MS * 3));
    expect(screen.getByTestId('stale').textContent).toBe('false');
  });
});
