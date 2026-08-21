/**
 * Guard: no floating-point column may exist in the schema.
 *
 * Rule 30 of the product specification is enforceable, so it is enforced. A
 * `double precision` column would let a balance drift by fractions of a cent
 * per operation, and no amount of Decimal arithmetic above it would help.
 */
import { PrismaClient } from '@prisma/client';

interface OffendingColumn {
  table_name: string;
  column_name: string;
  data_type: string;
}

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const offenders = await prisma.$queryRaw<OffendingColumn[]>`
    SELECT table_name, column_name, data_type
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND data_type IN ('double precision', 'real', 'float')
    ORDER BY table_name, column_name
  `;

  if (offenders.length > 0) {
    console.error('Floating-point columns are not permitted in this schema:');
    for (const column of offenders) {
      console.error(`  ${column.table_name}.${column.column_name} (${column.data_type})`);
    }
    process.exitCode = 1;
    return;
  }

  const numericCount = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT count(*)::bigint AS count
    FROM information_schema.columns
    WHERE table_schema = 'public' AND data_type = 'numeric'
  `;

  console.log(
    `No floating-point columns found. ${numericCount[0]?.count ?? 0n} NUMERIC columns verified.`,
  );
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
