import { describe, expect, it, vi } from 'vitest';
import { TenantClientRegistry } from './registry';

const ALPHA = '11111111-1111-1111-1111-111111111111';
const BETA = '22222222-2222-2222-2222-222222222222';
const GAMMA = '33333333-3333-3333-3333-333333333333';

const TENANT_URL = 'postgresql://app:pw@db:5432/trading?schema=public';
const PRIVILEGED_URL = 'postgresql://owner:pw@db:5432/trading?schema=public';

interface FakeClient {
  readonly url: string;
  disconnected: number;
  $disconnect(): Promise<void>;
}

function build(overrides: Partial<Parameters<typeof make>[0]> = {}) {
  return make({ ...overrides });
}

function make(options: {
  maxClients?: number;
  drainMs?: number;
  onEvict?: (tenantId: string) => void;
}) {
  const created: FakeClient[] = [];
  const registry = new TenantClientRegistry<FakeClient>({
    tenantUrl: TENANT_URL,
    privilegedUrl: PRIVILEGED_URL,
    createClient: (url) => {
      const client: FakeClient = {
        url,
        disconnected: 0,
        $disconnect: () => {
          client.disconnected += 1;
          return Promise.resolve();
        },
      };
      created.push(client);
      return client;
    },
    ...options,
  });
  return { registry, created };
}

