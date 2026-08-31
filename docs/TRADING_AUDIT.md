# Trading Audit

**Audited:** commit `76fd42a`. The order engine, position engine, risk engine,
market data layer and the trigger loop that joins them.

---

## 1. Where the trading logic lives

The rule the codebase enforces on itself: **anything that decides money lives in
a framework-free package.** ESLint refuses a NestJS or React import inside
`packages/*`, so the boundary is checked by the build rather than remembered.

```
financial-core     money, rounding, margin, P&L, instrument arithmetic
trading-core       order and position state machines, resting-order logic,
                   protective-order logic, price ranges
risk-core          the rule engine and its six rules
market-core        providers, candles, tick windows, integrity checks, clock
```

The API layer orchestrates. It does not calculate. That separation is why the
financial behaviour can be tested without a database or an HTTP server, and it
is the single most valuable structural decision in the repository.

## 2. Money

**No floating-point arithmetic touches money anywhere.** `decimal.js` in code,
`NUMERIC(28,10)` in the database, decimal **strings** on the wire so JSON cannot
quietly reconstitute a float. Rounding is explicit — `financial-core/rounding.ts`
exists precisely so that no rounding decision is made implicitly at a call site.
`pnpm check:schema` interrogates `information_schema` on a live database and
fails the build if a real or double-precision column ever appears.

This satisfies the specification's rule without qualification.

## 3. Orders

**Supported at the API today:** `MARKET`, and resting `LIMIT` and `STOP`, with
`GTC`, `DAY`, `GTD`.

**Present in the schema but not accepted by the API:** `STOP_LIMIT`, and `IOC` /
`FOK`. The enums exist so the state machine and the database are ready; the DTO
deliberately does not accept them, because accepting an order type the engine
does not fully execute would be worse than refusing it. This is the honest
position and it should stay honest — an order type is complete when it fills
correctly, not when it parses.

Order status covers the full lifecycle: `NEW → PENDING → ACCEPTED → TRIGGERED →
PARTIALLY_FILLED → FILLED`, with `MODIFY_REQUESTED`, `CANCEL_REQUESTED`,
`CANCELLED`, `REJECTED`, `EXPIRED`. Every transition goes through
`trading-core/state/order-state-machine.ts` and every transition writes an
`OrderEvent`. There is no path that changes an order's status by assignment.

**Resting-order direction is isolated on purpose.** `pending-orders.ts` contains
one comparison, but which comparison depends on both type and side, and getting
it backwards turns a limit order into a market order at the worst possible
moment. All four combinations are tested. Orders are measured against the
**executable** price — ask for a buy, bid for a sell — because measuring a buy
against the bid would fire it at a price nobody could deal at.

## 4. Positions

Open, modify, partial close, full close, reverse. Close reasons are enumerated
and recorded: `MANUAL`, `STOP_LOSS`, `TAKE_PROFIT`, `TRAILING_STOP`,
`LIQUIDATION`, `REVERSE`, `SYSTEM` — so "why did this close?" is answered by
data rather than inference.

**Concurrency is handled in three layers**, each for a different failure:

- `SELECT … FOR UPDATE` on the account row for anything that moves money, so
  concurrent trades on one account serialize instead of interleaving.
- An optimistic `version` integer, so a stale write is rejected rather than
  silently applied.
- An explicit `OPEN → CLOSING` claim, so two simultaneous close requests cannot
  both close the same position.

## 5. The trigger engine

`trading/trigger-engine.service.ts` is what makes a stop-loss real. Without it,
SL and TP are decorative fields that only take effect if the trader happens to
be watching.

Four things happen per tick, **in this order**, and the order is the design:

1. Trailing stops ratchet — an improved level is persisted before anything is
   evaluated against it. Evaluating a stale trailing level would close a position
   at a stop the trader had already moved away from.
2. Protective levels are evaluated on the executable exit price.
3. Resting orders are expired, _then_ fired — so an order that lapsed at midnight
   cannot open a position on the first tick after it.
