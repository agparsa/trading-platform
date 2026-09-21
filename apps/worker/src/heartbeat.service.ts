import { hostname } from 'node:os';
import {
  Inject,
  Injectable,
  Logger,
  Optional,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import IORedis from 'ioredis';
import { buildMarker } from '@tp/crypto-core';
import {
  WORKER_HEARTBEAT_INTERVAL_MS,
  WORKER_HEARTBEAT_TTL_SECONDS,
  workerHeartbeatKey,
  type WorkerHeartbeat,
} from '@tp/shared-types';
import type { WorkerEnv } from './env';
import { workerAssignment } from './roles';

/**
 * The narrow interface this service needs from Redis, so a test can hand it a
 * map and the production wiring can hand it a client.
 */
export interface HeartbeatStore {
  set(key: string, value: string, mode: 'EX', seconds: number): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

/** Injection token for a store supplied from outside; absent in production. */
export const HEARTBEAT_STORE = Symbol('HEARTBEAT_STORE');

/**
 * Says this worker is alive, and which build it is.
 *
 * The worker serves no HTTP, so it cannot be asked. It answers instead by
 * writing one key — see `WorkerHeartbeat` in `@tp/shared-types` for why this
 * is a Redis key with a TTL and not a database row — on boot and every
 * interval, and by deleting it on a clean shutdown so a stopped worker vanishes
 * at once rather than lingering for the TTL. The API reads every key under the
 * prefix into `/health/jobs`, and `verify:production` compares the build on
 * each to the commit that was deployed.
 *
 * Its own connection rather than the BullMQ one: that one is configured for
 * blocking commands (`maxRetriesPerRequest: null`) and belongs to the queues.
 * A heartbeat that could not be written must never stall a job, so every write
 * here is caught and logged and nothing is awaited by anything that matters.
 */
@Injectable()
export class HeartbeatService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(HeartbeatService.name);
  private readonly store: HeartbeatStore;
  private readonly ownsStore: boolean;
  private readonly heartbeat: Omit<WorkerHeartbeat, 'at'>;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(
    @Inject(ConfigService) config: ConfigService<WorkerEnv, true>,
    @Optional() @Inject(HEARTBEAT_STORE) store?: HeartbeatStore,
  ) {
    const assignment = workerAssignment(
      config.getOrThrow('WORKER_ROLE', { infer: true }),
      config.get('WORKER_QUEUES', { infer: true }),
    );
    this.heartbeat = {
      instance: `${hostname()}:${process.pid}`,
      build: buildMarker(),
      role: config.getOrThrow('WORKER_ROLE', { infer: true }),
      queues: assignment.processes,
      startedAt: new Date().toISOString(),
    };
    if (store === undefined) {
      this.store = new IORedis(config.getOrThrow('REDIS_URL', { infer: true }), {
        lazyConnect: true,
        // A heartbeat is not worth waiting for. Fail the write and try again
        // next interval rather than queueing writes behind a Redis that is gone.
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
      });
      this.ownsStore = true;
    } else {
      this.store = store;
      this.ownsStore = false;
    }
  }

  get key(): string {
    return workerHeartbeatKey(this.heartbeat.instance);
  }

  async onApplicationBootstrap(): Promise<void> {
    if (this.ownsStore) {
      try {
        await (this.store as IORedis).connect();
      } catch (error) {
        // Logged and carried on: the first beat below will fail the same way
        // and say so, and ioredis reconnects on its own for the ones after.
        this.logger.warn({ err: error }, 'Could not connect for the worker heartbeat');
      }
    }
    await this.beat();
    this.schedule();
    this.logger.log(`Heartbeat as ${this.heartbeat.instance}, build ${this.heartbeat.build}`);
  }

  /**
   * A self-rescheduling timeout, as the gateway's authority refresh is: the
   * next beat is armed only after the current one has finished, so a slow
   * Redis produces late beats rather than a queue of them. The TTL is three
   * intervals for exactly this — one late beat is not an absence.
   */
  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.beat().finally(() => {
        this.timer = null;
        this.schedule();
      });
    }, WORKER_HEARTBEAT_INTERVAL_MS);
    // A heartbeat must never be what keeps a process alive.
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    try {
      await this.store.del(this.key);
    } catch (error) {
      this.logger.warn({ err: error }, 'Could not withdraw the worker heartbeat; it will expire');
    }
    if (this.ownsStore) {
      (this.store as IORedis).disconnect();
    }
  }

  /** One write. Public so a test can drive it without waiting an interval. */
  async beat(at: Date = new Date()): Promise<void> {
    const payload: WorkerHeartbeat = { ...this.heartbeat, at: at.toISOString() };
    try {
      await this.store.set(this.key, JSON.stringify(payload), 'EX', WORKER_HEARTBEAT_TTL_SECONDS);
    } catch (error) {
      this.logger.warn({ err: error }, 'Could not write the worker heartbeat');
    }
  }
}
