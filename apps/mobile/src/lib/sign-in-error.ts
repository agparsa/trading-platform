import { isDomainError } from '@tp/shared-types';

/**
 * What the sign-in screen says when signing in fails.
 *
 * The server's message when there is one — "Too many attempts, try again in
 * 15 minutes" is actionable and "Sign-in failed" is not. Anything else used
 * to read "Could not reach the server. Try again." and nothing more, which is
 * what the first phone this app was installed on showed: true for a dead
 * network, false for a client calling the wrong path or a runtime missing a
 * global, and indistinguishable between them. The underlying message now
 * follows, short, so a screenshot is enough to tell which.
 *
 * `isDomainError` rather than `instanceof`: a class checked across two
 * bundled copies of a package is not the same class.
 */
export function signInErrorText(caught: unknown): string {
  if (isDomainError(caught)) return caught.message;
  const detail =
    caught instanceof Error && caught.message.trim() !== ''
      ? caught.message.trim().slice(0, 160)
      : null;
  return detail === null
    ? 'Could not reach the server. Try again.'
    : `Could not reach the server. Try again. (${detail})`;
}
