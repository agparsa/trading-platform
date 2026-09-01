# Payments

Money coming into the platform.

## The gap, stated rather than filled

**There is one payment provider in this repository and it is the manual bank
transfer.** No Stripe adapter, no PSP, no card form.

That is deliberate and it is not an oversight. Choosing a payment provider is a
commercial decision — pricing, settlement terms, which countries, which methods,
who signs — and the implementation plan says so: it gates this phase. An adapter
written against public documentation for a contract nobody has signed would be
an integration that has never taken a payment, sitting in the repository looking
finished. The one thing worse than a missing provider is a provider that appears
present and has never been through a real payment.

So what exists is:

- `PaymentProvider`, the port, in `@tp/payments-core`
- the state machine every provider's vocabulary is mapped onto, with tests
- the webhook endpoint, the event log, the idempotency, the wallet credit
- `ManualBankTransferProvider`, which is a real provider, not a stub

Adding a third-party processor means implementing that interface and registering
it in `PaymentProviders`. Nothing else should have to change; that is what the
port is for. Until then the concrete adapter is **pending provider selection**.

## The manual bank transfer is a real provider

It is how most firms take their first deposits and how many take their largest.
The payer is shown account details and a reference to quote; an operator sees the
money land and confirms it on `/admin/payments`. Nothing there is simulated —
the confirmation is a human act, with a capability behind it and an audit record
after it.

What it does not do is pretend to be automated. `parseWebhook` returns `null` for
everything, because nobody is going to send one.

The details a payer is shown come from `PAYMENT_BANK_DETAILS`. A hard-coded IBAN
in a repository is somebody else's bank account by the second deployment. Unset,
the instructions say so plainly rather than showing a blank.

## States

```
REQUIRES_ACTION ──┬─→ PROCESSING ──┬─→ SUCCEEDED   (terminal, funds credited)
                  │                └─→ FAILED      (terminal)
                  ├─→ SUCCEEDED
                  ├─→ FAILED
                  ├─→ CANCELLED   (terminal)
                  └─→ EXPIRED     (terminal)
```

`react(from, reported)` returns one of three things, and there being three is the
point:

| Reaction   | When                                           | What happens                                |
| ---------- | ---------------------------------------------- | ------------------------------------------- |
| **apply**  | a real advance                                 | written; `SUCCEEDED` credits a wallet       |
| **ignore** | the same state, or one that does not follow    | recorded, nothing changes                   |
| **alarm**  | terminal reported after a _different_ terminal | recorded and logged loudly, nothing changes |

`failed` after `succeeded` is the dangerous one. It is **not** silently reversed:
a genuine reversal is a chargeback, which is a separate movement with its own
accounting, and silently debiting a wallet from a webhook is how money
disappears with no record of anyone deciding it should. It is not swallowed
either, because if it is real then the money is gone and somebody has to know.

## A failed payment never creates funds

Enforced in one place. The wallet is credited on exactly one transition — into
`SUCCEEDED` — and the state machine will not produce that transition twice or
produce it out of a terminal state. Everything else in `PaymentsService` is
bookkeeping around that single fact.

## Why a re-delivered webhook cannot credit twice

Two mechanisms, because either alone has a hole.

1. **`payment_events(provider, provider_event_id)` is unique**, and the row is
   written _inside the same transaction as the credit_. A provider that
   re-delivers an event collides on the insert, before any money moves, and the
   whole transaction rolls back. A check in code could not do this: two
   deliveries can be in flight on two API instances at the same moment, and only
   the database can settle that.

2. **The wallet credit carries `payment:<intent id>` as its idempotency key**, so
   even an event with a _different_ id credits nothing.

The first stops the ordinary case. The second stops the one where a provider
invents a new event id for a repeat — and that is not hypothetical: with the key
removed, `payments.test.ts` fails on exactly one test, the one that races two
deliveries carrying different ids.

`WalletService.post` takes the wallet's row lock **before** reading the
idempotency key, and the order matters. Checking first and locking after is
itself a read-then-write: both callers find no movement, both write one, and the
loser hits the unique index. No money is created — its transaction rolls back —
but the caller gets a constraint violation where it asked a question with a
correct answer, and a provider reading that as a failure re-delivers for hours.

## An amount a provider states must be the amount on the intent

Not a formality. An event matched to the wrong intent, and an intent whose amount
was somehow edited after it was created, both surface here — and both would
otherwise credit whatever the provider said. A mismatch is an **alarm**: recorded,
logged with both figures, and nothing credited.

