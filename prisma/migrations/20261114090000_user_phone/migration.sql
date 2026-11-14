-- A contact number on the trader's profile. Nullable and additive, so an image
-- older than this column reads and writes users unchanged.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "phone" TEXT;
