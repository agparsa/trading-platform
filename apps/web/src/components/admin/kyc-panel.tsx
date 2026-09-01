'use client';

import { useEffect, useState } from 'react';
import { Button, Tabs } from '@/components/primitives';
import {
  useClaimKyc,
  useDecideKyc,
  useKycQueue,
  useKycRecord,
  useOpenKycDocument,
  useReleaseKyc,
  useRevokeKyc,
  type AdminKycDocument,
} from '@/lib/admin-queries';
import { utcTime } from '@/lib/format';
import { ErrorLine, Head, Loading, ReasonedAction, Table } from './shared';

type Tab = 'queue' | 'VERIFIED' | 'REJECTED' | 'EXPIRED';

const STATUS_TONE: Record<string, string> = {
  VERIFIED: 'text-terminal-long',
  REJECTED: 'text-terminal-short',
  EXPIRED: 'text-terminal-muted',
  PENDING: 'text-terminal-warning',
  UNDER_REVIEW: 'text-terminal-warning',
  NOT_STARTED: 'text-terminal-muted',
};

const KIND_LABELS: Record<string, string> = {
  PASSPORT: 'Passport',
  NATIONAL_ID: 'National ID',
  DRIVING_LICENCE: 'Driving licence',
  PROOF_OF_ADDRESS: 'Proof of address',
  SELFIE: 'Selfie with document',
};

/**
 * The verification queue, as a reviewer works it.
 *
 * Three capabilities meet here and the screen does not pretend otherwise. The
 * queue and every status need `kyc.read_any`; opening a document needs
 * `kyc.documents.read` and is audited on the server with the reviewer's name;
 * deciding needs `kyc.review`. A support agent with only the first sees the
 * queue and, on pressing "Open", is told their role does not include it —
 * which is the truth, and is what stops "can you check this person's ID for
 * me" from being a thing support does.
 *
 * A document is shown, never downloaded. The bytes live in an object URL for
 * exactly as long as the viewer is open, and are revoked when it closes.
 */
