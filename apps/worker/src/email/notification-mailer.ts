import { Logger } from '@nestjs/common';
import { createTransport } from 'nodemailer';
import { smtpTransportOptions, type SmtpSettings } from '@tp/email-core';

/**
 * Notifications by email: the channel for a trader with no screen open.
 *
 * The API sends its own mail (verification, password reset) and hands it over
 * without waiting. This one waits, because its caller writes `emailedAt` only
 * after the server has taken the message — a row marked emailed when nothing
 * was sent would be worse than the column being empty, which is what it was
 * until 29 October.
 */
export interface NotificationEmail {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
}

export abstract class NotificationMailer {
  /** False when this deployment sends no notification mail at all. */
  abstract readonly configured: boolean;
  abstract send(message: NotificationEmail): Promise<void>;
}

/** EMAIL_PROVIDER=none: nothing is sent and nothing is marked as sent. */
export class DisabledNotificationMailer extends NotificationMailer {
  readonly configured = false;
  async send(): Promise<void> {
    throw new Error('Notification email is not configured');
  }
}

/**
 * EMAIL_PROVIDER=log, for development: says that a mail would have gone, to
 * which domain, with which subject. Never the address or the body.
 */
export class LoggingNotificationMailer extends NotificationMailer {
  readonly configured = true;
  private readonly logger = new Logger('NotificationEmail');
  async send(message: NotificationEmail): Promise<void> {
    this.logger.log(
      { domain: message.to.slice(message.to.lastIndexOf('@') + 1), subject: message.subject },
      'Would email a notification',
    );
  }
}

/** What this needs of nodemailer: one call. */
export interface MailTransport {
  sendMail(mail: { from: string; to: string; subject: string; text: string }): Promise<unknown>;
}

export class SmtpNotificationMailer extends NotificationMailer {
  readonly configured = true;
  private readonly transport: MailTransport;

  constructor(
    private readonly from: string,
    settings: SmtpSettings,
    transport?: MailTransport,
  ) {
    super();
    this.transport =
      transport ?? (createTransport(smtpTransportOptions(settings)) as MailTransport);
  }

  async send(message: NotificationEmail): Promise<void> {
    await this.transport.sendMail({ from: this.from, ...message });
  }
}

/**
 * The message for one notification.
 *
 * The notification's own title and body, which the server wrote — nothing
 * here computes a figure — with the account named when there is one and a
 * link to the terminal. No token, no link that signs anyone in: a mail is
 * read on devices the platform knows nothing about.
 */
export function composeNotificationEmail(input: {
  readonly title: string;
  readonly body: string;
  readonly severity: string;
  readonly accountNumber: string | null;
  readonly appUrl: string;
}): { subject: string; text: string } {
  const subject = `${input.severity === 'CRITICAL' ? 'Action needed: ' : ''}${input.title}`;
  const lines = [
    input.body,
    '',
    ...(input.accountNumber === null ? [] : [`Account: ${input.accountNumber}`, '']),
    `Open the terminal: ${input.appUrl.replace(/\/+$/, '')}/terminal`,
    '',
    '—',
    'Turn these emails on or off in the mobile app, under Settings → By email.',
  ];
  return { subject: subject.slice(0, 200), text: lines.join('\n') };
}
