/**
 * Putting the tenant on the connection itself.
 *
 * ## The problem this solves
 *
 * Row-level security reads `app.tenant_id`, a session setting. Something has to
 * set it, and the obvious candidates are both bad:
 *
 *   - `set_config(..., true)` is transaction-local, so every read would have to
 *     be wrapped in a transaction. Measured on a local socket: 1.85ms p50
 *     against 0.72ms for the same read without one. Three round trips where
 *     there was one, on the order path.
 *   - `SET` without a transaction is session-level, and Prisma hands the next
 *     request whichever pooled connection is free. A tenant would leak into the
 *     next caller's queries, which is worse than having no second layer at all.
 *
 * There is a third option, and it costs nothing: PostgreSQL accepts `options` in
 * the startup packet, so a connection can be *born* with `app.tenant_id` already
 * set. Prisma passes the parameter through from the connection URL. Measured
 * the same way: 0.54ms p50, at or below the no-RLS floor, because there is no
 * extra statement at all.
 *
 * The cost is that a connection belongs to one tenant for its lifetime, which
 * is what `TenantClientRegistry` is for.
 *
 * ## Why the id is validated rather than escaped
 *
 * The value is interpolated into a connection string that PostgreSQL parses as
 * command-line options. A tenant id containing a space would not be a broken
 * query — it would be an *additional option*, chosen by whoever supplied the
 * id. `-c app.tenant_id=x -c role=postgres` is a privilege escalation written
 * as a UUID field.
 *
 * Tenant ids come from a `uuid` column and a JWT claim, so a strict UUID check
 * costs nothing and closes the whole class. Anything that is not a UUID is
 * refused rather than sanitised: sanitising invites an argument about which
 * characters are safe, and this code should not be having that argument.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The GUC every row-level-security policy reads. */
export const TENANT_SETTING = 'app.tenant_id';

/**
 * Returns `base` with `app.tenant_id` bound to `tenantId` for the life of every
 * connection it opens.
 *
 * Any `options` already present are preserved and any existing `app.tenant_id`
 * among them is replaced — a URL that carries one from configuration must not
 * be able to override the tenant actually in scope.
 */
export function tenantConnectionUrl(base: string, tenantId: string): string {
  if (!UUID.test(tenantId)) {
    throw new Error(
      `Refusing to build a connection for tenant id ${JSON.stringify(tenantId)}: not a UUID. ` +
        'The id is interpolated into PostgreSQL startup options, where a space would introduce ' +
        'a second option rather than a syntax error.',
    );
  }

  const url = new URL(base);
  const existing = url.searchParams.get('options');
  const kept =
    existing === null
      ? []
      : existing
          .split(/\s+/)
          .filter((token) => token.length > 0)
          .reduce<string[]>((tokens, token, index, all) => {
            // `-c key=value` arrives as two tokens. Drop both when the key is ours.
            if (token === '-c' && (all[index + 1] ?? '').startsWith(`${TENANT_SETTING}=`)) {
              return tokens;
            }
            if (token.startsWith(`${TENANT_SETTING}=`) && all[index - 1] === '-c') return tokens;
            return [...tokens, token];
          }, []);

  url.searchParams.set('options', [...kept, '-c', `${TENANT_SETTING}=${tenantId}`].join(' '));
  return url.toString();
}
