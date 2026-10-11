-- A stop-limit's second phase: its stop has been reached and it rests as a
-- limit. Nullable and additive, so an image older than this column reads and
-- writes orders unchanged (it never selects STOP_LIMIT orders to work).
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "activated_at" TIMESTAMPTZ(6);
