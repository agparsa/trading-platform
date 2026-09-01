'use client';

import { useCallback, useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { DomainError } from '@tp/shared-types';
import { useSession } from '@/lib/session';
import { Button, Field, inputClass } from './primitives';

interface TwoFactorStatus {
  enabled: boolean;
  enabledAt: string | null;
  pending: boolean;
  recoveryCodesRemaining: number;
}

interface EnrolmentOffer {
  secret: string;
  otpauthUri: string;
}

interface SessionSummary {
  id: string;
  device: string;
  ipAddress: string | null;
  signedInAt: string;
  lastSeenAt: string;
  current: boolean;
}

/**
 * Turning two-factor authentication on and off.
 *
 * The shape of this panel follows the shape of the server's rules rather than
 * the other way round. Enrolment is two steps because the server will not switch
 * anything on until a code has been produced, and the recovery codes appear once
 * because that is the only time the server can show them. A screen that made
 * either look optional would be lying about what happens next.
 */
export function SecuritySettings({
  presentation = 'popover',
}: {
  /** `page` drops the trigger button and renders the panel inline. */
  presentation?: 'popover' | 'page';
} = {}) {
  const { api } = useSession();
  const [open, setOpen] = useState(presentation === 'page');
  const [status, setStatus] = useState<TwoFactorStatus | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [offer, setOffer] = useState<EnrolmentOffer | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setStatus(await api.get<TwoFactorStatus>('/auth/2fa').catch(() => null));
    setSessions(await api.get<SessionSummary[]>('/auth/sessions').catch(() => null));
  }, [api]);

  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  // The QR is drawn from the URI the server produced. Building it here from the
  // parts would be a second definition of the enrolment, and the two would
  // eventually disagree.
  useEffect(() => {
    if (offer === null) {
      setQr(null);
      return;
    }
    let cancelled = false;
    void QRCode.toDataURL(offer.otpauthUri, { margin: 1, width: 176 })
      .then((url) => {
        if (!cancelled) setQr(url);
      })
      .catch(() => {
        // A missing QR is a nuisance, not a failure: the secret below it is
        // enough to finish enrolling by hand.
        if (!cancelled) setQr(null);
      });
    return () => {
      cancelled = true;
    };
  }, [offer]);

  const run = async (action: () => Promise<void>) => {
    setError(null);
    setBusy(true);
    try {
      await action();
    } catch (caught) {
      setError(caught instanceof DomainError ? caught.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  };

  const begin = () =>
    run(async () => {
      setOffer(
        await api.post<EnrolmentOffer>(
          '/auth/2fa/enrol',
          {},
          { idempotencyKey: crypto.randomUUID() },
        ),
      );
      setCode('');
    });

  const activate = () =>
    run(async () => {
      const result = await api.post<{ recoveryCodes: string[] }>(
        '/auth/2fa/activate',
        { code: code.trim() },
        { idempotencyKey: crypto.randomUUID() },
      );
      setRecoveryCodes(result.recoveryCodes);
      setOffer(null);
      setCode('');
      await refresh();
    });

  const endSession = (id: string) =>
    run(async () => {
      await api.delete(`/auth/sessions/${id}`, { idempotencyKey: crypto.randomUUID() });
      await refresh();
    });

  const disable = () =>
    run(async () => {
      await api.post(
        '/auth/2fa/disable',
        { password, code: code.trim() },
        { idempotencyKey: crypto.randomUUID() },
      );
      setPassword('');
      setCode('');
      await refresh();
    });

  const on = status?.enabled === true;

  /**
   * The panel itself, without the popover around it.
   *
   * Split out so `/security` can render it full width while the terminal keeps
   * the button it has always had. Two copies of a two-factor enrolment flow
   * would be two places to get the "shown once" rule wrong.
   */
  const body = (
    <>
      <p className="mb-2 text-[10px] uppercase tracking-wider text-terminal-muted">
        Two-factor authentication
      </p>

      {status === null ? (
        <p className="text-[11px] text-terminal-muted">Loading…</p>
      ) : recoveryCodes !== null ? (
        <div>
          <p className="text-[11px] text-terminal-text">
            Two-factor authentication is on. Save these recovery codes now — they are the only way
            back in without your phone, and they cannot be shown again.
          </p>
          <ul className="my-3 grid grid-cols-2 gap-1 rounded border border-terminal-border bg-terminal-bg p-2 font-mono text-[11px] text-terminal-text">
            {recoveryCodes.map((value) => (
              <li key={value}>{value}</li>
            ))}
          </ul>
          <Button
            variant="neutral"
            className="w-full py-1.5"
            onClick={() => setRecoveryCodes(null)}
          >
            I have saved them
          </Button>
        </div>
      ) : offer !== null ? (
        <div className="space-y-2">
          <p className="text-[11px] text-terminal-muted">
            Scan this with your authenticator app, then enter the code it shows.
          </p>
          {qr === null ? null : (
            // A plain <img>, not next/image: the source is a data URL
            // generated in the browser, so there is nothing for an image
            // optimiser to fetch or cache.
            <img
              src={qr}
              alt="Enrolment QR code"
              className="mx-auto rounded bg-white p-1"
              width={176}
              height={176}
            />
          )}
          <p className="break-all rounded border border-terminal-border bg-terminal-bg p-2 font-mono text-[10px] text-terminal-text">
            {offer.secret}
          </p>
          <Field label="Code from your app">
            <input
              className={inputClass}
              value={code}
              inputMode="numeric"
              autoComplete="one-time-code"
              onChange={(event) => setCode(event.target.value)}
            />
          </Field>
          <Button
            variant="neutral"
            className="w-full py-1.5"
            disabled={busy}
            onClick={() => void activate()}
          >
            {busy ? 'Checking…' : 'Turn on'}
          </Button>
          <button
            type="button"
            className="w-full text-center text-[10px] text-terminal-muted hover:text-terminal-text"
            onClick={() => setOffer(null)}
          >
            Cancel
          </button>
        </div>
      ) : on ? (
        <div className="space-y-2">
          <p className="text-[11px] text-terminal-text">
            On since {new Date(status.enabledAt ?? '').toLocaleDateString()}.
          </p>
          <p className="text-[10px] text-terminal-muted">
            {status.recoveryCodesRemaining} recovery{' '}
            {status.recoveryCodesRemaining === 1 ? 'code' : 'codes'} left.
          </p>
          <Field label="Password">
            <input
              className={inputClass}
              type="password"
              value={password}
              autoComplete="current-password"
              onChange={(event) => setPassword(event.target.value)}
            />
          </Field>
          <Field label="Code from your app">
            <input
              className={inputClass}
              value={code}
              autoComplete="one-time-code"
              onChange={(event) => setCode(event.target.value)}
            />
          </Field>
          <Button
            variant="danger"
            className="w-full py-1.5"
            disabled={busy || password.length === 0 || code.length === 0}
            onClick={() => void disable()}
          >
            {busy ? 'Working…' : 'Turn off'}
          </Button>
        </div>
      ) : (
        <div className="space-y-2">
          <p className="text-[11px] text-terminal-muted">
            A password alone is one stolen credential away from your positions. With this on, a
            sign-in also needs the code on your phone.
          </p>
          {status.pending ? (
            <p className="text-[10px] text-terminal-warning">
              An enrolment was started and never confirmed. Starting again replaces it.
            </p>
          ) : null}
          <Button
            variant="neutral"
            className="w-full py-1.5"
            disabled={busy}
            onClick={() => void begin()}
          >
            {busy ? 'Working…' : 'Set up'}
          </Button>
        </div>
      )}

      {error === null ? null : <p className="mt-2 text-[11px] text-terminal-short">{error}</p>}

      <p className="mb-2 mt-4 border-t border-terminal-border pt-3 text-[10px] uppercase tracking-wider text-terminal-muted">
        Where you are signed in
      </p>
      {sessions === null ? (
        <p className="text-[11px] text-terminal-muted">Loading…</p>
      ) : (
        <ul className="space-y-1.5">
          {sessions.map((session) => (
            <li key={session.id} className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate text-[11px] text-terminal-text">
                  {session.device}
                  {session.current ? (
                    <span className="ml-1 text-terminal-muted">· this device</span>
                  ) : null}
                </p>
                <p className="truncate text-[10px] text-terminal-muted">
                  {session.ipAddress ?? 'address unknown'} · since{' '}
                  {new Date(session.signedInAt).toLocaleString()}
                </p>
              </div>
              {session.current ? null : (
                <button
                  type="button"
                  className="shrink-0 text-[10px] text-terminal-muted transition-colors hover:text-terminal-short"
                  disabled={busy}
                  onClick={() => void endSession(session.id)}
                >
                  End
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <p className="mt-2 text-[10px] leading-relaxed text-terminal-muted">
        A device you do not recognise means someone else has your password. End that session, then
        change it.
      </p>
    </>
  );

  if (presentation === 'page') return body;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="rounded border border-terminal-border px-2 py-1 text-[10px] uppercase tracking-wider text-terminal-muted transition-colors hover:text-terminal-text"
        title="Account security"
      >
        Security
      </button>

      {!open ? null : (
        <div className="absolute right-0 top-8 z-30 w-80 rounded border border-terminal-border bg-terminal-surface p-3 shadow-xl">
          {body}
        </div>
      )}
    </div>
  );
}
