import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ConfigService } from '@nestjs/config';
import type { PrismaClient } from '@prisma/client';
import { LeadershipService, LeaderLoop } from '../../src/leadership/leadership.service';
import { MetricsService } from '../../src/metrics/metrics.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { createTestClient, hasTestDatabase } from './harness';

const suite = hasTestDatabase ? describe : describe.skip;

/**
 * Who is allowed to run the loops that must run in exactly one place.
 *
 * These tests use a real database because the whole mechanism *is* a database
 * statement: the safety comes from Postgres serialising two upserts on one
 * primary key and from `now()` being one clock. A fake would test the parts
 * that cannot go wrong.
 */
suite('leadership', () => {
  let prisma: PrismaClient;
  /**
   * Every service built by a test keeps a renewal timer running. Left alone,
   * one test's timer would re-take a lease the next test had just deleted, and
   * the failure would land in whichever test happened to be running — which is
   * the worst kind to debug.
   */
  const built: LeadershipService[] = [];

  const build = (overrides: Record<string, unknown> = {}): LeadershipService => {
    const service = new LeadershipService(
      prisma as unknown as PrismaService,
      new ConfigService({
        LEADER_LEASE_TTL_MS: 10_000,
        LEADER_RENEW_INTERVAL_MS: 3_000,
        LEADER_GUARD_MS: 1_000,
        ...overrides,
      } as never),
      new MetricsService(),
    );
    built.push(service);
    return service;
  };

  beforeAll(async () => {
    prisma = createTestClient();
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.leaderLease.deleteMany({});
  });

  afterEach(async () => {
    for (const service of built.splice(0)) await service.onApplicationShutdown();
  });

  /**
   * How long a contender is given to settle before its outcome is read.
   *
   * This was a flat 150 ms sleep, and it failed twice in a full parallel run:
   * `campaign` starts its first attempt without awaiting it and offers no
   * handle on it, so on a machine running a hundred and ninety test files at
   * once a single database round trip outlasted the wait and the assertion
   * read `acquired` before the attempt had finished. The test was measuring
   * the box, not the lease.
   *
   * So a contender that wins is waited *for* — usually tens of milliseconds —
   * and only one that is meant to lose spends the whole window. That is the
   * price of proving a negative, and it is now two seconds of headroom rather
   * than a hundred and fifty milliseconds of hope.
   */
  const SETTLE_MS = 2_000;

  /** Drive one acquire/renew attempt without waiting for the timer. */
  const attempt = async (
    service: LeadershipService,
  ): Promise<{ acquired: boolean; lost: string[] }> => {
    const lost: string[] = [];
    let acquired = false;
    service.campaign(LeaderLoop.TRIGGER_ENGINE, {
      onAcquired: () => {
        acquired = true;
      },
      onLost: (reason) => {
        lost.push(reason);
      },
    });
    const deadline = Date.now() + SETTLE_MS;
    while (!acquired && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    // `lost` is returned by reference: a test that breaks the database after
    // this returns still reads what the campaign reported afterwards.
    return { acquired, lost };
  };

  it('gives the lease to the first contender', async () => {
    const first = build();
    const result = await attempt(first);

    expect(result.acquired).toBe(true);
    expect(first.isLeading(LeaderLoop.TRIGGER_ENGINE)).toBe(true);

    const row = await prisma.leaderLease.findUniqueOrThrow({
      where: { name: LeaderLoop.TRIGGER_ENGINE },
    });
    expect(row.holder).toBe(first.instanceId);
    expect(row.term).toBe(1n);
  });

  /**
   * The case the whole mechanism exists for: two containers both told they may
   * run the trigger engine. Exactly one may act.
   */
  it('refuses a second contender while the lease is live', async () => {
    const first = build();
    await attempt(first);

    const second = build();
    const result = await attempt(second);

    expect(result.acquired).toBe(false);
    expect(second.isLeading(LeaderLoop.TRIGGER_ENGINE)).toBe(false);
    expect(first.isLeading(LeaderLoop.TRIGGER_ENGINE)).toBe(true);

    const row = await prisma.leaderLease.findUniqueOrThrow({
      where: { name: LeaderLoop.TRIGGER_ENGINE },
    });
    expect(row.holder).toBe(first.instanceId);
  });

  /**
   * Two contenders arriving at once, rather than one after the other. The
   * upsert is the only thing standing between this and two trigger engines, so
   * it is worth asserting against the database rather than against a mock.
   */
  it('gives the lease to exactly one of many simultaneous contenders', async () => {
    const contenders = [build(), build(), build(), build(), build()];
    const results = await Promise.all(contenders.map((service) => attempt(service)));

    expect(results.filter((result) => result.acquired)).toHaveLength(1);
    expect(
      contenders.filter((service) => service.isLeading(LeaderLoop.TRIGGER_ENGINE)),
    ).toHaveLength(1);

    const row = await prisma.leaderLease.findUniqueOrThrow({
      where: { name: LeaderLoop.TRIGGER_ENGINE },
    });
    expect(row.term).toBe(1n);
  });

  it('renews without pretending leadership changed hands', async () => {
    const first = build();
    await attempt(first);
    const before = await prisma.leaderLease.findUniqueOrThrow({
      where: { name: LeaderLoop.TRIGGER_ENGINE },
    });

    // A second pass by the same holder: renewal, not takeover.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await first['acquire'](LeaderLoop.TRIGGER_ENGINE);

    const after = await prisma.leaderLease.findUniqueOrThrow({
      where: { name: LeaderLoop.TRIGGER_ENGINE },
    });
    expect(after.term).toBe(before.term);
    expect(after.acquiredAt.getTime()).toBe(before.acquiredAt.getTime());
    expect(after.renewedAt.getTime()).toBeGreaterThan(before.renewedAt.getTime());
    expect(after.expiresAt.getTime()).toBeGreaterThan(before.expiresAt.getTime());
  });

  it('lets a successor take an expired lease, and counts the takeover', async () => {
    const dead = build();
    await attempt(dead);
    // The holder died without releasing: the row stays, the clock runs out.
    await prisma.leaderLease.update({
      where: { name: LeaderLoop.TRIGGER_ENGINE },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });

    const successor = build();
    const result = await attempt(successor);

    expect(result.acquired).toBe(true);
    const row = await prisma.leaderLease.findUniqueOrThrow({
      where: { name: LeaderLoop.TRIGGER_ENGINE },
    });
    expect(row.holder).toBe(successor.instanceId);
    expect(row.term).toBe(2n);
  });

  /**
   * A redeploy must not leave the trigger engine unled for a whole TTL. The
   * outgoing process hands the lease back rather than letting it lapse.
   */
  it('releases the lease on shutdown so the successor takes over at once', async () => {
    const outgoing = build();
    await attempt(outgoing);
    await outgoing.onApplicationShutdown();

    expect(outgoing.isLeading(LeaderLoop.TRIGGER_ENGINE)).toBe(false);

    const successor = build();
    const result = await attempt(successor);
    expect(result.acquired).toBe(true);
  });

  /**
   * The stalled-leader case. A process that has not renewed recently must stop
   * acting *on its own clock*, without asking the database — because a stall
   * and an unreachable database are usually the same incident.
   */
  it('stops acting once the lease is within the guard interval of expiry', async () => {
    const service = build({ LEADER_LEASE_TTL_MS: 2_000, LEADER_GUARD_MS: 1_900 });
    const result = await attempt(service);

    expect(result.acquired).toBe(true);
    // The lease is good for two seconds and the guard is nearly two seconds
    // wide, so there is almost no window in which acting is safe.
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(service.isLeading(LeaderLoop.TRIGGER_ENGINE)).toBe(false);
  });

  /**
   * An unreachable database is not evidence that somebody else took the lease.
   * It is evidence that this process can no longer prove it holds one — and a
   * singleton loop that cannot prove it must stop. Continuing on the strength
   * of a lease last confirmed some unknown time ago is how two engines end up
   * running during exactly the incident that makes it hardest to notice.
   */
  it('stands down when it cannot reach the database to renew', async () => {
    const service = build();
    const result = await attempt(service);
    expect(result.acquired).toBe(true);

    const broken = {
      $queryRaw: () => Promise.reject(new Error('connection terminated')),
    } as unknown as PrismaService;
    Object.defineProperty(service, 'prisma', { value: broken, configurable: true });

    await service['tick'](service['campaigns'].get(LeaderLoop.TRIGGER_ENGINE) as never);

    expect(service.isLeading(LeaderLoop.TRIGGER_ENGINE)).toBe(false);
    expect(result.lost).toContain('RENEW_FAILED');
  });

  it('reports every lease for the operations console', async () => {
    const service = build();
    await attempt(service);

    const leases = await service.leases();
    expect(leases).toHaveLength(1);
    expect(leases[0]?.name).toBe(LeaderLoop.TRIGGER_ENGINE);
    expect(leases[0]?.holder).toBe(service.instanceId);
  });

  it('refuses to campaign for the same loop twice in one process', async () => {
    const service = build();
    await attempt(service);
    expect(() =>
      service.campaign(LeaderLoop.TRIGGER_ENGINE, {
        onAcquired: () => undefined,
        onLost: () => undefined,
      }),
    ).toThrow(/Already campaigning/);
  });

  /** Leases are independent: leading one loop says nothing about the other. */
  it('keeps the loops separate', async () => {
    const engine = build();
    await attempt(engine);

    const ingest = build();
    let acquired = false;
    ingest.campaign(LeaderLoop.MARKET_INGEST, {
      onAcquired: () => {
        acquired = true;
      },
      onLost: () => undefined,
    });
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(acquired).toBe(true);
    expect(ingest.isLeading(LeaderLoop.MARKET_INGEST)).toBe(true);
    expect(ingest.isLeading(LeaderLoop.TRIGGER_ENGINE)).toBe(false);
    expect(engine.isLeading(LeaderLoop.MARKET_INGEST)).toBe(false);
  });
});
