-- Two more kinds of report: the orders placed in a window, and the positions
-- opened in it.
--
-- `ADD VALUE` rather than a new type: an enum value cannot be added inside a
-- transaction block on PostgreSQL before 12, and recreating the type would mean
-- rewriting every existing report row to say the same thing it already says.
-- `IF NOT EXISTS` makes the statement idempotent, which matters because a
-- migration that has been applied by hand on one environment and by the tool on
-- another must not diverge.
--
-- Nothing is removed and no row changes: existing reports keep the kind they
-- were built with, and a deployment that rolls back simply cannot produce the
-- two new kinds.
ALTER TYPE "ReportKind" ADD VALUE IF NOT EXISTS 'ORDERS';
ALTER TYPE "ReportKind" ADD VALUE IF NOT EXISTS 'POSITIONS';
