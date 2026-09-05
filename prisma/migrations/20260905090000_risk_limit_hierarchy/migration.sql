-- The layers of the risk hierarchy above an account.
--
-- Platform → broker → desk → account. Each layer may tighten what the one
-- above it allows and may never loosen it; the account layer stays where it
-- has always been, on `account_settings`, because it is one row per account
-- and belongs beside that account's other settings.
--
-- A null field means "this layer sets no opinion" and passes the layer above
-- through. It does not mean unlimited, and nothing in code turns a null into a
-- default.
CREATE TYPE "RiskLimitLevel" AS ENUM ('PLATFORM', 'BROKER', 'DESK');

CREATE TABLE "risk_limit_sets" (
    "id" UUID NOT NULL,
    "level" "RiskLimitLevel" NOT NULL,
    "tenant_id" UUID NOT NULL,
    "master_account_id" UUID,
    "max_position_volume" DECIMAL(18,8),
    "max_open_positions" INTEGER,
    "max_gross_notional" DECIMAL(28,10),
    "max_symbol_net_volume" DECIMAL(18,8),
    "updated_by_user_id" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "risk_limit_sets_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "risk_limit_sets_tenant_id_level_idx" ON "risk_limit_sets"("tenant_id", "level");

ALTER TABLE "risk_limit_sets" ADD CONSTRAINT "risk_limit_sets_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "risk_limit_sets" ADD CONSTRAINT "risk_limit_sets_master_account_id_fkey"
  FOREIGN KEY ("master_account_id") REFERENCES "master_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- One set per layer, enforced by the database rather than by whoever writes
-- next. Two BROKER rows for one firm would mean the effective ceiling depended
-- on which the resolver read first, and a limit that depends on row order is
-- not a limit.
--
-- Partial indexes because the shape differs per level: PLATFORM and BROKER are
-- keyed by tenant alone, DESK by the master account.
CREATE UNIQUE INDEX "risk_limit_sets_one_per_tenant_level"
  ON "risk_limit_sets"("tenant_id", "level")
  WHERE "master_account_id" IS NULL;
CREATE UNIQUE INDEX "risk_limit_sets_one_per_desk"
  ON "risk_limit_sets"("master_account_id")
  WHERE "master_account_id" IS NOT NULL;

-- A DESK set names a desk; a PLATFORM or BROKER set does not. Without this a
-- row could claim to be a broker ceiling while pointing at one desk, and the
-- resolver would apply it to every account in the firm.
ALTER TABLE "risk_limit_sets" ADD CONSTRAINT "risk_limit_sets_level_shape"
  CHECK (
    ("level" = 'DESK' AND "master_account_id" IS NOT NULL)
    OR ("level" <> 'DESK' AND "master_account_id" IS NULL)
  );

-- Row-level security, as every tenant-scoped table has. Reading the platform's
-- ceiling from inside a broker is a deliberate cross-tenant read the
-- application makes out of scope; it is not something a stray query can do.
ALTER TABLE "risk_limit_sets" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "risk_limit_sets_tenant_isolation" ON "risk_limit_sets";
CREATE POLICY "risk_limit_sets_tenant_isolation" ON "risk_limit_sets"
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- Which desk placed an order.
--
-- A resting order fills later, from the tick loop, with no caller and no
-- route — and the desk ceiling that governed its placement must still govern
-- its fill. Without this an operator under a two-position desk cap could place
-- five pending orders and have all five fill.
--
-- Deliberately not a foreign key. This is evidence about what happened, and it
-- must survive the desk being deleted: an order that records the desk it came
-- from is more useful than one whose provenance vanished with a row somebody
-- tidied up.
ALTER TABLE "orders" ADD COLUMN "placed_by_master_account_id" UUID;
