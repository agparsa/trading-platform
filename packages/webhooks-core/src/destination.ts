import { isIP } from 'node:net';

/**
 * Where a webhook may be sent (§49, and the SSRF section of §72).
 *
 * A webhook is an HTTP request this platform makes to an address a customer
 * typed in. That is the textbook shape of server-side request forgery: point
 * the platform at `http://169.254.169.254/` and read the cloud metadata
 * service, at `http://postgres:5432/` and probe the database, at
 * `http://127.0.0.1:4000/admin/…` and reach routes the proxy never exposes.
 * So the destination is checked twice — the URL when it is registered, and
 * the address it resolves to at the moment of delivery, because a name that
 * pointed somewhere public on Tuesday can point at 127.0.0.1 on Wednesday.
 */

export type DestinationRefusal =
  'NOT_A_URL' | 'NOT_HTTPS' | 'HAS_CREDENTIALS' | 'HAS_FRAGMENT' | 'LOCAL_NAME' | 'PRIVATE_ADDRESS';

export type DestinationCheck =
  | { readonly ok: true; readonly url: URL }
  | { readonly ok: false; readonly reason: DestinationRefusal };

const LOCAL_NAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
]);

/** Whether a registered URL is one this platform is willing to call at all. */
export function checkDestination(
  raw: string,
  options: { readonly allowHttp?: boolean } = {},
): DestinationCheck {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'NOT_A_URL' };
  }
  if (url.protocol !== 'https:' && !(options.allowHttp === true && url.protocol === 'http:')) {
    return { ok: false, reason: 'NOT_HTTPS' };
  }
  if (url.username !== '' || url.password !== '') return { ok: false, reason: 'HAS_CREDENTIALS' };
  if (url.hash !== '') return { ok: false, reason: 'HAS_FRAGMENT' };

  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (
    LOCAL_NAMES.has(host) ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  ) {
    return { ok: false, reason: 'LOCAL_NAME' };
  }
  if (isIP(host) !== 0 && !isPublicAddress(host)) return { ok: false, reason: 'PRIVATE_ADDRESS' };
  return { ok: true, url };
}

function ipv4Octets(address: string): number[] | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : NaN));
  return octets.some((octet) => Number.isNaN(octet) || octet > 255) ? null : octets;
}

function privateIpv4(o: readonly number[]): boolean {
  const [a, b] = o as [number, number, number, number];
  return (
    a === 0 || // this network
    a === 10 || // private
    a === 127 || // loopback
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local, and the cloud metadata service
    (a === 172 && b >= 16 && b <= 31) || // private
    (a === 192 && b === 0 && o[2] === 0) || // IETF protocol assignments
    (a === 192 && b === 0 && o[2] === 2) || // documentation
    (a === 192 && b === 168) || // private
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    (a === 198 && b === 51 && o[2] === 100) || // documentation
    (a === 203 && b === 0 && o[2] === 113) || // documentation
    a >= 224 // multicast, reserved, broadcast
  );
}

function expandIpv6(address: string): number[] | null {
  const halves = address.split('::');
  if (halves.length > 2) return null;
  const parse = (text: string): number[] | null => {
    if (text === '') return [];
    const groups = text.split(':');
    const values = groups.map((group) =>
      /^[0-9a-f]{1,4}$/i.test(group) ? parseInt(group, 16) : NaN,
    );
    return values.some(Number.isNaN) ? null : values;
  };
  const head = parse(halves[0] ?? '');
  const tail = halves.length === 2 ? parse(halves[1] ?? '') : [];
  if (head === null || tail === null) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const missing = 8 - head.length - tail.length;
  if (missing < 1) return null;
  return [...head, ...new Array<number>(missing).fill(0), ...tail];
}

function privateIpv6(groups: readonly number[]): boolean {
  const [g0, g1] = groups as [number, number, ...number[]];
  const allZeroBut = (last: number) =>
    groups.slice(0, 7).every((g) => g === 0) && groups[7] === last;
  return (
    allZeroBut(0) || // unspecified
    allZeroBut(1) || // loopback
    (g0 & 0xfe00) === 0xfc00 || // unique local
    (g0 & 0xffc0) === 0xfe80 || // link-local
    (g0 === 0x2001 && g1 === 0x0db8) || // documentation
    (g0 & 0xff00) === 0xff00 // multicast
  );
}

/**
 * Whether an address, as resolved, is one on the public internet.
 *
 * IPv4-mapped IPv6 (`::ffff:10.0.0.1`) is unmapped first, because it is the
 * classic way a private address slips past a check written for dotted quads.
 */
export function isPublicAddress(address: string): boolean {
  const kind = isIP(address);
  if (kind === 4) {
    const octets = ipv4Octets(address);
    return octets !== null && !privateIpv4(octets);
  }
  if (kind === 6) {
    const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(address);
    if (mapped !== null) return isPublicAddress(mapped[1] as string);
    const groups = expandIpv6(address);
    if (groups === null) return false;
    // ::ffff:a.b.c.d written in hex groups.
    if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
      const [hi, lo] = [groups[6] as number, groups[7] as number];
      return isPublicAddress(`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`);
    }
    return !privateIpv6(groups);
  }
  return false;
}
