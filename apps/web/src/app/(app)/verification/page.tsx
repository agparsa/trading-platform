'use client';

import { useRef, useState } from 'react';
import { DomainError } from '@tp/shared-types';
import { AppShell } from '@/components/shell/app-shell';
import { Button, EmptyState, Panel } from '@/components/primitives';
import { utcTime } from '@/lib/format';
import { useKyc, useSubmitKyc, useUploadKycDocument, type KycDocumentRow } from '@/lib/queries';

const KIND_LABELS: Record<string, string> = {
  PASSPORT: 'Passport',
  NATIONAL_ID: 'National ID card',
  DRIVING_LICENCE: 'Driving licence',
  PROOF_OF_ADDRESS: 'Proof of address',
  SELFIE: 'Photo of you holding the document',
};

const KINDS = ['PASSPORT', 'NATIONAL_ID', 'DRIVING_LICENCE', 'SELFIE', 'PROOF_OF_ADDRESS'];

const STATUS_TEXT: Record<string, { label: string; tone: string; detail: string }> = {
  NOT_STARTED: {
    label: 'Not started',
    tone: 'text-terminal-muted',
    detail: 'Add an identity document and a photo of yourself holding it, then submit.',
  },
  PENDING: {
    label: 'Submitted, waiting for review',
    tone: 'text-terminal-warning',
    detail: 'Somebody will look at your documents. You will be told the outcome.',
  },
  UNDER_REVIEW: {
    label: 'Being reviewed',
    tone: 'text-terminal-warning',
    detail: 'A reviewer has your documents open now.',
  },
  VERIFIED: {
    label: 'Verified',
    tone: 'text-terminal-long',
    detail: 'Withdrawals are open to you.',
  },
  REJECTED: {
    label: 'Not accepted',
    tone: 'text-terminal-short',
    detail: 'See the reason below, then submit again with new documents.',
  },
  EXPIRED: {
    label: 'Expired',
    tone: 'text-terminal-short',
    detail: 'Your verification has lapsed. Submit again to renew it.',
  },
};

/**
 * Identity verification, from the person's side.
 *
 * Nothing here decides anything. The page uploads, shows what is still
 * missing, submits, and then reports what somebody else decided — and it says
 * so in those words, because a screen that implied the platform would verify
 * you on the spot would be describing a process that does not exist here.
 *
 * Documents are never shown back. The person has the originals; what they see
 * is that a document of a kind was received, its size, and when.
 */
