-- CreateEnum
CREATE TYPE "TenantKind" AS ENUM ('PLATFORM', 'BROKER');

-- CreateEnum
CREATE TYPE "ExecutionMode" AS ENUM ('INTERNAL', 'EXTERNAL_BROKER');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "UserRole" ADD VALUE 'BROKER_OWNER';
ALTER TYPE "UserRole" ADD VALUE 'BROKER_ANALYST';
ALTER TYPE "UserRole" ADD VALUE 'BROKER_DEVELOPER';
ALTER TYPE "UserRole" ADD VALUE 'PLATFORM_SUPER_ADMIN';
ALTER TYPE "UserRole" ADD VALUE 'PLATFORM_OPERATOR';
ALTER TYPE "UserRole" ADD VALUE 'PLATFORM_SUPPORT';
ALTER TYPE "UserRole" ADD VALUE 'PLATFORM_AUDITOR';
ALTER TYPE "UserRole" ADD VALUE 'PLATFORM_DEVELOPER';

-- AlterTable
ALTER TABLE "invite_codes" ADD COLUMN     "grants_role" "UserRole";

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "default_execution_mode" "ExecutionMode" NOT NULL DEFAULT 'INTERNAL',
ADD COLUMN     "kind" "TenantKind" NOT NULL DEFAULT 'BROKER',
ADD COLUMN     "legal_name" TEXT;


-- The oldest tenant is the platform: every deployment so far has exactly one
-- tenant, and it is the operator's own. Brokers created afterwards default to
-- BROKER. A deployment with several tenants already reviews this by hand.
UPDATE "tenants"
SET "kind" = 'PLATFORM'
WHERE "id" = (SELECT "id" FROM "tenants" ORDER BY "created_at" ASC LIMIT 1);
