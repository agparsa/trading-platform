# Deployment

## Local development

See the README's Quick start for paste-safe commands. In short:

```bash
corepack enable pnpm
cp .env.example .env
docker compose up -d postgres redis
pnpm install
pnpm db:migrate
pnpm db:roles
pnpm db:seed
pnpm verify
```

Fill in `JWT_ACCESS_SECRET` and `JWT_REFRESH_SECRET` before starting the API; it
refuses to boot on anything shorter than 32 characters.

On a host that is already running, `scripts/upgrade-server.sh` does this for you
— it creates the role after the migration, verifies the policies actually
constrain it, and only then writes `DATABASE_URL_TENANT`. That order is the point:
the API refuses to boot when the variable is set and the role turns out to be
exempt, so checking afterwards would turn a misconfiguration into an outage. A
failure there is a warning rather than a stop, because the platform runs
correctly without it — with the second isolation layer disarmed, which is the
state every deployment was in before the step existed.

For a fresh checkout, `pnpm db:roles` creates the second database role — the one that owns no tables,
and therefore the one PostgreSQL's row-level-security policies actually apply to.
It prints a `DATABASE_URL_TENANT` line for `.env`. Set it: with it, tenant
isolation is enforced by the database as well as by the application, and the API
refuses to start if that stops being true. Without it, both processes start and
say once that isolation is not enforced. Run it again after any migration that
adds a table. See [multi-tenancy.md](./multi-tenancy.md).

Integration tests need their own database — `pnpm db:test:prepare` creates and
migrates it, provisions the same role against it, and prints the
`TEST_DATABASE_URL` and `TEST_DATABASE_URL_TENANT` lines to uncomment.

- Web: http://localhost:3000
- API: http://localhost:4000/api/v1
- OpenAPI: http://localhost:4000/docs
- Liveness: http://localhost:4000/health · Readiness: `/ready` · Metrics: `/metrics`

Generate secrets with `openssl rand -base64 48`. The API refuses to start on
anything shorter than 32 characters.

Without Docker: run PostgreSQL 16 and Redis 7 yourself, point `DATABASE_URL` and
`REDIS_URL` at them, then `pnpm dev`.

## Images

Each service has its own Dockerfile in `docker/` with four stages — `base`,
`development`, `build`, `production` — so CI can build and cache them
independently. Production images carry only built output plus traced
dependencies; the web image uses Next's standalone output.

## Probes

| Endpoint  | Answers               | Touches dependencies                     |
| --------- | --------------------- | ---------------------------------------- |
| `/health` | Is the process alive? | **No**                                   |
| `/ready`  | Can it serve traffic? | Yes — database and Redis, with latencies |

Liveness deliberately does not touch the database. If it did, a brief database
blip would make the orchestrator kill every healthy API pod at once — turning a
30-second degradation into an outage.

Both are version-neutral, so moving the API from v1 to v2 does not break probes.

## Migrations

`prisma migrate deploy` runs before new application containers accept traffic.
Migrations are forward-only and additive within a release; a destructive change
is split across two releases so a rollback never strands data.

The production schema is never edited by hand.

## Bringing it up in production

```bash
cp .env.production.example .env.production
pnpm keygen                    # prints fresh JWT secrets and an encryption key
$EDITOR .env.production        # every value; nothing here has a safe default

docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build
docker compose -f docker-compose.prod.yml --env-file .env.production ps
```

`migrate` runs to completion before anything that reads the schema starts, and
everything else waits on it. To add serving capacity:

```bash
docker compose -f docker-compose.prod.yml --env-file .env.production up -d --scale api=3
```

### What the production stack does differently

**Ingestion is its own process.** `api-ingest` pulls market data and runs the
trigger engine and serves nobody; `api` serves everybody with
`MARKET_INGEST_ENABLED=false` and relays prices over `market:ticks`. Exactly one
process may ingest — two would double-count candle volume — and a process that
does both starves its own feed. That is measured, not assumed: see
[capacity.md](./capacity.md).

**Nothing is exposed but Nginx.** Postgres, Redis, the API and the web app have
no host ports. One door, one place TLS terminates, one place an edge rate limit
goes.

**No source volumes.** The image is what runs. A bind mount over `apps/api/src`
in production is a way to run code nobody built or tested.

**Migrations are a job.** Two API replicas racing `migrate deploy` is lock
contention at best.

### Behind a control panel

If the host already runs cPanel, Plesk or similar, it already serves ports 80
and 443 for every site on it, and this stack cannot have them. See
[deployment-cpanel.md](./deployment-cpanel.md) — and read the first paragraph,
which argues for not doing it at all on anything but a test deployment.

### Behind a CDN

