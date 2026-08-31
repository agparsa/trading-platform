import { describe, expect, it } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from './prisma.service';

/**
 * `PrismaService`'s constructor returns a Prisma extension rather than itself,
 * so that the only client anybody can reach is the tenant-scoped one.
 *
 * That is an unusual construction and it can break silently on a Prisma
 * upgrade: the class's own members would quietly stop being reachable, and the
 * first symptom would be Nest failing to call `onModuleInit` — at boot, in
 * production, with no test having noticed.
 */
const config = new ConfigService<Record<string, unknown>, true>({
  DATABASE_TRANSACTION_TIMEOUT_MS: 15_000,
  DATABASE_TRANSACTION_MAX_WAIT_MS: 5_000,
} as never);

describe('PrismaService', () => {
  it('keeps the class members Nest and the health check depend on', () => {
    const service = new PrismaService(config as never);

    expect(typeof service.onModuleInit).toBe('function');
    expect(typeof service.onModuleDestroy).toBe('function');
    expect(typeof service.ping).toBe('function');
  });

  it('keeps the client members the application depends on', () => {
    const service = new PrismaService(config as never);

    expect(typeof service.$connect).toBe('function');
    expect(typeof service.$disconnect).toBe('function');
    expect(typeof service.$transaction).toBe('function');
    expect(typeof service.$queryRaw).toBe('function');
  });

  it('exposes the models', () => {
    const service = new PrismaService(config as never);

    expect(typeof service.user.findFirst).toBe('function');
    expect(typeof service.account.findFirst).toBe('function');
    expect(typeof service.tenant.findFirst).toBe('function');
  });
});
