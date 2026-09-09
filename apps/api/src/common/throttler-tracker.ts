import { resolveClientIp } from '../security/client-ip';

/**
 * What the tracker needs from a request, and no more.
 *
 * The library hands it a `Record<string, any>`, so a full `express.Request`
 * cannot be required here. Naming the two fields used keeps that looseness at
 * this one boundary instead of letting it into the logic.
 */
interface Addressed {
  readonly ip?: string | undefined;
  readonly headers?: Readonly<Record<string, string | readonly string[] | undefined>> | undefined;
}

function forwardedFor(request: Addressed): string | undefined {
  const raw = request.headers?.['x-forwarded-for'];
  return Array.isArray(raw) ? raw.join(', ') : (raw as string | undefined);
}

/**
 * Which caller a rate-limit bucket belongs to.
 *
 * `@nestjs/throttler` buckets by `req.ip` by default. Express does not resolve
 * that from `X-Forwarded-For` unless `trust proxy` is set — and it deliberately
 * is not set here, because a blanket `trust proxy` would let any caller name
 * their own address. So behind nginx every request in the world arrives from
 * one container address, and **the whole platform shares a single bucket**: one
 * noisy client exhausts the allowance for every customer at once, and an
 * attacker gets the same allowance as the entire legitimate population
 * combined. That is a rate limiter that reads as a defence and is not one.
 *
 * So the bucket is the address `resolveClientIp` establishes from the forwarded
 * chain, using the same `TRUSTED_PROXY_HOPS` the IP rules use — one definition
 * of "who is calling" for the whole application, rather than two that can drift.
 *
 * When the address cannot be trusted this is the socket address, which is
 * exactly what the library would have used. The limiter is never worse than it
 * was, and never bucketed on a header a caller controls.
 */
export function trackerFor(hops: number | undefined) {
  return (request: Addressed): string => {
    const resolved = resolveClientIp(request.ip, forwardedFor(request), hops);
    return resolved.trusted ? resolved.address : (request.ip ?? '');
  };
}
