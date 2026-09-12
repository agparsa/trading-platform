-- A device revocation that a relaunch cannot undo, and the security-feed
-- vocabulary for what happens to a device.
--
-- Additive only: new enum values and one nullable column. An older image runs
-- against this schema unchanged, which is what the runbook asks of a migration
-- applied to a live database.
--
-- PostgreSQL 12 and later accept several ADD VALUE in one transaction as long
-- as none of the new values is *used* in the same transaction. None is.

-- AlterEnum
ALTER TYPE "SecurityEventKind" ADD VALUE 'DEVICE_REGISTERED';
ALTER TYPE "SecurityEventKind" ADD VALUE 'DEVICE_REVIVED';
ALTER TYPE "SecurityEventKind" ADD VALUE 'DEVICE_REVOKED';
ALTER TYPE "SecurityEventKind" ADD VALUE 'DEVICE_REVOKED_BY_STAFF';
ALTER TYPE "SecurityEventKind" ADD VALUE 'DEVICE_RESTORED_BY_STAFF';

-- AlterTable
ALTER TABLE "devices" ADD COLUMN "revoked_by_staff_at" TIMESTAMPTZ(6);
