-- Tenant isolation, layer two, actually switched on.
--
-- ## What this corrects
--
-- The `tenant_row_level_security` migration installed the policies and then
-- explained, at length, why they could not constrain the application: PostgreSQL
-- exempts a table's owner from its own policies, the application owns its
-- tables, and setting `app.tenant_id` per statement looked like a choice between
-- wrapping every read in a transaction or moving to a driver adapter.
--
-- That note is now wrong in its conclusion, and it is left in place because
-- rewriting an applied migration is worse than a note that says what was
-- believed at the time. Read this one after it.
--
-- There is a third way and it costs nothing. PostgreSQL accepts `options` in the
-- startup packet, so a connection can be born with `app.tenant_id` already set:
--
--   postgresql://…/db?options=-c%20app.tenant_id=<uuid>
--
-- Prisma passes the parameter through. Measured against the same read on a local
-- socket: 0.72ms p50 with no policies at all, 0.54ms with the tenant bound to the
-- connection, 1.85ms with `set_config` inside a transaction. The middle one is
-- the one this platform now uses — `packages/tenancy/src/registry.ts` keeps a
-- connection pool per tenant.
--
-- ## Why this migration does not use FORCE
--
-- FORCE would subject the owner to the policies too, and the owner's exemption
-- is not an oversight — it is the escape hatch. `withoutTenantScope(reason)` is
-- how the sign-in lookup finds a user before it knows their tenant, and how the
-- reconciliation sweep lists which tenants exist. Those run on the owner
-- connection precisely because it can see across. Forcing the policies would
-- remove that mechanism rather than tighten anything, and the alternative —
-- granting BYPASSRLS to the owner — is the same exemption spelled with more
-- moving parts and a superuser.
--
-- What makes the policies bite is the *second role*: `DATABASE_URL_TENANT`,
-- pointing at a login role that owns nothing, has SELECT/INSERT/UPDATE/DELETE and
-- no CREATE, and is NOBYPASSRLS. `pnpm db:roles` creates it. The API and the
-- worker each probe at boot and refuse to start if that variable is set and the
-- role turns out to be exempt after all — the one part of this that cannot be
-- checked by reading code.
--
-- ## What this migration changes
--
-- The comment on `current_tenant_id`, so that an analyst who finds this function
-- in psql — which is exactly who the policies were already protecting — reads
-- how it is fed rather than guessing.

COMMENT ON FUNCTION current_tenant_id() IS
  'The tenant in scope for this transaction, or NULL. NULL matches no row. Set by the application '
  'through the connection''s startup options (options=-c app.tenant_id=<uuid>), one pool per tenant, '
  'on a role that owns no tables. The owner role is exempt from these policies by design and is '
  'used only for deliberate cross-tenant work. See docs/multi-tenancy.md.';
