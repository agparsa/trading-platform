/**
 * Re-seals every sealed column under the active encryption key.
 *
 * ## The step that had no mechanism
 *
 * `encryption-at-rest.md` documented a rotation in five steps. Step 4 was
 * "re-seal the stored rows under key 2". Nothing in the repository could do it:
 * there was no job, no script, and `SecretBox` could not re-seal bytes at all,
 * which is the form the two most consequential columns use — identity documents
 * and built reports.
 *
 * The danger was not the missing step. It was step 5: "**only then** may key 1
 * be dropped." An operator who works through the list, finds nothing to run,
 * assumes the restart did it, and drops the old key makes every enrolled second
 * factor, every identity document, every venue credential and every withdrawal
 * destination in the system permanently unreadable — and finds out one user at
 * a time over the following weeks.
 *
 * So this does the re-sealing, and, just as importantly, it can **answer step
 * 5's question**: is anything still sealed under a key that is about to be
 * dropped?
 *
 * ## How it behaves, and why
 *
 * - **`--check` (the default) opens nothing.** Both sealed forms carry their
 *   key id in the clear, so counting what is under which key needs no key at
 *   all. It is safe to run against production by somebody who cannot decrypt.
 * - **`--assert-current` exits non-zero if any row is not under the active
 *   key.** This is the gate to put in front of dropping a key.
 * - **`--apply` re-seals, one row at a time, and verifies before it writes.**
 *   Every new value is opened again with the same context before the update
 *   runs. A re-seal that cannot be read back is not written.
 * - **It never destroys anything it cannot read.** A row that will not open —
 *   a key already dropped, a value corrupted — is counted and named, the walk
 *   continues, and the exit code is non-zero. Nulling it would turn a
 *   recoverable mistake into a permanent one.
 * - **It is idempotent.** Rows already under the active key are skipped without
 *   a write, so it can be run again after a failure, or on a schedule.
 * - **It sees every firm.** Rotation is an operator's act on the whole
 *   deployment, so the walk is explicitly outside tenant scope — stated here
 *   because a silent cross-tenant read would be a defect anywhere else.
 *
 * ## Usage
 *
 * ```bash
 * pnpm rotate:secrets                 # what is sealed under which key
 * pnpm rotate:secrets --apply         # re-seal everything under the active key
 * pnpm rotate:secrets --assert-current  # exit 1 if anything is not
 * ```
 */
import { PrismaClient } from '@prisma/client';
import {
  SEALED_COLUMNS,
  SecretBox,
  SecretDecryptionError,
  parseEncryptionKeys,
  type SealedColumn,
} from '@tp/crypto-core';
import { withoutTenantScope } from '@tp/tenancy';

const PAGE = 200;

export interface Tally {
  readonly column: SealedColumn;
  /** How many rows sit under each key id. `?` means the value is unrecognisable. */
  readonly byKey: Map<string, number>;
  moved: number;
  unreadable: { id: string; keyId: string; because: string }[];
}

function label(column: SealedColumn): string {
  return `${column.model}.${column.field}`;
}

function keyIdOf(column: SealedColumn, value: unknown): string {
  if (column.form === 'bytes') {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
    return SecretBox.keyIdOfBytes(bytes) ?? '?';
  }
  return SecretBox.keyIdOfText(String(value)) ?? '?';
}

/**
 * Reads a page of rows that have something sealed in them.
 *
 * `id` is always selected because it is how the walk pages and how an
 * unreadable row is named in the report; the context fields come from the
 * column's own declaration, so no caller here has to know what a device token
 * is bound to.
 */
async function page(
  prisma: PrismaClient,
  column: SealedColumn,
  cursor: string | undefined,
): Promise<Record<string, unknown>[]> {
  const select: Record<string, boolean> = { id: true, [column.field]: true };
  for (const need of column.needs) select[need] = true;
  if (column.keyIdField !== undefined) select[column.keyIdField] = true;

  const delegate = (prisma as unknown as Record<string, Record<string, unknown>>)[column.model];
  if (delegate === undefined) throw new Error(`no Prisma model named ${column.model}`);
  const findMany = delegate['findMany'] as (args: unknown) => Promise<Record<string, unknown>[]>;

  return findMany({
    where: column.nullable ? { [column.field]: { not: null } } : {},
    select,
    orderBy: { id: 'asc' },
    take: PAGE,
    ...(cursor === undefined ? {} : { cursor: { id: cursor }, skip: 1 }),
  });
}

