-- CreateEnum
CREATE TYPE "WithdrawalStatus" AS ENUM ('REQUESTED', 'UNDER_REVIEW', 'APPROVED', 'PROCESSING', 'PAID', 'REJECTED', 'CANCELLED', 'FAILED');

-- AlterEnum
ALTER TYPE "UserRole" ADD VALUE 'FINANCE';

-- CreateTable
CREATE TABLE "withdrawal_requests" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "wallet_id" UUID NOT NULL,
    "amount" DECIMAL(28,10) NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "status" "WithdrawalStatus" NOT NULL DEFAULT 'REQUESTED',
    "destination" TEXT NOT NULL,
    "destination_hint" TEXT NOT NULL,
    "hold_transaction_id" UUID NOT NULL,
    "release_transaction_id" UUID,
    "provider" TEXT NOT NULL DEFAULT 'manual',
    "provider_reference" TEXT,
    "reason" TEXT,
    "reviewer_id" UUID,
    "approved_by_id" UUID,
    "approved_at" TIMESTAMPTZ(6),
    "auto_approved" BOOLEAN NOT NULL DEFAULT false,
    "paid_by_id" UUID,
    "decided_at" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "withdrawal_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "withdrawal_requests_hold_transaction_id_key" ON "withdrawal_requests"("hold_transaction_id");

-- CreateIndex
CREATE UNIQUE INDEX "withdrawal_requests_release_transaction_id_key" ON "withdrawal_requests"("release_transaction_id");

-- CreateIndex
CREATE INDEX "withdrawal_requests_user_id_created_at_idx" ON "withdrawal_requests"("user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "withdrawal_requests_status_created_at_idx" ON "withdrawal_requests"("status", "created_at");

-- CreateIndex
CREATE INDEX "withdrawal_requests_tenant_id_idx" ON "withdrawal_requests"("tenant_id");

-- AddForeignKey
ALTER TABLE "withdrawal_requests" ADD CONSTRAINT "withdrawal_requests_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "withdrawal_requests" ADD CONSTRAINT "withdrawal_requests_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "wallets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "withdrawal_requests" ADD CONSTRAINT "withdrawal_requests_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Tenant isolation, at the database as well as in the application.
ALTER TABLE "withdrawal_requests" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "withdrawal_requests_tenant_isolation" ON "withdrawal_requests";
CREATE POLICY "withdrawal_requests_tenant_isolation" ON "withdrawal_requests"
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- What was asked for is fixed at the asking. The amount, the currency, the
-- wallet and the hold that took the money are the facts every later decision
-- is about; an UPDATE that changed any of them would make the decision about
-- something else. Only the state, the people, the timestamps, the reason and
-- the provider's references move.
CREATE OR REPLACE FUNCTION withdrawal_requests_ask_fixed()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.user_id             IS DISTINCT FROM OLD.user_id
  OR NEW.tenant_id           IS DISTINCT FROM OLD.tenant_id
  OR NEW.wallet_id           IS DISTINCT FROM OLD.wallet_id
  OR NEW.amount              IS DISTINCT FROM OLD.amount
  OR NEW.currency            IS DISTINCT FROM OLD.currency
  OR NEW.destination         IS DISTINCT FROM OLD.destination
  OR NEW.destination_hint    IS DISTINCT FROM OLD.destination_hint
  OR NEW.hold_transaction_id IS DISTINCT FROM OLD.hold_transaction_id
  OR NEW.created_at          IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'withdrawal_requests: what was asked for cannot be edited after the asking'
      USING ERRCODE = '42501';
  END IF;
  -- The money comes back once, and never twice.
  IF OLD.release_transaction_id IS NOT NULL
     AND NEW.release_transaction_id IS DISTINCT FROM OLD.release_transaction_id THEN
    RAISE EXCEPTION 'withdrawal_requests: a release cannot be replaced'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS withdrawal_requests_ask_fixed ON "withdrawal_requests";
CREATE TRIGGER withdrawal_requests_ask_fixed
  BEFORE UPDATE ON "withdrawal_requests"
  FOR EACH ROW EXECUTE FUNCTION withdrawal_requests_ask_fixed();

-- A withdrawal is a financial record. It ends; it is not deleted.
CREATE OR REPLACE FUNCTION withdrawal_requests_never_deleted()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'withdrawal_requests: rows end in a terminal state, they are never deleted'
    USING ERRCODE = '42501';
END;
$$;

DROP TRIGGER IF EXISTS withdrawal_requests_never_deleted ON "withdrawal_requests";
CREATE TRIGGER withdrawal_requests_never_deleted
  BEFORE DELETE ON "withdrawal_requests"
  FOR EACH ROW EXECUTE FUNCTION withdrawal_requests_never_deleted();
