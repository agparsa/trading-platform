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

When the merge it performs changes `upgrade-server.sh` itself, the script
restarts on the new version rather than finishing on the old text (bash reads a
script as it runs, so a change to the file lands on the _next_ deploy
otherwise). The restarted run says so — "resumed on the new script; the upgrade
began at …" — and reports the same `before -> after` range as the first, because
the first hands its starting commit across. The first upgrade to restart itself
did not, saw "nothing to fetch", and force-recreated nginx for want of a
range to compare, dropping every open socket on an upgrade that never touched
nginx. `deployment.test.ts` now runs that step of the script in a clone that is
in the resumed state.

A flag added to a self-restarting script is first received from a caller that
does not know it: the previous version. The version that introduced
`--resumed-from` refused a bare `--resumed`, and its own deploy stopped at
step 4 — merged, nothing built, nothing stopped, old build still serving —
when the old script restarted onto it. The script now accepts what its
predecessor passes and says what it lost, and the test feeds the flags on
`HEAD`'s restart line to the working tree's parser.

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

## Confirming a deploy from outside

```bash
pnpm verify:production --expect $(git rev-parse HEAD)
```

Checks over HTTPS, with no credentials and no shell (the script prints how
many it ran): the probes, whether the running build is the one you just
deployed, that `/metrics` and the API reference are **not** public, that an
unauthenticated call is refused with a coded error rather than a crash, HSTS,
that the real-time socket completes a handshake — and that the real-time
service is on the deployed build too.

`BUILD_SHA` above is what makes the build checks possible. The API serves a
one-way marker derived from it — not the commit, because `/health` is
unauthenticated and this platform keeps its route surface off the public
internet. Deploy without `BUILD_SHA` and the check reports `unknown`, which is
itself worth knowing: nobody will be able to tell what is running.

The real-time service is asked separately because it is a separate container.
Nginx sends `/ws` to `api-ws` and everything else to `api`, so the `/health`
marker is the HTTP instance's answer only. `api-ws` puts the same marker on
its Engine.IO handshake response as an `x-tp-build` header, and the script
reads it from the handshake it already performs. This exists because on
21 September the API reported the deployed commit, every check passed, and the
socket service — the container each trader's screen is connected to — had been
"Up 2 days" on a build sixteen commits older: `upgrade-server.sh` had never
rebuilt or stopped it. Both of its service lists are now checked against the
compose file by `deployment.test.ts`.

The web is asked too: every page carries an `x-tp-build` header, folded into
the routes manifest at `next build` from the `BUILD_SHA` the image was built
with (so the web Dockerfile sets it in the _build_ stage — an `ENV` in the
production stage would be read by nothing). The script reads it from the
terminal page, or from the login page when the terminal redirected.

When the public page carries no header, the script asks once more with a query
string nobody has requested before — an answer that cannot come from a cache —
and says which of two faults it found: the container was not rebuilt (no
header at the origin either), or something between the origin and the visitor
is answering that path from a copy older than the deploy (header at the
origin, none on the public page). The second happened on the first deploy of
the header: the origin served it on every path; the public `/` and `/terminal`
— the two pages a trader opens — did not, while `/login`, `/wallet` and the
rest did. That is a CDN answering for those paths, and it means a deploy can
leave traders on the previous page shell.

The cause was ours to remove, and is removed: Next marks every prerendered page
`Cache-Control: s-maxage=31536000` — a year, for a CDN purged on each deploy,
which is how the company that wrote Next runs it. Nothing purges this one, and
Next's own `headers()` cannot override Cache-Control (its documentation says
so). So nginx does: the page shell is served `no-cache` on every response, and
`/_next/static/` — hashed assets that _are_ immutable — is matched first and
passed through untouched. The script's last check asks the origin for the
shell's cache policy. What the edge already holds still has to be purged once;
after that, no deploy needs a purge again.

