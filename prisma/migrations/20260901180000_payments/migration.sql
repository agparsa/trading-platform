-- Payments: intents, their state, and every webhook that was ever delivered.
--
-- Provider-agnostic, because choosing a provider is a commercial decision and
-- the implementation plan says so in as many words. What lives here is the part
-- that does not change when the contract does: what a payment can be, what it
-- may become, and the constraint that makes a re-delivered webhook harmless.
--
-- That constraint is `payment_events(provider, provider_event_id)`. A provider
-- *will* deliver the same event twice — after a timeout, after a retry, after
-- its own outage — and the second insert must fail rather than the second credit
-- succeeding. It is a unique index rather than a check in code because the two
-- deliveries can be in flight at the same moment on two API instances, and only
-- the database can settle that.

CREATE TYPE "PaymentStatus" AS ENUM (
    'REQUIRES_ACTION', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'EXPIRED'
);

CREATE TABLE "payment_intents" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "provider_reference" TEXT,
    "amount" DECIMAL(28,10) NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'REQUIRES_ACTION',
    "instructions" TEXT,
    "wallet_transaction_id" UUID,
    "failure_reason" TEXT,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "settled_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "payment_intents_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "payment_events" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "intent_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "provider_event_id" TEXT NOT NULL,
    "provider_status" TEXT NOT NULL,
    "status" "PaymentStatus" NOT NULL,
    "outcome" TEXT NOT NULL,
    "note" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_events_pkey" PRIMARY KEY ("id")
);

-- A provider's own reference identifies one payment. Two intents claiming the
-- same one is a mapping bug, and finding out at the constraint beats finding out
-- when a webhook credits the wrong person.
CREATE UNIQUE INDEX "payment_intents_provider_provider_reference_key"
    ON "payment_intents"("provider", "provider_reference");
CREATE INDEX "payment_intents_user_id_created_at_idx"
    ON "payment_intents"("user_id", "created_at" DESC);
CREATE INDEX "payment_intents_status_idx" ON "payment_intents"("status");
CREATE INDEX "payment_intents_tenant_id_idx" ON "payment_intents"("tenant_id");

CREATE UNIQUE INDEX "payment_events_provider_provider_event_id_key"
    ON "payment_events"("provider", "provider_event_id");
CREATE INDEX "payment_events_intent_id_created_at_idx"
    ON "payment_events"("intent_id", "created_at" DESC);
CREATE INDEX "payment_events_tenant_id_idx" ON "payment_events"("tenant_id");

ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payment_events" ADD CONSTRAINT "payment_events_intent_id_fkey"
    FOREIGN KEY ("intent_id") REFERENCES "payment_intents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payment_events" ADD CONSTRAINT "payment_events_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "payment_intents" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "payment_intents_tenant_isolation" ON "payment_intents";
CREATE POLICY "payment_intents_tenant_isolation" ON "payment_intents"
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

ALTER TABLE "payment_events" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "payment_events_tenant_isolation" ON "payment_events";
CREATE POLICY "payment_events_tenant_isolation" ON "payment_events"
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- What a provider told us is not ours to edit.
CREATE OR REPLACE FUNCTION payment_events_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'payment_events is append-only; it records what a provider said'
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER payment_events_no_update
  BEFORE UPDATE OR DELETE ON "payment_events"
  FOR EACH ROW EXECUTE FUNCTION payment_events_append_only();
