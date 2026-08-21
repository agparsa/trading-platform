import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { REQUEST_ID_HEADER } from '@tp/shared-types';

/**
 * Express's `Request` extended with our per-request id.
 *
 * Declared as an explicit type rather than a global module augmentation: the
 * augmentation would make `requestId` look present on every Request in the
 * codebase, including ones no middleware has touched.
 */
export interface RequestWithContext extends Request {
  requestId?: string;
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
  next();
}
