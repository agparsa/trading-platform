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
  /**
   * `resource`, so the event lands in the *subject's* feed rather than the
   * staff member's. "Somebody looked at your account" is a thing the account
   * owner is entitled to know, and a break-glass nobody outside the room can
   * see is indistinguishable from snooping. The feed answers "what happened to
   * my account", not "what did I do".
   */
  BREAK_GLASS_OPENED: { kind: 'BREAK_GLASS_OPENED', severity: 'WARNING', subject: 'resource' },
  BREAK_GLASS_CLOSED: { kind: 'BREAK_GLASS_CLOSED', severity: 'INFO', subject: 'resource' },
  /**
   * `actor`, unlike break-glass, because an IP rule has no individual subject —
   * it is a firm-wide control. The feed it belongs in is that of the person
   * whose session made the change, and that is precisely the value: an attacker
   * holding a staff session widens the allow-list to cover their own address,
   * and the rightful holder of that session is the one person certain to see a
   * change they did not make.
   *
   * WARNING for all three, including removal. A rule taken away is a control
   * weakened, which is what an attacker does second.
   */
  /**
   * A device the account has never been seen on. WARNING, and for the same
   * reason as a sign-in from a new device: it is what somebody who has taken a
   * password does next, and it is a thing the rightful owner can recognise as
   * not theirs.
   *
   * This reaches the feed *only* for a genuinely new installation. The app
   * re-registers on every launch and those write no audit row at all, which is
   * what makes this entry worth having — a WARNING per app launch would be
   * noise the owner learns to scroll past.
   */
  DEVICE_REGISTERED: { kind: 'DEVICE_REGISTERED', severity: 'WARNING', subject: 'actor' },
  /** A device the person had revoked, back because they signed in on it again. */
  DEVICE_REVIVED: { kind: 'DEVICE_REVIVED', severity: 'WARNING', subject: 'actor' },
  DEVICE_DEACTIVATED: { kind: 'DEVICE_REVOKED', severity: 'NOTICE', subject: 'actor' },
  /**
   * Staff acted on somebody's device. `resource`, so it lands in the owner's
   * feed rather than the staff member's — the same reasoning as break-glass:
   * it is their handset and their business, and a revocation nobody outside
   * the office can see is indistinguishable from one that never happened.
   */
  'user.device_revoked': {
    kind: 'DEVICE_REVOKED_BY_STAFF',
    severity: 'NOTICE',
    subject: 'resource',
  },
  'user.device_restored': {
    kind: 'DEVICE_RESTORED_BY_STAFF',
    severity: 'NOTICE',
    subject: 'resource',
  },
  IP_RULE_CREATED: { kind: 'IP_RULE_CHANGED', severity: 'WARNING', subject: 'actor' },
  IP_RULE_ENABLED: { kind: 'IP_RULE_CHANGED', severity: 'WARNING', subject: 'actor' },
  IP_RULE_DISABLED: { kind: 'IP_RULE_CHANGED', severity: 'WARNING', subject: 'actor' },
  IP_RULE_DELETED: { kind: 'IP_RULE_CHANGED', severity: 'WARNING', subject: 'actor' },
};

/** Audit resource types that name a person. Case varies by author; the check does not. */
const PERSON_RESOURCES = new Set(['user']);

export function isPersonResource(resourceType: string): boolean {
  return PERSON_RESOURCES.has(resourceType.toLowerCase());
}
