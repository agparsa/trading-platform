import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { DevicesModule } from './devices/devices.module';
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
import { LeadershipModule } from './leadership/leadership.module';
import { AlertsModule } from './alerts/alerts.module';
import { CryptoModule } from './common/crypto/crypto.module';
import { AuditModule } from './common/audit/audit.module';
import { EmailModule } from './auth/email/email.module';
import { AuthModule } from './auth/auth.module';
import { AccountsModule } from './accounts/accounts.module';
import { UsersModule } from './users/users.module';
import { PermissionsModule } from './permissions/permissions.module';
import { WalletModule } from './wallet/wallet.module';
import { PaymentsModule } from './payments/payments.module';
import { KycModule } from './kyc/kyc.module';
import { WithdrawalsModule } from './withdrawals/withdrawals.module';
import { CredentialsModule } from './credentials/credentials.module';
import { BrokersModule } from './brokers/brokers.module';
import { SecurityModule } from './security/security.module';
import { WebhooksModule } from './webhooks/webhooks.module';
import { DeveloperModule } from './developer/developer.module';
import { FeaturesModule } from './features/features.module';
import { BrokerConnectionsModule } from './broker-connections/broker-connections.module';
import { OutboxModule } from './outbox/outbox.module';
import { ChartsModule } from './charts/charts.module';
import { MasterModule } from './master/master.module';
import { IntegrityModule } from './integrity/integrity.module';
import { OperationsModule } from './operations/operations.module';
import { AdminModule } from './admin/admin.module';
import { ReconciliationModule } from './reconciliation/reconciliation.module';
import { ReportsModule } from './reports/reports.module';
import { MarketModule } from './market/market.module';
import { TradingModule } from './trading/trading.module';
import { IdempotencyModule } from './common/idempotency/idempotency.module';
import { EventsModule } from './realtime/events.module';
import { RealtimeModule } from './realtime/realtime.module';
import { PlatformMetricsModule } from './metrics/platform-metrics.module';
import { BearerAuthGuard } from './common/guards/bearer-auth.guard';
import { trackerFor } from './common/throttler-tracker';
import { IpRulesGuard } from './security/ip-rules.guard';
import { RolesGuard } from './common/guards/roles.guard';
import { PermissionsGuard } from './common/guards/permissions.guard';
import { TenancyModule } from './tenancy/tenancy.module';
import { TenantMiddleware } from './tenancy/tenant.middleware';

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
        /**
         * Bucketed on the caller's address rather than the proxy's. Without
         * this the whole platform shares one allowance behind nginx — see
         * `common/throttler-tracker.ts`.
         */
        getTracker: trackerFor(config.get('TRUSTED_PROXY_HOPS', { infer: true })),
      }),
    }),
    PrismaModule,
    TenancyModule,
    RedisModule,
    CryptoModule,
    AuditModule,
    EmailModule,
    IdempotencyModule,
    EventsModule,
    HealthModule,
    MetricsModule,
    LeadershipModule,
    AlertsModule,
    AuthModule,
    AccountsModule,
    UsersModule,
    PermissionsModule,
    WalletModule,
    PaymentsModule,
    KycModule,
    WithdrawalsModule,
    CredentialsModule,
    BrokersModule,
    SecurityModule,
    WebhooksModule,
    DeveloperModule,
    FeaturesModule,
    BrokerConnectionsModule,
    OutboxModule,
    ChartsModule,
    MasterModule,
    IntegrityModule,
    OperationsModule,
    AdminModule,
    ReconciliationModule,
    ReportsModule,
    MarketModule,
    TradingModule,
    RealtimeModule,
    DevicesModule,
    PlatformMetricsModule,
  ],
  providers: [
    // Order matters: rate limiting runs before authentication so an unauthenticated
    // flood is rejected without a database read, and roles are checked only once
    // a user has been established.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: BearerAuthGuard },
    // After authentication, because the rule set is per tenant and its scope
    // depends on whether the caller is staff. Before the role and permission
    // guards, so a caller from a refused address is turned away without the
    // platform revealing whether they would otherwise have been allowed in.
    { provide: APP_GUARD, useClass: IpRulesGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    // After the role guard, so a route may narrow by role and by capability.
    { provide: APP_GUARD, useClass: PermissionsGuard },
  ],
})
export class AppModule implements NestModule {
  /**
   * The tenant scope is opened here, before every route.
   *
   * Middleware rather than a guard, because middleware can wrap `next()`: the
   * scope then begins and ends exactly where the request does. A guard can only
   * set the scope and return, which leaves it to `AsyncLocalStorage.enterWith`
   * and to hoping the store does not outlive the request.
   *
   * `*` includes the unversioned health and metrics routes. They need no tenant
   * and reading one costs a cached lookup; excluding them would mean a list of
   * exceptions that the next unversioned route would be missing from.
   */
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(TenantMiddleware).forRoutes('*');
  }
}
