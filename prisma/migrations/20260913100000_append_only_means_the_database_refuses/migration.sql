-- The ledger the documents call "the truth" could be edited and deleted.
--
-- `docs/database.md` says two things a paragraph apart:
--
--   "`*_events` tables and `balance_ledger` are append-only."
--   "`balance_ledger` is append-only. Nothing updates or deletes a row; a
--    mistake is corrected with a compensating ADJUSTMENT entry."
--
-- and `docs/runbook.md` tells whoever is on call not to edit it. All three
-- were descriptions of the application's behaviour, which is accurate --
-- nothing in this repository has ever issued an UPDATE or a DELETE against
-- these tables, in application code or in a test. None of them was a
-- constraint. Against the live database, today, before this migration:
--
--   DELETE FROM balance_ledger;         -- DELETE PERMITTED
--   UPDATE balance_ledger SET amount=0; -- UPDATE PERMITTED
--
-- `docs/security.md` already answers why that is not enough, about the audit
-- log: "That is a convention, and a convention holds only for people who are
-- following it. The requirement is that a normal administrator cannot alter
-- audit records, and the person the requirement exists for is the one who has
-- reached a database connection." Every word of that applies to the account
-- ledger, which is the record of every movement of customer money.
--
-- The asymmetry is what makes it an oversight rather than a decision:
-- `wallet_transactions` -- the *second* ledger, money held for a person rather
-- than in an account -- has refused UPDATE and DELETE by trigger since it was
-- created. The first ledger, the one everything else reconciles against, never
-- got the same treatment.
--
-- ## Is this safe to roll back across?
--
-- `scripts/migrations.test.ts` will not flag this: its patterns match DDL that
-- narrows a column, and a trigger is none of them. Its own comment says what to
-- do about that -- "If you add a constraint of any kind to an existing table,
-- think for yourself about whether last release's code could still write to
-- it." So: every release in this repository's history writes these tables with
-- INSERT only; the compensating-entry pattern exists precisely so that nothing
-- needs to update one. An older image runs against this schema unchanged. The
-- rollback floor does not move.
--
-- ## What is deliberately not here
--
-- `trades` and `executions` are append-only in the application too, and are not
-- locked, because two integration tests deliberately corrupt them to prove the
-- reconciliation detectors fire -- "detects a filled order whose execution never
-- happened" deletes the executions. Whether those tests should instead disable a
-- trigger the way the audit-log harness does is a question about test design,
-- and answering it inside a migration would be the wrong place.
--
-- `account_snapshots` is upserted by design: a day's snapshot is revised as the
-- day moves. It is not append-only and no document claims it is.
--
-- `outbox_events` already has the right trigger and a better shape than a flat
-- refusal: the event's content is frozen and the relay's bookkeeping still
-- moves. Delivered rows are also legitimately prunable, so it keeps DELETE.

CREATE OR REPLACE FUNCTION rows_are_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '%: append-only; % is not permitted. Correct a mistake with a compensating entry, not by editing history.',
    TG_TABLE_NAME, TG_OP
    USING ERRCODE = '42501';
END;
$$;

DROP TRIGGER IF EXISTS balance_ledger_no_update ON "balance_ledger";
CREATE TRIGGER balance_ledger_no_update
  BEFORE UPDATE ON "balance_ledger"
  FOR EACH ROW EXECUTE FUNCTION rows_are_append_only();

DROP TRIGGER IF EXISTS balance_ledger_no_delete ON "balance_ledger";
CREATE TRIGGER balance_ledger_no_delete
  BEFORE DELETE ON "balance_ledger"
  FOR EACH ROW EXECUTE FUNCTION rows_are_append_only();

-- Statement-level, because TRUNCATE does not fire row-level triggers. This is
-- the rule `truncate_is_a_deletion_too` had to retrofit onto nine tables; it is
-- applied here at the same time as the other two, rather than a fortnight later.
DROP TRIGGER IF EXISTS balance_ledger_no_truncate ON "balance_ledger";
CREATE TRIGGER balance_ledger_no_truncate
  BEFORE TRUNCATE ON "balance_ledger"
  FOR EACH STATEMENT EXECUTE FUNCTION rows_are_append_only();

