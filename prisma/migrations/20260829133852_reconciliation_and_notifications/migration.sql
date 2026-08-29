-- CreateEnum
CREATE TYPE "ReconciliationRunStatus" AS ENUM ('RUNNING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "ReconciliationFindingStatus" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'INVESTIGATING', 'RESOLVED', 'FALSE_POSITIVE');

-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('IN_APP', 'EMAIL');

-- CreateTable
CREATE TABLE "reconciliation_runs" (
    "id" UUID NOT NULL,
    "status" "ReconciliationRunStatus" NOT NULL DEFAULT 'RUNNING',
    "trigger" TEXT NOT NULL DEFAULT 'SCHEDULED',
    "requested_by_user_id" UUID,
    "accounts_checked" INTEGER NOT NULL DEFAULT 0,
    "findings_raised" INTEGER NOT NULL DEFAULT 0,
    "findings_recurred" INTEGER NOT NULL DEFAULT 0,
    "critical_count" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(6),
    "duration_ms" INTEGER,

    CONSTRAINT "reconciliation_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reconciliation_findings" (
    "id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "status" "ReconciliationFindingStatus" NOT NULL DEFAULT 'OPEN',
    "expected" TEXT NOT NULL,
    "actual" TEXT NOT NULL,
    "difference" TEXT NOT NULL,
    "subject_type" TEXT,
    "subject_id" UUID,
    "subject_key" TEXT NOT NULL DEFAULT '',
    "message" TEXT NOT NULL,
    "occurrences" INTEGER NOT NULL DEFAULT 1,
    "first_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_by_user_id" UUID,
    "resolved_at" TIMESTAMPTZ(6),
    "resolution_note" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "reconciliation_findings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'INFO',
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "data" JSONB NOT NULL DEFAULT '{}',
    "account_id" UUID,
    "read_at" TIMESTAMPTZ(6),
    "emailed_at" TIMESTAMPTZ(6),
    "dedupe_key" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "reconciliation_runs_started_at_idx" ON "reconciliation_runs"("started_at" DESC);

-- CreateIndex
CREATE INDEX "reconciliation_runs_status_started_at_idx" ON "reconciliation_runs"("status", "started_at" DESC);

-- CreateIndex
CREATE INDEX "reconciliation_findings_status_severity_idx" ON "reconciliation_findings"("status", "severity");

-- CreateIndex
CREATE INDEX "reconciliation_findings_last_seen_at_idx" ON "reconciliation_findings"("last_seen_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "reconciliation_findings_account_id_code_subject_key_key" ON "reconciliation_findings"("account_id", "code", "subject_key");

-- CreateIndex
CREATE UNIQUE INDEX "notifications_dedupe_key_key" ON "notifications"("dedupe_key");

-- CreateIndex
CREATE INDEX "notifications_user_id_read_at_created_at_idx" ON "notifications"("user_id", "read_at", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "reconciliation_findings" ADD CONSTRAINT "reconciliation_findings_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "reconciliation_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reconciliation_findings" ADD CONSTRAINT "reconciliation_findings_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
