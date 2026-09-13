-- TRUNCATE is a deletion, and nine tables that refuse deletion allowed it.
--
-- `audit_log_append_only` worked this out and wrote it down, in a comment that
-- is still there:
--
--   "TRUNCATE does not fire row-level triggers, so without this it would be the
--    one statement that empties the table while UPDATE and DELETE are refused —
--    an unlocked back door beside two locked front ones."
--
-- That reasoning was applied to `audit_logs`, then to `security_events`, and to
-- nothing after. Every table that has since been given a `BEFORE DELETE ... FOR
-- EACH ROW` trigger got the locked front door and not the locked back one.
--
-- Reproduced before this migration was written, on `withdrawal_requests`:
--
--   DELETE FROM withdrawal_requests;
--   ERROR:  withdrawal_requests: rows end in a terminal state, they are never deleted
--   TRUNCATE TABLE withdrawal_requests;
--   rows_after_truncate | 0
--
-- One statement, no error, and the financial record `docs/withdrawals.md` calls
-- permanent is gone. The same held for credentials, KYC documents, venue
-- evidence, payment events, wallet transactions and resolution records — the
-- nine tables in this repository whose whole point is that their rows survive.
--
-- Whether an attacker can reach it depends on the deployment: TRUNCATE needs
-- table ownership or an explicit grant, and `docs/security.md` recommends
-- separating the application role from the owner. But these triggers exist for
-- the deployment that has *not* separated them — which is the one running in
-- production — and a guarantee that holds only under a configuration nobody
-- verified is not a guarantee.
--
-- Each table keeps its own refusal message: the trigger below reuses the
-- function that table already has, so an operator who hits this reads the same
-- sentence whichever statement they tried.

-- The one function that branched on TG_OP and so would have let a TRUNCATE
-- through the bottom: at statement level NEW and OLD are null, every comparison
-- below is null, and it would have fallen to `RETURN NEW` — permitting exactly
-- what it exists to refuse. The others RAISE unconditionally and are safe as
-- they stand.
CREATE OR REPLACE FUNCTION broker_inbound_events_are_evidence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'broker_inbound_events: what a venue sent is evidence and is not deleted'
      USING ERRCODE = '42501';
  END IF;
  IF NEW.connection_id      IS DISTINCT FROM OLD.connection_id
  OR NEW.tenant_id          IS DISTINCT FROM OLD.tenant_id
  OR NEW.external_event_id  IS DISTINCT FROM OLD.external_event_id
  OR NEW.payload            IS DISTINCT FROM OLD.payload
  OR NEW.kind               IS DISTINCT FROM OLD.kind
  OR NEW.occurred_at        IS DISTINCT FROM OLD.occurred_at
  OR NEW.received_at        IS DISTINCT FROM OLD.received_at THEN
    RAISE EXCEPTION 'broker_inbound_events: what a venue sent does not change; only how we handled it does'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS api_keys_no_truncate ON "api_keys";
CREATE TRIGGER api_keys_no_truncate
  BEFORE TRUNCATE ON "api_keys"
  FOR EACH STATEMENT EXECUTE FUNCTION credentials_never_deleted();

DROP TRIGGER IF EXISTS service_tokens_no_truncate ON "service_tokens";
CREATE TRIGGER service_tokens_no_truncate
  BEFORE TRUNCATE ON "service_tokens"
  FOR EACH STATEMENT EXECUTE FUNCTION credentials_never_deleted();

DROP TRIGGER IF EXISTS broker_credentials_no_truncate ON "broker_credentials";
CREATE TRIGGER broker_credentials_no_truncate
  BEFORE TRUNCATE ON "broker_credentials"
  FOR EACH STATEMENT EXECUTE FUNCTION broker_credentials_never_deleted();

DROP TRIGGER IF EXISTS broker_inbound_events_no_truncate ON "broker_inbound_events";
CREATE TRIGGER broker_inbound_events_no_truncate
  BEFORE TRUNCATE ON "broker_inbound_events"
  FOR EACH STATEMENT EXECUTE FUNCTION broker_inbound_events_are_evidence();

DROP TRIGGER IF EXISTS kyc_documents_no_truncate ON "kyc_documents";
CREATE TRIGGER kyc_documents_no_truncate
  BEFORE TRUNCATE ON "kyc_documents"
  FOR EACH STATEMENT EXECUTE FUNCTION kyc_documents_never_deleted();

DROP TRIGGER IF EXISTS payment_events_no_truncate ON "payment_events";
CREATE TRIGGER payment_events_no_truncate
  BEFORE TRUNCATE ON "payment_events"
  FOR EACH STATEMENT EXECUTE FUNCTION payment_events_append_only();

DROP TRIGGER IF EXISTS resolution_records_no_truncate ON "resolution_records";
CREATE TRIGGER resolution_records_no_truncate
  BEFORE TRUNCATE ON "resolution_records"
  FOR EACH STATEMENT EXECUTE FUNCTION resolution_records_are_append_only();

DROP TRIGGER IF EXISTS wallet_transactions_no_truncate ON "wallet_transactions";
CREATE TRIGGER wallet_transactions_no_truncate
  BEFORE TRUNCATE ON "wallet_transactions"
  FOR EACH STATEMENT EXECUTE FUNCTION wallet_transactions_append_only();

DROP TRIGGER IF EXISTS withdrawal_requests_no_truncate ON "withdrawal_requests";
CREATE TRIGGER withdrawal_requests_no_truncate
  BEFORE TRUNCATE ON "withdrawal_requests"
  FOR EACH STATEMENT EXECUTE FUNCTION withdrawal_requests_never_deleted();

-- Belt as well as braces, the same way audit_logs does it: harmless where the
-- application role owns the table, load-bearing the moment a deployment
-- separates the two.
REVOKE TRUNCATE ON
  "api_keys", "service_tokens", "broker_credentials", "broker_inbound_events",
  "kyc_documents", "payment_events", "resolution_records", "wallet_transactions",
  "withdrawal_requests"
FROM PUBLIC;
