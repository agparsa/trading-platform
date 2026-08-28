# Realtime account state and P&L

Everything on the account strip is computed by the server. Nothing on it is
derived in the browser.

That is not a style preference. A number a trader can see but the server never
produced is a number nobody can reconcile after a dispute — there is no row to
point at, no formula to re-run, and no way to tell whether the trader or the
platform is right. So the browser's job is to display what arrived and to be
honest about how old it is.

## What the server sends

| Field               | Meaning                                                                            |
| ------------------- | ---------------------------------------------------------------------------------- |
| `balance`           | Cash, the ledger's running total                                                   |
| `equity`            | Balance plus floating P&L                                                          |
| `floatingPnl`       | Open positions marked to the executable exit side                                  |
| `usedMargin`        | Committed against open positions                                                   |
| `freeMargin`        | Equity less used margin                                                            |
| `marginLevel`       | Equity ÷ used margin, as a percentage. `null` when nothing is committed            |
| `marginUtilisation` | Used margin ÷ equity, as a percentage. `null` when there is no equity to divide by |
| `grossExposure`     | Sum of absolute notional across open positions, in account currency                |
| `openPositions`     | Count                                                                              |
| `realizedPnlToday`  | Closed round trips since the trading day began                                     |
| `realizedPnlTotal`  | Closed round trips over the life of the account                                    |
| `realizedSince`     | The instant "today" started, so a client can say what it is showing                |

`marginLevel` and `marginUtilisation` are the same two numbers a trader knows
under one name, in opposite order, and are implemented under names that cannot be
confused. Both return `null` rather than a number when their denominator is not
positive: a ratio over zero is not a percentage, and rendering one would be worse
than rendering nothing.

## Realized P&L comes from trades, never from the balance

The balance is right there, and it moves when a trade closes. It also moves when
somebody deposits. A "profit" figure that counts a deposit is worse than no
profit figure at all, so realized P&L is summed from `trades` — the immutable
record of closed round trips — and from nowhere else.

Those rows tie to the ledger exactly, by construction rather than by luck; see
[database.md](./database.md) for the rounding rule that makes that true, and what
went wrong before it existed.

"Today" is the current trading day in the trading server's timezone, computed
once by `startOfTradingDay()` and sent to the client as a timestamp — so the API,
the terminal and any later report all mean the same window. That function carries
a daylight-saving correction: a wall clock reads 1440 minutes on every day, and
two days a year are 23 or 25 hours long.

## Absent is not zero

Realized P&L travels with the REST snapshot and **not** with tick frames. Nothing
about it changes on a tick, and re-querying it twice a second for every watched
account would buy nothing.

This has a consequence the client has to respect in two places, and getting
either wrong looks the same to a trader: their day's profit blinks to nothing.

- **In the store.** A frame that does not name the realized figures carries the
  previous ones forward. It does not overwrite them with zero, because the frame
  made no claim about them.
- **At the point of display.** The account strip merges the snapshot and the live
  frame _field by field_ — the frame's value for everything the frame carries,
  the snapshot's for everything it does not. Taking the live frame whole is the
  obvious thing to write, and it blanked realized P&L from the first tick
  onwards. That was shipped, seen in a browser, and fixed; the merge now lives in
  `lib/account-view.ts` with the reasoning attached.

An em dash on the strip means "not loaded yet". It never means zero.

## Per-position figures

Each open position carries its mark, the costs already charged against it, and
the difference:

```
floatingPnl   marked at the executable exit side — BUY at bid, SELL at ask
commission    what was actually charged at entry
swap          what has actually accrued, signed
netPnl        floatingPnl − commission + swap
```

`netPnl` is deliberately **not** an estimate of the round trip. The closing
commission has not been charged, and guessing at it would put a number on screen
that no ledger entry will ever match. This is the mark less what has actually
been paid — a figure that can be reconciled today.

## Cost, and where it is not paid

Valuing an account is a database read plus a P&L calculation per position, so
`RealtimeService` bounds it twice: only accounts with a socket actually
listening are valued, and each at most once per `REALTIME_VALUATION_INTERVAL_MS`.
Nothing runs when the market is still. This is throttling, not polling — see
[websocket.md](./websocket.md).

Realized P&L is deliberately outside `valuate()`. `valuate()` runs inside the
transactions that open and close positions, and inside the tick loop; every query
added to it lengthens a lock window or the per-tick cost. Realized P&L decides
nothing — it is display data — so it is a separate call made only by the surfaces
that show it.
