# Trading Platform

A standalone, production-oriented trading platform: its own order engine,
position engine, P&L engine, risk engine, market-data layer, API, terminal and
administration console. No architectural dependency on TradingLocker, MetaTrader,
or any other trading platform.

**Status: Phases 0–15 complete; deployable.** A trader can register, verify their
email, enrol a second factor, fund an account, place market and resting orders
against a live price feed, watch positions marked to market over a WebSocket,
modify levels by dragging them on the chart, and close — or have the platform
close, when a stop-loss, take-profit, trailing stop, expiry or stop-out fires.
Every outcome lands in an immutable ledger. An administrator can search users and
accounts, suspend either, see live risk exposure, read the audit trail, run a
reconciliation, and post a balance adjustment — which requires a second factor, a
written reason, and produces a ledger entry rather than an edited number.

One thing is genuinely unfinished, and the build-status page says so on screen:
the TradingView Advanced Charts _widget_ needs a licensed bundle this repository
does not contain. The datafeed and trading-command adapters it plugs into are
written and driven end to end by tests; the terminal ships on `lightweight-charts`
until the bundle is dropped in.

---

## What exists today

|                   |                                                                                     |
| ----------------- | ----------------------------------------------------------------------------------- |
| Tests             | **1058** across 83 files, all passing                                               |
| Database          | 30 tables, **59 NUMERIC columns, 0 floating-point columns** (CI-enforced)           |
| Verified          | `lint → typecheck → test → build` green, plus smoke, WebSocket smoke, pentest, load |
| Deployed          | Run against a live deployment: 9/9 WebSocket checks, 9/9 applicable API checks      |
| Security          | **25** attacks attempted against a running instance, all refused                    |
| Load              | 100 traders · 200 sockets · 1000 orders; newest price stays ~200ms old under it     |
| Reference vectors | 8 P&L / margin / equity figures reproduced exactly from a live broker terminal      |

### Engine

- **Money and precision** — `Money`, configured `Decimal`, explicit rounding and
  tick/lot quantization. `toDecimal()` refuses inexact JS numbers outright.
- **P&L** — executable-side selection, gross/net, commission, swap, FX conversion,
  break-even. Checked against eight figures captured from a live terminal.
- **Margin and account state** — effective margin rate, required margin, equity,
  free margin, margin level, margin utilisation, margin call, stop-out.
- **State machines** — order and position lifecycles as data, with illegal
  transitions rejected at the attempt.
- **Protective orders** — SL/TP validation and triggering on the correct side of
  the book, trailing stops that ratchet and never retreat, and a defined
  resolution for a tick that spans both levels.
- **Risk engine** — pure rule contract, six default rules, all violations reported
  at once.
- **Accounts and ledger** — append-only balance ledger that is the only writer of
  balances, row-locked against lost updates, idempotent, reversed by compensating
  entries, and replayable for reconciliation.
- **Trading** — market orders, resting LIMIT and STOP orders with expiry, executions
  retaining the exact quote they filled against, positions, full and partial close,
  SL/TP modification, reverse. Every mutation requires an `Idempotency-Key`; closes
  are serialised by an `OPEN → CLOSING` database guard.
- **Trigger engine** — closes positions from price movement, and works resting
  orders. Verified against the live feed, not only in tests. Its stop-out sweep runs
  off the tick path, so a large book cannot back-pressure the market feed.

### Market data

- **Provider port** — seeded deterministic simulator, scripted provider for tests,
  candle aggregation and persistence, quote-freshness policy, per-instrument
  session calendar evaluated in its own timezone.
- **Integrity gate** — every tick is inspected before anything downstream sees it:
  malformed, non-positive, crossed, out-of-order, future-dated, implausibly wide
  or implausibly large moves are rejected and counted. A run of rejections
  re-anchors only for the reasons where re-anchoring is safe; a crossed book never
  re-anchors, because a crossed book is a broken feed, not a new price.
- **Split ingest** — one instance ingests and relays over Redis; serving instances
  scale horizontally behind it.
- **Freshness as a first-class refusal** — `STALE_QUOTE` is a safe answer. A dead
  feed refuses to open positions and refuses to close them; it never closes one on
  its own and never writes a ledger entry.

### Interfaces

- **Realtime** — Socket.IO gateway on `/ws` with per-connection sequence numbers,
  account-scoped private channels, Redis fan-out across instances, per-socket
  message budgets, and a connection that re-checks its own authority every minute
  and is downgraded when the token behind it expires or the account is revoked.
