-- Make the audit log append-only in the database, not just in the application.
--
-- Until now nothing in the API offered a way to edit or delete an audit row,
-- which is a convention. Conventions do not survive a database connection, and
-- the specification requires that a normal administrator cannot modify or
-- delete audit records. This makes that true of Postgres.
--
-- A trigger rather than a REVOKE, deliberately.
--
-- REVOKE UPDATE, DELETE ON audit_logs is the obvious instrument and it is the
-- wrong one on its own: a table's owner keeps every privilege regardless of
-- what is granted, and in most deployments here the application role owns its
-- tables. The REVOKE would appear to work and would do nothing. A trigger fires
-- for the owner too.
--
-- What this does NOT claim: an actor who can execute DDL as the table's owner
-- can ALTER TABLE ... DISABLE TRIGGER and then do as they like. The integration
-- test harness does exactly that to reset between runs, which is the honest
-- demonstration of the limit. That is not a
-- hole this migration can close from inside the database. Closing it properly
-- means the application connecting as a role that does not own its tables, or
-- shipping audit records to an append-only sink outside this database. Both are
-- deployment decisions; see docs/security.md. What this migration buys is that
-- an ordinary UPDATE or DELETE — the accident, the careless cleanup script, the
-- SQL injection that got as far as a statement — fails loudly and leaves the
-- row intact.

CREATE OR REPLACE FUNCTION audit_logs_are_append_only()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'audit_logs is append-only: % is not permitted on this table', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

DROP TRIGGER IF EXISTS audit_logs_no_update ON audit_logs;
CREATE TRIGGER audit_logs_no_update
  BEFORE UPDATE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_are_append_only();

DROP TRIGGER IF EXISTS audit_logs_no_delete ON audit_logs;
CREATE TRIGGER audit_logs_no_delete
  BEFORE DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_are_append_only();

-- TRUNCATE does not fire row-level triggers, so without this it would be the
-- one statement that empties the table while UPDATE and DELETE are refused —
-- an unlocked back door beside two locked front ones. It needs a statement-level
-- trigger of its own.
DROP TRIGGER IF EXISTS audit_logs_no_truncate ON audit_logs;
CREATE TRIGGER audit_logs_no_truncate
  BEFORE TRUNCATE ON audit_logs
  FOR EACH STATEMENT EXECUTE FUNCTION audit_logs_are_append_only();

-- Belt as well as braces: harmless where the application role owns the table,
-- and load-bearing the moment a deployment separates the two, which is the
-- configuration docs/security.md recommends.
REVOKE UPDATE, DELETE ON audit_logs FROM PUBLIC;

COMMENT ON TABLE audit_logs IS
  'Append-only. INSERT and SELECT only; UPDATE, DELETE and TRUNCATE are refused by trigger.';
