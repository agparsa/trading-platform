-- Commercial terms become a tenant's own.
--
-- Until now `symbol_specs` held both halves of an instrument: the contract
-- specification, which is a fact about the world, and the firm's terms, which
-- are a commercial decision. With one tenant that was harmless. With two it is
-- a hole in the isolation boundary — `POST /admin/instruments/:code/terms`
-- wrote a global row, so one firm's administrator raising a margin rate would
-- put the other firm's accounts into margin call without anybody touching them.
--
-- Every column is nullable and null means "the platform default". A tenant that
-- wants a different margin rate does not have to restate the commission, the
-- swap and the size cap — and, more to the point, will not silently freeze them
-- at whatever they happened to be the day the row was written.
--
-- No backfill. An absent row is a tenant on the platform's terms, which is
-- exactly where every existing tenant is today.

CREATE TABLE "tenant_symbol_terms" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "symbol_id" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "margin_rate" DECIMAL(18,8),
    "commission_per_lot" DECIMAL(28,10),
    "swap_long_per_lot" DECIMAL(28,10),
    "swap_short_per_lot" DECIMAL(28,10),
    "max_volume" DECIMAL(18,8),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "tenant_symbol_terms_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "tenant_symbol_terms_tenant_id_symbol_id_key"
  ON "tenant_symbol_terms"("tenant_id", "symbol_id");
CREATE INDEX "tenant_symbol_terms_tenant_id_idx" ON "tenant_symbol_terms"("tenant_id");

ALTER TABLE "tenant_symbol_terms" ADD CONSTRAINT "tenant_symbol_terms_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "tenant_symbol_terms" ADD CONSTRAINT "tenant_symbol_terms_symbol_id_fkey"
  FOREIGN KEY ("symbol_id") REFERENCES "symbols"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Same policy as every other owned table; see tenant_row_level_security.
ALTER TABLE "tenant_symbol_terms" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_symbol_terms_tenant_isolation" ON "tenant_symbol_terms";
CREATE POLICY "tenant_symbol_terms_tenant_isolation" ON "tenant_symbol_terms"
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
