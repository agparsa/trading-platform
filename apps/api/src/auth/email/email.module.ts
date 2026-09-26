import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.schema';
import { EmailPort } from './email.port';
import { LoggingEmailAdapter, NoopEmailAdapter } from './logging-email.adapter';
import { SmtpEmailAdapter } from './smtp-email.adapter';

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
        const from = config.get('EMAIL_FROM', { infer: true });
        if (provider === 'smtp') {
          // The schema has already refused `smtp` without these three.
          return new SmtpEmailAdapter(from, {
            host: config.getOrThrow('EMAIL_SMTP_HOST', { infer: true }),
            user: config.getOrThrow('EMAIL_SMTP_USER', { infer: true }),
            password: config.getOrThrow('EMAIL_SMTP_PASSWORD', { infer: true }),
          });
        }
        return provider === 'log' ? new LoggingEmailAdapter(from) : new NoopEmailAdapter(from);
      },
    },
  ],
  exports: [EmailPort],
})
export class EmailModule {}
