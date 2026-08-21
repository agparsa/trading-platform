# Risk engine

`packages/risk-core`. Independent of the trading engine, and pure: a rule is a
function of `(order, context)` that reads no database and calls no clock.

## Contract

```ts
interface RiskRule {
  readonly name: string;
  evaluate(order: ProposedOrder, context: RiskContext): RiskViolation | null;
}
```

The engine evaluates **every** rule and returns all violations. It deliberately
does not short-circuit: a trader whose order breaks three limits should be told
all three, not sent round the loop three times.

## Default rules

| Rule                    | Error code                    | Notes                                                                                       |
| ----------------------- | ----------------------------- | ------------------------------------------------------------------------------------------- |
| `symbol-tradeable`      | `SYMBOL_NOT_TRADEABLE`        | Instrument disabled                                                                         |
| `sufficient-margin`     | `INSUFFICIENT_MARGIN`         | `freeMargin >= requiredMargin` — an order consuming exactly the remaining margin is allowed |
| `max-position-volume`   | `MAX_POSITION_SIZE_EXCEEDED`  | Per-order lot cap                                                                           |
| `max-open-positions`    | `MAX_OPEN_POSITIONS_EXCEEDED` | Count cap                                                                                   |
| `max-symbol-net-volume` | `MAX_EXPOSURE_EXCEEDED`       | Net directional lots per symbol; an offsetting order reduces exposure                       |
| `max-gross-notional`    | `MAX_EXPOSURE_EXCEEDED`       | Gross across all symbols, including the proposed order                                      |

Gross rather than net for notional: two offsetting positions still carry
execution and gap risk, so they are not free.

## Limits are configuration

Every field on `AccountRiskLimits` is optional, and **an unset limit is not
enforced**. No rule invents a default. Limits live in `account_settings`;
enabling one is an administrative act, not a code change.

## Extension point

This is the seam a future evaluation product plugs into. Daily loss, maximum
drawdown, profit targets, trading-day counting and consistency rules are all
expressible as additional `RiskRule` implementations plus additional context
fields.

**None of that is implemented here, and none of it should be.** Specification
§62 draws the boundary: this repository is a standalone trading platform. Mixing
evaluation-program logic into it would couple two products that need to ship on
different schedules.

What Phase 1 guarantees is that adding those rules later requires no change to
the trading engine — only new rules and a wider `RiskContext`.

## Margin call and stop-out

Thresholds live in `account_settings` (defaults: margin call 100%, stop-out 50%)
and are evaluated against `marginLevel`, the MetaTrader-style ratio — not against
`marginUtilization`. Confusing the two inverts the comparison. See
[margin.md](./margin.md).

A `null` margin level (no open positions) never triggers either.
