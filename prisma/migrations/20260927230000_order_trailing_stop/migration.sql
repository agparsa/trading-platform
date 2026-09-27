-- A trailing stop asked for at entry.
--
-- Trailing existed only on an open position: the ticket could not ask for one,
-- so a trader who wanted a trail set the order, waited for the fill, then
-- modified the position — a window in which the position had no stop at all.
-- The distance is carried on the order so a resting order that fills hours
-- later, with nobody present, opens the position with the trail it was placed
-- with. Nullable and unread by the version before this one, so a rollback of
-- the code leaves the column ignored rather than broken.
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "trailing_stop_distance" DECIMAL(28, 10);
