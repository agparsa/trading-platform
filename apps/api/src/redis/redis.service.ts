import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import type { Env } from '../config/env.schema';

/**
 * Redis connections.
 *
 * Three of them, deliberately: a connection in subscribe mode cannot issue
 * commands, so pub/sub gets its own pair and everything else shares the third.
 * Sharing one would deadlock the moment a handler tried to read a key.
 */
@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);

  readonly client: Redis;
  readonly publisher: Redis;
  readonly subscriber: Redis;

  // ConfigService is injected by explicit token: a generic parameter type
  // erases to `Function` in the emitted decorator metadata, and Nest cannot
  // resolve that.
  constructor(@Inject(ConfigService) config: ConfigService<Env, true>) {
    const url = config.get('REDIS_URL', { infer: true });
    const options = {
      // Fail fast and let the caller decide, rather than queueing trading
      // commands indefinitely against a dead Redis.
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      lazyConnect: true,
    } as const;
    this.client = new Redis(url, options);
    this.publisher = new Redis(url, options);
    this.subscriber = new Redis(url, options);
  }

  async onModuleInit(): Promise<void> {
    await Promise.all([
      ensureConnected(this.client),
      ensureConnected(this.publisher),
      ensureConnected(this.subscriber),
    ]);
    this.logger.log('Redis connections established');
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all([this.client.quit(), this.publisher.quit(), this.subscriber.quit()]);
  }

  async ping(): Promise<void> {
    const reply = await this.client.ping();
    if (reply !== 'PONG') throw new Error(`Unexpected Redis PING reply: ${reply}`);
  }
}

/**
 * Connects a lazy client only if it is not already connecting.
 *
 * These connections are `lazyConnect`, so ioredis dials on the first command.
 * The WebSocket gateway subscribes during Nest's initialisation, which can run
 * before this module's `onModuleInit` — and calling `connect()` on a socket
 * that is already dialling throws "Redis is already connecting/connected",
 * taking the whole process down at boot. Checking the status first makes the
 * call idempotent and removes the dependency on hook ordering.
 */
async function ensureConnected(connection: Redis): Promise<void> {
  if (connection.status === 'wait' || connection.status === 'end') {
    await connection.connect();
  }
}
