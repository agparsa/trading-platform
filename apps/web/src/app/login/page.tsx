'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { DomainError } from '@tp/shared-types';
import { useSession } from '@/lib/session';
import { Button, Field, inputClass } from '@/components/primitives';

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

  // Navigation belongs in an effect: redirecting during render is a side effect
  // React is allowed to run twice.
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
      router.replace('/');
    } catch (caught) {
      setError(
        caught instanceof DomainError
          ? caught.message
          : 'Could not reach the API. Check that it is running.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <h1 className="text-lg font-semibold text-terminal-text">Trading Platform</h1>
        <p className="mt-1 text-xs text-terminal-muted">
          {challengeToken !== null
            ? 'Enter the code from your authenticator app.'
            : mode === 'sign-in'
              ? 'Sign in to your terminal.'
              : 'Create an account.'}
        </p>

        <form
          onSubmit={(event) => void submit(event)}
          className="mt-6 space-y-3 rounded-lg border border-terminal-border bg-terminal-surface p-5"
        >
          {challengeToken !== null ? (
            <>
              <Field label="Authentication code">
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
              <p className="text-[10px] leading-relaxed text-terminal-muted">
                Six digits from your authenticator app, or one of the recovery codes you saved.
              </p>
            </>
          ) : mode === 'register' ? (
            <Field label="Display name">
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
              <Field label="Email">
                <input
                  className={inputClass}
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  autoComplete="email"
                  required
                />
              </Field>

              <Field label="Password">
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

          {error === null ? null : <p className="text-[11px] text-terminal-short">{error}</p>}

          <Button type="submit" variant="neutral" disabled={busy} className="w-full py-2">
            {busy
              ? 'Working…'
              : challengeToken !== null
                ? 'Verify'
                : mode === 'sign-in'
                  ? 'Sign in'
                  : 'Create account'}
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
            className="w-full text-center text-[11px] text-terminal-muted transition-colors hover:text-terminal-text"
          >
            {challengeToken !== null
              ? 'Start again'
              : mode === 'sign-in'
                ? 'Need an account? Register'
                : 'Already registered? Sign in'}
          </button>
        </form>

        <p className="mt-4 text-center text-[10px] leading-relaxed text-terminal-muted">
          Your session is kept in a cookie this page cannot read.
        </p>
      </div>
    </main>
  );
}
