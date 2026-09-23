import { Injectable, Logger } from '@nestjs/common';
import { EmailPort, type EmailMessage } from './email.port';

/**
 * Development adapter: prints the message to the server log instead of sending it.
 *
 * This exists so a developer can complete the verification and password-reset
 * flows locally without an email provider. It is refused under
 * `NODE_ENV=production` at module construction — a production deployment that
 * silently logged reset links instead of delivering them would be a security
 * incident, not a convenience.
 */
@Injectable()
export class LoggingEmailAdapter extends EmailPort {
  private readonly logger = new Logger('Email');

  async send(message: EmailMessage): Promise<void> {
    this.logger.warn(
      `[DEV EMAIL — not delivered] from=${this.from} to=${message.to} ` +
        `subject="${message.subject}"\n${message.text}`,
    );
  }
}

/**
 * Null adapter: accepts and discards. Used when `EMAIL_PROVIDER=none`, so a
 * deployment can opt out explicitly rather than by accident.
 */
@Injectable()
export class NoopEmailAdapter extends EmailPort {
  private readonly logger = new Logger('Email');

  async send(message: EmailMessage): Promise<void> {
    this.logger.warn(`Email discarded (EMAIL_PROVIDER=none): from=${this.from} to=${message.to}`);
  }
}
