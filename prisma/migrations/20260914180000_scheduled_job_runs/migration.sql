-- When each scheduled job last ran.
--
-- The platform had no record of this at all, and a schedule that stops is the
-- one failure here that produces no error, no failed job and no log line — the
-- process that would have written them is the one that never ran. Swap accrual,
-- reconciliation, the retention sweep, the outbox relay: each stops quietly, and
-- what stops with them is money, financial checks, a data-retention duty, and
-- every event that was supposed to leave the platform.
--
-- One row per job rather than one per run: the outbox relay fires every minute,
-- and a per-run table would need a retention sweep that is itself one of the
-- jobs this table exists to watch. Per-run history stays in the structured logs.
--
-- No tenant column: a schedule belongs to the deployment, not to a firm. It is
-- therefore not row-level-secured, and holds nothing about anybody.
CREATE TABLE "scheduled_job_runs" (
    "name" TEXT NOT NULL,
    "cron" TEXT NOT NULL,
    "started_at" TIMESTAMPTZ(6) NOT NULL,
    "finished_at" TIMESTAMPTZ(6),
    "duration_ms" INTEGER,
    "outcome" TEXT,
    "error" TEXT,
    "runs" INTEGER NOT NULL DEFAULT 0,
    "failures" INTEGER NOT NULL DEFAULT 0,
    "last_succeeded_at" TIMESTAMPTZ(6),
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "scheduled_job_runs_pkey" PRIMARY KEY ("name")
);

-- An outcome is one of two words or nothing at all; a row claiming to have
-- succeeded must say when, and one that has finished must say how long it took.
-- These are cheap, and they stop the table from developing a third state that
-- the readers of it have to guess about.
ALTER TABLE "scheduled_job_runs"
  ADD CONSTRAINT "scheduled_job_runs_outcome_is_known"
  CHECK ("outcome" IS NULL OR "outcome" IN ('OK', 'FAILED'));

ALTER TABLE "scheduled_job_runs"
  ADD CONSTRAINT "scheduled_job_runs_finished_runs_are_complete"
  CHECK (
    ("finished_at" IS NULL AND "outcome" IS NULL AND "duration_ms" IS NULL)
    OR ("finished_at" IS NOT NULL AND "outcome" IS NOT NULL AND "duration_ms" IS NOT NULL)
  );

ALTER TABLE "scheduled_job_runs"
  ADD CONSTRAINT "scheduled_job_runs_failure_says_why"
  CHECK ("outcome" IS DISTINCT FROM 'FAILED' OR "error" IS NOT NULL);
