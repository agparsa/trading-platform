'use client';

import { useState } from 'react';
import { cn } from '@tp/ui';
import { Button, Field, inputClass } from '@/components/primitives';
import {
  useBrokers,
  useCreateBroker,
  useSetBrokerStatus,
  type BrokerCreated,
  type BrokerRow,
} from '@/lib/admin-queries';
import { utcTime } from '@/lib/format';
import { ErrorLine, Head, Loading, ReasonedAction, StatusPill, Table } from './shared';

/**
 * The platform's brokers.
 *
 * Only the platform tenant sees anything here: a broker's administrator
 * holds no `tenants.read`, and the server refuses the route from a broker
 * tenant even to someone who somehow does. Creating a broker returns the
 * owner's invitation code once — it is kept in this component's state until
 * dismissed and nowhere else, because the server does not have it either.
 */
export function BrokersPanel() {
  const list = useBrokers();
  const create = useCreateBroker();
  const setStatus = useSetBrokerStatus();
  const mayManage = create.allowed;

  const [created, setCreated] = useState<BrokerCreated | null>(null);
  const [slug, setSlug] = useState('');
  const [name, setName] = useState('');
  const [legalName, setLegalName] = useState('');
  const [host, setHost] = useState('');
  const [mode, setMode] = useState<'INTERNAL' | 'EXTERNAL_BROKER'>('INTERNAL');
  const [copied, setCopied] = useState(false);

  const rows = list.data?.brokers ?? [];
  const canCreate = slug.trim().length >= 2 && name.trim().length > 0 && !create.isPending;

  const submit = () => {
    create.mutate(
      {
        slug: slug.trim(),
        name: name.trim(),
        ...(legalName.trim() === '' ? {} : { legalName: legalName.trim() }),
        ...(host.trim() === '' ? {} : { primaryHost: host.trim() }),
        defaultExecutionMode: mode,
      },
      {
        onSuccess: (result) => {
          setCreated(result);
          setSlug('');
          setName('');
          setLegalName('');
          setHost('');
          setCopied(false);
        },
      },
    );
  };

  return (
    <div className="flex flex-col" data-testid="brokers-panel">
      <div className="flex items-center justify-between gap-2 px-3 py-2">
        <p className="text-[11px] text-terminal-muted">
          A broker is a tenant of its own: its people, accounts, roles and audit trail are separate
          from every other firm&apos;s and from the platform&apos;s.
        </p>
        <span className="text-[10px] text-terminal-muted">
          {rows.length} {rows.length === 1 ? 'broker' : 'brokers'}
        </span>
      </div>
      <ErrorLine error={list.error ?? setStatus.error} />

      {created === null ? null : (
        <div
          className="mx-3 mb-3 space-y-2 rounded border border-terminal-warning/60 bg-terminal-raised p-3"
          data-testid="broker-owner-invite"
        >
          <p className="text-[11px] text-terminal-text">
            <span className="font-medium">{created.broker.name}</span> is created. Give this
            invitation code to its owner. It is shown once: the platform keeps only a fingerprint (
            {created.ownerInvite.fingerprint}), and it expires{' '}
            {utcTime(created.ownerInvite.expiresAt)}.
          </p>
          <pre className="whitespace-pre-wrap break-all rounded bg-terminal-bg px-3 py-2 font-mono text-[12px] text-terminal-text">
            {created.ownerInvite.code}
          </pre>
          <div className="flex gap-2">
            <Button
              variant="neutral"
              onClick={() => {
                void navigator.clipboard.writeText(created.ownerInvite.code).then(() => {
                  setCopied(true);
                });
              }}
            >
              {copied ? 'Copied' : 'Copy'}
            </Button>
            <Button variant="ghost" onClick={() => setCreated(null)}>
              I have passed it on
            </Button>
          </div>
        </div>
      )}

      {list.isLoading ? (
        <Loading />
      ) : rows.length === 0 ? (
        <Loading>No brokers yet.</Loading>
      ) : (
        <Table>
          <Head columns={['Broker', 'Hostname', 'Execution', 'People', 'Accounts', 'Status', '']} />
          <tbody>
            {rows.map((row: BrokerRow) => (
              <tr key={row.id} className="border-t border-terminal-border/60 align-top">
                <td className="px-3 py-1.5">
                  <p className="text-terminal-text">{row.name}</p>
                  <p className="font-mono text-[10px] text-terminal-muted">
                    {row.slug}
                    {row.legalName === null ? '' : ` · ${row.legalName}`}
                  </p>
                </td>
                <td className="px-3 py-1.5 font-mono text-[10px] text-terminal-muted">
                  {row.primaryHost ?? '—'}
                </td>
                <td className="px-3 py-1.5 text-[10px] text-terminal-muted">
                  {row.defaultExecutionMode === 'INTERNAL' ? 'Internal engine' : 'External broker'}
                </td>
                <td className="numeric px-3 py-1.5 text-terminal-muted">{row.users}</td>
                <td className="numeric px-3 py-1.5 text-terminal-muted">{row.accounts}</td>
                <td className="px-3 py-1.5">
                  <StatusPill status={row.status} />
                </td>
                <td className="px-3 py-1.5 text-right">
                  {mayManage && row.status === 'ACTIVE' ? (
                    <ReasonedAction
                      gate={setStatus}
                      label="Suspend"
                      variant="danger"
                      title="Why — this stops every request on the broker's hostname"
                      minLength={4}
                      busy={setStatus.isPending}
                      onConfirm={(reason) =>
                        setStatus.mutate({ id: row.id, status: 'SUSPENDED', reason })
                      }
                    />
                  ) : mayManage && row.status === 'SUSPENDED' ? (
                    <ReasonedAction
                      gate={setStatus}
                      label="Reinstate"
                      title="Why"
                      minLength={4}
                      busy={setStatus.isPending}
                      onConfirm={(reason) =>
                        setStatus.mutate({ id: row.id, status: 'ACTIVE', reason })
                      }
                    />
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      {mayManage ? (
        <div className="border-t border-terminal-border px-3 py-3">
          <p className="mb-2 text-[10px] uppercase tracking-wider text-terminal-muted">
            New broker
          </p>
          <ErrorLine error={create.error} />
          <div className="grid gap-3 md:grid-cols-2">
            <Field label="Slug" hint="lowercase, letters, digits and hyphens">
              <input
                className={cn(inputClass, 'py-1 text-xs')}
                value={slug}
                onChange={(event) => setSlug(event.target.value)}
                placeholder="acme-fx"
              />
            </Field>
            <Field label="Name">
              <input
                className={cn(inputClass, 'py-1 text-xs')}
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Acme FX"
              />
            </Field>
            <Field label="Legal name" hint="optional">
              <input
                className={cn(inputClass, 'py-1 text-xs')}
                value={legalName}
                onChange={(event) => setLegalName(event.target.value)}
              />
            </Field>
            <Field label="Hostname" hint="optional; the address the broker answers on">
              <input
                className={cn(inputClass, 'py-1 text-xs')}
                value={host}
                onChange={(event) => setHost(event.target.value)}
                placeholder="trade.acme.example"
              />
            </Field>
            <Field label="Execution" hint="where new accounts execute unless told otherwise">
              <select
                className={cn(inputClass, 'py-1 text-xs')}
                value={mode}
                onChange={(event) => setMode(event.target.value as typeof mode)}
              >
                <option value="INTERNAL">Internal engine</option>
                <option value="EXTERNAL_BROKER">External broker (needs a connector)</option>
              </select>
            </Field>
          </div>
          <div className="mt-3">
            <Button onClick={submit} disabled={!canCreate} gate={create}>
              {create.isPending ? 'Creating…' : 'Create broker and mint the owner invitation'}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
