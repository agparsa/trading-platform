# Trading terminal

The browser client. **Implemented in Phase 8.**

## The rule

The terminal displays numbers the server produced. It does not compute money.

Balance, equity, floating P&L, used margin, free margin and margin level all
arrive from `AccountStateService` — either in the REST snapshot at
`GET /accounts/:id/state` or in an `account.updated` frame, which come from the
same valuation code. A figure on screen that the server never calculated is a
figure nobody can reconcile after a dispute, so there are none.

Two places do arithmetic in the browser, and both are bounded:

- **The order ticket's estimates.** Margin and commission run the same
  `@tp/financial-core` formulas the engine runs, on the last quote this browser
  received. They are labelled estimates and the panel says why: the server
  prices the fill against the quote current at execution. Where the instrument's
  quote currency differs from the account's, the ticket shows `—` rather than
  invent an FX rate it does not hold.
- **Chart pixel coordinates.** Those are positions, not money. Every _price_
  rendered as text is the server's decimal string, formatted — never
  arithmetic'd.

## State, split four ways

| Kind     | Lives in                | Holds                                       |
| -------- | ----------------------- | ------------------------------------------- |
| Server   | TanStack Query          | positions, orders, trades, account, symbols |
| Realtime | zustand (`useRealtime`) | quotes, live P&L, bars, connection status   |
| UI       | React state             | selected symbol, resolution, active tab     |
| Form     | React state             | the order ticket, the position editor       |

Nothing crosses those lines. **The socket carries the notification; REST remains
the source of the list.** A `position.closed` frame invalidates the positions
query rather than removing a row directly, so a frame the client never received
degrades to a list that is briefly stale — not a list assembled from whichever
frames happened to arrive.

## Sequence gaps

Every frame carries a per-connection `seq`. The store flags a gap the moment one
number does not follow the last, and the terminal responds by refetching every
snapshot. Guessing at what was missed would be worse than the gap: the server
does not replay, so anything that happened during it was never delivered.

A reconnect resets the sequence origin, because a new connection starts at 1 and
the old high-water mark would make the first frame look like a gap.

## Connection state is never hidden

A terminal that has quietly lost its feed looks exactly like a quiet market. The
connection badge is always visible and never optimistic — `Live` means frames are
arriving now, and the tooltip carries the frame count on this connection.

## Chart

Real bars from `/market/candles`, with the in-progress bar merged in from
`candle.update` on bar time, so a refetch overlapping the live window cannot
produce two bars for one minute. When the server has no bars for a window the
panel says so rather than drawing a plausible line.

This is an SVG rendering of real data, not the finished charting surface.
TradingView Advanced Charts — indicators, drawing tools, order-from-chart — is
Phase 9 and needs the licensed library at `apps/web/public/charting_library/`.
See [charting.md](./charting.md).

## Tokens

The access token is held in memory. The refresh token is **not held here at
all** — the API issues it as an httpOnly, `SameSite=Strict` cookie scoped to the
auth routes, and this code never sees its value.

The result is visible in what the session module no longer contains: no storage
reads, no storage writes, no try/catch around a private-browsing exception, and
no token threaded through the refresh call. There is only
`credentials: 'include'`.

A reload still restores the session — the cookie survives it — and the session's
lifetime is now the refresh token's rather than the tab's. See
[security.md](./security.md) for the attributes and the CSRF threat model.

## Mutations

Every mutation carries a fresh `Idempotency-Key`, minted once per attempt.
`ApiClient` refuses to send one without it, so a retried order cannot open a
second position. Mutations never retry automatically: a failed order is a
decision for the trader, not something to repeat behind their back.

## Testing

The pure logic — ticket validation, volume stepping, cost estimation, bar merging
— is tested directly in `apps/web/src/lib/*.test.ts`, in the Node environment;
anything importing React is not. Ticket validation calls the same `checkVolume`
and `validateProtectiveLevels` the API calls, from the same package, so the
browser cannot invent a rule the server does not have or miss one it does.

The rendered terminal is verified by driving a real browser against a running
stack: register, open a position, watch P&L move, close it, and check the trade
row. See [testing.md](./testing.md).
