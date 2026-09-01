import { describe, expect, it } from 'vitest';
import { tenantConnectionUrl } from './connection';

const BASE = 'postgresql://app:pw@db:5432/trading?schema=public';
const ALPHA = '11111111-1111-1111-1111-111111111111';
const BETA = '22222222-2222-2222-2222-222222222222';

function optionsOf(url: string): string | null {
  return new URL(url).searchParams.get('options');
}

describe('tenantConnectionUrl', () => {
  it('binds the tenant to the connection', () => {
    expect(optionsOf(tenantConnectionUrl(BASE, ALPHA))).toBe(`-c app.tenant_id=${ALPHA}`);
  });

  it('keeps everything else about the connection', () => {
    const url = new URL(tenantConnectionUrl(`${BASE}&connection_limit=5`, ALPHA));
    expect(url.protocol).toBe('postgresql:');
    expect(url.host).toBe('db:5432');
    expect(url.pathname).toBe('/trading');
    expect(url.searchParams.get('schema')).toBe('public');
    expect(url.searchParams.get('connection_limit')).toBe('5');
  });

  it('keeps other startup options', () => {
    const url = tenantConnectionUrl(
      `${BASE}&options=${encodeURIComponent('-c statement_timeout=5s')}`,
      ALPHA,
    );
    expect(optionsOf(url)).toBe(`-c statement_timeout=5s -c app.tenant_id=${ALPHA}`);
  });

  /**
   * Configuration must not be able to name the tenant. A `DATABASE_URL` with
   * `app.tenant_id` already in it would otherwise silently outrank the tenant
   * the request is actually running as.
   */
  it('replaces a tenant already named in the base URL rather than appending', () => {
    const seeded = tenantConnectionUrl(BASE, BETA);
    const url = tenantConnectionUrl(seeded, ALPHA);
    expect(optionsOf(url)).toBe(`-c app.tenant_id=${ALPHA}`);
    expect(optionsOf(url)).not.toContain(BETA);
  });

  it('replaces it even when other options surround it', () => {
    const messy = `${BASE}&options=${encodeURIComponent(`-c a=1 -c app.tenant_id=${BETA} -c b=2`)}`;
    expect(optionsOf(tenantConnectionUrl(messy, ALPHA))).toBe(
      `-c a=1 -c b=2 -c app.tenant_id=${ALPHA}`,
    );
  });

  /**
   * The value lands in PostgreSQL's startup options, where whitespace separates
   * arguments. Every one of these is a second option wearing a tenant id, not a
   * malformed one.
   */
  it.each([
    ['a space and a second option', `${ALPHA} -c role=postgres`],
    ['a tab', `${ALPHA}\t-c\trole=postgres`],
    ['a bare word', 'not-a-uuid'],
    ['an empty string', ''],
    ['a quoted id', `'${ALPHA}'`],
    ['a URL-encoded space', `${ALPHA}%20-c%20role=postgres`],
    ['an ampersand', `${ALPHA}&connection_limit=99`],
    ['a UUID with one character too many', `${ALPHA}1`],
  ])('refuses %s', (_label, id) => {
    expect(() => tenantConnectionUrl(BASE, id)).toThrow(/not a UUID/);
  });

  it('accepts an uppercase UUID, which PostgreSQL compares equal', () => {
    expect(optionsOf(tenantConnectionUrl(BASE, ALPHA.toUpperCase()))).toContain(
      ALPHA.toUpperCase(),
    );
  });
});
