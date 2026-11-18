'use client';

import { useState } from 'react';
import { cn } from '@tp/ui';
import { Button, inputClass } from '@/components/primitives';
import {
  useAdminChallenge,
  useAdminChallengePlans,
  useAdminChallenges,
  useDecideChallengePayment,
  useSaveChallengePlan,
  type ChallengePlanInput,
} from '@/lib/admin-queries';
import { money, utcTime } from '@/lib/format';
import type { ChallengePlanRow, ChallengeStatus } from '@/lib/queries';
import { ErrorLine, Head, Loading, ReasonedAction, StatusPill, Table } from './shared';

const STATUSES: ReadonlyArray<ChallengeStatus | null> = [
  'PAYMENT_REVIEW',
  'ACTIVE',
  'FUNDED',
  'FAILED',
  'AWAITING_PAYMENT',
  'CANCELLED',
  null,
];

const NEW_PLAN: ChallengePlanInput = {
  name: '',
  steps: 2,
  accountSize: '10000',
  accountCurrency: 'USD',
  leverage: 100,
  price: '',
  paymentAsset: 'USDT',
  paymentNetwork: 'TRC20',
  paymentAddress: null,
  phaseOneTargetPct: '8',
  phaseTwoTargetPct: '5',
  dailyLossPct: '5',
  maxLossPct: '10',
  drawdownMode: 'STATIC',
  trailingLock: false,
  dailyBasis: 'BALANCE',
  minTradingDays: 4,
  maxDays: null,
  profitSplitPct: '80',
  isActive: false,
};

/**
 * The firm's side of challenges: the payment queue first, because it is the
 * one that waits on a person; then every challenge by status; then the plans.
 */
