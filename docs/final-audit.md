# The final audit

Two plans have run against this repository. The second — the multi-tenant,
multi-broker specification of 3 September 2026 — ends here, with the §107
matrix: one line per area of the specification, PASS / PARTIAL / BLOCKED, and
for every BLOCKED item what is missing, why, what outside the repository it
waits on, and what interface or mock already stands in its place. The first
plan's audit follows, unchanged, because what it found still holds.

## The multi-broker plan's audit (10 September 2026)

### How it was verified

Everything below was checked against the build at the head of
`feat/m1-realtime-terminal`, not against the plan's description of it:

| Gate                                                 | Result                                                      |
| ---------------------------------------------------- | ----------------------------------------------------------- |
| `pnpm verify` (lint, types, inventory, tests, build) | 185 files / 2,480 tests                                     |
| `pnpm smoke` (boots the API build)                   | 22 checks, including the boot log reaching stdout           |
| `pnpm smoke:worker`                                  | 7 checks, including a narrowed processor and a file secret  |
| `pnpm smoke:ws`                                      | 9 checks                                                    |
| `pnpm smoke:web` (Playwright)                        | 124 checks                                                  |
| `pnpm pentest`                                       | 62 attacks refused, every one enumerated in the checklist   |
| `pnpm chaos` (§75)                                   | 7 scenarios hold the invariant, including SIGTERM mid-burst |
| `pnpm load` at 500 traders / 1,000 sockets           | passes; every refusal a safe one                            |
| Production (`devopss.ir`)                            | deployed at each phase; boot log read after each deploy     |

Mutation testing was standing practice: every guarantee added in the last two
phases was broken on purpose and the test that was supposed to catch it was
watched fail. The one mutant that survived — a duplicate quote-flush timer with
no observable effect — is recorded as equivalent, not as covered.

### The matrix (§107)

PASS: present and tested. PARTIAL: present, short of the section, with what is
short named. BLOCKED: cannot be finished without something outside the
repository — each states what, why, and the seam already in place.

