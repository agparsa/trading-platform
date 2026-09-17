/**
 * Asking the database whether the policies actually bite, rather than trusting
 * that they were installed.
 *
 * Every part of this design is checkable except one: whether the role the
 * application connected as is a role row-level security applies to. Ownership,
 * superuser and a missing policy all produce the same symptom — everything
 * works, and the second isolation layer quietly is not there. That is exactly
 * the kind of failure that survives a deploy, a review and an audit, because
 * nothing about it looks broken.
 *
 * So it is measured at boot, once, by asking the unprivileged connection to read
 * a tenant table with no tenant bound. `current_tenant_id()` is NULL there and
 * NULL matches no row, so the correct answer is zero. Any other answer means the
 * connection is exempt.
 */

/** The slice of a Prisma client this needs. Keeps the package free of Prisma. */
export interface RawQueryable {
  $queryRawUnsafe<T>(query: string, ...values: unknown[]): Promise<T>;
}

export type IsolationState =
  | { readonly enforced: true; readonly role: string }
  | { readonly enforced: false; readonly role: string; readonly reason: string }
  | { readonly enforced: 'unknown'; readonly role: string; readonly reason: string };

/**
 * `users` rather than a table chosen for convenience: it is the one table that
 * is never empty in a running deployment, and it is tenant-scoped.
 */
const PROBE_TABLE = 'users';

export async function probeTenantIsolation(
  unscoped: RawQueryable,
  privileged: RawQueryable,
): Promise<IsolationState> {
  try {
    const seen = (
      await unscoped.$queryRawUnsafe<Array<{ role: string; visible: number }>>(
        `SELECT current_user AS role, (SELECT count(*)::int FROM ${PROBE_TABLE}) AS visible`,
      )
    )[0];
    if (seen === undefined) {
      return { enforced: 'unknown', role: 'unknown', reason: 'the probe returned no rows' };
    }

    if (seen.visible > 0) {
      return {
        enforced: false,
        role: seen.role,
        reason:
          `role ${seen.role} reads ${String(seen.visible)} rows from ${PROBE_TABLE} with no tenant ` +
          'set, so row-level security does not apply to it — it owns the table, or it is a ' +
          'superuser, or the policy is missing',
      };
    }

    /**
     * Zero rows is only good news if there were rows to miss. On an empty
     * database it means nothing, and reporting it as enforcement would mean
     * reporting success at precisely the moment — a fresh deployment — when
     * somebody would believe it and stop checking.
     */
    const total =
      (
        await privileged.$queryRawUnsafe<Array<{ total: number }>>(
          `SELECT count(*)::int AS total FROM ${PROBE_TABLE}`,
        )
      )[0]?.total ?? 0;

    return total === 0
      ? {
          enforced: 'unknown',
          role: seen.role,
          reason: `${PROBE_TABLE} is empty, so reading zero rows proves nothing`,
        }
      : { enforced: true, role: seen.role };
  } catch (error) {
    return {
      enforced: 'unknown',
      role: 'unknown',
      reason: `the probe failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * How long to wait before asking again while the answer is still unknown.
 *
 * Only ever spent on a deployment with no rows in the probe table yet, and the
 * callers are a metrics refresh and a housekeeping sweep rather than a request,
 * so this is a floor against a health poll turning into a query per second —
 * not a latency budget.
 */
export const ISOLATION_REPROBE_MS = 30_000;

/**
 * Whether to ask the database again.
 *
 * Two rules, and the first is the one the original design was missing.
 *
 * **An unknown answer is not an answer.** The probe reads `users`, chosen
 * because that table "is never empty in a running deployment" — and it is empty
 * at exactly one moment, a fresh install starting for the first time, which was
 * the only moment anything asked. So a new deployment recorded *unknown* and
 * kept it for ever, and the refusal the operator was promised could not fire on
 * the deployment where getting it wrong costs the most.
 *
 * **A definite answer is final.** Table ownership and role membership do not
 * change under a running process, so re-asking a settled question every fifteen
 * seconds would be a query on the trading path's own pool for no new
 * information. A role altered underneath a running deployment is a restart, and
 * is out of scope on purpose rather than by omission.
 */
export function shouldReprobe(
  state: IsolationState,
  lastProbeAt: number,
  now: number,
  floorMs: number = ISOLATION_REPROBE_MS,
): boolean {
  if (state.enforced !== 'unknown') return false;
  return now - lastProbeAt >= floorMs;
}
