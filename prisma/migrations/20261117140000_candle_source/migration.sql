-- Where each bar's prices came from. Nullable and additive: an older image
-- writes bars without it, and every bar before this migration reads as
-- "not recorded" rather than being guessed at.
ALTER TABLE "candles" ADD COLUMN IF NOT EXISTS "source" TEXT;
