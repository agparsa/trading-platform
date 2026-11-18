'use client';

import Link from 'next/link';
import { useState } from 'react';
import { cn } from '@tp/ui';
import { Button, inputClass } from '@/components/primitives';
import { useExplain } from '@/lib/error-words';
import { money, utcTime } from '@/lib/format';
import type { MessageKey } from '@/lib/messages';
import {
  useCancelChallenge,
  useSubmitChallengePayment,
  type ChallengeMetricsRow,
  type ChallengeRow,
} from '@/lib/queries';
import { useSession } from '@/lib/session';
import { useT } from '@/lib/use-locale';

const STATUS_TONE: Record<ChallengeRow['status'], string> = {
  AWAITING_PAYMENT: 'bg-terminal-warning/15 text-terminal-warning',
  PAYMENT_REVIEW: 'bg-terminal-warning/15 text-terminal-warning',
  ACTIVE: 'bg-terminal-accent/15 text-terminal-accent',
  FUNDED: 'bg-terminal-long/15 text-terminal-long',
  FAILED: 'bg-terminal-short/15 text-terminal-short',
  CANCELLED: 'bg-terminal-raised text-terminal-muted',
};

/**
 * One challenge, in whatever state it is in: how to pay for it, that it is
 * being checked, how close it is to each rule, or why it ended.
 *
 * The meters are the evaluator's own figures from its last pass — nothing is
 * computed here that the server did not decide. Bar lengths are the only
 * arithmetic, and they are drawing, not figures.
 */
