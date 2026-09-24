'use client';

import { useState } from 'react';
import { cn } from '@tp/ui';
import { Button, Field, inputClass } from '@/components/primitives';
import {
  useCreateMasterAccount,
  useDeskView,
  useGrantMasterLink,
  useMasterAccounts,
  useMasterLinks,
  useRevokeMasterLink,
  useRiskLimits,
  useSetRiskLimits,
  type MasterAccountRow,
} from '@/lib/admin-queries';
import { utcTime } from '@/lib/format';
import { ErrorLine, Head, Loading, ReasonedAction, Table } from './shared';

/** What each preset actually confers, in words, so nobody grants by guessing. */
const ROLES = [
  { value: 'MASTER_VIEWER', label: 'Viewer', hint: 'sees the account; moves nothing' },
  { value: 'MASTER_TRADER', label: 'Trader', hint: 'opens, closes and modifies' },
  { value: 'MASTER_MANAGER', label: 'Manager', hint: 'trades, and changes the account' },
  { value: 'MASTER_OWNER', label: 'Owner', hint: 'everything a delegation may carry' },
] as const;

/**
 * Desks: who may trade whose account, and what the desk adds up to.
 *
 * The thing this screen has to make hard to get wrong is the grant. A
 * delegation is one person given power over someone else's money, so the
 * presets are named in words with what they confer written beside them, and
 * the capabilities that were actually stored are shown afterwards — because
 * the stored list is what will be enforced, and a screen that showed only the
 * name would be showing a label rather than the fact.
 */
