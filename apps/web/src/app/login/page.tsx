'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { DomainError } from '@tp/shared-types';
import { useSession } from '@/lib/session';
import { Button, Field, inputClass, wordInputClass } from '@/components/primitives';
import { NavIcon } from '@/components/shell/nav-icons';
import { useLocale, useT } from '@/lib/use-locale';
import { explainError } from '@/lib/error-words';
import { PASSWORD_MIN } from '@/lib/password';

/**
 * Sign in and registration.
 *
 * Both live on one page because the difference is one field. The form reports
 * exactly what the server said and nothing more: an invented reassurance here
 * would be a trader locked out of a position with no idea why.
 */
export default function LoginPage() {
  const router = useRouter();
  const { api, signIn, completeTwoFactor, register, ready, user } = useSession();
  const t = useT();
  const { locale } = useLocale();

  const [mode, setMode] = useState<'sign-in' | 'register' | 'forgot'>('sign-in');
  const [notice, setNotice] = useState<string | null>(null);
  // `?mode=register` or `?mode=forgot` opens that form — what an emailed link
  // or a "forgot password" button elsewhere points at.
  useEffect(() => {
    const asked = new URLSearchParams(window.location.search).get('mode');
    if (asked === 'register' || asked === 'forgot') setMode(asked);
  }, []);
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
  const [inviteCode, setInviteCode] = useState('');
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
    setNotice(null);
    setBusy(true);
    try {
      if (challengeToken !== null) {
        await completeTwoFactor(challengeToken, code);
      } else if (mode === 'forgot') {
        await api.post(
          '/auth/password-reset',
          { email: email.trim() },
          { idempotencyKey: crypto.randomUUID() },
        );
        // The same words whether or not the address is registered: the server
        // will not say, and neither does this page.
        setNotice(t('login.forgotSent', { email: email.trim() }));
      } else if (mode === 'sign-in') {
        const result = await signIn(email.trim(), password);
        if (result.kind === 'twoFactorRequired') {
          setChallengeToken(result.challengeToken);
          setBusy(false);
          return;
        }
      } else {
        // Checked here as well as by the server, so the rule is read before a
        // round trip rather than after one.
        if (password.length < PASSWORD_MIN) {
          setError(t('login.passwordShort', { min: String(PASSWORD_MIN) }));
          return;
        }
        await register(email.trim(), password, displayName.trim(), inviteCode.trim());
      }
      // No navigation here — see the effect above.
    } catch (caught) {
      setError(
        caught instanceof DomainError
          ? explainError(caught.code, caught.message, locale, t)
          : t('login.unreachable'),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-[radial-gradient(ellipse_at_top,_rgb(59_130_246/0.12),_transparent_55%)] px-4 py-8">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center text-center">
          <span className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-terminal-accent text-terminal-bg shadow-lg">
            <NavIcon name="terminal" className="h-6 w-6" />
          </span>
          <h1 className="text-xl font-semibold tracking-tight text-terminal-text">
            {t('shell.brand')}
          </h1>
        </div>
        <p className="mt-1 text-center text-sm text-terminal-muted">
          {challengeToken !== null
            ? t('login.lead.code')
            : mode === 'sign-in'
              ? t('login.lead.signIn')
              : mode === 'forgot'
                ? t('login.lead.forgot')
                : t('login.lead.register')}
        </p>

        <form
          onSubmit={(event) => void submit(event)}
          className="mt-6 space-y-3 rounded-xl border border-terminal-border bg-terminal-surface p-6 shadow-xl"
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
                className={wordInputClass}
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
                  className={wordInputClass}
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  autoComplete="email"
                  required
                />
              </Field>

              {mode === 'forgot' ? null : (
                <Field label={t('login.password')}>
                  <input
                    className={inputClass}
                    type="password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    autoComplete={mode === 'sign-in' ? 'current-password' : 'new-password'}
                    minLength={mode === 'register' ? PASSWORD_MIN : undefined}
                    aria-describedby={mode === 'register' ? 'password-rule' : undefined}
                    required
                  />
                </Field>
              )}
              {mode === 'sign-in' ? (
                <button
                  type="button"
                  onClick={() => {
                    setMode('forgot');
                    setError(null);
                    setNotice(null);
                  }}
                  className="-mt-1 block text-label text-terminal-muted transition-colors hover:text-terminal-text"
                >
                  {t('login.forgot')}
                </button>
              ) : null}
              {mode === 'register' ? (
                <>
                  <p
                    id="password-rule"
                    className={
                      password.length === 0 || password.length >= PASSWORD_MIN
                        ? '-mt-1 text-label text-terminal-muted'
                        : '-mt-1 text-label text-terminal-warning'
                    }
                  >
                    {t('login.passwordRule', { min: String(PASSWORD_MIN) })}
                    {password.length > 0 ? ` · ${password.length}/${PASSWORD_MIN}` : ''}
                  </p>
                  <Field label={t('login.inviteCode')}>
                    <input
                      className={inputClass}
                      value={inviteCode}
                      onChange={(event) => setInviteCode(event.target.value)}
                      autoComplete="off"
                      spellCheck={false}
                      aria-describedby="invite-hint"
                    />
                  </Field>
                  <p id="invite-hint" className="-mt-1 text-label text-terminal-muted">
                    {t('login.inviteHint')}
                  </p>
                </>
              ) : null}
            </>
          )}

          {notice === null ? null : (
            <p className="text-caption leading-relaxed text-terminal-long" role="status">
              {notice}
            </p>
          )}
          {error === null ? null : (
            <p className="text-caption text-terminal-short" role="alert">
              {error}
              {/* The server's own words are English; say so rather than leave a reader guessing. */}
              {locale === 'fa' ? (
                <span className="mt-1 block text-terminal-muted">{t('login.serverWords')}</span>
              ) : null}
            </p>
          )}

          <Button
            type="submit"
            variant="neutral"
            disabled={busy}
            className="w-full border-transparent bg-terminal-accent py-2 font-medium text-terminal-bg hover:border-transparent hover:opacity-90"
          >
            {busy
              ? t('login.working')
              : challengeToken !== null
                ? t('login.verify')
                : mode === 'sign-in'
                  ? t('login.signIn')
                  : mode === 'forgot'
                    ? t('login.sendReset')
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
              setNotice(null);
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
      </div>
    </main>
  );
}
