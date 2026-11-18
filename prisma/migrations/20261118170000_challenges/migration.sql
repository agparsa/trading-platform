-- Prop-firm evaluations: plans a firm sells, the challenges traders buy, what
-- happened to each, and the certificates a passed phase earns.
--
-- A plan's rules are copied into each challenge when it is bought, so a plan
-- edited later never changes the terms of a challenge already running. The
-- rules themselves are defined in `@tp/trading-core` `challenge-rules.ts`;
-- the checks below are the ones that must stay true however a row is written.
-- CreateEnum
CREATE TYPE "ChallengeStatus" AS ENUM ('AWAITING_PAYMENT', 'PAYMENT_REVIEW', 'ACTIVE', 'FUNDED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ChallengePhase" AS ENUM ('PHASE_ONE', 'PHASE_TWO', 'FUNDED');

-- CreateEnum
CREATE TYPE "ChallengeDrawdownMode" AS ENUM ('STATIC', 'TRAILING');

-- CreateEnum
CREATE TYPE "ChallengeDailyBasis" AS ENUM ('BALANCE', 'EQUITY', 'HIGHER');

-- CreateTable
CREATE TABLE "challenge_plans" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "steps" INTEGER NOT NULL DEFAULT 2,
    "account_size" DECIMAL(28,10) NOT NULL,
    "account_currency" VARCHAR(3) NOT NULL DEFAULT 'USD',
    "leverage" INTEGER NOT NULL DEFAULT 100,
    "price" DECIMAL(28,10) NOT NULL,
    "payment_asset" VARCHAR(12) NOT NULL,
    "payment_network" VARCHAR(40) NOT NULL,
    "payment_address" VARCHAR(256),
    "phase_one_target_pct" DECIMAL(8,4) NOT NULL,
    "phase_two_target_pct" DECIMAL(8,4),
    "daily_loss_pct" DECIMAL(8,4) NOT NULL,
    "max_loss_pct" DECIMAL(8,4) NOT NULL,
    "drawdown_mode" "ChallengeDrawdownMode" NOT NULL DEFAULT 'STATIC',
    "trailing_lock" BOOLEAN NOT NULL DEFAULT false,
    "daily_basis" "ChallengeDailyBasis" NOT NULL DEFAULT 'BALANCE',
    "min_trading_days" INTEGER NOT NULL DEFAULT 0,
    "max_days" INTEGER,
    "profit_split_pct" DECIMAL(8,4) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "challenge_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "challenges" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "status" "ChallengeStatus" NOT NULL DEFAULT 'AWAITING_PAYMENT',
    "phase" "ChallengePhase" NOT NULL DEFAULT 'PHASE_ONE',
    "plan_name" TEXT NOT NULL,
    "steps" INTEGER NOT NULL,
    "account_size" DECIMAL(28,10) NOT NULL,
    "account_currency" VARCHAR(3) NOT NULL,
    "leverage" INTEGER NOT NULL,
    "price" DECIMAL(28,10) NOT NULL,
    "payment_asset" VARCHAR(12) NOT NULL,
    "payment_network" VARCHAR(40) NOT NULL,
    "payment_address" VARCHAR(256) NOT NULL,
    "phase_one_target_pct" DECIMAL(8,4) NOT NULL,
    "phase_two_target_pct" DECIMAL(8,4),
    "daily_loss_pct" DECIMAL(8,4) NOT NULL,
    "max_loss_pct" DECIMAL(8,4) NOT NULL,
    "drawdown_mode" "ChallengeDrawdownMode" NOT NULL,
    "trailing_lock" BOOLEAN NOT NULL,
    "daily_basis" "ChallengeDailyBasis" NOT NULL,
    "min_trading_days" INTEGER NOT NULL,
    "max_days" INTEGER,
    "profit_split_pct" DECIMAL(8,4) NOT NULL,
    "transaction_hash" VARCHAR(128),
    "account_id" UUID,
    "phase_started_at" TIMESTAMPTZ(6),
    "phase_start_day" VARCHAR(10),
    "day_key" VARCHAR(10),
    "day_start_balance" DECIMAL(28,10),
    "day_start_equity" DECIMAL(28,10),
    "high_water_equity" DECIMAL(28,10),
    "last_metrics" JSONB,
    "last_evaluated_at" TIMESTAMPTZ(6),
    "failed_rule" VARCHAR(32),
    "failed_at" TIMESTAMPTZ(6),
    "funded_at" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "challenges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "challenge_events" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "challenge_id" UUID NOT NULL,
    "kind" VARCHAR(40) NOT NULL,
    "phase" "ChallengePhase" NOT NULL,
    "account_id" UUID,
    "actor_id" UUID,
    "details" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "challenge_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "challenge_certificates" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "challenge_id" UUID NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "phase" "ChallengePhase" NOT NULL,
    "trader_name" TEXT NOT NULL,
    "account_size" DECIMAL(28,10) NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "issued_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "challenge_certificates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "challenge_plans_tenant_id_is_active_idx" ON "challenge_plans"("tenant_id", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "challenges_account_id_key" ON "challenges"("account_id");

-- CreateIndex
CREATE INDEX "challenges_tenant_id_user_id_created_at_idx" ON "challenges"("tenant_id", "user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "challenges_status_idx" ON "challenges"("status");

-- CreateIndex
CREATE UNIQUE INDEX "challenges_tenant_id_transaction_hash_key" ON "challenges"("tenant_id", "transaction_hash");

-- CreateIndex
CREATE INDEX "challenge_events_challenge_id_created_at_idx" ON "challenge_events"("challenge_id", "created_at");

-- CreateIndex
CREATE INDEX "challenge_events_tenant_id_idx" ON "challenge_events"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "challenge_certificates_code_key" ON "challenge_certificates"("code");

-- CreateIndex
CREATE INDEX "challenge_certificates_tenant_id_idx" ON "challenge_certificates"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "challenge_certificates_challenge_id_phase_key" ON "challenge_certificates"("challenge_id", "phase");

-- AddForeignKey
ALTER TABLE "challenge_plans" ADD CONSTRAINT "challenge_plans_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "challenges" ADD CONSTRAINT "challenges_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "challenges" ADD CONSTRAINT "challenges_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "challenges" ADD CONSTRAINT "challenges_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "challenge_plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "challenges" ADD CONSTRAINT "challenges_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "challenge_events" ADD CONSTRAINT "challenge_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "challenge_events" ADD CONSTRAINT "challenge_events_challenge_id_fkey" FOREIGN KEY ("challenge_id") REFERENCES "challenges"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "challenge_certificates" ADD CONSTRAINT "challenge_certificates_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "challenge_certificates" ADD CONSTRAINT "challenge_certificates_challenge_id_fkey" FOREIGN KEY ("challenge_id") REFERENCES "challenges"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- A plan has to make sense whatever writes it.
ALTER TABLE "challenge_plans" ADD CONSTRAINT "challenge_plans_terms_sane" CHECK (
  "steps" IN (1, 2)
  AND "account_size" > 0 AND "price" > 0 AND "leverage" >= 1
  AND "phase_one_target_pct" > 0
  AND ("steps" = 1 OR ("phase_two_target_pct" IS NOT NULL AND "phase_two_target_pct" > 0))
  AND "daily_loss_pct" > 0 AND "daily_loss_pct" <= "max_loss_pct" AND "max_loss_pct" <= 100
  AND "min_trading_days" >= 0 AND ("max_days" IS NULL OR "max_days" >= GREATEST("min_trading_days", 1))
  AND "profit_split_pct" > 0 AND "profit_split_pct" <= 100
);

-- A failed challenge says which rule and when.
ALTER TABLE "challenges" ADD CONSTRAINT "challenges_failure_is_complete" CHECK (
  "status" <> 'FAILED' OR ("failed_rule" IS NOT NULL AND "failed_at" IS NOT NULL)
);

-- A running challenge has an account to run on.
ALTER TABLE "challenges" ADD CONSTRAINT "challenges_running_has_account" CHECK (
  "status" NOT IN ('ACTIVE', 'FUNDED') OR "account_id" IS NOT NULL
);

-- The history is a record: it is added to, never rewritten.
CREATE OR REPLACE FUNCTION challenge_events_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'challenge_events is append-only; it records what happened to a challenge'
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER challenge_events_no_update
  BEFORE UPDATE OR DELETE ON "challenge_events"
  FOR EACH ROW EXECUTE FUNCTION challenge_events_append_only();
CREATE TRIGGER challenge_events_no_truncate
  BEFORE TRUNCATE ON "challenge_events"
  FOR EACH STATEMENT EXECUTE FUNCTION challenge_events_append_only();

-- Row-level security, as on every tenant-scoped table.
ALTER TABLE "challenge_plans" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "challenge_plans_tenant_isolation" ON "challenge_plans"
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
ALTER TABLE "challenges" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "challenges_tenant_isolation" ON "challenges"
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
ALTER TABLE "challenge_events" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "challenge_events_tenant_isolation" ON "challenge_events"
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
ALTER TABLE "challenge_certificates" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "challenge_certificates_tenant_isolation" ON "challenge_certificates"
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
