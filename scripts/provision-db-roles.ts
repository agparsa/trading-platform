/**
 * Creates the unprivileged database role that tenant traffic runs as.
 *
 * ## Why a second role exists at all
 *
 * PostgreSQL exempts a table's owner from that table's row-level-security
 * policies. The application owns its tables — it has to, because migrations run
 * through the same connection string — so the policies installed by the
 * `tenant_row_level_security` migration constrained every role *except* the one
 * that most needed constraining.
 *
 * This role fixes that by not owning anything. It gets SELECT, INSERT, UPDATE
 * and DELETE and nothing else: no ownership, no CREATE on the schema, no
 * BYPASSRLS. Point `DATABASE_URL_TENANT` at it and the policies become
 * enforcement instead of documentation.
 *
 *   pnpm db:roles                       # reads DATABASE_TENANT_PASSWORD
 *   DATABASE_TENANT_ROLE=app pnpm db:roles
 *
 * Idempotent: safe to run after every deploy, and it must be, because default
 * privileges only cover tables that exist when they are granted.
 */
import { randomBytes } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is not set`);
  return value;
}

/**
 * A role name is interpolated into DDL, where it cannot be a bound parameter.
 * Restricting it to an unquoted identifier is what makes that safe, and it is
 * also the only shape that survives a connection string without quoting.
 */
function checkIdentifier(name: string): string {
  if (!IDENTIFIER.test(name)) {
    throw new Error(
      `Role name ${JSON.stringify(name)} must be lowercase letters, digits and underscores, ` +
        'starting with a letter or underscore. It goes into DDL, where it cannot be a parameter.',
    );
  }
  return name;
}

async function main(): Promise<void> {
  const databaseUrl = requireEnv('DATABASE_URL');
  const role = checkIdentifier(process.env['DATABASE_TENANT_ROLE'] ?? 'trading_app');
  const password = process.env['DATABASE_TENANT_PASSWORD'] ?? randomBytes(24).toString('base64url');
  const generated = process.env['DATABASE_TENANT_PASSWORD'] === undefined;

  const schema = new URL(databaseUrl).searchParams.get('schema') ?? 'public';
  checkIdentifier(schema);

  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  try {
    const owner = await prisma.$queryRaw<Array<{ role: string }>>`SELECT current_user AS role`;
    const ownerRole = owner[0]?.role ?? 'unknown';

    const exists = await prisma.$queryRaw<Array<{ one: number }>>`
      SELECT 1 AS one FROM pg_roles WHERE rolname = ${role}
    `;

    // The password is passed as a literal because CREATE/ALTER ROLE takes no
    // parameters. It is quoted by PostgreSQL's own quote_literal rather than by
    // string concatenation here.
    const quoted = await prisma.$queryRaw<Array<{ literal: string }>>`
      SELECT quote_literal(${password}::text) AS literal
    `;
    const passwordLiteral = quoted[0]?.literal;
    if (passwordLiteral === undefined) throw new Error('Could not quote the password');

    if (exists.length === 0) {
      await prisma.$executeRawUnsafe(
        `CREATE ROLE ${role} LOGIN PASSWORD ${passwordLiteral} NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE`,
      );
      console.log(`Created role ${role}`);
    } else {
      await prisma.$executeRawUnsafe(`ALTER ROLE ${role} WITH LOGIN PASSWORD ${passwordLiteral}`);
      // An existing role may have been granted more than it should have been.
      await prisma.$executeRawUnsafe(
        `ALTER ROLE ${role} NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE`,
      );
      console.log(`Role ${role} already existed; password and attributes reset`);
    }

    /**
     * Read and write the data, and nothing structural. Without the REVOKE the
     * role could create its own tables in the schema — and it would own them,
     * which is the exemption this whole arrangement exists to avoid.
     */
    await prisma.$executeRawUnsafe(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);
    await prisma.$executeRawUnsafe(`REVOKE CREATE ON SCHEMA ${schema} FROM ${role}`);
    await prisma.$executeRawUnsafe(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${schema} TO ${role}`,
    );
    await prisma.$executeRawUnsafe(
      `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${schema} TO ${role}`,
    );

    /**
     * Tables that do not exist yet.
     *
     * `GRANT ... ON ALL TABLES` is a snapshot: it covers what is there now and
     * nothing a later migration adds. Default privileges are attached to the
     * role that creates the table, which is why this names the owner explicitly
     * rather than relying on whoever happens to run it.
     */
    await prisma.$executeRawUnsafe(
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${checkIdentifier(ownerRole)} IN SCHEMA ${schema} ` +
        `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${role}`,
    );
    await prisma.$executeRawUnsafe(
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${checkIdentifier(ownerRole)} IN SCHEMA ${schema} ` +
        `GRANT USAGE, SELECT ON SEQUENCES TO ${role}`,
    );

    const url = new URL(databaseUrl);
    url.username = role;
    url.password = 'THE_PASSWORD';

    console.log(`\nGranted on schema ${schema}, owned by ${ownerRole}.`);
    console.log('\nPut this in .env, with the password substituted:\n');
    console.log(`DATABASE_URL_TENANT=${url.toString()}`);
    if (generated) {
      // Printed once, because nothing stored it. Everything else about this
      // script is repeatable; this line is not.
      console.log(`\nGenerated password (shown once, not stored): ${password}`);
    } else {
      console.log('\nPassword: the one you supplied in DATABASE_TENANT_PASSWORD.');
    }
    console.log(
      '\nRun this again after every migration that adds a table, or rely on the default\n' +
        'privileges above — both work; running it is the one that also verifies.',
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
