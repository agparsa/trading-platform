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

  /**
   * Print the shapes, not just a total.
   *
   * `DATABASE_AUDIT.md` used to say "44 columns are Decimal(28, 10)". There
   * were 54, and four other shapes it did not mention — the schema had grown
   * and the sentence had not. A number in a document is a claim with a
   * shelf life; this is the same number with none, so the document can point
   * here instead of repeating it.
   */
  const shapes = await prisma.$queryRaw<
    Array<{ precision: number; scale: number; count: bigint }>
  >`
    SELECT numeric_precision AS precision, numeric_scale AS scale, count(*)::bigint AS count
    FROM information_schema.columns
    WHERE table_schema = 'public' AND data_type = 'numeric'
    GROUP BY 1, 2
    ORDER BY count DESC, precision DESC
  `;

  const total = shapes.reduce((sum, shape) => sum + shape.count, 0n);
  console.log(`No floating-point columns found. ${total} NUMERIC columns verified:`);
  for (const shape of shapes) {
    console.log(`  ${String(shape.count).padStart(4)}  NUMERIC(${shape.precision},${shape.scale})`);
  }
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
