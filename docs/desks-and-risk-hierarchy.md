# Desks and the risk hierarchy

Master accounts, what a delegation confers, and the four layers of ceilings
that sit above an account.

This is the Phase 4 layer. It builds on the master accounts that already
existed — a desk is not new here; what is new is that a delegation can be
granted by name, that a desk's book can be read, and that there is something
above an account that can tighten what it may do.

---

## 1. A desk confers nothing by itself

The rule everything else is subordinate to, and it has not changed:

> Creating a master account grants no access. Operating one grants no access.
> Only a **link** does, only to the account it names, and only for the
> capabilities it lists.

A master with a hundred links reaches exactly a hundred accounts. There is no
route anywhere that lets an operator reach an account by knowing its id, and
`AccountAccessService.resolve` is the single place that decides — for reads,
writes, orders and the socket alike.

---

## 2. Delegation presets

A link stores an explicit list of capabilities. Four presets expand into those
lists:

| Preset           | What it confers                                   |
| ---------------- | ------------------------------------------------- |
| `MASTER_VIEWER`  | reads the account; moves nothing                  |
| `MASTER_TRADER`  | opens, closes and modifies positions and orders   |
| `MASTER_MANAGER` | trades, and may change the account's own settings |
| `MASTER_OWNER`   | everything the linkable ceiling permits           |

### They expand once, at grant

A role is a live reference: change what `RISK_MANAGER` may do and every risk
manager's powers move with it. **A delegation must not work that way.** "Hossein
may trade this account" is a decision someone made about one person and one
account on one day, and widening `MASTER_TRADER` next quarter must not silently
widen every delegation ever made under that name.

So the preset is expanded at grant time into the capabilities stored on the
link, and the link is what is enforced. The name is kept beside it
(`grantedAsRole`) so a screen can say "Trader" and an audit row can record what
was asked for — but if the two ever disagree, the stored list wins, because it
is what the granter actually approved. The panel therefore shows both: what it
was granted as, and what it confers _now_.

### Owner and manager currently coincide

`LINKABLE_CAPABILITIES` is presently exactly the manager set, so the top two
presets expand to the same ten capabilities. They are not an alias for one
another: `MASTER_OWNER` is defined _as_ the ceiling and `MASTER_MANAGER` as an
explicit list, so the next capability added to the ceiling reaches an owner and
does not reach a manager. A test asserts the current sizes, and fails the day
they diverge — which is the day someone should check that the new capability
really belongs to an owner.

---

## 3. The desk book

`GET /master-accounts/:id/desk` is what the accounts a desk reaches add up to:
each account's balance, equity, margin and open positions; net exposure by
symbol across the desk; and the totals.

Three things about it are deliberate.

**It is a read and nothing more.** A desk is a view over accounts, not a
container of them. The money belongs to the account holders.

**It calls `AccountStateService.valuate` rather than recomputing.** That is the
single place equity is computed on this platform, so a desk total and an
account's own screen cannot disagree.

**It shows only what the desk may read.** A link granting `orders.create` is a
delegation to trade, not a licence to read the balance, so such an account does
not appear in the book.

### Currency

A desk can hold accounts in several currencies, and adding a euro balance to a
dollar one is meaningless. Every figure is converted into the desk's currency —
the operator's own, or the first delegated account's, or USD — and an account
that **cannot** be converted is named in `unpriced` and no total is printed at
all. A total that quietly dropped the account it could not price would read as a
smaller book than the desk actually runs, and that is the direction that gets
someone hurt.

---

## 4. The risk hierarchy

```
platform  →  broker  →  desk  →  account
```

Each layer may **tighten** what the layer above allows. **None may loosen it.**

| Layer    | Where it lives                         | Set by                   |
| -------- | -------------------------------------- | ------------------------ |
| platform | `RiskLimitSet` on the platform tenant  | the platform, only       |
| broker   | `RiskLimitSet` on the firm             | the firm's `risk.manage` |
| desk     | `RiskLimitSet` keyed by master account | the firm's `risk.manage` |
| account  | `AccountSettings`                      | the firm's `risk.manage` |

