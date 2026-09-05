# The broker panel

What the person running a firm can see and do, and what is deliberately still
missing.

This is the Phase 5 layer. Most of the console already existed; this phase
added the parts a broker could not run a desk without — the firm's own book,
the trading week, and money on the dashboard — and says plainly which of §13's
sections are not built.

---

## 1. The firm's book

Every trading listing on this platform is account-scoped and ownership-checked.
That is right for a trader and useless for the person running the firm:
answering "what is open across the book right now" or "why was that order
rejected at 14:32" meant a database console.

`/admin/book` has three tabs — Orders, Positions, Closed trades — each a real
query across the whole tenant, with the account number and the owner's address
beside every row, and an order's own event history one click away.

### It takes `accounts.read_any`, not `orders.read`

Every trader holds `orders.read`; it is what lets them see their own orders.
Guarding a firm-wide blotter with it would show one trader everybody else's
book. That exact mistake was made once on the venue-recovery console and caught
by the pentest rather than by the suite, so this one is guarded by the
permission that already means "read across accounts" — and the pentest attacks
it directly.

The tenancy extension scopes every query, so "tenant-wide" means one firm's
book and never the platform's.

### Paging is by cursor, not page number

A book is read while orders are still arriving. `skip`/`take` over a moving
table shows some rows twice and skips others, which in a book of orders is not
cosmetic — it is a row somebody is looking for that is not there.

The cursor carries the row's timestamp **and its id**, because several orders
can share a millisecond, and a cursor of time alone would repeat or drop such a
pair at every page boundary. The screen therefore offers Next and Back and no
jump to page seven, which is honest about what a keyset can actually do.

A page marker that cannot be read is refused rather than quietly restarting at
the top of the book.

### An unknown account number matches nothing

Not everything. A mistyped digit that fell through to no filter would show a
support agent the whole firm's book while looking like a successful search.

### Export is of the page, and says so

The button reads "Export this page". An export that silently handed over one
screen of a hundred thousand rows would be worse than none. Whole-dataset
export is a server-side job and is **not built** — see §5.

---

## 2. The trading week

`MarketSession` has existed since the beginning and nothing could edit it: the
only writer in the repository was the seed. A firm that needed Friday to close
an hour early needed a database console.

The Instruments screen now edits it, under each instrument.

**The week is replaced whole.** Saving day by day would mean a moment where
Monday has been written and Tuesday has not, and that moment is a market that
is open when it should be shut. It also makes "close Friday an hour earlier"
one audited change rather than a sequence somebody could stop halfway.

**Overlaps are refused, not merged.** Two windows that overlap mean somebody
described the week twice and disagreed with themselves; taking the union would
hide which they meant and make "why was it open at 3am" unanswerable from the
row. Windows that _touch_ — 00:00–10:00 and 10:00–11:40 — are fine: that is one
window described in two parts.

**A window may not cross midnight.** It is two windows: one ending at 1440 on
the first day, one starting at 0 on the next. The refusal says so.

**The timezone is checked against the system's own database**, not a list
somebody typed, so it stays correct as zones are added and renamed.

**It is a platform act.** Sessions are when the _venue_ trades, so a broker is
refused — a firm that wants an instrument shut disables it for itself, which it
already can.

**The cache is refreshed on save.** The engine checks the session before every
order from a cached copy; without the reload the change would take effect at
the next restart, which is exactly the kind of "it did not apply" that gets
blamed on the market.

---

## 3. Money on the dashboard

The operator's page was counts only. It could say how many orders were rejected
in the last hour and not what the firm was holding or what dealing had earned
it, which are the first two questions anyone running one asks.

It now carries, **by currency**: balance held, deposits and withdrawals in the
last day, commission and swap earned, traders' net P&L, closed trades and
volume.

**By currency, never summed across them.** A firm holding dollars and euros has
two numbers, and one number made by adding them is not a smaller mistake than
showing neither — it is a figure that looks authoritative and reconciles with
nothing. Converting them would need a rate for every pair at the instant the
page is drawn, and a dashboard is not the place to invent one.

Withdrawals are negative ledger entries; the figure is labelled "out", so it
carries what left as a positive number. A negative under that heading reads as
money arriving.

---

## 4. The navigation today

| §13 section                                 | State                                                          |
| ------------------------------------------- | -------------------------------------------------------------- |
| Dashboard                                   | real queries, and now money as well as counts                  |
| Users                                       | `/admin/people`                                                |
| Trading Accounts                            | `/admin/accounts`                                              |
| Master Accounts                             | `/admin/desks`                                                 |
| Orders / Positions / Trades / Order history | `/admin/book` — **new this phase**                             |
| Instruments                                 | `/admin/instruments`                                           |
| Sessions                                    | on the Instruments screen — **new this phase**                 |
| Risk / Margin / Exposure                    | `/admin/risk`, five tabs including the ceilings                |
| Broker Connections                          | `/admin/connections`                                           |
| Reconciliation                              | `/admin/reconciliation`                                        |
| Audit                                       | `/admin/audit`                                                 |
| Security                                    | `/admin/security` — the event feed                             |
| Developer: API keys                         | `/admin/credentials`                                           |
| **Fees**                                    | **no section** — commission and swap are edited on Instruments |
| **Reports**                                 | **not built**                                                  |
| **Alerts**                                  | **not built**                                                  |
| **Security: devices, IP rules**             | **not built**                                                  |
| **Branding**                                | **not built**                                                  |
| **Developer: webhooks, API docs**           | **not built** / non-production only                            |

---

## 5. What is not built, and where it belongs

Saying this plainly is the point of the table above. None of the following
exists, and none of it is stubbed:

- **Fees as a section.** Commission and swap are editable per instrument on the
  Instruments screen, which is the only place they can be set. There is no fee
  schedule, no per-account or per-desk override, no rebate or markup model, and
  no report of fees charged — though the dashboard now shows commission earned
  in the last day, and the closed-trades tab shows what each round trip cost.
  Spread is not configurable at all: it comes from the feed.
- **Reports.** There is no server-side export and no statement generator. What
  exists is client-side CSV of the page on screen, on Audit, the book, and the
  trader's own history. A real reporting surface is a job queue, a file store
  and a retention policy — a phase of its own, not a button.
- **Alerts.** `Alert` (price alerts) is Phase 8, with the notification
  channels. Admin alert _rules_ — thresholds that raise something when a figure
  moves — do not exist and are not designed.
- **Security: devices and IP rules.** Device management is self-service only;
  there is no admin view. There is no IP allow/deny concept anywhere in the
  platform: addresses are recorded on sessions, audit rows and security events,
  and are never used as a control. Adding one is a security feature with real
  lock-out risk, and belongs with Phase 10.
- **Branding / white label.** Nothing exists. The `Tenant` model carries no
  visual field. Phase 14 lists white label behind a feature flag; the feature
  it would flag has not been written.
- **Webhooks.** Phase 12. The Phase 3 outbox is what they will be delivered
  from — `OutboxRelayService` already takes a destination.
- **API documentation.** Swagger is mounted at `/docs`, but only when
  `NODE_ENV` is not production, so **there is no API documentation in
  production**, and nothing in the console links to it.
