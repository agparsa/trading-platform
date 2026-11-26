import React from 'react';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { SessionProvider } from '../lib/session';
import { AccountsProvider } from '../lib/accounts';
import { FeaturesProvider } from '../lib/features';
import { LiveProvider } from '../lib/live';
import { LocaleProvider, useT } from '../lib/i18n';
import { theme } from '../lib/theme';

export default function RootLayout(): React.ReactElement {
  return (
    <SafeAreaProvider>
      {/* Outermost after the safe area: every screen, the sign-in form
          included, speaks the chosen language and lays out in its direction. */}
      <LocaleProvider>
        <SessionProvider>
          {/* Inside the session, because the flags are the signed-in firm's. */}
          <FeaturesProvider>
            {/* Above the navigator: the ticket lives outside the tabs, and it
                must act on the same account the tabs are showing. */}
            <AccountsProvider>
              {/* One socket for every screen: the tabs and the ticket read it. */}
              <LiveProvider>
                <StatusBar style="light" />
                <AppStack />
              </LiveProvider>
            </AccountsProvider>
          </FeaturesProvider>
        </SessionProvider>
      </LocaleProvider>
    </SafeAreaProvider>
  );
}

function AppStack(): React.ReactElement {
  const t = useT();
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: theme.colors.background },
        headerTintColor: theme.colors.text,
        headerShadowVisible: false,
        headerTitleStyle: { fontWeight: '700' },
        contentStyle: { backgroundColor: theme.colors.background },
      }}
    >
      <Stack.Screen name="index" options={{ headerShown: false }} />
      <Stack.Screen name="login" options={{ headerShown: false, title: t('screen.signIn') }} />
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      {/* The instrument screens name themselves once they know the symbol. */}
      <Stack.Screen name="chart/[symbol]" options={{ title: '' }} />
      <Stack.Screen name="trade/[symbol]" options={{ title: '' }} />
    </Stack>
  );
}
