import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Whether a rollback is safe, checked rather than claimed.
 *
 * ## The procedure this exists to keep true
 *
 * `runbook.md` tells whoever is on call to roll back the **image**, not the
 * migration. That advice is only sound while every migration since the image
 * they are rolling back to is *additive* — because an older image runs against
 * the newer schema, writing the older shape of every row. The runbook used to
 * justify it with "every migration in this repository is additive so far",
 * which was **not true**: two migrations add `NOT NULL` to columns that already
 * existed, and an image from before them writes nulls into exactly those
 * columns. Rolling back across one would turn a bad deploy into a broken one,
 * at the hour when somebody is least able to work out why.
 *
 * Nobody had noticed because nothing checked. A sentence in a document is a
 * claim; this is the check, and it fails the build rather than the deploy.
 *
 * ## What it enforces
 *
 * Every narrowing migration must be listed in `NARROWING` with the reason.
 * The comparison is **both ways**: a new narrowing that is not listed fails,
 * and a listed one that no longer narrows fails too, so the list cannot rot
 * into folklore. Adding to it is meant to be a deliberate act, because it
 * moves the boundary the runbook quotes — which the last test here pins.
 *
 * ## What it does not catch
 *
 * Said plainly, because a check whose limits are unstated gets trusted past
 * them. A new `CHECK` constraint, a new `UNIQUE` index over existing columns,
 * a tightened foreign key and a shortened `VARCHAR` can each reject a write an
 * older image would make, and none is matched here. The patterns below are the
 * unambiguous ones. If you add a constraint of any kind to an existing table,
 * think for yourself about whether last release's code could still write to it.
 */

const MIGRATIONS_DIR = join(import.meta.dirname, '..', 'prisma', 'migrations');

/**
 * The migrations that narrow the schema, and why each was worth it.
 *
 * Keyed by folder name. An image from *before* one of these cannot be rolled
 * back to while it is applied, and the newest entry is the rollback floor the
 * runbook names.
 */
const NARROWING: Readonly<Record<string, string>> = {
  '20260824190000_trade_commission_breakdown':
    'entry_commission and exit_commission became NOT NULL after being backfilled to 0. ' +
    'A pre-this image writes a trade with neither, and the insert is refused.',
  '20260831140000_multi_tenancy':
    'tenant_id became NOT NULL on every scoped table after the default tenant backfill. ' +
    'A pre-tenancy image knows nothing about tenants and writes none, so every insert is refused. ' +
    'This is the rollback floor.',
};

/** Statements that can make a write an older image would have made invalid. */
/**
 * Migrations an older image cannot read *past*, once a row uses the new value.
 *
 * ## A second kind of rollback hazard, and the one nothing was watching
 *
 * `NARROWING` above is about the schema getting *tighter*: an old image writes
 * the old shape and the insert is refused. Adding a value to an enum is the
 * opposite shape of problem and just as final. The schema gets *wider*, every
 * write an old image makes still succeeds — and the moment one row carries the
 * new value, an old image cannot **read** it.
 *
 * Measured, not assumed. A Prisma client generated from the schema as it stood
 * before `ORDERS` existed, pointed at a database holding one report with
 * `kind = 'ORDERS'`:
 *
 * ```
 * raw SQL says            [{"kind":"ORDERS"}]
 * old client findUnique   PrismaClientUnknownRequestError
 * old client findMany     PrismaClientUnknownRequestError
 * ```
 *
 * `findMany` is the one that matters: it is not one unreadable row, it is the
 * **whole list**. Roll back across this with a single such report in the table
 * and the reports screen does not degrade, it throws.
 *
 * And PostgreSQL has no `ALTER TYPE … DROP VALUE`, so the database half cannot
 * be undone at all — only restored.
 *
 * ## Why it is a separate list
 *
 * Because the hazard is **data-dependent**, and saying so is the difference
 * between a useful floor and a scary one. A narrowing migration breaks a
 * rollback always; this breaks it only once somebody has created a row using
 * the new value. `RISK_MANAGER` has been addable since August and costs nothing
 * until a user actually holds that role.
 */
