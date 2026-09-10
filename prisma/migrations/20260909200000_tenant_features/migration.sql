-- Feature flags per firm (§95). A row overrides the catalogue default for one
-- flag; no row means the default. Who may write a flag is decided by its
-- authority in the catalogue, and the authority is copied onto the row so the
-- row says who was allowed to write it.
-- CreateTable
CREATE TABLE "tenant_features" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "authority" TEXT NOT NULL,
    "note" TEXT NOT NULL,
    "updated_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "tenant_features_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tenant_features_tenant_id_key_key" ON "tenant_features"("tenant_id", "key");

-- AddForeignKey
ALTER TABLE "tenant_features" ADD CONSTRAINT "tenant_features_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


ALTER TABLE "tenant_features" ADD CONSTRAINT "tenant_features_note_not_empty"
  CHECK (length(btrim("note")) > 0);
ALTER TABLE "tenant_features" ADD CONSTRAINT "tenant_features_authority_known"
  CHECK ("authority" IN ('PLATFORM', 'FIRM'));

-- Row-level security, as on every tenant-scoped table. The platform sets a
-- broker's platform-authority flags by entering that broker's scope, never by
-- reaching across from its own.
ALTER TABLE "tenant_features" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_features_tenant_isolation" ON "tenant_features";
CREATE POLICY "tenant_features_tenant_isolation" ON "tenant_features"
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
