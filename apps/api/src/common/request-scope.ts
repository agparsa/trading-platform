import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * What the current unit of work knows about *why* it is running.
 *
 * Separate from the tenant scope on purpose. The tenant is a security
 * boundary and is set in exactly four places; this is provenance — a request
 * id to correlate by and the person acting — and it is read only to stamp
 * things: the event envelope, and later the outbox row and the webhook body.
 * Nothing decides anything from it. A missing scope means "not a request":
 * a worker job or a timer, and the fields come out null.
 */
export interface RequestScope {
  /** The request id: what the log line, the error envelope and the audit row carry. */
  readonly requestId: string;
  /** Set once the guard knows who is asking. Null on a public route. */
  actorId: string | null;
  /**
   * The idempotency claim this request is running under, while it runs.
   *
   * Read by `PrismaService.$transaction`, which marks the claim COMMITTED
   * inside whatever transaction the operation commits — so a crash between
   * the commit and the recording of the result leaves a row that says
   * "applied", and a retry is refused rather than run again. Set by
   * `IdempotencyService.claim`, cleared when the claim completes or is
   * abandoned.
   */
  idempotencyClaimId?: string | null;
}

const storage = new AsyncLocalStorage<RequestScope>();

/** Runs `fn` with this provenance. The middleware is the one caller. */
export function runInRequestScope<T>(scope: RequestScope, fn: () => T): T {
  return storage.run(scope, fn);
}

export function currentRequestScope(): RequestScope | undefined {
  return storage.getStore();
}

/**
 * Records who the request turned out to be from. Mutates the store rather
 * than opening a new one because the guard runs inside the middleware's scope
 * and cannot wrap what follows it.
 */
export function noteActor(actorId: string): void {
  const scope = storage.getStore();
  if (scope !== undefined) scope.actorId = actorId;
}

/** Test seam: run something as if it were a request. */
export const __testing = { storage };

/** Records the idempotency claim the request is running under, or clears it. */
export function noteIdempotencyClaim(claimId: string | null): void {
  const scope = storage.getStore();
  if (scope !== undefined) scope.idempotencyClaimId = claimId;
}

export function currentIdempotencyClaim(): string | null {
  return storage.getStore()?.idempotencyClaimId ?? null;
}