If anything sits between the internet and this host — a CDN, a load balancer, a
reverse proxy someone else runs — then every request arrives from _its_
addresses, not from the client's. Three things follow, and the first is not
optional.

**Rate limits count the wrong subject.** `limit_req_zone $binary_remote_addr`
and every per-IP decision the application makes are only as meaningful as the
address behind them. Unfixed, the whole platform shares one bucket per CDN edge
node: an attacker gets the same allowance as every legitimate user put together,
and a single abusive client rate-limits everybody else. Point
`TRUSTED_PROXIES_FILE` at a file naming the provider's ranges —
`docker/nginx/trusted-proxies.arvancloud.conf` is one, from ArvanCloud's
published list — and Nginx resolves the real client address from
`X-Forwarded-For`.

Never enable `real_ip_header` without also naming who may set it. That does not
weaken the limits; it removes them, because any client can then send
`X-Forwarded-For: 1.2.3.4` and present a different address on every request.

**WebSockets need to be allowed through.** The terminal's entire realtime path is
one connection to `/ws`. Most CDNs support WebSocket but not always by default,
and a CDN that silently downgrades the upgrade request produces a terminal whose
prices never move and whose console says nothing useful. Check it explicitly
after the first deploy: `pnpm smoke:ws` run against the public hostname either
connects or it does not.

**`/api/` and `/ws` must not be cached.** A cached account balance is a wrong
account balance. Configure the CDN to bypass cache for both paths; the static
web bundle is the only thing here worth caching.

### Checking the deployment itself

`pnpm smoke` and `pnpm smoke:ws` normally spawn their own API and talk to it on
loopback, because a smoke test that might be hitting a stale binary proves
nothing. `SMOKE_TARGET` aims them at a deployment that is already running
instead:

```bash
SMOKE_TARGET=https://trade.example.com pnpm smoke
SMOKE_TARGET=https://trade.example.com pnpm smoke:ws
```

If the deployment runs `REGISTRATION_MODE=invite` — which production examples do
— mint a multi-use invitation first and pass it, or every check that needs a
token will fail on the registration rather than on what it was testing:

```bash
SMOKE_INVITE_CODE=<code> SMOKE_TARGET=https://trade.example.com pnpm smoke
```

The trade is explicit: they stop proving anything about the code and start
proving something about the environment — whether TLS terminates where you
think, whether the upgrade survives every proxy in front of it, whether the
database that deployment actually uses is reachable. The rate-limit check is
skipped, because it needs an allowance this run cannot set on a process it did
not start.

Run `smoke:ws` first. Everything else here fails visibly; a WebSocket that has
been downgraded to polling looks entirely normal until prices stop moving.

`pnpm pentest` has no such mode, on purpose. It brute-forces a login and creates
users — against a live deployment that means tripping its own protections and
leaving debris behind. Run it against a staging copy.

### TLS, and what happens before you have a certificate

`ssl_certificate` is not a conditional directive: Nginx refuses to start when the
file is missing. Pointed straight at the operator's mount, that made a first
bring-up on a fresh host start every service and then fail on the only container
through which any of them could be reached — with the reason in a log nobody was
watching yet.

So the Nginx image runs one script before Nginx starts, and it looks in three
places in order of how explicit each one is:

1. **`TLS_CERT_DIR`** — a certificate you put there yourself. It wins, because
   putting a file there is an instruction.
2. **`/etc/letsencrypt/live/$TLS_DOMAIN/`** — one the `certbot` service issued.
3. **A self-signed certificate** it generates, with a warning on stderr every
   boot. The stack comes up reachable and obviously provisional, which is the
   honest state of a host with no certificate.

The first two are _linked_, not copied, so a renewal behind the link takes effect
on reload. Nginx watches that file itself and reloads when it changes — a
renewed certificate that nothing reloads keeps being served as the old one until
the container happens to restart, and the failure then arrives up to ninety days
after its cause.

Nothing here holds the Docker socket. The usual sidecar that runs
`docker kill -s HUP` needs it, and a container with that socket can start any
container it likes as root on the host; mounting it `:ro` protects the socket
file, not the API reachable through it. Reloading a web server is not worth that.

**Issuing the first certificate.** Port 80 must reach this host from the internet
— through the CDN, if there is one, with the CDN not caching
`/.well-known/acme-challenge/`. Nginx answers that path over plain HTTP ahead of
its HTTPS redirect, because Let's Encrypt follows no redirect to a certificate
that does not exist yet.

```bash
docker compose -f docker-compose.prod.yml --env-file .env.production run --rm \
  --entrypoint certbot certbot certonly --webroot -w /var/www/certbot \
  -d "$TLS_DOMAIN" --email you@example.com --agree-tos --no-eff-email
docker compose -f docker-compose.prod.yml --env-file .env.production restart nginx
```

