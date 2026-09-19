// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DomainError, Permission } from '@tp/shared-types';

/**
 * The first rendering test of a component in this repository.
 *
 * `vitest.config.ts` restricted the web app to "pure logic only" for want of a
 * DOM environment, so every component's helpers were tested and no component
 * was. The browser suite renders 33 views and audits each for accessibility,
 * and it places its single order over HTTP rather than through this ticket — so
 * a component that computes the right answer and paints the wrong thing was
 * caught by nobody.
 *
 * It caught nothing here, either. The ticket held every risk violation the
 * server sent and rendered the first, because it read `error.message` and
 * dropped `details.violations`. The fix is a helper with its own unit tests;
 * *this* is the half those cannot reach — that the component asks the helper
 * and puts all of the answer on the screen.
 *
 * The mocks stop at the edge on purpose: the data hooks and the session are
 * replaced, and everything from the submit handler inward is the real
 * component.
 */
const mutateAsync = vi.fn();

vi.mock('@/lib/queries', () => ({
  useAccountState: () => ({ data: undefined }),
  useOpenPosition: () => ({ mutateAsync, isPending: false }),
  usePlacePending: () => ({ mutateAsync: vi.fn(), isPending: false }),
  usePermissions: () => ({ data: { role: 'TRADER', permissions: [Permission.ORDERS_CREATE] } }),
}));

vi.mock('@/lib/session', () => ({
  useSession: () => ({ api: {}, accessToken: 'test' }),
}));

const { OrderTicket } = await import('./order-ticket');
const { useRealtime } = await import('@/lib/realtime-store');
const { DEFAULT_PREFERENCES } = await import('@/lib/trading-preferences');

const SYMBOL = {
  code: 'XAUUSD',
  description: 'Gold',
  quoteCurrency: 'USD',
  contractSize: '100',
  tickSize: '0.01',
  pricePrecision: 2,
  volumeStep: '0.01',
  volumePrecision: 2,
  minVolume: '0.01',
  maxVolume: '50',
  marginRate: '0.01',
  commissionPerLot: '0',
  swapLongPerLot: '0',
  swapShortPerLot: '0',
  enabled: true,
  sessionOpen: true,
} as never;

const ACCOUNT = {
  id: 'acc-1',
  number: 'TP-100001',
  type: 'LIVE',
  status: 'ACTIVE',
  currency: 'USD',
  balance: '100.00',
  leverage: 100,
  createdAt: '2026-01-01T00:00:00.000Z',
} as never;

/**
 * The application's own defaults rather than a hand-built object: a fixture
 * that drifts from the real shape tests a component nobody ships.
 */
const PREFERENCES = { ...DEFAULT_PREFERENCES, confirm: false, oneClick: true } as never;

/** A quote, so the ticket has an executable price to price against. */
const quote = () => {
  useRealtime.setState({
    quotes: {
      XAUUSD: { symbol: 'XAUUSD', bid: '4583.58', ask: '4583.72', at: Date.now() },
    },
  } as never);
};

afterEach(() => {
  cleanup();
  mutateAsync.mockReset();
});

describe('the order ticket, rendered', () => {
  it('shows every violation the server sent, not only the first', async () => {
    mutateAsync.mockRejectedValue(
      new DomainError(
        'MAX_POSITION_SIZE_EXCEEDED' as never,
        'Order volume 5.00 exceeds the per-position limit of 2 lots',
        {
          violations: [
            'Order volume 5.00 exceeds the per-position limit of 2 lots',
            'Insufficient free margin',
          ],
        },
      ),
    );

    quote();
    render(
      <OrderTicket
        symbol={SYMBOL}
        account={ACCOUNT}
        accountId="acc-1"
        preferences={PREFERENCES}
        shortcut={null}
        onShortcutHandled={() => undefined}
      />,
    );

    /**
     * The *send* control, not the side selector — both say BUY, and clicking
     * the wrong one sets the side and submits nothing, which looks exactly like
     * a component that refuses to send.
     */
    const send = screen
      .getAllByRole('button')
      .find((node) => /BUY XAUUSD/.test(node.textContent ?? ''));
    expect(send, 'no send control rendered').toBeDefined();
    fireEvent.click(send!);

    await waitFor(() => {
      expect(mutateAsync).toHaveBeenCalled();
    });

    /**
     * Both lines, in the ticket's own notice. Queried through `role="alert"`
     * rather than by text anywhere on screen: the command log beneath also
     * carries the primary reason, so a text query passes on the log alone —
     * which is the bug, rendered somewhere else.
     */
    const notice = await waitFor(() => screen.getByRole('alert'));
    const lines = [...notice.querySelectorAll('li')].map((li) => li.textContent ?? '');
    expect(lines).toEqual([
      'Order volume 5.00 exceeds the per-position limit of 2 lots',
      'Insufficient free margin',
    ]);
  });

  /**
   * The other half, so the test above cannot pass by painting everything it is
   * given. A refusal with one reason shows one line — and a failure that never
   * reached the platform says the thing a trader needs first.
   */
  it('shows one line when there is one reason, and says nothing was placed when the request failed', async () => {
    mutateAsync.mockRejectedValue(
      new DomainError('SYMBOL_NOT_TRADEABLE' as never, 'XAUUSD is not currently tradeable'),
    );
    quote();
    const view = render(
      <OrderTicket
        symbol={SYMBOL}
        account={ACCOUNT}
        accountId="acc-1"
        preferences={PREFERENCES}
        shortcut={null}
        onShortcutHandled={() => undefined}
      />,
    );
    fireEvent.click(
      screen.getAllByRole('button').find((n) => /BUY XAUUSD/.test(n.textContent ?? ''))!,
    );
    const one = await waitFor(() => screen.getByRole('alert'));
    expect([...one.querySelectorAll('li')].map((li) => li.textContent)).toEqual([
      'XAUUSD is not currently tradeable',
    ]);
    view.unmount();

    mutateAsync.mockRejectedValue(new Error('fetch failed'));
    quote();
    render(
      <OrderTicket
        symbol={SYMBOL}
        account={ACCOUNT}
        accountId="acc-1"
        preferences={PREFERENCES}
        shortcut={null}
        onShortcutHandled={() => undefined}
      />,
    );
    fireEvent.click(
      screen.getAllByRole('button').find((n) => /BUY XAUUSD/.test(n.textContent ?? ''))!,
    );
    const dropped = await waitFor(() => screen.getByRole('alert'));
    expect([...dropped.querySelectorAll('li')].map((li) => li.textContent)).toEqual([
      'The order could not be submitted. It was not placed.',
    ]);
  });
});
