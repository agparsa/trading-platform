-- Chart state, kept per person.
--
-- Three tables, because the three things have different lifetimes. A *layout*
-- is one arrangement of one instrument and belongs to an account, since the
-- levels on it are that account's positions. A *template* is a set of studies
-- with no instrument at all — built once, applied to whatever is opened next.
-- *Drawings* belong to the instrument: a trendline drawn on gold is about
-- gold, and a trader who switches layout expects their lines to still be
-- there. Folding drawings into a layout would silently lose them on a switch.
--
-- `content` is JSON this platform never parses. A chart's arrangement is the
-- renderer's own description of itself, and every renderer describes it
-- differently; having an opinion about a format we do not own means being
-- wrong about it the first time the renderer changes. It is stored, returned
-- and replaced verbatim. What lives in columns is only what can be answered
-- without parsing — whose, which instrument, which resolution, which to open —
-- and that is also the part that survives a change of renderer.


-- CreateTable
CREATE TABLE "chart_layouts" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "account_id" UUID,
    "name" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "resolution" TEXT NOT NULL,
    "content" JSONB NOT NULL DEFAULT '{}',
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "chart_layouts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chart_templates" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "content" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "chart_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_drawings" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "symbol" TEXT NOT NULL,
    "content" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "user_drawings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "chart_layouts_tenant_id_user_id_idx" ON "chart_layouts"("tenant_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "chart_layouts_user_id_account_id_name_key" ON "chart_layouts"("user_id", "account_id", "name");

-- CreateIndex
CREATE INDEX "chart_templates_tenant_id_user_id_idx" ON "chart_templates"("tenant_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "chart_templates_user_id_name_key" ON "chart_templates"("user_id", "name");

-- CreateIndex
CREATE INDEX "user_drawings_tenant_id_user_id_idx" ON "user_drawings"("tenant_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_drawings_user_id_symbol_key" ON "user_drawings"("user_id", "symbol");

-- AddForeignKey
ALTER TABLE "chart_layouts" ADD CONSTRAINT "chart_layouts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chart_layouts" ADD CONSTRAINT "chart_layouts_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chart_layouts" ADD CONSTRAINT "chart_layouts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chart_templates" ADD CONSTRAINT "chart_templates_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chart_templates" ADD CONSTRAINT "chart_templates_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_drawings" ADD CONSTRAINT "user_drawings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_drawings" ADD CONSTRAINT "user_drawings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- At most one default per person per account.
--
-- "Which chart do I get when I open the terminal" must not depend on row
-- order. A partial unique index says it once, in the place that cannot be
-- forgotten by a future writer.
--
-- Two indexes because `account_id` is nullable and Postgres treats NULLs as
-- distinct: without the second, a person could hold any number of
-- account-agnostic defaults.
CREATE UNIQUE INDEX "chart_layouts_one_default_per_account"
  ON "chart_layouts"("user_id", "account_id")
  WHERE "is_default" AND "account_id" IS NOT NULL;
CREATE UNIQUE INDEX "chart_layouts_one_default_without_account"
  ON "chart_layouts"("user_id")
  WHERE "is_default" AND "account_id" IS NULL;

-- Row-level security, as on every tenant-scoped table.
ALTER TABLE "chart_layouts" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "chart_layouts_tenant_isolation" ON "chart_layouts";
CREATE POLICY "chart_layouts_tenant_isolation" ON "chart_layouts"
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

ALTER TABLE "chart_templates" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "chart_templates_tenant_isolation" ON "chart_templates";
CREATE POLICY "chart_templates_tenant_isolation" ON "chart_templates"
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

ALTER TABLE "user_drawings" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "user_drawings_tenant_isolation" ON "user_drawings";
CREATE POLICY "user_drawings_tenant_isolation" ON "user_drawings"
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
