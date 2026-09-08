-- "Tell me when gold reaches 4600."
--
-- An alert belongs to a person rather than to an account: a trader watching a
-- level is watching the market, and wants to hear about it whether or not they
-- happen to hold a position at the time.
--
-- `price` is NUMERIC like every other price here. A level a trader typed has to
-- be compared as they typed it — an alert set at 4600 that fires at 4599.9999
-- because the level became a float is a bug nobody can explain to them.
--
-- One alert fires once, which is why there is a status rather than a boolean.
-- A level crossed back and forth in a volatile minute would otherwise produce a
-- notification per oscillation, which is how a trader learns to ignore them.
CREATE TYPE "PriceAlertCondition" AS ENUM ('ABOVE', 'BELOW');
CREATE TYPE "PriceAlertSource" AS ENUM ('BID', 'ASK', 'MID');
CREATE TYPE "PriceAlertStatus" AS ENUM ('ACTIVE', 'TRIGGERED', 'CANCELLED', 'EXPIRED');

CREATE TABLE "price_alerts" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "symbol" TEXT NOT NULL,
    "condition" "PriceAlertCondition" NOT NULL,
    "source" "PriceAlertSource" NOT NULL DEFAULT 'BID',
    "price" DECIMAL(24,10) NOT NULL,
    "status" "PriceAlertStatus" NOT NULL DEFAULT 'ACTIVE',
    "note" TEXT,
    "expires_at" TIMESTAMPTZ(6),
    "triggered_at" TIMESTAMPTZ(6),
    "triggered_price" DECIMAL(24,10),
    "notification_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "price_alerts_pkey" PRIMARY KEY ("id")
);

-- A level has to be a positive number. The API validates it too; this is the
-- statement that stays true when something writes around the API.
ALTER TABLE "price_alerts" ADD CONSTRAINT "price_alerts_price_positive" CHECK ("price" > 0);

-- A triggered alert has to say when and at what. Half a record of a firing is
-- worse than none: it looks like evidence and cannot be used as any.
ALTER TABLE "price_alerts" ADD CONSTRAINT "price_alerts_triggered_is_complete"
  CHECK (
    ("status" <> 'TRIGGERED')
    OR ("triggered_at" IS NOT NULL AND "triggered_price" IS NOT NULL)
  );

-- The evaluation sweep's only query: active alerts on one instrument, asked on
-- every tick. Partial, because triggered alerts accumulate for ever and the
-- sweep never reads one.
CREATE INDEX "price_alerts_symbol_status_idx" ON "price_alerts"("symbol", "status");
CREATE INDEX "price_alerts_user_id_status_created_at_idx"
  ON "price_alerts"("user_id", "status", "created_at" DESC);
CREATE INDEX "price_alerts_tenant_id_idx" ON "price_alerts"("tenant_id");

ALTER TABLE "price_alerts" ADD CONSTRAINT "price_alerts_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "price_alerts" ADD CONSTRAINT "price_alerts_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Row-level security, as on every tenant-scoped table.
ALTER TABLE "price_alerts" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "price_alerts_tenant_isolation" ON "price_alerts";
CREATE POLICY "price_alerts_tenant_isolation" ON "price_alerts"
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
