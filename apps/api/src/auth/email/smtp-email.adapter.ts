import { Logger } from '@nestjs/common';
import { createTransport, type Transporter } from 'nodemailer';
import { EmailPort, type EmailMessage } from './email.port';

/**
 * Where to send, and as whom.
 *
 * `host` is `host:port`. Port 465 is TLS from the first byte; any other port
 * must upgrade with STARTTLS, and a server that does not offer it is refused
 * rather than spoken to in the clear — these messages carry password-reset
 * links.
 */
export interface SmtpSettings {
  readonly host: string;
  readonly user: string;
  readonly password: string;
}

/** The transport options for a setting, separated so the TLS rule can be tested. */
export function smtpTransportOptions(settings: SmtpSettings) {
  const [hostname, rawPort] = splitHost(settings.host);
  const port = Number(rawPort);
  return {
    host: hostname,
    port,
    secure: port === 465,
    requireTLS: port !== 465,
    auth: { user: settings.user, pass: settings.password },
    // A few messages an hour at most; two connections are plenty, and a pool
    // saves a TLS handshake per message.
    pool: true,
    maxConnections: 2,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  } as const;
}

function splitHost(host: string): [string, string] {
  const at = host.lastIndexOf(':');
  if (at <= 0 || at === host.length - 1) {
    throw new Error(`EMAIL_SMTP_HOST must be host:port, got "${host}"`);
  }
  return [host.slice(0, at), host.slice(at + 1)];
}

/** What the adapter needs of nodemailer: one call. */
export interface MailTransport {
  sendMail(mail: { from: string; to: string; subject: string; text: string }): Promise<unknown>;
}

/**
 * Sends the platform's email — verification, password reset, new-device
 * notices — through an SMTP server the operator names.
 *
 * **It hands the message over and returns; it does not wait for the server.**
 * Three reasons, each sufficient:
 *
 *  - The password-reset endpoint answers the same way whether or not the
 *    address is registered, so it cannot be used to find out which are. A
 *    send that took a second only for registered addresses would say it with
 *    the clock instead of the body; one that threw would say it with a 500.
 *  - A sign-in from a new device sends a notice. The trader should not wait
 *    on a mail server to be let in.
 *  - Registration has already committed when the verification mail goes. A
 *    mail server that is down must not turn a created account into an error
 *    the person retries.
 *
 * A failure is therefore logged — with the recipient's domain and the
 * server's error, never the address or the body, which is where the reset
 * token is — and counted, so it is seen rather than
 * swallowed. What this is not is a queue: a process that stops with a
 * message in flight loses it, and the person asks again.
 */
export class SmtpEmailAdapter extends EmailPort {
  private readonly logger = new Logger('Email');
  private readonly transport: MailTransport;
  private inFlight = 0;
  private failures = 0;

  constructor(from: string, settings: SmtpSettings, transport?: MailTransport) {
    super(from);
    this.transport =
      transport ??
      (createTransport(smtpTransportOptions(settings)) as Transporter as MailTransport);
  }

  async send(message: EmailMessage): Promise<void> {
    this.inFlight += 1;
    void this.transport
      .sendMail({ from: this.from, to: message.to, subject: message.subject, text: message.text })
      .catch((error: unknown) => {
        this.failures += 1;
        this.logger.error(
          {
            domain: message.to.slice(message.to.lastIndexOf('@') + 1),
            error: error instanceof Error ? error.message : String(error),
            code: (error as { code?: unknown } | null)?.code ?? null,
            failures: this.failures,
          },
          'An email could not be sent',
        );
      })
      .finally(() => {
        this.inFlight -= 1;
      });
  }

  /** For tests and for a shutdown that wants to wait: how many are still going. */
  pending(): number {
    return this.inFlight;
  }

  /** How many sends have failed since the process started. */
  failed(): number {
    return this.failures;
  }
}
