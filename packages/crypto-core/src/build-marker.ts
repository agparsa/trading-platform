import { createHash } from 'node:crypto';

/**
 * The one-way marker a process publishes to say which build it is.
 *
 * Not the commit itself: `/health` is unauthenticated and this platform keeps
 * its route surface off the public internet, so publishing the exact revision
 * of a private repository there would tell anyone watching which code is
 * running and therefore which defect to try. A short digest identifies the
 * build to somebody who already knows what they deployed — `verify:production
 * --expect <sha>` computes the same digest and compares — and identifies
 * nothing to anybody else.
 *
 * `unknown` when the image was built without `BUILD_SHA`, which is itself worth
 * knowing: it means the deploy did not stamp its build, and the next person
 * asking "what is running?" will have no way to answer.
 *
 * Here rather than in the API because the API is not the only process that has
 * to answer the question. The real-time service answers it on its handshake
 * and the worker on its heartbeat, and three copies of a twelve-character rule
 * is how one of them ends up computing something different.
 */
export function buildMarker(sha: string | undefined = process.env['BUILD_SHA']): string {
  if (sha === undefined || sha === '' || sha === 'unknown') return 'unknown';
  return createHash('sha256').update(sha.trim()).digest('hex').slice(0, 12);
}
