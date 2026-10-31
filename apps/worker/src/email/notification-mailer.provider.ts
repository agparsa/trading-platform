import { ConfigService } from '@nestjs/config';
import type { WorkerEnv } from '../env';
import {
  DisabledNotificationMailer,
  LoggingNotificationMailer,
  NotificationMailer,
  SmtpNotificationMailer,
} from './notification-mailer';

/** The mail transport this deployment's configuration names, chosen once at boot. */
export function notificationMailerFrom(config: ConfigService<WorkerEnv, true>): NotificationMailer {
  const provider = config.get('EMAIL_PROVIDER', { infer: true });
  if (provider === 'log') return new LoggingNotificationMailer();
  if (provider !== 'smtp') return new DisabledNotificationMailer();
  const user = config.get('EMAIL_SMTP_USER', { infer: true });
  const password = config.get('EMAIL_SMTP_PASSWORD', { infer: true });
  return new SmtpNotificationMailer(config.get('EMAIL_FROM', { infer: true }), {
    host: config.getOrThrow('EMAIL_SMTP_HOST', { infer: true }),
    // validateEnv has refused one half without the other.
    auth: user === undefined || password === undefined ? null : { user, password },
  });
}
