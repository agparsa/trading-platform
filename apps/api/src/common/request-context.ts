import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { REQUEST_ID_HEADER } from '@tp/shared-types';
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
  /** Attached by BearerAuthGuard. Absent on public routes. */
  user?: RequestPrincipal;
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
}

/**
 * Stamps every request with an id and echoes it back.
 *
 * The id appears in the log line, in the error envelope and in the audit row,
 * which is what makes "the order I placed at 09:27 was rejected" a traceable
 * report rather than a guessing game.
 */
export function requestContext(req: RequestWithContext, res: Response, next: NextFunction): void {
  const incoming = req.header(REQUEST_ID_HEADER);
  const id =
    incoming !== undefined && incoming.length > 0 && incoming.length <= 128
      ? incoming
      : randomUUID();
  req.requestId = id;
  res.setHeader(REQUEST_ID_HEADER, id);
  // The rest of the request runs inside the scope, so anything it publishes
  // can say which request caused it. `next` is called synchronously, which is
  // what makes the scope reach the handlers — see tenancy's `withTenant`.
  runInRequestScope({ requestId: id, actorId: null }, next);
}
