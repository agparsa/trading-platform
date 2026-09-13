import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every unique index on a tenant-scoped table, checked for a tenant root.
 *
 * ## The defect this exists to make impossible a second time
 *
 * `docs/database.md` used to say, of the ledger: "`idempotencyKey` is unique: a
 * retried webhook or job cannot double-credit an account." True, and only half
 * the story. The index was a bare `@unique` on the column — **global** — on a
 * table where every row belongs to one firm.
 *
 * A unique index is enforced across every row in the table, *including the rows
 * row-level security hides.* So when Firm B's caller chose an idempotency key
 * that Firm A's caller had already used, Firm B's posting was refused with a
 * constraint violation naming a row Firm B could not see, could not query, and
 * could not be told about. Reproduced before it was fixed, on `clientOrderId`:
 *
 *     { code: 'P2002', meta: { modelName: 'Order', target: ['client_order_id'] } }
 *
 * Two things are wrong with that at once. It is a denial of service one firm
 * can inflict on another by accident — `order-1` is not an exotic choice — and
 * it is an **oracle**: the refusal itself is a signal that some other firm used
 * that value, which is precisely the class of leak tenancy exists to close.
 *
 * `IdempotencyKey` already had the right shape, `@@unique([tenantId, scope,
 * key])`, which is what settled it as an oversight rather than a design: seven
 * other keys had simply never been looked at.
 *
 * ## The rule
 *
 * On a model that has a `tenantId`, a unique index must be **rooted in one
 * tenant** — otherwise it reaches across firms. There are three ways to be
 * rooted, and the check accepts all three:
 *
 *   1. It leads with `tenantId`.
 *   2. It leads with a foreign key to another tenant-scoped model — the parent
 *      carries the tenancy down, so two firms cannot share the parent either.
 *      `@@unique([accountId, code])` is safe because an account belongs to one
 *      firm.
 *   3. The column holds a value **nobody chooses**: a hash, a minted UUID. A
 *      collision there does not mean two firms picked the same short string, it
 *      means the same secret or the same event — which global uniqueness is the
 *      correct response to. These are listed below, one reason each.
 *
 * ## What it does not catch
 *
 * Stated plainly, because a check whose limits go unsaid gets trusted past
 * them. It reads the schema, so a unique index created by hand in a migration
 * and never reflected back into `schema.prisma` is invisible here — the
 * migration rehearsal's drift check is what covers that. It also cannot tell a
 * caller-supplied string from a minted one; that judgement is the allow-list,
 * and the allow-list is checked both ways so it cannot quietly rot.
 */

const SCHEMA = readFileSync(join(import.meta.dirname, '..', 'prisma', 'schema.prisma'), 'utf8');

/**
 * Unique indexes that are global on purpose, and why each is.
 *
 * Keyed `Model.field`. Every entry is a value the platform derives or mints —
 * never one a caller hands us — so a collision across firms means the two rows
 * are genuinely the same thing.
 */
const GLOBAL_ON_PURPOSE: Readonly<Record<string, string>> = {
  'User.emailVerificationTokenHash':
    'a hash of a secret we generated. Two firms sharing one means the same token was issued twice.',
  'User.passwordResetTokenHash': 'likewise — a reset token is minted here, never supplied.',
  'RefreshToken.tokenHash': 'a hash of a token this platform issued.',
  'TotpRecoveryCode.codeHash': 'a hash of a recovery code this platform generated.',
  'InviteCode.codeHash': 'a hash of an invite code this platform generated.',
  'ApiKey.fingerprint': 'a fingerprint of a key this platform generated; it identifies the key itself.',
  'ServiceToken.fingerprint': 'likewise, for service tokens.',
  'OutboxEvent.eventId':
    'randomUUID() at the moment of record — see outbox.service.ts. Global uniqueness is the ' +
    'guarantee that a relay which ran twice did not produce two events.',
  /**
   * `WithdrawalRequest.holdTransactionId` and `releaseTransactionId` used to be
   * listed here, with the note that they were bare `@db.Uuid` columns with no
   * `@relation` — "a separate thing worth fixing". They are composite foreign
   * keys to `WalletTransaction` now, so the parent-tenancy rule above covers
   * them and this list refused to keep excusing them: the stale-entry half of
   * the check failed the build until they were removed. That is the list doing
   * what it was built to do.
   */
  'CredentialUsage.kind+credentialId+day':
    'credentialId is the UUID of an ApiKey or ServiceToken, both tenant-scoped, so the id ' +
    'itself already belongs to exactly one firm. Polymorphic by `kind`, which is why there ' +
    'is no @relation for the rule above to follow.',
};

interface Model {
  readonly name: string;
  readonly body: string;
  readonly tenantScoped: boolean;
  /** Foreign key field name -> the model it points at. */
  readonly foreignKeys: ReadonlyMap<string, string>;
}

