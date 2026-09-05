-- CreateEnum
CREATE TYPE "OutboxStatus" AS ENUM ('PENDING', 'RELAYED', 'ABANDONED');

-- CreateEnum
CREATE TYPE "InboundStatus" AS ENUM ('PENDING', 'APPLIED', 'SKIPPED', 'FAILED');

-- AlterTable
ALTER TABLE "accounts" ADD COLUMN     "broker_connection_id" UUID,
ADD COLUMN     "execution_mode" "ExecutionMode" NOT NULL DEFAULT 'INTERNAL',
ADD COLUMN     "external_account_id" TEXT;

-- AlterTable
ALTER TABLE "executions" ADD COLUMN     "external_execution_id" TEXT;

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "client_order_id" TEXT,
ADD COLUMN     "external_order_id" TEXT;

-- AlterTable
ALTER TABLE "positions" ADD COLUMN     "external_position_id" TEXT;

-- CreateTable
CREATE TABLE "broker_instrument_mappings" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "symbol_id" UUID NOT NULL,
    "external_symbol" TEXT NOT NULL,
    "contract_size" DECIMAL(28,10),
    "volume_step" DECIMAL(18,8),
    "min_volume" DECIMAL(18,8),
    "max_volume" DECIMAL(18,8),
    "price_decimals" INTEGER,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "synced_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "broker_instrument_mappings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_events" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "event_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "aggregate_type" TEXT NOT NULL,
    "aggregate_id" TEXT NOT NULL,
    "account_id" UUID,
    "actor_id" UUID,
    "correlation_id" TEXT,
    "causation_id" TEXT,
    "payload" JSONB NOT NULL,
    "status" "OutboxStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "next_attempt_at" TIMESTAMPTZ(6),
    "relayed_at" TIMESTAMPTZ(6),
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "broker_inbound_events" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "external_event_id" TEXT NOT NULL,
    "sequence" BIGINT,
    "kind" TEXT NOT NULL,
    "external_account_id" TEXT,
    "payload" JSONB NOT NULL,
    "status" "InboundStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "applied_at" TIMESTAMPTZ(6),
    "skip_reason" TEXT,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "broker_inbound_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "broker_instrument_mappings_tenant_id_idx" ON "broker_instrument_mappings"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "broker_instrument_mappings_connection_id_symbol_id_key" ON "broker_instrument_mappings"("connection_id", "symbol_id");

-- CreateIndex
CREATE UNIQUE INDEX "broker_instrument_mappings_connection_id_external_symbol_key" ON "broker_instrument_mappings"("connection_id", "external_symbol");

-- CreateIndex
CREATE UNIQUE INDEX "outbox_events_event_id_key" ON "outbox_events"("event_id");

-- CreateIndex
CREATE INDEX "outbox_events_status_next_attempt_at_idx" ON "outbox_events"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "outbox_events_tenant_id_occurred_at_idx" ON "outbox_events"("tenant_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "outbox_events_aggregate_type_aggregate_id_idx" ON "outbox_events"("aggregate_type", "aggregate_id");

-- CreateIndex
CREATE INDEX "broker_inbound_events_status_received_at_idx" ON "broker_inbound_events"("status", "received_at");

-- CreateIndex
CREATE INDEX "broker_inbound_events_connection_id_sequence_idx" ON "broker_inbound_events"("connection_id", "sequence");

-- CreateIndex
CREATE INDEX "broker_inbound_events_tenant_id_idx" ON "broker_inbound_events"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "broker_inbound_events_connection_id_external_event_id_key" ON "broker_inbound_events"("connection_id", "external_event_id");

-- CreateIndex
CREATE UNIQUE INDEX "accounts_broker_connection_id_external_account_id_key" ON "accounts"("broker_connection_id", "external_account_id");

-- CreateIndex
CREATE UNIQUE INDEX "executions_external_execution_id_key" ON "executions"("external_execution_id");

-- CreateIndex
CREATE UNIQUE INDEX "orders_client_order_id_key" ON "orders"("client_order_id");

-- CreateIndex
CREATE UNIQUE INDEX "positions_external_position_id_key" ON "positions"("external_position_id");

-- AddForeignKey
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_broker_connection_id_fkey" FOREIGN KEY ("broker_connection_id") REFERENCES "broker_connections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "broker_instrument_mappings" ADD CONSTRAINT "broker_instrument_mappings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "broker_instrument_mappings" ADD CONSTRAINT "broker_instrument_mappings_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "broker_connections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "broker_instrument_mappings" ADD CONSTRAINT "broker_instrument_mappings_symbol_id_fkey" FOREIGN KEY ("symbol_id") REFERENCES "symbols"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "broker_inbound_events" ADD CONSTRAINT "broker_inbound_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "broker_inbound_events" ADD CONSTRAINT "broker_inbound_events_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "broker_connections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Tenant isolation, at the database as well as in the application.
ALTER TABLE "broker_instrument_mappings" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "broker_instrument_mappings_tenant_isolation" ON "broker_instrument_mappings";
CREATE POLICY "broker_instrument_mappings_tenant_isolation" ON "broker_instrument_mappings"
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
ALTER TABLE "outbox_events" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "outbox_events_tenant_isolation" ON "outbox_events";
CREATE POLICY "outbox_events_tenant_isolation" ON "outbox_events"
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
ALTER TABLE "broker_inbound_events" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "broker_inbound_events_tenant_isolation" ON "broker_inbound_events";
CREATE POLICY "broker_inbound_events_tenant_isolation" ON "broker_inbound_events"
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- An account executes at a venue, or it does not. Half a migration — a mode
-- with no connection, or a connection with no mode — is a state in which an
-- order has nowhere to go, and it is cheaper to refuse it here than to
-- discover it on the order path.
ALTER TABLE "accounts" DROP CONSTRAINT IF EXISTS "accounts_execution_mode_consistent";
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_execution_mode_consistent" CHECK (
  (execution_mode = 'INTERNAL' AND broker_connection_id IS NULL)
  OR (execution_mode = 'EXTERNAL_BROKER' AND broker_connection_id IS NOT NULL)
);

