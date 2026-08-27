-- CreateEnum
CREATE TYPE "MasterAccountStatus" AS ENUM ('ACTIVE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "MasterLinkStatus" AS ENUM ('ACTIVE', 'REVOKED');

-- CreateTable
CREATE TABLE "master_accounts" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "status" "MasterAccountStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "master_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "master_account_links" (
    "id" UUID NOT NULL,
    "master_account_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "capabilities" TEXT[],
    "status" "MasterLinkStatus" NOT NULL DEFAULT 'ACTIVE',
    "granted_by_user_id" UUID NOT NULL,
    "granted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_by_user_id" UUID,
    "revoked_at" TIMESTAMPTZ(6),

    CONSTRAINT "master_account_links_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "master_accounts_user_id_status_idx" ON "master_accounts"("user_id", "status");

-- CreateIndex
CREATE INDEX "master_account_links_account_id_status_idx" ON "master_account_links"("account_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "master_account_links_master_account_id_account_id_key" ON "master_account_links"("master_account_id", "account_id");

-- AddForeignKey
ALTER TABLE "master_accounts" ADD CONSTRAINT "master_accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "master_account_links" ADD CONSTRAINT "master_account_links_master_account_id_fkey" FOREIGN KEY ("master_account_id") REFERENCES "master_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "master_account_links" ADD CONSTRAINT "master_account_links_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

