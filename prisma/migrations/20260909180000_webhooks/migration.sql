-- Webhooks (§49): where a firm has asked to be told about its own events, and
-- the log of every attempt to tell it.
--
-- The endpoint's secret is sealed with the platform's key list and shown once.
-- A delivery is one event to one endpoint, created when the outbox relay hands
-- the event on and updated by each attempt; a replay is a new row pointing at
-- the one it repeats, so the log shows both what happened and that somebody
-- asked for it again. Nothing here is ever deleted by the platform: an event
-- that could not be delivered is EXHAUSTED and kept for a person to look at.
-- CreateEnum
CREATE TYPE "WebhookDeliveryStatus" AS ENUM ('PENDING', 'DELIVERED', 'FAILED', 'EXHAUSTED');

-- CreateTable
CREATE TABLE "webhook_endpoints" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "url" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "secret_sealed" TEXT NOT NULL,
    "secret_hint" TEXT NOT NULL,
    "previous_secret_sealed" TEXT,
    "previous_secret_expires_at" TIMESTAMPTZ(6),
    "events" TEXT[],
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "disabled_at" TIMESTAMPTZ(6),
    "disabled_reason" TEXT,
    "consecutive_failures" INTEGER NOT NULL DEFAULT 0,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "webhook_endpoints_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_deliveries" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "endpoint_id" UUID NOT NULL,
    "outbox_event_id" UUID NOT NULL,
    "event_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "status" "WebhookDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(6),
    "last_attempt_at" TIMESTAMPTZ(6),
    "delivered_at" TIMESTAMPTZ(6),
    "response_status" INTEGER,
    "response_body" TEXT,
    "last_error" TEXT,
    "duration_ms" INTEGER,
    "replay_of_id" UUID,
    "requested_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "webhook_endpoints_tenant_id_enabled_idx" ON "webhook_endpoints"("tenant_id", "enabled");

-- CreateIndex
CREATE INDEX "webhook_deliveries_status_next_attempt_at_idx" ON "webhook_deliveries"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "webhook_deliveries_tenant_id_endpoint_id_created_at_idx" ON "webhook_deliveries"("tenant_id", "endpoint_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "webhook_deliveries_tenant_id_event_id_idx" ON "webhook_deliveries"("tenant_id", "event_id");

-- AddForeignKey
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_endpoint_id_fkey" FOREIGN KEY ("endpoint_id") REFERENCES "webhook_endpoints"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_outbox_event_id_fkey" FOREIGN KEY ("outbox_event_id") REFERENCES "outbox_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_replay_of_id_fkey" FOREIGN KEY ("replay_of_id") REFERENCES "webhook_deliveries"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- The URL is checked by the API before it is stored, and the address it
-- resolves to is checked again at delivery. These constraints are the floor
-- under both: an empty description is a webhook nobody can explain, and a
-- hint longer than a handful of characters is a secret being leaked slowly.
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_description_not_empty"
  CHECK (length(btrim("description")) > 0);
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_secret_hint_short"
  CHECK (length("secret_hint") <= 4);
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_attempts_non_negative"
  CHECK ("attempts" >= 0);

-- One original delivery per (endpoint, event). Replays are not bound by this;
-- a person may ask for the same event as often as they need.
CREATE UNIQUE INDEX "webhook_deliveries_original_key"
  ON "webhook_deliveries"("endpoint_id", "outbox_event_id") WHERE "replay_of_id" IS NULL;

-- Row-level security, as on every tenant-scoped table. One firm's endpoints
-- and delivery log are not another's to read.
ALTER TABLE "webhook_endpoints" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "webhook_endpoints_tenant_isolation" ON "webhook_endpoints";
CREATE POLICY "webhook_endpoints_tenant_isolation" ON "webhook_endpoints"
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

ALTER TABLE "webhook_deliveries" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "webhook_deliveries_tenant_isolation" ON "webhook_deliveries";
CREATE POLICY "webhook_deliveries_tenant_isolation" ON "webhook_deliveries"
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
