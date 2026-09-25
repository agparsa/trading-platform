# Disaster recovery

What is lost, how much of it, and how long until the platform is back — with the
numbers that are actually measured rather than hoped.

## What holds the truth

| Component  | Holds                                                      | If lost                                                                                                                                                   |
| ---------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PostgreSQL | **everything financial**: ledger, orders, positions, audit | restore from a dump; the gap since it is the loss                                                                                                         |
| Redis      | quotes, sessions' rate buckets, queue state                | a cache warm-up, one round of client re-snapshots, scheduled jobs re-registered at boot                                                                   |
| Files      | nothing — documents are rows, sealed under the key list    | —                                                                                                                                                         |
| Secrets    | `.env.production`: JWT secrets, `SECRET_ENCRYPTION_KEYS`   | **without `SECRET_ENCRYPTION_KEYS` every sealed secret in the dump is unreadable** — venue credentials, webhook secrets, TOTP secrets, identity documents |

The last row is the one that ends a firm. A database restored without its
encryption keys is a ledger nobody can act on. `.env.production` is not in any
dump and never in the repository; it is backed up separately, by hand, to a place
the operator controls, and the restore drill below starts by proving it is
there.

## Backups: the `backup` service

`docker-compose.prod.yml` runs `docker/backup/backup.sh` beside the database:

- `pg_dump -Fc` every `BACKUP_INTERVAL_HOURS` (default **6**) into `BACKUP_DIR`
  (default `./backups`, a **host** path).
- Each dump is parsed with `pg_restore --list` before it is named; a dump that
  fails is discarded and `latest.dump` never points at it.
- Dumps older than `BACKUP_RETENTION_DAYS` (default **14**) are pruned — **only
  after** a verified dump landed. A night the dump fails is not the night the
  last good one is deleted.
- `BACKUP_DIR/status` says, in one line, when the last attempt ran and whether
  it was `OK` or `FAILED`. Alert on it (see below).

**A dump on the database's own disk is a copy, not a backup.** Copying
`BACKUP_DIR` offsite — object storage, another host — is the deployment's job
and is deliberately not done by the container, which has no credentials for
anywhere else and should not. The operator's copy job reads `latest.dump` and
the dated files; it must not delete them.

On devopss.ir the copy job is `scripts/pull-backup.sh`, run every six hours by
the owner's health check from their Mac into `~/Documents/tp-backups` — the
owner's choice on 25 September; until then every dump lived only on the
server's own disk. It reads `status`, refuses a `FAILED` one, copies the dump
it names, compares SHA-256 with the server's, and exits 4 when the newest
backup is over twelve hours old, so a copy of an old file cannot hide a backup
job that stopped. It deletes nothing: fourteen days are kept as 56 slots
written over in turn. The dumps hold every trader's data, so the Mac's disk
should be encrypted.

### Recovery point objective

The interval **is** the RPO: with the default, up to six hours of trades exist
only on the primary. Tighten it by setting `BACKUP_INTERVAL_HOURS=1`; a
5.9 MB dump takes under a second. Anything tighter than an hour is a case for
point-in-time recovery, which is **not configured**: it needs `archive_mode`,
a WAL archive on separate storage, a base backup, and its own rehearsal against
a chosen second. None of that is here, and the platform should not claim it is.

## Restoring

`pnpm restore:rehearse` does all of this against a copy and measures it; run it
on the production host before you need it, and read
[backup-restore.md](./backup-restore.md) for what it checks and why row counts
are not the check.

The real thing, in order:

1. **Prove the keys exist.** Before touching the database, confirm
   `.env.production` — above all `SECRET_ENCRYPTION_KEYS` and the JWT secrets —
   is in hand from the separate backup. Without it, stop: a restore now
   produces a database nobody can read the sealed columns of.
2. **Stop the writers.** `docker compose … stop api api-ingest worker`. A
   restore under a running API is a restore with rows being written into it.
   Leave `nginx` up so the site answers with an error rather than nothing.
3. **Pick the dump.** `BACKUP_DIR/latest.dump`, or a dated one from before the
   incident if the incident is data corruption rather than loss. `pg_restore
--list` it first; a dump that does not list is not the one.
4. **Restore into an empty database**, not over the damaged one:
   `createdb <db>_restored && pg_restore -d <db>_restored --no-owner --no-acl
<dump>`. Keep the damaged database until the restored one is verified —
   it may hold rows newer than the dump that a person can reconcile by hand.
5. **Migrate forward.** `prisma migrate deploy` against the restored database;
   the image running now may be newer than the dump.
6. **Verify before serving.** Run the reconciliation engine against the
   restored copy (the rehearsal script does exactly this); every account must
   agree with its own ledger. Then swap: rename databases, or point
   `DATABASE_URL` at the restored one.
7. **Bring the platform back**, ingest first, then the API, then the worker:
   `docker compose -f docker-compose.prod.yml -f docker-compose.cpanel.yml
--env-file .env.production up -d`. Check `/health`, that quotes are moving,
   that a sign-in works, and that the worker logs show its queues scheduled.
8. **Account for the gap.** Every order, deposit and withdrawal between the
   dump and the incident is gone from the platform and still real at the venue
   and the bank. The external reconciliation run and the payments panel are
   where they are found; a person books them, with a reason, through the
   adjustment route — never by editing rows.
9. **Tell people.** Traders whose positions were affected, first.

### Recovery time objective

Measured, not promised. The rehearsal on 9 September 2026, on a two-CPU
container against 1,312 accounts and a 5.9 MB dump:

| Step             | Time      |
| ---------------- | --------- |
| dump             | 0.6 s     |
| restore          | 1.2 s     |
| `migrate deploy` | 3.2 s     |
| **total**        | **5.0 s** |

Add to that the human steps above — finding the keys, deciding which dump,
verifying, communicating — which dominate, and which is why they are written
down. Run the rehearsal on the production host against the production volume
and write the number here; that is the RTO, and it changes as the data grows.

## Alerting

Two conditions, both cheap:

- `BACKUP_DIR/status` older than `2 × BACKUP_INTERVAL_HOURS`, or containing
  `FAILED`: the backup is not happening.
- `BACKUP_DIR/latest.dump` absent from the offsite copy for longer than one
  interval: the copy is not happening.

Neither is wired to Prometheus, because the metrics endpoint is inside the
stack and a stack that is down cannot report its own backups. A check from
outside the host is the right shape.

## What is deliberately not here

- **Point-in-time recovery**, as above. Its absence is stated rather than
  papered over with a dump interval.
- **Automatic failover.** One database, restored by a person who has read this
  page. A replica that promotes itself during a network partition is a second
  ledger; two ledgers is the disaster.
- **Restoring Redis.** It holds nothing that cannot be rebuilt from PostgreSQL
  and the next tick.
