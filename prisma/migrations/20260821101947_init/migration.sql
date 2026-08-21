-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('USER', 'SUPPORT', 'OPERATOR', 'ADMIN');

-- CreateEnum
CREATE TYPE "AccountStatus" AS ENUM ('ACTIVE', 'RESTRICTED', 'CLOSE_ONLY', 'SUSPENDED', 'CLOSED');

-- CreateEnum
CREATE TYPE "AccountType" AS ENUM ('LIVE', 'DEMO');

-- CreateEnum
CREATE TYPE "OrderSide" AS ENUM ('BUY', 'SELL');

-- CreateEnum
CREATE TYPE "OrderType" AS ENUM ('MARKET', 'LIMIT', 'STOP', 'STOP_LIMIT');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('NEW', 'PENDING', 'ACCEPTED', 'TRIGGERED', 'PARTIALLY_FILLED', 'FILLED', 'MODIFY_REQUESTED', 'CANCEL_REQUESTED', 'CANCELLED', 'REJECTED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "TimeInForce" AS ENUM ('GTC', 'IOC', 'FOK', 'DAY', 'GTD');

-- CreateEnum
CREATE TYPE "OrderEventType" AS ENUM ('CREATED', 'VALIDATED', 'ACCEPTED', 'REJECTED', 'TRIGGERED', 'PARTIALLY_FILLED', 'FILLED', 'MODIFY_REQUESTED', 'MODIFIED', 'CANCEL_REQUESTED', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "PositionStatus" AS ENUM ('OPEN', 'CLOSING', 'CLOSED');

-- CreateEnum
CREATE TYPE "CloseReason" AS ENUM ('MANUAL', 'STOP_LOSS', 'TAKE_PROFIT', 'TRAILING_STOP', 'LIQUIDATION', 'REVERSE', 'SYSTEM');

-- CreateEnum
CREATE TYPE "LedgerEntryType" AS ENUM ('DEPOSIT', 'WITHDRAWAL', 'TRADE_PROFIT', 'TRADE_LOSS', 'COMMISSION', 'SWAP', 'FEE', 'ADJUSTMENT');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'USER',
    "email_verified" BOOLEAN NOT NULL DEFAULT false,
    "totp_secret" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "last_login_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "replaced_by" UUID,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "user_agent" TEXT,
    "ip_address" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "accounts" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "type" "AccountType" NOT NULL DEFAULT 'DEMO',
    "status" "AccountStatus" NOT NULL DEFAULT 'ACTIVE',
    "currency" VARCHAR(3) NOT NULL,
    "balance" DECIMAL(28,10) NOT NULL DEFAULT 0,
    "leverage" INTEGER NOT NULL DEFAULT 100,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account_settings" (
    "account_id" UUID NOT NULL,
    "margin_call_level_percent" DECIMAL(10,4) NOT NULL DEFAULT 100,
    "stop_out_level_percent" DECIMAL(10,4) NOT NULL DEFAULT 50,
    "max_position_volume" DECIMAL(18,8),
    "max_open_positions" INTEGER,
    "max_gross_notional" DECIMAL(28,10),
    "max_symbol_net_volume" DECIMAL(18,8),
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "account_settings_pkey" PRIMARY KEY ("account_id")
);

-- CreateTable
CREATE TABLE "symbols" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "quote_currency" VARCHAR(3) NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "category" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "symbols_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "symbol_specs" (
    "symbol_id" UUID NOT NULL,
    "contract_size" DECIMAL(28,10) NOT NULL,
    "tick_size" DECIMAL(28,10) NOT NULL,
    "price_precision" INTEGER NOT NULL,
    "volume_step" DECIMAL(18,8) NOT NULL,
    "volume_precision" INTEGER NOT NULL,
    "min_volume" DECIMAL(18,8) NOT NULL,
    "max_volume" DECIMAL(18,8) NOT NULL,
    "margin_rate" DECIMAL(18,8) NOT NULL,
    "commission_per_lot" DECIMAL(28,10) NOT NULL DEFAULT 0,
    "swap_long_per_lot" DECIMAL(28,10) NOT NULL DEFAULT 0,
    "swap_short_per_lot" DECIMAL(28,10) NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "symbol_specs_pkey" PRIMARY KEY ("symbol_id")
);

