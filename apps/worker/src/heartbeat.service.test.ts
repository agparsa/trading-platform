import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildMarker } from '@tp/crypto-core';
import {
  WORKER_HEARTBEAT_INTERVAL_MS,
  WORKER_HEARTBEAT_PREFIX,
  WORKER_HEARTBEAT_TTL_SECONDS,
  parseWorkerHeartbeat,
} from '@tp/shared-types';
import { HeartbeatService, type HeartbeatStore } from './heartbeat.service';

/** A store that remembers every call, with a TTL it can be asked about. */
function fakeStore(options: { failing?: boolean } = {}) {
  const entries = new Map<string, { value: string; ttl: number }>();
  const store: HeartbeatStore & { entries: typeof entries; writes: number } = {
    entries,
    writes: 0,
    async set(key, value, _mode, seconds) {
      store.writes += 1;
      if (options.failing) throw new Error('connection is closed');
      entries.set(key, { value, ttl: seconds });
      return 'OK';
    },
    async del(key) {
      if (options.failing) throw new Error('connection is closed');
      return entries.delete(key) ? 1 : 0;
    },
  };
  return store;
}

const config = (env: Record<string, string | undefined>) =>
  ({
    getOrThrow: (key: string) => {
      const value = env[key];
      if (value === undefined) throw new Error(`${key} missing`);
      return value;
    },
    get: (key: string) => env[key],
  }) as never;

describe('HeartbeatService', () => {
  const before = process.env['BUILD_SHA'];
  beforeEach(() => {
    process.env['BUILD_SHA'] = '54c7b29621323eadd2705c6cb86a0ef6ceaa4ff2';
  });
  afterEach(() => {
    if (before === undefined) delete process.env['BUILD_SHA'];
    else process.env['BUILD_SHA'] = before;
    vi.useRealTimers();
  });

  it('writes a heartbeat the shared contract can read, under the shared prefix, with the shared TTL', async () => {
    const store = fakeStore();
    const service = new HeartbeatService(config({ WORKER_ROLE: 'all' }), store);
    await service.beat(new Date('2026-09-21T08:00:00Z'));

    expect(store.entries.size).toBe(1);
    const [key, entry] = [...store.entries.entries()][0]!;
    expect(key.startsWith(WORKER_HEARTBEAT_PREFIX)).toBe(true);
    expect(entry.ttl).toBe(WORKER_HEARTBEAT_TTL_SECONDS);
    const beat = parseWorkerHeartbeat(entry.value);
    expect(beat).not.toBeNull();
    expect(beat?.build).toBe(buildMarker('54c7b29621323eadd2705c6cb86a0ef6ceaa4ff2'));
    expect(beat?.build).not.toBe('unknown');
    expect(beat?.role).toBe('all');
    expect(beat?.at).toBe('2026-09-21T08:00:00.000Z');
    expect(beat?.queues.length).toBeGreaterThan(0);
  });

  it('names the queues a narrowed processor takes, and none for a scheduler', async () => {
    const processor = fakeStore();
    await new HeartbeatService(
      config({ WORKER_ROLE: 'processor', WORKER_QUEUES: 'webhook-delivery' }),
      processor,
    ).beat();
    expect(parseWorkerHeartbeat([...processor.entries.values()][0]!.value)?.queues).toEqual([
      'webhook-delivery',
    ]);

    const scheduler = fakeStore();
    await new HeartbeatService(config({ WORKER_ROLE: 'scheduler' }), scheduler).beat();
    expect(parseWorkerHeartbeat([...scheduler.entries.values()][0]!.value)?.queues).toEqual([]);
  });

  it('says unknown, not nothing, when the image was not stamped', async () => {
    delete process.env['BUILD_SHA'];
    const store = fakeStore();
    await new HeartbeatService(config({ WORKER_ROLE: 'all' }), store).beat();
    expect(parseWorkerHeartbeat([...store.entries.values()][0]!.value)?.build).toBe('unknown');
  });

  it('beats on boot and then every interval', async () => {
    vi.useFakeTimers();
    const store = fakeStore();
    const service = new HeartbeatService(config({ WORKER_ROLE: 'all' }), store);
    await service.onApplicationBootstrap();
    expect(store.writes).toBe(1);
    await vi.advanceTimersByTimeAsync(WORKER_HEARTBEAT_INTERVAL_MS * 3 + 5);
    expect(store.writes).toBe(4);
    await service.onModuleDestroy();
    await vi.advanceTimersByTimeAsync(WORKER_HEARTBEAT_INTERVAL_MS * 3);
    expect(store.writes).toBe(4);
  });

  it('withdraws the key on a clean shutdown, so a stopped worker vanishes at once', async () => {
    const store = fakeStore();
    const service = new HeartbeatService(config({ WORKER_ROLE: 'all' }), store);
    await service.onApplicationBootstrap();
    expect(store.entries.size).toBe(1);
    await service.onModuleDestroy();
    expect(store.entries.size).toBe(0);
  });

  it('never throws when Redis is not there — a heartbeat must not stall a job', async () => {
    const store = fakeStore({ failing: true });
    const service = new HeartbeatService(config({ WORKER_ROLE: 'all' }), store);
    await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();
    await expect(service.beat()).resolves.toBeUndefined();
    await expect(service.onModuleDestroy()).resolves.toBeUndefined();
  });
});
