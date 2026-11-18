# Prop-firm challenges

A firm sells evaluations. A trader buys one, pays the fee, and trades a demo
account of the size bought under the plan's rules. Pass every phase and the
challenge is funded; break a rule and it ends.

## The path

1. **The firm makes a plan** (Administration → Challenges): size, leverage, price,
   what the fee is paid in and on which network, the receiving address, and the
   rules. A plan without a receiving address cannot be put on sale.
2. **The trader buys it** (Challenges). Buying copies the plan's terms into the
   challenge, so editing the plan later never changes a challenge already bought.
   The trader sees the exact amount, asset, network and address.
3. **The trader pays and pastes the transaction hash.** The challenge waits in
   _Payment being checked_. One hash cannot be used for two challenges.
4. **A person confirms the fee arrived** (Administration → Challenges, needs
   `payments.confirm`), or refuses it with a reason the trader sees. Nothing is
   opened on the trader's word: there is no chain monitor, so a person checks the
   chain. Confirming opens the phase-1 demo account, funded with the plan's size
   through a ledger deposit, in the same transaction that starts the challenge.
5. **The evaluator checks the rules** every `CHALLENGE_EVALUATION_INTERVAL_MS`
   (5 s by default), on one API instance at a time (its own leadership lease,
   `CHALLENGE_EVALUATION_ENABLED`).
6. **A breach** ends the challenge: status `FAILED`, the rule and the instant
   recorded with the account's figures, the account set to close-only (risk can be
   taken off, never added), the trader notified.
7. **A pass** issues a certificate with a code anyone can check
   (`GET /challenges/certificates/:code`), sets the old account to close-only and
   opens the next phase's account — phase 2, or the funded account.

## The rules

Defined once, in `packages/trading-core/src/challenge-rules.ts`, and tested
there. In short:

| Rule                 | Definition                                                                                                                                                                                                               |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Daily loss           | `dailyLossPct` of the day's reference — the day-start balance, the day-start equity, or the higher of the two (`dailyBasis`). Broken when **equity** (open positions marked to market) is at or below reference − limit. |
| Maximum loss         | `maxLossPct` of the initial balance. `STATIC`: the floor is initial − limit. `TRAILING`: high-water equity − limit, optionally stopped at the initial balance (`trailingLock`).                                          |
| Profit target        | Reached by the **closed balance** with nothing open — floating profit does not pass a phase.                                                                                                                             |
| Minimum trading days | Days, in the trading server's timezone, on which at least one position was opened.                                                                                                                                       |
| Days per phase       | Calendar days from the phase's start; past it, an unpassed phase ends (`MAX_DAYS`). Funded accounts have no target and no limit.                                                                                         |

A breach is checked before a pass. The trading day is `TRADING_SERVER_TIMEZONE`;
the day's reference is the account's balance and equity at the first evaluation
after the day begins.

## What is never decided

- **A price the evaluator cannot see.** An open position with no price, or a price
  older than the engine would trade on (`QUOTE_MAX_AGE_MS` and its overrides), and
  the challenge is skipped for that pass — not failed. A valuation that throws is
  a deferral. A feed outage is not a trader breaking a rule.
- **Twice.** Every transition claims the challenge's `version` first; a second
  decision on the same state finds nothing to claim.

## The record

`challenge_events` is append-only (the database refuses update, delete and
truncate): purchase, payment submitted, confirmed or refused, each phase started
and passed, and the breach with the figures it was decided on. Each staff
decision and each automatic transition is also an audit-log entry.

## Not built yet

Payouts from funded accounts (requests, profit split, review and payment) are the
next piece; the plan's `profitSplitPct` is recorded on every challenge for it.
Breaches set the account close-only rather than closing positions automatically.
