import { describe, expect, it } from 'vitest';
import { coarseIp, describeDevice } from './device';

/** Real strings, taken as browsers actually send them. */
const AGENTS = {
  chromeMac:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  chromeWindows:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  edge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0',
  firefoxLinux: 'Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0',
  safariIphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
  chromeAndroid:
    'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
  curl: 'curl/8.7.1',
} as const;

describe('describeDevice', () => {
  it.each([
    [AGENTS.chromeMac, 'Chrome on macOS'],
    [AGENTS.chromeWindows, 'Chrome on Windows'],
    [AGENTS.firefoxLinux, 'Firefox on Linux'],
    [AGENTS.safariIphone, 'Safari on iPhone'],
    [AGENTS.curl, 'curl'],
  ])('reads %s as a name a person can check', (agent, label) => {
    expect(describeDevice(agent).label).toBe(label);
  });

  /**
   * Edge says Chrome, Chrome says Safari, and everything says Mozilla. These are
   * the cases that a naive "does it contain Chrome" check gets wrong, and the
   * user-visible cost of getting them wrong is telling somebody their Edge
   * session is a Chrome session they do not recognise.
   */
  it('is not fooled by browsers impersonating each other', () => {
    expect(describeDevice(AGENTS.edge).browser).toBe('Edge');
    expect(describeDevice(AGENTS.chromeMac).browser).toBe('Chrome');
    expect(describeDevice(AGENTS.safariIphone).browser).toBe('Safari');
  });

  it('reads Android as Android and not as the Linux it also claims', () => {
    expect(describeDevice(AGENTS.chromeAndroid).os).toBe('Android');
  });

  /**
   * No version in the signature. Chrome updates itself every few weeks, and an
   * alert on every update is an alert nobody reads by the third month.
   */
  it('gives one signature across versions of the same browser', () => {
    const older = AGENTS.chromeMac.replace('131.0.0.0', '120.0.0.0');
    expect(describeDevice(older).signature).toBe(describeDevice(AGENTS.chromeMac).signature);
  });

  it('separates different browsers and different systems', () => {
    const signatures = new Set(
      [AGENTS.chromeMac, AGENTS.chromeWindows, AGENTS.edge, AGENTS.firefoxLinux].map(
        (agent) => describeDevice(agent).signature,
      ),
    );
    expect(signatures.size).toBe(4);
  });

  /**
   * Found in a browser, not by reading the code: a headless Chrome session was
   * shown to the user as "Safari on Linux". `HeadlessChrome/` has no word
   * boundary before `Chrome`, so the Chrome pattern missed it and it fell
   * through to the Safari token every WebKit-derived agent also carries.
   */
  it('reads headless Chrome as Chrome, not as the Safari it also claims', () => {
    const headless =
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/141.0.0.0 Safari/537.36';
    expect(describeDevice(headless).label).toBe('Chrome on Linux');
  });

  it('says it does not know rather than inventing a name', () => {
    for (const input of [null, undefined, '', '   ', 'x']) {
      expect(describeDevice(input).label).toBe('Unknown device');
    }
  });
});

describe('coarseIp', () => {
  it('keeps enough of an IPv4 address to recognise, not enough to place', () => {
    expect(coarseIp('203.0.113.42')).toBe('203.0.113.x');
    expect(coarseIp('10.1.2.3')).toBe('10.1.2.x');
  });

  it('unwraps the IPv4-mapped form Node hands back on a dual-stack socket', () => {
    expect(coarseIp('::ffff:203.0.113.42')).toBe('203.0.113.x');
  });

  it('keeps the routing prefix of an IPv6 address', () => {
    expect(coarseIp('2001:0db8:85a3:0000:0000:8a2e:0370:7334')).toBe('2001:0db8:85a3::');
    expect(coarseIp('::1')).toBe('1::');
  });

  it('returns nothing rather than guessing', () => {
    for (const input of [null, undefined, '', '   ', 'not-an-address']) {
      expect(coarseIp(input)).toBeNull();
    }
  });
});
