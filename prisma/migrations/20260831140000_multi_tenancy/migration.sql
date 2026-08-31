-- Multi-tenancy.
--
-- Non-destructive, and deliberately written by hand rather than taken from
-- `prisma migrate diff`. The generated version adds `tenant_id NOT NULL` to
-- twenty-six populated tables in one statement, which fails on the first row
-- that exists. So each column arrives nullable, is backfilled to the default
-- tenant, and is only then constrained.
--
-- Every existing row belongs to one tenant. That is what makes the *data*
-- migration trivial; the code migration is the expensive half, and it is in
-- docs/multi-tenancy.md.
--
-- The default tenant's id is a literal rather than a generated one, so that
-- this migration produces the same result in every environment and a later
-- migration can refer to it without a lookup.

-- ---------------------------------------------------------------------------
-- The tenants table
-- ---------------------------------------------------------------------------

CREATE TYPE "TenantStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'CLOSED');

CREATE TABLE "tenants" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "primary_host" TEXT,
    "status" "TenantStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "tenants_slug_key" ON "tenants"("slug");
CREATE UNIQUE INDEX "tenants_primary_host_key" ON "tenants"("primary_host");

-- The tenant every existing row belongs to. `primary_host` is left null on
-- purpose: a tenant with no host is the one the resolver falls back to, which
-- is exactly today's single-tenant behaviour.
INSERT INTO "tenants" ("id", "slug", "name", "status", "created_at", "updated_at")
VALUES ('00000000-0000-4000-8000-000000000001', 'default', 'Default Tenant', 'ACTIVE', now(), now());

-- ---------------------------------------------------------------------------
-- tenant_id on every owned table: add nullable, backfill, constrain
-- ---------------------------------------------------------------------------

-- `audit_logs` refuses UPDATE by trigger (see audit_log_append_only). Backfilling
-- a new column is not tampering, but the trigger cannot tell the difference and
-- should not try to — a trigger with exceptions is a trigger with a bypass. So
-- the migration disables it for the length of one statement and puts it back.
ALTER TABLE "audit_logs" DISABLE TRIGGER USER;

ALTER TABLE "account_settings" ADD COLUMN "tenant_id" UUID;
ALTER TABLE "account_snapshots" ADD COLUMN "tenant_id" UUID;
ALTER TABLE "accounts" ADD COLUMN "tenant_id" UUID;
ALTER TABLE "audit_logs" ADD COLUMN "tenant_id" UUID;
ALTER TABLE "balance_ledger" ADD COLUMN "tenant_id" UUID;
ALTER TABLE "executions" ADD COLUMN "tenant_id" UUID;
ALTER TABLE "idempotency_keys" ADD COLUMN "tenant_id" UUID;
ALTER TABLE "integrity_signal_events" ADD COLUMN "tenant_id" UUID;
ALTER TABLE "integrity_signals" ADD COLUMN "tenant_id" UUID;
ALTER TABLE "invite_codes" ADD COLUMN "tenant_id" UUID;
ALTER TABLE "invite_redemptions" ADD COLUMN "tenant_id" UUID;
ALTER TABLE "master_account_links" ADD COLUMN "tenant_id" UUID;
ALTER TABLE "master_accounts" ADD COLUMN "tenant_id" UUID;
ALTER TABLE "notifications" ADD COLUMN "tenant_id" UUID;
ALTER TABLE "order_events" ADD COLUMN "tenant_id" UUID;
ALTER TABLE "orders" ADD COLUMN "tenant_id" UUID;
ALTER TABLE "position_events" ADD COLUMN "tenant_id" UUID;
ALTER TABLE "positions" ADD COLUMN "tenant_id" UUID;
ALTER TABLE "reconciliation_findings" ADD COLUMN "tenant_id" UUID;
ALTER TABLE "reconciliation_runs" ADD COLUMN "tenant_id" UUID;
ALTER TABLE "refresh_tokens" ADD COLUMN "tenant_id" UUID;
ALTER TABLE "risk_events" ADD COLUMN "tenant_id" UUID;
ALTER TABLE "risk_rules" ADD COLUMN "tenant_id" UUID;
ALTER TABLE "totp_recovery_codes" ADD COLUMN "tenant_id" UUID;
ALTER TABLE "trades" ADD COLUMN "tenant_id" UUID;
ALTER TABLE "users" ADD COLUMN "tenant_id" UUID;

