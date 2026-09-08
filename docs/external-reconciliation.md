# External reconciliation (§44)

The platform's records against a venue's.

## Different in kind from the internal checks

`reconciliation_findings` compares this platform's own records against each
other — orders, positions, trades and the ledger, each written by its own code
path inside the same transaction. There, a disagreement means exactly one of
those paths is wrong and the others are the evidence.

Here, a disagreement can also mean the venue is right and we are behind, or that
we asked at a moment the venue was mid-write. So nothing in this component
concludes anything about _cause_. It states what each side said, how they
differ, and leaves the meaning to a person.

## The rule this exists to obey

**An unreachable venue is not evidence of anything.**

If `getOrders` times out, the platform has not discovered that its orders are
missing. It has discovered that it cannot see the venue's. Writing
`MISSING_EXTERNAL` for every order in that case produces a report saying the
firm's entire book is unbacked — on the day the network was bad — and somebody
acts on it.

So a failure to reach the venue for an account **aborts that account's
comparison**. It is counted as unreachable on the run and never becomes an item.
This is §26's "never interpret an API timeout as a trader breaching rules",
applied to the other end of the system, and it is the property most worth
protecting here.

The run still completes and is recorded. "We could not look" is a fact an
operator needs, and a run that vanished would look like a run that never
happened.

## Statuses

| Status              | Means                                                                               |
| ------------------- | ----------------------------------------------------------------------------------- |
| `MATCHED`           | Both sides agree.                                                                   |
| `MISSING_INTERNAL`  | The venue has it and we do not — a trade nobody here booked.                        |
| `MISSING_EXTERNAL`  | We have it and the venue does not — a position we believe in and nobody is holding. |
| `QUANTITY_MISMATCH` | Volumes differ.                                                                     |
| `PRICE_MISMATCH`    | Prices differ.                                                                      |
| `FEE_MISMATCH`      | Commission differs.                                                                 |
| `BALANCE_MISMATCH`  | Balance or equity differs.                                                          |
| `UNKNOWN`           | Both sides have it and it could not be compared.                                    |

`UNKNOWN` is deliberately **not** "matched". An item nobody could compare is not
an item that agrees, and calling it one is how a reconciliation report comes back
clean on the day the venue starts returning empty fields. `needsAttention`
counts it, and so does the run's `itemsUnknown`.

Two numbers in different currencies do not differ by their subtraction, so a
currency disagreement is `UNKNOWN` rather than a balance mismatch: reporting a
difference there would be a number worse than no number.

## Tolerances

Zero everywhere by default, and that is the right default — a fee that is a cent
out is a cent that came from somewhere. A tolerance is a decision a firm makes
about a particular venue (one that rounds swap to five decimals, say), and it is
**recorded on every item it is applied to**, so a reader can tell "these agreed"
from "these were close enough by a rule somebody set".

Never a floating-point epsilon. These are decimals; "close enough" is a business
rule with a number attached, not an artefact of binary arithmetic.

## Commission is compared as a total, not per fill

This platform books commission against the **position**; a venue reports it
against the **fill**. There is no honest way to split ours back out into theirs,
and a per-fill `FEE_MISMATCH` derived from a guess about the split would be a
finding about the guess.

So the comparison is the one both sides can actually make: everything charged on
the account over the window, on each side. It is what a finance person checks,
and it catches the thing that matters — a venue charging more than the platform
has booked — without pretending to a precision neither side has.

A venue that reports no commission at all is not a venue that charges nothing:
that is `UNKNOWN`, not a mismatch for the full amount. And when nothing was
charged here _and_ the venue said nothing, there is no item at all — an absence
is neither a discrepancy nor an agreement, and an `UNKNOWN` on every quiet
account on every run makes a report whose normal state is a page of them.

## Only disagreements are stored

A matched order is a row the platform would write on every run for the life of
the account, and a hundred thousand of them say exactly what
`ReconciliationRun.itemsMatched` says in one integer. So `MATCHED` is a status
the column can hold and in practice never does — kept in the enum because the
comparison produces it, and truncating the vocabulary at the database boundary
is how a status quietly becomes a lie.

Items are **per run**, not deduplicated. A finding is deduplicated because it is
the standing view of a problem; an item is the record of one comparison at one
moment, and "the same order disagreed on Monday and again on Tuesday" is two
observations — which is precisely what an investigator wants to see.

## Resolutions

`resolution_records` is what a person decided, and why.

Append-only, and separate from the item on purpose: an item's `status` is what
the machine observed, a resolution is what a person concluded, and the two must
not be able to overwrite each other. A discrepancy investigated and accepted,
and the same one reopened a month later, are **two records** — not one field
changing its mind.

There is no route that edits or deletes one, and a database trigger refuses
`UPDATE` and `DELETE` outright — the guarantee has to survive somebody writing
around the API. The correction of a mistaken resolution is another resolution
saying so.

The note is required, and the database enforces that too. A decision with no
reason is a decision nobody can review, and these are read months later by
people who were not there.

| Decision              | Means                                                           |
| --------------------- | --------------------------------------------------------------- |
| `FALSE_POSITIVE`      | Looked at; the records were right after all.                    |
| `ACCEPTED_DIFFERENCE` | Real, understood, expected to stay.                             |
| `CORRECTED_MANUALLY`  | Real, and a correcting entry was made by hand elsewhere.        |
| `UNDER_INVESTIGATION` | Real, and the cause is being chased. A state, not a conclusion. |
| `ESCALATED`           | Raised beyond the desk.                                         |

There is deliberately no `REPAIRED`. **Nothing in this system repairs a
discrepancy** (§112), so there is no value here that could claim it did.
Auto-correcting would erase the evidence of how the drift happened — the one
thing an investigation needs — and would turn a bug that shows up once into one
that quietly cleans up after itself for ever.

## API

| Route                                | Permission              |
| ------------------------------------ | ----------------------- |
| `GET /reconciliation/items`          | `reconciliation.read`   |
| `GET /reconciliation/resolutions`    | `reconciliation.read`   |
| `POST /reconciliation/external-runs` | `reconciliation.run`    |
| `POST /reconciliation/resolutions`   | `reconciliation.manage` |

Reading a discrepancy and deciding about one are separate permissions, for the
same reason closing an internal finding is: anyone who can see a discrepancy
must not thereby be able to declare it accounted for.

`POST /reconciliation/external-runs` is **synchronous**, unlike the internal run
which is queued. This one talks to a venue over the network and the person who
asked needs to be told whether it could be reached — a queued job that silently
counted an unreachable venue as a clean pass is the failure this whole feature
exists to avoid.

## Not done

**No scheduled external run yet.** The internal sweep runs on
`RECONCILIATION_CRON`; this one is on demand only. Scheduling it needs a
decision about _which_ connections to sweep and how often, and that decision
belongs with the first real venue rather than being guessed against a mock.

**Order and position status are not compared**, only volumes, fills and prices.
Mapping a venue's status vocabulary onto this platform's is provider-specific,
and inventing a mapping against the mock would produce a comparison that fails
the moment a real venue arrives.
