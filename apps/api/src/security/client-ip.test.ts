import { describe, expect, it } from 'vitest';
import { resolveClientIp } from './client-ip';

describe('resolving the client address', () => {
  describe('with nothing declared', () => {
    /**
     * A deployment that has not said what sits in front of it is one where this
     * platform does not know whether the socket address is a client or an nginx
     * container. It is reported — the best answer available for a log line —
     * and is not a basis for a security decision.
     */
    it('reports the socket address and trusts nothing', () => {
      expect(resolveClientIp('172.16.1.1', '203.0.113.4, 10.0.0.1', undefined)).toEqual({
        address: '172.16.1.1',
        trusted: false,
      });
    });

    /** Not even a public one. The point is that nobody has said what it means. */
    it('does not trust a public socket address either', () => {
      expect(resolveClientIp('203.0.113.4', undefined, undefined).trusted).toBe(false);
    });
  });

  describe('with zero proxies declared', () => {
    /**
     * Zero is a claim, not an absence: an operator has said there is nothing in
     * front of this API. The socket address is therefore the client's, and the
     * forwarded header — which on a direct deployment can only have come from
     * the caller — is ignored entirely.
     */
    it('trusts the socket address and ignores the header', () => {
      expect(resolveClientIp('203.0.113.4', '1.2.3.4', 0)).toEqual({
        address: '203.0.113.4',
        trusted: true,
      });
    });

    it('trusts nothing when there is no socket address either', () => {
      expect(resolveClientIp(undefined, undefined, 0)).toEqual({ address: '', trusted: false });
    });

    it('trusts nothing when the socket address is not an address', () => {
      expect(resolveClientIp('not-an-address', undefined, 0).trusted).toBe(false);
    });
  });

  describe('behind one proxy', () => {
    it('takes the last entry, which is what one proxy appends', () => {
      expect(resolveClientIp('10.0.0.1', '203.0.113.4', 1)).toEqual({
        address: '203.0.113.4',
        trusted: true,
      });
    });

    /**
     * A caller may prepend anything. They cannot make it land in the trusted
     * position, because the real proxy appends after whatever they sent.
     */
    it('ignores entries the caller prepended', () => {
      expect(resolveClientIp('10.0.0.1', '1.2.3.4, 203.0.113.4', 1).address).toBe('203.0.113.4');
    });
  });

  describe('behind two proxies, as this deployment runs', () => {
    it('takes the second entry from the right', () => {
      expect(resolveClientIp('172.16.1.1', '203.0.113.4, 10.0.0.1', 2)).toEqual({
        address: '203.0.113.4',
        trusted: true,
      });
    });

    it('still ignores a forged prefix', () => {
      const forged = 'evil.example, 9.9.9.9, 203.0.113.4, 10.0.0.1';
      expect(resolveClientIp('172.16.1.1', forged, 2).address).toBe('203.0.113.4');
    });

    /**
     * A header shorter than the configuration promised means the request did
     * not come through the declared proxies — or somebody is playing with it.
     * Falling back to another entry is exactly how a caller who sends a short
     * header gets to choose which entry is believed.
     */
    it('trusts nothing when the chain is shorter than promised', () => {
      expect(resolveClientIp('172.16.1.1', '203.0.113.4', 2)).toEqual({
        address: '172.16.1.1',
        trusted: false,
      });
      expect(resolveClientIp('172.16.1.1', undefined, 2).trusted).toBe(false);
    });

    it('trusts nothing when the entry in that position is not an address', () => {
      expect(resolveClientIp('172.16.1.1', 'not-an-address, 10.0.0.1', 2).trusted).toBe(false);
    });
  });

  it('tolerates the spacing real proxies produce', () => {
    expect(resolveClientIp('172.16.1.1', ' 203.0.113.4 ,10.0.0.1 ', 2).address).toBe('203.0.113.4');
    expect(resolveClientIp('172.16.1.1', '203.0.113.4,,10.0.0.1', 2).address).toBe('203.0.113.4');
  });

  it('handles an IPv6 client', () => {
    expect(resolveClientIp('172.16.1.1', '2001:db8::1, 10.0.0.1', 2)).toEqual({
      address: '2001:db8::1',
      trusted: true,
    });
  });
});
