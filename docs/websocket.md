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

## Candles

`candle.update` carries the bar the feed is currently building, plus the final
state of a bar when its bucket closes. A closing bucket therefore produces two
frames — the bar that ended, then the bar that opened. Sending only the new one
would leave a chart's last completed candle showing a mid-bucket close forever.

```jsonc
{
  "event": "candle.update",
  "data": {
    "symbol": "XAUUSD",
    "resolution": "1",
    "time": 1787307840000,
    "open": "4583.10",
    "high": "4584.02",
    "low": "4582.88",
    "close": "4583.58",
    "volume": "42",
    "closed": false,
  },
  "seq": 4413,
}
```

A candle subscription names what it wants:

```jsonc
{ "channel": "candles", "symbols": ["XAUUSD"], "resolutions": ["1"] }
```

Three details, each deliberate:

- **Candles carry their own symbol filter**, separate from `quotes`. A terminal
  streams every quote for its watchlist while charting one instrument; sharing
  one filter would silently narrow the watchlist to whatever the chart happened
  to be showing. Verified by deleting the separation: the watchlist stopped
  updating for every symbol but the charted one.
- **Empty means _none_, not _everything_.** Six resolutions per symbol on every
  tick is a firehose nobody asked for, so a subscription that names no resolution
  gets `1` and nothing else.
- **Subscribing replaces the previous chart** rather than adding to it. Changing
  instrument four times must not leave four streams running.

The feed skips snapshotting in-progress bars entirely when no socket is
listening, so the cost is paid only when someone is looking.

## Frame shape

```jsonc
{
  "event": "position.updated",
  "eventId": "0f0f4f0e-…",
  "channel": "positions",
  "accountId": "a15faf89-…",
  "data": { "positionId": "…", "symbol": "XAUUSD", "floatingPnl": "182.42" },
  "seq": 4412,
  "timestamp": 1787307884014,
}
```

`eventId` identifies the **occurrence**, not the delivery. Two frames carrying
one id describe one thing that happened once, and a client may discard the
second. It is minted at publish time and travels to every socket that receives
the event — including sockets on other API instances — so it is stable across
the whole fan-out.

`accountId` is at the top level rather than inside `data` because a client with
several accounts open has to route a frame before it knows what shape the
payload is. It is `null` for public market data.

`channel` says which subscription produced the frame.

`seq` is a monotonic **per-connection** sequence number. A client that sees a
gap knows it missed a frame and must re-snapshot over REST rather than silently
drifting out of sync. Per connection rather than per channel deliberately: a
per-channel counter would let a client detect a gap in quotes while missing one
in positions, whereas one counter across the socket makes any loss visible. It
resets on reconnect, which is why the reconnect contract re-snapshots instead of
resuming.

All monetary values are decimal strings, as everywhere else.

## Account figures arrive together

The specification asks for `MarginUpdated` and `FreeMarginUpdated` as separate
streams. They are **one frame** here — `account.updated` — and that is a
deliberate strengthening rather than a shortcut.

Those figures are derived from each other: free margin _is_ equity minus used
margin. Split across frames, a client that has applied one and not yet the other
renders a set of numbers that never existed — an equity from 10:00:00.250 beside
a used margin from 10:00:00.750, and a free margin matching neither. One frame
carrying a consistent set is a stronger guarantee than four carrying the same
information, and it is a quarter of the traffic.

## `risk.updated` fires on transition only

An account crossing into or out of margin call or stop-out proximity produces
one frame. An account _sitting_ at 94% for an hour produces nothing further.

That is what makes it safe for a notification to be raised straight from this
event with no de-duplication of its own: the de-duplication is the semantics of
the event rather than a filter bolted on afterwards. The frame carries the
levels it judged against, so the decision can be checked rather than trusted.

## Two delivery faults this contract had

**Every domain event was delivered twice.** `EventsService` publishes to local
handlers _and_ to Redis; the gateway also subscribes to Redis; and Redis hands a
message back to the connection that published it, because the publisher and
subscriber are separate connections and Redis cannot know they are one process.
Counted on a live socket, one market order produced two `position.created`
frames carrying the same position id. Envelopes now carry the id of the process
that raised them and an instance refuses its own echo.

**Subscribing raced authentication.** Socket.IO fires the client's `connect`
event as soon as the transport is up — before the gateway has finished reading
the socket's accounts from the database. A terminal that subscribes on `connect`,
as every one does, was racing those two queries: win and the private channels
attached, lose and all of them were refused with "requires authentication" while
`whoami` reported the socket as authenticated, leaving the trader silently deaf
to their own positions and orders until they reconnected. `subscribe` now waits
for the socket's identity to be resolved. `pnpm smoke:ws` subscribes inside the
`connect` handler with no delay at all, because any wait there hides the bug.

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

## `order.rejected` is its own event

A resting order the engine refuses when it triggers — nearly always because the
account cannot carry it by the time the market gets there — used to arrive as
`order.updated`. That is how a client learns that _something_ about an order
changed and nothing whatever about what.

It is now `order.rejected`, carrying `orderId`, `symbol`, `reason` and `code`.
A trader whose breakout order was refused for margin has to be told that in those
words: an order that quietly stops existing is worse than one that fails loudly,
and "updated" is the quiet version.

## `order.filled` names the position it created

The fill frame carries `positionId` alongside `orderId`. `position.created`
names it too, and a subscriber that cares about one particular order should not
have to correlate two events by arrival time to learn what became of it.

The terminal uses exactly this: an order placed an hour ago fills, and the
submission recorded in the browser advances from _accepted_ to _filled_ against
the order id, because nothing on the frame carries the idempotency key the
submission was sent under and nothing should. See `lib/order-commands.ts`.