The worker is the fourth process asked, though it serves no HTTP. Each worker
writes a heartbeat to Redis on boot and every thirty seconds — instance, role,
queues, and the same build marker — and withdraws it on a clean stop.
`/health/jobs` reports every heartbeat under `workers`, and the script checks
that at least one worker is alive and that every one is on the deployed build.
With that, every container running this platform's code — API, socket
service, worker, web — says which build it is, and the script compares each to
the deployed commit. Until the worker's heartbeat and the web's header existed,
either could sit on last week's image with nothing outside the host able to
tell. See [worker.md](./worker.md#is-a-worker-there-now).

Each heartbeat also says whether that worker could last reach the internet: it
asks `EGRESS_PROBE_URL` every five minutes (any HTTP answer counts), and the
script fails **the workers can reach the internet** on a no, naming the cause
and where to look. On 24 September an automatic CSF upgrade removed Docker's
NAT rules and every check here passed for thirteen hours while nothing could
leave the host — see
[deployment-cpanel.md](./deployment-cpanel.md#the-firewall-which-removes-dockers-rules-when-it-restarts).
The upgrade script seeds `EGRESS_PROBE_URL` with the Alpine mirror the build
reached and the public Alpine CDN, and a worker asks them in turn, twice round,
before it says no. It asked the mirror alone until 25 September, when the
mirror stopped answering — from the host as well — and this check reported the
workers cut off while they reached everything else.

The script itself is tested: `verify-production.test.ts` runs it as a process
against a fake deployment that answers every path as a healthy one does, then
breaks one answer at a time and requires the matching check — and only it — to
fail. The first run of that harness found the tenancy reader looking in the
wrong place: it had printed "this deployment predates the probe" and passed on
every deployment since it was written, including ones that had the probe.

What it cannot see: one request reaches one instance, so a half-finished
rollout can pass. It does not read logs or count containers. Green means the
public surface is right; the container list still deserves a look —
`docker compose ps` shows each container's age, and a service far older than
its neighbours after an upgrade is a service the upgrade did not touch.

## Migrations

`prisma migrate deploy` runs before new application containers accept traffic.
Migrations are forward-only, and additive _as a rule_ — a destructive change is
split across two releases so a rollback never strands data.

The rule has two recorded exceptions, both `NOT NULL` on columns that already
existed, and they set the floor an image may be rolled back to. The list, and
what it means for an incident, is in
[runbook.md](./runbook.md#rolling-back); `scripts/migrations.test.ts` fails the
build if a third appears without being written down.

The production schema is never edited by hand.

## Bringing it up in production

```bash
cp .env.production.example .env.production
pnpm keygen                    # prints fresh JWT secrets and an encryption key
$EDITOR .env.production        # every value; nothing here has a safe default

BUILD_SHA=$(git rev-parse HEAD) \
  docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build
docker compose -f docker-compose.prod.yml --env-file .env.production ps
```

`migrate` runs to completion before anything that reads the schema starts, and
everything else waits on it. To add serving capacity:

```bash
docker compose -f docker-compose.prod.yml --env-file .env.production up -d --scale api=3
```

### The first administrator

A deployment that has just come up has no administrator. The seed creates no
users, registration creates traders, and no endpoint mints an administrator —
correctly, because an endpoint that did would be the first thing anybody hostile
looked for. Every role change goes through `POST /admin/users/:id/role`, which
needs `roles.assign`, which only an administrator holds. So the first one comes
from the person who already holds everything: the operator at the host.

```bash
./scripts/first-administrator.sh --email you@firm.example \
  --reason "first administrator after deployment"
```

The person registers through the site and verifies their address first; the
platform does not create accounts from a shell, because a password typed at a
host is a password in a shell history. The script then does what the endpoint
would do, minus the actor it cannot have: changes the role, ends every session
the person has (the role travels in the token), and writes the audit row —
actor `SYSTEM`, with the host's name, the operator's username and the reason —
in the same transaction. It refuses once the tenant has an active administrator:
from then on the record of who appointed whom belongs to the administrators.
`--even-if-one-exists` is the break-glass for the day the only administrator
has left the company, and the audit row says it was used.

It runs the compiled CLI (`apps/api/dist/cli/first-administrator.js`) inside
the `migrate` image, which already holds the built code, the Prisma client and
the owner connection; `--tenant <slug>` for a tenant other than the default.
`--role PLATFORM_SUPER_ADMIN` appoints the platform's first super administrator
instead — accepted only on the PLATFORM tenant, and only once the API has
started at least once so the role is seeded. From then on that person creates
brokers from `/admin/brokers` and each broker's owner arrives by invitation
([brokers.md](./brokers.md)).

This was found the hard way: a production host with twenty-five registered
users, every one of them `USER`, and an admin panel nobody could open.

### What the production stack does differently

**Ingestion is its own process.** `api-ingest` pulls market data and runs the
trigger engine and serves nobody; `api` serves everybody with
`MARKET_INGEST_ENABLED=false` and relays prices over `market:ticks`. Exactly one
process may ingest — two would double-count candle volume — and a process that
does both starves its own feed. That is measured, not assumed: see
[capacity.md](./capacity.md).

**The WebSocket is its own process too (§77).** Nginx sends `/ws` to `api-ws`
and every HTTP route to `api`. Both are the API image with the same flags;
only the route differs. Fan-out to every connected terminal, and the
per-account valuations behind it, were what saturated a serving instance at a
thousand connected traders ([capacity.md](./capacity.md)), and they are also
the part that scales by adding copies — each `api-ws` values only the accounts
connected to it, and domain events reach it from the HTTP instances over Redis
exactly as they reach a second `api` replica. `--scale api-ws=2` when the
socket count grows; `--scale api=2` when order latency does.

**The worker has a role.** One `worker` with `WORKER_ROLE=all` (the default)
schedules and processes every queue. When one queue needs more hands — webhook
delivery to slow endpoints — run a second worker as
`WORKER_ROLE=processor WORKER_QUEUES=webhook-delivery` and, if the schedules
should live apart from the processing, a `WORKER_ROLE=scheduler`. BullMQ makes
one job per tick however many schedulers register it; the roles decide who
holds a queue open, not who wins.

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

## Dashboards

Prometheus and Grafana are a third compose file,
`docker-compose.observability.yml` — added to the command when wanted, because
they need `GRAFANA_ADMIN_PASSWORD` set and an operator who will read them.
Grafana binds the loopback interface only; open an SSH tunnel to it. What is on
the dashboard and what the alert rules page on is in
[observability.md](./observability.md#dashboards-and-alerts-63).

## Backups

PostgreSQL is the only stateful component that matters. The `backup` service in
the production compose file dumps it every `BACKUP_INTERVAL_HOURS` into
`BACKUP_DIR` on the host, verifies each dump before naming it, and prunes only
after a good one. Copying that directory offsite is the operator's job. Redis
holds no financial truth — losing it costs a cache warm-up and a round of client
re-snapshots. What to do when the database is gone, and how long it takes, is
[disaster-recovery.md](./disaster-recovery.md).

## Taking money

The only payment provider in this build is the manual bank transfer, confirmed by
an operator at `/admin/payments`. Set `PAYMENT_BANK_DETAILS` in
`.env.production` to whatever a payer should be shown; unset, the instructions
say plainly that details have not been configured rather than showing a blank.

| Variable                   | Default   |
| -------------------------- | --------- |
| `PAYMENT_CURRENCIES`       | `USD`     |
| `PAYMENT_MAX_AMOUNT`       | `100000`  |
| `PAYMENT_INTENT_TTL_HOURS` | `72`      |
| `PAYMENT_BANK_DETAILS`     | _(unset)_ |

Adding a third-party processor means implementing `PaymentProvider` and
registering it; nothing else should have to change. See
[payments.md](./payments.md) for why no such adapter ships here.

## Identity documents

Manual review only; see [kyc.md](./kyc.md) for why no provider ships. Two
settings, both optional:

| Variable                      | Default |
| ----------------------------- | ------- |
| `KYC_VALID_FOR_DAYS`          | unset   |
| `KYC_DOCUMENT_RETENTION_DAYS` | `1826`  |

The retention value must be the same in the API's and the worker's environment;
`.env.production` is read by both. Documents are sealed under
`SECRET_ENCRYPTION_KEYS`, so retiring a key that wrote any of them makes those
documents unreadable — rotate rather than retire, per
[encryption-at-rest.md](./encryption-at-rest.md).

Nginx accepts 11 MB on `/api/v1/kyc/documents` and 2 MB everywhere else. A
deployment behind another proxy — cPanel's Apache, a CDN — needs that proxy's
body limit raised for the same path, or uploads fail before reaching Nginx.

### Nginx reads a bind-mounted file, and a file mount is a mount of an inode

`docker/nginx/nginx.conf` is bind-mounted into the container. `git merge`
writes a new file rather than editing the old one, so after a pull the running
container is still reading the configuration it started with — all of it —
until the container is recreated, and `up -d` does not recreate it because
nothing about the container changed from Compose's point of view.

The upgrade script now diffs the mounted files between the old and new commits
and recreates nginx only when they differ, since recreating it drops whatever
connections are open at that instant. A configuration edited by hand on the
host still needs `docker compose … up -d --force-recreate nginx`.

## Paying withdrawals

Manual, by a person holding `withdrawals.pay`; see
[withdrawals.md](./withdrawals.md) for why no rail ships. The settings:

| Variable                        | Default |
| ------------------------------- | ------- |
| `WITHDRAWAL_MIN_AMOUNT`         | `10`    |
| `WITHDRAWAL_MAX_AMOUNT`         | `50000` |
| `WITHDRAWAL_DAILY_LIMIT`        | unset   |
| `WITHDRAWAL_COOLDOWN_HOURS`     | `0`     |
| `WITHDRAWAL_REQUIRE_KYC`        | `true`  |
| `WITHDRAWAL_AUTO_APPROVE_BELOW` | unset   |

**A deployment needs somebody in the FINANCE role before anyone can be paid.**
ADMIN cannot approve or pay a withdrawal — the capabilities that create money
and the ones that let it out are never one person's — so after upgrading, an
administrator puts a second person into FINANCE from the People screen (or
`POST /admin/users/:id/role`). Doing it ends that person's sessions; they sign
in again with the new role. A single-operator deployment has to choose which
half its one operator is; the platform does not choose for it. A person holds
one role, so this is two accounts at the least — and if there is no
administrator yet, [the first administrator](#the-first-administrator) comes
before either.

## Programmatic access

Nothing to configure. A person mints API keys from the Security page with their
password; an administrator mints service tokens from `/admin/credentials`.
The defaults — a year at most, ninety days unless chosen, ten live keys a
person, three hundred requests a minute per credential — are `API_KEY_*` in
`.env.example`, and the per-credential limit needs the Redis the platform
already has. Every secret is shown once and stored hashed; there is nothing on
the host to back up or rotate for them. See [api-keys.md](./api-keys.md).

### Roles reconcile themselves at boot

A release that adds a capability writes it into a constant, and the constant is
not what the permission guard reads — grants are rows, per tenant. `RolesService`
reconciles untouched built-in roles with the build when the API starts, so an
upgrade delivers the permissions its new endpoints need. Roles anybody has edited
are left exactly as they were left.

Nothing operational is required. It is worth knowing about only because the log
line after an upgrade — `Roles reconciled with this build: … brought up to date`
— is a change to what people may do, and an operator should be able to see it
there rather than infer it from a screen somebody could suddenly reach.

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

`scripts/production-env.test.ts` does the same for
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