-- CreateTable
CREATE TABLE "market_sessions" (
    "id" UUID NOT NULL,
    "symbol_id" UUID NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "day_of_week" INTEGER NOT NULL,
    "open_minute" INTEGER NOT NULL,
    "close_minute" INTEGER NOT NULL,

    CONSTRAINT "market_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "candles" (
    "symbol_code" TEXT NOT NULL,
    "resolution" TEXT NOT NULL,
    "time" TIMESTAMPTZ(6) NOT NULL,
    "open" DECIMAL(28,10) NOT NULL,
    "high" DECIMAL(28,10) NOT NULL,
    "low" DECIMAL(28,10) NOT NULL,
    "close" DECIMAL(28,10) NOT NULL,
    "volume" DECIMAL(28,10) NOT NULL,

    CONSTRAINT "candles_pkey" PRIMARY KEY ("symbol_code","resolution","time")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "symbol_id" UUID NOT NULL,
    "side" "OrderSide" NOT NULL,
    "type" "OrderType" NOT NULL,
    "status" "OrderStatus" NOT NULL DEFAULT 'NEW',
    "time_in_force" "TimeInForce" NOT NULL DEFAULT 'GTC',
    "volume" DECIMAL(18,8) NOT NULL,
    "filled_volume" DECIMAL(18,8) NOT NULL DEFAULT 0,
    "price" DECIMAL(28,10),
    "stop_price" DECIMAL(28,10),
    "stop_loss" DECIMAL(28,10),
    "take_profit" DECIMAL(28,10),
    "position_id" UUID,
    "rejection_code" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "expires_at" TIMESTAMPTZ(6),

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_events" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "type" "OrderEventType" NOT NULL,
    "from_status" "OrderStatus",
    "to_status" "OrderStatus" NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "positions" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "symbol_id" UUID NOT NULL,
    "side" "OrderSide" NOT NULL,
    "status" "PositionStatus" NOT NULL DEFAULT 'OPEN',
    "volume" DECIMAL(18,8) NOT NULL,
    "initial_volume" DECIMAL(18,8) NOT NULL,
    "entry_price" DECIMAL(28,10) NOT NULL,
    "current_price" DECIMAL(28,10),
    "stop_loss" DECIMAL(28,10),
    "take_profit" DECIMAL(28,10),
    "trailing_stop_distance" DECIMAL(28,10),
    "high_water_price" DECIMAL(28,10),
    "margin" DECIMAL(28,10) NOT NULL,
    "commission" DECIMAL(28,10) NOT NULL DEFAULT 0,
    "swap" DECIMAL(28,10) NOT NULL DEFAULT 0,
    "realized_pnl" DECIMAL(28,10) NOT NULL DEFAULT 0,
    "close_reason" "CloseReason",
    "version" INTEGER NOT NULL DEFAULT 0,
    "opened_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "closed_at" TIMESTAMPTZ(6),

    CONSTRAINT "positions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "position_events" (
    "id" UUID NOT NULL,
    "position_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "from_status" "PositionStatus",
    "to_status" "PositionStatus" NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "position_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "executions" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "side" "OrderSide" NOT NULL,
    "volume" DECIMAL(18,8) NOT NULL,
    "price" DECIMAL(28,10) NOT NULL,
    "quote_bid" DECIMAL(28,10) NOT NULL,
    "quote_ask" DECIMAL(28,10) NOT NULL,
    "quote_at" TIMESTAMPTZ(6) NOT NULL,
    "executed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "executions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trades" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "position_id" UUID NOT NULL,
    "symbol_id" UUID NOT NULL,
    "side" "OrderSide" NOT NULL,
    "volume" DECIMAL(18,8) NOT NULL,
    "entry_price" DECIMAL(28,10) NOT NULL,
    "exit_price" DECIMAL(28,10) NOT NULL,
    "entry_time" TIMESTAMPTZ(6) NOT NULL,
    "exit_time" TIMESTAMPTZ(6) NOT NULL,
    "gross_pnl" DECIMAL(28,10) NOT NULL,
    "commission" DECIMAL(28,10) NOT NULL,
    "swap" DECIMAL(28,10) NOT NULL,
    "net_pnl" DECIMAL(28,10) NOT NULL,
    "close_reason" "CloseReason" NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trades_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "balance_ledger" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "type" "LedgerEntryType" NOT NULL,
    "amount" DECIMAL(28,10) NOT NULL,
    "balance_after" DECIMAL(28,10) NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "reference_type" TEXT,
    "reference_id" UUID,
    "compensates_id" UUID,
    "idempotency_key" TEXT,
    "description" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "balance_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account_snapshots" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "taken_at" TIMESTAMPTZ(6) NOT NULL,
    "balance" DECIMAL(28,10) NOT NULL,
    "equity" DECIMAL(28,10) NOT NULL,
    "used_margin" DECIMAL(28,10) NOT NULL,
    "free_margin" DECIMAL(28,10) NOT NULL,
    "margin_level" DECIMAL(18,6),
    "floating_pnl" DECIMAL(28,10) NOT NULL,
    "open_positions" INTEGER NOT NULL,

    CONSTRAINT "account_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "risk_rules" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "parameters" JSONB NOT NULL DEFAULT '{}',
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "risk_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "risk_events" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "rule" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'WARNING',
    "message" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "risk_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "actor_id" UUID,
    "actor_type" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "resource_type" TEXT NOT NULL,
    "resource_id" TEXT,
    "before" JSONB,
    "after" JSONB,
    "request_id" TEXT,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_keys" (
    "id" UUID NOT NULL,
    "scope" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'IN_PROGRESS',
    "response_code" INTEGER,
    "response_body" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "refresh_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "refresh_tokens_user_id_revoked_at_idx" ON "refresh_tokens"("user_id", "revoked_at");

-- CreateIndex
CREATE UNIQUE INDEX "accounts_number_key" ON "accounts"("number");

-- CreateIndex
CREATE INDEX "accounts_user_id_status_idx" ON "accounts"("user_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "symbols_code_key" ON "symbols"("code");

-- CreateIndex
CREATE UNIQUE INDEX "market_sessions_symbol_id_day_of_week_open_minute_key" ON "market_sessions"("symbol_id", "day_of_week", "open_minute");

-- CreateIndex
CREATE INDEX "candles_symbol_code_resolution_time_idx" ON "candles"("symbol_code", "resolution", "time" DESC);

-- CreateIndex
CREATE INDEX "orders_account_id_status_idx" ON "orders"("account_id", "status");

-- CreateIndex
CREATE INDEX "orders_account_id_created_at_idx" ON "orders"("account_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "orders_symbol_id_status_idx" ON "orders"("symbol_id", "status");

-- CreateIndex
CREATE INDEX "order_events_order_id_created_at_idx" ON "order_events"("order_id", "created_at");

-- CreateIndex
CREATE INDEX "positions_account_id_status_idx" ON "positions"("account_id", "status");

-- CreateIndex
CREATE INDEX "positions_symbol_id_status_idx" ON "positions"("symbol_id", "status");

-- CreateIndex
CREATE INDEX "position_events_position_id_created_at_idx" ON "position_events"("position_id", "created_at");

-- CreateIndex
CREATE INDEX "executions_account_id_executed_at_idx" ON "executions"("account_id", "executed_at" DESC);

-- CreateIndex
CREATE INDEX "executions_order_id_idx" ON "executions"("order_id");

-- CreateIndex
CREATE INDEX "trades_account_id_exit_time_idx" ON "trades"("account_id", "exit_time" DESC);

-- CreateIndex
CREATE INDEX "trades_position_id_idx" ON "trades"("position_id");

-- CreateIndex
CREATE UNIQUE INDEX "balance_ledger_idempotency_key_key" ON "balance_ledger"("idempotency_key");

-- CreateIndex
CREATE INDEX "balance_ledger_account_id_created_at_idx" ON "balance_ledger"("account_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "balance_ledger_reference_type_reference_id_idx" ON "balance_ledger"("reference_type", "reference_id");

-- CreateIndex
CREATE INDEX "account_snapshots_account_id_taken_at_idx" ON "account_snapshots"("account_id", "taken_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "account_snapshots_account_id_taken_at_key" ON "account_snapshots"("account_id", "taken_at");

-- CreateIndex
CREATE UNIQUE INDEX "risk_rules_name_key" ON "risk_rules"("name");

-- CreateIndex
CREATE INDEX "risk_events_account_id_created_at_idx" ON "risk_events"("account_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "risk_events_rule_created_at_idx" ON "risk_events"("rule", "created_at" DESC);

-- CreateIndex
CREATE INDEX "audit_logs_actor_id_created_at_idx" ON "audit_logs"("actor_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "audit_logs_resource_type_resource_id_idx" ON "audit_logs"("resource_type", "resource_id");

-- CreateIndex
CREATE INDEX "audit_logs_action_created_at_idx" ON "audit_logs"("action", "created_at" DESC);

-- CreateIndex
CREATE INDEX "idempotency_keys_expires_at_idx" ON "idempotency_keys"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_keys_scope_key_key" ON "idempotency_keys"("scope", "key");

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_settings" ADD CONSTRAINT "account_settings_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "symbol_specs" ADD CONSTRAINT "symbol_specs_symbol_id_fkey" FOREIGN KEY ("symbol_id") REFERENCES "symbols"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "market_sessions" ADD CONSTRAINT "market_sessions_symbol_id_fkey" FOREIGN KEY ("symbol_id") REFERENCES "symbols"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_symbol_id_fkey" FOREIGN KEY ("symbol_id") REFERENCES "symbols"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_position_id_fkey" FOREIGN KEY ("position_id") REFERENCES "positions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "positions" ADD CONSTRAINT "positions_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "positions" ADD CONSTRAINT "positions_symbol_id_fkey" FOREIGN KEY ("symbol_id") REFERENCES "symbols"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "position_events" ADD CONSTRAINT "position_events_position_id_fkey" FOREIGN KEY ("position_id") REFERENCES "positions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "executions" ADD CONSTRAINT "executions_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trades" ADD CONSTRAINT "trades_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trades" ADD CONSTRAINT "trades_position_id_fkey" FOREIGN KEY ("position_id") REFERENCES "positions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trades" ADD CONSTRAINT "trades_symbol_id_fkey" FOREIGN KEY ("symbol_id") REFERENCES "symbols"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "balance_ledger" ADD CONSTRAINT "balance_ledger_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_snapshots" ADD CONSTRAINT "account_snapshots_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "risk_events" ADD CONSTRAINT "risk_events_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
