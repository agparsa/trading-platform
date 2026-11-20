-- Admin alert rules: thresholds on counts the platform keeps, evaluated by the
-- worker every minute; and the alerts they raise. See docs/admin-alerts.md.
-- CreateTable
CREATE TABLE "admin_alert_rules" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "metric" TEXT NOT NULL,
    "comparator" TEXT NOT NULL,
    "threshold" INTEGER NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "cooldown_minutes" INTEGER NOT NULL DEFAULT 60,
    "last_value" INTEGER,
    "last_evaluated_at" TIMESTAMPTZ(6),
    "in_breach" BOOLEAN NOT NULL DEFAULT false,
    "last_raised_at" TIMESTAMPTZ(6),
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "admin_alert_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_alerts" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "rule_id" UUID NOT NULL,
    "rule_name" TEXT NOT NULL,
    "metric" TEXT NOT NULL,
    "comparator" TEXT NOT NULL,
    "threshold" INTEGER NOT NULL,
    "value" INTEGER NOT NULL,
    "raised_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledged_at" TIMESTAMPTZ(6),
    "acknowledged_by_id" UUID,
    "note" TEXT,

    CONSTRAINT "admin_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "admin_alert_rules_tenant_id_idx" ON "admin_alert_rules"("tenant_id");

-- CreateIndex
CREATE INDEX "admin_alert_rules_enabled_idx" ON "admin_alert_rules"("enabled");

-- CreateIndex
CREATE UNIQUE INDEX "admin_alert_rules_tenant_id_name_key" ON "admin_alert_rules"("tenant_id", "name");

-- CreateIndex
CREATE INDEX "admin_alerts_tenant_id_acknowledged_at_raised_at_idx" ON "admin_alerts"("tenant_id", "acknowledged_at", "raised_at" DESC);

-- CreateIndex
CREATE INDEX "admin_alerts_rule_id_idx" ON "admin_alerts"("rule_id");

-- AddForeignKey
ALTER TABLE "admin_alert_rules" ADD CONSTRAINT "admin_alert_rules_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_alerts" ADD CONSTRAINT "admin_alerts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_alerts" ADD CONSTRAINT "admin_alerts_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "admin_alert_rules"("id") ON DELETE CASCADE ON UPDATE CASCADE;


ALTER TABLE "admin_alert_rules" ADD CONSTRAINT "admin_alert_rules_comparator_known"
  CHECK ("comparator" IN ('ABOVE', 'BELOW'));
ALTER TABLE "admin_alert_rules" ADD CONSTRAINT "admin_alert_rules_threshold_not_negative"
  CHECK ("threshold" >= 0);
ALTER TABLE "admin_alert_rules" ADD CONSTRAINT "admin_alert_rules_cooldown_sane"
  CHECK ("cooldown_minutes" BETWEEN 1 AND 10080);
ALTER TABLE "admin_alert_rules" ADD CONSTRAINT "admin_alert_rules_name_not_empty"
  CHECK (length(btrim("name")) > 0);

-- Row-level security, as on every tenant-scoped table.
ALTER TABLE "admin_alert_rules" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "admin_alert_rules_tenant_isolation" ON "admin_alert_rules";
CREATE POLICY "admin_alert_rules_tenant_isolation" ON "admin_alert_rules"
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

ALTER TABLE "admin_alerts" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "admin_alerts_tenant_isolation" ON "admin_alerts";
CREATE POLICY "admin_alerts_tenant_isolation" ON "admin_alerts"
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
