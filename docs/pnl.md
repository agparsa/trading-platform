# Profit & loss

Implemented in `packages/financial-core/src/formulas/`. Every formula here has a
test; several are checked against figures captured from a live broker terminal.

## Executable side

A long is opened by lifting the **ask** and closed by hitting the **bid**. A
short is the mirror image.

|      | Entry price | Exit / valuation price |
| ---- | ----------- | ---------------------- |
| BUY  | ask         | **bid**                |
| SELL | bid         | **ask**                |

Valuing an open position at the mid price would overstate every account's equity
by half the spread per position. That is a systematic error across the whole
book, not a rounding detail — so `sides.ts` is the single place this decision
is made, and nothing else in the codebase picks a price side. Code that needs a
Decimal calls `entryPriceFor` / `exitPriceFor`; code that needs the quote's own
string (a price shown as the feed printed it) reads `quote[entrySideOf(side)]` or
`quote[exitSideOf(side)]`.

This was a description rather than a rule until `scripts/price-sides.test.ts`:
five other files — the server's valuation of every open position among them —
each chose with their own `side === 'BUY' ? … : …`. All were right; none was
checked. The test now finds every conditional in `apps/` and `packages/` whose
branches are a bid and an ask, and fails on any outside `sides.ts`. The one
exemption is the mock venue in `broker-sdk`, which stands in for the exchange
rather than the platform.

## Gross P&L

```
priceMove = (exitPrice − entryPrice) × direction        direction: BUY = +1, SELL = −1
grossPnl(quote currency) = priceMove × contractSize × volumeLots
grossPnl(account currency) = grossPnl(quote) × quoteToAccountRate
```

`quoteToAccountRate` is always passed explicitly. There is no implicit default of
1 — a missing conversion rate is a bug we want to surface, not paper over.

## Net P&L

```
netPnl = grossPnl − commission + swap
```

Commission is stored as a positive magnitude and subtracted. Swap is stored
**signed** — negative debits, positive credits — and added. Mixing the two
conventions is the usual way a swap credit ends up charged as a cost.

### Swap is settled the night it accrues, and reported at close

Overnight financing moves the balance **on the night it is charged**: the
worker's accrual writes the ledger entry, moves the balance and adds the amount
to `position.swap`, in one transaction. `position.swap` is therefore the record
of what has _already been paid_, and closing carries its share onto the trade
row — apportioned to the volume closed — so that `netPnl` is the whole round
trip. Closing posts **no** swap to the ledger.

It did, until the first reconciliation run to reach production. Every position
held overnight was charged its swap twice — once at midnight and once at close,
under "swap released" — and the ledger held exactly double the swap the trades
reported. So `netPnl` reconciles with the balance over the position's whole
life, not with the movement a single close produces: the entry commission was
taken at the open and the swap on each night in between. The two tests under
"swap accounting" in `trading.test.ts` hold the close to that.

### `commission` is the round trip, not one leg

Commission is charged twice: once when the position opens, once when it closes.
Both postings hit the ledger at the moment they are incurred, so the balance has
always been right. The **trade record** was not: it carried only the closing leg,
which meant a trader summing `netPnl` over their history came out short by one
commission per round trip and could not reconcile the report with the balance it
was describing.

A trade now records all three figures:

| Field             | Meaning                                                         |
| ----------------- | --------------------------------------------------------------- |
| `entryCommission` | the opening leg, apportioned to the volume closed by this trade |
| `exitCommission`  | the closing leg                                                 |
| `commission`      | the two added together                                          |

and `netPnl = grossPnl − commission + swap` is the round trip.

The apportionment divides by the volume the position **opened** with, never by
the volume still open:

```
entryCommission = position.commission × (closedVolume ÷ position.initialVolume)
```

Dividing by the remaining volume would charge the full entry commission against
every partial close — 7 on the first close and 7 again on the second, when 7 was
all that was ever taken. Because the divisor is constant, the shares across every
close of one position add back up to exactly what was charged at entry.

Only the closing leg is posted to the ledger when a position closes. The entry
leg is already there from when it opened; posting it again would charge it twice.

All three properties are asserted, and each was verified by breaking it: swapping
the divisor for the remaining volume, dropping the entry leg from `netPnl`, and
re-posting the entry leg at close each make a test fail.

## Reference vectors

These come from a live TradeLocker session (XAUUSD and BTCUSD, 21 Aug 2026).
Every number below is one the terminal displayed; `pnl.test.ts` asserts each.

XAUUSD, contract size 100, live bid 4583.58:

| Side | Volume | Entry   | Exit (bid)         | Expected    |
| ---- | ------ | ------- | ------------------ | ----------- |
| BUY  | 1.00   | 4584.76 | 4583.58            | −118.00     |
| BUY  | 1.00   | 4585.57 | 4583.58            | −199.00     |
|      |        |         | **floating total** | **−317.00** |

BTCUSD, contract size 1, closed round trips:

| Side | Volume | Entry    | Exit          | Expected    |
| ---- | ------ | -------- | ------------- | ----------- |
| BUY  | 0.01   | 77634.99 | 77707.26      | 0.72        |
| BUY  | 2.00   | 77609.23 | 77677.70      | 136.94      |
| BUY  | 0.23   | 77693.25 | 77609.37      | −19.29      |
| BUY  | 2.00   | 77702.55 | 77584.38      | −236.34     |
|      |        |          | **day total** | **−117.97** |

The fact that all eight figures reproduce exactly is what establishes that
`contractSize` for XAUUSD is 100 and for BTCUSD is 1, and that the terminal
marks longs at the bid.

## Precision and rounding

- Intermediate arithmetic runs at 40 significant digits; nothing is rounded
  mid-calculation.
- Rounding happens **once**, at settlement or display, to the currency's ISO 4217
  minor units. USD → 2 places, JPY → 0.
- Default mode is `ROUND_HALF_UP`. `ROUND_HALF_EVEN` is available for aggregation
  where a systematic upward bias would accumulate.
- An unknown currency throws. It never silently defaults to two decimal places.

## Break-even

`breakEvenPrice()` returns the price at which gross P&L exactly offsets a given
cost (commission plus accrued swap). It is tested and exported, and **nothing
calls it yet**: this page used to say it drew the break-even marker on the chart
and sanity-checked protective levels, and the chart has no such marker and no
check uses it.