Add `--dry-run` first. Let's Encrypt rate-limits failed issuance per domain per
week, and a rehearsal costs nothing.

After that the `certbot` service checks for renewal twice a day and does nothing
until a certificate is within thirty days of expiry.

HSTS is sent from the first response, so a browser that accepts a self-signed
certificate once will refuse to speak plain HTTP to that hostname afterwards.
Get the real certificate in place before anyone signs in.

`TLS_CERT_DIR` is mounted read-only and never written to. Nothing in
`docker/nginx/certs/` is committed.

### The web image is built for one hostname

Next.js inlines `NEXT_PUBLIC_*` into the client bundle, so `PUBLIC_API_URL` and
`PUBLIC_WS_URL` are **build arguments**, not runtime settings. Setting them at
runtime changes nothing the browser ever sees — which produces a terminal
talking to `localhost` in production, with no error anywhere to say why. Moving
to a different hostname means rebuilding the web image.

## Scaling

The serving API is stateless and scales horizontally: session state is in the
token, hot market state is in Redis, financial truth is in PostgreSQL. WebSocket
fan-out goes through Redis pub/sub, so any instance can serve any socket.

The worker scales independently.

Two components must stay singular, and for different reasons:

- **Market-data ingestion.** Two ingesters double-count candle volume.
- **The trigger engine.** Two would race each other for the same position rows
  when firing the same stop.

Both live on `api-ingest`, which is deliberately not behind the load balancer.

Per-tick cost scales with **platform-wide open interest**, not with how busy any
one trader is — every open position is checked against every price, because that
is what a stop-loss is. `tp_open_positions` is the gauge that predicts when the
ingest process will need to be split by symbol.

## Observability

Prometheus scrapes `/metrics`. Declared metrics (`tp_` prefix) are listed in
[observability.md](./observability.md). The production Nginx config restricts
`/metrics` to private ranges — it carries the shape of the whole platform, and
it is neither a secret nor public.

The one to alert on first is **`tp_market_feed_age_ms`**. It is the leading
indicator of `STALE_QUOTE` refusals: the engine will not fill against a price it
does not trust, so a rising feed age becomes rejected orders before anybody
reports anything. `GET /health/market` says the same thing in words, and names
the instruments currently being refused by the integrity gate.

`/health/market` is deliberately _not_ part of `/ready`. A process pulled out of
the load balancer because the upstream feed stopped is a process that cannot
serve history, account state or the ledger either — and traders would lose the
screen that tells them what has happened. Alert on it; do not route on it.

## Backups

PostgreSQL is the only stateful component that matters. Point-in-time recovery,
plus periodic restore drills. Redis holds no financial truth — losing it costs a
cache warm-up and a round of client re-snapshots.

## Before the first deploy

Two things in this repository have never run outside CI, and both should be
proven before anyone depends on them:

1. **The images.** `.github/workflows/ci.yml` builds all three — api, worker and
   web — to the `production` target on every push, so they are exercised where
   Docker exists. They have not been _run_ in production shape. Start a
   container from each and hit `/ready` before cutting traffic over.
2. **A restore.** See [runbook.md](./runbook.md). A backup nobody has restored is
   a hope.

The lockfile is enforced in the images: `pnpm install --frozen-lockfile` with no
fallback. A stale lockfile fails the build rather than silently installing
versions the test suite never saw.

`.dockerignore` keeps `node_modules` out of the build context. Without it the
Dockerfiles copy `packages/` with whatever native binaries the machine running
the build happens to have compiled — which is how an image built on a Mac fails
at runtime on a Linux host, on a module that works locally.

`scripts/deployment.test.ts` checks the parts of this that a typecheck cannot
see: that every path the Dockerfiles copy exists, that no service runs as root,
that no healthcheck touches the database, that ingest and the trigger engine are
enabled for exactly one service, and that nothing but Nginx publishes a port. It
runs as part of `pnpm test`, and it exists because each of those was wrong at
least once.

`apps/api/src/config/production-env.test.ts` does the same for
`.env.production.example`: every variable the API or the worker cannot start
without is declared in it, nothing is declared that nothing reads, and no secret
ships with a value. That one caught a sealing key named `ENCRYPTION_KEYS` where
the schema wanted `SECRET_ENCRYPTION_KEYS` — an operator would have generated a
key, pasted it in, and watched the API refuse to start over a value it never saw.

## Load

`pnpm load` drives concurrent sockets and concurrent orders against a real build
and reports what it measured, failing only on correctness. Run it against a
staging environment that resembles production before committing to capacity
numbers — the figures in [testing.md](./testing.md) came from a development
container and describe its limits, not yours.
