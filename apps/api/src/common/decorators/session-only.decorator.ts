import { SetMetadata } from '@nestjs/common';

export const SESSION_ONLY_KEY = 'tp:session-only';

/**
 * This route is for a signed-in person, never for an API key or a service
 * token.
 *
 * The auth guard refuses a credential here whatever it carries. Used on the
 * routes that manage credentials — a key that can mint keys is a key that
 * never expires — and on anything else where the person, not their script,
 * has to be the one asking. `@SelfService()` routes are treated the same way
 * without needing this: changing your password from a stolen key is the
 * first thing a thief would do.
 */
export const SessionOnly = () => SetMetadata(SESSION_ONLY_KEY, true);