UPDATE "account_settings" SET "tenant_id" = '00000000-0000-4000-8000-000000000001' WHERE "tenant_id" IS NULL;
UPDATE "account_snapshots" SET "tenant_id" = '00000000-0000-4000-8000-000000000001' WHERE "tenant_id" IS NULL;
UPDATE "accounts" SET "tenant_id" = '00000000-0000-4000-8000-000000000001' WHERE "tenant_id" IS NULL;
UPDATE "audit_logs" SET "tenant_id" = '00000000-0000-4000-8000-000000000001' WHERE "tenant_id" IS NULL;
UPDATE "balance_ledger" SET "tenant_id" = '00000000-0000-4000-8000-000000000001' WHERE "tenant_id" IS NULL;
UPDATE "executions" SET "tenant_id" = '00000000-0000-4000-8000-000000000001' WHERE "tenant_id" IS NULL;
UPDATE "idempotency_keys" SET "tenant_id" = '00000000-0000-4000-8000-000000000001' WHERE "tenant_id" IS NULL;
UPDATE "integrity_signal_events" SET "tenant_id" = '00000000-0000-4000-8000-000000000001' WHERE "tenant_id" IS NULL;
UPDATE "integrity_signals" SET "tenant_id" = '00000000-0000-4000-8000-000000000001' WHERE "tenant_id" IS NULL;
UPDATE "invite_codes" SET "tenant_id" = '00000000-0000-4000-8000-000000000001' WHERE "tenant_id" IS NULL;
UPDATE "invite_redemptions" SET "tenant_id" = '00000000-0000-4000-8000-000000000001' WHERE "tenant_id" IS NULL;
UPDATE "master_account_links" SET "tenant_id" = '00000000-0000-4000-8000-000000000001' WHERE "tenant_id" IS NULL;
UPDATE "master_accounts" SET "tenant_id" = '00000000-0000-4000-8000-000000000001' WHERE "tenant_id" IS NULL;
UPDATE "notifications" SET "tenant_id" = '00000000-0000-4000-8000-000000000001' WHERE "tenant_id" IS NULL;
UPDATE "order_events" SET "tenant_id" = '00000000-0000-4000-8000-000000000001' WHERE "tenant_id" IS NULL;
UPDATE "orders" SET "tenant_id" = '00000000-0000-4000-8000-000000000001' WHERE "tenant_id" IS NULL;
UPDATE "position_events" SET "tenant_id" = '00000000-0000-4000-8000-000000000001' WHERE "tenant_id" IS NULL;
UPDATE "positions" SET "tenant_id" = '00000000-0000-4000-8000-000000000001' WHERE "tenant_id" IS NULL;
UPDATE "reconciliation_findings" SET "tenant_id" = '00000000-0000-4000-8000-000000000001' WHERE "tenant_id" IS NULL;
UPDATE "reconciliation_runs" SET "tenant_id" = '00000000-0000-4000-8000-000000000001' WHERE "tenant_id" IS NULL;
UPDATE "refresh_tokens" SET "tenant_id" = '00000000-0000-4000-8000-000000000001' WHERE "tenant_id" IS NULL;
UPDATE "risk_events" SET "tenant_id" = '00000000-0000-4000-8000-000000000001' WHERE "tenant_id" IS NULL;
UPDATE "risk_rules" SET "tenant_id" = '00000000-0000-4000-8000-000000000001' WHERE "tenant_id" IS NULL;
UPDATE "totp_recovery_codes" SET "tenant_id" = '00000000-0000-4000-8000-000000000001' WHERE "tenant_id" IS NULL;
UPDATE "trades" SET "tenant_id" = '00000000-0000-4000-8000-000000000001' WHERE "tenant_id" IS NULL;
UPDATE "users" SET "tenant_id" = '00000000-0000-4000-8000-000000000001' WHERE "tenant_id" IS NULL;

