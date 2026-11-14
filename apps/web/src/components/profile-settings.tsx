'use client';

import { useEffect, useState } from 'react';
import { useProfile, useUpdateProfile } from '@/lib/queries';
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
      <p className="text-label uppercase tracking-wider text-terminal-muted">
        {t('profile.title')}
      </p>
      <label className="block text-caption text-terminal-muted">
        {t('profile.email')}
        <input className={inputClass} value={data?.email ?? ''} readOnly disabled />
      </label>
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