export function DesksPanel() {
  const masters = useMasterAccounts();
  // Asked of a hook whose route needs `master.manage`, not by the string.
  const mayManage = useCreateMasterAccount().allowed;
  const [selected, setSelected] = useState<string | null>(null);
  const rows = masters.data ?? [];
  const current = rows.find((row) => row.id === selected) ?? rows[0] ?? null;

  return (
    <div className="flex flex-col" data-testid="desks-panel">
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
        <p className="text-[11px] text-terminal-muted">
          A desk reaches exactly the accounts it has been delegated, and only for what each
          delegation lists. Creating one grants nothing by itself.
        </p>
        <span className="text-[10px] text-terminal-muted">
          {rows.length} {rows.length === 1 ? 'desk' : 'desks'}
        </span>
      </div>
      <ErrorLine error={masters.error} />

      {masters.isLoading ? (
        <Loading />
      ) : rows.length === 0 ? (
        <Loading>No desks. Every account is traded by its own holder.</Loading>
      ) : (
        <Table>
          <Head columns={['Desk', 'Operator', 'Delegations', 'Created', '']} />
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.id}
                className={cn(
                  'border-t border-terminal-border/60',
                  current?.id === row.id && 'bg-terminal-raised/40',
                )}
              >
                <td className="px-3 py-1.5 text-terminal-text">
                  {row.name}
                  {row.status === 'ACTIVE' ? '' : ` · ${row.status.toLowerCase()}`}
                </td>
                <td className="px-3 py-1.5 font-mono text-[10px] text-terminal-muted">
                  {row.operatorUserId}
                </td>
                <td className="numeric px-3 py-1.5">{row.activeLinks}</td>
                <td className="numeric px-3 py-1.5 text-[10px] text-terminal-muted">
                  {utcTime(row.createdAt)}
                </td>
                <td className="px-3 py-1.5 text-right">
                  <Button variant="ghost" onClick={() => setSelected(row.id)}>
                    Open
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      {mayManage ? <NewDesk /> : null}
      {current === null ? null : <DeskDetail desk={current} mayManage={mayManage} />}
    </div>
  );
}

function NewDesk() {
  const create = useCreateMasterAccount();
  const [name, setName] = useState('');
  const [operatorUserId, setOperator] = useState('');

  return (
    <div className="space-y-3 border-t border-terminal-border px-3 py-3">
      <p className="text-[10px] uppercase tracking-wider text-terminal-muted">New desk</p>
      <ErrorLine error={create.error} />
      <div className="grid gap-3 md:grid-cols-2">
        <Field label="Name" hint="what this desk is called here">
          <input
            className={cn(inputClass, 'py-1 text-xs')}
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="London desk"
          />
        </Field>
        <Field label="Operator" hint="the person who will run it">
          <input
            className={cn(inputClass, 'py-1 font-mono text-xs')}
            value={operatorUserId}
            onChange={(event) => setOperator(event.target.value)}
            placeholder="user id"
          />
        </Field>
      </div>
      <Button
        gate={create}
        onClick={() =>
          create.mutate(
            { name: name.trim(), operatorUserId: operatorUserId.trim() },
            {
              onSuccess: () => {
                setName('');
                setOperator('');
              },
            },
          )
        }
        disabled={name.trim() === '' || operatorUserId.trim() === '' || create.isPending}
      >
        {create.isPending ? 'Creating…' : 'Create desk'}
      </Button>
    </div>
  );
}

function DeskDetail({ desk, mayManage }: { desk: MasterAccountRow; mayManage: boolean }) {
  const links = useMasterLinks(desk.id);
  const book = useDeskView(desk.id);
  const grant = useGrantMasterLink();
  const revoke = useRevokeMasterLink();

  const [accountId, setAccountId] = useState('');
  const [role, setRole] = useState<string>('MASTER_VIEWER');

  const totals = book.data?.totals;

  return (
    <div className="space-y-4 border-t border-terminal-border px-3 py-3" data-testid="desk-detail">
      <p className="text-[10px] uppercase tracking-wider text-terminal-muted">{desk.name}</p>
      <ErrorLine error={links.error ?? book.error ?? grant.error ?? revoke.error} />

      {/* The book */}
      {book.isLoading ? (
        <Loading />
      ) : (
        <div className="space-y-2">
          <div className="flex flex-wrap gap-4 text-[11px]">
            <Figure label="Accounts" value={String(totals?.accounts ?? 0)} />
            <Figure label="Equity" value={totals?.equity} currency={book.data?.currency} />
            <Figure label="Balance" value={totals?.balance} currency={book.data?.currency} />
            <Figure label="Used margin" value={totals?.usedMargin} currency={book.data?.currency} />
            <Figure label="Floating" value={totals?.floatingPnl} currency={book.data?.currency} />
            <Figure label="Open positions" value={String(totals?.openPositions ?? 0)} />
          </div>
          {book.data !== undefined && book.data.unpriced.length > 0 ? (
            <p className="text-[11px] text-terminal-warning">
              No total is shown: {book.data.unpriced.join(', ')} could not be priced in{' '}
              {book.data.currency}. A total that quietly dropped them would read as a smaller book
              than this desk actually runs.
            </p>
          ) : null}

          {book.data !== undefined && book.data.exposure.length > 0 ? (
            <Table>
              <Head columns={['Instrument', 'Net volume', 'Gross notional', 'Accounts']} />
              <tbody>
                {book.data.exposure.map((row) => (
                  <tr key={row.symbol} className="border-t border-terminal-border/60">
                    <td className="px-3 py-1.5 text-terminal-text">{row.symbol}</td>
                    <td
                      className={cn(
                        'numeric px-3 py-1.5',
                        Number(row.netVolume) < 0 ? 'text-terminal-short' : 'text-terminal-long',
                      )}
                    >
                      {row.netVolume}
                    </td>
                    <td className="numeric px-3 py-1.5">{row.grossNotional ?? '—'}</td>
                    <td className="numeric px-3 py-1.5">{row.accounts}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          ) : null}
        </div>
      )}

      {/* The delegations */}
      <Table>
        <Head columns={['Account', 'Granted as', 'What it confers now', 'Granted', '']} />
        <tbody>
          {(links.data ?? []).map((link) => (
            <tr key={link.id} className="border-t border-terminal-border/60 align-top">
              <td className="px-3 py-1.5 font-mono text-[11px]">
                {link.accountNumber}
                {link.status === 'ACTIVE' ? '' : ' · revoked'}
              </td>
              <td className="px-3 py-1.5 text-[11px]">
                {label(link.grantedAsRole) ?? <span className="text-terminal-muted">chosen</span>}
              </td>
              <td className="px-3 py-1.5 text-[10px] text-terminal-muted">
                {/* The stored list, because the stored list is what is enforced. */}
                {link.role === null ? link.capabilities.join(', ') : label(link.role)}
              </td>
              <td className="numeric px-3 py-1.5 text-[10px] text-terminal-muted">
                {utcTime(link.grantedAt)}
              </td>
              <td className="px-3 py-1.5 text-right">
                {mayManage && link.status === 'ACTIVE' ? (
                  <ReasonedAction
                    gate={revoke}
                    label="Revoke"
                    variant="danger"
                    title="Why"
                    minLength={4}
                    busy={revoke.isPending}
                    onConfirm={() => revoke.mutate({ id: desk.id, accountId: link.accountId })}
                  />
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </Table>

      {mayManage ? (
        <div className="grid gap-3 md:grid-cols-3">
          <Field label="Account" hint="the account to delegate">
            <input
              className={cn(inputClass, 'py-1 font-mono text-xs')}
              value={accountId}
              onChange={(event) => setAccountId(event.target.value)}
              placeholder="account id"
            />
          </Field>
          <Field label="As" hint={ROLES.find((one) => one.value === role)?.hint}>
            <select
              className={cn(inputClass, 'py-1 text-xs')}
              value={role}
              onChange={(event) => setRole(event.target.value)}
            >
              {ROLES.map((one) => (
                <option key={one.value} value={one.value}>
                  {one.label}
                </option>
              ))}
            </select>
          </Field>
          <div className="flex items-end">
            <Button
              gate={grant}
              onClick={() =>
                grant.mutate(
                  { id: desk.id, accountId: accountId.trim(), role },
                  { onSuccess: () => setAccountId('') },
                )
              }
              disabled={accountId.trim() === '' || grant.isPending}
            >
              {grant.isPending ? 'Granting…' : 'Grant'}
            </Button>
          </div>
        </div>
      ) : null}

      <DeskCeiling masterAccountId={desk.id} />
    </div>
  );
}

/**
 * The desk's own ceiling.
 *
 * It binds orders this desk's operators place and does not bind the account
 * holder trading their own account — which is the whole reason the layer
 * exists, and is said on the screen because nobody would guess it.
 */
function DeskCeiling({ masterAccountId }: { masterAccountId: string }) {
  const limits = useRiskLimits();
  const save = useSetRiskLimits();
  // A desk's ceiling is a risk limit: `risk.manage`, which is not the same
  // capability as managing desks. This was given the desk screen's flag, and
  // offered the form to desk managers the server then refused.
  const mayManage = save.allowed;
  const [volume, setVolume] = useState('');
  const [positions, setPositions] = useState('');

  const mine = limits.data?.find((row) => row.masterAccountId === masterAccountId);
  const above = limits.data?.filter((row) => row.masterAccountId === null) ?? [];

  return (
    <div className="space-y-2 border-t border-terminal-border/60 pt-3">
      <p className="text-[10px] uppercase tracking-wider text-terminal-muted">Desk ceiling</p>
      <p className="text-[11px] text-terminal-muted">
        Binds orders this desk&apos;s operators place. It does not bind an account holder trading
        their own account. A ceiling may tighten the layers above it and never loosen them.
      </p>
      <ErrorLine error={limits.error ?? save.error} />
      {above.length > 0 ? (
        <p className="text-[10px] text-terminal-muted">
          Above:{' '}
          {above
            .map(
              (row) =>
                `${row.level.toLowerCase()} ${row.maxPositionVolume ?? '—'} lots / ${
                  row.maxOpenPositions ?? '—'
                } positions`,
            )
            .join(' · ')}
        </p>
      ) : null}
      <p className="text-[11px]">
        Now: {mine?.maxPositionVolume ?? '—'} lots per position, {mine?.maxOpenPositions ?? '—'}{' '}
        open positions
      </p>
      {mayManage ? (
        <div className="grid gap-3 md:grid-cols-3">
          <Field label="Max lots per position">
            <input
              className={cn(inputClass, 'py-1 text-xs')}
              value={volume}
              onChange={(event) => setVolume(event.target.value)}
              placeholder={mine?.maxPositionVolume ?? 'unset'}
            />
          </Field>
          <Field label="Max open positions">
            <input
              className={cn(inputClass, 'py-1 text-xs')}
              value={positions}
              onChange={(event) => setPositions(event.target.value)}
              placeholder={mine?.maxOpenPositions?.toString() ?? 'unset'}
            />
          </Field>
          <div className="flex items-end">
            <Button
              gate={save}
              onClick={() =>
                save.mutate(
                  {
                    level: 'DESK',
                    masterAccountId,
                    limits: {
                      ...(volume.trim() === '' ? {} : { maxPositionVolume: volume.trim() }),
                      ...(positions.trim() === ''
                        ? {}
                        : { maxOpenPositions: Number(positions.trim()) }),
                    },
                  },
                  {
                    onSuccess: () => {
                      setVolume('');
                      setPositions('');
                    },
                  },
                )
              }
              disabled={(volume.trim() === '' && positions.trim() === '') || save.isPending}
            >
              {save.isPending ? 'Saving…' : 'Set ceiling'}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Figure({
  label: name,
  value,
  currency,
}: {
  label: string;
  value: string | null | undefined;
  currency?: string;
}) {
  return (
    <span>
      <span className="text-[10px] uppercase tracking-wider text-terminal-muted">{name}</span>{' '}
      <span className="numeric">
        {value ?? '—'}
        {value != null && currency !== undefined ? ` ${currency}` : ''}
      </span>
    </span>
  );
}

function label(role: string | null): string | null {
  if (role === null) return null;
  return ROLES.find((one) => one.value === role)?.label ?? role;
}
