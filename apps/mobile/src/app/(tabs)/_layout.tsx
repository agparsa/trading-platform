import React from 'react';
import { Tabs } from 'expo-router';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Icon, type IconName } from '../../components/icons';
import { BackButton } from '../../components/ui';
import { useT } from '../../lib/i18n';
import type { MessageKey } from '../../lib/messages';
import { theme } from '../../lib/theme';

/**
 * Five tabs, the way a phone trading terminal has them: prices, a chart,
 * what is open, what has closed, and everything else.
 *
 * The screens that used to be tabs of their own — the account, positions,
 * orders, notifications, profile, settings — are still routes (`href: null`
 * keeps them out of the bar): Trade shows positions and orders together under
 * the account's figures, and More leads to the rest. Eight tabs on a phone
 * left each one a label nobody could read.
 */
const VISIBLE: ReadonlyArray<{ name: string; title: MessageKey; icon: IconName }> = [
  { name: 'market', title: 'tab.quotes', icon: 'quotes' },
  { name: 'chart', title: 'tab.chart', icon: 'chart' },
  { name: 'trade', title: 'tab.trade', icon: 'trade' },
  { name: 'history', title: 'tab.history', icon: 'history' },
  { name: 'more', title: 'tab.more', icon: 'more' },
];

const HIDDEN: ReadonlyArray<{ name: string; title: MessageKey }> = [
  { name: 'index', title: 'screen.account' },
  { name: 'positions', title: 'screen.positions' },
  { name: 'orders', title: 'screen.orders' },
  { name: 'notifications', title: 'screen.notifications' },
  { name: 'profile', title: 'screen.profile' },
  { name: 'settings', title: 'screen.settings' },
];

export default function TabsLayout(): React.ReactElement {
  const t = useT();
  const insets = useSafeAreaInsets();
  return (
    <Tabs
      initialRouteName="market"
      screenOptions={{
        headerStyle: { backgroundColor: theme.colors.background },
        headerTintColor: theme.colors.text,
        headerShadowVisible: false,
        headerTitleStyle: { fontFamily: theme.font.heavy, fontSize: theme.type.heading },
        headerTitleAlign: 'left',
        tabBarStyle: {
          backgroundColor: theme.colors.surface,
          borderTopColor: theme.colors.border,
          // Above the phone's own navigation bar, not under it: the app draws
          // edge to edge, so the bar adds the system inset itself.
          height: 60 + insets.bottom,
          paddingTop: 6,
          paddingBottom: Math.max(insets.bottom, 6),
        },
        tabBarActiveTintColor: theme.colors.accent,
        tabBarInactiveTintColor: theme.colors.textFaint,
        tabBarLabelStyle: { fontFamily: theme.font.semibold, fontSize: theme.type.caption },
        sceneStyle: { backgroundColor: theme.colors.background },
      }}
    >
      {VISIBLE.map((tab) => (
        <Tabs.Screen
          key={tab.name}
          name={tab.name}
          options={{
            title: t(tab.title),
            // The active tab sits on a pill of the accent, so where you are is
            // a shape, not only a colour.
            tabBarIcon: ({ color, focused }) => (
              <View
                style={{
                  width: 52,
                  height: 30,
                  borderRadius: 15,
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor: focused ? theme.colors.accentTint : 'transparent',
                }}
              >
                <Icon name={tab.icon} color={String(color)} />
              </View>
            ),
          }}
        />
      ))}
      {HIDDEN.map((tab) => (
        <Tabs.Screen
          key={tab.name}
          name={tab.name}
          options={{ title: t(tab.title), href: null, headerLeft: () => <BackButton /> }}
        />
      ))}
    </Tabs>
  );
}
