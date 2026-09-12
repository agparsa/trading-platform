-- AlterTable
ALTER TABLE "refresh_tokens" ADD COLUMN     "installation_id" TEXT;

-- CreateIndex
CREATE INDEX "refresh_tokens_user_id_installation_id_revoked_at_idx" ON "refresh_tokens"("user_id", "installation_id", "revoked_at");
