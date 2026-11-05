'use client';

import { useRef, useState } from 'react';
import { DomainError } from '@tp/shared-types';
import { AppShell } from '@/components/shell/app-shell';
import { Button, EmptyState, Panel } from '@/components/primitives';
import { utcTime } from '@/lib/format';
import type { MessageKey } from '@/lib/messages';
import { useT } from '@/lib/use-locale';
import { useKyc, useSubmitKyc, useUploadKycDocument, type KycDocumentRow } from '@/lib/queries';

const KIND_LABELS: Record<string, MessageKey> = {
  PASSPORT: 'kyc.kind.PASSPORT',
  NATIONAL_ID: 'kyc.kind.NATIONAL_ID',
  DRIVING_LICENCE: 'kyc.kind.DRIVING_LICENCE',
  PROOF_OF_ADDRESS: 'kyc.kind.PROOF_OF_ADDRESS',
  SELFIE: 'kyc.kind.SELFIE',
};

const KINDS = ['PASSPORT', 'NATIONAL_ID', 'DRIVING_LICENCE', 'SELFIE', 'PROOF_OF_ADDRESS'];

const STATUS_TEXT: Record<string, { label: MessageKey; tone: string; detail: MessageKey }> = {
  NOT_STARTED: {
    label: 'kyc.status.NOT_STARTED',
    tone: 'text-terminal-muted',
    detail: 'kyc.detail.NOT_STARTED',
  },
  PENDING: {
    label: 'kyc.status.PENDING',
    tone: 'text-terminal-warning',
    detail: 'kyc.detail.PENDING',
  },
  UNDER_REVIEW: {
    label: 'kyc.status.UNDER_REVIEW',
    tone: 'text-terminal-warning',
    detail: 'kyc.detail.UNDER_REVIEW',
  },
  VERIFIED: {
    label: 'kyc.status.VERIFIED',
    tone: 'text-terminal-long',
    detail: 'kyc.detail.VERIFIED',
  },
  REJECTED: {
    label: 'kyc.status.REJECTED',
    tone: 'text-terminal-short',
    detail: 'kyc.detail.REJECTED',
  },
  EXPIRED: {
    label: 'kyc.status.EXPIRED',
    tone: 'text-terminal-short',
    detail: 'kyc.detail.EXPIRED',
  },
};

