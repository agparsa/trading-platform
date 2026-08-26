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
  const { signIn, register, ready, user } = useSession();

  const [mode, setMode] = useState<'sign-in' | 'register'>('sign-in');
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
      if (mode === 'sign-in') await signIn(email.trim(), password);
      else await register(email.trim(), password, displayName.trim());
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
          {mode === 'sign-in' ? 'Sign in to your terminal.' : 'Create an account.'}
        </p>

        <form
          onSubmit={(event) => void submit(event)}
          className="mt-6 space-y-3 rounded-lg border border-terminal-border bg-terminal-surface p-5"
        >
          {mode === 'register' ? (
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

          {error === null ? null : <p className="text-[11px] text-terminal-short">{error}</p>}

          <Button type="submit" variant="neutral" disabled={busy} className="w-full py-2">
            {busy ? 'Working…' : mode === 'sign-in' ? 'Sign in' : 'Create account'}
          </Button>

          <button
            type="button"
            onClick={() => {
              setMode(mode === 'sign-in' ? 'register' : 'sign-in');
              setError(null);
            }}
            className="w-full text-center text-[11px] text-terminal-muted transition-colors hover:text-terminal-text"
          >
            {mode === 'sign-in' ? 'Need an account? Register' : 'Already registered? Sign in'}
          </button>
        </form>

        <p className="mt-4 text-center text-[10px] leading-relaxed text-terminal-muted">
          Your session is kept in a cookie this page cannot read.
        </p>
      </div>
    </main>
  );
}
