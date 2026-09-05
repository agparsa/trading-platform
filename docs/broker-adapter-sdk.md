# The broker adapter SDK

`packages/broker-sdk`: the port a venue connector implements, the vocabulary
for what a venue can do, the state machine that decides whether it is up, a
mock venue that misbehaves on request, and the contract every connector must
pass. Framework-free — a connector can be written and proven without booting
the platform.

**There is no connector to a real venue in this repository.** See
[broker-integration.md](./broker-integration.md) for why, and for what adding
one takes.

## Capability discovery

A connector answers `getCapabilities()` once after connecting, and the
platform stores the answer on the connection. Every flag is a question that
would otherwise be answered by guessing — and a guess about a venue is how an
order gets sent somewhere that cannot take it:

| Group     | Flags                                                                                                         |
| --------- | ------------------------------------------------------------------------------------------------------------- |
| Orders    | `supportsMarketOrders`, `supportsLimitOrders`, `supportsStopOrders`, `supportsStopLimitOrders`, `timeInForce` |
| Positions | `supportsPartialClose`, `supportsModifyProtection`, `supportsHedging`                                         |
| Data      | `supportsStreamingQuotes`, `supportsHistoricalCandles`, `supportsAccountSync`                                 |
| Events    | `supportsOrderEvents`, `supportsWebhooks`                                                                     |
| Auth      | `supportsApiToken`                                                                                            |

`false` is the safe default for every one: a connector that has not looked
says it cannot. An order type the venue does not support is refused before it
leaves, with `UNSUPPORTED`, rather than sent and rejected there with something
opaque.

## The outcome that matters: UNKNOWN

`placeOrder` answers `FILLED`, `PARTIALLY_FILLED`, `ACCEPTED`, `REJECTED` or
**`UNKNOWN`** — and UNKNOWN is not an error. It means the request left and no
answer came back within the budget. The venue may have filled it.

So the platform **never resends on the strength of a timeout**. It records the
UNKNOWN and asks `queryOrder(clientOrderId)`, which answers what the venue
holds, or `null` if the venue never saw it — the one state in which a resend
is safe. `clientOrderId` is the platform's own id and is the whole of the
idempotency story: a good venue refuses a duplicate on it, and one that does
not is queried by it first.

This is §41 and §26 in one method signature: a timeout is a timeout, never a
fill and never a breach.

## The connection state machine

`ConnectionMonitor` is told what happened and decides what the state is. No
I/O in it, so the judgement is testable to the millisecond.

```
UNKNOWN ──health──▶ CONNECTED ⇄ DEGRADED
   │                    │
   │                    ├─fail×N──▶ DISCONNECTED   (breaker: 5s, 10s, 20s, … capped)
   │                    ├─auth────▶ AUTH_FAILED    (breaker: the cap, at once)
   │                    └─429─────▶ RATE_LIMITED   (breaker: the venue's retry-after)
```

- **DEGRADED is connected but late** — the heartbeat or the last quote is older
  than the connection expects. Orders still go, with the state shown: a quiet
  venue at 03:00 on Sunday is not an outage.
- **AUTH_FAILED opens the breaker at once and for the cap.** Retrying the same
  rejected credentials cannot help and can lock the account at the venue.
- **RATE_LIMITED honours the venue's own `retryAfterMs`** when it gave one.
- A success clears the failure count and the backoff; the backoff doubles per
  opening, not per failure.
- `mayAttempt` gates health checks; `mayTrade` gates orders and additionally
  requires CONNECTED or DEGRADED.

`ConnectionMonitor.restore` rebuilds it from the row after a restart, as
UNKNOWN — nothing has been heard by _this_ process — while keeping the breaker,
so a restart is not a way to skip a backoff.

## The mock venue

`MockBrokerAdapter` keeps real state: positions opened through it can be
closed, modified, listed and reconciled, every change emits an event with a
stable id and a sequence number, and prices can be moved to push quotes. What
makes it useful is that it misbehaves **on request** — `script(...)` queues
what the next orders do:

`fill` · `partial` · `accept` · `reject` · `timeout-filled` (UNKNOWN, and the
venue did fill it) · `timeout-lost` (UNKNOWN, and it did not) · `disconnect` ·
`rate-limit` · `auth-failed` · `venue-error`

plus `redeliver()` for a duplicate event, `emitOutOfOrder()` for a queue that
caught up backwards, and `dropConnection()`. That is the failure catalogue of
§41 and §67 as fixtures rather than as prose, and it is what the platform's
handling of each is tested against.

## The contract

`brokerAdapterContract(harness, { it, expect })` is called from a connector's
own test file. It takes the test primitives as arguments so the SDK depends on
no test runner. It checks the promises the platform relies on, not the venue's
business rules:

- bad credentials raise `AUTH_FAILED` and show in the health check;
- calls before `connect` raise `NOT_CONNECTED`;
- **no credential value appears in any error message or stack**;
- capabilities are declared, and an unsupported order type is refused before
  it is sent;
- money and prices are strings, never floats;
- the same `clientOrderId` twice opens one position, not two;
- `queryOrder` answers `null` for an id the venue never saw, and finds an
  UNKNOWN that did land;
- pushed events carry stable, unique ids.

A connector that fails one of these is one the platform cannot run safely,
however well it trades.

## Credentials

`serialiseCredentials` / `deserialiseCredentials` are what gets sealed;
`fingerprintCredentials` is SHA-256 over the kind and the sorted fields,
truncated to sixteen hex characters — enough to say "the same one as
yesterday", nothing to use. `credentialMetadata` splits the fields the
connector declared secret from the ones it did not, and only the second half
is ever shown. `redactCredentialValues` is the belt to that braces: it strips
any credential value out of a message before it can be logged or stored, which
is what catches the connector that included one anyway.

## The registry

`BrokerAdapterRegistry` maps a kind to a factory. Registering a connector for
a real venue **requires naming the documentation it was written against**; the
registry throws without one. That is not bureaucracy: a connector nobody can
trace to a published API is a connector nobody can review, and this repository
has one rule about venues it cannot read the documentation for.
