'use client';

import { useMemo, useState } from 'react';
import { DomainError, KEYABLE_PERMISSIONS } from '@tp/shared-types';
import { cn } from '@tp/ui';
import { Button, Field, inputClass } from '@/components/primitives';
import { utcTime } from '@/lib/format';
import {
  useApiKeys,
  useMintApiKey,
  usePermissions,
  useRevokeApiKey,
  type ApiKeyRow,
} from '@/lib/queries';

const STATUS_TONE: Record<ApiKeyRow['status'], string> = {
  ACTIVE: 'text-terminal-long',
  EXPIRED: 'text-terminal-muted',
  REVOKED: 'text-terminal-short',
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
        <p className="text-[10px] uppercase tracking-wider text-terminal-muted">API keys</p>
        <p className="mt-1 text-[11px] leading-relaxed text-terminal-muted">
          A key lets a script act as you, with only the capabilities you give it. It can never move
          money in or out, change roles, or make more keys. Revoking one stops it at once.
        </p>
      </div>

      {shown === null ? null : (
        <div
          className="space-y-2 rounded border border-terminal-warning/60 bg-terminal-raised p-3"
          data-testid="api-key-secret"
        >
          <p className="text-[11px] text-terminal-warning">
            This is the only time the key will be shown. Copy it now; the platform does not keep it
            and cannot show it again.
          </p>
          <pre className="whitespace-pre-wrap break-all rounded bg-terminal-bg px-3 py-2 font-mono text-[11px] text-terminal-text">
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
              {copied ? 'Copied' : 'Copy'}
            </Button>
            <Button
              variant="ghost"
              className="px-2 py-0.5"
              onClick={() => {
                setShown(null);
                setCopied(false);
              }}
            >
              I have saved it
            </Button>
          </div>
        </div>
      )}

      <div className="space-y-3 rounded border border-terminal-border/60 p-3">
        <p className="text-[10px] uppercase tracking-wider text-terminal-muted">New key</p>
        <Field label="Name">
          <input
            className={inputClass}
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="What will use it — a trading bot, a spreadsheet"
            maxLength={100}
          />
        </Field>
        <div className="block">
          <span className="mb-1 flex items-center justify-between text-[11px] uppercase tracking-wider text-terminal-muted">
            Capabilities
          </span>
          {offered.length === 0 ? (
            <p className="text-[11px] text-terminal-muted">
              Nothing you hold can be carried by a key.
            </p>
          ) : (
            <div className="grid grid-cols-2 gap-1 sm:grid-cols-3">
              {offered.map((permission) => (
                <label
                  key={permission}
                  className="flex cursor-pointer items-center gap-1.5 text-[11px] text-terminal-text"
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
          <Field label="Lives for (days)">
            <input
              className={inputClass}
              inputMode="numeric"
              value={days}
              onChange={(event) => setDays(event.target.value)}
            />
          </Field>
          <Field label="Your password">
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
          <p className="text-[11px] text-terminal-negative">
            {mint.error instanceof DomainError ? mint.error.message : 'The key was not created.'}
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
          {mint.isPending ? 'Creating…' : 'Create key'}
        </Button>
      </div>

      {revoke.error === null ? null : (
        <p className="text-[11px] text-terminal-negative">
          {revoke.error instanceof DomainError ? revoke.error.message : 'The key was not revoked.'}
        </p>
      )}

      {keys.isLoading ? (
        <p className="text-[11px] text-terminal-muted">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-[11px] text-terminal-muted">You have no keys.</p>
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
                  <span className={cn('text-[10px] uppercase', STATUS_TONE[row.status])}>
                    {row.status}
                  </span>
                </p>
                <p className="font-mono text-[11px] text-terminal-muted">{row.fingerprint}</p>
                <p className="text-[10px] text-terminal-muted">{row.permissions.join(', ')}</p>
                <p className="text-[10px] text-terminal-muted">
                  {row.status === 'REVOKED'
                    ? `Revoked ${utcTime(row.revokedAt ?? row.createdAt)}${row.revokedReason === null ? '' : ` — ${row.revokedReason}`}`
                    : `Expires ${utcTime(row.expiresAt)}`}
                  {' · '}
                  {row.lastUsedAt === null
                    ? 'never used'
                    : `last used ${utcTime(row.lastUsedAt)}${row.lastUsedIp === null ? '' : ` from ${row.lastUsedIp}`}`}
                  {' · '}
                  {row.usage7d.requests} requests this week
                  {row.usage7d.refused > 0 ? `, ${row.usage7d.refused} refused` : ''}
                  {row.usage7d.throttled > 0 ? `, ${row.usage7d.throttled} throttled` : ''}
                </p>
              </div>
              {row.status === 'ACTIVE' ? (
                <Button
                  variant="danger"
                  className="px-2 py-0.5"
                  disabled={revoke.isPending}
                  onClick={() => revoke.mutate({ id: row.id })}
                >
                  Revoke
                </Button>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
