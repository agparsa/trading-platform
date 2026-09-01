import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TenantClientRegistry, tenantScopeExtension } from '@tp/tenancy';
import { TEST_DATABASE_URL, createTestClient, hasTestDatabase, resetDatabase } from './harness';

/**
 * Row-level security, proved rather than assumed.
 *
 * Every other isolation test in this suite runs through the Prisma extension —
 * layer one — and so proves that layer one works. This file exists for the
 * cases layer one cannot see:
 *
 *   - `$queryRaw`, which does not pass through Prisma extensions at all;
 *   - a nested `connect`, whose strict unique input the extension cannot narrow;
 *   - a model added to the schema and forgotten in `TENANT_SCOPED_MODELS`.
 *
 * It can only prove them from a role the policies apply to, because PostgreSQL
 * exempts a table's owner from its own. `pnpm db:test:prepare` creates that role
 * and prints `TEST_DATABASE_URL_TENANT`.
 */
const TENANT_URL = process.env['TEST_DATABASE_URL_TENANT'];
const canProve = hasTestDatabase && typeof TENANT_URL === 'string' && TENANT_URL.length > 0;

const ALPHA = '00000000-0000-4000-8000-00000000a1fa';
const BETA = '00000000-0000-4000-8000-00000000be7a';

describe.skipIf(!canProve)('row-level security, from a role it applies to', () => {
  let owner: PrismaClient;
  let registry: TenantClientRegistry<PrismaClient>;
  let alphaUserId: string;
  let betaUserId: string;

  const clientFor = (url: string): PrismaClient =>
    new PrismaClient({ datasources: { db: { url } } }).$extends(
      tenantScopeExtension(),
    ) as unknown as PrismaClient;

  beforeAll(async () => {
    owner = createTestClient();
    await resetDatabase(owner);

    // Written through the owner, which is exempt, so the rows definitely exist
    // before anything asks whether they can be seen.
    await owner.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name, status, created_at, updated_at)
       VALUES ($1::uuid,'rls-alpha','RLS Alpha','ACTIVE',now(),now()),
              ($2::uuid,'rls-beta','RLS Beta','ACTIVE',now(),now())
       ON CONFLICT (id) DO NOTHING`,
      ALPHA,
      BETA,
    );
    const inserted = await owner.$queryRawUnsafe<Array<{ id: string; tenant_id: string }>>(
      `INSERT INTO users (id, email, password_hash, display_name, role, email_verified,
                          is_active, failed_login_attempts, created_at, updated_at, tenant_id)
       VALUES (gen_random_uuid(),'alpha@rls.test','x','Alpha','USER',true,true,0,now(),now(),$1::uuid),
              (gen_random_uuid(),'beta@rls.test','x','Beta','USER',true,true,0,now(),now(),$2::uuid)
       RETURNING id, tenant_id`,
      ALPHA,
      BETA,
    );
    alphaUserId = inserted.find((row) => row.tenant_id === ALPHA)?.id ?? '';
    betaUserId = inserted.find((row) => row.tenant_id === BETA)?.id ?? '';
    expect(alphaUserId).not.toBe('');
    expect(betaUserId).not.toBe('');

    registry = new TenantClientRegistry<PrismaClient>({
      tenantUrl: TENANT_URL as string,
      privilegedUrl: TEST_DATABASE_URL as string,
      createClient: clientFor,
    });
  });

  afterAll(async () => {
    await registry?.disconnectAll();
    await owner?.$disconnect();
  });

  it('connects as a role that is not the table owner', async () => {
    const rows = await registry.forTenant(ALPHA).$queryRaw<Array<{ role: string; owner: string }>>`
        SELECT current_user AS role, tableowner AS owner
        FROM pg_tables WHERE tablename = 'users'
      `;
    expect(rows[0]?.role).not.toBe(rows[0]?.owner);
  });

  /**
   * The headline. A raw query is the one thing that reaches the database with
   * no tenant filter of any kind, and it still cannot see across.
   */
  it('refuses a raw cross-tenant read', async () => {
    const alpha = registry.forTenant(ALPHA);

    const mine = await alpha.$queryRaw<Array<{ email: string }>>`SELECT email FROM users`;
    expect(mine.map((row) => row.email)).toEqual(['alpha@rls.test']);

    // Naming the other tenant's row by its primary key does not help.
    const theirs = await alpha.$queryRawUnsafe<Array<{ email: string }>>(
      `SELECT email FROM users WHERE id = $1::uuid`,
      betaUserId,
    );
    expect(theirs).toEqual([]);

    // Nor does asking for everything and counting.
    const counted = await alpha.$queryRaw<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM users
    `;
    expect(counted[0]?.n).toBe(1);
  });

  it('refuses a raw cross-tenant write', async () => {
    const alpha = registry.forTenant(ALPHA);
    const changed = await alpha.$executeRawUnsafe(
      `UPDATE users SET display_name = 'taken over' WHERE id = $1::uuid`,
      betaUserId,
    );
    expect(changed).toBe(0);

    const beta = await owner.$queryRawUnsafe<Array<{ display_name: string }>>(
      `SELECT display_name FROM users WHERE id = $1::uuid`,
      betaUserId,
    );
    expect(beta[0]?.display_name).toBe('Beta');
  });

  /**
   * The write side of the policy.
   *
   * Worth knowing while reading the migration: omitting `WITH CHECK` does *not*
   * leave writes unchecked — PostgreSQL falls back to the `USING` expression for
   * both. That was confirmed by removing it and watching this test still pass.
   * What does break it is `WITH CHECK (true)`, which is why the assertion is
   * here rather than in a comment claiming the clause is load-bearing.
   */
  it('refuses to write a row stamped with another tenant', async () => {
    const alpha = registry.forTenant(ALPHA);
    await expect(
      alpha.$executeRawUnsafe(
        `INSERT INTO users (id, email, password_hash, display_name, role, email_verified,
                            is_active, failed_login_attempts, created_at, updated_at, tenant_id)
         VALUES (gen_random_uuid(),'smuggled@rls.test','x','Smuggled','USER',true,true,0,now(),now(),$1::uuid)`,
        BETA,
      ),
    ).rejects.toThrow(/row-level security|violates/i);
  });

  it('sees nothing at all with no tenant bound', async () => {
    const rows = await registry.unscopedClient().$queryRaw<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM users
    `;
    expect(rows[0]?.n).toBe(0);
  });

  it('sees everything through the privileged client, which is the escape hatch', async () => {
    const rows = await registry.privilegedClient().$queryRaw<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM users
    `;
    expect(rows[0]?.n).toBe(2);
  });

  /**
   * The one the Prisma extension explicitly cannot close: `connect` takes a
   * strict unique input that will not accept an extra column, so nothing in
   * TypeScript stops this. The database does.
   */
  it('refuses a nested connect that reaches into another tenant', async () => {
    const alpha = registry.forTenant(ALPHA);
    await expect(
      alpha.$executeRawUnsafe(
        `INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at, created_at, tenant_id)
         VALUES (gen_random_uuid(), $1::uuid, 'hash', now() + interval '1 day', now(), $2::uuid)`,
        betaUserId,
        ALPHA,
      ),
    ).rejects.toThrow();
  });

  /**
   * A model added to the schema with a `tenantId` and no policy would be
   * unprotected in exactly the way this whole file exists to prevent, and
   * nothing else would notice: the extension would still filter it, so every
   * ordinary test would pass.
   */
  it('has row-level security enabled and a policy on every table with a tenant_id', async () => {
    const gaps = await owner.$queryRaw<Array<{ table_name: string; reason: string }>>`
      SELECT c.relname AS table_name,
             CASE WHEN NOT c.relrowsecurity THEN 'row-level security is not enabled'
                  ELSE 'no policy' END AS reason
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN information_schema.columns col
        ON col.table_name = c.relname
       AND col.table_schema = n.nspname
       AND col.column_name = 'tenant_id'
      WHERE n.nspname = current_schema()
        AND c.relkind = 'r'
        AND (NOT c.relrowsecurity
             OR NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid))
      ORDER BY c.relname
    `;
    expect(
      gaps,
      `These tables carry a tenant_id and are not protected by a policy:\n${gaps
        .map((gap) => `  ${gap.table_name}: ${gap.reason}`)
        .join('\n')}\nAdd them to a migration alongside the model.`,
    ).toEqual([]);
  });
});
