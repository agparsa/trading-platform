# Secrets

Where a secret may come from, what happens to it once the process has it, and
what this repository deliberately does not do.

## Two sources, one convention

Every secret the platform reads is an environment variable. Since this phase it
may also be a **file**, named by the variable with `_FILE` appended:

```
DATABASE_URL_FILE=/run/secrets/database_url
JWT_ACCESS_SECRET_FILE=/run/secrets/jwt_access
SECRET_ENCRYPTION_KEYS_FILE=/run/secrets/encryption_keys
```

That is the convention Docker secrets, Kubernetes secrets, Vault Agent,
External Secrets Operator and the official Postgres and Grafana images all
meet: the manager delivers a file with restrictive permissions, mounted into
the container, and the application is told where. An environment variable is
the least private place a secret can live — it is in `docker inspect`, in
`/proc/<pid>/environ`, in a crash dump, in whatever a child process inherits —
and a file mounted at `0400` is none of those.

The resolver (`packages/crypto-core/src/file-secrets.ts`) runs before anything
reads the environment — as the **first import** of both entry points, because
`ConfigModule.forRoot({ validate })` validates when the module file is
imported, not when `bootstrap()` runs; a deployment test pins the order. It
resolves only the variables on its list, and only those:

| Variable                                      | Read by                                          |
| --------------------------------------------- | ------------------------------------------------ |
| `DATABASE_URL`, `DATABASE_URL_TENANT`         | API, worker                                      |
| `REDIS_URL`                                   | API, worker                                      |
| `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`     | API                                              |
| `SECRET_ENCRYPTION_KEYS`                      | API, worker                                      |
| `FCM_SERVICE_ACCOUNT_JSON`                    | worker                                           |
| `APNS_CREDENTIALS_JSON`                       | worker                                           |
| `POSTGRES_PASSWORD`, `GRAFANA_ADMIN_PASSWORD` | compose (their images honour `_FILE` themselves) |

A generic "any `_FILE` suffix" rule was rejected on purpose: `TRUSTED_PROXIES_FILE`
is a real path the edge is given, present in the API's environment through
`env_file`, and not inside the API container. The list is the contract; a new
secret is added to the platform by adding it there, and a deployment test
checks the production example against it, and `scripts/secrets.test.ts` checks
this table against the list and against the process that declares each one.

It said the push credential was read by the API, which has never sent a push;
and it had no row for `APNS_CREDENTIALS_JSON` — the APNs signing key, the one
secret here that is literally a private key — because the list had none
either. That key could only be given to the worker as an environment variable,
readable in `docker inspect` by anyone with the Docker socket.

Every ambiguity refuses the boot rather than guessing, by variable name and
never by value: both `X` and `X_FILE` set (two sources, one of them stale); a
file that cannot be read (a mount that is missing); an empty file (a mount that
failed). One trailing newline is removed — editors add one, secrets do not
carry one — and nothing else is touched. The boot log says which variables
came from files (`Secrets read from files: DATABASE_URL, …`), and nothing about
their contents. The worker's smoke check boots the real build from a file and
then from a missing one.

## Using it with Docker Compose

The production compose file builds `DATABASE_URL` from `POSTGRES_*` in
`.env.production`. To move the password out of that file:

```yaml
# docker-compose.secrets.yml — an example, not shipped
secrets:
  postgres_password: { file: /etc/trading-platform/secrets/postgres_password }
  database_url: { file: /etc/trading-platform/secrets/database_url }
  jwt_access: { file: /etc/trading-platform/secrets/jwt_access }

services:
  postgres:
    secrets: [postgres_password]
    environment:
      POSTGRES_PASSWORD_FILE: /run/secrets/postgres_password
  api:
    secrets: [database_url, jwt_access]
    environment:
      DATABASE_URL: '' # the base file sets it; empty it so the file wins
      DATABASE_URL_FILE: /run/secrets/database_url
      JWT_ACCESS_SECRET_FILE: /run/secrets/jwt_access
```

Added as a third `-f` when wanted, like the observability file. The files on
the host belong to root, mode `0400`, and are not in the repository, in the
image, or in `.env.production`.

## Rotation

A secret is read once, at boot. Rotating a mounted file takes effect at the
next process start — a rolling restart, which the drain (`docs/runbook.md`)
makes painless. That is the same moment `SECRET_ENCRYPTION_KEYS` rotation
already takes effect: the newest key encrypts, every listed key decrypts, so
the new file lists both until every row has been rewritten
([security.md](./security.md#secrets)).

## What this is not

A client for a secrets manager's API. HashiCorp Vault, AWS Secrets Manager,
GCP Secret Manager and Azure Key Vault each need their SDK, an identity for the
process, and their own rotation semantics — and choosing one is the operator's
decision, tied to where the platform runs. Every one of them can deliver a
file; this is the interface they all meet. If a direct integration is wanted
later, it is one adapter behind the same resolver, and it starts with that
manager's documentation, not with a guess at its API.
