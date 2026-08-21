# Domain model

## Aggregates

```
Account            the consistency boundary for money
 ├─ Order          an intent, with a lifecycle
 │   └─ Execution  a fill: immutable, with the quote it executed against
 ├─ Position       an open exposure
 │   └─ Trade      a completed round trip: immutable
 └─ LedgerEntry    an immutable money movement

Instrument         Symbol + SymbolSpec + MarketSession
```

An `Account` is the transaction boundary. Everything that changes a balance —
the order, its execution, the position, the ledger entry, the account row —
commits together or not at all.

## Value objects

| Type                            | Package        | Invariant                                  |
| ------------------------------- | -------------- | ------------------------------------------ |
| `Money`                         | financial-core | Exact; refuses cross-currency arithmetic   |
| `Decimal`                       | financial-core | 40 digits; no exponent notation on output  |
| `SymbolSpec`                    | financial-core | Validated once on load, trusted thereafter |
| `Tick` / `Candle`               | market-core    | Immutable observations                     |
| `ProposedOrder` / `RiskContext` | risk-core      | Everything a rule may read                 |

## Identity

Public identifiers are UUIDs, and TypeScript brands them (`AccountId`,
`OrderId`, `PositionId`, …). Branding makes it a compile error to pass an
account id where an order id belongs — a mistake plain `string` types cannot
catch. Sequential database keys never leave the persistence layer.

## Ubiquitous language

| Term                   | Means precisely                                                                               |
| ---------------------- | --------------------------------------------------------------------------------------------- |
| **Volume**             | Lots. Never units, never notional.                                                            |
| **Contract size**      | Units of the underlying per 1.00 lot.                                                         |
| **Notional**           | volume × contractSize × price, in quote currency.                                             |
| **Balance**            | Settled cash. Moves only via a ledger entry.                                                  |
| **Equity**             | balance + floatingPnl.                                                                        |
| **Floating P&L**       | Pure price P&L on open positions. No fees folded in.                                          |
| **Used margin**        | Sum of initial margin held against open positions.                                            |
| **Free margin**        | equity − usedMargin.                                                                          |
| **Margin level**       | equity / usedMargin × 100. Healthy when large.                                                |
| **Margin utilisation** | usedMargin / equity × 100. Healthy when small.                                                |
| **Executable price**   | Bid for closing a long / opening a short; ask for the reverse.                                |
| **Trading day**        | A server-timezone day, boundary set by configuration — not a calendar day in the user's zone. |

Two terms are deliberately distinguished because platforms disagree about them:
_margin level_ and _margin utilisation_. See [margin.md](./margin.md).

## Invariants

1. A position's `volume` never exceeds its `initialVolume`.
2. A closed position has both `closedAt` and `closeReason` set.
3. `filledVolume <= volume` on every order; equal exactly when `FILLED`.
4. Every ledger entry's `balanceAfter` equals the previous entry's plus `amount`.
5. `accounts.balance` equals the latest ledger `balanceAfter` for that account.
6. Prices sit on the instrument's tick grid; volumes sit on its lot step.
7. A long's stop-loss is below its entry reference and its take-profit above;
   a short is mirrored.
8. State transitions follow the published tables; nothing else may set `status`.

Invariants 4 and 5 are what the reconciliation job checks. A violation is the
most serious alert this system can raise.
