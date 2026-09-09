import { describe, expect, it } from 'vitest';
import { checkDestination, isPublicAddress } from './destination';

/**
 * Server-side request forgery, by the addresses that make it work.
 *
 * Every private, loopback, link-local and metadata address here is one an
 * attacker would type into the webhook form on purpose. The check is what
 * stands between "register a webhook" and "read the cloud metadata service".
 */
describe('where a webhook may be sent', () => {
  it('accepts a public https URL', () => {
    const result = checkDestination('https://hooks.example.com/tp?x=1');
    expect(result.ok).toBe(true);
  });

  it.each([
    ['not a url', 'NOT_A_URL'],
    ['ftp://hooks.example.com/', 'NOT_HTTPS'],
    ['http://hooks.example.com/', 'NOT_HTTPS'],
    ['https://user:pw@hooks.example.com/', 'HAS_CREDENTIALS'],
    ['https://hooks.example.com/#frag', 'HAS_FRAGMENT'],
    ['https://localhost/', 'LOCAL_NAME'],
    ['https://LOCALHOST:8443/', 'LOCAL_NAME'],
    ['https://api.localhost/', 'LOCAL_NAME'],
    ['https://postgres.internal/', 'LOCAL_NAME'],
    ['https://printer.local/', 'LOCAL_NAME'],
    ['https://127.0.0.1/', 'PRIVATE_ADDRESS'],
    ['https://10.0.0.1/', 'PRIVATE_ADDRESS'],
    ['https://172.16.1.1/', 'PRIVATE_ADDRESS'],
    ['https://192.168.1.1/', 'PRIVATE_ADDRESS'],
    ['https://169.254.169.254/latest/meta-data/', 'PRIVATE_ADDRESS'],
    ['https://100.64.0.1/', 'PRIVATE_ADDRESS'],
    ['https://0.0.0.0/', 'PRIVATE_ADDRESS'],
    ['https://[::1]/', 'PRIVATE_ADDRESS'],
    ['https://[fd00::1]/', 'PRIVATE_ADDRESS'],
    ['https://[fe80::1]/', 'PRIVATE_ADDRESS'],
    ['https://[::ffff:127.0.0.1]/', 'PRIVATE_ADDRESS'],
    ['https://[::ffff:7f00:1]/', 'PRIVATE_ADDRESS'],
  ] as const)('refuses %s (%s)', (url, reason) => {
    expect(checkDestination(url)).toEqual({ ok: false, reason });
  });

  it('allows plain http only when told to, for a local test receiver', () => {
    expect(checkDestination('http://hooks.example.com/', { allowHttp: true }).ok).toBe(true);
    expect(checkDestination('http://127.0.0.1/', { allowHttp: true })).toEqual({
      ok: false,
      reason: 'PRIVATE_ADDRESS',
    });
  });
});

describe('a resolved address', () => {
  it.each(['203.0.113.4', '8.8.8.8', '2606:4700::1111', '1.1.1.1'])('%s is public', (address) => {
    // 203.0.113.0/24 is documentation space and is refused — see below; the
    // rest are real public addresses.
    expect(isPublicAddress(address)).toBe(address !== '203.0.113.4');
  });

  it.each([
    '127.0.0.1',
    '127.255.255.255',
    '10.1.2.3',
    '172.31.255.255',
    '192.168.0.1',
    '169.254.169.254',
    '100.100.0.1',
    '0.0.0.1',
    '224.0.0.1',
    '255.255.255.255',
    '::1',
    '::',
    'fc00::1',
    'fdab::1',
    'fe80::1',
    'ff02::1',
    '2001:db8::1',
    '::ffff:10.0.0.1',
    '::ffff:a00:1',
  ])('%s is not', (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it('treats anything that is not an address as not public', () => {
    expect(isPublicAddress('hooks.example.com')).toBe(false);
    expect(isPublicAddress('')).toBe(false);
    expect(isPublicAddress('999.1.1.1')).toBe(false);
  });
});
