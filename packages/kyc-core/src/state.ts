/**
 * What an identity verification can be, and what it may become.
 *
 * ## Why these states and not a boolean
 *
 * "Verified: yes/no" loses the two states that matter operationally. A person
 * who has *submitted* and is waiting must be told so, and must not be asked to
 * submit again; and a verification that has *expired* is not the same as one
 * that was never done — the person was known once, and is being asked to prove
 * it again, which a screen should say in those words.
 */
export const KycStatus = {
  /** Nothing submitted. The default for every person. */
  NOT_STARTED: 'NOT_STARTED',
  /** Documents submitted; nobody has looked yet. */
  PENDING: 'PENDING',
  /** An operator has opened it. Distinct from PENDING so a queue shows who is being worked. */
  UNDER_REVIEW: 'UNDER_REVIEW',
  /** Accepted. The only state a withdrawal gate treats as passed. */
  VERIFIED: 'VERIFIED',
  /** Refused, with a reason the person is shown. They may submit again. */
  REJECTED: 'REJECTED',
  /** Was VERIFIED; the configured validity has run out. Must be done again. */
  EXPIRED: 'EXPIRED',
} as const;
export type KycStatus = (typeof KycStatus)[keyof typeof KycStatus];

/**
 * Every legal transition, written out.
 *
 * Two are deliberately absent. `VERIFIED → REJECTED` does not exist: a
 * verification that was accepted and is later found to be wrong is *revoked*,
 * which goes to `NOT_STARTED` with a reason and is its own audited act, not a
 * review decision made after the fact. And nothing leads *into* `EXPIRED` but
 * `VERIFIED`, because only something that was valid can run out.
 */
const NEXT: Readonly<Record<KycStatus, readonly KycStatus[]>> = {
  [KycStatus.NOT_STARTED]: [KycStatus.PENDING],
  [KycStatus.PENDING]: [KycStatus.UNDER_REVIEW, KycStatus.VERIFIED, KycStatus.REJECTED],
  [KycStatus.UNDER_REVIEW]: [KycStatus.VERIFIED, KycStatus.REJECTED, KycStatus.PENDING],
  [KycStatus.VERIFIED]: [KycStatus.EXPIRED, KycStatus.NOT_STARTED],
  [KycStatus.REJECTED]: [KycStatus.PENDING],
  [KycStatus.EXPIRED]: [KycStatus.PENDING],
};

export function canTransition(from: KycStatus, to: KycStatus): boolean {
  return NEXT[from].includes(to);
}

/** States in which a person may (re)submit documents. */
export const SUBMITTABLE: readonly KycStatus[] = [
  KycStatus.NOT_STARTED,
  KycStatus.REJECTED,
  KycStatus.EXPIRED,
];

/** States in which an operator's decision is waited on. */
export const AWAITING_DECISION: readonly KycStatus[] = [KycStatus.PENDING, KycStatus.UNDER_REVIEW];

export function isSubmittable(status: KycStatus): boolean {
  return SUBMITTABLE.includes(status);
}

export function isAwaitingDecision(status: KycStatus): boolean {
  return AWAITING_DECISION.includes(status);
}

/**
 * Whether a verification is currently good, given when it was granted.
 *
 * `validForDays` of null means it never runs out. Otherwise a verification
 * granted more than that many days ago is *not* good, whatever the stored
 * status says — the sweep that writes `EXPIRED` runs on a schedule, and a gate
 * that trusted the column between two runs would honour a verification the
 * policy says has lapsed.
 */
export function isCurrentlyVerified(
  status: KycStatus,
  verifiedAt: Date | null,
  validForDays: number | null,
  now: Date = new Date(),
): boolean {
  if (status !== KycStatus.VERIFIED) return false;
  if (validForDays === null) return true;
  if (verifiedAt === null) return false;
  return now.getTime() - verifiedAt.getTime() < validForDays * 86_400_000;
}

/**
 * The kinds of document a verification may consist of.
 *
 * A closed list rather than free text, because the review screen groups by it
 * and a retention sweep reasons about it. Adding one is a code change, which
 * is right: it is also a change to what the platform asks people to hand over.
 */
export const KycDocumentKind = {
  PASSPORT: 'PASSPORT',
  NATIONAL_ID: 'NATIONAL_ID',
  DRIVING_LICENCE: 'DRIVING_LICENCE',
  PROOF_OF_ADDRESS: 'PROOF_OF_ADDRESS',
  SELFIE: 'SELFIE',
} as const;
export type KycDocumentKind = (typeof KycDocumentKind)[keyof typeof KycDocumentKind];

/** Kinds that establish who a person is. At least one is required to submit. */
export const IDENTITY_KINDS: readonly KycDocumentKind[] = [
  KycDocumentKind.PASSPORT,
  KycDocumentKind.NATIONAL_ID,
  KycDocumentKind.DRIVING_LICENCE,
];

/**
 * What a submission must contain to be reviewable at all.
 *
 * One identity document and one selfie. Proof of address is accepted but not
 * required here: whether it is needed is a policy decision that differs by
 * jurisdiction, so it is the deployment's to demand, not this function's.
 *
 * Returns the reasons a submission falls short, so the person is told all of
 * them at once rather than one per attempt.
 */
export function submissionShortfalls(kinds: readonly KycDocumentKind[]): string[] {
  const reasons: string[] = [];
  if (!kinds.some((kind) => IDENTITY_KINDS.includes(kind))) {
    reasons.push('an identity document (passport, national ID or driving licence)');
  }
  if (!kinds.includes(KycDocumentKind.SELFIE)) {
    reasons.push('a photo of yourself holding the document');
  }
  return reasons;
}

/**
 * Content types a document may be uploaded as.
 *
 * Images and PDF, and nothing that can carry a script. The list is what the
 * review screen can *display*; a document that could not be shown to a
 * reviewer could not be reviewed.
 */
export const ACCEPTED_CONTENT_TYPES: ReadonlySet<string> = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
]);

/**
 * The largest single document. Ten megabytes covers a phone photograph of a
 * passport page at full resolution with room to spare, and is small enough that
 * a submission of five of them stays inside one request's patience.
 */
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
