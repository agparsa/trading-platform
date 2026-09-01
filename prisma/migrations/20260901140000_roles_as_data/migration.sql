-- Roles become rows; capabilities stay in code.
--
-- The distinction is the whole design. `ALL_PERMISSIONS` in `@tp/shared-types`
-- remains a compile-time constant, because code is what checks a capability and
-- one that exists only as a row is one no route can require. What moves into the
-- database is the *grant* — which role carries which capability — because that is
-- the part a firm needs to change without a deployment, and the part that differs
-- between tenants.
--
-- Seeded from `ROLE_PERMISSIONS` exactly as it stands, so the first day after
-- this migration behaves like the last day before it. The seed below was
-- generated from that constant rather than transcribed; `roles.service.test.ts`
-- asserts the rows and the constant still agree.
--
-- Two rules bound what a grant may become, and both live in code where they can
-- be unit-tested: nobody may grant a capability they do not themselves hold, and
-- no role may hold `accounts.adjust` alongside a capability that opens or
-- reshapes a position. See INCOMPATIBLE_PERMISSIONS.

CREATE TABLE "roles" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "role_permissions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "permission" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "roles_tenant_id_key_key" ON "roles"("tenant_id", "key");
CREATE INDEX "roles_tenant_id_idx" ON "roles"("tenant_id");
CREATE UNIQUE INDEX "role_permissions_role_id_permission_key" ON "role_permissions"("role_id", "permission");
CREATE INDEX "role_permissions_tenant_id_idx" ON "role_permissions"("tenant_id");

ALTER TABLE "roles" ADD CONSTRAINT "roles_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_fkey"
    FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Both tables carry a tenant_id, so both need a policy. A table with a tenant_id
-- and no policy is what `rls-enforcement.test.ts` fails the build over, and it
-- would be a particularly bad one to miss: the rows here decide what everybody
-- else is allowed to do.
ALTER TABLE "roles" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "roles_tenant_isolation" ON "roles";
CREATE POLICY "roles_tenant_isolation" ON "roles"
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

ALTER TABLE "role_permissions" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "role_permissions_tenant_isolation" ON "role_permissions";
CREATE POLICY "role_permissions_tenant_isolation" ON "role_permissions"
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

INSERT INTO roles (id, tenant_id, key, name, description, is_system, created_at, updated_at)
SELECT gen_random_uuid(), t.id, v.key, v.name, v.description, true, now(), now()
FROM tenants t
CROSS JOIN (VALUES
  ('USER', 'Trader', 'Trades their own accounts.'),
  ('SUPPORT', 'Support', 'Reads across accounts to answer questions. Changes nothing.'),
  ('OPERATOR', 'Operator', 'Runs the desk: cancels, closes, manages accounts.'),
  ('RISK_MANAGER', 'Risk manager', 'Sets limits, acts on integrity signals, holds the kill switch.'),
  ('ADMIN', 'Administrator', 'Everything administrative. Deliberately cannot open a position.')
) AS v(key, name, description)
ON CONFLICT (tenant_id, key) DO NOTHING;

INSERT INTO role_permissions (id, tenant_id, role_id, permission, created_at)
SELECT gen_random_uuid(), r.tenant_id, r.id, v.permission, now()
FROM roles r
JOIN (VALUES
  ('USER', 'accounts.read'),
  ('USER', 'orders.read'),
  ('USER', 'orders.create'),
  ('USER', 'orders.cancel'),
  ('USER', 'orders.modify'),
  ('USER', 'positions.read'),
  ('USER', 'positions.close'),
  ('USER', 'positions.modify'),
  ('SUPPORT', 'accounts.read_any'),
  ('SUPPORT', 'users.read_any'),
  ('SUPPORT', 'orders.read'),
  ('SUPPORT', 'positions.read'),
  ('SUPPORT', 'master.read'),
  ('OPERATOR', 'accounts.read_any'),
  ('OPERATOR', 'accounts.manage'),
  ('OPERATOR', 'users.read_any'),
  ('OPERATOR', 'orders.read'),
  ('OPERATOR', 'orders.cancel'),
  ('OPERATOR', 'positions.read'),
  ('OPERATOR', 'positions.close'),
  ('OPERATOR', 'positions.modify'),
  ('OPERATOR', 'risk.read'),
  ('OPERATOR', 'master.read'),
  ('OPERATOR', 'integrity.read'),
  ('OPERATOR', 'instruments.read'),
  ('OPERATOR', 'reconciliation.read'),
  ('OPERATOR', 'system.operations'),
  ('RISK_MANAGER', 'accounts.read_any'),
  ('RISK_MANAGER', 'accounts.manage'),
  ('RISK_MANAGER', 'users.read_any'),
  ('RISK_MANAGER', 'users.manage'),
  ('RISK_MANAGER', 'orders.read'),
  ('RISK_MANAGER', 'orders.cancel'),
  ('RISK_MANAGER', 'positions.read'),
  ('RISK_MANAGER', 'positions.close'),
  ('RISK_MANAGER', 'risk.read'),
  ('RISK_MANAGER', 'risk.manage'),
  ('RISK_MANAGER', 'audit.read'),
  ('RISK_MANAGER', 'master.read'),
  ('RISK_MANAGER', 'integrity.read'),
  ('RISK_MANAGER', 'integrity.manage'),
  ('RISK_MANAGER', 'instruments.read'),
  ('RISK_MANAGER', 'reconciliation.read'),
  ('RISK_MANAGER', 'reconciliation.manage'),
  ('RISK_MANAGER', 'reconciliation.run'),
  ('RISK_MANAGER', 'roles.read'),
  ('RISK_MANAGER', 'system.operations'),
  ('RISK_MANAGER', 'system.kill_switch'),
  ('ADMIN', 'accounts.read'),
  ('ADMIN', 'accounts.read_any'),
  ('ADMIN', 'accounts.manage'),
  ('ADMIN', 'accounts.adjust'),
  ('ADMIN', 'users.read_any'),
  ('ADMIN', 'users.manage'),
  ('ADMIN', 'invites.manage'),
  ('ADMIN', 'orders.read'),
  ('ADMIN', 'orders.cancel'),
  ('ADMIN', 'positions.read'),
  ('ADMIN', 'risk.read'),
  ('ADMIN', 'risk.manage'),
  ('ADMIN', 'audit.read'),
  ('ADMIN', 'master.read'),
  ('ADMIN', 'master.manage'),
  ('ADMIN', 'integrity.read'),
  ('ADMIN', 'integrity.manage'),
  ('ADMIN', 'instruments.read'),
  ('ADMIN', 'instruments.manage'),
  ('ADMIN', 'reconciliation.read'),
  ('ADMIN', 'reconciliation.manage'),
  ('ADMIN', 'reconciliation.run'),
  ('ADMIN', 'roles.read'),
  ('ADMIN', 'roles.manage'),
  ('ADMIN', 'system.operations'),
  ('ADMIN', 'system.kill_switch')
) AS v(role_key, permission) ON v.role_key = r.key
WHERE r.is_system
ON CONFLICT (role_id, permission) DO NOTHING;