export function ChallengeCard({ row }: { row: ChallengeRow }) {
  const t = useT();
  const { selectAccount } = useSession();
  const currency = row.accountCurrency;
  const phaseKey = `ch.phase.${row.phase}` as MessageKey;

  return (
    <article
      className="overflow-hidden rounded-xl border border-terminal-border bg-terminal-surface"
      data-testid="challenge-card"
    >
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-terminal-border px-4 py-3">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold text-terminal-text">{row.planName}</h3>
          <p className="numeric mt-0.5 text-caption text-terminal-muted">
            {money(row.accountSize, currency)} · 1:{row.leverage} ·{' '}
            {row.status === 'ACTIVE' || row.status === 'FUNDED'
              ? t(phaseKey)
              : t(`ch.steps.${row.steps === 1 ? '1' : '2'}`)}
          </p>
        </div>
        <span
          className={cn('rounded px-2 py-0.5 text-caption font-medium', STATUS_TONE[row.status])}
          data-testid="challenge-status"
        >
          {t(`ch.status.${row.status}` as MessageKey)}
        </span>
      </header>

      <div className="space-y-3 p-4">
        {row.status === 'AWAITING_PAYMENT' ? <PayBox row={row} /> : null}
        {row.status === 'PAYMENT_REVIEW' ? (
          <p className="text-caption text-terminal-muted">
            {t('ch.reviewing', { hash: row.payment.transactionHash ?? '' })}
          </p>
        ) : null}
        {row.status === 'ACTIVE' || row.status === 'FUNDED' ? (
          <>
            {row.metrics === null ? (
              <p className="text-caption text-terminal-muted">{t('ch.firstCheck')}</p>
            ) : (
              <Meters metrics={row.metrics} currency={currency} funded={row.phase === 'FUNDED'} />
            )}
            <div className="flex flex-wrap items-center justify-between gap-2 text-caption">
              <span className="text-terminal-muted">
                {t('ch.account', { number: row.accountNumber ?? '—' })}
                {row.lastEvaluatedAt === null
                  ? ''
                  : ` · ${t('ch.checked', { at: utcTime(row.lastEvaluatedAt).slice(11, 19) })}`}
              </span>
              {row.accountId === null ? null : (
                <Link
                  href="/terminal"
                  onClick={() => selectAccount(row.accountId ?? '')}
                  className="rounded-md bg-terminal-accent px-3 py-1.5 font-medium text-terminal-bg hover:opacity-90"
                >
                  {t('ch.trade')}
                </Link>
              )}
            </div>
          </>
        ) : null}
        {row.status === 'FAILED' ? (
          <p className="text-caption text-terminal-short">
            {t(`ch.rule.${row.failedRule ?? 'UNKNOWN'}` as MessageKey)}{' '}
            <span className="numeric text-terminal-muted">
              {row.failedAt === null ? '' : `${utcTime(row.failedAt)} UTC`}
            </span>
          </p>
        ) : null}
        {row.certificates.length === 0 ? null : (
          <ul className="flex flex-wrap gap-2">
            {row.certificates.map((c) => (
              <li key={c.code}>
                <Link
                  href={`/challenges/certificate/${c.code}`}
                  className="inline-flex items-center gap-1 rounded-md border border-terminal-long/40 px-2 py-1 text-caption text-terminal-long hover:bg-terminal-long/10"
                >
                  <span aria-hidden>★</span>
                  {t('ch.certificate', { phase: t(`ch.phase.${c.phase}` as MessageKey) })}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </article>
  );
}

function PayBox({ row }: { row: ChallengeRow }) {
  const t = useT();
  const explain = useExplain();
  const submit = useSubmitChallengePayment();
  const cancel = useCancelChallenge();
  const [hash, setHash] = useState('');
  const [copied, setCopied] = useState(false);
  const error = submit.error ?? cancel.error;

  return (
    <div className="space-y-3">
      <p className="text-caption text-terminal-muted">
        {t('ch.payLead', {
          amount: row.price,
          asset: row.payment.asset,
          network: row.payment.network,
        })}
      </p>
      <div className="flex items-center gap-2 rounded-lg border border-terminal-border bg-terminal-bg p-2">
        <code
          className="numeric min-w-0 flex-1 break-all text-caption text-terminal-text"
          dir="ltr"
        >
          {row.payment.address}
        </code>
        <button
          type="button"
          className="shrink-0 rounded border border-terminal-border px-2 py-1 text-caption text-terminal-muted hover:text-terminal-text"
          onClick={() => {
            void navigator.clipboard?.writeText(row.payment.address).then(() => setCopied(true));
          }}
        >
          {copied ? t('ch.copied') : t('ch.copy')}
        </button>
      </div>
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          submit.mutate({ id: row.id, transactionHash: hash.trim() });
        }}
      >
        <label className="sr-only" htmlFor={`hash-${row.id}`}>
          {t('ch.hash')}
        </label>
        <input
          id={`hash-${row.id}`}
          value={hash}
          onChange={(event) => setHash(event.target.value)}
          placeholder={t('ch.hash')}
          className={cn(inputClass, 'min-w-0 flex-1 font-mono')}
          dir="ltr"
          autoComplete="off"
          spellCheck={false}
        />
        <Button type="submit" disabled={hash.trim().length < 32 || submit.isPending}>
          {t('ch.submitHash')}
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={cancel.isPending}
          onClick={() => cancel.mutate(row.id)}
        >
          {t('ch.cancel')}
        </Button>
      </form>
      <p className="text-micro text-terminal-muted">{t('ch.payNote')}</p>
      {error === null ? null : (
        <p role="alert" className="text-caption text-terminal-short">
          {explain(error, t('ch.failed'))}
        </p>
      )}
    </div>
  );
}

function Meters({
  metrics,
  currency,
  funded,
}: {
  metrics: ChallengeMetricsRow;
  currency: string;
  funded: boolean;
}) {
  const t = useT();
  // Drawing only: shares of each bar. Every number written is the server's.
  const share = (part: string, whole: string) => {
    const w = Number(whole);
    return w > 0 ? Math.min(100, Math.max(0, (Number(part) / w) * 100)) : 0;
  };
  const room = Number(metrics.equity) - Number(metrics.maxLossFloor);
  const maxUsed = share(String(Number(metrics.maxLossLimit) - room), metrics.maxLossLimit);
  return (
    <dl className="grid gap-3 sm:grid-cols-2">
      {funded || metrics.targetBalance === null ? null : (
        <Meter
          label={t('ch.m.target')}
          value={`${metrics.targetProgressPct ?? '0'}%`}
          detail={t('ch.m.targetDetail', {
            balance: money(metrics.balance, currency),
            target: money(metrics.targetBalance, currency),
          })}
          fill={Number(metrics.targetProgressPct ?? 0)}
          tone="good"
        />
      )}
      <Meter
        label={t('ch.m.daily')}
        value={money(metrics.dailyLoss, currency)}
        detail={t('ch.m.dailyDetail', {
          limit: money(metrics.dailyLossLimit, currency),
          floor: money(metrics.dailyFloor, currency),
        })}
        fill={share(metrics.dailyLoss, metrics.dailyLossLimit)}
        tone="risk"
      />
      <Meter
        label={t('ch.m.max')}
        value={money(metrics.equity, currency)}
        detail={t('ch.m.maxDetail', { floor: money(metrics.maxLossFloor, currency) })}
        fill={maxUsed}
        tone="risk"
      />
      {funded ? null : (
        <Meter
          label={t('ch.m.days')}
          value={`${metrics.tradingDays} / ${metrics.minTradingDays}`}
          detail={
            metrics.maxDays === null
              ? t('ch.m.noLimit', { day: metrics.dayNumber })
              : t('ch.m.dayOf', { day: metrics.dayNumber, max: metrics.maxDays })
          }
          fill={
            metrics.minTradingDays === 0
              ? 100
              : Math.min(100, (metrics.tradingDays / metrics.minTradingDays) * 100)
          }
          tone="good"
        />
      )}
    </dl>
  );
}

function Meter({
  label,
  value,
  detail,
  fill,
  tone,
}: {
  label: string;
  value: string;
  detail: string;
  fill: number;
  tone: 'good' | 'risk';
}) {
  const color =
    tone === 'good'
      ? 'bg-terminal-long'
      : fill >= 80
        ? 'bg-terminal-short'
        : fill >= 50
          ? 'bg-terminal-warning'
          : 'bg-terminal-accent';
  return (
    <div className="rounded-lg border border-terminal-border/70 bg-terminal-bg/60 p-3">
      <div className="flex items-baseline justify-between gap-2">
        <dt className="text-caption text-terminal-muted">{label}</dt>
        <dd className="numeric text-sm text-terminal-text" dir="ltr">
          {value}
        </dd>
      </div>
      <div
        className="mt-2 h-1.5 overflow-hidden rounded-full bg-terminal-raised"
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(fill)}
      >
        <div
          className={cn('h-full rounded-full', color)}
          style={{ width: `${Math.max(fill, 1)}%` }}
        />
      </div>
      <p className="mt-1.5 text-micro text-terminal-muted">{detail}</p>
    </div>
  );
}
