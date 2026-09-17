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
  /**
   * Who the message is from.
   *
   * On the port rather than on each message, because it is a property of the
   * deployment and not of the mail. `EMAIL_FROM` was in the schema and in
   * `.env.example` and **read by nothing** — an operator could set their
   * sending address and it would go nowhere. Holding it here means the real
   * provider somebody writes one day cannot forget to ask for it.
   */
  constructor(readonly from: string) {}

  abstract send(message: EmailMessage): Promise<void>;
}

export const EMAIL_PORT = Symbol('EmailPort');