- **Terminal** — order ticket with projected outcome and reward-to-risk, positions
  and pending tables with server-side totals, chart trading with drag-to-modify,
  watchlist with search, favourites and daily change, keyboard trading with a help
  card, order-command log, toasts and a notification bell.
- **Administration** — people, accounts, risk console, audit search and
  reconciliation, each backed by its own capability. Moving money is one route,
  gated on a second factor and a written reason, and it posts to the ledger.
- **API** — NestJS with Zod-validated environment and DTOs, response/error
  envelopes, request-id tracing, structured logging with redaction, Prometheus
  metrics, liveness/readiness/market probes, OpenAPI, per-endpoint rate limits.
- **Worker** — nightly swap accrual with weekend financing, idempotency sweeping,
  reconciliation that replays every ledger against its cached balance and records
  a finding on any drift, and notification delivery.

### Operations

- **Reconciliation** — runs are recorded before the work starts and closed either
  way; findings are deduplicated per subject, counted, and reopened if they recur
  after being resolved.
- **Backup and restore** — `pnpm restore:rehearse` dumps, restores into a scratch
  database, compares row counts and content fingerprints, and reconciles every
  ledger. It is a rehearsal, not a claim.
- **Production stack** — `docker-compose.prod.yml`: Postgres with data checksums,
  Redis with `noeviction`, a one-shot migration container, a dedicated ingest
  instance, scalable serving instances, worker, web, and nginx terminating TLS
  with per-zone rate limits. Every application image runs as a non-root user.
- **A first bring-up that works** — nginx generates a self-signed certificate and
  says so, loudly, when none is mounted, because `ssl_certificate` is not
  conditional and a missing file would otherwise stop the only container anybody
  can reach the platform through. The deployment artefacts are themselves tested:
  every path the Dockerfiles copy exists, no application image runs as root, no
  healthcheck touches the database, ingest and the trigger engine are enabled for
  exactly one service, nothing but nginx publishes a port, and
  `.env.production.example` declares every variable the API and worker cannot
  start without and nothing that nothing reads.

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

**2. Create `.env` and generate the three secrets:**

```bash
cd ~/Documents/trading-platform
cp .env.example .env
sed -i '' "s|^JWT_ACCESS_SECRET=.*|JWT_ACCESS_SECRET=$(openssl rand -base64 48)|" .env
sed -i '' "s|^JWT_REFRESH_SECRET=.*|JWT_REFRESH_SECRET=$(openssl rand -base64 48)|" .env
sed -i '' "s|^SECRET_ENCRYPTION_KEYS=.*|SECRET_ENCRYPTION_KEYS=1:$(openssl rand -base64 32)|" .env
```

On Linux, drop the `''` after `-i`. The API refuses to start on a JWT secret
shorter than 32 characters or on the encryption-key placeholder, so this step is
not optional — and for a long time it generated two secrets out of three. The
placeholder says `replace_me_run_pnpm_keygen_1`, but `pnpm keygen` needs the
toolchain that step 3 installs, so `openssl` does the job here; the two produce
the same thing, a 32-byte key with the id `1`.

`scripts/readme-quick-start.test.ts` runs this block against a copy of
`.env.example` and hands the result to the API's own configuration validator, so
a required setting added to the schema without a line here fails the build
rather than the next person's first `pnpm dev`.

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

|                  |                                                      |
| ---------------- | ---------------------------------------------------- |
| Terminal         | http://localhost:3000                                |
| Admin console    | http://localhost:3000/admin                          |
| Build status     | http://localhost:3000/status                         |
| API              | http://localhost:4000/api/v1                         |
| OpenAPI          | http://localhost:4000/docs                           |
| Probes / Metrics | `/health` · `/ready` · `/health/market` · `/metrics` |

`docker compose up -d` with no service names also builds and runs the api, worker
and web containers. Starting only `postgres` and `redis` and running the apps
with `pnpm dev` gives faster reloads while developing.

### Running the integration tests

A large share of the suite talks to a real PostgreSQL database. Those tests skip
themselves unless `TEST_DATABASE_URL` is set, so a fresh checkout gets a green
`pnpm verify` with no extra setup — but that means they are not running yet.

To enable them:

```bash
pnpm db:test:prepare
```

That creates a separate `trading_platform_test` database and migrates it, then
prints the line to uncomment in `.env`. The suite truncates every table between
cases, which is why it gets its own database and never points at your working one.

---

## Deploying

[`docs/deployment.md`](./docs/deployment.md) is the procedure. In outline:

