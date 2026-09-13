-- A withdrawal could name a hold that never happened, or one from another
-- firm's wallet.
--
-- `hold_transaction_id` and `release_transaction_id` were bare `uuid` columns.
-- They are the link between a withdrawal and the movement that actually took
-- the money out of somebody's wallet, and nothing checked that the movement
-- existed, belonged to that wallet, or belonged to that firm. Reproduced
-- against the live schema before this migration:
--
--   -- firm A holds 500 in A's wallet
--   INSERT INTO withdrawal_requests (... wallet_id = B's wallet,
--                                    hold_transaction_id = A's movement ...);
--   ACCEPTED: firm B holds a withdrawal backed by firm A's money
--
--   INSERT INTO withdrawal_requests (... hold_transaction_id = a uuid that
--                                    names nothing at all ...);
--   ACCEPTED: a withdrawal whose hold does not exist
--
-- Neither is reachable through `WithdrawalsService.request`, which writes the
-- hold and the request inside one transaction and takes the id straight from
-- the movement it just made. But "the code currently gets this right" is not a
-- constraint, and the shape of the failure if it ever stopped being right is
-- money held from one person and paid to another.
--
-- ## Why the key is three columns and not one
--
-- A foreign key on `hold_transaction_id` alone fixes only the second case. The
-- first — the one that costs somebody their money — needs the firm and the
-- wallet in the key, so the movement has to belong to the same wallet the
-- withdrawal is against. That requires a unique index on
-- `(tenant_id, wallet_id, id)`; `id` is already unique on its own, so the index
-- adds no constraint that was not already true, only a target to point at.
--
-- `release_transaction_id` is nullable, and a composite foreign key with a null
-- column is not checked at all (MATCH SIMPLE). That is exactly the behaviour
-- wanted: unchecked while the money has not gone back, fully checked the moment
-- it has.
--
-- ## Rollback, and what this does to a deploy
--
-- Additive: every release in this repository writes these columns from a
-- movement created in the same transaction, so an older image satisfies the
-- constraint unchanged and the rollback floor does not move.
--
-- But `ADD CONSTRAINT` validates the rows already there, so if production holds
-- a withdrawal that violates this, the migration fails and the deploy stops
-- with the old containers still serving. That is the right outcome and it is
-- also an unhelpful error to read at 3am, so the check below runs first and
-- says what is wrong in words. If it fires, do not drop the constraint: the
-- rows it names are withdrawals whose money cannot be accounted for, and that
-- is a thing to investigate, not to migrate past.

DO $$
DECLARE
  orphaned bigint;
  misplaced bigint;
BEGIN
  SELECT count(*) INTO orphaned
  FROM withdrawal_requests w
  WHERE NOT EXISTS (SELECT 1 FROM wallet_transactions t WHERE t.id = w.hold_transaction_id)
     OR (w.release_transaction_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM wallet_transactions t WHERE t.id = w.release_transaction_id));

  SELECT count(*) INTO misplaced
  FROM withdrawal_requests w
  JOIN wallet_transactions t ON t.id = w.hold_transaction_id
  WHERE t.wallet_id IS DISTINCT FROM w.wallet_id
     OR t.tenant_id IS DISTINCT FROM w.tenant_id;

  IF orphaned > 0 OR misplaced > 0 THEN
    RAISE EXCEPTION
      'Cannot add the withdrawal hold constraint: % withdrawal(s) name a wallet movement that does not exist, and % name one belonging to a different wallet or firm. These are withdrawals whose money cannot be accounted for. Investigate them before deploying; do not remove this check.',
      orphaned, misplaced
      USING ERRCODE = 'data_exception';
  END IF;
END;
$$;

-- CreateIndex
CREATE UNIQUE INDEX "wallet_transactions_tenant_id_wallet_id_id_key" ON "wallet_transactions"("tenant_id", "wallet_id", "id");

-- AddForeignKey
ALTER TABLE "withdrawal_requests" ADD CONSTRAINT "withdrawal_requests_tenant_id_wallet_id_hold_transaction_i_fkey" FOREIGN KEY ("tenant_id", "wallet_id", "hold_transaction_id") REFERENCES "wallet_transactions"("tenant_id", "wallet_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "withdrawal_requests" ADD CONSTRAINT "withdrawal_requests_tenant_id_wallet_id_release_transactio_fkey" FOREIGN KEY ("tenant_id", "wallet_id", "release_transaction_id") REFERENCES "wallet_transactions"("tenant_id", "wallet_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
