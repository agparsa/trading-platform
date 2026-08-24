# WebSocket API

Endpoint: `/ws` (Socket.IO). **Implemented in Phase 7.**

Authentication happens at _connect_, not at subscribe. A socket that cannot prove
who it is may still connect — public quotes are public — but it never acquires an
account, and every private channel is filtered by account membership. There is no
message a client can send that grants it access it did not arrive with.

## Why not polling

The browser never polls for trading state. `setInterval` is banned by an ESLint
rule for exactly this reason: a terminal that polls is both slower and heavier
than one that is pushed to, and the specification (§16) is explicit about it.

## Channels

| Channel     | Visibility | Carries                                              |
| ----------- | ---------- | ---------------------------------------------------- |
| `quotes`    | public     | `quote.update`                                       |
| `candles`   | public     | `candle.update`                                      |
| `orders`    | private    | `order.created` / `updated` / `filled` / `cancelled` |
| `positions` | private    | `position.created` / `updated` / `closed`            |
| `account`   | private    | `account.updated`                                    |
| `pnl`       | private    | `pnl.updated`                                        |

Private channels are scoped to the authenticated account. One user's account
data is never broadcast to another's socket — the account set is resolved from
the database at connect time and never taken from anything the client sends.

That guarantee is one `if` in `onDomainEvent`, so it is verified by removing it:
with the filter gone, a second trader's socket immediately received two
`position.created` frames belonging to the first. See docs/testing.md.

## Frame shape

```jsonc
{
  "event": "position.updated",
  "data": { "positionId": "…", "symbol": "XAUUSD", "floatingPnl": "182.42" },
  "seq": 4412,
  "timestamp": 1787307884014,
}
```

`seq` is a monotonic per-connection sequence number. A client that sees a gap
knows it missed a frame and must re-snapshot over REST rather than silently
drifting out of sync. Without it, a dropped frame produces a P&L on screen that
is quietly wrong and stays wrong.

All monetary values are decimal strings, as everywhere else.

## Fan-out

`EventsService` publishes twice, deliberately. Local handlers run immediately, so
a socket on this instance sees a fill without a Redis round trip; the same
envelope goes to Redis so sockets on _other_ instances see it too.

Redis carries no financial truth here — it is a transport. A publish failure is
logged and swallowed rather than propagated into the trade that produced it: a
committed fill must not be undone because a notification could not be sent. A
Redis restart drops frames, clients re-snapshot, and no data is lost.

Events are published **after** the database transaction commits, never inside it.
A subscriber must not be told about a fill that a rollback is about to erase.

Fan-out is an explicit per-socket filter rather than Socket.IO rooms. A room
would have to be trusted to contain the right sockets; the filter can be read in
one place and tested by deleting it.

## Account state and P&L

Quotes stream at the feed's tick rate. Account valuations do not: re-valuing an
account is a database read plus a P&L calculation per position, and a human
cannot read four updates a second anyway.

`RealtimeService` bounds that work twice over:

- Only accounts with a socket **actually listening** are valued. Cost scales with
  users online, not users registered.
- Each account is valued at most once per `REALTIME_VALUATION_INTERVAL_MS`
  (default 500ms).

This is throttling, not polling: nothing runs when the market is still, and the
trigger engine — which must see every tick — is untouched by it.

## Reconnect contract

1. Socket drops.
2. Client reconnects with backoff.
3. Client re-authenticates and re-subscribes.
4. Client **re-fetches a REST snapshot** of account, positions and orders.
5. Streaming resumes from the new `seq`.

Step 4 is not optional. Anything that happened during the gap was never
delivered, and the server does not replay it.
