'use client';

import { useState } from 'react';
import { DomainError, SERVICE_GRANTABLE_PERMISSIONS } from '@tp/shared-types';
import { cn } from '@tp/ui';
import { Button, Field, Tabs, inputClass } from '@/components/primitives';
import {
  useAdminApiKeys,
  useMintServiceToken,
  useRevokeAnyApiKey,
  useRevokeServiceToken,
  useServiceTokens,
  type AdminApiKeyRow,
  type ServiceTokenRow,
} from '@/lib/admin-queries';
import { usePermissions } from '@/lib/queries';
import { utcTime } from '@/lib/format';
import { ErrorLine, Head, Loading, ReasonedAction, SearchBox, Table } from './shared';

type Tab = 'keys' | 'tokens';

const STATUS_TONE: Record<string, string> = {
  ACTIVE: 'text-terminal-long',
  EXPIRED: 'text-terminal-muted',
  REVOKED: 'text-terminal-short',
};

/**
 * Every credential in the tenant.
 *
 * Two kinds, two tabs. Keys belong to people: staff see who holds what and
 * can end one, and the holder is told why. Service tokens belong to the
 * firm: an administrator mints them for an integration, with reads across
 * the tenant and nothing else, and the secret is shown once here and kept
 * nowhere — the same rule as everywhere else on the platform.
 */
export function CredentialsPanel() {
  const [tab, setTab] = useState<Tab>('keys');
  return (
    <div className="flex flex-col">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-terminal-border px-3 py-2">
        <Tabs<Tab>
          active={tab}
          onChange={setTab}
          tabs={[
            { id: 'keys', label: "People's keys" },
            { id: 'tokens', label: 'Service tokens' },
          ]}
        />
      </div>
      {tab === 'keys' ? <KeysTab /> : <TokensTab />}
    </div>
  );
}

function usageText(row: { usage7d: { requests: number; refused: number; throttled: number } }) {
  const { requests, refused, throttled } = row.usage7d;
  return `${requests}${refused > 0 ? ` · ${refused} refused` : ''}${throttled > 0 ? ` · ${throttled} throttled` : ''}`;
}

function lastUse(row: { lastUsedAt: string | null; lastUsedIp: string | null }) {
  if (row.lastUsedAt === null) return 'never';
  return `${utcTime(row.lastUsedAt)}${row.lastUsedIp === null ? '' : ` · ${row.lastUsedIp}`}`;
}

