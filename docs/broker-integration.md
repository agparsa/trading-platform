# Connecting a venue

## The state of it

**No venue is connected, and none can be until somebody supplies a venue's API
documentation and sandbox credentials.** That is a blocker, stated rather than
filled.

What exists is everything on this side of that line: the port
([broker-adapter-sdk.md](./broker-adapter-sdk.md)), the capability vocabulary,
the connection state machine with its breaker, a mock venue that produces every
failure in the catalogue, the contract suite, the sealed credential store, the
admin surface at `/admin/connections`, and the worker sweep that keeps every
connection's state honest. A connector is the last piece, and it is the one
piece that cannot be written from imagination.

The specification is explicit about this and so is this repository: **do not
invent an undocumented broker API.** A connector written from a plausible guess
at "what an FX bridge usually looks like" would pass its own tests, look
finished on this screen, and fail the first time real money went through it.

## What adding one takes

1. **The venue's documentation and a sandbox.** REST and WebSocket endpoints,
   the authentication scheme, symbol naming, volume and price precision, the
   order and position models, the event stream, the error codes, and the rate
   limits.
2. **A class implementing `BrokerAdapter`** in its own package or under
   `packages/broker-sdk/src/connectors/`, obeying the four rules in the port's
   documentation: throw only `BrokerAdapterError`; never log a credential;
   answer `UNKNOWN` rather than throwing when an order's fate is unknown; keep
   money as strings.
3. **`brokerAdapterContract` green against the sandbox**, plus whatever the
   venue's own quirks deserve.
4. **Registration** with `documentation` naming what it was written against —
   the registry refuses a connector without it — and the credential fields the
   panel should ask for, with `secret: true` on the ones that are.
5. **A capability review.** Every flag the connector returns is a promise the
   platform will act on. `false` is always safe; a wrong `true` is an order
   sent somewhere it cannot go.

Nothing else in the platform changes. Execution mode, external id mapping and
the order path are phase 3.

## How a connection lives

A **connection** is a row: a name, a connector kind, non-secret settings, and
whether it is enabled. Its **credentials** are a second row, sealed with
`SecretBox` bound to the connection's id, so a sealed blob cannot be moved to
another connection and opened there.

```
create ──▶ set credentials ──▶ test ──▶ the worker sweeps it every minute
             (sealed, once)     (now)     (breaker decides whether to try)
```

Rotation is a **new row with the old one revoked**, never an edit: the database
refuses to change a sealed row and refuses to delete one, so who used what,
and when, survives. The panel shows the fingerprint, the non-secret fields, and
when the credential was last used — and there is no route, no audit payload and
no log line that carries a value. The only place a credential is opened is
`BrokerConnectionsService.withAdapter`, and anything thrown out of it has the
values stripped from its message first.

## Health

`BrokerHealthService.sweep` runs in the worker every minute
(`BROKER_HEALTH_CRON`). It discovers connections across every tenant
deliberately, then handles each **inside its own tenant's scope**, so every read
and write it does is scoped exactly as a request would be. It:

- skips a connection whose breaker is open, rather than retrying it;
- records the monitor's verdict, the capabilities, the latency and the last
  error on the row;
- reports a missing credential, a credential its keys cannot open, and a
  connector this build does not have, each as a state on that connection rather
  than as a crash;
- **says nothing about any trader.** A venue being unreachable is a fact about
  the venue. Nothing here fails an account, and §26 is the reason.

`POST /admin/broker-connections/:id/test` is the same verdict on demand, for
the person who has just set the credentials and wants to know now. It refuses
while the breaker is open.

## Permissions

`broker_connections.read` — the list, the states, the credential metadata — is
held by the desk (operator, risk), administration, the owner, the analyst, the
developer, and the platform's operators, support and auditors.
`broker_connections.manage` — create, set credentials, enable, disable, test —
is administration, the owner and the platform's super administrator, and it is
**person-only**: a leaked API key that could repoint a firm's execution at a
venue of its holder's choosing is the worst thing on the capability list.

## Verified by breaking it

Twelve integration tests drive the service against a real database and the mock
venue; ten drive the worker sweep. Six mutations were made and watched: the
redaction removed from `withAdapter` (caught), rotation not revoking (caught),
the sweep ignoring the breaker (caught), the credential include not naming its
tenant (caught — see below), the field allowlist removed (caught), and the
sweep dropping its per-tenant scope (survived at first, which is how the
include was found). Thirty-five unit tests cover the monitor, the mock and the
credential envelope, including the contract suite the mock must pass.

### What the sweep's own test found

A nested Prisma `include` is **not** narrowed by the tenancy extension: the
extension rewrites the top-level query, and a relation is then filtered by its
foreign key alone. A credential row misfiled under another firm was therefore
visible through `connection.credentials`. Both services now name
`tenantId: requireTenantId()` in the include, and
[multi-tenancy.md](./multi-tenancy.md) §6 records the rule.
