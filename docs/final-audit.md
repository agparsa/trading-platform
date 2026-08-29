# The final audit

The last step of the upgrade plan: look at the whole thing at once, from the
three angles that catch different faults.

- **In a browser**, because every UI defect this work found — a figure rendering
  as `—` while the API was sending it, a chart level drawn off-screen, a label
  describing two prices at once, a session row that would not go away after being
  ended — was found by looking at the screen and by no other means.
- **Under concurrency**, because the faults that create money only exist when two
  requests arrive together.
- **Across the integration**, because a platform whose parts are each correct can
  still present something incoherent.

## Concurrency

`apps/api/test/integration/concurrency.test.ts` is the deliberate pass over races
nobody had gone looking for. `trading.test.ts` already covers the ones this
platform met while being built — two closes of one position, ten closes, a
modification losing to a close, ten simultaneous opens. This file asks a
different question:

> **Which pair of simultaneous requests could create money?**

| Race                                                         | What would go wrong                                                |
| ------------------------------------------------------------ | ------------------------------------------------------------------ |
| Two partial closes of 0.6 on a 1.0 position                  | The account is paid for 1.2 lots it never held                     |
| Five partial closes of 0.5 at once                           | The same, past the point where luck could explain it               |
| Two orders that each fit the free margin and together do not | Margin spent twice; a stop-out on a position that should not exist |
| A stop-out firing while the owner closes by hand             | One close, paid for twice                                          |
| A limit filling as its owner cancels it                      | An order the trader believes is gone, carrying risk                |
| Twenty trades at once on one account                         | The balance stops equalling its ledger                             |

Every case ends by replaying the ledger. **A race that leaves the right rows and
the wrong balance is the failure that matters, and a count of rows cannot see
it.**

Two of them are written to be non-vacuous on purpose. The stop-out case asserts
_exactly_ one trade rather than at most one, because a run where neither path
fired would pass a `<= 1` assertion while proving nothing. The five-way close
exists because a two-way race can pass by luck — two requests can miss each
other; five cannot all miss each other.

### What it found: margin could be spent twice

The margin case failed on its first run.

    expected 9167.44 to be less than or equal to 4972

Two one-lot orders on a $5,000 account, submitted together. Each needed $4,583 of
margin. Both opened. The account came out holding $9,167 of margin against $4,972
of equity — a margin level of 54%, far past any stop-out, on positions it should
never have been allowed to take.

The cause was a time-of-check-to-time-of-use gap, and it was there on purpose. The
class comment said so:

> Everything that can reject — validation, pricing, margin, risk — happens
> _before_ the transaction opens, so a rejected order costs one read-only pass and
> holds no row locks.

That is a good instinct and it is wrong for margin. Validation reads the request;
margin reads the _account_, and the account can change between the read and the
write. Two orders each read the same free margin, each concluded independently
that it fitted, and each then took the account lock in turn and spent it.

The fix moves the valuation, the risk context and the decision **inside** the
transaction, after `lockAccount`. The number that is read can no longer change
before it is spent. A rejection now has to escape a transaction that must roll
back, so it travels out in a `RiskRejection` and the risk event is recorded after
the rollback — a write inside a rolled-back transaction is a write that never
happened, and the rejection would otherwise leave no trace.

The same fault was in the resting-order fill path, where it is worse: a limit
fills from the tick loop while its owner may be submitting a market order by hand,
so "the account changed since the check" can mean "in the last millisecond". Fixed
the same way.

Reverting the fix — reading the valuation before the transaction and using it
inside — fails the case again, so the test would catch the regression.

The cost is real and worth stating: the account lock now covers a valuation, so
less work happens in parallel. Measured with `pnpm load` on the same two-CPU
container, throughput went from ~58 orders/second to ~54, and a single unloaded
order from 43ms to 35ms. The first is a real ~7% reduction, close enough to the
run-to-run spread that it should be re-measured on real hardware; the second is
noise in the other direction. Either way it is the right trade — a lock held for
the length of one evaluation, in exchange for an invariant that cannot be raced.

**This is the most serious defect this upgrade found.** Margin exists to stop an
account taking on risk it cannot cover; a race that defeats it defeats the whole
purpose. It survived every unit test, every integration test, the smoke suite, the
penetration checklist and a fifteen-minute soak, because all of those submit
orders one at a time.

## The browser

A full walkthrough, photographed at each step: register, land, read the account
strip, open a position, watch the figures move without touching anything, close
it, walk the history tabs, open both settings panels.

### What it found

**The terminal opened on a closed instrument.** The default was
`tradeableSymbols[0]` — alphabetical, which at a weekend is AUDUSD, and at a
weekend every market except crypto is shut. A new user's first sight of the
platform was an empty chart, a price of `—`, and an order ticket refusing to
send. Nothing was broken and everything looked broken, for two days out of every
seven.

It now prefers an instrument whose session is open, falling back to the first if
none is. The fallback is deliberate: if the whole market is shut there is no
better choice, and an empty selector would be worse than a closed instrument
honestly labelled.

This is a good example of the class of fault only a browser finds. Every test
passed. The API was correct. The data was correct. The product was bad.

### Everything else, cross-checked on screen

Read off one screenshot, mid-position, and verified by hand:

| Figure           | Shown      | Checks against                        |
| ---------------- | ---------- | ------------------------------------- |
| Equity           | $99,995.31 | balance $100,000.00 + floating −$4.69 |
| Free margin      | $99,917.35 | equity − used margin $77.96           |
| Margin level     | 128264.89% | equity ÷ used margin × 100            |
| Utilisation      | 0.08%      | used margin ÷ equity                  |
| Exposure         | $7,791.66  | 0.10 lots × 77,916.57                 |
| Net P&L on close | −$37.95    | (78,039.24 − 78,418.74) × 0.10        |

The position line is drawn on the chart at its entry price, the floating figures
move without any interaction, and the trade lands in the history with the exit
price the ticket quoted.

`Manage` opens close, partial close, reverse and protective levels. The close
button is labelled with the volume it will close — `Close 0.10` — rather than with
the word "Close", which is the difference between an action and a guess.

## Integration

The things that have to agree across the whole system, checked as a set rather
than one service at a time:

- **One definition of a session.** `GET /users/me/sessions` was removed during
  step 11 because `GET /auth/sessions` answered the same question better. Two
  answers to "where am I signed in" is one too many.
- **One definition of the reconciliation checks.** The restore rehearsal started
  with its own SQL for "is this copy self-consistent" and the SQL was wrong. It
  now runs the real engine.
- **One definition of a usable encryption key.** The Zod schema validates
  `SECRET_ENCRYPTION_KEYS` with the same parser the application uses.
- **One definition of a token's type.** Access, refresh and two-factor challenge
  are told apart by the same `typ` discriminator, checked in both directions.

## What is deliberately still open

Recorded here rather than left to be discovered:

- No organisation hierarchy for master accounts.
- A master's trades audit the actor alone; the grant carries `linkId` so the
  delegation can be threaded through next.
- `accounts.read_any` grants nothing until there is a support surface.
- Per-order latency percentiles (§50) and operational alerts (§70) are not
  approximated.
- Four integrity patterns need client telemetry the latency work will bring.
- The admin audit surface.
- One decision for the product owner: what a resting order should do when the
  market is closed.