/** A document kind in words, or its code when this page does not know it. */
function kindLabel(kind: string, t: (key: MessageKey) => string): string {
  const key = KIND_LABELS[kind];
  return key === undefined ? kind : t(key);
}

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
  const t = useT();
  const upload = useUploadKycDocument();
  const submit = useSubmitKyc();
  const [kind, setKind] = useState('PASSPORT');
  const fileInput = useRef<HTMLInputElement>(null);

  const view = kyc.data;
  const status = view === undefined ? undefined : STATUS_TEXT[view.status];

  return (
    <AppShell title={t('nav.verification')} description={t('kyc.description')}>
      {kyc.isLoading || view === undefined ? (
        <EmptyState>{t('common.loading')}</EmptyState>
      ) : (
        <div className="space-y-4">
          <Panel className="p-4">
            <p className="text-label uppercase tracking-wider text-terminal-muted">
              {t('col.status')}
            </p>
            <p className={`mt-1 text-lg ${status?.tone ?? 'text-terminal-text'}`}>
              {status === undefined ? view.status : t(status.label)}
            </p>
            <p className="mt-1 text-caption text-terminal-muted">
              {status === undefined ? null : t(status.detail)}
            </p>
            {view.reason === null ? null : (
              <p className="mt-2 rounded bg-terminal-raised px-3 py-2 text-caption text-terminal-text">
                {view.reason}
              </p>
            )}
            {view.expiresAt === null ? null : (
              <p className="mt-2 text-label text-terminal-muted">
                {t('kyc.validUntil', { time: utcTime(view.expiresAt) })}
              </p>
            )}
          </Panel>

          {view.canSubmit ? (
            <Panel className="max-w-lg space-y-3 p-4">
              <p className="text-label uppercase tracking-wider text-terminal-muted">
                {t('kyc.addDocument')}
              </p>
              <p className="text-caption leading-relaxed text-terminal-muted">
                {t('kyc.addDocument.hint')}
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <select
                  aria-label={t('kyc.documentType')}
                  className="rounded border border-terminal-border bg-terminal-bg px-2 py-1 text-caption text-terminal-text"
                  value={kind}
                  onChange={(event) => setKind(event.target.value)}
                >
                  {KINDS.map((one) => (
                    <option key={one} value={one}>
                      {kindLabel(one, t)}
                    </option>
                  ))}
                </select>
                <input
                  ref={fileInput}
                  type="file"
                  aria-label={t('kyc.chooseFile')}
                  accept="image/jpeg,image/png,image/webp,application/pdf"
                  className="text-caption text-terminal-muted"
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
                  <span className="text-caption text-terminal-muted">{t('kyc.uploading')}</span>
                ) : null}
              </div>
              {upload.error === null ? null : (
                <p className="text-caption text-terminal-short">
                  {upload.error instanceof DomainError
                    ? upload.error.message
                    : t('kyc.uploadFailed')}
                </p>
              )}
            </Panel>
          ) : null}

          <DocumentList documents={view.documents} />

          {view.canSubmit ? (
            <Panel className="max-w-lg space-y-2 p-4">
              <p className="text-label uppercase tracking-wider text-terminal-muted">
                {t('kyc.submit')}
              </p>
              {view.missing.length > 0 ? (
                <p className="text-caption text-terminal-muted">
                  {t('kyc.stillNeeded', { missing: view.missing.join(' · ') })}
                </p>
              ) : (
                <p className="text-caption text-terminal-muted">{t('kyc.readyToSubmit')}</p>
              )}
              {submit.error === null ? null : (
                <p className="text-caption text-terminal-short">
                  {submit.error instanceof DomainError
                    ? submit.error.message
                    : t('kyc.submitFailed')}
                </p>
              )}
              <Button
                disabled={view.missing.length > 0 || submit.isPending}
                onClick={() => submit.mutate()}
              >
                {submit.isPending ? t('kyc.submitting') : t('kyc.submitForReview')}
              </Button>
            </Panel>
          ) : null}
        </div>
      )}
    </AppShell>
  );
}

function DocumentList({ documents }: { documents: readonly KycDocumentRow[] }) {
  const t = useT();
  if (documents.length === 0) return null;
  return (
    <Panel className="overflow-auto">
      <table className="w-full text-caption">
        <thead>
          <tr className="text-start text-label uppercase tracking-wider text-terminal-muted">
            <th className="px-3 py-2">{t('kyc.col.document')}</th>
            <th className="px-3 py-2">{t('kyc.col.file')}</th>
            <th className="px-3 py-2 text-end">{t('kyc.col.size')}</th>
            <th className="px-3 py-2">{t('kyc.col.received')}</th>
            <th className="px-3 py-2">{t('kyc.col.counts')}</th>
          </tr>
        </thead>
        <tbody>
          {documents.map((row) => (
            <tr key={row.id} className="border-t border-terminal-border/60">
              <td className="px-3 py-1.5 text-terminal-text">{kindLabel(row.kind, t)}</td>
              <td className="px-3 py-1.5 text-terminal-muted">{row.filename ?? '—'}</td>
              <td className="numeric px-3 py-1.5 text-end text-terminal-muted">
                {(row.sizeBytes / 1024).toFixed(0)} KB
              </td>
              <td className="numeric px-3 py-1.5 text-terminal-muted">{utcTime(row.uploadedAt)}</td>
              <td className="px-3 py-1.5 text-terminal-muted">
                {row.purged
                  ? t('kyc.counts.purged')
                  : row.current
                    ? t('kyc.counts.yes')
                    : t('kyc.counts.earlier')}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  );
}
