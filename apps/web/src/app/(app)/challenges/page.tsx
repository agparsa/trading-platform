'use client';

import { AppShell } from '@/components/shell/app-shell';
import { ChallengeCard } from '@/components/challenges/challenge-card';
import { Button } from '@/components/primitives';
import { useExplain } from '@/lib/error-words';
import { money } from '@/lib/format';
import type { MessageKey } from '@/lib/messages';
import {
  useBuyChallenge,
  useChallengePlans,
  useChallenges,
  type ChallengePlanRow,
} from '@/lib/queries';
import { useT } from '@/lib/use-locale';

/**
 * Prop-firm challenges: the ones you hold, and the ones on sale.
 *
 * What is on sale, its price and its rules are the firm's configuration,
 * read from the server; the page shows a plan only when the firm has given it
 * somewhere to be paid.
 */
export default function ChallengesPage() {
  const t = useT();
  const mine = useChallenges();
  const plans = useChallengePlans();
  const rows = mine.data ?? [];

  return (
    <AppShell wide title={t('nav.challenges')} description={t('ch.lead')}>
      <div className="space-y-8" data-testid="challenges">
        <section aria-labelledby="ch-mine">
          <h2 id="ch-mine" className="mb-3 text-sm font-semibold text-terminal-text">
            {t('ch.mine')}
          </h2>
          {mine.isError ? (
            <p className="text-caption text-terminal-short">{t('dash.unavailable')}</p>
          ) : mine.isPending ? (
            <p className="text-caption text-terminal-muted">{t('common.loading')}</p>
          ) : rows.length === 0 ? (
            <p className="rounded-xl border border-dashed border-terminal-border p-6 text-center text-caption text-terminal-muted">
              {t('ch.none')}
            </p>
          ) : (
            <div className="grid gap-4 lg:grid-cols-2">
              {rows.map((row) => (
                <ChallengeCard key={row.id} row={row} />
              ))}
            </div>
          )}
        </section>

        <section aria-labelledby="ch-plans">
          <h2 id="ch-plans" className="mb-3 text-sm font-semibold text-terminal-text">
            {t('ch.onSale')}
          </h2>
          {plans.isError ? (
            <p className="text-caption text-terminal-short">{t('dash.unavailable')}</p>
          ) : plans.isPending ? (
            <p className="text-caption text-terminal-muted">{t('common.loading')}</p>
          ) : (plans.data ?? []).length === 0 ? (
            <p className="text-caption text-terminal-muted">{t('ch.noPlans')}</p>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {(plans.data ?? []).map((plan) => (
                <PlanCard key={plan.id} plan={plan} />
              ))}
            </div>
          )}
        </section>
      </div>
    </AppShell>
  );
}

function PlanCard({ plan }: { plan: ChallengePlanRow }) {
  const t = useT();
  const explain = useExplain();
  const buy = useBuyChallenge();
  const rules: Array<[MessageKey, string]> = [
    ['ch.r.target1', `${plan.phaseOneTargetPct}%`],
    ...(plan.steps === 2 && plan.phaseTwoTargetPct !== null
      ? ([['ch.r.target2', `${plan.phaseTwoTargetPct}%`]] as Array<[MessageKey, string]>)
      : []),
    ['ch.r.daily', `${plan.dailyLossPct}%`],
    [plan.drawdownMode === 'TRAILING' ? 'ch.r.maxTrailing' : 'ch.r.max', `${plan.maxLossPct}%`],
    ['ch.r.minDays', String(plan.minTradingDays)],
    ['ch.r.maxDays', plan.maxDays === null ? t('ch.r.unlimited') : String(plan.maxDays)],
    ['ch.r.split', `${plan.profitSplitPct}%`],
    ['account.leverage', `1:${plan.leverage}`],
  ];
  return (
    <article
      className="flex flex-col rounded-xl border border-terminal-border bg-terminal-surface p-4"
      data-testid="challenge-plan"
    >
      <p className="text-caption text-terminal-muted">{plan.name}</p>
      <p className="numeric mt-1 text-2xl font-semibold text-terminal-text" dir="ltr">
        {money(plan.accountSize, plan.accountCurrency)}
      </p>
      <p className="mt-0.5 text-caption text-terminal-muted">
        {t(`ch.steps.${plan.steps === 1 ? '1' : '2'}`)}
      </p>
      <dl className="mt-4 flex-1 space-y-1.5 text-caption">
        {rules.map(([key, value]) => (
          <div key={key} className="flex justify-between gap-3">
            <dt className="text-terminal-muted">{t(key)}</dt>
            <dd className="numeric text-terminal-text" dir="ltr">
              {value}
            </dd>
          </div>
        ))}
      </dl>
      <div className="mt-4 flex items-center justify-between gap-3 border-t border-terminal-border pt-3">
        <span className="numeric text-base font-semibold text-terminal-text" dir="ltr">
          {plan.price} {plan.paymentAsset}
        </span>
        <Button
          variant="long"
          disabled={buy.isPending}
          onClick={() => buy.mutate(plan.id)}
          data-testid="challenge-buy"
        >
          {t('ch.buy')}
        </Button>
      </div>
      <p className="mt-1 text-micro text-terminal-muted">
        {t('ch.paidOn', { network: plan.paymentNetwork })}
      </p>
      {buy.error === null ? null : (
        <p role="alert" className="mt-2 text-caption text-terminal-short">
          {explain(buy.error, t('ch.failed'))}
        </p>
      )}
    </article>
  );
}
