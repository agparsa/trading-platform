import { describe, expect, it } from 'vitest';
import { trackerFor } from './throttler-tracker';

/**
 * The rate limiter's bucket key.
 *
 * One assertion carries the point: two callers arriving through the same proxy
 * must land in different buckets. If they do not, the limiter is a single
 * shared allowance for the entire platform — worse than none, because it reads
 * as a defence.
 */

const request = (ip: string, forwardedFor?: string) => ({
  ip,
  headers: forwardedFor === undefined ? {} : { 'x-forwarded-for': forwardedFor },
});

describe('the rate limiter’s bucket', () => {
  it('gives two callers behind the same proxies two different buckets', () => {
    const track = trackerFor(2);
    const alice = track(request('172.16.1.1', '203.0.113.4, 10.0.0.1'));
    const mallory = track(request('172.16.1.1', '198.51.100.9, 10.0.0.1'));

    expect(alice).toBe('203.0.113.4');
    expect(mallory).toBe('198.51.100.9');
  });

  /**
   * The forged header. A caller who could choose their own bucket would have a
   * fresh allowance on every request, which is no allowance at all.
   */
  it('cannot be given a fresh bucket by a forged prefix', () => {
    const track = trackerFor(2);
    expect(track(request('172.16.1.1', 'evil.example, 9.9.9.9, 203.0.113.4, 10.0.0.1'))).toBe(
      track(request('172.16.1.1', '203.0.113.4, 10.0.0.1')),
    );
  });

  /**
   * Untrusted falls back to the socket address — what the library would have
   * used anyway. Never worse than before, never a header a caller controls.
   */
  it('falls back to the socket address when the chain cannot be trusted', () => {
    expect(trackerFor(undefined)(request('172.16.1.1', '203.0.113.4'))).toBe('172.16.1.1');
    expect(trackerFor(2)(request('172.16.1.1', '203.0.113.4'))).toBe('172.16.1.1');
  });

  /**
   * A repeated header. Node usually joins these itself, but when it does not
   * the chain is still a chain: keeping only the first entry would throw away
   * the trusted right-hand end and hand the caller their own bucket.
   */
  it('reads a repeated header as one chain, in order', () => {
    const track = trackerFor(2);
    const split = track({
      ip: '172.16.1.1',
      headers: { 'x-forwarded-for': ['evil.example', '203.0.113.4, 10.0.0.1'] },
    });
    expect(split).toBe(track(request('172.16.1.1', 'evil.example, 203.0.113.4, 10.0.0.1')));
    expect(split).toBe('203.0.113.4');
  });

  it('uses the socket address on a deployment that declares no proxies', () => {
    expect(trackerFor(0)(request('203.0.113.4', '1.2.3.4'))).toBe('203.0.113.4');
  });
});