The four caps the hierarchy governs are `maxPositionVolume`,
`maxOpenPositions`, `maxGrossNotional` and `maxSymbolNetVolume`.

### Null is silence, not permission

A layer that leaves a field null has no opinion about it and passes the layer
above through untouched. It does not mean "unlimited". If every layer is silent
the limit is unset, and the rules read an unset limit as not enforced — the
platform's existing behaviour, unchanged.

### Enforced twice, on purpose

**When a limit is written**, a value looser than the layer above is refused, and
the refusal names the layer and what it allows. Refusing is the important half:
an administrator told their 100-lot ceiling was saved will believe their traders
can trade 100 lots, and will find out otherwise from a rejected order at the
worst possible moment.

**When a limit is read**, the resolver takes the tightest value across every
layer regardless. A row that reached the table some other way — a manual fix, a
restored backup, a migration written before the rule existed — still cannot
widen what an account may do.

The comparison is numeric, never lexical. `'9'` sorts after `'10'` as text, and
a ceiling compared as text is a ceiling that is sometimes exactly the wrong way
round.

### The desk layer binds the route, not the account

A desk ceiling binds an order **placed through that desk's delegation**. The
same account traded by its own owner is not subject to it.

That is the whole point of the layer: "my operators may not put on more than a
lot at a time" is a statement about the operators. The account holder never
agreed to it, and binding them by it would let a firm quietly narrow a client's
own trading by giving somebody a delegation.

`AccountAccessService` already knows which route a caller took, so it reports
the master account alongside the grant, and the order path passes it into the
risk context.

**A resting order carries its desk with it.** `Order.placedByMasterAccountId`
records which desk placed it, because a pending order fills later from the tick
loop with no caller and no route. Without it an operator under a two-position
desk cap could place five pending orders and have all five fill.

### What is deliberately not in the hierarchy

`marginCallLevelPercent` and `stopOutLevelPercent` stay account-only. They are
not caps — they are the levels at which the platform intervenes — and "stricter"
runs the other way for them: a _higher_ stop-out level is the safer one. Folding
them into a minimum would silently give every account the loosest stop-out on
the platform. They belong in the hierarchy eventually, with their own direction.
Saying so is better than getting it backwards.

### Only the platform sets the platform ceiling

`risk.manage` is authority over your own firm, not over everyone's. Setting the
platform layer additionally requires standing in the platform tenant, so a
broker holding `risk.manage` cannot set the ceiling every other firm trades
under.

---

## 5. Integrity the database enforces

- **One limit set per layer.** Two broker rows for one firm would mean the
  effective ceiling depended on which the resolver read first, and a limit that
  depends on row order is not a limit. Partial unique indexes, not application
  convention.
- **A desk set names a desk; a platform or broker set does not.** Without the
  check a row could claim to be a firm ceiling while pointing at one desk, and
  the resolver would apply it to every account in the firm.
- **Row-level security**, as on every tenant-scoped table. Reading the platform
  ceiling from inside a firm is a deliberate, narrow, out-of-scope read the
  application makes and documents; it is not something a stray query can do.
- `Order.placedByMasterAccountId` is **not** a foreign key. It is evidence about
  what happened and must survive the desk being deleted.

---

## 6. Routes

| Route                                           | Needs                    |
| ----------------------------------------------- | ------------------------ |
| `GET /master-accounts`                          | `master.read`            |
| `GET /master-accounts/:id/links`                | `master.read`            |
| `GET /master-accounts/:id/desk`                 | `master.read`            |
| `POST /master-accounts`                         | `master.manage`          |
| `POST /master-accounts/:id/links`               | `master.manage`          |
| `DELETE /master-accounts/:id/links/:accountId`  | `master.manage`          |
| `GET /admin/risk/limits`                        | `risk.read`              |
| `POST /admin/risk/limits/platform`              | `risk.manage` + platform |
| `POST /admin/risk/limits/broker`                | `risk.manage`            |
| `POST /admin/risk/limits/desk/:masterAccountId` | `risk.manage`            |

`master.manage` is person-only: an API key can never grant a delegation.

Screens: **Desks** in the admin console (the book, the delegations, the desk
ceiling) and a **Ceilings** tab on the Risk console (the platform and firm
layers).
