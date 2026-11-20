-- Commission schedules: named per-lot rates an account can be assigned instead
-- of the firm's standard terms. Only commission; swap and margin stay the
-- instrument's. See docs/fees.md.
-- AlterTable
ALTER TABLE "accounts" ADD COLUMN     "fee_schedule_id" UUID;

-- CreateTable
CREATE TABLE "fee_schedules" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "note" TEXT,
    "default_commission_per_lot" DECIMAL(28,10),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "fee_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fee_rules" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "schedule_id" UUID NOT NULL,
    "symbol_id" UUID NOT NULL,
    "commission_per_lot" DECIMAL(28,10) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "fee_rules_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "fee_schedules_tenant_id_idx" ON "fee_schedules"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "fee_schedules_tenant_id_name_key" ON "fee_schedules"("tenant_id", "name");

-- CreateIndex
CREATE INDEX "fee_rules_tenant_id_idx" ON "fee_rules"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "fee_rules_schedule_id_symbol_id_key" ON "fee_rules"("schedule_id", "symbol_id");

-- AddForeignKey
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_fee_schedule_id_fkey" FOREIGN KEY ("fee_schedule_id") REFERENCES "fee_schedules"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_schedules" ADD CONSTRAINT "fee_schedules_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_rules" ADD CONSTRAINT "fee_rules_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_rules" ADD CONSTRAINT "fee_rules_schedule_id_fkey" FOREIGN KEY ("schedule_id") REFERENCES "fee_schedules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_rules" ADD CONSTRAINT "fee_rules_symbol_id_fkey" FOREIGN KEY ("symbol_id") REFERENCES "symbols"("id") ON DELETE CASCADE ON UPDATE CASCADE;


CREATE INDEX "accounts_fee_schedule_id_idx" ON "accounts"("fee_schedule_id");

-- A rebate is not modelled, so a negative rate would be an undeclared one.
ALTER TABLE "fee_schedules" ADD CONSTRAINT "fee_schedules_default_not_negative"
  CHECK ("default_commission_per_lot" IS NULL OR "default_commission_per_lot" >= 0);
ALTER TABLE "fee_schedules" ADD CONSTRAINT "fee_schedules_name_not_empty"
  CHECK (length(btrim("name")) > 0);
ALTER TABLE "fee_rules" ADD CONSTRAINT "fee_rules_commission_not_negative"
  CHECK ("commission_per_lot" >= 0);

-- Row-level security, as on every tenant-scoped table.
ALTER TABLE "fee_schedules" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "fee_schedules_tenant_isolation" ON "fee_schedules";
CREATE POLICY "fee_schedules_tenant_isolation" ON "fee_schedules"
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

ALTER TABLE "fee_rules" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "fee_rules_tenant_isolation" ON "fee_rules";
CREATE POLICY "fee_rules_tenant_isolation" ON "fee_rules"
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