4. Accounts holding the symbol are checked for stop-out — last, because an order
   that just filled has consumed margin and the account must be judged on the
   state it is actually in.

Ticks arriving mid-pass used to be dropped. That was fast and had a real cost: a
stop level printed on a dropped tick was never honoured. It is now handled.

## 6. Risk engine

Six rules, in `risk-core/rules/`:

```
sufficientMarginRule       enough free margin to open
maxPositionVolumeRule      per-position size ceiling
maxOpenPositionsRule       count ceiling
maxGrossNotionalRule       total exposure ceiling
maxSymbolNetVolumeRule     per-symbol net exposure ceiling
symbolTradeableRule        the instrument is enabled and in session
```

Plus margin-call and stop-out monitoring, which are continuous rather than
per-request. `risk.updated` is emitted on **transition**, not per tick — an
earlier implementation emitted per tick and drowned the client.

Limits are configurable per account (`AccountSettings`, `RiskRuleConfig`), not
hard-coded. Every breach writes a `RiskEvent` with the account state at the
moment of the breach, so a decision can be reconstructed afterwards.

**The engine is enforced server-side, on every order path.** There is no client
that can reach an order without passing it. This is the property the
specification names for mobile — _"never allow mobile clients to bypass the Risk
Engine"_ — and it holds by construction: mobile will use the same `/orders`
route as the browser, and the guard chain does not know or care what client is
calling.

## 7. Market data

Two providers behind one interface (`market-core/providers/`):

- **`simulator`** — geometric random walk with per-instrument daily volatility,
  a derived per-tick sigma, and mean reversion toward an anchor. The per-day /
  per-tick distinction matters: treating a daily sigma as a per-tick sigma
  inflates volatility by √(ticks per day). At the configured 250 ms tick that is
  √345,600 ≈ **588×**. That bug existed and was fixed.
- **`scripted`** — deterministic sequences for tests.

Eight instruments seeded: `XAUUSD`, `XAGUSD`, `BTCUSD`, `ETHUSD`, `EURUSD`,
`AUDUSD`, `GBPUSD`, `USDJPY`.

`market-core/integrity.ts` checks incoming data for staleness, crossed quotes and
implausible jumps, so bad data is rejected rather than traded on.

## 8. Findings

### T-1 — No real broker or liquidity provider · **Structural, by design**

Prices come from a simulator. The provider interface exists and is the correct
seam, but nothing behind it is real. **This is fine for what the platform is
today and must be stated plainly rather than implied away:** no live money has
ever passed through this engine. Connecting a real feed is a Phase-3 item and
carries its own audit.

### T-2 — `STOP_LIMIT`, `IOC`, `FOK` declared but not accepted · **Low**

Deliberate and correct. Recorded so nobody "fixes" it by widening the DTO
without implementing the fill semantics.

### T-3 — Slippage and requote behaviour are not modelled · **Medium**

Market orders fill at the current executable price. Real execution slips.
A simulator that never slips trains traders — and tests — on a market that does
not exist. Worth adding as a configurable execution model before any real feed.

### T-4 — No trading sounds · **Low, specification gap**

The specification names eight: `trade_opened`, `trade_closed`, `trade_modified`,
`order_filled`, `order_cancelled`, `stop_loss`, `take_profit`, `risk_warning`.
None exist. The events that would drive them all exist already, which makes this
a presentation-layer task rather than an engine one.

**The specification's rule about them is a real correctness requirement, not a
cosmetic one:** a sound must fire when the backend confirms execution, never
when the user clicks Buy. The client already has the event stream to do this
correctly — `order.filled` and `position.opened` are server-emitted — so the
correct implementation is also the easy one, provided nobody wires a sound to a
click handler.

### T-5 — No per-tenant instrument availability · **Blocked on tenancy**

Instruments are global. Under multi-tenancy, which instruments a tenant offers,
and on what commercial terms, becomes tenant-scoped. `SymbolSpec` already
separates contract specification from commercial terms, which is the right
shape for this — the terms become per-tenant, the contract stays global.
