import React, { useCallback, useEffect, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { useSession } from '../../lib/session';
import { Empty, ErrorNote, Screen } from '../../components/ui';
import { theme } from '../../lib/theme';

interface Notice {
  id: string;
  kind: string;
  severity: 'INFO' | 'WARNING' | 'CRITICAL';
  title: string;
  body: string;
  readAt: string | null;
  createdAt: string;
}

const severityColor = (severity: Notice['severity']): string =>
  severity === 'CRITICAL'
    ? theme.colors.negative
    : severity === 'WARNING'
      ? theme.colors.warning
      : theme.colors.accent;

export default function NotificationCentre(): React.ReactElement {
  const { api } = useSession();
  const [notices, setNotices] = useState<Notice[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      setNotices(await api.get<Notice[]>('/notifications', { query: { limit: 100 } }));
      setError(null);
    } catch {
      setError('Could not load notifications.');
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const markRead = async (id: string) => {
    // Optimistic: the row greys out immediately, because waiting for a round
    // trip to acknowledge a tap makes the list feel broken.
    setNotices(
      (current) =>
        current?.map((notice) =>
          notice.id === id ? { ...notice, readAt: new Date().toISOString() } : notice,
        ) ?? null,
    );
    try {
      await api.post(`/notifications/${id}/read`, {}, { idempotencyKey: `read:${id}` });
    } catch {
      void load();
    }
  };

  return (
    <Screen>
      {error === null ? null : <ErrorNote message={error} />}
      <FlatList
        data={notices ?? []}
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
        ListEmptyComponent={
          <Empty message={notices === null ? 'Loading…' : 'Nothing to report.'} />
        }
        renderItem={({ item }) => (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${item.title}. ${item.body}`}
            onPress={() => {
              if (item.readAt === null) void markRead(item.id);
            }}
            style={[styles.row, item.readAt === null ? styles.unread : null]}
          >
            <View style={[styles.stripe, { backgroundColor: severityColor(item.severity) }]} />
            <View style={styles.content}>
              <Text style={styles.title}>{item.title}</Text>
              <Text style={styles.body}>{item.body}</Text>
              <Text style={styles.when}>{new Date(item.createdAt).toLocaleString()}</Text>
            </View>
          </Pressable>
        )}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    marginBottom: theme.spacing(1),
    overflow: 'hidden',
    minHeight: 48,
  },
  unread: { backgroundColor: theme.colors.surfaceRaised },
  stripe: { width: 3 },
  content: { flex: 1, padding: theme.spacing(1.5) },
  title: { color: theme.colors.text, fontSize: 15, fontWeight: '600' },
  body: { color: theme.colors.textMuted, fontSize: 13, marginTop: theme.spacing(0.25) },
  when: { color: theme.colors.textMuted, fontSize: 11, marginTop: theme.spacing(0.5) },
});
