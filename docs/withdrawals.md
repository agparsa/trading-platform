# Withdrawals

Money leaving the platform. The point where phases 4, 5 and 6 meet: a wallet to
take it from, a record of how it arrived, and a verified person to pay it to.

## The hold is the design

**The wallet is debited when the withdrawal is asked for.** Not at approval,
not at payment.

A balance that still showed money somebody had asked to withdraw could be moved
into a trading account and traded while the bank transfer of the same money was
in flight — two claims on one sum, which is the thing a ledger exists to make
impossible. So `WithdrawalsService.request` writes the wallet movement
(`WITHDRAWAL`, negative) and the request row in one transaction, and everything
afterwards is about what happens to money that has already left the wallet:

| Ending      | What happens to the money                |
| ----------- | ---------------------------------------- |
| `PAID`      | it left the platform; nothing more moves |
| `REJECTED`  | a compensating `ADJUSTMENT` puts it back |
| `CANCELLED` | the same                                 |
| `FAILED`    | the same                                 |

The compensating movement names the hold it reverses (`compensatesId`) and
carries `withdrawal:<id>:release` as its idempotency key. The row and the
movement commit together or not at all.

So the quantity that stays constant across the whole lifecycle is **every
wallet plus every open hold**. `withdrawals.test.ts` adds the two up before and
after nearly every step, because a service that debited without recording the
hold, or released twice, would satisfy every assertion about status and fail
exactly that one.

Two requests racing for the same balance are serialised by the wallet's row
lock inside `WalletService.post`: the second waits, re-reads, and is refused by
the ledger's own "a wallet may not go negative" rule whatever `refusalsFor`
concluded from the balance it read a moment earlier.

## States

```
REQUESTED ──┬──→ UNDER_REVIEW ──┬──→ APPROVED ──→ PROCESSING ──┬──→ PAID
            │         │         │       │                      └──→ FAILED   (money back)
            │         └── back ─┘       └──→ REJECTED (money back)
            ├──→ APPROVED / REJECTED
            └──→ CANCELLED (by the person; money back)
```

The person may cancel while nobody has decided — `REQUESTED` or
`UNDER_REVIEW`. After approval it is the firm's to finish or refuse. An approval
can be taken back until the payout is _started_: a reviewer who approved at
nine and learns something at ten must be able to stop it. Once `PROCESSING`,
the money may already have left, so there is no rejecting it — it is paid, or
it failed and came back.

## Who may do what, and why it takes two people

| Capability             | Means                                           | Held by                                 |
| ---------------------- | ----------------------------------------------- | --------------------------------------- |
| `withdrawals.read`     | see your own                                    | trader                                  |
| `withdrawals.request`  | ask, and cancel before a decision               | trader                                  |
| `withdrawals.read_any` | see the queue and anyone's                      | support, operator, risk, finance, admin |
| `withdrawals.review`   | approve or reject                               | **finance**                             |
| `withdrawals.pay`      | open the destination, start and settle a payout | **finance**                             |

`withdrawals.review` and `withdrawals.pay` are **incompatible** with
`payments.confirm`, `wallet.adjust` and `accounts.adjust` — the three
capabilities that make money appear. Confirm a deposit that never arrived, or
adjust a wallet upward, then approve its withdrawal: the firm pays out money
that never came in. That is the whole of the fraud, and it must take two
people.

This is why the **FINANCE** role exists, and why **ADMIN cannot approve a
withdrawal**. An administrator holds `payments.confirm` and `wallet.adjust`;
the finance desk holds `withdrawals.review` and `withdrawals.pay`; neither role
may be edited into holding both, because `conflictsIn` refuses the pair. A
deployment therefore needs at least one person in each — and a single-operator
deployment has to decide which half that person is. The platform does not
decide for it.

`withdrawals.review` and `withdrawals.pay` are also incompatible with
`withdrawals.request`: approving or paying your own withdrawal.

Both roles are built-in and reconcile at boot like the others. Putting a person
into one is `POST /admin/users/:id/role`, which needs `roles.assign` (ADMIN),
refuses your own id, ends every session the person has — the role travels in
the token — and records who and why.

## Limits

Every applicable reason at once — `refusalsFor` in `@tp/withdrawals-core` — so a
person is not sent round the loop once per limit. Identity comes first and stops
the list: somebody unverified is not being told how much they could withdraw if
they were.

| Variable                        | Default   | Rule                                                                  |
| ------------------------------- | --------- | --------------------------------------------------------------------- |
| `WITHDRAWAL_MIN_AMOUNT`         | `10`      | smallest request; inclusive                                           |
| `WITHDRAWAL_MAX_AMOUNT`         | `50000`   | largest single request; inclusive                                     |
| `WITHDRAWAL_DAILY_LIMIT`        | _(unset)_ | rolling 24 hours, counting requests not cancelled, rejected or failed |
| `WITHDRAWAL_COOLDOWN_HOURS`     | `0`       | since the last request that still counts                              |
| `WITHDRAWAL_REQUIRE_KYC`        | `true`    | the gate                                                              |
| `WITHDRAWAL_AUTO_APPROVE_BELOW` | _(unset)_ | see below                                                             |

`GET /withdrawals/terms` states all of this for the page before anything is
typed, with what remains of today's limit and when the cooldown ends.

## The identity gate, twice

`KycService.isVerified` is asked at the request and **again at approval**. The
second check is not redundant: a verification revoked or lapsed between the two
is exactly the case a reviewer must not approve through, and the reviewer's
screen shows the person's _current_ standing beside every row.

## Auto-approval is approval, not payment

`WITHDRAWAL_AUTO_APPROVE_BELOW` lets small, routine withdrawals skip the
reviewer. They land in `APPROVED` with `autoApproved = true` and no approver's
name, and they still sit in the queue until a person holding `withdrawals.pay`
sends the money and says so. There is no automated rail here to pay them with.

## The destination

Where the money goes is a bank account or similar, given by the person as free
text — the formats differ by country and a form that knew them all would refuse
somebody's real account. It is sealed with the request's id as the context, like
an identity document and for the same reason. The person's own list shows the
last four characters; the audit rows carry the same and never the whole;
`GET /admin/withdrawals/:id/destination` opens it for the person about to pay,
and that opening is audited with their name.

## The gap, stated rather than filled

**There is no automated payout rail.** Somebody holding `withdrawals.pay` sends
the transfer from the firm's bank, records its reference (`POST …/payout`),
and later records that it went or bounced (`POST …/settle`). A payout with no
reference is refused: it is a payout nobody can find on a statement.

`PayoutProvider` in `@tp/withdrawals-core` is the port an automated rail
implements when one is chosen. Which rail is a commercial decision, and the
adapter is deliberately absent, for the reason given in `payments.md` and
`kyc.md`.

## At the database

A trigger holds what was asked for fixed after the asking — amount, currency,
wallet, destination, the hold — so every later decision is about the same
thing; lets the release be recorded once and never replaced; and refuses to
delete a row. A withdrawal is a financial record: it ends, it is not removed.

**And refuses to truncate one.** That is a separate trigger, because TRUNCATE
does not fire row-level triggers — for a fortnight this table refused `DELETE`
with a clear error and let `TRUNCATE TABLE withdrawal_requests` empty it in
silence. `append-only-tables.test.ts` now checks every table that refuses
deletion for both.
