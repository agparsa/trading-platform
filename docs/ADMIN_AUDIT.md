# Admin Audit

**Audited:** commit `76fd42a`. The admin console at `/admin`, its seven panels,
and the API surface behind them.

---

## 1. What exists

One route, `/admin`, gated on permission, with seven panels:

| Panel          | Lines | What it does                                                    |
| -------------- | ----- | --------------------------------------------------------------- |
| Overview       | 107   | Platform totals, trading state, kill switch                     |
| People         | 234   | Search users, view detail, suspend, reinstate, sign out, unlock |
| Accounts       | 271   | Search accounts, status, limits, ledger adjustments             |
| Risk           | 327   | At-risk accounts, exposure, risk events                         |
| Reconciliation | 310   | Runs, findings, decisions                                       |
| Instruments    | 293   | Enable/disable, commercial terms                                |
| Audit          | 142   | Filterable audit log with an action index                       |

Behind them, 18 admin routes plus operations, integrity, reconciliation and
master-account controllers — all listed in `API_INVENTORY.md`.

**Every panel is real.** Each is wired UI → API → service → database →
permission → audit. None displays placeholder data. That matters because the
specification is explicit that UI-only implementation must not be marked
complete, and this console does not have that problem.

## 2. Authorization inside the console

Permission-per-action, not role-per-page. `/admin/users` needs
`users.read_any`; suspending needs `users.manage`; adjusting a balance needs
`accounts.adjust`; changing limits needs `risk.manage`. A `SUPPORT` user opening
the console sees the panels they can use and gets a refusal from the server for
anything else — the hidden button is a courtesy, the guard is the control.

**Separation of duties is enforced, including against the administrator.**
`ADMIN` can adjust a balance and cannot trade — see `SECURITY_AUDIT.md` §2.
Where an administrator genuinely needs to act on an account, a master-account
link grants it per account and leaves a record.

## 3. Audit coverage

Every mutating admin action writes an `AuditLog` row with actor, action,
resource, **before and after** state, request id, IP and user agent. The
instrument-terms endpoint is the model: it audits the full before and after, and
refuses a change whose stated reason is shorter than eight characters — because
an audit trail of "fix" is an audit trail of nothing.

**Gap:** the log is immutable in the application and mutable in the database.
`DATABASE_AUDIT.md` §8 and `SECURITY_AUDIT.md` F-2. One migration.

## 4. Findings

### A-1 — The console is one page with tab state · **Medium**

Seven panels share a single route. Consequences that already bite: no
deep-linking to a user or an account, no browser history, no bookmark, and no
way to send a colleague a URL that opens the thing being discussed. For an
operator working an incident, "open the console, click People, search this
email" is worse than a link.

**Fix:** nested routes — `/admin/people/:id`, `/admin/accounts/:id` — using
Next.js route groups. The panels stay; only their mounting changes.

### A-2 — No bulk operations · **Low**

Every action is one entity at a time. Suspending forty accounts after an
incident means forty clicks. Not urgent; will be, at scale.

### A-3 — No admin surface for anything the specification adds · **Expected**

No KYC review queue, no payment or withdrawal review, no API-key management, no
webhook configuration, no tenant administration, no push-notification tooling,
no Security Center. Each is a new panel and, more importantly, a new set of
routes and services beneath it. None can be built before the feature it
administers.

### A-4 — No admin-facing reporting or export · **Medium**

Data is viewable, not exportable. Finance and compliance functions eventually
need CSV, scheduled reports, and a defensible way to produce a statement for a
regulator. Nothing here does that today.

### A-5 — Roles cannot be edited · **Low today, High under tenancy**

Roles and their permissions are TypeScript constants. Changing them is a
deployment. Once tenants define their own roles, the console needs a role editor
and the permission table needs to become data. `SECURITY_AUDIT.md` F-5.

### A-6 — No impersonation, and that is a decision to make deliberately · **Informational**

Support cannot see what a user sees. That is safe, and it makes some support
questions very hard to answer. If impersonation is ever added it must be
read-only, time-boxed, consented to or at minimum loudly audited, and it must
never carry trading permissions — otherwise it becomes the hole in the
separation of duties that §2 spends its effort maintaining.

## 5. What must not be lost

The console's design has two properties worth protecting through everything that
follows:

**Permission-per-action rather than role-per-page.** It is why a new role does
not require re-auditing every screen.

**Before-and-after auditing with a mandatory reason.** It is why an admin action
can be reconstructed rather than merely noticed.

Both will be under pressure when the console grows from seven panels to twenty.
Neither should be traded for speed of building the new ones.