| §                 | Area                                            | Status  | Note                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------------- | ----------------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2                 | Execution modes                                 | PARTIAL | INTERNAL complete; `EXTERNAL_BROKER` built end to end against the mock adapter (Phases 2–3, 9); a real venue is §10–11's BLOCKED item                                                                                                                                                                                                                                                                                                                                       |
| 4                 | Non-negotiable abstractions                     | PASS    |                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 5                 | Money / precision                               | PASS    | Decimal, NUMERIC, strings; `assert-no-float-columns`                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 6                 | Domain model                                    | PASS    | broker, connection, credential, mapping, outbox/inbox, master accounts, security events, webhooks, tenant features all present                                                                                                                                                                                                                                                                                                                                              |
| 7                 | Multi-tenancy                                   | PASS    | RLS on a separate role, probed at boot; connection budget printed at boot; platform-wide sweeps run on the privileged pool by name                                                                                                                                                                                                                                                                                                                                          |
| 8                 | Role model                                      | PASS    | platform and broker role groups, assignability rule, reconciled with each build                                                                                                                                                                                                                                                                                                                                                                                             |
| 9                 | Break-glass / impersonation                     | PASS    | reason-bound, time-bound, audited; one decision open (which role holds `security.break_glass`)                                                                                                                                                                                                                                                                                                                                                                              |
| 10–11             | Broker adapter SDK, account mapping             | BLOCKED | **Missing:** a connector to a real venue. **Why:** the specification forbids inventing an undocumented broker API. **Waits on:** that venue's API documentation and sandbox credentials. **In place:** `BrokerAdapter` port with capability discovery, `MockBrokerAdapter` with the whole failure catalogue, the contract suite any adapter must pass, connection state machine, credential envelope, instrument mapping, a registry that refuses an undocumented connector |
| 12                | Credential security                             | PASS    | sealed with `SecretBox`; metadata only leaves the server; secrets may arrive as files (`docs/secrets.md`)                                                                                                                                                                                                                                                                                                                                                                   |
| 13–14             | Broker panel, dashboard                         | PARTIAL | the firm's book, sessions, money by currency, connections, security centre, IP rules, webhooks, features, developer reference; **not built:** fee schedules, server-side reports, admin threshold alerts, branding — each stated in `broker-panel.md`                                                                                                                                                                                                                       |
| 15                | Master accounts                                 | PASS    | links, capabilities, desk view across linked accounts, desk risk ceilings; no organisation hierarchy above a master (stated)                                                                                                                                                                                                                                                                                                                                                |
| 16                | Multi-account user                              | PASS    | account selector; state scoped per account                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 17–24             | Terminal IA, header, watchlist, tickets, panels | PARTIAL | the parts where the alternative was a defect are built; the inline quick ticket, categories/top movers, Finance/Alerts/Logs tabs and the typography scale are not — `uiux.md` says why for each                                                                                                                                                                                                                                                                             |
| 25                | Server-side close-all                           | PASS    | `POST /positions/close-all`, outcome per position, largest margin first                                                                                                                                                                                                                                                                                                                                                                                                     |
| 26–27             | Chart, drawing persistence                      | PARTIAL | persistence of layout, instrument, resolution and levels done; indicators, the drawing set and bid/ask axis labels are §7's BLOCKED item                                                                                                                                                                                                                                                                                                                                    |
| 26–27 (library)   | Indicators, drawings, axis labels               | BLOCKED | **Missing:** the indicator and drawing toolset. **Why:** the reference is the TradingView charting library's behaviour, and this repository holds an open-source renderer. **Waits on:** a TradingView licence, or the product owner accepting the open-source set as the target. **In place:** the chart seam (§58) that keeps the renderer replaceable, and level persistence that survives either choice                                                                 |
| 28–29             | Overlays, draggable SL/TP                       | PASS    |                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 30–31             | Edit dialog, shared calculator                  | PASS    | one calculator, shared by ticket, dialog and mobile                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 32–35             | Market data, realtime, freshness                | PASS    | quotes conflated; P&L one frame per account; tick → frame latency measured; freshness gates on every fill                                                                                                                                                                                                                                                                                                                                                                   |
| 36                | Market status states                            | PASS    | OPEN / PRE_OPEN / POST_CLOSE / CLOSED / HALTED / UNKNOWN, derived from one function the engine and the screen both read; only OPEN trades, and a state with no opening time never reports one                                                                                                                                                                                                                                                                               |
| 37–39             | P&L, fees, risk engine                          | PASS    |                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 40                | Risk hierarchy                                  | PASS    | platform → broker → master/desk → account, ceilings audited                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 41–43             | External execution, outbox, disconnect          | PARTIAL | built and tested against the mock, UNKNOWN outcomes queried back never retried blindly, recovery sequence on reconnect; exercised against a real venue only when §10–11 unblocks                                                                                                                                                                                                                                                                                            |
| 44                | Reconciliation                                  | PARTIAL | internal complete; external: on-demand runs, `MISSING_INTERNAL` / `MISSING_EXTERNAL` / `UNREACHABLE`, `ResolutionRecord`; **not done:** scheduled external sweeps, status vocabulary mapping, swaps/cash — each waits on a real venue (§10–11)                                                                                                                                                                                                                              |
| 45                | Ledger                                          | PASS    | append-only, replayed by reconciliation, never repaired                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 46                | Anti-fraud                                      | PASS    | security events, rate/replay/device/IP signals, review queue, tenant IP rules (`anti-fraud.md`)                                                                                                                                                                                                                                                                                                                                                                             |
| 47                | Security                                        | PASS    | `SECURITY_AUDIT.md`, `penetration-checklist.md` (62), Security Centre; one production setting owed: `TRUSTED_PROXY_HOPS`                                                                                                                                                                                                                                                                                                                                                    |
| 48                | API keys                                        | PASS    |                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 49                | Webhooks                                        | PASS    | signed, retried, disabled after failures, SSRF-vetted, secret shown once; `reconciliation.mismatch` and `security.alert` events wait on their producers writing outbox rows                                                                                                                                                                                                                                                                                                 |
| 50–51             | Notifications, sounds                           | PASS    |                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 52, 57, 61, 83–86 | Terminal UX, responsive, a11y, quality          | PARTIAL | large-order confirmation, risk as a share of equity, account selector done; a documented accessibility pass and a light theme are not                                                                                                                                                                                                                                                                                                                                       |
| 53–56             | Mobile                                          | PARTIAL | account switching, reconnect with backoff and the §55 states, secure token store, seen-event dedupe, haptics, sound, chart with overlays, shared protective-level maths; **not built:** biometric unlock, and the selected account does not survive a relaunch (the app has no store for a preference); acceptance is §105's BLOCKED item                                                                                                                                   |
| 58                | Chart library seams                             | PASS    |                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 59                | White label                                     | PARTIAL | `white_label` is a platform-set feature flag, enforced server-side; the `Tenant` model has no visual fields yet — a phase nobody has designed                                                                                                                                                                                                                                                                                                                               |
| 60                | Locale (English + Persian, RTL)                 | PARTIAL | not built; stated rather than stubbed                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 62                | Audit log                                       | PASS    | append-only at the database; before/after on every mutation                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 63                | Observability                                   | PASS    | the metric set, Prometheus + Grafana provisioned from the repository, alert rules, dashboard cross-checked against `MetricsService`                                                                                                                                                                                                                                                                                                                                         |
| 64                | Distributed leadership                          | PASS    | database-clock leases for ingest, trigger engine, price alerts; verified under chaos                                                                                                                                                                                                                                                                                                                                                                                        |
| 65–66             | Database, concurrency                           | PASS    |                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 67                | Failure handling                                | PASS    | internal and external paths against the mock; the idempotency claim commits with the money (found by §75)                                                                                                                                                                                                                                                                                                                                                                   |
| 68                | Rate limiting                                   | PASS    | per IP, tenant, account, master; admission control by count and loop lag                                                                                                                                                                                                                                                                                                                                                                                                    |
| 69–71             | API design, envelope, idempotency               | PASS    |                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 72–75             | Security tests, load, failure injection         | PARTIAL | pentest, soak, chaos and load at 500 traders done and every finding fixed; **1,000 traders / 5,000 sockets** needs a generator on a host other than the platform's — reported as a limit of the box, not the platform                                                                                                                                                                                                                                                       |
| 76                | Disaster recovery                               | PASS    | verified backups, `disaster-recovery.md`, rehearsed restore                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 77–79             | Deployment, config, migrations                  | PASS    | ingest, trigger engine, WebSocket, worker roles each in their own containers; graceful drain; secrets from files; broker adapters stay in-process until one exists                                                                                                                                                                                                                                                                                                          |
| 80–81             | UI state, optimistic UI                         | PASS    |                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 87–90             | Account/broker status, instruments              | PASS    | account status policy table; broker status ACTIVE / SUSPENDED / CLOSED with its own transitions (`brokers.service.ts`) — an earlier draft of this matrix said it was absent, which was wrong                                                                                                                                                                                                                                                                                |
| 91, 113           | PropFA seam                                     | PASS    | none of it in the repository; the outbox is the seam                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 92–94             | Analytics/event schema, versioning              | PASS    | envelope v2                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 95                | Feature flags                                   | PASS    | authority and enforcement stated per flag                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 96                | Documentation                                   | PASS    | seventy-odd documents; every phase's decisions written where the code is                                                                                                                                                                                                                                                                                                                                                                                                    |
| 100–103           | Acceptance scenarios                            | PARTIAL | the internal path end to end in the browser suite; the broker steps run against the mock and wait on §10–11 for a venue                                                                                                                                                                                                                                                                                                                                                     |
| 105               | Mobile acceptance                               | BLOCKED | **Missing:** a run on a device. **Why:** an emulator proves nothing about biometrics, background reconnects or a real network. **Waits on:** a physical Android device; iOS additionally on macOS, Xcode and a signing key. **In place:** the app builds for Android, its logic is unit-tested, and every screen runs on the same store the web terminal uses                                                                                                               |

