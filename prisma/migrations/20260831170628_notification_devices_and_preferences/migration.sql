-- CreateEnum
CREATE TYPE "DevicePlatform" AS ENUM ('IOS', 'ANDROID', 'WEB');

-- CreateEnum
CREATE TYPE "NotificationCategory" AS ENUM ('TRADE_OPENED', 'TRADE_CLOSED', 'TRADE_MODIFIED', 'ORDER_FILLED', 'ORDER_CANCELLED', 'STOP_LOSS', 'TAKE_PROFIT', 'RISK_ALERT', 'SECURITY_ALERT', 'SYSTEM');

-- AlterEnum
ALTER TYPE "NotificationChannel" ADD VALUE 'PUSH';

-- CreateTable
CREATE TABLE "devices" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "platform" "DevicePlatform" NOT NULL,
    "installation_id" TEXT NOT NULL,
    "push_token" TEXT,
    "push_token_fingerprint" TEXT,
    "push_token_rejected_at" TIMESTAMPTZ(6),
    "app_version" TEXT,
    "os_version" TEXT,
    "model" TEXT,
    "locale" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_preferences" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "category" "NotificationCategory" NOT NULL,
    "in_app" BOOLEAN NOT NULL DEFAULT true,
    "push" BOOLEAN NOT NULL DEFAULT true,
    "sound" BOOLEAN NOT NULL DEFAULT true,
    "email" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_settings" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "trading_enabled" BOOLEAN NOT NULL DEFAULT true,
    "push_enabled" BOOLEAN NOT NULL DEFAULT true,
    "sound_enabled" BOOLEAN NOT NULL DEFAULT true,
    "vibration_enabled" BOOLEAN NOT NULL DEFAULT true,
    "sound_volume" INTEGER NOT NULL DEFAULT 80,
    "quiet_hours_start_minute" INTEGER,
    "quiet_hours_end_minute" INTEGER,
    "quiet_hours_timezone" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "notification_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "devices_tenant_id_user_id_is_active_idx" ON "devices"("tenant_id", "user_id", "is_active");

-- CreateIndex
CREATE INDEX "devices_tenant_id_idx" ON "devices"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "devices_tenant_id_user_id_installation_id_key" ON "devices"("tenant_id", "user_id", "installation_id");

-- CreateIndex
CREATE INDEX "notification_preferences_tenant_id_idx" ON "notification_preferences"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "notification_preferences_tenant_id_user_id_category_key" ON "notification_preferences"("tenant_id", "user_id", "category");

-- CreateIndex
CREATE INDEX "notification_settings_tenant_id_idx" ON "notification_settings"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "notification_settings_tenant_id_user_id_key" ON "notification_settings"("tenant_id", "user_id");

-- AddForeignKey
ALTER TABLE "devices" ADD CONSTRAINT "devices_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "devices" ADD CONSTRAINT "devices_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_settings" ADD CONSTRAINT "notification_settings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_settings" ADD CONSTRAINT "notification_settings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Row-level security for the three new tables.
--
-- Every tenant-scoped table gets a policy in the same migration that creates
-- it. Adding the table now and the policy "later" is exactly the failure mode
-- 20260831150000 warns about: a model missing from TENANT_SCOPED_MODELS is
-- silently unprotected, and a table missing from this list is unprotected in
-- the layer that exists to catch that mistake.
--
-- `devices` is the one that would hurt most. A row there holds a sealed push
-- token; a cross-tenant read of this table is a list of another firm's traders
-- and a means of delivering messages to their phones.

ALTER TABLE "devices" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "devices_tenant_isolation" ON "devices";
CREATE POLICY "devices_tenant_isolation" ON "devices"
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

ALTER TABLE "notification_preferences" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "notification_preferences_tenant_isolation" ON "notification_preferences";
CREATE POLICY "notification_preferences_tenant_isolation" ON "notification_preferences"
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

ALTER TABLE "notification_settings" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "notification_settings_tenant_isolation" ON "notification_settings";
CREATE POLICY "notification_settings_tenant_isolation" ON "notification_settings"
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
