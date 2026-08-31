-- Row-level security: tenant isolation, layer two.
--
-- Layer one is a Prisma client extension (apps/api/src/tenancy/tenant-scope.ts)
-- that injects `tenant_id` into every filter and stamps it onto every insert.
-- It is code, and code has bugs. Three specific ones it cannot cover:
--
--   * `$queryRaw` does not pass through Prisma extensions at all;
--   * a nested `connect` takes a strict unique input that will not accept an
--     extra column, so the extension cannot narrow it;
--   * a model added to the schema and forgotten in `TENANT_SCOPED_MODELS` is
--     silently unprotected.
--
-- This is what refuses those. Neither layer is sufficient alone, and that is the
-- point: a single mechanism that is "obviously correct" is one nobody checks.
--
-- ## How the tenant reaches the database
--
-- `app.tenant_id`, a session setting, read by every policy. The application sets
-- it with `set_config('app.tenant_id', $1, true)` inside each transaction —
-- `true` meaning transaction-local, so a pooled connection handed to the next
-- request carries nothing over.
--
-- `current_setting('app.tenant_id', true)` returns NULL when it has never been
-- set, and the policies are written so that NULL matches nothing. A query that
-- forgets to set it therefore returns zero rows rather than everything, which is
-- the failure direction that does not leak.
--
-- ## What is true after this migration, and what is not
--
-- The policies exist and the tables have RLS enabled. They are **not** FORCE'd,
-- and that is a deliberate, load-bearing decision rather than an omission.
--
-- Postgres exempts a table's owner from its own policies unless FORCE is used.
-- In this deployment the application role owns its tables, so today the policies
-- constrain every role *except* the application — a reporting user, an analyst's
-- psql session, a service that was granted SELECT.
--
-- Forcing them requires something this migration cannot provide: the
-- application must set `app.tenant_id` on the connection for every statement,
-- and Prisma runs most reads outside an explicit transaction on a pooled
-- connection, where a transaction-local setting has nowhere to live. Making
-- that work means either routing every query through a transaction — three
-- round trips where there was one, on the order path — or moving to a driver
-- adapter that can set the variable when a connection is checked out.
--
-- Turning FORCE on before that plumbing exists would not tighten security. It
-- would make every query return zero rows, which is an outage wearing a
-- security badge.
--
-- So: layer two is armed and covers every role but one. Completing it is a
-- named item in docs/IMPLEMENTATION_PLAN.md rather than a claim made here. The
-- deployment change that makes it bite immediately — running the application as
-- a role that does not own its tables — is the same one docs/security.md
-- recommends for the audit log, and it is worth doing for both reasons at once.

CREATE OR REPLACE FUNCTION current_tenant_id()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid
$$;

COMMENT ON FUNCTION current_tenant_id() IS
  'The tenant in scope for this transaction, or NULL. NULL matches no row.';


ALTER TABLE "account_settings" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "account_settings_tenant_isolation" ON "account_settings";
CREATE POLICY "account_settings_tenant_isolation" ON "account_settings"
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

ALTER TABLE "account_snapshots" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "account_snapshots_tenant_isolation" ON "account_snapshots";
CREATE POLICY "account_snapshots_tenant_isolation" ON "account_snapshots"
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

ALTER TABLE "accounts" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "accounts_tenant_isolation" ON "accounts";
CREATE POLICY "accounts_tenant_isolation" ON "accounts"
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

ALTER TABLE "audit_logs" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "audit_logs_tenant_isolation" ON "audit_logs";
CREATE POLICY "audit_logs_tenant_isolation" ON "audit_logs"
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

ALTER TABLE "balance_ledger" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "balance_ledger_tenant_isolation" ON "balance_ledger";
CREATE POLICY "balance_ledger_tenant_isolation" ON "balance_ledger"
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

ALTER TABLE "executions" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "executions_tenant_isolation" ON "executions";
CREATE POLICY "executions_tenant_isolation" ON "executions"
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

ALTER TABLE "idempotency_keys" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "idempotency_keys_tenant_isolation" ON "idempotency_keys";
CREATE POLICY "idempotency_keys_tenant_isolation" ON "idempotency_keys"
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

