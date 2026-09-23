import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { PrismaClient } from '@prisma/client';
import {
  SEALED_COLUMNS,
  SecretBox,
  documentSealContext,
  generateEncryptionKey,
  parseEncryptionKeys,
  totpSealContext,
} from '@tp/crypto-core';
import { withTenant } from '@tp/tenancy';
import { walk } from '../../../../scripts/rotate-secrets';
import {
  DEFAULT_TENANT_ID,
  DEFAULT_TENANT_SLUG,
  createAccount,
  createTestClient,
  hasTestDatabase,
  resetDatabase,
} from './harness';

const suite = hasTestDatabase ? describe : describe.skip;

/**
 * Key rotation, which was a documented procedure with no mechanism.
 *
 * `encryption-at-rest.md` listed five steps. Step 4 — "re-seal the stored rows
 * under key 2" — had nothing to run: no job, no script, and `SecretBox` could
 * not re-seal bytes at all, which is the form identity documents and built
 * reports use.
 *
 * The danger was step 5: "**only then** may key 1 be dropped." Following the
 * list, finding nothing at step 4, and assuming a restart had done it makes
 * every second factor, identity document, venue credential and withdrawal
 * destination in the deployment permanently unreadable — one user at a time,
 * over weeks.
 *
 * These tests are about the three properties that make the tool safe to point
 * at production: it moves what needs moving, it does nothing twice, and it
 * never destroys what it cannot read.
 */