### What the audit itself found

Looking at the whole thing again at the end turned up three things, all fixed
before this was written: the first deploy of the direct `listen()` lost the
entire boot log (Nest flushes buffered logs from inside `app.listen`; the smoke
now pins that the boot log reaches stdout); a compose profile is still
interpolated, so a required Grafana password in the main file stopped every
`compose` command on the host (moved to its own file; a test pins that the main
file requires nothing an ordinary deploy does not set); and the worker's config
module validates at import time, so a secret resolved inside `bootstrap()` was
resolved too late (the resolver is the first import; a test pins the order).

### Corrections to this matrix

An audit that is never revisited becomes a claim rather than a record. Two rows
have changed since it was first written, and both are recorded rather than
quietly edited:

- **§53–56 gained account switching.** The row first said it was absent; it is
  built now, and the row says what is still missing rather than being deleted.
- **§87–90 was wrong.** It said a broker had no status of its own. It has —
  ACTIVE / SUSPENDED / CLOSED, with transitions guarded in `brokers.service.ts`.
  The row was written from a grep that looked only at connection status. PASS.
- **§36 was PARTIAL and is now PASS.** The market state machine was built
  afterwards; the entry below records what it cost to find.

### Decisions owed by the product owner

Named here because the code cannot make them: `TRUSTED_PROXY_HOPS=2` and
`DATABASE_TENANT_POOLS=4` in production; whether `security.break_glass` sits on
ADMIN or SUPPORT; the first ADMIN account; TP-100001's +42.98 USD; a broker's
API documentation and sandbox; a TradingView licence or the open-source
target; the Match-Trader screenshots the terminal was to match; a device for
mobile acceptance; a host for the load generator; what a resting order should
do when the market is closed; CSF's SSH bans and its treatment of Docker's
iptables.

## The first plan's audit (August 2026)

The last step of the first upgrade plan: look at the whole thing at once, from
the three angles that catch different faults.

- **In a browser**, because every UI defect this work found — a figure rendering
  as `—` while the API was sending it, a chart level drawn off-screen, a label
  describing two prices at once, a session row that would not go away after being
  ended — was found by looking at the screen and by no other means.
- **Under concurrency**, because the faults that create money only exist when two
  requests arrive together.
- **Across the integration**, because a platform whose parts are each correct can
  still present something incoherent.

### Concurrency

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

#### What it found: margin could be spent twice

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

### The browser

A full walkthrough, photographed at each step: register, land, read the account
strip, open a position, watch the figures move without touching anything, close
it, walk the history tabs, open both settings panels.

#### What it found

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

#### Everything else, cross-checked on screen

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

### Integration

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

### What was deliberately still open then

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
