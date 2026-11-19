'use client';

import Link from 'next/link';
import { Suspense, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { DomainError } from '@tp/shared-types';
import { AuthCard, authButtonClass } from '@/components/auth-card';
import { useSession } from '@/lib/session';
import { useT } from '@/lib/use-locale';

/**
 * Where the confirmation link in the registration email lands.
 *
 * The server sent `/verify-email?token=…` from the day registration existed,
 * and no page answered it: every confirmation link was a 404. This page hands
 * the token to `POST /auth/verify-email` once and says what the server said.
 * It works signed out — the link is opened from a mail app, often on another
 * device.
 */
export default function VerifyEmailPage() {
  return (
    <Suspense>
      <VerifyEmail />
    </Suspense>
  );
}

function VerifyEmail() {
  const t = useT();
  const { api, user } = useSession();
  const token = useSearchParams().get('token') ?? '';
  const [state, setState] = useState<'working' | 'done' | 'failed'>(
    token === '' ? 'failed' : 'working',
  );
  const [message, setMessage] = useState<string | null>(null);
  // A token is single-use: React's development double-effect must not spend it twice.
  const sent = useRef(false);

  useEffect(() => {
    if (token === '' || sent.current) return;
    sent.current = true;
    api
      .post('/auth/verify-email', { token }, { idempotencyKey: crypto.randomUUID() })
      .then(() => setState('done'))
      .catch((caught: unknown) => {
        setMessage(caught instanceof DomainError ? caught.message : t('login.unreachable'));
        setState('failed');
      });
  }, [api, token, t]);

  return (
    <AuthCard lead={t('verify.lead')}>
      {state === 'working' ? (
        <p className="text-sm text-terminal-muted" role="status">
          {t('verify.working')}
        </p>
      ) : state === 'done' ? (
        <>
          <p className="text-sm text-terminal-long" role="status" data-testid="verify-done">
            {t('verify.done')}
          </p>
          <Link
            href={user === null ? '/login' : '/dashboard'}
            className={`block text-center ${authButtonClass}`}
          >
            {user === null ? t('login.signIn') : t('verify.toDashboard')}
          </Link>
        </>
      ) : (
        <>
          <p className="text-sm text-terminal-short" role="alert" data-testid="verify-failed">
            {message ?? t('verify.missing')}
          </p>
          <p className="text-caption leading-relaxed text-terminal-muted">{t('verify.again')}</p>
          <Link
            href={user === null ? '/login' : '/settings'}
            className={`block text-center ${authButtonClass}`}
          >
            {user === null ? t('login.signIn') : t('nav.settings')}
          </Link>
        </>
      )}
    </AuthCard>
  );
}