suite('key rotation', () => {
  let prisma: PrismaClient;
  let user: { userId: string; accountId: string };

  const KEY_1 = generateEncryptionKey('1');
  const KEY_2 = generateEncryptionKey('2');
  const alpha = { tenantId: DEFAULT_TENANT_ID, slug: DEFAULT_TENANT_SLUG };

  /** The box in use before a rotation, and the one in use after it. */
  const before = () => new SecretBox(parseEncryptionKeys(KEY_1));
  const after = () => new SecretBox(parseEncryptionKeys(`${KEY_2},${KEY_1}`));

  beforeEach(async () => {
    prisma = createTestClient();
    await resetDatabase(prisma);
    user = await createAccount(prisma, { balance: '100', email: 'rotate@alpha.test' });
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  const column = (model: string, field: string) => {
    const found = SEALED_COLUMNS.find((one) => one.model === model && one.field === field);
    if (found === undefined) throw new Error(`${model}.${field} is not a declared sealed column`);
    return found;
  };

  /** A TOTP secret sealed under key 1, as the application would have written it. */
  async function enrolledUnderKeyOne(secret = 'JBSWY3DPEHPK3PXP'): Promise<void> {
    await withTenant(alpha, () =>
      prisma.user.update({
        where: { id: user.userId },
        data: { totpSecret: before().seal(secret, totpSealContext(user.userId)) },
      }),
    );
  }

  /** An identity document sealed under key 1 — the byte form, which had no rotate at all. */
  async function documentUnderKeyOne(bytes = Buffer.from('a passport scan')): Promise<string> {
    const record = await withTenant(alpha, () =>
      prisma.kycRecord.create({
        data: { tenantId: alpha.tenantId, userId: user.userId } as never,
      }),
    );
    /**
     * Sealed in the `create`, not by a later `update`.
     *
     * `kyc_documents_identity_fixed` refuses an update that changes `content`
     * while leaving `sealed_with_key_id` where it was — the bytes of an
     * identity document are evidence, and the only edit the database permits is
     * one that moves the key. Which is to say the trigger was written with a
     * rotation in mind before there was a rotation, and it is why this tool
     * must always write the key id alongside the frame.
     */
    const id = randomUUID();
    const row = await withTenant(alpha, () =>
      prisma.kycDocument.create({
        data: {
          id,
          tenantId: alpha.tenantId,
          recordId: record.id,
          kind: 'PASSPORT',
          contentType: 'image/png',
          sizeBytes: bytes.length,
          sha256: 'a'.repeat(64),
          content: new Uint8Array(before().sealBytes(bytes, documentSealContext(id))),
          sealedWithKeyId: '1',
        } as never,
      }),
    );
    return row.id;
  }

  it('moves a text value to the active key, and it still opens', async () => {
    await enrolledUnderKeyOne();

    const box = after();
    const tally = await walk(prisma, box, column('user', 'totpSecret'), true);
    expect(tally.moved).toBe(1);

    const row = await withTenant(alpha, () =>
      prisma.user.findFirstOrThrow({ where: { id: user.userId }, select: { totpSecret: true } }),
    );
    expect(SecretBox.keyIdOfText(row.totpSecret ?? '')).toBe('2');
    expect(box.open(row.totpSecret ?? '', totpSealContext(user.userId))).toBe('JBSWY3DPEHPK3PXP');
  });

  /**
   * The byte form is the half that could not be rotated at all, and it is the
   * half holding somebody's passport.
   */
  it('moves a sealed document to the active key, and it still opens', async () => {
    const id = await documentUnderKeyOne();

    const box = after();
    const tally = await walk(prisma, box, column('kycDocument', 'content'), true);
    expect(tally.moved).toBe(1);

    const row = await withTenant(alpha, () =>
      prisma.kycDocument.findFirstOrThrow({
        where: { id },
        select: { content: true, sealedWithKeyId: true },
      }),
    );
    const content = Buffer.from(row.content as Uint8Array);
    expect(SecretBox.keyIdOfBytes(content)).toBe('2');
    // The column that lets a later walk find rows without opening them has to
    // move with the frame, or the next rotation looks at a stale answer.
    expect(row.sealedWithKeyId).toBe('2');
    expect(box.openBytes(content, documentSealContext(id)).toString('utf8')).toBe(
      'a passport scan',
    );
  });

  /**
   * The database itself refuses a re-seal that does not move the key id.
   *
   * `kyc_documents_identity_fixed` permits `content` to change only when
   * `sealed_with_key_id` changes with it. That is a stronger guarantee than the
   * rotation tool could give on its own: a document's bytes cannot be swapped
   * for other bytes under any pretext, and the one edit that is allowed is the
   * one that says, in the row, which key now holds it.
   *
   * It also means the tool has no choice about writing the key id, which is
   * exactly the coupling worth having — a rotation that forgot it would not
   * silently leave a stale column behind, it would not commit at all.
   */
  it('refuses bytes that change without the key id changing with them', async () => {
    const id = await documentUnderKeyOne();
    const other = after().sealBytes(
      Buffer.from('somebody else’s passport'),
      documentSealContext(id),
    );

    await expect(
      withTenant(alpha, () =>
        prisma.kycDocument.update({
          where: { id },
          data: { content: new Uint8Array(other) },
        }),
      ),
    ).rejects.toThrow(/bytes cannot be replaced/);
  });

  /**
   * Idempotent, asserted on the stored bytes rather than on the count.
   *
   * `moved` is the tool's own bookkeeping, and a test that only reads it proves
   * the tool agrees with itself. The value in the column is the thing: every
   * seal uses a fresh IV, so a needless re-seal changes the stored string even
   * though the plaintext is identical. If the second run wrote anything, this
   * sees it.
   */
  it('does nothing the second time, so a failed run can simply be run again', async () => {
    await enrolledUnderKeyOne();
    const box = after();
    const stored = async () =>
      (
        await withTenant(alpha, () =>
          prisma.user.findFirstOrThrow({
            where: { id: user.userId },
            select: { totpSecret: true },
          }),
        )
      ).totpSecret;

    expect((await walk(prisma, box, column('user', 'totpSecret'), true)).moved).toBe(1);
    const afterFirst = await stored();

    expect((await walk(prisma, box, column('user', 'totpSecret'), true)).moved).toBe(0);
    expect(await stored()).toBe(afterFirst);
  });

  /**
   * The row that will not open is the whole reason this tool reports rather
   * than repairs.
   *
   * A key retired too early is exactly the mistake the procedure is meant to
   * prevent, and it is recoverable — the value is still there, and it opens
   * again the moment the key is put back. Clearing it would make a reversible
   * mistake permanent, which is the one thing worse than the mistake.
   */
  it('names a row it cannot open and leaves it exactly where it was', async () => {
    await enrolledUnderKeyOne();
    const stored = await withTenant(alpha, () =>
      prisma.user.findFirstOrThrow({ where: { id: user.userId }, select: { totpSecret: true } }),
    );

    // Key 1 dropped: the box that runs the rotation cannot read what key 1 wrote.
    const withoutTheOldKey = new SecretBox(parseEncryptionKeys(KEY_2));
    const tally = await walk(prisma, withoutTheOldKey, column('user', 'totpSecret'), true);

    expect(tally.moved).toBe(0);
    expect(tally.unreadable).toHaveLength(1);
    expect(tally.unreadable[0]?.id).toBe(user.userId);
    expect(tally.unreadable[0]?.keyId).toBe('1');

    const afterwards = await withTenant(alpha, () =>
      prisma.user.findFirstOrThrow({ where: { id: user.userId }, select: { totpSecret: true } }),
    );
    expect(afterwards.totpSecret).toBe(stored.totpSecret);
    // And it opens again the moment the key is back.
    expect(before().open(afterwards.totpSecret ?? '', totpSealContext(user.userId))).toBe(
      'JBSWY3DPEHPK3PXP',
    );
  });

  /**
   * The question step 5 of the procedure depends on: is anything still under an
   * older key? Answered without opening a single row, because both sealed forms
   * carry their key id in the clear.
   */
  it('counts what is under which key without needing a key at all', async () => {
    await enrolledUnderKeyOne();
    await documentUnderKeyOne();

    const blind = await walk(prisma, null, column('user', 'totpSecret'), false);
    expect(blind.byKey.get('1')).toBe(1);
    expect(blind.moved).toBe(0);

    const docs = await walk(prisma, null, column('kycDocument', 'content'), false);
    expect(docs.byKey.get('1')).toBe(1);
  });

  /**
   * The registry is the tool's map of the system, and a map that has gone stale
   * is worse than none: a column it does not list is a column a rotation walks
   * straight past, leaving values under a key somebody is about to drop.
   *
   * These two check it against things it does not control — the Prisma schema,
   * and the application's own call sites.
   */
  describe('the registry', () => {
    // vitest runs from the repository root; the walk below needs no more than that.
    const ROOT = process.cwd();

    it('names only columns the schema actually has', async () => {
      for (const column of SEALED_COLUMNS) {
        const delegate = (prisma as unknown as Record<string, Record<string, unknown>>)[
          column.model
        ];
        expect(delegate, `no Prisma model named ${column.model}`).toBeDefined();
        const findFirst = delegate?.['findFirst'] as (args: unknown) => Promise<unknown>;
        // A field that does not exist makes Prisma throw on the select.
        await expect(
          findFirst({ select: { id: true, [column.field]: true } }),
        ).resolves.not.toThrow();
      }
    });

    /**
     * No call site may invent its own AAD.
     *
     * This is the property the registry exists for, checked directly rather
     * than by counting: every `seal`/`sealBytes`/`open`/`openBytes` in the two
     * applications must bind its value with one of the context builders
     * exported from `sealed-columns.ts` — directly, or through a local alias
     * assigned from one, which is how `contextFor` and `sealContext` read to
     * somebody working in those files.
     *
     * A new sealed column written with a hand-rolled context string fails here,
     * which is the moment to declare it — not months later, when a rotation
     * walks past it and an operator drops the key it is still under.
     */
    it('binds every sealed value with a context the registry defines', () => {
      const BUILDERS = new Set([
        'totpSealContext',
        'documentSealContext',
        'reportSealContext',
        'destinationSealContext',
        'deviceSealContext',
        'idSealContext',
      ]);

      const files: string[] = [];
      const walkDir = (dir: string): void => {
        for (const entry of readdirSync(dir)) {
          if (entry === 'node_modules' || entry === 'dist' || entry === '.next') continue;
          const full = join(dir, entry);
          if (statSync(full).isDirectory()) walkDir(full);
          else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) files.push(full);
        }
      };
      walkDir(join(ROOT, 'apps', 'api', 'src'));
      walkDir(join(ROOT, 'apps', 'worker', 'src'));

      const offenders: string[] = [];
      let checked = 0;

      for (const file of files) {
        const src = readFileSync(file, 'utf8');
        /** `const contextFor = totpSealContext;` — an alias, not a second definition. */
        const aliases = new Set<string>();
        for (const match of src.matchAll(/const\s+(\w+)\s*=\s*(\w+);/g)) {
          const [, name, target] = match;
          if (name !== undefined && target !== undefined && BUILDERS.has(target)) aliases.add(name);
        }

        for (const match of src.matchAll(
          /\.(?:seal|sealBytes|open|openBytes)\(\s*([\s\S]{0,200}?)\)[,;)\s]/g,
        )) {
          const args = match[1] ?? '';
          const context = args.slice(args.indexOf(',') + 1).trim();
          if (args.indexOf(',') < 0) continue; // not a two-argument call
          checked += 1;
          const called = /^(\w+)\s*\(/.exec(context)?.[1];
          if (called === undefined || (!BUILDERS.has(called) && !aliases.has(called))) {
            const line = src.slice(0, match.index).split('\n').length;
            offenders.push(`${relative(ROOT, file)}:${line} → ${context.slice(0, 60)}`);
          }
        }
      }

      expect(
        checked,
        'the sweep found no sealing at all, which means it stopped sweeping',
      ).toBeGreaterThan(10);
      expect(
        offenders,
        'a context built anywhere but the registry is one a rotation cannot reproduce',
      ).toEqual([]);
    });
  });
});
