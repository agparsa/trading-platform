# Master upgrade — audit and plan

The current-state audit required by the master upgrade specification, and the
plan derived from it. Written before any code changed, against commit
`5646c52` with a clean working tree, 469 passing tests and 17 passing smoke
checks.

The governing rule of this plan: **nothing new bypasses what already works.**
Where a capability exists it is extended, not rebuilt. Where the specification
describes something already implemented under a different name, the existing
name wins unless there is a documented reason to change it.

## 1. Current-state gap analysis

### Already implemented — extend, do not rebuild

| Spec   | Capability                                                                                                                         | State                                                                                                                                                 |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| §5     | Realtime P&L pipeline: tick → market engine → valuation → P&L → account state → risk → domain event → Redis → WebSocket → terminal | Complete, exactly as specified                                                                                                                        |
| §6     | Account header: balance, equity, floating P&L, margin, free margin, margin level                                                   | Present. **Missing on screen:** realized P&L, margin utilisation, exposure, open-position count                                                       |
| §7     | Per-position P&L with the executable-side convention (BUY marks at bid, SELL at ask)                                               | Complete. **Missing:** a net P&L column                                                                                                               |
| §15    | Order ticket with Market / Limit / Stop, volume, SL, TP, estimated margin                                                          | Present. **Missing:** bid/ask/spread display, estimated risk                                                                                          |
| §46    | WebSocket sequence numbers, account-scoped authorisation, gap detection, forced re-snapshot                                        | Complete                                                                                                                                              |
| §49    | Tick coalescing with extreme-aware detection, and detection price ≠ execution price recorded in the fill event                     | Complete                                                                                                                                              |
| §42–45 | Audit log with actor, action, resource, before/after, requestId, IP, user agent                                                    | Present. **Missing:** typed actor kinds, source tracking, a timeline surface                                                                          |
| §52–53 | Transactions, row locking, state guards, idempotency, Decimal money, no float columns                                              | Complete and CI-enforced                                                                                                                              |
| §31–37 | Reconciliation                                                                                                                     | **Only** ledger-vs-cached-balance drift. Nine of the ten checks in §33 are missing                                                                    |
| §22    | Roles                                                                                                                              | `USER`, `SUPPORT`, `OPERATOR`, `ADMIN` with a role guard. **No granular permissions**, no `RISK_MANAGER`                                              |
| §20    | Account trading states                                                                                                             | `ACTIVE`, `RESTRICTED`, `CLOSE_ONLY`, `SUSPENDED`, `CLOSED`. Close to the spec's four; `CLOSE_ONLY` already means "trading disabled, closing allowed" |

### Not implemented

| Spec        | Capability                                                                               |
| ----------- | ---------------------------------------------------------------------------------------- |
| §8–12       | SL/TP chart lines, drag-and-drop modification, trailing visualisation                    |
| §13–14      | One-click trading, keyboard trading                                                      |
| §16–19, §65 | Master accounts, hierarchy, master dashboard, master actions, master authorisation       |
| §21         | Global kill switch                                                                       |
| §22         | Granular permissions and backend enforcement                                             |
| §23–30      | Anti-fraud / integrity engine, signals, evidence, review workflow                        |
| §32–36      | Full reconciliation: executions, positions, trades, commission, swap                     |
| §38–41      | Operations dashboard, live account monitor, live position monitor                        |
| §50         | Order latency timeline (client → received → validated → accepted → executed → responded) |
| §70         | Operational alerts                                                                       |

### Naming reconciliation

The specification names some things this codebase already has under other names.
Renaming working code for style is explicitly out of scope, so:

- **`CLOSE_ONLY` is the spec's `TRADING_DISABLED`.** It already rejects new
  orders and permits closes, which is what §20 describes. The enum keeps its
  name; the documentation records the equivalence.
- **`RiskEvent` is the spec's risk signal store.** Integrity signals get their
  own model rather than overloading it, because a risk violation is a decision
  the engine made about an order and an integrity signal is an observation about
  a pattern — conflating them would make both harder to act on.

## 2. Affected modules

| Area            | Modules                                                                                |
| --------------- | -------------------------------------------------------------------------------------- |
| Permissions     | `apps/api/src/common/guards`, a new `common/permissions`, every controller             |
| Master accounts | New `apps/api/src/master`, `prisma/schema.prisma`, `apps/web`                          |
| Kill switch     | New `apps/api/src/operations`, `OrdersService`, `PositionsService`                     |
| Reconciliation  | `apps/worker/src/jobs/reconciliation.service.ts`, a new `packages/reconciliation-core` |
| Integrity       | New `packages/integrity-core`, new `apps/api/src/integrity`, the domain-event stream   |
| Chart trading   | `apps/web/src/components/chart-panel.tsx`, `lib/queries.ts`                            |
| Latency         | `apps/api/src/common`, `MetricsService`, `prisma/schema.prisma`                        |

Deliberately untouched: `packages/financial-core`, `packages/trading-core`
formula code, `LedgerService`, and the order/position state machines. Every new
capability consumes them; none replaces them.

## 3. Database migration plan

Additive only. No column is dropped or narrowed, so an older image runs against
a newer schema and a rollback is an image rollback.