const ADDS_ENUM_VALUES: Readonly<Record<string, string>> = {
  '20260826200000_risk_manager_role': 'UserRole: RISK_MANAGER',
  '20260831170628_notification_devices_and_preferences': 'NotificationChannel: PUSH',
  '20260901220000_withdrawals': 'UserRole: FINANCE',
  '20260903090000_tenant_kind_and_role_groups':
    'UserRole: BROKER_OWNER, BROKER_ANALYST, BROKER_DEVELOPER, PLATFORM_SUPER_ADMIN, ' +
    'PLATFORM_OPERATOR, PLATFORM_SUPPORT, PLATFORM_AUDITOR, PLATFORM_DEVELOPER',
  '20260903130000_account_status_pending_locked': 'AccountStatus: PENDING, LOCKED',
  '20260904170000_order_unconfirmed': 'OrderStatus: UNCONFIRMED',
  '20260906140500_price_alert_notification_category': 'NotificationCategory: PRICE_ALERT',
  '20260909120500_break_glass_security_kinds':
    'SecurityEventKind: BREAK_GLASS_OPENED, BREAK_GLASS_CLOSED',
  '20260909150000_ip_rule_security_kind': 'SecurityEventKind: IP_RULE_CHANGED',
  '20260912101638_device_staff_revocation':
    'SecurityEventKind: DEVICE_REGISTERED, DEVICE_REVIVED, DEVICE_REVOKED, ' +
    'DEVICE_REVOKED_BY_STAFF, DEVICE_RESTORED_BY_STAFF',
  '20260914100000_audit_report_kind': 'ReportKind: AUDIT',
  '20260914160000_orders_and_positions_report_kinds': 'ReportKind: ORDERS, POSITIONS',
};

const ADDS_ENUM_VALUE = /\bALTER\s+TYPE\b[\s\S]*?\bADD\s+VALUE\b/i;

const NARROWINGS: readonly { readonly what: string; readonly pattern: RegExp }[] = [
  { what: 'drops a table', pattern: /\bDROP\s+TABLE\b/i },
  { what: 'drops a column', pattern: /\bDROP\s+COLUMN\b/i },
  // `ALTER INDEX … RENAME` is deliberately not this: an index's name is
  // invisible to the application, so renaming one narrows nothing.
  { what: 'renames a table or column', pattern: /\bALTER\s+TABLE\b[\s\S]*?\bRENAME\b/i },
  {
    what: 'makes an existing column NOT NULL',
    pattern: /\bALTER\s+COLUMN\b[^;]*?\bSET\s+NOT\s+NULL\b/i,
  },
  { what: "changes a column's type", pattern: /\bALTER\s+COLUMN\b[^;]*?\bTYPE\b/i },
  { what: 'drops a type', pattern: /\bDROP\s+TYPE\b/i },
];

/**
 * SQL with comments and string literals removed.
 *
 * Both matter. `runbook.md`'s own prose about TRUNCATE lives in a comment in
 * the append-only migration, and the trigger there has `TRUNCATE` in a string
 * — matching either would report a migration that narrows nothing.
 */
function statements(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/\$\$[\s\S]*?\$\$/g, ' ');
}

