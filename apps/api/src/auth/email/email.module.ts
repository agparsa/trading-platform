import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.schema';
import { EmailPort } from './email.port';
import { LoggingEmailAdapter, NoopEmailAdapter } from './logging-email.adapter';

@Global()
@Module({
  providers: [
    {
      provide: EmailPort,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>): EmailPort => {
        const provider = config.get('EMAIL_PROVIDER', { infer: true });
        const environment = config.get('NODE_ENV', { infer: true });
        if (provider === 'log' && environment === 'production') {
          throw new Error(
            'EMAIL_PROVIDER=log writes verification and password-reset links to the server log. ' +
              'Refusing to start in production. Implement EmailPort with a real provider, or set EMAIL_PROVIDER=none.',
          );
        }
        return provider === 'log' ? new LoggingEmailAdapter() : new NoopEmailAdapter();
      },
    },
  ],
  exports: [EmailPort],
})
export class EmailModule {}
