import React from 'react';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { SessionProvider } from '../lib/session';
import { AccountsProvider } from '../lib/accounts';
import { FeaturesProvider } from '../lib/features';
import { theme } from '../lib/theme';

export default function RootLayout(): React.ReactElement {
  return (
    <SafeAreaProvider>
      <SessionProvider>
        {/* Above the navigator: the ticket lives outside the tabs, and it must
            act on the same account the tabs are showing. */}
        {/* Inside the session, because the flags are the signed-in firm's. */}
        <FeaturesProvider>
          <AccountsProvider>
            <StatusBar style="light" />
            <Stack
              screenOptions={{
                headerStyle: { backgroundColor: theme.colors.surface },
                headerTintColor: theme.colors.text,
                contentStyle: { backgroundColor: theme.colors.background },
              }}
            >
              <Stack.Screen name="index" options={{ headerShown: false }} />
              <Stack.Screen name="login" options={{ title: 'Sign in' }} />
              <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
            </Stack>
          </AccountsProvider>
        </FeaturesProvider>
      </SessionProvider>
    </SafeAreaProvider>
  );
}
