# Wallets

A wallet is money that belongs to a person and is in no trading account.

## Two ledgers, and the sentence this whole phase exists for

The plan said it in one line: **two ledgers that both believe they are
authoritative is the classic way to lose money in an accounting system.** These
two are not authoritative for the same thing.

| Table                 | Authoritative for                           | Cached head        | Only writer     |
| --------------------- | ------------------------------------------- | ------------------ | --------------- |
| `balance_ledger`      | what is inside a trading account            | `accounts.balance` | `LedgerService` |
| `wallet_transactions` | what is held for a person and in no account | `wallets.balance`  | `WalletService` |

A transfer writes one row on each side, in one transaction, with equal and
opposite amounts. There is no path through `WalletService.transfer` that writes
one without the other, which is why the sum of the two pots is the same
afterwards — and nearly every test in `wallet.test.ts` adds both pots up before
and after for exactly that reason. A transfer that wrote one row and not the
other would satisfy every assertion about balances and fail that one.

Each row names the other: the wallet movement carries the `ledger_entry_id` it
was written with, so an auditor reading either side can find the other.

## One wallet per person per currency

A wallet holding two currencies would need a rate to state its balance, and a
balance that changes when nobody moved any money is not a balance.

The consequence is worth stating because it looks like a bug the first time:
transferring into a USD account uses your **USD** wallet, and a EUR balance
sitting beside it does not help. The refusal says so.

There is no conversion here, deliberately. Moving money between a EUR wallet and
a USD account at a rate this service picked would put an exchange desk inside a
ledger; it belongs somewhere it can be quoted, priced and recorded as its own
transaction.

## What limits an outbound transfer

**Free margin, not balance.**

A trading account's balance includes money that is currently margin for an open
position. Letting that leave would close somebody's position for them — from the
wallet screen, silently, at a price nobody chose. The limit is computed by
`AccountStateService.valuate`, which is the same computation the terminal
displays, so the number a trader is refused against is the number they were
looking at.

A wallet, by contrast, may not go negative at all. A trading account can — a gap
through a stop leaves a debit balance and pretending otherwise would hide it —
but nothing about a wallet is leveraged, so a negative balance there is always an
arithmetic mistake or a double spend, never a market event.

## Money in, money out

There is no payment provider. This is not pretending to be one.

`POST /admin/wallets/:id/adjustments` is the manual path every firm has anyway:
an operator sees a bank transfer land and records it. It needs `wallet.adjust`,
which nobody holds by default, and **no role may hold it alongside a capability
that opens a position** — `wallet.adjust` is `accounts.adjust` aimed at a
different pot, and money invented in a wallet reaches a position through one
transfer the holder is entitled to make on their own wallet. See
[permissions.md](./permissions.md).

Automated deposits are phase 5; withdrawals are phase 7.

## Freezing

`FROZEN` stops movement in both directions. Freezing **holds** money; it does not
take it, and the two are different acts. That is why `wallet.manage` and
`wallet.adjust` are separate capabilities and why a risk manager has only the
first: after the fact, the audit trail can say which happened.

## Append-only

`wallet_transactions` carries the same database trigger `balance_ledger` and
`audit_logs` do: `UPDATE` and `DELETE` raise `42501`. A correction is a new row
that names the one it compensates. "Fixing" history in a financial record
destroys the very thing an auditor needs.

## Precision

`NUMERIC(28,10)` for every amount, decimal strings on the wire, and
`scripts/assert-no-float-columns.ts` fails the build if a float column ever
appears.

The rounding rule is the ledger's, and it is not a stylistic echo. Storing
`amount.round()` and separately computing `(before + amount).round()` rounds
twice and the two disagree whenever the movement does not land on a cent — which
is how the balance ledger once drifted a cent per trade before anybody noticed.
Round once; apply what was rounded.

One shape for a balance on the way out, too. The column is `NUMERIC(28,10)` so
Prisma hands back `490.0000000000` while a `Money` prints `490.00` — and `490`
for JPY, which has no minor units. Both are correct and returning whichever
happened to be at hand is not: `GET /wallet` and the response to a transfer were
briefly reporting the same field in two formats.

## Lock ordering

The account row is locked before the wallet row, always. Two transfers on the
same pair in opposite directions would otherwise each hold one lock and wait for
the other, and PostgreSQL would break the cycle by killing one with `40P01` —
reported to the trader as an unexpected error. `LedgerService.lockAccount` has to
be the first statement of any transaction that posts to the ledger for a related
reason it documents; the wallet slots in behind it.

## How this was verified

Twenty-three integration tests against a real database, and the implementation
was broken six ways to check they notice:

| Break                                                 | Caught by |
| ----------------------------------------------------- | --------- |
| A transfer credits both sides instead of moving money | 2 tests   |
| The wallet side is not written at all                 | 9 tests   |
| Balance, not free margin, limits an outbound transfer | 2 tests   |
| A wallet is allowed to go negative                    | 2 tests   |
| The idempotency key is ignored                        | 1 test    |
| A frozen wallet still moves money                     | 1 test    |
