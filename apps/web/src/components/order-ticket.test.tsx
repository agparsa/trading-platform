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

  /**
   * A trail asked for at entry goes on the wire as `trailingStopDistance`,
   * and only when one was typed: the server consults the firm's flag only
   * when the key is present, so an empty field must send no key at all.
   */
  it('sends a trailing distance with the order only when one was typed', async () => {
    mutateAsync.mockResolvedValue({ orderId: 'o-1', status: 'FILLED', positionId: 'p-1' });
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
    const send = () =>
      fireEvent.click(
        screen.getAllByRole('button').find((n) => /BUY XAUUSD/.test(n.textContent ?? ''))!,
      );
    send();
    await waitFor(() => {
      expect(mutateAsync).toHaveBeenCalledTimes(1);
    });
    expect(mutateAsync.mock.calls[0]?.[0]).not.toHaveProperty('trailingStopDistance');

    fireEvent.change(screen.getByLabelText('Trailing distance'), { target: { value: '5.00' } });
    send();
    await waitFor(() => {
      expect(mutateAsync).toHaveBeenCalledTimes(2);
    });
    expect(mutateAsync.mock.calls[1]?.[0]).toMatchObject({
      symbol: 'XAUUSD',
      side: 'BUY',
      trailingStopDistance: '5.00',
    });
    // Cleared with the levels once the order is away.
    expect((screen.getByLabelText('Trailing distance') as HTMLInputElement).value).toBe('');
  });

  /**
   * A press on the watchlist's bid or ask stages a market order here. It must
   * ask even with one-click armed and confirmation off — these preferences —
   * because the same press changed the instrument under a volume chosen for
   * another, and must turn a ticket left on LIMIT into a market order rather
   * than rest one where the trader pressed a price to deal at.
   */
  it('asks before sending an order staged from the watchlist, at market, whatever the settings', async () => {
    mutateAsync.mockResolvedValue({ orderId: 'o-9', status: 'FILLED', positionId: 'p-9' });
    quote();
    const props = {
      symbol: SYMBOL,
      account: ACCOUNT,
      accountId: 'acc-1',
      preferences: PREFERENCES,
      shortcut: null,
      onShortcutHandled: () => undefined,
    };
    const handled = vi.fn();
    const view = render(<OrderTicket {...props} staged={null} onStagedHandled={handled} />);

    // Left on LIMIT, as a trader might have.
    fireEvent.click(screen.getByRole('button', { name: /^LIMIT$/ }));

    view.rerender(
      <OrderTicket {...props} staged={{ side: 'SELL', at: 1 }} onStagedHandled={handled} />,
    );
    expect(handled).toHaveBeenCalledTimes(1);
    const question = screen.getByTestId('ticket-confirm').textContent ?? '';
    expect(question).toMatch(/Send SELL 0\.10 XAUUSD at market\?/);
    expect(mutateAsync).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /^Send$/ }));
    await waitFor(() => {
      expect(mutateAsync).toHaveBeenCalledTimes(1);
    });
    // A market order — the open-position mutation, not the resting one —
    // on the side pressed.
    expect(mutateAsync.mock.calls[0]?.[0]).toMatchObject({ symbol: 'XAUUSD', side: 'SELL' });
    expect(mutateAsync.mock.calls[0]?.[0]).not.toHaveProperty('price');
  });

  it('sends nothing when the staged order is cancelled', () => {
    quote();
    render(
      <OrderTicket
        symbol={SYMBOL}
        account={ACCOUNT}
        accountId="acc-1"
        preferences={PREFERENCES}
        shortcut={null}
        onShortcutHandled={() => undefined}
        staged={{ side: 'BUY', at: 1 }}
        onStagedHandled={() => undefined}
      />,
    );
    expect(screen.getByTestId('ticket-confirm').textContent).toMatch(/BUY 0\.10 XAUUSD at market/);
    fireEvent.click(screen.getByRole('button', { name: /^Cancel$/ }));
    expect(screen.queryByTestId('ticket-confirm')).toBeNull();
    expect(mutateAsync).not.toHaveBeenCalled();
  });
});
