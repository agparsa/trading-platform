-- The order in which an order's events were written.
--
-- `created_at` defaults to CURRENT_TIMESTAMP, which is the start of the
-- transaction, not the moment of the insert. Every row one transaction writes
-- therefore carries the same time — a market order's CREATED, ACCEPTED and
-- FILLED, a cancel's CANCEL_REQUESTED and CANCELLED — and a trail read
-- `ORDER BY created_at` came back in whatever order the plan produced. On the
-- development database 316 of 495 orders' trails did not begin with CREATED.
--
-- A sequence is assigned at the insert, in the order the inserts happen, so it
-- orders the rows of one transaction and, because an order's writes are
-- serialised by its row lock, the transactions too.
--
-- Existing rows are numbered in the table's physical order as the column is
-- added. Nothing has ever deleted from this table in production (and since
-- 20260913100000 the database refuses to), so there that is the order they were
-- inserted in. A development database the test harness has emptied and
-- refilled can reuse freed space, and may number a few old trails out of order.
ALTER TABLE "order_events" ADD COLUMN "seq" BIGSERIAL NOT NULL;

CREATE INDEX "order_events_order_id_seq_idx" ON "order_events"("order_id", "seq");
