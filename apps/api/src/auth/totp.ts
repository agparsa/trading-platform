import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Time-based one-time passwords, RFC 6238.
 *
 * Written out rather than taken from a package, for one reason: RFC 6238 and
 * RFC 4648 both publish test vectors, so this file can be *proved* against the
 * specification instead of trusted. `totp.test.ts` runs every vector from both.
 * The whole of the algorithm is forty lines; a dependency would have been forty
 * lines plus a supply chain, in the one place where a subtle wrong answer means
 * either locking every user out or letting anybody in.
 *
 * SHA-1 is not a mistake here. RFC 6238's default is HMAC-SHA-1 and it is what
 * every authenticator app implements; HMAC does not rely on the collision
 * resistance that SHA-1 has lost. Choosing SHA-256 would be marginally stronger
 * in theory and unusable in practice, which is not a trade a login screen wins.
 */

/** The 30-second period every authenticator app assumes. */
export const STEP_SECONDS = 30;
const DIGITS = 6;

/**
 * How many steps either side of now are accepted.
 *
 * One. That is ±30 seconds, which covers a phone whose clock has drifted and a
 * user who starts typing at second 29. Each extra step multiplies the number of
 * codes valid at any instant, so widening it to be forgiving is directly a
 * weakening — three steps means three times as many guesses land.
 */
export const DEFAULT_WINDOW = 1;

export function stepFor(atMs: number): number {
  return Math.floor(atMs / 1000 / STEP_SECONDS);
}

/** RFC 4226 §5.3 — HMAC, dynamic truncation, modulo. */
export function codeForStep(secret: Buffer, step: number, digits = DIGITS): string {
  const counter = Buffer.alloc(8);
  // The counter is 64-bit; writing it as two 32-bit halves keeps this correct
  // past 2038 without depending on BigInt in a hot path.
  counter.writeUInt32BE(Math.floor(step / 2 ** 32), 0);
  counter.writeUInt32BE(step >>> 0, 4);

  const digest = createHmac('sha1', secret).update(counter).digest();
  const offset = (digest[digest.length - 1] ?? 0) & 0x0f;
  const binary =
    (((digest[offset] ?? 0) & 0x7f) << 24) |
    (((digest[offset + 1] ?? 0) & 0xff) << 16) |
    (((digest[offset + 2] ?? 0) & 0xff) << 8) |
    ((digest[offset + 3] ?? 0) & 0xff);

  return (binary % 10 ** digits).toString().padStart(digits, '0');
}

export interface TotpMatch {
  /** The step the presented code belongs to. The caller must record it. */
  step: number;
}

/**
 * Checks a presented code and says **which step** it came from.
 *
 * Returning the step rather than a boolean is the whole design. A code is valid
 * for thirty seconds, which is thirty seconds in which anyone who saw it — over
 * a shoulder, in a phishing proxy, in a screenshot — can present it again. The
 * caller stores the step it accepted and refuses anything at or below it, so a
 * code works exactly once. A `verify(): boolean` cannot support that, and the
 * codebases that have one almost always accept replays without knowing it.
 */
export function matchCode(
  secret: Buffer,
  presented: string,
  atMs: number,
  window = DEFAULT_WINDOW,
): TotpMatch | null {
  if (!/^[0-9]{6}$/.test(presented)) return null;
  const centre = stepFor(atMs);
  let found: TotpMatch | null = null;
  for (let offset = -window; offset <= window; offset += 1) {
    const step = centre + offset;
    // No early return: every candidate is compared, so the time taken does not
    // reveal which step matched, and a near-miss costs the same as a miss.
    if (constantTimeEquals(codeForStep(secret, step), presented)) found = { step };
  }
  return found;
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

// ---------------------------------------------------------------------------
// Base32, RFC 4648 — the alphabet authenticator apps read
// ---------------------------------------------------------------------------

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(input: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of input) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += ALPHABET[(value << (5 - bits)) & 31];
  while (output.length % 8 !== 0) output += '=';
  return output;
}

export function base32Decode(input: string): Buffer {
  const cleaned = input.replace(/=+$/, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const character of cleaned) {
    const index = ALPHABET.indexOf(character);
    if (index === -1) throw new Error('not base32');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/**
 * A new shared secret.
 *
 * 20 bytes — 160 bits, RFC 4226's recommended length and what HMAC-SHA-1 uses
 * internally. Longer would be encoded to a longer string for the user to type
 * and buy nothing.
 */
export function generateSecret(): string {
  return base32Encode(randomBytes(20));
}

/**
 * The `otpauth://` URI an authenticator app scans.
 *
 * The issuer appears twice — once in the label prefix and once as a parameter —
 * because different apps read different ones, and an app that reads neither
 * shows the user a nameless six-digit code they cannot tell from any other.
 */
export function otpauthUri(secret: string, account: string, issuer: string): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// Recovery codes
// ---------------------------------------------------------------------------

/**
 * Codes for the user who has lost their phone.
 *
 * Grouped for legibility because people write these down and read them back;
 * `4XQ7-K2M9-PT3W` survives a transcription that `4xq7k2m9pt3w` does not. The
 * alphabet omits characters that are read as each other on paper — no O/0, no
 * I/1/L — for the same reason.
 *
 * 60 bits of entropy each. They are stored as SHA-256, not Argon2: like a
 * refresh token and unlike a password, there is no low-entropy guess to slow
 * down, and 60 bits is not being brute-forced.
 */
const RECOVERY_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const RECOVERY_CODE_COUNT = 10;

export function generateRecoveryCode(): string {
  const groups: string[] = [];
  for (let group = 0; group < 3; group += 1) {
    let text = '';
    // rejection-sampled from randomBytes: taking bytes modulo 31 would make the
    // first few characters of the alphabet measurably likelier.
    while (text.length < 4) {
      for (const byte of randomBytes(8)) {
        if (byte >= 248) continue;
        text += RECOVERY_ALPHABET[byte % RECOVERY_ALPHABET.length];
        if (text.length === 4) break;
      }
    }
    groups.push(text);
  }
  return groups.join('-');
}

/** Accepts what a person typed: any case, dashes or none, spaces or none. */
export function normaliseRecoveryCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, '');
}
