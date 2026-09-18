# Feature flags

§95. What a deployment, or a firm, has switched on — and who gets to say.

## Two kinds of authority

| Authority  | Set by                            | Examples                                  |
| ---------- | --------------------------------- | ----------------------------------------- |
| `PLATFORM` | the platform operator, per broker | external execution, webhooks, white label |
| `FIRM`     | the firm's owner, for itself      | trailing stops, one-click, mobile trading |

A firm cannot flip a platform flag — external execution is the platform's to
grant, not the firm's to take — and the platform does not manage a firm's
product choices for it. The catalogue (`packages/shared-types/src/features.ts`)
says which is which, and `FeaturesService.set` refuses a mismatch whatever route
the request came in by. The authority is copied onto the row so it says who was
allowed to write it, even if the catalogue later moves.

The platform sets a broker's flags by **entering the broker's scope** — never by
reaching across from its own. The row is written as the broker's, under the
broker's isolation policy.

## Two kinds of enforcement

| Enforcement | Meaning                                                                            |
| ----------- | ---------------------------------------------------------------------------------- |
| `SERVER`    | the API refuses the action with `FEATURE_DISABLED` (403), whatever the client says |
| `CLIENT`    | a product choice the apps honour; the server has no action to guard                |

Stated on every flag, and shown on the admin screen, so nobody reads
"mobile trading: off" as a security guarantee. It is not one: the same person
can trade from the web.

## The flags

| Key                  | Authority | Enforced | Default | Where                                                                                                                   |
| -------------------- | --------- | -------- | ------- | ----------------------------------------------------------------------------------------------------------------------- |
| `external_execution` | PLATFORM  | server   | off     | `OrdersService`: an order on a venue-routed account is refused — never quietly filled internally                        |
| `webhooks`           | PLATFORM  | server   | on      | `WebhooksService.create`                                                                                                |
| `trailing_stop`      | FIRM      | server   | on      | `PositionsService.modify`: setting or changing a trail; clearing one is always allowed, existing trails keep ratcheting |
| `quick_trading`      | FIRM      | client   | on      | the terminal disarms one-click and says why; the trader's own setting is kept for when it returns                       |
| `mobile_trading`     | FIRM      | client   | on      | `useMobileTrading` in the app: the ticket refuses to open and says why. **Closing and modifying are never gated**       |
| `new_chart`          | PLATFORM  | client   | off     | the terminal's chart choice — meaningless until the licence exists                                                      |
| `white_label`        | PLATFORM  | client   | off     | branding, when it is built; the flag exists so nothing has to be redesigned to gate it                                  |

### One of these was a switch that moved and did nothing

The `Where` column above is a claim, and for `mobile_trading` it said "the
mobile app" and was false: **nothing in `apps/mobile` fetched `GET /features` at
all.** An operator could switch mobile trading off, watch the switch move in the
panel, and change nothing. It is honoured now, and `scripts/feature-flags.test.ts`
checks this table against the definitions row by row, and checks that every flag
claiming to be honoured is acted on by the side responsible for honouring it —
`apps/api` or `apps/worker` for SERVER, `apps/web` or `apps/mobile` for CLIENT.

`new_chart` and `white_label` are acted on by nothing too, and that is correct:
neither feature is built. They carry `honoured: false` in `features.ts` now, as
structure rather than as prose a reader has to infer, and the same test requires
their descriptions — which the admin screen renders — to say so.

**Two decisions inside the mobile one, both stated because either could be got
wrong quietly:**

- **Closing is never gated.** The same reasoning that lets a trader clear a
  trailing stop the firm will not let them set: switching a product off may
  remove a way in, it may not remove the way out. A firm must not be able to
  leave somebody holding a position they cannot exit from the device in their
  hand.
- **Unknown means allowed.** A flag that has not loaded, or a request that
  failed, reads as *on* — matching the terminal's `!== false` for
  `quick_trading`. Failing closed would stop a trader placing an order because
  their phone briefly lost signal, in order to enforce a preference the server
  refuses nothing for. That is only safe because this is not a control, which is
  what the paragraph above this table already says.

## Reading on the order path

`isEnabled` is asked inside order handling, so each firm's overrides are cached
for five seconds. A write invalidates this instance at once; other instances
catch up within the window. A flag is a switch a person throws, not a value that
races — five seconds of one instance disagreeing is not a correctness problem.

## Routes

| Route                                   | Who                                                                          |
| --------------------------------------- | ---------------------------------------------------------------------------- |
| `GET /features`                         | any signed-in principal, keys included: the effective flags a client honours |
| `GET /admin/features`                   | `system.operations` — an operator answering "why was that refused"           |
| `POST /admin/features/:key`             | `tenant.settings.manage` — the firm's own flags; a platform flag is refused  |
| `GET /admin/brokers/:id/features`       | `tenants.read`, from the platform tenant                                     |
| `POST /admin/brokers/:id/features/:key` | `tenants.manage`, from the platform tenant                                   |

Every write needs a note — "why, for the person reading this in a year" — and is
audited (`FEATURE_ENABLED` / `FEATURE_DISABLED`) with the authority named.

## Not here

- **Per-user or percentage rollouts.** A trading platform's flags are decisions
  about a firm, made by a person, with a reason. A flag that is on for 30% of
  traders is a flag nobody can explain to the 30%.
- **Flags for things that do not exist.** `new_chart` and `white_label` are the
  exception, and only because §95 names them and the day they exist nothing
  should need redesigning to gate them. They are marked client-enforced and say
  so in their descriptions.
