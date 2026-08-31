import { Prisma } from '@prisma/client';
import { currentScope, isCrossTenant } from './context';

/**
 * Tenant isolation, layer one.
 *
 * Every operation on a tenant-scoped model passes through here, and one of
 * three things happens:
 *
 *   - a tenant is in scope: `tenantId` is **injected** into the filter on reads
 *     and into the payload on writes;
 *   - the caller has said `withoutTenantScope(reason)`: nothing is added;
 *   - neither: the operation **throws**.
 *
 * ## Why inject rather than validate
 *
 * The alternative is to require every call site to pass `tenantId` and to
 * refuse the ones that do not. That makes the failure mode *forgetting* — and a
 * forgotten filter is a leak that no test catches, because the test fixture has
 * one tenant and reading "everything" and reading "everything belonging to my
 * tenant" return the same rows. The bug is invisible until there are two
 * customers, at which point it is invisible and live.
 *
 * Injecting makes the failure mode *the wrong tenant*, which is a crash, a
 * foreign-key violation, or a test that fails the moment a second tenant
 * exists. Loud beats subtle when the subtle version is a data breach.
 *
 * ## Why this is not the only layer
 *
 * This is code, and code has bugs. A raw query bypasses it entirely. A model
 * added to the schema and not to `TENANT_SCOPED_MODELS` below is silently
 * unprotected. Row-level security sits underneath for exactly those cases —
 * see the `tenant_row_level_security` migration. Two mechanisms that can each
 * fail independently beat one that is asserted to be correct.
 */

/**
 * The models that belong to a tenant.
 *
 * Kept as an explicit list rather than derived, because deriving it would mean
 * a model without a `tenantId` field is silently treated as global — which is
 * the safe-looking default that produces an unprotected table. An explicit list
 * can be checked against the schema, and `tenant-scope.test.ts` does exactly
 * that: it reads `schema.prisma` and fails if any model carrying a `tenantId`
 * is missing from here.
 */
export const TENANT_SCOPED_MODELS = new Set<string>([
  'User',
  'TotpRecoveryCode',
  'RefreshToken',
  'InviteCode',
  'InviteRedemption',
  'Account',
  'AccountSettings',
  'BalanceLedger',
  'AccountSnapshot',
  'Order',
  'OrderEvent',
  'Position',
  'PositionEvent',
  'Execution',
  'Trade',
  'RiskRuleConfig',
  'RiskEvent',
  'IntegritySignal',
  'IntegritySignalEvent',
  'ReconciliationRun',
  'ReconciliationFinding',
  'MasterAccount',
  'MasterAccountLink',
  'TenantSymbolTerms',
  'AuditLog',
  'IdempotencyKey',
  'Notification',
  'Device',
  'NotificationPreference',
  'NotificationSetting',
]);

/**
 * Models with a `tenantId` that this extension does **not** scope.
 *
 * `SystemSetting` is the only one. Its `tenantId` is nullable and null means
 * the platform, so "give me my tenant's rows" is the wrong query — the kill
 * switch has to see the platform-wide row as well as its own. `KillSwitchService`
 * asks for both explicitly, which is clearer than an injection rule with an
 * exception in it.
 */
export const DELIBERATELY_UNSCOPED_MODELS = new Set<string>(['SystemSetting']);

/** Operations whose argument carries a `where` we can narrow. */
const FILTERED = new Set([
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'findUnique',
  'findUniqueOrThrow',
  'updateMany',
  'deleteMany',
  'count',
  'aggregate',
  'groupBy',
]);

/** Operations that write a row we must stamp. */
const CREATES = new Set(['create', 'createMany', 'createManyAndReturn']);

/**
 * Operations that both find and write: the filter is narrowed and the payload
 * is stamped, so an upsert cannot reach across and cannot create unstamped.
 */
const UPSERTS = new Set(['upsert']);

/** Operations that find one row and change it. */
const MUTATES_ONE = new Set(['update', 'delete']);