ALTER TABLE "audit_logs" ENABLE TRIGGER USER;

ALTER TABLE "account_settings" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "account_snapshots" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "accounts" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "audit_logs" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "balance_ledger" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "executions" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "idempotency_keys" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "integrity_signal_events" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "integrity_signals" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "invite_codes" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "invite_redemptions" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "master_account_links" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "master_accounts" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "notifications" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "order_events" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "orders" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "position_events" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "positions" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "reconciliation_findings" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "reconciliation_runs" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "refresh_tokens" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "risk_events" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "risk_rules" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "totp_recovery_codes" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "trades" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "users" ALTER COLUMN "tenant_id" SET NOT NULL;

-- ---------------------------------------------------------------------------
-- system_settings: the one hybrid
-- ---------------------------------------------------------------------------
--
-- `tenant_id` stays nullable here, and null means the whole platform. The kill
-- switch is why: an operator halts one tenant, the platform operator halts
-- everything.
--
-- `key` was the primary key when there was one tenant. It becomes a plain
-- column with a surrogate id, because a composite primary key cannot hold a
-- nullable column. Existing rows keep tenant_id null, which is right — a kill
-- switch set before tenancy existed applied to everything.

ALTER TABLE "system_settings" ADD COLUMN "tenant_id" UUID;
ALTER TABLE "system_settings" ADD COLUMN "id" UUID;
UPDATE "system_settings" SET "id" = gen_random_uuid() WHERE "id" IS NULL;
ALTER TABLE "system_settings" ALTER COLUMN "id" SET NOT NULL;
ALTER TABLE "system_settings" DROP CONSTRAINT "system_settings_pkey";
ALTER TABLE "system_settings" ADD CONSTRAINT "system_settings_pkey" PRIMARY KEY ("id");

-- Two indexes, because one cannot do the job.
--
-- The composite covers tenant rows. It does *not* constrain the platform-wide
-- ones: Postgres treats two NULLs as distinct, so `(NULL, 'trading')` twice
-- satisfies it — and two platform-wide kill switches disagreeing with each
-- other is precisely the state that must not exist. The partial index is what
-- forbids it.
CREATE UNIQUE INDEX "system_settings_tenant_id_key_key" ON "system_settings"("tenant_id", "key");
CREATE UNIQUE INDEX "system_settings_platform_key" ON "system_settings"("key") WHERE "tenant_id" IS NULL;
CREATE INDEX "system_settings_tenant_id_idx" ON "system_settings"("tenant_id");

-- ---------------------------------------------------------------------------
-- Uniqueness becomes per-tenant
-- ---------------------------------------------------------------------------
--
-- An email address identifies a person to one firm, not to the platform. The
-- same is true of an account number, a rule name, an idempotency key and a
-- notification's deduplication key. Dropping these before adding the composites
-- would leave a window with no constraint at all, so each pair runs together.

DROP INDEX "users_email_key";
CREATE UNIQUE INDEX "users_tenant_id_email_key" ON "users"("tenant_id", "email");

DROP INDEX "accounts_number_key";
CREATE UNIQUE INDEX "accounts_tenant_id_number_key" ON "accounts"("tenant_id", "number");

DROP INDEX "risk_rules_name_key";
CREATE UNIQUE INDEX "risk_rules_tenant_id_name_key" ON "risk_rules"("tenant_id", "name");

DROP INDEX "idempotency_keys_scope_key_key";
CREATE UNIQUE INDEX "idempotency_keys_tenant_id_scope_key_key" ON "idempotency_keys"("tenant_id", "scope", "key");

DROP INDEX "notifications_dedupe_key_key";
CREATE UNIQUE INDEX "notifications_tenant_id_dedupe_key_key" ON "notifications"("tenant_id", "dedupe_key");

-- Left global on purpose: refresh tokens, invitation codes and the two
-- single-use tokens on `users` are high-entropy secrets. Scoping them per
-- tenant would tolerate a cross-tenant collision in principle and buy nothing;
-- a global unique on a random 256-bit value is free.

