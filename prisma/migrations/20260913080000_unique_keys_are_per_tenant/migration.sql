-- Client-supplied identifiers are unique per firm, not across the platform.
--
-- Every index dropped here was global on a tenant-scoped table, and every key
-- it covered is chosen by somebody outside this platform: a caller's
-- `Idempotency-Key`, a trader's own order reference, a venue's id for a
-- position or a fill, a payment provider's reference. Two firms picking the
-- same string is ordinary, and it was breaking the second one — a unique
-- constraint is enforced across rows that row-level security hides, so firm B
-- was refused an order it could not see the reason for, and could use the
-- failure to learn which references firm A had used.
--
-- `IdempotencyKey` already had this shape (`@@unique([tenantId, scope, key])`),
-- which is what makes these an oversight rather than a decision.
--
-- Widening, not narrowing: every write that succeeded before still succeeds,
-- so an older image runs against this schema unchanged. Left global on purpose
-- are the keys that are *meant* to be unique platform-wide — token and
-- recovery-code hashes, key fingerprints, minted UUIDs — where a collision
-- across firms would be a security problem rather than an inconvenience.

-- DropIndex
DROP INDEX "balance_ledger_idempotency_key_key";
-- DropIndex
DROP INDEX "executions_external_execution_id_key";
-- DropIndex
DROP INDEX "orders_client_order_id_key";
-- DropIndex
DROP INDEX "payment_events_provider_provider_event_id_key";
-- DropIndex
DROP INDEX "payment_intents_provider_provider_reference_key";
-- DropIndex
DROP INDEX "positions_external_position_id_key";
-- DropIndex
DROP INDEX "wallet_transactions_idempotency_key_key";

-- CreateIndex
CREATE UNIQUE INDEX "balance_ledger_tenant_id_idempotency_key_key" ON "balance_ledger"("tenant_id", "idempotency_key");
-- CreateIndex
CREATE UNIQUE INDEX "executions_tenant_id_external_execution_id_key" ON "executions"("tenant_id", "external_execution_id");
-- CreateIndex
CREATE UNIQUE INDEX "orders_tenant_id_client_order_id_key" ON "orders"("tenant_id", "client_order_id");
-- CreateIndex
CREATE UNIQUE INDEX "payment_events_tenant_id_provider_provider_event_id_key" ON "payment_events"("tenant_id", "provider", "provider_event_id");
-- CreateIndex
CREATE UNIQUE INDEX "payment_intents_tenant_id_provider_provider_reference_key" ON "payment_intents"("tenant_id", "provider", "provider_reference");
-- CreateIndex
CREATE UNIQUE INDEX "positions_tenant_id_external_position_id_key" ON "positions"("tenant_id", "external_position_id");
-- CreateIndex
CREATE UNIQUE INDEX "wallet_transactions_tenant_id_idempotency_key_key" ON "wallet_transactions"("tenant_id", "idempotency_key");