ALTER TABLE "integrity_signal_events" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "integrity_signal_events_tenant_isolation" ON "integrity_signal_events";
CREATE POLICY "integrity_signal_events_tenant_isolation" ON "integrity_signal_events"
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

ALTER TABLE "integrity_signals" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "integrity_signals_tenant_isolation" ON "integrity_signals";
CREATE POLICY "integrity_signals_tenant_isolation" ON "integrity_signals"
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

ALTER TABLE "invite_codes" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "invite_codes_tenant_isolation" ON "invite_codes";
CREATE POLICY "invite_codes_tenant_isolation" ON "invite_codes"
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

ALTER TABLE "invite_redemptions" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "invite_redemptions_tenant_isolation" ON "invite_redemptions";
CREATE POLICY "invite_redemptions_tenant_isolation" ON "invite_redemptions"
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

ALTER TABLE "master_account_links" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "master_account_links_tenant_isolation" ON "master_account_links";
CREATE POLICY "master_account_links_tenant_isolation" ON "master_account_links"
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

ALTER TABLE "master_accounts" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "master_accounts_tenant_isolation" ON "master_accounts";
CREATE POLICY "master_accounts_tenant_isolation" ON "master_accounts"
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

ALTER TABLE "notifications" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "notifications_tenant_isolation" ON "notifications";
CREATE POLICY "notifications_tenant_isolation" ON "notifications"
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

ALTER TABLE "order_events" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "order_events_tenant_isolation" ON "order_events";
CREATE POLICY "order_events_tenant_isolation" ON "order_events"
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

ALTER TABLE "orders" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "orders_tenant_isolation" ON "orders";
CREATE POLICY "orders_tenant_isolation" ON "orders"
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

ALTER TABLE "position_events" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "position_events_tenant_isolation" ON "position_events";
CREATE POLICY "position_events_tenant_isolation" ON "position_events"
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

ALTER TABLE "positions" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "positions_tenant_isolation" ON "positions";
CREATE POLICY "positions_tenant_isolation" ON "positions"
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

ALTER TABLE "reconciliation_findings" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "reconciliation_findings_tenant_isolation" ON "reconciliation_findings";
CREATE POLICY "reconciliation_findings_tenant_isolation" ON "reconciliation_findings"
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

ALTER TABLE "reconciliation_runs" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "reconciliation_runs_tenant_isolation" ON "reconciliation_runs";
CREATE POLICY "reconciliation_runs_tenant_isolation" ON "reconciliation_runs"
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

ALTER TABLE "refresh_tokens" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "refresh_tokens_tenant_isolation" ON "refresh_tokens";
CREATE POLICY "refresh_tokens_tenant_isolation" ON "refresh_tokens"
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

ALTER TABLE "risk_events" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "risk_events_tenant_isolation" ON "risk_events";
CREATE POLICY "risk_events_tenant_isolation" ON "risk_events"
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

ALTER TABLE "risk_rules" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "risk_rules_tenant_isolation" ON "risk_rules";
CREATE POLICY "risk_rules_tenant_isolation" ON "risk_rules"
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

ALTER TABLE "totp_recovery_codes" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "totp_recovery_codes_tenant_isolation" ON "totp_recovery_codes";
CREATE POLICY "totp_recovery_codes_tenant_isolation" ON "totp_recovery_codes"
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

ALTER TABLE "trades" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "trades_tenant_isolation" ON "trades";
CREATE POLICY "trades_tenant_isolation" ON "trades"
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "users_tenant_isolation" ON "users";
CREATE POLICY "users_tenant_isolation" ON "users"
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- `system_settings` is the hybrid: a null tenant_id is the platform-wide row and
-- every tenant may read it. Writing it is not permitted through a tenant scope —
-- halting every firm on the platform is not a power that belongs behind the same
-- policy as halting one's own.
ALTER TABLE "system_settings" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "system_settings_tenant_isolation" ON "system_settings";
CREATE POLICY "system_settings_tenant_isolation" ON "system_settings"
  USING (tenant_id = current_tenant_id() OR tenant_id IS NULL)
  WITH CHECK (tenant_id = current_tenant_id());

