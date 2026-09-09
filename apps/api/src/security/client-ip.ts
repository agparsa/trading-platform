import { parseAddress } from './ip-rules';

/**
 * Who is actually calling, behind however many proxies this deployment has.
 *
 * ## Why this cannot be `request.ip`
 *
 * This platform runs behind two of them: a host nginx holding 80/443, and the
 * stack's own nginx container. `request.ip` is the last hop — the proxy — so
 * every client in the world looks like `172.16.1.1`. An allow-list built on
 * that either admits everybody or excludes everybody, and both are worse than
 * having no allow-list at all.
 *
 * ## Why `X-Forwarded-For` is not simply trusted
 *
 * It is a header. Anyone can send one. Trusting it blindly hands every caller a
 * free choice of source address, which is precisely the control an IP allow-list
 * is supposed to be.
 *
 * So the number of proxies is **configuration**, not a guess:
 * `TRUSTED_PROXY_HOPS` says how many entries at the right-hand end of the chain
 * were appended by infrastructure this deployment owns. The client is the entry
 * immediately to their left. A caller can prepend anything they like; they
 * cannot make their own forgery land in that position, because each real proxy
 * appends after it.
 *
 * ## Why unset and zero are different
 *
 * A deployment that has **not said** how many proxies it has is a deployment
 * where this platform does not know whether the socket address is a client or a
 * proxy. The safe unknown is "do not decide": the address is reported, for logs
 * and audit rows, and marked untrusted so nothing is enforced on it.
 *
 * A deployment that says **zero** has said there is nothing in front of it. The
 * socket address is the client and is trusted — which is the correct and
 * ordinary answer for an API exposed directly, and a claim only the operator
 * can make.
 *
 * Collapsing the two would mean either refusing every direct deployment the
 * feature, or silently enforcing an allow-list against an nginx container's
 * address, which admits everybody. Neither is worth saving a variable.
 *
 * **Nothing enforces an IP rule on an untrusted address.** The API also refuses
 * to create one while the platform cannot see real client addresses, so the
 * usual way to reach that state is to change `TRUSTED_PROXY_HOPS` afterwards —
 * which is loud rather than silent.
 */
export interface ResolvedIp {
  /** The best answer available, for logs and audit rows. Never null. */
  readonly address: string;
  /**
   * Whether it is good enough to make a security decision on.
   *
   * False when the deployment has not said how many proxies it has, or when the
   * chain is shorter than the configured number of hops — a header that does
   * not have the shape the configuration promised is a header this platform
   * will not reason about.
   */
  readonly trusted: boolean;
}

export function resolveClientIp(
  socketAddress: string | undefined,
  forwardedFor: string | undefined,
  trustedHops: number | undefined,
): ResolvedIp {
  const socket = (socketAddress ?? '').trim();

  if (trustedHops === undefined) {
    /**
     * Nothing declared. The socket address may be the client or may be an nginx
     * container, and this platform has no way to tell the two apart — so it is
     * reported, because logs and audit rows want the best answer available, and
     * not trusted, because a security decision wants a true one.
     */
    return { address: socket, trusted: false };
  }

  if (trustedHops === 0) {
    /**
     * Declared: nothing in front. The socket address *is* the client, and the
     * forwarded header is ignored entirely — a caller who sends one on a direct
     * deployment is trying to choose their own source address.
     */
    return { address: socket, trusted: socket !== '' && parseAddress(socket) !== null };
  }

  const chain = (forwardedFor ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');

  /**
   * With N trusted hops, the client sits N entries from the right — counting
   * the socket address as the last hop, which never appears in the header.
   *
   * One proxy: `XFF: client`, and the client is the last entry.
   * Two proxies: `XFF: client, first-proxy`, and the client is the second from
   * the right.
   */
  const index = chain.length - trustedHops;
  const candidate = chain[index];
  if (candidate === undefined || parseAddress(candidate) === null) {
    /**
     * The chain is shorter than promised, or the entry is not an address.
     * Either the request did not come through the proxies this deployment
     * declared, or somebody is playing with the header. Neither is a basis for
     * a decision — and inventing one by falling back to another entry is how a
     * caller who sends a short header gets to choose which entry is believed.
     */
    return { address: socket, trusted: false };
  }
  return { address: candidate, trusted: true };
}
