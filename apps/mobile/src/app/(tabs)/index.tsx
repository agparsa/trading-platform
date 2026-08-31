import React, { useCallback, useEffect, useState } from 'react';
import { RefreshControl, ScrollView, Text } from 'react-native';
import { useSession } from '../../lib/session';
import { Card, Empty, ErrorNote, Figure, Screen } from '../../components/ui';

interface AccountState {
  id: string;
  number: string;
  currency: string;
  balance: string;
  equity: string;
  usedMargin: string;
  freeMargin: string;
  marginLevel: string | null;
  unrealisedPnl: string;
  status: string;
  leverage: number;
}

/**
 * The account, from the server.
 *
 * Every figure here is fetched. §46.21 forbids fake trading data on production
 * screens, and a dashboard is exactly where a placeholder would be most
 * convincing and most dangerous — a trader acts on the equity they can see.
 */
export default function AccountScreen(): React.ReactElement {
  const { api } = useSession();
  const [accounts, setAccounts] = useState<AccountState[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      setAccounts(await api.get<AccountState[]>('/accounts'));
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
          accounts.map((account) => (
            <Card key={account.id} title={`${account.number} · ${account.currency}`}>
              <Figure label="Balance" value={account.balance} />
              <Figure label="Equity" value={account.equity} />
              <Figure label="Unrealised P&L" value={account.unrealisedPnl} signed />
              <Figure label="Used margin" value={account.usedMargin} />
              <Figure label="Free margin" value={account.freeMargin} />
              <Figure label="Margin level" value={account.marginLevel ?? '—'} />
              <Figure label="Leverage" value={`1:${account.leverage}`} />
              <Figure label="Status" value={account.status} />
            </Card>
          ))
        )}
        <Text />
      </ScrollView>
    </Screen>
  );
}
