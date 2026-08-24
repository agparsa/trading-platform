# Testing

This is a financial system. Tests are not a quality gate bolted on afterwards;
the formulas were written against them.

```
pnpm test              # 294 tests (97 of them integration, opt-in)
pnpm db:test:prepare   # create + migrate the integration test database
pnpm test:coverage     # thresholds enforced
pnpm verify            # lint → typecheck → test → build
pnpm check:schema      # no floating-point columns exist
pnpm smoke             # boots the built API and drives a full trade round trip
```

Integration tests run against a real PostgreSQL database named by
`TEST_DATABASE_URL`, and skip themselves when it is unset — so a clean checkout
gets a green `pnpm verify` with no extra setup, and `pnpm test` still works
offline. Enable them with `pnpm db:test:prepare`, which creates and migrates a
separate database and prints the line to uncomment in `.env`. They use a real database on purpose: row locks, unique
constraints and transaction boundaries are exactly what they check, and a mocked
`FOR UPDATE` proves nothing.

## What is covered today

| Area                   | Tests | Highlights                                                                               |
| ---------------------- | ----- | ---------------------------------------------------------------------------------------- |
| Decimal & rounding     | 13    | `0.1 + 0.2` exactness, grid quantization, non-integer JS numbers rejected                |
| Money                  | 9     | Currency mixing refused, JPY minor units, 100 × 0.01 = 1.00 exactly                      |
| Instruments            | 11    | Spec validation, tick/lot normalisation, reference exposure figure                       |
| P&L                    | 22    | Executable-side selection, **eight reference-terminal vectors**, FX conversion           |
| Margin                 | 7     | Instrument rate as a floor, reference margin figure, sizing to free margin               |
| Account state          | 8     | Reference snapshot, `marginLevel` vs `marginUtilization`, null-not-infinite              |
| Order state machine    | 8     | Terminal dead ends, fill-wins-cancel race, modify rollback                               |
| Position state machine | 4     | `CLOSING` guard, double-close refused                                                    |
| Protective orders      | 20    | Wrong-side rejection, bid/ask trigger sides, ambiguous tick resolution, trailing ratchet |
| Risk engine            | 12    | Unset limit = no limit, exact-margin allowed, all violations reported                    |
| Market core            | 34    | Seed determinism, candle bucketing, staleness, script replay                             |
| API client             | 8     | Envelope unwrap, error codes, idempotency header, token refresh                          |
| API config & errors    | 15    | Boot refused on weak secrets, every error code has a status                              |
| Worker                 | 6     | Queue names unique, failed jobs retained                                                 |

## Reference vectors

The P&L, margin and account tests assert against numbers captured from a live
broker terminal rather than from our own expectations. Eight independent figures
reproduce exactly — see [pnl.md](./pnl.md). Anchoring the arithmetic to observed
production behaviour is what makes a bug in a formula fail a test instead of
becoming the definition of correct.

The one place the reference terminal and this platform deliberately differ is the
"Margin Level" label, which the terminal computes as utilisation. Both are
implemented under unambiguous names.

## Deterministic market script

Tests never use `Math.random()` or the wall clock. `ScriptedMarketDataProvider`
plays an exact tick list:

```
XAUUSD  bid 4500.00  ask 4500.20
        bid 4501.00  ask 4501.20
        bid 4502.00  ask 4502.20
```

The same sequence must produce the same fills and the same P&L, on any machine,
forever. `ManualClock` and `SeededRandom` cover the other two sources of
nondeterminism.

## Planned

| Phase | Adds                                                                                   |
| ----- | -------------------------------------------------------------------------------------- |
| 4     | Integration: order → execution → position → close → ledger, against a real database    |
| 6     | SL/TP trigger integration; tick-spans-both-levels resolution                           |
| 7     | Realtime: tick → P&L → WebSocket frame; reconnect and re-snapshot                      |
| 4–6   | Concurrency: double close, close racing SL, modify racing close, duplicate submissions |
| 12    | Load: concurrent sockets, high tick rate, high order rate                              |

## Coverage

Thresholds start at 70% across the domain packages and ratchet up as phases land.
Coverage is measured on `packages/*/src` — the code where a wrong answer costs
money — not on wiring.
