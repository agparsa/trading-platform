import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'tp:isPublic';

/**
 * Marks a route as reachable without a token.
 *
 * Authentication is on by default — the guard is global — so forgetting this
 * decorator makes an endpoint private, which is the safe direction to fail.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
