import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import { validateEnv } from './env';
import { PrismaService } from './prisma.service';
import { QueueRegistry } from './queue-registry';
import { SwapAccrualService } from './jobs/swap-accrual.service';
import { ReconciliationService } from './jobs/reconciliation.service';
import { MaintenanceService } from './jobs/maintenance.service';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      envFilePath: ['.env'],
      validate: validateEnv,
    }),
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
  ],
  providers: [
    PrismaService,
    SwapAccrualService,
    ReconciliationService,
    MaintenanceService,
    QueueRegistry,
  ],
})
export class WorkerModule {}
