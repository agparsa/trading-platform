import React, { useCallback, useEffect, useState } from 'react';
import { RefreshControl, ScrollView, Text } from 'react-native';
import { useSession } from '../../lib/session';
import { useLiveBook } from '../../lib/live';
import { applyAccount } from '../../lib/live-book';
import { Card, Empty, ErrorNote, Figure, Screen } from '../../components/ui';
import { MESSAGES, type MessageKey, type Translate } from '../../lib/messages';
import { useT } from '../../lib/i18n';

interface AccountSummary {
  id: string;
  number: string;
  type: string;
  status: string;
  currency: string;
  balance: string;
  leverage: number;
  createdAt: string;
}

/** The live figures, which are a different endpoint from the account itself. */
interface AccountState {
  accountId: string;
  currency: string;
  balance: string;
  equity: string;
  usedMargin: string;
  freeMargin: string;
  marginLevel: string | null;
  floatingPnl: string;
  /**
   * Closed-trade P&L since the trading day began (`realizedSince`), and in
   * total. Required: this screen reads the REST snapshot, which always carries
   * them (the socket's tick frames do not, and the web's type says so).
   *
   * This interface used to read `realizedPnl`, `commission` and `swap`, none of
   * which the server has ever sent: the home screen showed three dashes to
   * every trader, and TypeScript, told the answer was an `AccountState`,
   * believed it. `pnpm smoke:contracts` now checks the real answer against
   * this type.
   */
  realizedPnlToday: string;
  realizedPnlTotal: string;
  realizedSince: number;
  updatedAt: number;
}

/**
 * The account, from the server.
 *
 * Two endpoints, because they answer two questions. `/accounts` says what
 * accounts exist and what they are; `/accounts/:id/state` marks one to market.
 * The second is the expensive one — it values every open position — so it is
 * fetched per account rather than folded into the list.
 *
 * Every figure here is fetched. §46.21 forbids fake trading data on production
 * screens, and a dashboard is exactly where a placeholder would be most
 * convincing and most dangerous: a trader acts on the equity they can see.
 */
export default function AccountScreen(): React.ReactElement {
  const t = useT();
  const { api } = useSession();
  /**
   * The valuation each tick sends, laid over the snapshot below; and a counter
   * that moves when a fill or a close changes what only a refetch can bring —
   * the balance after a close, the realised P&L. See `live-book.ts`.
   */
  const live = useLiveBook();
  const [accounts, setAccounts] = useState<AccountSummary[] | null>(null);
  const [states, setStates] = useState<Record<string, AccountState>>({});
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const list = await api.get<AccountSummary[]>('/accounts');
      setAccounts(list);

      const marked = await Promise.all(
        list.map(async (account) => {
          try {
            return [
              account.id,
              await api.get<AccountState>(`/accounts/${account.id}/state`),
            ] as const;
          } catch {
            // One account failing to value must not blank the others.
            return null;
          }
        }),
      );
      setStates(Object.fromEntries(marked.filter((entry) => entry !== null)));
      setError(null);
    } catch {
      // The previous figures stay on screen. Blanking them would replace known
      // numbers with nothing, which is worse than known numbers plus a warning
      // that they may be a minute old.
      setError(t('account.refreshFailed'));
    }
  }, [api, t]);

  useEffect(() => {
    void load();
  }, [load, live.versions.account]);

  return (
    <Screen>
      <ScrollView
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              void load().finally(() => setRefreshing(false));
            }}
          />
        }
      >
        {error === null ? null : <ErrorNote message={error} />}
        {accounts === null ? (
          <Empty message={t('common.loading')} />
        ) : accounts.length === 0 ? (
          <Empty message={t('account.none')} />
        ) : (
          accounts.map((account) => {
            const state = applyAccount(states[account.id], live.accounts[account.id]);
            return (
              <Card key={account.id} title={`${account.number} · ${account.currency}`}>
                <Figure label={t('account.balance')} value={state?.balance ?? account.balance} />
                <Figure label={t('account.equity')} value={state?.equity ?? '—'} />
                <Figure label={t('account.floating')} value={state?.floatingPnl ?? '—'} signed />
                <Figure
                  label={t('account.realizedToday')}
                  value={state?.realizedPnlToday ?? '—'}
                  signed
                />
                <Figure
                  label={t('account.realizedTotal')}
                  value={state?.realizedPnlTotal ?? '—'}
                  signed
                />
                <Figure label={t('account.margin')} value={state?.usedMargin ?? '—'} />
                <Figure label={t('account.freeMargin')} value={state?.freeMargin ?? '—'} />
                <Figure
                  label={t('account.marginLevel')}
                  value={state?.marginLevel == null ? '—' : `${state.marginLevel}%`}
                />
                <Figure label={t('account.leverage')} value={`1:${account.leverage}`} />
                <Figure label={t('account.status')} value={statusWords(account.status, t)} />
              </Card>
            );
          })
        )}
        <Text />
      </ScrollView>
    </Screen>
  );
}

function statusWords(status: string, t: Translate): string {
  const key = `account.status.${status}`;
  return key in MESSAGES.en ? t(key as MessageKey) : status;
}
