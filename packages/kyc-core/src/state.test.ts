import { describe, expect, it } from 'vitest';
import {
  ACCEPTED_CONTENT_TYPES,
  KycDocumentKind,
  KycStatus,
  MAX_DOCUMENT_BYTES,
  canTransition,
  isAwaitingDecision,
  isCurrentlyVerified,
  isSubmittable,
  submissionShortfalls,
} from './state';

const ALL = Object.values(KycStatus);

describe('the verification state machine', () => {
  it('starts nowhere and can only be submitted from there', () => {
    for (const to of ALL) {
      expect(canTransition(KycStatus.NOT_STARTED, to)).toBe(to === KycStatus.PENDING);
    }
  });

  it('lets a person submit again after a rejection or an expiry, and not otherwise', () => {
    expect(isSubmittable(KycStatus.NOT_STARTED)).toBe(true);
    expect(isSubmittable(KycStatus.REJECTED)).toBe(true);
    expect(isSubmittable(KycStatus.EXPIRED)).toBe(true);
    expect(isSubmittable(KycStatus.PENDING)).toBe(false);
    expect(isSubmittable(KycStatus.UNDER_REVIEW)).toBe(false);
    expect(isSubmittable(KycStatus.VERIFIED)).toBe(false);
  });

  it('never lets a verified person be rejected after the fact', () => {
    /**
     * A verification found to be wrong is *revoked*, which is its own act with
     * its own record. Allowing REJECTED here would let a review decision be
     * rewritten long after it was made, and the audit trail would show a
     * rejection with no review behind it.
     */
    expect(canTransition(KycStatus.VERIFIED, KycStatus.REJECTED)).toBe(false);
    expect(canTransition(KycStatus.VERIFIED, KycStatus.NOT_STARTED)).toBe(true);
    expect(canTransition(KycStatus.VERIFIED, KycStatus.EXPIRED)).toBe(true);
  });

  it('only lets something that was valid run out', () => {
    for (const from of ALL) {
      expect(canTransition(from, KycStatus.EXPIRED)).toBe(from === KycStatus.VERIFIED);
    }
  });

  it('lets a reviewer hand a record back to the queue', () => {
    expect(canTransition(KycStatus.UNDER_REVIEW, KycStatus.PENDING)).toBe(true);
    expect(isAwaitingDecision(KycStatus.PENDING)).toBe(true);
    expect(isAwaitingDecision(KycStatus.UNDER_REVIEW)).toBe(true);
    expect(isAwaitingDecision(KycStatus.VERIFIED)).toBe(false);
  });

  it('refuses every self-transition', () => {
    for (const status of ALL) expect(canTransition(status, status)).toBe(false);
  });
});

describe('whether a verification is good right now', () => {
  const granted = new Date('2026-01-01T00:00:00Z');

  it('is only ever true of VERIFIED', () => {
    for (const status of ALL) {
      if (status === KycStatus.VERIFIED) continue;
      expect(isCurrentlyVerified(status, granted, null)).toBe(false);
    }
  });

  it('never runs out when no validity is configured', () => {
    const decadesLater = new Date('2056-01-01T00:00:00Z');
    expect(isCurrentlyVerified(KycStatus.VERIFIED, granted, null, decadesLater)).toBe(true);
  });

  it('runs out on the configured day, whatever the column still says', () => {
    /**
     * The sweep that writes EXPIRED runs on a schedule. Between two runs the
     * column says VERIFIED and the policy says lapsed; a gate must follow the
     * policy, or a withdrawal goes through on a verification that is over.
     */
    const lastGoodInstant = new Date(granted.getTime() + 365 * 86_400_000 - 1);
    const firstBadInstant = new Date(granted.getTime() + 365 * 86_400_000);
    expect(isCurrentlyVerified(KycStatus.VERIFIED, granted, 365, lastGoodInstant)).toBe(true);
    expect(isCurrentlyVerified(KycStatus.VERIFIED, granted, 365, firstBadInstant)).toBe(false);
  });

  it('is not good when VERIFIED has no date behind it and a validity applies', () => {
    expect(isCurrentlyVerified(KycStatus.VERIFIED, null, 365)).toBe(false);
  });
});

describe('what a submission must contain', () => {
  it('needs one identity document and a selfie', () => {
    expect(submissionShortfalls([])).toHaveLength(2);
    expect(submissionShortfalls([KycDocumentKind.PASSPORT])).toEqual([
      'a photo of yourself holding the document',
    ]);
    expect(submissionShortfalls([KycDocumentKind.SELFIE])).toEqual([
      'an identity document (passport, national ID or driving licence)',
    ]);
    expect(submissionShortfalls([KycDocumentKind.NATIONAL_ID, KycDocumentKind.SELFIE])).toEqual([]);
  });

  it('does not demand proof of address, which is a jurisdiction question', () => {
    expect(submissionShortfalls([KycDocumentKind.DRIVING_LICENCE, KycDocumentKind.SELFIE])).toEqual(
      [],
    );
  });

  it('accepts images and PDF and nothing executable', () => {
    for (const type of ['image/jpeg', 'image/png', 'image/webp', 'application/pdf']) {
      expect(ACCEPTED_CONTENT_TYPES.has(type)).toBe(true);
    }
    for (const type of ['image/svg+xml', 'text/html', 'application/javascript', 'image/gif']) {
      expect(ACCEPTED_CONTENT_TYPES.has(type)).toBe(false);
    }
  });

  it('caps a document at ten megabytes', () => {
    expect(MAX_DOCUMENT_BYTES).toBe(10_485_760);
  });
});
