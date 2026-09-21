import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import { validateEnv } from './env';
import { PrismaService } from './prisma.service';
import { QueueRegistry } from './queue-registry';
import { HeartbeatService } from './heartbeat.service';
import { SwapAccrualService } from './jobs/swap-accrual.service';
import { ReconciliationService } from './jobs/reconciliation.service';
import { ScheduleLogService } from './jobs/schedule-log.service';
import { MaintenanceService } from './jobs/maintenance.service';
import { NotificationsService } from './jobs/notifications.service';
import { BrokerHealthService } from './jobs/broker-health.service';
import { OutboxRelayService } from './jobs/outbox-relay.service';
import { WebhookDeliveryService } from './jobs/webhook-delivery.service';
import { ReportsService } from './jobs/reports.service';
import { BrokerAdapterRegistry } from '@tp/broker-sdk';
import { PushModule } from './push/push.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      envFilePath: ['.env'],
      validate: validateEnv,
    }),
    /**
     * No `redact` block, deliberately. The API's list is entirely made of
     * `req.*` and `res.*` paths, and this process is a headless application
     * context that serves no HTTP — there is no request here to redact, and
     * copying the list across would be four more rules that remove nothing.
     * `scripts/log-redaction.test.ts` pins that this stays true.
     */
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        pinoHttp: {
          level: config.get<string>('LOG_LEVEL') ?? 'info',
          transport:
            config.get<string>('NODE_ENV') === 'development'
              ? { target: 'pino-pretty', options: { singleLine: true, colorize: true } }
              : undefined,
        },
      }),
    }),
    PushModule,
  ],
  providers: [
    PrismaService,
    SwapAccrualService,
    ReconciliationService,
    ScheduleLogService,
    MaintenanceService,
    NotificationsService,
    BrokerHealthService,
    OutboxRelayService,
    WebhookDeliveryService,
    ReportsService,
    { provide: BrokerAdapterRegistry, useFactory: () => new BrokerAdapterRegistry() },
    QueueRegistry,
    HeartbeatService,
  ],
})
export class WorkerModule {}