export function KycPanel() {
  const [tab, setTab] = useState<Tab>('queue');
  const [selected, setSelected] = useState<string | null>(null);
  const queue = useKycQueue(tab);
  const rows = queue.data?.records ?? [];

  return (
    <div className="flex flex-col">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-terminal-border px-3 py-2">
        <Tabs<Tab>
          active={tab}
          onChange={(next) => {
            setTab(next);
            setSelected(null);
          }}
          tabs={[
            { id: 'queue', label: 'Awaiting review' },
            { id: 'VERIFIED', label: 'Verified' },
            { id: 'REJECTED', label: 'Rejected' },
            { id: 'EXPIRED', label: 'Expired' },
          ]}
        />
        <span className="text-[10px] text-terminal-muted">
          {rows.length} {rows.length === 1 ? 'record' : 'records'}
        </span>
      </div>

      <ErrorLine error={queue.error} />

      {queue.isLoading ? (
        <Loading />
      ) : rows.length === 0 ? (
        <Loading>{tab === 'queue' ? 'Nobody is waiting for a decision.' : 'Nothing here.'}</Loading>
      ) : (
        <Table>
          <Head columns={['Submitted', 'Who', 'Documents', 'Status', 'Reviewer', '']} />
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className="border-t border-terminal-border/60 align-top">
                <td className="numeric px-3 py-1.5 text-terminal-muted">
                  {row.submittedAt === null ? '—' : utcTime(row.submittedAt)}
                </td>
                <td className="px-3 py-1.5 text-terminal-text">{row.email}</td>
                <td className="px-3 py-1.5 text-terminal-muted">
                  {row.documentKinds.map((kind) => KIND_LABELS[kind] ?? kind).join(', ') || '—'}
                </td>
                <td className={`px-3 py-1.5 ${STATUS_TONE[row.status] ?? 'text-terminal-text'}`}>
                  {row.status}
                </td>
                <td className="px-3 py-1.5 text-terminal-muted">
                  {row.reviewerId === null ? '—' : row.reviewerId.slice(0, 8)}
                </td>
                <td className="px-3 py-1.5 text-right">
                  <Button
                    variant="ghost"
                    className="px-2 py-0.5"
                    onClick={() => setSelected(selected === row.id ? null : row.id)}
                  >
                    {selected === row.id ? 'Close' : 'Review'}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      {selected === null ? null : <RecordReview id={selected} onDone={() => setSelected(null)} />}
    </div>
  );
}

function RecordReview({ id, onDone }: { id: string; onDone: () => void }) {
  const record = useKycRecord(id);
  const claim = useClaimKyc();
  const release = useReleaseKyc();
  const decide = useDecideKyc();
  const revoke = useRevokeKyc();
  const detail = record.data;
  const busy = claim.isPending || release.isPending || decide.isPending || revoke.isPending;
  const awaiting = detail?.status === 'PENDING' || detail?.status === 'UNDER_REVIEW';

  return (
    <div className="border-t border-terminal-border bg-terminal-raised/30 px-3 py-3">
      {record.isLoading || detail === undefined ? (
        <Loading />
      ) : (
        <div className="space-y-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <div>
              <p className="text-[10px] uppercase tracking-wider text-terminal-muted">
                Verification {detail.id.slice(0, 8)} · {detail.email}
              </p>
              <p className={`text-sm ${STATUS_TONE[detail.status] ?? 'text-terminal-text'}`}>
                {detail.status}
                {detail.reason === null ? '' : ` — ${detail.reason}`}
              </p>
              {detail.verifiedAt === null ? null : (
                <p className="text-[10px] text-terminal-muted">
                  Verified {utcTime(detail.verifiedAt)}
                  {detail.expiresAt === null ? '' : `, valid until ${utcTime(detail.expiresAt)}`}
                </p>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-1">
              {detail.status === 'PENDING' ? (
                <Button
                  variant="neutral"
                  className="px-2 py-0.5"
                  disabled={busy}
                  onClick={() => claim.mutate({ id })}
                >
                  Take this one
                </Button>
              ) : null}
              {detail.status === 'UNDER_REVIEW' ? (
                <Button
                  variant="ghost"
                  className="px-2 py-0.5"
                  disabled={busy}
                  onClick={() => release.mutate({ id })}
                >
                  Put back
                </Button>
              ) : null}
              {awaiting ? (
                <>
                  <ReasonedAction
                    label="Verify"
                    title="Which document, checked against what"
                    minLength={8}
                    busy={busy}
                    onConfirm={(reason) => decide.mutate({ id, outcome: 'VERIFIED', reason })}
                  />
                  <ReasonedAction
                    label="Reject"
                    variant="danger"
                    title="What to fix — the person is shown this"
                    minLength={8}
                    busy={busy}
                    onConfirm={(reason) => decide.mutate({ id, outcome: 'REJECTED', reason })}
                  />
                </>
              ) : null}
              {detail.status === 'VERIFIED' ? (
                <ReasonedAction
                  label="Revoke"
                  variant="danger"
                  title="Why the verification is withdrawn"
                  minLength={8}
                  busy={busy}
                  onConfirm={(reason) => revoke.mutate({ id, reason }, { onSuccess: onDone })}
                />
              ) : null}
            </div>
          </div>

          <ErrorLine error={claim.error ?? release.error ?? decide.error ?? revoke.error} />

          <div className="grid gap-2 md:grid-cols-2">
            {detail.documents.map((document) => (
              <DocumentCard key={document.id} recordId={id} document={document} />
            ))}
            {detail.documents.length === 0 ? (
              <p className="text-[11px] text-terminal-muted">No documents on this record.</p>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}

function DocumentCard({ recordId, document }: { recordId: string; document: AdminKycDocument }) {
  const open = useOpenKycDocument();
  const [url, setUrl] = useState<string | null>(null);
  const [type, setType] = useState<string>('');

  // The object URL lives as long as the viewer is open, and not a moment more.
  useEffect(() => {
    return () => {
      if (url !== null) URL.revokeObjectURL(url);
    };
  }, [url]);

  return (
    <div className="rounded border border-terminal-border/60 bg-terminal-bg p-2">
      <div className="flex flex-wrap items-center justify-between gap-1">
        <div>
          <p className="text-[11px] text-terminal-text">
            {KIND_LABELS[document.kind] ?? document.kind}
            {document.current ? (
              ''
            ) : (
              <span className="ml-1 text-[10px] text-terminal-muted">(earlier attempt)</span>
            )}
          </p>
          <p className="text-[10px] text-terminal-muted">
            {document.filename ?? 'unnamed'} · {(document.sizeBytes / 1024).toFixed(0)} KB ·{' '}
            {utcTime(document.uploadedAt)}
          </p>
        </div>
        {document.purged ? (
          <span className="text-[10px] text-terminal-muted">Purged under retention</span>
        ) : url === null ? (
          <Button
            variant="neutral"
            className="px-2 py-0.5"
            disabled={open.isPending}
            onClick={() =>
              open.mutate(
                { recordId, documentId: document.id },
                {
                  onSuccess: (blob) => {
                    setType(blob.type);
                    setUrl(URL.createObjectURL(blob));
                  },
                },
              )
            }
          >
            {open.isPending ? 'Opening…' : 'Open'}
          </Button>
        ) : (
          <Button
            variant="ghost"
            className="px-2 py-0.5"
            onClick={() => {
              URL.revokeObjectURL(url);
              setUrl(null);
            }}
          >
            Hide
          </Button>
        )}
      </div>
      <ErrorLine error={open.error} />
      {url === null ? null : type === 'application/pdf' ? (
        <iframe title={document.kind} src={url} className="mt-2 h-[32rem] w-full rounded" />
      ) : (
        // A plain <img> on purpose: next/image would try to optimise an object
        // URL through its loader, and these bytes must not leave the page.
        <img src={url} alt={document.kind} className="mt-2 max-h-[32rem] w-auto rounded" />
      )}
    </div>
  );
}
