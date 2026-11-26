import { useAccounts } from '../../lib/accounts';
import { AccountPicker } from '../../components/account-picker';
import { useLiveBook } from '../../lib/live';
import React, { useCallback, useEffect, useState } from 'react';
import { FlatList, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { useSession } from '../../lib/session';
import { Empty, ErrorNote, InstrumentBadge, Screen, SideTag } from '../../components/ui';
import { useT } from '../../lib/i18n';
import { MESSAGES, type MessageKey, type Translate } from '../../lib/messages';
import { NUMERIC_DIRECTION } from '../../lib/direction';
import { formatSigned, signColor, theme } from '../../lib/theme';
import { performanceSummary, type PerformanceSummaryInput } from '../../lib/performance-summary';

interface Trade {
  id: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  volume: string;
  entryPrice: string;
  exitPrice: string;
  grossPnl: string;
  commission: string;
  swap: string;
  netPnl: string;
  closeReason: string;
  entryTime: string;
  exitTime: string;
}

/**
 * Closed trades, with the costs shown separately.
 *
 * Net P&L is the number that matters, but showing only the net hides where it
 * went. A trader whose gross was positive and whose net was not should be able
 * to see that it was commission, and how much — that is the difference between
 * a strategy that does not work and a size that does not.
 */
export default function History(): React.ReactElement {
  const t = useT();
  const { api } = useSession();
  // One account for the whole app, chosen by the trader rather than by the
  // order the server happened to list them in. See lib/accounts.tsx.
  const { selected: account } = useAccounts();
  // Moves when a position closes — which is what adds a row here.
  const { versions } = useLiveBook();
  const [trades, setTrades] = useState<Trade[] | null>(null);
  const [performance, setPerformance] = useState<PerformanceSummaryInput | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      if (account === null) {
        setTrades([]);
        return;
      }
      setTrades(
        await api.get<Trade[]>('/trades', { query: { accountId: account.id, limit: 100 } }),
      );
      // Its own catch: the list is worth showing without the summary.
      setPerformance(
        await api
          .get<PerformanceSummaryInput>(`/accounts/${account.id}/performance`, {
            query: { period: '3M' },
          })
          .catch(() => null),
      );
      setError(null);
    } catch {
      setError(t('history.loadFailed'));
    }
  }, [api, account, t]);

  useEffect(() => {
    void load();
  }, [load, versions.trades]);

  return (
    <Screen>
      <AccountPicker />
      {error === null ? null : <ErrorNote message={error} />}
      <FlatList
        data={trades ?? []}
        keyExtractor={(item) => item.id}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              void load().finally(() => setRefreshing(false));
            }}
          />
        }
        ListHeaderComponent={
          performance === null || performance.trades.total === 0 ? null : (
            <Summary input={performance} />
          )
        }
        ListEmptyComponent={
          <Empty message={trades === null ? t('common.loading') : t('history.none')} />
        }
        renderItem={({ item }) => (
          <View style={styles.row}>
            <View style={styles.top}>
              <View style={styles.title}>
                <InstrumentBadge code={item.symbol} size={28} />
                <Text style={styles.symbol}>{item.symbol}</Text>
                <SideTag
                  side={item.side}
                  label={`${t(item.side === 'BUY' ? 'common.BUY' : 'common.SELL')} ${item.volume}`}
                />
              </View>
              <Text
                style={[
                  styles.net,
                  { color: signColor(item.netPnl), writingDirection: NUMERIC_DIRECTION },
                ]}
              >
                {formatSigned(item.netPnl)}
              </Text>
            </View>
            <Text style={[styles.detail, { writingDirection: NUMERIC_DIRECTION }]}>
              {item.entryPrice} → {item.exitPrice} · {reasonWords(item.closeReason, t)}
            </Text>
            {/* Where the net came from. Hiding the costs hides the difference
                between a strategy that does not work and a size that does not. */}
            <Text style={[styles.costs, { writingDirection: NUMERIC_DIRECTION }]}>
              {t('history.costs', {
                gross: formatSigned(item.grossPnl),
                commission: item.commission,
                swap: item.swap,
              })}
            </Text>
            <Text style={styles.when}>{new Date(item.exitTime).toLocaleString()}</Text>
          </View>
        )}
      />
    </Screen>
  );
}

function reasonWords(reason: string, t: Translate): string {
  const key = `reason.${reason}`;
  return key in MESSAGES.en ? t(key as MessageKey) : reason;
}

/** The last three months, as the server counts them. */
function Summary({ input }: { input: PerformanceSummaryInput }): React.ReactElement {
  const t = useT();
  const { lines, notes } = performanceSummary(input, t);
  return (
    <View style={styles.summary}>
      <Text style={styles.summaryTitle}>{t('history.summary')}</Text>
      {lines.map((line) => (
        <View key={line.label} style={styles.top}>
          <Text style={styles.detail}>{line.label}</Text>
          <Text
            style={[
              styles.summaryValue,
              {
                color: line.signOf === null ? theme.colors.text : signColor(line.signOf),
                writingDirection: NUMERIC_DIRECTION,
              },
            ]}
          >
            {line.value}
          </Text>
        </View>
      ))}
      {notes.map((note) => (
        <Text key={note} style={styles.when}>
          {note}
        </Text>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  summary: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    padding: theme.spacing(1.5),
    marginBottom: theme.spacing(1.5),
    gap: theme.spacing(0.5),
  },
  summaryTitle: { fontFamily: theme.font.semibold, color: theme.colors.text, fontSize: 15 },
  summaryValue: { fontFamily: theme.font.mono, fontSize: 14 },
  row: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    padding: theme.spacing(1.5),
    marginBottom: theme.spacing(1),
  },
  top: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  title: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing(0.75), flex: 1 },
  symbol: { fontFamily: theme.font.heavy, color: theme.colors.text, fontSize: 15 },
  net: { fontFamily: theme.font.monoHeavy, fontSize: 17 },
  detail: {
    fontFamily: theme.font.mono,
    color: theme.colors.textMuted,
    fontSize: 13,
    marginTop: theme.spacing(0.75),
  },
  costs: {
    fontFamily: theme.font.mono,
    color: theme.colors.textMuted,
    fontSize: 11,
    marginTop: theme.spacing(0.25),
  },
  when: {
    fontFamily: theme.font.regular,
    color: theme.colors.textMuted,
    fontSize: 11,
    marginTop: theme.spacing(0.5),
  },
});
