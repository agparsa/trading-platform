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
    await Promise.all([this.client.connect(), this.publisher.connect(), this.subscriber.connect()]);
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
