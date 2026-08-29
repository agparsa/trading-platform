/**
 * Describing the device a session came from.
 *
 * The scope here is deliberately narrow, and the narrowness is the design. This
 * reads the `User-Agent` header the browser already sends and the IP the
 * connection already arrived from. Nothing else. No canvas fingerprint, no font
 * enumeration, no screen metrics, no cross-site identifier — none of the
 * techniques that would make this more accurate and turn a security feature into
 * surveillance.
 *
 * The user-visible purpose is one question: *is one of these sessions not me?*
 * A person can answer that from "Firefox on Windows, 203.0.113.4, first seen
 * Tuesday". They cannot answer it from a hash, however unique it is, and a hash
 * is exactly what a fingerprint would give them.
 *
 * A user agent is self-reported and trivially forged. That is fine for what this
 * is used for — telling a user what their sessions look like, and noticing when
 * a new kind of client appears — and it is why nothing here is used to *grant*
 * anything. It informs a person; it never decides.
 */

export interface DeviceDescription {
  browser: string;
  os: string;
  /** What a person reads: "Chrome on macOS". */
  label: string;
  /**
   * The value new-device detection compares.
   *
   * Browser and OS only — no version. Chrome updates itself every few weeks, and
   * keying on the version would mean an alert every time it did, which is how a
   * genuine alert ends up ignored.
   */
  signature: string;
}

const UNKNOWN: DeviceDescription = {
  browser: 'Unknown browser',
  os: 'Unknown system',
  label: 'Unknown device',
  signature: 'unknown|unknown',
};

/**
 * Order matters throughout: Edge announces itself as Chrome, Chrome announces
 * itself as Safari, and almost everything announces itself as Mozilla. The
 * specific names have to be tried before the ones they impersonate.
 */
const BROWSERS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bEdg[A-Za-z]*\//, 'Edge'],
  [/\bOPR\/|\bOpera\b/, 'Opera'],
  [/\bFirefox\/|\bFxiOS\//, 'Firefox'],
  // `HeadlessChrome/` has no word boundary before `Chrome`, so it needs saying
  // outright — otherwise it falls through to the Safari token it also carries
  // and a Chrome session is labelled Safari.
  [/\bChrome\/|\bCriOS\/|HeadlessChrome\//, 'Chrome'],
  [/\bSafari\//, 'Safari'],
  [/\bcurl\//, 'curl'],
  [/\bPostmanRuntime\//, 'Postman'],
  [/\bnode-fetch\b|\bundici\b/, 'Node'],
];

const SYSTEMS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\biPhone\b|\biPod\b/, 'iPhone'],
  [/\biPad\b/, 'iPad'],
  [/\bAndroid\b/, 'Android'],
  [/\bWindows NT\b/, 'Windows'],
  [/\bMac OS X\b|\bMacintosh\b/, 'macOS'],
  [/\bCrOS\b/, 'ChromeOS'],
  [/\bLinux\b|\bX11\b/, 'Linux'],
];

export function describeDevice(userAgent: string | null | undefined): DeviceDescription {
  if (typeof userAgent !== 'string' || userAgent.trim().length === 0) return UNKNOWN;

  const browser = BROWSERS.find(([pattern]) => pattern.test(userAgent))?.[1] ?? null;
  const os = SYSTEMS.find(([pattern]) => pattern.test(userAgent))?.[1] ?? null;

  // Recognising neither means this is something we have no name for. Saying
  // "Unknown device" is more honest than inventing a label from a string we did
  // not understand, and it is also the more useful alarm: a session the platform
  // cannot name is exactly the one worth a second look.
  if (browser === null && os === null) return UNKNOWN;

  const browserName = browser ?? UNKNOWN.browser;
  const osName = os ?? UNKNOWN.os;
  return {
    browser: browserName,
    os: osName,
    label: browser === null ? osName : os === null ? browserName : `${browserName} on ${osName}`,
    signature: `${browser ?? 'unknown'}|${os ?? 'unknown'}`,
  };
}

/**
 * Trims an IP to something a person can compare without it being a precise
 * location.
 *
 * IPv4 keeps three octets, IPv6 keeps the routing prefix. "203.0.113.x" answers
 * "was that me, at home, this morning?" — which is the whole question — while
 * not putting a full address in an email that may itself be read by somebody
 * else. The full value stays in the session row for an investigation that needs
 * it.
 */
export function coarseIp(ip: string | null | undefined): string | null {
  if (typeof ip !== 'string' || ip.trim().length === 0) return null;
  const value = ip.trim().replace(/^::ffff:/, '');

  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value);
  if (v4 !== null) return `${v4[1]}.${v4[2]}.${v4[3]}.x`;

  if (value.includes(':')) {
    const groups = value.split(':').filter((group) => group.length > 0);
    if (groups.length === 0) return null;
    return `${groups.slice(0, 3).join(':')}::`;
  }
  return null;
}
