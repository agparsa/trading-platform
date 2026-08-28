-- CreateEnum
CREATE TYPE "IntegritySignalStatus" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'INVESTIGATING', 'RESOLVED', 'FALSE_POSITIVE');

-- CreateEnum
CREATE TYPE "IntegritySignalEventType" AS ENUM ('RAISED', 'RECURRED', 'STATUS_CHANGED', 'NOTE_ADDED');

-- CreateTable
CREATE TABLE "integrity_signals" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "status" "IntegritySignalStatus" NOT NULL DEFAULT 'OPEN',
    "message" TEXT NOT NULL,
    "occurrences" INTEGER NOT NULL DEFAULT 1,
    "first_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewed_by_user_id" UUID,
    "reviewed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "integrity_signals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integrity_signal_events" (
    "id" UUID NOT NULL,
    "signal_id" UUID NOT NULL,
    "type" "IntegritySignalEventType" NOT NULL,
    "from_status" "IntegritySignalStatus",
    "to_status" "IntegritySignalStatus",
    "severity" TEXT,
    "message" TEXT,
    "evidence" JSONB,
    "actor_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "integrity_signal_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "integrity_signals_status_severity_idx" ON "integrity_signals"("status", "severity");

-- CreateIndex
CREATE INDEX "integrity_signals_last_seen_at_idx" ON "integrity_signals"("last_seen_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "integrity_signals_account_id_code_key" ON "integrity_signals"("account_id", "code");

-- CreateIndex
CREATE INDEX "integrity_signal_events_signal_id_created_at_idx" ON "integrity_signal_events"("signal_id", "created_at");

-- AddForeignKey
ALTER TABLE "integrity_signals" ADD CONSTRAINT "integrity_signals_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integrity_signal_events" ADD CONSTRAINT "integrity_signal_events_signal_id_fkey" FOREIGN KEY ("signal_id") REFERENCES "integrity_signals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

