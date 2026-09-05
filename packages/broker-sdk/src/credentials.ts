import { createHash } from 'node:crypto';
import type { BrokerCredentialKind, BrokerCredentials } from './types';

/**
 * How a venue's credentials are stored: sealed, with only metadata outward.
 *
 * The platform holds the sealed form and opens it for the single call that
 * needs it. Nothing that leaves the server — no list, no audit row, no log
 * line — carries a field value. What leaves is the metadata below: enough
 * to say which credential this is and when it changed, nothing to use it.
 *
 * The **fingerprint** is a SHA-256 over the kind and the sorted field names
 * and values, truncated. It identifies the credential (was it rotated? is it
 * the same one as on the other connection?) without revealing it: a
 * different secret is a different fingerprint, and sixteen hex characters of
 * a hash over hundreds of bits of secret leak nothing usable.
 *
 * Sealing itself is `SecretBox` from `@tp/crypto-core`, bound to the
 * connection id as context so a sealed blob cannot be moved between rows.
 * This module only says what is sealed and what is shown.
 */
export interface BrokerCredentialMetadata {
  readonly kind: BrokerCredentialKind;
  readonly fingerprint: string;
  /** The non-secret fields, for the panel: login, server, key id — never a secret. */
  readonly visible: Readonly<Record<string, string>>;
}

/** What the sealed payload holds. Serialised as JSON before sealing. */
export interface SealedCredentialPayload {
  readonly version: 1;
  readonly kind: BrokerCredentialKind;
  readonly fields: Readonly<Record<string, string>>;
}

export function serialiseCredentials(credentials: BrokerCredentials): string {
  const payload: SealedCredentialPayload = {
    version: 1,
    kind: credentials.kind,
    fields: credentials.fields,
  };
  return JSON.stringify(payload);
}

export function deserialiseCredentials(plaintext: string): BrokerCredentials {
  const parsed = JSON.parse(plaintext) as Partial<SealedCredentialPayload>;
  if (
    parsed.version !== 1 ||
    typeof parsed.kind !== 'string' ||
    typeof parsed.fields !== 'object' ||
    parsed.fields === null
  ) {
    throw new Error('sealed credential payload is not in a form this build understands');
  }
  return { kind: parsed.kind, fields: parsed.fields as Record<string, string> };
}

export function fingerprintCredentials(credentials: BrokerCredentials): string {
  const hash = createHash('sha256');
  hash.update(credentials.kind);
  for (const key of Object.keys(credentials.fields).sort()) {
    hash.update(' ');
    hash.update(key);
    hash.update(' ');
    hash.update(credentials.fields[key] ?? '');
  }
  return hash.digest('hex').slice(0, 16);
}

/**
 * The metadata for the panel. `secretKeys` are the field names the connector
 * declared secret; every other field is shown.
 */
export function credentialMetadata(
  credentials: BrokerCredentials,
  secretKeys: ReadonlySet<string>,
): BrokerCredentialMetadata {
  const visible: Record<string, string> = {};
  for (const [key, value] of Object.entries(credentials.fields)) {
    if (!secretKeys.has(key)) visible[key] = value;
  }
  return { kind: credentials.kind, fingerprint: fingerprintCredentials(credentials), visible };
}

/**
 * Strips anything that looks like a credential from a message before it is
 * logged or stored. Belt and braces: connectors are told never to include
 * one, and this catches the one that does anyway.
 */
export function redactCredentialValues(message: string, credentials: BrokerCredentials): string {
  let out = message;
  for (const value of Object.values(credentials.fields)) {
    if (value.length >= 4) out = out.split(value).join('[redacted]');
  }
  return out;
}
