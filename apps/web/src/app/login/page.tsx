'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { DomainError } from '@tp/shared-types';
import { useSession } from '@/lib/session';
import { Button, Field, inputClass } from '@/components/primitives';
import { LanguageSettings } from '@/components/language-settings';
import { useLocale, useT } from '@/lib/use-locale';

/**
 * Sign in and registration.
 *
 * Both live on one page because the difference is one field. The form reports
 * exactly what the server said and nothing more: an invented reassurance here
 * would be a trader locked out of a position with no idea why.
 */
export default function LoginPage() {
  const router = useRouter();
  const { signIn, completeTwoFactor, register, ready, user } = useSession();
  const t = useT();
  const { locale } = useLocale();

  const [mode, setMode] = useState<'sign-in' | 'register'>('sign-in');
  /**
   * Set when the password was accepted and a code is still owed.
   *
   * Holding it in state rather than in storage is deliberate: it is worth
   * nothing without the code, and it should die with the tab.
   */
  const [challengeToken, setChallengeToken] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /**
   * The only place this page navigates away.
   *
   * Navigation belongs in an effect for the obvious reason — redirecting during
   * render is a side effect React is allowed to run twice — and it is the *only*
   * one for a less obvious one. `submit` used to call `router.replace('/')` too,
   * as soon as the sign-in promise resolved. That resolves when the profile has
   * been fetched, not when React has committed the state, so the destination
   * could mount while the session context still read `user: null` — and the
   * session gate there would bounce straight back to this page. A trader who had
   * just signed in successfully landed back on the login form.
   *
   * Waiting for `user` to actually be set removes the race rather than widening
   * the window. It reproduced roughly one sign-in in six.
   */
  useEffect(() => {
    if (ready && user !== null) router.replace('/');
  }, [ready, user, router]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (challengeToken !== null) {
        await completeTwoFactor(challengeToken, code);
      } else if (mode === 'sign-in') {
        const result = await signIn(email.trim(), password);
        if (result.kind === 'twoFactorRequired') {
          setChallengeToken(result.challengeToken);
          setBusy(false);
          return;
        }
      } else {
        await register(email.trim(), password, displayName.trim());
      }
      // No navigation here — see the effect above.
    } catch (caught) {
      setError(caught instanceof DomainError ? caught.message : t('login.unreachable'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <h1 className="text-lg font-semibold text-terminal-text">{t('shell.brand')}</h1>
        <p className="mt-1 text-xs text-terminal-muted">
          {challengeToken !== null
            ? t('login.lead.code')
            : mode === 'sign-in'
              ? t('login.lead.signIn')
              : t('login.lead.register')}
        </p>

        <form
          onSubmit={(event) => void submit(event)}
          className="mt-6 space-y-3 rounded-lg border border-terminal-border bg-terminal-surface p-5"
        >
          {challengeToken !== null ? (
            <>
              <Field label={t('login.code')}>
                <input
                  className={inputClass}
                  // `one-time-code` is what lets a phone offer the code from
                  // the notification instead of making the user switch apps.
                  autoComplete="one-time-code"
                  inputMode="text"
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                  autoFocus
                  required
                />
              </Field>
              <p className="text-label leading-relaxed text-terminal-muted">
                {t('login.codeHint')}
              </p>
            </>
          ) : mode === 'register' ? (
            <Field label={t('login.displayName')}>
              <input
                className={inputClass}
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                autoComplete="name"
                required
              />
            </Field>
          ) : null}

          {challengeToken !== null ? null : (
            <>
              <Field label={t('login.email')}>
                <input
                  className={inputClass}
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  autoComplete="email"
                  required
                />
              </Field>

              <Field label={t('login.password')}>
                <input
                  className={inputClass}
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoComplete={mode === 'sign-in' ? 'current-password' : 'new-password'}
                  required
                />
              </Field>
            </>
          )}

          {error === null ? null : (
            <p className="text-caption text-terminal-short">
              {error}
              {/* The server's own words are English; say so rather than leave a reader guessing. */}
              {locale === 'fa' ? (
                <span className="mt-1 block text-terminal-muted">{t('login.serverWords')}</span>
              ) : null}
            </p>
          )}

          <Button type="submit" variant="neutral" disabled={busy} className="w-full py-2">
            {busy
              ? t('login.working')
              : challengeToken !== null
                ? t('login.verify')
                : mode === 'sign-in'
                  ? t('login.signIn')
                  : t('login.createAccount')}
          </Button>

          <button
            type="button"
            onClick={() => {
              if (challengeToken !== null) {
                // Backing out abandons the challenge rather than hiding it. A
                // token still in memory behind a changed screen is a token.
                setChallengeToken(null);
                setCode('');
                setPassword('');
              } else {
                setMode(mode === 'sign-in' ? 'register' : 'sign-in');
              }
              setError(null);
            }}
            className="w-full text-center text-caption text-terminal-muted transition-colors hover:text-terminal-text"
          >
            {challengeToken !== null
              ? t('login.startAgain')
              : mode === 'sign-in'
                ? t('login.toRegister')
                : t('login.toSignIn')}
          </button>
        </form>

        <p className="mt-4 text-center text-label leading-relaxed text-terminal-muted">
          {t('login.cookieNote')}
        </p>
        {/* Before signing in, so a Persian reader need not find Settings in English first. */}
        <div className="mt-4 flex justify-center">
          <LanguageSettings showNote={false} />
        </div>
      </div>
    </main>
  );
}
