import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { REQUEST_ID_HEADER } from '@tp/shared-types';
import { AppConfigModule } from './config/config.module';
import type { Env } from './config/env.schema';
import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './redis/redis.module';
import { HealthModule } from './health/health.module';
import { MetricsModule } from './metrics/metrics.module';

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
    PrismaModule,
    RedisModule,
    HealthModule,
    MetricsModule,
  ],
})
export class AppModule {}
