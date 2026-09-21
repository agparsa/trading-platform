/**
 * What must never reach a log aggregator, and where it would arrive from.
 *
 * This file exists because the list it replaces was three working rules and
 * four decorative ones, and nothing told them apart. `docs/security.md`
 * published all seven as fact.
 *
 * The three that work — `authorization`, `cookie`, `set-cookie` — were measured
 * both ways: present in the log without this configuration, absent with it.
 * `logging.test.ts` keeps measuring them, because a rule that has never been
 * observed doing its job is a claim like any other.
 *
 * The four that did nothing are the interesting half. **pino-http does not
 * serialise a request body.** Its `req` serialiser emits id, method, url,
 * query, params, headers, remoteAddress and remotePort — and nothing else. So
 * `req.body.password` removed nothing, because there was nothing there to
 * remove, and the same was true of every other body path.
 *
 * They are kept, and completed, on purpose. Adding a body serialiser is the
 * single most common pino-http customisation and the natural thing to reach
 * for the first time a validation failure has to be diagnosed in production.
 * The person who does that will read this list, see four thoughtful-looking
 * entries, and conclude it was maintained. It has to *be* maintained, which is
 * what `SECRET_BODY_FIELDS` and the static check over the API's own schemas are
 * for.
 */

/**
 * Request-body field names that carry a credential.
 *
 * Checked against every zod object in `apps/api/src` by
 * `scripts/log-redaction.test.ts`, in both directions: a new field whose name
 * looks like a secret must be listed here or exempted by name with a reason,
 * and an entry here that no schema declares any more must be removed.
 */
export const SECRET_BODY_FIELDS = [
  /** Sign-in, registration, changing a password, and minting an API key. */
  'password',
  'currentPassword',
  'newPassword',
  /** A manual balance adjustment re-asks for the operator's second factor. */
  'totpCode',
  /**
   * The second factor at sign-in, and at disabling two-factor. One field for
   * both a six-digit code and a recovery code, so this name carries the
   * longer-lived of the two.
   *
   * Deliberately *not* in the audit log's `REDACTED_KEYS`, which matches on a
   * bare key at any depth and would blank every symbol code in the platform.
   * Here the path is anchored at the request body, where the only fields called
   * `code` are the three two-factor routes.
   */
  'code',
  /** Half of a sign-in: presented with the second factor to finish it. */
  'challengeToken',
  /** The longest-lived credential the platform issues. */
  'refreshToken',
  /**
   * Email verification and password reset. Possession of the reset one is
   * enough to take an account over.
   */
  'token',
  /** Registration in invite mode; audited by fingerprint, never by value. */
  'inviteCode',
  /** A bearer credential for delivering a notification to somebody's handset. */
  'pushToken',
] as const;

/**
 * Body fields whose names match the secret-shaped pattern and are not secrets.
 *
 * A name and a reason, rather than a quiet hole: an exemption nobody has to
 * justify is how a real one gets added at five o'clock.
 */
export const NOT_SECRET_BODY_FIELDS: Readonly<Record<string, string>> = {
  symbolCode: 'An instrument symbol — EURUSD. Public, and printed on the screen.',
  errorCode:
    "A push provider's own word for why it refused — UNREGISTERED, UNAVAILABLE. A filter on the delivery view, and printed on it.",
};

/**
 * The paths pino actually serialises today, and the only rules with anything to
 * remove. Each is proved to remove something by `logging.test.ts`.
 */
export const SERIALISED_SECRET_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
] as const;

/**
 * Body paths, derived rather than typed out, so the list above is the only
 * place to edit.
 */
export function secretBodyPaths(): string[] {
  return SECRET_BODY_FIELDS.map((field) => `req.body.${field}`);
}

/**
 * The `redact` block handed to pino-http.
 *
 * `remove: true` rather than a mask: a key present with the value `[Redacted]`
 * still tells a reader which requests carried one, and pino's masked form is
 * one configuration slip away from being the value itself.
 */
export function redactionOptions(): { paths: string[]; remove: true } {
  return { paths: [...SERIALISED_SECRET_PATHS, ...secretBodyPaths()], remove: true };
}

/**
 * Field names that must never appear as a **query** parameter.
 *
 * Nothing can redact one. `req.url` is logged whole, query string included,
 * and it is logged again by nginx and by every proxy in front of it. The
 * WebSocket gateway already refuses to read its token from a query parameter
 * for exactly this reason; `scripts/log-redaction.test.ts` holds the HTTP
 * routes to the same rule, so the day somebody adds `?token=` the build says
 * so rather than the log aggregator.
 */
export const SECRET_NAME_PATTERN =
  /secret|token|password|credential|passphrase|apikey|api_key|private|signature|challenge|otp|^code$|Code$/i;
