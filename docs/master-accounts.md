# Master accounts

A master account is a person acting on trading accounts that are not their own —
a desk operator, a managed-account manager, a support engineer with a mandate.

The whole design follows from one sentence in the specification: **no master
account may reach another account merely by knowing its id.** Account ids
travel. They appear in screenshots, support tickets, shared URLs, log lines. A
system whose answer depends on whether one leaked has no answer at all.

## What a master account is not

It is not a role, and it is not a container of accounts.

Creating a master account grants nothing. Operating one grants nothing. It holds
no balance, no positions, no permissions. A master account with no links can see
exactly as much as a stranger can, which is nothing.

Access comes only from a **link**: this master, that account, these
capabilities, granted by this person, at this time. A master with a hundred
links reaches exactly a hundred accounts.

## The two tables

```
master_accounts        id, user_id (the operator), name, status
master_account_links   master_account_id, account_id, capabilities[],
                       status, granted_by_user_id, granted_at,
                       revoked_by_user_id, revoked_at
```

`capabilities` holds the permission catalogue's own `resource.verb` strings — see
[permissions.md](./permissions.md) — rather than a role name. A delegation is a
specific grant to a specific person over a specific account; storing a role would
make every existing delegation move whenever the role did.

Revocation is a status and a timestamp, never a delete. "Who could have closed
that position last March" has to stay answerable after the answer has stopped
being true, and a deleted row answers nothing.

## What a link may carry

A ceiling, not a free-form list. A link may grant:

```
accounts.read     accounts.manage
orders.read       orders.create    orders.cancel    orders.modify
positions.read    positions.close  positions.modify
risk.read
```

Everything else is refused by name. A link is authority over _one account_, so
nothing that reaches past that account can be delegated through one — no kill
switch, no reconciliation runs, no audit access, no power to create further
delegations. Without the ceiling, granting a link would be a way to mint any
capability at all and call it account management.

`accounts.read_any` is excluded for the same reason: a capability meaning "see
every account" cannot be scoped to one.

The ceiling is applied twice — when a grant is written, and again when a link is
read. Validating on write refuses a bad request; filtering on read defends
against a row that arrived some other way: a manual fix, a restored backup, a
migration written before the ceiling existed.

A grant outside the ceiling is **refused, not narrowed**. Silently dropping a
capability would tell the caller the grant succeeded and leave an operator
believing they can act — which is how somebody discovers they cannot in the one
moment it matters.

## How access is decided

Every path to an account — REST, the trading services, the WebSocket account set
— goes through `AccountAccessService.resolve(userId, accountId, needs)`. It
answers in this order:

1. **Owner.** The account's `user_id` is the caller. Full owner capabilities.
2. **Link.** An `ACTIVE` link on this account, from an `ACTIVE` master account
   operated by the caller. The link's capabilities, filtered by the ceiling.
3. **Neither.** `RESOURCE_NOT_FOUND` — the same answer as for an account id that
   does not exist.

The master account's own status is part of the query rather than checked
afterwards, so suspending a master stops every link it holds at once. An
operator whose access is being withdrawn during an incident cannot be switched
off one account at a time.

Step 3 in the refusal is the constraint at the top of this page. A caller with a
real id and no link gets the response for a nonexistent account, because
distinguishing the two turns a list of candidate uuids into an account census.

Step 2 is what makes the `needs` argument load-bearing: a link granting
`positions.read` and not `positions.close` refuses the close — and refuses it
with `FORBIDDEN` naming the capability, because an operator holding a link can
already see the account and hiding it from them would be theatre.

## Two checks, neither replacing the other

A master link never widens what the caller's **role** allows.

- The route's `@RequirePermissions(...)` asks: may this kind of user ever do
  this?
- The resolver asks: may this user do it _to this account_?

Both must pass. A `SUPPORT` user operating a master account with a
`positions.close` link still cannot close a position, because `SUPPORT` does not
carry `positions.close` at all. The delegation says which accounts; the role
says which verbs. Neither is a way around the other.

## The socket

A socket's private-account set is the union of the accounts the user owns and
the accounts their active links point at, read from the database at connect and
never taken from anything the client sends.

It is a snapshot, as it always was for ownership: a link revoked mid-session
stops appearing on the next connection, not the next frame. The reconnect
contract in [websocket.md](./websocket.md) is what refreshes it.

## What is not built

**Organisation hierarchy.** The specification describes masters arranged in a
tree. Nothing here needs one yet, and an empty, untested model is worse than an
absent one — it looks like a feature. When there is a second thing to group,
`master_accounts` gains a parent and the resolver gains one more clause.

**Audit of the master's trading actions.** Grants and revocations are audited
today. The `linkId` on every grant exists so that a trade made through a
delegation can name the delegation that allowed it, but the trading services
still write their audit rows with the actor alone. Threading the grant into them
is the next step, and until it lands, "which link permitted this fill" is
answerable by reconstruction rather than by lookup.

## How this was verified

Each rule was broken deliberately and the named test confirmed to fail:

| Break                                         | Result        |
| --------------------------------------------- | ------------- |
| Link query stops checking _which_ master      | 2 of 12 fail  |
| Revoked links still count                     | 2 of 12 fail  |
| Ceiling not applied when a link is read       | 1 of 12 fails |
| Ceiling not applied when a link is granted    | 1 of 12 fails |
| Socket ignores which master a link belongs to | 1 of 12 fails |
| Socket ignores revocation                     | 1 of 12 fails |

The fifth is worth its own note. It passed at first. The test asserted that an
unlinked account was not streamed — but the only link in the database belonged
to the operator under test, so a gateway that forgot to ask _whose_ link it was
still produced the right set. The fix was to the test: put somebody else's
delegation in the same table, and the assertion starts meaning what it says. The
defect it would have hidden is every socket receiving every delegated account's
private frames.
