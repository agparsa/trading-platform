'use client';

import Link from 'next/link';
import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { DomainError } from '@tp/shared-types';
import { AuthCard, authButtonClass } from '@/components/auth-card';
import { Field, inputClass } from '@/components/primitives';
import { useSession } from '@/lib/session';
import { useT } from '@/lib/use-locale';
import { PASSWORD_MIN } from '@/lib/password';

/**
 * Where the password-reset email's link lands: a new password, twice, for
 * the token in the address. The server revokes every session on success, so
 * the page sends the person to sign in rather than pretending they are in.
 */
export default function ResetPasswordPage() {
  return (
    <Suspense>
      <ResetPassword />
    </Suspense>
  );
}

function ResetPassword() {
  const t = useT();
  const { api } = useSession();
  const token = useSearchParams().get('token') ?? '';
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  if (token === '') {
    return (
      <AuthCard lead={t('reset.lead')}>
        <p className="text-sm text-terminal-short" role="alert">
          {t('reset.missing')}
        </p>
        <Link href="/login?mode=forgot" className={`block text-center ${authButtonClass}`}>
          {t('reset.requestAgain')}
        </Link>
      </AuthCard>
    );
  }

  if (done) {
    return (
      <AuthCard lead={t('reset.lead')}>
        <p className="text-sm text-terminal-long" role="status" data-testid="reset-done">
          {t('reset.done')}
        </p>
        <Link href="/login" className={`block text-center ${authButtonClass}`}>
          {t('login.signIn')}
        </Link>
      </AuthCard>
    );
  }

  return (
    <AuthCard lead={t('reset.lead')}>
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          setError(null);
          if (password.length < PASSWORD_MIN) {
            setError(t('login.passwordShort', { min: String(PASSWORD_MIN) }));
            return;
          }
          if (password !== again) {
            setError(t('reset.mismatch'));
            return;
          }
          setBusy(true);
          api
            .post(
              '/auth/password-reset/confirm',
              { token, password },
              { idempotencyKey: crypto.randomUUID() },
            )
            .then(() => setDone(true))
            .catch((caught: unknown) =>
              setError(caught instanceof DomainError ? caught.message : t('login.unreachable')),
            )
            .finally(() => setBusy(false));
        }}
      >
        <Field label={t('reset.new')}>
          <input
            className={inputClass}
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
        </Field>
        <p className="-mt-1 text-label text-terminal-muted">
          {t('login.passwordRule', { min: String(PASSWORD_MIN) })}
        </p>
        <Field label={t('reset.again')}>
          <input
            className={inputClass}
            type="password"
            autoComplete="new-password"
            value={again}
            onChange={(event) => setAgain(event.target.value)}
            required
          />
        </Field>
        {error === null ? null : (
          <p className="text-caption text-terminal-short" role="alert">
            {error}
          </p>
        )}
        <button type="submit" disabled={busy} className={authButtonClass}>
          {busy ? t('login.working') : t('reset.submit')}
        </button>
      </form>
    </AuthCard>
  );
}
