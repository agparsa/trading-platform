# Fees

Commission schedules, and what fees came to. `/admin/fees`.

## Schedules

A **fee schedule** is a named set of commission rates — per lot, per leg, in the
instrument's quote currency — that the accounts on it pay instead of the
firm's standard terms. A VIP tier, a desk's rate, an introducer's markup:
whatever the firm calls it.

For an account on a schedule, per instrument, the engine charges:

1. the schedule's rate for that instrument, if it lists one; else
2. the schedule's default rate, if it has one; else
3. the standard terms — the firm's override for the instrument
   (`TenantSymbolTerms`), else the platform's (`SymbolSpec`).

An account on no schedule pays the standard terms. Only commission changes:
swap and margin stay the instrument's.

- **Where it is charged.** `FeesService.commissionSpec` is called at all four
  places the engine computes commission — the order preview, the market fill,
  the resting-order fill and the close — so the preview, the opening leg and
  the closing leg all use the same rate. It reads the account's schedule
  fresh on every order (one indexed read; none for an account on no
  schedule) rather than caching it, because a cached rate keeps charging after
  somebody changed it, in every API process separately.
- **A change applies from the next order.** What was charged stays charged:
  the ledger is append-only.
- **Rates are never negative** (a database check). A rebate is not modelled,
  and a negative commission would be one.
- **Putting an account on a schedule** is done from the account's own page
  (`/admin/accounts/:id`), with a reason, needs `accounts.manage`, and is
  audited (`ACCOUNT_FEE_SCHEDULE_CHANGED`). Writing schedules needs
  `instruments.manage`; reading them `instruments.read`.
- **A schedule an account pays cannot be deleted.** Move the accounts first.
- **The trader's ticket** shows the estimate at the account's own rate:
  `GET /accounts` carries the schedule's rates (`commission`), and
  `commissionPerLotFor` resolves them in the same order as the server.

## Fees charged

`GET /admin/fees/report?from&to` (`accounts.read_any`), at most 366 days:
commission charged and swap settled, **from the ledger** — what was actually
posted, never recomputed from today's rates — by currency (never summed
across currencies), by instrument, and for the twenty accounts that paid most
commission. Swap is signed as traders saw it: negative means they paid it.
The instrument breakdown groups at most 50,000 positions and says so when it
stops; the currency totals are always whole.

## Not covered

No per-desk assignment (an account at a time). No rebate or volume-tier
model. Spread comes from the feed and is not a fee here.
