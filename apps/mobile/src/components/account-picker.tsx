import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { theme } from '../lib/theme';
import { shouldOfferChoice } from '../lib/account-selection';
import { useAccounts } from '../lib/accounts';
import { useT } from '../lib/i18n';

/**
 * Which account this screen is acting on, and a way to change it.
 *
 * Shown only when there is more than one — a chooser with one choice is
 * furniture, and the screens are small. When it is shown it is not decoration:
 * every screen below it acts on whatever is selected here, so the selected chip
 * is the answer to "where is this order going".
 */
export function AccountPicker(): React.ReactElement | null {
  const t = useT();
  const { accounts, selected, select } = useAccounts();
  if (!shouldOfferChoice(accounts)) return null;

  return (
    <View style={styles.row} accessibilityRole="radiogroup" accessibilityLabel={t('more.accounts')}>
      {accounts.map((account) => {
        const active = account.id === selected?.id;
        return (
          <Pressable
            key={account.id}
            onPress={() => select(account.id)}
            accessibilityRole="radio"
            accessibilityState={{ selected: active }}
            accessibilityLabel={t('account.picker', {
              number: account.number,
              currency: account.currency,
            })}
            style={({ pressed }) => [
              styles.chip,
              active ? styles.active : null,
              pressed ? styles.pressed : null,
            ]}
          >
            <Text style={[styles.label, active ? styles.activeLabel : null]}>
              {account.number} · {account.currency}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingHorizontal: 16, paddingTop: 12 },
  chip: {
    borderRadius: 999,
    borderWidth: 1,
    borderColor: theme.colors.border,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  active: { backgroundColor: theme.colors.surface, borderColor: theme.colors.accent },
  pressed: { opacity: 0.6 },
  label: { fontFamily: theme.font.regular, color: theme.colors.textMuted, fontSize: 12 },
  activeLabel: { fontFamily: theme.font.semibold, color: theme.colors.text },
});
