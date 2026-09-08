-- External reconciliation (§44): the platform's records against a venue's.
--
-- Different in kind from what `reconciliation_findings` records. There, a
-- disagreement means exactly one of our own code paths is wrong and the others
-- are the evidence. Here, a disagreement can also mean the venue is right and
-- we are behind, or that we asked mid-write. So an item states what each side
-- said and how they differ, and a person decides what it means.
--
-- **Nothing here repairs anything** (§112). Auto-correcting would erase the
-- evidence of how the drift happened, which is the one thing an investigation
-- needs — and would turn a bug that shows up once into a bug that quietly
-- cleans up after itself for ever.

CREATE TYPE "ReconciliationKind" AS ENUM ('INTERNAL', 'EXTERNAL');
CREATE TYPE "ReconciliationSubject" AS ENUM ('BALANCE', 'ORDER', 'POSITION', 'EXECUTION');
CREATE TYPE "ReconciliationItemStatus" AS ENUM (
  'MATCHED', 'MISSING_INTERNAL', 'MISSING_EXTERNAL', 'QUANTITY_MISMATCH',
  'PRICE_MISMATCH', 'FEE_MISMATCH', 'BALANCE_MISMATCH', 'UNKNOWN'
);
CREATE TYPE "ResolutionDecision" AS ENUM (
  'FALSE_POSITIVE', 'ACCEPTED_DIFFERENCE', 'CORRECTED_MANUALLY',
  'UNDER_INVESTIGATION', 'ESCALATED'
);

ALTER TABLE "reconciliation_runs"
  ADD COLUMN "kind" "ReconciliationKind" NOT NULL DEFAULT 'INTERNAL',
  ADD COLUMN "broker_connection_id" UUID,
  ADD COLUMN "items_compared" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "items_matched" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "items_mismatched" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "items_missing" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "items_unknown" INTEGER NOT NULL DEFAULT 0;

-- An internal run has no venue; an external one must name the one it asked.
-- Without this a run could claim to have reconciled against nothing in
-- particular, and its findings would be unattributable.
ALTER TABLE "reconciliation_runs" ADD CONSTRAINT "reconciliation_runs_external_names_a_venue"
  CHECK (
    ("kind" = 'INTERNAL' AND "broker_connection_id" IS NULL)
    OR ("kind" = 'EXTERNAL' AND "broker_connection_id" IS NOT NULL)
  );

CREATE INDEX "reconciliation_runs_kind_started_at_idx"
  ON "reconciliation_runs"("kind", "started_at" DESC);

-- Only disagreements are stored. A matched order is a row the platform would
-- write on every run for the life of the account, and a hundred thousand of
-- them say exactly what `items_matched` says in one integer.
CREATE TABLE "reconciliation_items" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "broker_connection_id" UUID,
    "subject" "ReconciliationSubject" NOT NULL,
    "key" TEXT NOT NULL,
    "status" "ReconciliationItemStatus" NOT NULL,
    "field" TEXT,
    "internal" TEXT,
    "external" TEXT,
    "difference" TEXT,
    "tolerance" TEXT,
    "message" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reconciliation_items_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "reconciliation_items_run_id_status_idx" ON "reconciliation_items"("run_id", "status");
CREATE INDEX "reconciliation_items_account_subject_created_idx"
  ON "reconciliation_items"("account_id", "subject", "created_at" DESC);
CREATE INDEX "reconciliation_items_status_created_idx"
  ON "reconciliation_items"("status", "created_at" DESC);
CREATE INDEX "reconciliation_items_tenant_id_idx" ON "reconciliation_items"("tenant_id");

ALTER TABLE "reconciliation_items" ADD CONSTRAINT "reconciliation_items_run_id_fkey"
  FOREIGN KEY ("run_id") REFERENCES "reconciliation_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "reconciliation_items" ADD CONSTRAINT "reconciliation_items_account_id_fkey"
  FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "reconciliation_items" ADD CONSTRAINT "reconciliation_items_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- What somebody decided about a discrepancy, and why.
--
-- Append-only, and separate from the item on purpose: an item's status is what
-- the machine observed, a resolution is what a person concluded, and the two
-- must not be able to overwrite each other. The correction of a mistaken
-- resolution is another resolution saying so.
CREATE TABLE "resolution_records" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "item_id" UUID,
    "finding_id" UUID,
    "decision" "ResolutionDecision" NOT NULL,
    "note" TEXT NOT NULL,
    "decided_by_user_id" UUID NOT NULL,
    "decided_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "resolution_records_pkey" PRIMARY KEY ("id")
);

-- Exactly one subject. A record attached to both, or to neither, is a decision
-- about nothing in particular.
ALTER TABLE "resolution_records" ADD CONSTRAINT "resolution_records_one_subject"
  CHECK (("item_id" IS NULL) <> ("finding_id" IS NULL));

-- A decision with no reason is a decision nobody can review, and these are read
-- months later by people who were not there.
ALTER TABLE "resolution_records" ADD CONSTRAINT "resolution_records_note_not_empty"
  CHECK (length(btrim("note")) > 0);

CREATE INDEX "resolution_records_item_decided_idx"
  ON "resolution_records"("item_id", "decided_at" DESC);
CREATE INDEX "resolution_records_finding_decided_idx"
  ON "resolution_records"("finding_id", "decided_at" DESC);
CREATE INDEX "resolution_records_tenant_id_idx" ON "resolution_records"("tenant_id");

ALTER TABLE "resolution_records" ADD CONSTRAINT "resolution_records_item_id_fkey"
  FOREIGN KEY ("item_id") REFERENCES "reconciliation_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "resolution_records" ADD CONSTRAINT "resolution_records_finding_id_fkey"
  FOREIGN KEY ("finding_id") REFERENCES "reconciliation_findings"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "resolution_records" ADD CONSTRAINT "resolution_records_decided_by_user_id_fkey"
  FOREIGN KEY ("decided_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "resolution_records" ADD CONSTRAINT "resolution_records_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A resolution is a record of a decision. It is never edited and never deleted
-- from the console — the correction of a mistaken one is another record saying
-- so. Enforced here rather than trusted to the API, for the same reason the
-- audit log is: the guarantee has to survive somebody writing around the API.
CREATE OR REPLACE FUNCTION resolution_records_are_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'resolution_records is append-only: % is not permitted', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER resolution_records_no_update
  BEFORE UPDATE OR DELETE ON "resolution_records"
  FOR EACH ROW EXECUTE FUNCTION resolution_records_are_append_only();

-- Row-level security, as on every tenant-scoped table.
ALTER TABLE "reconciliation_items" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "reconciliation_items_tenant_isolation" ON "reconciliation_items";
CREATE POLICY "reconciliation_items_tenant_isolation" ON "reconciliation_items"
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

ALTER TABLE "resolution_records" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "resolution_records_tenant_isolation" ON "resolution_records";
CREATE POLICY "resolution_records_tenant_isolation" ON "resolution_records"
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