type AnyArgs = Record<string, unknown>;

function narrow(args: AnyArgs, tenantId: string): AnyArgs {
  const where = (args['where'] ?? {}) as AnyArgs;
  return { ...args, where: { ...where, tenantId } };
}

/**
 * Which of a model's fields are relations, and to what.
 *
 * Read from the generated DMMF rather than written out, because a hand-written
 * relation map is a second copy of the schema and the two would part company on
 * the first migration nobody remembered it for.
 */
const relationsOf = new Map<string, Map<string, string>>();
for (const model of Prisma.dmmf.datamodel.models) {
  const relations = new Map<string, string>();
  for (const field of model.fields) {
    if (field.kind === 'object') relations.set(field.name, field.type);
  }
  relationsOf.set(model.name, relations);
}

/**
 * Stamps `tenantId` onto a create payload, and onto every nested create inside
 * it that lands in a tenant-scoped table.
 *
 * Nested writes are the hole a top-level-only stamp leaves, and it is not a
 * theoretical one: `account.create({ data: { …, settings: { create: {} } } })`
 * is ordinary Prisma, and the settings row would arrive with no tenant and a
 * NOT NULL violation — or, on a nullable column, with none at all.
 *
 * Only creates are rewritten. A nested `connect` naming another tenant's row is
 * a real attack and it is **not** closed here: `connect` takes a strict unique
 * input that will not accept an extra column, so narrowing it is not available.
 * Row-level security is what refuses that one — see the
 * `tenant_row_level_security` migration. This is exactly the kind of gap that
 * makes a single-layer design a bad idea.
 */
function stampCreate(model: string, data: unknown, tenantId: string): unknown {
  if (data === null || data === undefined) return data;
  if (Array.isArray(data)) return data.map((row) => stampCreate(model, row, tenantId));
  if (typeof data !== 'object') return data;

  const row = data as AnyArgs;

  /**
   * A payload that names a tenant is checked, not trusted, and not silently
   * corrected.
   *
   * Most call sites pass `tenantId: requireTenantId()` explicitly, because the
   * schema makes the column required and TypeScript therefore catches a missing
   * one at build time — which is a stronger guarantee than any runtime check.
   * What TypeScript cannot catch is the *wrong* tenant: a service that has an
   * id in hand from somewhere else and passes that instead.
   *
   * Overwriting it would hide that bug. Throwing surfaces it at the first test
   * that runs the path.
   */
  const declared = row['tenantId'];
  if (typeof declared === 'string' && declared !== tenantId) {
    throw new Error(
      `${model} was written with tenantId ${declared} while ${tenantId} is in scope. ` +
        'A row cannot be created for another tenant; if this is deliberate cross-tenant ' +
        'work, say so with withoutTenantScope().',
    );
  }

  const out: AnyArgs = TENANT_SCOPED_MODELS.has(model) ? { ...row, tenantId } : { ...row };
  const relations = relationsOf.get(model);
  if (relations === undefined) return out;

  for (const [field, target] of relations) {
    const nested = out[field];
    if (nested === null || typeof nested !== 'object') continue;
    if (!TENANT_SCOPED_MODELS.has(target)) continue;

    const write = { ...(nested as AnyArgs) };
    if (write['create'] !== undefined) {
      write['create'] = stampCreate(target, write['create'], tenantId);
    }
    if (write['createMany'] !== undefined) {
      const many = { ...(write['createMany'] as AnyArgs) };
      many['data'] = stampCreate(target, many['data'], tenantId);
      write['createMany'] = many;
    }
    if (Array.isArray(write['connectOrCreate'])) {
      write['connectOrCreate'] = (write['connectOrCreate'] as AnyArgs[]).map((entry) => ({
        ...entry,
        create: stampCreate(target, entry['create'], tenantId),
      }));
    } else if (write['connectOrCreate'] !== undefined) {
      const entry = { ...(write['connectOrCreate'] as AnyArgs) };
      entry['create'] = stampCreate(target, entry['create'], tenantId);
      write['connectOrCreate'] = entry;
    }
    if (write['upsert'] !== undefined) {
      const entry = { ...(write['upsert'] as AnyArgs) };
      entry['create'] = stampCreate(target, entry['create'], tenantId);
      write['upsert'] = entry;
    }
    out[field] = write;
  }

  return out;
}