function parseModels(schema: string = SCHEMA): ReadonlyMap<string, Model> {
  const models = new Map<string, Model>();
  const pattern = /^model (\w+) \{\n([\s\S]*?)^\}/gm;
  for (const match of schema.matchAll(pattern)) {
    const name = match[1] as string;
    const body = match[2] as string;
    const foreignKeys = new Map<string, string>();
    // `broker BrokerConnection @relation(fields: [brokerConnectionId], references: [id])`
    for (const relation of body.matchAll(
      /^\s*\w+\s+(\w+)\??\s+@relation\([^)]*?fields:\s*\[([^\]]+)\]/gm,
    )) {
      const target = relation[1] as string;
      for (const field of (relation[2] as string).split(',')) {
        foreignKeys.set(field.trim(), target);
      }
    }
    models.set(name, {
      name,
      body,
      tenantScoped: /^\s*tenantId\s+String/m.test(body),
      foreignKeys,
    });
  }
  return models;
}

/** Every unique index on a model, as an ordered list of field names. */
function uniqueIndexes(model: Model): readonly (readonly string[])[] {
  const found: string[][] = [];
  for (const line of model.body.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('///') || trimmed.startsWith('//')) continue;
    const block = /^@@unique\(\s*\[([^\]]+)\]/.exec(trimmed);
    if (block !== null) {
      found.push((block[1] as string).split(',').map((f) => f.trim()));
      continue;
    }
    // `fingerprint String @unique` — but not `@@unique`, and not a doc comment.
    const inline = /^(\w+)\s+\w+\??.*?(?<!@)@unique\b/.exec(trimmed);
    if (inline !== null) found.push([inline[1] as string]);
  }
  return found;
}

/**
 * The rule itself, as a function, so it can be driven with something other than
 * the real schema.
 *
 * Pointing a check only at the codebase it guards leaves its own logic
 * untested: a mutation that made the allow-list excuse *everything* passed,
 * because every real index is either rooted or already listed. The fixture
 * below is the input that kills that mutant — a model the rule must reject.
 */
function audit(
  models: ReadonlyMap<string, Model>,
  allowed: Readonly<Record<string, string>>,
): { readonly unrooted: string[]; readonly used: Set<string> } {
  const unrooted: string[] = [];
  const used = new Set<string>();

  for (const model of models.values()) {
    if (!model.tenantScoped) continue;
    for (const fields of uniqueIndexes(model)) {
      /**
       * `includes`, not "leads with". What makes the constraint per-firm is
       * that `tenantId` is one of its columns; which column comes first only
       * decides whether the index is also useful for a lookup. Requiring the
       * lead would be this check inventing a rule of its own, and a schema that
       * wrote `@@unique([slug, tenantId])` would be failed for nothing.
       */
      if (fields.includes('tenantId')) continue;

      const first = fields[0] as string;
      const parent = model.foreignKeys.get(first);
      // A parent that is itself tenant-scoped carries the tenancy down: two
      // firms cannot share the parent row, so they cannot collide here.
      if (parent !== undefined && models.get(parent)?.tenantScoped === true) continue;

      const key = `${model.name}.${fields.join('+')}`;
      if (key in allowed) {
        used.add(key);
        continue;
      }
      unrooted.push(`  ${key}  —  @@unique([${fields.join(', ')}])`);
    }
  }
  return { unrooted, used };
}

const MODELS = parseModels();

/**
 * A schema the rule must reject, and the parts of one it must accept.
 *
 * `Widget.serial` is the defect, spelled out: a caller-supplied value, globally
 * unique, on a table whose rows belong to one firm. `Gadget` is the same value
 * done correctly, `Sprocket` is rooted through a tenant-scoped parent, and
 * `Registry` has no tenant at all and so is none of this check's business.
 */
const FIXTURE = `
model Widget {
  id       String @id
  tenantId String @map("tenant_id")
  serial   String @unique
  tenant   Tenant @relation(fields: [tenantId], references: [id])
}

model Gadget {
  id       String @id
  tenantId String @map("tenant_id")
  serial   String
  @@unique([tenantId, serial])
}

model Sprocket {
  id       String @id
  tenantId String @map("tenant_id")
  widgetId String @map("widget_id")
  code     String
  widget   Widget @relation(fields: [widgetId], references: [id])
  @@unique([widgetId, code])
}

model Registry {
  id   String @id
  name String @unique
}

model Listing {
  id         String   @id
  tenantId   String   @map("tenant_id")
  registryId String   @map("registry_id")
  label      String
  registry   Registry @relation(fields: [registryId], references: [id])
  @@unique([registryId, label])
}

model Reversed {
  id       String @id
  tenantId String @map("tenant_id")
  slug     String
  @@unique([slug, tenantId])
}
`;

