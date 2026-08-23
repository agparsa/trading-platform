/**
 * Outbound email.
 *
 * An interface, not an implementation: the platform must not pretend to have
 * sent an email it did not send. Wiring a real provider means implementing this
 * port and binding it in `EmailModule` — no other code changes.
 */
export interface EmailMessage {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
}

export abstract class EmailPort {
  abstract send(message: EmailMessage): Promise<void>;
}

export const EMAIL_PORT = Symbol('EmailPort');
