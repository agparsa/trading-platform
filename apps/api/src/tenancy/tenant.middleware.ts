import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { TenantResolver } from './tenant-resolver.service';
import { withTenant } from '@tp/tenancy';

/**
 * Puts a tenant in scope for the whole request, before anything else runs.
 *
 * Middleware rather than a guard, and `withTenant` rather than `enterWith`,
 * because middleware can wrap `next()` — so the scope begins and ends exactly
 * where the request does, with no chance of it leaking into the next one that
 * happens to reuse the same async context.
 *
 * The tenant here comes from the hostname, which is all that is available
 * before authentication. The auth guard then verifies that the token agrees.
 */
@Injectable()
export class TenantMiddleware implements NestMiddleware {
  constructor(private readonly resolver: TenantResolver) {}

  use(request: Request, _response: Response, next: NextFunction): void {
    void this.resolver
      .forHost(request.headers.host)
      .then((tenant) => {
        withTenant(tenant, next);
      })
      .catch((error: unknown) => {
        next(error);
      });
  }
}
