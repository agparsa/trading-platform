-- Auth hardening: hashed single-use tokens, per-login refresh-token families,
-- and per-account login lockout. Also introduces the account-number sequence.
--
-- family_id is added NOT NULL without a default because refresh_tokens is empty
-- at this point in the project's life; a later deployment with live sessions
-- would need a backfill instead.

-- AlterTable
ALTER TABLE "refresh_tokens" ADD COLUMN     "family_id" UUID NOT NULL;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "email_verification_expires_at" TIMESTAMPTZ(6),
ADD COLUMN     "email_verification_token_hash" TEXT,
ADD COLUMN     "failed_login_attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "locked_until" TIMESTAMPTZ(6),
ADD COLUMN     "password_reset_expires_at" TIMESTAMPTZ(6),
ADD COLUMN     "password_reset_token_hash" TEXT;

-- CreateIndex
CREATE INDEX "refresh_tokens_family_id_idx" ON "refresh_tokens"("family_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_verification_token_hash_key" ON "users"("email_verification_token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "users_password_reset_token_hash_key" ON "users"("password_reset_token_hash");

-- Public account numbers come from a sequence rather than a random draw or a
-- count(*): sequential allocation is collision-free under concurrency, and the
-- surrogate key stays a UUID so the sequence value leaks nothing but ordering.
CREATE SEQUENCE IF NOT EXISTS account_number_seq START WITH 100001 INCREMENT BY 1;