export function ChallengesPanel() {
  const [status, setStatus] = useState<ChallengeStatus | null>('PAYMENT_REVIEW');
  const [open, setOpen] = useState<string | null>(null);
  const list = useAdminChallenges(status);
  const decide = useDecideChallengePayment();

  return (
    <div className="space-y-6 p-3" data-testid="admin-challenges">
      <section>
        <div className="mb-2 flex flex-wrap gap-1" role="group" aria-label="Challenge status">
          {STATUSES.map((one) => (
            <button
              key={one ?? 'all'}
              type="button"
              aria-pressed={status === one}
              onClick={() => setStatus(one)}
              className={cn(
                'rounded px-2 py-1 text-caption',
                status === one
                  ? 'bg-terminal-raised text-terminal-text'
                  : 'text-terminal-muted hover:text-terminal-text',
              )}
            >
              {one === null ? 'All' : one.replace('_', ' ').toLowerCase()}
            </button>
          ))}
        </div>
        {list.isError ? (
          <ErrorLine error={list.error} />
        ) : list.isPending ? (
          <Loading />
        ) : (list.data ?? []).length === 0 ? (
          <p className="p-4 text-caption text-terminal-muted">No challenges here.</p>
        ) : (
          <Table>
            <Head
              columns={[
                'Trader',
                'Plan',
                'Status',
                'Phase',
                'Account',
                { label: 'Equity', right: true },
                'Payment',
                'Actions',
              ]}
            />
            <tbody>
              {(list.data ?? []).map((row) => (
                <tr
                  key={row.id}
                  className="border-t border-terminal-border/60"
                  data-testid="admin-challenge-row"
                >
                  <td className="px-2 py-1.5">
                    <button
                      type="button"
                      className="text-start text-terminal-text hover:underline"
                      onClick={() => setOpen(open === row.id ? null : row.id)}
                    >
                      {row.trader?.email ?? '—'}
                    </button>
                  </td>
                  <td className="px-2 py-1.5">
                    {row.planName}{' '}
                    <span className="numeric text-terminal-muted">
                      {money(row.accountSize, row.accountCurrency)}
                    </span>
                  </td>
                  <td className="px-2 py-1.5">
                    <StatusPill status={row.status} />
                    {row.failedRule === null ? null : (
                      <span className="ms-1 text-terminal-short">{row.failedRule}</span>
                    )}
                  </td>
                  <td className="px-2 py-1.5">{row.phase}</td>
                  <td className="numeric px-2 py-1.5">{row.accountNumber ?? '—'}</td>
                  <td className="numeric px-2 py-1.5 text-end">
                    {row.metrics === null ? '—' : money(row.metrics.equity, row.accountCurrency)}
                  </td>
                  <td className="px-2 py-1.5">
                    <span className="numeric">
                      {row.price} {row.payment.asset}/{row.payment.network}
                    </span>
                    {row.payment.transactionHash === null ? null : (
                      <code className="ms-1 block max-w-56 truncate text-micro text-terminal-muted">
                        {row.payment.transactionHash}
                      </code>
                    )}
                  </td>
                  <td className="px-2 py-1.5">
                    {row.status === 'PAYMENT_REVIEW' ? (
                      <div className="flex flex-wrap gap-1">
                        <Button
                          variant="long"
                          className="px-2 py-0.5"
                          gate={decide}
                          disabled={decide.isPending}
                          onClick={() =>
                            decide.mutate({ id: row.id, confirmed: true, reason: null })
                          }
                        >
                          Confirm paid
                        </Button>
                        <ReasonedAction
                          label="Refuse"
                          title="Why — the trader sees this"
                          variant="danger"
                          gate={decide}
                          busy={decide.isPending}
                          onConfirm={(reason) =>
                            decide.mutate({ id: row.id, confirmed: false, reason })
                          }
                        />
                      </div>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        {decide.error === null ? null : <ErrorLine error={decide.error} />}
        {open === null ? null : <ChallengeHistory id={open} />}
      </section>

      <Plans />
    </div>
  );
}

function ChallengeHistory({ id }: { id: string }) {
  const one = useAdminChallenge(id);
  if (one.isPending) return <Loading />;
  if (one.isError) return <ErrorLine error={one.error} />;
  return (
    <div className="mt-3 rounded-lg border border-terminal-border p-3">
      <h3 className="mb-2 text-label uppercase tracking-wider text-terminal-muted">History</h3>
      <ol className="space-y-1 text-caption">
        {(one.data.events ?? []).map((event, index) => (
          <li key={index} className="flex gap-3">
            <span className="numeric w-40 shrink-0 text-terminal-muted">{utcTime(event.at)}</span>
            <span className="w-36 shrink-0 text-terminal-text">{event.kind}</span>
            <code className="min-w-0 truncate text-terminal-muted">
              {JSON.stringify(event.details)}
            </code>
          </li>
        ))}
      </ol>
    </div>
  );
}

function Plans() {
  const plans = useAdminChallengePlans();
  const [editing, setEditing] = useState<{ id: string | null; plan: ChallengePlanInput } | null>(
    null,
  );
  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-label uppercase tracking-wider text-terminal-muted">Plans</h2>
        <Button className="px-2 py-0.5" onClick={() => setEditing({ id: null, plan: NEW_PLAN })}>
          New plan
        </Button>
      </div>
      {editing === null ? null : (
        <PlanForm
          key={editing.id ?? 'new'}
          id={editing.id}
          initial={editing.plan}
          onDone={() => setEditing(null)}
        />
      )}
      {plans.isError ? (
        <ErrorLine error={plans.error} />
      ) : plans.isPending ? (
        <Loading />
      ) : (
        <Table>
          <Head columns={['Name', 'Size', 'Price', 'Rules', 'Pay to', 'On sale', 'Actions']} />
          <tbody>
            {(plans.data ?? []).map((plan) => (
              <tr
                key={plan.id}
                className="border-t border-terminal-border/60"
                data-testid="admin-plan-row"
              >
                <td className="px-2 py-1.5 text-terminal-text">{plan.name}</td>
                <td className="numeric px-2 py-1.5">
                  {money(plan.accountSize, plan.accountCurrency)} · 1:{plan.leverage}
                </td>
                <td className="numeric px-2 py-1.5">
                  {plan.price} {plan.paymentAsset}
                </td>
                <td className="numeric px-2 py-1.5 text-terminal-muted">
                  {plan.steps}-step · {plan.phaseOneTargetPct}%
                  {plan.phaseTwoTargetPct === null ? '' : `/${plan.phaseTwoTargetPct}%`} · daily{' '}
                  {plan.dailyLossPct}% ({plan.dailyBasis.toLowerCase()}) · max {plan.maxLossPct}%{' '}
                  {plan.drawdownMode.toLowerCase()} · {plan.minTradingDays}d min
                  {plan.maxDays === null ? '' : ` · ${plan.maxDays}d max`} · split{' '}
                  {plan.profitSplitPct}%
                </td>
                <td className="px-2 py-1.5">
                  {plan.paymentNetwork}{' '}
                  <code className="block max-w-48 truncate text-micro text-terminal-muted">
                    {plan.paymentAddress ?? 'no address'}
                  </code>
                </td>
                <td className="px-2 py-1.5">{plan.isActive ? 'Yes' : 'No'}</td>
                <td className="px-2 py-1.5">
                  <Button
                    variant="ghost"
                    className="px-2 py-0.5"
                    onClick={() => setEditing({ id: plan.id, plan: toInput(plan) })}
                  >
                    Edit
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </section>
  );
}

function toInput(plan: ChallengePlanRow): ChallengePlanInput {
  const { id: _id, ...rest } = plan;
  return { ...rest, paymentAddress: plan.paymentAddress ?? null, isActive: plan.isActive ?? false };
}

function PlanForm({
  id,
  initial,
  onDone,
}: {
  id: string | null;
  initial: ChallengePlanInput;
  onDone: () => void;
}) {
  const save = useSaveChallengePlan();
  const [plan, setPlan] = useState<ChallengePlanInput>(initial);
  const set = <K extends keyof ChallengePlanInput>(key: K, value: ChallengePlanInput[K]) =>
    setPlan((now) => ({ ...now, [key]: value }));
  const text = (key: keyof ChallengePlanInput, label: string, hint?: string) => (
    <label className="flex flex-col gap-1 text-caption text-terminal-muted">
      {label}
      <input
        className={cn(inputClass, 'py-1 text-xs')}
        value={String(plan[key] ?? '')}
        placeholder={hint}
        onChange={(event) => set(key, event.target.value as never)}
      />
    </label>
  );
  const int = (key: 'leverage' | 'minTradingDays', label: string) => (
    <label className="flex flex-col gap-1 text-caption text-terminal-muted">
      {label}
      <input
        type="number"
        className={cn(inputClass, 'py-1 text-xs')}
        value={plan[key]}
        onChange={(event) => set(key, Number.parseInt(event.target.value || '0', 10))}
      />
    </label>
  );

  return (
    <form
      className="mb-4 space-y-3 rounded-lg border border-terminal-border p-3"
      data-testid="plan-form"
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate(
          {
            id,
            plan: {
              ...plan,
              phaseTwoTargetPct: plan.steps === 1 ? null : plan.phaseTwoTargetPct,
              paymentAddress:
                plan.paymentAddress === null || plan.paymentAddress.trim() === ''
                  ? null
                  : plan.paymentAddress.trim(),
            },
          },
          { onSuccess: onDone },
        );
      }}
    >
      <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {text('name', 'Name', '10K two-step')}
        <label className="flex flex-col gap-1 text-caption text-terminal-muted">
          Phases
          <select
            className={cn(inputClass, 'py-1 text-xs')}
            value={plan.steps}
            onChange={(event) => set('steps', Number(event.target.value))}
          >
            <option value={1}>1 then funded</option>
            <option value={2}>2 then funded</option>
          </select>
        </label>
        {text('accountSize', 'Account size')}
        {text('accountCurrency', 'Account currency')}
        {int('leverage', 'Leverage 1:')}
        {text('profitSplitPct', 'Trader split %')}
        {text('price', 'Price')}
        {text('paymentAsset', 'Paid in')}
        {text('paymentNetwork', 'Network')}
        <div className="sm:col-span-3">{text('paymentAddress', 'Receiving address')}</div>
        {text('phaseOneTargetPct', 'Phase 1 target %')}
        {plan.steps === 2 ? text('phaseTwoTargetPct', 'Phase 2 target %') : <span />}
        {text('dailyLossPct', 'Daily loss %')}
        <label className="flex flex-col gap-1 text-caption text-terminal-muted">
          Daily measured from
          <select
            className={cn(inputClass, 'py-1 text-xs')}
            value={plan.dailyBasis}
            onChange={(event) => set('dailyBasis', event.target.value as 'BALANCE')}
          >
            <option value="BALANCE">Day-start balance</option>
            <option value="EQUITY">Day-start equity</option>
            <option value="HIGHER">Higher of the two</option>
          </select>
        </label>
        {text('maxLossPct', 'Max loss %')}
        <label className="flex flex-col gap-1 text-caption text-terminal-muted">
          Max loss floor
          <select
            className={cn(inputClass, 'py-1 text-xs')}
            value={plan.drawdownMode}
            onChange={(event) => set('drawdownMode', event.target.value as 'STATIC')}
          >
            <option value="STATIC">Static (initial balance)</option>
            <option value="TRAILING">Trailing (high-water equity)</option>
          </select>
        </label>
        {int('minTradingDays', 'Min trading days')}
        <label className="flex flex-col gap-1 text-caption text-terminal-muted">
          Days per phase
          <input
            type="number"
            className={cn(inputClass, 'py-1 text-xs')}
            placeholder="unlimited"
            value={plan.maxDays ?? ''}
            onChange={(event) =>
              set(
                'maxDays',
                event.target.value === '' ? null : Number.parseInt(event.target.value, 10),
              )
            }
          />
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-4 text-caption text-terminal-muted">
        {plan.drawdownMode === 'TRAILING' ? (
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={plan.trailingLock}
              onChange={(event) => set('trailingLock', event.target.checked)}
            />
            Stop the trailing floor at the initial balance
          </label>
        ) : null}
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={plan.isActive}
            onChange={(event) => set('isActive', event.target.checked)}
          />
          On sale
        </label>
        <span className="flex-1" />
        <Button type="button" variant="ghost" className="px-2 py-0.5" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" className="px-2 py-0.5" gate={save} disabled={save.isPending}>
          {id === null ? 'Create plan' : 'Save plan'}
        </Button>
      </div>
      <p className="text-micro text-terminal-muted">
        Changes apply to challenges bought from now on; challenges already bought keep the terms
        they were bought with.
      </p>
      {save.error === null ? null : <ErrorLine error={save.error} />}
    </form>
  );
}
