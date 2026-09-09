import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * How a webhook proves it came from this platform (§49).
 *
 * The receiver holds a secret this platform showed them once. Every delivery
 * carries a header:
 *
 *     X-Signature: t=1725890000,v1=<hex hmac-sha256>
 *
 * where the MAC is over `${t}.${body}` — the timestamp *and* the exact bytes
 * delivered. Two consequences the receiver should know:
 *
 * - **The timestamp is inside the MAC.** A captured delivery replayed a day
 *   later carries a stale `t`; the receiver rejects it by age without needing
 *   to remember what it has seen. Without this, an attacker who obtained one
 *   valid delivery could resend it forever.
 * - **The body is signed as bytes, not as JSON.** Re-serialising before
 *   checking produces a different string on most stacks (key order, spacing,
 *   unicode escapes), and the signature fails on a perfectly genuine delivery.
 *   Verify the raw request body.
 *
 * `v1` names the scheme so a `v2` can be added alongside it later and a
 * receiver can be told which one it is checking. Several `v1` entries may be
 * present during a secret rotation; a receiver accepts the delivery if any of
 * them verifies.
 */

export const SIGNATURE_HEADER = 'x-signature';
export const SIGNATURE_SCHEME = 'v1';

export interface Signature {
  readonly timestamp: number;
  readonly digests: readonly string[];
}

function mac(secret: string, timestamp: number, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

/** The header value for one delivery. `secrets` newest first; all sign. */
export function sign(secrets: readonly string[], timestamp: number, body: string): string {
  if (secrets.length === 0) throw new Error('A webhook cannot be signed without a secret');
  if (!Number.isInteger(timestamp) || timestamp <= 0) {
    throw new Error('A webhook signature needs a positive integer timestamp');
  }
  const parts = [`t=${timestamp}`];
  for (const secret of secrets) parts.push(`${SIGNATURE_SCHEME}=${mac(secret, timestamp, body)}`);
  return parts.join(',');
}

/** Parses a header. Null for anything that is not the documented shape. */
export function parseSignature(header: string | undefined | null): Signature | null {
  if (typeof header !== 'string' || header.length === 0 || header.length > 4096) return null;
  let timestamp: number | undefined;
  const digests: string[] = [];
  for (const raw of header.split(',')) {
    const part = raw.trim();
    const eq = part.indexOf('=');
    if (eq <= 0) return null;
    const key = part.slice(0, eq);
    const value = part.slice(eq + 1);
    if (key === 't') {
      if (timestamp !== undefined || !/^\d{1,12}$/.test(value)) return null;
      timestamp = Number(value);
    } else if (key === SIGNATURE_SCHEME) {
      if (!/^[0-9a-f]{64}$/.test(value)) return null;
      digests.push(value);
    }
    // Unknown keys are ignored, so a future scheme can be added without
    // breaking receivers on this one.
  }
  if (timestamp === undefined || digests.length === 0) return null;
  return { timestamp, digests };
}

export type VerificationFailure = 'MALFORMED' | 'STALE' | 'MISMATCH';

export type Verification =
  { readonly ok: true } | { readonly ok: false; readonly reason: VerificationFailure };

/**
 * What a receiver runs. `tolerance` is how old a delivery may be, in seconds;
 * `now` is the receiver's clock in seconds.
 *
 * Every candidate digest is compared in constant time, and *all* of them are
 * compared even after a match, so the time taken says nothing about which
 * position matched or whether one did.
 */
export function verify(
  header: string | undefined | null,
  body: string,
  secrets: readonly string[],
  now: number,
  tolerance: number,
): Verification {
  const parsed = parseSignature(header);
  if (parsed === null) return { ok: false, reason: 'MALFORMED' };
  if (Math.abs(now - parsed.timestamp) > tolerance) return { ok: false, reason: 'STALE' };

  let matched = false;
  for (const secret of secrets) {
    const expected = Buffer.from(mac(secret, parsed.timestamp, body), 'hex');
    for (const digest of parsed.digests) {
      const candidate = Buffer.from(digest, 'hex');
      if (candidate.length === expected.length && timingSafeEqual(candidate, expected)) {
        matched = true;
      }
    }
  }
  return matched ? { ok: true } : { ok: false, reason: 'MISMATCH' };
}
