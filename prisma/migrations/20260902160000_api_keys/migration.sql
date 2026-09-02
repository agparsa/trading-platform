-- CreateEnum
CREATE TYPE "CredentialKind" AS ENUM ('API_KEY', 'SERVICE_TOKEN');

-- CreateTable
CREATE TABLE "api_keys" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "secret_hash" TEXT NOT NULL,
    "permissions" TEXT[],
    "rate_limit_per_minute" INTEGER NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "last_used_at" TIMESTAMPTZ(6),
    "last_used_ip" TEXT,
    "revoked_at" TIMESTAMPTZ(6),
    "revoked_by_id" UUID,
    "revoked_reason" TEXT,
    "created_from_ip" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_tokens" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "fingerprint" TEXT NOT NULL,
    "secret_hash" TEXT NOT NULL,
    "permissions" TEXT[],
    "rate_limit_per_minute" INTEGER NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "last_used_at" TIMESTAMPTZ(6),
    "last_used_ip" TEXT,
    "revoked_at" TIMESTAMPTZ(6),
    "revoked_by_id" UUID,
    "revoked_reason" TEXT,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "service_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credential_usage" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "kind" "CredentialKind" NOT NULL,
    "credential_id" UUID NOT NULL,
    "day" DATE NOT NULL,
    "requests" INTEGER NOT NULL DEFAULT 0,
    "refused" INTEGER NOT NULL DEFAULT 0,
    "throttled" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "credential_usage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "api_keys_fingerprint_key" ON "api_keys"("fingerprint");

-- CreateIndex
CREATE INDEX "api_keys_user_id_created_at_idx" ON "api_keys"("user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "api_keys_tenant_id_idx" ON "api_keys"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "service_tokens_fingerprint_key" ON "service_tokens"("fingerprint");

-- CreateIndex
CREATE INDEX "service_tokens_tenant_id_created_at_idx" ON "service_tokens"("tenant_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "credential_usage_tenant_id_idx" ON "credential_usage"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "credential_usage_kind_credential_id_day_key" ON "credential_usage"("kind", "credential_id", "day");

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_tokens" ADD CONSTRAINT "service_tokens_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_tokens" ADD CONSTRAINT "service_tokens_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credential_usage" ADD CONSTRAINT "credential_usage_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;



-- Tenant isolation, at the database as well as in the application.
ALTER TABLE "api_keys" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "api_keys_tenant_isolation" ON "api_keys";
CREATE POLICY "api_keys_tenant_isolation" ON "api_keys"
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

ALTER TABLE "service_tokens" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_tokens_tenant_isolation" ON "service_tokens";
CREATE POLICY "service_tokens_tenant_isolation" ON "service_tokens"
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

ALTER TABLE "credential_usage" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "credential_usage_tenant_isolation" ON "credential_usage";
CREATE POLICY "credential_usage_tenant_isolation" ON "credential_usage"
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- A credential is what it was minted as. Its holder, its name to the platform,
-- its hash, what it may do and when it dies are fixed at minting: a key whose
-- permissions could be widened afterwards is a key whose audit row at minting
-- describes something else. Only use, revocation and the display name move.
CREATE OR REPLACE FUNCTION api_keys_minted_fixed()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.tenant_id      IS DISTINCT FROM OLD.tenant_id
  OR NEW.user_id        IS DISTINCT FROM OLD.user_id
  OR NEW.fingerprint    IS DISTINCT FROM OLD.fingerprint
  OR NEW.secret_hash    IS DISTINCT FROM OLD.secret_hash
  OR NEW.permissions    IS DISTINCT FROM OLD.permissions
  OR NEW.expires_at     IS DISTINCT FROM OLD.expires_at
  OR NEW.created_from_ip IS DISTINCT FROM OLD.created_from_ip
  OR NEW.created_at     IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'api_keys: a key is what it was minted as; mint another'
      USING ERRCODE = '42501';
  END IF;
  -- Revocation happens once.
  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
    RAISE EXCEPTION 'api_keys: a revocation cannot be undone or replaced'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS api_keys_minted_fixed ON "api_keys";
CREATE TRIGGER api_keys_minted_fixed
  BEFORE UPDATE ON "api_keys"
  FOR EACH ROW EXECUTE FUNCTION api_keys_minted_fixed();

CREATE OR REPLACE FUNCTION service_tokens_minted_fixed()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.tenant_id      IS DISTINCT FROM OLD.tenant_id
  OR NEW.fingerprint    IS DISTINCT FROM OLD.fingerprint
  OR NEW.secret_hash    IS DISTINCT FROM OLD.secret_hash
  OR NEW.permissions    IS DISTINCT FROM OLD.permissions
  OR NEW.expires_at     IS DISTINCT FROM OLD.expires_at
  OR NEW.created_by_id  IS DISTINCT FROM OLD.created_by_id
  OR NEW.created_at     IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'service_tokens: a token is what it was minted as; mint another'
      USING ERRCODE = '42501';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
    RAISE EXCEPTION 'service_tokens: a revocation cannot be undone or replaced'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS service_tokens_minted_fixed ON "service_tokens";
CREATE TRIGGER service_tokens_minted_fixed
  BEFORE UPDATE ON "service_tokens"
  FOR EACH ROW EXECUTE FUNCTION service_tokens_minted_fixed();

-- A credential that existed is part of the record of who could do what. It is
-- revoked, never removed: a deleted key is a gap where an audit row points.
CREATE OR REPLACE FUNCTION credentials_never_deleted()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '%: credentials are revoked, never deleted', TG_TABLE_NAME
    USING ERRCODE = '42501';
END;
$$;

DROP TRIGGER IF EXISTS api_keys_never_deleted ON "api_keys";
CREATE TRIGGER api_keys_never_deleted
  BEFORE DELETE ON "api_keys"
  FOR EACH ROW EXECUTE FUNCTION credentials_never_deleted();

DROP TRIGGER IF EXISTS service_tokens_never_deleted ON "service_tokens";
CREATE TRIGGER service_tokens_never_deleted
  BEFORE DELETE ON "service_tokens"
  FOR EACH ROW EXECUTE FUNCTION credentials_never_deleted();
