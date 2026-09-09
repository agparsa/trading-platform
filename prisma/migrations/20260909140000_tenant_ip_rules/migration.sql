-- Where a firm's people may reach it from (§46).
--
-- A DENY match refuses and beats everything. If any ALLOW rule exists for the
-- scope, the address must match one — allow-list mode, which is what a firm
-- means by "only from the office". With no ALLOW rule the set is a block-list.
--
-- Adding the first ALLOW therefore changes the mode of the whole set. The API
-- refuses to save one that would exclude the person writing it: an allow-list
-- that locks the firm out of the screen where it could be undone leaves a
-- database console as the only fix, which is not a support process but an
-- outage.
CREATE TYPE "IpRuleKind" AS ENUM ('ALLOW', 'DENY');
CREATE TYPE "IpRuleScope" AS ENUM ('STAFF', 'EVERYONE');

CREATE TABLE "tenant_ip_rules" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "cidr" TEXT NOT NULL,
    "kind" "IpRuleKind" NOT NULL,
    "scope" "IpRuleScope" NOT NULL DEFAULT 'STAFF',
    "note" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "tenant_ip_rules_pkey" PRIMARY KEY ("id")
);

-- A rule nobody can explain a year later is a rule nobody dares remove, and an
-- allow-list nobody dares change stops being maintained.
ALTER TABLE "tenant_ip_rules" ADD CONSTRAINT "tenant_ip_rules_note_not_empty"
  CHECK (length(btrim("note")) > 0);

-- One rule per range per scope. Two rows saying the same thing are two rows
-- somebody has to reconcile by hand when only one of them gets disabled.
CREATE UNIQUE INDEX "tenant_ip_rules_tenant_cidr_scope_key"
  ON "tenant_ip_rules"("tenant_id", "cidr", "scope");
CREATE INDEX "tenant_ip_rules_tenant_enabled_idx" ON "tenant_ip_rules"("tenant_id", "enabled");

ALTER TABLE "tenant_ip_rules" ADD CONSTRAINT "tenant_ip_rules_created_by_user_id_fkey"
  FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "tenant_ip_rules" ADD CONSTRAINT "tenant_ip_rules_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Row-level security, as on every tenant-scoped table. One firm must not be
-- able to read — let alone write — another's rules about who may reach it.
ALTER TABLE "tenant_ip_rules" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_ip_rules_tenant_isolation" ON "tenant_ip_rules";
CREATE POLICY "tenant_ip_rules_tenant_isolation" ON "tenant_ip_rules"
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
