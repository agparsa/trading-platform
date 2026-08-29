# The soak

`pnpm load` asks what happens when the platform is busier than it is comfortable
with. `pnpm soak` asks a different question, and a burst cannot answer it: **does
anything drift, leak or degrade while the platform is merely running?**

Those are the faults that never appear in a test suite and never appear in a
benchmark. A listener added per subscription and removed on no path. A pool that
grows a connection each time a query throws. A Map keyed by account id that
nothing deletes from. A sequence counter that skips once an hour. Each is
invisible for the first minute and fatal on the third day, and the only way to
see one is to leave the thing running and watch a number.

```
pnpm soak                       # 10 minutes, 4 traders, 20 orders/minute each
SOAK_MINUTES=120 pnpm soak      # the version that proves something
```

## What it holds steady

A **modest** rate, deliberately well under capacity — a saturated system tells you
about saturation and nothing else. Four traders, twenty orders a minute each,
each position opened and closed again so the run does not simply accumulate
exposure until the margin engine starts refusing (which would measure the margin
engine). Four sockets held open for the whole run.

The script refuses to start if the configured rate exceeds the platform's own
per-route order limit. Every trader comes from one address and shares the bucket,
so a rate above it means the soak spends its time measuring the rate limiter —
something `pnpm smoke` already proves. It is checked up front, because a soak
that reports this after ten minutes has wasted ten minutes.

## Tokens rotate, because a real client's do

An access token lasts fifteen minutes. The first run longer than that failed with
`TOKEN_EXPIRED` — the platform behaving exactly as designed, and the harness
behaving like nothing real, because no client left open all day holds one token.

The traders now rotate every ten minutes, comfortably inside the TTL. That was
worth more than a fix: a long run now exercises the refresh path continuously,
and reuse of a rotated token revokes the whole family, so a bug in that machinery
ends the run rather than hiding in it.

This is the sort of thing only a soak finds. A burst finishes in seconds; nothing
in it is old enough to expire.

## What it samples, every thirty seconds

Resident memory, V8 heap in use, event-loop lag p99, Node handles and active
resources, PostgreSQL backends, order round-trip p50 and p99 **per window rather
than pooled** — a pooled percentile hides exactly the degradation this is looking
for — and WebSocket sequence continuity, which is watched continuously rather than
sampled.

Every sample is printed. The verdict is a summary of numbers a person can
disagree with, not a substitute for them.

## Why memory is a slope and not a before-and-after

The first version compared the mean of the first third with the mean of the last
third and failed on a 50% rise. A deliberately injected leak of half a megabyte
per request walked resident memory from 230MB to 263MB in three minutes, and that
test called it fine — because **a leak does not double anything in three minutes,
it climbs**, and the point of a soak is to see the climb early enough to matter.

So the test is a least-squares slope over every sample, reported in MB/hour, which
is the number a person actually wants: "this would be 4GB by Friday".

That alone was still wrong. A three-minute _clean_ run trends at roughly
+200MB/hour — not because anything leaks, but because V8 grows its heap and
collects it in a sawtooth, and a line drawn through three teeth has a
confident-looking gradient and means nothing.

The discriminator is the **fit** (R²). A leak is very nearly a straight line,
because something is being retained at a steady rate. Sawtooth noise fits a line
badly, whatever its apparent gradient. Measured on this platform:

| Run                                  | Trend        | Fit      |
| ------------------------------------ | ------------ | -------- |
| Clean, 3 minutes                     | +93MB/hour   | **0.06** |
| Half a megabyte retained per request | +1451MB/hour | **0.97** |

A failure needs both a slope that matters and a fit that holds.

## The correctness question underneath

The run ends by summing `balance_ledger` per account and comparing it with the
stored balance. After thousands of orders, does every balance still equal the sum
of its own ledger?

That is the invariant the whole platform rests on, and a soak is the only place it
gets asked after sustained concurrent writing rather than after a handful of
fixture rows.

## The soak was tested by breaking three things

A harness that has never been seen to fail is a harness nobody has checked.

| Fault injected                                          | Caught                                                       |
| ------------------------------------------------------- | ------------------------------------------------------------ |
| A balance nudged by 13.37 with no matching ledger entry | `TP-100425: balance 100013.37 but its ledger sums to 100000` |
| The gateway skipping a sequence number 0.2% of the time | `3 sequence gap(s): quote.update jumped 153 → 155 …`         |
| Half a megabyte retained per request                    | `climbing at 1451MB/hour on a fit of 0.97`                   |

The leak injection also found a fault in the harness itself: at sixty orders a
minute per trader the run tripped the platform's order limit, and 480 of its own
requests were refused. That is the check described above, and it exists because
of that run.

## What this is not

Ten minutes on a two-CPU container is **not a production soak**. It is the
shortest run that can show a leak with a steep enough slope, and it will miss
anything slower. `SOAK_MINUTES=120` on real hardware is the run that proves
something; this is the run that fits in CI without holding it up.

It is also not a capacity measurement. Numbers for that are in
[testing.md](./testing.md), from `pnpm load`.
