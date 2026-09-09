import { describe, expect, it } from 'vitest';
import {
  evaluate,
  inCidr,
  isValidCidr,
  parseAddress,
  parseCidr,
  wouldLockOut,
  type IpRule,
} from './ip-rules';

const allow = (cidr: string, scope: 'STAFF' | 'EVERYONE' = 'STAFF'): IpRule => ({
  cidr,
  kind: 'ALLOW',
  scope,
});
const deny = (cidr: string, scope: 'STAFF' | 'EVERYONE' = 'STAFF'): IpRule => ({
  cidr,
  kind: 'DENY',
  scope,
});

const matches = (address: string, cidr: string): boolean => {
  const parsed = parseAddress(address);
  const range = parseCidr(cidr);
  return parsed !== null && range !== null && inCidr(parsed, range);
};

describe('parsing addresses', () => {
  it('reads IPv4', () => {
    expect(parseAddress('203.0.113.4')?.bits).toBe(32);
    expect(parseAddress('0.0.0.0')?.value).toBe(0n);
    expect(parseAddress('255.255.255.255')?.value).toBe(4_294_967_295n);
  });

  it('refuses an octet above 255, and a short address', () => {
    expect(parseAddress('203.0.113.256')).toBeNull();
    expect(parseAddress('203.0.113')).toBeNull();
    expect(parseAddress('203.0.113.4.5')).toBeNull();
  });

  it('reads IPv6, expanded or abbreviated', () => {
    expect(parseAddress('2001:0db8:0000:0000:0000:0000:0000:0001')?.value).toBe(
      parseAddress('2001:db8::1')?.value,
    );
    expect(parseAddress('::1')?.bits).toBe(128);
    expect(parseAddress('::')?.value).toBe(0n);
  });

  /**
   * Node hands these out for IPv4 clients on a dual-stack socket. Without
   * unmapping, every rule a firm writes for its own office fails to match the
   * office.
   */
  it('treats an IPv4-mapped IPv6 address as the IPv4 address it is', () => {
    expect(parseAddress('::ffff:203.0.113.4')?.value).toBe(parseAddress('203.0.113.4')?.value);
    expect(parseAddress('::ffff:203.0.113.4')?.bits).toBe(32);
  });

  /**
   * `::` must stand for at least one group. Accepting a `::` that expands to
   * nothing would let two spellings of different addresses compare equal.
   */
  it('refuses a `::` that stands for nothing', () => {
    expect(parseAddress('1:2:3:4:5:6:7::8')).toBeNull();
    expect(parseAddress('1:2:3:4:5:6:7:8:9')).toBeNull();
    expect(parseAddress('2001:db8::1::2')).toBeNull();
  });

  it('refuses things that are not addresses at all', () => {
    for (const junk of ['', '  ', 'localhost', '203.0.113.x', 'zzzz::1', '203.0.113.4/24/8']) {
      expect(parseAddress(junk), junk).toBeNull();
    }
  });
});

describe('parsing ranges', () => {
  it('reads a prefix', () => {
    expect(parseCidr('203.0.113.0/24')?.prefix).toBe(24);
    expect(parseCidr('2001:db8::/32')?.prefix).toBe(32);
  });

  /** What people type when they mean "one machine". */
  it('treats a bare address as a single host', () => {
    expect(parseCidr('203.0.113.4')?.prefix).toBe(32);
    expect(parseCidr('2001:db8::1')?.prefix).toBe(128);
  });

  /**
   * `203.0.113.7/24` is what somebody types when they mean that machine's
   * network. Masking makes the two spellings identical, which is what they
   * meant; refusing would teach them to write something they understand less.
   */
  it('masks a base that carries host bits', () => {
    expect(parseCidr('203.0.113.7/24')?.base).toBe(parseCidr('203.0.113.0/24')?.base);
  });

  it('refuses a prefix wider than the family allows', () => {
    expect(parseCidr('203.0.113.0/33')).toBeNull();
    expect(parseCidr('2001:db8::/129')).toBeNull();
    expect(parseCidr('203.0.113.0/-1')).toBeNull();
  });

  it('says which strings are usable', () => {
    expect(isValidCidr('10.0.0.0/8')).toBe(true);
    expect(isValidCidr('10.0.0.0/8/8')).toBe(false);
    expect(isValidCidr('nonsense')).toBe(false);
  });
});

