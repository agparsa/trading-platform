-- Reports: a server-side export, the file it produced, and who may have it.
--
-- The panel's CSV buttons export *the page on screen*. That is honest for a
-- hundred rows and useless for a quarter: an operator who asked for "every
-- closed trade in March" got the fifty rows the table had paged in, named as
-- though it were the answer. A real export cannot run inside a request — it is
-- minutes of query and megabytes of output — so it is a job, a stored file and
-- a download.
--
-- The table deliberately copies `kyc_documents`, which had already solved the
-- same problem: bytes sealed at rest, hash and size in the clear so the row
-- stays useful after the bytes are gone, the sealing key recorded so a rotation
-- can find rows without opening them, and a sweep that nulls the content rather
-- than deleting the record. A report is evidence of what an operator was shown;
-- the record outlives the file.
--
-- Not append-only. A report row moves QUEUED → RUNNING → READY → EXPIRED, so it
-- is excluded from `append-only-tables.test.ts` by having no trigger, which is
-- the deliberate absence that check reads as "not claimed".

-- CreateEnum
CREATE TYPE "ReportKind" AS ENUM ('TRADES', 'LEDGER');

-- CreateEnum
CREATE TYPE "ReportStatus" AS ENUM ('QUEUED', 'RUNNING', 'READY', 'FAILED', 'EXPIRED');

-- CreateTable
CREATE TABLE "reports" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "kind" "ReportKind" NOT NULL,
    "status" "ReportStatus" NOT NULL DEFAULT 'QUEUED',
    "params" JSONB NOT NULL,
    "requested_by_id" UUID NOT NULL,
    "sha256" VARCHAR(64),
    "size_bytes" INTEGER,
    "row_count" INTEGER,
    "content" BYTEA,
    "sealed_with_key_id" TEXT,
    "error" TEXT,
    "requested_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMPTZ(6),
    "completed_at" TIMESTAMPTZ(6),
    "expires_at" TIMESTAMPTZ(6),
    "purged_at" TIMESTAMPTZ(6),

    CONSTRAINT "reports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "reports_tenant_id_requested_at_idx" ON "reports"("tenant_id", "requested_at" DESC);

-- CreateIndex
CREATE INDEX "reports_requested_by_id_requested_at_idx" ON "reports"("requested_by_id", "requested_at" DESC);

-- CreateIndex
CREATE INDEX "reports_status_idx" ON "reports"("status");

-- AddForeignKey
ALTER TABLE "reports" ADD CONSTRAINT "reports_requested_by_id_fkey" FOREIGN KEY ("requested_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reports" ADD CONSTRAINT "reports_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Row-level security, as on every tenant-scoped table. A report is a file full
-- of one firm's trades; the isolation that matters is not the API's.
ALTER TABLE "reports" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "reports_tenant_isolation" ON "reports";
CREATE POLICY "reports_tenant_isolation" ON "reports"
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- A report that never finished is not a report. `status` and the timestamps
-- have to agree, or a row can claim READY with nothing behind it.
ALTER TABLE "reports" ADD CONSTRAINT "reports_ready_has_a_file"
  CHECK (
    "status" <> 'READY'
    OR ("content" IS NOT NULL AND "sha256" IS NOT NULL AND "size_bytes" IS NOT NULL
        AND "row_count" IS NOT NULL AND "completed_at" IS NOT NULL AND "expires_at" IS NOT NULL)
  );
ALTER TABLE "reports" ADD CONSTRAINT "reports_failed_says_why"
  CHECK ("status" <> 'FAILED' OR length(btrim(coalesce("error", ''))) > 0);
ALTER TABLE "reports" ADD CONSTRAINT "reports_expired_has_no_bytes"
  CHECK ("status" <> 'EXPIRED' OR ("content" IS NULL AND "purged_at" IS NOT NULL));
