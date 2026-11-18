'use client';

import Link from 'next/link';
import { use } from 'react';
import { money } from '@/lib/format';
import type { MessageKey } from '@/lib/messages';
import { useCertificate } from '@/lib/queries';
import { useT } from '@/lib/use-locale';

/**
 * A passed phase, as a page to print or show. Everything on it is the
 * server's record for the code in the address; a code with no record says so.
 */
export default function CertificatePage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = use(params);
  const t = useT();
  const cert = useCertificate(code);

  return (
    <main className="flex min-h-screen items-center justify-center bg-terminal-bg px-4 py-8">
      <div className="w-full max-w-2xl">
        {cert.isPending ? (
          <p className="text-center text-caption text-terminal-muted">{t('common.loading')}</p>
        ) : cert.isError || cert.data === undefined ? (
          <p className="text-center text-caption text-terminal-short">{t('ch.noCertificate')}</p>
        ) : (
          <article
            className="relative overflow-hidden rounded-2xl border border-terminal-accent/40 bg-terminal-surface p-8 text-center"
            data-testid="certificate"
          >
            <div
              aria-hidden
              className="pointer-events-none absolute inset-3 rounded-xl border border-terminal-accent/20"
            />
            <p className="text-label uppercase tracking-[0.3em] text-terminal-accent">
              {t('ch.cert.title')}
            </p>
            <h1 className="mt-6 text-3xl font-semibold text-terminal-text sm:text-4xl">
              {cert.data.traderName}
            </h1>
            <p className="mt-4 text-sm text-terminal-muted">
              {t('ch.cert.body', {
                phase: t(`ch.phase.${cert.data.phase}` as MessageKey),
                size: money(cert.data.accountSize, cert.data.currency),
              })}
            </p>
            <dl className="mt-8 grid grid-cols-2 gap-4 text-caption">
              <div>
                <dt className="text-terminal-muted">{t('ch.cert.issued')}</dt>
                <dd className="numeric mt-1 text-terminal-text">
                  {cert.data.issuedAt.slice(0, 10)}
                </dd>
              </div>
              <div>
                <dt className="text-terminal-muted">{t('ch.cert.code')}</dt>
                <dd className="numeric mt-1 text-terminal-text" dir="ltr">
                  {cert.data.code}
                </dd>
              </div>
            </dl>
          </article>
        )}
        <p className="mt-6 flex justify-center gap-4 text-caption print:hidden">
          <Link href="/challenges" className="text-terminal-muted hover:text-terminal-text">
            {t('ch.back')}
          </Link>
          <button
            type="button"
            onClick={() => window.print()}
            className="text-terminal-accent hover:underline"
          >
            {t('ch.print')}
          </button>
        </p>
      </div>
    </main>
  );
}
