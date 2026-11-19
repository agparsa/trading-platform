import React, { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRouter, type Href } from 'expo-router';
import { Icon, type IconName } from '../../components/icons';
import { useAccounts } from '../../lib/accounts';
import { groupDigits } from '../../lib/format';
import { useT } from '../../lib/i18n';
import type { MessageKey } from '../../lib/messages';
import { useSession } from '../../lib/session';
import { theme } from '../../lib/theme';

interface Me {
  email: string;
  displayName: string;
}

/**
 * Everything that is not a price or a trade: who you are, which account you
 * are on, your notices, security and settings — and signing
 * out, at the bottom where it is not pressed by accident.
 */
export default function More(): React.ReactElement {
  const t = useT();
  const { api, signOut } = useSession();
  const router = useRouter();
  const { accounts, selected, select } = useAccounts();
  const [me, setMe] = useState<Me | null>(null);

  useEffect(() => {
    void api
      .get<Me>('/users/me')
      .then(setMe)
      .catch(() => setMe(null));
  }, [api]);

  const initials =
    (me?.displayName ?? '')
      .split(/\s+/)
      .filter((part) => part !== '')
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join('') || '•';

  const row = (icon: IconName, label: MessageKey, href: Href) => (
    <Pressable
      key={label}
      accessibilityRole="button"
      onPress={() => router.push(href)}
      style={({ pressed }) => [styles.row, pressed ? styles.pressed : null]}
    >
      <Icon name={icon} color={theme.colors.textMuted} />
      <Text style={styles.rowLabel}>{t(label)}</Text>
      <Icon name="chevron" color={theme.colors.textMuted} size={18} />
    </Pressable>
  );

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <View style={styles.who}>
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>{initials}</Text>
        </View>
        <View style={{ flex: 1, alignItems: 'flex-start' }}>
          <Text style={styles.name} numberOfLines={1}>
            {me?.displayName ?? '…'}
          </Text>
          <Text style={styles.email} numberOfLines={1}>
            {me?.email ?? ''}
          </Text>
        </View>
      </View>

      {accounts.length === 0 ? null : (
        <View style={styles.group}>
          <Text style={styles.groupTitle}>{t('more.accounts')}</Text>
          {accounts.map((account) => {
            const active = account.id === selected?.id;
            return (
              <Pressable
                key={account.id}
                accessibilityRole="radio"
                accessibilityState={{ selected: active }}
                onPress={() => select(account.id)}
                style={[styles.row, active ? styles.rowActive : null]}
              >
                <View
                  style={[
                    styles.badge,
                    {
                      backgroundColor:
                        account.type === 'LIVE' ? 'rgba(22,199,132,0.15)' : 'rgba(240,167,10,0.15)',
                    },
                  ]}
                >
                  <Text
                    style={[
                      styles.badgeText,
                      {
                        color:
                          account.type === 'LIVE' ? theme.colors.positive : theme.colors.warning,
                      },
                    ]}
                  >
                    {account.type === 'LIVE' ? t('account.type.LIVE') : t('account.type.DEMO')}
                  </Text>
                </View>
                <Text style={styles.rowLabel}>
                  #{account.number} · {account.currency}
                </Text>
                <Text style={styles.balance}>{groupDigits(account.balance)}</Text>
                {active ? <Text style={styles.check}>✓</Text> : null}
              </Pressable>
            );
          })}
        </View>
      )}

      <View style={styles.group}>
        {row('account', 'screen.account', '/(tabs)')}
        {row('bell', 'screen.notifications', '/(tabs)/notifications')}
        {row('shield', 'screen.profile', '/(tabs)/profile')}
        {row('gear', 'screen.settings', '/(tabs)/settings')}
      </View>

      <Pressable
        accessibilityRole="button"
        onPress={() => {
          void signOut().then(() => router.replace('/login'));
        }}
        style={({ pressed }) => [styles.group, styles.row, pressed ? styles.pressed : null]}
      >
        <Icon name="logout" color={theme.colors.negative} />
        <Text style={[styles.rowLabel, { color: theme.colors.negative }]}>
          {t('common.signOut')}
        </Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.background },
  content: { padding: theme.spacing(2), gap: theme.spacing(1.5) },
  who: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing(1.5),
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg,
    padding: theme.spacing(2),
  },
  avatar: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: theme.colors.surfaceRaised,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { color: theme.colors.text, fontSize: 16, fontWeight: '700' },
  name: { color: theme.colors.text, fontSize: 16, fontWeight: '700' },
  email: { color: theme.colors.textMuted, fontSize: 13, marginTop: 2 },
  group: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg,
    overflow: 'hidden',
  },
  groupTitle: {
    color: theme.colors.textMuted,
    fontSize: 12,
    paddingHorizontal: theme.spacing(2),
    paddingTop: theme.spacing(1.5),
    paddingBottom: theme.spacing(0.5),
    alignSelf: 'flex-start',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing(1.5),
    minHeight: 52,
    paddingHorizontal: theme.spacing(2),
  },
  rowActive: { backgroundColor: theme.colors.surfaceRaised },
  pressed: { opacity: 0.7 },
  rowLabel: { flex: 1, color: theme.colors.text, fontSize: 15 },
  balance: { color: theme.colors.text, fontFamily: theme.font.mono, fontSize: 14 },
  check: { color: theme.colors.accent, fontSize: 16 },
  badge: { borderRadius: 4, paddingHorizontal: 6, paddingVertical: 2 },
  badgeText: { fontSize: 11, fontWeight: '700' },
});
