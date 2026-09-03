-- CreateEnum
CREATE TYPE "SecurityEventKind" AS ENUM ('SIGN_IN', 'SIGN_IN_FAILED', 'SECOND_FACTOR_FAILED', 'SIGN_IN_NEW_DEVICE', 'SIGN_OUT', 'SESSION_REVOKED', 'SESSIONS_REVOKED_BY_STAFF', 'EMAIL_VERIFIED', 'PASSWORD_CHANGED', 'PASSWORD_RESET', 'TWO_FACTOR_ENABLED', 'TWO_FACTOR_DISABLED', 'RECOVERY_CODE_USED', 'API_KEY_MINTED', 'API_KEY_REVOKED', 'SERVICE_TOKEN_MINTED', 'SERVICE_TOKEN_REVOKED', 'ROLE_ASSIGNED', 'USER_SUSPENDED', 'USER_REINSTATED', 'USER_UNLOCKED');

-- CreateEnum
CREATE TYPE "SecuritySeverity" AS ENUM ('INFO', 'NOTICE', 'WARNING');

-- CreateTable
CREATE TABLE "security_events" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID,
    "kind" "SecurityEventKind" NOT NULL,
    "severity" "SecuritySeverity" NOT NULL,
    "actor_id" UUID,
    "actor_type" TEXT NOT NULL,
    "request_id" TEXT,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "details" JSONB,
    "audit_log_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "security_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "security_events_user_id_created_at_idx" ON "security_events"("user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "security_events_tenant_id_created_at_idx" ON "security_events"("tenant_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "security_events_kind_created_at_idx" ON "security_events"("kind", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "security_events" ADD CONSTRAINT "security_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "security_events" ADD CONSTRAINT "security_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Tenant isolation, at the database as well as in the application.
ALTER TABLE "security_events" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "security_events_tenant_isolation" ON "security_events";
CREATE POLICY "security_events_tenant_isolation" ON "security_events"
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- Append-only, like the audit log it is derived from. A security feed that a
-- compromised administrator account could tidy is a feed that says nothing.
-- `ON DELETE SET NULL` on user_id is an UPDATE, so the trigger below would
-- refuse deleting a user who has events; users are never deleted here, and
-- that refusal is the right answer if somebody tries.
CREATE OR REPLACE FUNCTION security_events_are_append_only()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'security_events is append-only: % is not permitted on this table', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

DROP TRIGGER IF EXISTS security_events_no_update ON security_events;
CREATE TRIGGER security_events_no_update
  BEFORE UPDATE ON security_events
  FOR EACH ROW EXECUTE FUNCTION security_events_are_append_only();

DROP TRIGGER IF EXISTS security_events_no_delete ON security_events;
CREATE TRIGGER security_events_no_delete
  BEFORE DELETE ON security_events
  FOR EACH ROW EXECUTE FUNCTION security_events_are_append_only();

DROP TRIGGER IF EXISTS security_events_no_truncate ON security_events;
CREATE TRIGGER security_events_no_truncate
  BEFORE TRUNCATE ON security_events
  FOR EACH STATEMENT EXECUTE FUNCTION security_events_are_append_only();

REVOKE UPDATE, DELETE ON security_events FROM PUBLIC;

COMMENT ON TABLE security_events IS
  'Append-only. Derived from audit_logs by the application; INSERT and SELECT only.';
