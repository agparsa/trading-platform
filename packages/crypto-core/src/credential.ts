import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Bearer credentials that are not sessions: API keys and service tokens.
 *
 * The specification's rule, without exception: never store the raw secret;
 * hash it; store a fingerprint for identification; show the generated secret
 * exactly once. A platform that can show a user their existing API key is a
 * platform that stored it.
 *
 * ## The shape
 *
 *     tpk_h7Qm3xL2pA9k_<43 characters of secret>
 *     └┬┘ └────┬─────┘ └──────────┬──────────┘
 *    kind    handle          the secret
 *
 * The **handle** is the credential's public name. It is stored in the clear,
 * unique, and is what the platform looks the row up by — so authenticating is
 * one indexed read followed by one comparison, never a scan of every hash. It
 * is what lists and audit rows show, and it identifies the key to a human the
 * way an invitation's fingerprint does.
 *
 * The **secret** is 32 random bytes. It is never stored; its SHA-256 is. No
 * salt, deliberately: salts defend low-entropy inputs against precomputation,
 * and 256 random bits are not a low-entropy input. What matters is that a copy
 * of the table gives an attacker nothing to present.
 *
 * The **kind** prefix is what lets the guard tell a key from a token from a
 * session JWT (which begins `eyJ`) without trying each in turn, and lets a
 * secret-scanning tool recognise one in a repository, which is the reason
 * every serious API uses a prefix.
 */
export type CredentialKind = 'api_key' | 'service_token';

const PREFIX: Record<CredentialKind, string> = {
  api_key: 'tpk',
  service_token: 'tps',
};
const KIND_BY_PREFIX: Record<string, CredentialKind> = {
  tpk: 'api_key',
  tps: 'service_token',
};

/** Unambiguous when read aloud: no 0/O, 1/l/I. */
const HANDLE_ALPHABET = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const HANDLE_LENGTH = 12;
const SECRET_BYTES = 32;
/** base64url of 32 bytes, unpadded. */
const SECRET_LENGTH = 43;

const SHAPE = new RegExp(
  `^(tpk|tps)_([${HANDLE_ALPHABET}]{${HANDLE_LENGTH}})_([A-Za-z0-9_-]{${SECRET_LENGTH}})$`,
);

export interface MintedCredential {
  readonly kind: CredentialKind;
  /** The public name: `tpk_<handle>`. Stored, listed, audited. */
  readonly fingerprint: string;
  readonly handle: string;
  /** The whole bearer string. Exists here, once, and in the holder's clipboard. */
  readonly token: string;
  /** What is stored in place of the secret. */
  readonly secretHash: string;
}

export interface ParsedCredential {
  readonly kind: CredentialKind;
  readonly handle: string;
  readonly fingerprint: string;
  readonly secret: string;
}

export function mintCredential(kind: CredentialKind): MintedCredential {
  const handle = randomHandle();
  const secret = randomBytes(SECRET_BYTES).toString('base64url');
  const fingerprint = `${PREFIX[kind]}_${handle}`;
  return {
    kind,
    handle,
    fingerprint,
    token: `${fingerprint}_${secret}`,
    secretHash: hashCredentialSecret(secret),
  };
}

/**
 * Whether a bearer string is one of ours at all — the guard's first question,
 * asked before anything is looked up.
 */
export function looksLikeCredential(bearer: string): boolean {
  return bearer.startsWith('tpk_') || bearer.startsWith('tps_');
}

/** Null for anything that is not exactly the shape above. */
export function parseCredential(bearer: string): ParsedCredential | null {
  const match = SHAPE.exec(bearer);
  if (match === null) return null;
  const [, prefix, handle, secret] = match as unknown as [string, string, string, string];
  const kind = KIND_BY_PREFIX[prefix];
  if (kind === undefined) return null;
  return { kind, handle, fingerprint: `${prefix}_${handle}`, secret };
}

export function hashCredentialSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

/**
 * Constant-time, so the comparison's duration says nothing about how many
 * leading characters were right.
 */
export function credentialMatches(storedHash: string, presentedSecret: string): boolean {
  const presented = Buffer.from(hashCredentialSecret(presentedSecret), 'hex');
  const stored = Buffer.from(storedHash, 'hex');
  if (presented.length !== stored.length || stored.length === 0) return false;
  return timingSafeEqual(presented, stored);
}

function randomHandle(): string {
  let out = '';
  // Rejection sampling: 55 symbols do not divide 256, and taking `byte % 55`
  // would favour the first 36 of them.
  while (out.length < HANDLE_LENGTH) {
    for (const byte of randomBytes(HANDLE_LENGTH * 2)) {
      if (byte >= HANDLE_ALPHABET.length * 4) continue; // 220 = the largest multiple of 55 below 256
      out += HANDLE_ALPHABET[byte % HANDLE_ALPHABET.length];
      if (out.length === HANDLE_LENGTH) break;
    }
  }
  return out;
}
