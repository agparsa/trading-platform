import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Background work has no tenant, and every one of these had forgotten.
 *
 * ## What happened
 *
 * Tenant isolation is enforced by a Prisma extension that refuses any query
 * made with no tenant in scope. A request always has one — the middleware opens
 * it — so the guard is invisible to every handler and to every test that drives
 * one.
 *
 * A timer does not. Nor does a tick handler, a socket refresh, or anything else
 * that runs because time passed rather than because somebody asked. On the day
 * isolation went live those paths began throwing, and the platform kept serving
 * requests perfectly while:
 *
 *   - stop-losses and take-profits stopped firing (the trigger engine's sweep
 *     failed on its first query, 12,296 times on the ingest instance),
 *   - realtime valuations stopped reaching connected terminals,
 *   - account snapshots stopped being taken,
 *   - and `refreshSockets` — which *removes* a socket's authority when access is
 *     revoked — failed before it could remove anything.
 *
 * Nothing in the test suite noticed, because every test that exercises those
 * services drives them from inside a scope the harness has already entered.
 *
 * ## What this test is
 *
 * A static sweep, deliberately. A behavioural version would have to boot each
 * background service with no scope, and the ones worth catching are exactly the
 * ones nobody remembers to add to such a list — so the check has to *find* its
 * own subjects rather than be given them.
 *
 * The rule: a file that starts background work and also touches the database
 * must say, somewhere in it, which tenant that work runs in. `withTenant` for
 * work that belongs to one, `withoutTenantScope` with a reason for work that
 * genuinely spans them. Not a proof — a file could open a scope for one query
 * and forget another — but it is the difference between a service that has
 * thought about the question and one that has not.
 */

const SOURCE = join(__dirname, '../../src');

/** Something that runs because time passed, not because somebody asked. */
const BACKGROUND = [
  /setInterval\s*\(/,
  /setTimeout\s*\(/,
  /onApplicationBootstrap\s*\(/,
  /onModuleInit\s*\(/,
  /\.subscribe\s*\(/,
];

const TOUCHES_DATABASE = /this\.prisma\./;
const NAMES_A_TENANT = /withTenant\s*\(|withoutTenantScope\s*\(/;

/**
 * Files exempt from the rule, each for a stated reason.
 *
 * A list rather than a pattern, so adding to it is a decision somebody makes on
 * purpose and a reviewer can argue with.
 */
const EXEMPT: Record<string, string> = {
  'market/market-feed.service.ts':
    'writes only Candle, which is global by design — an instrument’s price history is one history, not one per firm',
  'permissions/roles.service.ts':
    'reconciles roles at boot and does open a scope per tenant; the call is in a helper this regex does not see as background',
  'operations/kill-switch.service.ts':
    'reads only SystemSetting, which is in DELIBERATELY_UNSCOPED_MODELS — its tenant_id is nullable and null means the platform, so a halt has to be read across tenants to be read at all',
  'leadership/leadership.service.ts':
    'writes only LeaderLease, which has no tenant_id: which process runs the trigger engine is a property of the deployment, and a tenant must never be able to see or take it',
  'prisma/prisma.service.ts': 'is the scoping mechanism, not a user of it',
};

function walk(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, found);
      continue;
    }
    if (!entry.endsWith('.ts') || entry.endsWith('.test.ts')) continue;
    found.push(full);
  }
  return found;
}

describe('background work names the tenant it runs in', () => {
  const offenders: string[] = [];
  const checked: string[] = [];

  for (const file of walk(SOURCE)) {
    const source = readFileSync(file, 'utf8');
    if (!TOUCHES_DATABASE.test(source)) continue;
    if (!BACKGROUND.some((pattern) => pattern.test(source))) continue;

    const relative = file.slice(SOURCE.length + 1);
    if (relative in EXEMPT) continue;

    checked.push(relative);
    if (!NAMES_A_TENANT.test(source)) offenders.push(relative);
  }

  it('finds background services to check at all', () => {
    /**
     * The sweep must not pass by finding nothing.
     *
     * A refactor that renamed the lifecycle hooks, or moved the services, would
     * otherwise turn this into a test that asserts an empty list is empty.
     */
    expect(checked.length).toBeGreaterThanOrEqual(4);
  });

  it('leaves no background service that touches the database without one', () => {
    expect(
      offenders,
      'these run in the background, query the database, and never say which tenant: ' +
        'wrap the work in withTenant(), or name the crossing with withoutTenantScope(reason). ' +
        'If it genuinely needs neither, add it to EXEMPT with the reason.',
    ).toEqual([]);
  });

  it('exempts nothing that has since started scoping itself', () => {
    /**
     * An exemption that is no longer needed is a hole somebody could widen back
     * out without noticing, so it has to be removed when it stops being true.
     */
    /**
     * Only the exemptions claiming "does not need a scope" are checked.
     *
     * `roles.service.ts` is exempt because the regex cannot see its scoping, and
     * `prisma.service.ts` is the mechanism itself — both mention `withTenant`
     * and always will.
     */
    const claimsNoScopeNeeded = [
      'market/market-feed.service.ts',
      'operations/kill-switch.service.ts',
    ];
    const stale = claimsNoScopeNeeded.filter((relative) =>
      NAMES_A_TENANT.test(readFileSync(join(SOURCE, relative), 'utf8')),
    );
    expect(stale, 'these are exempt but now scope themselves; drop the exemption').toEqual([]);
  });
});