/**
 * Like `stampCreate`, but for an update payload: the row itself already has a
 * tenant and must not be restamped — moving a row between tenants is not
 * something anybody writes on purpose — while nested creates inside it still
 * need one.
 */
function stampNested(model: string, data: unknown, tenantId: string): unknown {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return data;
  const row = { ...(data as AnyArgs) };
  const relations = relationsOf.get(model);
  if (relations === undefined) return row;

  for (const [field, target] of relations) {
    const nested = row[field];
    if (nested === null || typeof nested !== 'object') continue;
    if (!TENANT_SCOPED_MODELS.has(target)) continue;
    const write = { ...(nested as AnyArgs) };
    if (write['create'] !== undefined)
      write['create'] = stampCreate(target, write['create'], tenantId);
    if (write['createMany'] !== undefined) {
      const many = { ...(write['createMany'] as AnyArgs) };
      many['data'] = stampCreate(target, many['data'], tenantId);
      write['createMany'] = many;
    }
    if (write['upsert'] !== undefined) {
      const entry = { ...(write['upsert'] as AnyArgs) };
      entry['create'] = stampCreate(target, entry['create'], tenantId);
      write['upsert'] = entry;
    }
    row[field] = write;
  }
  return row;
}

export function tenantScopeExtension() {
  return Prisma.defineExtension({
    name: 'tenant-scope',
    query: {
      $allModels: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        async $allOperations({ model, operation, args, query }: any) {
          if (!TENANT_SCOPED_MODELS.has(model)) return query(args);

          const scope = currentScope();

          if (scope === undefined) {
            throw new Error(
              `${model}.${operation} ran with no tenant in scope. Every request carries one; ` +
                'work that legitimately spans tenants must say so with withoutTenantScope().',
            );
          }
          if (isCrossTenant(scope)) return query(args);

          const { tenantId } = scope;
          const input = (args ?? {}) as AnyArgs;

          if (operation === 'update' || operation === 'updateMany') {
            // A nested create inside an update lands in a scoped table just as
            // one inside a create does.
            const narrowed = narrow(input, tenantId);
            return query(
              narrowed['data'] === undefined
                ? narrowed
                : { ...narrowed, data: stampNested(model, narrowed['data'], tenantId) },
            );
          }

          if (FILTERED.has(operation) || MUTATES_ONE.has(operation)) {
            /**
             * `findUnique` is narrowed the same as the rest, which Prisma
             * permits only because `tenantId` participates in a compound unique
             * on the models where it matters. Where it does not, Prisma rejects
             * the extra key — so those models are reached through `findFirst`,
             * and `tenant-scope.test.ts` pins which is which.
             */
            return query(narrow(input, tenantId));
          }

          if (CREATES.has(operation)) {
            return query({ ...input, data: stampCreate(model, input['data'], tenantId) });
          }

          if (UPSERTS.has(operation)) {
            return query({
              ...narrow(input, tenantId),
              create: stampCreate(model, input['create'], tenantId),
              // `update` is not stamped: an upsert that changes a row's tenant
              // is not an update anybody meant to write.
            });
          }

          /**
           * Anything else — a new Prisma operation, or one nobody thought
           * about — is refused rather than passed through. Passing it through
           * would be a silent hole that appears on a dependency upgrade.
           */
          throw new Error(
            `${model}.${operation} is not handled by the tenant scope extension. ` +
              'Add it deliberately rather than letting it through unscoped.',
          );
        },
      },
    },
  });
}
