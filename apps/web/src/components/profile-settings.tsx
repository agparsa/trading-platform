'use client';

import { useEffect, useState } from 'react';
import { useProfile, useResendVerification, useUpdateProfile } from '@/lib/queries';
import { useT } from '@/lib/use-locale';
import { inputClass } from './primitives';

/**
 * The trader's name and contact number — the two profile fields they may
 * change themselves. The email is the sign-in and is shown, not edited here.
 * The number is checked by the server (international form, `+` and country
 * code); what it says is shown as it said it.
 */
export function ProfileSettings() {
  const t = useT();
  const profile = useProfile();
  const update = useUpdateProfile();
  const resend = useResendVerification();
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (profile.data === undefined) return;
    setName(profile.data.displayName);
    setPhone(profile.data.phone ?? '');
  }, [profile.data]);

  if (profile.isError) {
    return <p className="text-caption text-terminal-short">{t('profile.failed')}</p>;
  }
  const data = profile.data;
  const changed =
    data !== undefined && (name.trim() !== data.displayName || phone.trim() !== (data.phone ?? ''));

  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (data === undefined || !changed || name.trim() === '') return;
        setSaved(false);
        update.mutate(
          {
            ...(name.trim() !== data.displayName ? { displayName: name.trim() } : {}),
            ...(phone.trim() !== (data.phone ?? '')
              ? { phone: phone.trim() === '' ? null : phone.trim() }
              : {}),
          },
          { onSuccess: () => setSaved(true) },
        );
      }}
      data-testid="profile-settings"
    >
      <p className="text-sm font-semibold text-terminal-text">{t('profile.title')}</p>
      <label className="block text-caption text-terminal-muted">
        {t('profile.email')}
        <input className={inputClass} value={data?.email ?? ''} readOnly disabled />
      </label>
      {data === undefined ? null : data.emailVerified ? (
        <p className="-mt-1 text-label text-terminal-long" data-testid="email-confirmed">
          {t('profile.emailConfirmed')}
        </p>
      ) : (
        <div className="-mt-1 space-y-1" data-testid="email-pending">
          <p className="text-label leading-relaxed text-terminal-warning">
            {t('profile.emailPending')}
          </p>
          {resend.isSuccess ? (
            <p className="text-label text-terminal-long" role="status">
              {t('profile.resent')}
            </p>
          ) : (
            <button
              type="button"
              disabled={resend.isPending}
              onClick={() => resend.mutate()}
              className="text-label text-terminal-accent hover:underline disabled:opacity-50"
              data-testid="email-resend"
            >
              {resend.isPending ? t('login.working') : t('profile.resend')}
            </button>
          )}
          {resend.isError ? (
            <p className="text-label text-terminal-short" role="alert">
              {resend.error instanceof Error ? resend.error.message : t('profile.failed')}
            </p>
          ) : null}
        </div>
      )}
      <label className="block text-caption text-terminal-muted">
        {t('profile.name')}
        <input
          className={inputClass}
          value={name}
          maxLength={120}
          autoComplete="name"
          onChange={(event) => setName(event.target.value)}
          disabled={data === undefined || update.isPending}
          data-testid="profile-name"
        />
      </label>
      <label className="block text-caption text-terminal-muted">
        {t('profile.phone')}
        <input
          className={inputClass}
          value={phone}
          type="tel"
          inputMode="tel"
          dir="ltr"
          autoComplete="tel"
          placeholder="+989121234567"
          onChange={(event) => setPhone(event.target.value)}
          disabled={data === undefined || update.isPending}
          data-testid="profile-phone"
        />
      </label>
      {update.isError ? (
        <p className="text-caption text-terminal-short" role="alert">
          {update.error instanceof Error ? update.error.message : t('profile.failed')}
        </p>
      ) : saved && !changed ? (
        <p className="text-caption text-terminal-long" role="status">
          {t('profile.saved')}
        </p>
      ) : null}
      <button
        type="submit"
        disabled={!changed || name.trim() === '' || update.isPending}
        className="min-h-8 rounded bg-terminal-accent px-3 text-sm font-medium text-terminal-bg disabled:opacity-40"
        data-testid="profile-save"
      >
        {update.isPending ? t('chart.saving') : t('chart.save')}
      </button>
    </form>
  );
}
