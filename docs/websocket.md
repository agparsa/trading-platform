# WebSocket API

Endpoint: `/ws` (Socket.IO). Clients authenticate before subscribing to any
private channel.

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
data is never broadcast to another's socket — subscriptions are authorised
server-side against the token, not trusted from the subscribe message.

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

API instances publish to Redis pub/sub; every instance relays to its own
connected sockets. Redis carries no financial truth here — it is a transport. A
Redis restart drops frames, clients re-snapshot, and no data is lost.

## Reconnect contract

1. Socket drops.
2. Client reconnects with backoff.
3. Client re-authenticates and re-subscribes.
4. Client **re-fetches a REST snapshot** of account, positions and orders.
5. Streaming resumes from the new `seq`.

Step 4 is not optional. Anything that happened during the gap was never
delivered, and the server does not replay it.
