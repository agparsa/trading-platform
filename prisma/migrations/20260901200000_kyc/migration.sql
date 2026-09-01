-- CreateEnum
CREATE TYPE "KycStatus" AS ENUM ('NOT_STARTED', 'PENDING', 'UNDER_REVIEW', 'VERIFIED', 'REJECTED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "KycDocumentKind" AS ENUM ('PASSPORT', 'NATIONAL_ID', 'DRIVING_LICENCE', 'PROOF_OF_ADDRESS', 'SELFIE');

-- CreateTable
CREATE TABLE "kyc_records" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "status" "KycStatus" NOT NULL DEFAULT 'NOT_STARTED',
    "provider" TEXT NOT NULL DEFAULT 'manual',
    "provider_reference" TEXT,
    "reason" TEXT,
    "reviewer_id" UUID,
    "decided_by_id" UUID,
    "decided_at" TIMESTAMPTZ(6),
    "submitted_at" TIMESTAMPTZ(6),
    "verified_at" TIMESTAMPTZ(6),
    "expires_at" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "kyc_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kyc_documents" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "record_id" UUID NOT NULL,
    "kind" "KycDocumentKind" NOT NULL,
    "content_type" TEXT NOT NULL,
    "sha256" VARCHAR(64) NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "filename" TEXT,
    "content" BYTEA,
    "sealed_with_key_id" TEXT,
    "uploaded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "purged_at" TIMESTAMPTZ(6),

    CONSTRAINT "kyc_documents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "kyc_records_user_id_key" ON "kyc_records"("user_id");

-- CreateIndex
CREATE INDEX "kyc_records_status_submitted_at_idx" ON "kyc_records"("status", "submitted_at");

-- CreateIndex
CREATE INDEX "kyc_records_tenant_id_idx" ON "kyc_records"("tenant_id");

-- CreateIndex
CREATE INDEX "kyc_documents_record_id_idx" ON "kyc_documents"("record_id");

-- CreateIndex
CREATE INDEX "kyc_documents_tenant_id_idx" ON "kyc_documents"("tenant_id");

-- AddForeignKey
ALTER TABLE "kyc_records" ADD CONSTRAINT "kyc_records_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kyc_records" ADD CONSTRAINT "kyc_records_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kyc_documents" ADD CONSTRAINT "kyc_documents_record_id_fkey" FOREIGN KEY ("record_id") REFERENCES "kyc_records"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kyc_documents" ADD CONSTRAINT "kyc_documents_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Tenant isolation, at the database as well as in the application.
ALTER TABLE "kyc_records" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "kyc_records_tenant_isolation" ON "kyc_records";
CREATE POLICY "kyc_records_tenant_isolation" ON "kyc_records"
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

ALTER TABLE "kyc_documents" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "kyc_documents_tenant_isolation" ON "kyc_documents";
CREATE POLICY "kyc_documents_tenant_isolation" ON "kyc_documents"
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- A document's identity is fixed at upload. The only edit the platform ever
-- makes is the retention sweep clearing the bytes, and that must not be able
-- to quietly change what the document *was*: its kind, its hash, its size and
-- its upload time stay exactly as they were, so the record still stands after
-- the bytes are gone.
CREATE OR REPLACE FUNCTION kyc_documents_identity_fixed()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.record_id      IS DISTINCT FROM OLD.record_id
  OR NEW.tenant_id      IS DISTINCT FROM OLD.tenant_id
  OR NEW.kind           IS DISTINCT FROM OLD.kind
  OR NEW.content_type   IS DISTINCT FROM OLD.content_type
  OR NEW.sha256         IS DISTINCT FROM OLD.sha256
  OR NEW.size_bytes     IS DISTINCT FROM OLD.size_bytes
  OR NEW.uploaded_at    IS DISTINCT FROM OLD.uploaded_at THEN
    RAISE EXCEPTION 'kyc_documents: a document''s identity cannot be edited after upload'
      USING ERRCODE = '42501';
  END IF;
  -- Bytes may be cleared, never replaced.
  IF OLD.content IS NULL AND NEW.content IS NOT NULL THEN
    RAISE EXCEPTION 'kyc_documents: a purged document cannot be given new bytes'
      USING ERRCODE = '42501';
  END IF;
  IF OLD.content IS NOT NULL AND NEW.content IS NOT NULL
     AND NEW.content IS DISTINCT FROM OLD.content
     AND NEW.sealed_with_key_id IS NOT DISTINCT FROM OLD.sealed_with_key_id THEN
    RAISE EXCEPTION 'kyc_documents: a document''s bytes cannot be replaced'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS kyc_documents_identity_fixed ON "kyc_documents";
CREATE TRIGGER kyc_documents_identity_fixed
  BEFORE UPDATE ON "kyc_documents"
  FOR EACH ROW EXECUTE FUNCTION kyc_documents_identity_fixed();

-- Deleting a document row is not how retention works: the bytes go, the row
-- stays. Nothing on the platform deletes one, and nothing may.
CREATE OR REPLACE FUNCTION kyc_documents_never_deleted()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'kyc_documents: rows are purged of their bytes, never deleted'
    USING ERRCODE = '42501';
END;
$$;

DROP TRIGGER IF EXISTS kyc_documents_never_deleted ON "kyc_documents";
CREATE TRIGGER kyc_documents_never_deleted
  BEFORE DELETE ON "kyc_documents"
  FOR EACH ROW EXECUTE FUNCTION kyc_documents_never_deleted();
