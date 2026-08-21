# Deployment

## Local development

```bash
cp .env.example .env      # then fill in the two JWT secrets
docker compose up -d      # postgres, redis, api, worker, web
pnpm db:migrate           # apply migrations
pnpm db:seed              # reference instruments
```

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

## Scaling

The API is stateless and scales horizontally: session state is in the token,
hot market state is in Redis, financial truth is in PostgreSQL. WebSocket fan-out
goes through Redis pub/sub, so any instance can serve any socket.

The worker scales independently. Market-data ingestion is the one component that
must be singular per symbol — two ingesters would double-count candle volume.

## Observability

Prometheus scrapes `/metrics`. Declared metrics (`tp_` prefix) are listed in
[observability.md](./observability.md). In production `/metrics` should be bound
to an internal listener or protected at the ingress rather than exposed with the
trading API.

## Backups

PostgreSQL is the only stateful component that matters. Point-in-time recovery,
plus periodic restore drills. Redis holds no financial truth — losing it costs a
cache warm-up and a round of client re-snapshots.