DROP TRIGGER IF EXISTS order_events_no_update ON "order_events";
CREATE TRIGGER order_events_no_update
  BEFORE UPDATE ON "order_events"
  FOR EACH ROW EXECUTE FUNCTION rows_are_append_only();

DROP TRIGGER IF EXISTS order_events_no_delete ON "order_events";
CREATE TRIGGER order_events_no_delete
  BEFORE DELETE ON "order_events"
  FOR EACH ROW EXECUTE FUNCTION rows_are_append_only();

DROP TRIGGER IF EXISTS order_events_no_truncate ON "order_events";
CREATE TRIGGER order_events_no_truncate
  BEFORE TRUNCATE ON "order_events"
  FOR EACH STATEMENT EXECUTE FUNCTION rows_are_append_only();

DROP TRIGGER IF EXISTS position_events_no_update ON "position_events";
CREATE TRIGGER position_events_no_update
  BEFORE UPDATE ON "position_events"
  FOR EACH ROW EXECUTE FUNCTION rows_are_append_only();

DROP TRIGGER IF EXISTS position_events_no_delete ON "position_events";
CREATE TRIGGER position_events_no_delete
  BEFORE DELETE ON "position_events"
  FOR EACH ROW EXECUTE FUNCTION rows_are_append_only();

DROP TRIGGER IF EXISTS position_events_no_truncate ON "position_events";
CREATE TRIGGER position_events_no_truncate
  BEFORE TRUNCATE ON "position_events"
  FOR EACH STATEMENT EXECUTE FUNCTION rows_are_append_only();

DROP TRIGGER IF EXISTS risk_events_no_update ON "risk_events";
CREATE TRIGGER risk_events_no_update
  BEFORE UPDATE ON "risk_events"
  FOR EACH ROW EXECUTE FUNCTION rows_are_append_only();

DROP TRIGGER IF EXISTS risk_events_no_delete ON "risk_events";
CREATE TRIGGER risk_events_no_delete
  BEFORE DELETE ON "risk_events"
  FOR EACH ROW EXECUTE FUNCTION rows_are_append_only();

DROP TRIGGER IF EXISTS risk_events_no_truncate ON "risk_events";
CREATE TRIGGER risk_events_no_truncate
  BEFORE TRUNCATE ON "risk_events"
  FOR EACH STATEMENT EXECUTE FUNCTION rows_are_append_only();

-- `docs/anti-fraud.md`: "integrity_signal_events is append-only: RAISED,
-- RECURRED, STATUS_CHANGED..." — the history a fraud decision is justified by.
DROP TRIGGER IF EXISTS integrity_signal_events_no_update ON "integrity_signal_events";
CREATE TRIGGER integrity_signal_events_no_update
  BEFORE UPDATE ON "integrity_signal_events"
  FOR EACH ROW EXECUTE FUNCTION rows_are_append_only();

DROP TRIGGER IF EXISTS integrity_signal_events_no_delete ON "integrity_signal_events";
CREATE TRIGGER integrity_signal_events_no_delete
  BEFORE DELETE ON "integrity_signal_events"
  FOR EACH ROW EXECUTE FUNCTION rows_are_append_only();

DROP TRIGGER IF EXISTS integrity_signal_events_no_truncate ON "integrity_signal_events";
CREATE TRIGGER integrity_signal_events_no_truncate
  BEFORE TRUNCATE ON "integrity_signal_events"
  FOR EACH STATEMENT EXECUTE FUNCTION rows_are_append_only();

-- Belt as well as braces, as with audit_logs: nothing where the application
-- role owns its tables, load-bearing the moment a deployment separates them.
REVOKE UPDATE, DELETE, TRUNCATE ON
  "balance_ledger", "order_events", "position_events", "risk_events",
  "integrity_signal_events"
FROM PUBLIC;

COMMENT ON TABLE balance_ledger IS
  'Append-only. The record of every movement of customer money; UPDATE, DELETE and TRUNCATE are refused by trigger. Correct a mistake with a compensating ADJUSTMENT entry that references the original via compensates_id.';