-- What a venue said happened is evidence. It is corrected by a later event,
-- never by editing the record of the earlier one, and it is never deleted:
-- an investigation a week later needs what the venue actually sent.
CREATE OR REPLACE FUNCTION broker_inbound_events_are_evidence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'broker_inbound_events: what a venue sent is evidence and is not deleted'
      USING ERRCODE = '42501';
  END IF;
  IF NEW.connection_id      IS DISTINCT FROM OLD.connection_id
  OR NEW.tenant_id          IS DISTINCT FROM OLD.tenant_id
  OR NEW.external_event_id  IS DISTINCT FROM OLD.external_event_id
  OR NEW.payload            IS DISTINCT FROM OLD.payload
  OR NEW.kind               IS DISTINCT FROM OLD.kind
  OR NEW.occurred_at        IS DISTINCT FROM OLD.occurred_at
  OR NEW.received_at        IS DISTINCT FROM OLD.received_at THEN
    RAISE EXCEPTION 'broker_inbound_events: what a venue sent does not change; only how we handled it does'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS broker_inbound_events_no_delete ON broker_inbound_events;
CREATE TRIGGER broker_inbound_events_no_delete
  BEFORE DELETE ON broker_inbound_events
  FOR EACH ROW EXECUTE FUNCTION broker_inbound_events_are_evidence();
DROP TRIGGER IF EXISTS broker_inbound_events_payload_fixed ON broker_inbound_events;
CREATE TRIGGER broker_inbound_events_payload_fixed
  BEFORE UPDATE ON broker_inbound_events
  FOR EACH ROW EXECUTE FUNCTION broker_inbound_events_are_evidence();

-- An outbox row describes something that happened. Its content is fixed;
-- only the relay's own bookkeeping moves.
CREATE OR REPLACE FUNCTION outbox_events_content_fixed()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.tenant_id      IS DISTINCT FROM OLD.tenant_id
  OR NEW.event_id       IS DISTINCT FROM OLD.event_id
  OR NEW.event_type     IS DISTINCT FROM OLD.event_type
  OR NEW.aggregate_type IS DISTINCT FROM OLD.aggregate_type
  OR NEW.aggregate_id   IS DISTINCT FROM OLD.aggregate_id
  OR NEW.payload        IS DISTINCT FROM OLD.payload
  OR NEW.occurred_at    IS DISTINCT FROM OLD.occurred_at THEN
    RAISE EXCEPTION 'outbox_events: an event describes what happened; only the relay''s bookkeeping moves'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS outbox_events_content_fixed ON outbox_events;
CREATE TRIGGER outbox_events_content_fixed
  BEFORE UPDATE ON outbox_events
  FOR EACH ROW EXECUTE FUNCTION outbox_events_content_fixed();
