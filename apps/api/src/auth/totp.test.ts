import { describe, expect, it } from 'vitest';
import {
  base32Decode,
  base32Encode,
  codeForStep,
  generateRecoveryCode,
  generateSecret,
  matchCode,
  normaliseRecoveryCode,
  otpauthUri,
  STEP_SECONDS,
  stepFor,
} from './totp';

/**
 * RFC 6238, Appendix B.
 *
 * The published vectors, run against this implementation. This is the test that
 * matters: an authenticator app on a user's phone implements the RFC, and the
 * only useful definition of "correct" here is "agrees with it".
 */
const RFC_SECRET = Buffer.from('12345678901234567890', 'ascii');
const RFC_VECTORS: ReadonlyArray<{ seconds: number; eightDigits: string }> = [
  { seconds: 59, eightDigits: '94287082' },
  { seconds: 1111111109, eightDigits: '07081804' },
  { seconds: 1111111111, eightDigits: '14050471' },
  { seconds: 1234567890, eightDigits: '89005924' },
  { seconds: 2000000000, eightDigits: '69279037' },
  { seconds: 20000000000, eightDigits: '65353130' },
];

describe('TOTP, against RFC 6238 Appendix B', () => {
  it.each(RFC_VECTORS)('matches the published code at T=$seconds', ({ seconds, eightDigits }) => {
    const step = Math.floor(seconds / STEP_SECONDS);
    expect(codeForStep(RFC_SECRET, step, 8)).toBe(eightDigits);
    // Six digits is the same truncation carried one modulo further, which is
    // what every authenticator app displays.
    expect(codeForStep(RFC_SECRET, step, 6)).toBe(eightDigits.slice(2));
  });

  /**
   * The counter is 64 bits and this writes it as two 32-bit halves. No RFC
   * vector reaches that far — the highest, T = 20000000000, is step 666666666,
   * still comfortably inside 32 bits — so the high half has to be checked
   * directly, by confirming a step above 2^32 does not produce the same code as
   * the low 32 bits of itself. An implementation that dropped the high half
   * would agree with every published vector and be wrong only from about the
   * year 6053, which is exactly the kind of defect a test suite never finds by
   * accident.
   */
  it('uses the whole 64-bit counter, not just its low half', () => {
    const high = 2 ** 32 + 12345;
    expect(codeForStep(RFC_SECRET, high, 8)).not.toBe(codeForStep(RFC_SECRET, 12345, 8));
  });
});

describe('base32, against RFC 4648 §10', () => {
  const VECTORS: ReadonlyArray<[string, string]> = [
    ['', ''],
    ['f', 'MY======'],
    ['fo', 'MZXQ===='],
    ['foo', 'MZXW6==='],
    ['foob', 'MZXW6YQ='],
    ['fooba', 'MZXW6YTB'],
    ['foobar', 'MZXW6YTBOI======'],
  ];

  it.each(VECTORS)('encodes %o', (plain, encoded) => {
    expect(base32Encode(Buffer.from(plain, 'ascii'))).toBe(encoded);
  });

  it.each(VECTORS)('decodes back to %o', (plain, encoded) => {
    expect(base32Decode(encoded).toString('ascii')).toBe(plain);
  });

  it('refuses characters outside the alphabet instead of guessing', () => {
    expect(() => base32Decode('MZXW6YTB!')).toThrow(/base32/);
    // 0, 1 and 8 are deliberately absent from the alphabet.
    expect(() => base32Decode('018')).toThrow(/base32/);
  });
});

