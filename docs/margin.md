# Margin and account state

Implemented in `packages/financial-core/src/formulas/margin.ts` and
`account.ts`.

## Effective margin rate

```
effectiveRate = max( 1 / accountLeverage , instrument.marginRate )
```

The instrument's rate is a **floor**, not a ceiling. An account with 500:1
leverage still posts the instrument's required margin on a symbol capped at
100:1. Taking the larger of the two is what makes per-symbol risk limits
actually enforceable — otherwise raising account leverage would quietly bypass
every instrument constraint.

## Required margin

```
notional       = volumeLots × contractSize × price          (quote currency)
requiredMargin = notional × effectiveRate × quoteToAccountRate
```

Verified against the reference terminal: XAUUSD 1.00 lot at 4583.65 with a 1.00%
initial margin shows **$458,365.00 exposure** and **$4,583.65 margin**. Both
reproduce exactly.

## Account state

Accounting conventions, fixed in `account.ts` and nowhere else:

- **Commission is realized at open.** It hits the balance ledger the moment a
  position is created, so it is already inside `balance`.
- **Swap accrues nightly** into the balance ledger, so it is inside `balance` too.
- **`floatingPnl` is therefore pure price P&L** on open positions, with no fees
  folded in.

Double-counting fees — once in `balance` and again in `floatingPnl` — is the
classic reason a platform's equity slowly disagrees with its own ledger.

```
equity      = balance + floatingPnl
freeMargin  = equity − usedMargin
marginLevel = equity / usedMargin × 100        (null when usedMargin = 0)
```

Verified against the reference terminal snapshot:

```
balance      99,882.03
floating       −317.00
equity       99,565.03      = balance + floating          ✓
usedMargin    9,167.30
freeMargin   90,397.73      = equity − usedMargin         ✓  ("Available Funds")
```

## Two different "margin level" numbers

The reference terminal displays **9.21%** where MetaTrader would show **1,085.98%**.
They are reciprocals of each other:

| Name                | Formula                   | Healthy when |
| ------------------- | ------------------------- | ------------ |
| `marginLevel`       | equity / usedMargin × 100 | large        |
| `marginUtilization` | usedMargin / equity × 100 | small        |

Both are exposed, under unambiguous names. The terminal header can show
utilisation (matching the reference UI); the risk engine uses `marginLevel` for
margin-call and stop-out thresholds. Conflating them would invert every
stop-out comparison.

## Undefined, not infinite

`marginLevel` returns `null` when no margin is committed. An account with no open
positions does not have an infinitely good margin level — the ratio is undefined,
and every consumer must handle that explicitly. `isStopOut()` and `isMarginCall()`
both return `false` for a `null` level, so a flat account is never liquidated.
