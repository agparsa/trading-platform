import { describe, expect, it } from 'vitest';
import { HealthIndicatorService } from '@nestjs/terminus';
import { WORKER_HEARTBEAT_PREFIX, type WorkerHeartbeat } from '@tp/shared-types';
import { WorkerHealthIndicator } from './health.indicators';
import type { RedisService } from '../redis/redis.service';

/**
 * A Redis with SCAN and MGET over a map, paged like the real one so the cursor
 * loop is exercised: a reader that stops after the first page reports one
 * worker where there are three.
 */
function redisWith(entries: Record<string, string>, pageSize = 1) {
  const keys = Object.keys(entries);
  const client = {
    scan: async (cursor: string, _m: string, pattern: string, _c: string, _count: number) => {
      const prefix = pattern.replace(/\*$/, '');
      const matching = keys.filter((key) => key.startsWith(prefix));
      const start = Number(cursor);
      const page = matching.slice(start, start + pageSize);
      const next = start + pageSize >= matching.length ? '0' : String(start + pageSize);
      return [next, page] as [string, string[]];
    },
    mget: async (...asked: string[]) => asked.map((key) => entries[key] ?? null),
  };
  return { client } as unknown as RedisService;
}

const beat = (
  instance: string,
  build: string,
  at = '2026-09-21T08:00:00.000Z',
): WorkerHeartbeat => ({
  instance,
  build,
  role: 'all',
  queues: ['swap-accrual'],
  startedAt: '2026-09-21T07:00:00.000Z',
  at,
  egress: null,
});

const NOW = Date.parse('2026-09-21T08:00:10.000Z');
const detailOf = (result: Record<string, unknown>) => result['workers'] as Record<string, unknown>;

describe('worker health', () => {
  it('is down, and says why, when no worker has reported in', async () => {
    const indicator = new WorkerHealthIndicator(new HealthIndicatorService(), redisWith({}));
    const result = await indicator.check('workers', NOW);
    expect(detailOf(result)['status']).toBe('down');
    expect(detailOf(result)['workers']).toBe(0);
    expect(String(detailOf(result)['note'])).toContain('no worker has reported');
  });

  it('names every instance with its build and age, across SCAN pages', async () => {
    const entries = {
      [`${WORKER_HEARTBEAT_PREFIX}c:3`]: JSON.stringify(beat('c:3', 'aaaaaaaaaaaa')),
      [`${WORKER_HEARTBEAT_PREFIX}a:1`]: JSON.stringify(beat('a:1', 'aaaaaaaaaaaa')),
      [`${WORKER_HEARTBEAT_PREFIX}b:2`]: JSON.stringify(
        beat('b:2', 'bbbbbbbbbbbb', '2026-09-21T07:59:40.000Z'),
      ),
      'tp:something:else': JSON.stringify(beat('x:9', 'cccccccccccc')),
    };
    const indicator = new WorkerHealthIndicator(
      new HealthIndicatorService(),
      redisWith(entries, 2),
    );
    const result = await indicator.check('workers', NOW);
    const detail = detailOf(result);
    expect(detail['status']).toBe('up');
    expect(detail['workers']).toBe(3);
    expect(detail['builds']).toEqual(['aaaaaaaaaaaa', 'bbbbbbbbbbbb']);
    expect(detail['instances']).toEqual([
      {
        instance: 'a:1',
        build: 'aaaaaaaaaaaa',
        role: 'all',
        queues: ['swap-accrual'],
        ageMs: 10_000,
        egress: null,
      },
      {
        instance: 'b:2',
        build: 'bbbbbbbbbbbb',
        role: 'all',
        queues: ['swap-accrual'],
        ageMs: 30_000,
        egress: null,
      },
      {
        instance: 'c:3',
        build: 'aaaaaaaaaaaa',
        role: 'all',
        queues: ['swap-accrual'],
        ageMs: 10_000,
        egress: null,
      },
    ]);
  });

  it('ignores a key under the prefix that is not a heartbeat, rather than reporting a worker with holes', async () => {
    const entries = {
      [`${WORKER_HEARTBEAT_PREFIX}a:1`]: JSON.stringify(beat('a:1', 'aaaaaaaaaaaa')),
      [`${WORKER_HEARTBEAT_PREFIX}junk`]: '{"instance":"junk"}',
    };
    const indicator = new WorkerHealthIndicator(new HealthIndicatorService(), redisWith(entries));
    const result = await indicator.check('workers', NOW);
    expect(detailOf(result)['workers']).toBe(1);
  });

  it('is down without a stack trace when Redis cannot be read', async () => {
    const redis = {
      client: {
        scan: async () => {
          throw new Error('connection is closed');
        },
      },
    } as unknown as RedisService;
    const result = await new WorkerHealthIndicator(new HealthIndicatorService(), redis).check(
      'workers',
      NOW,
    );
    expect(detailOf(result)['status']).toBe('down');
    expect(detailOf(result)['message']).toBe('Error');
  });
});