export default function VerificationPage() {
  const kyc = useKyc();
  const upload = useUploadKycDocument();
  const submit = useSubmitKyc();
  const [kind, setKind] = useState('PASSPORT');
  const fileInput = useRef<HTMLInputElement>(null);

  const view = kyc.data;
  const status = view === undefined ? undefined : STATUS_TEXT[view.status];

  return (
    <AppShell
      title="Verification"
      description="Prove who you are once, so that withdrawals can be paid to you."
    >
      {kyc.isLoading || view === undefined ? (
        <EmptyState>Loading…</EmptyState>
      ) : (
        <div className="space-y-4">
          <Panel className="p-4">
            <p className="text-[10px] uppercase tracking-wider text-terminal-muted">Status</p>
            <p className={`mt-1 text-lg ${status?.tone ?? 'text-terminal-text'}`}>
              {status?.label ?? view.status}
            </p>
            <p className="mt-1 text-[11px] text-terminal-muted">{status?.detail}</p>
            {view.reason === null ? null : (
              <p className="mt-2 rounded bg-terminal-raised px-3 py-2 text-[11px] text-terminal-text">
                {view.reason}
              </p>
            )}
            {view.expiresAt === null ? null : (
              <p className="mt-2 text-[10px] text-terminal-muted">
                Valid until {utcTime(view.expiresAt)}.
              </p>
            )}
          </Panel>

          {view.canSubmit ? (
            <Panel className="max-w-lg space-y-3 p-4">
              <p className="text-[10px] uppercase tracking-wider text-terminal-muted">
                Add a document
              </p>
              <p className="text-[11px] leading-relaxed text-terminal-muted">
                A clear photograph or scan — JPEG, PNG, WebP or PDF, up to 10 MB. Every page of a
                passport or card that carries your name, photo or number.
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <select
                  className="rounded border border-terminal-border bg-terminal-bg px-2 py-1 text-[11px] text-terminal-text"
                  value={kind}
                  onChange={(event) => setKind(event.target.value)}
                >
                  {KINDS.map((one) => (
                    <option key={one} value={one}>
                      {KIND_LABELS[one] ?? one}
                    </option>
                  ))}
                </select>
                <input
                  ref={fileInput}
                  type="file"
                  accept="image/jpeg,image/png,image/webp,application/pdf"
                  className="text-[11px] text-terminal-muted"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file === undefined) return;
                    upload.mutate(
                      { kind, file },
                      {
                        onSettled: () => {
                          if (fileInput.current !== null) fileInput.current.value = '';
                        },
                      },
                    );
                  }}
                  disabled={upload.isPending}
                />
                {upload.isPending ? (
                  <span className="text-[11px] text-terminal-muted">Uploading…</span>
                ) : null}
              </div>
              {upload.error === null ? null : (
                <p className="text-[11px] text-terminal-negative">
                  {upload.error instanceof DomainError
                    ? upload.error.message
                    : 'The file could not be uploaded.'}
                </p>
              )}
            </Panel>
          ) : null}

          <DocumentList documents={view.documents} />

          {view.canSubmit ? (
            <Panel className="max-w-lg space-y-2 p-4">
              <p className="text-[10px] uppercase tracking-wider text-terminal-muted">Submit</p>
              {view.missing.length > 0 ? (
                <p className="text-[11px] text-terminal-muted">
                  Still needed: {view.missing.join(' and ')}.
                </p>
              ) : (
                <p className="text-[11px] text-terminal-muted">
                  Everything required is here. Submitting hands it to a reviewer; nothing more can
                  be added until they decide.
                </p>
              )}
              {submit.error === null ? null : (
                <p className="text-[11px] text-terminal-negative">
                  {submit.error instanceof DomainError
                    ? submit.error.message
                    : 'The submission did not go through.'}
                </p>
              )}
              <Button
                disabled={view.missing.length > 0 || submit.isPending}
                onClick={() => submit.mutate()}
              >
                {submit.isPending ? 'Submitting…' : 'Submit for review'}
              </Button>
            </Panel>
          ) : null}
        </div>
      )}
    </AppShell>
  );
}

function DocumentList({ documents }: { documents: readonly KycDocumentRow[] }) {
  if (documents.length === 0) return null;
  return (
    <Panel className="overflow-auto">
      <table className="w-full text-[11px]">
        <thead>
          <tr className="text-left text-[10px] uppercase tracking-wider text-terminal-muted">
            <th className="px-3 py-2">Document</th>
            <th className="px-3 py-2">File</th>
            <th className="px-3 py-2 text-right">Size</th>
            <th className="px-3 py-2">Received</th>
            <th className="px-3 py-2">Counts</th>
          </tr>
        </thead>
        <tbody>
          {documents.map((row) => (
            <tr key={row.id} className="border-t border-terminal-border/60">
              <td className="px-3 py-1.5 text-terminal-text">
                {KIND_LABELS[row.kind] ?? row.kind}
              </td>
              <td className="px-3 py-1.5 text-terminal-muted">{row.filename ?? '—'}</td>
              <td className="numeric px-3 py-1.5 text-right text-terminal-muted">
                {(row.sizeBytes / 1024).toFixed(0)} KB
              </td>
              <td className="numeric px-3 py-1.5 text-terminal-muted">{utcTime(row.uploadedAt)}</td>
              <td className="px-3 py-1.5 text-terminal-muted">
                {row.purged
                  ? 'Purged under retention'
                  : row.current
                    ? 'Yes'
                    : 'From an earlier attempt'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  );
}
