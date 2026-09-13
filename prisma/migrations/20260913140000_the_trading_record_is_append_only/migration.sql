-- `trades` and `executions` are what a trader would dispute, and they could be
-- edited.
--
-- The last two tables on the list `append_only_means_the_database_refuses`
-- started. That migration deliberately left these out, and said why: two
-- integration tests corrupt them on purpose to prove the reconciliation
-- detectors fire, so locking them was a question about test design rather than
-- a bug fix, and answering it inside a migration would have been the wrong
-- place. This is that question answered.
--
-- What is at stake. `executions` is the record of every fill: the price a
-- trader actually got, at the quote that was live at the time. `trades` is what
-- their profit and loss is summed from — `AccountStateService.realized()` reads
-- nothing else. Between them they are the evidence in any argument about what
-- happened to somebody's money, and the argument only ever starts when
-- somebody is unhappy. A record that can be edited after the fact settles
-- nothing.
--
-- Nothing has ever written them other than by INSERT. The two exceptions were
-- both tests, and both are dealt with:
--
--   * `jobs.test.ts` deletes executions to prove the detector notices a filled
--     order with no fill behind it. The corruption *is* the subject of that
--     test — the service is what makes the two agree, so there is no way to
--     ask it for the broken state. It goes through `simulatingCorruption`,
--     which disables the trigger for that one statement and puts it back in a
--     `finally`.
--
--   * `account-figures.test.ts` dragged a trade's `exit_time` backwards to test
--     the day boundary. That one did not need corrupting at all: `realized()`
--     already takes `nowMs`, so the test now moves the *clock* forward instead
--     and asks about the same untouched trade from the next day. That is the
--     real scenario — in production the trade stays put and the day rolls
--     over — where a trade edited into the past was a fiction that happened to
--     produce the same numbers. The constraint improved the test.
--
-- Rollback: additive. Every release writes these tables with INSERT only, so an
-- older image runs against this schema unchanged and the rollback floor does
-- not move. As with the previous two trigger migrations, `migrations.test.ts`
-- does not match `CREATE TRIGGER` and its own comment says to judge this class
-- by hand; this is that judgement.
--
-- `rows_are_append_only()` is the function from
-- `append_only_means_the_database_refuses`, reused so the message is the same
-- sentence whichever of these tables an operator runs into.

DROP TRIGGER IF EXISTS trades_no_update ON "trades";
CREATE TRIGGER trades_no_update
  BEFORE UPDATE ON "trades"
  FOR EACH ROW EXECUTE FUNCTION rows_are_append_only();

DROP TRIGGER IF EXISTS trades_no_delete ON "trades";
CREATE TRIGGER trades_no_delete
  BEFORE DELETE ON "trades"
  FOR EACH ROW EXECUTE FUNCTION rows_are_append_only();

DROP TRIGGER IF EXISTS trades_no_truncate ON "trades";
CREATE TRIGGER trades_no_truncate
  BEFORE TRUNCATE ON "trades"
  FOR EACH STATEMENT EXECUTE FUNCTION rows_are_append_only();

DROP TRIGGER IF EXISTS executions_no_update ON "executions";
CREATE TRIGGER executions_no_update
  BEFORE UPDATE ON "executions"
  FOR EACH ROW EXECUTE FUNCTION rows_are_append_only();

DROP TRIGGER IF EXISTS executions_no_delete ON "executions";
CREATE TRIGGER executions_no_delete
  BEFORE DELETE ON "executions"
  FOR EACH ROW EXECUTE FUNCTION rows_are_append_only();

DROP TRIGGER IF EXISTS executions_no_truncate ON "executions";
CREATE TRIGGER executions_no_truncate
  BEFORE TRUNCATE ON "executions"
  FOR EACH STATEMENT EXECUTE FUNCTION rows_are_append_only();

-- Belt as well as braces, as with the tables before them.
REVOKE UPDATE, DELETE, TRUNCATE ON "trades", "executions" FROM PUBLIC;

COMMENT ON TABLE trades IS
  'Append-only. What a trader''s realized P&L is summed from; UPDATE, DELETE and TRUNCATE are refused by trigger.';
COMMENT ON TABLE executions IS
  'Append-only. The record of every fill and the quote behind it; UPDATE, DELETE and TRUNCATE are refused by trigger.';