function migrationFolders(): string[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function addsEnumValues(folder: string): boolean {
  return ADDS_ENUM_VALUE.test(
    statements(readFileSync(join(MIGRATIONS_DIR, folder, 'migration.sql'), 'utf8')),
  );
}

function narrowingsIn(folder: string): string[] {
  const sql = statements(readFileSync(join(MIGRATIONS_DIR, folder, 'migration.sql'), 'utf8'));
  return NARROWINGS.filter((rule) => rule.pattern.test(sql)).map((rule) => rule.what);
}

describe('migrations', () => {
  it('has migrations to check at all', () => {
    // A regex suite that silently matches nothing is the failure mode of every
    // check like this one.
    expect(migrationFolders().length).toBeGreaterThan(40);
  });

  it('narrows the schema only where it is written down, and nowhere else', () => {
    const found = new Map<string, string[]>();
    for (const folder of migrationFolders()) {
      const narrowings = narrowingsIn(folder);
      if (narrowings.length > 0) found.set(folder, narrowings);
    }

    const unlisted = [...found.keys()].filter((folder) => !(folder in NARROWING));
    expect(
      unlisted,
      `These migrations narrow the schema and are not in NARROWING:\n` +
        unlisted.map((f) => `  ${f} — ${found.get(f)?.join(', ')}`).join('\n') +
        `\n\nA narrowing migration means an image from before it cannot be rolled back to. ` +
        `If that is what you intend, add it to NARROWING with the reason and move the ` +
        `rollback floor named in docs/runbook.md. If it is not, make the change additive.`,
    ).toEqual([]);

    // The other direction, so the list cannot outlive the thing it describes.
    const stale = Object.keys(NARROWING).filter((folder) => !found.has(folder));
    expect(
      stale,
      `NARROWING lists these, but they no longer narrow anything. Remove them.`,
    ).toEqual([]);
  });

  it('records every migration that adds an enum value, and nothing that does not', () => {
    const found = migrationFolders().filter((folder) => addsEnumValues(folder));

    const unlisted = found.filter((folder) => !(folder in ADDS_ENUM_VALUES));
    expect(
      unlisted,
      `These migrations add a value to an enum and are not in ADDS_ENUM_VALUES:\n` +
        unlisted.map((f) => `  ${f}`).join('\n') +
        `\n\nAn image from before one of these throws — on findMany, not just on the ` +
        `row — as soon as any row uses the new value, and PostgreSQL cannot drop an ` +
        `enum value afterwards. Add it with the values it introduces, and move the ` +
        `second rollback floor in docs/runbook.md.`,
    ).toEqual([]);

    const stale = Object.keys(ADDS_ENUM_VALUES).filter((folder) => !found.includes(folder));
    expect(stale, `ADDS_ENUM_VALUES lists these, but they add no enum value.`).toEqual([]);
  });

  it('names the enum floor in the runbook, and keeps it the newest one', () => {
    const newest = [...Object.keys(ADDS_ENUM_VALUES)].sort().at(-1);
    expect(newest, 'ADDS_ENUM_VALUES is empty').toBeDefined();
    const runbook = readFileSync(join(MIGRATIONS_DIR, '..', '..', 'docs', 'runbook.md'), 'utf8');
    expect(
      runbook.includes(newest as string),
      `docs/runbook.md does not name ${String(newest)}, which is the newest migration that ` +
        `adds an enum value and therefore the floor for reading rolled-back images.`,
    ).toBe(true);
  });

  it('names the rollback floor in the runbook, and keeps it the newest narrowing', () => {
    /**
     * The tie between the document and the code.
     *
     * The runbook's rollback step is only correct relative to a specific
     * migration, and the whole failure this file exists for was that the
     * document stated an absolute instead. So the newest narrowing migration
     * has to appear in the runbook by name: add another one and this fails
     * until somebody updates the procedure.
     */
    const floor = Object.keys(NARROWING).sort().at(-1);
    expect(floor).toBeDefined();
    const runbook = readFileSync(join(import.meta.dirname, '..', 'docs', 'runbook.md'), 'utf8');

    /**
     * The *sentence*, not the name anywhere in the file.
     *
     * This first asserted only that the runbook mentioned the migration
     * somewhere — and a mutation that changed the boundary sentence to name a
     * different migration passed anyway, because the real name still appeared
     * in the table of past narrowings further down. A check satisfied by a
     * name in a list is not checking the claim; the claim is "you may roll
     * back to any image released after this one".
     */
    expect(
      runbook,
      `docs/runbook.md must state the rollback floor as "released after \`${floor}\`". ` +
        `Naming it anywhere in the file is not enough — the sentence that makes the ` +
        `promise has to be the one that names it.`,
    ).toContain(`released after\n\`${floor}\``);
  });

  it('every migration folder has exactly one migration.sql', () => {
    for (const folder of migrationFolders()) {
      const files = readdirSync(join(MIGRATIONS_DIR, folder));
      expect(files, `${folder}`).toEqual(['migration.sql']);
    }
  });
});
