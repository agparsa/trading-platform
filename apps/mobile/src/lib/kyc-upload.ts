import {
  ACCEPTED_CONTENT_TYPES,
  IDENTITY_KINDS,
  KycDocumentKind,
  MAX_DOCUMENT_BYTES,
} from '@tp/kyc-core';

/**
 * Sending identity documents from the phone: which documents to offer, and
 * whether a picked photo can be sent at all.
 *
 * The server decides what a document is — it reads the bytes, not the label —
 * and refuses anything it does not accept, with a reason. These checks run
 * first only so that a photo that cannot pass (a 14 MB original, an iPhone
 * HEIC) is refused on the phone, in a sentence, before minutes of upload on a
 * mobile connection. Their limits are `@tp/kyc-core`'s, the same constants the
 * server enforces, so the two cannot disagree.
 */

/** What `GET /kyc` returns, as far as this screen reads it. */
export interface KycView {
  readonly status: string;
  readonly reason: string | null;
  readonly verified: boolean;
  readonly expiresAt: string | null;
  readonly canSubmit: boolean;
  readonly missing: readonly string[];
  readonly documents: ReadonlyArray<{
    readonly kind: string;
    readonly current: boolean;
  }>;
}

export interface DocumentSlot {
  readonly kind: KycDocumentKind;
  readonly label: string;
  /** Whether a current copy of this kind is already with the server. */
  readonly sent: boolean;
  /** Needed for a submission, as opposed to accepted. */
  readonly role: 'identity' | 'selfie' | 'optional';
}

const LABELS: Record<KycDocumentKind, string> = {
  PASSPORT: 'Passport',
  NATIONAL_ID: 'National ID card',
  DRIVING_LICENCE: 'Driving licence',
  SELFIE: 'Photo of you holding the document',
  PROOF_OF_ADDRESS: 'Proof of address',
};

const ORDER: readonly KycDocumentKind[] = [
  KycDocumentKind.PASSPORT,
  KycDocumentKind.NATIONAL_ID,
  KycDocumentKind.DRIVING_LICENCE,
  KycDocumentKind.SELFIE,
  KycDocumentKind.PROOF_OF_ADDRESS,
];

/**
 * The documents a person can send now. None while the record is not
 * accepting them — under review, verified — because an upload then would be
 * refused, and a button that can only fail is not offered.
 */
export function documentSlots(view: KycView): DocumentSlot[] {
  if (!view.canSubmit) return [];
  const current = new Set(view.documents.filter((doc) => doc.current).map((doc) => doc.kind));
  return ORDER.map((kind) => ({
    kind,
    label: LABELS[kind],
    sent: current.has(kind),
    role: IDENTITY_KINDS.includes(kind)
      ? 'identity'
      : kind === KycDocumentKind.SELFIE
        ? 'selfie'
        : 'optional',
  }));
}

/** Submit is offered when the server says nothing is missing. */
export function canSubmitNow(view: KycView): boolean {
  return view.canSubmit && view.missing.length === 0;
}

/** What an image picker hands back, as far as this reads it. */
export interface PickedFile {
  readonly uri: string;
  readonly mimeType?: string | null;
  readonly fileName?: string | null;
  readonly fileSize?: number | null;
}

export type CheckedFile =
  | { readonly ok: true; readonly contentType: string; readonly filename: string }
  | { readonly ok: false; readonly reason: string };

const BY_EXTENSION: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  pdf: 'application/pdf',
  heic: 'image/heic',
  heif: 'image/heif',
};

const EXTENSION_OF: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
};

function extensionOf(name: string): string | null {
  const match = /\.([a-z0-9]+)$/i.exec(name.split('?')[0] ?? '');
  return match === null ? null : match[1]!.toLowerCase();
}

export function checkPicked(file: PickedFile, kind: KycDocumentKind): CheckedFile {
  const named = file.fileName ?? file.uri;
  const extension = extensionOf(named);
  const contentType = (
    file.mimeType ??
    (extension === null ? undefined : BY_EXTENSION[extension]) ??
    ''
  ).toLowerCase();

  if (!ACCEPTED_CONTENT_TYPES.has(contentType)) {
    return {
      ok: false,
      reason:
        contentType === ''
          ? 'This file’s type could not be told. Send a JPEG, PNG, WebP or PDF.'
          : `A ${contentType} file cannot be sent. Send a JPEG, PNG, WebP or PDF — taking the photo again from here sends a JPEG.`,
    };
  }
  if (file.fileSize != null && file.fileSize > MAX_DOCUMENT_BYTES) {
    const mb = (size: number) => (size / (1024 * 1024)).toFixed(1);
    return {
      ok: false,
      reason: `This file is ${mb(file.fileSize)} MB; the most that can be sent is ${mb(MAX_DOCUMENT_BYTES)} MB.`,
    };
  }
  const filename =
    file.fileName != null && file.fileName.trim() !== ''
      ? file.fileName.trim()
      : `${kind.toLowerCase()}.${EXTENSION_OF[contentType] ?? 'bin'}`;
  return { ok: true, contentType, filename };
}
