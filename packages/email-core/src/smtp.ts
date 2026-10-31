/**
 * SMTP settings and the transport options they become.
 *
 * Shared by the API (verification, password reset, new-device notices) and the
 * worker (notifications by email), so both speak to the mail server under one
 * TLS rule. Two copies would drift, and the way that failure presents is one
 * process quietly sending in the clear.
 */
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
  /**
   * The login, or `null` for a server that relays for this host by its
   * address — a mail server on the same machine that trusts the platform's
   * network. TLS is required either way; what is not sent is a password, and
   * a server that relays by address has none to check.
   */
  readonly auth: { readonly user: string; readonly password: string } | null;
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
    ...(settings.auth === null
      ? {}
      : { auth: { user: settings.auth.user, pass: settings.auth.password } }),
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
