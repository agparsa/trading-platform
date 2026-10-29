import { describe, expect, it } from 'vitest';
import { MAX_DOCUMENT_BYTES } from '@tp/kyc-core';
import { canSubmitNow, checkPicked, documentSlots, type KycView } from './kyc-upload';

const view = (over: Partial<KycView> = {}): KycView => ({
  status: 'NOT_STARTED',
  reason: null,
  verified: false,
  expiresAt: null,
  canSubmit: true,
  missing: ['an identity document', 'a photo of yourself'],
  documents: [],
  ...over,
});

describe('the documents offered', () => {
  it('offers every kind, marking the ones the server already holds', () => {
    const slots = documentSlots(
      view({
        documents: [
          { kind: 'PASSPORT', current: true },
          // Sent before a rejection: no longer counts, so it is offered again.
          { kind: 'SELFIE', current: false },
        ],
      }),
    );
    expect(slots.map((slot) => [slot.kind, slot.sent, slot.role])).toEqual([
      ['PASSPORT', true, 'identity'],
      ['NATIONAL_ID', false, 'identity'],
      ['DRIVING_LICENCE', false, 'identity'],
      ['SELFIE', false, 'selfie'],
      ['PROOF_OF_ADDRESS', false, 'optional'],
    ]);
  });

  it('offers nothing while the record is not taking documents', () => {
    expect(documentSlots(view({ status: 'UNDER_REVIEW', canSubmit: false }))).toEqual([]);
  });

  it('offers submit only when the server says nothing is missing', () => {
    expect(canSubmitNow(view())).toBe(false);
    expect(canSubmitNow(view({ missing: [] }))).toBe(true);
    expect(canSubmitNow(view({ missing: [], canSubmit: false }))).toBe(false);
  });
});

describe('a picked file', () => {
  it('is sent as what the picker says it is, under its own name', () => {
    expect(
      checkPicked(
        { uri: 'file:///x/IMG_0001.JPG', mimeType: 'image/jpeg', fileName: 'IMG_0001.JPG' },
        'PASSPORT',
      ),
    ).toEqual({ ok: true, contentType: 'image/jpeg', filename: 'IMG_0001.JPG' });
  });

  it('is typed from its extension when the picker does not say, and named for its kind', () => {
    expect(checkPicked({ uri: 'file:///cache/ab12.png' }, 'SELFIE')).toEqual({
      ok: true,
      contentType: 'image/png',
      filename: 'selfie.png',
    });
    expect(checkPicked({ uri: 'content://media/42', mimeType: 'image/webp' }, 'SELFIE')).toEqual({
      ok: true,
      contentType: 'image/webp',
      filename: 'selfie.webp',
    });
  });

  it('is refused on the phone when the server would refuse it', () => {
    const heic = checkPicked({ uri: 'file:///x/IMG_0002.HEIC' }, 'PASSPORT');
    expect(heic).toMatchObject({ ok: false });
    expect(heic.ok ? '' : heic.reason).toMatch(/image\/heic.*JPEG/);
    expect(checkPicked({ uri: 'content://media/43' }, 'PASSPORT')).toMatchObject({ ok: false });

    const big = checkPicked(
      { uri: 'file:///x/a.jpg', mimeType: 'image/jpeg', fileSize: MAX_DOCUMENT_BYTES + 1 },
      'PASSPORT',
    );
    expect(big.ok ? '' : big.reason).toMatch(/10\.0 MB; the most that can be sent is 10\.0 MB/);
    expect(
      checkPicked(
        { uri: 'file:///x/a.jpg', mimeType: 'image/jpeg', fileSize: MAX_DOCUMENT_BYTES },
        'PASSPORT',
      ).ok,
    ).toBe(true);
  });
});