describe('matching', () => {
  it('matches inside the range and not outside it', () => {
    expect(matches('203.0.113.4', '203.0.113.0/24')).toBe(true);
    expect(matches('203.0.114.4', '203.0.113.0/24')).toBe(false);
    expect(matches('203.0.113.4', '203.0.113.4')).toBe(true);
    expect(matches('203.0.113.5', '203.0.113.4')).toBe(false);
  });

  it('handles the boundaries of a range', () => {
    expect(matches('203.0.113.0', '203.0.113.0/24')).toBe(true);
    expect(matches('203.0.113.255', '203.0.113.0/24')).toBe(true);
    expect(matches('203.0.112.255', '203.0.113.0/24')).toBe(false);
    expect(matches('203.0.114.0', '203.0.113.0/24')).toBe(false);
  });

  it('treats /0 as everything, within its family', () => {
    expect(matches('203.0.113.4', '0.0.0.0/0')).toBe(true);
    expect(matches('2001:db8::1', '::/0')).toBe(true);
  });

  /**
   * The one that matters on a modern network: a firm writes an IPv4 allow-list
   * and its IPv6 clients must not be silently admitted by arithmetic that
   * happens to look right.
   */
  it('never matches across families', () => {
    expect(matches('2001:db8::1', '0.0.0.0/0')).toBe(false);
    expect(matches('203.0.113.4', '::/0')).toBe(false);
  });

  it('matches IPv6 ranges', () => {
    expect(matches('2001:db8:1::5', '2001:db8::/32')).toBe(true);
    expect(matches('2001:db9::5', '2001:db8::/32')).toBe(false);
  });
});

describe('the decision', () => {
  it('allows everything when the firm has written no rules', () => {
    expect(evaluate('203.0.113.4', [], 'STAFF')).toEqual({ allowed: true, reason: 'no-rules' });
  });

  /** A rule set of only denials is a block-list. */
  it('allows anything not denied when there is no allow-list', () => {
    const rules = [deny('198.51.100.0/24')];
    expect(evaluate('203.0.113.4', rules, 'STAFF').allowed).toBe(true);
    expect(evaluate('198.51.100.9', rules, 'STAFF')).toMatchObject({
      allowed: false,
      reason: 'denied',
    });
  });

  /** The first ALLOW changes the mode of the whole set. */
  it('refuses anything not allow-listed once an allow-list exists', () => {
    const rules = [allow('203.0.113.0/24')];
    expect(evaluate('203.0.113.4', rules, 'STAFF')).toMatchObject({ reason: 'allow-listed' });
    expect(evaluate('198.51.100.9', rules, 'STAFF')).toMatchObject({
      allowed: false,
      reason: 'not-allow-listed',
    });
  });

  /** An explicit block is an explicit block. */
  it('lets a denial beat an allow-list', () => {
    const rules = [allow('203.0.113.0/24'), deny('203.0.113.9')];
    expect(evaluate('203.0.113.4', rules, 'STAFF').allowed).toBe(true);
    expect(evaluate('203.0.113.9', rules, 'STAFF')).toMatchObject({ reason: 'denied' });
  });

  describe('scope', () => {
    it('applies a STAFF rule to staff and not to everyone', () => {
      const rules = [allow('203.0.113.0/24', 'STAFF')];
      expect(evaluate('198.51.100.9', rules, 'STAFF').allowed).toBe(false);
      expect(evaluate('198.51.100.9', rules, 'EVERYONE').allowed).toBe(true);
    });

    /** A firm that says "nobody from that network" means nobody, staff included. */
    it('applies an EVERYONE rule to staff too', () => {
      const rules = [deny('198.51.100.0/24', 'EVERYONE')];
      expect(evaluate('198.51.100.9', rules, 'STAFF').allowed).toBe(false);
      expect(evaluate('198.51.100.9', rules, 'EVERYONE').allowed).toBe(false);
    });
  });

  /**
   * A typo in one row must not silently widen an allow-list, and must not lock
   * a firm out of the panel where the typo could be fixed.
   */
  it('ignores a malformed rule rather than reading it either way', () => {
    const rules = [allow('203.0.113.0/24'), allow('not-an-address')];
    expect(evaluate('203.0.113.4', rules, 'STAFF').allowed).toBe(true);
    expect(evaluate('198.51.100.9', rules, 'STAFF').allowed).toBe(false);

    const denials = [deny('also-not-an-address')];
    expect(evaluate('203.0.113.4', denials, 'STAFF').allowed).toBe(true);
  });

  /** An address this platform cannot parse is not one it can judge. */
  it('does not enforce on an address it cannot read', () => {
    expect(evaluate('unknown', [allow('203.0.113.0/24')], 'STAFF').allowed).toBe(true);
  });
});

describe('lock-out protection', () => {
  /**
   * Asked before a rule is saved, against the address of the person saving it.
   * An allow-list that excludes its own author locks the firm out of the screen
   * where the mistake could be undone.
   */
  it('sees an allow-list that would exclude its author', () => {
    expect(wouldLockOut('198.51.100.9', [allow('203.0.113.0/24')], 'STAFF')).toBe(true);
    expect(wouldLockOut('203.0.113.4', [allow('203.0.113.0/24')], 'STAFF')).toBe(false);
  });

  it('sees a denial that would exclude its author', () => {
    expect(wouldLockOut('198.51.100.9', [deny('198.51.100.0/24')], 'STAFF')).toBe(true);
  });
});
