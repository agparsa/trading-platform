import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { REQUEST_ID_HEADER } from '@tp/shared-types';
import { resolveClientIp, type ResolvedIp } from '../security/client-ip';
import { runInRequestScope } from './request-scope';

/**
 * Express's `Request` extended with our per-request id.
 *
 * Declared as an explicit type rather than a global module augmentation: the
 * augmentation would make `requestId` look present on every Request in the
 * codebase, including ones no middleware has touched.
 */
export interface RequestWithContext extends Request {
  requestId?: string;
  /**
   * Who is calling, as far as the platform can tell — resolved once, here,
   * and read everywhere. See `clientAddress` for why nothing else may read
   * `request.ip`.
   */
  client?: ResolvedIp;
  /** Attached by BearerAuthGuard. Absent on public routes. */
  user?: RequestPrincipal;
}

/**
 * The address to record against what this request does.
 *
 * This is the **only** place `request.ip` is read for a client address. Express
 * resolves that from the socket, and behind nginx the socket is the proxy — so
 * every session, audit row and security event used to say the same container
 * address, and "signed in from somewhere new" could never fire. The middleware
 * resolves the real caller from the forwarded chain, under `TRUSTED_PROXY_HOPS`,
 * and this hands it out.
 *
 * It answers "what is the best address to write down", which is always
 * something: the forwarded address when the chain can be trusted, the socket
 * when it cannot. A security *decision* — the rate limiter, an IP rule — reads
 * `request.client.trusted` as well, because for those the honest answer to an
 * untrusted address is "do not decide", not "use the socket".
 */
export function clientAddress(request: RequestWithContext): string | undefined {
  const address = request.client?.address ?? request.ip;
  return address === undefined || address === '' ? undefined : address;
}

/**
 * Who is asking, as the guard established it.
 *
 * A session is a person at a screen. An API key is a person's script: `id`
 * is still theirs, so everything they do through it is theirs — but
 * `permissions` is the key's subset and the permission guard reads that
 * rather than the role. A service token is the firm's integration: `id` is
 * the token's own, `role` is `SERVICE`, and only routes whose declared
 * capabilities the token carries are reachable at all.
 */
export interface RequestPrincipal {
  id: string;
  email: string;
  role: string;
  sessionId: string;
  principal: 'session' | 'api_key' | 'service_token';
  /** Set for a key or token; absent for a session, whose capabilities are its role's. */
  credentialId?: string;
  permissions?: ReadonlySet<string>;
  /**
   * A live break-glass grant, when this request presented one (§9).
   *
   * The principal is still the staff member — this only says whose data they
   * are permitted to *read*, and the guard refuses every non-GET request that
   * carries a grant.
   */
  viewingAs?: {
    grantId: string;
    userId: string;
    email: string;
    expiresAt: Date;
  };
}

/**
 * Stamps every request with an id and echoes it back.
 *
 * The id appears in the log line, in the error envelope and in the audit row,
 * which is what makes "the order I placed at 09:27 was rejected" a traceable
 * report rather than a guessing game.
 */
export function requestContext(options: { readonly trustedProxyHops: number | undefined }) {
  return (req: RequestWithContext, res: Response, next: NextFunction): void => {
    const incoming = req.header(REQUEST_ID_HEADER);
    const id =
      incoming !== undefined && incoming.length > 0 && incoming.length <= 128
        ? incoming
        : randomUUID();
    req.requestId = id;
    res.setHeader(REQUEST_ID_HEADER, id);
    req.client = resolveClientIp(req.ip, req.header('x-forwarded-for'), options.trustedProxyHops);
    // The rest of the request runs inside the scope, so anything it publishes
    // can say which request caused it. `next` is called synchronously, which is
    // what makes the scope reach the handlers — see tenancy's `withTenant`.
    runInRequestScope({ requestId: id, actorId: null }, next);
  };
}