function KeysTab() {
  const [search, setSearch] = useState('');
  const list = useAdminApiKeys(search);
  const revoke = useRevokeAnyApiKey();
  const permissions = usePermissions();
  const mayRevoke = permissions.data?.permissions.includes('api_keys.revoke_any') ?? false;
  const rows = list.data?.keys ?? [];

  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between gap-2 px-3 py-2">
        <SearchBox value={search} onChange={setSearch} placeholder="Holder, name or fingerprint" />
        <span className="text-[10px] text-terminal-muted">
          {rows.length} {rows.length === 1 ? 'key' : 'keys'}
        </span>
      </div>
      <ErrorLine error={list.error ?? revoke.error} />
      {list.isLoading ? (
        <Loading />
      ) : rows.length === 0 ? (
        <Loading>Nobody holds a key.</Loading>
      ) : (
        <Table>
          <Head columns={['Holder', 'Key', 'Carries', 'Status', 'Last use', 'This week', '']} />
          <tbody>
            {rows.map((row: AdminApiKeyRow) => (
              <tr key={row.id} className="border-t border-terminal-border/60 align-top">
                <td className="px-3 py-1.5 text-terminal-text">{row.email}</td>
                <td className="px-3 py-1.5">
                  <p className="text-terminal-text">{row.name}</p>
                  <p className="font-mono text-[10px] text-terminal-muted">{row.fingerprint}</p>
                </td>
                <td className="px-3 py-1.5 font-mono text-[10px] text-terminal-muted">
                  {row.permissions.join(', ')}
                </td>
                <td className={cn('px-3 py-1.5', STATUS_TONE[row.status])}>
                  {row.status}
                  {row.revokedReason === null ? null : (
                    <p className="text-[10px] text-terminal-muted">{row.revokedReason}</p>
                  )}
                </td>
                <td className="numeric px-3 py-1.5 text-terminal-muted">{lastUse(row)}</td>
                <td className="numeric px-3 py-1.5 text-terminal-muted">{usageText(row)}</td>
                <td className="px-3 py-1.5 text-right">
                  {row.status === 'ACTIVE' && mayRevoke ? (
                    <ReasonedAction
                      label="Revoke"
                      variant="danger"
                      title="Why — the holder is told this"
                      minLength={8}
                      busy={revoke.isPending}
                      onConfirm={(reason) => revoke.mutate({ id: row.id, reason })}
                    />
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}

function TokensTab() {
  const list = useServiceTokens();
  const mint = useMintServiceToken();
  const revoke = useRevokeServiceToken();
  const [shown, setShown] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [days, setDays] = useState('365');
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const rows = list.data?.tokens ?? [];

  const toggle = (permission: string) => {
    setChosen((current) => {
      const next = new Set(current);
      if (next.has(permission)) next.delete(permission);
      else next.add(permission);
      return next;
    });
  };

  return (
    <div className="flex flex-col">
      <div className="space-y-3 border-b border-terminal-border px-3 py-3">
        <p className="text-[10px] uppercase tracking-wider text-terminal-muted">
          New service token
        </p>
        <p className="text-[11px] leading-relaxed text-terminal-muted">
          A machine identity for an integration. It reads across every account and writes nothing —
          every write on this platform is a person&apos;s, and a token is not one.
        </p>
        {shown === null ? null : (
          <div
            className="space-y-2 rounded border border-terminal-warning/60 bg-terminal-raised p-3"
            data-testid="service-token-secret"
          >
            <p className="text-[11px] text-terminal-warning">
              Shown once. Put it in the integration&apos;s secret store now; it cannot be shown
              again.
            </p>
            <pre className="whitespace-pre-wrap break-all rounded bg-terminal-bg px-3 py-2 font-mono text-[11px] text-terminal-text">
              {shown}
            </pre>
            <Button variant="ghost" className="px-2 py-0.5" onClick={() => setShown(null)}>
              I have saved it
            </Button>
          </div>
        )}
        <div className="grid gap-3 md:grid-cols-2">
          <Field label="Name">
            <input
              className={inputClass}
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="The integration this is for"
              maxLength={100}
            />
          </Field>
          <Field label="Lives for (days)">
            <input
              className={inputClass}
              inputMode="numeric"
              value={days}
              onChange={(event) => setDays(event.target.value)}
            />
          </Field>
        </div>
        <Field label="Description">
          <input
            className={inputClass}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="Who runs it, and where the secret is kept"
            maxLength={500}
          />
        </Field>
        <div className="block">
          <span className="mb-1 flex items-center justify-between text-[11px] uppercase tracking-wider text-terminal-muted">
            Reads
          </span>
          <div className="grid grid-cols-2 gap-1 md:grid-cols-4">
            {SERVICE_GRANTABLE_PERMISSIONS.map((permission) => (
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
        </div>
        {mint.error === null ? null : (
          <p className="text-[11px] text-terminal-negative">
            {mint.error instanceof DomainError ? mint.error.message : 'The token was not created.'}
          </p>
        )}
        <Button
          disabled={name.trim().length === 0 || chosen.size === 0 || mint.isPending}
          onClick={() =>
            mint.mutate(
              {
                name: name.trim(),
                ...(description.trim() === '' ? {} : { description: description.trim() }),
                permissions: [...chosen],
                ...(/^\d+$/.test(days.trim()) ? { expiresInDays: Number(days.trim()) } : {}),
              },
              {
                onSuccess: (result) => {
                  setShown(result.secret);
                  setName('');
                  setDescription('');
                  setChosen(new Set());
                },
              },
            )
          }
        >
          {mint.isPending ? 'Creating…' : 'Create token'}
        </Button>
      </div>

      <ErrorLine error={list.error ?? revoke.error} />
      {list.isLoading ? (
        <Loading />
      ) : rows.length === 0 ? (
        <Loading>No service tokens.</Loading>
      ) : (
        <Table>
          <Head columns={['Token', 'Reads', 'Status', 'Minted by', 'Last use', 'This week', '']} />
          <tbody>
            {rows.map((row: ServiceTokenRow) => (
              <tr key={row.id} className="border-t border-terminal-border/60 align-top">
                <td className="px-3 py-1.5">
                  <p className="text-terminal-text">{row.name}</p>
                  <p className="font-mono text-[10px] text-terminal-muted">{row.fingerprint}</p>
                  {row.description === null ? null : (
                    <p className="text-[10px] text-terminal-muted">{row.description}</p>
                  )}
                </td>
                <td className="px-3 py-1.5 font-mono text-[10px] text-terminal-muted">
                  {row.permissions.join(', ')}
                </td>
                <td className={cn('px-3 py-1.5', STATUS_TONE[row.status])}>
                  {row.status}
                  {row.revokedReason === null ? null : (
                    <p className="text-[10px] text-terminal-muted">{row.revokedReason}</p>
                  )}
                </td>
                <td className="px-3 py-1.5 text-terminal-muted">{row.createdBy}</td>
                <td className="numeric px-3 py-1.5 text-terminal-muted">{lastUse(row)}</td>
                <td className="numeric px-3 py-1.5 text-terminal-muted">{usageText(row)}</td>
                <td className="px-3 py-1.5 text-right">
                  {row.status === 'ACTIVE' ? (
                    <ReasonedAction
                      label="Revoke"
                      variant="danger"
                      title="Why"
                      minLength={8}
                      busy={revoke.isPending}
                      onConfirm={(reason) => revoke.mutate({ id: row.id, reason })}
                    />
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}
