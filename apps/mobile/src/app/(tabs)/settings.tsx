import React, { useState } from 'react';
import { ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import type {
  NotificationCategory,
  NotificationPreferenceDto,
  NotificationSettingsDto,
} from '@tp/shared-types';
import { useSession } from '../../lib/session';
import { Button, Card, Empty, ErrorNote, Screen } from '../../components/ui';
import { theme } from '../../lib/theme';
import { MESSAGES, type MessageKey, type Translate } from '../../lib/messages';
import { useT } from '../../lib/i18n';

function label(category: string, t: Translate): string {
  const key = `category.${category}`;
  return key in MESSAGES.en ? t(key as MessageKey) : category;
}

export default function Settings(): React.ReactElement {
  const t = useT();
  const { api, preferences, refreshPreferences, signOut } = useSession();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  /**
   * Typed as the fields the settings route accepts, not `Record<string, …>`:
   * a record is a body nobody — the compiler included — can check against the
   * route's schema, and `smoke:contracts` compares every body with it.
   */
  const patchSettings = async (patch: Partial<Omit<NotificationSettingsDto, 'categories'>>) => {
    setError(null);
    try {
      await api.patch('/notifications/preferences', patch, {
        idempotencyKey: `prefs:${Date.now()}`,
      });
      await refreshPreferences();
    } catch {
      setError(t('settings.saveFailed'));
    }
  };

  const patchCategory = async (
    category: NotificationCategory,
    patch: Partial<Pick<NotificationPreferenceDto, 'inApp' | 'push' | 'sound' | 'email'>>,
  ) => {
    setError(null);
    try {
      await api.patch(`/notifications/preferences/${category}`, patch, {
        idempotencyKey: `prefs:${category}:${Date.now()}`,
      });
      await refreshPreferences();
    } catch {
      /**
       * The server refuses to mute a risk or security category.
       *
       * It refuses rather than accepting and ignoring, so the switch snaps back
       * and the reason is shown — instead of sitting there off while the
       * notifications keep arriving.
       */
      setError(t('settings.cannotMute'));
      await refreshPreferences();
    }
  };

  if (preferences === null) {
    return (
      <Screen>
        <Empty message={t('settings.loading')} />
      </Screen>
    );
  }

  return (
    <Screen>
      <ScrollView>
        {error === null ? null : <ErrorNote message={error} />}

        <Card title={t('settings.notifications')}>
          <Row
            label={t('settings.trading')}
            value={preferences.tradingEnabled}
            onChange={(value) => void patchSettings({ tradingEnabled: value })}
          />
          <Row
            label={t('settings.push')}
            value={preferences.pushEnabled}
            onChange={(value) => void patchSettings({ pushEnabled: value })}
          />
          <Row
            label={t('settings.sound')}
            value={preferences.soundEnabled}
            onChange={(value) => void patchSettings({ soundEnabled: value })}
          />
          <Row
            label={t('settings.vibration')}
            value={preferences.vibrationEnabled}
            onChange={(value) => void patchSettings({ vibrationEnabled: value })}
          />
        </Card>

        <Card title={t('settings.what')}>
          {preferences.categories.map((category) => (
            <Row
              key={category.category}
              label={label(category.category, t)}
              value={category.push}
              disabled={category.unmutable}
              {...(category.unmutable ? { hint: t('settings.alwaysOn') } : {})}
              onChange={(value) =>
                void patchCategory(category.category, { push: value, inApp: value })
              }
            />
          ))}
        </Card>

        {/*
          Email reaches a trader with the app closed — the channel risk alerts
          use when push cannot, which on Android without Firebase is always.
          Every category has a switch; risk alerts start on.
        */}
        <Card title={t('settings.email')}>
          {preferences.categories
            .filter((category) => category.category !== 'SYSTEM')
            .map((category) => (
              <Row
                key={`email-${category.category}`}
                label={label(category.category, t)}
                value={category.email}
                onChange={(value) => void patchCategory(category.category, { email: value })}
              />
            ))}
        </Card>

        <Card title={t('settings.sounds')}>
          {preferences.categories
            .filter((category) => category.category !== 'SYSTEM')
            .map((category) => (
              <Row
                key={`sound-${category.category}`}
                label={label(category.category, t)}
                value={category.sound}
                onChange={(value) => void patchCategory(category.category, { sound: value })}
              />
            ))}
        </Card>

        <Button
          label={t('common.signOut')}
          variant="danger"
          onPress={() => {
            void signOut().then(() => router.replace('/login'));
          }}
        />
      </ScrollView>
    </Screen>
  );
}

function Row({
  label,
  value,
  onChange,
  disabled = false,
  hint,
}: {
  label: string;
  value: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
  hint?: string;
}): React.ReactElement {
  return (
    <View style={styles.row}>
      <View style={{ flex: 1 }}>
        <Text style={styles.label}>{label}</Text>
        {hint === undefined ? null : <Text style={styles.hint}>{hint}</Text>}
      </View>
      <Switch
        value={value}
        onValueChange={onChange}
        disabled={disabled}
        accessibilityLabel={label}
        trackColor={{ true: theme.colors.accent, false: theme.colors.border }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 48,
  },
  label: { color: theme.colors.text, fontSize: 15 },
  hint: { color: theme.colors.textMuted, fontSize: 12 },
});