On the server, from a checkout:

```bash
./scripts/first-deploy.sh trade.example.com you@example.com --cdn arvancloud
```

That checks Docker is usable and ports 80 and 443 are actually free (a web
server already sitting there produces a container that restarts forever rather
than a clear error), writes `.env.production` with secrets generated **on that
host** and stored nowhere else, builds, starts, waits for `/ready`, then
rehearses the Let's Encrypt issuance before doing it for real. It is safe to
re-run: the env file is written once and a certificate that exists is left
alone.

The `migrate` service runs `prisma migrate deploy` once and exits; `api` waits for
it. Only `nginx` publishes ports. `MARKET_INGEST_ENABLED` and
`TRIGGER_ENGINE_ENABLED` are true on exactly one instance — `api-ingest` — and
false everywhere else, which is what makes `api` safe to scale with
`--scale api=N`.

Before pointing traffic at it, run the four checks the platform ships with
against the real deployment: `pnpm smoke`, `pnpm smoke:ws`, `pnpm pentest` and
`pnpm restore:rehearse`. Each of them boots or attacks something rather than
reading a config file.

A deployment that has just come up has **no administrator**, and nothing
creates one — every role change goes through an endpoint only an administrator
may call. Register through the site, verify the address, then appoint that
account from the host: `./scripts/first-administrator.sh --email you@firm.example --reason "..."`.
It ends the person's sessions and writes the audit row; it refuses once an
administrator exists.

**Behind a CDN**, set `TRUSTED_PROXIES_FILE` to that provider's ranges. Without
it every per-IP rate limit — nginx's and the application's — counts the CDN
rather than the client, so one attacker gets the same allowance as the entire
legitimate population. Never enable `real_ip_header` without naming who may set
it: that does not weaken the limits, it removes them.

---

## Layout

```
apps/
  api/         NestJS — HTTP, WebSocket, trading engine, admin
  worker/      BullMQ — deferred work only
  web/         Next.js — terminal and admin console
packages/
  shared-types/       enums, wire DTOs, error codes, permissions, WS contract
  financial-core/     Money, Decimal, instrument specs, P&L / margin / account formulas
  market-core/        MarketDataProvider port, clock, seeded RNG, candles, simulator, tick gate
  trading-core/       order & position state machines, protective orders, pending validation
  risk-core/          rule contract, rule engine, default rules
  reconciliation-core/ ledger replay and drift detection
  integrity-core/     anti-fraud and integrity signals
  api-client/         typed REST client
  ui/                 presentation primitives and design tokens
prisma/          schema, migrations, instrument seed
docs/            architecture, design, operations
docker/          per-service Dockerfiles and the nginx config
scripts/         schema guard, smoke, WebSocket smoke, pentest, load, soak, restore rehearsal
```

`financial-core`, `market-core`, `trading-core`, `risk-core`,
`reconciliation-core` and `integrity-core` are pure: no React, no Next, no NestJS,
no Prisma, no Redis, no Node I/O. **Enforced by ESLint**, not by convention.

---

## Scripts

| Command                                                                        | Does                                             |
| ------------------------------------------------------------------------------ | ------------------------------------------------ |
| `pnpm verify`                                                                  | build packages → lint → typecheck → test → build |
| `pnpm test` / `test:watch` / `test:coverage`                                   | Vitest                                           |
| `pnpm dev`                                                                     | Every app in watch mode                          |
| `pnpm build`                                                                   | Packages, then apps                              |
| `pnpm db:migrate` / `db:migrate:deploy` / `db:seed` / `db:studio` / `db:reset` | Prisma                                           |
| `pnpm check:schema`                                                            | Fails if any floating-point column exists        |
| `pnpm smoke`                                                                   | Boots the built API and probes it                |
| `pnpm smoke:ws`                                                                | Connects a real socket and checks the contract   |
| `pnpm pentest`                                                                 | Boots it again and attacks it                    |
| `pnpm load`                                                                    | 100 traders, 200 sockets, three phases           |
| `pnpm soak`                                                                    | Boots it again and leaves it running             |
| `pnpm restore:rehearse`                                                        | Dumps, restores, compares, reconciles            |
| `pnpm keygen <id>`                                                             | Prints a secret-encryption key                   |
| `pnpm lint:fix` / `pnpm format`                                                | Fixers                                           |

---

## Environment

Every variable is documented in [`.env.example`](./.env.example) (and
[`.env.production.example`](./.env.production.example) for a host) and validated
by a Zod schema at boot (`apps/api/src/config/env.schema.ts`). Missing or
malformed configuration stops the process; error output names fields, never
values.

