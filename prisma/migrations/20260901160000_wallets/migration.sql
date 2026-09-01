-- Money that belongs to a person rather than to a trading account.
--
-- The plan for this phase said in one line why a second ledger is dangerous: two
-- ledgers that both believe they are authoritative is the classic way to lose
-- money in an accounting system. These two are not authoritative for the same
-- thing.
--
--   * `balance_ledger` is authoritative for what is inside a trading account.
--   * `wallet_transactions` is authoritative for what is held for a person and
--     is in no trading account.
--
-- A transfer writes one row on each side inside one transaction, and the two
-- amounts sum to zero. Nothing else may write either balance.
--
-- `NUMERIC(28,10)` throughout, like every other money column here, and
-- `scripts/assert-no-float-columns.ts` fails the build if that ever slips.

CREATE TYPE "WalletStatus" AS ENUM ('ACTIVE', 'FROZEN');
CREATE TYPE "WalletTransactionType" AS ENUM (
    'DEPOSIT', 'WITHDRAWAL', 'TRANSFER_IN', 'TRANSFER_OUT', 'ADJUSTMENT', 'FEE'
);

CREATE TABLE "wallets" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "balance" DECIMAL(28,10) NOT NULL DEFAULT 0,
    "status" "WalletStatus" NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "wallets_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "wallet_transactions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "wallet_id" UUID NOT NULL,
    "type" "WalletTransactionType" NOT NULL,
    "amount" DECIMAL(28,10) NOT NULL,
    "balance_after" DECIMAL(28,10) NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "account_id" UUID,
    "ledger_entry_id" UUID,
    "reference_type" TEXT,
    "reference_id" UUID,
    "compensates_id" UUID,
    "idempotency_key" TEXT,
    "description" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wallet_transactions_pkey" PRIMARY KEY ("id")
);

-- One wallet per person per currency. A wallet holding two currencies would
-- need a rate to state its balance, and a balance that moves when nobody moved
-- any money is not a balance.
CREATE UNIQUE INDEX "wallets_user_id_currency_key" ON "wallets"("user_id", "currency");
CREATE INDEX "wallets_tenant_id_idx" ON "wallets"("tenant_id");

CREATE UNIQUE INDEX "wallet_transactions_idempotency_key_key" ON "wallet_transactions"("idempotency_key");
CREATE INDEX "wallet_transactions_wallet_id_created_at_idx" ON "wallet_transactions"("wallet_id", "created_at" DESC);
CREATE INDEX "wallet_transactions_account_id_idx" ON "wallet_transactions"("account_id");
CREATE INDEX "wallet_transactions_tenant_id_idx" ON "wallet_transactions"("tenant_id");

ALTER TABLE "wallets" ADD CONSTRAINT "wallets_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_wallet_id_fkey"
    FOREIGN KEY ("wallet_id") REFERENCES "wallets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Both tables carry a tenant_id, so both need a policy — `rls-enforcement.test.ts`
-- fails the build over a table that does not, and these hold money.
ALTER TABLE "wallets" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "wallets_tenant_isolation" ON "wallets";
CREATE POLICY "wallets_tenant_isolation" ON "wallets"
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

ALTER TABLE "wallet_transactions" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "wallet_transactions_tenant_isolation" ON "wallet_transactions";
CREATE POLICY "wallet_transactions_tenant_isolation" ON "wallet_transactions"
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- The same trigger the balance ledger has: a wallet movement is a financial
-- record, and correcting history in one destroys what an auditor needs. A
-- correction is a compensating row, which is why `compensates_id` exists.
CREATE OR REPLACE FUNCTION wallet_transactions_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'wallet_transactions is append-only; post a compensating row instead'
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER wallet_transactions_no_update
  BEFORE UPDATE OR DELETE ON "wallet_transactions"
  FOR EACH ROW EXECUTE FUNCTION wallet_transactions_append_only();
