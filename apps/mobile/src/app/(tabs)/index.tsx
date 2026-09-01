import React, { useCallback, useEffect, useState } from 'react';
import { RefreshControl, ScrollView, Text } from 'react-native';
import { useSession } from '../../lib/session';
import { Card, Empty, ErrorNote, Figure, Screen } from '../../components/ui';

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
  realizedPnl: string;
  commission: string;
  swap: string;
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
  const { api } = useSession();
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
      setError('Could not refresh. The figures below may be out of date.');
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

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
          <Empty message="Loading…" />
        ) : accounts.length === 0 ? (
          <Empty message="No trading accounts yet." />
        ) : (
          accounts.map((account) => {
            const state = states[account.id];
            return (
              <Card key={account.id} title={`${account.number} · ${account.currency}`}>
                <Figure label="Balance" value={state?.balance ?? account.balance} />
                <Figure label="Equity" value={state?.equity ?? '—'} />
                <Figure label="Floating P&L" value={state?.floatingPnl ?? '—'} signed />
                <Figure label="Realised P&L" value={state?.realizedPnl ?? '—'} signed />
                <Figure label="Used margin" value={state?.usedMargin ?? '—'} />
                <Figure label="Free margin" value={state?.freeMargin ?? '—'} />
                <Figure label="Margin level" value={state?.marginLevel ?? '—'} />
                <Figure label="Commission" value={state?.commission ?? '—'} />
                <Figure label="Swap" value={state?.swap ?? '—'} />
                <Figure label="Leverage" value={`1:${account.leverage}`} />
                <Figure label="Status" value={account.status} />
              </Card>
            );
          })
        )}
        <Text />
      </ScrollView>
    </Screen>
  );
}
