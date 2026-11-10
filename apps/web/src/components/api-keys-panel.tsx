'use client';

import { useMemo, useState } from 'react';
import { DomainError, KEYABLE_PERMISSIONS } from '@tp/shared-types';
import { cn } from '@tp/ui';
import { Button, Field, inputClass, wordInputClass } from '@/components/primitives';
import { utcTime } from '@/lib/format';
import {
  useApiKeys,
  useMintApiKey,
  usePermissions,
  useRevokeApiKey,
  type ApiKeyRow,
} from '@/lib/queries';
import type { MessageKey } from '@/lib/messages';
import { useT } from '@/lib/use-locale';

const STATUS_TONE: Record<ApiKeyRow['status'], string> = {
  ACTIVE: 'text-terminal-long',
  EXPIRED: 'text-terminal-muted',
  REVOKED: 'text-terminal-short',
};

/** A key's status in words; the status itself is derived, see STATUS_TONE. */
const STATUS_WORDS: Record<ApiKeyRow['status'], MessageKey> = {
  ACTIVE: 'apikeys.status.ACTIVE',
  EXPIRED: 'apikeys.status.EXPIRED',
  REVOKED: 'apikeys.status.REVOKED',
};

/**
 * A person's API keys.
 *
 * The secret appears exactly once, in the response to minting, and lives in
 * this component's state until the person dismisses it. It is never put in
 * the query cache, so nothing that refetches can bring it back — which is
 * also the truth about the server: it does not have it either.
 *
 * The capabilities on offer are the intersection of what the person holds
 * and what a key may carry at all. The server computes the same thing and
 * refuses anything else; the list here is so the person is not offered a
 * checkbox that would only ever be refused.
 */