## The webhook endpoint always answers 200

`POST /webhooks/payments/:provider` is public — a provider has no session — so
authenticity comes from a signature over the **raw** body, which the adapter
verifies because only it knows the scheme.

The raw bytes are why `rawBody: true` is set at bootstrap. A signature is over
bytes; `JSON.parse` followed by `JSON.stringify` produces different bytes for the
same document, so a signature checked against a re-serialised body fails for
every authentic delivery — and then somebody "fixes" it by not checking at all.

It answers 200 for everything, including a body it does not recognise and a
signature that does not verify. A provider that gets anything else retries for
hours with backoff, and a bad body will fail identically every time. Worse, a
4xx tells an unauthenticated caller which of "not for me" and "not authentic"
applied, which tells them how to get closer. What the platform decided is in
`payment_events`, where an operator looks — not in a status code the provider
will never show anybody.

## Capabilities

| Capability          | Means                                            |
| ------------------- | ------------------------------------------------ |
| `payments.read`     | see your own payments                            |
| `payments.create`   | start a deposit                                  |
| `payments.read_any` | see anyone's payments and the events behind them |
| `payments.confirm`  | settle a payment by hand                         |

`payments.create` is separate from `payments.read` for the reason given on
`accounts.read`: seeing a thing and starting one are different powers, and a
capability that quietly means both cannot be given to someone who should only
look.

`payments.confirm` and `payments.create` are an **incompatible pair** — the
shortest path to money out of nothing on this platform. Start a deposit for any
amount, then confirm it as an operator who saw it on a statement. Both halves
leave a record and both look ordinary alone; only holding them together turns
them into a credit with no counterparty. Every other incompatible pair needs a
market to launder through.

`payments.confirm` is narrower than `wallet.adjust` on purpose: it can settle
only a payment somebody started, only for the amount they started it for, and it
leaves an intent and an event behind. `wallet.adjust` can credit any wallet any
amount. Both make money appear; only one of them has a counterparty. That is why
the settle endpoint takes no amount.

## Payments nobody paid

A bank transfer intent sits in `REQUIRES_ACTION` from the moment it is started
and most are never paid — someone changed their mind, or opened the page twice.
The maintenance sweep expires them after `PAYMENT_INTENT_TTL_HOURS`.

It does not touch a terminal payment, so money that arrived is never un-arrived
by a clock. It does not touch `PROCESSING` either: the provider has the money in
hand and is still working, and expiring that would tell a payer their payment
failed while it was about to succeed. Only the state where nothing has moved can
be closed by a timer.

Expiry is terminal. A transfer that genuinely arrived after the window closed is
an operator's decision — a new payment, or a manual credit with a name against it
— not something a late webhook does by itself.

## What the screens do and do not claim

The wallet page offers whatever `GET /payments/providers` returns, which today is
a bank transfer and nothing else. No card logos: a button for a provider nobody
has a contract with is a button that fails on submit.

Nothing on that page moves the balance. Starting a deposit is an instruction to
the payer, and `useStartPayment` deliberately does not invalidate the wallet
query — refetching it on submit would suggest a screen where a number was about
to go up.

The instructions for an unpaid deposit stay visible in the payment list rather
than appearing once. The reference is the only thing tying a line on a bank
statement to a person, and somebody who closed the tab has to be able to find it
again.

`/admin/payments` opens on the queue — payments waiting for a person — because
that is the only part of the screen that is _work_. Expanding one shows every
delivery, **including the ones that were ignored or alarmed**: an operator
looking into a deposit a payer insists they made needs to see the delivery whose
amount did not match, and a screen showing only what was applied would show
nothing at all in exactly the cases somebody is asking about.

## Configuration

| Variable                   | Default   | What it does                                       |
| -------------------------- | --------- | -------------------------------------------------- |
| `PAYMENT_CURRENCIES`       | `USD`     | currencies this deployment takes                   |
| `PAYMENT_MAX_AMOUNT`       | `100000`  | largest single deposit that may be started         |
| `PAYMENT_INTENT_TTL_HOURS` | `72`      | how long an unpaid payment stays open              |
| `PAYMENT_BANK_DETAILS`     | _(unset)_ | shown verbatim to a payer choosing a bank transfer |

`PAYMENT_MAX_AMOUNT` is a refusal at the door rather than a half-processed
transfer. The boundary is inclusive: exactly the ceiling is allowed.