export async function walk(
  prisma: PrismaClient,
  box: SecretBox | null,
  column: SealedColumn,
  apply: boolean,
): Promise<Tally> {
  const tally: Tally = { column, byKey: new Map(), moved: 0, unreadable: [] };
  let cursor: string | undefined;

  for (;;) {
    const rows = await withoutTenantScope(
      'rotation is an operator acting on the whole deployment, not one firm',
      () => page(prisma, column, cursor),
    );
    for (const row of rows) {
      const value = row[column.field];
      if (value === null || value === undefined) continue;
      const keyId = keyIdOf(column, value);
      tally.byKey.set(keyId, (tally.byKey.get(keyId) ?? 0) + 1);

      /**
       * The key-id comparison here saves work; it does not provide the
       * guarantee. `rotate` and `rotateBytes` each return `null` for a value
       * already under the active key, and that is what makes a second run a
       * no-op — checked in `secret-box.test.ts`, where it lives. Said plainly
       * because the two guards mask each other under a mutation: remove either
       * alone and nothing fails, which reads as coverage and is not.
       */
      if (!apply || box === null || keyId === box.activeKeyId) continue;

      const id = String(row['id']);
      try {
        const context = column.context(row);
        let next: unknown;
        if (column.form === 'bytes') {
          const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
          const resealed = box.rotateBytes(bytes, context);
          if (resealed === null) continue;
          // Read it back before it is written. A re-seal that cannot be opened
          // is the one failure this tool must never commit.
          box.openBytes(resealed, context);
          next = new Uint8Array(resealed);
        } else {
          const resealed = box.rotate(String(value), context);
          if (resealed === null) continue;
          box.open(resealed, context);
          next = resealed;
        }

        const data: Record<string, unknown> = { [column.field]: next };
        if (column.keyIdField !== undefined) data[column.keyIdField] = box.activeKeyId;

        const delegate = (prisma as unknown as Record<string, Record<string, unknown>>)[
          column.model
        ];
        if (delegate === undefined) throw new Error(`no Prisma model named ${column.model}`);
        const update = delegate['update'] as (args: unknown) => Promise<unknown>;
        await withoutTenantScope('rotation writes across every firm', () =>
          update({ where: { id }, data }),
        );
        tally.moved += 1;
      } catch (error) {
        /**
         * Counted and named, never cleared.
         *
         * The commonest cause is a key retired before this ran — exactly the
         * mistake this tool exists to make impossible. The row is still there
         * and still openable the moment the key is put back.
         */
        const because =
          error instanceof SecretDecryptionError || error instanceof Error
            ? error.message
            : 'unknown';
        tally.unreadable.push({ id, keyId, because });
      }
    }
    if (rows.length < PAGE) return tally;
    cursor = String(rows[rows.length - 1]?.['id']);
  }
}

export function report(
  tallies: readonly Tally[],
  activeKeyId: string | null,
  apply: boolean,
): void {
  const pad = Math.max(...tallies.map((one) => label(one.column).length));
  let stale = 0;
  let unreadable = 0;

  for (const tally of tallies) {
    const parts = [...tally.byKey.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([keyId, count]) => {
        const current = activeKeyId !== null && keyId === activeKeyId;
        if (!current) stale += count;
        return `${keyId}${current ? '' : ' (not current)'}: ${count}`;
      });
    const moved = apply && tally.moved > 0 ? `  → re-sealed ${tally.moved}` : '';
    console.log(
      `  ${label(tally.column).padEnd(pad)}  ${parts.length === 0 ? 'nothing sealed' : parts.join(', ')}${moved}`,
    );
    console.log(`  ${' '.repeat(pad)}  ${tally.column.describes}`);
    for (const row of tally.unreadable) {
      unreadable += 1;
      console.log(
        `  ${' '.repeat(pad)}  WILL NOT OPEN ${row.id} (key ${row.keyId}): ${row.because}`,
      );
    }
  }

  console.log('');
  if (unreadable > 0) {
    console.log(`  ${unreadable} row(s) would not open. Nothing was cleared; put the key back.`);
  }
  if (apply) {
    const moved = tallies.reduce((sum, one) => sum + one.moved, 0);
    console.log(`  Re-sealed ${moved} row(s) under ${activeKeyId ?? 'the active key'}.`);
    console.log('  Run again with no flag to confirm nothing is left under an older key.');
  } else if (stale > 0) {
    console.log(`  ${stale} row(s) are not under the active key. Run with --apply.`);
    console.log('  Do NOT drop an older key until this reads zero.');
  } else {
    console.log('  Everything sealed is under the active key.');
  }
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const assertCurrent = process.argv.includes('--assert-current');

  const keys = process.env['SECRET_ENCRYPTION_KEYS'];
  let box: SecretBox | null = null;
  if (keys !== undefined && keys.length > 0) {
    box = new SecretBox(parseEncryptionKeys(keys));
  } else if (apply) {
    console.error('SECRET_ENCRYPTION_KEYS is not set; nothing can be re-sealed.');
    process.exit(2);
  }

  const prisma = new PrismaClient();
  console.log('');
  console.log(
    `  Sealed columns, ${apply ? 're-sealing under' : 'against'} ${
      box === null ? 'no configured key' : `key ${box.activeKeyId}`
    }`,
  );
  console.log('');

  const tallies: Tally[] = [];
  try {
    for (const column of SEALED_COLUMNS) {
      tallies.push(await walk(prisma, box, column, apply));
    }
  } finally {
    await prisma.$disconnect();
  }

  report(tallies, box?.activeKeyId ?? null, apply);

  const unreadable = tallies.reduce((sum, one) => sum + one.unreadable.length, 0);
  const stale = tallies.reduce((sum, one) => {
    for (const [keyId, count] of one.byKey) {
      if (box !== null && keyId !== box.activeKeyId) sum += count;
    }
    return sum;
  }, 0);

  if (unreadable > 0) process.exit(1);
  if (assertCurrent && stale > 0) process.exit(1);
}

/**
 * Only when run as a command.
 *
 * `rotation.test.ts` imports `walk` to drive a real rotation against a real
 * database with two real keys, which is the only way to find out whether the
 * re-sealed values open — and a module that starts working on import cannot be
 * tested that way.
 */
const entry = process.argv[1] ?? '';
if (/[\\/]rotate-secrets\.(ts|js)$/.test(entry)) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