The ones worth knowing:

| Variable                                   | Why it matters                                                       |
| ------------------------------------------ | -------------------------------------------------------------------- |
| `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` | Minimum 32 characters, or the API will not start                     |
| `CREDENTIALS_ENCRYPTION_KEY`               | Seals 2FA secrets and stored credentials at rest                     |
| `MARKET_SIMULATOR_SEED`                    | Fixes the market. Same seed ⇒ same ticks ⇒ same fills ⇒ same P&L     |
| `MARKET_INGEST_ENABLED`                    | True on exactly one instance. Everywhere else, prices arrive relayed |
| `TRIGGER_ENGINE_ENABLED`                   | True on exactly one instance, or positions close more than once      |
| `MARKET_MAX_SPREAD_RATIO` / `_JUMP_RATIO`  | What the integrity gate will accept from the feed                    |
| `TRADING_SERVER_TIMEZONE`                  | The single zone all trading-day logic uses                           |
| `CORS_ORIGINS`                             | Empty in production means the socket accepts no browser origin       |
| `NEXT_PUBLIC_CHARTING_LIBRARY_PATH`        | Where the licensed TradingView library is unpacked                   |

---

## Documentation

[`docs/`](./docs/README.md). Most useful first:

- [architecture.md](./docs/architecture.md) — the rule everything else follows
- [deployment.md](./docs/deployment.md) — how it goes on a host
- [runbook.md](./docs/runbook.md) — what to do when it misbehaves
- [pnl.md](./docs/pnl.md) — formulas and the reference vectors
- [trading-engine.md](./docs/trading-engine.md) — submission and tick paths
- [market-data.md](./docs/market-data.md) — the feed, freshness and the integrity gate
- [database.md](./docs/database.md) — schema and the immutable ledger
- [security.md](./docs/security.md) — auth, 2FA, sockets, and what is not covered
- [capacity.md](./docs/capacity.md) — what the load run measured, and its limits
- [reconciliation.md](./docs/reconciliation.md) — drift, findings and their lifecycle

---

## Build status

| Phase |                            |              |
| ----- | -------------------------- | ------------ |
| 0     | Product definition         | **Complete** |
| 1     | Project foundation         | **Complete** |
| 2     | Account system             | **Complete** |
| 3     | Market core (persisted)    | **Complete** |
| 4     | Trading core               | **Complete** |
| 5     | Financial engine (wired)   | **Complete** |
| 6     | SL/TP engine               | **Complete** |
| 7     | Realtime                   | **Complete** |
| 8     | Trading terminal           | **Complete** |
| 9     | Charting                   | In progress  |
| 10    | Advanced trading UX        | **Complete** |
| 11    | Security hardening         | **Complete** |
| 12    | Performance under load     | **Complete** |
| 13    | Production readiness       | **Complete** |
| 14    | Market data integrity      | **Complete** |
| 15    | Administration & oversight | **Complete** |

Phase 9 is in progress for one reason, stated plainly on `/status` as well: the
TradingView Advanced Charts widget needs a licensed bundle. The seam it attaches
to — `buildChartDatafeed` and `TradingCommandAdapter` — is complete and tested,
and chart trading works today on `lightweight-charts`.

The path that had to work before anything else does:

```
User → Account → Market feed → integrity gate → BUY XAUUSD → Order → Execution
     → Position → Tick → P&L → SL/TP → Close → Ledger → Updated balance
     → Reconciliation → Audit
```

---

## Working rules

Non-negotiable in this repository:

1. **No fake functionality.** A feature is complete or it is marked incomplete.
   No `TODO: implement later` behind a finished-looking surface.
2. **No floating-point money.** `Decimal` in memory, `NUMERIC` in the database.
   CI fails on a float column.
3. **No polling as a substitute for realtime.** ESLint bans `setInterval`.
4. **No silently swallowed errors.** Every failure is a typed, coded error.
5. **No API timeout read as a rule breach.** A provider failure never closes a
   position, and a dead feed refuses to trade rather than guessing a price.
6. **Database transactions for every financial mutation**, and no route that edits
   a balance — only routes that post to the ledger.
7. **Tests for every financial calculation**, and a guard is not trusted until
   breaking it deliberately has been seen to fail a test.
8. **UTC internally; timezone assumptions made explicit.**
9. **The domain stays framework-free.**
10. **No evaluation-program logic here.** This is a standalone trading platform;
    that belongs in a separate product built on these seams.