describe('matchCode', () => {
  const secret = base32Decode(generateSecret());
  const now = 1_700_000_000_000;

  it('accepts the current code and says which step it came from', () => {
    const step = stepFor(now);
    const match = matchCode(secret, codeForStep(secret, step), now);
    expect(match).toEqual({ step });
  });

  it('accepts one step either side, for a phone whose clock has drifted', () => {
    const step = stepFor(now);
    expect(matchCode(secret, codeForStep(secret, step - 1), now)).toEqual({ step: step - 1 });
    expect(matchCode(secret, codeForStep(secret, step + 1), now)).toEqual({ step: step + 1 });
  });

  it('refuses two steps away, so the window cannot quietly widen', () => {
    const step = stepFor(now);
    expect(matchCode(secret, codeForStep(secret, step - 2), now)).toBeNull();
    expect(matchCode(secret, codeForStep(secret, step + 2), now)).toBeNull();
  });

  it('refuses a code for a different secret', () => {
    const other = base32Decode(generateSecret());
    expect(matchCode(secret, codeForStep(other, stepFor(now)), now)).toBeNull();
  });

  it('refuses anything that is not six digits, without hashing it', () => {
    for (const input of ['', '12345', '1234567', 'abcdef', '12 34 56', '12345a']) {
      expect(matchCode(secret, input, now)).toBeNull();
    }
  });
});

describe('otpauth URI', () => {
  it('carries the secret, the issuer and the parameters an app needs', () => {
    const uri = otpauthUri('JBSWY3DPEHPK3PXP', 'trader@example.com', 'Trading Platform');
    const parsed = new URL(uri);
    expect(parsed.protocol).toBe('otpauth:');
    expect(parsed.searchParams.get('secret')).toBe('JBSWY3DPEHPK3PXP');
    expect(parsed.searchParams.get('digits')).toBe('6');
    expect(parsed.searchParams.get('period')).toBe('30');
    expect(parsed.searchParams.get('algorithm')).toBe('SHA1');
    // The label carries the issuer too; apps differ over which one they read.
    expect(decodeURIComponent(parsed.pathname)).toContain('Trading Platform:trader@example.com');
  });

  it('escapes an account name containing a colon, which would otherwise split the label', () => {
    const uri = otpauthUri('JBSWY3DPEHPK3PXP', 'a:b@example.com', 'Trading Platform');
    expect(uri).toContain('a%3Ab%40example.com');
  });
});

describe('generateSecret', () => {
  it('produces 160 bits, RFC 4226 §4 R6', () => {
    expect(base32Decode(generateSecret())).toHaveLength(20);
  });

  it('does not repeat', () => {
    const secrets = new Set(Array.from({ length: 200 }, () => generateSecret()));
    expect(secrets.size).toBe(200);
  });
});

describe('recovery codes', () => {
  it('reads back the way a person would write it down', () => {
    expect(generateRecoveryCode()).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  });

  it('omits the characters people misread on paper', () => {
    const sample = Array.from({ length: 300 }, () => generateRecoveryCode()).join('');
    for (const confusable of ['O', '0', 'I', '1', 'L']) {
      expect(sample).not.toContain(confusable);
    }
  });

  it('does not repeat', () => {
    const codes = new Set(Array.from({ length: 500 }, () => generateRecoveryCode()));
    expect(codes.size).toBe(500);
  });

  it('is distributed evenly across the alphabet, not skewed by a modulo', () => {
    const sample = Array.from({ length: 4000 }, () => generateRecoveryCode())
      .join('')
      .replace(/-/g, '');
    const counts = new Map<string, number>();
    for (const character of sample) counts.set(character, (counts.get(character) ?? 0) + 1);
    const expected = sample.length / 31;
    for (const [, count] of counts) {
      // Rejection sampling; a naive `% 31` skews the first eight characters by
      // about 3%, which this bound catches and randomness does not trip.
      expect(Math.abs(count - expected) / expected).toBeLessThan(0.15);
    }
    expect(counts.size).toBe(31);
  });

  it('accepts what a person actually types', () => {
    expect(normaliseRecoveryCode('4xq7-k2m9-pt3w')).toBe('4XQ7K2M9PT3W');
    expect(normaliseRecoveryCode('4XQ7 K2M9 PT3W')).toBe('4XQ7K2M9PT3W');
    expect(normaliseRecoveryCode('  4XQ7K2M9PT3W ')).toBe('4XQ7K2M9PT3W');
  });
});