-- ---------------------------------------------------------------------------
-- Indexes and foreign keys
-- ---------------------------------------------------------------------------

CREATE INDEX "account_settings_tenant_id_idx" ON "account_settings"("tenant_id");
CREATE INDEX "account_snapshots_tenant_id_idx" ON "account_snapshots"("tenant_id");
CREATE INDEX "accounts_tenant_id_idx" ON "accounts"("tenant_id");
CREATE INDEX "audit_logs_tenant_id_idx" ON "audit_logs"("tenant_id");
CREATE INDEX "balance_ledger_tenant_id_idx" ON "balance_ledger"("tenant_id");
CREATE INDEX "executions_tenant_id_idx" ON "executions"("tenant_id");
CREATE INDEX "idempotency_keys_tenant_id_idx" ON "idempotency_keys"("tenant_id");
CREATE INDEX "integrity_signal_events_tenant_id_idx" ON "integrity_signal_events"("tenant_id");
CREATE INDEX "integrity_signals_tenant_id_idx" ON "integrity_signals"("tenant_id");
CREATE INDEX "invite_codes_tenant_id_idx" ON "invite_codes"("tenant_id");
CREATE INDEX "invite_redemptions_tenant_id_idx" ON "invite_redemptions"("tenant_id");
CREATE INDEX "master_account_links_tenant_id_idx" ON "master_account_links"("tenant_id");
CREATE INDEX "master_accounts_tenant_id_idx" ON "master_accounts"("tenant_id");
CREATE INDEX "notifications_tenant_id_idx" ON "notifications"("tenant_id");
CREATE INDEX "order_events_tenant_id_idx" ON "order_events"("tenant_id");
CREATE INDEX "orders_tenant_id_idx" ON "orders"("tenant_id");
CREATE INDEX "position_events_tenant_id_idx" ON "position_events"("tenant_id");
CREATE INDEX "positions_tenant_id_idx" ON "positions"("tenant_id");
CREATE INDEX "reconciliation_findings_tenant_id_idx" ON "reconciliation_findings"("tenant_id");
CREATE INDEX "reconciliation_runs_tenant_id_idx" ON "reconciliation_runs"("tenant_id");
CREATE INDEX "refresh_tokens_tenant_id_idx" ON "refresh_tokens"("tenant_id");
CREATE INDEX "risk_events_tenant_id_idx" ON "risk_events"("tenant_id");
CREATE INDEX "risk_rules_tenant_id_idx" ON "risk_rules"("tenant_id");
CREATE INDEX "totp_recovery_codes_tenant_id_idx" ON "totp_recovery_codes"("tenant_id");
CREATE INDEX "trades_tenant_id_idx" ON "trades"("tenant_id");
CREATE INDEX "users_tenant_id_idx" ON "users"("tenant_id");

ALTER TABLE "account_settings" ADD CONSTRAINT "account_settings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "account_snapshots" ADD CONSTRAINT "account_snapshots_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "balance_ledger" ADD CONSTRAINT "balance_ledger_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "executions" ADD CONSTRAINT "executions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "integrity_signal_events" ADD CONSTRAINT "integrity_signal_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "integrity_signals" ADD CONSTRAINT "integrity_signals_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "invite_codes" ADD CONSTRAINT "invite_codes_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "invite_redemptions" ADD CONSTRAINT "invite_redemptions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "master_account_links" ADD CONSTRAINT "master_account_links_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "master_accounts" ADD CONSTRAINT "master_accounts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "orders" ADD CONSTRAINT "orders_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "position_events" ADD CONSTRAINT "position_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "positions" ADD CONSTRAINT "positions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "reconciliation_findings" ADD CONSTRAINT "reconciliation_findings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "reconciliation_runs" ADD CONSTRAINT "reconciliation_runs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "risk_events" ADD CONSTRAINT "risk_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "risk_rules" ADD CONSTRAINT "risk_rules_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "totp_recovery_codes" ADD CONSTRAINT "totp_recovery_codes_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "trades" ADD CONSTRAINT "trades_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "users" ADD CONSTRAINT "users_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "system_settings" ADD CONSTRAINT "system_settings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
