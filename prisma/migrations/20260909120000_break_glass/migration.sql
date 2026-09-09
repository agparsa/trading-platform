-- Break-glass impersonation (§9).
--
-- A grant, not a token. The obvious design is to mint an access token saying
-- "you are the trader"; it is the wrong one. Every downstream check would then
-- see the trader, the audit trail would name the trader as the actor, and
-- revoking mid-session would mean chasing a token already issued.
--
-- So the staff member stays themselves and carries this row. Revocation is an
-- UPDATE. The audit trail always names who actually did it. And "may this
-- person see that person's data" is asked per request against the database's
-- clock, not minted into a claim and trusted for fifteen minutes.
CREATE TYPE "BreakGlassScope" AS ENUM ('READ_ONLY', 'READ_WRITE');

CREATE TABLE "break_glass_grants" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "actor_id" UUID NOT NULL,
    "subject_user_id" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "scope" "BreakGlassScope" NOT NULL DEFAULT 'READ_ONLY',
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "ended_at" TIMESTAMPTZ(6),
    "ended_by_user_id" UUID,
    "uses" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "break_glass_grants_pkey" PRIMARY KEY ("id")
);

-- A break-glass with no reason is access nobody can review afterwards, which is
-- the only thing that makes this safe to have at all. Enforced here rather than
-- trusted to the API, for the same reason the audit log is.
ALTER TABLE "break_glass_grants" ADD CONSTRAINT "break_glass_grants_reason_not_empty"
  CHECK (length(btrim("reason")) >= 8);

-- Nobody impersonates themselves. It is always either a mistake or an attempt
-- to make an ordinary action look like a supervised one.
ALTER TABLE "break_glass_grants" ADD CONSTRAINT "break_glass_grants_not_self"
  CHECK ("actor_id" <> "subject_user_id");

-- A grant that never expires is a mode somebody left switched on. The service
-- caps the window; this refuses the degenerate case whatever writes the row.
ALTER TABLE "break_glass_grants" ADD CONSTRAINT "break_glass_grants_expires_after_creation"
  CHECK ("expires_at" > "created_at");

CREATE INDEX "break_glass_grants_actor_expires_idx"
  ON "break_glass_grants"("actor_id", "expires_at" DESC);
CREATE INDEX "break_glass_grants_subject_created_idx"
  ON "break_glass_grants"("subject_user_id", "created_at" DESC);
CREATE INDEX "break_glass_grants_tenant_id_idx" ON "break_glass_grants"("tenant_id");

ALTER TABLE "break_glass_grants" ADD CONSTRAINT "break_glass_grants_actor_id_fkey"
  FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "break_glass_grants" ADD CONSTRAINT "break_glass_grants_subject_user_id_fkey"
  FOREIGN KEY ("subject_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "break_glass_grants" ADD CONSTRAINT "break_glass_grants_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Row-level security, as on every tenant-scoped table. It is also the last line
-- against a grant reaching across firms: a broker's staff must not be able to
-- see the platform's users or another firm's traders, and the service refuses
-- that too — this is what holds if somebody writes around the service.
ALTER TABLE "break_glass_grants" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "break_glass_grants_tenant_isolation" ON "break_glass_grants";
CREATE POLICY "break_glass_grants_tenant_isolation" ON "break_glass_grants"
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
