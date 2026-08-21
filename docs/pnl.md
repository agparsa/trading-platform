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
is made, and nothing else in the codebase picks a price side.

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
cost (commission plus accrued swap). It is used for the break-even marker on the
chart and to sanity-check protective levels.