export function ApiKeysPanel() {
  const keys = useApiKeys();
  const permissions = usePermissions();
  const mint = useMintApiKey();
  const revoke = useRevokeApiKey();
  const [shown, setShown] = useState<{ fingerprint: string; token: string } | null>(null);
  const [name, setName] = useState('');
  const [days, setDays] = useState('90');
  const [password, setPassword] = useState('');
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [copied, setCopied] = useState(false);

  const offered = useMemo(() => {
    const held = new Set(permissions.data?.permissions ?? []);
    return KEYABLE_PERMISSIONS.filter((permission) => held.has(permission));
  }, [permissions.data]);

  const rows = keys.data?.keys ?? [];
  const live = rows.filter((row) => row.status === 'ACTIVE');
  const ended = rows.filter((row) => row.status !== 'ACTIVE');
  const t = useT();
  const canMint =
    name.trim().length > 0 && chosen.size > 0 && password.length > 0 && !mint.isPending;

  const toggle = (permission: string) => {
    setChosen((current) => {
      const next = new Set(current);
      if (next.has(permission)) next.delete(permission);
      else next.add(permission);
      return next;
    });
  };

  return (
    <div className="space-y-4">
      <div>
        <p className="text-label uppercase tracking-wider text-terminal-muted">
          {t('apikeys.title')}
        </p>
        <p className="mt-1 text-caption leading-relaxed text-terminal-muted">{t('apikeys.lead')}</p>
      </div>

      {shown === null ? null : (
        <div
          className="space-y-2 rounded border border-terminal-warning/60 bg-terminal-raised p-3"
          data-testid="api-key-secret"
        >
          <p className="text-caption text-terminal-warning">{t('apikeys.onlyOnce')}</p>
          <pre className="whitespace-pre-wrap break-all rounded bg-terminal-bg px-3 py-2 font-mono text-caption text-terminal-text">
            {shown.token}
          </pre>
          <div className="flex items-center gap-2">
            <Button
              variant="neutral"
              className="px-2 py-0.5"
              onClick={() => {
                void navigator.clipboard?.writeText(shown.token).then(() => setCopied(true));
              }}
            >
              {copied ? t('apikeys.copied') : t('apikeys.copy')}
            </Button>
            <Button
              variant="ghost"
              className="px-2 py-0.5"
              onClick={() => {
                setShown(null);
                setCopied(false);
              }}
            >
              {t('apikeys.saved')}
            </Button>
          </div>
        </div>
      )}

      <div className="space-y-3 rounded border border-terminal-border/60 p-3">
        <p className="text-label uppercase tracking-wider text-terminal-muted">
          {t('apikeys.new')}
        </p>
        <Field label={t('apikeys.name')}>
          <input
            className={wordInputClass}
            dir="auto"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={t('apikeys.namePlaceholder')}
            maxLength={100}
          />
        </Field>
        <div className="block">
          <span className="mb-1 flex items-center justify-between text-caption uppercase tracking-wider text-terminal-muted">
            {t('apikeys.capabilities')}
          </span>
          {offered.length === 0 ? (
            <p className="text-caption text-terminal-muted">{t('apikeys.nothingOffered')}</p>
          ) : (
            <div className="grid grid-cols-2 gap-1 sm:grid-cols-3">
              {offered.map((permission) => (
                <label
                  key={permission}
                  className="flex cursor-pointer items-center gap-1.5 text-caption text-terminal-text"
                >
                  <input
                    type="checkbox"
                    checked={chosen.has(permission)}
                    onChange={() => toggle(permission)}
                  />
                  <span className="font-mono">{permission}</span>
                </label>
              ))}
            </div>
          )}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('apikeys.lifetime')}>
            <input
              className={inputClass}
              inputMode="numeric"
              value={days}
              onChange={(event) => setDays(event.target.value)}
            />
          </Field>
          <Field label={t('apikeys.password')}>
            <input
              className={inputClass}
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </Field>
        </div>
        {mint.error === null ? null : (
          <p className="text-caption text-terminal-short">
            {mint.error instanceof DomainError ? mint.error.message : t('apikeys.createFailed')}
          </p>
        )}
        <Button
          disabled={!canMint}
          onClick={() =>
            mint.mutate(
              {
                name: name.trim(),
                permissions: [...chosen],
                ...(/^\d+$/.test(days.trim()) ? { expiresInDays: Number(days.trim()) } : {}),
                password,
              },
              {
                onSuccess: (result) => {
                  setShown({ fingerprint: result.key.fingerprint, token: result.token });
                  setCopied(false);
                  setName('');
                  setChosen(new Set());
                  setPassword('');
                },
                onSettled: () => setPassword(''),
              },
            )
          }
        >
          {mint.isPending ? t('apikeys.creating') : t('apikeys.create')}
        </Button>
      </div>

      {revoke.error === null ? null : (
        <p className="text-caption text-terminal-short">
          {revoke.error instanceof DomainError ? revoke.error.message : t('apikeys.revokeFailed')}
        </p>
      )}

      {keys.isLoading ? (
        <p className="text-caption text-terminal-muted">{t('common.loading')}</p>
      ) : rows.length === 0 ? (
        <p className="text-caption text-terminal-muted">{t('apikeys.none')}</p>
      ) : (
        <div className="space-y-2">
          {[...live, ...ended].map((row) => (
            <div
              key={row.id}
              className="flex flex-wrap items-start justify-between gap-2 rounded border border-terminal-border/60 px-3 py-2"
            >
              <div className="min-w-0 space-y-0.5">
                <p className="text-sm text-terminal-text">
                  {row.name}{' '}
                  <span className={cn('text-label uppercase', STATUS_TONE[row.status])}>
                    {t(STATUS_WORDS[row.status])}
                  </span>
                </p>
                <p className="font-mono text-caption text-terminal-muted">{row.fingerprint}</p>
                <p className="text-label text-terminal-muted">{row.permissions.join(', ')}</p>
                <p className="text-label text-terminal-muted">
                  {row.status === 'REVOKED'
                    ? `${t('apikeys.revokedAt', { time: utcTime(row.revokedAt ?? row.createdAt) })}${row.revokedReason === null ? '' : ` — ${row.revokedReason}`}`
                    : t('apikeys.expires', { time: utcTime(row.expiresAt) })}
                  {' · '}
                  {row.lastUsedAt === null
                    ? t('apikeys.neverUsed')
                    : row.lastUsedIp === null
                      ? t('apikeys.lastUsed', { time: utcTime(row.lastUsedAt) })
                      : t('apikeys.lastUsedFrom', {
                          time: utcTime(row.lastUsedAt),
                          ip: row.lastUsedIp,
                        })}
                  {' · '}
                  {t('apikeys.requests', { count: row.usage7d.requests })}
                  {row.usage7d.refused > 0
                    ? `, ${t('apikeys.refused', { count: row.usage7d.refused })}`
                    : ''}
                  {row.usage7d.throttled > 0
                    ? `, ${t('apikeys.throttled', { count: row.usage7d.throttled })}`
                    : ''}
                </p>
              </div>
              {row.status === 'ACTIVE' ? (
                <Button
                  variant="danger"
                  className="px-2 py-0.5"
                  disabled={revoke.isPending}
                  onClick={() => revoke.mutate({ id: row.id })}
                >
                  {t('apikeys.revoke')}
                </Button>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
