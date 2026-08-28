import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { REQUEST_ID_HEADER } from '@tp/shared-types';
import { AppConfigModule } from './config/config.module';
import { RATE_LIMIT_WINDOW_MS, type Env } from './config/env.schema';
import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './redis/redis.module';
import { HealthModule } from './health/health.module';
import { MetricsModule } from './metrics/metrics.module';
import { AuditModule } from './common/audit/audit.module';
import { EmailModule } from './auth/email/email.module';
import { AuthModule } from './auth/auth.module';
import { AccountsModule } from './accounts/accounts.module';
import { UsersModule } from './users/users.module';
import { PermissionsModule } from './permissions/permissions.module';
import { MasterModule } from './master/master.module';
import { IntegrityModule } from './integrity/integrity.module';
import { OperationsModule } from './operations/operations.module';
import { MarketModule } from './market/market.module';
import { TradingModule } from './trading/trading.module';
import { IdempotencyModule } from './common/idempotency/idempotency.module';
import { EventsModule } from './realtime/events.module';
import { RealtimeModule } from './realtime/realtime.module';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { RolesGuard } from './common/guards/roles.guard';
import { PermissionsGuard } from './common/guards/permissions.guard';

@Module({
  imports: [
    AppConfigModule,
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        pinoHttp: {
          level: config.get('LOG_LEVEL', { infer: true }),
          genReqId: (req) =>
            (req.headers[REQUEST_ID_HEADER.toLowerCase()] as string) ?? randomUUID(),
          // Structured logs only. Pretty-printing is a development convenience.
          transport:
            config.get('NODE_ENV', { infer: true }) === 'development'
              ? { target: 'pino-pretty', options: { singleLine: true, colorize: true } }
              : undefined,
          // Credentials and tokens must never reach a log aggregator.
          redact: {
            paths: [
              'req.headers.authorization',
              'req.headers.cookie',
              'req.body.password',
              'req.body.currentPassword',
              'req.body.newPassword',
              'req.body.totpCode',
              'res.headers["set-cookie"]',
            ],
            remove: true,
          },
        },
      }),
    }),
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        throttlers: [
          {
            name: 'default',
            ttl: RATE_LIMIT_WINDOW_MS,
            limit: config.get('RATE_LIMIT_API_PER_MINUTE', { infer: true }),
          },
        ],
      }),
    }),
    PrismaModule,
    RedisModule,
    AuditModule,
    EmailModule,
    IdempotencyModule,
    EventsModule,
    HealthModule,
    MetricsModule,
    AuthModule,
    AccountsModule,
    UsersModule,
    PermissionsModule,
    MasterModule,
    IntegrityModule,
    OperationsModule,
    MarketModule,
    TradingModule,
    RealtimeModule,
  ],
  providers: [
    // Order matters: rate limiting runs before authentication so an unauthenticated
    // flood is rejected without a database read, and roles are checked only once
    // a user has been established.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    // After the role guard, so a route may narrow by role and by capability.
    { provide: APP_GUARD, useClass: PermissionsGuard },
  ],
})
export class AppModule {}
