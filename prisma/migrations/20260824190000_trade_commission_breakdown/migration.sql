-- Trade commission breakdown.
--
-- `trades.commission` previously held only the closing leg's commission, and
-- `net_pnl` was computed from it. The opening leg had been charged to the ledger
-- at open time and was never recorded on the trade, so summing `net_pnl` over a
-- trader's history came out short by one commission per round trip — a report
-- that did not reconcile with the balance it was describing.
--
-- After this migration:
--   entry_commission  the opening leg, apportioned to the volume closed here
--   exit_commission   the closing leg
--   commission        the two added together
--   net_pnl           gross_pnl - commission + swap

ALTER TABLE "trades" ADD COLUMN "entry_commission" DECIMAL(28,10);
ALTER TABLE "trades" ADD COLUMN "exit_commission" DECIMAL(28,10);

-- The old column was the closing leg.
UPDATE "trades" SET "exit_commission" = "commission";

-- The opening leg is still recoverable: positions keep the commission charged at
-- entry, and the share belonging to one close is that commission times the
-- fraction of the *initial* volume being closed. Initial volume, not remaining —
-- the entry commission was paid on the whole position once.
UPDATE "trades" t
SET "entry_commission" = ROUND(
      p."commission" * (t."volume" / NULLIF(p."initial_volume", 0)), 10)
FROM "positions" p
WHERE p."id" = t."position_id";

UPDATE "trades" SET "entry_commission" = 0 WHERE "entry_commission" IS NULL;

UPDATE "trades"
SET "commission" = "entry_commission" + "exit_commission",
    "net_pnl"    = "gross_pnl" - ("entry_commission" + "exit_commission") + "swap";

ALTER TABLE "trades" ALTER COLUMN "entry_commission" SET NOT NULL;
ALTER TABLE "trades" ALTER COLUMN "exit_commission" SET NOT NULL;
