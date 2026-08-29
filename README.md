# Trading Platform

A standalone, production-oriented trading platform: its own order engine,
position engine, P&L engine, risk engine, market-data layer, API and terminal.
No architectural dependency on TradingLocker, MetaTrader, or any other trading
platform.

**Status: Phases 0–7 complete.** The trading engine works end to end: a
trader can register, be funded, open a position against a live price feed, watch
it marked to market, and close it — or have the platform close it, when a
stop-loss, take-profit, trailing stop or stop-out fires. Every outcome lands in
an immutable ledger. The terminal UI is not built yet, and this repository does
not pretend otherwise — see [Build status](#build-status).

---

## What exists today

|                   |                                                                                |
| ----------------- | ------------------------------------------------------------------------------ |
| Tests             | **174**, all passing                                                           |
| Database          | 21 tables, **57 NUMERIC columns, 0 floating-point columns** (CI-enforced)      |
| Verified          | `lint → typecheck → test → build` green; API boots and passes smoke checks     |
| Reference vectors | 8 P&L / margin / equity figures reproduced exactly from a live broker terminal |

Working, with tests:

- **Money and precision** — `Money`, configured `Decimal`, explicit rounding and
  tick/lot quantization. `toDecimal()` refuses inexact JS numbers outright.
- **P&L** — executable-side selection, gross/net, commission, swap, FX conversion,
  break-even. Checked against eight figures captured from a live terminal.
- **Margin and account state** — effective margin rate, required margin, equity,
  free margin, margin level, margin utilisation, margin call, stop-out.
- **State machines** — order and position lifecycles as data, with illegal
  transitions rejected at the attempt.
- **Protective orders** — SL/TP validation and triggering on the correct side of
  the book, trailing stops, and a defined resolution for a tick that spans both levels.
- **Risk engine** — pure rule contract, six default rules, all violations reported at once.
- **Market data** — provider port, seeded deterministic simulator, scripted
  provider for tests, candle aggregation and persistence, quote-freshness policy,
  per-instrument session calendar evaluated in its own timezone.
- **Authentication** — Argon2id, separate access/refresh secrets, refresh-token
  families with reuse detection, per-account lockout, email verification and
  password reset over an injected email port, global auth guard, RBAC.
- **Accounts and ledger** — append-only balance ledger that is the only writer of
  balances, row-locked against lost updates, idempotent, reversed by compensating
  entries, and replayable for reconciliation.
- **Trading** — market orders, executions retaining the exact quote they filled
  against, positions, full and partial close, SL/TP modification, reverse. Every
  mutation requires an `Idempotency-Key`; closes are serialised by an
  `OPEN → CLOSING` database guard.
- **Trigger engine** — closes positions from price movement: stop-loss and
  take-profit on the executable exit price, trailing stops that ratchet and never
  retreat, and incremental liquidation at the stop-out level. Verified against
  the live feed, not only in tests.
- **Realtime** — Socket.IO gateway on `/ws` with per-connection sequence numbers,
  account-scoped private channels, Redis fan-out across instances, and
  tick-driven account and P&L pushes throttled per account.
- **API** — NestJS with Zod-validated environment and DTOs, response/error
  envelopes, request-id tracing, structured logging with redaction, Prometheus
  metrics, liveness and readiness probes, OpenAPI, per-endpoint rate limits.
- **Worker** — real scheduled jobs: nightly swap accrual with weekend financing,
  idempotency sweeping, and a reconciliation check that replays every ledger
  against its cached balance and raises a CRITICAL risk event on any drift.
- **Web** — Next.js 15 with the terminal theme, serving an honest build-status page.

Not built yet: pending orders, account snapshots, the terminal UI, chart
integration. Those are Phases 8–9.

---

## Quick start

Requires Node 22+ and Docker. Every block below is safe to paste as-is — there
are no inline comments, because an interactive zsh does not treat `#` as one and
will try to run the explanation.

**1. Install pnpm** (skip if `pnpm -v` already works):

```bash
corepack enable pnpm
```

If corepack is unavailable, `npm install -g pnpm` or `brew install pnpm` work too.
The repo pins `pnpm@10.28.0` via `packageManager`, and corepack honours it.

**2. Create `.env` and generate the two JWT secrets:**

```bash
cd ~/Documents/trading-platform
cp .env.example .env
sed -i '' "s|^JWT_ACCESS_SECRET=.*|JWT_ACCESS_SECRET=$(openssl rand -base64 48)|" .env
sed -i '' "s|^JWT_REFRESH_SECRET=.*|JWT_REFRESH_SECRET=$(openssl rand -base64 48)|" .env
```

On Linux, drop the `''` after `-i`. The API refuses to start on a secret shorter
than 32 characters, so this step is not optional.

**3. Start PostgreSQL and Redis, then set up the database:**

```bash
docker compose up -d postgres redis
pnpm install
pnpm db:migrate
pnpm db:seed
```

**4. Check everything works:**

```bash
pnpm verify
```

**5. Run it:**

```bash
pnpm dev
```

|                          |                                   |
| ------------------------ | --------------------------------- |
| Web                      | http://localhost:3000             |
| API                      | http://localhost:4000/api/v1      |
| OpenAPI                  | http://localhost:4000/docs        |
| Health / Ready / Metrics | `/health` · `/ready` · `/metrics` |

`docker compose up -d` with no service names also builds and runs the api, worker
and web containers. Starting only `postgres` and `redis` and running the apps
with `pnpm dev` gives faster reloads while developing.

### Running the integration tests

65 of the 261 tests talk to a real PostgreSQL database. They skip themselves
unless `TEST_DATABASE_URL` is set, so a fresh checkout gets a green `pnpm verify`
with no extra setup — but that means they are not running yet.

To enable them:

```bash
pnpm db:test:prepare
```

That creates a separate `trading_platform_test` database and migrates it, then
prints the line to uncomment in `.env`. The suite truncates every table between
cases, which is why it gets its own database and never points at your working one.

## Layout

```
apps/
  api/         NestJS — HTTP, WebSocket, trading engine
  worker/      BullMQ — deferred work only
  web/         Next.js — the terminal
packages/
  shared-types/    enums, wire DTOs, error codes, WS contract
  financial-core/  Money, Decimal, instrument specs, P&L / margin / account formulas
  market-core/     MarketDataProvider port, clock, seeded RNG, candles, simulator
  trading-core/    order & position state machines, protective orders
  risk-core/       rule contract, rule engine, default rules
  api-client/      typed REST client
  ui/              presentation primitives and design tokens
prisma/          schema, migrations, instrument seed
docs/            architecture and design (Phase 0 deliverables)
docker/          per-service Dockerfiles
scripts/         schema guard, API smoke test
```

`financial-core`, `trading-core` and `risk-core` are pure: no React, no Next,
no NestJS, no Prisma, no Redis, no Node I/O. **Enforced by ESLint**, not by
convention.

---

## Scripts

| Command                                                                        | Does                                      |
| ------------------------------------------------------------------------------ | ----------------------------------------- |
| `pnpm verify`                                                                  | lint → typecheck → test → build           |
| `pnpm test` / `test:watch` / `test:coverage`                                   | Vitest                                    |
| `pnpm dev`                                                                     | Every app in watch mode                   |
| `pnpm build`                                                                   | Packages, then apps                       |
| `pnpm db:migrate` / `db:migrate:deploy` / `db:seed` / `db:studio` / `db:reset` | Prisma                                    |
| `pnpm check:schema`                                                            | Fails if any floating-point column exists |
| `pnpm smoke`                                                                   | Boots the built API and probes it         |
| `pnpm pentest`                                                                 | Boots it again and attacks it             |
| `pnpm soak`                                                                    | Boots it again and leaves it running      |
| `pnpm restore:rehearse`                                                        | Dumps, restores, compares, reconciles     |
| `pnpm keygen <id>`                                                             | Prints a secret-encryption key            |
| `pnpm lint:fix` / `pnpm format`                                                | Fixers                                    |

---

## Environment

Every variable is documented in [`.env.example`](./.env.example) and validated by
a Zod schema at boot (`apps/api/src/config/env.schema.ts`). Missing or malformed
configuration stops the process; error output names fields, never values.

The ones worth knowing:

| Variable                                   | Why it matters                                                   |
| ------------------------------------------ | ---------------------------------------------------------------- |
| `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` | Minimum 32 characters, or the API will not start                 |
| `MARKET_SIMULATOR_SEED`                    | Fixes the market. Same seed ⇒ same ticks ⇒ same fills ⇒ same P&L |
| `TRADING_SERVER_TIMEZONE`                  | The single zone all trading-day logic uses                       |
| `NEXT_PUBLIC_CHARTING_LIBRARY_PATH`        | Where the licensed TradingView library is unpacked               |

---

## Documentation

[`docs/`](./docs/README.md) holds the Phase 0 design. Most useful first:

- [architecture.md](./docs/architecture.md) — the rule everything else follows
- [pnl.md](./docs/pnl.md) — formulas and the reference vectors
- [trading-engine.md](./docs/trading-engine.md) — submission and tick paths
- [database.md](./docs/database.md) — schema and the immutable ledger

---

## Build status

| Phase |                                                |              |
| ----- | ---------------------------------------------- | ------------ |
| 0     | Product definition                             | **Complete** |
| 1     | Project foundation                             | **Complete** |
| 2     | Account system                                 | Planned      |
| 3     | Market core (persisted)                        | Planned      |
| 4     | Trading core                                   | Planned      |
| 5     | Financial engine (wired)                       | Planned      |
| 6     | SL/TP engine                                   | Planned      |
| 7     | Realtime                                       | Planned      |
| 8     | Trading terminal                               | Planned      |
| 9     | Chart integration                              | Planned      |
| 10–13 | Advanced UX, security, performance, production | Planned      |

The first real milestone was never the chart. It is this, and it now works end to
end through automated tests and against the running API:

```
User → Account → Market simulator → BUY XAUUSD → Order → Execution
     → Position → Tick → P&L → SL/TP → Close → Ledger → Updated balance
```

That is now complete, including the SL/TP leg: a position closes from a tick, not
only from a request.

---

## Working rules

Non-negotiable in this repository:

1. **No fake functionality.** A feature is complete or it is marked incomplete.
   No `TODO: implement later` behind a finished-looking surface.
2. **No floating-point money.** `Decimal` in memory, `NUMERIC` in the database.
   CI fails on a float column.
3. **No polling as a substitute for realtime.** ESLint bans `setInterval`.
4. **No silently swallowed errors.** Every failure is a typed, coded error.
5. **No API timeout read as a rule breach.** A provider failure never closes a position.
6. **Database transactions for every financial mutation.**
7. **Tests for every financial calculation.**
8. **UTC internally; timezone assumptions made explicit.**
9. **The domain stays framework-free.**
10. **No evaluation-program logic here.** This is a standalone trading platform;
    that belongs in a separate product built on these seams.
