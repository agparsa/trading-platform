/**
 * Creates and migrates the database the integration tests use.
 *
 * The integration suite truncates every table between cases, so it must never
 * point at a database anyone cares about. This script derives a separate one
 * from `DATABASE_URL` (or uses `TEST_DATABASE_URL` when set), creates it if it
 * does not exist, and applies the migrations.
 */
import { execFileSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';

function testUrlFrom(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  // /trading_platform -> /trading_platform_test
  url.pathname = `${url.pathname.replace(/\/$/, '')}_test`;
  return url.toString();
}

async function main(): Promise<void> {
  const databaseUrl = process.env['DATABASE_URL'];
  if (databaseUrl === undefined) {
    throw new Error('DATABASE_URL is not set. Copy .env.example to .env first.');
  }

  const testUrl = process.env['TEST_DATABASE_URL'] ?? testUrlFrom(databaseUrl);
  const testDatabase = new URL(testUrl).pathname.replace(/^\//, '').split('?')[0];
  if (testDatabase === undefined || testDatabase.length === 0) {
    throw new Error(`Could not read a database name out of ${testUrl}`);
  }

  const admin = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  try {
    // CREATE DATABASE cannot run inside a transaction, and PostgreSQL has no
    // IF NOT EXISTS for it, so an "already exists" error is the success case.
    await admin.$executeRawUnsafe(`CREATE DATABASE "${testDatabase}"`);
    console.log(`Created database ${testDatabase}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('already exists') || message.includes('42P04')) {
      console.log(`Database ${testDatabase} already exists`);
    } else {
      throw error;
    }
  } finally {
    await admin.$disconnect();
  }

  execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: testUrl },
  });

  console.log(`\nIntegration tests are ready. Add this to .env:\n\nTEST_DATABASE_URL=${testUrl}\n`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