describe('TenantClientRegistry', () => {
  /**
   * Asserted on the decoded parameter rather than on the raw string, because
   * `URL.searchParams` writes a space as `+` and `=` as `%3D`. All three
   * spellings — `+`, `%20` and a literal space — were checked against a real
   * PostgreSQL through Prisma and all three arrive as the same startup option;
   * asserting the raw string would pin an encoding nobody chose.
   */
  it('binds the tenant to the connection it hands out', () => {
    const { registry } = build();
    const url = new URL(registry.forScope({ tenantId: ALPHA, slug: 'alpha' }).url);
    expect(url.searchParams.get('options')).toBe(`-c app.tenant_id=${ALPHA}`);
  });

  it('reuses one client per tenant', () => {
    const { registry, created } = build();
    const scope = { tenantId: ALPHA, slug: 'alpha' };
    expect(registry.forScope(scope)).toBe(registry.forScope(scope));
    expect(created).toHaveLength(1);
  });

  it('gives different tenants different clients', () => {
    const { registry } = build();
    const a = registry.forScope({ tenantId: ALPHA, slug: 'alpha' });
    const b = registry.forScope({ tenantId: BETA, slug: 'beta' });
    expect(a).not.toBe(b);
    expect(new URL(b.url).searchParams.get('options')).toBe(`-c app.tenant_id=${BETA}`);
    expect(b.url).not.toContain(ALPHA);
  });

  /**
   * The three-way split is the whole design. If a missing scope reached the
   * privileged client, forgetting to open a scope would disable both isolation
   * layers at once and look like nothing at all.
   */
  it('sends cross-tenant work to the privileged role and no one else there', () => {
    const { registry } = build();
    const cross = registry.forScope({ crossTenant: true, reason: 'sign-in lookup' });
    expect(cross.url).toBe(PRIVILEGED_URL);
    expect(registry.forScope({ tenantId: ALPHA, slug: 'alpha' }).url).not.toBe(PRIVILEGED_URL);
    expect(registry.forScope(undefined).url).not.toBe(PRIVILEGED_URL);
  });

  it('sends unscoped work to the unprivileged role with no tenant bound', () => {
    const { registry } = build();
    const client = registry.forScope(undefined);
    expect(client.url).toBe(TENANT_URL);
    expect(client.url).not.toContain('app.tenant_id');
  });

  it('refuses a tenant id that is not a UUID before creating anything', () => {
    const { registry, created } = build();
    expect(() => registry.forScope({ tenantId: `${ALPHA} -c role=postgres`, slug: 'x' })).toThrow(
      /not a UUID/,
    );
    expect(created).toHaveLength(0);
  });

  it('evicts the least recently used tenant at the cap', () => {
    const evicted: string[] = [];
    const { registry } = make({ maxClients: 2, onEvict: (id) => evicted.push(id) });

    registry.forScope({ tenantId: ALPHA, slug: 'a' });
    registry.forScope({ tenantId: BETA, slug: 'b' });
    // Touching alpha makes beta the least recently used.
    registry.forScope({ tenantId: ALPHA, slug: 'a' });
    registry.forScope({ tenantId: GAMMA, slug: 'c' });

    expect(evicted).toEqual([BETA]);
    expect(registry.size).toBe(2);
  });

  /**
   * `$disconnect()` kills queries that are still running — measured, not
   * assumed. An evicted client therefore stops receiving new work immediately
   * and closes later.
   */
  it('stops routing to an evicted client immediately but closes it only after the drain', () => {
    vi.useFakeTimers();
    try {
      const { registry, created } = make({ maxClients: 1, drainMs: 30_000 });
      const alpha = registry.forScope({ tenantId: ALPHA, slug: 'a' });
      registry.forScope({ tenantId: BETA, slug: 'b' });

      expect(alpha.disconnected).toBe(0);
      vi.advanceTimersByTime(29_999);
      expect(alpha.disconnected).toBe(0);
      vi.advanceTimersByTime(2);
      expect(alpha.disconnected).toBe(1);

      // And the tenant that was evicted gets a fresh client, not the closed one.
      expect(registry.forScope({ tenantId: ALPHA, slug: 'a' })).not.toBe(alpha);
      expect(created.filter((c) => c.url.includes(ALPHA))).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports a disconnect that fails rather than swallowing it', async () => {
    vi.useFakeTimers();
    const errors: unknown[] = [];
    try {
      const registry = new TenantClientRegistry<FakeClient>({
        tenantUrl: TENANT_URL,
        privilegedUrl: PRIVILEGED_URL,
        maxClients: 1,
        drainMs: 10,
        onDisconnectError: (_id, error) => errors.push(error),
        createClient: (url) => ({
          url,
          disconnected: 0,
          $disconnect: () => Promise.reject(new Error('pool already gone')),
        }),
      });
      registry.forScope({ tenantId: ALPHA, slug: 'a' });
      registry.forScope({ tenantId: BETA, slug: 'b' });
      await vi.advanceTimersByTimeAsync(20);
    } finally {
      vi.useRealTimers();
    }
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe('pool already gone');
  });

  it('closes every client on shutdown, including the privileged one', async () => {
    const { registry, created } = build();
    registry.forScope({ tenantId: ALPHA, slug: 'a' });
    registry.forScope({ crossTenant: true, reason: 'sweep' });
    registry.forScope(undefined);

    await registry.disconnectAll();

    expect(created).toHaveLength(3);
    expect(created.every((client) => client.disconnected === 1)).toBe(true);
    expect(registry.size).toBe(0);
  });

  it('does not close a client twice when shutdown follows an eviction', async () => {
    vi.useFakeTimers();
    try {
      const { registry, created } = make({ maxClients: 1, drainMs: 30_000 });
      registry.forScope({ tenantId: ALPHA, slug: 'a' });
      registry.forScope({ tenantId: BETA, slug: 'b' });
      await registry.disconnectAll();
      vi.advanceTimersByTime(60_000);
      const alpha = created.find((client) => client.url.includes(ALPHA));
      expect(alpha?.disconnected).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses a cap below one rather than evicting what it just created', () => {
    expect(
      () =>
        new TenantClientRegistry<FakeClient>({
          tenantUrl: TENANT_URL,
          privilegedUrl: PRIVILEGED_URL,
          maxClients: 0,
          createClient: (url) => ({ url, disconnected: 0, $disconnect: () => Promise.resolve() }),
        }),
    ).toThrow(/at least 1/);
  });
});