| Migration         | Adds                                                                                                       |
| ----------------- | ---------------------------------------------------------------------------------------------------------- |
| `permissions`     | `Permission` catalogue, `RolePermission` join, `RISK_MANAGER` to `UserRole`                                |
| `master_accounts` | `MasterAccount`, `MasterAccountLink` (master ↔ trading account, with per-link permissions), `Organization` |
| `kill_switch`     | `SystemSetting` key/value with an audit trail                                                              |
| `integrity`       | `IntegritySignal`, `IntegritySignalEvent` (append-only evidence)                                           |
| `reconciliation`  | `ReconciliationRun`, `ReconciliationFinding`                                                               |
| `order_latency`   | Nullable timestamp columns on `Order`; nullable so existing rows stay valid                                |

Every migration is written so it takes no long lock: new tables, nullable
columns, and indexes created without rewriting existing rows.

## 4. API changes

All new endpoints are `/api/v1`. No existing endpoint changes shape.

```
GET    /master-accounts                       list masters the caller may see
GET    /master-accounts/:id/accounts          the accounts under one master
GET    /master-accounts/:id/dashboard         live summary per account
POST   /master-accounts/:id/links             assign an account (admin)
DELETE /master-accounts/:id/links/:accountId  unassign

POST   /accounts/:id/trading-state            enable / disable trading
GET    /operations/kill-switch                current state
POST   /operations/kill-switch                set state (admin)
GET    /operations/overview                   system metrics for the dashboard

GET    /integrity/signals                     filtered signal list
POST   /integrity/signals/:id/status          acknowledge / investigate / resolve

POST   /reconciliation/runs                   run on demand
GET    /reconciliation/runs                   history
GET    /reconciliation/runs/:id/findings      what a run found

GET    /audit                                 filtered audit timeline
GET    /permissions/me                        the caller's effective permissions
```

## 5. WebSocket changes

The existing frame envelope, sequencing and account scoping are unchanged. New
channels and events:

| Channel      | Event                                          | Notes                                  |
| ------------ | ---------------------------------------------- | -------------------------------------- |
| `positions`  | `position.sl_modified`, `position.tp_modified` | Durable — never coalesced              |
| `operations` | `killswitch.changed`                           | Admin/operator sockets only            |
| `integrity`  | `integrity.signal`                             | Authorised sockets only                |
| `master`     | `master.account_updated`                       | Scoped to a master's assigned accounts |

§47's classification is made explicit in code: ephemeral market frames may
coalesce, durable trading events may not.

## 6. Frontend changes

| Change                                                          | Files                               |
| --------------------------------------------------------------- | ----------------------------------- |
| Chart position, entry, SL and TP lines with labels              | `chart-panel.tsx`                   |
| Drag SL/TP → optimistic preview → `PATCH` → revert on rejection | `chart-panel.tsx`, `lib/queries.ts` |
| Trailing stop visualisation                                     | `chart-panel.tsx`                   |
| One-click trading with an explicit armed indicator              | `order-ticket.tsx`, new settings    |
| Keyboard trading, disabled inside inputs, configurable          | new `lib/use-hotkeys.ts`            |
| Realized P&L, exposure, margin utilisation in the header        | `account-header.tsx`                |
| Master dashboard, account monitor, position monitor             | new `app/master/`                   |
| Operations dashboard                                            | new `app/operations/`               |
| Integrity signal review                                         | new `app/integrity/`                |

## 7. Testing plan

Every new capability carries tests before it is called done.

- **Unit** — permission resolution, master link authorisation, each integrity
  detector with a positive _and_ a negative fixture (a false-positive test is
  mandatory, §55), each reconciliation invariant.
- **Integration** — order → execution → position → ledger with a master acting;
  tick → P&L → WebSocket; a deliberately corrupted database that reconciliation
  must catch (§56).
- **Concurrency** — manual close racing SL, two master actions on one position,
  two modifications, duplicate requests.
- **Security** — user A cannot reach user B; a master cannot reach an unassigned
  account; an operator cannot perform an admin-only action.
- **Mutation** — remove each new guard and confirm a test fails: master-account
  permission, kill switch, permission enforcement, reconciliation invariant.
- **Browser** — the full trader journey, then the operator journey, both driven
  through Playwright against a running stack.

## 8. Implementation order

Follows the specification's order, because each step is the foundation of the
next: permissions gate master accounts, master accounts gate the dashboards, and
the integrity engine consumes events the earlier steps emit.

| Step | Work                                             | Depends on | State                                             |
| ---- | ------------------------------------------------ | ---------- | ------------------------------------------------- |
| 3    | RBAC and granular permissions                    | —          | done — [permissions.md](./permissions.md)         |
| 4    | Master account domain and authorisation          | 3          | done — [master-accounts.md](./master-accounts.md) |
| 5    | Realtime account and P&L UI completion           | —          | done — [realtime-pnl.md](./realtime-pnl.md)       |
| 6    | Chart SL/TP interaction                          | 5          | done — [chart-trading.md](./chart-trading.md)     |
| 7    | One-click and keyboard trading                   | 6          |                                                   |
| 8    | Reconciliation engine                            | —          |                                                   |
| 9    | Integrity engine                                 | 3          |                                                   |
| 10   | Operations dashboard                             | 3, 8, 9    |                                                   |
| 11   | Security hardening                               | 3, 4       |                                                   |
| 12   | Load and soak                                    | all        |                                                   |
| 13   | Backup and restore rehearsal                     | —          |                                                   |
| 14   | Final browser, integration and concurrency audit | all        |                                                   |

`pnpm verify` must pass at the end of every step, and `pnpm smoke`,
`pnpm smoke:ws` and `pnpm load` where the step touches what they cover. No step
is committed knowingly broken.
