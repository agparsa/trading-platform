import { SetMetadata } from '@nestjs/common';

export const SELF_SERVICE_KEY = 'tp:self-service';

/**
 * This route acts only on the caller's own record.
 *
 * Changing your own password or your own display name needs no capability from
 * the permission catalogue — it needs ownership, which the handler enforces by
 * taking the account from the authenticated user rather than from the request.
 *
 * The marker exists so that "self-service" is a decision a reader can see, and
 * so the coverage test can tell it apart from a route where someone simply
 * forgot to declare a permission. It grants nothing.
 */
export const SelfService = () => SetMetadata(SELF_SERVICE_KEY, true);
