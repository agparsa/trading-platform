import type { RedisService } from '../../src/redis/redis.service';

/**
 * Redis, as far as the services under test use it: a publisher whose messages
 * are kept, a subscriber that never delivers, and a counter per key. In
 * memory, so a test decides what Redis does — including dying.
 */
export function redisStub(): {
  service: RedisService;
  published: string[];
  counters: Map<string, number>;
  failing: boolean;
} {
  const published: string[] = [];
  const counters = new Map<string, number>();
  const state = { failing: false };
  const client = {
    incr: async (key: string) => {
      if (state.failing) throw new Error('Redis is away');
      const next = (counters.get(key) ?? 0) + 1;
      counters.set(key, next);
      return next;
    },
    expire: async () => 1,
  };
  const service = {
    client,
    publisher: {
      publish: (_channel: string, message: string) => {
        published.push(message);
        return Promise.resolve(1);
      },
    },
    subscriber: { subscribe: () => Promise.resolve(), on: () => undefined },
  } as unknown as RedisService;
  return {
    service,
    published,
    counters,
    get failing() {
      return state.failing;
    },
    set failing(value: boolean) {
      state.failing = value;
    },
  };
}