describe('the rule, driven with a schema that is deliberately wrong', () => {
  const models = parseModels(FIXTURE);

  it('parsed the fixture', () => {
    expect([...models.keys()]).toEqual([
      'Widget',
      'Gadget',
      'Sprocket',
      'Registry',
      'Listing',
      'Reversed',
    ]);
    expect(models.get('Registry')?.tenantScoped).toBe(false);
  });

  it('rejects a global unique on a tenant-scoped table', () => {
    expect(audit(models, {}).unrooted).toContain('  Widget.serial  —  @@unique([serial])');
  });

  /**
   * A parent is only a root if the parent itself belongs to one firm.
   *
   * `Registry` has no tenant — an instrument, a currency, anything the whole
   * platform shares — so `@@unique([registryId, label])` reaches straight
   * across every firm using that row. This is the subtle version of the same
   * defect, and the version most likely to be written next.
   */
  it('rejects an index rooted in a parent that is not itself tenant-scoped', () => {
    expect(audit(models, {}).unrooted).toContain('  Listing.registryId+label  —  @@unique([registryId, label])');
  });

  it('accepts tenantId anywhere in the index, not only first', () => {
    expect(audit(models, {}).unrooted.join('\n')).not.toContain('Reversed');
  });

  it('accepts one led by tenantId, one led by a tenant-scoped parent, and an untenanted table', () => {
    // If any of these three were flagged, the rule would be unusable and the
    // allow-list would fill up with entries that are not really exceptions.
    const flagged = audit(models, {}).unrooted.join('\n');
    expect(flagged).not.toContain('Gadget');
    expect(flagged).not.toContain('Sprocket');
    expect(flagged).not.toContain('Registry');
  });

  it('lets the allow-list excuse exactly what it names, and nothing else', () => {
    const excused = audit(models, { 'Widget.serial': 'a minted id' });
    expect(excused.unrooted.join('\n')).not.toContain('Widget.serial');
    // And the other one is still flagged — one entry excuses one index.
    expect(excused.unrooted).toContain('  Listing.registryId+label  —  @@unique([registryId, label])');
    expect(excused.used).toEqual(new Set(['Widget.serial']));
    // An entry for something that is not flagged is not counted as used, which
    // is what makes the stale-entry check in the real suite bite.
    expect(audit(models, { 'Gadget.serial': 'wrong' }).used.size).toBe(0);
  });
});

describe('unique keys on tenant-scoped tables', () => {
  it('parsed a schema that looks like the one we have', () => {
    // A regex suite that silently matches nothing is the failure mode of every
    // static check, so the shape of what was parsed is asserted first.
    expect(MODELS.size).toBeGreaterThan(50);
    expect([...MODELS.values()].filter((m) => m.tenantScoped).length).toBeGreaterThan(25);
    const order = MODELS.get('Order');
    expect(order?.tenantScoped).toBe(true);
    expect(uniqueIndexes(order as Model)).toContainEqual(['tenantId', 'clientOrderId']);
    expect(MODELS.get('Account')?.foreignKeys.get('userId')).toBe('User');
  });

  it('roots every unique index in one tenant, or says in writing why not', () => {
    const { unrooted, used } = audit(MODELS, GLOBAL_ON_PURPOSE);

    expect(
      unrooted,
      `These unique indexes are global on a table whose rows belong to one firm:\n\n` +
        unrooted.join('\n') +
        `\n\nA unique index is enforced across the rows row-level security hides, so one ` +
        `firm's value refuses another firm's write — a denial of service, and an oracle ` +
        `for what the other firm used. Lead the index with tenantId (widen it in a ` +
        `migration; that is additive), or, if the column holds a value this platform mints ` +
        `rather than one a caller supplies, add it to GLOBAL_ON_PURPOSE with the reason.`,
    ).toEqual([]);

    // The other direction, so an entry cannot outlive the index it excuses.
    const stale = Object.keys(GLOBAL_ON_PURPOSE).filter((key) => !used.has(key));
    expect(
      stale,
      `GLOBAL_ON_PURPOSE excuses these, but no such unique index exists any more. Remove them.`,
    ).toEqual([]);
  });

  /**
   * The seven that were wrong, named.
   *
   * Pinned individually rather than left to the rule above, because the rule
   * would also be satisfied by deleting the constraint altogether — and a
   * missing unique on `idempotencyKey` is how an account gets credited twice.
   * Both halves have to hold: scoped to a firm, *and* still unique within it.
   */
  it.each([
    ['Order', 'clientOrderId'],
    ['Position', 'externalPositionId'],
    ['Execution', 'externalExecutionId'],
    ['BalanceLedger', 'idempotencyKey'],
    ['WalletTransaction', 'idempotencyKey'],
  ])('%s.%s is unique per firm and still unique', (modelName, field) => {
    const model = MODELS.get(modelName) as Model;
    expect(model.tenantScoped).toBe(true);
    expect(uniqueIndexes(model)).toContainEqual(['tenantId', field]);
  });

  it('the payment provider references are unique per firm', () => {
    expect(uniqueIndexes(MODELS.get('PaymentIntent') as Model)).toContainEqual([
      'tenantId',
      'provider',
      'providerReference',
    ]);
    expect(uniqueIndexes(MODELS.get('PaymentEvent') as Model)).toContainEqual([
      'tenantId',
      'provider',
      'providerEventId',
    ]);
  });
});
