-- CreateEnum
CREATE TYPE "BrokerConnectionStatus" AS ENUM ('UNKNOWN', 'CONNECTING', 'CONNECTED', 'DEGRADED', 'DISCONNECTED', 'AUTH_FAILED', 'RATE_LIMITED');

-- CreateTable
CREATE TABLE "broker_connections" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "adapter_kind" TEXT NOT NULL,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "status" "BrokerConnectionStatus" NOT NULL DEFAULT 'UNKNOWN',
    "capabilities" JSONB,
    "last_heartbeat_at" TIMESTAMPTZ(6),
    "last_quote_at" TIMESTAMPTZ(6),
    "last_order_event_at" TIMESTAMPTZ(6),
    "latency_ms" INTEGER,
    "last_error" TEXT,
    "consecutive_failures" INTEGER NOT NULL DEFAULT 0,
    "circuit_openings" INTEGER NOT NULL DEFAULT 0,
    "circuit_open_until" TIMESTAMPTZ(6),
    "status_changed_at" TIMESTAMPTZ(6),
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "broker_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "broker_credentials" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "sealed" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "visible" JSONB NOT NULL DEFAULT '{}',
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ(6),
    "revoked_by_id" UUID,
    "last_used_at" TIMESTAMPTZ(6),

    CONSTRAINT "broker_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "broker_connections_tenant_id_enabled_idx" ON "broker_connections"("tenant_id", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "broker_connections_tenant_id_name_key" ON "broker_connections"("tenant_id", "name");

-- CreateIndex
CREATE INDEX "broker_credentials_connection_id_revoked_at_idx" ON "broker_credentials"("connection_id", "revoked_at");

-- CreateIndex
CREATE INDEX "broker_credentials_tenant_id_idx" ON "broker_credentials"("tenant_id");

-- AddForeignKey
ALTER TABLE "broker_connections" ADD CONSTRAINT "broker_connections_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "broker_connections" ADD CONSTRAINT "broker_connections_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "broker_credentials" ADD CONSTRAINT "broker_credentials_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "broker_credentials" ADD CONSTRAINT "broker_credentials_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "broker_connections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "broker_credentials" ADD CONSTRAINT "broker_credentials_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Tenant isolation, at the database as well as in the application.
ALTER TABLE "broker_connections" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "broker_connections_tenant_isolation" ON "broker_connections";
CREATE POLICY "broker_connections_tenant_isolation" ON "broker_connections"
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
ALTER TABLE "broker_credentials" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "broker_credentials_tenant_isolation" ON "broker_credentials";
CREATE POLICY "broker_credentials_tenant_isolation" ON "broker_credentials"
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- A credential is what it was sealed as. Only revocation and use move; the
-- sealed payload, its fingerprint and its connection are fixed, so a row
-- cannot be re-pointed at another connection or quietly replaced. Rotation
-- is a new row.
CREATE OR REPLACE FUNCTION broker_credentials_sealed_fixed()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.tenant_id     IS DISTINCT FROM OLD.tenant_id
  OR NEW.connection_id IS DISTINCT FROM OLD.connection_id
  OR NEW.kind          IS DISTINCT FROM OLD.kind
  OR NEW.sealed        IS DISTINCT FROM OLD.sealed
  OR NEW.fingerprint   IS DISTINCT FROM OLD.fingerprint
  OR NEW.visible       IS DISTINCT FROM OLD.visible
  OR NEW.created_by_id IS DISTINCT FROM OLD.created_by_id
  OR NEW.created_at    IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'broker_credentials: a credential is what it was sealed as; add another'
      USING ERRCODE = '42501';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
    RAISE EXCEPTION 'broker_credentials: a revocation cannot be undone or replaced'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS broker_credentials_sealed_fixed ON broker_credentials;
CREATE TRIGGER broker_credentials_sealed_fixed
  BEFORE UPDATE ON broker_credentials
  FOR EACH ROW EXECUTE FUNCTION broker_credentials_sealed_fixed();

-- Never deleted: an audit row that names a credential must keep pointing at one.
CREATE OR REPLACE FUNCTION broker_credentials_never_deleted()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'broker_credentials: rows are revoked, never deleted'
    USING ERRCODE = '42501';
END;
$$;
DROP TRIGGER IF EXISTS broker_credentials_never_deleted ON broker_credentials;
CREATE TRIGGER broker_credentials_never_deleted
  BEFORE DELETE ON broker_credentials
  FOR EACH ROW EXECUTE FUNCTION broker_credentials_never_deleted();
