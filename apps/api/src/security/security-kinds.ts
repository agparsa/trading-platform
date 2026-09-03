import type { SecurityEventKind, SecuritySeverity } from '@prisma/client';

/**
 * Which audit actions are somebody's security business, and how loudly.
 *
 * The feed is derived from the audit log by this table and nothing else: an
 * action not listed here is audited and not fed. Adding a kind is one line
 * here and one value in the enum; the writer in `AuditService` does the rest.
 *
 * Severity is what the feed sorts and colours by. INFO is routine and expected
 * — a sign-in, a sign-out. NOTICE is a change the person should recognise as
 * theirs — a new key, a changed password. WARNING is what an attacker leaves
 * behind — a failed sign-in, a new device, a second factor turned off.
 */
export interface SecurityKind {
  readonly kind: SecurityEventKind;
  readonly severity: SecuritySeverity;
  /**
   * Whose event it is. `resource` means the audit row's resource is the person
   * (a sign-in names the user it was for); `actor` means the person who acted
   * (a key is minted by its holder).
   */
  readonly subject: 'resource' | 'actor';
}

export const SECURITY_KINDS: Readonly<Record<string, SecurityKind>> = {
  LOGIN: { kind: 'SIGN_IN', severity: 'INFO', subject: 'resource' },
  LOGIN_FAILED: { kind: 'SIGN_IN_FAILED', severity: 'WARNING', subject: 'resource' },
  LOGIN_SECOND_FACTOR_FAILED: {
    kind: 'SECOND_FACTOR_FAILED',
    severity: 'WARNING',
    subject: 'resource',
  },
  LOGIN_FROM_NEW_DEVICE: { kind: 'SIGN_IN_NEW_DEVICE', severity: 'WARNING', subject: 'actor' },
  LOGOUT: { kind: 'SIGN_OUT', severity: 'INFO', subject: 'actor' },
  SESSION_REVOKED: { kind: 'SESSION_REVOKED', severity: 'NOTICE', subject: 'actor' },
  'user.sessions_revoked': {
    kind: 'SESSIONS_REVOKED_BY_STAFF',
    severity: 'NOTICE',
    subject: 'resource',
  },
  EMAIL_VERIFIED: { kind: 'EMAIL_VERIFIED', severity: 'INFO', subject: 'resource' },
  PASSWORD_CHANGED: { kind: 'PASSWORD_CHANGED', severity: 'NOTICE', subject: 'resource' },
  PASSWORD_RESET: { kind: 'PASSWORD_RESET', severity: 'NOTICE', subject: 'resource' },
  TWO_FACTOR_ENABLED: { kind: 'TWO_FACTOR_ENABLED', severity: 'NOTICE', subject: 'resource' },
  TWO_FACTOR_DISABLED: { kind: 'TWO_FACTOR_DISABLED', severity: 'WARNING', subject: 'resource' },
  TWO_FACTOR_RECOVERY_CODE_USED: {
    kind: 'RECOVERY_CODE_USED',
    severity: 'WARNING',
    subject: 'resource',
  },
  'api_key.minted': { kind: 'API_KEY_MINTED', severity: 'NOTICE', subject: 'actor' },
  'api_key.revoked': { kind: 'API_KEY_REVOKED', severity: 'NOTICE', subject: 'actor' },
  'service_token.minted': { kind: 'SERVICE_TOKEN_MINTED', severity: 'NOTICE', subject: 'actor' },
  'service_token.revoked': { kind: 'SERVICE_TOKEN_REVOKED', severity: 'NOTICE', subject: 'actor' },
  'user.role_assigned': { kind: 'ROLE_ASSIGNED', severity: 'NOTICE', subject: 'resource' },
  'user.suspended': { kind: 'USER_SUSPENDED', severity: 'WARNING', subject: 'resource' },
  'user.reinstated': { kind: 'USER_REINSTATED', severity: 'NOTICE', subject: 'resource' },
  'user.unlocked': { kind: 'USER_UNLOCKED', severity: 'NOTICE', subject: 'resource' },
};

/** Audit resource types that name a person. Case varies by author; the check does not. */
const PERSON_RESOURCES = new Set(['user']);

export function isPersonResource(resourceType: string): boolean {
  return PERSON_RESOURCES.has(resourceType.toLowerCase());
}
